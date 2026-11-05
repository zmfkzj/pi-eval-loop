// Second public source of the holdout supply: Exercism's JavaScript track (`eval-loop-supply collect-exercism`). Model-free.
//
// Why this source: it carries its own difficulty annotation. Every practice exercise in the track's config.json has a
// `difficulty` (1-10) written by the track maintainers, and Exercism's documentation (exercism/docs,
// building/tracks/config-json.md) fixes how the website reads it: 1-3 easy, 4-7 medium, 8-10 hard. A task built here gets
// difficultyBasis "source" with that annotation and the rubric pinned to their source revisions (difficultySource); nothing is
// relabelled. Size-proxy tiers of the commit source stay what they are.
//
// Adaptation (nothing invented; the exercise is what Exercism delivers to a student):
//   repo/      = the exercise directory at the pinned track revision without .meta/ (stub, spec, docs, configs, license).
//   hidden/    = <stem>.upstream-spec.js: the upstream spec, byte-identical (renamed so the runner does not start it bare);
//                <stem>.holdout.test.mjs: a fixed runner bridge (resolution hook: `@jest/globals` -> the harness shim, and
//                jest's extension fallback for relative imports); .holdout-harness/: the shim (describe/test/hooks onto
//                node:test; xtest/xit/xdescribe enabled exactly as Exercism's CI does, scripts/helpers.mjs) plus the real
//                `expect` package at the version of the track's lockfile, vendored with its dependency tree and licenses.
//   reference/ = the maintainers' .meta example solution(s) as the solution file(s), with Exercism CI's one rewrite
//                (`from '../` -> `from './`).
//   instruction = a fixed preamble + .docs/introduction.md, instructions.md, instructions.append.md verbatim.
// Specs using jest features the bridge does not carry (jest.*, .each, .only, .todo, snapshots, assertion counting, ...) are
// rejected, never approximated. The upstream spec has no node:test suite of its own, so the visible suite is empty and the
// case is validated with visibleSuite "none" (every other check of validateCase unchanged).
//
// Exposure: exercises listed in public benchmark collections (default: Aider's polyglot benchmark, whose JavaScript set was
// chosen from model results) are excluded; the usual family/name/content checks apply; an exercise is taken once per pool
// across track revisions (sourceKey). Exercism exercises and solutions have been public for years, so pretraining exposure is
// likely: see LIMITATIONS_EXERCISM.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteJson, digestOf, ensureDir, readJson, sha256, walkFiles } from "./util.mjs";
import { PACKAGE_DIR } from "./protocol.mjs";
import { caseDigest, cloneRepo, knownCorpus, licenseAccepted, licenseTextMatches, PROVENANCE, poolPath, registryOf, SUPPLY_SCHEMA } from "./supply.mjs";

export const EXERCISM_SOURCE = "exercism";

/** Rubric text of exercism/docs building/tracks/config-json.md that maps the 1-10 difficulty to the website's tiers. */
export const RUBRIC_PATTERN = { easy: /^\s*-\s*1,\s*2,\s*3:\s*easy\s*$/m, medium: /^\s*-\s*4,\s*5,\s*6,\s*7:\s*medium\s*$/m, hard: /^\s*-\s*8,\s*9,\s*10:\s*hard\s*$/m };
export const tierOfDifficulty = (d) => (!Number.isInteger(d) || d < 1 || d > 10 ? null : d >= 8 ? "hard" : d >= 4 ? "medium" : "easy");

