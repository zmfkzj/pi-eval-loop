// Recurring exploration-only route (2026-11-07): one cycle = one fresh sealed batch, one frozen plan, ONE exploration-only pass
// (src/exploration.mjs runHoldout) of the stable harness vs a fixed candidate. It speaks the CLI contract agent_workflow drives
// (status@1, preflight@1, outcome@1, supply-refresh@1; src/contract.mjs EXIT codes) so the existing recurring orchestration can run
// it in an explicitly configured exploration mode. It NEVER adopts, deploys, promotes, commits or schedules: every final has
// adopt false, explorationOnly true and evidence class "exploratory".
//
// Distinct, safe outcomes (status@1 `exploration.outcome` / `exploration.code`):
//   completed        the pass decided (KEEP_STABLE, EXPLORATORY_SUPPORTED, INCONCLUSIVE ...): a successful cycle of THIS mode only
//   integrity-stop   decided, but the candidate arm had integrity violations: the series stops for a human (no repair, no rerun)
//   incomplete       decided with unmeasured units: kept as is, never rerun
//   consumed-blocked the batch was used but the pass could not decide: kept, never rerun
//   supply-wait      no eligible fresh batch (retryable, model-free)
//   runtime-wait     isolated runtime/credential/peer pressure not usable (retryable, no model call)
//   budget-exhausted the global attempt ledger cannot cover the frozen plan, or refused mid-pass (NOT retryable: a human decision)
//   prerequisite-failed  grader/checks/arm identity failed before consumption (not retryable)
// Budget: every target attempt is admitted by the ONE durable ledger (src/request-budget.mjs; limit fixed at its creation) through
// src/admission.mjs and, in live mode, the isolated runtime's outbound gate. No per-cycle allowance exists.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, OUTCOME_SCHEMA, STATUS_SCHEMA } from "./contract.mjs";
import { verifySeal } from "./datasets.mjs";
import { exploreProtocol, planTasks, runHoldout, runtimeDigest as treeDigest } from "./exploration.mjs";
import { confirmationPolicy, PACKAGE_DIR as LC_PACKAGE, Releases, runSmoke, testProtocol } from "./lifecycle.mjs";
import { merge, routeKey, routeProblems, sameRoute } from "./protocol.mjs";
import { batchLineageProblems, BATCH_RULE, forbiddenSet, lineageRepos, minimaOfExplore, selectAndSeal, sourcesProblems } from "./lineage.mjs";
import { RequestBudget, gatewayPressureMeter } from "./request-budget.mjs";
import { batchEvidenceProblems, DEFAULT_SUPPLY, firstEligibleBatch, mergeSupply, poolPolicy, poolState, recoverPool, registryOf, retireBatch } from "./supply.mjs";
import { acquireLock, atomicWriteJson, digestOf, ensureDir, inspectLock, LockBusyError, readJson, sha256 } from "./util.mjs";
import { screeningConfigProblems, screeningCycle, screeningExclusionTasks, screeningPreflight, screeningStatus } from "./screening.mjs";

export const EXPLORATION_SCHEMA = "pi-eval-loop/exploration@1";
export const CYCLE_SCHEMA = "pi-eval-loop/explore-cycle@1";
export const PREFLIGHT_SCHEMA = "pi-eval-loop/preflight@1";
export const REFRESH_SCHEMA = "pi-eval-loop/supply-refresh@1";
const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Evidence every case of an exploration batch must carry (2026-11-07): enforced by this route itself, whatever the pool's
 * POLICY.json says (omitting or emptying POLICY.requireEvidence cannot switch it off). A config may add files, never remove these.
 */
export const EXPLORATION_REQUIRED_EVIDENCE = Object.freeze(["validation.private.json"]);
const requiredEvidence = (cfg) => [...new Set([...EXPLORATION_REQUIRED_EVIDENCE, ...(cfg.evidence?.required ?? [])])];
const STATE = "explore.json";
const autonomous = (cfg) => cfg.mode === "autonomous";
const screening = (cfg) => cfg.mode === "screening";
const releasesOf = (cfg) => new Releases(cfg.confirmation.deploy.dir);
/** The target route of a config: its explicit `route`, else the package default. */
const targetRoute = (cfg) => exploreProtocol(cfg.route).route;
/** The stable arm: in autonomous mode the deployed release (release history), else the configured stable tree. */
function stableOf(cfg) {
  if (!autonomous(cfg)) return cfg.stable;
  const cur = releasesOf(cfg).current();
  return cur ? { dir: cur.dir, commit: cur.commit ?? `release:${cur.release.slice(0, 16)}`, runtimeDigest: cur.runtimeDigest } : cfg.stable;
}
const LIFECYCLE_PHASES = ["promoted", "confirm-wait", "confirm-selected", "confirm-running", "adopting", "smoke", "postconfirm-wait", "postconfirm-selected", "postconfirm-running"];
const RETRYABLE = new Set(["runtime-wait", "supply-empty", "supply-wait", "supply-error", "confirmation-plan-not-ready", "confirmation-supply-empty", "no-candidate", "dev-supply-empty"]);
/** Problem order: the listed codes first (in order), any other (supply waits) after them. */
const rank = (code) => { const i = PRIORITY.indexOf(code); return i < 0 ? PRIORITY.length : i; };
const PRIORITY = ["config-invalid", "prerequisite-failed", "budget-unusable", "budget-exhausted", "candidate-deployed", "confirmation-infeasible", "confirmation-plan-not-ready", "runtime-wait"];

// ------------------------------------------------------------------------------------------------------------------ config
/** Load and validate an exploration config (absolute paths; frozen candidate identity; lineage sources; one budget). */
export function loadExploration(file) {
  const path = resolve(file);
  let c; try { c = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`exploration config ${path} unreadable: ${error.message}`); }
  const p = [];
  const abs = (v, k) => { if (typeof v !== "string" || !v.startsWith("/")) p.push(`${k} must be an absolute path`); };
  if (c.schema !== EXPLORATION_SCHEMA) p.push(`schema must be ${EXPLORATION_SCHEMA}`);
  if (c.route !== undefined) p.push(...routeProblems(c.route));
  // mode screening (src/screening.mjs): candidates come from the bounded source and the development tasks are the screening
  // tasks; no fixed candidate, no pre-accepted screen report, no whole-pass minRemaining (the route caps size every stage).
  const scr = c.mode === "screening";
  if (scr) { if (c.candidate !== undefined || c.screen !== undefined || c.confirmation !== undefined) p.push("mode screening takes its candidates from screening.candidates and its development tasks from screening.dev (no candidate, screen or confirmation section)"); p.push(...screeningConfigProblems(c)); }
  else {
    abs(c.candidate?.dir, "candidate.dir"); abs(c.screen?.report, "screen.report");
    if (!/^[0-9a-f]{64}$/.test(c.candidate?.identity?.runtimeDigest ?? "")) p.push("candidate.identity.runtimeDigest (frozen sha256) required");
    if (typeof c.candidate?.identity?.commit !== "string") p.push("candidate.identity.commit required");
    if (!/^[0-9a-f]{64}$/.test(c.screen?.reportSha256 ?? "")) p.push("screen.reportSha256 required");
    if (!Array.isArray(c.screen?.tasks) || !c.screen.tasks.length) p.push("screen.tasks (the screening tasks, excluded from every batch) required");
    if (!(Number.isInteger(c.budget?.minRemaining) && c.budget.minRemaining > 0)) p.push("budget.minRemaining (attempts the whole pass may need) required");
  }
  abs(c.stable?.dir, "stable.dir"); abs(c.pool, "pool"); abs(c.budget?.ledger, "budget.ledger");
  if (!/^[0-9a-f]{64}$/.test(c.stable?.runtimeDigest ?? "")) p.push("stable.runtimeDigest (frozen sha256) required");
  p.push(...sourcesProblems(c.lineage));
  if (!(Number.isInteger(c.budget?.limit) && c.budget.limit > 0) || typeof c.budget?.scope !== "string") p.push("budget.limit (integer) and budget.scope required");
  if (c.evidence !== undefined && !(c.evidence && typeof c.evidence === "object" && !Array.isArray(c.evidence) && Object.keys(c.evidence).every(k => k === "required") && (c.evidence.required === undefined || (Array.isArray(c.evidence.required) && c.evidence.required.every(x => typeof x === "string" && /^[A-Za-z0-9._-]+$/.test(x))))))
    p.push(`evidence must be {required?: [file names]} (adds to ${EXPLORATION_REQUIRED_EVIDENCE.join(", ")}; it can never disable the required evidence)`);
  if (c.runtime?.mode !== undefined && !["live", "test"].includes(c.runtime.mode)) p.push("runtime.mode must be live or test");
  const sim = c.simulation?.enabled === true;
  if (sim && !c.runtime?.simulated) p.push("simulation.enabled needs runtime.simulated (offline only)");
  if (!sim && c.runtime?.simulated) p.push("runtime.simulated needs simulation.enabled");
  if (!sim) abs(c.runtime?.dir, "runtime.dir");
  // Simulated-only fault controls (offline rehearsal of the rollback routes): accepted only by a simulated cycle, never by a
  // live one and never by mode screening (whose backend ignores them); see simulatedFromConfig.
  if (c.simulation?.crash !== undefined || c.simulation?.byPhase !== undefined) {
    if (!sim || c.runtime?.simulated !== true) p.push("simulation.crash / simulation.byPhase are simulated-only fault controls: they need simulation.enabled and runtime.simulated");
    if (scr) p.push("simulation.crash / simulation.byPhase are not supported by mode screening");
    p.push(...simulationFaultProblems(c.simulation));
  }
  // mode autonomous (lifecycle): exploration -> registered confirmation -> gate-driven adoption -> smoke -> post-adoption check.
  if (c.mode !== undefined && !["exploration-only", "autonomous", "screening"].includes(c.mode)) p.push("mode must be exploration-only, autonomous or screening");
  if (c.mode === "autonomous") {
    if (!c.confirmation || typeof c.confirmation !== "object") p.push("mode autonomous needs a confirmation section");
    abs(c.screen?.runs, "screen.runs (the measured per-unit attempts size the confirmation budget)");
  }
  if (p.length) throw new Error(`exploration config ${path}: ${p.join("; ")}`);
  return { ...c, ...(scr ? { screen: { tasks: screeningExclusionTasks({ ...c, file: path }) } } : {}), mode: c.mode ?? "exploration-only", file: path, digest: sha256(readFileSync(path)), batchRule: c.batchRule ?? BATCH_RULE, parallelism: c.parallelism ?? 2, simulated: sim };
}

