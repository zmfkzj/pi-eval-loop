// Regression tests for protocol-2: critical integrity problems reject a candidate whatever the baseline did (every attempt, every
// non-holdout split, re-checked at selection), exact development points and tie handling, greedy progress, and the
// exploration-only protocol (no holdout loaded, graded or consumed; deployment BLOCKED; no ref change) in the Loop and in A/B/C.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { edit, makeHoldout, makeLoop, makeTasks, makeUmbrella, HOLDOUT, TRAIN_DEV, rmSync, sh, skillOf, tempDir, testProtocol } from "./helpers.mjs";
import { criticalProblems } from "../src/gate.mjs";
import { makeRecord } from "../src/metrics.mjs";
import { Archive } from "../src/archive.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";
import { runAblation } from "../src/ablation.mjs";
import { buildReport } from "../src/report.mjs";
import { Ledger } from "../src/util.mjs";

const rec = (over) => makeRecord({ run_id: "r", unit_key: over.unit_key ?? `${over.candidate_id ?? "c1"}|${over.task_id ?? "t"}|${over.split ?? "dev"}|${over.repeat ?? 0}`, attempt: 1, candidate_id: "c1", harness_commit: "x", task_id: "t", split: "dev", repeat: 0, terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, model_route: "m", thinking_effort: "e", environment_digest: "d", protocol_digest: "p", ...over });
const GOOD = { hypothesis: "re-read requirements before finishing", targetFailureClass: "requirements-generalization", edit: edit("good") };
const BAD = { hypothesis: "skip verification", targetFailureClass: "requirements-generalization", edit: edit("bad") };
const noRef = (fx) => assert.throws(() => sh(fx.orche, ["rev-parse", "--verify", "refs/heads/eval-loop/stable"]));

