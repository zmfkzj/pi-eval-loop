// Internal promotion track (2026-11-13; opt-in `screening.internal` of a mode-"screening" exploration@1 config).
//
// It is an OPERATIONAL improvement loop for the internal evaluation stable. It is NOT the research path: it never produces
// ADOPT, a confirmatory claim or confirmatory-1 evidence, and it never deploys to a real service. It reuses the screening route
// unchanged for the paid stages:
//
//   1. smoke + dev     (screening.mjs, unchanged): reusable development/regression comparison, evidence class "development".
//   2. waiting         qualified candidates wait (model-free) for a fresh batch; at most `maxWaitingQualified` wait before further
//                      dev screening stops, and preflight reports candidateDemand false so the consumer stops paid proposals.
//   3. acceptance      ONE pass of the best-dev-net qualified candidate on ONE fresh, sealed, unused, lineage-clean batch: the
//                      screening holdout stage unchanged (exploration eligibility, one use, every existing safeguard). It runs
//                      only when the ONE shared ledger's remaining allowance covers the estimated pass AND the assessment that
//                      must follow (budget policy shared-total-only: there is no stage cap).
//   4. promotion       only a completed pass with verdict EXPLORATORY_SUPPORTED and zero candidate integrity violations moves the
//                      EVALUATION-STABLE pointer (Releases, compare-and-swap against the stable the pass measured; a moved
//                      pointer refuses the promotion as STALE_BASELINE). Evidence class "internal-acceptance".
//   5. assessment      the next cycle's first action: promoted vs previous stable, paired on the regression (dev) tasks, under its
//                      shared ledger. A critical candidate problem or a negative net rolls the pointer back (CAS, idempotent).
//
// Epochs: every evaluation stable has its own screening registry and work directory (`<dir>/epochs/<digest16>/`), so the screening
// registry stays bound to ONE stable as before. Exposure is durable across epochs: every candidate that any epoch exposed to a
// holdout (result or consumed claim, screening.mjs candidateView) is added to the effective `screening.history`, and every
// development task an epoch showed is added to `screening.exposedDevTasks`, so no candidate gets a second acceptance batch and no
// exposed task enters a new batch. Lineage rule (LINEAGE_RULE): the current evaluation stable's own acceptance exposure does not
// taint its descendants, because each acceptance batch is fresh and lineage-clean against every earlier batch (pool lineage).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Releases } from "./lifecycle.mjs";
import { exploreProtocol } from "./exploration.mjs";
import { routeKey } from "./protocol.mjs";
import { fault, Ledger } from "./util.mjs";
// screening.mjs imports this module; passNeed is resolved lazily at call time (circular import, no top-level use).
import * as screening from "./screening.mjs";
const passNeed = (...a) => screening.passNeed(...a);

export const INTERNAL_SCHEMA = "pi-eval-loop/internal-promotion@1";
export const INTERNAL_STATUS_SCHEMA = "pi-eval-loop/internal-status@1";
export const INTERNAL_EVIDENCE = Object.freeze({ class: "internal-acceptance", confirmatoryClaim: false, generalizedClaim: false, researchAdopt: false,
  note: "operational promotion of the internal evaluation stable after ONE exploration-eligible fresh batch: not research confirmation, not ADOPT, not evidence of broad generalization; the decision rule is an unvalidated operational policy" });
export const ASSESSMENT_EVIDENCE = Object.freeze({ class: "development", confirmatoryClaim: false, generalizedClaim: false,
  note: "post-promotion regression assessment on the reusable development tasks (adaptively exposed): a safety check, not independent confirmation" });
export const LINEAGE_RULE = "internal-lineage@1: (1) a candidate exposed to any holdout/acceptance batch in any epoch never gets another; (2) a candidate created after one of its archive ancestors was exposed is tainted (screening rule, unchanged); (3) descendants of the CURRENT evaluation stable are not tainted by its acceptance exposure, because every acceptance batch is fresh, one-use and lineage-clean against every earlier batch of the pool (the batch the stable was accepted on can never be shown again); (4) exposure records are never deleted (rollback keeps them)";
export const SELECT = Object.freeze(["best-dev-net", "registration"]);