/** Evaluator files bound into a cycle (package src/ and this CLI), absolute path -> sha256 (agent_workflow compares the same set). */
export function evaluatorFiles(pkg = PACKAGE) {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const q = join(d, e.name); if (e.isDirectory()) walk(q); else if (e.isFile()) out[q] = sha256(readFileSync(q)); } };
  walk(join(pkg, "src"));
  const bin = join(pkg, "bin", "eval-loop-explore.mjs");
  if (existsSync(bin)) out[bin] = sha256(readFileSync(bin));
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ status
const readState = (dir) => { const f = join(dir, STATE); if (!existsSync(f)) return { health: existsSync(dir) && readdirSync(dir).length ? "unknown" : "fresh" }; try { const s = JSON.parse(readFileSync(f, "utf8")); return s?.schema === CYCLE_SCHEMA ? { health: "present", state: s } : { health: "corrupt", detail: "explore.json schema" }; } catch { return { health: "corrupt", detail: "explore.json unreadable" }; } };

function finalView(s) {
  const f = s.final;
  if (!f) return null;
  const ev = f.evidence ?? { class: "exploratory", confirmatoryClaim: false };
  return { verdict: f.verdict ?? null, candidate: f.candidate ?? null, adopt: f.adopt === true, explorationOnly: f.explorationOnly !== false, rolledBack: f.rolledBack === true, reasonCount: Array.isArray(f.reasons) ? f.reasons.length : 0, evidence: { class: ev.class, confirmatoryClaim: ev.confirmatoryClaim === true, confirmation: f.confirmation ?? (ev.class === "exploratory" ? "not-applicable" : "not-registered") }, execution: "interleaved" };
}

/** status@1 of a cycle directory (read-only). layout "explore". */
export function exploreStatus(dir) {
  dir = resolve(dir);
  const lock = inspectLock(join(dir, ".lock"));
  const base = { schema: STATUS_SCHEMA, stateDir: dir, layout: "explore", lock: lock.present ? { state: lock.state, pid: lock.owner?.pid ?? null, host: lock.owner?.host ?? null, at: lock.owner?.at ?? null } : { state: "absent" } };
  const info = readState(dir);
  if (info.health !== "present") return { ...base, health: info.health === "unknown" ? "corrupt" : info.health, condition: info.health === "fresh" ? "none" : "state_error", detail: info.detail ?? (info.health === "unknown" ? "directory exists without explore.json" : null) };
  const s = info.state;
  const condition = s.phase === "done" ? "cycle_complete" : s.phase === "blocked" ? "blocked" : "in_progress";
  const final = finalView(s);
  return { ...base, health: "present", condition, phase: s.phase, cycle: 1, strategy: null, protocolDigest: s.configDigest,
    blocked: s.phase === "blocked" ? { reason: s.blocked.reason, retryable: s.blocked.retryable === true, missing: [], problemCount: 0 } : null, halted: null,
    cycleComplete: s.phase === "done", searchStop: null, counters: { candidates: 1, noProgress: 0 }, final,
    acceptance: acceptanceOf(s, final),
    exploration: { mode: s.mode === "autonomous" || s.mode === "screening" ? s.mode : "exploration-only", outcome: s.outcome ?? null, code: s.blocked?.code ?? null, batch: s.batch ? basename(s.batch) : null, ...(s.mode === "screening" ? screeningStatus(s) : {}) },
    ...(s.mode === "autonomous" ? { lifecycle: { stage: s.phase === "blocked" ? s.resumePhase ?? null : s.phase, outcome: s.lifecycleOutcome ?? null, code: s.blocked?.code ?? null, explorationVerdict: s.exploration?.verdict ?? null, confirmVerdict: s.confirm?.verdict ?? null, deployed: s.adoption && !s.rolledBack ? s.adoption.release : null, rolledBack: s.rolledBack === true, confirmation: s.confirmation?.verdict ?? null } } : {}),
    ...(s.adoption ? { adoptedAt: s.adoption.at } : {}),
    doneAt: s.doneAt ?? null, updatedAt: s.updatedAt ?? null, lastInterruption: null };
}

function acceptanceOf(s, final) {
  if (!final) return null;
  const deployed = !!s.adoption && !s.rolledBack, confirmed = s.confirmation?.verdict === "CONFIRMED";
  const stage = s.rolledBack ? "rolled-back" : deployed ? (confirmed ? "adopted-confirmed" : "adopted-unconfirmed") : final.verdict === "EXPLORATORY_SUPPORTED" ? "candidate-accepted-exploratory" : "not-accepted";
  return { stage, candidateAccepted: final.verdict === "EXPLORATORY_SUPPORTED" || final.verdict === "ADOPT", productionAdopted: deployed, confirmed, confirmation: s.confirmation?.verdict ?? null, evidenceClass: final.evidence?.class ?? "exploratory", legacy: false };
}

const outcome = (kind, stateDir, extra = {}) => ({ schema: OUTCOME_SCHEMA, outcome: kind, exitCode: EXIT[kind], stateDir, ...extra, status: existsSync(join(stateDir, STATE)) ? exploreStatus(stateDir) : null, at: new Date().toISOString() });

// ------------------------------------------------------------------------------------------------------------------ checks
function budgetOf(cfg) { return new RequestBudget({ path: cfg.budget.ledger, limit: cfg.budget.limit, scope: cfg.budget.scope }); }

