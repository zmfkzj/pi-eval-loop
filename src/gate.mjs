// Quality-first gates. Exploration (screening -> development) and deployment (adoption) use different, pre-registered rules:
// exploration may keep a candidate that trades up to eps of one quality objective for credible progress in another; adoption
// demands overall improvement at a stricter support on an independent holdout plus every non-statistical check.
// Cost, tokens and time never enter any gate.
import { compare } from "./stats.mjs";

export const DECISIONS = ["PROMOTE", "EXTEND", "INCONCLUSIVE", "REJECT"];

/**
 * Screening decision on matched parent/candidate observations (stats.compare result `cmp`).
 * Near the threshold (|support - gamma| < band) the screening is EXTENDED while repeats remain; at the cap a below-threshold result
 * in the band is INCONCLUSIVE (kept, never deployed); an infra-tainted comparison is never promoted.
 */
export function screeningDecision(cmp, { support, band, maxRepeats }, { repeats, infraRate = 0, maxInfraRate = 0.1, hardRequired = false }) {
  const reasons = [`support ${cmp.support.toFixed(4)} vs threshold ${support} (level ${cmp.level}, ${cmp.draws} draws, mcse ${cmp.mcse.toFixed(4)})`];
  const canExtend = repeats < maxRepeats;
  if (infraRate > maxInfraRate) { reasons.push(`infrastructure error rate ${infraRate.toFixed(3)} > ${maxInfraRate}`); return { decision: canExtend ? "EXTEND" : "INCONCLUSIVE", reasons }; }
  if (hardRequired && cmp.hardTasks === 0) { reasons.push("no hard task in the screening batch"); return { decision: "INCONCLUSIVE", reasons }; }
  if (Math.abs(cmp.support - support) < band && canExtend) { reasons.push(`within band ${band} of the threshold: extend repeats (${repeats} -> more)`); return { decision: "EXTEND", reasons }; }
  if (cmp.support >= support) return { decision: "PROMOTE", reasons };
  if (cmp.support >= support - band) { reasons.push("near the threshold after the maximum repeats"); return { decision: "INCONCLUSIVE", reasons }; }
  return { decision: "REJECT", reasons };
}

/**
 * Critical problems that reject a candidate at once, whatever the statistics and WHATEVER THE REFERENCE ARM DID (protocol-2):
 *  - task-agent workspace integrity violations in a run under the candidate harness (test files deleted/changed, skip markers,
 *    runner injection, module rewiring, test detection, grading-material references, symlinks);
 *  - task-agent leak attempts (grading material, credentials, controller paths);
 *  - route violations and harness crashes.
 * Harness-candidate violations (the candidate's own patch touching protected files, evaluation-aware content, forged checks,
 * trust-boundary breaches) are rejected earlier, at proposal time (`patchIntegrity`, `protectedState`, `compareChecks`).
 * The reference arm's count (`reference`) is reported as context only: a baseline that also produces violations never excuses a
 * candidate (protocol-1 compared counts, which let a candidate with as many violations as stable through). EVERY recorded attempt is
 * inspected, not only the final one: a clean retry can never erase evidence of an earlier attempt.
 * @param {any[]} records run records (every attempt)
 * @param {string} candidateId
 * @param {{ reference?: string, units?: Set<string> }} [options] reference arm (context only) and an optional `split|task|repeat` scope
 * @returns {string[]}
 */
export function criticalProblems(records, candidateId, { reference, units } = {}) {
  const inScope = (r) => !units || units.has(`${r.split}|${r.task_id}|${r.repeat}`);
  const own = records.filter(r => r.candidate_id === candidateId && inScope(r));
  const problems = [];
  const tag = (r) => `${r.split}/${r.task_id}#${r.repeat}${r.attempt > 1 ? ` attempt ${r.attempt}` : ""}`;
  const violating = own.filter(r => r.integrity?.violations?.length);
  if (violating.length) {
    const refViolations = reference ? records.filter(r => r.candidate_id === reference && inScope(r) && r.integrity?.violations?.length).length : null;
    problems.push(`integrity: ${violating.length} run attempt(s) under ${candidateId} with task-agent workspace integrity violations${refViolations === null ? "" : ` (reference ${reference}: ${refViolations} in the same scope; context only, never an excuse)`}`);
    for (const r of violating) problems.push(`task-agent integrity violation ${tag(r)}: ${r.integrity.violations[0]}`);
  }
  for (const r of own) {
    for (const h of r.integrity?.leakHits ?? []) problems.push(`task-agent leak attempt ${tag(r)}: ${h}`);
    if (r.terminal_status === "route_violation") problems.push(`route violation ${tag(r)}: ${r.terminal_detail}`);
    if (r.terminal_status === "harness_crash") problems.push(`harness crash ${tag(r)}: ${r.terminal_detail}`);
  }
  return problems;
}

