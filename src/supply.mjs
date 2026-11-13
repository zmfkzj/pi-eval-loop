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
import { builtinModules } from "node:module";
import { acquireLock, atomicWriteJson, digestOf, ensureDir, fault, Ledger, readJson, sha256, sleep, walkFiles } from "./util.mjs";
import { difficultyBasisOf, holdoutHard, holdoutLedger, holdoutStatus, loadLocal, loadSuite, reviewClass, reviewProblems, sealOf, taskContentDigest, verifySeal } from "./datasets.mjs";
import { planCompleteness, planPath, seriesFits } from "./design.mjs";
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
    // Diversity of the commit source (2026-11-06): at most this many repositories of one GitHub account per collection (the
    // first pool was 9/15 sindresorhus), and repositories never scanned before go first, then the least recently scanned
    // (registry `scan` records), so repeated collections cover new projects instead of re-reading the same 60.
    maxReposPerOwner: 3, preferUnscanned: true,
  },
  commits: { maxScanPerRepo: 60, maxValidatePerRepo: 6, maxCodeFiles: 6, maxCodeLines: 400, maxTestFiles: 4, maxRepoBytes: 8 * 1024 * 1024, minSubjectChars: 12, maxTimeoutsPerRepo: 2 },
  excludeAuthors: ["[bot]", "dependabot", "renovate", "github-actions", "greenkeeper"],
  excludeSubjects: "^(v?\\d+\\.\\d+|bump|release|merge|chore|ci|build|docs?|style|lint|meta|update dependencies)\\b|\\btweaks?\\b|\\btypo",
  tiers: { easyMaxLines: 10, mediumMaxLines: 60, hardMinFiles: 3 },
  validation: { repeats: 2, timeoutMs: 120_000 },
  // maxOwnerShare (2026-11-06): no GitHub account may hold more than this share of the tasks actually sealed (the first eligible
  // batch was 4/6 = 67% sindresorhus). preferFreshFamilies: candidate-blind ordering puts families that were never in an earlier
  // batch first (less correlation between consecutive experiments' holdouts); it never relaxes a cap or minimum.
  batch: { maxTasks: 12, maxPerFamily: 2, maxPerOwner: 4, maxOwnerShare: 0.5, preferFreshFamilies: true, seed: "supply-v1" },
  // Cross-family overlap (2026-11-06): a case whose reference code is a lexical near-duplicate (identifier-abstracted 6-token
  // shingles, Jaccard >= nearDuplicateJaccard, both sides >= minShingles) of an earlier task of ANOTHER family, or whose
  // repository shares a root commit with another family's repository (fork/mirror), is rejected. Lexical only: semantic
  // independence is not established.
  dedupe: { nearDuplicateJaccard: 0.7, minShingles: 40 },
  // Annotated source (src/supply-exercism.mjs, `collect-exercism`): Exercism tracks whose maintainers annotate each exercise's
  // difficulty (1-10) and whose docs map 8-10 to hard. Only the tiers listed are collected (the missing hard stratum). Tracks:
  // JavaScript (since 2026-11-05) and TypeScript (2026-11-06; a separate family, same `exercism` account). An Exercism problem
  // is taken once per pool across tracks (TypeScript ports share the canonical problem and test data of the JavaScript ones).
  // Benchmark exclusion: an exercise listed for the track's benchmark language is always excluded (TypeScript ports are judged
  // by the JavaScript list); listings in the other languages are recorded per task as exposure evidence and exclude it too
  // only with excludeScope "any-language".
  exercism: {
    tracks: [
      { slug: "exercism/javascript", benchmarkLanguage: "javascript", specSuffix: ".spec.js", solutionExt: ".js", vendor: { expect: "30.3.0" } },
      { slug: "exercism/typescript", benchmarkLanguage: "javascript", specSuffix: ".test.ts", solutionExt: ".ts", vendor: { expect: "29.7.0" }, renameVisibleSpec: true, dropFromRepo: ["test-runner.mjs"], licenseFrom: "track" },
    ],
    rubric: { slug: "exercism/docs", path: "building/tracks/config-json.md" },
    tiers: ["hard"], maxValidate: 12,
    excludeListedIn: [{ name: "aider-polyglot-benchmark", slug: "aider-ai/polyglot-benchmark", path: "{language}/exercises/practice", languages: ["cpp", "go", "java", "javascript", "python", "rust"] }],
    excludeScope: "track-language",
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

/** Files `node --test` starts without arguments (Node >= 23 defaults, type-stripped .ts variants included; node_modules excluded). */
export const isNodeDefaultTest = (p) => !p.split("/").includes("node_modules") && /\.[cm]?[jt]s$/.test(p) && !DECL.test(p) && (/(^|\/)test\/./.test(p) || /(^|\/)(test|test-[^/]+|[^/]+[.\-_]test)\.[cm]?[jt]s$/.test(p));
const BUILTINS = new Set(builtinModules.map(m => m.replace(/^node:/, "")));
/**
 * Bare package names a source text imports unconditionally: statement-level static `import`/`export ... from` and statement-level
 * `require` (`const x = require("p")`, `require("p")`). Conservative on purpose (a hit must be a certain load at module start):
 * `import type` (erased), dynamic `import()`, nested/optional requires, comments, relative/absolute/URL specifiers and package
 * `#imports` are not counted, so what static reading cannot resolve is left to the sandbox validation.
 */
export function bareImports(text) {
  const src = String(text).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  const out = new Set();
  const re = /^[ \t]*(?:import\s+(?!type\s)(?:[\w$*{}\s,]+?\s+from\s+)?|export\s+(?!type\s)[\w$*{}\s,]+?\s+from\s+|(?:(?:const|let|var)\s+[\w${}\s,:]+?=\s*)?require\s*\(\s*)(['"])([^'"\n]+)\1/gm;
  for (const m of src.matchAll(re)) {
    const s = m[2];
    if (/^(\.|\/|#|[a-z][a-z0-9+.-]*:)/i.test(s)) continue; // relative, absolute, #imports, node:, file:, data:
    const parts = s.split("/");
    out.add(s.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  }
  return [...out];
}
/** Packages imported by default-run tests of `repoDir` or by any hidden code file that are neither builtins nor `self`. */
export function unavailableImports(repoDir, hiddenDir, self) {
  const files = [...walkFiles(repoDir, { skip: [] }).filter(f => f.symlink === undefined && isNodeDefaultTest(f.path)).map(f => join(repoDir, f.path)),
    ...(hiddenDir && existsSync(hiddenDir) ? walkFiles(hiddenDir, { skip: [] }).filter(f => f.symlink === undefined && CODE.test(f.path) && !DECL.test(f.path)).map(f => join(hiddenDir, f.path)) : [])];
  const missing = new Set();
  for (const file of files) for (const name of bareImports(readFileSync(file, "utf8"))) if (!BUILTINS.has(name) && name !== self) missing.add(name);
  return [...missing].sort();
}

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
/**
 * Pool policy (POLICY.json, optional): {schema: "pi-eval-loop/pool-policy@1", autoSeal: false, sealVia: "<selector>"} makes the
 * CLI's collect/refresh never seal and its generic `seal` refuse. Absent = {} (unchanged behaviour); unreadable or malformed
 * fails closed (throws), so a damaged policy can never silently re-enable sealing.
 * @param {string} pool
 * @returns {{ autoSeal?: boolean, sealVia?: string }}
 */
export function poolPolicy(pool) {
  const f = join(pool, "POLICY.json");
  if (!existsSync(f)) return {};
  let p; try { p = JSON.parse(readFileSync(f, "utf8")); } catch (error) { throw new Error(`pool policy ${f} unreadable: ${error.message}`); }
  if (p?.schema !== "pi-eval-loop/pool-policy@1" || typeof p.autoSeal !== "boolean") throw new Error(`pool policy ${f} malformed (schema pi-eval-loop/pool-policy@1 with boolean autoSeal required)`);
  if (p.requireEvidence !== undefined && !(Array.isArray(p.requireEvidence) && p.requireEvidence.every(x => typeof x === "string" && /^[A-Za-z0-9._-]+$/.test(x)))) throw new Error(`pool policy ${f} malformed (requireEvidence must be a list of file names)`);
  return p;
}
export const registryOf = (pool) => new Ledger(join(pool, "registry.jsonl"));

export function poolState(pool) {
  const reg = registryOf(pool);
  const records = reg.records();
  const cases = new Map(), batches = new Map(), reservations = new Map(), retired = new Map();
  for (const r of records) {
    if (r.type === "case") cases.set(r.caseId, r);
    else if (r.type === "batch") batches.set(r.batch, r);
    else if (r.type === "reserve") { if (!reservations.has(r.stateDir)) reservations.set(r.stateDir, r); }
    // A retired batch (retireBatch: sealed, never reserved, never used) is no batch any more: never reserved, sealed from or
    // counted; its directory and records stay as provenance.
    else if (r.type === "retire" && batches.has(r.batch)) { retired.set(r.batch, { ...batches.get(r.batch), retire: r }); batches.delete(r.batch); }
  }
  const batched = new Set([...batches.values()].flatMap(b => b.tasks));
  const reservedBatches = new Set([...reservations.values()].map(r => r.batch));
  return { records, chain: reg.verify(), cases, batches, reservations, batched, reservedBatches, retired };
}

// -------------------------------------------------------------------------------------------------------------------- discovery

/**
 * Candidate repositories from the npm registry: latest version's test script runs `node --test`, no runtime dependencies,
 * an accepted SPDX license and a GitHub repository. Order: keyword order, then registry search order (both recorded).
 */
/** @param {any} cfg @param {{ fetchJson?: (url: string) => Promise<any>, log?: (line: string) => void, lastScan?: Map<string, string> }} [options] */
export async function discoverRepos(cfg, { fetchJson = defaultFetchJson, log = () => {}, lastScan = new Map() } = {}) {
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
  const qualifying = new Map();
  const names = [...seen.keys()];
  const latest = new Array(names.length);
  let next = 0;
  // Packuments in parallel (8), evaluated afterwards in discovery order (the result does not depend on fetch timing).
  await Promise.all(Array.from({ length: 8 }, async () => { while (next < names.length) { const i = next++; try { latest[i] = await fetchJson(`https://registry.npmjs.org/${names[i].replace("/", "%2f")}/latest`); } catch { latest[i] = null; } } }));
  for (let i = 0; i < names.length; i++) {
    const name = names[i], meta = seen.get(name), p = latest[i];
    if (!p) continue;
    const test = String(p.scripts?.test ?? "");
    if (!/(^|[\s;&|(])node\b[^&|;]*\s--test\b/.test(test)) continue;
    if (Object.keys(p.dependencies ?? {}).length) continue;
    if (!licenseAccepted(p.license, cfg.licenses)) continue;
    const slug = githubSlug(typeof p.repository === "string" ? p.repository : p.repository?.url);
    if (!slug || qualifying.has(slug)) continue;
    qualifying.set(slug, { slug, url: `https://github.com/${slug}.git`, npm: { name, version: p.version, license: p.license }, keyword: meta.keyword });
  }
  const repos = orderRepos([...qualifying.values()], cfg.discovery, lastScan);
  log(`discovery: ${qualifying.size} qualifying repositories, ${repos.length} taken (max ${cfg.discovery.maxRepos}, ${cfg.discovery.maxReposPerOwner ?? "any"} per account)`);
  return repos;
}

/**
 * Order and cap qualifying repositories (deterministic; no task or model result is an input): with `preferUnscanned`, never
 * scanned repositories first, then by oldest last scan (registry `scan` records), discovery order otherwise; at most
 * `maxReposPerOwner` per GitHub account and `maxRepos` in total.
 * @param {any[]} repos @param {any} discovery @param {Map<string, string>} [lastScan]
 */
export function orderRepos(repos, discovery, lastScan = new Map()) {
  const ordered = discovery.preferUnscanned ? repos.map((r, i) => ({ r, i, at: lastScan.get(r.slug) ?? "" })).sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i).map(x => x.r) : [...repos];
  const perOwner = {}, out = [];
  for (const r of ordered) {
    if (out.length >= discovery.maxRepos) break;
    const owner = r.slug.split("/")[0];
    // Cross-pool exclusion (2026-11-07): repositories and accounts an exploration's lineage sources already hold are skipped before
    // cloning (their families are forbidden anyway; they used the per-collection repository budget before).
    if (discovery.excludeRepos?.includes(r.slug.toLowerCase()) || discovery.excludeOwners?.includes(owner.toLowerCase())) continue;
    if ((perOwner[owner] ?? 0) >= (discovery.maxReposPerOwner ?? Infinity)) continue;
    perOwner[owner] = (perOwner[owner] ?? 0) + 1;
    out.push(r);
  }
  return out;
}

/** Last scan time per repository slug: registry `scan` records, and for pools older than them (2026-11-05) commit-case decisions. */
export function lastScans(records) {
  const m = new Map();
  for (const r of records) if ((r.type === "scan" || (r.type === "case" && r.commit)) && r.repo && (r.at ?? "") >= (m.get(r.repo) ?? "")) m.set(r.repo, r.at ?? "");
  return m;
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
  // Offline precheck (mechanical, before the costly sandbox validation and its per-repository budget): grading runs `node --test`
  // offline with no node_modules, so a test file the runner starts (visible) or a hidden test that imports a package which is
  // neither a Node builtin nor this package itself cannot pass. 2026-11-05: most of the 56 "original-visible-suite-not-passing-
  // offline" rejections were such imports (ava, tape, delay, sinon, expect, ...). Validation still runs on everything else.
  const missing = unavailableImports(repoDir, hidden, pkg.name);
  if (missing.length) return { reject: "test-imports-unavailable-package", missing };
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
    lineage: lineageOf(clone.dir, c.sha),
  };
  // tier = the size proxy (difficultyBasis "size-proxy"): kept for stratified reporting; never a hard stratum for adoption.
  const task = { id, family: familyOf(c.repo.slug), tier, difficultyBasis: "size-proxy", instruction: `${PREAMBLE(c.repo.slug, pkg.license)}\n\n${c.message}\n`, provenance: PROVENANCE, timeoutSec: 900, upstream: provenance };
  atomicWriteJson(join(dir, "task.json"), task);
  return { task, provenance };
}

// -------------------------------------------------------------------------------------------------------------- independence

/** Identifiers and content fingerprints that already appeared somewhere a new holdout must not overlap. */
export function knownCorpus({ orcheDir, packageDir = PACKAGE_DIR, pool, extraTextRoots = [], extraPools = [], excludeCases = new Set() }) {
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
  // Lineage (2026-11-06): root commits of every earlier repository (registry case records, sealed batch provenance) by family,
  // so a fork, mirror or renamed copy of an earlier repository (same root commit, other family) is recognized.
  const rootFamilies = new Map();
  const addRoots = (roots, family) => { for (const root of roots ?? []) { if (!rootFamilies.has(root)) rootFamilies.set(root, new Set()); rootFamilies.get(root).add(family); } };
  for (const r of state?.cases.values() ?? []) if (r.rootCommits) addRoots(r.rootCommits, r.family ?? familyOf(r.repo ?? ""));
  // Near-duplicate index: code shingles of the reference solutions of every earlier task (suite, datasets, staged cases, batches).
  const shingleIndex = [];
  const indexTask = (id, family, dir) => { const set = codeShingles(dir); if (set.size) shingleIndex.push({ id, family, set }); };
  for (const t of earlier) indexTask(t.id, t.family, t.dir);
  if (pool) {
    for (const root of [join(pool, "cases"), ...(state ? [...state.batches.keys()].map(b => join(pool, "batches", b)) : [])]) {
      if (!existsSync(root)) continue;
      for (const id of readdirSync(root)) {
        const tj = join(root, id, "task.json");
        if (!existsSync(tj)) continue;
        if (root === join(pool, "cases") && excludeCases.has(id)) continue; // a staged case being superseded by its own new version
        try { const m = JSON.parse(readFileSync(tj, "utf8")); indexTask(m.id ?? id, m.family, join(root, id)); if (m.upstream?.lineage?.rootCommits) addRoots(m.upstream.lineage.rootCommits, m.family); } catch { /* unreadable: not indexed */ }
      }
    }
  }
  // Other pools (read-only, e.g. the live supply pool an isolated pool must not duplicate): their staged and sealed tasks join the
  // content-hash and near-duplicate indexes and their task ids the text index; nothing in them is written.
  for (const other of extraPools) {
    const roots = [join(other, "cases"), ...(existsSync(join(other, "batches")) ? readdirSync(join(other, "batches")).map(b => join(other, "batches", b)) : [])];
    coverage.push({ root: other, scanned: existsSync(other) });
    for (const root of roots) {
      if (!existsSync(root) || !statSync(root).isDirectory()) continue;
      for (const id of readdirSync(root)) {
        const dir = join(root, id), tj = join(dir, "task.json");
        if (!existsSync(tj)) continue;
        try { const m = JSON.parse(readFileSync(tj, "utf8")); texts.push(String(m.id ?? id).toLowerCase()); families.add(m.family); indexTask(m.id ?? id, m.family, dir); for (const sub of ["hidden", "reference"]) for (const f of walkFiles(join(dir, sub))) if (f.symlink === undefined && f.size > 64) fileHashes.add(sha256(readFileSync(join(dir, sub, f.path)))); } catch { /* unreadable: not indexed */ }
      }
    }
  }
  return { texts, fileHashes, packageNames, families, seenCommits, seenPatches, rootFamilies, shingleIndex, coverage, earlierTasks: earlier.length };
}

/**
 * Repository lineage of a commit: its root commit(s) and whether the clone holds the complete history (a shallow clone's roots are
 * only its cut-off points, so lineage is then unknown, never "independent").
 */
export function lineageOf(cloneDir, sha) {
  try {
    const shallow = gitText(cloneDir, ["rev-parse", "--is-shallow-repository"]) === "true";
    if (shallow) return { complete: false, rootCommits: [], why: "shallow clone" };
    return { complete: true, rootCommits: gitText(cloneDir, ["rev-list", "--max-parents=0", sha]).split("\n").filter(Boolean).sort() };
  } catch (error) { return { complete: false, rootCommits: [], why: String(error.message).slice(0, 120) }; }
}

const JS_KEYWORDS = new Set("break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while with yield async await of static get set interface type implements enum readonly private public protected as from".split(" "));
/**
 * Lexical fingerprint of code: comments dropped, identifiers abstracted (renaming does not hide a copy), keywords, punctuation,
 * numbers and string literals kept; then k-token shingles. A LEXICAL near-duplicate signal (forks, copies, light ports): it does
 * not establish semantic independence, and a reimplementation of the same algorithm in other words is not found.
 */
export function codeTokens(text) {
  const src = String(text).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const out = [];
  for (const m of src.matchAll(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|([A-Za-z_$][\w$]*)|(\d[\w.]*)|([^\s\w])/g)) {
    if (m[1]) out.push(`S${m[1].slice(1, -1)}`);
    else if (m[2]) out.push(JS_KEYWORDS.has(m[2]) ? m[2] : "I");
    else out.push(m[3] ?? m[4]);
  }
  return out;
}
export function shingles(tokens, k = 6) { const out = new Set(); for (let i = 0; i + k <= tokens.length; i++) out.add(tokens.slice(i, i + k).join("\u0001")); return out; }
/** Shingles of the code files of a task's reference solution (test paths excluded: test boilerplate is alike everywhere). */
export function codeShingles(taskDir) {
  const ref = join(taskDir, "reference");
  const out = new Set();
  if (!existsSync(ref)) return out;
  for (const f of walkFiles(ref, { skip: [] })) if (f.symlink === undefined && CODE.test(f.path) && !DECL.test(f.path) && !isTestPath(f.path)) for (const s of shingles(codeTokens(readFileSync(join(ref, f.path), "utf8")))) out.add(s);
  return out;
}
export const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let inter = 0; const [small, large] = a.size <= b.size ? [a, b] : [b, a]; for (const x of small) if (large.has(x)) inter++; return inter / (a.size + b.size - inter); };

/**
 * Near-duplicate and lineage overlap of an adapted case with earlier tasks of OTHER families (same-family overlap is governed by
 * the family rules: maxPerFamily, priorFamilyReuse). Returns codes; `lineage` = this case's lineage (or undefined).
 * @param {string} dir @param {string} family @param {any} corpus @param {{ lineage?: any, dedupe?: any }} [options]
 */
export function crossFamilyOverlap(dir, family, corpus, { lineage, dedupe = DEFAULT_SUPPLY.dedupe } = {}) {
  const codes = [];
  for (const root of lineage?.rootCommits ?? []) if ([...(corpus.rootFamilies?.get(root) ?? [])].some(f => f !== family)) { codes.push("lineage-shared-with-other-repository"); break; }
  const mine = codeShingles(dir);
  if (mine.size >= dedupe.minShingles) for (const e of corpus.shingleIndex ?? []) if (e.family !== family && e.set.size >= dedupe.minShingles && jaccard(mine, e.set) >= dedupe.nearDuplicateJaccard) { codes.push("near-duplicate-of-other-family-task"); break; }
  return codes;
}
/** Record an accepted case in the corpus, so cases of one collection are checked against each other too. @param {any} corpus @param {{ id: string, family: string, dir: string, lineage?: any }} entry */
export function addToCorpus(corpus, { id, family, dir, lineage }) {
  const set = codeShingles(dir); if (set.size) corpus.shingleIndex?.push({ id, family, set });
  for (const root of lineage?.rootCommits ?? []) { if (!corpus.rootFamilies.has(root)) corpus.rootFamilies.set(root, new Set()); corpus.rootFamilies.get(root).add(family); }
}

/** Overlap reasons of one adapted case (codes only; empty = no overlap FOUND, which is not proof of absence). @param {any} c @param {string} dir @param {any} corpus @param {string} [patchId] @param {{ lineage?: any, dedupe?: any }} [options] */
export function overlapOf(c, dir, corpus, patchId, { lineage, dedupe } = {}) {
  const codes = [];
  const slug = c.repo.slug.toLowerCase(), npm = c.repo.npm?.name?.toLowerCase();
  if (corpus.seenCommits.has(c.sha)) codes.push("commit-seen-in-supply");
  if (patchId && corpus.seenPatches.has(patchId)) codes.push("patch-seen-in-supply");
  if (corpus.families.has(familyOf(c.repo.slug)) || (npm && corpus.packageNames.has(npm))) codes.push("family-in-earlier-datasets");
  const needles = [slug, c.sha, c.sha.slice(0, 12), taskIdOf(c.repo.slug, c.sha)];
  if (corpus.texts.some(t => needles.some(n => t.includes(n)))) codes.push("named-in-earlier-experiments");
  for (const sub of ["hidden", "reference"]) for (const f of walkFiles(join(dir, sub))) if (f.size > 64 && corpus.fileHashes.has(sha256(readFileSync(join(dir, sub, f.path))))) { codes.push("content-matches-earlier-task"); break; }
  codes.push(...crossFamilyOverlap(dir, familyOf(c.repo.slug), corpus, { lineage, dedupe }));
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
    // A grader error or a timeout already decides the case ("grader-error"/"timeout", checked first below), so the remaining runs
    // are skipped: a repository whose suite hangs used to cost repeats x 2 x timeoutMs per commit (2026-11-06 real refresh).
    // Acceptance still needs every run of every repeat.
    runs: for (let i = 0; i < repeats; i++) {
      for (const which of ["original", "reference"]) {
        const ws = join(scratch, `${which}-${i}`);
        rmSync(ws, { recursive: true, force: true });
        cpSync(task.repo, ws, { recursive: true });
        if (which === "reference") cpSync(join(dir, "reference"), ws, { recursive: true, force: true });
        const g = await gradeWorkspace({ task, workspace: ws, scratch: join(scratch, `g-${which}-${i}`), env, timeoutMs });
        runs[which].push(g);
        rmSync(ws, { recursive: true, force: true });
        if (g.error || g.visible?.timeout || g.hidden?.timeout) break runs;
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
  // Rotation input: when each repository was last scanned (failed clones/scans included), so discovery takes new ones first.
  repos ??= await discoverRepos(cfg, { fetchJson, log, lastScan: lastScans(reg.records()) });
  summary.repositories = repos.length;
  summary.discovered = repos.map(r => r.slug);
  const corpus = knownCorpus({ orcheDir, packageDir, pool });
  summary.scanCoverage = corpus.coverage;
  const count = (map, code) => { map[code] = (map[code] ?? 0) + 1; };
  const scanned1 = (repo, extra) => reg.append({ type: "scan", repo: repo.slug, ...extra });
  for (const repo of repos) {
    let clone;
    try { clone = cloneRepo(repo, ensureDir(join(pool, "cache", "repos"))); } catch (error) { summary.errors.push({ repo: repo.slug, code: "clone-failed", message: String(error.message).slice(0, 200) }); scanned1(repo, { error: "clone-failed" }); continue; }
    let scanned;
    try { scanned = scanCommits(clone, repo, cfg); } catch (error) { summary.errors.push({ repo: repo.slug, code: "scan-failed", message: String(error.message).slice(0, 200) }); scanned1(repo, { head: clone.headSha, error: "scan-failed" }); continue; }
    scanned1(repo, { head: clone.headSha, qualifying: scanned.cases.length, rejected: scanned.rejects.length });
    for (const r of scanned.rejects) count(summary.commitRejects, r.code);
    let kept = 0, validated = 0, timeouts = 0;
    for (const c of scanned.cases) {
      if (kept >= maxCasesPerRepo || validated >= cfg.commits.maxValidatePerRepo) break;
      // A repository whose suite already timed out twice is left for a later collection (budget only; nothing is accepted).
      if (timeouts >= (cfg.commits.maxTimeoutsPerRepo ?? Infinity)) { count(summary.caseRejects, "repository-skipped-after-timeouts"); break; }
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
      if (ex.reject) { decide("rejected", ex.reject, { patchId, ...(ex.missing ? { missing: ex.missing.slice(0, 20) } : {}) }); continue; }
      const lineage = ex.provenance.lineage;
      const overlap = overlapOf(c, dir, corpus, patchId, { lineage, dedupe: cfg.dedupe });
      if (overlap.length) { decide("rejected", overlap[0], { patchId, overlap }); continue; }
      validated++;
      const v = await validate(dir);
      // Private: the detail can name hidden tests; it stays in the case directory (never in reports or the registry).
      atomicWriteJson(join(dir, "validation.private.json"), v);
      if (!v.ok) { if (v.code === "timeout") timeouts++; decide("rejected", v.code, { patchId }); continue; }
      const task = ex.task;
      task.expected = v.expected;
      atomicWriteJson(join(dir, "task.json"), task);
      decide("eligible", "valid", { patchId, family: task.family, tier: task.tier, difficultyBasis: task.difficultyBasis, contentDigest: caseDigest(dir), ...(lineage?.complete ? { rootCommits: lineage.rootCommits } : { lineage: "unknown" }) });
      addToCorpus(corpus, { id: caseId, family: task.family, dir, lineage });
      summary.eligible.push({ id: caseId, family: task.family, tier: task.tier, url: ex.provenance.commitUrl, license: ex.provenance.license.spdx });
      kept++;
      log(`${caseId}: eligible (${task.tier})`);
    }
  }
  return summary;
}

/**
 * Intake of newly authored, independently reviewed tasks (low-exposure tier) from `src` (one directory per task with task.json,
 * repo/, hidden/, reference/) into the pool as eligible cases, model-free. Accepted only with provenance "private-reviewed", no
 * public-source origin (`upstream`), a complete review record (datasets.mjs reviewProblems: named authors, tests not written by
 * the reference's author, reviewers who authored nothing, declared unpublished, every review item checked, review document
 * digest), no exact or cross-family lexical overlap with earlier tasks, not named in earlier experiments, and the same
 * mechanical validation as every other case. The record is an operator attestation: nothing here can make a public task
 * private, and nothing verifies that the reviewers are real or independent (PRIVATE_LIMITATION).
 * @param {{ pool: string, src: string, orcheDir: string, packageDir?: string, validate: (dir: string, opts?: any) => Promise<any>, log?: (s: string) => void, cfg?: any, overlapPools?: string[] }} options
 */
export async function intakePrivate({ pool, src, orcheDir, packageDir = PACKAGE_DIR, validate, log = () => {}, cfg = DEFAULT_SUPPLY, overlapPools = [] }) {
  pool = poolPath(pool);
  ensureDir(pool, 0o700); chmodSync(pool, 0o700);
  const reg = registryOf(pool);
  if (reg.verify().length) throw new Error(`supply registry tampered: ${reg.verify().join("; ")}`);
  const st = poolState(pool);
  // Versioned remedies (2026-11-07): a new version names the staged case it supersedes. The predecessor must be eligible, never
  // batched or reserved, and its content must be the content the version was derived from; it is excluded from the version's own
  // overlap index (a version shares content with its predecessor by construction), and once the version is accepted the
  // predecessor is recorded "superseded" and moved out of cases/ (kept under superseded/ for provenance). Sealed tasks are never
  // superseded; a rejected version leaves the predecessor untouched.
  const supersedes = new Map();
  for (const id of existsSync(src) ? readdirSync(src) : []) {
    try { const m = JSON.parse(readFileSync(join(src, id, "task.json"), "utf8")); if (m.supersedes?.id) supersedes.set(id, m.supersedes); } catch { /* checked below */ }
  }
  const corpus = knownCorpus({ orcheDir, packageDir, pool, extraPools: overlapPools, excludeCases: new Set([...supersedes.values()].map(x => x.id)) });
  const summary = { schema: SUPPLY_SCHEMA, source: "private-reviewed", overlapPools: overlapPools.length, at: new Date().toISOString(), eligible: [], rejected: {}, problems: {} };
  for (const id of readdirSync(src).sort()) {
    const from = join(src, id);
    if (!existsSync(join(from, "task.json"))) continue;
    const reject = (code, problems) => { reg.append({ type: "case", caseId: id, status: "rejected", code, source: "private-reviewed" }); summary.rejected[code] = (summary.rejected[code] ?? 0) + 1; if (problems) summary.problems[id] = problems.slice(0, 8); rmSync(join(pool, "cases", id), { recursive: true, force: true }); };
    if (st.cases.has(id)) { summary.rejected["case-id-in-supply"] = (summary.rejected["case-id-in-supply"] ?? 0) + 1; continue; }
    let m;
    try { m = JSON.parse(readFileSync(join(from, "task.json"), "utf8")); } catch { reject("task-json-unreadable"); continue; }
    if (m.id !== id || !m.family || !m.tier || !m.instruction) { reject("task-json-incomplete"); continue; }
    if (m.provenance !== "private-reviewed") { reject("provenance-not-private-reviewed"); continue; }
    if (m.upstream) { reject("public-source-task-cannot-be-private"); continue; }
    if (m.difficultyBasis === "size-proxy") { reject("size-proxy-difficulty"); continue; }
    if (m.supersedes?.id) {
      const prev = st.cases.get(m.supersedes.id);
      const prevDir = join(pool, "cases", m.supersedes.id);
      if (!prev || prev.status !== "eligible" || !existsSync(prevDir)) { reject("supersedes-unknown-or-ineligible-case"); continue; }
      if (st.batched.has(m.supersedes.id)) { reject("supersedes-sealed-case"); continue; }
      let pm; try { pm = JSON.parse(readFileSync(join(prevDir, "task.json"), "utf8")); } catch { reject("supersedes-unreadable-case"); continue; }
      if (taskContentDigest(prevDir, pm.instruction) !== m.supersedes.contentDigest) { reject("supersedes-content-mismatch"); continue; }
      if (pm.family !== m.family || pm.authorship?.account !== m.authorship?.account) { reject("supersedes-changes-family-or-account"); continue; }
    }
    const review = reviewProblems(m, { dir: from });
    if (review.length) { reject("review-record-incomplete", review); continue; }
    if (!["repo", "hidden", "reference"].every(p => existsSync(join(from, p)))) { reject("task-layout-incomplete"); continue; }
    const dir = join(pool, "cases", id);
    rmSync(dir, { recursive: true, force: true }); ensureDir(dir);
    // review/ carries the review document(s) whose sha256 the record names: it travels with the task so eligibility re-verifies it.
    for (const part of ["task.json", "repo", "hidden", "reference", "review"]) if (existsSync(join(from, part))) cpSync(join(from, part), join(dir, part), { recursive: true });
    if (walkFiles(dir, { skip: [] }).some(f => f.symlink !== undefined)) { reject("symlink-in-tree"); continue; }
    const codes = [];
    if (corpus.texts.some(t => t.includes(id.toLowerCase()))) codes.push("named-in-earlier-experiments");
    for (const sub of ["hidden", "reference"]) for (const f of walkFiles(join(dir, sub))) if (f.size > 64 && corpus.fileHashes.has(sha256(readFileSync(join(dir, sub, f.path))))) { codes.push("content-matches-earlier-task"); break; }
    codes.push(...crossFamilyOverlap(dir, m.family, corpus, { dedupe: cfg.dedupe }));
    if (codes.length) { reject(codes[0]); continue; }
    const v = await validate(dir, { visibleSuite: m.visibleSuite === "none" ? "none" : "required" });
    atomicWriteJson(join(dir, "validation.private.json"), v);
    if (!v.ok) { reject(v.code); continue; }
    m.expected = v.expected;
    atomicWriteJson(join(dir, "task.json"), m);
    reg.append({ type: "case", caseId: id, status: "eligible", code: "valid", source: "private-reviewed", family: m.family, tier: m.tier, difficultyBasis: difficultyBasisOf(m), contentDigest: caseDigest(dir), reviewDocumentSha256: m.review.documentSha256, reviewClass: reviewClass(m), ...(m.supersedes ? { supersedes: m.supersedes.id, version: m.version ?? null } : {}) });
    if (m.supersedes?.id) {
      ensureDir(join(pool, "superseded"));
      renameSync(join(pool, "cases", m.supersedes.id), join(pool, "superseded", m.supersedes.id));
      reg.append({ type: "case", caseId: m.supersedes.id, status: "superseded", code: "superseded", source: "private-reviewed", by: id });
    }
    addToCorpus(corpus, { id, family: m.family, dir });
    summary.eligible.push({ id, family: m.family, tier: m.tier });
    log(`${id}: eligible (private-reviewed)`);
  }
  return summary;
}

/** Digest of a task directory as sealed (task.json, repo, hidden, reference). */
export const caseDigest = (dir) => digestOf(Object.fromEntries(walkFiles(dir, { skip: [] }).filter(f => f.symlink === undefined && !f.path.endsWith(".private.json")).map(f => [f.path, sha256(readFileSync(join(dir, f.path)))])));

/**
 * Withdraw an eligible, unbatched case from eligibility (2026-11-07; e.g. its starting repository carries a sibling task's answer
 * and it cannot be isolated). Appends status "withdrawn" with a code, a reason and an evidence document {document, sha256};
 * the directory stays in cases/ as provenance but is never sealable again. A sealed (batched) case is never withdrawn here.
 * @param {{ pool: string, caseId: string, code: string, reason: string, evidence: { document: string, sha256: string } }} o
 */
export function withdrawCase({ pool, caseId, code, reason, evidence }) {
  pool = poolPath(pool);
  if (!code || !reason || !evidence?.document || !/^[0-9a-f]{64}$/.test(evidence?.sha256 ?? "")) throw new Error("withdrawCase: code, reason and evidence {document, sha256} required");
  if (!existsSync(evidence.document) || sha256(readFileSync(evidence.document)) !== evidence.sha256) throw new Error("withdrawCase: evidence document missing or changed");
  const lock = acquireLock(join(pool, ".pool.lock"));
  try {
    const st = poolState(pool);
    if (st.chain.length) throw new Error(`supply registry tampered: ${st.chain.join("; ")}`);
    const latest = st.cases.get(caseId);
    if (!latest || latest.status !== "eligible") throw new Error(`withdrawCase: ${caseId} is ${latest?.status ?? "unknown"}, not eligible`);
    if (st.batched.has(caseId)) throw new Error(`withdrawCase: ${caseId} is sealed in a batch`);
    return registryOf(pool).append({ type: "case", caseId, status: "withdrawn", code, reason, evidence, source: latest.source ?? "private-reviewed" });
  } finally { lock.release(); }
}

/**
 * Retire a sealed holdout batch that was NEVER reserved and NEVER used (2026-11-07: collectors seal by default, and two batches
 * were sealed in an exploration pool with tasks of earlier holdouts, so they can never be an independent holdout). Appends
 * {type: "retire"} with code, reason and a verified evidence document; poolState then drops the batch (never reserved or sealed
 * from again; directory kept). `restage` names tasks of the batch to stage again as unbatched cases: each is copied back from
 * the sealed copy and must reproduce the content digest of its eligibility decision, else nothing is restaged. No outcome of a
 * never-used batch exists, so re-forming a batch from its tasks reveals nothing; a reserved, used or calibration batch is refused.
 * @param {{ pool: string, batch: string, code: string, reason: string, evidence: { document: string, sha256: string }, restage?: string[] }} o
 */
export function retireBatch({ pool, batch, code, reason, evidence, restage = [] }) {
  pool = poolPath(pool);
  if (!code || !reason || !evidence?.document || !/^[0-9a-f]{64}$/.test(evidence?.sha256 ?? "")) throw new Error("retireBatch: code, reason and evidence {document, sha256} required");
  if (!existsSync(evidence.document) || sha256(readFileSync(evidence.document)) !== evidence.sha256) throw new Error("retireBatch: evidence document missing or changed");
  const lock = acquireLock(join(pool, ".pool.lock"));
  try {
    recoverLocked(pool);
    const st = poolState(pool);
    if (st.chain.length) throw new Error(`supply registry tampered: ${st.chain.join("; ")}`);
    const b = st.batches.get(batch);
    if (!b) throw new Error(`retireBatch: ${batch} is not a live batch of the pool`);
    if ((b.purpose ?? "holdout") !== "holdout") throw new Error(`retireBatch: ${batch} is a ${b.purpose} batch (measured material is never retired)`);
    if (st.reservedBatches.has(batch)) throw new Error(`retireBatch: ${batch} is reserved`);
    const dir = join(pool, "batches", batch);
    if (existsSync(join(dir, "USES.jsonl")) && holdoutLedger(dir).records().length) throw new Error(`retireBatch: ${batch} has a recorded use`);
    const seal = verifySeal(dir);
    if (!seal.ok || seal.seal.digest !== b.sealDigest) throw new Error(`retireBatch: ${batch} seal ${seal.ok ? "differs from the registry" : seal.why}`);
    const plan = [];
    for (const id of restage) {
      if (!b.tasks.includes(id)) throw new Error(`retireBatch: ${id} is not in ${batch}`);
      const prior = priorDecision(st, id);
      if (!prior || st.cases.get(id)?.status !== "eligible") throw new Error(`retireBatch: ${id} has no standing eligibility decision`);
      if (existsSync(join(pool, "cases", id))) throw new Error(`retireBatch: cases/${id} exists`);
      try { plan.push({ id, prior, ...restageCopy(pool, st, batch, id, prior) }); }
      catch (error) { for (const p of plan) rmSync(p.tmp, { recursive: true, force: true }); throw new Error(`retireBatch: ${id} ${error.message} (nothing restaged)`); }
    }
    const r = registryOf(pool).append({ type: "retire", batch, sealDigest: b.sealDigest, code, reason, evidence, restaged: plan.map(p => p.id) });
    fault("retire:after-retire-record");
    for (const p of plan) {
      renameSync(p.tmp, join(pool, "cases", p.id));
      fault("retire:after-restage-rename");
      registryOf(pool).append(restagedRecord(p.prior, batch, r.seq, p));
    }
    return { retired: batch, seq: r.seq, restaged: plan.map(p => p.id) };
  } finally { lock.release(); }
}

/** The latest eligibility decision (with a content digest) of a case, optionally before a registry sequence number. */
function priorDecision(st, id, beforeSeq = Infinity) {
  return [...st.records].reverse().find(r => r.seq < beforeSeq && r.type === "case" && r.caseId === id && r.status === "eligible" && r.contentDigest);
}

function restagedRecord(prior, batch, retireSeq, p) {
  const { seq: _s, at: _a, prev: _p, hash: _h, ...decision } = prior;
  return { ...decision, code: "restaged", fromBatch: batch, retireSeq, ...(p.evidence ? { evidence: p.evidence } : { evidenceGap: p.evidenceGap }), ...(p.recovered ? { recovered: p.recovered } : {}) };
}

/**
 * Build the restage copy of `id` from the sealed batch copy plus the evidence preserved at its seal, in <pool>/tmp/restage-<id>.
 * The task part must reproduce the decided content digest and every preserved evidence file its registered sha256; a batch sealed
 * before evidence preservation yields a recorded legacy gap (never regenerated). Throws on any mismatch (nothing left behind).
 */
function restageCopy(pool, st, batch, id, prior) {
  const dir = join(pool, "batches", batch);
  const tmp = join(pool, "tmp", `restage-${id}`);
  rmSync(tmp, { recursive: true, force: true }); ensureDir(tmp);
  const fail = (why) => { rmSync(tmp, { recursive: true, force: true }); throw new Error(why); };
  for (const part of SEALED_PARTS) if (existsSync(join(dir, id, part))) cpSync(join(dir, id, part), join(tmp, part), { recursive: true });
  if (caseDigest(tmp) !== prior.contentDigest) fail("does not reproduce its decided content digest");
  const ev = [...st.records].reverse().find(r => r.type === "evidence" && r.caseId === id && r.batch === batch);
  if (!ev) return { tmp, evidence: null, evidenceGap: `sealed into ${batch} before evidence preservation (2026-11-07): validation and other private records of the staged case were not kept` };
  for (const [f, h] of Object.entries(ev.files ?? {})) {
    const src = join(pool, ev.dir, f);
    if (!existsSync(src) || sha256(readFileSync(src)) !== h) fail(`evidence ${f} preserved at the seal is missing or changed`);
    ensureDir(dirname(join(tmp, f))); cpSync(src, join(tmp, f));
  }
  return { tmp, evidence: { files: ev.files, from: ev.dir }, evidenceGap: null };
}

/**
 * Finish what an interrupted seal or retirement left (2026-11-07; caller holds the pool lock). Idempotent; never regenerates
 * evidence and never makes anything unverifiable eligible:
 *  - seal stopped after the batch record: a task of a live holdout batch with no evidence record whose staged directory is still
 *    in place and unchanged (content digest of its decision) gets its evidence record and is moved (the same bytes the seal would
 *    have moved; record marked `recovered`);
 *  - seal stopped between an evidence record and its move: the staged directory is moved if its files carry exactly the
 *    registered hashes; otherwise nothing is moved (batchEvidenceProblems then keeps the batch out of use);
 *  - retirement stopped before a restage finished: each listed task is staged from the verified copy (or, if its directory was
 *    already renamed into place, verified) and gets its restaged record; a task that cannot be verified is withdrawn
 *    (`restage-interrupted`), so it is never retried or offered again.
 * Orphan batch directories (renamed but never registered) are reported, never used (batches come from the registry).
 * @returns {{ archived: string[], moved: string[], restaged: string[], withdrawn: string[], orphans: string[] }}
 */
function recoverLocked(pool) {
  const out = { archived: [], moved: [], restaged: [], withdrawn: [], orphans: [] };
  let st = poolState(pool);
  if (st.chain.length) return out;
  const batchRecs = st.records.filter(r => r.type === "batch");
  for (const b of batchRecs) {
    if ((b.purpose ?? "holdout") !== "holdout") continue;
    const live = st.batches.has(b.batch);
    for (const id of b.tasks) {
      const ev = [...st.records].reverse().find(r => r.type === "evidence" && r.caseId === id && r.batch === b.batch);
      const from = join(pool, "cases", id), to = join(pool, "evidence", b.batch, id);
      if (ev) {
        if (existsSync(to) || !existsSync(from)) continue;
        const now = evidenceFiles(from);
        if (Object.entries(ev.files ?? {}).every(([f, h]) => now[f] === h) && Object.keys(now).length === Object.keys(ev.files ?? {}).length) { ensureDir(dirname(to), 0o700); renameSync(from, to); out.moved.push(id); }
        continue;
      }
      // No evidence record: only a live batch whose staged directory is still exactly the decided one (interrupted seal).
      if (!live || !existsSync(from)) continue;
      const restagedLater = st.records.some(r => r.type === "case" && r.caseId === id && r.code === "restaged" && r.seq > b.seq);
      if (restagedLater) continue;
      const dec = priorDecision(st, id, b.seq);
      if (!dec || caseDigest(from) !== dec.contentDigest) continue;
      const files = evidenceFiles(from);
      registryOf(pool).append({ type: "evidence", caseId: id, batch: b.batch, dir: relative(pool, to), files, recovered: "seal interrupted after the batch record; staged directory moved unchanged" });
      ensureDir(dirname(to), 0o700); renameSync(from, to); out.archived.push(id);
    }
  }
  st = poolState(pool);
  for (const r of st.records.filter(x => x.type === "retire")) {
    for (const id of r.restaged ?? []) {
      if (st.records.some(x => x.type === "case" && x.caseId === id && x.seq > r.seq && (x.code === "restaged" || x.code === "restage-interrupted"))) continue;
      const prior = priorDecision(st, id, r.seq);
      const withdraw = (why) => { registryOf(pool).append({ type: "case", caseId: id, status: "withdrawn", code: "restage-interrupted", family: prior?.family, reason: why, retireSeq: r.seq }); out.withdrawn.push(id); };
      if (!prior) { withdraw("no decision before the retirement"); continue; }
      const dest = join(pool, "cases", id);
      try {
        const c = restageCopy(pool, st, r.batch, id, prior);
        if (existsSync(dest)) {
          // Renamed before the crash: it must be byte-identical to the verified copy (task digest and every evidence file).
          const same = caseDigest(dest) === prior.contentDigest && JSON.stringify(evidenceFiles(dest)) === JSON.stringify(evidenceFiles(c.tmp));
          rmSync(c.tmp, { recursive: true, force: true });
          if (!same) { withdraw("restaged directory differs from the verified copy"); continue; }
        } else renameSync(c.tmp, dest);
        registryOf(pool).append(restagedRecord(prior, r.batch, r.seq, { ...c, recovered: "retirement interrupted before this restage finished" }));
        out.restaged.push(id);
      } catch (error) { withdraw(`restage cannot be verified: ${error.message}`); }
    }
  }
  if (existsSync(join(pool, "batches"))) {
    const known = new Set(st.records.filter(x => x.type === "batch").map(x => x.batch));
    // Renamed or half-built but never registered: moved aside (kept, never used), so a later seal of the same name cannot collide.
    for (const n of readdirSync(join(pool, "batches"))) {
      if (known.has(n)) continue;
      ensureDir(join(pool, "orphaned"), 0o700);
      renameSync(join(pool, "batches", n), join(pool, "orphaned", `${n}-${Date.now()}`));
      out.orphans.push(n);
    }
  }
  return out;
}

/**
 * Content check of a required evidence file: .json must parse to an object; validation.private.json must be the record of a
 * PASSED validation (validateCase: {ok: true, code: "valid"}) -- `{}`, `null` or a failed validation is not evidence of anything.
 */
export function evidenceContentProblems(f, text) {
  if (!f.endsWith(".json")) return text.length ? [] : [`${f} empty`];
  let v; try { v = JSON.parse(text); } catch { return [`${f} unreadable`]; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return [`${f} is not a record`];
  if (f === "validation.private.json" && !(v.ok === true && v.code === "valid")) return [`${f} does not record a passed validation`];
  return [];
}

/** Lock-taking recovery of interrupted seals and retirements (see recoverLocked). */
export function recoverPool(pool) {
  pool = poolPath(pool);
  const lock = acquireLock(join(pool, ".pool.lock"));
  try { return recoverLocked(pool); } finally { lock.release(); }
}

/**
 * Evidence problems of a sealed batch (2026-11-07): every task must have an evidence record for this batch naming each required
 * file, and every recorded file must be present under <pool>/evidence with its registered sha256. A batch sealed before
 * preservation has no records: every task is reported (a legacy gap is never filled with regenerated files).
 */
export function batchEvidenceProblems(pool, batch, required = []) {
  const st = poolState(pool);
  const b = st.batches.get(batch) ?? st.retired.get(batch);
  if (!b) return [`${batch}: not a batch of the pool`];
  const out = [];
  for (const id of b.tasks) {
    const ev = [...st.records].reverse().find(r => r.type === "evidence" && r.caseId === id && r.batch === batch);
    if (!ev) { out.push(`${id}: no evidence preserved at the seal`); continue; }
    for (const f of required) if (!(f in (ev.files ?? {}))) out.push(`${id}: required evidence ${f} was not part of the staged case`);
    for (const [f, h] of Object.entries(ev.files ?? {})) { const p = join(pool, ev.dir, f); if (!existsSync(p)) out.push(`${id}: evidence ${f} missing`); else if (sha256(readFileSync(p)) !== h) out.push(`${id}: evidence ${f} changed since the seal`); }
    for (const f of required.filter(x => x in (ev.files ?? {}) && existsSync(join(pool, ev.dir, x)))) out.push(...evidenceContentProblems(f, readFileSync(join(pool, ev.dir, f), "utf8")).map(x => `${id}: evidence ${x}`));
  }
  return out;
}

// ----------------------------------------------------------------------------------------------------------------- batch + seal

/**
 * Candidate-blind batch: eligible, not yet batched cases ordered by sha256(seed:id) — with `preferFreshFamilies`, cases whose
 * family was in no earlier batch (`options.priorFamilies`) first, each part in hash order; the first hard case (by that order)
 * first, then fill in order with at most `maxPerFamily` per repository and `maxPerOwner` per account. Size: the largest
 * T <= `maxTasks` for which that fill reaches exactly T tasks with every account at most floor(`maxOwnerShare` * T) (the share is
 * enforced against the tasks actually sealed, not against maxTasks). A case is hard only with tier hard AND a difficulty basis in
 * `minima.hardBasis` (registry records without a basis are supply-built: size-proxy). No task or model result is an input.
 * Returns { ids, coverage, ok, why }.
 * @param {any[]} eligible @param {any} cfg @param {any} minima @param {{ priorFamilies?: Set<string> }} [options]
 */
export function selectBatch(eligible, cfg, minima, { priorFamilies = new Set() } = {}) {
  const hashed = [...eligible].sort((a, b) => sha256(`${cfg.batch.seed}:${a.caseId}`).localeCompare(sha256(`${cfg.batch.seed}:${b.caseId}`)));
  const order = cfg.batch.preferFreshFamilies ? [...hashed.filter(c => !priorFamilies.has(c.family)), ...hashed.filter(c => priorFamilies.has(c.family))] : hashed;
  // Owner = the GitHub account of the repository: several repositories of one author share style and habits.
  const ownerOf = (c) => String(c.family).replace(/^gh:/, "").split("/")[0];
  const isHard = (c) => c.tier === "hard" && (minima.hardBasis ?? []).includes(c.difficultyBasis ?? "size-proxy");
  const share = cfg.batch.maxOwnerShare ?? 1;
  const fill = (size) => {
    const picked = [], perFamily = {}, perOwner = {};
    const ownerCap = Math.min(cfg.batch.maxPerOwner ?? Infinity, Math.floor(share * size + 1e-9));
    const add = (c) => {
      const o = ownerOf(c);
      if (picked.includes(c) || (perFamily[c.family] ?? 0) >= cfg.batch.maxPerFamily || (perOwner[o] ?? 0) >= ownerCap || picked.length >= size) return;
      picked.push(c); perFamily[c.family] = (perFamily[c.family] ?? 0) + 1; perOwner[o] = (perOwner[o] ?? 0) + 1;
    };
    const hard = order.find(isHard);
    if (hard) add(hard);
    for (const c of order) add(c);
    return { picked, perFamily, perOwner };
  };
  let best;
  for (let size = Math.min(cfg.batch.maxTasks, order.length); size >= 1; size--) {
    const f = fill(size);
    best ??= f;
    if (f.picked.length === size) { best = f; break; }
  }
  const { picked, perFamily, perOwner } = best ?? { picked: [], perFamily: {}, perOwner: {} };
  const top = Math.max(0, ...Object.values(perOwner));
  const coverage = { tasks: picked.length, families: Object.keys(perFamily).length, owners: Object.keys(perOwner).length, hard: picked.filter(isHard).length, hardByUnacceptedBasis: picked.filter(c => c.tier === "hard" && !isHard(c)).length, maxOwnerTasks: top, maxOwnerShare: picked.length ? Math.round((top / picked.length) * 1000) / 1000 : 0, familiesInEarlierBatches: Object.keys(perFamily).filter(f => priorFamilies.has(f)).length };
  const why = [];
  if (coverage.tasks < minima.minTasks) why.push(`tasks ${coverage.tasks} < ${minima.minTasks}`);
  if (coverage.families < minima.minFamilies) why.push(`families ${coverage.families} < ${minima.minFamilies}`);
  if (minima.requireHard && coverage.hard < 1) why.push(`no hard task with an accepted difficulty basis ${JSON.stringify(minima.hardBasis ?? [])} (size-proxy tiers do not count)`);
  if (picked.length && coverage.maxOwnerShare > share + 1e-9) why.push(`one account holds ${top}/${picked.length} tasks (max share ${share})`);
  return { ids: picked.map(c => c.caseId), coverage, ok: why.length === 0, why: why.join("; ") };
}

/** Eligible, not yet batched cases whose staged directory is present and unchanged since its decision (what sealing may use). */
export const sealableCases = (pool, st, { requireEvidence = [] } = {}) => { const req = [...new Set([...(poolPolicy(pool).requireEvidence ?? []), ...requireEvidence])]; return [...st.cases.values()].filter(r => r.status === "eligible" && !st.batched.has(r.caseId) && existsSync(join(pool, "cases", r.caseId, "task.json")) && caseDigest(join(pool, "cases", r.caseId)) === r.contentDigest && !evidenceProblems(pool, r.caseId, st, req).length); };

/** Files of a case directory that are NOT part of the sealed task copy (validation records, other private evidence): path -> sha256. */
export function evidenceFiles(dir) {
  const sealed = new Set(SEALED_PARTS);
  return Object.fromEntries(walkFiles(dir, { skip: [] }).filter(f => f.symlink === undefined && !sealed.has(f.path.split("/")[0])).map(f => [f.path, sha256(readFileSync(join(dir, f.path)))]));
}
/** The parts of a staged case that a batch seals (everything else is private evidence kept under <pool>/evidence/). */
export const SEALED_PARTS = Object.freeze(["task.json", "repo", "hidden", "reference", "review"]);

/**
 * Evidence problems of a staged case (2026-11-07): every file the pool policy requires (requireEvidence, e.g.
 * "validation.private.json") must exist and, for .json, parse; a case staged again from a retired batch must carry exactly the
 * evidence bytes preserved when that batch was sealed (registry `evidence` record). Missing or changed evidence = not sealable.
 */
export function evidenceProblems(pool, caseId, st, required = []) {
  const dir = join(pool, "cases", caseId), out = [];
  for (const f of required) {
    const p = join(dir, f);
    if (!existsSync(p)) { out.push(`${f} missing`); continue; }
    out.push(...evidenceContentProblems(f, readFileSync(p, "utf8")));
  }
  const restaged = [...st.records].reverse().find(r => r.type === "case" && r.caseId === caseId);
  if (restaged?.code === "restaged" && restaged.evidence?.files) {
    for (const [f, h] of Object.entries(restaged.evidence.files)) { const p = join(dir, f); if (!existsSync(p) || sha256(readFileSync(p)) !== h) out.push(`${f} differs from the evidence preserved at the seal of ${restaged.fromBatch}`); }
  } else if (restaged?.code === "restaged" && restaged.evidenceGap) out.push(...(required.length ? [`legacy evidence gap: ${restaged.evidenceGap}`] : []));
  return out;
}

/** Families of every task in an earlier batch of the pool (sealed, reserved or used alike), from the registry. */
export function batchedFamilies(st) {
  const out = new Set();
  for (const b of st.batches.values()) for (const id of b.tasks) { const f = st.cases.get(id)?.family; if (f) out.add(f); }
  return out;
}

/**
 * Form and seal one batch from eligible cases (if coverage allows). `purpose`: "holdout" (default) or "calibration" (a separate set
 * whose tasks may be run to calibrate difficulty rules; a calibration batch is never eligible as a holdout, and no holdout batch
 * is ever used for calibration). Returns { batch, dir, coverage } or { blocked: why }.
 */
export function sealBatch({ pool, cfg, minima, now = new Date(), purpose = "holdout", exclude = null, requireEvidence = [] }) {
  if (!["holdout", "calibration"].includes(purpose)) throw new Error(`sealBatch: unknown purpose ${purpose}`);
  pool = poolPath(pool);
  const lock = acquireLock(join(pool, ".pool.lock"));
  try {
    recoverLocked(pool);
    const st = poolState(pool);
    if (st.chain.length) throw new Error(`supply registry tampered: ${st.chain.join("; ")}`);
    const cfgDigest = digestOf(cfg);
    if (!st.records.some(r => r.type === "config" && r.digest === cfgDigest)) registryOf(pool).append({ type: "config", schema: SUPPLY_SCHEMA, digest: cfgDigest, config: cfg });
    // exclude (optional): a caller-side exclusion evaluated under this lock (src/lineage.mjs: cross-pool lineage).
    const eligible = sealableCases(pool, st, { requireEvidence }).filter(r => !exclude || !exclude(r));
    const sel = selectBatch(eligible, cfg, minima, { priorFamilies: batchedFamilies(st) });
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
      for (const part of SEALED_PARTS) if (existsSync(join(src, part))) cpSync(join(src, part), join(tmp, id, part), { recursive: true });
      const t = readJson(join(src, "task.json"));
      provenance.push({ id, family: t.family, tier: t.tier, difficultyBasis: t.difficultyBasis ?? "size-proxy", ...(t.difficultySource ? { difficultySource: t.difficultySource } : {}), provenance: t.provenance, upstream: t.upstream });
    }
    atomicWriteJson(join(tmp, "PROVENANCE.json"), { schema: SUPPLY_SCHEMA, batch, purpose, createdAt: now.toISOString(), selection: { rule: `sha256(seed:id) order${cfg.batch.preferFreshFamilies ? " (families of no earlier batch first)" : ""}, first hard case first, maxPerFamily, maxPerOwner, maxOwnerShare of the sealed size, maxTasks`, seed: cfg.batch.seed, maxTasks: cfg.batch.maxTasks, maxPerFamily: cfg.batch.maxPerFamily, maxPerOwner: cfg.batch.maxPerOwner, maxOwnerShare: cfg.batch.maxOwnerShare ?? null, preferFreshFamilies: !!cfg.batch.preferFreshFamilies, candidateBlind: true }, configDigest: digestOf(cfg), coverage: sel.coverage, tasks: provenance, limitations: [...new Set([...LIMITATIONS, ...(provenance.some(p => p.provenance === "private-reviewed") ? [PRIVATE_LIMITATION] : []), ...provenance.flatMap(p => p.upstream?.limitations ?? [])])] });
    const seal = sealOf(tmp);
    if (seal.symlinks.length) throw new Error(`symlinks in batch: ${seal.symlinks.join(", ")}`);
    atomicWriteJson(join(tmp, "SEAL.json"), { ...seal, schema: SUPPLY_SCHEMA, batch, sealedAt: now.toISOString() });
    renameSync(tmp, dir);
    fault("seal:after-batch-rename");
    registryOf(pool).append({ type: "batch", batch, dir: relative(pool, dir), tasks: sel.ids, sealDigest: seal.digest, coverage: sel.coverage, ...(purpose !== "holdout" ? { purpose } : {}) });
    fault("seal:after-batch-record");
    // Evidence lifecycle (2026-11-07): the staged case directory is MOVED, byte for byte, to <pool>/evidence/<batch>/<id> (never
    // deleted: its validation.private.json and other private records were lost this way before), and the sha256 of every file the
    // batch does not seal is registered, so a restage (retireBatch) can restore exactly these bytes and nothing regenerated.
    for (const id of sel.ids) {
      const from = join(pool, "cases", id), to = join(pool, "evidence", batch, id);
      if (!existsSync(from)) continue;
      // Record first, then move: an interruption in between leaves a recorded, hash-checked directory that recovery moves.
      registryOf(pool).append({ type: "evidence", caseId: id, batch, dir: relative(pool, to), files: evidenceFiles(from) });
      fault("seal:after-evidence-record");
      ensureDir(dirname(to), 0o700);
      renameSync(from, to);
      fault("seal:after-evidence-move");
    }
    return { batch, dir, coverage: sel.coverage, seal: seal.digest };
  } finally { lock.release(); }
}

/**
 * Seal a calibration-ONLY batch from explicitly named corrected versions staged in <pool>/<staged>/ (2026-11-07). Each id must be
 * registered with the latest status "calibration-only", be in no batch, and match the content digest of its intake record; its
 * family must not occur in any holdout batch or eligible holdout case (calibration and holdout material stay disjoint); `checks`
 * (id, dir) may add problems (e.g. a missing or invalid cross-provider triage). Any problem refuses the whole seal. The staged
 * directories are kept (the registry marks them batched, so they are never sealed again); the original batches are untouched.
 * @param {{ pool: string, ids: string[], cfg: any, now?: Date, staged?: string, checks?: (id: string, dir: string) => string[] }} o
 */
export function sealCalibrationBatch({ pool, ids, cfg, now = new Date(), staged = "calibration-staged", checks = () => [] }) {
  pool = poolPath(pool);
  if (!ids?.length) throw new Error("sealCalibrationBatch: no ids");
  const lock = acquireLock(join(pool, ".pool.lock"));
  try {
    const st = poolState(pool);
    if (st.chain.length) throw new Error(`supply registry tampered: ${st.chain.join("; ")}`);
    const problems = [];
    const holdoutFamilies = new Set();
    for (const b of st.batches.values()) if ((b.purpose ?? "holdout") === "holdout") { try { for (const t of loadLocal(join(pool, "batches", b.batch))) holdoutFamilies.add(t.family); } catch { problems.push(`holdout batch ${b.batch} unreadable`); } }
    for (const r of sealableCases(pool, st)) holdoutFamilies.add(r.family);
    const tasks = [];
    for (const id of [...ids].sort()) {
      const dir = join(pool, staged, id);
      const latest = st.cases.get(id);
      if (!latest || latest.status !== "calibration-only") { problems.push(`${id}: registry status ${latest?.status ?? "none"} (calibration-only required)`); continue; }
      if (st.batched.has(id)) { problems.push(`${id}: already in a batch`); continue; }
      if (!existsSync(join(dir, "task.json"))) { problems.push(`${id}: not staged in ${staged}/`); continue; }
      const intake = [...st.records].reverse().find(r => r.type === "case" && r.caseId === id && r.contentDigest);
      if (!intake || caseDigest(dir) !== intake.contentDigest) { problems.push(`${id}: staged content differs from its intake record`); continue; }
      const t = readJson(join(dir, "task.json"));
      if (t.id !== id) problems.push(`${id}: task.json id ${t.id}`);
      if (holdoutFamilies.has(t.family)) problems.push(`${id}: family ${t.family} also occurs in holdout material`);
      problems.push(...checks(id, dir).map(p => `${id}: ${p}`));
      tasks.push({ id, dir, t });
    }
    if (problems.length) return { blocked: "calibration seal refused", problems };
    const cfgDigest = digestOf(cfg);
    if (!st.records.some(r => r.type === "config" && r.digest === cfgDigest)) registryOf(pool).append({ type: "config", schema: SUPPLY_SCHEMA, digest: cfgDigest, config: cfg });
    const sorted = tasks.map(x => x.id);
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const batch = `b${stamp}-${digestOf(sorted).slice(0, 8)}`;
    const dir = join(pool, "batches", batch), tmp = `${dir}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    ensureDir(tmp);
    const provenance = [];
    for (const { id, dir: src, t } of tasks) {
      ensureDir(join(tmp, id));
      for (const part of SEALED_PARTS) if (existsSync(join(src, part))) cpSync(join(src, part), join(tmp, id, part), { recursive: true });
      provenance.push({ id, family: t.family, tier: t.tier, difficultyBasis: t.difficultyBasis ?? "size-proxy", provenance: t.provenance, derivedFrom: t.derivedFrom ?? null, version: t.version ?? null });
    }
    const families = [...new Set(provenance.map(p => p.family))].sort();
    atomicWriteJson(join(tmp, "PROVENANCE.json"), { schema: SUPPLY_SCHEMA, batch, purpose: "calibration", createdAt: now.toISOString(), selection: { rule: "explicit list: every corrected calibration-only version staged at sealing time (named before any target-model result of these versions; no candidate or model result is an input)", ids: sorted, source: staged }, configDigest: cfgDigest, coverage: { tasks: sorted.length, families: families.length }, tasks: provenance, limitations: [...new Set([...LIMITATIONS, PRIVATE_LIMITATION, "Corrected versions: hidden tests were extended after a cross-provider review found accepted violations; the added tests derive from the reviewer's blind tests or an adjudicator, so blind tests and hidden tests are no longer fully independent for these tasks."])] });
    const seal = sealOf(tmp);
    if (seal.symlinks.length) throw new Error(`symlinks in batch: ${seal.symlinks.join(", ")}`);
    atomicWriteJson(join(tmp, "SEAL.json"), { ...seal, schema: SUPPLY_SCHEMA, batch, sealedAt: now.toISOString() });
    renameSync(tmp, dir);
    registryOf(pool).append({ type: "batch", batch, dir: relative(pool, dir), tasks: sorted, sealDigest: seal.digest, coverage: { tasks: sorted.length, families: families.length }, purpose: "calibration", source: staged });
    return { batch, dir, seal: seal.digest, tasks: sorted, families };
  } finally { lock.release(); }
}

export const LIMITATIONS = [
  "Public upstream code: absence from model pretraining data is not established; the commit date cutoff and duplicate checks reduce, not exclude, that risk.",
  "Overlap checks cover exact commits, git patch-ids, file content hashes, repository/package names, texts of earlier experiments and records, shared repository root commits (forks/mirrors; only with complete history) and lexical near-duplicates of reference code in other families (identifier-abstracted shingles); semantic near-duplicates (a reimplementation in other words, a port to another language) are not established absent.",
  "Tiers of commit-built tasks are a size proxy of the upstream fix (changed code files/lines; difficultyBasis size-proxy), not established difficulty: they never count for the hard stratum. Tasks of an annotated source (difficultyBasis source, e.g. Exercism) carry the source's own annotation instead.",
  "Same-account storage: the pool is outside model-facing sandboxes (bubblewrap hides /home) and mode 0700, but any process of the same user outside a sandbox can read it.",
];
export const PRIVATE_LIMITATION = "Low-exposure (private-reviewed) tasks: authorship, independence of tests and reviewers, and non-publication are attested by the operator's review record (structure and document digest checked); this software cannot verify that the people or statements are real or that the task never reached model training data.";

// ------------------------------------------------------------------------------------------------------------ eligibility + use

/**
 * Families of every earlier holdout: tasks of pool batches that were used (USES.jsonl) or reserved (by any experiment or
 * purpose), and of package datasets with a recorded use, EXCLUDING the dataset `exclude` itself (a batch is never its own prior).
 * Families come from the sealed task.json files (registry family as fallback).
 * @param {{ pool?: string, packageDir?: string, exclude?: string }} options
 */
export function priorHoldoutFamilies({ pool, packageDir = PACKAGE_DIR, exclude } = {}) {
  const out = new Set();
  const same = (dir) => { if (!exclude) return false; const k = (p) => { try { return realpathSync(p); } catch { return resolve(p); } }; return k(dir) === k(exclude); };
  const addDir = (dir, fallback = []) => { try { for (const t of loadLocal(dir)) out.add(t.family); } catch { for (const f of fallback) if (f) out.add(f); } };
  if (pool && existsSync(join(pool, "registry.jsonl"))) {
    const st = poolState(pool);
    for (const b of st.batches.values()) {
      const dir = join(pool, "batches", b.batch);
      if (same(dir)) continue;
      const used = existsSync(join(dir, "USES.jsonl")) && holdoutLedger(dir).records().length > 0;
      if (used || st.reservedBatches.has(b.batch) || b.purpose === "calibration") addDir(dir, b.tasks.map(id => st.cases.get(id)?.family));
    }
  }
  const ds = join(packageDir, "datasets");
  if (existsSync(ds)) for (const d of readdirSync(ds)) { const dir = join(ds, d); if (!same(dir) && existsSync(join(dir, "USES.jsonl")) && holdoutLedger(dir).records().length > 0) addDir(dir); }
  return out;
}

/** Holdout eligibility of a sealed batch under a protocol: holdoutStatus (seal, purpose, provenance, review, exposure, uses, ledger chain, concentration, prior families) + coverage. */
/** @param {string} dir @param {any} protocol @param {{ orcheDir?: string, tasks?: any[], pool?: string, priorFamilies?: Set<string> }} [options] */
export function batchEligibility(dir, protocol, { orcheDir, tasks, pool, priorFamilies } = {}) {
  let list;
  try { list = tasks ?? loadLocal(dir); } catch (error) { return { ok: false, reasons: [`unreadable batch: ${error.message}`] }; }
  priorFamilies ??= protocol.holdout.priorFamilyReuse === "forbid" ? priorHoldoutFamilies({ pool, exclude: dir }) : undefined;
  const status = holdoutStatus(list, dir, protocol, { orcheDir, priorFamilies });
  const reasons = status.independent ? [] : [status.why];
  const families = new Set(list.map(t => t.family)).size, hard = list.filter(t => holdoutHard(t, protocol)).length, hardUnverified = list.filter(t => t.hard && !holdoutHard(t, protocol)).length;
  if (list.length < protocol.holdout.minTasks) reasons.push(`holdout too small: ${list.length} tasks (need ${protocol.holdout.minTasks})`);
  if (families < protocol.holdout.minFamilies) reasons.push(`holdout too narrow: ${families} families (need ${protocol.holdout.minFamilies})`);
  if (protocol.adoption.requireHardStratum && hard === 0) reasons.push(`holdout has no hard stratum: no hard task with an accepted difficulty basis ${JSON.stringify(protocol.holdout.hardBasis)}${hardUnverified ? ` (${hardUnverified} hard by size-proxy or another unaccepted basis: coverage UNVERIFIED)` : ""}`);
  return { ok: reasons.length === 0, reasons, coverage: { tasks: list.length, families, hard, hardUnverified, owners: status.concentration.owners, maxOwnerShare: status.concentration.maxOwnerShare }, uses: status.uses, seal: status.seal, purpose: status.purpose };
}

const stateKey = (stateDir) => { const abs = resolve(stateDir); try { return realpathSync(abs); } catch { return abs; } };
/** Reservation identity: the state directory for its experiment holdout; `<state>#<purpose>` for any other purpose (confirmation). */
export const reservationKey = (stateDir, purpose = "holdout") => purpose === "holdout" ? stateKey(stateDir) : `${stateKey(stateDir)}#${purpose}`;

/** The batch already reserved for this state directory and purpose (read-only), or undefined. */
export function assignmentFor(pool, stateDir, purpose = "holdout") {
  pool = poolPath(pool);
  const st = poolState(pool);
  if (st.chain.length) throw new Error(`supply registry tampered: ${st.chain.join("; ")}`);
  const r = st.reservations.get(reservationKey(stateDir, purpose));
  return r ? { batch: r.batch, dir: join(pool, "batches", r.batch), reservedAt: r.at, seq: r.seq, sealDigest: r.sealDigest } : undefined;
}

/**
 * Reserve an eligible, unreserved, unused batch for a state directory and purpose (idempotent: the same state and purpose always
 * get their first reservation back; a pool lock serializes competing experiments). The purpose is part of the reservation
 * identity, so a confirmation never gets the experiment's own holdout back; `excludeSeals` refuses batches with a listed seal
 * digest. Returns the assignment or { none: reasons }.
 */
/** @param {string} pool @param {string} stateDir @param {any} protocol @param {{ orcheDir?: string, purpose?: string, excludeSeals?: string[] }} [options] @returns {any} */
export function reserveBatch(pool, stateDir, protocol, { orcheDir, purpose = "holdout", excludeSeals = [] } = {}) {
  pool = poolPath(pool);
  if (!existsSync(join(pool, "registry.jsonl"))) return { none: ["no supply registry in the pool"] };
  const lock = acquireLock(join(pool, ".pool.lock"));
  try {
    const existing = assignmentFor(pool, stateDir, purpose);
    if (existing) return existing;
    const pick = firstEligibleBatch(pool, protocol, { orcheDir, excludeSeals });
    if (pick.none) return pick;
    const r = registryOf(pool).append({ type: "reserve", batch: pick.batch, stateDir: reservationKey(stateDir, purpose), sealDigest: pick.sealDigest, ...(purpose !== "holdout" ? { purpose } : {}) });
    return { batch: pick.batch, dir: pick.dir, reservedAt: r.at, seq: r.seq, sealDigest: pick.sealDigest };
  } finally { lock.release(); }
}

/** First sealed batch (registry order) that is unreserved, seal-intact (matching the registry) and eligible; or { none: reasons }. */
/** @param {string} pool @param {any} protocol @param {{ orcheDir?: string, excludeSeals?: string[] }} [options] @returns {any} */
export function firstEligibleBatch(pool, protocol, { orcheDir, excludeSeals = [] } = {}) {
  const st = poolState(pool);
  if (st.chain.length) throw new Error(`supply registry tampered: ${st.chain.join("; ")}`);
  const reasons = [];
  for (const b of [...st.batches.values()].sort((x, y) => x.seq - y.seq)) {
    if (st.reservedBatches.has(b.batch)) { reasons.push(`${b.batch}: reserved by another experiment`); continue; }
    if (excludeSeals.includes(b.sealDigest)) { reasons.push(`${b.batch}: excluded seal (the experiment's own holdout)`); continue; }
    const dir = join(pool, "batches", b.batch);
    const seal = existsSync(dir) ? verifySeal(dir) : { ok: false, why: "missing" };
    if (!seal.ok || seal.seal?.digest !== b.sealDigest) { reasons.push(`${b.batch}: seal ${seal.ok ? "differs from the registry" : seal.why}`); continue; }
    const e = batchEligibility(dir, protocol, { orcheDir, pool });
    if (!e.ok) { reasons.push(`${b.batch}: ${e.reasons.join("; ")}`); continue; }
    return { batch: b.batch, dir, sealDigest: b.sealDigest, coverage: e.coverage };
  }
  return { none: reasons.length ? reasons : ["no sealed batch in the pool"] };
}

/**
 * Non-secret pool overview: batches with eligibility, reservations, uses and account concentration; case counts by status/reason
 * code; with `cfg`, the supply outlook (unbatched eligible cases by account/family/accepted hard and the read-only result of
 * the next selection: would it seal, and if not, which minimum is missing).
 */
/** @param {string} pool @param {any} protocol @param {{ orcheDir?: string, cfg?: any }} [options] */
export function poolStatus(pool, protocol, { orcheDir, cfg } = {}) {
  pool = poolPath(pool);
  const st = poolState(pool);
  const ownerOf = (f) => String(f ?? "").replace(/^gh:/, "").split("/")[0];
  const tally = (xs) => { const m = {}; for (const x of xs) m[x] = (m[x] ?? 0) + 1; return m; };
  const batches = [...st.batches.values()].map(b => {
    const dir = join(pool, "batches", b.batch);
    const reservedBy = [...st.reservations.values()].find(r => r.batch === b.batch)?.stateDir ?? null;
    const e = existsSync(dir) ? batchEligibility(dir, protocol, { orcheDir, pool }) : { ok: false, reasons: ["batch directory missing"] };
    const owners = tally(b.tasks.map(id => ownerOf(st.cases.get(id)?.family)));
    // coverageAtSeal: the counts recorded when sealed (nominal tiers); coverageNow: what the protocol accepts today.
    return { batch: b.batch, tasks: b.tasks.length, coverageAtSeal: b.coverage, coverageNow: e.coverage ?? null, owners, maxOwnerShare: b.tasks.length ? Math.round((Math.max(...Object.values(owners)) / b.tasks.length) * 1000) / 1000 : 0, reservedBy, uses: existsSync(dir) ? holdoutLedger(dir).records().length : null, eligibleNow: e.ok, reasons: e.reasons };
  });
  const cases = {};
  for (const r of st.cases.values()) { const k = `${r.status}:${r.code}`; cases[k] = (cases[k] ?? 0) + 1; }
  const unbatched = [...st.cases.values()].filter(r => r.status === "eligible" && !st.batched.has(r.caseId));
  const out = { schema: SUPPLY_SCHEMA, pool, registryIntact: st.chain.length === 0, batches, unbatchedEligible: unbatched.length, cases };
  if (cfg) {
    // What sealing may use (staged, unchanged); registry-only eligible cases without their directory are counted apart.
    const sealable = sealableCases(pool, st);
    out.unbatchedSealable = sealable.length;
    const unbatched = sealable;
    const minima = minimaOf(protocol);
    const hard = unbatched.filter(r => r.tier === "hard" && (minima.hardBasis ?? []).includes(r.difficultyBasis ?? "size-proxy"));
    const next = selectBatch(unbatched, cfg, minima, { priorFamilies: batchedFamilies(st) });
    out.outlook = { byOwner: tally(unbatched.map(r => ownerOf(r.family))), families: new Set(unbatched.map(r => r.family)).size, acceptedHard: hard.length, nextBatch: { ok: next.ok, why: next.why || null, coverage: next.coverage } };
  }
  return out;
}

/** Batch minima of a protocol (the sealing side of its holdout coverage rules). */
export const minimaOf = (protocol) => ({ minTasks: protocol.holdout.minTasks, minFamilies: protocol.holdout.minFamilies, requireHard: protocol.adoption.requireHardStratum, hardBasis: protocol.holdout.hardBasis });


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
  const e = batchEligibility(out.holdout.dir, protocol, { orcheDir, pool: out.pool });
  Object.assign(out, { ok: e.ok, coverage: e.coverage, uses: e.uses, note: "model-free; per-task grader validation runs at prepare, before the search" });
  out.reasons.push(...e.reasons);
  // The pre-registered analysis plan (protocol-4): a confirmatory plan with a missing item, or a series budget that cannot
  // cover it, blocks the experiment before the search (src/loop.mjs holdoutPreflight applies the same rule).
  const plan = planPreflight(protocol, stateDir);
  out.analysisPlan = { mode: protocol.analysisPlan?.mode ?? "exploratory", complete: plan.length === 0 };
  if (plan.length) { out.ok = false; out.reasons.push(...plan); }
  return out;
}

/**
 * Analysis-plan problems of a protocol for a state directory, model-free: the confirmatory plan's missing items and whether the
 * series error budget still covers this experiment's pre-registered spends. Empty for an exploratory plan.
 * @param {any} protocol @param {string} stateDir @returns {string[]}
 */
export function planPreflight(protocol, stateDir) {
  const plan = protocol.analysisPlan;
  if (plan?.mode !== "confirmatory") return [];
  const missing = planCompleteness(protocol, { base: PACKAGE_DIR });
  if (missing.length) return missing.map(m => `confirmatory analysis plan incomplete: ${m}`);
  const need = plan.alpha + (plan.confirmation?.required ? plan.confirmation.alpha : 0);
  const fits = seriesFits(planPath(plan.series.ledger, PACKAGE_DIR), { series: plan.series.id, alphaTotal: plan.series.alphaTotal, alpha: need, stateDir: resolve(stateDir) });
  return fits.ok ? [] : [`confirmatory analysis plan: ${fits.why}`];
}