/** Model-free checks shared by preflight and the run: config identities, screen binding, budget, runtime. */
async function readiness(cfg, deps, { pre = true } = {}) {
  const problems = [];
  const { runtimeDigest } = await import("./exploration.mjs");
  if (!screening(cfg)) try { if (runtimeDigest(cfg.candidate.dir) !== cfg.candidate.identity.runtimeDigest) problems.push({ code: "prerequisite-failed", why: "candidate tree differs from the frozen identity" }); } catch (error) { problems.push({ code: "prerequisite-failed", why: `candidate tree unreadable: ${error.message}` }); }
  let stable = null;
  try { stable = stableOf(cfg); if (runtimeDigest(stable.dir) !== stable.runtimeDigest) problems.push({ code: "prerequisite-failed", why: "stable tree differs from its frozen identity" }); } catch (error) { problems.push({ code: "prerequisite-failed", why: `stable / deployed release unusable (fail closed): ${String(error.message).slice(0, 200)}` }); }
  const report = screening(cfg) ? { accepted: true } : readJson(cfg.screen.report, null);
  if (!screening(cfg) && (!report?.accepted || !existsSync(cfg.screen.report) || sha256(readFileSync(cfg.screen.report)) !== cfg.screen.reportSha256)) problems.push({ code: "prerequisite-failed", why: "no accepted integrity screen bound to this config" });
  // The integrity screen is evidence about ONE target route (a report without `route` predates route selection: the default).
  else if (!screening(cfg)) {
    const measured = report.route ?? exploreProtocol().route, target = targetRoute(cfg);
    if (!sameRoute(measured, target)) problems.push({ code: "prerequisite-failed", why: `the integrity screen was measured on ${routeKey(measured)} (${measured.effort}), not on the target route ${routeKey(target)} (${target.effort}): no evidence carries across routes` });
  }
  let budget = null, remaining = null;
  try { budget = budgetOf(cfg); const s = budget.status(); remaining = s.remaining; if (!screening(cfg) && s.remaining < cfg.budget.minRemaining) problems.push({ code: "budget-exhausted", why: `request budget: ${s.remaining} attempts remain of ${cfg.budget.limit}; the plan needs >= ${cfg.budget.minRemaining} (no new cycle; extending the cap is a human decision)` }); }
  catch (error) { problems.push({ code: "budget-unusable", why: `request budget unusable (fail closed): ${String(error.message).slice(0, 200)}` }); }
  // Autonomous mode, before a new exploration commits budget: the candidate must differ from the deployed release, and the
  // registered confirmation must be ready and affordable AFTER this exploration (else exploring could never lead to an adoption).
  if (autonomous(cfg) && pre) {
    if (stable && stable.runtimeDigest === cfg.candidate.identity.runtimeDigest) problems.push({ code: "candidate-deployed", why: "the configured candidate is the deployed release: nothing to explore (a new candidate needs a new config)" });
    const pol = confirmationPolicy(cfg, { remaining: remaining === null ? null : remaining - cfg.budget.minRemaining, reserved: cfg.budget.minRemaining });
    for (const x of pol.problems) problems.push(x);
  }
  if (cfg.route !== undefined && !cfg.simulated) {
    try {
      const { routeCatalogProblems } = await import("./isolated-runtime.mjs");
      const m = readJson(join(cfg.runtime.dir, "manifest.json"), null);
      if (!m?.agentDir) throw new Error("runtime manifest has no agentDir");
      for (const why of routeCatalogProblems(m.agentDir, cfg.route)) problems.push({ code: "prerequisite-failed", why });
    } catch (error) { problems.push({ code: "prerequisite-failed", why: `route catalog validation unavailable: ${String(error.message).slice(0, 200)}` }); }
  }
  const rt = await (deps.runtimeCheck ?? defaultRuntimeCheck)(cfg);
  if (rt.length) problems.push({ code: "runtime-wait", why: `isolated runtime not usable: ${rt.join("; ").slice(0, 300)}` });
  problems.sort((a, b) => rank(a.code) - rank(b.code));
  return { problems, budget, remaining };
}

export async function defaultRuntimeCheck(cfg) {
  if (cfg.simulated) return [];
  const { runtimeProblems } = await import("./isolated-runtime.mjs");
  const out = runtimeProblems(cfg.runtime.dir, { running: false, mode: cfg.runtime.mode ?? "live", budgetPath: cfg.budget.ledger });
  if (cfg.gatewayDb) {
    try { const n = gatewayPressureMeter({ db: cfg.gatewayDb, model: exploreProtocol(cfg.route).route.model }).read(Date.now() - (cfg.pressureMinutes ?? 30) * 60_000); if (n > 0) out.push(`peer protection: ${n} target-model 429/503 failures recently`); }
    catch (error) { out.push(`pressure meter: ${error.message}`); }
  }
  return out;
}

/** Retire every live, never-reserved holdout batch whose tasks are now forbidden by lineage (evidence document; batch kept). */
export function retireContaminated(cfg, { now = new Date() } = {}) {
  const st = poolState(cfg.pool);
  const out = [];
  for (const b of st.batches.values()) {
    if ((b.purpose ?? "holdout") !== "holdout" || st.reservedBatches.has(b.batch)) continue;
    const lineage = batchLineageProblems({ pool: cfg.pool, batch: b.batch, screenPlan: cfg.screen, sources: cfg.lineage });
    // Evidence (never repaired, never regenerated): a batch whose preserved evidence is missing, changed or not a passed
    // validation is retired WITHOUT restaging, so it is neither used nor offered again (no endless supply wait on it).
    const evidence = lineage.length ? [] : batchEvidenceProblems(cfg.pool, b.batch, requiredEvidence(cfg));
    const problems = [...lineage, ...evidence];
    if (!problems.length) continue;
    const kind = lineage.length ? "lineage" : "evidence";
    const doc = join(ensureDir(join(cfg.pool, "retired"), 0o700), `${b.batch}-${kind}-${now.toISOString().replace(/[-:.]/g, "")}.json`);
    writeFileSync(doc, `${JSON.stringify({ schema: "pi-eval-loop/batch-retirement@1", at: now.toISOString(), batch: b.batch, why: `${kind} re-check before use`, problems }, null, 1)}\n`, { mode: 0o400, flag: "wx" });
    retireBatch({ pool: cfg.pool, batch: b.batch, code: `${kind}-recheck`, reason: problems[0].slice(0, 200), evidence: { document: doc, sha256: sha256(readFileSync(doc)) } });
    out.push(b.batch);
  }
  return out;
}

/** The batch a new cycle would use (read-only): the pool's first eligible batch, if it passes the lineage re-check. */
export function nextBatch(cfg, { orcheDir, protocol = null } = {}) {
  if (!orcheDir) throw new Error("nextBatch: orcheDir (the exposure corpus) is required");
  // An exploration never takes a batch sealed for a confirmatory test (larger than the exploration batch rule).
  const excludeSeals = protocol ? [] : [...poolState(cfg.pool).batches.values()].filter(b => b.tasks.length > (cfg.batchRule?.maxTasks ?? BATCH_RULE.maxTasks)).map(b => b.sealDigest);
  const pick = firstEligibleBatch(cfg.pool, protocol ?? exploreProtocol(cfg.route), { orcheDir, excludeSeals });
  if (pick.none) return { none: pick.none };
  const lp = batchLineageProblems({ pool: cfg.pool, batch: pick.batch, screenPlan: cfg.screen, sources: cfg.lineage });
  if (lp.length) return { none: [`${pick.batch}: lineage re-check failed (a refresh retires it): ${lp[0]}`] };
  const ev = batchEvidenceProblems(cfg.pool, pick.batch, requiredEvidence(cfg));
  if (ev.length) return { none: [`${pick.batch}: evidence re-check failed (a refresh retires it): ${ev[0]}`] };
  return pick;
}

/** The exposure corpus directory: deps.orcheDir, the config's orcheDir, else the sandbox's ORCHE (umbrella). */
async function orcheOf(cfg, deps) { return deps.orcheDir ?? cfg.orcheDir ?? (await import("./sandbox.mjs")).ORCHE; }

// ------------------------------------------------------------------------------------------------------------------ preflight
/** preflight@1 (model-free, read-only, creates nothing). ok = a new cycle in stateDir could start now. */
export async function explorePreflight(cfgFile, stateDir, deps = {}) {
  const r = { schema: PREFLIGHT_SCHEMA, stateDir: resolve(stateDir), mode: "exploration-only", ok: false, code: null, reasons: [] };
  let cfg; try { cfg = loadExploration(cfgFile); } catch (error) { return { ...r, code: "config-invalid", reasons: [String(error.message).slice(0, 500)] }; }
  r.mode = cfg.mode;
  const { problems, remaining, budget } = await readiness(cfg, deps);
  r.budget = { remaining, minRemaining: cfg.budget.minRemaining ?? null, limit: cfg.budget.limit, ...(screening(cfg) ? { caps: cfg.screening.caps } : {}) };
  if (problems.length) return { ...r, code: problems[0].code, reasons: problems.map(p => p.why) };
  if (screening(cfg)) return screeningPreflight(cfg, r, { budget, remaining, orcheDir: await orcheOf(cfg, deps), nextBatch });
  let pick; try { pick = nextBatch(cfg, { orcheDir: await orcheOf(cfg, deps) }); } catch (error) { return { ...r, code: "supply-error", reasons: [String(error.message).slice(0, 300)] }; }
  if (pick.none) return { ...r, code: "supply-empty", reasons: pick.none.slice(0, 8) };
  return { ...r, ok: true, code: "ok", holdout: { batch: pick.batch, source: "pool" } };
}

// ------------------------------------------------------------------------------------------------------------------ run
const BUDGET_RE = /request budget|budget refused|request ceiling|outbound attempt refused|ledger/i;

/**
 * One cycle (lock-taking): init (fresh dir; only without requireState) -> select + freeze -> ONE pass -> done. Resume continues
 * where it stopped; the batch use is recorded once by runHoldout (a resume reuses it). deps: { backend, validate, checks,
 * envDigest, runtimeCheck, startRuntime, stopRuntime, bound, orcheDir, log } (the CLI passes the real ones).
 */
