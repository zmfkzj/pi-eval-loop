// Internal promotion track (src/internal-promotion.mjs; opt-in `screening.internal`): simulated end to end through the CLI
// (real child processes, real ledger/registry/pool/lineage/seal/Releases code, simulated target model) plus unit checks of the
// adversarial edges: stale baseline, A -> B -> A, exact rollback, crash between the release history and the internal registry,
// decided-but-unapplied rollback, throttled waiting, cost fit, and off-gate accounting units. Simulated evidence only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { caseDigest, poolState, registryOf } from "../src/supply.mjs";
import { holdoutLedger, sealOf } from "../src/datasets.mjs";
import { RequestBudget, budgetTotals } from "../src/request-budget.mjs";
import { runtimeDigest } from "../src/exploration.mjs";
import { Ledger } from "../src/util.mjs";
import { Releases } from "../src/lifecycle.mjs";
import { loadExploration } from "../src/explore-cycle.mjs";
import { passNeed, planAction } from "../src/screening.mjs";
import { offGateAdmission } from "../src/admission.mjs";
import { assessmentDecision, candidateDemand, noProgress, recordAcceptance, currentStable, evalReleases, internalConfigProblems, internalLedger, pendingAssessment, promote, reconcile, rollback } from "../src/internal-promotion.mjs";

const BIN = fileURLToPath(new URL("../bin/eval-loop-explore.mjs", import.meta.url));
const SRC = { dataset: "Exercism TS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
const run = (args, extraEnv = {}) => { const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, ...extraEnv } }); const last = r.stdout.trim().split("\n").at(-1); return { code: r.status, signal: r.signal, out: last ? JSON.parse(last) : null, err: r.stderr }; };