/** Jest features the node:test bridge does not reproduce: a spec that uses one is rejected (fail closed). */
export const UNSUPPORTED_JEST = [/\bjest\s*\./, /\.each\s*[(`]/, /\.only\s*\(/, /\.todo\s*\(/, /\.concurrent\b/, /\.failing\b/, /\bexpect\s*\.\s*(assertions|hasAssertions)\b/, /toMatch(Inline)?Snapshot|toThrowErrorMatching(Inline)?Snapshot/, /\brequire\s*\(/];
const IMPORT_RE = /^\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

/** Imports of a spec (specifiers). */
export function specImports(text) { return [...String(text).matchAll(IMPORT_RE)].map(m => m[1] ?? m[2]); }

/** Why a spec cannot run unchanged under the bridge, or null. */
export function specUnsupported(text) {
  for (const re of UNSUPPORTED_JEST) if (re.test(text)) return "unsupported-jest-feature";
  if (specImports(text).some(s => s !== "@jest/globals" && !/^\.\/[A-Za-z0-9._-]+$/.test(s))) return "unsupported-spec-import";
  if (!specImports(text).includes("@jest/globals")) return "spec-without-jest-globals";
  return null;
}

/** The fixed shim (@jest/globals onto node:test + the vendored real `expect`). */
export const JEST_GLOBALS_SHIM = `// @jest/globals for an unchanged Exercism spec under node:test (pi-eval-loop supply, fixed text). expect = the vendored
// real \`expect\` package. xtest/xit/xdescribe run like test/describe because Exercism's CI enables them (scripts/helpers.mjs);
// test.skip/describe.skip stay skipped (Exercism CI keeps them skipped too).
import * as nt from "node:test";
import { createRequire } from "node:module";
const { expect } = createRequire(import.meta.url)("expect");
const body = (fn) => (fn.length > 0 ? (t, done) => fn(done) : () => fn());
const opts = (timeout) => (typeof timeout === "number" ? { timeout } : {});
export const test = (name, fn, timeout) => nt.test(name, opts(timeout), body(fn));
test.skip = (name, fn, timeout) => nt.test(name, { ...opts(timeout), skip: true }, body(fn));
export const it = test;
export const xtest = test, xit = test;
export const describe = (name, fn) => nt.describe(name, fn);
describe.skip = (name, fn) => nt.describe(name, { skip: true }, fn);
export const xdescribe = describe;
export const beforeEach = (fn, timeout) => nt.beforeEach(body(fn), opts(timeout));
export const afterEach = (fn, timeout) => nt.afterEach(body(fn), opts(timeout));
export const beforeAll = (fn, timeout) => nt.before(body(fn), opts(timeout));
export const afterAll = (fn, timeout) => nt.after(body(fn), opts(timeout));
export { expect };
`;

/** The fixed runner bridge for one spec (only the spec file name varies). */
export const BRIDGE = (specFile) => `// Runs the upstream Exercism spec ${JSON.stringify(specFile)} unchanged under node:test (pi-eval-loop supply, fixed text):
// \`@jest/globals\` resolves to the harness shim; relative imports get jest's extension fallback (.js .mjs .cjs .json).
import { registerHooks } from "node:module";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
const shim = new URL("./.holdout-harness/jest-globals.mjs", import.meta.url).href;
const harness = new URL("./.holdout-harness/", import.meta.url).href;
const isFile = (u) => { try { return statSync(fileURLToPath(u)).isFile(); } catch { return false; } };
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(harness)) return next(specifier, context);
  if (specifier === "@jest/globals") return { url: shim, shortCircuit: true };
  if (/^\\.\\.?\\//.test(specifier) && context.parentURL && !isFile(new URL(specifier, context.parentURL))) {
    for (const ext of [".js", ".mjs", ".cjs", ".json"]) if (isFile(new URL(specifier + ext, context.parentURL))) return next(specifier + ext, context);
  }
  return next(specifier, context);
} });
await import(${JSON.stringify(`./${specFile}`)});
`;

export const PREAMBLE_EXERCISM = (exercise, track, license) => `This directory is the public Exercism ${track} practice exercise "${exercise}" (${license} license) as Exercism delivers it to a student. Implement the solution file(s) so that the exercise's test suite passes with every test enabled, as Exercism's own CI runs it (xtest/xit/xdescribe enabled). The exercise instructions follow verbatim:`;

export const LIMITATIONS_EXERCISM = [
  "Exercism exercises, their test suites and many community solutions have been public for years: absence from model pretraining data is not established and exposure is likely; listed public benchmark sets are excluded, which reduces, not removes, that risk.",
  "The hard tier is Exercism's own annotation (track maintainers' difficulty 8-10, read as hard by Exercism's documented rubric): an independent curator judgement, not a measured difficulty for any model.",
  "The spec runs unchanged under node:test through a fixed bridge and the real `expect` package; jest features the bridge does not carry are rejected, not approximated.",
];

// ------------------------------------------------------------------------------------------------------------------- vendor

/**
 * The real `expect` package with its dependency tree, installed once into <pool>/cache/vendor (network at collection time only;
 * grading is offline). Every package must carry an accepted license. Returns { dir, manifest } where dir holds node_modules.
 */
export function vendorExpect(cacheDir, version, licenses, { install = npmInstall } = {}) {
  const dir = join(cacheDir, `expect-${version}`);
  if (!existsSync(join(dir, "node_modules", "expect", "package.json"))) {
    rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-eval-loop-holdout-harness-vendor", private: true, dependencies: { expect: version } }, null, 2));
    install(dir);
  }
  return { dir, manifest: vendorManifest(dir, version, licenses) };
}
function npmInstall(dir) { execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--omit=dev"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 }); }

/** Pinned versions, integrity and licenses of the vendored tree (from its package-lock.json and package.json files). */
export function vendorManifest(dir, version, licenses) {
  const installed = readJson(join(dir, "node_modules", "expect", "package.json"));
  if (installed.version !== version) throw new Error(`vendored expect is ${installed.version}, want ${version}`);
  const lock = existsSync(join(dir, "package-lock.json")) ? readJson(join(dir, "package-lock.json")) : { packages: {} };
  const packages = [];
  const visit = (nm) => {
    if (!existsSync(nm)) return;
    for (const e of readdirSync(nm, { withFileTypes: true })) {
      if (e.name.startsWith(".") || !e.isDirectory()) continue;
      if (e.name.startsWith("@")) { for (const s of readdirSync(join(nm, e.name), { withFileTypes: true })) if (s.isDirectory()) add(join(nm, e.name, s.name)); continue; }
      add(join(nm, e.name));
    }
  };
  const add = (p) => {
    const pj = readJson(join(p, "package.json"));
    const rel = p.slice(dir.length + 1);
    const license = typeof pj.license === "string" ? pj.license : pj.license?.type;
    if (!licenseAccepted(license, licenses)) throw new Error(`vendored ${pj.name}@${pj.version}: license ${license} not accepted`);
    packages.push({ path: rel, name: pj.name, version: pj.version, license, integrity: lock.packages?.[rel]?.integrity ?? null, resolved: lock.packages?.[rel]?.resolved ?? null });
    visit(join(p, "node_modules"));
  };
  visit(join(dir, "node_modules"));
  packages.sort((a, b) => a.path.localeCompare(b.path));
  return { package: "expect", version, packages, lockDigest: lock.packages ? digestOf(lock.packages) : null };
}

/** Copy the vendored node_modules (no .bin, no symlinks) into a harness directory. */
function copyVendor(vendorDir, to) {
  cpSync(join(vendorDir, "node_modules"), join(to, "node_modules"), { recursive: true, verbatimSymlinks: true, filter: (p) => !/(^|\/)\.bin$/.test(p) && !/(^|\/)\.package-lock\.json$/.test(p) });
  for (const f of walkFiles(join(to, "node_modules"), { skip: [] })) if (f.symlink !== undefined) rmSync(join(to, "node_modules", f.path));
}

// --------------------------------------------------------------------------------------------------------------- collection

const gitText = (cwd, args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).toString();
const show = (clone, rev, path) => gitText(clone.dir, ["show", `${rev}:${path}`]);
const exists = (clone, rev, path) => { try { gitText(clone.dir, ["cat-file", "-e", `${rev}:${path}`]); return true; } catch { return false; } };
const lsTree = (clone, rev, path) => { try { return gitText(clone.dir, ["ls-tree", "--name-only", `${rev}:${path}`]).split("\n").filter(Boolean); } catch { return []; } };

export const exerciseTaskId = (slug, exercise) => `x-${slug.replace("/", "-")}-${exercise}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 90);
export const exerciseSourceKey = (slug, exercise) => `${EXERCISM_SOURCE}:${slug}:practice/${exercise}`;

