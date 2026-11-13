// internal-acceptance@1 (src/internal-acceptance.mjs, user-approved 2026-11-14): policy separation, audited intake from an untouched
// research pool, actual-exposure exclusion, and the internal promotion track end to end on the internal pool (CLI child processes,
// real ledger/registry/pool/seal/Releases code, simulated target model and simulated grader validation). Simulated evidence only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { batchEligibility, caseDigest, poolState, registryOf, withdrawCase } from "../src/supply.mjs";
import { holdoutLedger, sealOf } from "../src/datasets.mjs";
import { exploreProtocol, internalAcceptanceProtocol, planProtocol, runtimeDigest, INTERNAL_ACCEPTANCE_POLICY } from "../src/exploration.mjs";
import { adoptionDecision } from "../src/gate.mjs";
import { Ledger } from "../src/util.mjs";
import { loadExploration } from "../src/explore-cycle.mjs";
import { currentStable, effectiveConfig, internalConfigProblems } from "../src/internal-promotion.mjs";
import { auditReport, exposureIndex, internalBatchProblems, internalIntake, internalSeal } from "../src/internal-acceptance.mjs";

const BIN = fileURLToPath(new URL("../bin/eval-loop-explore.mjs", import.meta.url));
const run = (args, extraEnv = {}) => { const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, ...extraEnv } }); const last = r.stdout.trim().split("\n").at(-1); return { code: r.status, signal: r.signal, out: last ? JSON.parse(last) : null, err: r.stderr }; };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const validate = async () => ({ ok: true, code: "valid", expected: {} });
const S = "stable-commit-1";

function tree(dir, text) { mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src", "x.ts"), text); writeFileSync(join(dir, "package.json"), "{}\n"); return dir; }
function dataset(dir, specs, purpose = null) { mkdirSync(dir, { recursive: true }); if (purpose) writeFileSync(join(dir, "PROVENANCE.json"), JSON.stringify({ schema: "pi-eval-loop/supply@1", purpose, tasks: specs.map(([id, family]) => ({ id, family })) })); for (const [id, family] of specs) { mkdirSync(join(dir, id, "repo"), { recursive: true }); writeFileSync(join(dir, id, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, family, tier: "easy", instruction: `Solve ${id}`, provenance: "external" })); } writeFileSync(join(dir, "SEAL.json"), JSON.stringify(sealOf(dir))); return dir; }
const patch = (from, to, file = "src/x.ts") => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
function archived(dir, name, { base, diff, createdAt = "2026-11-01T00:00:00.000Z" }) { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, "candidate.json"), JSON.stringify({ id: name, status: "dev_qualified", parent: "stable", base, createdAt, hypothesis: { text: `h ${name}` }, decisions: [] })); writeFileSync(join(dir, name, "patch.diff"), diff); }

/** A research-style origin pool: staged cases with passing validation and content digests (some withdrawn). */
function originCase(pool, id, family, { withdraw = false, hidden = null, tier = "easy" } = {}) {
  const d = join(pool, "cases", id);
  for (const p of ["repo", "hidden", "reference"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, "repo", "index.js"), `export const id = "${id}";\n`);
  writeFileSync(join(d, "hidden", "h.test.js"), hidden ?? `// hidden test of ${id}: ${"x".repeat(80)}\n`);
  writeFileSync(join(d, "reference", "index.js"), `// reference of ${id}\n`);
  writeFileSync(join(d, "task.json"), JSON.stringify({ id, family, tier, instruction: `Solve ${id}`, provenance: "external" }));
  writeFileSync(join(d, "validation.private.json"), JSON.stringify({ ok: true, code: "valid", id }));
  registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family, tier, difficultyBasis: "size-proxy", contentDigest: caseDigest(d) });
  if (withdraw) { const doc = join(pool, `withdraw-${id}.json`); writeFileSync(doc, "{}"); withdrawCase({ pool, caseId: id, code: "cross-pool-overlap", reason: "named in a committed record", evidence: { document: doc, sha256: sha(readFileSync(doc)) } }); }
  return d;
}
function snapshot(dir) { const out = {}; const go = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) go(p); else out[relative(dir, p)] = sha(readFileSync(p)) + ":" + statSync(p).mode; } }; go(dir); return out; }