/** True when a loaded exploration config enables the internal promotion track. */
export const internalEnabled = (cfg) => cfg?.mode === "screening" && cfg?.screening?.internal?.enabled === true;

/** Problems of the `screening.internal` section (pure; absent section = no problem). */
export function internalConfigProblems(c) {
  const i = c?.screening?.internal;
  if (i === undefined) return [];
  const p = [];
  const posInt = (v, k) => { if (!(Number.isInteger(v) && v > 0)) p.push(`${k} must be a positive integer`); };
  if (c.mode !== "screening") p.push("screening.internal needs mode screening");
  if (!i || typeof i !== "object") return ["screening.internal must be an object"];
  if (i.enabled !== true) p.push("screening.internal.enabled must be true (omit the section for plain screening)");
  if (typeof i.dir !== "string" || !i.dir.startsWith("/")) p.push("screening.internal.dir must be an absolute path");
  if (c.screening?.holdout?.enabled !== true) p.push("screening.internal needs screening.holdout.enabled true (acceptance is the holdout stage)");
  posInt(i.maxWaitingQualified, "screening.internal.maxWaitingQualified");
  posInt(i.maxAcceptancesWithoutPromotion, "screening.internal.maxAcceptancesWithoutPromotion");
  if (i.attemptsPerUnit !== undefined) p.push("screening.internal.attemptsPerUnit moved to screening.estimate.attemptsPerUnit {dev, holdout} (sizing of the shared-ledger admission only; budget policy shared-total-only)");
  if (typeof i.assessment?.enabled !== "boolean") p.push("screening.internal.assessment.enabled (true/false) required");
  if (i.assessment?.enabled === true && !(typeof i.assessment.maxHours === "number" && i.assessment.maxHours > 0)) p.push("screening.internal.assessment.maxHours (positive number: a promotion not assessed by then is rolled back) required");
  if (i.select !== undefined && !SELECT.includes(i.select)) p.push(`screening.internal.select must be one of ${SELECT.join(", ")}`);
  if (i.policy !== "operational-unvalidated") p.push("screening.internal.policy must be \"operational-unvalidated\" (acknowledges that the promotion rule is an operational policy, not a validated statistical guarantee)");
  if (typeof i.dir === "string" && typeof c.screening?.registry === "string" && c.screening.registry.startsWith(`${i.dir}/`)) p.push("screening.registry must lie outside screening.internal.dir (the track keeps one registry per epoch there)");
  return p;
}

// ------------------------------------------------------------------------------------------------------------------ paths
export function internalPaths(cfg) {
  const dir = cfg.screening.internal.dir;
  return { dir, releases: join(dir, "eval-stable"), registry: join(dir, "internal.jsonl"), lock: join(dir, "internal.lock"), epochs: join(dir, "epochs") };
}
export const evalReleases = (cfg) => new Releases(internalPaths(cfg).releases);
/** The internal registry (hash-chained): acceptance decisions, promotions, stale refusals, assessments, rollbacks. */
export const internalLedger = (cfg) => new Ledger(internalPaths(cfg).registry);
function internalRecords(cfg) {
  const f = internalPaths(cfg).registry;
  if (!existsSync(f)) return [];
  const led = new Ledger(f);
  const problems = led.verify();
  if (problems.length) throw new Error(`internal registry chain broken: ${problems[0]}`);
  return led.records();
}
function releaseHistory(cfg) {
  const f = join(internalPaths(cfg).releases, "history.jsonl");
  if (!existsSync(f)) return [];
  const led = new Ledger(f);
  const problems = led.verify();
  if (problems.length) throw new Error(`evaluation-stable history chain broken: ${problems[0]}`);
  return led.records();
}

/** The current evaluation stable (read-only): the Releases pointer once initialized, else the configured stable. */
export function currentStable(cfg) {
  if (!releaseHistory(cfg).length) return { dir: cfg.stable.dir, commit: cfg.stable.commit, runtimeDigest: cfg.stable.runtimeDigest, release: null, releaseSeq: null };
  const cur = evalReleases(cfg).current();
  return { dir: cur.dir, commit: cur.commit ?? `release:${cur.release.slice(0, 16)}`, runtimeDigest: cur.runtimeDigest, release: cur.release, releaseSeq: cur.seq };
}

