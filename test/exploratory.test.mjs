// exploratory-1 (2026-11-07): candidate c1's existing-tests guard, strict test immutability, the screen's acceptance, and the
// one exploration-only holdout pass (use recorded once, resumable, never ADOPT). Model-free (simulated backend).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rmSync, tempDir } from "./helpers.mjs";
import { strictTestIntegrity } from "../src/integrity.mjs";
import { transcriptFiles } from "../src/runner.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";
import { adoptionDecision } from "../src/gate.mjs";
import { holdoutLedger, sealOf } from "../src/datasets.mjs";
import { RequestBudget } from "../src/request-budget.mjs";
import { GUARD_MARKS, exploreProtocol, guardEvents, runHoldout, runScreen, screenVerdict } from "../studies/exploratory-1/explore.mjs";
import { candidateIdentity } from "../studies/exploratory-1/build-candidate.mjs";

const guard = await import("../studies/exploratory-1/c1/existing-tests.ts");

/** A fake Pi extension API that records handlers. */
function fakePi() {
  const handlers = {};
  return { handlers, on: (name, fn) => { (handlers[name] ??= []).push(fn); }, fire: async (name, event, ctx) => { let out; for (const fn of handlers[name] ?? []) out = await fn(event, ctx); return out; } };
}

test("c1 guard: refuses edit/write naming an existing test file, allows new test files, detects shell changes without rewriting the workspace, writes nothing", async () => {
  const root = tempDir();
  try {
    const ws = join(root, "ws"), agent = join(root, "agent");
    mkdirSync(join(ws, "test"), { recursive: true }); mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "test", "a.test.js"), "original\n"); writeFileSync(join(ws, "src", "a.js"), "x\n"); writeFileSync(join(ws, "test.js"), "runner default\n");
    assert.equal(guard.isExistingTestPath("test/a.test.js"), true); assert.equal(guard.isExistingTestPath("src/a.js"), false);
    assert.equal(guard.isExistingTestPath("src/b.spec.ts"), true); assert.equal(guard.isExistingTestPath("test.js"), true);
    const pi = fakePi();
    guard.installExistingTestsGuard(pi);
    const ctx = { cwd: ws };
    await pi.fire("session_start", {}, ctx);
    const blocked = await pi.fire("tool_call", { toolName: "edit", input: { path: "test/a.test.js", edits: [] } }, ctx);
    assert.equal(blocked.block, true); assert.match(blocked.reason, /read-only.*NEW test file/s);
    assert.equal((await pi.fire("tool_call", { toolName: "write", input: { path: "@test.js", content: "" } }, ctx)).block, true, "@-prefixed path");
    assert.equal(await pi.fire("tool_call", { toolName: "write", input: { path: "test/new.test.js", content: "" } }, ctx), undefined, "a new test file is allowed");
    assert.equal(await pi.fire("tool_call", { toolName: "edit", input: { path: "src/a.js", edits: [] } }, ctx), undefined, "production code is allowed");
    assert.equal(await pi.fire("tool_call", { toolName: "bash", input: { command: "sed -i s/o/x/ test/a.test.js" } }, ctx), undefined, "bash is never pre-judged");
    // A shell command changed the test: reported once, NOT undone (the evaluator sees what the model leaves).
    writeFileSync(join(ws, "test", "a.test.js"), "changed\n");
    const r = await pi.fire("tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] }, ctx);
    assert.match(r.content.at(-1).text, /changed existing test file\(s\) test\/a\.test\.js.*restore/s);
    assert.equal(readFileSync(join(ws, "test", "a.test.js"), "utf8"), "changed\n", "the harness never rewrites the workspace");
    assert.equal(await pi.fire("tool_result", { toolName: "read", content: [] }, ctx), undefined, "the same change is not reported twice");
    writeFileSync(join(ws, "test", "a.test.js"), "original\n");
    await pi.fire("tool_result", { toolName: "bash", content: [] }, ctx);
    assert.equal(existsSync(agent), false, "the guard writes nothing outside the workspace");
    assert.ok(blocked.reason.includes(GUARD_MARKS.refused) && r.content.at(-1).text.includes(GUARD_MARKS.changed), "explore.mjs counts the guard's own phrases");
    // Deletion counts as a change.
    rmSync(join(ws, "test.js"));
    assert.deepEqual(guard.changedTests(ws, guard.snapshotTests(join(root, "nothing"))), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("c1 guard regressions: path spellings and ast_rewrite paths are refused; rename, symlink swap, deletion and out-of-band (worker) changes are detected, never undone; files past the snapshot cap stay with the evaluator's strict check", async () => {
  const { renameSync, symlinkSync } = await import("node:fs");
  const root = tempDir();
  try {
    const ws = join(root, "ws");
    mkdirSync(join(ws, "test", "deep"), { recursive: true }); mkdirSync(join(ws, "src"), { recursive: true });
    for (const f of ["test/a.test.js", "test/b.test.js", "test/deep/c.js", "src/x.spec.ts"]) writeFileSync(join(ws, f), `${f}\n`);
    const pi = fakePi(); guard.installExistingTestsGuard(pi);
    const ctx = { cwd: ws };
    await pi.fire("session_start", {}, ctx);
    for (const input of [{ path: join(ws, "test", "a.test.js") }, { path: "./test/../test/a.test.js" }, { path: "test/deep/c.js" }, { file: "src/x.spec.ts" }]) assert.equal((await pi.fire("tool_call", { toolName: "write", input }, ctx))?.block, true, JSON.stringify(input));
    assert.equal((await pi.fire("tool_call", { toolName: "ast_rewrite", input: { pattern: "a", replacement: "b", paths: ["src", "test/b.test.js"] } }, ctx))?.block, true, "ast_rewrite naming a test file");
    assert.equal(await pi.fire("tool_call", { toolName: "write", input: { path: "../outside.test.js" } }, ctx), undefined, "outside the workspace is not the guard's business");
    // Out-of-band changes (shell, worker, a directory-wide rewrite): detected at the next tool result, never undone.
    renameSync(join(ws, "test", "a.test.js"), join(ws, "test", "moved.test.js"));
    rmSync(join(ws, "test", "b.test.js")); writeFileSync(join(root, "other.js"), "other\n"); symlinkSync(join(root, "other.js"), join(ws, "test", "b.test.js"));
    writeFileSync(join(ws, "test", "deep", "c.js"), "by a worker\n");
    const r = await pi.fire("tool_result", { toolName: "task", content: [] }, ctx);
    for (const f of ["test/a.test.js", "test/b.test.js", "test/deep/c.js"]) assert.ok(r.content.at(-1).text.includes(f), f);
    assert.equal(existsSync(join(ws, "test", "a.test.js")), false, "a rename is not undone");
    assert.equal(readFileSync(join(ws, "test", "deep", "c.js"), "utf8"), "by a worker\n");
    // Snapshot cap: the guard is advice only; the evaluator's strict immutability sees every existing test file regardless.
    const big = "x".repeat(3 * 1024 * 1024);
    writeFileSync(join(ws, "test", "big.test.js"), big);
    assert.equal(guard.snapshotTests(ws).has("test/big.test.js"), false, "past the cap the guard does not watch");
    assert.match(strictTestIntegrity(new Map([["test/big.test.js", big]]), new Map([["test/big.test.js", `${big}y`]])).violations.join(" "), /big\.test\.js was modified/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("strict test immutability: append-only or reformatting edits and deletions of existing test files are violations; new test files are not", () => {
  const initial = new Map([["test/a.test.js", "a\n"], ["test.js", "b\n"], ["src/x.js", "c\n"]]);
  assert.deepEqual(strictTestIntegrity(initial, new Map([["test/a.test.js", "a\n"], ["test.js", "b\n"], ["src/x.js", "z\n"], ["test/new.test.js", "n\n"]])).violations, []);
  const v = strictTestIntegrity(initial, new Map([["test/a.test.js", "a\nmore\n"], ["src/x.js", "c\n"]])).violations;
  assert.equal(v.length, 2); assert.match(v.join(" "), /test\/a\.test\.js was modified/); assert.match(v.join(" "), /test\.js was deleted/);
});

test("guard evidence is counted from captured main-session tool results only", () => {
  const root = tempDir();
  try {
    const d = join(root, "transcripts", "try0", "sessions", "x");
    mkdirSync(d, { recursive: true });
    const line = (role, text) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
    writeFileSync(join(d, "s.jsonl"), [line("toolResult", `Existing test file t.js ${GUARD_MARKS.refused}.`), line("toolResult", `${GUARD_MARKS.changed} a (existing test)`), line("assistant", `${GUARD_MARKS.changed} existing test quoted by the model`)].join("\n"));
    assert.deepEqual(guardEvents(root), { refused: 1, changed: 1, transcripts: 1 });
    assert.deepEqual(guardEvents(join(root, "none")), { refused: 0, changed: 0, transcripts: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("transcript capture lists orche records only when asked", () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, "sessions"), { recursive: true }); writeFileSync(join(root, "sessions", "s.jsonl"), "{}\n");
    mkdirSync(join(root, "agent", "orche", "records", "guard"), { recursive: true }); writeFileSync(join(root, "agent", "orche", "records", "guard", "existing-tests.jsonl"), "{}\n");
    assert.deepEqual(transcriptFiles(root, false), ["sessions/s.jsonl"]);
    assert.deepEqual(transcriptFiles(root, true).sort(), ["agent/orche/records/guard", "agent/orche/records/guard/existing-tests.jsonl", "sessions/s.jsonl"].filter(f => /\.(jsonl|json)$/.test(f)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exploratory protocol: original gates kept, hard only by an annotated source, strict tests + capture on, and the gate never adopts", () => {
  const p = exploreProtocol();
  assert.equal(p.holdout.minTasks, 6); assert.equal(p.holdout.minFamilies, 4); assert.equal(p.holdout.maxUses, 1); assert.equal(p.adoption.requireHardStratum, true);
  assert.deepEqual(p.holdout.hardBasis, ["source"]); assert.equal(p.holdout.priorFamilyReuse, "forbid"); assert.equal(p.holdout.maxOwnerShare, 0.5);
  assert.equal(p.integrity.strictTestFiles, true); assert.equal(p.capture.transcripts, true); assert.equal(p.analysisPlan.mode, "exploratory");
  const cmp = { tasks: 8, families: 5, hardTasks: 1, support: 0.999, level: "task", delta: { overall: { mean: 0.3, lo95: 0.1, hi95: 0.5 } }, familyDelta: {} };
  const d = adoptionDecision(cmp, p, { holdoutIndependent: true, critical: [], checksPassed: true, routeOk: true, incomplete: [], infraRate: 0, familyCmp: { support: 0.999, families: 5 } });
  assert.equal(d.adopt, false); assert.equal(d.verdict, "EXPLORATORY_SUPPORTED");
});

/** Simulated backend whose records carry the strict field like real runs (optionally a violation for one task). */
function backendWith({ violate = () => false, p = () => 0.6 } = {}) {
  const sim = simulatedBackend({ skill: (h, t, info) => ({ p: p(h, t, info), violation: violate(h, t, info) }) });
  return { simulated: true, async run(args) { const r = await sim.run(args); r.integrity.strictTestViolations = r.integrity.violations.length ? ["existing test file test/a.test.js was modified (strict test immutability)"] : []; r.integrity.legacyViolations = []; return r; } };
}

function dataset(root, name, specs, { purpose } = {}) {
  const dir = join(root, name);
  for (const [id, family, tier, extra = {}] of specs) {
    mkdirSync(join(dir, id, "repo"), { recursive: true });
    writeFileSync(join(dir, id, "repo", "index.js"), `export const id = "${id}";\n`);
    writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, family, tier, instruction: `Solve ${id}`, provenance: "external", ...extra }));
  }
  if (purpose) writeFileSync(join(dir, "PROVENANCE.json"), JSON.stringify({ purpose }));
  writeFileSync(join(dir, "SEAL.json"), JSON.stringify(sealOf(dir)));
  return dir;
}

function candidateDir(root) { const d = join(root, "c1"); mkdirSync(join(d, "src"), { recursive: true }); writeFileSync(join(d, "src", "x.ts"), "export {};\n"); writeFileSync(join(d, "package.json"), "{}"); return d; }

test("screen: accepted only with zero violations over every planned unit; a violation in any attempt refuses", async () => {
  const root = tempDir();
  try {
    const dev = dataset(root, "dev", [["d1", "gh:a/x", "easy"], ["d2", "gh:b/y", "medium"]]);
    const cdir = candidateDir(root);
    const plan = { tasks: [{ id: "d1", dataset: dev }, { id: "d2", dataset: dev }], repeats: 2, candidate: { dir: cdir, identity: candidateIdentity(cdir) } };
    const budget = new RequestBudget({ path: join(root, "b.jsonl"), limit: 4500, scope: "t" });
    const ok = await runScreen({ plan, state: join(root, "s1"), backend: backendWith(), budget });
    assert.equal(ok.accepted, true, ok.problems.join("; ")); assert.equal(ok.measured, 4); assert.equal(ok.totals.strictViolations, 0);
    const bad = await runScreen({ plan, state: join(root, "s2"), backend: backendWith({ violate: (h, t, i) => t.id === "d2" && i.repeat === 1 }), budget });
    assert.equal(bad.accepted, false); assert.match(bad.problems.join(" "), /integrity violations in 1 attempt/);
    assert.equal(screenVerdict([], { tasks: plan.tasks, repeats: 2, simulated: true }).accepted, false, "nothing measured is not a pass");
    await assert.rejects(runScreen({ plan: { ...plan, repeats: 3 }, state: join(root, "s1"), backend: backendWith(), budget }), /another plan/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("holdout pass: blocked (unconsumed) without an accepted screen, too little budget or an ineligible batch; otherwise the use is recorded once, a resume never records a second, and the verdict is never ADOPT", async () => {
  const root = tempDir();
  try {
    const dev = dataset(root, "dev", [["d1", "gh:dev/x", "easy"]]);
    const src = { dataset: "Exercism JS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
    const batch = dataset(root, "batch", [["h1", "gh:o1/a", "hard", { difficultyBasis: "source", difficultySource: src }], ["h2", "gh:o2/b", "easy"], ["h3", "gh:o3/c", "medium"], ["h4", "gh:o4/d", "easy"], ["h5", "gh:o5/e", "medium"], ["h6", "gh:o6/f", "easy"]], { purpose: "holdout" });
    const cdir = candidateDir(root);
    const screenState = join(root, "screen");
    const budget = new RequestBudget({ path: join(root, "b.jsonl"), limit: 4500, scope: "t" });
    const screenPlan = { tasks: [{ id: "d1", dataset: dev }], repeats: 1, candidate: { dir: cdir, identity: candidateIdentity(cdir) } };
    await runScreen({ plan: screenPlan, state: screenState, backend: backendWith(), budget });
    const reportSha = (await import("node:crypto")).createHash("sha256").update(readFileSync(join(screenState, "screen-report.json"))).digest("hex");
    const orche = join(root, "orche"); mkdirSync(orche);
    const plan = (over = {}) => ({ seed: "t", stable: { dir: cdir }, candidate: screenPlan.candidate, screen: { report: join(screenState, "screen-report.json"), reportSha256: reportSha, runs: join(screenState, "runs.jsonl"), tasks: screenPlan.tasks }, holdout: { batch, seal: sealOf(batch).digest, minRemaining: 100, ...over } });
    const checks = async () => ({ pass: true, problems: [] });
    const common = { backend: backendWith({ p: (h) => (h.id === "c1" ? 0.9 : 0.4) }), budget, checks, orcheDir: orche, priorFamilies: new Set(["gh:dev/x"]) };
    // Budget below the frozen minimum: nothing consumed.
    const poor = await runHoldout({ ...common, plan: plan({ minRemaining: 99_999 }), state: join(root, "h-poor") });
    assert.equal(poor.verdict, "BLOCKED"); assert.match(poor.reasons[0], /not consumed/); assert.equal(holdoutLedger(batch).records().length, 0);
    // A forbidden family: nothing consumed.
    const fam = await runHoldout({ ...common, priorFamilies: new Set(["gh:o3/c"]), plan: plan(), state: join(root, "h-fam") });
    assert.equal(fam.verdict, "BLOCKED"); assert.match(fam.reasons[0], /families of earlier holdouts reused/); assert.equal(holdoutLedger(batch).records().length, 0);
    // The real pass.
    const state = join(root, "h");
    const out = await runHoldout({ ...common, plan: plan(), state });
    assert.equal(out.adopt, false); assert.notEqual(out.verdict, "ADOPT"); assert.equal(out.holdoutEvaluated, true);
    assert.equal(out.arms.stable.units, 18); assert.equal(out.arms.c1.units, 18); assert.equal(out.evidence.class, "exploratory");
    assert.equal(holdoutLedger(batch).records().length, 1);
    // Resume: the final decision is returned, no second use.
    const again = await runHoldout({ ...common, plan: plan(), state });
    assert.equal(again.verdict, out.verdict); assert.equal(holdoutLedger(batch).records().length, 1);
    // Another state: the batch is used up.
    const other = await runHoldout({ ...common, plan: plan(), state: join(root, "h2") });
    assert.equal(other.verdict, "BLOCKED"); assert.match(other.reasons[0], /already used 1 time/); assert.equal(holdoutLedger(batch).records().length, 1);
    // A changed screen report: refused before use.
    writeFileSync(join(screenState, "screen-report.json"), "{\"accepted\":true}");
    const forged = await runHoldout({ ...common, plan: plan(), state: join(root, "h3") });
    assert.match(forged.reasons[0], /no accepted integrity screen/);
    assert.ok(existsSync(join(state, "holdout-schedule.json")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("holdout pass: a crash after the use is recorded resumes with the same use and schedule", async () => {
  const root = tempDir();
  try {
    const dev = dataset(root, "dev", [["d1", "gh:dev/x", "easy"]]);
    const src = { dataset: "Exercism JS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
    const batch = dataset(root, "batch", [["h1", "gh:o1/a", "hard", { difficultyBasis: "source", difficultySource: src }], ["h2", "gh:o2/b", "easy"], ["h3", "gh:o3/c", "medium"], ["h4", "gh:o4/d", "easy"], ["h5", "gh:o5/e", "medium"], ["h6", "gh:o6/f", "easy"]], { purpose: "holdout" });
    const cdir = candidateDir(root);
    const budget = new RequestBudget({ path: join(root, "b.jsonl"), limit: 4500, scope: "t" });
    const screenPlan = { tasks: [{ id: "d1", dataset: dev }], repeats: 1, candidate: { dir: cdir, identity: candidateIdentity(cdir) } };
    await runScreen({ plan: screenPlan, state: join(root, "screen"), backend: backendWith(), budget });
    const reportSha = (await import("node:crypto")).createHash("sha256").update(readFileSync(join(root, "screen", "screen-report.json"))).digest("hex");
    const orche = join(root, "orche"); mkdirSync(orche);
    const plan = { seed: "t", stable: { dir: cdir }, candidate: screenPlan.candidate, screen: { report: join(root, "screen", "screen-report.json"), reportSha256: reportSha, tasks: screenPlan.tasks }, holdout: { batch, seal: sealOf(batch).digest, minRemaining: 100 } };
    let calls = 0;
    const crashing = backendWith();
    const flaky = { simulated: true, async run(a) { if (++calls === 7) throw new Error("simulated crash"); return crashing.run(a); } };
    const common = { plan, state: join(root, "h"), budget, checks: async () => ({ pass: true }), orcheDir: orche, priorFamilies: new Set() };
    await runHoldout({ ...common, backend: flaky }).catch(() => {});
    assert.equal(holdoutLedger(batch).records().length, 1, "used before the first run");
    const out = await runHoldout({ ...common, backend: backendWith() });
    assert.equal(out.holdoutEvaluated, true); assert.equal(out.adopt, false);
    assert.equal(holdoutLedger(batch).records().length, 1, "one use after resume");
    assert.equal(out.arms.stable.units + out.arms.c1.units, 36);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("holdout pass: grader failure, failed checks or a changed candidate tree block BEFORE consumption; resume across the reservation/use boundary keeps one reservation and one use; a pool that would hand out another batch is never reserved", async () => {
  const { caseDigest, registryOf, sealBatch, poolState, reserveBatch } = await import("../src/supply.mjs");
  const root = tempDir();
  try {
    const dev = dataset(root, "dev", [["d1", "gh:dev/x", "easy"]]);
    const cdir = candidateDir(root);
    const budget = new RequestBudget({ path: join(root, "b.jsonl"), limit: 4500, scope: "t" });
    const screenPlan = { tasks: [{ id: "d1", dataset: dev }], repeats: 1, candidate: { dir: cdir, identity: candidateIdentity(cdir) } };
    await runScreen({ plan: screenPlan, state: join(root, "screen"), backend: backendWith(), budget });
    const reportSha = (await import("node:crypto")).createHash("sha256").update(readFileSync(join(root, "screen", "screen-report.json"))).digest("hex");
    const orche = join(root, "orche"); mkdirSync(orche);
    // A supply pool with two sealed holdout batches of fresh families.
    const pool = join(root, "pool");
    const src = { dataset: "Exercism TS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
    const add = (id, family, extra = {}) => {
      const d = join(pool, "cases", id); mkdirSync(join(d, "repo"), { recursive: true });
      writeFileSync(join(d, "task.json"), JSON.stringify({ id, family, tier: extra.difficultyBasis ? "hard" : "easy", instruction: `Solve ${id}`, provenance: "external", ...extra }));
      writeFileSync(join(d, "repo", "index.js"), `export const id = "${id}";\n`);
      registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family, tier: extra.difficultyBasis ? "hard" : "easy", difficultyBasis: extra.difficultyBasis ?? "declared", contentDigest: caseDigest(d) });
    };
    const cfg = { batch: { seed: "s", maxTasks: 6, maxPerFamily: 1, maxPerOwner: 6, maxOwnerShare: 0.5 } };
    const minima = { minTasks: 6, minFamilies: 4, requireHard: true, hardBasis: ["source"] };
    add("a1", "gh:p1/a", { difficultyBasis: "source", difficultySource: src }); for (let i = 2; i <= 6; i++) add(`a${i}`, `gh:p${i}/a`);
    const first = sealBatch({ pool, cfg, minima });
    add("b1", "gh:q1/a", { difficultyBasis: "source", difficultySource: src }); for (let i = 2; i <= 6; i++) add(`b${i}`, `gh:q${i}/a`);
    const second = sealBatch({ pool, cfg, minima, now: new Date(Date.now() + 1000) });
    assert.ok(first.batch && second.batch, JSON.stringify({ first, second }));
    const plan = (dir, seal, over = {}) => ({ seed: "t", stable: { dir: cdir }, candidate: screenPlan.candidate, screen: { report: join(root, "screen", "screen-report.json"), reportSha256: reportSha, tasks: screenPlan.tasks }, holdout: { batch: dir, seal, minRemaining: 100, pool, ...over } });
    const ok = async () => ({ pass: true, problems: [] });
    const common = { budget, orcheDir: orche, priorFamilies: new Set(), backend: backendWith(), poolDir: pool };
    const reserves = () => poolState(pool).records.filter(r => r.type === "reserve").length;
    // The second batch while the first would be handed out: never reserved, never used.
    const wrong = await runHoldout({ ...common, checks: ok, plan: plan(second.dir, second.seal), state: join(root, "h-wrong") });
    assert.equal(wrong.verdict, "BLOCKED"); assert.match(wrong.reasons[0], /would not hand out the frozen batch/); assert.equal(reserves(), 0); assert.equal(holdoutLedger(second.dir).records().length, 0);
    // Grader failure, failed checks, a changed candidate tree: blocked before consumption.
    const g = await runHoldout({ ...common, checks: ok, validate: async (t) => ({ ok: t.id !== "a3" }), plan: plan(first.dir, first.seal), state: join(root, "h-grader") });
    assert.match(g.reasons[0], /grader validation failed \(not consumed/);
    const c = await runHoldout({ ...common, checks: async () => ({ pass: false, problems: ["typecheck"] }), plan: plan(first.dir, first.seal), state: join(root, "h-checks") });
    assert.match(c.reasons[0], /checks failed \(not consumed/);
    const t = await runHoldout({ ...common, checks: ok, plan: { ...plan(first.dir, first.seal), candidate: { ...screenPlan.candidate, identity: { ...screenPlan.candidate.identity, runtimeDigest: "0".repeat(64) } } }, state: join(root, "h-tree") });
    assert.match(t.reasons[0], /candidate tree differs/);
    const sb = await runHoldout({ ...common, checks: ok, plan: { ...plan(first.dir, first.seal), stable: { dir: cdir, runtimeDigest: "0".repeat(64) } }, state: join(root, "h-stable") });
    assert.match(sb.reasons[0], /stable tree differs.*not consumed/);
    assert.equal(holdoutLedger(first.dir).records().length, 0, "nothing consumed by any blocked attempt");
    assert.equal(reserves(), 0, "nothing reserved by any blocked attempt");
    // Preflight: every model-free prerequisite passes, nothing reserved or consumed.
    const pf = await runHoldout({ ...common, checks: ok, plan: plan(first.dir, first.seal), state: join(root, "h-preflight"), preflightOnly: true });
    assert.equal(pf.preflight, "passed", JSON.stringify(pf)); assert.equal(reserves(), 0); assert.equal(holdoutLedger(first.dir).records().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("holdout pass: a crash between the pool reservation and the use record resumes with the same reservation and exactly one use", async () => {
  const { caseDigest, registryOf, sealBatch, poolState, reserveBatch } = await import("../src/supply.mjs");
  const root = tempDir();
  try {
    const dev = dataset(root, "dev", [["d1", "gh:dev/x", "easy"]]);
    const cdir = candidateDir(root);
    const budget = new RequestBudget({ path: join(root, "b.jsonl"), limit: 4500, scope: "t" });
    const screenPlan = { tasks: [{ id: "d1", dataset: dev }], repeats: 1, candidate: { dir: cdir, identity: candidateIdentity(cdir) } };
    await runScreen({ plan: screenPlan, state: join(root, "screen"), backend: backendWith(), budget });
    const reportSha = (await import("node:crypto")).createHash("sha256").update(readFileSync(join(root, "screen", "screen-report.json"))).digest("hex");
    const orche = join(root, "orche"); mkdirSync(orche);
    const pool = join(root, "pool");
    const src = { dataset: "Exercism TS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
    const add = (id, family, extra = {}) => {
      const d = join(pool, "cases", id); mkdirSync(join(d, "repo"), { recursive: true });
      writeFileSync(join(d, "task.json"), JSON.stringify({ id, family, tier: extra.difficultyBasis ? "hard" : "easy", instruction: `Solve ${id}`, provenance: "external", ...extra }));
      writeFileSync(join(d, "repo", "index.js"), `export const id = "${id}";\n`);
      registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family, tier: extra.difficultyBasis ? "hard" : "easy", difficultyBasis: extra.difficultyBasis ?? "declared", contentDigest: caseDigest(d) });
    };
    add("a1", "gh:p1/a", { difficultyBasis: "source", difficultySource: src }); for (let i = 2; i <= 6; i++) add(`a${i}`, `gh:p${i}/a`);
    const b = sealBatch({ pool, cfg: { batch: { seed: "s", maxTasks: 6, maxPerFamily: 1, maxPerOwner: 6, maxOwnerShare: 0.5 } }, minima: { minTasks: 6, minFamilies: 4, requireHard: true, hardBasis: ["source"] } });
    const state = join(root, "h");
    // The crash: the reservation was appended, the process died before the use record.
    const r0 = reserveBatch(pool, state, exploreProtocol(), { orcheDir: orche });
    assert.equal(r0.batch, b.batch);
    const plan = { seed: "t", stable: { dir: cdir }, candidate: screenPlan.candidate, screen: { report: join(root, "screen", "screen-report.json"), reportSha256: reportSha, tasks: screenPlan.tasks }, holdout: { batch: b.dir, seal: b.seal, minRemaining: 100, pool } };
    const out = await runHoldout({ plan, state, budget, checks: async () => ({ pass: true, problems: [] }), orcheDir: orche, priorFamilies: new Set(), backend: backendWith(), poolDir: pool });
    assert.equal(out.holdoutEvaluated, true, JSON.stringify(out.reasons)); assert.equal(out.adopt, false);
    assert.equal(poolState(pool).records.filter(r => r.type === "reserve").length, 1, "one reservation");
    assert.equal(holdoutLedger(b.dir).records().length, 1, "one use");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("holdout pass: an environment digest given as environmentDigest()'s {digest, facts} object still pairs both arms after the ledger round trip and counts as one environment", async () => {
  const root = tempDir();
  try {
    const dev = dataset(root, "dev", [["d1", "gh:dev/x", "easy"]]);
    const src = { dataset: "Exercism JS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
    const batch = dataset(root, "batch", [["h1", "gh:o1/a", "hard", { difficultyBasis: "source", difficultySource: src }], ["h2", "gh:o2/b", "easy"], ["h3", "gh:o3/c", "medium"], ["h4", "gh:o4/d", "easy"], ["h5", "gh:o5/e", "medium"], ["h6", "gh:o6/f", "easy"]], { purpose: "holdout" });
    const cdir = candidateDir(root);
    const budget = new RequestBudget({ path: join(root, "b.jsonl"), limit: 4500, scope: "t" });
    const screenPlan = { tasks: [{ id: "d1", dataset: dev }], repeats: 1, candidate: { dir: cdir, identity: candidateIdentity(cdir) } };
    const envDigest = { digest: "env-1", facts: { node: "v24" } };
    await runScreen({ plan: screenPlan, state: join(root, "screen"), backend: backendWith(), budget, envDigest });
    const reportSha = (await import("node:crypto")).createHash("sha256").update(readFileSync(join(root, "screen", "screen-report.json"))).digest("hex");
    const orche = join(root, "orche"); mkdirSync(orche);
    const plan = { seed: "t", stable: { dir: cdir }, candidate: screenPlan.candidate, screen: { report: join(root, "screen", "screen-report.json"), reportSha256: reportSha, tasks: screenPlan.tasks }, holdout: { batch, seal: sealOf(batch).digest, minRemaining: 100 } };
    const out = await runHoldout({ plan, state: join(root, "h"), budget, envDigest, checks: async () => ({ pass: true, problems: [] }), orcheDir: orche, priorFamilies: new Set(), backend: backendWith({ p: (h) => (h.id === "c1" ? 0.9 : 0.4) }) });
    assert.equal(out.holdoutEvaluated, true); assert.equal(out.adopt, false);
    assert.equal(out.holdout.tasks, 6, JSON.stringify(out.reasons));
    assert.ok(!out.reasons.some(r => /route|environment/i.test(r)), out.reasons.join("; "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