export async function runExploreCycle(cfgFile, stateDir, { requireState = false, deps = {} } = {}) {
  stateDir = resolve(stateDir);
  let cfg; try { cfg = loadExploration(cfgFile); } catch (error) { return outcome("usage", stateDir, { detail: String(error.message).slice(0, 400) }); }
  const info = readState(stateDir);
  if (info.health === "corrupt" || info.health === "unknown") return outcome("state_error", stateDir, { health: "corrupt", detail: info.detail ?? "directory exists without explore.json" });
  if (info.health === "fresh" && requireState) return outcome("state_error", stateDir, { health: "missing", detail: "no exploration state (--require-state)" });
  ensureDir(stateDir, 0o700);
  let lock;
  try { lock = acquireLock(join(stateDir, ".lock")); } catch (error) { if (error instanceof LockBusyError) return outcome("busy", stateDir, { lock: { state: "live" } }); throw error; }
  let started = false, users = null;
  try {
    let s = readState(stateDir).state;
    const initialized = !s;
    const evaluator = evaluatorFiles();
    if (!s) {
      s = { schema: CYCLE_SCHEMA, phase: "init", config: cfg.file, configDigest: cfg.digest, createdAt: new Date().toISOString() };
      atomicWriteJson(join(stateDir, "protocol.lock.json"), { schema: "pi-eval-loop/explore-lock@1", protocolDigest: cfg.digest, config: cfg.file, ...(cfg.route !== undefined ? { route: cfg.route } : {}), evaluator });
      save(stateDir, s);
    }
    // A cycle is bound to its config and evaluator: a change is never continued in the same directory.
    const lockRec = readJson(join(stateDir, "protocol.lock.json"), null);
    if (s.configDigest !== cfg.digest || lockRec?.protocolDigest !== cfg.digest) return outcome("state_error", stateDir, { health: "corrupt", detail: "exploration config differs from the one this cycle was bound to (use a new state directory)" });
    const drift = Object.entries(lockRec.evaluator ?? {}).filter(([f, h]) => evaluator[f] !== h).map(([f]) => f).concat(Object.keys(evaluator).filter(f => !(f in (lockRec.evaluator ?? {}))));
    if (drift.length) return outcome("state_error", stateDir, { health: "corrupt", detail: `evaluator changed since this cycle started: ${drift.slice(0, 3).join(", ")}` });
    if (s.phase === "done") return outcome("idle", stateDir, { note: "cycle already complete (never rerun)" });
    if (s.phase === "blocked" && !s.blocked.retryable && !["budget-exhausted", "confirmation-infeasible", "candidate-deployed"].includes(s.blocked.code)) return outcome("blocked", stateDir, { note: "blocked (not retryable)" });
    if (!s.mode) { s = { ...s, mode: cfg.mode }; save(stateDir, s); }
    if (autonomous(cfg)) { try { releasesOf(cfg).init(cfg.stable); } catch (error) { return outcome("state_error", stateDir, { health: "corrupt", detail: `release history: ${String(error.message).slice(0, 200)}` }); } }
    const block = (code, reason, retryable, back = s.batch ? "selected" : "init") => { s = { ...s, phase: "blocked", resumePhase: back, outcome: code, blocked: { code, reason: String(reason).slice(0, 300), retryable } }; save(stateDir, s); return outcome("blocked", stateDir, { initialized: initialized || undefined }); };
    // Reservations left open by a cycle that was killed (dead owner pid) are settled at the attempt floor first.
    try { await budgetOf(cfg).reconcileDead({ by: "explore-cycle" }); } catch { /* readiness reports an unusable ledger */ }
    const pre = s.phase === "init" || (s.phase === "blocked" && (s.resumePhase ?? "init") === "init");
    const ready = await readiness(cfg, deps, { pre });
    if (ready.problems.length) { const p0 = ready.problems[0]; return block(p0.code, ready.problems.map(x => x.why).join(" | "), RETRYABLE.has(p0.code), s.phase === "blocked" ? s.resumePhase : undefined); }
    if (s.phase === "blocked") s = { ...s, phase: s.resumePhase ?? "init", blocked: undefined };
    const orcheDir = await orcheOf(cfg, deps);
    // Runtime + backend for one pass (memoized per invocation): the isolated runtime's gate admits every attempt.
    let rtMemo = null;
    const setupRun = async (forPlan) => {
      if (rtMemo) return rtMemo;
      let bound = deps.bound ?? null;
      if (!cfg.simulated) {
        const r0 = await liveRuntime();
        if (r0.out) return r0;
        bound = r0.bound;
      }
      const live = cfg.simulated || (deps.backend && deps.validate && deps.checks && deps.envDigest) ? null : await liveDeps(cfg, stateDir, forPlan);
      const backend = deps.backend ?? (cfg.simulated ? await simulatedFromConfig(cfg, () => s?.phase) : live.backend);
      rtMemo = { bound, backend,
        validate: deps.validate ?? (cfg.simulated ? async () => ({ ok: true, expected: {}, baselineFailing: [] }) : live.validate),
        checks: deps.checks ?? (cfg.simulated ? async () => ({ pass: true, problems: [] }) : live.checks),
        envDigest: deps.envDigest ?? (cfg.simulated ? { digest: "simulated", facts: {} } : live.envDigest) };
      return rtMemo;
    };
    const liveRuntime = async () => {
    // Isolated runtime (every non-simulated cycle, whatever backend runs the arms): started here when configured and stopped by
    // the cycle that started it once no other cycle uses it; its gate admits every provider attempt against this config's ledger.
    // The shared gateway is never a fallback: an unusable runtime blocks the cycle before any dispatch.
      const rt = await import("../studies/confirmatory-1/isolated-runtime.mjs");
      const { runtimeProblems } = await import("./isolated-runtime.mjs");
      const mode = cfg.runtime.mode ?? "live";
      const check = () => runtimeProblems(cfg.runtime.dir, { running: true, mode, budgetPath: cfg.budget.ledger });
      let manifest;
      try { manifest = JSON.parse(readFileSync(join(cfg.runtime.dir, "manifest.json"), "utf8")); } catch (error) { return { out: block("runtime-wait", `runtime manifest unreadable: ${error.message}`, true) }; }
      if (resolve(manifest.budget?.path ?? "") !== resolve(cfg.budget.ledger) || manifest.budget?.limit !== cfg.budget.limit || manifest.budget?.scope !== cfg.budget.scope) return { out: block("prerequisite-failed", "the runtime's gate charges another ledger (path, limit or scope) than this config: misbound runtime", false) };
      if (process.env.EVAL_LOOP_UPSTREAM && process.env.EVAL_LOOP_UPSTREAM !== manifest.upstream) return { out: block("prerequisite-failed", `EVAL_LOOP_UPSTREAM ${process.env.EVAL_LOOP_UPSTREAM} is not the isolated runtime (${manifest.upstream}): refusing any other upstream`, false) };
      if (process.env.EVAL_LOOP_AGENT_DIR && resolve(process.env.EVAL_LOOP_AGENT_DIR) !== resolve(manifest.agentDir)) return { out: block("prerequisite-failed", "EVAL_LOOP_AGENT_DIR is not the isolated runtime's agent dir", false) };
      users = join(cfg.runtime.dir, "users"); mkdirSync(users, { recursive: true, mode: 0o700 });
      writeFileSync(join(users, `${process.pid}.json`), JSON.stringify({ pid: process.pid, stateDir, at: new Date().toISOString() }), { mode: 0o600 });
      if (cfg.runtime.autoStart && check().length) {
        try { await (deps.startRuntime ?? rt.startRuntime)(cfg.runtime.dir, { mode }); started = true; writeFileSync(join(users, "started-by.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 }); }
        catch (error) { if (check().length) return { out: block("runtime-wait", `runtime start failed: ${String(error.message).slice(0, 200)}`, true) }; }
      }
      process.env.EVAL_LOOP_UPSTREAM = manifest.upstream; process.env.EVAL_LOOP_AGENT_DIR = manifest.agentDir;
      const bound = () => { const pr = check(); if (pr.length) throw new Error(`isolated runtime: ${pr.join("; ")}`); return { perRequest: 2, gated: true }; };
      try { bound(); } catch (error) { return { out: block("runtime-wait", error.message, true) }; }
      return { bound };
    };
    // One holdout pass of this cycle (exploration, confirmatory holdout or post-adoption confirmation): verified frozen plan,
    // evidence re-check before consumption, runtime, ONE runHoldout. Returns { r } or { out } (a blocked/state outcome).
    const pass = async ({ planFile, planSha, sub, back, dropTo }) => {
      const plan = readJson(join(stateDir, planFile), null);
      if (!plan || sha256(readFileSync(join(stateDir, planFile))) !== planSha) return { out: outcome("state_error", stateDir, { health: "corrupt", detail: `frozen ${planFile} missing or changed` }) };
      // Before the batch is consumed (also after a restart): its preserved evidence must still verify, else the selection is
      // dropped (nothing reserved or used) and the next selection retires the batch.
      const consumed = existsSync(join(plan.holdout.batch, "USES.jsonl")) && readFileSync(join(plan.holdout.batch, "USES.jsonl"), "utf8").includes(JSON.stringify(join(stateDir, sub)));
      if (!consumed) {
        const ev = batchEvidenceProblems(cfg.pool, basename(plan.holdout.batch), requiredEvidence(cfg));
        if (ev.length) { s = { ...s, batch: undefined }; return { out: block("supply-error", `selected batch failed its evidence re-check before use (not consumed): ${ev[0]}`, true, dropTo) }; }
      }
      const run = await setupRun(plan);
      if (run.out) return run;
      const priorFamilies = new Set(forbiddenSet({ pool: cfg.pool, screenPlan: cfg.screen, sources: cfg.lineage, excludeBatch: basename(plan.holdout.batch) }).keys());
      s = { ...s, phase: back.replace(/-selected$|^selected$/, (m) => m === "selected" ? "running" : "-running"), runningSince: s.runningSince ?? new Date().toISOString() }; save(stateDir, s);
      let r;
      try { r = await runHoldout({ plan, state: join(stateDir, sub), backend: run.backend, budget: ready.budget, bound: run.bound, parallelism: cfg.parallelism, priorFamilies, orcheDir, poolDir: cfg.pool, validate: run.validate, checks: run.checks, envDigest: run.envDigest, log: deps.log ?? (() => {}), requireValidation: !run.backend.simulated }); }
      catch (error) {
        // Another cycle or a refresh holds the pool lock while this one reserves its batch: nothing was reserved or used.
        if (error instanceof LockBusyError) return { out: block("supply-wait", `pool busy while reserving the batch (not reserved, not consumed): ${String(error.message).slice(0, 200)}`, true, back) };
        throw error;
      }
      if (r.paused) { const budgetHalt = !/isolated runtime/.test(r.paused) && BUDGET_RE.test(r.paused); return { out: block(budgetHalt ? "budget-exhausted" : "runtime-wait", r.paused, !budgetHalt, back) }; }
      if (r.verdict === "BLOCKED" && !r.holdoutEvaluated) {
        // Nothing consumed: the blocked decision is kept under another name so a later resume may decide again.
        const f = join(stateDir, sub, "final.json");
        if (existsSync(f)) renameSync(f, join(stateDir, sub, `blocked-${Date.now()}.json`));
        const why = (r.reasons ?? []).join("; ");
        if (BUDGET_RE.test(why) && !/series error budget/.test(why)) return { out: block(/open reservation/.test(why) ? "runtime-wait" : "budget-exhausted", why, /open reservation/.test(why), back) };
        if (/series error budget/.test(why)) return { out: block("confirmation-infeasible", why, false, back) };
        if (/would not hand out|reservation did not return|no independent holdout/.test(why)) { s = { ...s, batch: undefined }; return { out: block(dropTo === "init" ? "supply-wait" : "confirmation-supply-empty", why, true, dropTo) }; }
        return { out: block("prerequisite-failed", why, false, back) };
      }
      return { r, plan };
    };
    const done = (lifecycleOutcome, final, extra = {}) => { s = { ...s, ...extra, phase: "done", outcome: s.mode === "autonomous" ? lifecycleOutcome : s.outcome, lifecycleOutcome: s.mode === "autonomous" ? lifecycleOutcome : undefined, doneAt: new Date().toISOString(), final }; save(stateDir, s); return outcome("cycle_done", stateDir, { initialized: initialized || undefined, note: `${s.mode === "autonomous" ? "lifecycle" : "exploration"} ${s.outcome}: ${final?.verdict ?? ""}` }); };

    if (screening(cfg)) return await screeningCycle({ cfg, stateDir, deps, ready, orcheDir, initialized, get s() { return s; }, set s(v) { s = v; }, block, done, pass, setupRun,
      helpers: { nextBatch, recoverPool, retireContaminated, liveDeps, save, outcome: (kind, dir, extra) => outcome(kind, dir, { initialized: initialized || undefined, ...extra }) } });
    if (["init", "selected", "running"].includes(s.phase)) {
      if (s.phase === "init") {
        try { recoverPool(cfg.pool); retireContaminated(cfg); } catch (error) { return block("supply-error", `pool recovery / lineage+evidence re-check: ${error.message}`, true); }
        const pick = nextBatch(cfg, { orcheDir });
        if (pick.none) return block("supply-empty", `no eligible unused holdout batch in the supply pool: ${pick.none.slice(0, 3).join("; ")}`, true, "init");
        const seal = verifySeal(pick.dir);
        if (!seal.ok) return block("supply-error", `batch seal: ${seal.why}`, true, "init");
        const plan = { ...(cfg.route !== undefined ? { route: cfg.route } : {}), seed: `${cfg.seriesSeed ?? "exploration"}:${basename(stateDir)}`, stable: stableOf(cfg), candidate: cfg.candidate, screen: cfg.screen, holdout: { batch: pick.dir, seal: seal.seal.digest, pool: cfg.pool, minRemaining: cfg.budget.minRemaining } };
        atomicWriteJson(join(stateDir, "plan.json"), plan);
        s = { ...s, phase: "selected", batch: pick.dir, planSha256: sha256(readFileSync(join(stateDir, "plan.json"))) };
        save(stateDir, s);
      }
      const x = await pass({ planFile: "plan.json", planSha: s.planSha256, sub: "holdout", back: "selected", dropTo: "init" });
      if (x.out) return x.out;
      const r = x.r;
      const c1 = r.arms?.c1 ?? {};
      const out = !r.holdoutEvaluated || r.verdict === "BLOCKED" ? "consumed-blocked" : (c1.integrityViolations || c1.strictViolations) ? "integrity-stop" : r.incomplete ? "incomplete" : "completed";
      const final = { verdict: r.verdict, candidate: cfg.candidate.identity.commit, adopt: false, explorationOnly: true, evidence: r.evidence, reasons: r.reasons ?? [], arms: r.arms, holdout: r.holdout ? { batch: basename(r.holdout.batch), tasks: r.holdout.tasks, families: r.holdout.families, support: r.holdout.support, familySupport: r.holdout.familySupport } : null, incomplete: r.incomplete ?? 0, budget: r.budget };
      s = { ...s, outcome: out, exploration: { verdict: r.verdict, outcome: out, finalSha256: sha256(readFileSync(join(stateDir, "holdout", "final.json"))), stable: x.plan.stable.runtimeDigest } };
      if (!autonomous(cfg)) return done(null, final);
      // Promotion (autonomous): only a completed exploration whose verdict is EXPLORATORY_SUPPORTED with zero candidate
      // integrity violations is carried into a registered confirmation; everything else ends the cycle (never adopted).
      if (!(out === "completed" && r.verdict === "EXPLORATORY_SUPPORTED")) return done(out === "completed" ? "explored-negative" : out, final);
      s = { ...s, phase: "promoted", final }; save(stateDir, s);
    }
    if (!autonomous(cfg) || !LIFECYCLE_PHASES.includes(s.phase)) return outcome("state_error", stateDir, { health: "corrupt", detail: `phase ${s.phase} is not part of the ${cfg.mode} route` });
    return await lifecycle({ cfg, stateDir, deps, ready, orcheDir, get s() { return s; }, set s(v) { s = v; }, block, done, pass, setupRun });
  } finally {
    if (users) rmSync(join(users, `${process.pid}.json`), { force: true });
    // Stopped by the cycle that started it -- or, when that cycle was killed, by the next auto-starting cycle -- once no other
    // live cycle uses it. A runtime started by hand (no started-by record) is never stopped here.
    const orphanedStart = !started && users && cfg.runtime?.autoStart && (() => { const b = readJson(join(users, "started-by.json"), null); if (!b?.pid) return false; try { process.kill(b.pid, 0); return false; } catch { return true; } })();
    if ((started || orphanedStart) && !otherRuntimeUsers(users)) { try { (deps.stopRuntime ?? (await import("../studies/confirmatory-1/isolated-runtime.mjs")).stopRuntime)(cfg.runtime.dir); rmSync(join(users, "started-by.json"), { force: true }); } catch { /* reported by the next status */ } }
    lock.release();
  }
}

/**
 * The lifecycle after a promoted exploration (autonomous mode; same lock, same state file). Phases:
 *   promoted -> (registration frozen) confirm-wait -> confirm-selected -> confirm-running -> [gate]
 *     ADOPT (confirmatory claim) -> adopting -> smoke -> (confirmation registered ? postconfirm-wait -> ... -> CONFIRMED : adopted)
 *     anything else -> done confirm-negative (never adopted)
 *   smoke failure, NOT_CONFIRMED, INCONCLUSIVE or a consumed-but-undecided confirmation -> rollback -> done rolled-back.
 * Every phase is resumable; each batch is reserved and used once (runHoldout); the registration and each test plan are frozen
 * (sha256 in the state) before the test's batch is consumed.
 */
/**
 * Confirmatory supply demand: a lifecycle waiting for its (post-)confirmation batch records it in the pool, so the refresh seals a
 * batch of the registered size instead of exploration-sized ones (which would strand the cases). Only a state still in that
 * wait counts; anything else is stale and ignored.
 */
const demandFile = (cfg) => join(cfg.pool, "selection", "demand-confirmatory.json");
function activeDemand(cfg) {
  const d = readJson(demandFile(cfg), null);
  if (!d?.stateDir) return null;
  const st = readJson(join(d.stateDir, "explore.json"), null);
  const phase = st?.phase === "blocked" ? st.resumePhase : st?.phase;
  return phase === "confirm-wait" || phase === "postconfirm-wait" ? d : null;
}

async function lifecycle(ctx) {
  const { cfg, stateDir, block, done, pass } = ctx;
  const R = releasesOf(cfg);
  const regFile = join(stateDir, "registration.json");
  const readReg = () => { if (!existsSync(regFile) || sha256(readFileSync(regFile)) !== ctx.s.registrationSha256) return null; return JSON.parse(readFileSync(regFile, "utf8")); };
  for (let guard = 0; guard < 12; guard++) {
    const s = ctx.s;
    if (s.phase === "promoted") {
      // Registration BEFORE any confirmatory outcome: candidate, baseline (the deployed release the exploration measured
      // against), the registered protocol (by sha256), the readiness record's sha256 and the budget sizing.
      const pol = confirmationPolicy(cfg, { remaining: budgetOf(cfg).status().remaining });
      if (pol.problems.length) { const p0 = pol.problems.sort((a, b) => rank(a.code) - rank(b.code))[0]; return block(p0.code, pol.problems.map(x => x.why).join(" | "), RETRYABLE.has(p0.code), "promoted"); }
      const cur = R.current({ repair: true });
      if (cur.runtimeDigest !== s.exploration.stable) return done("explored-negative", { ...s.final, reasons: [...(s.final.reasons ?? []), "deployed release changed since the exploration: its evidence is stale for the current baseline"] });
      if (treeDigest(cfg.candidate.dir) !== cfg.candidate.identity.runtimeDigest) return block("prerequisite-failed", "candidate tree changed since the exploration (stale)", false, "promoted");
      const reg = { schema: "pi-eval-loop/confirmation-registration@1", registeredAt: new Date().toISOString(), ...(cfg.route !== undefined ? { route: cfg.route } : {}), candidate: cfg.candidate, stable: { dir: cur.dir, commit: cur.commit ?? `release:${cur.release.slice(0, 16)}`, runtimeDigest: cur.runtimeDigest, release: cur.release },
        protocol: pol.registered, protocolSha256: pol.protocolSha256, readinessSha256: pol.readinessSha256, exploration: { finalSha256: s.exploration.finalSha256, verdict: s.exploration.verdict }, units: pol.units, attemptsPerUnit: cfg.confirmation.attemptsPerUnit, smokeAttempts: cfg.confirmation.smokeAttempts };
      if (!existsSync(regFile)) writeFileSync(regFile, `${JSON.stringify(reg, null, 1)}\n`, { mode: 0o400, flag: "wx" });
      ctx.s = { ...s, phase: "confirm-wait", registrationSha256: sha256(readFileSync(regFile)) }; save(stateDir, ctx.s);
      continue;
    }
    const reg = readReg();
    if (!reg) return outcome("state_error", stateDir, { health: "corrupt", detail: "confirmation registration missing or changed" });
    if (s.phase === "confirm-wait" || s.phase === "postconfirm-wait") {
      const purpose = s.phase === "confirm-wait" ? "holdout" : "confirmation";
      const part = testProtocol(reg.protocol, purpose);
      const p = merge(exploreProtocol(cfg.route), part);
      try { recoverPool(cfg.pool); retireContaminated(cfg); } catch (error) { return block("supply-error", `pool recovery / re-check: ${error.message}`, true, s.phase); }
      const pick = nextBatch(cfg, { orcheDir: ctx.orcheDir, protocol: p });
      const ap = p.analysisPlan;
      if (!pick.none && ((pick.coverage?.hard ?? pick.coverage?.hardTasks ?? 0) < (ap.minHardTasks ?? 0) || (pick.coverage?.tasks ?? 0) < ap.minTasks || (pick.coverage?.families ?? 0) < ap.minFamilies)) pick.none = [`${pick.batch}: coverage ${JSON.stringify(pick.coverage)} below the registered minima (${ap.minTasks} tasks / ${ap.minFamilies} families / ${ap.minHardTasks ?? 0} accepted hard)`];
      if (pick.none) atomicWriteJson(join(ensureDir(join(cfg.pool, "selection"), 0o700), "demand-confirmatory.json"), { schema: "pi-eval-loop/confirmatory-demand@1", stateDir: resolve(stateDir), purpose, minTasks: p.holdout.minTasks, minFamilies: p.holdout.minFamilies, at: new Date().toISOString() });
      else if (readJson(demandFile(cfg), null)?.stateDir === resolve(stateDir)) rmSync(demandFile(cfg), { force: true });
      if (pick.none) return block("confirmation-supply-empty", `no eligible unused batch meeting the registered ${purpose === "holdout" ? "confirmatory holdout" : "post-adoption confirmation"} minima (${p.holdout.minTasks} tasks / ${p.holdout.minFamilies} families): ${pick.none.slice(0, 3).join("; ")}`, true, s.phase);
      const seal = verifySeal(pick.dir);
      if (!seal.ok) return block("supply-error", `batch seal: ${seal.why}`, true, s.phase);
      // Headroom for THIS selected batch (actual size) plus what must follow it, before anything is reserved or consumed.
      const tasks = pick.coverage?.tasks ?? poolState(cfg.pool).batches.get(pick.batch)?.tasks.length ?? 0;
      const units = 2 * tasks * p.holdout.repeats;
      const need = (units + (purpose === "holdout" ? reg.units.post : 0)) * reg.attemptsPerUnit + (purpose === "holdout" ? reg.smokeAttempts : 0);
      const left = budgetOf(cfg).status();
      if (left.remaining < need) return block("confirmation-infeasible", `the ${purpose} pass on ${pick.batch} needs ${need} attempts (${units} units x ${reg.attemptsPerUnit}${purpose === "holdout" ? ` + post-confirmation ${reg.units.post} units + smoke` : ""}); the ledger has ${left.remaining} (never raised here)`, false, s.phase);
      const adopted = purpose === "confirmation" ? s.adoption : null;
      const plan = { ...(cfg.route !== undefined ? { route: cfg.route } : {}), seed: `${cfg.seriesSeed ?? "lifecycle"}:${basename(stateDir)}:${purpose}`, screen: cfg.screen,
        stable: purpose === "holdout" ? reg.stable : { dir: join(R.dir, "releases", adopted.previous.release), commit: adopted.previous.commit ?? `release:${adopted.previous.release.slice(0, 16)}`, runtimeDigest: adopted.previous.runtimeDigest },
        candidate: purpose === "holdout" ? reg.candidate : { dir: join(R.dir, "releases", adopted.release), identity: { commit: reg.candidate.identity.commit, runtimeDigest: adopted.release } },
        holdout: { batch: pick.dir, seal: seal.seal.digest, pool: cfg.pool, minRemaining: need }, analysis: { mode: "confirmatory", purpose, protocol: part, base: LC_PACKAGE, registrationSha256: s.registrationSha256 } };
      const file = purpose === "holdout" ? "confirm-plan.json" : "postconfirm-plan.json";
      atomicWriteJson(join(stateDir, file), plan);
      ctx.s = { ...s, phase: purpose === "holdout" ? "confirm-selected" : "postconfirm-selected", batch: pick.dir, [purpose === "holdout" ? "confirmPlanSha256" : "postPlanSha256"]: sha256(readFileSync(join(stateDir, file))) }; save(stateDir, ctx.s);
      continue;
    }
    if (["confirm-selected", "confirm-running", "postconfirm-selected", "postconfirm-running"].includes(s.phase)) {
      const confirm = s.phase.startsWith("confirm");
      const x = await pass({ planFile: confirm ? "confirm-plan.json" : "postconfirm-plan.json", planSha: confirm ? s.confirmPlanSha256 : s.postPlanSha256, sub: confirm ? "confirm" : "postconfirm", back: confirm ? "confirm-selected" : "postconfirm-selected", dropTo: confirm ? "confirm-wait" : "postconfirm-wait" });
      if (x.out) return x.out;
      const r = x.r;
      const f = { verdict: r.verdict, candidate: reg.candidate.identity.commit, adopt: false, explorationOnly: false, evidence: r.evidence, reasons: r.reasons ?? [], arms: r.arms, holdout: r.holdout ? { batch: basename(r.holdout.batch), tasks: r.holdout.tasks, families: r.holdout.families, support: r.holdout.support, familySupport: r.holdout.familySupport } : null, confirmatory: r.confirmatory ?? null, incomplete: r.incomplete ?? 0 };
      if (confirm) {
        ctx.s = { ...ctx.s, confirm: { verdict: r.verdict, adopt: r.adopt === true, finalSha256: sha256(readFileSync(join(stateDir, "confirm", "final.json"))) } };
        const c1 = r.arms?.c1 ?? {};
        // The original gate AND the registered confirmatory checks decided ADOPT with a confirmatory claim: deploy. Anything
        // else (KEEP_STABLE, INCONCLUSIVE, consumed BLOCKED, any candidate integrity violation) ends the cycle unadopted.
        if (r.adopt === true && r.verdict === "ADOPT" && r.evidence?.confirmatoryClaim === true && !c1.integrityViolations && !c1.strictViolations && !r.incomplete) { ctx.s = { ...ctx.s, phase: "adopting", final: f }; save(stateDir, ctx.s); continue; }
        return done("confirm-negative", f);
      }
      ctx.s = { ...ctx.s, confirmation: { verdict: r.verdict, finalSha256: sha256(readFileSync(join(stateDir, "postconfirm", "final.json"))) } };
      if (r.verdict === "CONFIRMED") return done("confirmed", { ...ctx.s.final, confirmation: "CONFIRMED" });
      const rb = R.rollback({ key: stateDir, reason: `post-adoption confirmation ${r.verdict}` });
      return done("rolled-back", { ...ctx.s.final, adopt: false, rolledBack: true, confirmation: r.verdict, reasons: [...(ctx.s.final.reasons ?? []), `rolled back: independent confirmation ${r.verdict}`] }, { rolledBack: true, rollback: rb.record ? { seq: rb.record.seq } : rb });
    }
    if (s.phase === "adopting") {
      // Gate-driven adoption: the release pointer moves from the registered baseline to the candidate (compare-and-swap).
      const a = R.adopt({ key: stateDir, expect: reg.stable.release, candidate: { dir: reg.candidate.dir, runtimeDigest: reg.candidate.identity.runtimeDigest, commit: reg.candidate.identity.commit }, evidence: { confirmFinalSha256: s.confirm.finalSha256, registrationSha256: s.registrationSha256, verdict: s.confirm.verdict } });
      const confReq = reg.protocol.analysisPlan.confirmation?.required === true;
      ctx.s = { ...s, phase: "smoke", adoption: { release: a.record.release, previous: a.previous, seq: a.record.seq, at: a.record.at ?? new Date().toISOString() }, final: { ...s.final, verdict: "ADOPT", adopt: true, confirmation: confReq ? "required" : "not-registered" } };
      save(stateDir, ctx.s);
      continue;
    }
    if (s.phase === "smoke") {
      // The consumer of the release pointer (the next cycle's stable arm) resolves it; the smoke runs exactly that resolved tree.
      const cur = R.current({ repair: true });
      if (cur.release !== s.adoption.release) return block("prerequisite-failed", `deployed release ${cur.release} is not the adopted ${s.adoption.release}`, false, "smoke");
      const run = await ctx.setupRun({ stable: { dir: cur.dir }, candidate: { dir: cur.dir } });
      if (run.out) return run.out;
      const task = planTasks(cfg.screen.tasks)[0];
      const sm = await runSmoke({ state: join(stateDir, "smoke"), route: cfg.route, harness: { id: "deployed", kind: "orche", commit: reg.candidate.identity.commit, mode: "single", dir: cur.dir }, task, backend: run.backend, budget: ctx.ready.budget, bound: run.bound, envDigest: run.envDigest, validate: run.validate });
      if (sm.paused) { const budgetHalt = !/isolated runtime/.test(sm.paused) && BUDGET_RE.test(sm.paused); return block(budgetHalt ? "budget-exhausted" : "runtime-wait", sm.paused, !budgetHalt, "smoke"); }
      if (!sm.ok) {
        const rb = R.rollback({ key: stateDir, reason: `post-adoption smoke: ${sm.terminal ?? sm.why}` });
        return done("rolled-back", { ...s.final, adopt: false, rolledBack: true, reasons: [...(s.final.reasons ?? []), `rolled back: smoke ${sm.terminal ?? sm.why}`] }, { rolledBack: true, rollback: rb.record ? { seq: rb.record.seq } : rb });
      }
      if (reg.protocol.analysisPlan.confirmation?.required === true) { ctx.s = { ...s, phase: "postconfirm-wait", smoke: { ok: true } }; save(stateDir, ctx.s); continue; }
      return done("adopted", s.final, { smoke: { ok: true } });
    }
    return outcome("state_error", stateDir, { health: "corrupt", detail: `unknown lifecycle phase ${s.phase}` });
  }
  return outcome("state_error", stateDir, { health: "corrupt", detail: "lifecycle did not converge" });
}

/** Live cycles (other processes) registered as users of the runtime. */
function otherRuntimeUsers(users) {
  if (!users || !existsSync(users)) return false;
  return readdirSync(users).some(n => { const pid = Number(n.replace(/\.json$/, "")); if (!Number.isInteger(pid) || pid === process.pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } });
}

function save(dir, s) { atomicWriteJson(join(dir, STATE), { ...s, updatedAt: new Date().toISOString() }); }

/** Lifecycle phase -> simulation.byPhase key (null: no override applies in that phase). */
export const SIMULATION_FAULT_PHASES = Object.freeze(["exploration", "confirm", "smoke", "postconfirm"]);
export function simulationFaultPhase(phase) {
  if (phase === "selected" || phase === "running") return "exploration";
  if (phase === "smoke") return "smoke";
  if (typeof phase === "string" && phase.startsWith("postconfirm-")) return "postconfirm";
  if (typeof phase === "string" && phase.startsWith("confirm-")) return "confirm";
  return null;
}
const HARNESS_ID = /^[A-Za-z0-9._-]{1,64}$/;
const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** Shape problems of simulation.crash ([harness ids]) and simulation.byPhase ({phase: {harness id: p in [0,1]}}). */
function simulationFaultProblems(sim) {
  const p = [];
  if (sim.crash !== undefined && !(Array.isArray(sim.crash) && sim.crash.length > 0 && sim.crash.every(x => typeof x === "string" && HARNESS_ID.test(x))))
    p.push("simulation.crash must be a non-empty array of harness ids (e.g. [\"deployed\"])");
  if (sim.byPhase !== undefined) {
    if (!plainObject(sim.byPhase) || !Object.keys(sim.byPhase).length) p.push(`simulation.byPhase must be a non-empty object keyed by ${SIMULATION_FAULT_PHASES.join(" / ")}`);
    else for (const [k, v] of Object.entries(sim.byPhase)) {
      if (!SIMULATION_FAULT_PHASES.includes(k)) p.push(`simulation.byPhase.${k}: unknown phase (one of ${SIMULATION_FAULT_PHASES.join(", ")})`);
      else if (!plainObject(v) || !Object.keys(v).length || !Object.entries(v).every(([h, q]) => HARNESS_ID.test(h) && typeof q === "number" && Number.isFinite(q) && q >= 0 && q <= 1)) p.push(`simulation.byPhase.${k} must map harness ids to success probabilities in [0, 1]`);
    }
  }
  return p;
}

/**
 * The simulated target model of a simulated cycle (cfg.simulated only; a live cycle never reaches this). simulation.p sets each
 * harness's success probability (default 0.5) and simulation.violate marks harnesses with an integrity violation. Fault controls:
 * simulation.crash lists harness ids whose every attempt ends harness_crash (the post-adoption smoke runs harness "deployed");
 * simulation.byPhase.<exploration|confirm|smoke|postconfirm> replaces p for the listed harnesses while the cycle is in that phase
 * (read live through `phaseOf`, so one config can rehearse a later failure, e.g. a post-adoption confirmation that is worse).
 */
async function simulatedFromConfig(cfg, phaseOf = () => null) {
  const { simulatedBackend } = await import("./evaluator.mjs");
  const p = cfg.simulation.p ?? {};
  const crash = new Set(cfg.simulation.crash ?? []);
  const byPhase = cfg.simulation.byPhase ?? {};
  return simulatedBackend({ seed: cfg.simulation.seed ?? "sim", skill: (h) => {
    const over = byPhase[simulationFaultPhase(phaseOf())] ?? {};
    return { p: over[h.id] ?? p[h.id] ?? 0.5, violation: (cfg.simulation.violate ?? []).includes(h.id), ...(crash.has(h.id) ? { crash: true } : {}) };
  } });
}

async function liveDeps(cfg, stateDir, plan) {
  const { environmentDigest, hostEnvironment, ORCHE } = await import("./sandbox.mjs");
  const { realBackend } = await import("./evaluator.mjs");
  const { validateGrader } = await import("./grader.mjs");
  const { runChecks, compareChecks } = await import("./checks.mjs");
  const { cpSync, rmSync } = await import("node:fs");
  const env = hostEnvironment();
  const checks = async () => {
    const out = {};
    for (const [id, dir] of [["stable", plan.stable.dir], ["c1", plan.candidate.dir]]) { const wt = join(stateDir, "checks", `wt-${id}`); rmSync(wt, { recursive: true, force: true }); cpSync(dir, wt, { recursive: true, filter: (x) => !x.endsWith("/.codegraph") }); out[id] = await runChecks({ worktree: wt, env, which: ["typecheck", "test"], logDir: join(stateDir, "checks", id) }); rmSync(wt, { recursive: true, force: true }); }
    const c = compareChecks(out.stable, out.c1);
    return { ...c, results: Object.fromEntries(Object.entries(out.c1.results).map(([k, v]) => [k, { pass: v.pass, failing: v.failing }])) };
  };
  return { backend: realBackend(env), validate: (t) => validateGrader({ task: t, scratch: join(stateDir, "grading-scratch", t.id), env }), checks, envDigest: environmentDigest(env, exploreProtocol(cfg.route).route), orcheDir: ORCHE };
}

// ------------------------------------------------------------------------------------------------------------------ refresh
/**
 * supply-refresh@1 (model-free): lineage re-check of live batches (contaminated ones retired with evidence), then -- only when no
 * eligible batch exists -- a collection with rotating keywords and cross-pool repository exclusion (the pool policy keeps it from
 * sealing), then lineage selection + seal (src/lineage.mjs) up to maxBatches. Serialized by the pool's refresh lock.
 * deps: { collect (async ({pool, cfg, maxCasesPerRepo}) => summary), orcheDir, now }.
 */
export async function refreshExploration(cfgFile, { maxCasesPerRepo = 2, maxBatches = 1, deps = {} } = {}) {
  const base = { schema: REFRESH_SCHEMA, mode: "exploration-only" };
  // (mode is set from the config below once it loads)
  let cfg; try { cfg = loadExploration(cfgFile); } catch (error) { return { code: 64, out: { ...base, error: String(error.message).slice(0, 400) } }; }
  base.mode = cfg.mode;
  const policy = poolPolicy(cfg.pool);
  if (policy.autoSeal !== false) return { code: 1, out: { ...base, error: `pool ${cfg.pool} needs POLICY.json {autoSeal: false} (collectors must never seal an exploration pool)` } };
  let lock; try { lock = acquireLock(join(ensureDir(cfg.pool, 0o700), ".refresh.lock")); } catch (error) { if (error instanceof LockBusyError) return { code: 3, out: { ...base, busy: "another refresh holds the pool's refresh lock" } }; throw error; }
  const now = deps.now ?? new Date();
  try {
    const recovered = recoverPool(cfg.pool);
    const retired = retireContaminated(cfg, { now });
    const orcheDir = await orcheOf(cfg, deps);
    const sealed = [];
    // Autonomous mode: a batch meeting the registered confirmatory minima is sealed first (from enough staged, lineage-clean cases).
    const demand = autonomous(cfg) ? activeDemand(cfg) : null;
    let pc = null;
    if (demand) {
      const pol = confirmationPolicy(cfg);
      if (!pol.problems.some(x => x.code === "config-invalid")) {
        pc = merge(exploreProtocol(cfg.route), testProtocol(pol.registered, demand.purpose === "confirmation" ? "confirmation" : "holdout"));
        const { sealableCases } = await import("./supply.mjs");
        const have = nextBatch(cfg, { orcheDir, protocol: pc });
        if (have.none && sealableCases(cfg.pool, poolState(cfg.pool), { requireEvidence: requiredEvidence(cfg) }).length >= pc.holdout.minTasks) {
          const stamp = now.toISOString().replace(/[-:.]/g, "");
          const r = selectAndSeal({ pool: cfg.pool, screenPlan: cfg.screen, out: join(ensureDir(join(cfg.pool, "selection"), 0o700), `${stamp}-confirm-rule.json`), sources: cfg.lineage, batchRule: { ...cfg.batchRule, maxTasks: pc.holdout.minTasks, maxPerFamily: Math.max(1, Math.floor(pc.holdout.minTasks / pc.holdout.minFamilies)) }, minima: { minTasks: pc.holdout.minTasks, minFamilies: pc.holdout.minFamilies, requireHard: true, hardBasis: pc.holdout.hardBasis }, requireEvidence: requiredEvidence(cfg), now });
          if (r.sealed.batch) sealed.push({ batch: r.sealed.batch, coverage: r.sealed.coverage, rule: r.rule, purpose: "confirmatory" });
        }
      }
    }
    let pick = demand ? (pc ? nextBatch(cfg, { orcheDir, protocol: pc }) : { none: ["confirmation registration unreadable"] }) : nextBatch(cfg, { orcheDir });
    let collected = null;
    // While a lifecycle waits for a confirmatory batch, exploration-sized batches are not sealed (they would strand its cases).
    if (pick.none && !demand) {
      const st = poolState(cfg.pool);
      const n = st.records.filter(r => r.type === "refresh").length;
      const all = cfg.supply?.keywords ?? DEFAULT_SUPPLY.discovery.keywords;
      const k = Math.min(all.length, cfg.supply?.keywordsPerRefresh ?? 8);
      const keywords = Array.from({ length: k }, (_, i) => all[(n * k + i) % all.length]);
      const excludeRepos = [...lineageRepos(cfg.lineage)];
      const supplyCfg = mergeSupply({ ...(cfg.supply?.collect ?? {}), discovery: { ...(cfg.supply?.collect?.discovery ?? {}), keywords, excludeRepos } });
      const collect = deps.collect ?? (async (o) => { const { collect: c } = await import("./supply.mjs"); const { hostEnvironment, ORCHE } = await import("./sandbox.mjs"); return c({ ...o, env: hostEnvironment(), orcheDir: ORCHE }); });
      // supply.collector "none": no acquisition (select only from cases already staged, e.g. by private intake or offline tests).
      if (cfg.supply?.collector === "none") collected = { eligible: [], repositories: 0, skipped: "collector none" };
      else try { collected = await collect({ pool: cfg.pool, cfg: supplyCfg, maxCasesPerRepo }); }
      catch (error) { collected = { error: String(error?.message ?? error).slice(0, 300) }; }
      registryOf(cfg.pool).append({ type: "refresh", keywords, excludedRepos: excludeRepos.length, eligible: collected?.eligible?.length ?? null, error: collected?.error ?? null });
      for (let i = 0; i < maxBatches; i++) {
        const stamp = new Date(now.getTime() + i).toISOString().replace(/[-:.]/g, "");
        const r = selectAndSeal({ pool: cfg.pool, screenPlan: cfg.screen, out: join(ensureDir(join(cfg.pool, "selection"), 0o700), `${stamp}-rule.json`), sources: cfg.lineage, batchRule: cfg.batchRule, minima: minimaOfExplore(), requireEvidence: requiredEvidence(cfg), now: new Date(now.getTime() + i * 1000) });
        if (!r.sealed.batch) break;
        sealed.push({ batch: r.sealed.batch, coverage: r.sealed.coverage, rule: r.rule });
      }
      pick = nextBatch(cfg, { orcheDir });
    }
    const ok = !pick.none;
    return { code: ok ? 0 : 2, out: { ...base, available: ok ? { ok: true, batch: pick.batch } : { ok: false, why: pick.none.slice(0, 5) }, sealed, retired, recovered, collected: collected ? { eligible: collected.eligible?.length ?? 0, repositories: collected.repositories ?? null, error: collected.error ?? null } : null } };
  } catch (error) {
    return { code: 1, out: { ...base, error: String(error?.message ?? error).slice(0, 400) } };
  } finally { lock.release(); }
}