/** Epoch of a stable: its own screening registry and work directory. */
export function epochOf(cfg, stable) {
  const id = stable.runtimeDigest;
  const d = join(internalPaths(cfg).epochs, id.slice(0, 16));
  return { id, stable: { dir: stable.dir, commit: stable.commit, runtimeDigest: stable.runtimeDigest, releaseSeq: stable.releaseSeq ?? null }, registry: join(d, "registry.jsonl"), workDir: join(d, "work") };
}

/** Existing epoch registries (read-only, creates nothing). */
export function epochRegistries(cfg) {
  const root = internalPaths(cfg).epochs;
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().map(n => join(root, n, "registry.jsonl")).filter(existsSync);
}

/**
 * Exposure of every OTHER epoch (pure over durable records): holdout-exposed candidates as screening.history entries and shown
 * development tasks as exposedDevTasks entries. A broken chain throws (fail closed).
 */
export async function crossEpochExposure(cfg, { exclude = null } = {}) {
  const { candidateView } = await import("./screening.mjs");
  const history = [], devTasks = [];
  for (const f of epochRegistries(cfg)) {
    if (f === exclude) continue;
    const led = new Ledger(f);
    const problems = led.verify();
    if (problems.length) throw new Error(`epoch registry ${f} chain broken: ${problems[0]}`);
    const records = led.records();
    const tag = f.split("/").at(-2);
    for (const c of candidateView(records, cfg)) {
      if (!c.exposure) continue;
      const h = { at: c.exposure.at, note: `internal epoch ${tag}: ${c.exposure.note}` };
      if (/^[0-9a-f]{64}$/.test(c.key ?? "")) h.runtimeDigest = c.key;
      if (/^[0-9a-f]{64}$/.test(c.pkey ?? "")) h.archivePkey = c.pkey;
      if (h.runtimeDigest || h.archivePkey) history.push(h);
    }
    for (const r of records) if (r.type === "dev-exposure") for (const t of r.tasks ?? []) devTasks.push({ id: t.id, dataset: t.dataset, note: `internal epoch ${tag} ${r.at}` });
  }
  return { history, devTasks };
}

