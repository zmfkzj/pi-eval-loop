// Autonomous lifecycle end to end (2026-11-07): exploration -> registered confirmation -> gate-driven adoption (release pointer)
// -> smoke -> independent post-adoption confirmation, through runExploreCycle / the CLI with a simulated target model, the real
// budget ledger, pool, lineage, seal, reservation, one-use ledgers, series alpha ledger and the release history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { caseDigest, poolState, registryOf } from "../src/supply.mjs";
import { holdoutLedger, sealOf } from "../src/datasets.mjs";
import { RequestBudget } from "../src/request-budget.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";
import { runtimeDigest } from "../src/exploration.mjs";
import { Releases, floorProblems, testProtocol } from "../src/lifecycle.mjs";
import { explorePreflight, exploreStatus, refreshExploration, runExploreCycle } from "../src/explore-cycle.mjs";
import { Ledger, sha256 } from "../src/util.mjs";
import { exploreProtocol } from "../src/exploration.mjs";
import { merge } from "../src/protocol.mjs";

const LIFECYCLE = fileURLToPath(new URL("../src/lifecycle.mjs", import.meta.url));
const SRC = { dataset: "Exercism TS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
function tree(dir, text) { mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src", "x.ts"), text); writeFileSync(join(dir, "package.json"), "{}"); return dir; }
function dataset(dir, specs) { for (const [id, family] of specs) { mkdirSync(join(dir, id, "repo"), { recursive: true }); writeFileSync(join(dir, id, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, family, tier: "easy", instruction: `Solve ${id}`, provenance: "external" })); } writeFileSync(join(dir, "SEAL.json"), JSON.stringify(sealOf(dir))); return dir; }
function stage(pool, id, family, hard) {
  const d = join(pool, "cases", id);
  for (const p of ["repo", "hidden", "reference"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(d, "hidden", "h.test.js"), "// h\n"); writeFileSync(join(d, "reference", "index.js"), "// r\n");
  writeFileSync(join(d, "task.json"), JSON.stringify({ id, family, tier: hard ? "hard" : "easy", instruction: `Solve ${id}`, provenance: "external", ...(hard ? { difficultyBasis: "source", difficultySource: SRC } : {}) }));
  writeFileSync(join(d, "validation.private.json"), JSON.stringify({ ok: true, code: "valid" }));
  registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family, tier: hard ? "hard" : "easy", difficultyBasis: hard ? "source" : "declared", contentDigest: caseDigest(d) });
}
const stageN = (pool, tag, n) => { for (let i = 1; i <= n; i++) stage(pool, `${tag}${i}`, `gh:${tag}${i}/r`, i === 1); };

