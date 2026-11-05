// Holdout supply (src/supply.mjs) and its engine integration. Everything here is synthetic and local: the "upstream"
// repositories are temporary git repositories built by the test, so NONE of these tasks is an eligible independent holdout.
// No network, no model. One test uses the real grading sandbox (bubblewrap) when it is available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { edit, HOLDOUT, makeHoldout, makeLoop, rmSync, tempDir, testProtocol, skillOf } from "./helpers.mjs";
import { acquireLock, Ledger, LockBusyError } from "../src/util.mjs";
import { verifySeal } from "../src/datasets.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";
import { assignmentFor, batchEligibility, cleanMessage, collect, hiddenNameOf, licenseAccepted, licenseTextMatches, mergeSupply, poolPath, poolState, poolStatus, preflightReport, registryOf, reserveBatch, sealBatch, selectBatch, validateCase } from "../src/supply.mjs";
import { DEFAULT_PROTOCOL, merge, PACKAGE_DIR, validateProtocol } from "../src/protocol.mjs";

const MIT = "MIT License\n\nCopyright (c) 2024 Upstream Dev\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...\n";
const APACHE = "Apache License, Version 2.0\n\nCopyright 2024 Upstream Dev\n";
const ENTRY0 = { hypothesis: "re-read requirements before finishing", targetFailureClass: "requirements-generalization", edit: edit("good") };

function gitc(dir, args, env = {}) { return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env } }).toString().trim(); }
/** A local "upstream" repository; commits = [{ message, date, files: { path: text | null (delete) }, author? }]. */
function upstream(root, slug, { license = "MIT", licenseText = MIT, name = slug.split("/")[1], commits }) {
  const dir = join(root, "upstream", slug.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  gitc(dir, ["init", "-q", "-b", "main"]);
  const write = (files) => { for (const [p, t] of Object.entries(files)) { if (t === null) rmSync(join(dir, p)); else { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), t); } } };
  const shas = [];
  write({ "package.json": JSON.stringify({ name, version: "1.0.0", license, type: "module", scripts: { test: "node --test" } }, null, 2), LICENSE: licenseText });
  for (const c of commits) {
    write(c.files);
    gitc(dir, ["add", "-A"]);
    const [an, ae] = (c.author ?? "Upstream Dev <dev@example.org>").match(/^(.*) <(.*)>$/).slice(1);
    gitc(dir, ["commit", "-q", "-m", c.message], { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_COMMITTER_NAME: an, GIT_COMMITTER_EMAIL: ae, GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date });
    shas.push(gitc(dir, ["rev-parse", "HEAD"]));
  }
  return { slug, url: dir, npm: { name }, shas };
}

const CLAMP0 = "export function clamp(x, lo, hi) {\n  return Math.min(Math.max(x, lo), hi);\n}\n";
const CLAMP1 = "export function clamp(x, lo, hi) {\n  if (lo > hi) throw new RangeError(`lower bound ${lo} exceeds upper bound ${hi}`);\n  return Math.min(Math.max(x, lo), hi);\n}\n";
const CLAMP_ROUND = "export function clamp(x, lo, hi) {\n  if (lo > hi) throw new RangeError(`lower bound ${lo} exceeds upper bound ${hi}`);\n  return Math.min(Math.max(Math.round(x), lo), hi);\n}\n";
const T0 = "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { clamp } from \"../index.js\";\n\ntest(\"clamps into the range\", () => {\n  assert.equal(clamp(5, 0, 3), 3);\n  assert.equal(clamp(0.4, 0, 1), 0.4);\n});\n";
const T1 = `${T0}\ntest("rejects an inverted range", () => {\n  assert.throws(() => clamp(1, 3, 0), RangeError);\n});\n`;
const T_ROUND = T1.replace("assert.equal(clamp(0.4, 0, 1), 0.4);", "assert.equal(clamp(0.4, 0, 1), 0);");

