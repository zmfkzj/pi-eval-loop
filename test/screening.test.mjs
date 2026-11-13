// Practical screening route end to end through its CLI (bin/eval-loop-explore.mjs, `mode: "screening"`; real child processes,
// simulated target model, real durable budget ledger, real registry/pool/lineage/seal/reservation/use code). Covers: model-free
// smoke rejection, archive dedupe, dev negative / rejected / promising, fresh holdout only for a dev-qualified candidate, supply
// wait, one holdout per candidate (also with fresh supply and on retry), no-candidate wait, cap and time exhaustion (cheap stage
// end vs durable stop), series lock (concurrency), SIGKILL + resume, immutable input drift, and never any adoption.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { caseDigest, poolState, registryOf } from "../src/supply.mjs";
import { holdoutLedger, sealOf } from "../src/datasets.mjs";
import { RequestBudget } from "../src/request-budget.mjs";
import { runtimeDigest } from "../src/exploration.mjs";
import { acquireLock, Ledger } from "../src/util.mjs";
import { candidateView, planAction, routeUsage, devVerdict, StageBudget, runDev, dirDigest, devEligibility, exposedDevTasks, passNeed, legacyBudgetFields } from "../src/screening.mjs";
import { loadExploration } from "../src/explore-cycle.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";

const BIN = fileURLToPath(new URL("../bin/eval-loop-explore.mjs", import.meta.url));
const SRC = { dataset: "Exercism TS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
const run = (args, extraEnv = {}) => { const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, ...extraEnv } }); const last = r.stdout.trim().split("\n").at(-1); if (process.env.EXPLORE_DEBUG) process.stderr.write(`RUN ${args[0]} ${r.status} ${last}\n${r.stderr}\n`); return { code: r.status, signal: r.signal, out: last ? JSON.parse(last) : null, err: r.stderr }; };

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

function world(root, over = {}) {
  const stable = tree(join(root, "stable"), "export const s = 1;\n");
  const exposed = tree(join(root, "exposed"), "export const s = 9;\n");
  const arch = join(root, "archive", "candidates");
  const S = "stable-commit-1";
  archived(arch, "a1-good", { base: S, diff: patch("export const s = 1;", "export const s = 2;") });
  archived(arch, "a2-noapply", { base: S, diff: patch("export const nope = 1;", "export const s = 0;") });
  archived(arch, "a3-dup", { base: S, diff: patch("export const s = 1;", "export const s = 2;") });
  archived(arch, "a4-smokefail", { base: S, diff: patch("export const s = 1;", "export const s = 5;") });
  archived(arch, "a5-neg", { base: S, diff: patch("export const s = 1;", "export const s = 3;") });
  archived(arch, "a6-viol", { base: S, diff: patch("export const s = 1;", "export const s = 4;") });
  archived(arch, "a7-pkg", { base: S, diff: patch("{}", "{\"x\":1}", "package.json") });
  archived(arch, "a8-oldreject", { status: "rejected", base: S, diff: patch("export const s = 1;", "export const s = 8;") });
  const devDir = dataset(join(root, "dev-tasks"), [["d1", "gh:dev/one"], ["d2", "gh:dev/two"]], "calibration");
  const reg = join(root, "old-registry.jsonl"); new Ledger(reg).append({ type: "case", caseId: "x-old-1", family: "gh:old/repo", status: "eligible" });
  const ds = dataset(join(root, "old-holdout"), [["o1", "gh:old/ds"]]);
  const pool = join(root, "pool"); mkdirSync(pool, { recursive: true });
  writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false, sealVia: "bin/eval-loop-explore.mjs refresh", requireEvidence: ["validation.private.json"] }));
  const orche = join(root, "orche"); mkdirSync(orche);
  const cfg = { schema: "pi-eval-loop/exploration@1", mode: "screening", seriesSeed: "t", stable: { dir: stable, commit: S, runtimeDigest: runtimeDigest(stable) }, pool, lineage: { registries: [reg], datasets: [ds] },
    budget: { ledger: join(root, "budget", "ledger.jsonl"), limit: 4500, scope: "test screening" }, runtime: { simulated: true },
    simulation: { enabled: true, p: { stable: 0, c1: 0.5 }, byCandidate: { "archive/a1-good": { p: 1 }, "archive/a5-neg": { p: 0 }, "archive/a6-viol": { p: 1, violate: true } }, smokeFail: ["archive/a4-smokefail"] },
    orcheDir: orche, parallelism: 1, batchRule: { seed: "t", maxTasks: 6, maxPerFamily: 1, maxPerOwner: 3, maxOwnerShare: 0.5, preferFreshFamilies: true }, supply: { collector: "none" },
    screening: { registry: join(root, "series", "registry.jsonl"), workDir: join(root, "series", "work"),
      candidates: { sources: [{ kind: "archive", dir: arch }, { kind: "tree", id: "old-exposed", dir: exposed, identity: { runtimeDigest: runtimeDigest(exposed), commit: "old@1" } }], maxCandidates: 12 },
      history: [{ runtimeDigest: runtimeDigest(exposed), at: "2026-11-07T08:51:10.524Z", note: "consumed holdout before this route" }],
      dev: { tasks: [{ id: "d1", dataset: devDir }, { id: "d2", dataset: devDir }], repeats: 1, promote: { minNetSuccesses: 1 }, maxHours: 2 },
      holdout: { enabled: true, maxHours: 4 }, smoke: { checks: true }, estimate: { attemptsPerUnit: { dev: 20, holdout: 20 } } }, ...over };
  const file = join(root, "screening.json"); writeFileSync(file, JSON.stringify(cfg));
  return { cfg, file, pool, stable, arch, devDir };
}
const ledger = (cfg) => new RequestBudget({ path: cfg.budget.ledger, limit: cfg.budget.limit, scope: cfg.budget.scope });
const charged = (cfg) => existsSync(cfg.budget.ledger) ? ledger(cfg).status().charged : 0;
const status = (dir) => run(["--status", "--summary", "--state", dir]).out;
const view = (cfg) => candidateView(new Ledger(cfg.screening.registry).records(), cfg);
const byId = (cfg, id) => view(cfg).find(c => c.id === `archive/${id}`);
function assertNoAdoption(s) {
  assert.equal(s.final.adopt, false); assert.equal(s.final.explorationOnly, true); assert.notEqual(s.acceptance?.productionAdopted, true);
  assert.equal(s.adoptedAt, undefined); assert.equal(s.lifecycle, undefined); assert.ok(["development", "exploratory"].includes(s.final.evidence.class)); assert.equal(s.final.evidence.confirmatoryClaim, false);
}

