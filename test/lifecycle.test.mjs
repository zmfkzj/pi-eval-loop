// Unattended-operation regressions on the simulated backend (no model, no sandbox): BLOCKED states resume at the phase they
// interrupted (decided cycles are never re-run), HALTED states are terminal for every entry point, holdout-use records are never
// re-associated, the supervised step (driveOnce) reports idle/cycle_done/blocked/halted, and the public summary is allowlisted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { edit, makeHoldout, makeLoop, makeTasks, makeUmbrella, HOLDOUT, TRAIN_DEV, rmSync, tempDir } from "./helpers.mjs";
import { HaltedError } from "../src/loop.mjs";
import { driveOnce } from "../src/cli.mjs";
import { inspectAblation, inspectState, stateSummary, statusSummary } from "../src/contract.mjs";
import { runAblation } from "../src/ablation.mjs";
import { Ledger } from "../src/util.mjs";

const GOOD = { hypothesis: "re-read requirements before finishing", targetFailureClass: "requirements-generalization", edit: edit("good") };

/**
 * A loop whose prerequisites can be switched off and on (a transient outage), over shared fixtures.
 * @param {string} root @param {any} [fx] @param {{ entries?: any[], stateName?: string, stopBefore?: string }} [options]
 */
function flaky(root, fx, { entries = [GOOD], stateName = "state", stopBefore } = {}) {
  const gate = { ok: true };
  const { loop, fx: fixtures } = makeLoop({ root, entries, fixtures: fx, stateName, prerequisites: async () => [{ name: "credentials", ok: gate.ok, detail: gate.ok ? "set" : "absent" }] });
  if (stopBefore) loop.stopBefore = stopBefore;
  return { loop, fx: fixtures, gate };
}
const uses = (fx) => new Ledger(join(fx.holdout.dir, "USES.jsonl")).records().length;
const results = (loop) => new Ledger(join(loop.stateDir, "runs.jsonl")).records().filter(r => r.type === "result");
const phasesSince = (loop, from) => loop.events.records().slice(from).filter(e => e.type === "phase").map(e => e.phase);
const stateFile = (loop) => JSON.parse(readFileSync(join(loop.stateDir, "state.json"), "utf8"));

/** Two failing resumes (fresh processes) keep the original resume phase; then the prerequisite returns. */
async function blockTwice(root, fx, expectedPhase) {
  for (let i = 0; i < 2; i++) {
    const { loop, gate } = flaky(root, fx);
    gate.ok = false;
    const r = await driveOnce(loop);
    assert.equal(r.kind, "blocked");
    const s = stateFile(loop);
    assert.equal(s.phase, "blocked");
    assert.equal(s.blocked.resumePhase, expectedPhase, `attempt ${i + 1}: resume phase kept`);
    assert.equal(s.blocked.retryable, true);
  }
}

