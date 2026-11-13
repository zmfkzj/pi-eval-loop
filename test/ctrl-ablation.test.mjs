// ctrl-ablation-1 infrastructure: frozen randomized queue, variant identity and fidelity of the patches, strict test immutability,
// transcript discovery, resumable campaign execution under the preregistered safety limits, and the analysis statistics.
// Simulated runs here are plumbing checks, never measurements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";
import { strictTestIntegrity, leakScan } from "../src/integrity.mjs";
import { transcriptFiles } from "../src/runner.mjs";
import { successOf } from "../src/metrics.mjs";
import { UMBRELLA } from "../src/protocol.mjs";
import { armSummary, buildQueue, contrast, harnessIdentity, holm, inconsistency, loadPrereg, EXPERIMENT_DIR, viable, buildHarness, harnessOf } from "../experiments/ctrl-ablation/lib.mjs";
import { lockState, runCampaign, prepare } from "../experiments/ctrl-ablation/run.mjs";

const prereg = loadPrereg();
const ORCHE = join(UMBRELLA, "orche");

test("queue: every (task, repeat) block holds each arm exactly once, order is seeded and interleaved", () => {
  const arms = prereg.arms.map(a => a.id);
  const q = buildQueue({ arms, tasks: prereg.tasks.ids, repeats: prereg.repeats, seed: prereg.seed });
  assert.equal(q.length, 810);
  for (let i = 0; i < q.length; i += arms.length) {
    const block = q.slice(i, i + arms.length);
    assert.deepEqual(block.map(u => u.arm).sort(), [...arms].sort());
    assert.equal(new Set(block.map(u => `${u.task}#${u.repeat}`)).size, 1);
  }
  assert.deepEqual(buildQueue({ arms, tasks: prereg.tasks.ids, repeats: 3, seed: prereg.seed }), q, "deterministic");
  const firstArms = new Set(); for (let i = 0; i < q.length; i += arms.length) firstArms.add(q[i].arm);
  assert.ok(firstArms.size >= 5, "arm order differs between blocks");
  const firstBlocks = q.filter((_, i) => i % arms.length === 0).slice(0, 10).map(u => u.task);
  assert.notDeepEqual(firstBlocks, [...firstBlocks].sort(), "block order is shuffled");
});

test("prereg: 10 arms, 27 exposed suite tasks, the preregistered ceilings", () => {
  assert.deepEqual(prereg.arms.map(a => a.id), ["S", "B0", "P1", "P2", "P3", "D1", "D2", "T1", "V1", "V2"]);
  assert.equal(prereg.tasks.ids.length, 27);
  assert.deepEqual(prereg.unit, { wallMs: 1200000, maxRequests: 150, graderMs: 120000 });
  assert.equal(prereg.integrity.strictTestFiles, true);
  assert.equal(prereg.capture.transcripts, true);
});

test("variants: identity binds the exact bytes; P1 and P3 carry the same rule text", () => {
  const ids = Object.fromEntries(prereg.arms.map(a => [a.id, harnessIdentity(a, prereg)]));
  assert.equal(new Set(Object.values(ids)).size, 10, "every arm has its own identity");
  assert.match(ids.S, /^e831a6b2bc19f0c707b55505db33a11b2c9d4d4a:single$/);
  assert.match(ids.D1, /:direct$/);
  assert.match(ids.P3, /^pure\+[0-9a-f]{16}$/);
  const p1 = readFileSync(join(EXPERIMENT_DIR, "variants/P1.diff"), "utf8");
  const literal = p1.split("\n").find(l => l.startsWith("+const TEST_INTEGRITY_RULE = "));
  assert.equal(JSON.parse(literal.slice("+const TEST_INTEGRITY_RULE = ".length, -1)), prereg.testIntegrityRule);
  assert.equal(prereg.arms.find(a => a.id === "P3").appendSystemPrompt, "testIntegrityRule");
});

