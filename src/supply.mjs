// Public-source supply of independent, unused holdout batches (model-free; never runs a model, never sees candidate results).
//
// Pipeline (`eval-loop-supply collect`): discover public npm packages whose own test suite runs with `node --test` and no
// runtime dependencies -> scan their upstream git history (default branch, first parent, no merges, committed on/after
// `since`) for real commits that change library code AND runnable tests -> verify license (package.json SPDX + license file
// text) and record provenance (repository URL, immutable base/fix revisions, dates, author name) -> reject duplicates and
// exposure (patch-id, file content hashes, repository/package names against the train/dev suite, earlier holdouts, earlier
// supply and the texts of earlier experiments) -> adapt WITHOUT inventing anything: repo/ = the upstream tree at the parent
// commit, hidden/ = the commit's own post-change test files, reference/ = the commit's own post-change non-test files,
// instruction = a fixed preamble + the upstream commit message -> validate mechanically in the grading sandbox (repeated:
// original visible suite passes, original fails the hidden tests on assertions, reference passes hidden AND visible, same
// counts every repeat) -> select a batch by a seeded hash order (candidate-blind: no candidate or model result is an input)
// -> seal it (datasets.mjs sealOf) in the pool, outside every package/dataset tree.
//
// Provenance is "external" only for tasks built this way (upstream-authored problem statement, code and oracle). This does
// NOT prove the tasks are absent from a model's pretraining data: public code may have been trained on; recency (`since`) and
// the duplicate checks reduce, they do not exclude, that risk. See docs/design.md "Holdout supply".
//
// Pool layout (keep it outside git/package trees; the CLI refuses paths inside this package):
//   <pool>/registry.jsonl        hash-chained ledger: config, case decisions (reason codes), batches, reservations
//   <pool>/cache/repos/          blobless bare clones of upstream repositories
//   <pool>/cases/<id>/           adapted, validated tasks not yet in a batch (private: hidden tests and reference)
//   <pool>/batches/<batch>/      sealed holdout datasets (SEAL.json, PROVENANCE.json, task dirs; USES.jsonl written on use)
//   <pool>/reports/              non-secret audit summaries (counts, reason codes, ids, URLs; no test or solution content)
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { acquireLock, atomicWriteJson, digestOf, ensureDir, Ledger, readJson, sha256, sleep, walkFiles } from "./util.mjs";
import { holdoutHard, holdoutLedger, holdoutStatus, loadLocal, loadSuite, sealOf, verifySeal } from "./datasets.mjs";
import { PACKAGE_DIR } from "./protocol.mjs";

export const SUPPLY_SCHEMA = "pi-eval-loop/supply@1";
export const PROVENANCE = "external";

/**
 * Selection criteria, fixed before collection and recorded (with their digest) in the registry. Nothing here depends on how a
 * candidate harness or model performs on a task. `tiers` is a declared size proxy (changed non-test code lines/files of the
 * upstream fix), not a measured difficulty.
 */
export const DEFAULT_SUPPLY = Object.freeze({
  since: "2025-11-05T00:00:00Z",
  licenses: ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "Unlicense", "BlueOak-1.0.0", "CC0-1.0"],
  discovery: {
    keywords: ["parser", "string", "array", "object", "url", "path", "json", "cli", "promise", "stream", "validation", "format", "color", "time", "date", "math", "hash", "diff", "glob", "utility", "encode", "escape", "semver", "template", "markdown", "csv", "yaml", "query", "cache", "ansi", "terminal", "html", "regex", "number", "text", "filesystem", "async", "event", "buffer", "crypto"],
    perKeyword: 250, delayMs: 2500, maxRepos: 60,
  },
  commits: { maxScanPerRepo: 60, maxValidatePerRepo: 6, maxCodeFiles: 6, maxCodeLines: 400, maxTestFiles: 4, maxRepoBytes: 8 * 1024 * 1024, minSubjectChars: 12 },
  excludeAuthors: ["[bot]", "dependabot", "renovate", "github-actions", "greenkeeper"],
  excludeSubjects: "^(v?\\d+\\.\\d+|bump|release|merge|chore|ci|build|docs?|style|lint|meta|update dependencies)\\b|\\btweaks?\\b|\\btypo",
  tiers: { easyMaxLines: 10, mediumMaxLines: 60, hardMinFiles: 3 },
  validation: { repeats: 2, timeoutMs: 120_000 },
  batch: { maxTasks: 12, maxPerFamily: 2, maxPerOwner: 4, seed: "supply-v1" },
  // Second source (src/supply-exercism.mjs, `collect-exercism`): Exercism's JavaScript track, whose maintainers annotate each
  // exercise's difficulty (1-10) and whose docs map 8-10 to hard. Only the tiers listed are collected (the missing hard stratum).
  exercism: {
    track: { slug: "exercism/javascript" },
    rubric: { slug: "exercism/docs", path: "building/tracks/config-json.md" },
    tiers: ["hard"], maxValidate: 12,
    excludeListedIn: [{ name: "aider-polyglot-benchmark", slug: "aider-ai/polyglot-benchmark", path: "javascript/exercises/practice" }],
    vendor: { expect: "30.3.0" },
  },
});

const CODE = /\.[cm]?[jt]sx?$/;
const DECL = /\.d\.[cm]?ts$/;
const TEST_DIR = /(^|\/)(test|tests|__tests__|spec)\//;
const RUNNER_TEST = /\.(test|spec)\.[cm]?[jt]s$/; // grader.mjs TEST_FILE
const ROOT_TEST = /(^|\/)tests?\.[cm]?[jt]s$/;
const FORBIDDEN = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|\.npmrc)$/;
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

