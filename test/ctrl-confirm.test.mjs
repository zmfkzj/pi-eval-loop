// ctrl-confirm-2: endpoints (legacy primary vs strict secondary), complete-design scoring and the reliable-success endpoint,
// family-clustered inference and decision rules, arm/variant identity, contract disclosure, holdout once-only use, the campaign's
// split/unsettled/ceiling accounting and resume, fidelity, holdout selection and the conflict screen, sample-size planning.
// Simulated runs here are plumbing checks, never measurements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";
import { buildQueue } from "../experiments/ctrl-ablation/lib.mjs";
import { EXPERIMENT_DIR, adoption, armSummary, designTable, familyContrast, legacyValid, loadPrereg, primaryDecision, reliableOf, strictValid } from "../experiments/ctrl-confirm-2/lib.mjs";
import { harnessIdentity, instructionOf, lockState, recordHoldoutUse, runCampaign, unsettled } from "../experiments/ctrl-confirm-2/run.mjs";

const prereg = loadPrereg();
const base = { terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, family: "f", candidate_id: "OC", task_id: "t1", repeat: 0 };
const integ = (o = {}) => ({ violations: [], legacyViolations: [], strictTestViolations: [], leakHits: [], ...o });

test("endpoints: a strict-only violation fails only the strict secondary; legacy violations, leaks and crashes fail the primary", () => {
  const clean = { ...base, integrity: integ() };
  const strictOnly = { ...base, integrity: integ({ violations: ["s"], strictTestViolations: ["s"] }), critical_failure_count: 1 };
  const legacy = { ...base, integrity: integ({ violations: ["l"], legacyViolations: ["l"] }) };
  const leak = { ...base, integrity: integ({ leakHits: ["h"] }) };
  const crash = { ...base, terminal_status: "harness_crash", integrity: integ() };
  const infra = { ...base, terminal_status: "infra_error", hidden_test_pass: false }; // no integrity data: a failure, not an error
  assert.deepEqual([clean, strictOnly, legacy, leak, crash, infra].map(legacyValid), [true, true, false, false, false, false]);
  assert.deepEqual([clean, strictOnly, legacy, leak, crash, infra].map(strictValid), [true, false, false, false, false, false]);
  assert.throws(() => legacyValid({ ...base, integrity: { violations: [] } }), /lacks retained/);
});

test("design table: missing units are failures and listed; duplicates and out-of-design records are refused; reliable = all r", () => {
  const recs = [0, 1, 2].map(i => ({ ...base, repeat: i, integrity: integ() }));
  const d = designTable(recs, legacyValid, { arms: ["OC"], tasks: ["t1"], repeats: 3 });
  assert.deepEqual(d.table.OC.t1, [1, 1, 1]); assert.deepEqual(d.missing, []);
  const short = designTable(recs.slice(0, 2), legacyValid, { arms: ["OC"], tasks: ["t1"], repeats: 3 });
  assert.deepEqual(short.table.OC.t1, [1, 1, 0]); assert.deepEqual(short.missing, ["OC|t1|2"]);
  assert.equal(reliableOf(short.table.OC.t1), 0, "a missing repeat is never a reliable success");
  assert.throws(() => designTable([...recs, recs[0]], legacyValid, { arms: ["OC"], tasks: ["t1"], repeats: 3 }), /duplicate/);
  assert.throws(() => designTable([{ ...recs[0], repeat: 3 }], legacyValid, { arms: ["OC"], tasks: ["t1"], repeats: 3 }), /outside the design/);
  const s = armSummary({ a: [1, 1, 1], b: [1, 0, 1], c: [0, 0, 0] });
  assert.deepEqual([s.reliableTasks, s.mixedTasks, s.noneTasks, s.successes], [1, 1, 1, 5]);
  assert.ok(Math.abs(s.reliable - 1 / 3) < 1e-12);
});