test("variants: each patch applies to the base commit and touches only its declared files", () => {
  const touched = { P1: ["src/pi/session-factory.ts"], P2: ["src/extension/mode.ts", "src/extension/workers.ts"], D2: ["src/extension/mode.ts"], T1: ["src/pi/session-factory.ts", "src/tools/index.ts"], V1: ["src/extension/workers.ts"], V2: ["src/orchestrator/instructions.ts"] };
  for (const [id, files] of Object.entries(touched)) {
    const patch = readFileSync(join(EXPERIMENT_DIR, `variants/${id}.diff`), "utf8");
    assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map(m => m[1]).sort(), files.sort(), id);
  }
  // Built INSIDE a git checkout (as the real state directories are): a patch must still apply to the export, verified by its hunks.
  const dir = join(EXPERIMENT_DIR, "..", "..", "state", `ctrl-harness-test-${process.pid}`);
  try {
    for (const arm of prereg.arms.filter(a => a.patch)) {
      const built = buildHarness(arm, prereg, { stateDir: dir, orcheDir: ORCHE });
      assert.ok(existsSync(join(built.dir, "src/extension/index.ts")));
      assert.equal(harnessOf(arm, prereg, built).dir, built.dir);
    }
    assert.match(readFileSync(join(dir, "harness/P2/src/extension/mode.ts"), "utf8"), /implement completely, add tests, run relevant/);
    assert.doesNotMatch(readFileSync(join(dir, "harness/P2/src/extension/workers.ts"), "utf8"), /adding or updating tests/);
    assert.match(readFileSync(join(dir, "harness/T1/src/tools/index.ts"), "utf8"), /WORKER_TOOL_NAMES: readonly string\[\] = \[\n {2}"read",\n {2}"bash",\n {2}"edit",\n {2}"write",\n\];/);
    assert.match(readFileSync(join(dir, "harness/D2/src/extension/mode.ts"), "utf8"), /R1: Complete the original request below exactly as written\./);
    assert.doesNotMatch(readFileSync(join(dir, "harness/V1/src/extension/workers.ts"), "utf8"), /every met item needs verifiedBy/);
    assert.match(readFileSync(join(dir, "harness/V2/src/orchestrator/instructions.ts"), "utf8"), /Independent verification \(always, for implement assignments\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("strict test immutability: append-only, reformat and deletion of an original test file are violations; new test files are not", () => {
  const initial = new Map([["test/smoke.test.mjs", "import test from 'node:test';test('a',()=>{});"], ["test-x.js", "t\n"], ["src/a.mjs", "export const a = 1;\n"]]);
  assert.deepEqual(strictTestIntegrity(initial, new Map([...initial, ["test/new.test.mjs", "x"], ["src/a.mjs", "export const a = 2;\n"]])).violations, []);
  assert.equal(strictTestIntegrity(initial, new Map([...initial, ["test/smoke.test.mjs", `${initial.get("test/smoke.test.mjs")}\ntest('b',()=>{});`]])).violations.length, 1, "append-only");
  assert.equal(strictTestIntegrity(initial, new Map([...initial, ["test-x.js", "t \n"]])).violations.length, 1, "node runner name, whitespace");
  const del = new Map(initial); del.delete("test/smoke.test.mjs");
  const r = strictTestIntegrity(initial, del);
  assert.match(r.violations[0], /deleted/);
  assert.equal(r.hashes["test/smoke.test.mjs"].final, null);
  assert.equal(r.hashes["src/a.mjs"], undefined);
});

test("transcripts: main sessions always, orche sub-session records with capture; leak scan sees worker tool calls", () => {
  const box = tempDir("ctrl-box-");
  try {
    mkdirSync(join(box, "sessions/x"), { recursive: true });
    mkdirSync(join(box, "agent/orche/records/s1/workers"), { recursive: true });
    writeFileSync(join(box, "sessions/x/main.jsonl"), "{}\n");
    const call = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat /tmp/grade/hidden/a.test.mjs" } }] } };
    writeFileSync(join(box, "agent/orche/records/s1/workers/W1-t.jsonl"), `${JSON.stringify(call)}\n`);
    writeFileSync(join(box, "agent/orche/records/s1/run.json"), "{}");
    assert.deepEqual(transcriptFiles(box, false), ["sessions/x/main.jsonl"]);
    const all = transcriptFiles(box, true).sort();
    assert.deepEqual(all, ["agent/orche/records/s1/run.json", "agent/orche/records/s1/workers/W1-t.jsonl", "sessions/x/main.jsonl"]);
    const text = all.filter(f => f.endsWith(".jsonl")).map(f => readFileSync(join(box, f), "utf8")).join("\n");
    assert.equal(leakScan(text).length, 1, "a worker reaching for grading material is a leak");
  } finally { rmSync(box, { recursive: true, force: true }); }
});

function fakePrepared(stateDir, { arms = ["S", "B0", "P1"], tasks = ["t1", "t2"], repeats = 2 } = {}) {
  const tasksById = Object.fromEntries(tasks.map(id => [id, { id, family: `f-${id}`, hard: false, repo: stateDir }]));
  const harness = Object.fromEntries(arms.map(id => [id, { id, kind: id === "B0" ? "pure" : "orche", commit: `c-${id}` }]));
  const queue = buildQueue({ arms, tasks, repeats, seed: "t" });
  return { tasksById, harness, grading: {}, queue, lock: { smoke: false, preregDigest: "p", envDigest: "e", queueDigest: "q" } };
}

test("campaign: runs the frozen queue once, resumes without re-running, records every unit", async () => {
  const dir = tempDir("ctrl-run-");
  try {
    const prepared = fakePrepared(dir);
    const backend = simulatedBackend({ skill: (h) => ({ p: h.id === "S" ? 0.5 : 0.8 }) });
    const first = await runCampaign({ stateDir: dir, prereg: { ...prereg, parallelism: 3 }, prepared, backend, log: () => {} });
    assert.equal(first.ran, 12); assert.equal(first.remaining, 0); assert.equal(first.paused, null);
    const again = await runCampaign({ stateDir: dir, prereg, prepared, backend, log: () => {} });
    assert.equal(again.ran, 0);
    const results = readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(e => e.type === "result");
    assert.equal(results.length, 12);
    assert.equal(new Set(results.map(e => e.unit_key)).size, 12);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("campaign: pauses on consecutive infrastructure failures and on the aggregate request ceiling (never decides)", async () => {
  const dir = tempDir("ctrl-infra-");
  try {
    const prepared = fakePrepared(dir, { tasks: ["t1", "t2", "t3", "t4"] });
    const infra = simulatedBackend({ skill: () => ({ p: 0.5, infra: true }) });
    // infra on attempt 1 only: the evaluator's one infra retry recovers every unit, so consecutive failures never reach 5.
    const ok = await runCampaign({ stateDir: dir, prereg: { ...prereg, parallelism: 1 }, prepared, backend: infra, log: () => {} });
    assert.equal(ok.paused, null);
    const dir2 = tempDir("ctrl-ceiling-");
    const capped = await runCampaign({ stateDir: dir2, prereg: { ...prereg, parallelism: 1, budget: { ...prereg.budget, maxRequestsTotal: 20 } }, prepared: fakePrepared(dir2, { tasks: ["t1", "t2", "t3", "t4"] }), backend: simulatedBackend({ skill: () => ({ p: 1 }) }), log: () => {} });
    assert.match(capped.paused, /aggregate request ceiling/);
    assert.equal(capped.ran, 4, "5 requests per simulated unit: dispatch stops once 20 are recorded");
    rmSync(dir2, { recursive: true, force: true });
    const dir3 = tempDir("ctrl-down-");
    const down = { simulated: true, async run() { throw new Error("provider down"); } };
    const stopped = await runCampaign({ stateDir: dir3, prereg: { ...prereg, parallelism: 1 }, prepared: fakePrepared(dir3, { tasks: ["t1", "t2", "t3", "t4"] }), backend: down, log: () => {} });
    assert.match(stopped.paused, /5 consecutive infrastructure failures/);
    assert.equal(stopped.ran, 5);
    rmSync(dir3, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: a fresh state is locked once; any changed digest is refused", () => {
  const dir = tempDir("ctrl-lock-");
  try {
    const lock = { preregDigest: "a", envDigest: "e", queueDigest: "q", files: { f: "1" }, harness: { S: { tree: "t" } }, tasks: { t1: "d" }, grading: {} };
    lockState(dir, lock, [{ arm: "S", task: "t1", repeat: 0 }]);
    assert.doesNotThrow(() => lockState(dir, lock, []));
    assert.throws(() => lockState(dir, { ...lock, files: { f: "2" } }, []), /files\.f changed/);
    assert.throws(() => lockState(dir, { ...lock, harness: { S: { tree: "x" } } }, []), /harness\.S changed/);
    assert.throws(() => lockState(dir, { ...lock, preregDigest: "b" }, []), /preregDigest changed/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")), [{ arm: "S", task: "t1", repeat: 0 }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prepare: real suite tasks, built variants and a stubbed grader produce a complete lock", async () => {
  const dir = tempDir("ctrl-prep-");
  try {
    const p = await prepare({ stateDir: dir, prereg, env: {}, envDigest: "env", validate: async () => ({ ok: true, problems: [], expected: { hiddenTests: 1 }, baselineFailing: [] }) });
    assert.equal(Object.keys(p.tasksById).length, 27);
    assert.equal(p.queue.length, 810);
    assert.equal(Object.keys(p.lock.harness).length, 10);
    assert.ok(Object.keys(p.lock.files).some(f => f.endsWith("experiments/ctrl-ablation/variants/P1.diff")));
    assert.ok(Object.keys(p.lock.files).some(f => f.endsWith("src/runner.mjs")));
    assert.equal(p.harness.P3.appendSystemPrompt, prereg.testIntegrityRule);
    assert.equal(p.harness.D1.mode, "direct");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("statistics: inconsistency, arm summary, paired contrast, Holm and the single viability rule", () => {
  assert.equal(inconsistency(3, 3), 0); assert.equal(inconsistency(0, 3), 0); assert.ok(Math.abs(inconsistency(1, 3) - 1 / 3) < 1e-12);
  const a = { t1: [1, 1, 1], t2: [1, 1, 1], t3: [1, 1, 1], t4: [0, 0, 0] }, b = { t1: [1, 0, 1], t2: [0, 0, 1], t3: [1, 1, 1], t4: [0, 0, 0] };
  const s = armSummary(b);
  assert.deepEqual([s.successes, s.units, s.all, s.mixed, s.none], [6, 12, 1, 2, 1]);
  const c = contrast(a, b, { draws: 2000, perms: 2000 });
  assert.ok(Math.abs(c.dRate - (1 / 3 + 2 / 3) / 4) < 1e-12);
  assert.ok(c.dI < 0); assert.equal(c.better, 2); assert.equal(c.worse, 0);
  assert.ok(c.dRateCI[0] <= c.dRate && c.dRate <= c.dRateCI[1]);
  assert.deepEqual(holm({ x: 0.01, y: 0.04, z: 0.03 }), { x: 0.03, z: 0.06, y: 0.06 });
  const good = { dRate: 0.05, dRateCI: [0.01, 0.09], dI: -0.01 };
  assert.equal(viable(good, { candidate: 1, stable: 2, criticalOther: 0 }), true);
  assert.equal(viable({ ...good, dRateCI: [-0.01, 0.09] }, { candidate: 1, stable: 2, criticalOther: 0 }), false);
  assert.equal(viable({ ...good, dI: 0.01 }, { candidate: 1, stable: 2, criticalOther: 0 }), false);
  assert.equal(viable(good, { candidate: 3, stable: 2, criticalOther: 0 }), false);
  assert.equal(viable(good, { candidate: 0, stable: 2, criticalOther: 1 }), false);
  assert.equal(successOf({ terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, integrity: { violations: ["existing test file x was modified (strict test immutability)"] }, critical_failure_count: 1 }), false);
});

test("analysis: full pipeline on simulated records; fidelity flags a missing intervention", async () => {
  const { analyze, markdown } = await import("../experiments/ctrl-ablation/analyze.mjs");
  const { unitFidelity } = await import("../experiments/ctrl-ablation/fidelity.mjs");
  const recs = [];
  for (const arm of prereg.arms.map(a => a.id)) for (const t of ["t1", "t2", "t3"]) for (let r = 0; r < 3; r++) {
    const ok = arm === "P1" || (t !== "t3" && r !== 2);
    recs.push({ candidate_id: arm, task_id: t, family: `f-${t}`, repeat: r, terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, integrity: { violations: ok ? [] : ["x"], leakHits: [] }, critical_failure_count: ok ? 0 : 1, model_requests: 5 });
  }
  const a = analyze(recs, prereg, { draws: 500, perms: 500 });
  assert.equal(a.summary.P1.valid.successes, 9);
  assert.equal(a.summary.S.integrityFailures, 5);
  assert.ok(a.contrasts["P1-S"].valid.dRate > 0);
  assert.equal(a.contrasts["P1-S"].functional.dRate, 0, "integrity, not function, separates them");
  assert.match(markdown(a, prereg), /Locked candidate/);
  const p1 = prereg.arms.find(x => x.id === "P1");
  const main = { kind: "main", system: "", tools: new Set(), userTexts: [], toolCalls: [{ name: "orche_task", arguments: { request: "R1: x" } }] };
  const worker = { kind: "worker", system: "no rule", tools: new Set(["read"]), userTexts: ["verifiedBy"], toolCalls: [] };
  assert.equal(unitFidelity(p1, [main, worker]).ok, false);
  assert.equal(unitFidelity(p1, [main, { ...worker, system: "Test integrity (overrides conflicting test-update or cleanup instructions):" }]).ok, true);
});

test("confirmation power: simulation calibrates on task pairs, a null effect has ~alpha power and a large one has high power", async () => {
  const { power, priorStrength } = await import("../experiments/ctrl-ablation-plan/power.mjs");
  assert.ok(priorStrength([3, 3, 0, 0, 3, 0], 3) <= 3, "strong between-task spread -> weak prior");
  const nullPairs = Array.from({ length: 20 }, (_, i) => ({ family: `f${i % 5}`, pS: 0.5, pX: 0.5 }));
  assert.ok(power({ pairs: nullPairs }, { tasks: 60, repeats: 3, sims: 400 }).validOnly < 0.1);
  const big = nullPairs.map(p => ({ ...p, pS: 0.4, pX: 1 }));
  const res = power({ pairs: big }, { tasks: 60, repeats: 3, sims: 400 });
  assert.ok(res.validOnly > 0.9 && res.coPrimary > 0.9, JSON.stringify(res));
});

test("post-hoc sensitivity: legacy and strict scorings come from the retained per-unit decisions; strict-valid equals the primary", async () => {
  const { sensitivity, legacyValid, strictValid } = await import("../experiments/ctrl-ablation-plan/sensitivity.mjs");
  const base = { terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, family: "f", candidate_id: "S", task_id: "t1", repeat: 0 };
  const clean = { ...base, integrity: { violations: [], legacyViolations: [], strictTestViolations: [], leakHits: [] }, critical_failure_count: 0 };
  const strictOnly = { ...base, repeat: 1, integrity: { violations: ["s"], legacyViolations: [], strictTestViolations: ["s"], leakHits: [] }, critical_failure_count: 1 };
  const both = { ...base, repeat: 2, integrity: { violations: ["l", "s"], legacyViolations: ["l"], strictTestViolations: ["s"], leakHits: [] }, critical_failure_count: 2 };
  const leak = { ...base, task_id: "t2", integrity: { violations: [], legacyViolations: [], strictTestViolations: [], leakHits: ["h"] }, critical_failure_count: 1 };
  const funcFail = { ...base, task_id: "t2", repeat: 1, hidden_test_pass: false, integrity: clean.integrity, critical_failure_count: 0 };
  assert.deepEqual([clean, strictOnly, both, leak, funcFail].map(legacyValid), [true, true, false, false, false]);
  assert.deepEqual([clean, strictOnly, both, leak, funcFail].map(strictValid), [true, false, false, false, false]);
  for (const r of [clean, strictOnly, both, leak, funcFail]) assert.equal(strictValid(r), successOf(r), "strict-valid is the preregistered primary");
  const s = sensitivity([clean, strictOnly, both, leak, funcFail], { ...prereg, arms: [{ id: "S" }] }, { draws: 10, perms: 10 });
  const r = s.rows.S;
  assert.deepEqual([r.legacyFail, r.strictFail, r.strictOnly, r.both, r.leaks, r.legacyValid, r.strictValid, r.functional], [2, 2, 1, 1, 1, 2, 1, 4]);
  assert.deepEqual([r.legacy.all, r.strict.all, r.strict.none], [0, 0, 1]);
  assert.equal(s.posthoc, true);
  assert.deepEqual(s.primaryMismatches, []);
  assert.equal(r.detectorFail, 1);
  assert.equal(r.functionalFailAmongStrictOnly, 0);
  // critical failure without a violation (e.g. a harness crash count) is not valid under the primary contract.
  assert.equal(strictValid({ ...clean, critical_failure_count: 1 }), false);
  // missing retained decisions and an incomplete design are refused, never scored as clean.
  const { assertComplete } = await import("../experiments/ctrl-ablation-plan/sensitivity.mjs");
  assert.throws(() => sensitivity([{ ...clean, integrity: { violations: [] } }], { ...prereg, arms: [{ id: "S" }] }), /lack retained integrity decisions/);
  assert.throws(() => assertComplete([clean, strictOnly], { arms: ["S"], tasks: ["t1"], repeats: 3 }), /expected 3 records, found 2/);
  assert.throws(() => assertComplete([clean, strictOnly, { ...leak, task_id: "t1" }, funcFail], { arms: ["S"], tasks: ["t1", "t2"], repeats: 2 }), /S\/t1: 3 records/);
});