/** A world: arms, screen (with measured runs), lineage, pool, registered confirmatory protocol + readiness, release dir. */
function world(root, { ready = "fulfilled", limit = 4500, alphaTotal = 0.2, confirmationRequired = true, apu = 6, minRemaining = 120, route, registeredRoute = route, screenRoute = route } = {}) {
  const cand = tree(join(root, "cand"), "export const c = 1;\n"), stable = tree(join(root, "stable"), "export const s = 1;\n");
  const report = join(root, "screen-report.json"); writeFileSync(report, JSON.stringify({ accepted: true, ...(screenRoute ? { route: screenRoute } : {}) }));
  const runs = join(root, "screen-runs.jsonl"); writeFileSync(runs, `${JSON.stringify({ type: "result", record: { model_requests: 5, ...(screenRoute ? { model_route: `${screenRoute.provider}/${screenRoute.model}`, thinking_effort: screenRoute.effort } : {}) } })}\n`);
  const reg = join(root, "old-registry.jsonl"); new Ledger(reg).append({ type: "case", caseId: "x-old-1", family: "gh:old/repo", status: "eligible" });
  const pool = join(root, "pool"); mkdirSync(pool, { recursive: true }); mkdirSync(join(root, "orche"));
  writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false }));
  const rationale = join(root, "rationale.md"); writeFileSync(rationale, "power simulation (fixture)\n");
  const protocol = { ...(registeredRoute ? { route: registeredRoute } : {}), holdout: { repeats: 3, minTasks: 8, minFamilies: 8, acceptedProvenance: ["external", "private-reviewed"], hardBasis: ["source"], execution: "interleaved", maxOwnerShare: 0.5, priorFamilyReuse: "forbid", privateReview: "cross-provider" }, adoption: { requireFamilyLevel: true },
    analysisPlan: { mode: "confirmatory", registeredAt: "2026-11-07T00:00:00Z", rationale: { document: rationale, sha256: sha256(readFileSync(rationale)) }, minEffect: 0.05, alpha: 0.05, minTasks: 8, minFamilies: 8, minHardTasks: 1, permutationDraws: 2000,
      series: { id: "test-series", ledger: join(root, "series", "ledger.jsonl"), alphaTotal }, lowExposure: { required: false, minTasks: null, provenance: ["private-reviewed"] }, confirmation: { required: confirmationRequired, pool, alpha: 0.05, minTasks: 8, minFamilies: 8 } } };
  const protoFile = join(root, "protocol.json"); writeFileSync(protoFile, JSON.stringify(protocol));
  const readiness = join(root, "readiness.json"); writeFileSync(readiness, JSON.stringify({ protocolSha256: sha256(readFileSync(protoFile)), conditions: [{ id: "analysis-plan", status: ready, reasons: ready === "fulfilled" ? [] : ["power not established"] }] }));
  const cfg = { schema: "pi-eval-loop/exploration@1", mode: "autonomous", ...(route ? { route } : {}), seriesSeed: "lc", candidate: { dir: cand, identity: { commit: "cand@1", runtimeDigest: runtimeDigest(cand) } }, stable: { dir: stable, commit: "stable@1", runtimeDigest: runtimeDigest(stable) },
    screen: { report, reportSha256: sha256(readFileSync(report)), runs, tasks: [{ id: "d1", dataset: dataset(join(root, "screen-tasks"), [["d1", "gh:dev/x"]]) }] }, pool, lineage: { registries: [reg], datasets: [dataset(join(root, "old-holdout"), [["o1", "gh:old/ds"]])] },
    budget: { ledger: join(root, "budget", "ledger.jsonl"), limit, scope: "lc", minRemaining }, runtime: { simulated: true }, simulation: { enabled: true, p: { stable: 0.05, c1: 0.95 } }, orcheDir: join(root, "orche"), parallelism: 2,
    batchRule: { seed: "lc", maxTasks: 6, maxPerFamily: 1, maxPerOwner: 3, maxOwnerShare: 0.5, preferFreshFamilies: true }, supply: { collector: "none" },
    confirmation: { protocol: protoFile, protocolSha256: sha256(readFileSync(protoFile)), readiness, attemptsPerUnit: apu, smokeAttempts: 10, deploy: { dir: join(root, "deploy") } } };
  const file = join(root, "lifecycle.json"); writeFileSync(file, JSON.stringify(cfg));
  const W = { p: { stable: 0.05, c1: 0.95 }, smokeFail: false };
  const inner = simulatedBackend({ seed: "lc", skill: (h, t, o) => ({ p: W.p[h.id] ?? 0.5, crash: W.smokeFail && o.split === "smoke" }) });
  // Every target call with the route the engine handed to the backend (the runner uses exactly this protocol.route).
  const calls = [];
  const backend = { simulated: true, run: (input) => { calls.push({ split: input.split, context: input.context, route: { ...input.protocol.route }, proposer: input.protocol.proposer.route.model }); return inner.run(input); } };
  const deps = { backend, orcheDir: cfg.orcheDir };
  const ledger = () => new RequestBudget({ path: cfg.budget.ledger, limit, scope: "lc" }).status();
  return { cfg, file, pool, W, deps, ledger, calls, releases: new Releases(cfg.confirmation.deploy.dir) };
}
const refresh = async (w) => refreshExploration(w.file, { deps: { orcheDir: w.cfg.orcheDir } });
const uses = (pool) => [...poolState(pool).batches.values()].reduce((n, b) => n + (existsSync(join(pool, "batches", b.batch, "USES.jsonl")) ? holdoutLedger(join(pool, "batches", b.batch)).records().length : 0), 0);

