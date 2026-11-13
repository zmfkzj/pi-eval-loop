// protocol-4 end to end on the simulated backend (no model, no sandbox): the interleaved holdout pass and its crash/resume, the
// confirmatory plan (missing evidence blocks before anything is spent), the series budget, the original gates still blocking
// despite passing statistics, the independent confirmation on a separate sealed batch, and read-only handling of experiments
// recorded under an older protocol version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { edit, HOLDOUT, makeLoop, passingChecks, rmSync, sh, skillOf, tempDir, testProtocol, writeBoundState, fixtureLock } from "./helpers.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";
import { sealOf } from "../src/datasets.mjs";
import { registryOf } from "../src/supply.mjs";
import { seriesStatus } from "../src/design.mjs";
import { inspectState, statusSummary } from "../src/contract.mjs";
import { buildReport } from "../src/report.mjs";
import { DEFAULT_PROTOCOL, merge } from "../src/protocol.mjs";
import { Ledger, sha256 } from "../src/util.mjs";

const GOOD = [{ hypothesis: "re-read requirements before finishing", targetFailureClass: "requirements-generalization", edit: edit("good") }];

/** A complete, operator-written confirmatory plan (values chosen for the fixture, not recommendations). */
function confirmatoryProtocol(root, { alphaTotal = 0.1, confirmation = { required: false }, extra = {} } = {}) {
  mkdirSync(join(root, "plan"), { recursive: true });
  const text = "# Rationale (test fixture): sample size and effect size are illustrative only.\n";
  writeFileSync(join(root, "plan", "rationale.md"), text);
  return merge(testProtocol({
    holdout: { priorFamilyReuse: "forbid" },
    analysisPlan: { mode: "confirmatory", registeredAt: "2026-11-06T00:00:00Z", rationale: { document: join(root, "plan", "rationale.md"), sha256: sha256(text) }, minEffect: 0.1, alpha: 0.05, minTasks: 6, minFamilies: 4, minHardTasks: 1, permutationDraws: 2000,
      series: { id: "test-series", ledger: join(root, "plan", "series.jsonl"), alphaTotal }, lowExposure: { required: false }, confirmation },
  }), extra);
}

const stableRef = (fx) => { try { return sh(fx.orche, ["rev-parse", "refs/heads/eval-loop/stable"]); } catch { return null; } };
const holdoutUses = (fx) => new Ledger(join(fx.holdout.dir, "USES.jsonl")).records().length;