function tree(dir, text) { mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src", "x.ts"), text); writeFileSync(join(dir, "package.json"), "{}\n"); return dir; }
function dataset(dir, specs, purpose = null) { if (purpose) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "PROVENANCE.json"), JSON.stringify({ schema: "pi-eval-loop/supply@1", purpose, tasks: specs.map(([id, family]) => ({ id, family })) })); } for (const [id, family] of specs) { mkdirSync(join(dir, id, "repo"), { recursive: true }); writeFileSync(join(dir, id, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, family, tier: "easy", instruction: `Solve ${id}`, provenance: "external" })); } writeFileSync(join(dir, "SEAL.json"), JSON.stringify(sealOf(dir))); return dir; }
function stage(pool, id, family, { hard = false } = {}) {
  const d = join(pool, "cases", id);
  for (const p of ["repo", "hidden", "reference"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(d, "hidden", "h.test.js"), "// hidden\n"); writeFileSync(join(d, "reference", "index.js"), "// ref\n");
  writeFileSync(join(d, "task.json"), JSON.stringify({ id, family, tier: hard ? "hard" : "easy", instruction: `Solve ${id}`, provenance: "external", ...(hard ? { difficultyBasis: "source", difficultySource: SRC } : {}) }));
  writeFileSync(join(d, "validation.private.json"), JSON.stringify({ ok: true, code: "valid", id }));
  registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family, tier: hard ? "hard" : "easy", difficultyBasis: hard ? "source" : "declared", contentDigest: caseDigest(d) });
}
const patch = (from, to, file = "src/x.ts") => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
function archived(dir, name, { status = "dev_qualified", parent = "stable", base, diff, createdAt = "2026-11-01T00:00:00.000Z" }) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "candidate.json"), JSON.stringify({ id: name, status, parent, base, createdAt, hypothesis: { text: `hypothesis ${name}` }, decisions: [] }));
  writeFileSync(join(dir, name, "patch.diff"), diff);
}
const S = "stable-commit-1";
function world(root, internalOver = {}, over = {}) {
  const stable = tree(join(root, "stable"), "export const s = 1;\n");
  const arch = join(root, "archive", "candidates");
  archived(arch, "a1-good", { base: S, diff: patch("export const s = 1;", "export const s = 2;") });
  archived(arch, "a5-other", { base: S, diff: patch("export const s = 1;", "export const s = 3;") });
  const devDir = dataset(join(root, "dev-tasks"), [["d1", "gh:dev/one"], ["d2", "gh:dev/two"]], "calibration");
  const reg = join(root, "old-registry.jsonl"); new Ledger(reg).append({ type: "case", caseId: "x-old-1", family: "gh:old/repo", status: "eligible" });
  const ds = dataset(join(root, "old-holdout"), [["o1", "gh:old/ds"]]);
  const pool = join(root, "pool"); mkdirSync(pool, { recursive: true });
  writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false, sealVia: "bin/eval-loop-explore.mjs refresh", requireEvidence: ["validation.private.json"] }));
  const orche = join(root, "orche"); mkdirSync(orche, { recursive: true });
  const cfg = { schema: "pi-eval-loop/exploration@1", mode: "screening", seriesSeed: "t", stable: { dir: stable, commit: S, runtimeDigest: runtimeDigest(stable) }, pool, lineage: { registries: [reg], datasets: [ds] },
    budget: { ledger: join(root, "budget", "ledger.jsonl"), limit: 6000, scope: "test internal" }, runtime: { simulated: true },
    simulation: { enabled: true, p: { stable: 0, c1: 0.5 }, byCandidate: { "archive/a1-good": { p: 1 }, "archive/a5-other": { p: 1 }, "archive/d1-desc": { p: 1 } }, byStage: { assessment: { "archive/a1-good": { p: 1 }, "archive/d1-desc": { p: 1, violate: true } } } },
    orcheDir: orche, parallelism: 1, batchRule: { seed: "t", maxTasks: 6, maxPerFamily: 1, maxPerOwner: 3, maxOwnerShare: 0.5, preferFreshFamilies: true }, supply: { collector: "none" },
    screening: { registry: join(root, "plain-registry.jsonl"), workDir: join(root, "plain-work"),
      candidates: { sources: [{ kind: "archive", dir: arch }], maxCandidates: 12 },
      dev: { tasks: [{ id: "d1", dataset: devDir }, { id: "d2", dataset: devDir }], repeats: 1, promote: { minNetSuccesses: 1 }, maxHours: 2 },
      holdout: { enabled: true, maxHours: 4 }, smoke: { checks: true }, estimate: { attemptsPerUnit: { dev: 5, holdout: 5 } },
      internal: { enabled: true, dir: join(root, "internal"), policy: "operational-unvalidated", maxWaitingQualified: 1, maxAcceptancesWithoutPromotion: 3, select: "best-dev-net", assessment: { enabled: true, maxHours: 4 }, ...internalOver } }, ...over };
  const file = join(root, "internal.json"); writeFileSync(file, JSON.stringify(cfg));
  return { cfg, file, pool, stable, arch };
}
const charged = (cfg) => existsSync(cfg.budget.ledger) ? new RequestBudget({ path: cfg.budget.ledger, limit: cfg.budget.limit, scope: cfg.budget.scope }).status().charged : 0;
const status = (dir) => run(["--status", "--summary", "--state", dir]).out;
const resume = (file, dir, env = {}) => run(["--resume", "--state", dir, "--protocol", file], env);
function seal(file, pool, prefix, n = 6) { for (let i = 1; i <= n; i++) stage(pool, `${prefix}${i}`, `gh:${prefix}${i}/r`, { hard: i === 1 }); const rf = run(["refresh", "--protocol", file]); assert.equal(rf.code, 0, rf.err); return rf.out.available.batch; }
function assertNotResearch(s) { assert.equal(s.final.adopt, false); assert.notEqual(s.acceptance?.productionAdopted, true); assert.equal(s.final.evidence?.confirmatoryClaim ?? false, false); assert.equal(s.lifecycle, undefined); }

