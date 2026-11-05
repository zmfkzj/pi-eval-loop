// protocol-3 efficiency: work that cannot change a decision is not dispatched, and recorded outcomes are reused only for an
// identical evaluation identity. Every test runs on the simulated backend (no model): the call counts are controlled-test counts
// of evaluation units, not measurements of real tokens or real savings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { edit, makeLoop, passingChecks, rmSync, skillOf, tempDir, testProtocol } from "./helpers.mjs";
import { simulatedBackend, Evaluator } from "../src/evaluator.mjs";
import { analyze } from "../src/analysis.mjs";
import { criticalProblems } from "../src/gate.mjs";
import { makeRecord, unitKey } from "../src/metrics.mjs";
import { createRng } from "../src/rng.mjs";
import { DEFAULT_PROTOCOL, merge, validateProtocol } from "../src/protocol.mjs";

const STABLE = new Set(["stable", "stable-default-mode"]);
/** Task-agent integrity violations (agents editing existing tests), as in explore-real-2: stable sometimes, candidates more often. */
const violates = (h, t, info, q) => createRng(`violation:${h.id}:${t.id}:${info.split}:${info.repeat}`).next() < q;
const integritySkill = (qStable, qCandidate) => (h, t, info = {}) => {
  const base = skillOf(h);
  if (h.kind === "pure" || h.kind === "multi") return base;
  return { ...base, violation: violates(h, t, info, STABLE.has(h.id) ? qStable : qCandidate) };
};
const NEUTRAL = ["tighten the completion checklist of workers", "ask workers to restate acceptance criteria", "shorten the handoff summary between roles", "retry a failed tool call once with a narrower command", "require a final self-review of the diff", "split long instructions into numbered steps"]
  .map((hypothesis, i) => ({ hypothesis, targetFailureClass: "requirements-generalization", edit: edit(`same ${i}`) }));

/** Simulated backend counting evaluation units by phase (one simulated run = one unit; tokens are fixed fakes). */
function counting(skill) {
  const sim = simulatedBackend({ skill, seed: "test" });
  const calls = { baseline: 0, screenCandidate: 0, screenParent: 0, develop: 0, holdout: 0, other: 0 };
  const kind = (ctx) => ctx.startsWith("baseline:") ? "baseline" : /^screen:.*:candidate$/.test(ctx) ? "screenCandidate" : /^screen:.*:parent$/.test(ctx) ? "screenParent" : ctx.startsWith("develop:") ? "develop" : ctx.startsWith("holdout:") ? "holdout" : "other";
  return { calls, backend: { simulated: true, run: async (input) => { calls[kind(input.context ?? "")]++; return sim.run(input); } } };
}
const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);
const statuses = (loop) => Object.fromEntries(loop.archive.all().filter(c => c.origin === "proposer").map(c => [c.id, c.status]));

async function runScenario(root, fx, { stopOnCritical, entries, skill, stateName }) {
  const { calls, backend } = counting(skill);
  const protocol = testProtocol({ datasets: { holdout: null }, efficiency: { stopOnCritical }, watchdog: { noProgressCandidates: entries.length, maxCandidatesPerCycle: entries.length } });
  const { loop } = makeLoop({ root, entries, backend, protocol, skill, fixtures: fx, stateName });
  const state = await loop.runCycle();
  return { loop, state, calls };
}

