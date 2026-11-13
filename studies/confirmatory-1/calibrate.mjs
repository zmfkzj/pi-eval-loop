#!/usr/bin/env node
// Bounded difficulty-calibration runner (confirmatory-1; docs/design.md "Difficulty calibration", "Request budget").
//
// Measures the STABLE harness on a sealed calibration-purpose batch (never a holdout) with the loop's sandboxed runner and its
// exactly-once evaluator ledger, then writes a calibration report (src/calibration.mjs) whose outcomes are re-derivable from that
// ledger. It never proposes, selects, adopts, reserves or consumes anything, and it never touches a holdout.
//
// Spending: every chargeable attempt is admitted by ONE durable, global request budget (src/request-budget.mjs) shared by every
// calibration run, resume and rerun of the study (never per state directory). The accounting unit is a provider request ATTEMPT,
// gateway-internal retries and credential fallback included: one request forwarded by the unit's route proxy can cause at most
// K = gatewayAttemptBound().perRequest attempts inside the gateway (its retry contract, read from its config and auth directory
// at every reservation and settlement; anything unknowable refuses). Before an attempt is dispatched, unit.maxRequests x K is
// reserved under a lock; afterwards it is settled with forwarded x K (the gateway's internal retries are not observable, so every
// forwarded request is charged its worst case). An unsettled reservation stays charged in full; a changed bound halts. So the
// total of attempts never exceeds the ceiling, deterministically, without any reliance on a meter or watchdog.
// Peers: the gateway's credential is shared with other experiments. The run refuses to start (and halts) when the gateway shows
// rate-limit/overload failures (429/503) of the target model, so the calibration's load never pushes a peer into failures.
// --dry-run prints the plan and the worst case and runs nothing.
//
//   node studies/confirmatory-1/calibrate.mjs --batch DIR --state DIR --harness-dir DIR --harness-commit SHA
//        --approval FILE --budget-ledger FILE --gateway-db FILE [--repeats 3] [--parallelism 3] [--dry-run]
//        [--route PROVIDER/MODEL [--effort LEVEL]] [--context ID] (--budget-limit N --budget-scope S | --max-requests N)
//
// Study identity (2026-11-13, docs/terra-study-v4.md): the defaults are confirmatory-1's (route = DEFAULT_PROTOCOL.route, context
// "confirmatory-1:calibration", a ledger of its own whose limit IS the approved --max-requests, hard cap 4500). Another study
// (e.g. Terra v4) names its route, its context and the identity of a SHARED series ledger (--budget-limit/--budget-scope = the
// ledger's init limit and scope, e.g. 300000). Budget policy shared-total-only (user decision 2026-11-13: "공유 상한 하나만 사용"):
// with a shared ledger the ledger's ceiling is the ONLY spending limit. --max-requests is refused there (the former per-context
// sub-ceiling is removed) and the approval must state budgetPolicy "shared-total-only" without a maxRequests ceiling: an older
// approval that carried a ceiling is not silently extended into an unbounded one; it must be re-approved. The confirmatory-1
// default (no --budget-limit) is unchanged research provenance: its own single study ledger whose limit IS --max-requests <= 4500.
//
// The harness directory is a read-only export of the stable orche commit, e.g.
//   mkdir DIR && git -C <umbrella>/orche archive <commit> | tar -x -C DIR
// (an export, not a worktree: the live orche repository is not written).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Evaluator, realBackend, wireJournals } from "../../src/evaluator.mjs";
import { datasetPurpose, holdoutLedger, loadLocal, verifySeal } from "../../src/datasets.mjs";
import { CENSORING, buildCalibrationReport, exclusionProblems, outcomesFromLedger, unitClassesFromLedger } from "../../src/calibration.mjs";
import { DEFAULT_PROTOCOL, EFFORTS, merge } from "../../src/protocol.mjs";
import { RequestBudget, gatewayPressureMeter } from "../../src/request-budget.mjs";
import { catalogModels, routeCatalogProblems, runtimeProblems } from "../../src/isolated-runtime.mjs";
import { Ledger, acquireLock, atomicWriteJson, digestOf, ensureDir, readJson, sha256 } from "../../src/util.mjs";