test("critical: a clean retry never erases an earlier attempt's violation; categories are named precisely", () => {
  const dirty = rec({ unit_key: "k", attempt: 1, terminal_status: "infra_error", integrity: { violations: ["changed/removed 1 line(s) of test file test/a.test.js"], leakHits: [] } });
  const clean = rec({ unit_key: "k", attempt: 2 });
  const problems = criticalProblems([dirty, clean], "c1", { reference: "stable" });
  assert.ok(problems.some(p => /task-agent integrity violation dev\/t#0: changed\/removed/.test(p)), problems.join(" | "));
  assert.match(problems[0], /reference stable: 0 in the same scope; context only, never an excuse/);
  const leak = criticalProblems([rec({ integrity: { violations: [], leakHits: ["read: /opt/grader"] } })], "c1");
  assert.ok(leak.some(p => /^task-agent leak attempt/.test(p)));
  assert.ok(criticalProblems([rec({ terminal_status: "route_violation", hidden_test_pass: false })], "c1").some(p => /^route violation/.test(p)));
});

test("critical: a violation only in the candidate's own development-train runs makes it dev_rejected, never selected", async () => {
  const root = tempDir();
  try {
    // Violation on every develop:train unit of the candidate (its screening and development runs stay clean).
    const everyTrain = (h, t, info = {}) => (h.id === "c001" && /^develop:.*:train$/.test(info.context ?? "") ? { ...skillOf(h), violation: true } : skillOf(h));
    // A small screening batch leaves train tasks that only the development phase runs (as in abc-real-1).
    const { loop, fx } = makeLoop({ root, entries: [GOOD], skill: everyTrain, protocol: testProtocol({ screening: { tasks: 2 } }) });
    const state = await loop.runCycle();
    const c = loop.archive.get("c001");
    assert.equal(c.screening.decision, "PROMOTE", "screening was clean");
    assert.equal(c.status, "dev_rejected", JSON.stringify(c.decisions.at(-1)));
    assert.match(c.decisions.at(-1).reason, /critical: integrity: .*task-agent integrity violation train\//);
    assert.equal(state.selection.selected, null);
    noRef(fx);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("critical: selection re-checks the records, so a stale dev_qualified candidate with a recorded violation is excluded", async () => {
  const root = tempDir();
  try {
    const { loop } = makeLoop({ root, entries: [GOOD] });
    loop.stopBefore = "select";
    await loop.runCycle();
    assert.equal(loop.archive.get("c001").status, "dev_qualified");
    // Evidence recorded after qualification (e.g. a later attempt): the archived status alone must not be trusted.
    loop.evaluator.ledger.append({ type: "result", unit_key: "late", record: rec({ candidate_id: "c001", task_id: "t1", split: "train", repeat: 9, unit_key: "late", integrity: { violations: ["new test-runner/configuration file conftest.py"], leakHits: [] } }) });
    loop.select();
    assert.equal(loop.state.selection.selected, null);
    assert.equal(loop.state.selection.criticalExcluded[0].id, "c001");
    assert.match(loop.state.selection.reason, /critical-clean/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("progress: exact development points; a tie with an existing point is not progress; greedy progress = a new best", async () => {
  const root = tempDir();
  try {
    const { loop, fx } = makeLoop({ root, entries: [] });
    const archive = new Archive(loop.stateDir);
    archive.create({ id: "stable", status: "baseline", development: { point: { overall: 0.5, hard: 0.4, consistency: 0.3 } } });
    archive.create({ id: "c1", status: "dev_qualified", development: { qualified: true, point: { overall: 0.5, hard: 0.4, consistency: 0.3 } } });
    archive.create({ id: "c2", status: "dev_qualified", development: { qualified: true, point: { overall: 0.52, hard: 0.4, consistency: 0.3 } } });
    assert.equal(archive.weaklyDominated("c1"), true, "identical to stable");
    assert.equal(archive.weaklyDominated("c2"), false);
    assert.deepEqual(archive.front().sort(), ["c2"]);
    const g = makeLoop({ root, entries: [GOOD], strategy: "greedy", stateName: "greedy", fixtures: fx }).loop;
    await g.runCycle();
    const c = g.archive.get("c001");
    assert.equal(g.state.greedyBest, "c001");
    // Exact plug-in point = raw task-mean of the repeats (no Monte Carlo noise).
    const finals = g.records().filter(r => r.candidate_id === "c001" && r.split === "dev");
    const byTask = {}; for (const r of finals) (byTask[r.task_id] ??= []).push(r.task_success ? 1 : 0);
    const exact = Object.values(byTask).reduce((s, v) => s + v.reduce((a, b) => a + b, 0) / v.length, 0) / Object.keys(byTask).length;
    assert.ok(Math.abs(c.development.point.overall - exact) < 1e-12, `${c.development.point.overall} vs ${exact}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function countingBackend() {
  const sim = simulatedBackend({ skill: (h, t) => skillOf(h, t), seed: "test" });
  const splits = {};
  return { splits, backend: { simulated: true, run: async (input) => { splits[input.split] = (splits[input.split] ?? 0) + 1; return sim.run(input); } } };
}

for (const [label, entries, selected] of [["a selected candidate", [GOOD], "c001"], ["no selected candidate", [BAD], null]]) {
  test(`exploration-only Loop (${label}): no holdout loaded or consumed, deployment BLOCKED, no ref change, resume is idempotent`, async () => {
    const root = tempDir();
    try {
      const { splits, backend } = countingBackend();
      const protocol = testProtocol({ datasets: { holdout: null } });
      const { loop, fx } = makeLoop({ root, entries, backend, protocol });
      const state = await loop.runCycle();
      assert.equal(state.phase, "done");
      assert.equal(state.selection.selected, selected);
      assert.equal(state.final.verdict, "BLOCKED");
      assert.equal(state.final.adopt, false);
      assert.equal(state.final.explorationOnly, true);
      assert.match(state.final.exploration, selected ? /selected on development/ : /no candidate selected/);
      assert.equal(splits.holdout ?? 0, 0, "no holdout unit was ever run");
      assert.deepEqual(JSON.parse(readFileSync(join(loop.stateDir, "datasets.json"), "utf8")).holdout, []);
      assert.equal(existsSync(join(fx.holdout.dir, "USES.jsonl")) ? new Ledger(join(fx.holdout.dir, "USES.jsonl")).records().length : 0, 0);
      noRef(fx);
      assert.match(buildReport(loop.stateDir).markdown, /deployment verdict: BLOCKED/);
      const again = makeLoop({ root, entries, backend, protocol, fixtures: fx }).loop;
      const resumed = await again.runCycle();
      assert.equal(resumed.final.verdict, "BLOCKED");
      assert.equal(splits.holdout ?? 0, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("exploration-only A/B/C: finals frozen, no joint holdout pass, BLOCKED, ledger and refs untouched, resume idempotent", async () => {
  const root = tempDir();
  try {
    const fixtures = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
    const { splits, backend } = countingBackend();
    const protocol = testProtocol({ datasets: { holdout: null } });
    const loopFactory = async ({ stateDir, strategy }) => {
      const name = stateDir.split("/").at(-1);
      return makeLoop({ root, fixtures, stateName: join("abc", name), strategy, backend, protocol, entries: name === "A" ? [] : [GOOD, BAD] }).loop;
    };
    const result = await runAblation({ stateDir: join(root, "abc"), loopFactory });
    assert.equal(result.ok, true, JSON.stringify(result.summary));
    const saved = JSON.parse(readFileSync(join(root, "abc/ablation.json"), "utf8"));
    assert.equal(saved.explorationOnly, true);
    assert.equal(saved.adoption.verdict, "BLOCKED");
    assert.equal(saved.arms.C.id, "C-c001");
    assert.equal(saved.comparisons["C vs A (loop effect, Pareto)"].notMeasured, true);
    assert.ok(saved.developmentComparisons["C vs A"].selectionBiased);
    assert.equal(splits.holdout ?? 0, 0);
    assert.equal(existsSync(join(fixtures.holdout.dir, "USES.jsonl")) ? new Ledger(join(fixtures.holdout.dir, "USES.jsonl")).records().length : 0, 0);
    noRef(fixtures);
    assert.match(readFileSync(join(root, "abc/ablation.md"), "utf8"), /EXPLORATION-ONLY/);
    const before = { ...splits };
    const again = await runAblation({ stateDir: join(root, "abc"), loopFactory });
    assert.equal(again.ok, true);
    assert.deepEqual(splits, before, "resuming a finished exploration runs nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("report: exact empirical rates next to counts and measured opportunities (allowed vs actual attempts)", async () => {
  const root = tempDir();
  try {
    const { loop } = makeLoop({ root, entries: [], protocol: testProtocol({ datasets: { holdout: null } }) });
    await loop.runCycle();
    const md = buildReport(loop.stateDir).markdown;
    assert.match(md, /\| stable \| dev \| \d+ \| \d+\/\d+ \(\d+\.\d\d%\)/);
    assert.match(md, /Measured execution opportunities/);
    assert.match(md, /\| multi2 \| dev \| 2 \| 1\.00 \|/, "the simulated k-attempt arm used one attempt per unit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