test("explore-real-2 replay (faux): every candidate rejected for task-agent integrity; same decisions, far fewer candidate units", async (t) => {
  const root = tempDir();
  try {
    const first = makeLoop({ root, entries: [] });
    const fx = first.fx;
    const skill = integritySkill(0.1, 0.3);
    const full = await runScenario(root, fx, { stopOnCritical: false, entries: NEUTRAL, skill, stateName: "full" });
    const early = await runScenario(root, fx, { stopOnCritical: true, entries: NEUTRAL, skill, stateName: "early" });
    // Decisions: identical, and (as in explore-real-2) every candidate is a critical integrity rejection.
    assert.deepEqual(statuses(early.loop), statuses(full.loop));
    for (const c of early.loop.archive.all().filter(c => c.origin === "proposer")) {
      assert.equal(c.status, "rejected", c.id);
      assert.match(c.decisions.at(-1).reason, /^critical: integrity: /);
    }
    assert.equal(early.state.selection.selected, null); assert.equal(full.state.selection.selected, null);
    assert.equal(early.state.final.verdict, "BLOCKED");
    // Baselines are identical; the candidate screening units drop; the parent (stable) units are reused baselines in both modes.
    assert.equal(early.calls.baseline, full.calls.baseline);
    assert.ok(early.calls.screenCandidate < full.calls.screenCandidate, JSON.stringify({ early: early.calls, full: full.calls }));
    const rounds = early.loop.archive.all().filter(c => c.origin === "proposer").map(c => c.screening.rounds.at(-1).stoppedEarly);
    assert.ok(rounds.every(Boolean), "every early rejection records how many units ran");
    t.diagnostic(`evaluation units (simulated): full ${total(full.calls)} ${JSON.stringify(full.calls)}; early ${total(early.calls)} ${JSON.stringify(early.calls)}; candidate screening units ${full.calls.screenCandidate} -> ${early.calls.screenCandidate}`);
    // Failure-driven targeting: after the first critical rejections the integrity class is targeted (gate-blocking first).
    const targets = early.loop.archive.all().filter(c => c.origin === "proposer").map(c => c.target);
    assert.ok(targets.slice(2).every(x => x === "integrity"), targets.join(","));
    // The proposer evidence names why candidates were rejected, without task ids, splits, repeats or holdout material.
    const evidence = readFileSync(join(early.loop.stateDir, "candidates", "c003", "evidence", "rejections.json"), "utf8");
    const rejections = JSON.parse(evidence);
    assert.ok(rejections.length >= 2 && rejections.every(r => r.classes.includes("integrity")));
    assert.doesNotMatch(evidence, /\b(t\d+|h\d+)\b|train\/|dev\/|holdout|#\d/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a valid candidate keeps the same full coverage, development point and selection with early stopping enabled", async () => {
  const root = tempDir();
  try {
    const fx = makeLoop({ root, entries: [] }).fx;
    const GOOD = [{ hypothesis: "re-read requirements before finishing", targetFailureClass: "requirements-generalization", edit: edit("good") }];
    const full = await runScenario(root, fx, { stopOnCritical: false, entries: GOOD, skill: skillOf, stateName: "full" });
    const early = await runScenario(root, fx, { stopOnCritical: true, entries: GOOD, skill: skillOf, stateName: "early" });
    assert.deepEqual(statuses(early.loop), statuses(full.loop));
    assert.equal(early.state.selection.selected, "c001");
    assert.deepEqual(early.loop.archive.get("c001").development.point, full.loop.archive.get("c001").development.point);
    assert.deepEqual(early.loop.archive.get("c001").screening.support, full.loop.archive.get("c001").screening.support);
    assert.deepEqual(early.calls, full.calls, "nothing critical: every scheduled unit runs in both modes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("development stops dispatching after a critical problem: dev_rejected as before, without a development point", async (t) => {
  const root = tempDir();
  try {
    const fx = makeLoop({ root, entries: [] }).fx;
    // Clean screening, violations only in the candidate's development runs.
    const skill = (h, task, info = {}) => (h.id === "c001" && /^develop:/.test(info.context ?? "") && info.repeat === 0 ? { ...skillOf(h), violation: true } : skillOf(h));
    const GOOD = [{ hypothesis: "re-read requirements before finishing", targetFailureClass: "requirements-generalization", edit: edit("good") }];
    const full = await runScenario(root, fx, { stopOnCritical: false, entries: GOOD, skill, stateName: "full" });
    const early = await runScenario(root, fx, { stopOnCritical: true, entries: GOOD, skill, stateName: "early" });
    for (const r of [full, early]) { assert.equal(r.loop.archive.get("c001").status, "dev_rejected"); assert.match(r.loop.archive.get("c001").decisions.at(-1).reason, /^critical: integrity: /); }
    assert.equal(early.loop.archive.get("c001").development.point, undefined, "a partial evaluation is never a development estimate");
    assert.ok(early.loop.archive.get("c001").development.aborted.unitsMissing > 0);
    assert.ok(early.calls.develop < full.calls.develop);
    assert.equal(early.state.selection.selected, null);
    t.diagnostic(`development units (simulated): full ${full.calls.develop} -> early ${early.calls.develop}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an earlier attempt's violation stops the candidate although its retry is clean (every attempt counts)", async () => {
  const root = tempDir();
  try {
    const fx = makeLoop({ root, entries: [] }).fx;
    // First screening unit of the candidate: attempt 1 is an infrastructure error WITH a workspace violation, attempt 2 is clean.
    const skill = (h, task, info = {}) => (h.id === "c001" && /^screen:/.test(info.context ?? "") && info.repeat === 0 ? { ...skillOf(h), infra: true, violation: info.attempt === 1 } : skillOf(h));
    const GOOD = [{ hypothesis: "re-read requirements before finishing", targetFailureClass: "requirements-generalization", edit: edit("good") }];
    const early = await runScenario(root, fx, { stopOnCritical: true, entries: GOOD, skill, stateName: "early" });
    const c = early.loop.archive.get("c001");
    assert.equal(c.status, "rejected");
    assert.match(c.decisions.at(-1).reason, /critical: integrity/);
    assert.ok(c.screening.rounds.at(-1).stoppedEarly, "stopped before the rest of the round");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Evaluator: parallel workers stop dispatching once stopWhen holds; running units are recorded; a resume with decided evidence dispatches nothing", async () => {
  const root = tempDir();
  try {
    const protocol = merge(structuredClone(DEFAULT_PROTOCOL), { parallelism: 3 });
    const tasksById = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`t${i}`, { id: `t${i}`, family: `f${i}` }]));
    let calls = 0;
    const sim = simulatedBackend({ skill: (h, t, info) => ({ p: 0.5, violation: t.id === "t1" && info.repeat === 0 }), seed: "ev" });
    const backend = { simulated: true, run: async (input) => { calls++; await new Promise(r => setTimeout(r, 5)); return sim.run(input); } };
    const ev = new Evaluator({ stateDir: root, protocol, protocolDigest: "p".repeat(64), envDigest: "env-a", tasksById, grading: {}, backend });
    const harness = { id: "c1", kind: "orche", commit: "abc" };
    const units = Object.keys(tasksById).flatMap(task => [0, 1, 2].map(repeat => ({ task, split: "train", repeat })));
    const stopWhen = () => criticalProblems(ev.records(), "c1").length > 0;
    const out = await ev.evaluate(harness, units, "screen:c1:candidate", { stopWhen });
    // t1 repeat 0 is the 4th unit: at most the units already running (parallelism 3) finish after it.
    assert.ok(calls >= 4 && calls <= 4 + 2, `calls ${calls}`);
    assert.equal(out.filter(Boolean).length, calls);
    assert.equal(ev.records().length, calls, "every dispatched unit is recorded");
    const again = await ev.evaluate(harness, units, "screen:c1:candidate", { stopWhen });
    assert.equal(calls, out.filter(Boolean).length, "resume: decided evidence, nothing dispatched");
    assert.equal(again.filter(Boolean).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reuse identity: a unit key changes with environment, commit, protocol, task, split and repeat (never reused across them)", () => {
  const base = { harness: { id: "stable", commit: "a" }, task: "t1", split: "dev", repeat: 0, protocolDigest: "p", envDigest: "e" };
  const k = unitKey(base);
  for (const change of [{ envDigest: "e2" }, { envDigest: undefined }, { harness: { id: "stable", commit: "b" } }, { harness: { id: "pure", commit: "a" } }, { protocolDigest: "p2" }, { task: "t2" }, { split: "train" }, { repeat: 1 }]) {
    assert.notEqual(unitKey({ ...base, ...change }), k, JSON.stringify(change));
  }
  assert.equal(unitKey({ ...base }), k);
});

test("reuse across cycles: an unchanged identity reuses every baseline unit; another environment re-measures all of them", async (t) => {
  const root = tempDir();
  try {
    const { calls, backend } = counting(skillOf);
    const protocol = testProtocol({ datasets: { holdout: null } });
    const first = makeLoop({ root, entries: [], backend, protocol });
    await first.loop.runCycle();
    const cycle1 = calls.baseline;
    assert.ok(cycle1 > 0);
    // Same environment, next cycle (e.g. orche HEAD moved while the stable ref did not): every baseline unit is reused.
    const second = makeLoop({ root, entries: [], backend, protocol, fixtures: first.fx });
    assert.ok(await second.loop.prepare());
    second.loop.nextCycle();
    await second.loop.runCycle();
    assert.equal(calls.baseline, cycle1, "no baseline unit re-run");
    assert.equal(second.loop.state.phase, "done");
    // Another environment (Pi/provider/node/bwrap): nothing is reused, every baseline unit is measured again.
    const third = makeLoop({ root, entries: [], backend, protocol, fixtures: first.fx });
    third.loop.envDigest = "test-env-2";
    assert.ok(await third.loop.prepare());
    third.loop.nextCycle();
    await third.loop.runCycle();
    assert.equal(calls.baseline, 2 * cycle1, "all baselines re-measured in the new environment");
    // Statistics of the new cycle use only its own environment's samples (the old ones stay in the ledger for audit).
    const devStable = third.loop.samples().filter(r => r.candidate_id === "stable" && r.split === "dev");
    assert.ok(devStable.length > 0 && devStable.every(r => r.environment_digest === "test-env-2"));
    assert.ok(third.loop.records().some(r => r.environment_digest === "test-env"));
    t.diagnostic(`baseline units (simulated): cycle 1 ${cycle1}; unchanged identity +0; new environment +${cycle1}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stable samples are bound to the current stable commit and identity; foreign records stay visible to critical checks only", async () => {
  const root = tempDir();
  try {
    const { loop } = makeLoop({ root, entries: [], protocol: testProtocol({ datasets: { holdout: null } }) });
    loop.stopBefore = "search";
    await loop.runCycle();
    const n = loop.samples().length;
    const foreign = (over) => makeRecord({ run_id: "x", unit_key: `x-${JSON.stringify(over)}`, candidate_id: "stable", harness_commit: loop.state.stable.commit, task_id: "t1", split: "dev", repeat: 0, terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, model_route: "m", thinking_effort: "e", environment_digest: "test-env", protocol_digest: loop.protocolDigest, integrity: { violations: ["changed/removed 1 line(s) of test file test/a.test.js"], leakHits: [] }, ...over });
    for (const over of [{ harness_commit: "0".repeat(40) }, { environment_digest: "other-env" }, { environment_digest: undefined }, { protocol_digest: "other-protocol" }]) loop.evaluator.ledger.append({ type: "result", unit_key: `x-${JSON.stringify(over)}`, record: foreign(over) });
    assert.equal(loop.samples().length, n, "no foreign record enters a statistic");
    assert.equal(criticalProblems(loop.records(), "stable").filter(p => p.startsWith("task-agent integrity violation dev/t1#0")).length >= 4, true, "violations of every identity remain evidence");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an environment change during the search blocks (permanent, nothing dispatched); the recorded environment resumes it", async () => {
  const root = tempDir();
  try {
    const { calls, backend } = counting(skillOf);
    const protocol = testProtocol({ datasets: { holdout: null } });
    const first = makeLoop({ root, entries: [], backend, protocol });
    first.loop.stopBefore = "search";
    await first.loop.runCycle();
    assert.equal(first.loop.state.phase, "search");
    const before = total(calls);
    const other = makeLoop({ root, entries: [], backend, protocol, fixtures: first.fx });
    other.loop.envDigest = "test-env-2";
    const state = await other.loop.runCycle();
    assert.equal(state.phase, "blocked");
    assert.equal(state.blocked.retryable, false);
    assert.equal(state.blocked.resumePhase, "search");
    assert.match(state.blocked.reason, /environment changed during the cycle/);
    assert.equal(total(calls), before, "no unit dispatched");
    const back = makeLoop({ root, entries: [], backend, protocol, fixtures: first.fx });
    const resumed = await back.loop.runCycle();
    assert.equal(resumed.phase, "done");
    assert.equal(calls.baseline, first.loop.evaluator.records().filter(r => r.context.startsWith("baseline:")).length, "baselines were not run again");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("precheck: a candidate failing the adoption check rule is rejected before any model run; stable's checks run once", async () => {
  const root = tempDir();
  try {
    const fx = makeLoop({ root, entries: [] }).fx;
    const failing = { pass: false, results: { typecheck: { pass: true, exit: 0 }, test: { pass: false, exit: 1, failing: ["src/a.test.ts > breaks"], tail: "\n FAIL  src/a.test.ts > breaks\n      Tests  1 failed | 9 passed (10)\n" } } };
    const seen = [];
    const checks = async (worktree, which) => { seen.push({ worktree, which }); return /\/c001$/.test(worktree) ? (which.includes("test") ? failing : { pass: true, results: { typecheck: failing.results.typecheck } }) : passingChecks(); };
    const { calls, backend } = counting(skillOf);
    const entries = [{ hypothesis: "break a test", targetFailureClass: "requirements-generalization", edit: edit("good") }, { hypothesis: "re-read requirements before finishing", targetFailureClass: "requirements-generalization", edit: edit("good x") }];
    const protocol = testProtocol({ datasets: { holdout: null } });
    const { loop } = makeLoop({ root, entries, backend, protocol, checks, fixtures: fx });
    await loop.runCycle();
    const c1 = loop.archive.get("c001");
    assert.equal(c1.status, "build_failed");
    assert.match(c1.decisions.at(-1).reason, /^precheck failed \(adoption check rule against stable\): .*tests failing only with the candidate: src\/a.test.ts > breaks/);
    assert.equal(loop.records().filter(r => r.candidate_id === "c001").length, 0, "no model run for the rejected candidate");
    assert.notEqual(loop.archive.get("c002").status, "build_failed");
    const stableRuns = seen.filter(s => /worktrees\/stable$/.test(s.worktree));
    assert.equal(stableRuns.length, 1, "stable checks measured once and cached");
    assert.deepEqual(seen.find(s => /\/c001$/.test(s.worktree)).which, ["typecheck", "test"]);
    void calls;
    // typecheck-only precheck (protocol override) keeps the earlier behaviour: the same candidate is screened.
    const typecheckOnly = makeLoop({ root, entries, backend, protocol: testProtocol({ datasets: { holdout: null }, efficiency: { precheck: ["typecheck"] } }), checks, fixtures: fx, stateName: "tc" }).loop;
    await typecheckOnly.runCycle();
    assert.notEqual(typecheckOnly.archive.get("c001").status, "build_failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("targeting: recurring gate-blocking classes first; a single occurrence does not reorder; rejections alone can make the target", () => {
  const rec = (task, repeat, cls) => ({ task_id: task, repeat, task_success: false, failure_class: cls, terminal_status: "completed" });
  const records = [...[0, 1, 2, 3, 4].map(i => rec(`t${i}`, 0, "requirements-generalization")), rec("t5", 0, "integrity"), rec("t6", 1, "integrity")];
  assert.equal(analyze(records).hypotheses[0].class, "integrity");
  assert.equal(analyze(records, { gateFirst: false }).hypotheses[0].class, "requirements-generalization");
  assert.equal(analyze(records.slice(0, 6)).hypotheses[0].class, "requirements-generalization", "one integrity run is not recurring");
  assert.equal(analyze(records.slice(0, 6), { rejections: { integrity: 1 } }).hypotheses[0].class, "integrity", "one run plus one candidate rejection recurs");
  const synthesized = analyze(records.slice(0, 5), { rejections: { integrity: 2 } }).hypotheses;
  assert.equal(synthesized[0].class, "integrity"); assert.equal(synthesized[0].runs, 0); assert.equal(synthesized[0].candidateRejections, 2);
});

test("no token, cost or money limit exists or can be configured; the non-financial safety limits are unchanged", () => {
  const p = structuredClone(DEFAULT_PROTOCOL);
  assert.equal(p.version, "pi-eval-loop/protocol-3");
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, /token|budget|cost|usd|money/i);
  assert.throws(() => merge(p, { efficiency: { maxTokens: 1 } }), /unknown key maxTokens/);
  assert.throws(() => merge(p, { budget: { tokens: 1 } }), /unknown key budget/);
  assert.deepEqual(validateProtocol(p), []);
  assert.deepEqual(validateProtocol(merge(p, { efficiency: { precheck: ["test"] } })), ["efficiency.precheck must list typecheck and optionally test"]);
  assert.equal(p.watchdog.noProgressCandidates, 10); assert.equal(p.watchdog.maxCandidatesPerCycle, 200); assert.equal(p.watchdog.maxCycleWallMs, 72 * 3600_000);
  assert.equal(p.adoption.support, 0.95); assert.equal(p.screening.support, 0.80); assert.equal(p.holdout.maxUses, 1); assert.equal(p.holdout.requireIndependent, true);
});