/** The config a cycle of `epoch` runs with: epoch stable, epoch registry/workDir, plus the exposure of every other epoch. */
export async function effectiveConfig(cfg, stable) {
  const { screeningExclusionTasks } = await import("./screening.mjs");
  const ep = epochOf(cfg, stable);
  const exp = await crossEpochExposure(cfg, { exclude: ep.registry });
  const out = { ...cfg, stable: ep.stable, screening: { ...cfg.screening, registry: ep.registry, workDir: ep.workDir, history: [...(cfg.screening.history ?? []), ...exp.history], exposedDevTasks: [...(cfg.screening.exposedDevTasks ?? []), ...exp.devTasks] }, internalEpoch: { id: ep.id, registry: ep.registry } };
  out.screen = { tasks: screeningExclusionTasks(out) };
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ acceptance
export const acceptanceRepeats = (cfg) => exploreProtocol(cfg.route).holdout.repeats;

/** Promotion decision over an acceptance pass result (pure; the rule is fixed before the pass). */
export function acceptanceDecision(r, outcome) {
  const c1 = r?.arms?.c1 ?? {};
  if (outcome === "completed" && r.verdict === "EXPLORATORY_SUPPORTED" && !c1.integrityViolations && !c1.strictViolations && !r.incomplete) return { promote: true, why: "completed acceptance pass, verdict EXPLORATORY_SUPPORTED, no candidate integrity violation" };
  return { promote: false, why: `acceptance pass ${outcome} with verdict ${r?.verdict ?? "?"}${c1.integrityViolations || c1.strictViolations ? " and candidate integrity violations" : ""}: not promoted` };
}

/**
 * Promote the accepted candidate (idempotent per acceptance state directory): CAS on the evaluation-stable pointer from the
 * stable the pass measured, then the internal `promote` record. A moved pointer is a STALE_BASELINE refusal (recorded once).
 */
export function promote(cfg, { stateDir, plan, evidence }) {
  const L = internalLedger(cfg);
  const prior = internalRecords(cfg);
  const stale = prior.find(r => r.type === "stale" && r.releaseKey === stateDir);
  if (stale) return { stale: true, why: stale.why };
  let a;
  try { a = evalReleases(cfg).adopt({ key: stateDir, expect: plan.stable.runtimeDigest, expectSeq: plan.stable.releaseSeq ?? null, candidate: { dir: plan.candidate.dir, runtimeDigest: plan.candidate.identity.runtimeDigest, commit: plan.candidate.identity.commit }, evidence: { ...evidence, class: INTERNAL_EVIDENCE.class, candidateId: plan.candidate.id, route: plan.route ?? null } }); }
  catch (error) {
    if (!/release pointer moved/.test(String(error?.message))) throw error;
    const why = `stale baseline: the acceptance pass measured ${plan.stable.runtimeDigest.slice(0, 16)} but the evaluation stable moved (${String(error.message).slice(0, 160)}); the result is never applied to another stable`;
    L.append({ type: "stale", releaseKey: stateDir, candidate: plan.candidate.identity, why });
    return { stale: true, why };
  }
  fault("internal:after-adopt");
  let rec = internalRecords(cfg).find(r => r.type === "promote" && r.releaseKey === stateDir);
  if (!rec) rec = L.append({ type: "promote", releaseKey: stateDir, candidate: { id: plan.candidate.id, key: plan.candidate.identity.runtimeDigest, commit: plan.candidate.identity.commit }, from: a.previous, to: { release: a.record.release, commit: a.record.commit }, releaseSeq: a.record.seq, evidence, route: plan.route ?? null,
    assessBy: cfg.screening.internal.assessment?.enabled === true ? new Date(Date.now() + cfg.screening.internal.assessment.maxHours * 3_600_000).toISOString() : null });
  fault("internal:after-promote-record");
  return { promoted: true, record: rec, previous: a.previous };
}

/**
 * Reconcile the internal registry with the evaluation-stable history (idempotent; under the internal series lock): an adoption or
 * rollback the release history holds but the internal registry does not (a crash between the two appends) is recorded, so a
 * promotion can never stand without its assessment obligation and a rollback is never missing from the audit trail.
 */
export function reconcile(cfg) {
  const hist = releaseHistory(cfg);
  if (!hist.length) return { added: 0 };
  const L = internalLedger(cfg);
  let added = 0;
  for (const h of hist) {
    const recs = internalRecords(cfg);
    if (h.type === "adopt" && !recs.some(r => r.type === "promote" && r.releaseKey === h.key)) {
      L.append({ type: "promote", releaseKey: h.key, candidate: { id: h.evidence?.candidateId ?? null, key: h.release, commit: h.commit }, from: h.previous, to: { release: h.release, commit: h.commit }, releaseSeq: h.seq, evidence: h.evidence ?? null, route: h.evidence?.route ?? null, reconciled: "release history adopt without an internal promote record",
        assessBy: cfg.screening.internal.assessment?.enabled === true ? new Date(Date.parse(h.at) + cfg.screening.internal.assessment.maxHours * 3_600_000).toISOString() : null });
      added++;
    }
    if (h.type === "rollback" && !recs.some(r => r.type === "rollback" && r.releaseKey === h.key)) { L.append({ type: "rollback", releaseKey: h.key, by: "reconciled", reason: h.reason, releaseSeq: h.seq, to: h.release }); added++; }
  }
  return { added };
}

/** Record an acceptance decision once per acceptance state directory (audit; feeds the no-progress stop). */
export function recordAcceptance(cfg, { stateDir, candidate, verdict, decision, batch, outcome }) {
  if (internalRecords(cfg).some(r => r.type === "acceptance" && r.releaseKey === stateDir)) return;
  internalLedger(cfg).append({ type: "acceptance", releaseKey: stateDir, candidate, verdict, decision, batch, outcome });
}

/** No-progress stop: consecutive acceptance passes without a promotion since the last promotion (null = keep going). */
export function noProgress(cfg) {
  const recs = internalRecords(cfg);
  const lastPromote = recs.filter(r => r.type === "promote").at(-1)?.seq ?? -1;
  const misses = recs.filter(r => r.type === "acceptance" && r.seq > lastPromote && r.decision !== "PROMOTE").length;
  const max = cfg.screening.internal.maxAcceptancesWithoutPromotion;
  return misses >= max ? `${misses} consecutive acceptance pass(es) without a promotion (maxAcceptancesWithoutPromotion ${max}): each one spends a scarce fresh batch; continuing is a human decision` : null;
}

/** The latest promotion still deployed (same history record) whose assessment or decided rollback is outstanding, else null. */
export function pendingAssessment(cfg) {
  const recs = internalRecords(cfg);
  const last = recs.filter(r => r.type === "promote").at(-1);
  if (!last) return null;
  const cur = currentStable(cfg);
  if (cur.runtimeDigest !== last.to.release || cur.releaseSeq !== last.releaseSeq) return null;
  const a = recs.find(r => r.type === "assessment" && r.releaseKey === last.releaseKey);
  // An assessment that decided a rollback the pointer does not show yet (crash between the record and the CAS): finish it.
  if (a) return /^ROLLBACK/.test(a.verdict) && !recs.some(r => r.type === "rollback" && r.releaseKey === last.releaseKey) ? { ...last, pendingRollback: a } : null;
  return cfg.screening.internal.assessment?.enabled === true ? last : null;
}

/** Assessment plan: promoted (candidate arm) vs the previous evaluation stable, paired on the regression (dev) tasks. */
export function assessmentPlan(cfg, rec, { devTasks, taskDigests, seed }) {
  const rel = internalPaths(cfg).releases;
  return { schema: "pi-eval-loop/internal-assessment-plan@1", stage: "assessment", ...(cfg.route !== undefined ? { route: cfg.route } : {}), seed,
    stable: { dir: join(rel, "releases", rec.from.release), commit: rec.from.commit ?? `release:${rec.from.release.slice(0, 16)}`, runtimeDigest: rec.from.runtimeDigest },
    candidate: { id: rec.candidate.id, key: rec.to.release, dir: join(rel, "releases", rec.to.release), identity: { id: rec.candidate.id, kind: "orche", commit: rec.to.commit ?? rec.candidate.commit, runtimeDigest: rec.to.release } },
    dev: { tasks: devTasks, repeats: cfg.screening.dev.repeats, promote: cfg.screening.dev.promote, taskDigests }, releaseKey: rec.releaseKey, evidence: ASSESSMENT_EVIDENCE };
}

/**
 * Rollback decision of an assessment report (pure; operational rule, unvalidated; fail closed). KEEP only for a complete pass
 * without a critical problem of the promoted arm and net successes >= 0 against the previous stable; anything else (critical
 * problem, worse, incomplete pairs, infrastructure-only units) rolls back: a promotion is never left standing unassessed.
 */
export function assessmentDecision(report) {
  if (report.verdict === "DEV_REJECTED") return { rollback: true, verdict: "ROLLBACK", why: `promoted harness showed a critical problem on the regression tasks: ${(report.reasons ?? [])[0] ?? "critical"}` };
  if (report.measured < report.planned || report.infra) return { rollback: true, verdict: "ROLLBACK_UNASSESSED", why: `assessment incomplete (${report.measured}/${report.planned} units, ${report.infra ?? 0} infra): an unassessed promotion is not kept` };
  if (report.net < 0) return { rollback: true, verdict: "ROLLBACK", why: `promoted harness is worse than the previous stable on the regression tasks (net ${report.net})` };
  return { rollback: false, verdict: "KEEP", why: `no critical problem and net ${report.net} >= 0 on the regression tasks` };
}

/** Roll back a pending promotion whose assessment cannot run (deadline passed or not affordable): fail closed. */
export function abandonAssessment(cfg, rec, why) {
  if (!internalRecords(cfg).some(r => r.type === "assessment" && r.releaseKey === rec.releaseKey)) internalLedger(cfg).append({ type: "assessment", releaseKey: rec.releaseKey, verdict: "ROLLBACK_UNASSESSED", why, net: null, measured: 0, planned: null });
  return { rollback: true, verdict: "ROLLBACK_UNASSESSED", why, result: rollback(cfg, { releaseKey: rec.releaseKey, reason: why, by: "assessment" }) };
}

/** Record an assessment and apply its rollback (idempotent per promotion). */
export function finishAssessment(cfg, { rec, report, reportSha256, runs = null }) {
  const L = internalLedger(cfg);
  const d = assessmentDecision(report);
  if (!internalRecords(cfg).some(r => r.type === "assessment" && r.releaseKey === rec.releaseKey)) L.append({ type: "assessment", releaseKey: rec.releaseKey, verdict: d.verdict, why: d.why, net: report.net, measured: report.measured, planned: report.planned, reportSha256, runs });
  fault("internal:after-assessment-record");
  if (!d.rollback) return { ...d };
  return { ...d, result: rollback(cfg, { releaseKey: rec.releaseKey, reason: d.why, by: "assessment" }) };
}

/** Roll a promotion back (CAS through Releases; idempotent). Manual use: the internal-rollback CLI. */
export function rollback(cfg, { releaseKey, reason, by = "operator" }) {
  const rb = evalReleases(cfg).rollback({ key: releaseKey, reason, exact: true });
  if (rb.none) return { none: rb.none };
  if (!internalRecords(cfg).some(r => r.type === "rollback" && r.releaseKey === releaseKey)) internalLedger(cfg).append({ type: "rollback", releaseKey, by, reason: String(reason).slice(0, 300), releaseSeq: rb.record.seq, to: rb.record.release });
  return { seq: rb.record.seq, to: rb.record.release, resumed: rb.resumed };
}

// ------------------------------------------------------------------------------------------------------------------ reporting
const stats = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return { n: 0 }; return { n: v.length, mean: Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10, p90: v[Math.floor(0.9 * (v.length - 1))], max: v.at(-1) }; };
function runRecords(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const l of readFileSync(file, "utf8").split("\n")) { if (!l.includes("\"type\":\"result\"")) continue; try { out.push(JSON.parse(l).record); } catch { /* skipped */ } }
  return out;
}