/**
 * The world: a research origin pool (untouched by the internal track) with withdrawn/eligible cases, a used batch whose run ledger
 * dispatched only u1, a calibration batch, a reserved batch, runner ledgers, content roots, coverage + audit documents.
 */
function world(root, { auditOver = {}, coverageSources = null } = {}) {
  const stable = tree(join(root, "stable"), "export const s = 1;\n");
  const arch = join(root, "archive", "candidates");
  archived(arch, "a1-good", { base: S, diff: patch("export const s = 1;", "export const s = 2;") });
  const devDir = dataset(join(root, "dev-tasks"), [["d1", "gh:dev/one"], ["d2", "gh:dev/two"]], "calibration");
  const reg = join(root, "old-registry.jsonl"); new Ledger(reg).append({ type: "case", caseId: "x-old-1", family: "gh:old/repo", status: "eligible" });
  const ds = dataset(join(root, "old-holdout"), [["o1", "gh:old/ds"]]);
  const pool = join(root, "pool"); mkdirSync(pool, { recursive: true });
  writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false, sealVia: "refresh", requireEvidence: ["validation.private.json"] }));
  const origin = join(root, "research-pool"); mkdirSync(origin, { recursive: true });
  for (let i = 1; i <= 12; i++) originCase(origin, `w${i}`, `gh:own${i}/r${i}`, { withdraw: i % 2 === 0 });
  originCase(origin, "w-ran", "gh:ran/x", { withdraw: true });
  originCase(origin, "w-sibling", "gh:shared/x", { withdraw: true });
  originCase(origin, "w-reviewed", "gh:rev/x", { withdraw: true });
  originCase(origin, "w-dup", "gh:dupe/x", { withdraw: true, hidden: `// hidden test of u1: ${"x".repeat(80)}\n` });
  originCase(origin, "w-unknown", "gh:unk/x", { withdraw: true });
  originCase(origin, "u1", "gh:used/one"); originCase(origin, "u2", "gh:used/two");
  originCase(origin, "c1", "gh:calib/one"); originCase(origin, "r1", "gh:resv/one");
  // Used batch [u1, u2]: its pass dispatched only u1 (readable run ledger); calibration batch [c1]; reserved, unused batch [r1].
  const passState = join(root, "research-runs", "ctrl-pass", "holdout");
  mkdirSync(passState, { recursive: true });
  writeFileSync(join(passState, "runs.jsonl"), `${JSON.stringify({ type: "dispatch", task: "u1" })}\n${JSON.stringify({ type: "result", record: { task_id: "u1", family: "gh:used/one" } })}\n`);
  for (const [b, tasks, extra] of [["bUSED", ["u1", "u2"], {}], ["bCAL", ["c1"], { purpose: "calibration" }], ["bRES", ["r1"], {}]]) {
    const dir = join(origin, "batches", b); mkdirSync(dir, { recursive: true });
    for (const id of tasks) { mkdirSync(join(dir, id, "hidden"), { recursive: true }); writeFileSync(join(dir, id, "hidden", "h.test.js"), readFileSync(join(origin, "cases", id, "hidden", "h.test.js"))); }
    registryOf(origin).append({ type: "batch", batch: b, dir: `batches/${b}`, tasks, sealDigest: "0".repeat(64), ...extra });
  }
  holdoutLedger(join(origin, "batches", "bUSED")).append({ type: "use", stateDir: passState, purpose: "confirmatory holdout" });
  registryOf(origin).append({ type: "reserve", batch: "bRES", stateDir: join(root, "elsewhere"), sealDigest: "0".repeat(64) });
  // Another runner ledger: w-ran executed; a sibling of w-sibling's family executed under another id.
  const runRoot = join(root, "runner-ledgers", "x"); mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(runRoot, "runs.jsonl"), `${JSON.stringify({ type: "result", record: { task_id: "w-ran", family: "gh:ran/x" } })}\n${JSON.stringify({ type: "result", record: { task_id: "other-sibling", family: "gh:shared/x" } })}\n`);
  const content = join(root, "reviews"); mkdirSync(join(content, "cross-provider"), { recursive: true });
  writeFileSync(join(content, "cross-provider", "report.md"), "blind review of w-reviewed: tests are weak\n");
  const sources = coverageSources ?? { runRoots: [join(root, "runner-ledgers"), join(root, "research-runs")], pools: [origin, pool], datasets: [devDir], contentRoots: [content] };
  const coverageDoc = join(root, "coverage.json"); writeFileSync(coverageDoc, JSON.stringify({ schema: "pi-eval-loop/internal-source-coverage@1", auditor: { name: "test operator", kind: "human" }, at: "2026-11-14T00:00:00Z", statement: "every place this loop ran or showed tasks", sources }));
  const selectionDoc = join(root, "selection.json"); writeFileSync(selectionDoc, JSON.stringify({ rule: "sha256(seed:id) order, candidate-blind" }));
  const entry = { contentExposure: "none", modelSessions: "none", analystSessions: "none" };
  const tasks = Object.fromEntries(["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10", "w11", "w12", "w-ran", "w-sibling", "w-reviewed", "w-dup", "u1", "u2", "c1", "r1"].map(id => [id, { ...entry }]));
  tasks["w-unknown"] = { contentExposure: "unknown", modelSessions: "none", analystSessions: "none" };
  const audit = join(root, "audit.json"); writeFileSync(audit, JSON.stringify({ schema: "pi-eval-loop/internal-exposure-audit@1", auditor: { name: "test auditor", kind: "human" }, at: "2026-11-14T00:00:00Z", origin: { pool: origin }, selection: { candidateBlind: true, document: selectionDoc, sha256: sha(readFileSync(selectionDoc)) }, tasks, ...auditOver }));
  const internalPool = join(root, "internal-pool");
  const orche = join(root, "orche"); mkdirSync(orche, { recursive: true });
  const cfg = { schema: "pi-eval-loop/exploration@1", mode: "screening", seriesSeed: "t", stable: { dir: stable, commit: S, runtimeDigest: runtimeDigest(stable) }, pool, lineage: { registries: [reg], datasets: [ds] },
    budget: { ledger: join(root, "budget", "ledger.jsonl"), limit: 6000, scope: "test acceptance" }, runtime: { simulated: true },
    simulation: { enabled: true, p: { stable: 0, c1: 0.5 }, byCandidate: { "archive/a1-good": { p: 1 }, "archive/d1-desc": { p: 1 } }, byStage: { assessment: { "archive/a1-good": { p: 1 }, "archive/d1-desc": { p: 1 } } } },
    orcheDir: orche, parallelism: 1, batchRule: { seed: "t", maxTasks: 6, maxPerFamily: 1, maxPerOwner: 3, maxOwnerShare: 0.5, preferFreshFamilies: true }, supply: { collector: "none" },
    screening: { registry: join(root, "plain-registry.jsonl"), workDir: join(root, "plain-work"),
      candidates: { sources: [{ kind: "archive", dir: arch }], maxCandidates: 12 },
      dev: { tasks: [{ id: "d1", dataset: devDir }, { id: "d2", dataset: devDir }], repeats: 1, promote: { minNetSuccesses: 1 }, maxHours: 2 },
      holdout: { enabled: true, maxHours: 4 }, smoke: { checks: true }, estimate: { attemptsPerUnit: { dev: 5, holdout: 5 } },
      internal: { enabled: true, dir: join(root, "internal"), policy: "operational-unvalidated", maxWaitingQualified: 1, maxAcceptancesWithoutPromotion: 3, select: "best-dev-net", assessment: { enabled: true, maxHours: 4 },
        acceptance: { policy: INTERNAL_ACCEPTANCE_POLICY, pool: internalPool, sources: { runRoots: [join(root, "runner-ledgers"), join(root, "research-runs")], pools: [origin, pool], datasets: [devDir], contentRoots: [content] }, coverage: { document: coverageDoc, sha256: sha(readFileSync(coverageDoc)) } } } } };
  const file = join(root, "internal.json"); writeFileSync(file, JSON.stringify(cfg));
  return { cfg, file, pool, origin, internalPool, audit, coverageDoc, arch, stable, content };
}
const effective = async (file) => { const c = loadExploration(file); return effectiveConfig(c, currentStable(c)); };

