// Statistics and gates: paired clustered bootstrap, adaptive extension / INCONCLUSIVE, adoption fail-closed rules, Pareto archive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, pointEstimate } from "../src/stats.mjs";
import { adoptionDecision, criticalProblems, screeningDecision } from "../src/gate.mjs";
import { DEFAULT_PROTOCOL, merge, validateProtocol } from "../src/protocol.mjs";
import { paretoFront } from "../src/archive.mjs";
import { finalAttempts, makeRecord, missingUnits, outcomesOf } from "../src/metrics.mjs";

const P = structuredClone(DEFAULT_PROTOCOL);
const t = (task, a, b, extra = {}) => ({ task, family: extra.family ?? task, hard: !!extra.hard, a, b });

test("defaults: 10,000 draws, screening >= 3 repeats, supports .80/.95, overall loss <= 3 points, no cost objective", () => {
  assert.equal(P.bootstrap.draws, 10_000);
  assert.equal(P.screening.minRepeats, 3);
  assert.ok(P.screening.maxRepeats > P.screening.minRepeats, "adaptive extension possible");
  assert.equal(P.screening.support, 0.8);
  assert.equal(P.adoption.support, 0.95);
  assert.equal(P.gate.eps.overall, 0.03);
  assert.deepEqual(validateProtocol(P), []);
  assert.ok(validateProtocol(merge(structuredClone(P), { gate: { eps: { overall: 0.05 } } })).some(x => /3 percentage points/.test(x)));
  assert.ok(validateProtocol(merge(structuredClone(P), { screening: { minRepeats: 2 } })).some(x => />= 3/.test(x)));
  assert.ok(validateProtocol({ ...P, gate: { ...P.gate, cost: 1 } }).some(x => /never quality objectives/.test(x)));
  assert.equal(compare([t("x", [0, 1, 0], [1, 1, 0])], { seed: "d" }).draws, 10_000);
});

test("bootstrap is seeded and paired: identical constant arms never differ; matched observations are required", () => {
  const tasks = [t("a", [1, 1, 1], [1, 1, 1]), t("b", [0, 0, 0], [0, 0, 0])];
  const c = compare(tasks, { draws: 2000, seed: "s" });
  assert.equal(c.support, 0, "no improvement event without any difference");
  assert.equal(c.delta.overall.mean, 0);
  assert.equal(c.lossSupport, 0);
  const x = [t("a", [0, 1, 0], [1, 1, 0]), t("b", [1, 0, 0], [1, 1, 1])];
  assert.equal(compare(x, { draws: 3000, seed: "same" }).support, compare(x, { draws: 3000, seed: "same" }).support);
  assert.throws(() => compare([t("a", [1], [])], { draws: 10, seed: "s" }), /matched observations/);
  assert.throws(() => compare([], { draws: 10, seed: "s" }));
});

test("clustered uncertainty: resampling tasks (task level) is more cautious than the paper's fixed-task execution level", () => {
  // The candidate's gain comes from one task and it loses on another: on these fixed tasks the gain always wins, but whether it
  // generalizes depends on which tasks are drawn. Few repeats are not made into more evidence than they are.
  const tasks = [t("win", [0, 0, 0], [1, 1, 1]), t("lose", [1, 1, 1], [0, 0, 1]), t("c", [1, 1, 1], [1, 1, 1]), t("d", [0, 0, 0], [0, 0, 0])];
  const ex = compare(tasks, { draws: 4000, seed: "c", level: "execution" });
  const tk = compare(tasks, { draws: 4000, seed: "c", level: "task" });
  const fam = compare(tasks.map((x, i) => ({ ...x, family: i < 2 ? "f1" : "f2" })), { draws: 4000, seed: "c", level: "family" });
  assert.ok(ex.support > 0.99, `execution ${ex.support}`);
  assert.ok(tk.support < ex.support - 0.1, `task ${tk.support} vs execution ${ex.support}`);
  assert.ok(fam.support <= ex.support);
  assert.ok(tk.delta.overall.hi95 - tk.delta.overall.lo95 > ex.delta.overall.hi95 - ex.delta.overall.lo95, "wider task-level interval");
  assert.ok(Number.isFinite(pointEstimate(tasks, "b").overall));
});