test("lifecycle: supported exploration -> registered confirmation (waits for supply) -> ADOPT -> release -> smoke -> CONFIRMED; acceptance/ADOPT/deployed/CONFIRMED stay distinct; next cycle sees the candidate deployed", { timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    const w = world(root);
    stageN(w.pool, "e", 6);
    assert.equal((await refresh(w)).code, 0);
    const state = join(root, "c-1");
    let o = await runExploreCycle(w.file, state, { deps: w.deps });
    assert.equal(o.outcome, "blocked", JSON.stringify(o.status?.blocked));
    assert.equal(o.status.lifecycle.stage, "confirm-wait"); assert.equal(o.status.exploration.code, "confirmation-supply-empty"); assert.equal(o.status.blocked.retryable, true);
    assert.equal(o.status.lifecycle.explorationVerdict, "EXPLORATORY_SUPPORTED");
    assert.equal(o.status.acceptance.stage, "candidate-accepted-exploratory"); assert.equal(o.status.acceptance.productionAdopted, false);
    const regSha = JSON.parse(readFileSync(join(state, "explore.json"), "utf8")).registrationSha256;
    assert.ok(existsSync(join(state, "registration.json")) && regSha, "registration frozen before any confirmatory outcome");
    assert.equal(w.releases.current().runtimeDigest, w.cfg.stable.runtimeDigest, "nothing deployed yet");
    // Confirmatory supply arrives: two 8-task batches (holdout + separate post-adoption confirmation).
    stageN(w.pool, "k", 8); assert.equal((await refresh(w)).out.sealed[0]?.purpose, "confirmatory");
    // A second confirmatory batch is not sealed while an unused one is still available (supply is not consumed ahead of need).
    stageN(w.pool, "m", 8); assert.equal((await refresh(w)).out.sealed.length, 0);
    o = await runExploreCycle(w.file, state, { requireState: true, deps: w.deps });
    assert.equal(o.status.lifecycle.stage, "postconfirm-wait", JSON.stringify(o.status.lifecycle));
    assert.equal(o.status.acceptance.stage, "adopted-unconfirmed");
    assert.equal((await refresh(w)).out.sealed[0]?.purpose, "confirmatory", "the post-adoption confirmation batch is sealed once the first is used");
    o = await runExploreCycle(w.file, state, { requireState: true, deps: w.deps });
    assert.equal(o.outcome, "cycle_done", JSON.stringify(o.status?.blocked ?? o));
    const st = o.status;
    assert.equal(st.lifecycle.outcome, "confirmed"); assert.equal(st.lifecycle.confirmVerdict, "ADOPT"); assert.equal(st.lifecycle.confirmation, "CONFIRMED");
    assert.equal(st.final.adopt, true); assert.equal(st.final.explorationOnly, false); assert.equal(st.final.evidence.class, "confirmatory"); assert.equal(st.final.evidence.confirmatoryClaim, true);
    assert.equal(st.acceptance.stage, "adopted-confirmed"); assert.equal(st.acceptance.productionAdopted, true); assert.equal(st.acceptance.confirmed, true);
    assert.equal(w.releases.current().runtimeDigest, w.cfg.candidate.identity.runtimeDigest, "the release pointer moved to the candidate");
    assert.equal(uses(w.pool), 3, "exploration, confirmatory holdout and confirmation each used once");
    const series = new Ledger(join(root, "series", "ledger.jsonl")).records().filter(r => r.type === "spend");
    assert.deepEqual(series.map(r => r.purpose).sort(), ["confirmation", "holdout"], "alpha spent once per confirmatory test");
    // Retry: idle, nothing dispatched.
    const before = w.ledger().charged;
    o = await runExploreCycle(w.file, state, { requireState: true, deps: w.deps });
    assert.equal(o.outcome, "idle"); assert.equal(w.ledger().charged, before);
    // Next cycle: the candidate is now the deployed release -> no exploration (stop, model-free).
    const pf = await explorePreflight(w.file, join(root, "c-2"), { orcheDir: w.cfg.orcheDir });
    assert.equal(pf.code, "candidate-deployed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lifecycle: unsupported exploration is never promoted (no registration, no adoption)", { timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    const w = world(root);
    w.W.p = { stable: 0.5, c1: 0.5 };
    stageN(w.pool, "e", 6); await refresh(w);
    let o = await runExploreCycle(w.file, join(root, "neg"), { deps: w.deps });
    assert.equal(o.outcome, "cycle_done"); assert.equal(o.status.lifecycle.outcome, "explored-negative");
    assert.equal(existsSync(join(root, "neg", "registration.json")), false);
    assert.equal(w.releases.current().runtimeDigest, w.cfg.stable.runtimeDigest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lifecycle: confirmatory gate rejection (candidate worse on the confirmatory holdout) ends unadopted", { timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    const w = world(root);
    stageN(w.pool, "e", 6); await refresh(w);
    const state = join(root, "c");
    let o = await runExploreCycle(w.file, state, { deps: w.deps });
    assert.equal(o.status.lifecycle.stage, "confirm-wait");
    stageN(w.pool, "k", 8); await refresh(w);
    w.W.p = { stable: 0.9, c1: 0.1 };
    o = await runExploreCycle(w.file, state, { requireState: true, deps: w.deps });
    assert.equal(o.status.lifecycle.outcome, "confirm-negative", JSON.stringify(o.status.lifecycle));
    assert.equal(o.status.final.adopt, false); assert.equal(o.status.acceptance.productionAdopted, false);
    assert.equal(w.releases.current().runtimeDigest, w.cfg.stable.runtimeDigest, "never deployed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [name, setup, expectConfirmation] of [
  ["smoke failure", (W) => { W.smokeFail = true; }, null],
  ["post-adoption confirmation NOT_CONFIRMED", (W) => { W.flipAfterAdopt = { stable: 0.9, c1: 0.1 }; }, "NOT_CONFIRMED"],
  ["post-adoption confirmation INCONCLUSIVE (tied arms)", (W) => { W.flipAfterAdopt = { stable: 0.6, c1: 0.6 }; }, "NOT_CONFIRMED|INCONCLUSIVE"],
]) {
  test(`lifecycle: ${name} rolls the release back and stops`, { timeout: 300_000 }, async () => {
    const root = tempDir();
    try {
      const w = world(root);
      stageN(w.pool, "e", 6); await refresh(w);
      const state = join(root, "c");
      let o = await runExploreCycle(w.file, state, { deps: w.deps });
      stageN(w.pool, "k", 8); await refresh(w);
      setup(w.W);
      if (w.W.flipAfterAdopt) {
        // Run until the post-confirmation waits for its batch, then change the arms' behaviour and supply the batch.
        o = await runExploreCycle(w.file, state, { requireState: true, deps: w.deps });
        assert.equal(o.status.lifecycle.stage, "postconfirm-wait", JSON.stringify(o.status.lifecycle));
        assert.equal(o.status.acceptance.stage, "adopted-unconfirmed"); assert.equal(o.status.acceptance.confirmed, false);
        assert.equal(w.releases.current().runtimeDigest, w.cfg.candidate.identity.runtimeDigest);
        w.W.p = w.W.flipAfterAdopt;
        stageN(w.pool, "m", 8); await refresh(w);
      }
      o = await runExploreCycle(w.file, state, { requireState: true, deps: w.deps });
      assert.equal(o.status.lifecycle.outcome, "rolled-back", JSON.stringify(o.status.lifecycle));
      assert.equal(o.status.lifecycle.rolledBack, true); assert.equal(o.status.final.adopt, false); assert.equal(o.status.final.rolledBack, true);
      if (expectConfirmation) assert.match(o.status.lifecycle.confirmation, new RegExp(expectConfirmation));
      assert.equal(o.status.acceptance.stage, "rolled-back"); assert.equal(o.status.acceptance.productionAdopted, false);
      assert.equal(w.releases.current().runtimeDigest, w.cfg.stable.runtimeDigest, "the previous release is deployed again");
      const h = w.releases.history.records().map(r => r.type);
      assert.deepEqual(h, ["init", "adopt", "rollback"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("lifecycle readiness: provisional plan, an unbound readiness record, a weakening protocol and an unaffordable confirmation never start an exploration (no attempt, no batch)", { timeout: 120_000 }, async () => {
  const root = tempDir();
  try {
    const w = world(root, { ready: "provisional" });
    stageN(w.pool, "e", 6); await refresh(w);
    let pf = await explorePreflight(w.file, join(root, "x"), { orcheDir: w.cfg.orcheDir });
    assert.equal(pf.code, "confirmation-plan-not-ready"); assert.match(pf.reasons.join(" "), /provisional/);
    const o = await runExploreCycle(w.file, join(root, "x"), { deps: w.deps });
    assert.equal(o.status.exploration.code, "confirmation-plan-not-ready"); assert.equal(o.status.blocked.retryable, true);
    assert.equal(w.ledger().charged, 0); assert.equal(poolState(w.pool).records.filter(r => r.type === "reserve").length, 0);
    // Readiness record not bound to this protocol.
    writeFileSync(w.cfg.confirmation.readiness, JSON.stringify({ conditions: [{ id: "analysis-plan", status: "fulfilled" }] }));
    pf = await explorePreflight(w.file, join(root, "x2"), { orcheDir: w.cfg.orcheDir });
    assert.equal(pf.code, "confirmation-plan-not-ready"); assert.match(pf.reasons.join(" "), /not bound to this protocol/);
    // A tight ledger: the registered confirmation cannot be afforded after the exploration.
    const root2 = tempDir();
    const t = world(root2, { limit: 600 });
    pf = await explorePreflight(t.file, join(root2, "x"), { orcheDir: t.cfg.orcheDir });
    assert.equal(pf.code, "confirmation-infeasible"); assert.match(pf.reasons.join(" "), /never raised/);
    rmSync(root2, { recursive: true, force: true });
    // Floors: a registered protocol cannot weaken the original gates; confirmation minima never fall below the holdout floors.
    const weak = merge(exploreProtocol(), { holdout: { minTasks: 3, repeats: 1 }, adoption: { support: 0.5, requireChecks: false } });
    assert.ok(floorProblems(weak).length >= 4);
    const part = testProtocol({ holdout: { minTasks: 8, minFamilies: 8 }, adoption: {}, analysisPlan: { alpha: 0.05, minTasks: 8, minFamilies: 8, confirmation: { alpha: 0.05, minTasks: 2, minFamilies: 1 } } }, "confirmation");
    assert.ok(part.analysisPlan.minTasks >= 6 && part.holdout.minFamilies >= 4);
    // attemptsPerUnit below the measured per-unit maximum is a config error.
    const root3 = tempDir();
    const a = world(root3, { apu: 2 });
    pf = await explorePreflight(a.file, join(root3, "x"), { orcheDir: a.cfg.orcheDir });
    assert.equal(pf.code, "config-invalid"); assert.match(pf.reasons.join(" "), /below the measured per-unit maximum/);
    rmSync(root3, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lifecycle restart: a crash inside the confirmatory pass resumes with one use and one alpha spend; stale candidate after promotion is refused", { timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    const w = world(root, { confirmationRequired: false });
    stageN(w.pool, "e", 6); await refresh(w);
    const state = join(root, "c");
    await runExploreCycle(w.file, state, { deps: w.deps });
    stageN(w.pool, "k", 8); await refresh(w);
    // SIGKILL right after the confirmatory batch use was recorded (child process, config-simulated target model).
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { runExploreCycle } from ${JSON.stringify(fileURLToPath(new URL("../src/explore-cycle.mjs", import.meta.url)))}; await runExploreCycle(${JSON.stringify(w.file)}, ${JSON.stringify(state)}, { requireState: true, deps: { orcheDir: ${JSON.stringify(w.cfg.orcheDir)} } });`], { encoding: "utf8", env: { ...process.env, EVAL_LOOP_FAULT: "holdout:after-use" } });
    assert.equal(child.signal, "SIGKILL", child.stderr.slice(0, 400));
    const o = await runExploreCycle(w.file, state, { requireState: true, deps: w.deps });
    assert.equal(o.status.lifecycle.outcome, "adopted", JSON.stringify(o.status.lifecycle ?? o));
    assert.equal(o.status.final.evidence.confirmation, "not-registered"); assert.equal(o.status.acceptance.stage, "adopted-unconfirmed");
    assert.equal(uses(w.pool), 2);
    assert.equal(new Ledger(join(root, "series", "ledger.jsonl")).records().filter(r => r.type === "spend").length, 1);
    // Stale candidate: a second world whose candidate tree changes after promotion.
    const root2 = tempDir();
    const v = world(root2);
    stageN(v.pool, "e", 6); await refreshExploration(v.file, { deps: { orcheDir: v.cfg.orcheDir } });
    const s2 = join(root2, "c");
    const first = await runExploreCycle(v.file, s2, { deps: v.deps });
    assert.equal(first.status.lifecycle.stage, "confirm-wait");
    writeFileSync(join(v.cfg.candidate.dir, "src", "x.ts"), "export const c = 2;\n");
    const second = await runExploreCycle(v.file, s2, { requireState: true, deps: v.deps });
    assert.equal(second.status.exploration.code, "prerequisite-failed");
    rmSync(root2, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [fault, op] of [["release:after-store", "adopt"], ["release:after-record", "adopt"], ["release:after-record", "rollback"]]) {
  test(`release pointer: SIGKILL at ${fault} during ${op} recovers to one consistent deployed release`, () => {
    const root = tempDir();
    try {
      const a = tree(join(root, "a"), "a\n"), b = tree(join(root, "b"), "b\n");
      const R = new Releases(join(root, "deploy"));
      R.init({ dir: a, runtimeDigest: runtimeDigest(a), commit: "a" });
      if (op === "rollback") R.adopt({ key: "k", expect: runtimeDigest(a), candidate: { dir: b, runtimeDigest: runtimeDigest(b), commit: "b" }, evidence: {} });
      const script = op === "adopt" ? `new R.Releases(${JSON.stringify(join(root, "deploy"))}).adopt({ key: "k", expect: ${JSON.stringify(runtimeDigest(a))}, candidate: { dir: ${JSON.stringify(b)}, runtimeDigest: ${JSON.stringify(runtimeDigest(b))}, commit: "b" }, evidence: {} });` : `new R.Releases(${JSON.stringify(join(root, "deploy"))}).rollback({ key: "k", reason: "t" });`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as R from ${JSON.stringify(LIFECYCLE)};\n${script}`], { encoding: "utf8", env: { ...process.env, EVAL_LOOP_FAULT: fault } });
      assert.equal(r.signal, "SIGKILL", r.stderr.slice(0, 300));
      const R2 = new Releases(join(root, "deploy"));
      const cur = R2.current({ repair: true });
      const ptr = JSON.parse(readFileSync(join(root, "deploy", "current.json"), "utf8"));
      assert.equal(ptr.release, cur.release, "pointer repaired from the history");
      const want = op === "adopt" ? (fault === "release:after-store" ? runtimeDigest(a) : runtimeDigest(b)) : runtimeDigest(a);
      assert.equal(cur.runtimeDigest, want);
      // A retry converges (idempotent) and leaves exactly one adopt (and at most one rollback) record.
      if (op === "adopt") R2.adopt({ key: "k", expect: runtimeDigest(a), candidate: { dir: b, runtimeDigest: runtimeDigest(b), commit: "b" }, evidence: {} });
      else R2.rollback({ key: "k", reason: "t" });
      const types = R2.history.records().map(x => x.type);
      assert.equal(types.filter(x => x === "adopt").length, 1);
      assert.ok(types.filter(x => x === "rollback").length <= 1);
      assert.equal(R2.current().runtimeDigest, op === "adopt" ? runtimeDigest(b) : runtimeDigest(a));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

void exploreStatus; void sealOf;

test("lifecycle ledger exhaustion: headroom for the selected confirmatory batch (+ post-confirmation + smoke) is checked before reserving or consuming it", { timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    const w = world(root);
    stageN(w.pool, "e", 6); await refresh(w);
    const state = join(root, "c");
    let o = await runExploreCycle(w.file, state, { deps: w.deps });
    assert.equal(o.status.lifecycle.stage, "confirm-wait");
    stageN(w.pool, "k", 8); assert.equal((await refresh(w)).out.sealed.length, 1);
    // Another use of the same cumulative ledger leaves less than this pass needs (8 tasks x 3 repeats x 2 arms x 6 + post + smoke).
    const b = new RequestBudget({ path: w.cfg.budget.ledger, limit: 4500, scope: "lc" });
    const left = b.status().remaining;
    const t = await b.reserve(left - 300, { test: "other use" }); await b.settle(t, left - 300, { test: "other use" });
    const charged = w.ledger().charged, usesBefore = uses(w.pool);
    o = await runExploreCycle(w.file, state, { requireState: true, deps: w.deps });
    assert.equal(o.status.exploration.code, "confirmation-infeasible", JSON.stringify(o.status.blocked));
    assert.equal(o.status.blocked.retryable, false);
    assert.match(o.status.blocked.reason, /never raised/);
    assert.equal(w.ledger().charged, charged, "no attempt");
    assert.equal(uses(w.pool), usesBefore, "the confirmatory batch was not consumed");
    assert.equal(poolState(w.pool).records.filter(r => r.type === "reserve").length, 1, "only the exploration batch was ever reserved");
    assert.equal(w.releases.current().runtimeDigest, w.cfg.stable.runtimeDigest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const TERRA = Object.freeze({ provider: "cliproxyapi", model: "gpt-6.1-terra", effort: "medium" });
const runRecords = (file) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => e.type === "result").map(e => e.record) : [];

test("lifecycle target route: an explicit cliproxyapi/gpt-6.1-terra reaches exploration, confirmation, deployment smoke and post-confirmation (records, plans, registration), the proposer route is untouched", { timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    const w = world(root, { route: TERRA });
    stageN(w.pool, "e", 6); assert.equal((await refresh(w)).code, 0);
    const state = join(root, "c-1");
    let o = await runExploreCycle(w.file, state, { deps: w.deps });
    assert.equal(o.status.lifecycle.stage, "confirm-wait", JSON.stringify(o.status?.blocked));
    stageN(w.pool, "k", 8); await refresh(w);
    o = await runExploreCycle(w.file, state, { requireState: true, deps: w.deps });
    assert.equal(o.status.lifecycle.stage, "postconfirm-wait", JSON.stringify(o.status?.blocked ?? o.status?.lifecycle));
    stageN(w.pool, "m", 8); await refresh(w);
    o = await runExploreCycle(w.file, state, { requireState: true, deps: w.deps });
    assert.equal(o.outcome, "cycle_done", JSON.stringify(o.status?.blocked ?? o));
    assert.equal(o.status.lifecycle.outcome, "confirmed");
    // Every phase dispatched target calls, all with the selected route; the proposer keeps its own default route.
    assert.deepEqual([...new Set(w.calls.map(c => c.split))].sort(), ["holdout", "smoke"]);
    assert.deepEqual(new Set(w.calls.map(c => c.context)).size >= 2, true);
    assert.ok(w.calls.every(c => c.route.provider === TERRA.provider && c.route.model === TERRA.model && c.route.effort === TERRA.effort), JSON.stringify(w.calls.find(c => c.route.model !== TERRA.model)));
    assert.ok(w.calls.every(c => c.proposer === "gpt-6.1-sol"));
    for (const sub of ["holdout", "confirm", "smoke", "postconfirm"]) {
      const recs = runRecords(join(state, sub, "runs.jsonl"));
      assert.ok(recs.length > 0, `${sub} has records`);
      assert.ok(recs.every(r => r.model_route === "cliproxyapi/gpt-6.1-terra" && r.thinking_effort === "medium"), `${sub}: every evidence record names the selected model_route`);
    }
    for (const f of ["plan.json", "confirm-plan.json", "postconfirm-plan.json", "registration.json", "protocol.lock.json"]) assert.deepEqual(JSON.parse(readFileSync(join(state, f), "utf8")).route, TERRA, `${f} binds the route`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lifecycle target route: luna-registered protocol, luna integrity screen or luna-measured attempts never start a Terra exploration; provider, model and effort are each part of the identity; malformed routes are config errors", { timeout: 120_000 }, async () => {
  const root = tempDir();
  try {
    const pre = async (w, dir) => explorePreflight(w.file, join(root, dir), { orcheDir: w.cfg.orcheDir });
    const LUNA = { provider: "cliproxyapi", model: "gpt-6-luna", effort: "medium" };
    // Registered without a route = registered on the package default (luna): refused for a Terra target.
    let w = world(join(root, "a"), { route: TERRA, registeredRoute: null });
    let pf = await pre(w, "a-s"); assert.equal(pf.code, "config-invalid"); assert.match(pf.reasons.join(" "), /registered for cliproxyapi\/gpt-6-luna \(medium\), not for the target route cliproxyapi\/gpt-6.1-terra/);
    for (const [name, other] of [["effort", { ...TERRA, effort: "high" }], ["model", { ...TERRA, model: "gpt-6-luna" }], ["provider", { ...TERRA, provider: "other" }]]) {
      w = world(join(root, `r-${name}`), { route: TERRA, registeredRoute: other });
      pf = await pre(w, `r-${name}-s`); assert.equal(pf.code, "config-invalid", name); assert.match(pf.reasons.join(" "), /not for the target route/, name);
    }
    // Integrity screen measured on luna (no route field) for a Terra config.
    w = world(join(root, "b"), { route: TERRA, screenRoute: null });
    pf = await pre(w, "b-s"); assert.equal(pf.code, "prerequisite-failed"); assert.match(pf.reasons.join(" "), /integrity screen was measured on cliproxyapi\/gpt-6-luna \(medium\), not on the target route/);
    // Measured attempts per unit only from records of the target route.
    w = world(join(root, "c"), { route: TERRA });
    writeFileSync(w.cfg.screen.runs, `${JSON.stringify({ type: "result", record: { model_requests: 5, model_route: "cliproxyapi/gpt-6-luna", thinking_effort: "medium" } })}\n`);
    pf = await pre(w, "c-s"); assert.equal(pf.code, "confirmation-plan-not-ready"); assert.match(pf.reasons.join(" "), /no measured per-unit attempt counts/);
    // Default behaviour unchanged: no route anywhere = luna everywhere, accepted.
    w = world(join(root, "d"));
    stageN(w.pool, "e", 6); await refresh(w);
    pf = await pre(w, "d-s"); assert.equal(pf.ok, true, JSON.stringify(pf));
    w = world(join(root, "e"), { route: LUNA, registeredRoute: null, screenRoute: null });
    stageN(w.pool, "e", 6); await refresh(w);
    pf = await pre(w, "e-s"); assert.equal(pf.ok, true, "an explicit default route equals the implicit one");
    // Malformed routes: null, missing effort, unsupported effort, extra key.
    for (const bad of [null, { provider: "cliproxyapi", model: "gpt-6.1-terra" }, { ...TERRA, effort: "turbo" }, { ...TERRA, extra: 1 }, { ...TERRA, model: "" }]) {
      w = world(join(root, `m-${Math.random().toString(16).slice(2)}`));
      writeFileSync(w.file, JSON.stringify({ ...w.cfg, route: bad }));
      pf = await pre(w, "m-s"); assert.equal(pf.code, "config-invalid", JSON.stringify(bad)); assert.match(pf.reasons.join(" "), /route/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
