// Empirical difficulty calibration on a SEPARATE calibration set (protocol-4, docs/design.md "Difficulty calibration").
//
// A calibration batch is sealed with purpose "calibration" (eval-loop-supply seal --purpose calibration); it is never eligible as a
// holdout (datasets.mjs holdoutStatus) and its families count as prior holdout families. The stable baseline is measured on it
// (an external step: it needs model runs; studies/confirmatory-1/calibrate.mjs is the bounded runner), and this module turns those
// measured outcomes into a REPORT: per level of one pre-declared, candidate-blind task feature (for example the author's declared
// tier), the number of tasks and the mean baseline pass rate, and the rule "a level is hard when it has at least minTasksPerLevel
// tasks and a mean rate <= hardMaxRate". Holdout tasks of LATER batches may then carry difficultyBasis "calibrated" with
// { report, reportSha256, level }; eligibility verifies the report (sha256, calibration purpose, no shared task id or family, the
// rule makes the level hard) AND re-derives it (verifyCalibrationReport): the outcomes must come from the runner ledger the
// report names (sha256, intact hash chain, real unsimulated runs of the recorded harness, every task measured, no unresolved
// infrastructure failure), and the hard levels must follow from the levels and the pre-registered rule. A report built from
// hand-supplied outcomes ("fixture") is never accepted. No holdout task is ever run or selected by this calibration, and the
// thresholds are the operator's pre-registered inputs (no defaults).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { datasetPurpose, holdoutLedger, loadLocal, verifySeal } from "./datasets.mjs";
import { retryable, successOf } from "./metrics.mjs";
import { Ledger, digestOf, sha256 } from "./util.mjs";

export const CALIBRATION_SCHEMA = "pi-eval-loop/calibration@1";
/** Pre-declared, candidate-blind features a calibration may use (named so a report can be re-derived without code). */
export const FEATURES = {
  "declared-tier": (m) => (typeof m.tier === "string" ? m.tier : null),
  "source-difficulty-value": (m) => (m.difficultySource?.value !== undefined ? String(m.difficultySource.value) : null),
};

/**
 * Class of one final calibration record (pre-registered 2026-11-07, before any calibration run):
 *   "success"        successOf(record);
 *   "integrity"      no success and a task-agent integrity violation / leak (a VALID failure of the baseline, reported apart);
 *   "failure"        no success, the agent ran to an agent-side end (completed, agent_error incl. request budget, timeout);
 *   "infrastructure" infra_error, model_unavailable, model_error, aborted, grader_error (provider/controller/grader failures);
 *   "harness-fault"  harness_crash, route_violation (the baseline harness itself broke: not a property of the task).
 * Under censoring "infra-excluded@1" infrastructure and harness-fault units carry NO difficulty evidence: they are left out of
 * a task's rate (never counted as 0); a task with no remaining outcome is unmeasured (the report is refused).
 */
export const INFRA_TERMINALS = new Set(["infra_error", "model_unavailable", "model_error", "aborted", "grader_error"]);
export const HARNESS_FAULTS = new Set(["harness_crash", "route_violation"]);
export const CENSORING = "infra-excluded@1";
/**
 * "infra-integrity-excluded@2" (2026-11-07, after the first measurement showed easy tasks with hidden-test pass 1.0 failing only
 * on strict integrity): a unit with an integrity violation is an INTEGRITY observation, not a cognitive one - it never counts as
 * a failure (nor a success) for difficulty; infrastructure and harness faults stay censored as in @1. A task needs at least
 * rule.minValidUnitsPerTask valid (success/failure) units to carry difficulty evidence; tasks below are "insufficient" and do not
 * count toward a level; a level with fewer than minTasksPerLevel sufficient tasks is never hard. Integrity is still blocked
 * separately (integrity gates elsewhere are unchanged); this rule only stops integrity failures from certifying difficulty.
 */