test("quality-first promotion: a hard-task gain with a small overall loss can promote; a large overall loss cannot", () => {
  const hardGain = [t("h1", [0, 0, 0], [1, 1, 1], { hard: true }), t("e1", [1, 1, 1], [1, 1, 1]), t("e2", [1, 1, 1], [1, 1, 1]), t("e3", [1, 1, 1], [1, 1, 1])];
  const c = compare(hardGain, { draws: 3000, seed: "p", level: "execution", eps: P.gate.eps, minGain: P.gate.minGain });
  assert.ok(c.support > 0.8);
  const bigLoss = [t("h1", [0, 0, 0], [1, 1, 1], { hard: true }), t("e1", [1, 1, 1], [0, 0, 0]), t("e2", [1, 1, 1], [0, 0, 0])];
  const d = compare(bigLoss, { draws: 3000, seed: "p", level: "execution", eps: P.gate.eps, minGain: P.gate.minGain });
  assert.ok(d.support < 0.05, `overall loss beyond eps must not promote (${d.support})`);
});

test("screening near the threshold extends, then is INCONCLUSIVE (kept, never deployed); infra-tainted never promotes", () => {
  const s = { support: 0.8, band: 0.1, maxRepeats: 9 };
  const cmp = (support) => ({ support, level: "execution", draws: 10, mcse: 0.001, hardTasks: 1 });
  assert.equal(screeningDecision(cmp(0.75), s, { repeats: 3 }).decision, "EXTEND");
  assert.equal(screeningDecision(cmp(0.75), s, { repeats: 9 }).decision, "INCONCLUSIVE");
  assert.equal(screeningDecision(cmp(0.95), s, { repeats: 3 }).decision, "PROMOTE");
  assert.equal(screeningDecision(cmp(0.2), s, { repeats: 3 }).decision, "REJECT");
  assert.equal(screeningDecision(cmp(0.99), s, { repeats: 3, infraRate: 0.5 }).decision, "EXTEND");
  assert.equal(screeningDecision(cmp(0.99), s, { repeats: 9, infraRate: 0.5 }).decision, "INCONCLUSIVE");
  assert.equal(screeningDecision({ ...cmp(0.99), hardTasks: 0 }, s, { repeats: 3, hardRequired: true }).decision, "INCONCLUSIVE");
});

test("adoption gate is fail-closed: omission, dependence, failing checks, route doubt, small or hard-less holdouts never adopt", () => {
  const tasks = Array.from({ length: 8 }, (_, i) => t(`h${i}`, [0, 0, 0], [1, 1, 1], { hard: i % 2 === 0, family: `f${i}` }));
  const cmp = compare(tasks, { draws: 3000, seed: "a", level: "task", event: "adoption", eps: P.adoption.eps, minGain: P.adoption.minGain, lossThreshold: 0, familyLossThreshold: P.adoption.familyRegression });
  const ok = { holdoutIndependent: true, critical: [], checksPassed: true, routeOk: true, incomplete: [], infraRate: 0 };
  assert.equal(adoptionDecision(cmp, P, ok).verdict, "ADOPT");
  assert.equal(adoptionDecision(cmp, P, { ...ok, incomplete: ["u1"] }).verdict, "BLOCKED", "a missing unit (selective omission) blocks");
  assert.equal(adoptionDecision(cmp, P, { ...ok, holdoutIndependent: false, holdoutWhy: "implementer-authored" }).verdict, "BLOCKED");
  assert.equal(adoptionDecision(cmp, P, { ...ok, checksPassed: false }).verdict, "BLOCKED");
  assert.equal(adoptionDecision(cmp, P, { ...ok, routeOk: false }).verdict, "BLOCKED");
  assert.equal(adoptionDecision(cmp, P, { ...ok, critical: ["leak"] }).verdict, "BLOCKED");
  assert.equal(adoptionDecision(undefined, P, ok).verdict, "BLOCKED");
  assert.equal(adoptionDecision({ ...cmp, tasks: 3 }, P, ok).verdict, "INCONCLUSIVE");
  assert.equal(adoptionDecision({ ...cmp, hardTasks: 0 }, P, ok).verdict, "INCONCLUSIVE");
  assert.equal(adoptionDecision(cmp, P, { ...ok, infraRate: 0.5 }).verdict, "INCONCLUSIVE");
  const flat = compare(tasks.map(x => ({ ...x, b: x.a })), { draws: 3000, seed: "a", level: "task", event: "adoption", eps: P.adoption.eps, minGain: P.adoption.minGain, lossThreshold: 0 });
  assert.equal(adoptionDecision(flat, P, ok).verdict, "KEEP_STABLE", "no improvement is a normal result");
});

