// Recurring exploration-only route end to end through its CLI (bin/eval-loop-explore.mjs, real child processes, simulated target
// model, real durable budget ledger, real pool/lineage/seal/reservation/use code): two cycles on two different fresh batches,
// completed-result retry, empty supply, budget exhaustion, evaluator/config binding, evidence preservation, refresh exclusivity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { caseDigest, poolState, registryOf } from "../src/supply.mjs";
import { holdoutLedger } from "../src/datasets.mjs";
import { RequestBudget } from "../src/request-budget.mjs";
import { runtimeDigest } from "../src/exploration.mjs";
import { sealOf } from "../src/datasets.mjs";
import { sha256 } from "../src/util.mjs";
import { acquireLock, Ledger } from "../src/util.mjs";

const BIN = fileURLToPath(new URL("../bin/eval-loop-explore.mjs", import.meta.url));
const SRC = { dataset: "Exercism TS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
const run = (args) => { const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env } }); const last = r.stdout.trim().split("\n").at(-1); if (process.env.EXPLORE_DEBUG) process.stderr.write(`RUN ${args[0]} ${r.status} ${last}\n${r.stderr}\n`); return { code: r.status, out: last ? JSON.parse(last) : null, err: r.stderr }; };

function tree(dir, text) { mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src", "x.ts"), text); writeFileSync(join(dir, "package.json"), "{}"); return dir; }
function dataset(dir, specs) { for (const [id, family] of specs) { mkdirSync(join(dir, id, "repo"), { recursive: true }); writeFileSync(join(dir, id, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, family, tier: "easy", instruction: `Solve ${id}`, provenance: "external" })); } writeFileSync(join(dir, "SEAL.json"), JSON.stringify(sealOf(dir))); return dir; }
function stage(pool, id, family, { hard = false, evidence = true, validation = null } = {}) {
  const d = join(pool, "cases", id);
  for (const p of ["repo", "hidden", "reference"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(d, "hidden", "h.test.js"), "// hidden\n"); writeFileSync(join(d, "reference", "index.js"), "// ref\n");
  writeFileSync(join(d, "task.json"), JSON.stringify({ id, family, tier: hard ? "hard" : "easy", instruction: `Solve ${id}`, provenance: "external", ...(hard ? { difficultyBasis: "source", difficultySource: SRC } : {}) }));
  if (evidence) writeFileSync(join(d, "validation.private.json"), validation ?? JSON.stringify({ ok: true, code: "valid", id }));
  registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family, tier: hard ? "hard" : "easy", difficultyBasis: hard ? "source" : "declared", contentDigest: caseDigest(d) });
}

function world(root, { minRemaining = 1000, limit = 4500 } = {}) {
  const cand = tree(join(root, "cand"), "export const c = 1;\n"), stable = tree(join(root, "stable"), "export const s = 1;\n");
  const screenDir = dataset(join(root, "screen-tasks"), [["d1", "gh:dev/x"]]);
  const report = join(root, "screen-report.json"); writeFileSync(report, JSON.stringify({ accepted: true }));
  const reg = join(root, "old-registry.jsonl"); new Ledger(reg).append({ type: "case", caseId: "x-old-1", family: "gh:old/repo", status: "eligible" });
  const ds = dataset(join(root, "old-holdout"), [["o1", "gh:old/ds"]]);
  const pool = join(root, "pool"); mkdirSync(pool, { recursive: true });
  writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false, sealVia: "bin/eval-loop-explore.mjs refresh", requireEvidence: ["validation.private.json"] }));
  const orche = join(root, "orche"); mkdirSync(orche);
  const cfg = { schema: "pi-eval-loop/exploration@1", seriesSeed: "t", candidate: { dir: cand, identity: { commit: "cand@1", runtimeDigest: runtimeDigest(cand) } }, stable: { dir: stable, commit: "stable@1", runtimeDigest: runtimeDigest(stable) },
    screen: { report, reportSha256: sha256(readFileSync(report)), tasks: [{ id: "d1", dataset: screenDir }] }, pool, lineage: { registries: [reg], datasets: [ds] },
    budget: { ledger: join(root, "budget", "ledger.jsonl"), limit, scope: "test exploration", minRemaining }, runtime: { simulated: true }, simulation: { enabled: true, p: { stable: 0.3, c1: 0.8 } }, orcheDir: orche, parallelism: 2,
    batchRule: { seed: "t", maxTasks: 6, maxPerFamily: 1, maxPerOwner: 3, maxOwnerShare: 0.5, preferFreshFamilies: true }, supply: { collector: "none" } };
  const file = join(root, "exploration.json"); writeFileSync(file, JSON.stringify(cfg));
  return { cfg, file, pool };
}
const ledgerAttempts = (cfg) => new RequestBudget({ path: cfg.budget.ledger, limit: cfg.budget.limit, scope: cfg.budget.scope }).status();

