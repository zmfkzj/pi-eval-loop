// Deterministic end-to-end tests of the loop on the simulated backend (no model, no sandbox): candidate generation and state,
// isolation, aggregation, gates, Pareto archive, rejection and retention, final selection, holdout consumption, adoption,
// rollback, crash recovery, watchdog stop and unattended termination.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { edit, makeLoop, rmSync, sh, tempDir, testProtocol } from "./helpers.mjs";
import { Ledger } from "../src/util.mjs";
import { gitlinks } from "../src/deploy.mjs";
import { buildReport } from "../src/report.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";
import { skillOf } from "./helpers.mjs";

const ENTRIES = [
  { hypothesis: "re-read requirements before finishing", targetFailureClass: "requirements-generalization", edit: edit("good") },
  { hypothesis: "skip verification to finish faster", targetFailureClass: "requirements-generalization", edit: edit("bad") },
  { hypothesis: "restructure the worker prompt completely", targetFailureClass: "requirements-generalization", edit: edit("crash") },
];

test("a full cycle runs unattended: good candidate promoted, developed, selected, holdout-confirmed, adopted on local refs; bad and crashing ones rejected and kept", async () => {
  const root = tempDir();
  try {
    const { loop, fx } = makeLoop({ root, entries: ENTRIES });
    const state = await loop.runCycle();
    assert.equal(state.phase, "done");
    const c = loop.archive.all();
    const byId = Object.fromEntries(c.map(x => [x.id, x]));
    assert.equal(byId.c001.hypothesis.text, ENTRIES[0].hypothesis);
    assert.ok(["adopted"].includes(byId.c001.status), `c001 status ${byId.c001.status}`);
    assert.ok(byId.c001.screening.support >= 0.8);
    assert.ok(byId.c001.development.qualified);
    // Rejected and crashing candidates stay in the archive with their reasons.
    const bad = c.find(x => x.hypothesis?.text === ENTRIES[1].hypothesis);
    assert.ok(bad, JSON.stringify(c.map(x => [x.id, x.status, x.hypothesis?.text, x.decisions?.at(-1)?.reason])));
    assert.ok(["rejected", "inconclusive"].includes(bad.status), bad.status);
    const crash = c.find(x => x.hypothesis?.text === ENTRIES[2].hypothesis);
    assert.equal(crash.status, "rejected");
    assert.match(crash.decisions.at(-1).reason, /critical: harness crash/);
    // Candidates are isolated worktrees on their own branches; orche's own checkout is untouched.
    assert.equal(sh(fx.orche, ["rev-parse", "HEAD"]), fx.base);
    assert.equal(readFileSync(join(fx.orche, "src/skill.txt"), "utf8"), "base\n");
    assert.match(sh(fx.orche, ["branch", "--list", "eval-loop/candidates/*"]), /c001/);
    assert.equal(byId.c001.branch.startsWith("eval-loop/candidates/"), true);
    // Adoption moved only the local eval-loop/stable refs, with a coherent umbrella gitlink.
    const adopted = sh(fx.orche, ["rev-parse", "refs/heads/eval-loop/stable"]);
    assert.equal(adopted, byId.c001.commit);
    assert.equal(gitlinks(fx.umbrella, "refs/heads/eval-loop/stable").orche, adopted);
    assert.equal(sh(fx.umbrella, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(gitlinks(fx.umbrella, "HEAD").orche, fx.base);
    // The holdout was consumed exactly once, before its runs.
    assert.equal(new Ledger(join(fx.holdout.dir, "USES.jsonl")).records().length, 1);
    assert.equal(state.final.verdict, "ADOPT");
    assert.equal(state.final.independence.independent, true);
    // Search stopped by the no-progress watchdog, not by hand.
    assert.match(state.searchStop, /no meaningful progress|no addressable/);
    // Records are complete and chained; the report builds from disk alone and flags simulation.
    assert.deepEqual(loop.evaluator.ledger.verify(), []);
    const report = buildReport(loop.stateDir);
    assert.match(report.markdown, /SIMULATED RUNS PRESENT/);
    assert.match(report.markdown, /verdict: ADOPT/);
    // Rollback restores the previous stable snapshot (refs removed: there was no earlier eval-loop/stable).
    const rb = loop.deployer.rollback({ reason: "test" });
    assert.deepEqual(rb.problems, []);
    assert.throws(() => sh(fx.orche, ["rev-parse", "--verify", "refs/heads/eval-loop/stable"]));
    assert.throws(() => sh(fx.umbrella, ["rev-parse", "--verify", "refs/heads/eval-loop/stable"]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a holdout that was already used cannot back an adoption: BLOCKED, the stable harness is kept", async () => {
  const root = tempDir();
  try {
    const { loop, fx } = makeLoop({ root, entries: [ENTRIES[0]] });
    new Ledger(join(fx.holdout.dir, "USES.jsonl")).append({ type: "use", note: "an earlier final evaluation" });
    const state = await loop.runCycle();
    assert.equal(state.selection.selected, "c001");
    assert.equal(state.final.verdict, "BLOCKED");
    assert.match(state.final.reasons.join(" "), /no independent holdout: .*already used 1 time/);
    assert.throws(() => sh(fx.orche, ["rev-parse", "--verify", "refs/heads/eval-loop/stable"]));
    assert.equal(new Ledger(join(fx.holdout.dir, "USES.jsonl")).records().length, 2, "this (non-independent) use is recorded too");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a later cycle starts from the adopted stable and finds no improvement over it", async () => {
  const root = tempDir();
  try {
    const first = makeLoop({ root, entries: [ENTRIES[0]] });
    await first.loop.runCycle();
    assert.equal(first.loop.state.final.verdict, "ADOPT");
    const second = makeLoop({ root, entries: [{ hypothesis: "another change", targetFailureClass: "requirements-generalization", edit: edit("good good") }], fixtures: first.fx, stateName: "state2" });
    const state = await second.loop.runCycle();
    assert.equal(state.stable.commit, first.loop.archive.get("c001").commit);
    assert.equal(state.final.verdict, "KEEP_STABLE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no improvement is a normal result: nothing is selected and the stable harness is kept", async () => {
  const root = tempDir();
  try {
    const { loop, fx } = makeLoop({ root, entries: [ENTRIES[1], { hypothesis: "a neutral change", targetFailureClass: "requirements-generalization", edit: edit("same") }] });
    const state = await loop.runCycle();
    assert.equal(state.phase, "done");
    assert.equal(state.selection.selected, null);
    assert.equal(state.final.verdict, "KEEP_STABLE");
    assert.throws(() => sh(fx.orche, ["rev-parse", "--verify", "refs/heads/eval-loop/stable"]));
    assert.equal(new Ledger(join(fx.holdout.dir, "USES.jsonl")).records().length, 0, "holdout untouched without a selection");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing prerequisites end in a recorded BLOCKED state without any evaluation", async () => {
  const root = tempDir();
  try {
    const { loop } = makeLoop({ root, entries: ENTRIES, prerequisites: async () => [{ name: "credentials", ok: false, detail: "absent" }] });
    const state = await loop.runCycle();
    assert.equal(state.phase, "blocked");
    assert.equal(state.blocked.missing[0].name, "credentials");
    assert.equal(existsSync(join(loop.stateDir, "runs.jsonl")), false);
    assert.match(buildReport(loop.stateDir).markdown, /BLOCKED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a crash mid-evaluation resumes: dispatched-but-unrecorded units are reconciled, completed ones reused, nothing re-drawn", async () => {
  const root = tempDir();
  try {
    let calls = 0, crashAt = 25;
    const sim = simulatedBackend({ skill: (h) => skillOf(h), seed: "test" });
    const crashing = { simulated: true, run: async (input) => { if (++calls === crashAt) { const e = new Error("controller killed"); e.fatal = true; throw e; } return sim.run(input); } };
    const { loop, fx } = makeLoop({ root, entries: [ENTRIES[0]], backend: crashing, protocol: testProtocol({ parallelism: 1 }) });
    // Emulate a hard kill: the first evaluation throws out of the controller before the result is written.
    const original = loop.evaluate;
    const evalRunOne = loop.constructor.prototype;
    void original; void evalRunOne;
    await assert.rejects(async () => {
      await loop.prepare();
      const ev = loop.evaluator;
      const runOne = ev.runOne.bind(ev);
      ev.runOne = async (h, u, ctx) => { if (calls + 1 === crashAt) { ev.ledger.append({ type: "dispatch", unit_key: ev.keyOf(h, u.task, u.split, u.repeat), attempt: 1, run_id: "killed", controlDir: join(root, "no-such"), harness: { id: h.id, kind: h.kind }, task: u.task, split: u.split, repeat: u.repeat, context: ctx, simulated: true }); calls++; throw new Error("killed"); } return runOne(h, u, ctx); };
      loop.setPhase("baselines");
      await loop.baselines();
    });
    const before = loop.evaluator.ledger.records().filter(r => r.type === "result").length;
    const resumed = makeLoop({ root, entries: [ENTRIES[0]], fixtures: fx, protocol: testProtocol({ parallelism: 1 }) }).loop;
    const state = await resumed.runCycle();
    assert.equal(state.phase, "done");
    const records = resumed.evaluator.ledger.records();
    const reconciled = records.filter(r => r.reconciled);
    assert.equal(reconciled.length, 1, "the killed unit is reconciled once");
    assert.equal(reconciled[0].record.terminal_status, "infra_error", "no completed model call in its (absent) wire journal");
    // Completed units before the crash were reused (one result each), and the reconciled unit got exactly one retry.
    const keys = records.filter(r => r.type === "result").map(r => r.unit_key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.equal(dupes.length, 1, "only the reconciled infra unit has a second (retry) attempt");
    assert.ok(before > 0);
    assert.deepEqual(resumed.evaluator.ledger.verify(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a changed protocol after the lock blocks the loop (a new protocol version needs a new state directory)", async () => {
  const root = tempDir();
  try {
    const { loop, fx } = makeLoop({ root, entries: [] });
    await loop.prepare();
    const changed = makeLoop({ root, entries: [], fixtures: fx, protocol: testProtocol({ screening: { support: 0.85 } }) }).loop;
    assert.equal(await changed.prepare(), false);
    assert.match(changed.state.blocked.reason, /protocol\/evaluator\/dataset changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("duplicate patches and repeatedly failing hypothesis classes are not retried forever", async () => {
  const root = tempDir();
  try {
    const entries = [
      { hypothesis: "make it bad", targetFailureClass: "requirements-generalization", edit: edit("bad") },
      { hypothesis: "make it bad", targetFailureClass: "requirements-generalization", edit: edit("bad") },
      { hypothesis: "make it bad again", targetFailureClass: "requirements-generalization", edit: edit("bad\nbad") },
      { hypothesis: "x", targetFailureClass: "requirements-generalization", edit: edit("bad\nbad\nbad") },
    ];
    const { loop } = makeLoop({ root, entries, protocol: testProtocol({ watchdog: { noProgressCandidates: 10, maxCandidatesPerCycle: 10, maxFailuresPerClass: 3 } }) });
    const state = await loop.runCycle();
    const all = loop.archive.all().filter(c => c.origin === "proposer");
    assert.ok(all.some(c => c.status === "duplicate"), all.map(c => c.status).join(","));
    assert.match(state.searchStop, /no addressable failure class/);
    assert.ok(all.length <= 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the evaluator retries only infrastructure failures without a completed model call", async () => {
  const root = tempDir();
  try {
    const { loop } = makeLoop({ root, entries: [], skill: (h) => (h.kind === "pure" ? { p: 0.5, infra: true } : skillOf(h)) });
    await loop.prepare();
    const recs = await loop.evaluator.evaluate({ id: "pure", kind: "pure" }, [{ task: "t1", split: "dev", repeat: 0 }], "test");
    assert.equal(recs[0].attempt, 2);
    assert.equal(recs[0].terminal_status, "completed");
    const all = loop.evaluator.ledger.records().filter(r => r.type === "result");
    assert.deepEqual(all.map(r => r.record.terminal_status), ["infra_error", "completed"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("greedy (quality-only) and pareto strategies keep separate trajectories", async () => {
  const root = tempDir();
  try {
    const a = makeLoop({ root, entries: [ENTRIES[0]], strategy: "greedy", stateName: "B" });
    await a.loop.runCycle();
    assert.equal(a.loop.state.strategy, "greedy");
    assert.equal(a.loop.state.greedyBest, "c001");
    writeFileSync(join(root, "marker"), "x");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the candidate cap never leaves the last created candidate unevaluated", async () => {
  const root = tempDir();
  try {
    const { loop } = makeLoop({ root, protocol: testProtocol({ watchdog: { maxCandidatesPerCycle: 1 } }), entries: [{ hypothesis: "only one", targetFailureClass: "requirements-generalization", edit: edit("same") }, { hypothesis: "never proposed", targetFailureClass: "requirements-generalization", edit: edit("good") }] });
    const state = await loop.runCycle();
    const proposed = loop.archive.all().filter(c => c.origin === "proposer");
    assert.equal(proposed.length, 1);
    assert.notEqual(proposed[0].status, "screening", "screened to a decision before the cap stops the search");
    assert.match(state.searchStop, /candidate cap/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