/**
 * Development qualification against the stable baseline on the development split: completed, critical-clean, not credibly worse
 * than stable by more than eps.overall (lossSupport < development.support). Dev-evaluated candidates are archived either way.
 */
export function developmentDecision(cmp, protocol, critical) {
  const reasons = [];
  if (critical.length) return { qualified: false, reasons: [`critical: ${critical.slice(0, 5).join("; ")}`] };
  reasons.push(`P(overall loss > ${cmp.lossThreshold}) = ${cmp.lossSupport.toFixed(4)} (must be < ${protocol.development.support})`);
  reasons.push(`quality-first support vs stable ${cmp.support.toFixed(4)}`);
  return { qualified: cmp.lossSupport < protocol.development.support, reasons };
}

/**
 * Deployment gate on the holdout comparison `cmp` (event "adoption", level task) plus non-statistical evidence.
 * Returns { adopt, verdict: ADOPT|EXPLORATORY_SUPPORTED|KEEP_STABLE|INCONCLUSIVE|BLOCKED, reasons, candidateAccepted? }.
 * protocol-4 adds checks that are ANDed onto the unchanged protocol-3 rules (each can only turn an ADOPT into another verdict):
 *  - adoption.requireFamilyLevel: the same adoption event under the family-clustered bootstrap (`evidence.familyCmp`) must reach
 *    adoption.support (missing comparison: BLOCKED);
 *  - analysisPlan.mode "confirmatory": `evidence.confirmatory` (design.mjs confirmatoryChecks) must pass: missing or an
 *    incomplete plan -> BLOCKED, data that cannot answer the plan -> INCONCLUSIVE, an unsupported answer -> KEEP_STABLE;
 *  - any other plan (exploratory, the default): never ADOPT. A candidate that passes every protocol-3 rule and the family-level
 *    check is EXPLORATORY_SUPPORTED (candidate accepted as a measurement, adopt false: nothing is deployed). Production adoption
 *    needs a complete, pre-registered confirmatory plan and its checks.
 */