function clampRepo(root, slug = "acme/clamp", dates = ["2025-01-01T00:00:00Z", "2026-03-01T00:00:00Z"]) {
  return upstream(root, slug, {
    name: `${slug.split("/")[1]}-lib`,
    commits: [
      { message: "Initial import", date: dates[0], files: { "index.js": CLAMP0, "legacy.js": "export const old = 1;\n", "test/clamp.test.js": T0 } },
      { message: "Throw a RangeError when the lower bound exceeds the upper bound\n\nCloses #12\n\nSigned-off-by: Upstream Dev <dev@example.org>", date: dates[1], files: { "index.js": CLAMP1, "test/clamp.test.js": T1 } },
      { message: "Bump version to 1.1.0", date: "2026-03-02T00:00:00Z", files: { "package.json": JSON.stringify({ name: "clamp-lib", version: "1.1.0", license: "MIT", type: "module", scripts: { test: "node --test" } }) } },
      { message: "Speed up clamping of integer inputs considerably", date: "2026-03-03T00:00:00Z", files: { "index.js": `${CLAMP1}// fast path\n` } },
      { message: "Update the development tooling configuration", date: "2026-03-04T00:00:00Z", author: "dependabot[bot] <bot@example.org>", files: { "index.js": `${CLAMP1}// fast path\n// x\n`, "test/clamp.test.js": `${T1}// x\n` } },
      { message: "Round fractional inputs to the nearest integer before clamping", date: "2026-03-05T00:00:00Z", files: { "index.js": CLAMP_ROUND, "test/clamp.test.js": T_ROUND } },
      { message: "Drop the deprecated legacy helper module entirely", date: "2026-03-06T00:00:00Z", files: { "legacy.js": null, "index.js": `${CLAMP_ROUND}// legacy removed\n`, "test/clamp.test.js": `${T_ROUND}// y\n` } },
    ],
  });
}
const PAD0 = "export const pad = (s, n) => String(s).padStart(n);\n";
const PAD1 = "export const pad = (s, n, fill = \" \") => String(s).padStart(n, fill);\n";
const PT0 = "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { pad } from \"./index.js\";\ntest(\"pads\", () => assert.equal(pad(1, 3), \"  1\"));\n";
const PT1 = `${PT0}test("pads with a custom fill", () => assert.equal(pad(1, 3, "0"), "001"));\n`;
// Each synthetic upstream gets its own bytes (a header naming it), so distinct repositories never share a patch-id.
const padRepo = (root, slug, opts = {}) => { const h = `// ${slug}\n`; return upstream(root, slug, { ...opts, commits: [
  { message: "Initial import", date: "2025-01-01T00:00:00Z", files: { "index.js": h + PAD0, "pad.test.js": h + PT0 } },
  { message: "Support a custom fill character when padding values", date: opts.date ?? "2026-04-01T00:00:00Z", files: { "index.js": h + PAD1, "pad.test.js": (opts.testText ?? (h + PT1)) } },
] }); };