/**
 * Verify the difficulty rubric at the pinned docs revision. Returns { commit, path, sha256, url, hard: line } or throws: without
 * the documented mapping no exercise gets a source tier.
 */
export function verifyRubric(docsClone, docs) {
  const text = show(docsClone, docsClone.headSha, docs.path);
  for (const [tier, re] of Object.entries(RUBRIC_PATTERN)) if (!re.test(text)) throw new Error(`exercism rubric: no "${tier}" mapping in ${docs.slug}/${docs.path}@${docsClone.headSha}`);
  return { repository: `https://github.com/${docs.slug}`, commit: docsClone.headSha, path: docs.path, sha256: sha256(text), url: `https://github.com/${docs.slug}/blob/${docsClone.headSha}/${docs.path}`, mapping: { easy: "1,2,3", medium: "4,5,6,7", hard: "8,9,10" }, hardLine: text.match(RUBRIC_PATTERN.hard)[0].trim() };
}

/**
 * One Exercism collection: candidate exercises = active practice exercises whose maintainer difficulty maps to a wanted tier
 * (default hard only), in slug order; each is excluded, adapted, checked and validated like a commit case. Rejections carry
 * reason codes only. Returns a non-secret summary.
 * @param {{ pool: string, cfg: any, orcheDir: string, packageDir?: string, log?: (s: string) => void, validate: (dir: string, opts?: any) => Promise<any>, repos?: { track?: any, docs?: any, exclusions?: any[] }, vendor?: { dir: string, manifest: any } }} options
 */