test("BLOCKED on a finished cycle: two failing resumes keep resumePhase done, recovery is idle (no rerun, final/selection/holdout use unchanged)", async () => {
  const root = tempDir();
  try {
    const first = flaky(root);
    assert.equal((await driveOnce(first.loop)).kind, "cycle_done");
    const before = stateFile(first.loop);
    assert.equal(before.final.verdict, "ADOPT");
    const runs = results(first.loop).length, used = uses(first.fx), events = first.loop.events.records().length;
    await blockTwice(root, first.fx, "done");
    const { loop } = flaky(root, first.fx);
    const r = await driveOnce(loop);
    assert.equal(r.kind, "idle", JSON.stringify(r));
    const after = stateFile(loop);
    assert.equal(after.phase, "done");
    assert.equal(after.blocked, undefined);
    assert.deepEqual(after.final, before.final);
    assert.deepEqual(after.selection, before.selection);
    assert.deepEqual(after.holdoutUse, before.holdoutUse);
    assert.equal(after.cycleFingerprint, before.cycleFingerprint);
    assert.equal(results(loop).length, runs, "no unit evaluated");
    assert.equal(uses(first.fx), used, "holdout not consumed again");
    assert.deepEqual(phasesSince(loop, events), ["blocked", "blocked"], "no earlier phase repeated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("BLOCKED at post-adopt: recovery runs only the post-adoption smoke check; selection, verdict and holdout use are kept", async () => {
  const root = tempDir();
  try {
    const first = flaky(root, undefined, { stopBefore: "post-adopt" });
    await first.loop.runCycle();
    const before = stateFile(first.loop);
    assert.equal(before.phase, "post-adopt");
    const runs = results(first.loop).length, events = first.loop.events.records().length;
    await blockTwice(root, first.fx, "post-adopt");
    const { loop } = flaky(root, first.fx);
    assert.equal((await driveOnce(loop)).kind, "cycle_done");
    const after = stateFile(loop);
    assert.deepEqual(after.selection, before.selection);
    assert.equal(after.final.verdict, before.final.verdict);
    assert.equal(after.final.candidate, before.final.candidate);
    assert.deepEqual(after.holdoutUse, before.holdoutUse);
    assert.equal(uses(first.fx), 1);
    const added = results(loop).slice(runs);
    assert.ok(added.length >= 1 && added.every(r => r.record?.split === "post-adopt" || r.split === "post-adopt"), JSON.stringify(added.map(r => r.record?.split ?? r.split)));
    assert.deepEqual(phasesSince(loop, events), ["blocked", "blocked", "done"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("BLOCKED at adopt and at holdout: recovery continues at that phase; the holdout is used exactly once", async () => {
  for (const phase of ["adopt", "holdout"]) {
    const root = tempDir();
    try {
      const first = flaky(root, undefined, { stopBefore: phase });
      await first.loop.runCycle();
      const before = stateFile(first.loop);
      assert.equal(before.phase, phase);
      const events = first.loop.events.records().length;
      await blockTwice(root, first.fx, phase);
      const { loop } = flaky(root, first.fx);
      assert.equal((await driveOnce(loop)).kind, "cycle_done");
      const after = stateFile(loop);
      assert.deepEqual(after.selection, before.selection, `${phase}: selection frozen`);
      assert.equal(after.final.verdict, "ADOPT");
      assert.equal(uses(first.fx), 1, `${phase}: one holdout use`);
      const expected = phase === "adopt" ? ["blocked", "blocked", "post-adopt", "done"] : ["blocked", "blocked", "adopt", "post-adopt", "done"];
      assert.deepEqual(phasesSince(loop, events), expected);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("BLOCKED during search: recovery resumes the search (no baseline phase again)", async () => {
  const root = tempDir();
  try {
    const first = flaky(root, undefined, { stopBefore: "search" });
    await first.loop.runCycle();
    assert.equal(stateFile(first.loop).phase, "search");
    const events = first.loop.events.records().length;
    await blockTwice(root, first.fx, "search");
    const { loop } = flaky(root, first.fx);
    assert.equal((await driveOnce(loop)).kind, "cycle_done");
    const phases = phasesSince(loop, events);
    assert.equal(phases.includes("baselines"), false, phases.join(","));
    assert.equal(phases[2], "select");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an older blocked state without a resume phase after a decision fails closed (never restarts at prepare)", async () => {
  const root = tempDir();
  try {
    const first = flaky(root);
    await first.loop.runCycle();
    const s = stateFile(first.loop);
    writeFileSync(join(first.loop.stateDir, "state.json"), JSON.stringify({ ...s, phase: "blocked", blocked: { reason: "missing prerequisites" } }));
    const runs = results(first.loop).length;
    const { loop } = flaky(root, first.fx);
    assert.equal((await driveOnce(loop)).kind, "blocked");
    const after = stateFile(loop);
    assert.equal(after.phase, "blocked");
    assert.match(after.blocked.reason, /without a recorded resume phase/);
    assert.equal(after.blocked.retryable, false);
    assert.deepEqual(after.final, s.final);
    assert.equal(results(loop).length, runs);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a holdout-use record of another selection is never reused: HALTED, no holdout unit, no new use", async () => {
  const root = tempDir();
  try {
    const first = flaky(root, undefined, { stopBefore: "holdout" });
    await first.loop.runCycle();
    const s = stateFile(first.loop);
    writeFileSync(join(first.loop.stateDir, "state.json"), JSON.stringify({ ...s, holdoutUse: { type: "use", seq: 0, stateDir: first.loop.stateDir, protocolDigest: "other", selected: "c999", commit: "deadbeef", frozenDigest: "x" } }));
    const { loop } = flaky(root, first.fx);
    assert.equal((await driveOnce(loop)).kind, "halted");
    assert.match(stateFile(loop).halted, /holdout integrity/);
    assert.equal(uses(first.fx), 0);
    assert.equal(results(loop).filter(r => (r.record?.split ?? r.split) === "holdout").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trust-boundary breach: HALTED is durable; resume, prepare, selection, adoption, next cycle and verification all refuse", async () => {
  const root = tempDir();
  try {
    const fx = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
    let proposals = 0;
    const BREACH = { hypothesis: "edit the target checkout", targetFailureClass: "requirements-generalization", edit: () => { proposals++; writeFileSync(join(fx.orche, "breach.txt"), "x\n"); } };
    const { loop } = flaky(root, fx, { entries: [BREACH, GOOD] });
    assert.equal((await driveOnce(loop)).kind, "halted");
    const s = stateFile(loop);
    assert.match(s.halted, /trust boundary breach: orcheStatus/);
    assert.ok(s.haltedAt);
    assert.equal(s.phase, "search");
    assert.equal(s.searchStop, undefined, "a halt is not recorded as an interruption or stop reason");
    assert.equal(proposals, 1);
    const runs = results(loop).length;
    const again = flaky(root, fx, { entries: [GOOD] }).loop;
    assert.equal((await driveOnce(again)).kind, "halted");
    assert.equal((await again.runCycle()).phase, "search");
    await assert.rejects(() => again.prepare(), HaltedError);
    assert.throws(() => again.select(), HaltedError);
    await assert.rejects(() => again.holdout(), HaltedError);
    assert.throws(() => again.adopt(), HaltedError);
    assert.throws(() => again.nextCycle(), HaltedError);
    await assert.rejects(() => again.verifyStable({ tasks: [] }), HaltedError);
    assert.equal(results(again).length, runs, "nothing evaluated after the halt");
    assert.equal(uses(fx), 0);
    assert.equal(statusSummary(again.stateDir).condition, "halted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ablation: a breach in one trajectory halts all three; a rerun stops before any work", async () => {
  const root = tempDir();
  try {
    const fx = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
    const BREACH = { hypothesis: "edit the target checkout", targetFailureClass: "requirements-generalization", edit: () => writeFileSync(join(fx.orche, "breach.txt"), "x\n") };
    let built = 0;
    const loopFactory = async ({ stateDir, strategy }) => {
      built++;
      const name = stateDir.split("/").at(-1);
      return makeLoop({ root, fixtures: fx, stateName: join("abc", name), strategy, entries: name === "B" ? [BREACH] : name === "C" ? [GOOD, GOOD] : [] }).loop;
    };
    const r = await runAblation({ stateDir: join(root, "abc"), loopFactory });
    assert.equal(r.outcome, "halted", JSON.stringify(r));
    for (const arm of ["A", "B", "C"]) assert.ok(JSON.parse(readFileSync(join(root, "abc", arm, "state.json"), "utf8")).halted, `${arm} halted`);
    assert.equal(uses(fx), 0);
    built = 0;
    const again = await runAblation({ stateDir: join(root, "abc"), loopFactory });
    assert.equal(again.outcome, "halted");
    assert.equal(built, 0, "no trajectory is even constructed");
    assert.equal(inspectAblation(join(root, "abc")).halted.arm, "A");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ablation never re-seeds a trajectory whose records exist without state.json", async () => {
  const root = tempDir();
  try {
    const dir = join(root, "abc");
    mkdirSync(join(dir, "A"), { recursive: true });
    writeFileSync(join(dir, "A", "state.json"), JSON.stringify({ phase: "search", cycle: 1, counters: {} }));
    mkdirSync(join(dir, "B"), { recursive: true });
    writeFileSync(join(dir, "B", "runs.jsonl"), "{}\n");
    let built = 0;
    const r = await runAblation({ stateDir: dir, loopFactory: async () => { built++; throw new Error("must not build"); } });
    assert.equal(r.outcome, "state_error");
    assert.equal(built, 0);
    assert.equal(readFileSync(join(dir, "B", "runs.jsonl"), "utf8"), "{}\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("state health: fresh, present, missing (records without state.json), corrupt JSON and invalid structure", () => {
  const root = tempDir();
  try {
    assert.equal(inspectState(join(root, "none")).health, "fresh");
    mkdirSync(join(root, "empty", "worktrees"), { recursive: true });
    writeFileSync(join(root, "empty", ".lock"), "{}");
    assert.equal(inspectState(join(root, "empty")).health, "fresh", "lock files and empty directories are not records");
    mkdirSync(join(root, "lost"));
    writeFileSync(join(root, "lost", "events.jsonl"), "{}\n");
    assert.equal(inspectState(join(root, "lost")).health, "missing");
    mkdirSync(join(root, "bad"));
    writeFileSync(join(root, "bad", "state.json"), "{ not json");
    assert.equal(inspectState(join(root, "bad")).health, "corrupt");
    const C = { candidates: 0, noProgress: 0, consecutiveInfra: 0 };
    for (const broken of [[], { phase: "weird", cycle: 1, counters: C }, { phase: "search", cycle: 0, counters: C }, { phase: "search", cycle: 1, counters: {} }, { phase: "blocked", cycle: 1, counters: C },
      { phase: "holdout", cycle: 1, counters: C, selection: {} }, { phase: "holdout", cycle: 1, counters: C, selection: { selected: "", commit: "abc", frozenDigest: "f" } }, { phase: "holdout", cycle: 1, counters: C, selection: { selected: "c1", frozenDigest: "f" } },
      { phase: "blocked", cycle: 1, counters: C, blocked: { reason: "x", resumePhase: "holdout" }, selection: {} },
      { phase: "adopt", cycle: 1, counters: C, selection: { selected: "c1", commit: "abc", frozenDigest: "f" }, final: { adopt: false, candidate: "c1" } }]) {
      writeFileSync(join(root, "bad", "state.json"), JSON.stringify(broken));
      assert.equal(inspectState(join(root, "bad")).health, "corrupt", JSON.stringify(broken));
    }
    writeFileSync(join(root, "bad", "state.json"), JSON.stringify({ phase: "holdout", cycle: 1, counters: C, selection: { selected: null, frozenDigest: "f" } }));
    assert.equal(inspectState(join(root, "bad")).health, "present", "an A/B/C joint holdout pass may have no selected candidate");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("public summary: allowlisted fields only; historical interruptions never decide the condition", () => {
  const state = {
    phase: "blocked", cycle: 3, strategy: "pareto", counters: { candidates: 4, noProgress: 2 },
    blocked: { reason: "split validation failed", retryable: false, resumePhase: "search", problems: ["SECRET-PROBLEM task text"], missing: [{ name: "credentials", detail: "SECRET-DETAIL /home/x" }] },
    final: { verdict: "KEEP_STABLE", candidate: "c004", reasons: ["SECRET-REASON holdout family"] },
    searchStop: "watchdog", interrupted: { at: "2026-01-01T00:00:00Z", signal: "SIGTERM" }, selection: { selected: "c004", considered: ["SECRET-CANDIDATES"] },
  };
  const s = stateSummary(state);
  const text = JSON.stringify(s);
  for (const secret of ["SECRET-PROBLEM", "SECRET-DETAIL", "SECRET-REASON", "SECRET-CANDIDATES"]) assert.equal(text.includes(secret), false, secret);
  assert.equal(s.condition, "blocked");
  assert.deepEqual(s.blocked, { reason: "split validation failed", retryable: false, missing: ["credentials"], problemCount: 1 });
  assert.equal(s.resumePhase, "search");
  assert.deepEqual(s.lastInterruption, { at: "2026-01-01T00:00:00Z", signal: "SIGTERM" });
  assert.equal(s.final.reasonCount, 1);
  assert.equal(stateSummary({ ...state, phase: "search", blocked: undefined }).condition, "in_progress");
  assert.equal(stateSummary({ ...state, phase: "search", blocked: undefined }).searchStop, null, "a search-phase stop reason is stale");
  assert.equal(stateSummary({ ...state, phase: "done", cycleFingerprint: "f" }).condition, "cycle_complete");
});

test("an older `interrupted` field is migrated to lastInterruption history when a loop loads the state", async () => {
  const root = tempDir();
  try {
    const { loop, fx } = makeLoop({ root, entries: [] });
    await loop.prepare();
    const s = stateFile(loop);
    writeFileSync(join(loop.stateDir, "state.json"), JSON.stringify({ ...s, interrupted: { at: "t", signal: "SIGINT" } }));
    const again = makeLoop({ root, entries: [], fixtures: fx }).loop;
    assert.equal(again.state.interrupted, undefined);
    assert.deepEqual(again.state.lastInterruption, { at: "t", signal: "SIGINT" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a holdout phase without a frozen selection halts before any holdout use (defense in depth behind the state validation)", async () => {
  const root = tempDir();
  try {
    const first = flaky(root, undefined, { stopBefore: "holdout" });
    await first.loop.runCycle();
    const s = stateFile(first.loop);
    writeFileSync(join(first.loop.stateDir, "state.json"), JSON.stringify({ ...s, selection: {} }));
    const { loop } = flaky(root, first.fx);
    assert.equal((await driveOnce(loop)).kind, "halted");
    assert.match(stateFile(loop).halted, /without a frozen selection/);
    assert.equal(uses(first.fx), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a selection that differs from the one frozen before holdout access halts before any holdout use", async () => {
  const root = tempDir();
  try {
    const first = flaky(root, undefined, { stopBefore: "holdout" });
    await first.loop.runCycle();
    const s = stateFile(first.loop);
    assert.ok(s.selection.selected);
    writeFileSync(join(first.loop.stateDir, "state.json"), JSON.stringify({ ...s, selection: { ...s.selection, commit: "0".repeat(40) } }));
    const { loop } = flaky(root, first.fx);
    assert.equal((await driveOnce(loop)).kind, "halted");
    assert.match(stateFile(loop).halted, /differs from the one frozen/);
    assert.equal(uses(first.fx), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