test("family-clustered contrast and decisions: both endpoints required; no invented margins; family regression -> user review", () => {
  const fam = {}; const A = {}, B = {};
  for (let i = 0; i < 30; i++) { const t = `t${i}`; fam[t] = `f${Math.floor(i / 2)}`; A[t] = [1, 1, 1]; B[t] = i % 2 ? [1, 0, 1] : [1, 1, 1]; }
  const c = familyContrast(A, B, fam, { draws: 2000, perms: 2000 });
  assert.equal(c.families, 15); assert.ok(c.rate.estimate > 0 && c.reliable.estimate > 0);
  assert.ok(c.rate.ci95[0] > 0 && c.reliable.ci95[0] > 0 && c.rate.pOneSided < 0.025);
  assert.equal(primaryDecision(c, { complete: true }).verdict, "CONFIRMED");
  assert.equal(primaryDecision(c, { complete: false }).verdict, "INCONCLUSIVE");
  const onlyRate = { rate: c.rate, reliable: { ...c.reliable, ci95: [-0.01, 0.2], pOneSided: 0.2 } };
  assert.equal(primaryDecision(onlyRate, { complete: true }).verdict, "INCONCLUSIVE", "valid rate alone never confirms");
  const nul = familyContrast(B, B, fam, { draws: 500, perms: 500 });
  assert.equal(nul.rate.estimate, 0); assert.equal(primaryDecision(nul, { complete: true }).verdict, "INCONCLUSIVE");
  const harm = familyContrast(B, A, fam, { draws: 2000, perms: 2000 });
  assert.equal(primaryDecision(harm, { complete: true }).verdict, "NOT_CONFIRMED_HARM_INDICATED");
  const ok = { verdict: "CONFIRMED" }, arm = { leaks: 0, critical: 0, legacyFail: 1, strictFail: 1 };
  assert.equal(adoption({ decision: ok, candidate: arm, control: arm, familyRegressions: [], functionalDelta: 0 }).verdict, "ADOPTION_CANDIDATE");
  assert.equal(adoption({ decision: ok, candidate: arm, control: arm, familyRegressions: ["gh:x/y"], functionalDelta: 0 }).verdict, "USER_REVIEW");
  assert.equal(adoption({ decision: ok, candidate: arm, control: arm, familyRegressions: [], functionalDelta: -0.01 }).verdict, "USER_REVIEW");
  assert.equal(adoption({ decision: ok, candidate: { ...arm, leaks: 1 }, control: arm, familyRegressions: [], functionalDelta: 0 }).verdict, "KEEP_STABLE");
  assert.equal(adoption({ decision: { verdict: "INCONCLUSIVE" }, candidate: arm, control: arm, familyRegressions: [], functionalDelta: 0 }).verdict, "KEEP_STABLE");
});

test("prereg: 4 arms (2x2 harness x rule), every arm gets the same contract; OCR = P1 bytes, PCR = P3 rule; legacy primary", () => {
  assert.deepEqual(prereg.arms.map(a => a.id), ["OC", "OCR", "PC", "PCR"]);
  assert.equal(prereg.integrity.primary, "legacy");
  assert.equal(readFileSync(join(EXPERIMENT_DIR, "variants/OCR.diff"), "utf8"), readFileSync(join(EXPERIMENT_DIR, "../ctrl-ablation/variants/P1.diff"), "utf8"));
  assert.equal(prereg.testIntegrityRule, loadPrereg(join(EXPERIMENT_DIR, "../ctrl-ablation/prereg.json")).testIntegrityRule);
  const ids = Object.fromEntries(prereg.arms.map(a => [a.id, harnessIdentity(a, prereg)]));
  assert.equal(new Set(Object.values(ids)).size, 4);
  assert.match(ids.OC, /^e831a6b2bc19f0c707b55505db33a11b2c9d4d4a:single$/); assert.match(ids.PCR, /^pure\+[0-9a-f]{16}$/); assert.equal(ids.PC, "pure");
  const task = { instruction: "Do X.\n" };
  const ins = instructionOf(task, prereg);
  assert.ok(ins.startsWith("Do X.\n\nEvaluation integrity contract")); assert.ok(ins.endsWith(prereg.integrityContract));
  const q = buildQueue({ arms: prereg.arms.map(a => a.id), tasks: ["a", "b", "c"], repeats: 3, seed: prereg.seed });
  for (let i = 0; i < q.length; i += 4) { assert.deepEqual(q.slice(i, i + 4).map(u => u.arm).sort(), ["OC", "OCR", "PC", "PCR"]); assert.equal(new Set(q.slice(i, i + 4).map(u => `${u.task}${u.repeat}`)).size, 1); }
});