export const CONTEXT = "confirmatory-1:calibration";
/** The evaluator context of a plan (confirmatory-1's unless the plan names another study's). */
export const contextOf = (plan) => plan?.context ?? CONTEXT;
/** The study's hard cap (user decision 2026-11-07: "요청 4500 유지"); no approval or CLI value can raise it. */
export const HARD_CAP = 4500;
export const BUDGET_SCOPE = "confirmatory-1: target-model calibration requests (all runs, resumes and reruns)";
/** Reservation size per forwarded request in the isolated runtime: 1 attempt (request-retry 0) + 1 for a followed redirect. */
export const GATED_RESERVATION_FACTOR = 2;
/** Pilot usage of the stable arm S in ctrl-ablation-1 (81 units): requests and input tokens per unit (expectations, not bounds). */
export const PILOT_PER_UNIT = { requests: 1954 / 81, inputTokens: 18.56e6 / 81, source: "records/ctrl-ablation-1/discovery (live checkout), arm S" };

export { EFFORTS, catalogModels };
/**
 * The runner protocol of a study: DEFAULT_PROTOCOL itself (confirmatory-1, unchanged identity) unless a route is named, e.g.
 * studyProtocol({ route: "cliproxyapi/gpt-6.1-terra", effort: "medium" }). Throws on a malformed route or effort.
 * @param {{ route?: string, effort?: string }} [options]
 */
export function studyProtocol({ route, effort } = {}) {
  if (route === undefined) { if (effort !== undefined) throw new Error("--effort needs --route"); return DEFAULT_PROTOCOL; }
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-][A-Za-z0-9._/-]*)$/.exec(route);
  if (!m) throw new Error(`--route ${route}: PROVIDER/MODEL (e.g. cliproxyapi/gpt-6.1-terra)`);
  const level = effort ?? DEFAULT_PROTOCOL.route.effort;
  if (!EFFORTS.includes(level)) throw new Error(`--effort ${level}: one of ${EFFORTS.join(", ")}`);
  return merge(structuredClone(DEFAULT_PROTOCOL), { route: { provider: m[1], model: m[2], effort: level } });
}

/** The calibration plan: units, identity and worst case. Model-free. */
export function calibrationPlan({ batch, harnessDir, harnessCommit, repeats = 3, protocol = DEFAULT_PROTOCOL, maxRequests, hardMaxRate, minTasksPerLevel, budgetLedger, exclusions = [], context, budgetLimit, budgetScope }) {
  const problems = [];
  if (datasetPurpose(batch) !== "calibration") problems.push("batch is not a calibration-purpose set (a holdout is never run for calibration)");
  const seal = verifySeal(batch);
  if (!seal.ok) problems.push(`batch seal: ${seal.why}`);
  if (holdoutLedger(batch).records().length) problems.push("batch carries a holdout use record");
  if (!harnessDir || !existsSync(join(harnessDir, "package.json"))) problems.push("--harness-dir: an exported stable orche tree (package.json missing)");
  if (!/^[0-9a-f]{40}$/.test(harnessCommit ?? "")) problems.push("--harness-commit: the full sha of the exported stable commit");
  if (budgetLimit !== undefined) { if (maxRequests !== undefined) problems.push("--max-requests is not accepted with a shared ledger (budget policy shared-total-only: the shared ledger's ceiling is the only spending limit; the per-run sub-ceiling was removed)"); }
  else if (!(Number.isInteger(maxRequests) && maxRequests > 0)) problems.push("--max-requests: the approved aggregate request ceiling of the study's own ledger (a positive integer)");
  else if (maxRequests > HARD_CAP) problems.push(`--max-requests ${maxRequests} exceeds the study's hard cap ${HARD_CAP}`);
  if (budgetLimit !== undefined && !(Number.isInteger(budgetLimit) && budgetLimit > 0 && typeof budgetScope === "string" && budgetScope.trim())) problems.push("--budget-limit/--budget-scope: the shared ledger's exact init limit (positive integer) and scope");
  if (context !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(context)) problems.push("--context: 1-80 characters [A-Za-z0-9._:-]");
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) problems.push("--repeats must be an integer in 1..10");
  if (!(hardMaxRate > 0 && hardMaxRate < 1) || !(Number.isInteger(minTasksPerLevel) && minTasksPerLevel >= 1)) problems.push("calibration rule (hardMaxRate, minTasksPerLevel) must be pre-registered");
  const tasks = seal.ok ? loadLocal(batch) : [];
  problems.push(...exclusionProblems(exclusions, tasks.map(t => t.id)));
  const excluded = new Set(exclusions.map(x => x?.task));
  const measured = tasks.map(t => t.id).filter(id => !excluded.has(id)).sort();
  const units = measured.length * repeats;
  const perUnit = protocol.unit.maxRequests;
  return {
    schema: "pi-eval-loop/calibration-plan@3", batch, seal: seal.seal?.digest ?? null, tasks: measured, allTasks: tasks.map(t => t.id).sort(), families: [...new Set(tasks.map(t => t.family))].sort(),
    harness: { id: "stable", kind: "orche", commit: harnessCommit ?? null, mode: protocol.target.mode }, route: protocol.route, repeats, units,
    rule: { feature: "declared-tier", hardMaxRate, minTasksPerLevel, censoring: CENSORING, exclusions },
    // Non-default identity only (a default plan keeps the digest of existing confirmatory-1 state directories).
    ...(context !== undefined && context !== CONTEXT ? { context } : {}),
    budget: { maxRequests: budgetLimit !== undefined ? null : maxRequests ?? null, ledger: budgetLedger ?? null, ...(budgetLimit !== undefined ? { ledgerLimit: budgetLimit, ledgerScope: budgetScope ?? null, policy: "shared-total-only" } : {}), perAttemptCeiling: perUnit, worstCaseFirstAttempts: units * perUnit, expectedRequests: Math.round(units * PILOT_PER_UNIT.requests), expectedInputTokens: Math.round(units * PILOT_PER_UNIT.inputTokens), expectationSource: PILOT_PER_UNIT.source, note: "every attempt (first try or infrastructure retry) reserves perAttemptCeiling in the global budget before dispatch; unsettled reservations stay charged in full; the run pauses (no report) when a reservation is refused" },
    problems,
  };
}