/**
 * Recorded cost and rejection evidence of the track (model-free): per-unit target attempts by stage on the target route, the
 * integrity violation rate of each arm in development passes, and the shared-ledger sizing (passNeed) of each stage.
 * Measured per-unit counts are forwarded requests as recorded by the unit's route proxy (gated: raised to the attempt floor).
 */
export function costEvidence(cfg, registries) {
  const route = exploreProtocol(cfg.route).route, key = routeKey(route);
  const by = { dev: [], acceptance: [], assessment: [] }, viol = { stable: [0, 0], candidate: [0, 0] };
  for (const f of registries) {
    const led = new Ledger(f);
    for (const r of led.records()) {
      if (r.type !== "result" || !["dev", "holdout"].includes(r.stage) || !r.stateDir) continue;
      const runs = r.stage === "dev" ? (r.runs ?? join(r.stateDir, "dev", "runs.jsonl")) : join(r.stateDir, r.report ? r.report.split("/").at(-2) : "holdout", "runs.jsonl");
      for (const x of runRecords(runs)) {
        if (x.simulated && !cfg.simulated) continue;
        if (x.model_route !== key) continue;
        (r.stage === "dev" ? by.dev : by.acceptance).push(x.model_requests);
        if (r.stage === "dev") { const a = x.candidate_id === "stable" ? viol.stable : viol.candidate; a[1]++; if (x.integrity?.violations?.length) a[0]++; }
      }
    }
  }
  for (const r of existsSync(internalPaths(cfg).registry) ? internalRecords(cfg) : []) if (r.type === "assessment" && r.runs) for (const x of runRecords(r.runs)) if (x.model_route === key) by.assessment.push(x.model_requests);
  const devTasks = cfg.screening.dev.tasks.length;
  const needs = { dev: passNeed(cfg, "dev", devTasks), acceptance: passNeed(cfg, "holdout", cfg.batchRule?.maxTasks ?? 8) };
  const measured = { dev: stats(by.dev), acceptance: stats(by.acceptance), assessment: stats(by.assessment) };
  const estOf = (k) => (k === "acceptance" ? needs.acceptance : needs.dev).attemptsPerUnit;
  return { route: key, unit: "target attempts per unit as charged by the unit's route proxy (gated runtime: raised to the outbound attempt floor)", budgetPolicy: "shared-total-only", measured,
    integrityViolations: { stableUnits: { violating: viol.stable[0], of: viol.stable[1] }, candidateUnits: { violating: viol.candidate[0], of: viol.candidate[1] } },
    needs, note: "needs size the admission against the ONE shared ledger (no stage cap); a per-unit estimate below the measured p90 is reported as a risk",
    risks: Object.entries(measured).filter(([k, m]) => m.n && estOf(k) < m.p90).map(([k, m]) => `${k}: measured p90 ${m.p90} > estimated ${estOf(k)} attempts/unit`) };
}