export const isTestPath = (p) => TEST_DIR.test(p) || RUNNER_TEST.test(p) || ROOT_TEST.test(p);
export const isRunnableTest = (p) => isTestPath(p) && CODE.test(p) && !DECL.test(p) && !/(^|\/)(fixtures?|helpers?|utils?)\//.test(p);
/** Hidden-copy name of a runnable upstream test: unchanged when the grader already runs it, else `<stem>.holdout.test.<ext>`. */
export const hiddenNameOf = (p) => RUNNER_TEST.test(p) ? p : join(dirname(p), `${basename(p, extname(p))}.holdout.test${extname(p)}`).replace(/^\.\//, "");

const git = (cwd, args, opts = {}) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 300_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const gitText = (cwd, args, opts) => git(cwd, args, opts).toString().trim();

export function mergeSupply(override = {}) {
  const out = structuredClone(DEFAULT_SUPPLY);
  for (const [k, v] of Object.entries(override)) {
    if (!(k in out)) throw new Error(`supply config: unknown key ${k}`);
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...out[k], ...v } : v;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------ pool

/** A pool path must be absolute after resolution and outside this package (whose `files` export datasets/ and docs/). */
export function poolPath(path) {
  const abs = resolve(path);
  const pkg = resolve(PACKAGE_DIR);
  if (abs === pkg || abs.startsWith(pkg + sep)) throw new Error(`supply pool ${abs} is inside the pi-eval-loop package: keep hidden tasks outside package and dataset trees`);
  return abs;
}
export const registryOf = (pool) => new Ledger(join(pool, "registry.jsonl"));

export function poolState(pool) {
  const reg = registryOf(pool);
  const records = reg.records();
  const cases = new Map(), batches = new Map(), reservations = new Map();
  for (const r of records) {
    if (r.type === "case") cases.set(r.caseId, r);
    else if (r.type === "batch") batches.set(r.batch, r);
    else if (r.type === "reserve") { if (!reservations.has(r.stateDir)) reservations.set(r.stateDir, r); }
  }
  const batched = new Set([...batches.values()].flatMap(b => b.tasks));
  const reservedBatches = new Set([...reservations.values()].map(r => r.batch));
  return { records, chain: reg.verify(), cases, batches, reservations, batched, reservedBatches };
}

// -------------------------------------------------------------------------------------------------------------------- discovery

/**
 * Candidate repositories from the npm registry: latest version's test script runs `node --test`, no runtime dependencies,
 * an accepted SPDX license and a GitHub repository. Order: keyword order, then registry search order (both recorded).
 */
/** @param {any} cfg @param {{ fetchJson?: (url: string) => Promise<any>, log?: (line: string) => void }} [options] */
export async function discoverRepos(cfg, { fetchJson = defaultFetchJson, log = () => {} } = {}) {
  const seen = new Map();
  for (const kw of cfg.discovery.keywords) {
    for (let from = 0; from < cfg.discovery.perKeyword; from += 250) {
      const size = Math.min(250, cfg.discovery.perKeyword - from);
      const d = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=keywords:${encodeURIComponent(kw)}&size=${size}&from=${from}`);
      for (const o of d?.objects ?? []) if (!seen.has(o.package.name)) seen.set(o.package.name, { keyword: kw, date: o.package.date });
      await sleep(cfg.discovery.delayMs);
    }
  }
  log(`discovery: ${seen.size} packages`);
  const repos = new Map();
  const names = [...seen.keys()];
  const latest = new Array(names.length);
  let next = 0;
  // Packuments in parallel (8), evaluated afterwards in discovery order (the result does not depend on fetch timing).
  await Promise.all(Array.from({ length: 8 }, async () => { while (next < names.length) { const i = next++; try { latest[i] = await fetchJson(`https://registry.npmjs.org/${names[i].replace("/", "%2f")}/latest`); } catch { latest[i] = null; } } }));
  for (let i = 0; i < names.length; i++) {
    if (repos.size >= cfg.discovery.maxRepos) break;
    const name = names[i], meta = seen.get(name), p = latest[i];
    if (!p) continue;
    const test = String(p.scripts?.test ?? "");
    if (!/(^|[\s;&|(])node\b[^&|;]*\s--test\b/.test(test)) continue;
    if (Object.keys(p.dependencies ?? {}).length) continue;
    if (!licenseAccepted(p.license, cfg.licenses)) continue;
    const slug = githubSlug(typeof p.repository === "string" ? p.repository : p.repository?.url);
    if (!slug || repos.has(slug)) continue;
    repos.set(slug, { slug, url: `https://github.com/${slug}.git`, npm: { name, version: p.version, license: p.license }, keyword: meta.keyword });
  }
  log(`discovery: ${repos.size} candidate repositories`);
  return [...repos.values()];
}

async function defaultFetchJson(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "pi-eval-loop-supply" } });
    if (r.status === 404) return null;
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * 2 ** attempt); continue; }
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`${url}: rate limited`);
}