/**
 * Approval file (schema calibration-approval@2): { maxRequests, approvedBy, approvedAt, authorization: { kind, signature,
 * humanSignatory, verbatim, recordedBy }, scope: { pool | batchSeal, budgetLedger } }. Own study ledger: maxRequests must EQUAL
 * the requested ceiling (<= HARD_CAP). Shared ledger (budget policy shared-total-only, 2026-11-13): { budgetPolicy:
 * "shared-total-only", approvedBy, approvedAt, authorization, scope: { pool | batchSeal, budgetLedger } } WITHOUT maxRequests;
 * an approval that still carries a ceiling is refused (re-approve: it is never silently widened). An authorization relayed by an agent is recorded as such: kind "relayed-instruction" with no signature
 * and humanSignatory false (an agent never signs for a person); kind "signed" needs a signature.
 */
export function approvalProblems(path, maxRequests, plan) {
  if (!path || !existsSync(path)) return ["no operator approval file (--approval): a chargeable calibration run needs an explicit, recorded request ceiling"];
  let a;
  try { a = JSON.parse(readFileSync(path, "utf8")); } catch { return ["approval file unreadable"]; }
  const out = [];
  if (plan.budget?.ledgerLimit !== undefined) {
    if (a.maxRequests !== undefined) out.push(`approval carries maxRequests ${a.maxRequests}: with a shared ledger the per-run ceiling was removed (budget policy shared-total-only); an approval of a bounded run is not extended into an unbounded one: re-approve with budgetPolicy "shared-total-only" and no maxRequests`);
    if (a.budgetPolicy !== "shared-total-only") out.push("approval.budgetPolicy must be \"shared-total-only\" for a shared-ledger calibration (the approver authorizes spending up to the shared ceiling)");
  } else {
    if (!(Number.isInteger(a.maxRequests) && a.maxRequests > 0 && a.maxRequests <= HARD_CAP)) out.push(`approval maxRequests ${a.maxRequests} must be a positive integer <= ${HARD_CAP}`);
    else if (a.maxRequests !== maxRequests) out.push(`approval maxRequests ${a.maxRequests} differs from --max-requests ${maxRequests} (the ceiling is exactly the approved one)`);
  }
  if (!a.approvedBy || !a.approvedAt || Number.isNaN(Date.parse(a.approvedAt))) out.push("approval needs approvedBy and approvedAt");
  const z = a.authorization ?? {};
  if (z.kind === "signed") { if (!z.signature) out.push("a signed approval needs its signature"); }
  else if (z.kind === "relayed-instruction") {
    if (z.signature !== null || z.humanSignatory !== false) out.push("a relayed instruction carries no signature and humanSignatory false (no agent signs for a person)");
    if (!z.verbatim || !z.recordedBy) out.push("a relayed instruction records the verbatim instruction and who recorded it");
  } else out.push("approval.authorization.kind must be signed | relayed-instruction");
  const sealOk = a.scope?.batchSeal === plan.seal;
  const poolOk = typeof a.scope?.pool === "string" && plan.batch && resolve(plan.batch).startsWith(`${resolve(a.scope.pool)}/batches/`);
  if (!sealOk && !poolOk) out.push("approval scope must name this calibration batch's seal digest or its pool");
  if (plan.budget?.ledger && a.scope?.budgetLedger && resolve(a.scope.budgetLedger) !== resolve(plan.budget.ledger)) out.push("approval scope.budgetLedger differs from --budget-ledger (one global budget)");
  if (plan.budget?.ledger && !a.scope?.budgetLedger) out.push("approval scope.budgetLedger missing");
  return out;
}

