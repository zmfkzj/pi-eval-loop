// Regression tests for protocol-2: critical integrity problems reject a candidate whatever the baseline did (every attempt, every
// non-holdout split, re-checked at selection), exact development points and tie handling, greedy progress, and the
// exploration-only protocol (no holdout loaded, graded or consumed; deployment BLOCKED; no ref change) in the Loop and in A/B/C.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { edit, makeHoldout, makeLoop, makeTasks, makeUmbrella, HOLDOUT, TRAIN_DEV, rmSync, sh, skillOf, tempDir, testProtocol } from "./helpers.mjs";
import { criticalProblems } from "../src/gate.mjs";
import { greedyProgress } from "../src/loop.mjs";
import { makeRecord } from "../src/metrics.mjs";
import { Archive, pointGt } from "../src/archive.mjs";
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
  const sim = simulatedBackend({ skill: (h) => skillOf(h), seed: "test" });
  const splits = {};
  return { splits, backend: { simulated: true, run: async (input) => { splits[input.split] = (splits[input.split] ?? 0) + 1; return sim.run(input); } } };
}

/** @type {Array<[label: string, entries: typeof GOOD[], selected: string | null]>} */
const EXPLORATION_CASES = [["a selected candidate", [GOOD], "c001"], ["no selected candidate", [BAD], null]];
for (const [label, entries, selected] of EXPLORATION_CASES) {
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

test("CLI: an unknown --strategy is refused before any loop starts (no silent fallback to the Pareto loop)", () => {
  const root = tempDir();
  try {
    const cli = fileURLToPath(new URL("../bin/eval-loop.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [cli, "--once", "--state", join(root, "s"), "--strategy", "quality"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /--strategy must be pareto or greedy/);
    assert.equal(existsSync(join(root, "s", "state.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exploration-only A/B/C without any selection: BLOCKED with a stated reason, no holdout unit run", async () => {
  const root = tempDir();
  try {
    const fixtures = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
    const { splits, backend } = countingBackend();
    const protocol = testProtocol({ datasets: { holdout: null } });
    const loopFactory = async ({ stateDir, strategy }) => makeLoop({ root, fixtures, stateName: join("abc", stateDir.split("/").at(-1)), strategy, backend, protocol, entries: stateDir.endsWith("A") ? [] : [BAD] }).loop;
    const result = await runAblation({ stateDir: join(root, "abc"), loopFactory });
    assert.equal(result.ok, true, JSON.stringify(result.summary));
    const saved = JSON.parse(readFileSync(join(root, "abc/ablation.json"), "utf8"));
    assert.deepEqual(Object.values(saved.arms).map(a => a.id), ["stable", "stable", "stable"]);
    assert.equal(saved.adoption.verdict, "BLOCKED");
    assert.equal(saved.adoption.adopt, false);
    assert.match(saved.adoption.exploration, /no candidate selected \(the C trajectory selected no candidate on development; neither did B\)/);
    assert.equal(splits.holdout ?? 0, 0);
    noRef(fixtures);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("patch integrity: moving a protected file into an allowed directory is a change of the protected path (no rename detection)", async () => {
  const root = tempDir();
  try {
    const MOVE = { hypothesis: "keep notes", targetFailureClass: "requirements-generalization", edit: (dir) => { renameSync(join(dir, ".gitignore"), join(dir, "src/gitignore-notes.txt")); edit("good")(dir); } };
    const { loop, fx } = makeLoop({ root, entries: [MOVE] });
    const state = await loop.runCycle();
    const c = loop.archive.get("c001");
    assert.equal(c.status, "rejected_patch", JSON.stringify(c.decisions));
    assert.match(c.decisions.at(-1).reason, /patch integrity: .*\.gitignore/);
    assert.equal(state.selection.selected, null);
    noRef(fx);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ties within floating-point noise: never progress, never domination, never a development win over stable", async () => {
  // The same rational value summed in two orders (the verifier's case: 6/18 gave 0.33333333333333337 vs 0.3333333333333333).
  const a = (1 / 3 + 1 / 3 + 1 / 3) / 3, b = (1 / 3) * (3 / 3);
  assert.equal(pointGt(0.1 + 0.2, 0.3), false);
  assert.equal(pointGt(0.33333333333333337, 0.3333333333333333), false);
  assert.equal(pointGt(a, b) || pointGt(b, a), false);
  assert.equal(pointGt(0.34, 0.3333333333333333), true, "a real difference still counts");
  // Greedy progress: noise is not a new best; the smallest real dev difference (1/48) is.
  assert.equal(greedyProgress(true, { overall: 0.33333333333333337 }, { overall: 0.3333333333333333 }), false);
  assert.equal(greedyProgress(true, { overall: 1 / 3 + 1 / 48 }, { overall: 1 / 3 }), true);
  assert.equal(greedyProgress(false, { overall: 0.9 }, { overall: 0.1 }), false);
  const root = tempDir();
  try {
    let fixtures;
    for (const strategy of /** @type {const} */ (["pareto", "greedy"])) {
      const made = makeLoop({ root, entries: [GOOD], strategy, stateName: `tie-${strategy}`, fixtures });
      fixtures = made.fx;
      const loop = made.loop;
      loop.stopBefore = "select";
      await loop.runCycle();
      const stable = loop.archive.get("stable");
      const c = loop.archive.get("c001");
      // Same outcomes as stable, summed in another order: the point differs from stable's only by rounding noise.
      const point = { ...stable.development.point, overall: stable.development.point.overall + 4 * Number.EPSILON * Math.max(1, stable.development.point.overall) };
      assert.notEqual(point.overall, stable.development.point.overall);
      loop.archive.put({ ...c, status: "dev_qualified", development: { ...c.development, qualified: true, point } });
      assert.equal(loop.archive.weaklyDominated("c001"), true, `${strategy}: a noise-level tie is weakly dominated by stable`);
      assert.ok(loop.archive.front().includes("stable"), `${strategy}: stable stays on the front`);
      if (strategy === "greedy") loop.state.greedyBest = "c001";
      loop.select();
      assert.equal(loop.state.selection.selected, null, `${strategy}: ${JSON.stringify(loop.state.selection)}`);
      if (strategy === "pareto") {
        // Selection order: a real Q_hard gain wins over an Q_overall "lead" that is only rounding noise.
        const s = stable.development.point, up = s.overall + 1 / 48;
        loop.archive.put({ ...loop.archive.get("c001"), status: "dev_qualified", development: { ...c.development, qualified: true, point: { ...s, overall: up + 4 * Number.EPSILON } } });
        loop.archive.create({ id: "c009", status: "dev_qualified", parent: "stable", commit: c.commit, development: { ...c.development, qualified: true, point: { ...s, overall: up, hard: (s.hard ?? 0) + 1 / 24 } } });
        loop.select();
        assert.equal(loop.state.selection.selected, "c009", JSON.stringify(loop.state.selection));
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("class exhaustion counts failures since the last progress only, so it cannot end a search before the no-progress patience", async () => {
  const root = tempDir();
  try {
    const archive = new Archive(join(root, "s"));
    const fail = (id, at) => archive.create({ id, status: "rejected", createdAt: at, hypothesis: { text: id, targetFailureClass: "requirements-generalization" } });
    for (let i = 0; i < 9; i++) fail(`a${i}`, `2026-01-01T00:00:0${i}.000Z`);
    fail("b0", "2026-01-01T00:01:00.000Z");
    assert.deepEqual(archive.failuresByClass(), { "requirements-generalization": 10 }, "cumulative count (protocol-2 as run)");
    assert.deepEqual(archive.failuresByClass({ since: "2026-01-01T00:00:30.000Z" }), { "requirements-generalization": 1 }, "only the failure after the last progress counts");
    assert.deepEqual(archive.failuresByClass({ last: 3 }), { "requirements-generalization": 3 }, "a state without lastProgressAt is bounded by the consecutive no-progress count");
    // Loop wiring: progress moves the counting window forward.
    const { loop } = makeLoop({ root, entries: [] });
    loop.save();
    await new Promise(r => setTimeout(r, 5));
    loop.archive.create({ id: "f1", status: "rejected", hypothesis: { text: "f1", targetFailureClass: "integrity" } });
    loop.endCandidate(false);
    assert.deepEqual(loop.classFailures(), { integrity: 1 });
    await new Promise(r => setTimeout(r, 5));
    loop.endCandidate(true);
    assert.deepEqual(loop.classFailures(), {}, "failures before the last progress no longer count");
    assert.equal(loop.state.counters.noProgress, 0);
    // A state written before lastProgressAt existed (resumed mid-search after progress): bounded by the consecutive count.
    for (const id of ["g1", "g2", "g3"]) loop.archive.create({ id, status: "rejected", hypothesis: { text: id, targetFailureClass: "integrity" } });
    delete loop.state.lastProgressAt;
    loop.state.counters.noProgress = 1;
    assert.deepEqual(loop.classFailures(), { integrity: 1 }, "only the consecutive no-progress candidates count");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("A/B/C re-checks each trajectory's own train/dev records before freezing its final (a late violation excludes it)", async () => {
  const root = tempDir();
  try {
    const fixtures = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
    const { splits, backend } = countingBackend();
    const protocol = testProtocol({ datasets: { holdout: null } });
    const loopFactory = async ({ stateDir, strategy }) => {
      const name = stateDir.split("/").at(-1);
      const loop = makeLoop({ root, fixtures, stateName: join("abc", name), strategy, backend, protocol, entries: name === "A" ? [] : [GOOD] }).loop;
      if (name === "C") {
        const run = loop.runCycle.bind(loop);
        loop.runCycle = async () => {
          const state = await run();
          loop.evaluator.ledger.append({ type: "result", unit_key: "late", record: rec({ candidate_id: "C-c001", task_id: "t1", split: "train", repeat: 9, unit_key: "late", integrity: { violations: ["new test-runner/configuration file conftest.py"], leakHits: [] } }) });
          return state;
        };
      }
      return loop;
    };
    const result = await runAblation({ stateDir: join(root, "abc"), loopFactory });
    assert.equal(result.ok, true, JSON.stringify(result.summary));
    const saved = JSON.parse(readFileSync(join(root, "abc/ablation.json"), "utf8"));
    assert.equal(saved.arms.C.id, "stable", "the violating C final is not frozen");
    const selection = JSON.parse(readFileSync(join(root, "abc/A/selection.json"), "utf8"));
    assert.equal(selection.criticalExcluded[0].id, "C-c001");
    assert.equal(saved.adoption.verdict, "BLOCKED");
    assert.equal(splits.holdout ?? 0, 0);
    noRef(fixtures);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