test("protocol-4 default (exploratory): interleaved holdout in planned order; a candidate passing every gate is EXPLORATORY_SUPPORTED, never adopted or deployed", async () => {
  const root = tempDir();
  try {
    const { loop, fx } = makeLoop({ root, entries: GOOD, protocol: testProtocol() });
    const stableBefore = stableRef(fx);
    const state = await loop.runCycle();
    assert.equal(state.final.verdict, "EXPLORATORY_SUPPORTED", JSON.stringify(state.final.reasons));
    assert.equal(state.final.adopt, false); assert.equal(state.final.candidateAccepted, true);
    assert.match(state.final.reasons.join(" "), /production adoption requires a complete, pre-registered confirmatory analysis plan/);
    assert.equal(state.phase, "done"); assert.equal(state.adoption, undefined, "the deployer was never reached");
    assert.equal(stableRef(fx), stableBefore, "the stable ref did not move");
    assert.equal(loop.archive.get("c001").status, "holdout_exploratory_supported");
    assert.equal((await loop.confirmAdoption()).verdict, "NOTHING_TO_CONFIRM");
    assert.ok(state.final.holdout.familySupport >= 0.95, "family-clustered support is required and recorded");
    assert.equal(state.final.evidence.class, "exploratory"); assert.equal(state.final.evidence.confirmatoryClaim, false);
    const acceptance = statusSummary(loop.stateDir).acceptance;
    assert.deepEqual({ stage: acceptance.stage, candidateAccepted: acceptance.candidateAccepted, productionAdopted: acceptance.productionAdopted, confirmed: acceptance.confirmed }, { stage: "candidate-accepted-exploratory", candidateAccepted: true, productionAdopted: false, confirmed: false });
    const schedule = JSON.parse(readFileSync(join(loop.stateDir, "holdout-schedule.json"), "utf8"));
    assert.equal(schedule.digest, state.holdoutSchedule.digest);
    assert.equal(schedule.units.length, HOLDOUT.length * 3 * 2);
    // Dispatch records of the holdout carry their planned position and appear in planned order with both arms interleaved.
    const dispatches = loop.evaluator.ledger.records().filter(r => r.type === "dispatch" && r.split === "holdout");
    assert.equal(dispatches.length, schedule.units.length);
    assert.deepEqual(dispatches.map(d => d.schedule.index), schedule.units.map(u => u.index));
    const firstHalf = dispatches.slice(0, dispatches.length / 2).map(d => d.harness.id);
    assert.ok(firstHalf.includes("stable") && firstHalf.includes("c001"), "no arm-by-arm time blocks");
    assert.equal(state.final.execution.mode, "interleaved"); assert.equal(state.final.execution.followsPlan, true);
    assert.equal(holdoutUses(fx), 1);
    const summary = statusSummary(loop.stateDir);
    assert.equal(summary.final.evidence.class, "exploratory"); assert.equal(summary.final.execution, "interleaved");
    assert.match(buildReport(loop.stateDir).markdown, /holdout execution: interleaved/);
    assert.match(buildReport(loop.stateDir).markdown, /Exploratory evidence only/);
    // The protocol-3 order stays available as an explicit, labelled choice.
    const seq = makeLoop({ root: join(root, "seq"), entries: GOOD, protocol: testProtocol({ holdout: { execution: "sequential" } }) });
    const s2 = await seq.loop.runCycle();
    assert.equal(s2.final.execution.mode, "sequential"); assert.match(s2.final.execution.note, /confounded/);
    assert.equal(s2.holdoutSchedule, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const crash of ["after-dispatch", "after-result", "before-schedule-save"]) {
  test(`interleaved holdout crash ${crash}: the resumed pass keeps the frozen schedule and its single use, reuses recorded units, never re-draws`, async () => {
    const root = tempDir();
    try {
      const protocol = testProtocol({ parallelism: 1 });
      const { loop, fx } = makeLoop({ root, entries: GOOD, protocol });
      loop.stopBefore = "holdout";
      await loop.runCycle();
      assert.equal(loop.state.phase, "holdout");
      const ev = loop.evaluator, runOne = ev.runOne.bind(ev);
      let holdoutCalls = 0;
      if (crash === "before-schedule-save") {
        const save = loop.save.bind(loop);
        loop.save = () => { if (loop.state.holdoutSchedule) throw new Error("killed before the schedule reached state.json"); save(); };
      } else {
        ev.runOne = async (h, u, ctx) => {
          if (u.split === "holdout" && ++holdoutCalls === 7) {
            if (crash === "after-dispatch") { ev.ledger.append({ type: "dispatch", unit_key: u.key, attempt: 1, run_id: "killed", controlDir: join(root, "no-such"), harness: { id: h.id, kind: h.kind }, task: u.task, split: u.split, repeat: u.repeat, context: ctx, simulated: true, schedule: { index: u.index, block: u.block, slot: u.slot } }); throw new Error("killed"); }
            await runOne(h, u, ctx); throw new Error("killed after the result was recorded");
          }
          return runOne(h, u, ctx);
        };
      }
      await assert.rejects(() => loop.holdout());
      assert.equal(holdoutUses(fx), 1, "consumed before the first run");
      const firstDigest = JSON.parse(readFileSync(join(loop.stateDir, "holdout-schedule.json"), "utf8")).digest;
      const resumed = makeLoop({ root, entries: GOOD, fixtures: fx, protocol }).loop;
      const state = await resumed.runCycle();
      assert.equal(state.phase, "done");
      assert.ok(["EXPLORATORY_SUPPORTED", "KEEP_STABLE", "INCONCLUSIVE"].includes(state.final.verdict), state.final.verdict);
      assert.equal(state.final.adopt, false, "exploratory: never adopted");
      assert.equal(holdoutUses(fx), 1, "the resumed pass reuses its own use");
      assert.equal(state.holdoutSchedule.digest, firstDigest);
      const recs = resumed.evaluator.ledger.records().filter(r => r.split === "holdout" || r.record?.split === "holdout");
      const results = recs.filter(r => r.type === "result");
      const keys = results.map(r => r.unit_key);
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
      assert.ok(dupes.length <= 1, `at most the reconciled unit has a retry (${dupes.length})`);
      if (crash === "after-dispatch") assert.equal(results.filter(r => r.reconciled).length, 1);
      assert.equal(new Set(keys).size, HOLDOUT.length * 3 * 2, "every scheduled unit has a result");
      assert.equal(state.final.execution.followsPlan, true, "first dispatches across the crash follow the plan");
      assert.deepEqual(resumed.evaluator.ledger.verify(), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("a changed schedule after the first run halts the holdout (never re-randomized)", async () => {
  const root = tempDir();
  try {
    const { loop, fx } = makeLoop({ root, entries: GOOD, protocol: testProtocol({ parallelism: 1 }) });
    loop.stopBefore = "holdout";
    await loop.runCycle();
    const ev = loop.evaluator, runOne = ev.runOne.bind(ev);
    let n = 0;
    ev.runOne = async (h, u, ctx) => { if (u.split === "holdout" && ++n === 3) throw new Error("killed"); return runOne(h, u, ctx); };
    await assert.rejects(() => loop.holdout());
    const s = JSON.parse(readFileSync(join(loop.stateDir, "state.json"), "utf8"));
    s.holdoutSchedule.digest = "0".repeat(64);
    writeFileSync(join(loop.stateDir, "state.json"), JSON.stringify(s));
    const resumed = makeLoop({ root, entries: GOOD, fixtures: fx, protocol: testProtocol({ parallelism: 1 }) }).loop;
    const state = await resumed.runCycle();
    assert.match(state.halted ?? "", /interleaved schedule differs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("confirmatory plan with a missing item blocks before the search: nothing run, holdout and series untouched", async () => {
  const root = tempDir();
  try {
    let runs = 0;
    const sim = simulatedBackend({ skill: skillOf, seed: "test" });
    const protocol = confirmatoryProtocol(root, { extra: { analysisPlan: { minEffect: null } } });
    const { loop, fx } = makeLoop({ root, entries: GOOD, protocol, backend: { simulated: true, run: (i) => { runs++; return sim.run(i); } } });
    const state = await loop.runCycle();
    assert.equal(state.phase, "blocked");
    assert.match(state.blocked.preflight.reasons.join(" "), /confirmatory analysis plan incomplete: analysisPlan.minEffect/);
    assert.match(state.blocked.reason, /^holdout preflight: confirmatory analysis plan incomplete/, "not reported as a supply shortage");
    assert.doesNotMatch(state.blocked.reason, /no independent, unused holdout/);
    assert.match(statusSummary(loop.stateDir).blocked.reason, /external input required/);
    assert.equal(runs, 0); assert.equal(holdoutUses(fx), 0);
    assert.equal(existsSync(join(root, "plan", "series.jsonl")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("confirmatory plan end to end: alpha spent before the holdout use, confirmatory checks pass, confirmatory (not generalized) claim; the exhausted series blocks the next experiment before its search", async () => {
  const root = tempDir();
  try {
    const protocol = confirmatoryProtocol(root, { alphaTotal: 0.05 });
    const { loop, fx } = makeLoop({ root, entries: GOOD, protocol });
    const state = await loop.runCycle();
    assert.equal(state.final.verdict, "ADOPT", JSON.stringify(state.final.reasons));
    assert.equal(state.final.confirmatory.ok, true);
    assert.ok(state.final.confirmatory.randomization.p <= 0.05);
    assert.equal(state.final.evidence.class, "confirmatory"); assert.equal(state.final.evidence.confirmatoryClaim, true); assert.equal(state.final.evidence.generalizedClaim, false);
    const series = seriesStatus(join(root, "plan", "series.jsonl"), "test-series");
    assert.equal(series.records.length, 1); assert.equal(series.records[0].purpose, "holdout");
    const useAt = new Ledger(join(fx.holdout.dir, "USES.jsonl")).records()[0].at;
    assert.ok(series.records[0].at <= useAt, "spent before the holdout was consumed");
    // The budget is exhausted: a second experiment (fresh holdout) is blocked at preflight, before any run.
    const { makeHoldout } = await import("./helpers.mjs");
    const fresh = makeHoldout(join(root, "batch-2"), HOLDOUT.map(([id, f, tier]) => [`${id}b`, `${f}b`, tier]));
    let runs = 0;
    const sim = simulatedBackend({ skill: skillOf, seed: "test" });
    const second = makeLoop({ root, entries: GOOD, protocol, fixtures: { ...fx, holdout: fresh }, stateName: "state2", backend: { simulated: true, run: (i) => { runs++; return sim.run(i); } } });
    const s2 = await second.loop.runCycle();
    assert.equal(s2.phase, "blocked"); assert.match(s2.blocked.preflight.reasons.join(" "), /error budget exhausted/);
    assert.equal(runs, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("passing statistics never override the original gates: failing adoption checks, a holdout integrity violation, a size-proxy-only hard stratum", async () => {
  const root = tempDir();
  try {
    // Candidate's adoption checks fail (precheck passes): BLOCKED although every statistic passes.
    const failing = async (worktree, which, logDir) => (String(logDir ?? "").includes("adoption-checks") && !String(logDir).includes("/stable/") ? { pass: false, results: { typecheck: { pass: false, exit: 1 }, test: { pass: false, exit: 1, failing: ["x"], tail: "" } } } : passingChecks());
    const a = makeLoop({ root: join(root, "a"), entries: GOOD, protocol: confirmatoryProtocol(join(root, "a")), checks: failing });
    const sa = await a.loop.runCycle();
    assert.equal(sa.final.verdict, "BLOCKED", JSON.stringify(sa.final.reasons)); assert.match(sa.final.reasons.join(" "), /test\/typecheck suite not passing/);
    // A task-agent integrity violation in a holdout run of the candidate: BLOCKED.
    const viol = (h, task, info) => (info?.split === "holdout" && String(h.id).startsWith("c") ? { ...skillOf(h), violation: true } : skillOf(h));
    const b = makeLoop({ root: join(root, "b"), entries: GOOD, protocol: confirmatoryProtocol(join(root, "b")), skill: viol });
    const sb = await b.loop.runCycle();
    assert.equal(sb.final.verdict, "BLOCKED"); assert.match(sb.final.reasons.join(" "), /critical/);
    // Only size-proxy "hard" tasks: no accepted hard stratum -> preflight blocks before the search.
    const c = makeLoop({ root: join(root, "c"), entries: GOOD, protocol: confirmatoryProtocol(join(root, "c"), { extra: { holdout: { hardBasis: ["curator"] } } }) });
    const sc = await c.loop.runCycle();
    assert.equal(sc.phase, "blocked"); assert.match(sc.blocked.preflight.reasons.join(" "), /no hard stratum/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the deployer is reached only with confirmatory evidence: an ADOPT decision without it halts at adopt (also on resume)", async () => {
  const forges = [(f) => { f.evidence = { ...f.evidence, class: "exploratory", confirmatoryClaim: false }; }, (f) => { f.confirmatory = { ...f.confirmatory, ok: false }; }];
  for (const forge of forges) {
    const root = tempDir();
    try {
      const { loop, fx } = makeLoop({ root, entries: GOOD });
      loop.stopBefore = "adopt";
      const stableBefore = stableRef(fx);
      await loop.runCycle();
      assert.equal(loop.state.phase, "adopt"); assert.equal(loop.state.final.verdict, "ADOPT");
      assert.equal(loop.state.final.evidence.confirmatoryClaim, true);
      // A decision whose evidence was carried over or edited (exploratory label, failed confirmatory checks) cannot deploy.
      forge(loop.state.final);
      loop.adopt();
      assert.match(loop.state.halted ?? "", /without confirmatory evidence/);
      assert.equal(loop.state.adoption, undefined);
      assert.equal(stableRef(fx), stableBefore);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

/** A pool with one sealed holdout-purpose batch of fresh tasks (families distinct from the experiment's holdout). */
function confirmationPool(root, specs) {
  const pool = join(root, "conf-pool"), batch = "bconfirm-1", dir = join(pool, "batches", batch);
  for (const [id, family, tier] of specs) {
    mkdirSync(join(dir, id, "repo/src"), { recursive: true });
    writeFileSync(join(dir, id, "repo/src/index.js"), `export const id = ${JSON.stringify(id)};\n`);
    writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, family, tier, instruction: `Solve ${id}`, provenance: "external" }));
  }
  const seal = sealOf(dir);
  writeFileSync(join(dir, "SEAL.json"), JSON.stringify({ createdAt: "test", ...seal }));
  registryOf(pool).append({ type: "batch", batch, dir: `batches/${batch}`, tasks: specs.map(s => s[0]), sealDigest: seal.digest, coverage: {} });
  return { pool, dir, batch };
}
const CONF = [["k1", "ka", "easy"], ["k2", "kb", "hard"], ["k3", "kc", "medium"], ["k4", "kd", "hard"], ["k5", "ke", "easy"], ["k6", "kf", "hard"]];

test("independent confirmation: separate purpose-bound reservation and seal, alpha spent, interleaved, CONFIRMED once; dormant without a plan; verify-stable refused under confirmatory plans", async () => {
  const root = tempDir();
  try {
    const { pool, dir } = confirmationPool(root, CONF);
    const protocol = confirmatoryProtocol(root, { alphaTotal: 0.1, confirmation: { required: true, pool, alpha: 0.05, minTasks: 6, minFamilies: 4 } });
    const { loop, fx } = makeLoop({ root, entries: GOOD, protocol });
    const state = await loop.runCycle();
    assert.equal(state.final.verdict, "ADOPT", JSON.stringify(state.final.reasons));
    assert.equal(state.final.evidence.confirmation, "required: pending");
    assert.equal((await loop.verifyStable({ tasks: [] })).verdict, "BLOCKED");
    const result = await loop.confirmAdoption();
    assert.equal(result.verdict, "CONFIRMED", JSON.stringify(result));
    assert.equal(result.execution.followsPlan, true);
    // Purpose-bound reservation: the confirmation batch, never the experiment's own holdout.
    const reserve = registryOf(pool).records().filter(r => r.type === "reserve");
    assert.equal(reserve.length, 1); assert.match(reserve[0].stateDir, /#confirmation$/); assert.equal(reserve[0].purpose, "confirmation");
    const uses = new Ledger(join(dir, "USES.jsonl")).records();
    assert.equal(uses.length, 1); assert.equal(uses[0].purpose, "confirmation");
    assert.equal(holdoutUses(fx), 1, "the experiment holdout is not reused");
    const series = seriesStatus(join(root, "plan", "series.jsonl"), "test-series");
    assert.deepEqual(series.records.map(r => r.purpose), ["holdout", "confirmation"]);
    // Decided once: a second call runs nothing.
    const before = loop.evaluator.ledger.records().length;
    assert.equal((await loop.confirmAdoption()).verdict, "CONFIRMED");
    assert.equal(loop.evaluator.ledger.records().length, before);
    assert.equal(statusSummary(loop.stateDir).confirmation.verdict, "CONFIRMED");
    // Dormant without a confirmatory plan: nothing reserved, consumed or run.
    const other = confirmationPool(join(root, "x"), CONF);
    const exp = makeLoop({ root: join(root, "x"), entries: GOOD });
    await exp.loop.runCycle();
    assert.equal(exp.loop.state.final.verdict, "ADOPT");
    const dormant = await exp.loop.confirmAdoption();
    assert.equal(dormant.verdict, "BLOCKED"); assert.equal(dormant.dormant, true);
    assert.equal(registryOf(other.pool).records().filter(r => r.type === "reserve").length, 0);
    assert.equal(existsSync(join(other.dir, "USES.jsonl")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an experiment recorded under protocol-3 is refused read-only: state, lock, records and report bytes unchanged; status stays readable", async () => {
  const root = tempDir();
  try {
    const { loop: probe, fx } = makeLoop({ root, entries: [] });
    void probe;
    const dir = join(root, "legacy");
    const p3 = structuredClone(DEFAULT_PROTOCOL); p3.version = "pi-eval-loop/protocol-3";
    for (const k of ["analysisPlan"]) delete p3[k];
    delete p3.holdout.execution; delete p3.holdout.maxOwnerShare; delete p3.holdout.priorFamilyReuse; delete p3.adoption.requireFamilyLevel;
    writeBoundState(dir, { phase: "done", cycle: 1, counters: { candidates: 1, noProgress: 0, consecutiveInfra: 0 }, final: { verdict: "BLOCKED", adopt: false, reasons: ["recorded"] }, holdoutUse: { seq: 0 }, selection: { selected: null, frozenDigest: "f" }, cycleFingerprint: "x" }, fixtureLock(p3));
    writeFileSync(join(dir, "runs.jsonl"), ""); writeFileSync(join(dir, "report.md"), "recorded report\n");
    // Files only: constructing any Loop creates its (empty) working directories, as before protocol-4.
    const snap = () => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && !e.name.startsWith(".lock")).map(e => [e.name, readFileSync(join(dir, e.name), "utf8")]));
    const before = snap();
    assert.equal(inspectState(dir).health, "present");
    assert.equal(statusSummary(dir).condition, "cycle_complete");
    const { loop } = makeLoop({ root, entries: [], fixtures: fx, stateName: "legacy" });
    const { driveOnce } = await import("../src/cli.mjs");
    const r = await driveOnce(loop);
    assert.equal(r.kind, "blocked");
    assert.equal(loop.readOnlyRefusal, true);
    assert.match(loop.state.blocked.reason, /protocol version pi-eval-loop\/protocol-3/);
    assert.deepEqual(snap(), before, "nothing in the recorded experiment changed");
    assert.equal(sh(fx.orche, ["status", "--porcelain"]), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