/** internal-status@1 (read-only, model-free): evaluation stable, promotions/assessments/rollbacks, exposure, waiting, supply, cost. */
export async function internalStatus(cfg, { supply = null } = {}) {
  const { candidateView } = await import("./screening.mjs");
  const recs = internalRecords(cfg);
  const hist = releaseHistory(cfg);
  const cur = currentStable(cfg);
  const registries = epochRegistries(cfg);
  const epochs = registries.map(f => {
    const records = new Ledger(f).records();
    const init = records.find(r => r.type === "init");
    const view = candidateView(records, cfg);
    const by = {}; for (const c of view) by[c.status] = (by[c.status] ?? 0) + 1;
    return { epoch: f.split("/").at(-2), stable: init?.stable?.runtimeDigest ?? null, current: init?.stable?.runtimeDigest === cur.runtimeDigest, candidates: view.length, statuses: by, exposed: view.filter(c => c.exposure).length,
      waiting: view.filter(c => c.status === "qualified" && !c.taintedBy).map(c => ({ id: c.id, net: c.results.dev?.net ?? null })) };
  });
  return { schema: INTERNAL_STATUS_SCHEMA, evidence: INTERNAL_EVIDENCE, lineageRule: LINEAGE_RULE, policy: cfg.screening.internal.policy,
    evaluationStable: { runtimeDigest: cur.runtimeDigest, commit: cur.commit, release: cur.release, historyRecords: hist.length },
    serviceDeployment: "none: pi-eval-loop moves only the internal evaluation-stable pointer; deploying a release to a real service is the consumer's separate, explicit step",
    promotions: recs.filter(r => r.type === "promote").map(r => ({ seq: r.seq, at: r.at, candidate: r.candidate.id, from: r.from.release.slice(0, 16), to: r.to.release.slice(0, 16), releaseKey: r.releaseKey })),
    stale: recs.filter(r => r.type === "stale").map(r => ({ seq: r.seq, at: r.at, releaseKey: r.releaseKey, why: r.why })),
    assessments: recs.filter(r => r.type === "assessment").map(r => ({ seq: r.seq, at: r.at, releaseKey: r.releaseKey, verdict: r.verdict, net: r.net, why: r.why })),
    rollbacks: recs.filter(r => r.type === "rollback").map(r => ({ seq: r.seq, at: r.at, releaseKey: r.releaseKey, by: r.by, reason: r.reason })),
    pendingAssessment: (() => { const p = pendingAssessment(cfg); return p ? { releaseKey: p.releaseKey, candidate: p.candidate.id } : null; })(),
    epochs, supply, cost: costEvidence(cfg, registries) };
}

/** Is a new paid proposal useful now? (consumer gate; pure over the preflight facts) */
export function candidateDemand({ pending, waiting, maxWaitingQualified, budgetStop }) {
  if (budgetStop) return { wanted: false, why: "the shared ledger cannot cover the next pass" };
  if (waiting >= maxWaitingQualified) return { wanted: false, why: `${waiting} qualified candidate(s) already wait for a fresh acceptance batch (maxWaitingQualified ${maxWaitingQualified})` };
  if (pending > 0) return { wanted: false, why: `${pending} registered candidate(s) still wait for smoke/dev` };
  return { wanted: true, why: "no pending candidate and fewer qualified candidates waiting than allowed" };
}