const rec = (over) => makeRecord({ run_id: "r", unit_key: over.unit_key ?? `${over.candidate_id ?? "c1"}|${over.task_id ?? "t"}|${over.repeat ?? 0}`, attempt: 1, candidate_id: "c1", harness_commit: "x", task_id: "t", split: "dev", repeat: 0, terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, model_route: "m", thinking_effort: "e", environment_digest: "d", protocol_digest: "p", ...over });

test("records: failures stay in the denominator, the last attempt is authoritative, omissions are detected, critical rules hold", () => {
  const records = [rec({ task_id: "t", repeat: 0 }), rec({ task_id: "t", repeat: 1, terminal_status: "timeout", hidden_test_pass: false }), rec({ task_id: "t", repeat: 2, terminal_status: "agent_error" })];
  assert.deepEqual(outcomesOf(records, "c1", "dev", ["t"]).t, [1, 0, 0], "a timeout or agent error is a failure, never dropped");
  const retried = [rec({ task_id: "t", unit_key: "k", attempt: 1, terminal_status: "infra_error" }), rec({ task_id: "t", unit_key: "k", attempt: 2, terminal_status: "completed" })];
  assert.equal(finalAttempts(retried).length, 1);
  assert.deepEqual(missingUnits(records, ["c1|t|0", "c1|t|9"]), ["c1|t|9"]);
  assert.throws(() => rec({ terminal_status: "made_up" }), /unknown terminal status/);
  const forged = rec({ terminal_status: "completed", hidden_test_pass: false });
  assert.equal(forged.task_success, false, "success needs the independent hidden grading, not a completed run");
  const leak = rec({ integrity: { violations: [], leakHits: ["read /opt/grader/task"] } });
  assert.ok(criticalProblems([leak], "c1").some(p => /leak/.test(p)));
  const v = (id, n) => rec({ candidate_id: id, task_id: `t${n}`, integrity: { violations: ["test weakened"] } });
  assert.equal(criticalProblems([v("c1", 1), v("stable", 1)], "c1", { reference: "stable" }).length, 0, "agent-level integrity failures in both arms are task failures");
  assert.equal(criticalProblems([v("c1", 1), v("c1", 2), v("stable", 1)], "c1", { reference: "stable" }).length, 1);
});

test("Pareto front keeps non-dominated quality points over overall, hard and consistency", () => {
  const front = paretoFront([{ id: "a", overall: 0.6, hard: 0.2, consistency: 0.5 }, { id: "b", overall: 0.5, hard: 0.4, consistency: 0.4 }, { id: "c", overall: 0.5, hard: 0.2, consistency: 0.4 }, { id: "d", overall: 0.6, hard: 0.2, consistency: 0.5 }]);
  assert.deepEqual(front.map(p => p.id).sort(), ["a", "b", "d"]);
});