export const CENSORING_V2 = "infra-integrity-excluded@2";
export const CENSORINGS = new Set([CENSORING, CENSORING_V2]);

/** Exact (Clopper-Pearson) 95% interval of k successes in n (n >= 1), by bisection on the binomial tail. */
export function exactInterval(k, n, alpha = 0.05) {
  const lgam = (x) => { let s = 0; for (let i = 2; i < x; i++) s += Math.log(i); return s; };
  const pmf = (i, p) => Math.exp(lgam(n + 1) - lgam(i + 1) - lgam(n - i + 1) + (i ? i * Math.log(p) : 0) + (n - i ? (n - i) * Math.log(1 - p) : 0));
  const cdf = (x, p) => { let s = 0; for (let i = 0; i <= x; i++) s += pmf(i, p); return s; };
  const solve = (f) => { let lo = 0, hi = 1; for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (f(mid)) hi = mid; else lo = mid; } return (lo + hi) / 2; };
  const lower = k === 0 ? 0 : solve(p => 1 - cdf(k - 1, p) >= alpha / 2);
  const upper = k === n ? 1 : solve(p => cdf(k, p) <= alpha / 2);
  return [Math.round(lower * 1000) / 1000, Math.round(upper * 1000) / 1000];
}
export function unitClass(r) {
  if (successOf(r)) return "success";
  if (INFRA_TERMINALS.has(r.terminal_status)) return "infrastructure";
  if (HARNESS_FAULTS.has(r.terminal_status)) return "harness-fault";
  if ((r.integrity?.violations?.length ?? 0) > 0 || (r.integrity?.leakHits?.length ?? 0) > 0 || (r.critical_failure_count ?? 0) > 0) return "integrity";
  return "failure";
}

/** Final record per task#repeat of `harnessId` in `context` (latest attempt; refuses simulated records and a broken chain). */
function finalRecords(ledgerPath, { harnessId, context, allowSimulated = false }) {
  const ledger = new Ledger(ledgerPath);
  const chain = ledger.verify();
  if (chain.length) throw new Error(`calibration: runner ledger chain broken: ${chain.slice(0, 2).join("; ")}`);
  const final = new Map();
  for (const e of ledger.records()) {
    if (e.type !== "result" || e.record?.candidate_id !== harnessId || e.record?.context !== context) continue;
    const r = e.record;
    if (r.simulated && !allowSimulated) throw new Error("calibration: simulated record in the runner ledger (a simulation is never a measurement)");
    const k = `${r.task_id}#${r.repeat}`;
    if (!final.has(k) || r.attempt >= final.get(k).attempt) final.set(k, r);
  }
  return final;
}

/**
 * Per-unit classes of a (possibly partial) calibration run: { units: { "task#r": class | "censored" }, counts, byTask }.
 * "censored" = planned but not measured (never run, halted, or an unresolved retryable infrastructure failure).
 * allowSimulated: a STATUS of a simulated (plumbing) run; never used for a report.
 * @param {string} ledgerPath @param {{ harnessId: string, context: string, repeats: number, tasks: string[], allowSimulated?: boolean }} options
 */
export function unitClassesFromLedger(ledgerPath, { harnessId, context, repeats, tasks, allowSimulated = false }) {
  const final = existsSync(ledgerPath) ? finalRecords(ledgerPath, { harnessId, context, allowSimulated }) : new Map();
  /** @type {Record<string, string>} */ const units = {};
  /** @type {Record<string, number>} */ const counts = { success: 0, failure: 0, integrity: 0, infrastructure: 0, "harness-fault": 0, censored: 0 };
  /** @type {Record<string, Record<string, number>>} */ const byTask = {};
  for (const id of tasks) {
    byTask[id] = { success: 0, failure: 0, integrity: 0, infrastructure: 0, "harness-fault": 0, censored: 0 };
    for (let i = 0; i < repeats; i++) {
      const r = final.get(`${id}#${i}`);
      const c = !r || retryable(r) ? "censored" : unitClass(r);
      units[`${id}#${i}`] = c; counts[c]++; byTask[id][c]++;
    }
  }
  return { units, counts, byTask };
}