/** Live POST starts of attempts dispatched but not yet recorded in a runner ledger (their wire journals are still in place). */
export function inflightPostStarts(runsPath) {
  if (!existsSync(runsPath)) return 0;
  const entries = new Ledger(runsPath).records();
  const done = new Set(entries.filter(e => e.type === "result").map(e => `${e.unit_key}#${e.record?.attempt}`));
  let n = 0;
  for (const d of entries.filter(e => e.type === "dispatch" && !done.has(`${e.unit_key}#${e.attempt}`))) {
    for (const j of wireJournals(d.controlDir)) {
      for (const line of readFileSync(j, "utf8").split("\n")) { if (!line) continue; try { const e = JSON.parse(line); if (e.phase === "start" && e.method === "POST") n++; } catch { /* torn tail */ } }
    }
  }
  return n;
}

import { attemptAdmission, pressureVerdict } from "../../src/admission.mjs";
export { attemptAdmission };

/** Running eval-loop experiment controllers other than this process (peer experiments share the account quota). */
export function peerExperiments() {
  const { readdirSync: list, readFileSync: read } = process.getBuiltinModule("node:fs");
  const out = [];
  for (const p of list("/proc").filter(n => /^\d+$/.test(n) && Number(n) !== process.pid)) {
    let parts; try { parts = read(`/proc/${p}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (!/(^|\/)node$/.test(parts[0] ?? "")) continue; // controllers are node processes (a shell quoting the command is not one)
    const argv = parts.join(" ");
    if (/pi-eval-loop\/experiments\/[^ /]+\/run\.mjs|bin\/eval-loop\.mjs .*--(once|resume|loop)|confirmatory-1\/calibrate\.mjs(?!.*--dry-run)/.test(argv) && !/node --test/.test(argv)) out.push({ pid: Number(p), cmd: argv.slice(0, 160) });
  }
  return out;
}

/** Triage classes that make a task's grader invalid as a difficulty measurement (pre-registered 2026-11-07). */
export const INVALID_CLASSES = ["test-gap", "reference-vs-blind", "reference-fails-hidden", "blind-not-discriminating", "remedy-incomplete"];
/**
 * Problems when a task with a known grader defect (its triage.json under `reviews` carries an INVALID class that its
 * adjudication did not set aside) is not excluded by the plan, or when a measured task has no complete triage at all.
 */
export function knownDefectProblems({ reviews, plan }) {
  const out = [];
  const excluded = new Set((plan.rule?.exclusions ?? []).map(x => x.task));
  for (const id of plan.allTasks ?? plan.tasks) {
    const p = join(reviews, id, "triage.json");
    if (!existsSync(p)) { if (!excluded.has(id)) out.push(`${id}: no cross-provider triage (unreviewed grader)`); continue; }
    const t = JSON.parse(readFileSync(p, "utf8"));
    if (t.classes.includes("incomplete") && !excluded.has(id)) out.push(`${id}: review incomplete`);
    const invalid = t.classes.filter(c => INVALID_CLASSES.includes(c) && !(t.settled ?? []).includes(c));
    if (invalid.length && !excluded.has(id)) out.push(`${id}: known grader defect (${invalid.join(", ")}) not excluded`);
  }
  return out;
}

export { pressureVerdict } from "../../src/admission.mjs";

/** Status of a (possibly partial) calibration: unit classes from the runner ledger and the budget. */
export function calibrationStatus({ plan, state, budget, simulated = false }) {
  const runs = join(state, "runs.jsonl");
  const classes = unitClassesFromLedger(runs, { harnessId: "stable", context: contextOf(plan), repeats: plan.repeats, tasks: plan.tasks, allowSimulated: simulated });
  return { schema: "pi-eval-loop/calibration-status@1", at: new Date().toISOString(), plan: { batch: plan.batch, seal: plan.seal, units: plan.units, repeats: plan.repeats }, unitClasses: classes.counts, byTask: classes.byTask, budget: budget ? budget.status() : null };
}

/**
 * Run the plan with `backend` under the global budget; returns { summary, status, report? }.
 * @param {{ plan: any, state: string, harnessDir: string, backend: any, protocol?: any, parallelism?: number, log?: (l: string) => void, validate?: any, envDigest?: string,
 *   budget?: RequestBudget, bound?: () => { perRequest: number }, pressure?: { read(since: number): number } | null, watchIntervalMs?: number }} options
 */
export async function runCalibration({ plan, state, harnessDir, backend, protocol = DEFAULT_PROTOCOL, parallelism = 1, log = () => {}, validate, envDigest, budget, bound, pressure = null, watchIntervalMs = 15_000 }) {
  if (!budget) throw new Error("calibration: a RequestBudget is required (no unmetered run)");
  // The plan's route is the measured route: the runner protocol must carry exactly it (never the default route by omission).
  if (plan.route && JSON.stringify(protocol.route) !== JSON.stringify(plan.route)) throw new Error(`calibration: protocol route ${protocol.route?.provider}/${protocol.route?.model} differs from the plan's ${plan.route.provider}/${plan.route.model}`);
  ensureDir(state);
  const lock = acquireLock(join(state, "calibration.lock"));
  try {
    const planLock = { plan: digestOf({ ...plan, problems: undefined }), at: new Date().toISOString() };
    const prior = readJson(join(state, "calibration-lock.json"), null);
    if (prior && prior.plan !== planLock.plan) throw new Error("calibration state belongs to another plan (use a new state directory; the request budget is global and shared)");
    if (!prior) atomicWriteJson(join(state, "calibration-lock.json"), planLock);
    const tasks = loadLocal(plan.batch);
    const tasksById = Object.fromEntries(tasks.map(t => [t.id, t]));
    const grading = readJson(join(state, "grading.json"), {});
    for (const t of tasks) if (!grading[t.id]) { grading[t.id] = validate ? await validate(t) : { ok: true, expected: {}, baselineFailing: [] }; atomicWriteJson(join(state, "grading.json"), grading); }
    const bad = tasks.filter(t => !grading[t.id].ok).map(t => t.id);
    if (bad.length) { const summary = { paused: `grader validation failed: ${bad.join(", ")}`, ran: 0 }; atomicWriteJson(join(state, "calibration-summary.json"), summary); return { summary }; }
    const p = merge(structuredClone(protocol), { parallelism });
    // A frozen plan of the removed sub-ceiling contract is not resumed under the new policy (re-plan and re-approve).
    if (plan.budget?.subCap) throw new Error("calibration plan carries the removed per-context sub-ceiling (budget.subCap): budget policy shared-total-only; use a new state directory with a re-approved plan");
    const admission = attemptAdmission(budget, bound);
    const evaluator = new Evaluator({ stateDir: state, protocol: p, protocolDigest: planLock.plan, envDigest, tasksById, grading, backend, log, admission });
    const harness = { ...plan.harness, dir: harnessDir };
    const units = []; for (const id of plan.tasks) for (let r = 0; r < plan.repeats; r++) units.push({ task: id, split: "calibration", repeat: r });
    // Peer protection over the gateway's failure records (not part of the accounting).
    const events = [];
    let timer = null;
    if (pressure) {
      const since = Date.now();
      const tick = () => {
        try { const v = pressureVerdict({ failures: pressure.read(since) }); if (v.action !== "none") { events.push({ at: new Date().toISOString(), ...v }); evaluator.halted ??= `peer protection: ${v.why}`; } }
        catch (error) { events.push({ at: new Date().toISOString(), action: "halt", why: `pressure meter failure: ${String(error?.message ?? error).slice(0, 200)}` }); evaluator.halted ??= "peer protection: gateway failure records unreadable (fail closed)"; }
      };
      timer = setInterval(tick, watchIntervalMs); timer.unref?.();
    }
    try { await evaluator.evaluate(harness, units, contextOf(plan)); } finally { if (timer) clearInterval(timer); }
    const status = { ...calibrationStatus({ plan, state, budget, simulated: !!backend.simulated }), simulated: !!backend.simulated, halted: evaluator.halted, peerEvents: events };
    atomicWriteJson(join(state, "calibration-status.json"), status);
    const summary = { ran: evaluator.records().length, planned: units.length, paused: evaluator.halted, simulated: !!backend.simulated, unitClasses: status.unitClasses, budget: status.budget && { limit: status.budget.limit, charged: status.budget.charged, settledUsed: status.budget.settledUsed, openReservations: status.budget.openReservations, remaining: status.budget.remaining, meters: status.budget.meters }, at: new Date().toISOString() };
    atomicWriteJson(join(state, "calibration-summary.json"), summary);
    if (evaluator.halted) return { summary, status };
    const ledger = join(state, "runs.jsonl");
    let report;
    try {
      if (backend.simulated) {
        // A simulation is never a measurement: the report is a FIXTURE (never accepted as a calibrated basis).
        /** @type {Record<string, number[]>} */ const outcomes = {}; for (const r of evaluator.records()) (outcomes[r.task_id] ??= [])[r.repeat] = r.task_success ? 1 : 0;
        report = buildCalibrationReport({ batchDir: plan.batch, outcomes, feature: plan.rule.feature, hardMaxRate: plan.rule.hardMaxRate, minTasksPerLevel: plan.rule.minTasksPerLevel, exclusions: plan.rule.exclusions ?? [], measuredWith: { kind: "fixture", note: "simulated backend (plumbing check only)" } });
      } else {
        const outcomes = outcomesFromLedger(ledger, { harnessId: "stable", context: contextOf(plan), repeats: plan.repeats, tasks: plan.tasks, censoring: plan.rule.censoring });
        const unitClasses = unitClassesFromLedger(ledger, { harnessId: "stable", context: contextOf(plan), repeats: plan.repeats, tasks: plan.tasks });
        report = buildCalibrationReport({ batchDir: plan.batch, outcomes, feature: plan.rule.feature, hardMaxRate: plan.rule.hardMaxRate, minTasksPerLevel: plan.rule.minTasksPerLevel, censoring: plan.rule.censoring, unitClasses, exclusions: plan.rule.exclusions ?? [], measuredWith: { kind: "runner-ledger", ledger, harnessId: "stable", harnessCommit: plan.harness.commit, context: contextOf(plan), repeats: plan.repeats, route: `${plan.route.provider}/${plan.route.model}`, protocolDigest: planLock.plan } });
      }
    } catch (error) {
      // The partial status above stays the record; no report is built from an incomplete measurement.
      atomicWriteJson(join(state, "calibration-summary.json"), { ...summary, reportRefused: String(error?.message ?? error).slice(0, 500) });
      return { summary: { ...summary, reportRefused: String(error?.message ?? error) }, status };
    }
    atomicWriteJson(join(state, "calibration-report.json"), report);
    return { summary, status, report };
  } finally { lock.release(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { batch: { type: "string" }, state: { type: "string" }, "harness-dir": { type: "string" }, "harness-commit": { type: "string" }, repeats: { type: "string", default: "3" }, parallelism: { type: "string", default: "1" }, "max-requests": { type: "string" }, approval: { type: "string" }, "budget-ledger": { type: "string" }, "budget-limit": { type: "string" }, "budget-scope": { type: "string" }, route: { type: "string" }, effort: { type: "string" }, context: { type: "string" }, "gateway-db": { type: "string" }, runtime: { type: "string" }, reviews: { type: "string" }, "pressure-minutes": { type: "string", default: "30" }, "hard-max-rate": { type: "string", default: "0.5" }, exclusions: { type: "string" }, "min-tasks-per-level": { type: "string", default: "3" }, "dry-run": { type: "boolean", default: false } } });
  if (!values.batch) { process.stderr.write("usage: calibrate.mjs --batch DIR --state DIR --harness-dir DIR --harness-commit SHA --approval FILE --budget-ledger FILE --runtime DIR --gateway-db FILE --reviews DIR [--exclusions FILE] [--route PROVIDER/MODEL [--effort LEVEL]] [--context ID] (--budget-limit N --budget-scope S | --max-requests N) [--dry-run]\n"); process.exit(64); }
  let protocol;
  try { protocol = studyProtocol({ route: values.route, effort: values.effort }); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(64); }
  if ((values["budget-limit"] === undefined) !== (values["budget-scope"] === undefined)) { process.stderr.write("--budget-limit and --budget-scope go together (the shared ledger's exact init limit and scope)\n"); process.exit(64); }
  const int = (v) => (v !== undefined && /^[0-9]+$/.test(v) ? Number(v) : NaN);
  const parallelism = int(values.parallelism);
  if (!(parallelism >= 1 && parallelism <= 4)) { process.stderr.write("--parallelism must be an integer in 1..4\n"); process.exit(64); }
  const plan = calibrationPlan({ batch: resolve(values.batch), harnessDir: values["harness-dir"] && resolve(values["harness-dir"]), harnessCommit: values["harness-commit"], repeats: int(values.repeats), protocol, maxRequests: values["max-requests"] ? int(values["max-requests"]) : undefined, hardMaxRate: Number(values["hard-max-rate"]), minTasksPerLevel: int(values["min-tasks-per-level"]), budgetLedger: values["budget-ledger"] && resolve(values["budget-ledger"]), exclusions: values.exclusions ? JSON.parse(readFileSync(values.exclusions, "utf8")).exclusions : [], context: values.context, budgetLimit: values["budget-limit"] !== undefined ? int(values["budget-limit"]) : undefined, budgetScope: values["budget-scope"] });
  const approval = approvalProblems(values.approval, plan.budget.maxRequests ?? 0, plan);
  const blocked = [...plan.problems, ...approval];
  if (!values["budget-ledger"]) blocked.push("--budget-ledger: the study's global request budget ledger");
  if (!values["gateway-db"] || !existsSync(values["gateway-db"])) blocked.push("--gateway-db: the gateway usage database (failure records for peer protection)");
  // Attempts are bounded at the actual outbound boundary: only the isolated runtime (isolated-runtime.mjs; private gateway in its
  // own network namespace whose single exit is the attempt gate charging this ledger) qualifies. The shared live gateway is never
  // used. The runtime is re-verified at every reservation and settlement (`bound`), not only here.
  let bound = null, attemptBound = null, runtime = null;
  if (!values.runtime) blocked.push("--runtime DIR: the isolated calibration runtime (the shared live gateway is never used for calibration)");
  else {
    const dir = resolve(values.runtime);
    try {
      runtime = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      // A shared series ledger: the runtime's gate must charge exactly that ledger identity (path checked by runtimeProblems).
      if (plan.budget.ledgerLimit !== undefined && (runtime.budget?.limit !== plan.budget.ledgerLimit || runtime.budget?.scope !== plan.budget.ledgerScope)) blocked.push("the runtime's gate charges another ledger identity (limit/scope) than --budget-limit/--budget-scope: misbound runtime");
      // The measured route must be served by the runtime's model catalog (no silent fallback to another model).
      if (values.route !== undefined) blocked.push(...routeCatalogProblems(runtime.agentDir, plan.route));
      const check = () => runtimeProblems(dir, { running: true, mode: "live", budgetPath: values["budget-ledger"] && resolve(values["budget-ledger"]) });
      attemptBound = () => { const p = check(); if (p.length) throw new Error(`isolated runtime: ${p.join("; ")}`); return { perRequest: GATED_RESERVATION_FACTOR, gated: true, basis: "outbound attempt gate (every provider attempt admitted against this ledger); factor = reservation size per forwarded request (retry 0, redirects)" }; };
      bound = attemptBound();
      if (process.env.EVAL_LOOP_UPSTREAM && process.env.EVAL_LOOP_UPSTREAM !== runtime.upstream) blocked.push(`EVAL_LOOP_UPSTREAM ${process.env.EVAL_LOOP_UPSTREAM} differs from the runtime upstream ${runtime.upstream}`);
      if (process.env.EVAL_LOOP_AGENT_DIR && resolve(process.env.EVAL_LOOP_AGENT_DIR) !== runtime.agentDir) blocked.push("EVAL_LOOP_AGENT_DIR differs from the runtime agent dir");
      process.env.EVAL_LOOP_UPSTREAM = runtime.upstream; process.env.EVAL_LOOP_AGENT_DIR = runtime.agentDir;
    } catch (error) { blocked.push(`isolated runtime unusable (fail closed): ${String(error?.message ?? error).slice(0, 400)}`); }
  }
  const peers = peerExperiments();
  if (peers.length) blocked.push(`peer experiments running on the same account (wait until they finish): ${peers.map(p => `${p.pid} ${p.cmd}`).join(" | ")}`);
  // Every task whose cross-provider review found its grader invalid must be excluded before dispatch (fail closed).
  if (!values.reviews) blocked.push("--reviews DIR: the cross-provider review directory (known grader defects must be excluded before dispatch)");
  else blocked.push(...knownDefectProblems({ reviews: resolve(values.reviews), plan }));
  let budget = null;
  if (!blocked.length) {
    budget = new RequestBudget({ path: resolve(values["budget-ledger"]), limit: plan.budget.ledgerLimit ?? plan.budget.maxRequests, scope: plan.budget.ledgerScope ?? BUDGET_SCOPE });
    try { budget.status(); } catch (error) { blocked.push(`budget: ${error.message}`); }
  }
  const pressure = values["gateway-db"] && existsSync(values["gateway-db"]) ? gatewayPressureMeter({ db: resolve(values["gateway-db"]), model: plan.route.model }) : null;
  const recent = (() => { if (!pressure) return null; const since = Date.now() - int(values["pressure-minutes"]) * 60_000; try { return { since: new Date(since).toISOString(), failures: pressure.read(since) }; } catch (error) { return { error: String(error.message) }; } })();
  const pressureProblem = !recent || recent.error || recent.failures > 0 ? `peer protection: target-model rate-limit/overload failures on the gateway in the last ${values["pressure-minutes"]} min (${JSON.stringify(recent)})` : null;
  const worst = bound ? { perRequestReservation: bound.perRequest, gated: !!bound.gated, perAttemptReservation: plan.budget.perAttemptCeiling * bound.perRequest, expectedAttempts: plan.budget.expectedRequests, maxConcurrentReservation: plan.budget.perAttemptCeiling * bound.perRequest * parallelism } : null;
  if (values["dry-run"] || blocked.length) {
    process.stdout.write(`${JSON.stringify({ ...plan, dryRun: values["dry-run"], approval: approval.length ? { ok: false, problems: approval } : { ok: true }, attemptBound: bound, accounting: worst, budgetStatus: budget?.status() ?? null, runtime: runtime && { dir: runtime.dir, upstream: runtime.upstream, credential: { expiresAt: runtime.credential?.expiresAt, usableUntil: runtime.credential?.usableUntil, refreshTokenCopied: runtime.credential?.refreshTokenCopied } }, recentPressure: recent, blocked: [...blocked, ...(pressureProblem ? [pressureProblem] : [])], modelCalls: 0, wouldRun: blocked.length === 0 && !pressureProblem })}\n`);
    process.exit(blocked.length ? 2 : 0);
  }
  if (pressureProblem) { process.stderr.write(`BLOCKED: ${pressureProblem}\n`); process.exit(2); }
  if (!values.state) { process.stderr.write("--state DIR is required for a run\n"); process.exit(64); }
  const { environmentDigest, hostEnvironment, prerequisites, stopProxies } = await import("../../src/sandbox.mjs");
  const { validateGrader } = await import("../../src/grader.mjs");
  const env = hostEnvironment();
  const missing = (await prerequisites(env)).filter(x => !x.ok);
  if (missing.length) { process.stderr.write(`BLOCKED: missing prerequisites ${missing.map(m => m.name).join(", ")}\n`); process.exit(2); }
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => { stopProxies("SIGTERM"); process.exit(130); });
  const state = resolve(values.state);
  const out = await runCalibration({ plan, state, harnessDir: resolve(values["harness-dir"]), backend: realBackend(env), protocol, parallelism, budget, bound: attemptBound, pressure, log: (l) => process.stderr.write(`${l.replace(/ PASS$/, "")}\n`), validate: (t) => validateGrader({ task: t, scratch: join(state, "grading-scratch", t.id), env }), envDigest: environmentDigest(env, plan.route) });
  process.stdout.write(`${JSON.stringify({ ...out.summary, unitClasses: out.summary.unitClasses })}\n`);
  process.exit(out.report ? 0 : 2);
}