test("screening route: smoke -> dev -> fresh holdout only for a qualified candidate; dedupe, waits, one holdout per candidate, never adopts", { timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    // The series work directory lives inside a git checkout (as in production): patches must still apply to the copy itself.
    execFileSync("git", ["init", "-q"], { cwd: root });
    const { cfg, file, pool, stable } = world(root);
    const stableDigest = runtimeDigest(stable);
    const c = (n) => join(root, "cycles", `c-${n}`);
    // Model-free preflight: unregistered archive candidates count as pending -> ok (dev next), creates nothing.
    let pf = run(["--preflight", "--state", c(1), "--protocol", file]);
    assert.equal(pf.code, 0, JSON.stringify(pf.out)); assert.equal(pf.out.screening.next, "dev"); assert.equal(existsSync(c(1)), false); assert.equal(existsSync(cfg.screening.registry), false);
    // Cycle 1: registers the bounded source (a2 does not apply -> smoke-rejected without a model; a3 is a duplicate patch of a1;
    // a8 has an excluded archive status), then smoke + dev of the first pending candidate in registration order (a1).
    let o = run(["--resume", "--state", c(1), "--protocol", file]);
    assert.equal(o.code, 0, o.err); assert.equal(o.out.outcome, "cycle_done");
    let s = status(c(1));
    assert.equal(s.exploration.mode, "screening"); assert.equal(s.exploration.stage, "dev"); assert.equal(s.exploration.candidate, "archive/a1-good");
    assert.equal(s.final.verdict, "DEV_PROMISING"); assert.equal(s.exploration.outcome, "completed"); assertNoAdoption(s); assert.equal(s.final.evidence.class, "development");
    const v1 = view(cfg);
    assert.deepEqual(v1.map(x => x.id).sort(), ["archive/a1-good", "archive/a2-noapply", "archive/a4-smokefail", "archive/a5-neg", "archive/a6-viol", "archive/a7-pkg", "old-exposed"]);
    assert.equal(byId(cfg, "a2-noapply").status, "rejected"); assert.equal(byId(cfg, "a1-good").status, "qualified");
    assert.equal(v1.find(x => x.id === "old-exposed").status, "exposed");
    assert.equal(new Ledger(cfg.screening.registry).records().filter(r => r.type === "alias").length, 1, "a3 is the same patch as a1: an alias, never a new candidate");
    for (const c of v1.filter(x => x.kind === "archive" && x.dir)) assert.notEqual(c.key, stableDigest, `${c.id}: the patch changed the materialized tree`);
    assert.equal(readFileSync(join(byId(cfg, "a1-good").dir, "src", "x.ts"), "utf8"), "export const s = 2;\n");
    const afterDev1 = charged(cfg);
    assert.ok(afterDev1 > 0);
    assert.equal(routeUsage(ledger(cfg).verified()).route, afterDev1, "every charged attempt is tagged with the screening route");
    // Retry of a completed cycle: idle, no attempt.
    o = run(["--resume", "--require-state", "--state", c(1), "--protocol", file]);
    assert.equal(o.out.outcome, "idle"); assert.equal(charged(cfg), afterDev1);
    // Cycle 2: a1 is qualified but no fresh batch exists -> the next pending candidate is screened (a4: smoke fails, zero model calls).
    o = run(["--resume", "--state", c(2), "--protocol", file]);
    s = status(c(2)); assert.equal(s.final.verdict, "SMOKE_REJECTED"); assert.equal(s.exploration.candidate, "archive/a4-smokefail"); assert.equal(charged(cfg), afterDev1, "smoke is model-free");
    // Cycle 3: a5 -> DEV_NEGATIVE (recorded, rotation continues). Cycle 4: a6 -> DEV_REJECTED (integrity), eliminated early.
    o = run(["--resume", "--state", c(3), "--protocol", file]); s = status(c(3)); assert.equal(s.final.verdict, "DEV_NEGATIVE"); assert.equal(s.exploration.outcome, "completed"); assertNoAdoption(s);
    const before4 = charged(cfg);
    o = run(["--resume", "--state", c(4), "--protocol", file]); s = status(c(4)); assert.equal(s.final.verdict, "DEV_REJECTED");
    const devRuns = readFileSync(join(c(4), "dev", "runs.jsonl"), "utf8").split("\n").filter(l => l.includes('"type":"result"')).length;
    assert.ok(devRuns < 4, `early elimination: ${devRuns} of 4 units measured`); assert.ok(charged(cfg) > before4);
    // Cycle 5: a7 changes package.json (outside the allowed paths) -> SMOKE_REJECTED, model-free.
    const before5 = charged(cfg);
    o = run(["--resume", "--state", c(5), "--protocol", file]); s = status(c(5)); assert.equal(s.final.verdict, "SMOKE_REJECTED"); assert.equal(charged(cfg), before5);
    // Cycle 6: nothing pending, a1 qualified, no supply -> model-free supply wait (retryable); preflight says the same.
    pf = run(["--preflight", "--state", c(6), "--protocol", file]); assert.equal(pf.out.code, "supply-empty");
    o = run(["--resume", "--state", c(6), "--protocol", file]);
    assert.equal(o.out.outcome, "blocked"); assert.equal(o.out.status.exploration.code, "supply-empty"); assert.equal(o.out.status.blocked.retryable, true); assert.equal(charged(cfg), before5);
    // Fresh supply (dev tasks' families are excluded by lineage) -> the waiting cycle resumes with the holdout of a1.
    for (let i = 1; i <= 6; i++) stage(pool, `h${i}`, `gh:h${i}/r`, { hard: i === 1 });
    stage(pool, "devfam", "gh:dev/one");
    let rf = run(["refresh", "--protocol", file]); assert.equal(rf.code, 0, rf.err); const A = rf.out.available.batch;
    assert.ok(!poolState(pool).batches.get(A).tasks.includes("devfam"), "a development task family never enters a holdout batch");
    o = run(["--resume", "--require-state", "--state", c(6), "--protocol", file]);
    assert.equal(o.out.outcome, "cycle_done", JSON.stringify(o.out)); s = status(c(6));
    assert.equal(s.exploration.stage, "holdout"); assert.equal(s.exploration.candidate, "archive/a1-good"); assert.equal(s.exploration.batch, A);
    assert.ok(["EXPLORATORY_SUPPORTED", "KEEP_STABLE", "INCONCLUSIVE"].includes(s.final.verdict)); assertNoAdoption(s); assert.equal(s.final.evidence.class, "exploratory");
    assert.equal(holdoutLedger(join(pool, "batches", A)).records().length, 1, "one use");
    assert.equal(byId(cfg, "a1-good").status, "holdout-done");
    // Retry: idle, no second use.
    o = run(["--resume", "--require-state", "--state", c(6), "--protocol", file]); assert.equal(o.out.outcome, "idle"); assert.equal(holdoutLedger(join(pool, "batches", A)).records().length, 1);
    // More fresh supply: a1 never gets another holdout; nothing pending -> no-candidate wait, model-free.
    for (let i = 1; i <= 6; i++) stage(pool, `k${i}`, `gh:k${i}/r`, { hard: i === 1 });
    rf = run(["refresh", "--protocol", file]); assert.equal(rf.code, 0, rf.err); const B = rf.out.available.batch; assert.notEqual(B, A);
    const before7 = charged(cfg);
    pf = run(["--preflight", "--state", c(7), "--protocol", file]); assert.equal(pf.out.code, "no-candidate");
    o = run(["--resume", "--state", c(7), "--protocol", file]); assert.equal(o.out.status.exploration.code, "no-candidate"); assert.equal(o.out.status.blocked.retryable, true);
    assert.equal(charged(cfg), before7); assert.equal(holdoutLedger(join(pool, "batches", B)).records().length, 0, "the fresh batch stays unused");
    // Nothing was adopted or deployed anywhere: the stable reference is unchanged; no release store exists.
    assert.equal(runtimeDigest(stable), stableDigest);
    assert.equal(readdirSync(root).includes("deploy"), false);
    // Re-registering the same source never duplicates candidates.
    const nCand = new Ledger(cfg.screening.registry).records().filter(r => r.type === "candidate").length;
    run(["--resume", "--require-state", "--state", c(7), "--protocol", file]);
    assert.equal(new Ledger(cfg.screening.registry).records().filter(r => r.type === "candidate").length, nCand);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared-total-only budget: tiny legacy caps are ignored (reported); global exhaustion and historical spend stop before any call; deadline ends dev cheaply; the ledger limit is never changed", { timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    const base = world(root);
    const mk = (name, { caps, dev = {}, limit = base.cfg.budget.limit } = {}) => { const f = join(root, `${name}.json`); const cfg = { ...base.cfg, screening: { ...base.cfg.screening, registry: join(root, name, "registry.jsonl"), workDir: join(root, name, "work"), ...(caps ? { caps } : {}), dev: { ...base.cfg.screening.dev, ...dev } }, budget: { ...base.cfg.budget, ledger: join(root, name, "ledger.jsonl"), limit, scope: `test ${name}` } }; writeFileSync(f, JSON.stringify(cfg)); return { cfg, file: f }; };
    // 1. Legacy per-stage caps far below one dev stage: ignored (never enforced), reported by preflight; the affordable dev pass
    //    runs to its verdict and charges more than every legacy cap.
    let { cfg, file } = mk("legacy", { caps: { dev: 1, holdout: 1, perCandidate: 1, perCycle: 1, cumulative: 1 } });
    assert.equal(legacyBudgetFields(cfg).length, 1);
    let pf = run(["--preflight", "--state", join(root, "t1"), "--protocol", file]);
    assert.equal(pf.out.code, "ok", JSON.stringify(pf.out)); assert.equal(pf.out.budget.policy, "shared-total-only"); assert.match(pf.out.budget.ignoredLegacy[0], /screening\.caps/);
    assert.equal(pf.out.screening.budget.needs.dev.need, passNeed(cfg, "dev", 2).need);
    // Killed mid-pass after a reservation, then resumed with the same legacy config: the frozen plan continues, still uncapped.
    let o = run(["--resume", "--state", join(root, "t1"), "--protocol", file], { EVAL_LOOP_FAULT: "screening:dev-reserve-2" });
    assert.equal(o.signal, "SIGKILL");
    o = run(["--resume", "--require-state", "--state", join(root, "t1"), "--protocol", file]);
    let s = status(join(root, "t1")); assert.equal(s.final.verdict, "DEV_PROMISING", JSON.stringify(s)); assert.ok(charged(cfg) > 1, "spent past every legacy cap");
    const reg = new Ledger(cfg.screening.registry).records(); assert.equal(reg[0].budgetPolicy, "shared-total-only"); assert.equal(reg[0].caps, undefined);
    const plan = JSON.parse(readFileSync(join(root, "t1", "screen-plan.json"), "utf8")); assert.equal(plan.caps, undefined); assert.equal(plan.budget.policy, "shared-total-only");
    // 2. The GLOBAL ledger cannot cover one dev pass (limit below its estimated need): preflight and run stop before any call.
    ({ cfg, file } = mk("tiny", { limit: passNeed(base.cfg, "dev", 2).need - 1 }));
    pf = run(["--preflight", "--state", join(root, "t2"), "--protocol", file]); assert.equal(pf.out.code, "budget-exhausted");
    o = run(["--resume", "--state", join(root, "t2"), "--protocol", file]);
    assert.equal(o.out.status.exploration.code, "budget-exhausted"); assert.equal(o.out.status.blocked.retryable, false); assert.equal(charged(cfg), 0);
    assert.match(o.out.status.blocked.reason, /shared ledger/);
    // 3. Historical spend (other roles, settled) stays charged and counts: the remaining allowance decides, nothing is reset.
    ({ cfg, file } = mk("hist"));
    const led = ledger(cfg); const t = await led.reserve(4450, { route: "proposal", proposal: "old" }); await led.settle(t, 4450);
    o = run(["--resume", "--state", join(root, "t3"), "--protocol", file]);
    assert.equal(o.out.status.exploration.code, "budget-exhausted", JSON.stringify(o.out.status)); assert.equal(ledger(cfg).status().charged, 4450, "historical spend stays charged (no reset)");
    // An OPEN reservation of another role counts the same way (in-flight worst case): a combined shortfall stops before any call.
    ({ cfg, file } = mk("open"));
    const led2 = ledger(cfg); await led2.reserve(4450, { route: "review" });
    o = run(["--resume", "--state", join(root, "t3b"), "--protocol", file]);
    assert.equal(o.out.status.exploration.code, "budget-exhausted"); assert.equal(ledger(cfg).status().charged, 4450);
    // 4. Stage deadline already past (a time bound, not a spend cap): dev ends DEV_INCONCLUSIVE, nothing dispatched or charged.
    ({ cfg, file } = mk("late", { dev: { maxHours: 1e-9 } }));
    o = run(["--resume", "--state", join(root, "t4"), "--protocol", file]); s = status(join(root, "t4"));
    assert.equal(s.final.verdict, "DEV_INCONCLUSIVE"); assert.equal(s.exploration.outcome, "completed"); assert.equal(charged(cfg), 0);
    assert.match(JSON.parse(readFileSync(join(root, "t4", "dev", "dev-report.json"), "utf8")).halted, /time bound/);
    // 5. The ledger's ceiling is never changed: a config asking for another limit is refused (budget-unusable).
    const bad = { ...cfg, budget: { ...cfg.budget, limit: 9000 } }; const bf = join(root, "bad.json"); writeFileSync(bf, JSON.stringify(bad));
    ledger(cfg).status(); await ledger(cfg).reserve(1); 
    pf = run(["--preflight", "--state", join(root, "t5"), "--protocol", bf]); assert.equal(pf.out.code, "budget-unusable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("screening concurrency, SIGKILL + resume and immutable input drift", { timeout: 240_000 }, async () => {
  const root = tempDir();
  try {
    const { cfg, file, arch, devDir } = world(root, {});
    cfg.simulation.smokeFail = []; writeFileSync(file, JSON.stringify(cfg));
    // Series lock: while another screening cycle holds it, a cycle is busy and changes nothing.
    const lock = acquireLock(`${cfg.screening.registry}.lock`);
    let o = run(["--resume", "--state", join(root, "x1"), "--protocol", file]);
    assert.equal(o.out.outcome, "busy"); lock.release(); assert.equal(charged(cfg), 0);
    // SIGKILL after the second dev reservation (an open reservation of a dead pid), then resume: the reservation is settled at the
    // attempt floor, the dev pass completes once, one dev result is recorded.
    o = run(["--resume", "--state", join(root, "x1"), "--protocol", file], { EVAL_LOOP_FAULT: "screening:dev-reserve-2" });
    assert.equal(o.signal, "SIGKILL");
    assert.ok(ledger(cfg).status().openReservations >= 1);
    o = run(["--resume", "--require-state", "--state", join(root, "x1"), "--protocol", file]);
    assert.equal(o.out.outcome, "cycle_done", JSON.stringify(o.out)); assert.equal(ledger(cfg).status().openReservations, 0);
    assert.equal(new Ledger(cfg.screening.registry).records().filter(r => r.type === "result" && r.stage === "dev").length, 1);
    assert.equal(status(join(root, "x1")).final.verdict, "DEV_PROMISING");
    // Kill after smoke, change the frozen candidate tree, resume: refused (prerequisite-failed), nothing dispatched.
    const before = charged(cfg);
    o = run(["--resume", "--state", join(root, "x2"), "--protocol", file], { EVAL_LOOP_FAULT: "screening:after-smoke" });
    assert.equal(o.signal, "SIGKILL");
    const st = JSON.parse(readFileSync(join(root, "x2", "explore.json"), "utf8")); assert.equal(st.phase, "dev-running");
    const candDir = view(cfg).find(c => c.key === st.screening.key).dir;
    writeFileSync(join(candDir, "src", "x.ts"), "export const s = 77;\n");
    o = run(["--resume", "--require-state", "--state", join(root, "x2"), "--protocol", file]);
    assert.equal(o.out.status.exploration.code, "prerequisite-failed"); assert.match(o.out.status.blocked.reason, /drift/); assert.equal(charged(cfg), before);
    // A development task changed between the frozen plan and the dev pass is refused before any dispatch.
    o = run(["--resume", "--state", join(root, "x3"), "--protocol", file], { EVAL_LOOP_FAULT: "screening:after-smoke" });
    assert.equal(o.signal, "SIGKILL");
    writeFileSync(join(devDir, "d2", "repo", "index.js"), "changed\n");
    const b3 = charged(cfg);
    o = run(["--resume", "--require-state", "--state", join(root, "x3"), "--protocol", file]);
    assert.equal(o.out.status.exploration.code, "prerequisite-failed"); assert.match(o.out.status.blocked.reason, /no longer eligible|changed since the plan was frozen/); assert.equal(charged(cfg), b3);
    // A changed config is never continued in a bound cycle directory.
    writeFileSync(file, JSON.stringify({ ...cfg, seriesSeed: "other" }));
    o = run(["--resume", "--require-state", "--state", join(root, "x1"), "--protocol", file]); assert.equal(o.out.outcome, "state_error");
    assert.ok(existsSync(arch));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("screening pure rules: dev verdict, plan order, holdout reservation, cap view", async () => {
  const plan = { dev: { tasks: [{ id: "a" }, { id: "b" }], repeats: 1, promote: { minNetSuccesses: 1 } } };
  const rec = (arm, task, ok, extra = {}) => ({ candidate_id: arm, task_id: task, split: "dev", repeat: 0, attempt: 1, unit_key: `${arm}-${task}`, terminal_status: "completed", task_success: ok, hidden_test_pass: ok, integrity: { violations: [] }, ...extra });
  assert.equal(devVerdict([rec("stable", "a", false), rec("stable", "b", false), rec("c1", "a", true), rec("c1", "b", false)], plan).verdict, "DEV_PROMISING");
  assert.equal(devVerdict([rec("stable", "a", true), rec("stable", "b", false), rec("c1", "a", true), rec("c1", "b", false)], plan).verdict, "DEV_NEGATIVE");
  assert.equal(devVerdict([rec("stable", "a", false), rec("c1", "a", true)], plan).verdict, "DEV_INCONCLUSIVE");
  assert.equal(devVerdict([rec("stable", "a", false), rec("stable", "b", false), rec("c1", "a", true, { integrity: { violations: ["x"] } }), rec("c1", "b", true)], plan).verdict, "DEV_REJECTED");
  // planAction (shared-total-only): only the GLOBAL remaining allowance against estimated needs; a qualified candidate waiting for
  // supply keeps its holdout need set aside; dev of others only within the rest; no route/stage/candidate/cycle cap exists.
  const needs = { dev: 100, holdout: 300, assessment: 100 };
  const v = [{ id: "q", key: "q", status: "qualified" }, { id: "p", key: "p", status: "pending" }];
  assert.equal(planAction(v, { needs, ledgerRemaining: 400, supply: { ok: false, why: "none" }, holdoutEnabled: true }).kind, "dev", "400 - 300 set aside >= 100");
  assert.equal(planAction(v, { needs, ledgerRemaining: 399, supply: { ok: false, why: "none" }, holdoutEnabled: true }).wait, "supply-empty", "dev would eat the waiting holdout's need");
  assert.equal(planAction(v, { needs, ledgerRemaining: 300, supply: { ok: true, pick: {} }, holdoutEnabled: true }).kind, "holdout");
  assert.equal(planAction([{ id: "q", key: "q", status: "qualified", taintedBy: "x" }], { needs, ledgerRemaining: 4000, supply: { ok: true }, holdoutEnabled: true }).wait, "no-candidate");
  assert.equal(planAction(v, { needs, ledgerRemaining: 50, supply: { ok: true }, holdoutEnabled: true }).stop, "budget-exhausted");
  assert.equal(planAction(v, { needs: { dev: 1e6, holdout: 1e6, assessment: 0 }, ledgerRemaining: 1e7, supply: { ok: true, pick: {} }, holdoutEnabled: true }).kind, "holdout", "large passes are admitted when the shared ledger covers them");
  // Tuned after a holdout: a child created after its parent's holdout exposure never qualifies for a holdout; an older one may.
  const pk = "a".repeat(64);
  const cfgT = { pool: "/nonexistent", screening: { history: [{ archivePkey: pk, at: "2026-11-05T22:50:09.264Z", note: "parent holdout" }] } };
  const recs = [{ type: "candidate", key: "k1", id: "late", parents: [pk], createdAt: "2026-11-06T00:00:00Z" }, { type: "candidate", key: "k2", id: "early", parents: [pk], createdAt: "2026-11-05T20:14:57Z" }, { type: "candidate", key: "k3", id: "parent", pkey: pk }];
  const tv = candidateView(recs, cfgT);
  assert.equal(tv.find(x => x.id === "late").taintedBy, pk); assert.equal(tv.find(x => x.id === "early").taintedBy, null); assert.equal(tv.find(x => x.id === "parent").status, "exposed");
  // Development exposure is inherited by descendants (created before or after the parent's screening) and never changes status.
  const recs2 = [{ type: "candidate", key: "p1", id: "par", pkey: "b".repeat(64) }, { type: "candidate", key: "k9", id: "kid", parents: ["b".repeat(64)], createdAt: "2026-11-09T00:00:00Z" }, { type: "dev-exposure", key: "p1", tasks: [{ id: "t1" }], at: "2026-11-08T11:20:00Z", basis: "planned" }, { type: "annotation", key: "p1", kind: "dev-set-deviation" }];
  const v2 = candidateView(recs2, { pool: "/nonexistent", screening: {} });
  assert.deepEqual(v2.find(x => x.id === "kid").devExposure.map(t => [t.id, t.inherited]), [["t1", "p1"]]);
  assert.equal(v2.find(x => x.id === "kid").status, "pending"); assert.equal(v2.find(x => x.id === "par").status, "pending");
  // StageBudget: no cap of its own; two parallel reserves (and another role's) are admitted or refused by the ONE ledger only.
  const root = tempDir();
  try {
    const inner = new RequestBudget({ path: join(root, "l.jsonl"), limit: 200, scope: "t" });
    const cb = new StageBudget(inner, { stage: "dev", key: "k", stageId: "s", cycle: "c" });
    const [a, b] = await Promise.all([cb.reserve(150, {}), cb.reserve(150, {})]);
    assert.equal([a, b].filter(Boolean).length, 1); assert.match(cb.refusal, /global ledger/);
    assert.equal(cb.status().remaining, 50);
    assert.equal(await inner.reserve(51, { route: "proposal" }), null, "another role cannot pass the shared ceiling either");
    const big = new StageBudget(new RequestBudget({ path: join(root, "big.jsonl"), limit: 300000, scope: "t" }), { stage: "holdout", key: "k", stageId: "s", cycle: "c" });
    assert.ok(await big.reserve(100000, {}), "no stage-size refusal below the shared ceiling");
    // Mid-pass refusal by the GLOBAL ledger (e.g. concurrent usage): runDev pauses (durable stop upstream), no dev result written.
    const devDir = dataset(join(root, "dev"), [["d1", "gh:d/1"], ["d2", "gh:d/2"]]);
    const stable = tree(join(root, "st"), "export const s = 1;\n"), cand = tree(join(root, "ca"), "export const s = 2;\n");
    const plan2 = { seed: "u", stable: { dir: stable, commit: "s", runtimeDigest: runtimeDigest(stable) }, candidate: { id: "u", dir: cand, identity: { commit: "c", runtimeDigest: runtimeDigest(cand) } }, dev: { tasks: [{ id: "d1", dataset: devDir }, { id: "d2", dataset: devDir }], repeats: 1, promote: { minNetSuccesses: 1 }, taskDigests: { d1: dirDigest(join(devDir, "d1")), d2: dirDigest(join(devDir, "d2")) } } };
    const inner2 = new RequestBudget({ path: join(root, "l2.jsonl"), limit: 160, scope: "t2" });
    const cb2 = new StageBudget(inner2, { stage: "dev", key: "k", stageId: "s", cycle: "c" });
    const r = await runDev({ plan: plan2, state: join(root, "devstate"), backend: simulatedBackend({ skill: () => ({ p: 0.5 }) }), budget: cb2, bound: null });
    assert.match(r.paused, /global ledger/); assert.equal(existsSync(join(root, "devstate", "dev-report.json")), false);
    assert.ok(inner2.status().charged <= 160);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("development set eligibility: only prospectively designated, never-held-out tasks; every historical source must be readable (fail closed)", { timeout: 120_000 }, async () => {
  const root = tempDir();
  try {
    const { cfg, file } = world(root);
    const load = (over) => { const f = join(root, `cfg-${Math.random().toString(36).slice(2, 8)}.json`); writeFileSync(f, JSON.stringify(over)); return loadExploration(f); };
    const withDev = (tasks, extra = {}) => load({ ...cfg, screening: { ...cfg.screening, ...extra, dev: { ...cfg.screening.dev, ...(extra.dev ?? {}), tasks } } });
    const base = devEligibility(loadExploration(file));
    assert.equal(base.ok, true, JSON.stringify(base.rejected)); assert.deepEqual(base.eligible.map(t => t.id), ["d1", "d2"]);
    // Holdout-purpose dataset, missing provenance, reserved/used dataset, historical holdout family, cross-track Exercism problem.
    const hold = dataset(join(root, "holdout-purpose"), [["h1", "gh:fresh/one"]], "holdout");
    const noprov = dataset(join(root, "no-provenance"), [["n1", "gh:fresh/two"]]);
    const usedDs = dataset(join(root, "used"), [["u1", "gh:fresh/three"]], "calibration"); writeFileSync(join(usedDs, "USES.jsonl"), "{}\n");
    const famHit = dataset(join(root, "family-hit"), [["f1", "gh:old/ds"]], "calibration");
    const exDs = join(root, "old-exercism"); dataset(exDs, [["x-exercism-javascript-knapsack", "gh:exercism/javascript"]]);
    const exDev = dataset(join(root, "dev-exercism"), [["x-exercism-typescript-knapsack", "gh:exercism/typescript"]], "development");
    const c2 = load({ ...cfg, lineage: { ...cfg.lineage, datasets: [...cfg.lineage.datasets, exDs] }, screening: { ...cfg.screening, dev: { ...cfg.screening.dev, tasks: [{ id: "h1", dataset: hold }, { id: "n1", dataset: noprov }, { id: "u1", dataset: usedDs }, { id: "f1", dataset: famHit }, { id: "x-exercism-typescript-knapsack", dataset: exDev }, { id: "d1", dataset: cfg.screening.dev.tasks[0].dataset }] } } });
    const r2 = devEligibility(c2);
    const why = Object.fromEntries(r2.rejected.map(x => [x.id, x.why]));
    assert.deepEqual(r2.eligible.map(t => t.id), ["d1"]); assert.equal(r2.ok, false);
    assert.match(why.h1, /purpose holdout/); assert.match(why.n1, /no readable PROVENANCE/); assert.match(why.u1, /USES/);
    assert.match(why.f1, /family:gh:old\/ds occurs in holdout dataset/); assert.match(why["x-exercism-typescript-knapsack"], /exercism-problem:knapsack/);
    // A task of a sealed holdout pool batch (never reserved or used yet) is a holdout identity, never development material.
    for (let i = 1; i <= 6; i++) stage(cfg.pool, `pc${i}`, `gh:pc${i}/r`, { hard: i === 1 });
    const rf = run(["refresh", "--protocol", file]); assert.equal(rf.code, 0, rf.err);
    const B = rf.out.available.batch;
    const r3 = devEligibility(withDev([{ id: poolState(cfg.pool).batches.get(B).tasks[0], dataset: join(cfg.pool, "batches", B) }]));
    assert.equal(r3.eligible.length, 0); assert.match(r3.rejected[0].why, /pool batch/);
    // Exclusion list: listed task rejected; changed list (sha mismatch) rejects everything.
    const ex = join(root, "exclusions.json"); writeFileSync(ex, JSON.stringify({ exclusions: [{ task: "d2", reason: "grader invalid" }] }));
    const exSha = createHash("sha256").update(readFileSync(ex)).digest("hex");
    const r4 = devEligibility(withDev(cfg.screening.dev.tasks, { dev: { exclusions: [{ file: ex, sha256: exSha }], minTasks: 1 } }));
    assert.deepEqual(r4.eligible.map(t => t.id), ["d1"]); assert.equal(r4.ok, true); assert.match(r4.rejected[0].why, /grader invalid/);
    const r5 = devEligibility(withDev(cfg.screening.dev.tasks, { dev: { exclusions: [{ file: ex, sha256: "0".repeat(64) }] } }));
    assert.equal(r5.eligible.length, 0); assert.match(r5.rejected[0].why, /sha256 mismatch/);
    // Exposed development tasks join the holdout exclusion (screen.tasks) but stay reusable development material.
    const exposedOnly = dataset(join(root, "exposed-dev"), [["z1", "gh:zz/one"]], "calibration");
    const c6 = withDev(cfg.screening.dev.tasks, { exposedDevTasks: [{ id: "z1", dataset: exposedOnly, note: "observed" }] });
    assert.equal(devEligibility(c6).ok, true); assert.ok(c6.screen.tasks.some(t => t.id === "z1"));
    // Missing or tampered historical sources: every task ineligible (never an empty exclusion inventory).
    const missing = load({ ...cfg, lineage: { ...cfg.lineage, datasets: [...cfg.lineage.datasets, join(root, "nope")] } });
    assert.equal(devEligibility(missing).eligible.length, 0); assert.match(devEligibility(missing).rejected[0].why, /fail closed/);
    const reg = cfg.lineage.registries[0]; const lines = readFileSync(reg, "utf8"); writeFileSync(reg, lines.replace("gh:old/repo", "gh:old/other"));
    const r7 = devEligibility(loadExploration(file)); assert.equal(r7.eligible.length, 0); assert.match(r7.rejected[0].why, /fail closed/);
    writeFileSync(reg, lines);
    assert.equal(devEligibility(loadExploration(file)).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dev-supply wait and dev-set change: ineligible set waits model-free with pending candidates; a corrected set never re-runs decided candidates; observed tasks stay out of every new holdout", { timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    const { cfg, file, pool } = world(root);
    // 1. Ineligible development set (holdout-purpose dataset) with pending candidates: preflight + cycle wait, zero calls, no claim.
    const bad = dataset(join(root, "bad-dev"), [["b1", "gh:bad/one"], ["b2", "gh:bad/two"]], "holdout");
    const badFile = join(root, "bad.json"); writeFileSync(badFile, JSON.stringify({ ...cfg, screening: { ...cfg.screening, dev: { ...cfg.screening.dev, tasks: [{ id: "b1", dataset: bad }, { id: "b2", dataset: bad }] } } }));
    let pf = run(["--preflight", "--state", join(root, "w0"), "--protocol", badFile]);
    assert.equal(pf.out.code, "dev-supply-empty"); assert.match(pf.out.reasons[0], /purpose holdout/);
    let o = run(["--resume", "--state", join(root, "w0"), "--protocol", badFile]);
    assert.equal(o.out.status.exploration.code, "dev-supply-empty"); assert.equal(o.out.status.blocked.retryable, true); assert.equal(charged(cfg), 0);
    assert.equal(new Ledger(cfg.screening.registry).records().filter(r => r.type === "claim").length, 0);
    // 2. Valid set A: screen a1 (promising) and a5 (negative); each dev claim records the planned tasks as exposure.
    o = run(["--resume", "--state", join(root, "w1"), "--protocol", file]); assert.equal(status(join(root, "w1")).final.verdict, "DEV_PROMISING");
    run(["--resume", "--state", join(root, "w2"), "--protocol", file]); // a4 smoke-rejected
    o = run(["--resume", "--state", join(root, "w3"), "--protocol", file]); assert.equal(status(join(root, "w3")).final.verdict, "DEV_NEGATIVE");
    const exp = new Ledger(cfg.screening.registry).records().filter(r => r.type === "dev-exposure");
    assert.equal(exp.length, 2); assert.deepEqual(exp[0].tasks.map(t => t.id), ["d1", "d2"]);
    assert.deepEqual(byId(cfg, "a1-good").devExposure.map(t => t.id), ["d1", "d2"]);
    const spent = charged(cfg);
    // 3. Corrected set B (new calibration tasks), same registry: a1/a5 are never re-run, the next pending one (a6) is screened on B.
    const devB = dataset(join(root, "dev-b"), [["e1", "gh:devb/one"], ["e2", "gh:devb/two"]], "calibration");
    const fileB = join(root, "setB.json"); writeFileSync(fileB, JSON.stringify({ ...cfg, screening: { ...cfg.screening, exposedDevTasks: cfg.screening.dev.tasks.map(t => ({ ...t, note: "set A (deviation)" })), dev: { ...cfg.screening.dev, tasks: [{ id: "e1", dataset: devB }, { id: "e2", dataset: devB }] } } }));
    const cB = loadExploration(fileB);
    assert.deepEqual(devEligibility(cB).eligible.map(t => t.id), ["e1", "e2"]);
    assert.deepEqual(cB.screen.tasks.map(t => t.id).sort(), ["d1", "d2", "e1", "e2"], "holdout exclusion keeps every observed dev task");
    o = run(["--resume", "--state", join(root, "w4"), "--protocol", fileB]);
    const s4 = status(join(root, "w4")); assert.equal(s4.exploration.candidate, "archive/a6-viol"); assert.equal(s4.final.verdict, "DEV_REJECTED");
    assert.deepEqual(JSON.parse(readFileSync(join(root, "w4", "screen-plan.json"), "utf8")).dev.tasks.map(t => t.id), ["e1", "e2"]);
    assert.equal(new Ledger(cfg.screening.registry).records().filter(r => r.type === "result" && r.stage === "dev" && r.key === byId(cfg, "a1-good").key).length, 1);
    assert.ok(charged(cfg) > spent);
    // 4. Registry exposure records alone (no exposedDevTasks) keep set A in the holdout exclusion of a later config.
    const onlyB = join(root, "onlyB.json"); writeFileSync(onlyB, JSON.stringify({ ...cfg, screening: { ...cfg.screening, dev: { ...cfg.screening.dev, tasks: [{ id: "e1", dataset: devB }, { id: "e2", dataset: devB }] } } }));
    assert.deepEqual(loadExploration(onlyB).screen.tasks.map(t => t.id).sort(), ["d1", "d2", "e1", "e2"]);
    // 5. A fresh case of an observed dev family never enters a new holdout batch.
    for (let i = 1; i <= 6; i++) stage(pool, `h${i}`, `gh:h${i}/r`, { hard: i === 1 });
    stage(pool, "obsA", "gh:dev/two"); stage(pool, "obsB", "gh:devb/one");
    const rf = run(["refresh", "--protocol", fileB]); assert.equal(rf.code, 0, rf.err);
    const tasks = poolState(pool).batches.get(rf.out.available.batch).tasks;
    assert.ok(!tasks.includes("obsA") && !tasks.includes("obsB"), JSON.stringify(tasks));
    assert.deepEqual([...new Set(exposedDevTasks(cB).map(t => t.id))].sort(), ["d1", "d2", "e1", "e2"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const TERRA = Object.freeze({ provider: "cliproxyapi", model: "gpt-6.1-terra", effort: "medium" });
const results = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => e.type === "result").map(e => e.record);

test("screening target route: explicit cliproxyapi/gpt-6.1-terra reaches dev and holdout (records, plans, registry); a registry or state of another route is never reused", { timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    const { cfg, file, pool } = world(root, { route: TERRA });
    const c = (n) => join(root, "cycles", `c-${n}`);
    let o = run(["--resume", "--state", c(1), "--protocol", file]);
    assert.equal(o.out.outcome, "cycle_done", o.err);
    assert.equal(status(c(1)).final.verdict, "DEV_PROMISING");
    assert.deepEqual(JSON.parse(readFileSync(join(c(1), "screen-plan.json"), "utf8")).route, TERRA);
    const dev = results(join(c(1), "dev", "runs.jsonl"));
    assert.ok(dev.length > 0 && dev.every(r => r.model_route === "cliproxyapi/gpt-6.1-terra" && r.thinking_effort === "medium"));
    const devResult = new Ledger(cfg.screening.registry).records().find(r => r.type === "result" && r.stage === "dev");
    assert.deepEqual(devResult.route, TERRA, "the registry names the route the dev evidence was measured on");
    for (let i = 2; i <= 5; i++) run(["--resume", "--state", c(i), "--protocol", file]);
    for (let i = 1; i <= 6; i++) stage(pool, `h${i}`, `gh:h${i}/r`, { hard: i === 1 });
    assert.equal(run(["refresh", "--protocol", file]).code, 0);
    o = run(["--resume", "--state", c(6), "--protocol", file]);
    assert.equal(o.out.outcome, "cycle_done", JSON.stringify(o.out));
    assert.equal(status(c(6)).exploration.stage, "holdout");
    const hold = results(join(c(6), "holdout", "runs.jsonl"));
    assert.ok(hold.length > 0 && hold.every(r => r.model_route === "cliproxyapi/gpt-6.1-terra" && r.thinking_effort === "medium"));
    assert.deepEqual(JSON.parse(readFileSync(join(c(6), "holdout-plan.json"), "utf8")).route, TERRA);
    // Effort only changed: the registry's Terra/medium evidence is not reused and the bound state refuses the new config.
    const changed = join(root, "screening-high.json");
    writeFileSync(changed, JSON.stringify({ ...cfg, route: { ...TERRA, effort: "high" } }));
    const pf = run(["--preflight", "--state", c(9), "--protocol", changed]);
    assert.equal(pf.out.code, "prerequisite-failed"); assert.match(pf.out.reasons.join(" "), /measured on cliproxyapi\/gpt-6.1-terra \(medium\), not on the target route cliproxyapi\/gpt-6.1-terra \(high\)/);
    const before = charged(cfg);
    o = run(["--resume", "--state", c(9), "--protocol", changed]);
    assert.equal(o.out.status.exploration.code, "prerequisite-failed"); assert.equal(charged(cfg), before, "no attempt under the changed route");
    o = run(["--resume", "--require-state", "--state", c(6), "--protocol", changed]);
    assert.equal(o.out.outcome, "state_error", "a state bound to the Terra/medium config never continues under another route");
    // The package-default series (no route) refuses a registry measured on Terra too.
    writeFileSync(changed, JSON.stringify({ ...cfg, route: undefined }));
    assert.equal(run(["--preflight", "--state", c(10), "--protocol", changed]).out.code, "prerequisite-failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("screening target route, live config (model-free preflight): the route is validated against the isolated runtime's own catalog snapshot (model and effort) and the peer-pressure meter watches the selected model", { timeout: 120_000 }, async () => {
  const root = tempDir();
  try {
    const { cfg } = world(root, { route: TERRA });
    const rt = join(root, "runtime"); mkdirSync(join(rt, "agent"), { recursive: true }); mkdirSync(join(rt, "auth"));
    writeFileSync(join(rt, "manifest.json"), JSON.stringify({ agentDir: join(rt, "agent") }));
    const catalog = (models) => writeFileSync(join(rt, "agent", "cliproxyapi-models.json"), JSON.stringify({ models }));
    const levels = { off: null, minimal: null, low: "low", medium: "medium", high: "high" };
    const live = (over) => { const f = join(root, `live-${Math.random().toString(16).slice(2)}.json`); const c = { ...cfg, ...over, runtime: { dir: rt }, simulation: undefined }; writeFileSync(f, JSON.stringify(c)); return f; };
    const { explorePreflight } = await import("../src/explore-cycle.mjs");
    const pre = (f, deps = { runtimeCheck: async () => [] }) => explorePreflight(f, join(root, "pf-state"), { orcheDir: cfg.orcheDir, ...deps });
    catalog([{ id: "gpt-6-luna", thinkingLevelMap: levels }]);
    let pf = await pre(live({}));
    assert.equal(pf.code, "prerequisite-failed"); assert.match(pf.reasons.join(" "), /gpt-6.1-terra is not in the runtime's model catalog/);
    catalog([{ id: "gpt-6.1-terra", thinkingLevelMap: levels }]);
    pf = await pre(live({ route: { ...TERRA, effort: "minimal" } }));
    assert.equal(pf.code, "prerequisite-failed"); assert.match(pf.reasons.join(" "), /does not support effort minimal/);
    pf = await pre(live({}));
    assert.notEqual(pf.code, "prerequisite-failed", JSON.stringify(pf.reasons));
    // Default runtime check: the pressure meter counts only the selected model's 429/503 failures.
    const db = join(root, "usage.db");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const h = new DatabaseSync(db); h.exec("CREATE TABLE usage_events (model TEXT, timestamp_ms INTEGER, failed INTEGER, failure_status INTEGER)");
    const ins = h.prepare("INSERT INTO usage_events VALUES (?, ?, ?, ?)");
    for (const m of ["gpt-6-luna", "gpt-6-luna", "gpt-6.1-terra"]) ins.run(m, Date.now(), 1, 429);
    h.close();
    const { defaultRuntimeCheck, loadExploration: load } = await import("../src/explore-cycle.mjs");
    const out = await defaultRuntimeCheck(load(live({ gatewayDb: db })));
    assert.ok(out.includes("peer protection: 1 target-model 429/503 failures recently"), JSON.stringify(out));
    assert.ok((await defaultRuntimeCheck(load(live({ gatewayDb: db, route: undefined })))).includes("peer protection: 2 target-model 429/503 failures recently"), "default route: luna");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