export async function collectExercism({ pool, cfg, orcheDir, packageDir = PACKAGE_DIR, log = () => {}, validate, repos = {}, vendor }) {
  pool = poolPath(pool);
  ensureDir(pool, 0o700);
  chmodSync(pool, 0o700);
  const ex = cfg.exercism;
  const reg = registryOf(pool);
  if (reg.verify().length) throw new Error(`supply registry tampered: ${reg.verify().join("; ")}`);
  const cfgDigest = digestOf(cfg);
  if (!reg.records().some(r => r.type === "config" && r.digest === cfgDigest)) reg.append({ type: "config", schema: SUPPLY_SCHEMA, digest: cfgDigest, config: cfg });
  const cache = ensureDir(join(pool, "cache", "repos"));
  const track = cloneRepo(repos.track ?? { slug: ex.track.slug, url: `https://github.com/${ex.track.slug}.git` }, cache);
  const docs = cloneRepo(repos.docs ?? { slug: ex.rubric.slug, url: `https://github.com/${ex.rubric.slug}.git` }, cache);
  const rubric = verifyRubric(docs, ex.rubric);
  const exclusions = (ex.excludeListedIn ?? []).map((x, i) => {
    const clone = cloneRepo(repos.exclusions?.[i] ?? { slug: x.slug, url: `https://github.com/${x.slug}.git` }, cache);
    const names = lsTree(clone, clone.headSha, x.path);
    if (!names.length) throw new Error(`exclusion list ${x.name}: nothing at ${x.slug}/${x.path}@${clone.headSha}`);
    return { name: x.name, repository: `https://github.com/${x.slug}`, commit: clone.headSha, path: x.path, names: new Set(names) };
  });
  vendor ??= vendorExpect(ensureDir(join(pool, "cache", "vendor")), ex.vendor.expect, cfg.licenses);
  const rev = track.headSha;
  const slug = ex.track.slug;
  const summary = { schema: SUPPLY_SCHEMA, source: EXERCISM_SOURCE, at: new Date().toISOString(), config: cfgDigest, track: { repository: `https://github.com/${slug}`, commit: rev }, rubric: { url: rubric.url, sha256: rubric.sha256 }, exclusions: exclusions.map(x => ({ name: x.name, commit: x.commit, listed: x.names.size })), vendor: { expect: vendor.manifest.version, packages: vendor.manifest.packages.length, lockDigest: vendor.manifest.lockDigest }, candidates: 0, caseRejects: {}, eligible: [], errors: [] };
  // Track-level license: root LICENSE text must match the declared SPDX.
  const rootPkg = JSON.parse(show(track, rev, "package.json"));
  const rootLicense = show(track, rev, "LICENSE");
  if (!licenseAccepted(rootPkg.license, cfg.licenses) || !licenseTextMatches(rootPkg.license, rootLicense)) throw new Error(`exercism track license not verified (${rootPkg.license})`);
  const trackConfigText = show(track, rev, "config.json");
  const trackConfig = JSON.parse(trackConfigText);
  const wanted = new Set(ex.tiers);
  const candidates = (trackConfig.exercises?.practice ?? []).filter(e => !["deprecated", "wip"].includes(e.status ?? "active") && Number.isInteger(e.difficulty) && wanted.has(tierOfDifficulty(e.difficulty))).sort((a, b) => a.slug.localeCompare(b.slug));
  summary.candidates = candidates.length;
  const corpus = knownCorpus({ orcheDir, packageDir, pool });
  summary.scanCoverage = corpus.coverage;
  const seenSources = new Set([...registryOf(pool).records()].filter(r => r.type === "case" && r.sourceKey).map(r => r.sourceKey));
  const count = (code) => { summary.caseRejects[code] = (summary.caseRejects[code] ?? 0) + 1; };
  let validated = 0;
  for (const e of candidates) {
    if (validated >= ex.maxValidate) break;
    const exercise = e.slug, caseId = exerciseTaskId(slug, exercise), sourceKey = exerciseSourceKey(slug, exercise);
    if (seenSources.has(sourceKey)) { count("exercise-seen-in-supply"); continue; }
    const dir = join(pool, "cases", caseId);
    const decide = (status, code, extra = {}) => {
      reg.append({ type: "case", caseId, status, code, source: EXERCISM_SOURCE, repo: slug, revision: rev, sourceKey, ...extra });
      seenSources.add(sourceKey);
      if (status === "rejected") { count(code); rmSync(dir, { recursive: true, force: true }); }
    };
    const listed = exclusions.find(x => x.names.has(exercise));
    if (listed) { decide("rejected", "listed-in-public-benchmark", { listedIn: listed.name }); continue; }
    let built;
    try { built = buildExerciseCase({ track, rev, slug, exercise, entry: e, trackConfigText, rubric, exclusions, vendor, cfg, dir }); }
    catch (error) { decide("rejected", "extraction-failed"); log(`${caseId}: extraction failed ${String(error.message).slice(0, 160)}`); continue; }
    if (built.reject) { decide("rejected", built.reject); continue; }
    const overlap = exerciseOverlap({ slug, exercise, caseId, dir, corpus });
    if (overlap.length) { decide("rejected", overlap[0], { overlap }); continue; }
    validated++;
    const v = await validate(dir, { visibleSuite: "none" });
    atomicWriteJson(join(dir, "validation.private.json"), v); // private: may name hidden tests
    if (!v.ok) { decide("rejected", v.code); continue; }
    const task = built.task;
    task.expected = v.expected;
    atomicWriteJson(join(dir, "task.json"), task);
    decide("eligible", "valid", { family: task.family, tier: task.tier, difficultyBasis: task.difficultyBasis, difficulty: e.difficulty, contentDigest: caseDigest(dir) });
    summary.eligible.push({ id: caseId, family: task.family, tier: task.tier, difficulty: e.difficulty, url: task.upstream.url, license: task.upstream.license.spdx });
    log(`${caseId}: eligible (${task.tier}, difficulty ${e.difficulty})`);
  }
  return summary;
}