/**
 * Final 0/1 outcomes per task (repeat order) of the harness `harnessId` in a runner ledger (evaluator runs.jsonl), limited to
 * `context`. Refuses simulated records, unresolved retryable (infrastructure) results and missing repeats. With censoring
 * "infra-excluded@1" (see unitClass) infrastructure and harness-fault units are left out instead of counting as 0.
 * @param {string} ledgerPath @param {{ harnessId: string, context: string, repeats: number, tasks: string[], censoring?: string }} options
 */
export function outcomesFromLedger(ledgerPath, { harnessId, context, repeats, tasks, censoring }) {
  if (censoring !== undefined && !CENSORINGS.has(censoring)) throw new Error(`calibration: unknown censoring rule ${censoring}`);
  const final = finalRecords(ledgerPath, { harnessId, context });
  /** @type {Record<string, number[]>} */ const outcomes = {};
  const problems = [];
  for (const id of tasks) {
    outcomes[id] = [];
    for (let i = 0; i < repeats; i++) {
      const r = final.get(`${id}#${i}`);
      if (!r) problems.push(`${id}#${i} not measured`);
      else if (censoring && (retryable(r) || ["infrastructure", "harness-fault"].includes(unitClass(r)))) continue;
      else if (censoring === CENSORING_V2 && unitClass(r) === "integrity") continue;
      else if (retryable(r)) problems.push(`${id}#${i} ended in an unresolved infrastructure failure (${r.terminal_status})`);
      else outcomes[id].push(successOf(r) ? 1 : 0);
    }
    // @2: a task without valid units is reported as insufficient evidence (never as a failure); @1 refuses it.
    if (censoring === CENSORING && !problems.length && !outcomes[id].length) problems.push(`${id}: every repeat ended in an infrastructure or harness failure (no difficulty evidence)`);
  }
  if (problems.length) throw new Error(`calibration: incomplete measurement: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5})` : ""}`);
  return outcomes;
}

/**
 * @param {{ batchDir: string, outcomes: Record<string, number[]>, feature: string, hardMaxRate: number, minTasksPerLevel: number,
 *   measuredWith: { kind: "runner-ledger" | "fixture", ledger?: string, ledgerSha256?: string, harnessId?: string, harnessCommit?: string, context?: string, repeats?: number, route?: string, protocolDigest?: string, note?: string } }} options
 *   outcomes: task id -> 0/1 outcomes of the stable baseline on the calibration batch; feature: a name in FEATURES; measuredWith:
 *   what produced them. kind "runner-ledger" = the evaluator ledger of real runs (re-derived at every verification); "fixture" =
 *   hand-supplied (tests, dry runs): such a report is never accepted for a calibrated difficulty basis.
 */
export function buildCalibrationReport({ batchDir, outcomes, feature, hardMaxRate, minTasksPerLevel, measuredWith, censoring, unitClasses, exclusions = [], minValidUnitsPerTask }) {
  if (censoring !== undefined && !CENSORINGS.has(censoring)) throw new Error(`calibration: unknown censoring rule ${censoring}`);
  if (censoring === CENSORING_V2 && !(Number.isInteger(minValidUnitsPerTask) && minValidUnitsPerTask >= 1)) throw new Error(`calibration: ${CENSORING_V2} needs a pre-registered minValidUnitsPerTask >= 1`);
  const minValid = censoring === CENSORING_V2 ? minValidUnitsPerTask : 1;
  if (datasetPurpose(batchDir) !== "calibration") throw new Error("calibration: the batch is not a calibration-purpose set (a holdout is never used for calibration)");
  const seal = verifySeal(batchDir);
  if (!seal.ok) throw new Error(`calibration: ${seal.why}`);
  if (holdoutLedger(batchDir).records().some(r => r.type === "use")) throw new Error("calibration: the batch carries a holdout use");
  if (!(hardMaxRate > 0 && hardMaxRate < 1) || !(Number.isInteger(minTasksPerLevel) && minTasksPerLevel >= 1)) throw new Error("calibration: hardMaxRate in (0,1) and minTasksPerLevel >= 1 must be pre-registered");
  if (!FEATURES[feature]) throw new Error(`calibration: feature must be one of ${Object.keys(FEATURES).join(", ")}`);
  if (!["runner-ledger", "fixture"].includes(measuredWith?.kind)) throw new Error("calibration: measuredWith.kind must be runner-ledger or fixture");
  const tasks = loadLocal(batchDir);
  const excl = exclusionProblems(exclusions, tasks.map(t => t.id));
  if (excl.length) throw new Error(`calibration: ${excl.join("; ")}`);
  const excluded = new Set(exclusions.map(x => x.task));
  // Excluded (pre-registered invalid) tasks carry no outcomes: they are not measured at all.
  const leaked = [...excluded].filter(id => outcomes[id]?.length);
  if (leaked.length) throw new Error(`calibration: outcomes for excluded tasks (${leaked.join(", ")}): an invalid task is never measured`);
  const missing = tasks.filter(t => !excluded.has(t.id) && !outcomes[t.id]?.length && censoring !== CENSORING_V2).map(t => t.id);
  if (missing.length) throw new Error(`calibration: no measured outcomes for ${missing.slice(0, 5).join(", ")} (every calibration task must be measured; none may be dropped after seeing results)`);
  const bad = tasks.filter(t => !excluded.has(t.id) && (outcomes[t.id] ?? []).some(x => x !== 0 && x !== 1)).map(t => t.id);
  if (censoring === CENSORING_V2) { const absent = tasks.filter(t => !excluded.has(t.id) && !Array.isArray(outcomes[t.id])).map(t => t.id); if (absent.length) throw new Error(`calibration: no outcome list for ${absent.slice(0, 5).join(", ")} (every calibration task must be listed; an empty list = no valid unit)`); }
  if (bad.length) throw new Error(`calibration: outcomes must be 0/1 run results (${bad.slice(0, 5).join(", ")})`);
  const extra = Object.keys(outcomes).filter(id => !tasks.some(t => t.id === id));
  if (extra.length) throw new Error(`calibration: outcomes for tasks outside the batch (${extra.slice(0, 5).join(", ")})`);
  const summary = levelsOf(tasks.filter(t => !excluded.has(t.id)), outcomes, FEATURES[feature], minValid, censoring === CENSORING_V2);
  const ledger = measuredWith.kind === "runner-ledger" && measuredWith.ledger ? { ledgerSha256: existsSync(measuredWith.ledger) ? sha256(readFileSync(measuredWith.ledger)) : null } : {};
  const v2 = censoring === CENSORING_V2;
  return { schema: CALIBRATION_SCHEMA, purpose: "calibration", batchDir, seal: seal.seal.digest, feature, rule: { hardMaxRate, minTasksPerLevel, hardLevels: hardLevelsOf(summary, { hardMaxRate, minTasksPerLevel }), ...(censoring ? { censoring } : {}), ...(v2 ? { minValidUnitsPerTask } : {}), ...(exclusions.length ? { exclusions } : {}) }, ...(unitClasses ? { unitClasses: unitClasses.counts } : {}), levels: summary, ...(v2 ? { taskEvidence: taskEvidenceOf(tasks.filter(t => !excluded.has(t.id)), outcomes, minValid) } : {}), tasks: tasks.map(t => t.id).sort(), families: [...new Set(tasks.map(t => t.family))].sort(), measuredWith: { ...measuredWith, ...ledger }, outcomesDigest: digestOf(outcomes), limitations: ["Measured on the calibration set with the stable baseline of that time: a later harness or model may find other levels hard.", "Levels with fewer than minTasksPerLevel tasks are never hard.", ...(v2 ? ["Integrity-violating units are integrity observations and carry no difficulty evidence; a task's rate is over its valid units only, with an exact 95% interval (3 runs cannot show a task is 'truly hard': 0/3 has an upper bound of 0.71)."] : []), ...(measuredWith.kind === "fixture" ? ["FIXTURE: outcomes were supplied by hand, not re-derivable from real runs; never accepted as a calibrated difficulty basis."] : [])] };
}

function levelsOf(tasks, outcomes, of, minValid = 1, detailed = false) {
  const levels = {};
  for (const t of tasks) {
    const level = of(JSON.parse(readFileSync(`${t.dir}/task.json`, "utf8")));
    if (level === null || level === undefined) continue;
    const ys = outcomes[t.id] ?? [];
    const v = (levels[level] ??= { tasks: 0, rates: [], insufficient: 0, validUnits: 0, successes: 0 });
    if (ys.length < minValid) { v.insufficient++; continue; }
    v.tasks++;
    v.rates.push(ys.reduce((s, x) => s + x, 0) / ys.length);
    v.validUnits += ys.length; v.successes += ys.reduce((s, x) => s + x, 0);
  }
  return Object.fromEntries(Object.entries(levels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, detailed
    ? { tasks: v.tasks, meanRate: v.rates.length ? v.rates.reduce((s, x) => s + x, 0) / v.rates.length : null, insufficientTasks: v.insufficient, validUnits: v.validUnits, successes: v.successes }
    : { tasks: v.tasks, meanRate: v.rates.reduce((s, x) => s + x, 0) / v.rates.length }]));
}

/** Per task under @2: valid units, successes, exact 95% interval, or "insufficient". */
function taskEvidenceOf(tasks, outcomes, minValid) {
  return Object.fromEntries(tasks.map(t => { const ys = outcomes[t.id] ?? []; const k = ys.reduce((s, x) => s + x, 0); return [t.id, ys.length < minValid ? { validUnits: ys.length, successes: k, evidence: "insufficient" } : { validUnits: ys.length, successes: k, rate: k / ys.length, ci95: exactInterval(k, ys.length) }]; }).sort(([a], [b]) => a.localeCompare(b)));
}
/**
 * Pre-registered exclusions (fixed in the plan before the first dispatch; never chosen after seeing outcomes): a calibration task
 * whose review shows its grader invalid (e.g. hidden tests accept an adjudicated violation of the instruction, or the reference
 * fails independent tests) is NOT measured: its outcomes would not be valid difficulty evidence in either direction. The
 * review diagnostics stay in the evidence document; a corrected version may be calibrated in a NEW batch. Each names its reason and an evidence document by sha256 (verified when present).
 */
export function exclusionProblems(exclusions, taskIds) {
  const out = [];
  if (!Array.isArray(exclusions)) return ["exclusions must be a list"];
  for (const x of exclusions) {
    if (!taskIds.includes(x?.task)) out.push(`exclusion of a task outside the batch: ${x?.task}`);
    if (!x?.reason || !x?.evidence?.document || !/^[0-9a-f]{64}$/.test(x?.evidence?.sha256 ?? "")) out.push(`exclusion of ${x?.task}: reason and evidence {document, sha256} required`);
    else if (existsSync(x.evidence.document) && sha256(readFileSync(x.evidence.document)) !== x.evidence.sha256) out.push(`exclusion of ${x.task}: evidence document changed`);
  }
  if (new Set(exclusions.map(x => x?.task)).size !== exclusions.length) out.push("a task is excluded twice");
  return out;
}
const hardLevelsOf = (summary, { hardMaxRate, minTasksPerLevel }) => Object.entries(summary).filter(([, v]) => v.tasks >= minTasksPerLevel && v.meanRate !== null && v.meanRate <= hardMaxRate).map(([k]) => k).sort();

/**
 * Re-derive a calibration report (empty = verified): runner-ledger provenance, ledger bytes and chain, the sealed calibration batch
 * it names, the outcomes re-read from the ledger, the levels and the hard levels of the pre-registered rule.
 * @param {any} report
 */
export function verifyCalibrationReport(report) {
  const problems = [];
  const m = report?.measuredWith ?? {};
  if (report?.schema !== CALIBRATION_SCHEMA) return ["unknown report schema"];
  if (m.kind !== "runner-ledger") return [`outcomes are not from a runner ledger (measuredWith.kind ${m.kind ?? "missing"})`];
  if (!m.ledger || !existsSync(m.ledger)) return ["runner ledger not found"];
  if (sha256(readFileSync(m.ledger)) !== m.ledgerSha256) problems.push("runner ledger changed since the report (sha256 differs)");
  if (!report.batchDir || !existsSync(join(report.batchDir, "SEAL.json"))) return [...problems, "calibration batch not found"];
  const seal = verifySeal(report.batchDir);
  if (!seal.ok || seal.seal?.digest !== report.seal) problems.push("calibration batch seal differs from the report");
  if (datasetPurpose(report.batchDir) !== "calibration") problems.push("the named batch is not a calibration-purpose set");
  let outcomes;
  const measured = report.tasks.filter(id => !(report.rule?.exclusions ?? []).some(x => x.task === id));
  try { outcomes = outcomesFromLedger(m.ledger, { harnessId: m.harnessId, context: m.context, repeats: m.repeats, tasks: measured, censoring: report.rule?.censoring }); }
  catch (error) { return [...problems, String(error.message)]; }
  const records = new Ledger(m.ledger).records().filter(e => e.type === "result" && e.record?.candidate_id === m.harnessId && e.record?.context === m.context).map(e => e.record);
  if (records.some(r => r.harness_commit !== m.harnessCommit)) problems.push("runner records of another harness commit");
  if (digestOf(outcomes) !== report.outcomesDigest) problems.push("outcomes differ from the runner ledger");
  const tasks = loadLocal(report.batchDir);
  if (JSON.stringify(tasks.map(t => t.id).sort()) !== JSON.stringify(report.tasks)) problems.push("task list differs from the sealed batch");
  else if (FEATURES[report.feature]) {
    const exclusions = report.rule?.exclusions ?? [];
    problems.push(...exclusionProblems(exclusions, tasks.map(t => t.id)));
    const excluded = new Set(exclusions.map(x => x.task));
    const v2 = report.rule?.censoring === CENSORING_V2;
    const levels = levelsOf(tasks.filter(t => !excluded.has(t.id)), outcomes, FEATURES[report.feature], v2 ? report.rule.minValidUnitsPerTask : 1, v2);
    if (JSON.stringify(levels) !== JSON.stringify(report.levels)) problems.push("levels differ from the re-derived measurement");
    if (JSON.stringify(hardLevelsOf(levels, report.rule ?? {})) !== JSON.stringify(report.rule?.hardLevels ?? [])) problems.push("hard levels do not follow from the pre-registered rule");
    if (report.unitClasses) { const c = unitClassesFromLedger(m.ledger, { harnessId: m.harnessId, context: m.context, repeats: m.repeats, tasks: measured }).counts; if (JSON.stringify(c) !== JSON.stringify(report.unitClasses)) problems.push("unit classes differ from the runner ledger"); }
    // Difficulty certification: a hard level counted integrity failures as difficulty unless integrity units are censored (@2).
    if (!v2 && (report.rule?.hardLevels ?? []).length) problems.push(`hard levels certified under censoring ${report.rule?.censoring ?? "none"}, which counts integrity violations as task failures: integrity failures never certify difficulty (re-derive under ${CENSORING_V2})`);
  } else problems.push(`unknown feature ${report.feature}`);
  return problems;
}