test("exploration route: two cycles on two different fresh batches, retry is idle, empty supply waits, budget exhaustion blocks before any dispatch", { timeout: 240_000 }, async () => {
  const root = tempDir();
  try {
    const { cfg, file, pool } = world(root);
    for (let i = 1; i <= 6; i++) stage(pool, `a${i}`, `gh:a${i}/r`, { hard: i === 1 });
    stage(pool, "contaminated", "gh:old/repo"); // family of a lineage registry: withdrawn before the seal
    stage(pool, "no-evidence", "gh:z9/r", { evidence: false }); // required evidence missing: never sealable
    // Before any batch: model-free preflight reports supply-empty (no batch sealed yet), creates nothing.
    const c1 = join(root, "cycles", "c-1");
    let pf = run(["--preflight", "--state", c1, "--protocol", file]);
    assert.equal(pf.code, 2); assert.equal(pf.out.code, "supply-empty"); assert.equal(existsSync(c1), false);
    // Refresh: selection withdraws the contaminated case, seals one batch; the collectors never sealed.
    let rf = run(["refresh", "--protocol", file]);
    assert.equal(rf.code, 0, rf.err); assert.equal(rf.out.schema, "pi-eval-loop/supply-refresh@1"); assert.equal(rf.out.sealed.length, 1);
    const A = rf.out.available.batch;
    let st = poolState(pool);
    assert.deepEqual([...st.batches.get(A).tasks].sort(), ["a1", "a2", "a3", "a4", "a5", "a6"]);
    assert.equal(st.cases.get("contaminated").status, "withdrawn");
    // Evidence preserved byte for byte at the seal (moved, hashed).
    const ev = st.records.filter(r => r.type === "evidence" && r.batch === A);
    assert.equal(ev.length, 6);
    for (const e of ev) assert.equal(sha256(readFileSync(join(pool, e.dir, "validation.private.json"))), e.files["validation.private.json"]);
    pf = run(["--preflight", "--state", c1, "--protocol", file]);
    assert.equal(pf.code, 0, JSON.stringify(pf.out)); assert.equal(pf.out.holdout.batch, A);
    // Cycle 1: init -> select -> ONE pass -> done (exploration-only, never adopt).
    const before = ledgerAttempts(cfg).charged;
    let o = run(["--resume", "--state", c1, "--protocol", file, "--strategy", "pareto"]);
    assert.equal(o.code, 0, o.err); assert.equal(o.out.outcome, "cycle_done"); assert.equal(o.out.initialized, true);
    let s = run(["--status", "--summary", "--state", c1]).out;
    assert.equal(s.condition, "cycle_complete"); assert.equal(s.layout, "explore"); assert.equal(s.final.adopt, false); assert.equal(s.final.explorationOnly, true);
    assert.equal(s.final.evidence.class, "exploratory"); assert.equal(s.exploration.outcome, "completed"); assert.equal(s.exploration.batch, A);
    const after1 = ledgerAttempts(cfg).charged;
    assert.ok(after1 > before, "the pass was charged to the global ledger");
    assert.equal(holdoutLedger(join(pool, "batches", A)).records().length, 1, "one use");
    // Retry of a completed cycle: idle, no attempt, no second use.
    o = run(["--resume", "--require-state", "--state", c1, "--protocol", file]);
    assert.equal(o.out.outcome, "idle"); assert.equal(ledgerAttempts(cfg).charged, after1); assert.equal(holdoutLedger(join(pool, "batches", A)).records().length, 1);
    // Next cycle before new supply: waits (A is used), creates nothing, no attempt.
    const c2 = join(root, "cycles", "c-2");
    pf = run(["--preflight", "--state", c2, "--protocol", file]);
    assert.equal(pf.out.code, "supply-empty"); assert.equal(ledgerAttempts(cfg).charged, after1);
    // A cycle forced to start anyway blocks retryably as supply-wait (model-free).
    o = run(["--resume", "--state", c2, "--protocol", file]);
    assert.equal(o.out.outcome, "blocked"); assert.equal(o.out.status.exploration.code, "supply-empty"); assert.equal(o.out.status.blocked.retryable, true); assert.equal(ledgerAttempts(cfg).charged, after1);
    // New staged supply with fresh families -> a DIFFERENT batch; the blocked cycle resumes and uses it.
    for (let i = 1; i <= 6; i++) stage(pool, `b${i}`, `gh:b${i}/r`, { hard: i === 1 });
    rf = run(["refresh", "--protocol", file]);
    assert.equal(rf.code, 0, rf.err); const B = rf.out.available.batch; assert.notEqual(B, A);
    o = run(["--resume", "--require-state", "--state", c2, "--protocol", file]);
    assert.equal(o.out.outcome, "cycle_done", JSON.stringify(o.out)); assert.equal(o.out.status.exploration.batch, B);
    assert.equal(holdoutLedger(join(pool, "batches", B)).records().length, 1);
    assert.equal(poolState(pool).records.filter(r => r.type === "reserve").length, 2, "one reservation per cycle");
    // Budget exhaustion: a config needing more than remains never starts (preflight and run), nothing dispatched or reserved.
    const rem = ledgerAttempts(cfg).remaining;
    const tight = { ...cfg, budget: { ...cfg.budget, minRemaining: rem + 1 } }; const tf = join(root, "tight.json"); writeFileSync(tf, JSON.stringify(tight));
    for (let i = 1; i <= 6; i++) stage(pool, `e${i}`, `gh:e${i}/r`, { hard: i === 1 });
    rf = run(["refresh", "--protocol", tf]); assert.equal(rf.code, 0, rf.err);
    const c3 = join(root, "cycles", "c-3");
    pf = run(["--preflight", "--state", c3, "--protocol", tf]); assert.equal(pf.out.code, "budget-exhausted");
    const attempts = ledgerAttempts(cfg).charged, reserves = poolState(pool).records.filter(r => r.type === "reserve").length;
    o = run(["--resume", "--state", c3, "--protocol", tf]);
    assert.equal(o.out.outcome, "blocked"); assert.equal(o.out.status.exploration.code, "budget-exhausted"); assert.equal(o.out.status.blocked.retryable, false);
    assert.equal(ledgerAttempts(cfg).charged, attempts); assert.equal(poolState(pool).records.filter(r => r.type === "reserve").length, reserves);
    // Restart after exhaustion: still blocked, still nothing dispatched.
    o = run(["--resume", "--require-state", "--state", c3, "--protocol", tf]);
    assert.equal(o.out.status.exploration.code, "budget-exhausted"); assert.equal(ledgerAttempts(cfg).charged, attempts);
    // The ledger's limit is fixed at creation: a config asking for a larger cap is refused, never an extra allowance.
    const bigger = { ...cfg, budget: { ...cfg.budget, limit: 9000 } }; const bf = join(root, "bigger.json"); writeFileSync(bf, JSON.stringify(bigger));
    pf = run(["--preflight", "--state", join(root, "cycles", "c-4"), "--protocol", bf]); assert.equal(pf.out.code, "budget-unusable"); assert.match(pf.out.reasons.join(" "), /limit/);
    // A cycle is bound to its config: another config on the same directory is a state_error.
    o = run(["--resume", "--require-state", "--state", c1, "--protocol", tf]);
    assert.equal(o.out.outcome, "state_error");
    // The no-evidence case was never sealed.
    assert.ok(!Object.values(Object.fromEntries(poolState(pool).batches)).some(b => b.tasks.includes("no-evidence")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exploration refresh: one at a time (busy = exit 3, nothing changed); a pool without autoSeal:false policy is refused", { timeout: 60_000 }, async () => {
  const root = tempDir();
  try {
    const { file, pool } = world(root);
    for (let i = 1; i <= 6; i++) stage(pool, `a${i}`, `gh:a${i}/r`, { hard: i === 1 });
    const held = acquireLock(join(pool, ".refresh.lock"));
    const before = readFileSync(join(pool, "registry.jsonl"), "utf8");
    const r = run(["refresh", "--protocol", file]);
    held.release();
    assert.equal(r.code, 3); assert.ok(r.out.busy); assert.equal(readFileSync(join(pool, "registry.jsonl"), "utf8"), before);
    writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: true }));
    const r2 = run(["refresh", "--protocol", file]);
    assert.equal(r2.code, 1); assert.match(r2.out.error, /autoSeal: false/);
    assert.equal(existsSync(join(pool, "batches")) ? readdirSync(join(pool, "batches")).length : 0, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exploration config fails closed: empty lineage inventories, missing screening tasks, relative paths, simulation without simulated runtime", () => {
  const root = tempDir();
  try {
    const { cfg } = world(root);
    for (const [name, mut] of [["empty-registries", c => ({ ...c, lineage: { ...c.lineage, registries: [] } })], ["no-screen", c => ({ ...c, screen: { ...c.screen, tasks: [] } })], ["relative", c => ({ ...c, pool: "pool" })], ["sim", c => ({ ...c, runtime: { dir: "/x" } })]]) {
      const f = join(root, `${name}.json`); writeFileSync(f, JSON.stringify(mut(cfg)));
      const r = run(["--preflight", "--state", join(root, "c"), "--protocol", f]);
      assert.equal(r.out.code, "config-invalid", name);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exploration evidence is enforced by the route itself: POLICY without requireEvidence, an empty list, {}, null, a failed validation or a corrupt file never seal; config cannot disable it", { timeout: 120_000 }, async () => {
  const { refreshExploration, explorePreflight } = await import("../src/explore-cycle.mjs");
  const root = tempDir();
  try {
    const { cfg, file, pool } = world(root);
    for (const policy of [{ schema: "pi-eval-loop/pool-policy@1", autoSeal: false }, { schema: "pi-eval-loop/pool-policy@1", autoSeal: false, requireEvidence: [] }]) {
      writeFileSync(join(pool, "POLICY.json"), JSON.stringify(policy));
      const tag = policy.requireEvidence ? "e" : "o";
      // 6 cases with fresh families, each with bad or missing evidence: none may seal.
      stage(pool, `${tag}1`, `gh:${tag}1/r`, { hard: true, evidence: false });
      stage(pool, `${tag}2`, `gh:${tag}2/r`, { validation: "{}" });
      stage(pool, `${tag}3`, `gh:${tag}3/r`, { validation: "null" });
      stage(pool, `${tag}4`, `gh:${tag}4/r`, { validation: JSON.stringify({ ok: false, code: "original-passes-hidden" }) });
      stage(pool, `${tag}5`, `gh:${tag}5/r`, { validation: "{broken" });
      stage(pool, `${tag}6`, `gh:${tag}6/r`, { validation: JSON.stringify({ ok: true }) });
      const r = await refreshExploration(file, { deps: { orcheDir: cfg.orcheDir } });
      assert.equal(r.code, 2, JSON.stringify(r.out)); assert.equal(r.out.sealed.length, 0, `${tag}: nothing sealed without passed-validation evidence`);
    }
    for (const [name, evidence] of [["false", false], ["null", null], ["string", "none"], ["bad-list", { required: "validation.private.json" }], ["extra-key", { required: [], optional: true }]]) {
      const f = join(root, `ev-${name}.json`); writeFileSync(f, JSON.stringify({ ...cfg, evidence }));
      const pf = await explorePreflight(f, join(root, "c"), { orcheDir: cfg.orcheDir });
      assert.equal(pf.code, "config-invalid", name);
    }
    // An empty extra list keeps the default requirement.
    const f = join(root, "ev-empty.json"); writeFileSync(f, JSON.stringify({ ...cfg, evidence: { required: [] } }));
    const r = await refreshExploration(f, { deps: { orcheDir: cfg.orcheDir } });
    assert.equal(r.out.sealed.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an already sealed batch whose preserved evidence is missing, changed or a legacy gap is retired before use (never consumed, never offered again); historical files untouched", { timeout: 120_000 }, async () => {
  const { refreshExploration, explorePreflight, runExploreCycle } = await import("../src/explore-cycle.mjs");
  const { sealBatch } = await import("../src/supply.mjs");
  const root = tempDir();
  try {
    const { cfg, file, pool } = world(root);
    // Legacy: a batch sealed without evidence records (as before 2026-11-07; simulated by sealing with the archive then
    // deleting nothing but registering no evidence: seal a pool copy whose evidence records we strip is not possible on a
    // hash chain, so the legacy batch is formed from cases staged WITHOUT any private evidence file).
    const policy = readFileSync(join(pool, "POLICY.json"));
    writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false }));
    for (let i = 1; i <= 6; i++) stage(pool, `l${i}`, `gh:l${i}/r`, { hard: i === 1, evidence: false });
    const legacy = sealBatch({ pool, cfg: { batch: cfg.batchRule }, minima: { minTasks: 6, minFamilies: 4, requireHard: true, hardBasis: ["source"] }, now: new Date("2026-01-01T00:00:00Z") });
    assert.ok(legacy.batch, JSON.stringify(legacy));
    writeFileSync(join(pool, "POLICY.json"), policy);
    const legacyBytes = readFileSync(join(legacy.dir, "SEAL.json"));
    // A good batch next, then its archived evidence is changed after the seal.
    for (let i = 1; i <= 6; i++) stage(pool, `g${i}`, `gh:g${i}/r`, { hard: i === 1 });
    let rf = await refreshExploration(file, { deps: { orcheDir: cfg.orcheDir } });
    assert.ok(rf.out.retired.includes(legacy.batch), "the legacy batch (no preserved evidence) is retired");
    const good = rf.out.available.batch;
    assert.ok(good && good !== legacy.batch, JSON.stringify(rf.out));
    const ev = poolState(pool).records.find(r => r.type === "evidence" && r.batch === good);
    writeFileSync(join(pool, ev.dir, "validation.private.json"), JSON.stringify({ ok: true, code: "valid", forged: 1 }));
    const pf = await explorePreflight(file, join(root, "c-x"), { orcheDir: cfg.orcheDir });
    assert.equal(pf.code, "supply-empty"); assert.match(pf.reasons.join(" "), /evidence re-check failed/);
    // A cycle started now retires it at init (supply wait), consumes nothing.
    const o = await runExploreCycle(file, join(root, "c-x"), { deps: { orcheDir: cfg.orcheDir } });
    assert.equal(o.outcome, "blocked"); assert.equal(o.status.exploration.code, "supply-empty");
    const st = poolState(pool);
    assert.equal(st.batches.has(good), false); assert.ok(st.retired.has(good));
    assert.equal(st.records.filter(r => r.type === "reserve").length, 0);
    assert.equal(existsSync(join(pool, "batches", good, "USES.jsonl")), false);
    assert.deepEqual(readFileSync(join(legacy.dir, "SEAL.json")), legacyBytes, "historical seal untouched");
    // Next refresh: the retired batches stay out (not offered again).
    rf = await refreshExploration(file, { deps: { orcheDir: cfg.orcheDir } });
    assert.equal(rf.out.available.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restart after selection: a selected batch whose evidence changed before use is dropped (not reserved, not consumed) and then retired", { timeout: 120_000 }, async () => {
  const { refreshExploration, runExploreCycle } = await import("../src/explore-cycle.mjs");
  const root = tempDir();
  try {
    const { cfg, file, pool } = world(root);
    for (let i = 1; i <= 6; i++) stage(pool, `s${i}`, `gh:s${i}/r`, { hard: i === 1 });
    const rf = await refreshExploration(file, { deps: { orcheDir: cfg.orcheDir } });
    const B = rf.out.available.batch;
    // A live foreign reservation makes the pass wait right before consumption (phase "selected").
    const budget = new RequestBudget({ path: cfg.budget.ledger, limit: cfg.budget.limit, scope: cfg.budget.scope });
    const t = await budget.reserve(5, { test: "foreign" });
    const state = join(root, "c-sel");
    let o = await runExploreCycle(file, state, { deps: { orcheDir: cfg.orcheDir } });
    assert.equal(o.status.exploration.code, "runtime-wait", JSON.stringify(o.status.blocked));
    assert.equal(o.status.exploration.batch, B);
    await budget.settle(t, 0);
    const ev = poolState(pool).records.find(r => r.type === "evidence" && r.batch === B);
    writeFileSync(join(pool, ev.dir, "validation.private.json"), "{}");
    o = await runExploreCycle(file, state, { requireState: true, deps: { orcheDir: cfg.orcheDir } });
    assert.equal(o.status.exploration.code, "supply-error"); assert.match(o.status.blocked.reason, /evidence re-check before use \(not consumed\)/);
    assert.equal(existsSync(join(pool, "batches", B, "USES.jsonl")), false);
    assert.equal(poolState(pool).records.filter(r => r.type === "reserve").length, 0);
    o = await runExploreCycle(file, state, { requireState: true, deps: { orcheDir: cfg.orcheDir } });
    assert.equal(o.status.exploration.code, "supply-empty");
    assert.ok(poolState(pool).retired.has(B), "retired, never offered again");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void execFileSync;