export function adoptionDecision(cmp, protocol, evidence) {
  const reasons = [], blocked = [];
  const a = protocol.adoption, h = protocol.holdout;
  if (h.requireIndependent && !evidence.holdoutIndependent) blocked.push(`no independent holdout: ${evidence.holdoutWhy ?? "unknown"}`);
  if (evidence.critical?.length) blocked.push(`critical failures: ${evidence.critical.slice(0, 5).join("; ")}`);
  if (a.requireChecks && evidence.checksPassed !== true) blocked.push(`relevant test/typecheck suite not passing in the candidate: ${evidence.checksDetail ?? "not run"}`);
  if (evidence.routeOk !== true) blocked.push(`route/environment integrity not confirmed: ${evidence.routeDetail ?? "not checked"}`);
  if (evidence.incomplete?.length) blocked.push(`incomplete holdout evaluation: ${evidence.incomplete.length} unit(s) missing`);
  if (blocked.length) return { adopt: false, verdict: "BLOCKED", reasons: blocked };
  if (!cmp) return { adopt: false, verdict: "BLOCKED", reasons: ["no holdout comparison"] };
  if (cmp.tasks < h.minTasks || cmp.families < h.minFamilies) return { adopt: false, verdict: "INCONCLUSIVE", reasons: [`holdout too small: ${cmp.tasks} tasks / ${cmp.families} families (need ${h.minTasks}/${h.minFamilies})`] };
  if (a.requireHardStratum && cmp.hardTasks === 0) return { adopt: false, verdict: "INCONCLUSIVE", reasons: ["holdout has no hard stratum"] };
  if ((evidence.infraRate ?? 0) > protocol.watchdog.maxInfraRate) return { adopt: false, verdict: "INCONCLUSIVE", reasons: [`holdout infrastructure error rate ${evidence.infraRate}`] };
  reasons.push(`adoption support ${cmp.support.toFixed(4)} (need >= ${a.support}; ${cmp.tasks} independent tasks, ${cmp.families} families, level ${cmp.level})`);
  reasons.push(`overall delta mean ${cmp.delta.overall.mean.toFixed(4)} [${cmp.delta.overall.lo95.toFixed(4)}, ${cmp.delta.overall.hi95.toFixed(4)}]`);
  const regressed = Object.entries(cmp.familyDelta).filter(([, d]) => d.probBelow >= a.familyRegressionSupport).map(([f, d]) => `${f} (P(delta < -${a.familyRegression}) = ${d.probBelow.toFixed(3)})`);
  if (regressed.length) return { adopt: false, verdict: "KEEP_STABLE", reasons: [...reasons, `family regression: ${regressed.join(", ")}`] };
  if (evidence.newCritical) return { adopt: false, verdict: "KEEP_STABLE", reasons: [...reasons, "new critical failures"] };
  if (cmp.support < a.support) return { adopt: false, verdict: "KEEP_STABLE", reasons: [...reasons, "improvement not supported at the adoption threshold (no improvement shown is a normal result)"] };
  // ---- protocol-4 additions (only ever stricter)
  if (a.requireFamilyLevel) {
    const f = evidence.familyCmp;
    if (!f) return { adopt: false, verdict: "BLOCKED", reasons: [...reasons, "family-level comparison required (adoption.requireFamilyLevel) but missing"] };
    reasons.push(`family-clustered adoption support ${f.support.toFixed(4)} (need >= ${a.support}; ${f.families} families)`);
    if (f.support < a.support) return { adopt: false, verdict: "KEEP_STABLE", reasons: [...reasons, "improvement not supported once tasks of one family are resampled together"] };
  }
  if (protocol.analysisPlan?.mode !== "confirmatory") return { adopt: false, verdict: "EXPLORATORY_SUPPORTED", candidateAccepted: true, reasons: [...reasons, "exploratory analysis plan: the candidate passed the adoption gate as a measurement only; production adoption requires a complete, pre-registered confirmatory analysis plan and its checks (nothing deployed)"] };
  const c = evidence.confirmatory;
  if (!c) return { adopt: false, verdict: "BLOCKED", reasons: [...reasons, `confirmatory analysis plan: ${evidence.planProblems?.length ? evidence.planProblems.join("; ") : "confirmatory checks missing"}`] };
  if (c.inconclusive.length) return { adopt: false, verdict: "INCONCLUSIVE", reasons: [...reasons, ...c.passed, ...c.failed, ...c.inconclusive.map(x => `confirmatory: ${x}`)] };
  if (c.failed.length) return { adopt: false, verdict: "KEEP_STABLE", reasons: [...reasons, ...c.passed, ...c.failed.map(x => `confirmatory: ${x}`)] };
  reasons.push(...c.passed.map(x => `confirmatory: ${x}`));
  return { adopt: true, verdict: "ADOPT", candidateAccepted: true, reasons };
}

/** Convenience wrappers binding the protocol's settings. */
export const screeningCompare = (pairs, protocol, seed) => compare(pairs, { draws: protocol.bootstrap.draws, seed, level: protocol.screening.level, event: "promotion", eps: protocol.gate.eps, minGain: protocol.gate.minGain, lossThreshold: protocol.gate.eps.overall });
export const taskLevelPromotion = (pairs, protocol, seed) => compare(pairs, { draws: protocol.bootstrap.draws, seed, level: "task", event: "promotion", eps: protocol.gate.eps, minGain: protocol.gate.minGain, lossThreshold: protocol.gate.eps.overall });
export const developmentCompare = (pairs, protocol, seed) => compare(pairs, { draws: protocol.bootstrap.draws, seed, level: protocol.development.level, event: "promotion", eps: protocol.gate.eps, minGain: protocol.gate.minGain, lossThreshold: protocol.gate.eps.overall });
export const adoptionCompare = (pairs, protocol, seed) => compare(pairs, { draws: protocol.bootstrap.draws, seed, level: protocol.adoption.level, event: "adoption", eps: protocol.adoption.eps, minGain: protocol.adoption.minGain, lossThreshold: 0, familyLossThreshold: protocol.adoption.familyRegression });
/** The adoption event under the family-clustered bootstrap (protocol-4 adoption.requireFamilyLevel). */
export const familyAdoptionCompare = (pairs, protocol, seed) => compare(pairs, { draws: protocol.bootstrap.draws, seed, level: "family", event: "adoption", eps: protocol.adoption.eps, minGain: protocol.adoption.minGain, lossThreshold: 0, familyLossThreshold: protocol.adoption.familyRegression });