test("internal-acceptance@1 is a separate protocol: no hard/private quotas internally, research and exploration rules unchanged; frozen plans are never reinterpreted", () => {
  const root = tempDir();
  try {
    const e = exploreProtocol(), i = internalAcceptanceProtocol();
    assert.deepEqual([e.holdout.hardBasis, e.adoption.requireHardStratum, e.holdout.privateReview], [["source"], true, "cross-provider"], "exploration unchanged");
    assert.deepEqual([i.holdout.hardBasis, i.adoption.requireHardStratum, i.holdout.privateReview], [[], false, "ai-allowed"]);
    assert.deepEqual([i.holdout.minTasks, i.holdout.minFamilies, i.holdout.maxOwnerShare, i.holdout.maxUses, i.holdout.priorFamilyReuse, i.holdout.repeats], [6, 4, 0.5, 1, "forbid", 3], "retained diversity and one-use rules");
    assert.ok(i.policy.waived.some(w => /hard stratum/.test(w)) && /unvalidated/.test(i.policy.sizes));
    assert.equal(planProtocol({}).holdout.hardBasis[0], "source"); assert.equal(planProtocol({ policy: INTERNAL_ACCEPTANCE_POLICY }).adoption.requireHardStratum, false);
    assert.throws(() => planProtocol({ policy: "internal-acceptance@2" }), /never reinterpreted/);
    // The same sealed 6-task, 6-family batch without a hard task: research/exploration rejects it, internal accepts it.
    const b = dataset(join(root, "batch"), [1, 2, 3, 4, 5, 6].map(n => [`t${n}`, `gh:o${n}/r`]), "holdout");
    assert.match(batchEligibility(b, e, { orcheDir: root, priorFamilies: new Set() }).reasons.join(" "), /no hard stratum/);
    assert.deepEqual(batchEligibility(b, i, { orcheDir: root, priorFamilies: new Set() }).reasons, []);
    // Diversity stays required internally: 3 families, or one owner above 0.5.
    const narrow = dataset(join(root, "narrow"), [1, 2, 3, 4, 5, 6].map(n => [`n${n}`, `gh:o${n % 3}/r`]), "holdout");
    assert.match(batchEligibility(narrow, i, { orcheDir: root, priorFamilies: new Set() }).reasons.join(" "), /too narrow|account concentration/);
    const owned = dataset(join(root, "owned"), [1, 2, 3, 4, 5, 6].map(n => [`m${n}`, n <= 4 ? `gh:same/r${n}` : `gh:o${n}/r`]), "holdout");
    assert.match(batchEligibility(owned, i, { orcheDir: root, priorFamilies: new Set() }).reasons.join(" "), /account concentration/);
    // The gate: no hard stratum is INCONCLUSIVE for research, not a reason internally (other rules unchanged).
    const cmp = { tasks: 6, families: 6, hardTasks: 0, support: 0.99, delta: { overall: { mean: 0.5, lo95: 0.2, hi95: 0.8 } }, familyDelta: {}, level: "task" };
    const ev = { holdoutIndependent: true, critical: [], checksPassed: true, routeOk: true, incomplete: [], infraRate: 0, familyCmp: { support: 0.99, families: 6 } };
    assert.match(adoptionDecision(cmp, e, ev).reasons.join(" "), /no hard stratum/);
    assert.equal(adoptionDecision(cmp, i, ev).verdict, "EXPLORATORY_SUPPORTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audited intake: registered/withdrawn but unexposed material imports only with a valid audit; executed, same-family, reviewed, calibration, reserved, duplicate and unknown material is refused; the research pool is never written", async () => {
  const root = tempDir();
  try {
    const w = world(root);
    assert.deepEqual(internalConfigProblems(loadExploration(w.file)), []);
    const before = snapshot(w.origin);
    const cfg = await effective(w.file);
    const ids = ["w1", "w2", "w3", "w4", "w5", "w6", "w-ran", "w-sibling", "w-reviewed", "w-dup", "w-unknown", "u1", "u2", "c1", "r1", "w-missing"];
    // Read-only worksheet: mechanical findings, never a clearance.
    const rep = run(["internal-audit", "--protocol", w.file, "--origin-pool", w.origin, "--ids", ids.join(",")]).out;
    assert.match(rep.note, /NOT cleared/);
    const why = Object.fromEntries(rep.tasks.map(t => [t.id, t.problems.join(" | ")]));
    assert.deepEqual(rep.mechanicallyClear.sort(), ["u2", "w-unknown", "w1", "w2", "w3", "w4", "w5", "w6"].sort());
    assert.match(why["w-ran"], /exposed-task/); assert.match(why["w-sibling"], /exposed-family: gh:shared\/x/); assert.match(why["w-reviewed"], /content-exposed/);
    assert.match(why["w-dup"], /duplicate-content/); assert.match(why.u1, /exposed-task.*dispatched/); assert.match(why.c1, /calibration/); assert.match(why.r1, /live-reservation/); assert.match(why["w-missing"], /origin-missing/);
    // Intake: only audited, unexposed, valid material; u2 (in a used batch, never dispatched) is accepted with its audit.
    const r = await internalIntake({ cfg, originPool: w.origin, audit: w.audit, ids, validate });
    assert.deepEqual(r.imported.map(x => x.id).sort(), ["u2", "w1", "w2", "w3", "w4", "w5", "w6"].sort());
    assert.match(r.refused["w-unknown"].join(" "), /audit-incomplete: contentExposure unknown/);
    assert.match(r.refused["w-reviewed"].join(" "), /audit-conflict/);
    assert.match(r.refused["w-dup"].join(" "), /duplicate-content/);
    assert.deepEqual(snapshot(w.origin), before, "the research pool is never written");
    const st = poolState(w.internalPool);
    assert.equal(st.cases.get("w2").origin.status, "withdrawn"); assert.equal(st.cases.get("w2").origin.contentDigest, caseDigest(join(w.origin, "cases", "w2")));
    assert.equal(st.cases.get("w-ran").status, "rejected");
    // Replay: same ids again are skipped; a grader that fails refuses; a renamed copy (other id, same hidden test) is a duplicate.
    const again = await internalIntake({ cfg, originPool: w.origin, audit: w.audit, ids: ["w1"], validate });
    assert.match(again.skipped.w1, /already in the internal pool/);
    const bad = await internalIntake({ cfg, originPool: w.origin, audit: w.audit, ids: ["w7"], validate: async () => ({ ok: false, code: "reference-fails" }) });
    assert.match(bad.refused.w7[0], /grader-invalid/);
    // Audit document problems refuse everything: missing selection evidence, wrong origin, unknown auditor.
    const a2 = join(root, "audit2.json"); writeFileSync(a2, JSON.stringify({ ...JSON.parse(readFileSync(w.audit, "utf8")), selection: { candidateBlind: true, document: join(root, "nope.json"), sha256: "0".repeat(64) } }));
    assert.match((await internalIntake({ cfg, originPool: w.origin, audit: a2, ids: ["w8"], validate })).refused.w8[0], /audit-evidence-mismatch/);
    const a3 = join(root, "audit3.json"); writeFileSync(a3, JSON.stringify({ ...JSON.parse(readFileSync(w.audit, "utf8")), auditor: {} }));
    assert.match((await internalIntake({ cfg, originPool: w.origin, audit: a3, ids: ["w8"], validate })).refused.w8[0], /attributable/);
    // Unknown exposure fails closed: a malformed runner ledger, or an executed id whose family is unknown.
    mkdirSync(join(root, "runner-ledgers", "y"), { recursive: true }); writeFileSync(join(root, "runner-ledgers", "y", "runs.jsonl"), `${JSON.stringify({ type: "dispatch", task: "mystery-task" })}\n`);
    let idx = exposureIndex(cfg); assert.match(idx.blockers.join(" "), /family-unresolved/);
    assert.match((await internalIntake({ cfg, originPool: w.origin, audit: w.audit, ids: ["w8"], validate })).refused.w8.join(" "), /exposure-unknown/);
    writeFileSync(join(root, "runner-ledgers", "y", "runs.jsonl"), "{not json\n");
    idx = exposureIndex(cfg); assert.match(idx.blockers.join(" "), /malformed/);
    rmSync(join(root, "runner-ledgers", "y"), { recursive: true, force: true });
    // Coverage statement drift (sources changed after the statement) refuses everything.
    const stale = JSON.parse(readFileSync(w.file, "utf8")); stale.screening.internal.acceptance.sources.contentRoots = []; writeFileSync(w.file, JSON.stringify(stale));
    assert.match((await internalIntake({ cfg: await effective(w.file), originPool: w.origin, audit: w.audit, ids: ["w8"], validate })).refused.w8[0], /source-coverage-stale/);
    assert.deepEqual(snapshot(w.origin), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("internal track end to end on the internal pool: no-hard internal batch -> acceptance (plan policy bound) -> promotion -> KEEP; audit drift retires a sealed batch; a descendant gets a disjoint fresh batch; exposure persists; changed policy never reinterprets a frozen plan", { timeout: 600_000 }, async () => {
  const root = tempDir();
  try {
    const w = world(root);
    const c = (n) => join(root, "cycles", `c-${n}`);
    const before = snapshot(w.origin);
    let o = run(["--resume", "--state", c(1), "--protocol", w.file]); assert.equal(o.code, 0, o.err);
    assert.equal(run(["--status", "--summary", "--state", c(1)]).out.final.verdict, "DEV_PROMISING");
    // No audited supply yet: a model-free wait.
    o = run(["--resume", "--state", c(2), "--protocol", w.file]); assert.equal(o.out.status.exploration.code, "supply-empty");
    assert.match(o.out.status.blocked.reason, /internal pool is empty/);
    // Audited intake of 6 single-task families (no hard task at all) -> refresh seals an internal batch.
    const cfg = await effective(w.file);
    const r1 = await internalIntake({ cfg, originPool: w.origin, audit: w.audit, ids: ["w1", "w2", "w3", "w4", "w5", "w6"], validate });
    assert.equal(r1.imported.length, 6);
    let rf = run(["refresh", "--protocol", w.file]); assert.equal(rf.code, 0, JSON.stringify(rf.out)); assert.equal(rf.out.policy, INTERNAL_ACCEPTANCE_POLICY);
    const A = rf.out.available.batch;
    assert.equal(JSON.parse(readFileSync(join(w.internalPool, "batches", A, "PROVENANCE.json"), "utf8")).policy, INTERNAL_ACCEPTANCE_POLICY);
    // Acceptance on the internal batch (crash right after the one use, then resume: one use, one promotion).
    o = run(["--resume", "--state", c(2), "--protocol", w.file], { EVAL_LOOP_FAULT: "holdout:after-use" }); assert.equal(o.signal, "SIGKILL");
    // Replay under a changed policy (acceptance section removed): the frozen internal plan is refused, not reinterpreted.
    const plain = JSON.parse(readFileSync(w.file, "utf8")); delete plain.screening.internal.acceptance; const pf = join(root, "plain.json"); writeFileSync(pf, JSON.stringify(plain));
    o = run(["--resume", "--require-state", "--state", c(2), "--protocol", pf]);
    assert.equal(o.out.outcome, "state_error", JSON.stringify(o.out)); assert.match(o.out.detail, /config differs from the one this cycle was bound to/);
    assert.equal(holdoutLedger(join(w.internalPool, "batches", A)).records().length, 1, "the refused replay used nothing");
    o = run(["--resume", "--require-state", "--state", c(2), "--protocol", w.file]);
    let s = run(["--status", "--summary", "--state", c(2)]).out;
    assert.equal(s.final.verdict, "INTERNAL_PROMOTED", JSON.stringify(s.final)); assert.equal(s.final.adopt, false); assert.equal(s.internal.researchAdopt, false);
    const sub = readdirSync(c(2)).find(f => /^holdout-plan/.test(f));
    assert.equal(JSON.parse(readFileSync(join(c(2), sub), "utf8")).policy, INTERNAL_ACCEPTANCE_POLICY, "policy bound into the frozen plan");
    assert.equal(holdoutLedger(join(w.internalPool, "batches", A)).records().length, 1, "one use");
    const loaded = loadExploration(w.file);
    const p1 = currentStable(loaded);
    o = run(["--resume", "--state", c(3), "--protocol", w.file]); assert.equal(run(["--status", "--summary", "--state", c(3)]).out.final.verdict, "KEEP");
    // Intake more; seal B; then the audit document drifts: the batch is no longer usable and refresh retires it (evidence kept).
    const r2 = await internalIntake({ cfg: await effective(w.file), originPool: w.origin, audit: w.audit, ids: ["w7", "w8", "w9", "w10", "w11", "w12"], validate });
    assert.equal(r2.imported.length, 6);
    rf = run(["refresh", "--protocol", w.file]); const B = rf.out.available.batch; assert.ok(B && B !== A, JSON.stringify(rf.out));
    const auditBytes = readFileSync(w.audit);
    writeFileSync(w.audit, auditBytes.toString().replace("test auditor", "someone else"));
    assert.match(internalBatchProblems(await effective(w.file), B).join(" "), /audit-drift/);
    rf = run(["refresh", "--protocol", w.file]); assert.deepEqual(rf.out.retired, [B]); assert.equal(rf.out.available.ok, false);
    writeFileSync(w.audit, auditBytes);
    // A descendant of the promoted stable: needs a fresh batch whose families share nothing with A (B is retired; re-import
    // under the restored audit is refused as a duplicate of material already in the internal pool).
    archived(w.arch, "d1-desc", { base: p1.commit, diff: patch("export const s = 2;", "export const s = 7;"), createdAt: new Date().toISOString() });
    o = run(["--resume", "--state", c(4), "--protocol", w.file]); assert.equal(run(["--status", "--summary", "--state", c(4)]).out.final.verdict, "DEV_PROMISING");
    o = run(["--resume", "--state", c(5), "--protocol", w.file]); assert.equal(o.out.status.exploration.code, "supply-empty");
    const famA = new Set(poolState(w.internalPool).batches.get(A).tasks.map(id => poolState(w.internalPool).cases.get(id).family));
    for (let i = 13; i <= 18; i++) originCase(w.origin, `v${i}`, `gh:fresh${i}/r`, { withdraw: true });
    const a = JSON.parse(auditBytes.toString()); for (let i = 13; i <= 18; i++) a.tasks[`v${i}`] = { contentExposure: "none", modelSessions: "none", analystSessions: "none" };
    const audit2 = join(root, "audit-v.json"); writeFileSync(audit2, JSON.stringify(a));
    const snap2 = snapshot(w.origin);
    const r3 = await internalIntake({ cfg: await effective(w.file), originPool: w.origin, audit: audit2, ids: ["v13", "v14", "v15", "v16", "v17", "v18", "w1"], validate });
    assert.equal(r3.imported.length, 6); assert.match(r3.skipped.w1, /already/);
    assert.deepEqual(snapshot(w.origin), snap2);
    rf = run(["refresh", "--protocol", w.file]); const C = rf.out.available.batch; assert.ok(C && C !== A && C !== B, JSON.stringify(rf.out));
    assert.ok(poolState(w.internalPool).batches.get(C).tasks.every(id => !famA.has(poolState(w.internalPool).cases.get(id).family)));
    o = run(["--resume", "--require-state", "--state", c(5), "--protocol", w.file]); s = run(["--status", "--summary", "--state", c(5)]).out;
    assert.equal(s.final.verdict, "INTERNAL_PROMOTED", JSON.stringify(s.final)); assert.equal(s.internal.acceptance.batch, C);
    // Exposure persists: A's tasks and families can never be sealed or imported again; status reports the policy.
    const st = run(["internal-status", "--protocol", w.file]).out;
    assert.equal(st.acceptance.policy, INTERNAL_ACCEPTANCE_POLICY); assert.ok(st.acceptance.notRequired.length >= 4);
    assert.ok(st.epochs.reduce((n, e) => n + e.exposed, 0) >= 2);
    const idx = exposureIndex(await effective(w.file));
    for (const id of poolState(w.internalPool).batches.get(A).tasks) assert.match(idx.ids.get(id), /internal acceptance batch/);
    assert.equal(internalSeal(await effective(w.file)).blocked !== undefined, true, "nothing left to seal: used material never returns");
    // The research/exploration pool and the origin pool were never written by the internal track.
    assert.deepEqual(readdirSync(w.pool).sort(), ["POLICY.json"]);
    assert.equal(existsSync(join(w.origin, "selection")), false);
    assert.deepEqual(snapshot(w.origin), snap2, "after the fixture added v13-v18, the internal track wrote nothing to the origin pool");
    for (const [k, v] of Object.entries(before)) if (k !== "registry.jsonl") assert.equal(snapshot(w.origin)[k], v);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