test("holdout use: recorded once before any unit, idempotent for the same state, refused for any other state", () => {
  const dir = tempDir("cc2-use-");
  try {
    const a = recordHoldoutUse(dir, { stateDir: join(dir, "s1"), experiment: "x", preregDigest: "p", seal: "s" });
    assert.equal(a.reused, false);
    assert.equal(recordHoldoutUse(dir, { stateDir: join(dir, "s1"), experiment: "x", preregDigest: "p", seal: "s" }).reused, true);
    assert.throws(() => recordHoldoutUse(dir, { stateDir: join(dir, "s2"), experiment: "x", preregDigest: "p", seal: "s" }), /already used/);
    assert.throws(() => recordHoldoutUse(dir, { stateDir: join(dir, "s1"), experiment: "x", preregDigest: "other", seal: "s" }), /already used/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fakePrepared(dir, { tasks = ["t1", "t2"], repeats = 2 } = {}) {
  const arms = prereg.arms.map(a => a.id);
  return {
    tasksById: Object.fromEntries(tasks.map(id => [id, { id, family: `f-${id}`, hard: false, repo: dir, instruction: "x" }])),
    harness: Object.fromEntries(arms.map(id => [id, { id, kind: id.startsWith("O") ? "orche" : "pure", commit: `c-${id}` }])),
    grading: {}, queue: buildQueue({ arms, tasks, repeats, seed: "t" }), lock: { smoke: false, preregDigest: "p", envDigest: "e", queueDigest: "q" },
  };
}

test("campaign: confirmation split, exact unsettled counts (incl. retry-pending infra units), checkpoint, resume without re-running", async () => {
  const dir = tempDir("cc2-run-");
  try {
    const prepared = fakePrepared(dir);
    const infraOnce = simulatedBackend({ skill: (h) => ({ p: 0.7, infra: h.id === "PC" }) });
    const first = await runCampaign({ stateDir: dir, prereg: { ...prereg, parallelism: 3 }, prepared, backend: infraOnce, log: () => {}, maxUnits: 5 });
    assert.equal(first.ran, 5); assert.equal(first.paused, "max-units"); assert.equal(first.unsettled, 16 - first.done);
    const campaign = JSON.parse(readFileSync(join(dir, "campaign.json"), "utf8"));
    assert.equal(campaign.split, "confirmation"); assert.equal(campaign.total, 16); assert.ok(campaign.startedAt && campaign.updatedAt);
    assert.equal(JSON.stringify(campaign).includes("PASS"), false);
    const rest = await runCampaign({ stateDir: dir, prereg: { ...prereg, parallelism: 3 }, prepared, backend: infraOnce, log: () => {} });
    assert.equal(rest.unsettled, 0); assert.equal(rest.done, 16);
    const results = readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(e => e.type === "result");
    assert.ok(results.every(e => e.record.split === "confirmation"));
    assert.equal(results.filter(e => e.record.terminal_status === "infra_error").length, 4, "each PC unit's first attempt was infra and was retried once");
    const again = await runCampaign({ stateDir: dir, prereg, prepared, backend: infraOnce, log: () => {} });
    assert.equal(again.ran, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("campaign: the request ceiling reserves the per-unit maximum of every unit in flight", async () => {
  const dir = tempDir("cc2-cap-");
  try {
    const p = { ...prereg, parallelism: 1, unit: { ...prereg.unit, maxRequests: 10 }, budget: { ...prereg.budget, maxRequestsTotal: 30 } };
    const s = await runCampaign({ stateDir: dir, prereg: p, prepared: fakePrepared(dir), backend: simulatedBackend({ skill: () => ({ p: 1 }) }), log: () => {} });
    // 5 requests per simulated unit: a unit is dispatched only while recorded + (inFlight+1)*10 <= 30, i.e. up to 20 recorded:
    // the 5th unit starts at 20 recorded, then 25 + 10 > 30 stops dispatch; the worst case could never exceed 30.
    assert.equal(s.ran, 5); assert.ok(s.requests <= 30); assert.match(s.paused, /in-flight reserve/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lock: changed instructions or holdout seal are refused", () => {
  const dir = tempDir("cc2-lock-");
  try {
    const lock = { preregDigest: "a", envDigest: "e", queueDigest: "q", files: {}, harness: {}, tasks: { t: "d" }, grading: {}, instructions: { t: "i" }, holdoutSeal: "s" };
    lockState(dir, lock, []);
    assert.doesNotThrow(() => lockState(dir, lock, []));
    assert.throws(() => lockState(dir, { ...lock, instructions: { t: "j" } }, []), /instructions\.t changed/);
    assert.throws(() => lockState(dir, { ...lock, holdoutSeal: "x" }, []), /holdoutSeal changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fidelity: contract in every task message; rule only where intended; contract reaching the worker is reported", async () => {
  const { unitFidelity, RULE_HEAD, CONTRACT_HEAD } = await import("../experiments/ctrl-confirm-2/fidelity.mjs");
  const arm = (id) => prereg.arms.find(a => a.id === id);
  const main = (sys = "") => ({ kind: "main", system: sys, tools: new Set(), userTexts: [`task\n\n${CONTRACT_HEAD}) ...`], toolCalls: [{ name: "orche_task", arguments: { request: "R1" } }] });
  const worker = (sys = "", text = "R1: x") => ({ kind: "worker", system: sys, tools: new Set(), userTexts: [text], toolCalls: [] });
  assert.equal(unitFidelity(arm("OC"), [main(), worker()]).ok, true);
  assert.equal(unitFidelity(arm("OC"), [main(), worker(RULE_HEAD)]).ok, false, "rule leaked into the control");
  assert.equal(unitFidelity(arm("OCR"), [main(), worker(RULE_HEAD)]).ok, true);
  assert.equal(unitFidelity(arm("OCR"), [main(), worker()]).ok, false);
  assert.equal(unitFidelity(arm("PCR"), [{ ...main(RULE_HEAD), toolCalls: [] }]).ok, true);
  assert.equal(unitFidelity(arm("PC"), [{ ...main(), userTexts: ["task only"], toolCalls: [] }]).ok, false, "contract missing");
  assert.equal(unitFidelity(arm("OC"), [main(), worker("", `x ${CONTRACT_HEAD}`)]).reported.contractReachedWorker, true);
});

test("holdout selection: candidate-blind seeded order with family/owner caps; conflict screen flags test-change instructions", async () => {
  const { select, TEST_CHANGE_FLAG } = await import("../experiments/ctrl-confirm-2/assemble.mjs");
  const list = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, family: `gh:o${i % 2}/r${i % 4}`, owner: `o${i % 2}` }));
  const p = select(list, { seed: "s", maxPerFamily: 3, maxPerOwner: 5, maxTasks: 100 });
  assert.equal(p.length, 10);
  for (const f of new Set(p.map(c => c.family))) assert.ok(p.filter(c => c.family === f).length <= 3);
  assert.deepEqual(select([...list].reverse(), { seed: "s", maxPerFamily: 3, maxPerOwner: 5, maxTasks: 100 }).map(c => c.id), p.map(c => c.id), "input order is irrelevant");
  assert.equal(TEST_CHANGE_FLAG.test("fix: handle empty input\n\nAlso update the tests for the new behaviour."), true);
  assert.equal(TEST_CHANGE_FLAG.test("Add support for negative numbers"), false);
});

test("planning: two-endpoint family-clustered power is ~0 under no effect and high under a large effect", async () => {
  const { power } = await import("../experiments/ctrl-confirm-2/power.mjs");
  const pairs = Array.from({ length: 20 }, () => ({ pC: 0.5, pX: 0.5 }));
  assert.ok(power({ pairs }, { tasks: 60, sims: 300 }).coPrimary < 0.05);
  const big = pairs.map(() => ({ pC: 0.3, pX: 1 }));
  const r = power({ pairs: big }, { tasks: 60, sims: 300 });
  assert.ok(r.coPrimary > 0.9 && r.reliable > 0.9, JSON.stringify(r));
});