test("internal track: dev -> throttled wait -> acceptance on a fresh batch -> evaluation-stable promotion -> assessment KEEP; descendant gets a different fresh batch; regression rolls back; exposure kept", { timeout: 600_000 }, async () => {
  const root = tempDir();
  try {
    const { cfg, file, pool, stable, arch } = world(root);
    const c = (n) => join(root, "cycles", `c-${n}`);
    // Cycle 1: dev of the best candidate (registration order among pending) -> qualified.
    let o = resume(file, c(1)); assert.equal(o.code, 0, o.err);
    let s = status(c(1)); assert.equal(s.final.verdict, "DEV_PROMISING"); assert.equal(s.exploration.candidate, "archive/a1-good"); assertNotResearch(s);
    const afterDev = charged(cfg); assert.ok(afterDev > 0);
    // Throttle (maxWaitingQualified 1): a1 waits for supply, a5 stays pending; no paid dev, candidateDemand false. Twice.
    for (const n of [2, 3]) {
      const pf = run(["--preflight", "--state", c(n), "--protocol", file]); assert.equal(pf.out.code, "supply-empty", JSON.stringify(pf.out)); assert.equal(pf.out.screening.internal.candidateDemand.wanted, false);
      o = resume(file, c(n)); assert.equal(o.out.status.exploration.code, "supply-empty"); assert.equal(o.out.status.blocked.retryable, true);
      assert.equal(charged(cfg), afterDev, "a supply wait is model-free"); assert.equal(existsSync(join(c(n), "dev")), false, "no development pass while a qualified candidate waits");
    }
    // Fresh supply -> acceptance of a1 -> promotion of the evaluation stable (crash right after the CAS, then resume).
    const A = seal(file, pool, "h");
    o = resume(file, c(3), { EVAL_LOOP_FAULT: "internal:after-adopt" }); assert.equal(o.signal, "SIGKILL");
    o = run(["--resume", "--require-state", "--state", c(3), "--protocol", file]); assert.equal(o.out.outcome, "cycle_done", JSON.stringify(o.out));
    s = status(c(3)); assert.equal(s.final.verdict, "INTERNAL_PROMOTED", JSON.stringify(s.final)); assert.equal(s.acceptance.stage, "internal-promoted"); assert.equal(s.internal.serviceDeployment, "none"); assertNotResearch(s);
    assert.equal(s.final.evidence.class, "internal-acceptance"); assert.equal(s.internal.acceptance.verdict, "EXPLORATORY_SUPPORTED");
    assert.equal(holdoutLedger(join(pool, "batches", A)).records().length, 1, "one use");
    const ep0 = new Ledger(join(cfg.screening.internal.dir, "epochs", cfg.stable.runtimeDigest.slice(0, 16), "registry.jsonl")).records();
    assert.equal(ep0.find(r => r.type === "result" && r.stage === "holdout")?.protected, true, "acceptance results are marked protected (never proposer feedback)");
    assert.equal(existsSync(cfg.screening.registry), false, "the plain screening registry is not used by the internal track");
    const loaded = loadExploration(file);
    const hist = new Ledger(join(cfg.screening.internal.dir, "eval-stable", "history.jsonl")).records();
    assert.equal(hist.filter(r => r.type === "adopt").length, 1, "the crash did not duplicate the adoption");
    assert.equal(internalLedger(loaded).records().filter(r => r.type === "promote").length, 1);
    const a1 = currentStable(loaded); assert.notEqual(a1.runtimeDigest, runtimeDigest(stable)); assert.equal(readFileSync(join(a1.dir, "src", "x.ts"), "utf8"), "export const s = 2;\n");
    assert.equal(runtimeDigest(stable), cfg.stable.runtimeDigest, "the configured stable tree is untouched");
    // Next cycle: the assessment comes first (promoted vs previous on the regression tasks) -> KEEP.
    let pf = run(["--preflight", "--state", c(4), "--protocol", file]); assert.equal(pf.out.screening.next, "assessment");
    o = resume(file, c(4)); s = status(c(4)); assert.equal(s.final.verdict, "KEEP", JSON.stringify(s.final)); assert.equal(s.acceptance.stage, "internal-promotion-kept");
    assert.equal(currentStable(loaded).runtimeDigest, a1.runtimeDigest);
    // A descendant of the promoted stable (patch on the promoted tree, base = its commit) -> its own epoch registry.
    archived(arch, "d1-desc", { base: a1.commit, diff: patch("export const s = 2;", "export const s = 7;"), createdAt: new Date().toISOString() });
    o = resume(file, c(5)); s = status(c(5)); assert.equal(s.final.verdict, "DEV_PROMISING", JSON.stringify(s.final)); assert.equal(s.exploration.candidate, "archive/d1-desc");
    const st = run(["internal-status", "--protocol", file]).out;
    assert.equal(st.epochs.length, 2); const e1 = st.epochs.find(e => e.current);
    assert.equal(e1.candidates, 1, "candidates based on another evaluation stable are not registered in this epoch (a5 stays in epoch 0)");
    // Its acceptance needs a fresh batch: A is used, so the wait returns until a new one is sealed; B differs, shares no family.
    o = resume(file, c(6)); assert.equal(o.out.status.exploration.code, "supply-empty");
    const B = seal(file, pool, "k"); assert.notEqual(B, A);
    const famA = new Set(poolState(pool).batches.get(A).tasks.map(id => poolState(pool).cases.get(id).family));
    assert.ok(poolState(pool).batches.get(B).tasks.every(id => !famA.has(poolState(pool).cases.get(id).family)), "the descendant's batch shares no family with the batch its parent was accepted on");
    o = run(["--resume", "--require-state", "--state", c(6), "--protocol", file]); s = status(c(6)); assert.equal(s.final.verdict, "INTERNAL_PROMOTED", JSON.stringify(s.final)); assert.equal(s.internal.acceptance.batch, B);
    const d1 = currentStable(loaded);
    // Assessment of d1: the promoted harness violates integrity on the regression tasks -> ROLLBACK to a1 (exact history record).
    o = resume(file, c(7)); s = status(c(7)); assert.equal(s.final.verdict, "ROLLBACK", JSON.stringify(s.final)); assert.equal(s.acceptance.stage, "internal-rolled-back");
    const back = currentStable(loaded); assert.equal(back.runtimeDigest, a1.runtimeDigest); assert.notEqual(back.releaseSeq, a1.releaseSeq, "a new history record");
    // Exposure survives the rollback: neither a1 nor d1 can get another acceptance batch; nothing is pending.
    const st2 = run(["internal-status", "--protocol", file]).out;
    assert.equal(st2.promotions.length, 2); assert.equal(st2.rollbacks.length, 1); assert.equal(st2.assessments.map(a => a.verdict).join(","), "KEEP,ROLLBACK"); assert.equal(st2.pendingAssessment, null);
    assert.ok(st2.epochs.reduce((n, e) => n + e.exposed, 0) >= 2);
    assert.equal(st2.cost.measured.dev.n > 0, true); assert.equal(st2.serviceDeployment.startsWith("none"), true);
    assert.notEqual(d1.runtimeDigest, back.runtimeDigest);
    // No research artifact anywhere: no deploy directory, no confirmation registration.
    assert.equal(readdirSync(root).includes("deploy"), false);
    assert.ok(charged(cfg) <= cfg.budget.limit);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("internal track on the ONE shared ledger: acceptance waits until the global allowance covers it AND its assessment (batch untouched); another role spending the assessment's allowance after a promotion rolls it back without a model call; a passed deadline does the same", { timeout: 500_000 }, async () => {
  const root = tempDir();
  try {
    let { cfg, file, pool } = world(join(root, "a"));
    const c = (n) => join(root, "a", "cycles", `c-${n}`);
    const led = () => new RequestBudget({ path: cfg.budget.ledger, limit: cfg.budget.limit, scope: cfg.budget.scope });
    let o = resume(file, c(1)); assert.equal(status(c(1)).final.verdict, "DEV_PROMISING");
    const A = seal(file, pool, "h");
    const loaded = loadExploration(file);
    const needs = { holdout: passNeed(loaded, "holdout", 6).need, assessment: passNeed(loaded, "dev", 2).need };
    // Another role holds an open worst case leaving the holdout's own need but not holdout + assessment.
    const hold = await led().reserve(led().status().remaining - (needs.holdout + needs.assessment - 1), { route: "proposal", proposal: "concurrent" });
    assert.ok(hold);
    let pf = run(["--preflight", "--state", c(2), "--protocol", file]);
    assert.notEqual(pf.out.screening?.next, "holdout", JSON.stringify(pf.out));
    o = resume(file, c(2)); let s = status(c(2));
    assert.notEqual(s.exploration.stage, "holdout", "no acceptance while the shared ledger cannot also cover its assessment");
    assert.equal(holdoutLedger(join(pool, "batches", A)).records().length, 0, "the scarce batch was not consumed");
    // The other role settles (frees its unused worst case): the acceptance is admitted and promotes.
    await led().settle(hold, 0);
    o = resume(file, c(3)); s = status(c(3)); assert.equal(s.final.verdict, "INTERNAL_PROMOTED", JSON.stringify(s.final));
    // After the promotion, another role takes the assessment's allowance: the assessment cannot run -> fail closed, no model call.
    const take = await led().reserve(led().status().remaining - (needs.assessment - 1), { route: "review" });
    assert.ok(take);
    const mid = led().status().charged;
    o = resume(file, c(4)); s = status(c(4)); assert.equal(s.final.verdict, "ROLLBACK_UNASSESSED", JSON.stringify(s.final));
    assert.match(run(["internal-status", "--protocol", file]).out.assessments.at(-1).why, /shared ledger/);
    assert.equal(led().status().charged, mid, "no model call"); assert.equal(currentStable(loaded).runtimeDigest, cfg.stable.runtimeDigest);
    // Deadline variant (time bound, not a spend cap): an unassessed promotion past assessBy rolls back without a model call.
    ({ cfg, file, pool } = world(join(root, "b"), { assessment: { enabled: true, maxHours: 1e-7 } }));
    const d = (n) => join(root, "b", "cycles", `c-${n}`);
    o = resume(file, d(1)); assert.equal(status(d(1)).final.verdict, "DEV_PROMISING");
    seal(file, pool, "h");
    o = resume(file, d(2)); assert.equal(status(d(2)).final.verdict, "INTERNAL_PROMOTED", JSON.stringify(status(d(2)).final));
    const before = charged(cfg);
    o = resume(file, d(3)); s = status(d(3)); assert.equal(s.final.verdict, "ROLLBACK_UNASSESSED", JSON.stringify(s.final));
    assert.equal(charged(cfg), before, "no model call"); assert.equal(currentStable(loadExploration(file)).runtimeDigest, cfg.stable.runtimeDigest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("internal track units: stale baseline, A->B->A, exact rollback, reconcile after a crash, decided rollback finished, decisions, throttling, config", () => {
  const root = tempDir();
  try {
    const { cfg, file } = world(root);
    const loaded = loadExploration(file);
    assert.deepEqual(internalConfigProblems(loaded), []);
    assert.ok(internalConfigProblems({ ...cfg, screening: { ...cfg.screening, internal: { ...cfg.screening.internal, policy: "validated" } } }).some(p => /operational-unvalidated/.test(p)));
    assert.ok(internalConfigProblems({ ...cfg, screening: { ...cfg.screening, internal: { ...cfg.screening.internal, attemptsPerUnit: { dev: 5, acceptance: 5 } } } }).some(p => /moved to screening\.estimate/.test(p)), "the removed cost-fit field is refused explicitly");
    const plain = { ...cfg, screening: { ...cfg.screening } }; delete plain.screening.internal;
    assert.deepEqual(internalConfigProblems(plain), [], "plain screening keeps working without the section");
    const R = evalReleases(loaded); R.init(loaded.stable);
    const S0 = currentStable(loaded);
    const mk = (name, text) => { const d = tree(join(root, "t", name), text); return { id: name, dir: d, identity: { id: name, kind: "orche", commit: `c-${name}`, runtimeDigest: runtimeDigest(d) } }; };
    const A = mk("A", "export const s = 11;\n"), B = mk("B", "export const s = 12;\n");
    const planOn = (stable, cand) => ({ stable: { dir: stable.dir, commit: stable.commit, runtimeDigest: stable.runtimeDigest, releaseSeq: stable.releaseSeq }, candidate: cand });
    // Two acceptances measured against S0 compete: the first promotes, the second is a stale baseline (never applied).
    const p1 = promote(loaded, { stateDir: "/k1", plan: planOn(S0, A), evidence: {} }); assert.equal(p1.promoted, true);
    const p2 = promote(loaded, { stateDir: "/k2", plan: planOn(S0, B), evidence: {} }); assert.equal(p2.stale, true);
    assert.equal(promote(loaded, { stateDir: "/k2", plan: planOn(S0, B), evidence: {} }).stale, true, "the refusal is durable");
    assert.equal(currentStable(loaded).runtimeDigest, A.identity.runtimeDigest);
    // A -> S0 again by rollback: equal bytes, other history record -> an acceptance measured on the OLD S0 record is stale.
    rollback(loaded, { releaseKey: "/k1", reason: "test" });
    const S0b = currentStable(loaded); assert.equal(S0b.runtimeDigest, S0.runtimeDigest); assert.notEqual(S0b.releaseSeq, S0.releaseSeq);
    assert.equal(promote(loaded, { stateDir: "/k3", plan: planOn(S0, B), evidence: {} }).stale, true, "A -> B -> A: same digest, different record");
    // Exact rollback: k4 adopts B over S0b; k5 adopts A over B; k5 rolls back (B again, by a rollback record): k4 may not roll back
    // through the later record although the bytes match (Releases without `exact` keeps its legacy digest check).
    promote(loaded, { stateDir: "/k4", plan: planOn(S0b, B), evidence: {} });
    const Bcur = currentStable(loaded);
    promote(loaded, { stateDir: "/k5", plan: planOn(Bcur, A), evidence: {} });
    rollback(loaded, { releaseKey: "/k5", reason: "test" });
    assert.equal(currentStable(loaded).runtimeDigest, B.identity.runtimeDigest);
    assert.throws(() => rollback(loaded, { releaseKey: "/k4", reason: "old" }), /not by the adoption/);
    // Crash between the release history append and the internal record: reconcile restores the promotion and its obligation.
    const cur = currentStable(loaded);
    const C = mk("C", "export const s = 13;\n");
    R.adopt({ key: "/k6", expect: cur.runtimeDigest, candidate: { dir: C.dir, runtimeDigest: C.identity.runtimeDigest, commit: "c-C" }, evidence: { candidateId: "C" } });
    assert.equal(internalLedger(loaded).records().some(r => r.type === "promote" && r.releaseKey === "/k6"), false);
    assert.equal(reconcile(loaded).added, 1);
    assert.equal(pendingAssessment(loaded)?.releaseKey, "/k6", "the reconciled promotion is due for assessment");
    // A decided rollback that the pointer does not show yet (crash after the assessment record) is finished next.
    internalLedger(loaded).append({ type: "assessment", releaseKey: "/k6", verdict: "ROLLBACK", why: "test", net: -1, measured: 4, planned: 4 });
    assert.equal(pendingAssessment(loaded)?.pendingRollback?.verdict, "ROLLBACK");
    rollback(loaded, { releaseKey: "/k6", reason: "test" }); assert.equal(pendingAssessment(loaded), null);
    // No-progress: consecutive acceptance passes without a promotion stop the track before another batch is spent.
    assert.equal(noProgress(loaded), null);
    for (const k of ["/n1", "/n2"]) recordAcceptance(loaded, { stateDir: k, candidate: { id: k }, verdict: "KEEP_STABLE", decision: "NOT_PROMOTED", batch: null, outcome: "completed" });
    recordAcceptance(loaded, { stateDir: "/n2", candidate: { id: "/n2" }, verdict: "KEEP_STABLE", decision: "NOT_PROMOTED", batch: null, outcome: "completed" });
    assert.equal(noProgress(loaded), null, "idempotent per acceptance; 2 < 3");
    recordAcceptance(loaded, { stateDir: "/n3", candidate: { id: "/n3" }, verdict: "INCONCLUSIVE", decision: "NOT_PROMOTED", batch: null, outcome: "completed" });
    assert.match(noProgress(loaded), /3 consecutive/);
    // Decisions (operational, fail closed).
    assert.equal(assessmentDecision({ verdict: "DEV_REJECTED", reasons: ["x"], measured: 4, planned: 4, net: 2 }).rollback, true);
    assert.equal(assessmentDecision({ verdict: "DEV_INCONCLUSIVE", measured: 3, planned: 4, net: 1 }).verdict, "ROLLBACK_UNASSESSED");
    assert.equal(assessmentDecision({ verdict: "DEV_NEGATIVE", measured: 4, planned: 4, net: -1 }).rollback, true);
    assert.equal(assessmentDecision({ verdict: "DEV_NEGATIVE", measured: 4, planned: 4, net: 0 }).verdict, "KEEP");
    assert.deepEqual(candidateDemand({ pending: 0, waiting: 0, maxWaitingQualified: 1, budgetStop: false }).wanted, true);
    // Throttling: maxWaitingQualified 2 -> dev continues while one waits, stops when two wait; best development net first.
    const q = (id, net) => ({ id, key: id, status: "qualified", results: { dev: { net } }, claims: {} });
    const pend = { id: "p", key: "p", status: "pending", results: {}, claims: {} };
    const opts = { needs: { dev: 20, holdout: 180, assessment: 20 }, ledgerRemaining: 5000, supply: { ok: false, why: "none" }, holdoutEnabled: true };
    const internal = { select: "best-dev-net", maxWaitingQualified: 2 };
    assert.equal(planAction([q("a", 1), pend], { ...opts, internal }).kind, "dev");
    assert.equal(planAction([q("a", 1), q("b", 3), pend], { ...opts, internal }).wait, "supply-empty");
    assert.equal(planAction([q("a", 1), q("b", 3)], { ...opts, supply: { ok: true }, internal }).candidate.id, "b");
    assert.equal(planAction([q("a", 1), q("b", 3)], { ...opts, supply: { ok: true } }).candidate.id, "a", "plain screening keeps registration order");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("off-gate accounting units: attempt-bound reservations, grown bound charges in full, strict total refuses unbounded sessions", async () => {
  const root = tempDir();
  try {
    const budget = new RequestBudget({ path: join(root, "l.jsonl"), limit: 1000, scope: "t" });
    let K = 3;
    const bounded = offGateAdmission(budget, { route: "review", bound: () => ({ perRequest: K }) });
    let t = await bounded.reserve(10, { task: "x" }); assert.equal(t.amount, 30);
    await bounded.settle(t, 4); 
    t = await bounded.reserve(10); K = 4; await bounded.settle(t, 2);
    const strict = offGateAdmission(budget, { route: "proposal", requireBound: true });
    assert.equal(await strict.reserve(5), null); assert.match(budget.refusal, /strict total/);
    const loose = offGateAdmission(budget, { route: "proposal" });
    t = await loose.reserve(5); await loose.settle(t, 2);
    t = await loose.reserve(5); await loose.settle(t, undefined);
    const tot = budgetTotals(budget.verified());
    assert.equal(tot.offGateUnits.upstreamAttemptBound, 12 + 30, "4 forwarded x 3, then the full 30 after the bound grew");
    assert.equal(tot.offGateUnits.proxyForwarded, 2 + 5, "forwarded count, then the full reservation without a count");
    assert.equal(tot.upstreamAttemptsBounded, false); assert.equal(tot.attempts, 0); assert.equal(tot.gatedCharged, 0, "off-gate charges never fund outbound attempts");
    assert.throws(() => offGateAdmission(budget, { route: "screening" }), /not an off-gate route/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