export function githubSlug(url) {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?(#.*)?$/.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export function licenseAccepted(spdx, allowed) {
  const s = String(spdx ?? "").trim().replace(/^\(|\)$/g, "");
  if (!s) return false;
  if (allowed.includes(s)) return true;
  const parts = s.split(/\s+OR\s+/);
  return parts.length > 1 && parts.some(x => allowed.includes(x.trim()));
}

/** License text signature check (the file must say what package.json declares). */
export function licenseTextMatches(spdx, text) {
  const t = String(text).replace(/\s+/g, " ");
  const checks = {
    "MIT": /Permission is hereby granted, free of charge/i, "ISC": /Permission to use, copy, modify, and\/or distribute this software/i,
    "BSD-2-Clause": /Redistribution and use in source and binary forms/i, "BSD-3-Clause": /Redistribution and use in source and binary forms/i,
    "Apache-2.0": /Apache License,? Version 2\.0/i, "0BSD": /Permission to use, copy, modify, and\/or distribute this software/i,
    "Unlicense": /This is free and unencumbered software released into the public domain/i, "BlueOak-1.0.0": /Blue Oak Model License/i, "CC0-1.0": /CC0 1\.0|Creative Commons Zero|No Copyright/i,
  };
  const options = String(spdx).replace(/^\(|\)$/g, "").split(/\s+OR\s+/).map(x => x.trim());
  return options.some(o => checks[o]?.test(t));
}

// ---------------------------------------------------------------------------------------------------------------------- scanning

/** Blobless bare clone (local paths in tests: plain bare clone), refreshed on each collect. */
export function cloneRepo(repo, cacheDir) {
  const dir = join(cacheDir, repo.slug.replace("/", "__") + ".git");
  const local = !/^https?:\/\//.test(repo.url);
  if (!existsSync(dir)) {
    const tmp = `${dir}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    ensureDir(dirname(dir));
    git(cacheDir, ["clone", "--bare", "--no-tags", ...(local ? [] : ["--filter=blob:none"]), repo.url, tmp], { timeoutMs: 600_000 });
    renameSync(tmp, dir);
  } else {
    git(dir, ["fetch", "--no-tags", ...(local ? [] : ["--filter=blob:none"]), "origin", "+HEAD:refs/supply/head"], { timeoutMs: 600_000 });
  }
  const head = existsSync(join(dir, "refs/supply/head")) || (() => { try { git(dir, ["rev-parse", "--verify", "refs/supply/head"]); return true; } catch { return false; } })() ? "refs/supply/head" : "HEAD";
  return { dir, head, headSha: gitText(dir, ["rev-parse", `${head}^{commit}`]) };
}

/**
 * Commits of the default branch that qualify mechanically (no content judgement): one parent, committed on/after `since`, not by
 * a bot, a descriptive subject, only added/modified files (no deletion/rename/type change), no package manifest or lock change,
 * text-only, >= 1 runnable test file and >= 1 non-test code file changed, within the size bounds. Returns { cases, rejects }.
 */
export function scanCommits(clone, repo, cfg) {
  const out = [], rejects = [];
  const shas = gitText(clone.dir, ["rev-list", "--first-parent", "--no-merges", `--since=${cfg.since}`, `--max-count=${cfg.commits.maxScanPerRepo}`, clone.head]).split("\n").filter(Boolean);
  const subjectRe = new RegExp(cfg.excludeSubjects, "i");
  for (const sha of shas) {
    const reject = (code) => { rejects.push({ commit: sha, code }); };
    const [, parents, author, authorEmail, authoredAt, committedAt, ...msg] = gitText(clone.dir, ["show", "-s", "--format=%H%n%P%n%an%n%ae%n%aI%n%cI%n%B", sha]).split("\n");
    const parentList = parents.split(" ").filter(Boolean);
    if (parentList.length !== 1) { reject("not-single-parent"); continue; }
    if (cfg.excludeAuthors.some(a => author.toLowerCase().includes(a.toLowerCase()) || authorEmail.toLowerCase().includes(a.toLowerCase()))) { reject("bot-author"); continue; }
    const message = cleanMessage(msg.join("\n"));
    const subject = message.split("\n")[0].trim();
    if (subject.length < cfg.commits.minSubjectChars || subjectRe.test(subject)) { reject("non-descriptive-subject"); continue; }
    const parent = parentList[0];
    const status = gitText(clone.dir, ["diff-tree", "-r", "--no-commit-id", "--find-renames", "--name-status", parent, sha]).split("\n").filter(Boolean).map(l => l.split("\t"));
    if (!status.length) { reject("empty"); continue; }
    if (status.some(([s]) => !["A", "M"].includes(s))) { reject("deletion-rename-or-type-change"); continue; }
    const files = status.map(([s, p]) => ({ status: s, path: p }));
    if (files.some(f => FORBIDDEN.test(f.path))) { reject("manifest-or-lockfile-change"); continue; }
    const numstat = Object.fromEntries(gitText(clone.dir, ["diff-tree", "-r", "--no-commit-id", "--numstat", parent, sha]).split("\n").filter(Boolean).map(l => { const [a, d, p] = l.split("\t"); return [p, a === "-" ? null : Number(a) + Number(d)]; }));
    if (Object.values(numstat).some(v => v === null)) { reject("binary-change"); continue; }
    const tests = files.filter(f => isRunnableTest(f.path));
    const support = files.filter(f => isTestPath(f.path) && !isRunnableTest(f.path));
    const code = files.filter(f => !isTestPath(f.path) && CODE.test(f.path) && !DECL.test(f.path));
    const other = files.filter(f => !isTestPath(f.path) && !code.includes(f));
    if (!tests.length) { reject("no-runnable-test-change"); continue; }
    if (!code.length) { reject("no-code-change"); continue; }
    const codeLines = code.reduce((s, f) => s + numstat[f.path], 0);
    if (code.length > cfg.commits.maxCodeFiles || codeLines > cfg.commits.maxCodeLines || tests.length > cfg.commits.maxTestFiles) { reject("too-large"); continue; }
    out.push({ repo, sha, parent, author, authoredAt, committedAt, message, subject, tests, support, code, other, codeLines });
  }
  return { cases: out, rejects };
}

/** Commit message without trailers (Signed-off-by, Co-authored-by, ...): problem text only, verbatim otherwise. */
export function cleanMessage(text) {
  return String(text).split("\n").filter(l => !/^[A-Za-z-]+-by:\s/.test(l.trim())).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const taskIdOf = (slug, sha) => `x-${slug.replace("/", "-")}-${sha.slice(0, 10)}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 90);
export const familyOf = (slug) => `gh:${slug}`;
export function tierOf(c, tiers) {
  if (c.code.length >= tiers.hardMinFiles || c.codeLines > tiers.mediumMaxLines) return "hard";
  return c.codeLines > tiers.easyMaxLines ? "medium" : "easy";
}

export const PREAMBLE = (slug, license) => `This repository is a snapshot of the public open-source project ${slug} (${license} license) taken just before an upstream commit. Make the change that this commit describes, in this repository. The upstream commit message follows verbatim (trailer lines removed):`;

/** Adapt one qualifying commit into a task directory (nothing invented: upstream tree, upstream tests, upstream fix, upstream text). */
export function extractCase(clone, c, cfg, dir) {
  rmSync(dir, { recursive: true, force: true });
  const repoDir = ensureDir(join(dir, "repo"));
  const tar = git(clone.dir, ["archive", "--format=tar", c.parent], { timeoutMs: 600_000 });
  execFileSync("tar", ["-x", "-C", repoDir], { input: tar, maxBuffer: 512 * 1024 * 1024 });
  const files = walkFiles(repoDir, { skip: [] });
  if (files.some(f => f.symlink !== undefined)) return { reject: "symlink-in-tree" };
  if (files.some(f => f.path.split("/").includes("node_modules"))) return { reject: "vendored-node_modules" };
  if (files.reduce((s, f) => s + (f.size ?? 0), 0) > cfg.commits.maxRepoBytes) return { reject: "repository-too-large" };
  const root = gitText(clone.dir, ["ls-tree", "--name-only", c.parent]).split("\n");
  const licFile = root.find(n => LICENSE_FILE.test(n));
  let pkg; try { pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")); } catch { return { reject: "no-package-json" }; }
  if (Object.keys(pkg.dependencies ?? {}).length) return { reject: "runtime-dependencies" };
  if (!licenseAccepted(pkg.license, cfg.licenses)) return { reject: "license-not-accepted" };
  if (!licFile) return { reject: "license-file-missing" };
  const licText = readFileSync(join(repoDir, licFile), "utf8");
  if (!licenseTextMatches(pkg.license, licText)) return { reject: "license-text-mismatch" };
  const show = (p) => git(clone.dir, ["show", `${c.sha}:${p}`]);
  const hidden = ensureDir(join(dir, "hidden")), reference = ensureDir(join(dir, "reference"));
  const renamed = [];
  for (const f of c.tests) {
    const name = hiddenNameOf(f.path);
    if (name !== f.path) renamed.push({ from: f.path, to: name });
    ensureDir(dirname(join(hidden, name))); writeFileSync(join(hidden, name), show(f.path));
  }
  for (const f of c.support) { ensureDir(dirname(join(hidden, f.path))); writeFileSync(join(hidden, f.path), show(f.path)); }
  for (const f of [...c.code, ...c.other]) { ensureDir(dirname(join(reference, f.path))); writeFileSync(join(reference, f.path), show(f.path)); }
  const id = taskIdOf(c.repo.slug, c.sha);
  const tier = tierOf(c, cfg.tiers);
  const copyright = (licText.split("\n").find(l => /copyright/i.test(l)) ?? "").trim().slice(0, 300);
  const provenance = {
    schema: SUPPLY_SCHEMA, source: "github", repository: `https://github.com/${c.repo.slug}`, commit: c.sha, parent: c.parent,
    commitUrl: `https://github.com/${c.repo.slug}/commit/${c.sha}`, committedAt: c.committedAt, authoredAt: c.authoredAt, author: c.author,
    branchHeadAtCollection: clone.headSha, npm: c.repo.npm ?? null,
    license: { spdx: pkg.license, file: licFile, sha256: sha256(licText), copyright },
    adaptation: { repo: "upstream tree at the parent commit", hidden: c.tests.map(f => f.path).concat(c.support.map(f => f.path)), renamedForRunner: renamed, reference: [...c.code, ...c.other].map(f => f.path), instruction: "fixed preamble + upstream commit message without trailers" },
    tierRule: { codeFiles: c.code.length, codeLines: c.codeLines, rule: cfg.tiers },
  };
  // tier = the size proxy (difficultyBasis "size-proxy"): kept for stratified reporting; never a hard stratum for adoption.
  const task = { id, family: familyOf(c.repo.slug), tier, difficultyBasis: "size-proxy", instruction: `${PREAMBLE(c.repo.slug, pkg.license)}\n\n${c.message}\n`, provenance: PROVENANCE, timeoutSec: 900, upstream: provenance };
  atomicWriteJson(join(dir, "task.json"), task);
  return { task, provenance };
}

// -------------------------------------------------------------------------------------------------------------- independence

/** Identifiers and content fingerprints that already appeared somewhere a new holdout must not overlap. */
export function knownCorpus({ orcheDir, packageDir = PACKAGE_DIR, pool, extraTextRoots = [] }) {
  const texts = [];
  const addTexts = (root, filter, depth, cap = 64 * 1024 * 1024) => {
    if (!existsSync(root)) return;
    const visit = (d, n) => {
      if (n > depth) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (!["node_modules", ".git", "cache", "cases", "batches"].includes(e.name)) { texts.push(e.name.toLowerCase()); visit(p, n + 1); } }
        else if (e.isFile() && filter(e.name) && statSync(p).size < cap) texts.push(readFileSync(p, "utf8").toLowerCase());
      }
    };
    visit(root, 0);
  };
  const coverage = [];
  for (const [root, filter, depth] of [[join(orcheDir, "experiments"), n => /\.(json|jsonl|ts|md|txt)$/.test(n), 6], [join(orcheDir, "docs"), n => n.endsWith(".md"), 2], [join(orcheDir, "results"), n => /\.(json|md)$/.test(n), 4], [join(packageDir, "records"), n => /\.(json|jsonl|md)$/.test(n), 4], [join(packageDir, "docs"), n => n.endsWith(".md"), 1], ...extraTextRoots.map(r => [r, n => /\.(json|jsonl|md|ts)$/.test(n), 4])]) {
    coverage.push({ root, scanned: existsSync(root) });
    addTexts(root, filter, depth);
  }
  // Content fingerprints of every earlier task (train/dev suite and bundled holdouts): reference + hidden + repo source files.
  const fileHashes = new Set(), packageNames = new Set(), families = new Set();
  const earlier = [];
  try { earlier.push(...loadSuite(join(orcheDir, "fixtures/suite"))); } catch { coverage.push({ root: join(orcheDir, "fixtures/suite"), scanned: false }); }
  const ds = join(packageDir, "datasets");
  if (existsSync(ds)) for (const d of readdirSync(ds)) { try { earlier.push(...loadLocal(join(ds, d))); } catch { coverage.push({ root: join(ds, d), scanned: false }); } }
  for (const t of earlier) {
    families.add(t.family);
    try { packageNames.add(JSON.parse(readFileSync(join(t.repo, "package.json"), "utf8")).name); } catch { /* none */ }
    for (const sub of ["hidden", "reference"]) for (const f of walkFiles(join(t.dir, sub))) if (f.symlink === undefined && f.size > 64) fileHashes.add(sha256(readFileSync(join(t.dir, sub, f.path))));
  }
  const state = pool ? poolState(pool) : undefined;
  const seenCommits = new Set(), seenPatches = new Set();
  for (const r of state?.cases.values() ?? []) { if (r.commit) seenCommits.add(r.commit); if (r.patchId) seenPatches.add(r.patchId); }
  return { texts, fileHashes, packageNames, families, seenCommits, seenPatches, coverage, earlierTasks: earlier.length };
}

/** Overlap reasons of one adapted case (codes only; empty = no overlap FOUND, which is not proof of absence). */
export function overlapOf(c, dir, corpus, patchId) {
  const codes = [];
  const slug = c.repo.slug.toLowerCase(), npm = c.repo.npm?.name?.toLowerCase();
  if (corpus.seenCommits.has(c.sha)) codes.push("commit-seen-in-supply");
  if (patchId && corpus.seenPatches.has(patchId)) codes.push("patch-seen-in-supply");
  if (corpus.families.has(familyOf(c.repo.slug)) || (npm && corpus.packageNames.has(npm))) codes.push("family-in-earlier-datasets");
  const needles = [slug, c.sha, c.sha.slice(0, 12), taskIdOf(c.repo.slug, c.sha)];
  if (corpus.texts.some(t => needles.some(n => t.includes(n)))) codes.push("named-in-earlier-experiments");
  for (const sub of ["hidden", "reference"]) for (const f of walkFiles(join(dir, sub))) if (f.size > 64 && corpus.fileHashes.has(sha256(readFileSync(join(dir, sub, f.path))))) { codes.push("content-matches-earlier-task"); break; }
  return [...new Set(codes)];
}

// -------------------------------------------------------------------------------------------------------------------- validation

/**
 * Mechanical validation in the grading sandbox, `repeats` times each: the original's visible suite passes; the original FAILS the
 * hidden tests with failing assertions reported by the runner (not a timeout); the reference passes the hidden tests and the
 * visible suite; hidden test counts are identical across repeats. Returns { ok, code, expected, detail } (detail is private).
 * `visibleSuite: "none"` (exercise sources whose upstream suite is the hidden spec, src/supply-exercism.mjs): the visible run must
 * still pass for original and reference but find NO tests (a visible suite that exists is not skipped), and the original must
 * execute exactly as many hidden tests as the reference (fails on the tests themselves, not on loading); all other checks apply.
 */
export async function validateCase(dir, { env, scratch, repeats = 2, timeoutMs = 120_000, gradeWorkspace, visibleSuite = "required" }) {
  if (!["required", "none"].includes(visibleSuite)) throw new Error(`validateCase: unknown visibleSuite ${visibleSuite}`);
  const task = { repo: join(dir, "repo"), hidden: join(dir, "hidden"), dir };
  const runs = { original: [], reference: [] };
  try {
    for (let i = 0; i < repeats; i++) {
      for (const which of ["original", "reference"]) {
        const ws = join(scratch, `${which}-${i}`);
        rmSync(ws, { recursive: true, force: true });
        cpSync(task.repo, ws, { recursive: true });
        if (which === "reference") cpSync(join(dir, "reference"), ws, { recursive: true, force: true });
        const g = await gradeWorkspace({ task, workspace: ws, scratch: join(scratch, `g-${which}-${i}`), env, timeoutMs });
        runs[which].push(g);
        rmSync(ws, { recursive: true, force: true });
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const o = runs.original, r = runs.reference;
  const detail = { original: o.map(g => ({ visible: g.visible && { pass: g.visible.pass, tests: g.visible.tests, failed: g.visible.failed, timeout: g.visible.timeout }, hidden: g.hidden && { pass: g.hidden.pass, tests: g.hidden.tests, failed: g.hidden.failed, timeout: g.hidden.timeout, failing: g.hidden.failing.slice(0, 5) }, error: g.error })), reference: r.map(g => ({ visible: g.visible && { pass: g.visible.pass, tests: g.visible.tests, failed: g.visible.failed, timeout: g.visible.timeout }, hidden: g.hidden && { pass: g.hidden.pass, tests: g.hidden.tests, failed: g.hidden.failed, timeout: g.hidden.timeout }, error: g.error })) };
  const fail = (code) => ({ ok: false, code, detail });
  if ([...o, ...r].some(g => g.error)) return fail("grader-error");
  if ([...o, ...r].some(g => g.visible?.timeout || g.hidden?.timeout)) return fail("timeout");
  if (visibleSuite === "required" && !o.every(g => g.visible?.pass && (g.visible.tests ?? 0) > 0)) return fail("original-visible-suite-not-passing-offline");
  if (visibleSuite === "none" && !o.every(g => g.visible?.pass && (g.visible.tests ?? 0) === 0)) return fail("visible-suite-not-empty-or-not-passing");
  if (o.some(g => g.hidden?.pass)) return fail("original-passes-hidden");
  if (!o.every(g => (g.hidden?.failed ?? 0) > 0 && (g.hidden?.failing?.length ?? 0) > 0)) return fail("original-hidden-failure-not-reported-as-failing-tests");
  if (!r.every(g => g.hidden?.pass)) return fail("reference-fails-hidden");
  if (!r.every(g => g.visible?.pass)) return fail("reference-breaks-visible-suite");
  if (visibleSuite === "none" && !o.every(g => g.hidden.tests === r[0].hidden.tests)) return fail("original-hidden-tests-not-executed");
  const counts = new Set(r.map(g => g.hidden.tests));
  const visibleCounts = new Set(o.map(g => g.visible.tests));
  if (counts.size !== 1 || visibleCounts.size !== 1 || new Set(o.map(g => g.hidden.failed)).size !== 1) return fail("non-deterministic-grading");
  return { ok: true, code: "valid", expected: { hiddenTests: r[0].hidden.tests }, detail };
}

// -------------------------------------------------------------------------------------------------------------------- collection

/**
 * One collection run: repositories -> qualifying commits -> adapted, deduplicated, validated cases in <pool>/cases. Rejections
 * are recorded with reason codes only. Returns a non-secret summary.
 * @param {{ pool: string, cfg: any, repos?: any[], env?: any, orcheDir: string, packageDir?: string, log?: (s: string) => void, validate?: (dir: string) => Promise<any>, fetchJson?: (url: string) => Promise<any>, maxCasesPerRepo?: number }} options
 */
export async function collect({ pool, cfg, repos, env, orcheDir, packageDir = PACKAGE_DIR, log = () => {}, validate, fetchJson, maxCasesPerRepo = Infinity }) {
  pool = poolPath(pool);
  ensureDir(pool, 0o700);
  chmodSync(pool, 0o700); // other accounts cannot enter; same-account processes can (see LIMITATIONS)
  const reg = registryOf(pool);
  if (reg.verify().length) throw new Error(`supply registry tampered: ${reg.verify().join("; ")}`);
  const cfgDigest = digestOf(cfg);
  if (!reg.records().some(r => r.type === "config" && r.digest === cfgDigest)) reg.append({ type: "config", schema: SUPPLY_SCHEMA, digest: cfgDigest, config: cfg });
  const summary = { schema: SUPPLY_SCHEMA, at: new Date().toISOString(), config: cfgDigest, repositories: 0, commitsQualified: 0, commitRejects: {}, caseRejects: {}, eligible: [], errors: [] };
  repos ??= await discoverRepos(cfg, { fetchJson, log });
  summary.repositories = repos.length;
  summary.discovered = repos.map(r => r.slug);
  const corpus = knownCorpus({ orcheDir, packageDir, pool });
  summary.scanCoverage = corpus.coverage;
  const count = (map, code) => { map[code] = (map[code] ?? 0) + 1; };
  for (const repo of repos) {
    let clone;
    try { clone = cloneRepo(repo, ensureDir(join(pool, "cache", "repos"))); } catch (error) { summary.errors.push({ repo: repo.slug, code: "clone-failed", message: String(error.message).slice(0, 200) }); continue; }
    let scanned;
    try { scanned = scanCommits(clone, repo, cfg); } catch (error) { summary.errors.push({ repo: repo.slug, code: "scan-failed", message: String(error.message).slice(0, 200) }); continue; }
    for (const r of scanned.rejects) count(summary.commitRejects, r.code);
    let kept = 0, validated = 0;
    for (const c of scanned.cases) {
      if (kept >= maxCasesPerRepo || validated >= cfg.commits.maxValidatePerRepo) break;
      const caseId = taskIdOf(repo.slug, c.sha);
      if (corpus.seenCommits.has(c.sha)) { count(summary.caseRejects, "commit-seen-in-supply"); continue; }
      summary.commitsQualified++;
      const dir = join(pool, "cases", caseId);
      const decide = (status, code, extra = {}) => {
        reg.append({ type: "case", caseId, status, code, repo: repo.slug, commit: c.sha, ...extra });
        corpus.seenCommits.add(c.sha); if (extra.patchId) corpus.seenPatches.add(extra.patchId);
        if (status === "rejected") { count(summary.caseRejects, code); rmSync(dir, { recursive: true, force: true }); }
      };
      let patchId;
      try { patchId = execFileSync("git", ["patch-id", "--stable"], { input: git(clone.dir, ["diff-tree", "-p", c.parent, c.sha]) }).toString().split(" ")[0] || undefined; } catch { patchId = undefined; }
      let ex;
      try { ex = extractCase(clone, c, cfg, dir); } catch (error) { decide("rejected", "extraction-failed", { patchId }); log(`${caseId}: extraction failed ${String(error.message).slice(0, 120)}`); continue; }
      if (ex.reject) { decide("rejected", ex.reject, { patchId }); continue; }
      const overlap = overlapOf(c, dir, corpus, patchId);
      if (overlap.length) { decide("rejected", overlap[0], { patchId, overlap }); continue; }
      validated++;
      const v = await validate(dir);
      // Private: the detail can name hidden tests; it stays in the case directory (never in reports or the registry).
      atomicWriteJson(join(dir, "validation.private.json"), v);
      if (!v.ok) { decide("rejected", v.code, { patchId }); continue; }
      const task = ex.task;
      task.expected = v.expected;
      atomicWriteJson(join(dir, "task.json"), task);
      decide("eligible", "valid", { patchId, family: task.family, tier: task.tier, difficultyBasis: task.difficultyBasis, contentDigest: caseDigest(dir) });
      summary.eligible.push({ id: caseId, family: task.family, tier: task.tier, url: ex.provenance.commitUrl, license: ex.provenance.license.spdx });
      kept++;
      log(`${caseId}: eligible (${task.tier})`);
    }
  }
  return summary;
}

/** Digest of a task directory as sealed (task.json, repo, hidden, reference). */
export const caseDigest = (dir) => digestOf(Object.fromEntries(walkFiles(dir, { skip: [] }).filter(f => f.symlink === undefined && !f.path.endsWith(".private.json")).map(f => [f.path, sha256(readFileSync(join(dir, f.path)))])));

// ----------------------------------------------------------------------------------------------------------------- batch + seal

/**
 * Candidate-blind batch: eligible, not yet batched cases ordered by sha256(seed:id); the first hard case (by that order) first,
 * then fill in order with at most `maxPerFamily` per repository and `maxPerOwner` per account, up to `maxTasks`. A case is hard only
 * with tier hard AND a difficulty basis in `minima.hardBasis` (registry records without a basis are supply-built: size-proxy).
 * Returns { ids, coverage, ok, why }.
 */
export function selectBatch(eligible, cfg, minima) {
  const order = [...eligible].sort((a, b) => sha256(`${cfg.batch.seed}:${a.caseId}`).localeCompare(sha256(`${cfg.batch.seed}:${b.caseId}`)));
  const picked = [], perFamily = {}, perOwner = {};
  // Owner = the GitHub account of the repository: several repositories of one author share style and habits.
  const ownerOf = (c) => String(c.family).replace(/^gh:/, "").split("/")[0];
  const add = (c) => {
    const o = ownerOf(c);
    if (picked.includes(c) || (perFamily[c.family] ?? 0) >= cfg.batch.maxPerFamily || (perOwner[o] ?? 0) >= (cfg.batch.maxPerOwner ?? Infinity) || picked.length >= cfg.batch.maxTasks) return;
    picked.push(c); perFamily[c.family] = (perFamily[c.family] ?? 0) + 1; perOwner[o] = (perOwner[o] ?? 0) + 1;
  };
  const isHard = (c) => c.tier === "hard" && (minima.hardBasis ?? []).includes(c.difficultyBasis ?? "size-proxy");
  const hard = order.find(isHard);
  if (hard) add(hard);
  for (const c of order) add(c);
  const coverage = { tasks: picked.length, families: Object.keys(perFamily).length, owners: Object.keys(perOwner).length, hard: picked.filter(isHard).length, hardByUnacceptedBasis: picked.filter(c => c.tier === "hard" && !isHard(c)).length };
  const why = [];
  if (coverage.tasks < minima.minTasks) why.push(`tasks ${coverage.tasks} < ${minima.minTasks}`);
  if (coverage.families < minima.minFamilies) why.push(`families ${coverage.families} < ${minima.minFamilies}`);
  if (minima.requireHard && coverage.hard < 1) why.push(`no hard task with an accepted difficulty basis ${JSON.stringify(minima.hardBasis ?? [])} (size-proxy tiers do not count)`);
  return { ids: picked.map(c => c.caseId), coverage, ok: why.length === 0, why: why.join("; ") };
}

/** Form and seal one batch from eligible cases (if coverage allows). Returns { batch, dir, coverage } or { blocked: why }. */
export function sealBatch({ pool, cfg, minima, now = new Date() }) {
  pool = poolPath(pool);
  const lock = acquireLock(join(pool, ".pool.lock"));
  try {
    const st = poolState(pool);
    if (st.chain.length) throw new Error(`supply registry tampered: ${st.chain.join("; ")}`);
    const cfgDigest = digestOf(cfg);
    if (!st.records.some(r => r.type === "config" && r.digest === cfgDigest)) registryOf(pool).append({ type: "config", schema: SUPPLY_SCHEMA, digest: cfgDigest, config: cfg });
    const eligible = [...st.cases.values()].filter(r => r.status === "eligible" && !st.batched.has(r.caseId) && existsSync(join(pool, "cases", r.caseId, "task.json")) && caseDigest(join(pool, "cases", r.caseId)) === r.contentDigest);
    const sel = selectBatch(eligible, cfg, minima);
    if (!sel.ok) return { blocked: `insufficient eligible supply: ${sel.why}`, coverage: sel.coverage, eligible: eligible.length };
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const batch = `b${stamp}-${digestOf(sel.ids).slice(0, 8)}`;
    const dir = join(pool, "batches", batch), tmp = `${dir}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    ensureDir(tmp);
    const provenance = [];
    for (const id of sel.ids) {
      const src = join(pool, "cases", id);
      ensureDir(join(tmp, id));
      for (const part of ["task.json", "repo", "hidden", "reference"]) if (existsSync(join(src, part))) cpSync(join(src, part), join(tmp, id, part), { recursive: true });
      const t = readJson(join(src, "task.json"));
      provenance.push({ id, family: t.family, tier: t.tier, difficultyBasis: t.difficultyBasis ?? "size-proxy", ...(t.difficultySource ? { difficultySource: t.difficultySource } : {}), provenance: t.provenance, upstream: t.upstream });
    }
    atomicWriteJson(join(tmp, "PROVENANCE.json"), { schema: SUPPLY_SCHEMA, batch, createdAt: now.toISOString(), selection: { rule: "sha256(seed:id) order, first hard case first, maxPerFamily, maxPerOwner, maxTasks", seed: cfg.batch.seed, maxTasks: cfg.batch.maxTasks, maxPerFamily: cfg.batch.maxPerFamily, maxPerOwner: cfg.batch.maxPerOwner, candidateBlind: true }, configDigest: digestOf(cfg), coverage: sel.coverage, tasks: provenance, limitations: [...new Set([...LIMITATIONS, ...provenance.flatMap(p => p.upstream?.limitations ?? [])])] });
    const seal = sealOf(tmp);
    if (seal.symlinks.length) throw new Error(`symlinks in batch: ${seal.symlinks.join(", ")}`);
    atomicWriteJson(join(tmp, "SEAL.json"), { ...seal, schema: SUPPLY_SCHEMA, batch, sealedAt: now.toISOString() });
    renameSync(tmp, dir);
    registryOf(pool).append({ type: "batch", batch, dir: relative(pool, dir), tasks: sel.ids, sealDigest: seal.digest, coverage: sel.coverage });
    for (const id of sel.ids) rmSync(join(pool, "cases", id), { recursive: true, force: true });
    return { batch, dir, coverage: sel.coverage, seal: seal.digest };
  } finally { lock.release(); }
}

export const LIMITATIONS = [
  "Public upstream code: absence from model pretraining data is not established; the commit date cutoff and duplicate checks reduce, not exclude, that risk.",
  "Overlap checks cover exact commits, git patch-ids, file content hashes, repository/package names and texts of earlier experiments and records; semantic near-duplicates in other repositories are not detected.",
  "Tiers of commit-built tasks are a size proxy of the upstream fix (changed code files/lines; difficultyBasis size-proxy), not established difficulty: they never count for the hard stratum. Tasks of an annotated source (difficultyBasis source, e.g. Exercism) carry the source's own annotation instead.",
  "Same-account storage: the pool is outside model-facing sandboxes (bubblewrap hides /home) and mode 0700, but any process of the same user outside a sandbox can read it.",
];

// ------------------------------------------------------------------------------------------------------------ eligibility + use

/** Holdout eligibility of a sealed batch under a protocol: holdoutStatus (seal, provenance, exposure, uses, ledger chain) + coverage. */
/** @param {string} dir @param {any} protocol @param {{ orcheDir?: string, tasks?: any[] }} [options] */
export function batchEligibility(dir, protocol, { orcheDir, tasks } = {}) {
  let list;
  try { list = tasks ?? loadLocal(dir); } catch (error) { return { ok: false, reasons: [`unreadable batch: ${error.message}`] }; }
  const status = holdoutStatus(list, dir, protocol, { orcheDir });
  const reasons = status.independent ? [] : [status.why];
  const families = new Set(list.map(t => t.family)).size, hard = list.filter(t => holdoutHard(t, protocol)).length, hardUnverified = list.filter(t => t.hard && !holdoutHard(t, protocol)).length;
  if (list.length < protocol.holdout.minTasks) reasons.push(`holdout too small: ${list.length} tasks (need ${protocol.holdout.minTasks})`);
  if (families < protocol.holdout.minFamilies) reasons.push(`holdout too narrow: ${families} families (need ${protocol.holdout.minFamilies})`);
  if (protocol.adoption.requireHardStratum && hard === 0) reasons.push(`holdout has no hard stratum: no hard task with an accepted difficulty basis ${JSON.stringify(protocol.holdout.hardBasis)}${hardUnverified ? ` (${hardUnverified} hard by size-proxy or another unaccepted basis: coverage UNVERIFIED)` : ""}`);
  return { ok: reasons.length === 0, reasons, coverage: { tasks: list.length, families, hard, hardUnverified }, uses: status.uses, seal: status.seal };
}

const stateKey = (stateDir) => { const abs = resolve(stateDir); try { return realpathSync(abs); } catch { return abs; } };

/** The batch already reserved for this state directory (read-only), or undefined. */
export function assignmentFor(pool, stateDir) {
  pool = poolPath(pool);
  const st = poolState(pool);
  if (st.chain.length) throw new Error(`supply registry tampered: ${st.chain.join("; ")}`);
  const r = st.reservations.get(stateKey(stateDir));
  return r ? { batch: r.batch, dir: join(pool, "batches", r.batch), reservedAt: r.at, seq: r.seq } : undefined;
}

/**
 * Reserve an eligible, unreserved, unused batch for a state directory (idempotent: the same state always gets its first
 * reservation back; a pool lock serializes competing experiments). Returns the assignment or { none: reasons }.
 */
/** @param {string} pool @param {string} stateDir @param {any} protocol @param {{ orcheDir?: string }} [options] @returns {any} */
export function reserveBatch(pool, stateDir, protocol, { orcheDir } = {}) {
  pool = poolPath(pool);
  if (!existsSync(join(pool, "registry.jsonl"))) return { none: ["no supply registry in the pool"] };
  const lock = acquireLock(join(pool, ".pool.lock"));
  try {
    const existing = assignmentFor(pool, stateDir);
    if (existing) return existing;
    const pick = firstEligibleBatch(pool, protocol, { orcheDir });
    if (pick.none) return pick;
    const r = registryOf(pool).append({ type: "reserve", batch: pick.batch, stateDir: stateKey(stateDir), sealDigest: pick.sealDigest });
    return { batch: pick.batch, dir: pick.dir, reservedAt: r.at, seq: r.seq };
  } finally { lock.release(); }
}

/** First sealed batch (registry order) that is unreserved, seal-intact (matching the registry) and eligible; or { none: reasons }. */
/** @param {string} pool @param {any} protocol @param {{ orcheDir?: string }} [options] @returns {any} */
export function firstEligibleBatch(pool, protocol, { orcheDir } = {}) {
  const st = poolState(pool);
  if (st.chain.length) throw new Error(`supply registry tampered: ${st.chain.join("; ")}`);
  const reasons = [];
  for (const b of [...st.batches.values()].sort((x, y) => x.seq - y.seq)) {
    if (st.reservedBatches.has(b.batch)) { reasons.push(`${b.batch}: reserved by another experiment`); continue; }
    const dir = join(pool, "batches", b.batch);
    const seal = existsSync(dir) ? verifySeal(dir) : { ok: false, why: "missing" };
    if (!seal.ok || seal.seal?.digest !== b.sealDigest) { reasons.push(`${b.batch}: seal ${seal.ok ? "differs from the registry" : seal.why}`); continue; }
    const e = batchEligibility(dir, protocol, { orcheDir });
    if (!e.ok) { reasons.push(`${b.batch}: ${e.reasons.join("; ")}`); continue; }
    return { batch: b.batch, dir, sealDigest: b.sealDigest, coverage: e.coverage };
  }
  return { none: reasons.length ? reasons : ["no sealed batch in the pool"] };
}

/** Non-secret pool overview: batches with eligibility, reservations, uses; case counts by status/reason code. */
/** @param {string} pool @param {any} protocol @param {{ orcheDir?: string }} [options] */
export function poolStatus(pool, protocol, { orcheDir } = {}) {
  pool = poolPath(pool);
  const st = poolState(pool);
  const batches = [...st.batches.values()].map(b => {
    const dir = join(pool, "batches", b.batch);
    const reservedBy = [...st.reservations.values()].find(r => r.batch === b.batch)?.stateDir ?? null;
    const e = existsSync(dir) ? batchEligibility(dir, protocol, { orcheDir }) : { ok: false, reasons: ["batch directory missing"] };
    // coverageAtSeal: the counts recorded when sealed (nominal tiers); coverageNow: what the protocol accepts today.
    return { batch: b.batch, tasks: b.tasks.length, coverageAtSeal: b.coverage, coverageNow: e.coverage ?? null, reservedBy, uses: existsSync(dir) ? holdoutLedger(dir).records().length : null, eligibleNow: e.ok, reasons: e.reasons };
  });
  const cases = {};
  for (const r of st.cases.values()) { const k = `${r.status}:${r.code}`; cases[k] = (cases[k] ?? 0) + 1; }
  return { schema: SUPPLY_SCHEMA, pool, registryIntact: st.chain.length === 0, batches, unbatchedEligible: [...st.cases.values()].filter(r => r.status === "eligible" && !st.batched.has(r.caseId)).length, cases };
}


/**
 * Read-only holdout preflight of a protocol for a state directory (CLI --preflight): which batch the experiment has or would
 * reserve, and whether it is sealed, accepted, unexposed, unused and covers the minima. Writes nothing.
 */
/** @param {any} protocol @param {string} stateDir @param {{ orcheDir?: string }} [options] @returns {any} */
export function preflightReport(protocol, stateDir, { orcheDir } = {}) {
  const out = { schema: "pi-eval-loop/preflight@1", stateDir, ok: false, reasons: [] };
  if (protocol.datasets.holdoutPool) {
    const pool = poolPath(resolve(PACKAGE_DIR, protocol.datasets.holdoutPool));
    out.pool = pool;
    const a = assignmentFor(pool, stateDir);
    if (a) out.holdout = { source: "reserved", batch: a.batch, dir: a.dir };
    else {
      const pick = existsSync(join(pool, "registry.jsonl")) ? firstEligibleBatch(pool, protocol, { orcheDir }) : { none: ["no supply registry in the pool"] };
      if (pick.none) { out.reasons.push("no eligible unused batch to reserve", ...pick.none.slice(0, 10)); return out; }
      out.holdout = { source: "would-reserve", batch: pick.batch, dir: pick.dir };
    }
  } else if (protocol.datasets.holdout) out.holdout = { source: "protocol", dir: resolve(PACKAGE_DIR, protocol.datasets.holdout) };
  else { out.reasons.push("exploration-only protocol (datasets.holdout = null): no holdout; deployment is BLOCKED by design"); return out; }
  const e = batchEligibility(out.holdout.dir, protocol, { orcheDir });
  Object.assign(out, { ok: e.ok, coverage: e.coverage, uses: e.uses, note: "model-free; per-task grader validation runs at prepare, before the search" });
  out.reasons.push(...e.reasons);
  return out;
}