const CFG = mergeSupply({ since: "2026-01-01T00:00:00Z", validation: { repeats: 1, timeoutMs: 60_000 }, batch: { maxTasks: 12, maxPerFamily: 2, seed: "test" } });
const fakeValidate = (bad = new Set()) => async (dir) => { const t = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")); return bad.has(t.upstream.commit) ? { ok: false, code: "reference-breaks-visible-suite", detail: {} } : { ok: true, code: "valid", expected: { hiddenTests: 2 }, detail: {} }; };
function fakeOrche(root, mentions = []) { const o = join(root, "orche"); mkdirSync(join(o, "experiments/x"), { recursive: true }); writeFileSync(join(o, "experiments/x/plan.md"), `Earlier experiment notes: ${mentions.join(", ")}\n`); return o; }

test("collect: qualifying upstream commits are adapted without invention; every other commit is rejected with a reason code", async () => {
  const root = tempDir();
  try {
    const a = clampRepo(root);
    const b = padRepo(root, "beta/pad");
    const gpl = padRepo(root, "gamma/gpl", { license: "GPL-3.0" });
    const mismatch = padRepo(root, "delta/mismatch", { licenseText: APACHE });
    const named = padRepo(root, "epsilon/named");
    const fork = clampRepo(root, "fork/clamp", ["2025-02-02T00:00:00Z", "2026-03-09T00:00:00Z"]); // same changes, another history
    const pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    const pool = join(root, "pool");
    const summary = await collect({ pool, cfg: CFG, repos: [a, b, gpl, mismatch, named, fork], orcheDir: fakeOrche(root, ["epsilon/named"]), packageDir: pkgDir, validate: fakeValidate(new Set([a.shas[5], fork.shas[5]])) });
    assert.deepEqual(summary.eligible.map(e => e.id).sort(), [`x-acme-clamp-${a.shas[1].slice(0, 10)}`, `x-beta-pad-${b.shas[1].slice(0, 10)}`].sort());
    assert.equal(summary.commitRejects["bot-author"], 2);
    assert.equal(summary.commitRejects["no-runnable-test-change"], 2);
    assert.equal(summary.commitRejects["deletion-rename-or-type-change"], 2);
    assert.ok(summary.commitRejects["non-descriptive-subject"] >= 2, "version bumps");
    assert.equal(summary.caseRejects["license-not-accepted"], 1);
    assert.equal(summary.caseRejects["license-text-mismatch"], 1);
    assert.equal(summary.caseRejects["named-in-earlier-experiments"], 1);
    assert.equal(summary.caseRejects["patch-seen-in-supply"], 2, "the fork's identical changes are duplicates");
    assert.equal(summary.caseRejects["reference-breaks-visible-suite"], 1);
    // The adapted task: upstream tree at the parent, upstream tests as hidden, upstream fix as reference, upstream text.
    const id = `x-acme-clamp-${a.shas[1].slice(0, 10)}`, dir = join(pool, "cases", id);
    const t = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
    assert.equal(readFileSync(join(dir, "repo/index.js"), "utf8"), CLAMP0);
    assert.equal(readFileSync(join(dir, "hidden/test/clamp.test.js"), "utf8"), T1);
    assert.equal(readFileSync(join(dir, "reference/index.js"), "utf8"), CLAMP1);
    assert.equal(t.provenance, "external"); assert.equal(t.family, "gh:acme/clamp"); assert.equal(t.upstream.commit, a.shas[1]); assert.equal(t.upstream.parent, a.shas[0]);
    assert.equal(t.upstream.license.spdx, "MIT"); assert.match(t.upstream.license.copyright, /Copyright \(c\) 2024 Upstream Dev/);
    assert.match(t.instruction, /Throw a RangeError when the lower bound exceeds the upper bound\n\nCloses #12/);
    assert.doesNotMatch(t.instruction, /Signed-off-by/);
    assert.deepEqual(t.expected, { hiddenTests: 2 });
    // The registry is hash-chained and holds reason codes only; the non-secret summary has no test or solution content.
    assert.deepEqual(poolState(pool).chain, []);
    const text = JSON.stringify(summary) + readFileSync(join(pool, "registry.jsonl"), "utf8");
    assert.doesNotMatch(text, /assert\.|Math\.min|padStart/);
    // A second collect over the same repositories takes no commit twice.
    const again = await collect({ pool, cfg: CFG, repos: [a, b], orcheDir: fakeOrche(root), packageDir: pkgDir, validate: fakeValidate() });
    assert.equal(again.eligible.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("collect: content identical to an earlier task is rejected; pool paths inside the package are refused", async () => {
  const root = tempDir();
  try {
    const copy = padRepo(root, "eta/copy", { testText: PT1 });
    const pkgDir = join(root, "pkg"), old = join(pkgDir, "datasets/old/o1");
    mkdirSync(join(old, "reference"), { recursive: true }); mkdirSync(join(old, "repo"), { recursive: true });
    writeFileSync(join(old, "task.json"), JSON.stringify({ id: "o1", family: "old", tier: "easy", instruction: "x", provenance: "implementer" }));
    writeFileSync(join(old, "repo/package.json"), "{\"name\":\"old\"}");
    writeFileSync(join(old, "reference/renamed-copy.test.js"), PT1); // the same oracle under another name
    const s = await collect({ pool: join(root, "pool"), cfg: CFG, repos: [copy], orcheDir: fakeOrche(root), packageDir: pkgDir, validate: fakeValidate() });
    assert.equal(s.caseRejects["content-matches-earlier-task"], 1);
    assert.throws(() => poolPath(join(PACKAGE_DIR, "datasets", "pool")), /inside the pi-eval-loop package/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("adaptation helpers: runner names, trailers, licenses", () => {
  assert.equal(hiddenNameOf("test/a.test.js"), "test/a.test.js");
  assert.equal(hiddenNameOf("test.js"), "test.holdout.test.js");
  assert.equal(hiddenNameOf("test/index.ts"), "test/index.holdout.test.ts");
  assert.equal(cleanMessage("Fix x\n\nbody\nCo-authored-by: A <a@b>\nSigned-off-by: B <b@c>"), "Fix x\n\nbody");
  assert.ok(licenseAccepted("MIT", ["MIT"])); assert.ok(licenseAccepted("(MIT OR GPL-3.0)", ["MIT"])); assert.ok(!licenseAccepted("GPL-3.0", ["MIT"])); assert.ok(!licenseAccepted("", ["MIT"]));
  assert.ok(licenseTextMatches("MIT", MIT)); assert.ok(!licenseTextMatches("MIT", APACHE));
});

test("real grading sandbox: original fails the upstream tests, the fix passes; a fix that breaks the visible suite is rejected", { skip: !existsSync("/usr/bin/bwrap") && "no bubblewrap" }, async () => {
  const root = tempDir();
  try {
    const a = clampRepo(root);
    const { hostEnvironment } = await import("../src/sandbox.mjs");
    const { gradeWorkspace } = await import("../src/grader.mjs");
    const env = hostEnvironment();
    const pool = join(root, "pool");
    let n = 0;
    const validate = (dir) => validateCase(dir, { env, scratch: join(root, "scratch", String(n++)), repeats: 2, timeoutMs: 60_000, gradeWorkspace });
    const s = await collect({ pool, cfg: CFG, repos: [a], orcheDir: fakeOrche(root), packageDir: join(root, "pkg"), validate });
    assert.deepEqual(s.eligible.map(e => e.id), [`x-acme-clamp-${a.shas[1].slice(0, 10)}`]);
    assert.equal(s.caseRejects["reference-breaks-visible-suite"], 1);
    const v = JSON.parse(readFileSync(join(pool, "cases", s.eligible[0].id, "validation.private.json"), "utf8"));
    assert.equal(v.ok, true); assert.deepEqual(v.expected, { hiddenTests: 2 });
    assert.ok(v.detail.original.every(o => o.visible.pass && !o.hidden.pass && o.hidden.failed === 1));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A pool whose cases come from synthetic upstreams (fake validation), sealed into one batch. */
async function sealedPool(root, { families = 3, minima = { minTasks: 2, minFamilies: 2, requireHard: false } } = {}) {
  const repos = Array.from({ length: families }, (_, i) => padRepo(root, `fam${i}/pad`, { date: `2026-04-0${i + 1}T00:00:00Z` }));
  const pool = join(root, "pool");
  await collect({ pool, cfg: CFG, repos, orcheDir: fakeOrche(root), packageDir: join(root, "pkg"), validate: fakeValidate() });
  return { pool, sealed: sealBatch({ pool, cfg: CFG, minima }) };
}

test("seal: candidate-blind selection, coverage minima, tamper detection, idempotent reservation per experiment", async () => {
  const root = tempDir();
  try {
    const { pool, sealed } = await sealedPool(root);
    assert.ok(sealed.batch, JSON.stringify(sealed));
    assert.deepEqual(sealed.coverage, { tasks: 3, families: 3, owners: 3, hard: 0, hardByUnacceptedBasis: 0 });
    assert.equal(verifySeal(sealed.dir).ok, true);
    assert.ok(existsSync(join(sealed.dir, "PROVENANCE.json")));
    assert.equal(readdirSync(join(pool, "cases")).length, 0, "batched cases leave the staging area");
    assert.match(sealBatch({ pool, cfg: CFG, minima: { minTasks: 2, minFamilies: 2 } }).blocked, /insufficient eligible supply: tasks 0 < 2/);
    // Selection depends only on ids, seed, tier and family (no candidate result exists in its input).
    const pick = selectBatch([{ caseId: "a", family: "f1", tier: "easy" }, { caseId: "b", family: "f1", tier: "hard", difficultyBasis: "source" }, { caseId: "c", family: "f1", tier: "easy" }, { caseId: "d", family: "f2", tier: "easy" }], { batch: { seed: "s", maxTasks: 10, maxPerFamily: 2 } }, { minTasks: 3, minFamilies: 2, requireHard: true, hardBasis: ["source"] });
    assert.equal(pick.ids[0], "b"); assert.equal(pick.coverage.tasks, 3); assert.ok(pick.ok);
    const owners = selectBatch(["gh:o1/a", "gh:o1/b", "gh:o1/c", "gh:o2/d"].map((family, i) => ({ caseId: `k${i}`, family, tier: "easy" })), { batch: { seed: "s", maxTasks: 10, maxPerFamily: 2, maxPerOwner: 2 } }, { minTasks: 1, minFamilies: 1 });
    assert.equal(owners.coverage.tasks, 3); assert.equal(owners.coverage.owners, 2);
    // The first-hard priority path respects the account cap too.
    const hardFirst = selectBatch(["gh:o1/a", "gh:o1/b", "gh:o1/c", "gh:o1/d", "gh:o1/e", "gh:o2/f"].map((family, i) => ({ caseId: `h${i}`, family, tier: i === 4 ? "hard" : "easy", difficultyBasis: "source" })), { batch: { seed: "s", maxTasks: 10, maxPerFamily: 2, maxPerOwner: 2 } }, { minTasks: 1, minFamilies: 1, requireHard: true, hardBasis: ["source"] });
    assert.equal(hardFirst.ids[0], "h4"); assert.equal(hardFirst.ids.filter(id => id !== "h5").length, 2); assert.equal(hardFirst.coverage.hard, 1);
    const protocol = structuredClone(DEFAULT_PROTOCOL); protocol.holdout.minTasks = 2; protocol.holdout.minFamilies = 2; protocol.adoption.requireHardStratum = false;
    const orcheDir = fakeOrche(root);
    const s1 = join(root, "exp1"), s2 = join(root, "exp2");
    const r1 = reserveBatch(pool, s1, protocol, { orcheDir });
    assert.equal(r1.batch, sealed.batch);
    assert.equal(reserveBatch(pool, s1, protocol, { orcheDir }).batch, r1.batch, "a retry gets the same batch");
    assert.equal(poolState(pool).records.filter(r => r.type === "reserve").length, 1, "and reserves nothing new");
    assert.match(reserveBatch(pool, s2, protocol, { orcheDir }).none.join(" "), /reserved by another experiment/);
    // A competing reservation meets the pool lock (busy, never a second reservation).
    const held = acquireLock(join(pool, ".pool.lock"));
    try { assert.throws(() => reserveBatch(pool, join(root, "exp3"), protocol, { orcheDir }), LockBusyError); } finally { held.release(); }
    // Tampering with a sealed file makes the batch ineligible.
    const task = poolState(pool).batches.get(sealed.batch).tasks[0];
    appendFileSync(join(sealed.dir, task, "hidden/pad.test.js"), "// edited\n");
    assert.match(batchEligibility(sealed.dir, protocol, { orcheDir }).reasons.join(" "), /dataset changed since sealing/);
    const status = poolStatus(pool, protocol, { orcheDir });
    assert.equal(status.batches[0].eligibleNow, false); assert.ok(status.batches[0].reservedBy.endsWith("exp1")); assert.ok(status.batches[0].coverageAtSeal && "coverageNow" in status.batches[0]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** An engine-compatible pool batch built from the loop fixtures' holdout tasks (synthetic; test-only). */
function addBatch(root, pool, name) {
  const tmp = makeHoldout(join(root, `mk-${name}`), HOLDOUT);
  mkdirSync(join(pool, "batches"), { recursive: true });
  renameSync(tmp.dir, join(pool, "batches", name));
  registryOf(pool).append({ type: "batch", batch: name, tasks: HOLDOUT.map(h => h[0]), sealDigest: verifySeal(join(pool, "batches", name)).seal.digest });
}
function poolWithBatch(root) { const pool = join(root, "pool"); addBatch(root, pool, "b1"); return pool; }
const poolProtocol = (pool) => testProtocol({ datasets: { holdout: null, holdoutPool: pool } });
function counter() { let runs = 0; const sim = simulatedBackend({ skill: skillOf, seed: "test" }); return { backend: { simulated: true, run: (i) => { runs++; return sim.run(i); } }, get runs() { return runs; } }; }

test("engine: a fresh experiment reserves an unused batch, locks it with the protocol and consumes it once; its next cycle is blocked", async () => {
  const root = tempDir();
  try {
    const pool = poolWithBatch(root);
    const { loop } = makeLoop({ root, entries: [ENTRY0], protocol: poolProtocol(pool), holdoutFromProtocol: true });
    const state = await loop.runCycle();
    assert.equal(state.final.verdict, "ADOPT");
    assert.equal(state.holdoutBatch.batch, "b1");
    const lock = JSON.parse(readFileSync(join(loop.stateDir, "protocol.lock.json"), "utf8"));
    assert.equal(lock.protocol.datasets.holdout, join(pool, "batches", "b1"));
    assert.equal(new Ledger(join(pool, "batches/b1/USES.jsonl")).records().length, 1);
    assert.equal(assignmentFor(pool, loop.stateDir).batch, "b1");
    loop.nextCycle();
    const second = await loop.runCycle();
    assert.equal(second.phase, "blocked"); assert.equal(second.blocked.retryable, false); assert.match(second.blocked.preflight.reasons.join(" "), /already used 1 time/);
    assert.equal(new Ledger(join(pool, "batches/b1/USES.jsonl")).records().length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine: no eligible batch -> BLOCKED (retryable) before the lock and any run; a later batch is reserved on retry", async () => {
  const root = tempDir();
  try {
    const pool = join(root, "pool");
    registryOf(pool).append({ type: "config", digest: "x" });
    const c = counter();
    const { loop, fx } = makeLoop({ root, entries: [ENTRY0], protocol: poolProtocol(pool), holdoutFromProtocol: true, backend: c.backend });
    const s = await loop.runCycle();
    assert.equal(s.phase, "blocked"); assert.equal(s.blocked.retryable, true); assert.match(s.blocked.reason, /no eligible unused holdout batch/);
    assert.equal(c.runs, 0); assert.equal(existsSync(join(loop.stateDir, "protocol.lock.json")), false);
    addBatch(root, pool, "b2");
    const again = makeLoop({ root, entries: [ENTRY0], protocol: poolProtocol(pool), holdoutFromProtocol: true, fixtures: fx });
    const done = await again.loop.runCycle();
    assert.equal(done.phase, "done"); assert.equal(done.holdoutBatch.batch, "b2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine: a batch reserved by another experiment is not taken; retries of one experiment keep their batch", async () => {
  const root = tempDir();
  try {
    const pool = poolWithBatch(root);
    const first = makeLoop({ root, entries: [ENTRY0], protocol: poolProtocol(pool), holdoutFromProtocol: true });
    first.loop.stopBefore = "search";
    await first.loop.runCycle();
    assert.equal(first.loop.state.holdoutBatch.batch, "b1");
    const retry = makeLoop({ root, entries: [ENTRY0], protocol: poolProtocol(pool), holdoutFromProtocol: true, fixtures: first.fx });
    retry.loop.stopBefore = "search";
    await retry.loop.runCycle();
    assert.equal(retry.loop.state.holdoutBatch.batch, "b1");
    assert.equal(poolState(pool).records.filter(r => r.type === "reserve").length, 1);
    const c = counter();
    const other = makeLoop({ root, entries: [ENTRY0], protocol: poolProtocol(pool), holdoutFromProtocol: true, fixtures: first.fx, stateName: "other", backend: c.backend });
    const s = await other.loop.runCycle();
    assert.equal(s.phase, "blocked"); assert.match(JSON.stringify(s.blocked.candidates), /reserved by another experiment/); assert.equal(c.runs, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine: a use appended before a crash is recovered (not appended twice); a foreign use at use time blocks without running", async () => {
  const root = tempDir(), root2 = tempDir();
  try {
    const pool = poolWithBatch(root);
    const { loop, fx } = makeLoop({ root, entries: [ENTRY0], protocol: poolProtocol(pool), holdoutFromProtocol: true });
    loop.stopBefore = "holdout";
    await loop.runCycle();
    assert.equal(loop.state.phase, "holdout");
    const sel = loop.state.selection;
    const ledger = new Ledger(join(pool, "batches/b1/USES.jsonl"));
    ledger.append({ type: "use", stateDir: loop.stateDir, protocolDigest: loop.protocolDigest, selected: sel.selected, commit: sel.commit, frozenDigest: sel.frozenDigest, independentBefore: true, why: "sealed, unexposed, unused" });
    const resumed = makeLoop({ root, entries: [ENTRY0], protocol: poolProtocol(pool), holdoutFromProtocol: true, fixtures: fx });
    const s = await resumed.loop.runCycle();
    assert.equal(s.final.verdict, "ADOPT");
    assert.equal(ledger.records().length, 1, "the crashed use is this selection's own use");

    const pool2 = poolWithBatch(root2);
    const c = counter();
    const a = makeLoop({ root: root2, entries: [ENTRY0], protocol: poolProtocol(pool2), holdoutFromProtocol: true, backend: c.backend });
    a.loop.stopBefore = "holdout";
    await a.loop.runCycle();
    const before = c.runs;
    const l2 = new Ledger(join(pool2, "batches/b1/USES.jsonl"));
    l2.append({ type: "use", stateDir: "/elsewhere", note: "another experiment" });
    const b = makeLoop({ root: root2, entries: [ENTRY0], protocol: poolProtocol(pool2), holdoutFromProtocol: true, fixtures: a.fx, backend: c.backend });
    const s2 = await b.loop.runCycle();
    assert.equal(s2.phase, "done"); assert.equal(s2.final.verdict, "BLOCKED"); assert.equal(s2.final.holdoutEvaluated, false);
    assert.equal(l2.records().length, 1, "not consumed"); assert.equal(c.runs, before, "no holdout run");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(root2, { recursive: true, force: true }); }
});

test("protocol: holdoutPool needs holdout null; CLI --preflight is read-only and reports BLOCKED without a supply", async () => {
  const root = tempDir();
  try {
    assert.match(validateProtocol(merge(structuredClone(DEFAULT_PROTOCOL), { datasets: { holdoutPool: "/x" } })).join(" "), /needs datasets.holdout: null/);
    const empty = join(root, "empty-pool"); mkdirSync(empty);
    const pfile = join(root, "p.json"); writeFileSync(pfile, JSON.stringify({ datasets: { holdout: null, holdoutPool: empty } }));
    const r = spawnSync(process.execPath, [join(PACKAGE_DIR, "bin/eval-loop.mjs"), "--preflight", "--state", join(root, "s"), "--protocol", pfile], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
    assert.equal(out.schema, "pi-eval-loop/preflight@1"); assert.equal(out.ok, false); assert.match(out.reasons.join(" "), /no supply registry/);
    assert.equal(existsSync(join(root, "s")), false, "read-only");
    assert.match(preflightReport(merge(structuredClone(DEFAULT_PROTOCOL), { datasets: { holdout: null } }), join(root, "s")).reasons[0], /exploration-only/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime boundary: a model-facing sandbox (no pool bind) cannot read the pool; the pool root is mode 0700", { skip: !existsSync("/usr/bin/bwrap") && "no bubblewrap" }, async () => {
  const root = tempDir();
  try {
    const { pool } = await sealedPool(root);
    const { statSync } = await import("node:fs");
    assert.equal(statSync(pool).mode & 0o777, 0o700);
    const { runSandboxed } = await import("../src/sandbox.mjs");
    const target = join(pool, "registry.jsonl");
    const inside = await runSandboxed({ binds: [], env: { PATH: "/usr/bin:/bin" }, cwd: "/", command: ["/bin/sh", "-c", `cat '${target}' && echo READ || echo DENIED`] }, { guardMs: 20_000 });
    assert.match(inside.text, /DENIED/); assert.doesNotMatch(inside.text, /READ/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("per-account cap: a pool dominated by one account seals at most maxPerOwner of its tasks (registry aggregate == PROVENANCE)", async () => {
  const root = tempDir();
  try {
    const repos = [...Array.from({ length: 6 }, (_, i) => padRepo(root, `solo/pkg${i}`, { date: `2026-05-0${i + 1}T00:00:00Z` })), padRepo(root, "other1/a"), padRepo(root, "other2/b")];
    const pool = join(root, "pool");
    await collect({ pool, cfg: CFG, repos, orcheDir: fakeOrche(root), packageDir: join(root, "pkg"), validate: fakeValidate() });
    const cfg = mergeSupply({ ...CFG, batch: { maxTasks: 12, maxPerFamily: 2, maxPerOwner: 4, seed: "test" } });
    const sealed = sealBatch({ pool, cfg, minima: { minTasks: 2, minFamilies: 2, requireHard: false } });
    const prov = JSON.parse(readFileSync(join(sealed.dir, "PROVENANCE.json"), "utf8"));
    const owners = {};
    for (const t of prov.tasks) { const o = t.upstream.repository.split("/")[3]; owners[o] = (owners[o] ?? 0) + 1; }
    assert.deepEqual(owners, { solo: 4, other1: 1, other2: 1 });
    assert.equal(sealed.coverage.owners, 3);
    assert.equal(poolStatus(pool, structuredClone(DEFAULT_PROTOCOL), { orcheDir: fakeOrche(root) }).unbatchedEligible, 2, "the solo account's surplus stays unbatched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("difficulty: size-proxy hard tiers never make a hard stratum (seal, eligibility, preflight, engine); declared/source tiers do", async () => {
  const root = tempDir();
  try {
    // Supply-built tasks carry difficultyBasis size-proxy; a big upstream fix is still not an accepted hard task.
    const big = upstream(root, "big/fix", { commits: [
      { message: "Initial import", date: "2025-01-01T00:00:00Z", files: { "a.js": "export const a = 1;\n", "b.js": "export const b = 1;\n", "c.js": "export const c = 1;\n", "abc.test.js": PT0.replace("./index.js", "./a.js").replace("pad", "a").replace("pads", "a").replace(/pad\(1, 3\), "  1"/, "a, 1") } },
      { message: "Rework the three modules to export doubled constant values", date: "2026-06-01T00:00:00Z", files: { "a.js": "export const a = 2;\n", "b.js": "export const b = 2;\n", "c.js": "export const c = 2;\n", "abc.test.js": "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { a } from \"./a.js\";\ntest(\"a\", () => assert.equal(a, 2));\n" } },
    ] });
    const pool = join(root, "pool");
    const s = await collect({ pool, cfg: CFG, repos: [big, padRepo(root, "p1/x"), padRepo(root, "p2/y")], orcheDir: fakeOrche(root), packageDir: join(root, "pkg"), validate: fakeValidate() });
    const bigCase = s.eligible.find(e => e.family === "gh:big/fix");
    assert.equal(bigCase.tier, "hard");
    const t = JSON.parse(readFileSync(join(pool, "cases", bigCase.id, "task.json"), "utf8"));
    assert.equal(t.difficultyBasis, "size-proxy");
    const minima = { minTasks: 2, minFamilies: 2, requireHard: true, hardBasis: DEFAULT_PROTOCOL.holdout.hardBasis };
    const blocked = sealBatch({ pool, cfg: CFG, minima });
    assert.match(blocked.blocked, /no hard task with an accepted difficulty basis/);
    assert.equal(blocked.coverage.hardByUnacceptedBasis, 1);
    // Sealed anyway (requireHard off, e.g. an older rule): eligibility and the engine preflight still refuse the hard stratum.
    const sealed = sealBatch({ pool, cfg: CFG, minima: { ...minima, requireHard: false } });
    const protocol = structuredClone(DEFAULT_PROTOCOL); protocol.holdout.minTasks = 2; protocol.holdout.minFamilies = 2;
    const e = batchEligibility(sealed.dir, protocol, { orcheDir: fakeOrche(root) });
    assert.equal(e.ok, false); assert.equal(e.coverage.hard, 0); assert.equal(e.coverage.hardUnverified, 1);
    assert.match(e.reasons.join(" "), /coverage UNVERIFIED/);
    assert.match(preflightReport({ ...protocol, datasets: { ...protocol.datasets, holdout: sealed.dir } }, join(root, "s"), { orcheDir: fakeOrche(root) }).reasons.join(" "), /no hard stratum/);
    // The protocol cannot be told to accept the size proxy.
    assert.match(validateProtocol(merge(structuredClone(DEFAULT_PROTOCOL), { holdout: { hardBasis: ["declared", "size-proxy"] } })).join(" "), /must not accept size-proxy/);
    // A task whose tier is declared (or annotated by its source) does count.
    const { holdoutHard, difficultyBasisOf } = await import("../src/datasets.mjs");
    assert.equal(difficultyBasisOf({ tier: "hard" }), "declared");
    assert.equal(difficultyBasisOf({ tier: "hard", upstream: { tierRule: {} } }), "size-proxy");
    assert.equal(holdoutHard({ hard: true, difficultyBasis: "source" }, DEFAULT_PROTOCOL), true);
    assert.equal(holdoutHard({ hard: true, difficultyBasis: "size-proxy" }, DEFAULT_PROTOCOL), false);
    // A supply-built (legacy or relabelled) manifest cannot launder its size proxy with a self-declared basis.
    for (const basis of [undefined, "declared", "curator", "made-up"]) assert.equal(difficultyBasisOf({ tier: "hard", difficultyBasis: basis, upstream: { tierRule: {} } }), "size-proxy", String(basis));
    assert.equal(difficultyBasisOf({ tier: "hard", difficultyBasis: "source", upstream: { tierRule: {} } }), "size-proxy", "source without its annotation");
    assert.equal(difficultyBasisOf({ tier: "hard", difficultyBasis: "source", difficultySource: { dataset: "x", label: "hard", url: "https://example.org/x" }, upstream: { tierRule: {} } }), "source");
    assert.equal(difficultyBasisOf({ tier: "hard", difficultyBasis: "source", difficultySource: { dataset: "x", label: "hard" }, upstream: { tierRule: {} } }), "size-proxy", "an annotation without a locator is not substantive");
    assert.equal(holdoutHard({ hard: true, difficultyBasis: "made-up" }, DEFAULT_PROTOCOL), false, "unknown bases are not accepted");
    // Mixed: only the supported hard task counts.
    assert.equal([{ hard: true, difficultyBasis: "source" }, { hard: true, difficultyBasis: "size-proxy" }].filter(t => holdoutHard(t, DEFAULT_PROTOCOL)).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("engine: a holdout whose only hard tasks are size-proxy is blocked by the preflight before any run", async () => {
  const root = tempDir();
  try {
    const pool = join(root, "pool");
    const tmp = makeHoldout(join(root, "mk"), HOLDOUT);
    for (const [id, , tier] of HOLDOUT) {
      const f = join(tmp.dir, id, "task.json");
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), ...(tier === "hard" ? { difficultyBasis: "size-proxy" } : {}) }));
    }
    mkdirSync(join(pool, "batches"), { recursive: true });
    renameSync(tmp.dir, join(pool, "batches", "bp"));
    const { sealOf } = await import("../src/datasets.mjs");
    const seal = sealOf(join(pool, "batches", "bp"));
    writeFileSync(join(pool, "batches", "bp", "SEAL.json"), JSON.stringify(seal));
    registryOf(pool).append({ type: "batch", batch: "bp", tasks: HOLDOUT.map(h => h[0]), sealDigest: seal.digest });
    const c = counter();
    const before = readFileSync(join(pool, "registry.jsonl"), "utf8");
    const reserve = reserveBatch(pool, join(root, "state"), poolProtocol(pool), { orcheDir: fakeOrche(root) });
    assert.equal(readFileSync(join(pool, "registry.jsonl"), "utf8"), before, "no reservation recorded");
    assert.match(reserve.none.join(" "), /no hard stratum/, "not reservable either");
    // Forced as a fixed holdout path: the engine preflight refuses it.
    const { loop } = makeLoop({ root, entries: [ENTRY0], protocol: testProtocol({ datasets: { holdout: join(pool, "batches", "bp") } }), holdoutFromProtocol: true, backend: c.backend });
    const st = await loop.runCycle();
    assert.equal(st.phase, "blocked"); assert.match(st.blocked.preflight.reasons.join(" "), /no hard stratum.*size-proxy/); assert.equal(st.blocked.preflight.coverage.hardUnverified, 3);
    assert.equal(c.runs, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