/** Overlap reasons of an adapted exercise (codes only). */
export function exerciseOverlap({ slug, exercise, caseId, dir, corpus }) {
  const codes = [];
  if (corpus.families.has(`gh:${slug}`)) codes.push("family-in-earlier-datasets");
  const needles = [`${slug}/exercises/practice/${exercise}`.toLowerCase(), `exercises/practice/${exercise}/`, caseId];
  if (corpus.texts.some(t => needles.some(n => t.includes(n)))) codes.push("named-in-earlier-experiments");
  for (const sub of ["hidden", "reference"]) for (const f of walkFiles(join(dir, sub))) if (f.size > 64 && corpus.fileHashes.has(sha256(readFileSync(join(dir, sub, f.path))))) { codes.push("content-matches-earlier-task"); break; }
  return [...new Set(codes)];
}

/** Adapt one exercise into a task directory, or { reject: code }. */
export function buildExerciseCase({ track, rev, slug, exercise, entry, trackConfigText, rubric, exclusions, vendor, cfg, dir }) {
  const base = `exercises/practice/${exercise}`;
  if (!exists(track, rev, `${base}/.meta/config.json`)) return { reject: "exercise-metadata-missing" };
  const meta = JSON.parse(show(track, rev, `${base}/.meta/config.json`));
  const solution = meta.files?.solution ?? [], tests = meta.files?.test ?? [], example = meta.files?.example ?? [];
  if (tests.length !== 1 || !solution.length || !example.length || example.length > solution.length) return { reject: "exercise-files-unsupported" };
  const spec = tests[0];
  if (spec.includes("/") || !/\.spec\.js$/.test(spec)) return { reject: "exercise-files-unsupported" };
  if (solution.some(s => s.includes("/") || !/\.js$/.test(s))) return { reject: "exercise-files-unsupported" };
  const specText = show(track, rev, `${base}/${spec}`);
  const unsupported = specUnsupported(specText);
  if (unsupported) return { reject: unsupported };
  // Exercise license and manifest (the directory a student receives carries both).
  const pkg = JSON.parse(show(track, rev, `${base}/package.json`));
  if (Object.keys(pkg.dependencies ?? {}).length) return { reject: "runtime-dependencies" };
  if (!licenseAccepted(pkg.license, cfg.licenses)) return { reject: "license-not-accepted" };
  if (!exists(track, rev, `${base}/LICENSE`)) return { reject: "license-file-missing" };
  const licText = show(track, rev, `${base}/LICENSE`);
  if (!licenseTextMatches(pkg.license, licText)) return { reject: "license-text-mismatch" };
  // repo/: the exercise directory without .meta (example solutions, tests.toml).
  rmSync(dir, { recursive: true, force: true });
  const repoDir = ensureDir(join(dir, "repo"));
  const tar = execFileSync("git", ["archive", "--format=tar", `${rev}:${base}`], { cwd: track.dir, maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", repoDir, "--exclude=./.meta", "--exclude=.meta"], { input: tar, maxBuffer: 256 * 1024 * 1024 });
  rmSync(join(repoDir, ".meta"), { recursive: true, force: true });
  const files = walkFiles(repoDir, { skip: [] });
  if (files.some(f => f.symlink !== undefined)) return { reject: "symlink-in-tree" };
  if (files.some(f => f.path.split("/").includes("node_modules"))) return { reject: "vendored-node_modules" };
  if (files.reduce((s, f) => s + (f.size ?? 0), 0) > cfg.commits.maxRepoBytes) return { reject: "repository-too-large" };
  for (const s of solution) if (!existsSync(join(repoDir, s))) return { reject: "exercise-files-unsupported" };
  // hidden/: the byte-identical spec under a non-runner name, the bridge, the harness (shim + vendored expect).
  const hidden = ensureDir(join(dir, "hidden"));
  const stem = basename(spec, ".spec.js");
  const upstreamSpec = `${stem}.upstream-spec.js`, bridge = `${stem}.holdout.test.mjs`;
  writeFileSync(join(hidden, upstreamSpec), specText);
  writeFileSync(join(hidden, bridge), BRIDGE(upstreamSpec));
  const harness = ensureDir(join(hidden, ".holdout-harness"));
  writeFileSync(join(harness, "jest-globals.mjs"), JEST_GLOBALS_SHIM);
  copyVendor(vendor.dir, harness);
  atomicWriteJson(join(harness, "VENDOR.json"), vendor.manifest);
  // reference/: the maintainers' example solution(s) in place of the solution file(s) (Exercism CI's only rewrite).
  const reference = ensureDir(join(dir, "reference"));
  const rewritten = [];
  example.forEach((p, i) => {
    const text = show(track, rev, `${base}/${p}`);
    const out = text.split("from '../").join("from './");
    if (out !== text) rewritten.push(solution[i]);
    ensureDir(dirname(join(reference, solution[i])));
    writeFileSync(join(reference, solution[i]), out);
  });
  // Instruction: Exercism's own documents, verbatim, in the order the student's README carries them.
  const docs = ["introduction.md", "instructions.md", "instructions.append.md"].filter(d => exists(track, rev, `${base}/.docs/${d}`));
  if (!docs.includes("instructions.md")) return { reject: "instructions-missing" };
  const instruction = `${PREAMBLE_EXERCISM(exercise, slug.split("/")[1], pkg.license)}\n\n${docs.map(d => show(track, rev, `${base}/.docs/${d}`).trim()).join("\n\n")}\n`;
  const id = exerciseTaskId(slug, exercise);
  const tier = tierOfDifficulty(entry.difficulty);
  const lastChange = gitText(track.dir, ["log", "-1", "--format=%H %cI", rev, "--", base]).trim().split(" ");
  const copyright = (licText.split("\n").find(l => /copyright/i.test(l)) ?? "").trim().slice(0, 300);
  const difficultySource = {
    dataset: `${slug} config.json (exercises.practice[].difficulty, set by the track maintainers)`,
    repository: `https://github.com/${slug}`, commit: rev, path: "config.json", configSha256: sha256(trackConfigText),
    url: `https://github.com/${slug}/blob/${rev}/config.json`, exercise, uuid: entry.uuid ?? null,
    field: "difficulty", value: entry.difficulty, scale: "1-10", tier, label: tier,
    rubric,
  };
  const upstream = {
    schema: SUPPLY_SCHEMA, source: EXERCISM_SOURCE, repository: `https://github.com/${slug}`, revision: rev, path: base,
    url: `https://github.com/${slug}/tree/${rev}/${base}`, lastChange: { commit: lastChange[0], committedAt: lastChange[1] },
    authors: meta.authors ?? [], contributors: meta.contributors ?? [], blurb: meta.blurb ?? null,
    license: { spdx: pkg.license, file: `${base}/LICENSE`, sha256: sha256(licText), copyright },
    adaptation: { repo: "exercise directory at the pinned revision without .meta/", hidden: { spec: `${spec} -> ${upstreamSpec} (byte-identical)`, bridge, harness: ".holdout-harness (fixed @jest/globals shim + vendored expect)", activation: "xtest/xit/xdescribe enabled as in Exercism CI; test.skip stays skipped" }, reference: example.map((p, i) => `${p} -> ${solution[i]}`), referenceRewrite: rewritten.length ? { rule: "from '../ -> from './ (Exercism CI)", files: rewritten } : null, instruction: `fixed preamble + .docs/${docs.join(", .docs/")} verbatim`, visibleSuite: "none (the spec is jest-only; node --test finds no visible tests)" },
    vendor: { package: "expect", version: vendor.manifest.version, packages: vendor.manifest.packages.length, lockDigest: vendor.manifest.lockDigest },
    exclusions: exclusions.map(x => ({ name: x.name, repository: x.repository, commit: x.commit, path: x.path })),
    limitations: LIMITATIONS_EXERCISM,
  };
  const task = { id, family: `gh:${slug}`, tier, difficultyBasis: "source", difficultySource, instruction, provenance: PROVENANCE, timeoutSec: 900, upstream };
  atomicWriteJson(join(dir, "task.json"), task);
  return { task };
}

