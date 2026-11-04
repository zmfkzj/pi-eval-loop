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
 * Critical problems that reject a candidate at once, whatever the statistics. Always critical: grading-material/credential leak
 * attempts, route violations and harness crashes. Workspace integrity violations (an agent weakening tests) are task failures in
 * every arm; they become critical for the candidate when it produces MORE of them than the reference arm on the same units.
 */
export function criticalProblems(records, candidateId, { reference, units } = {}) {
  const inScope = (r) => !units || units.has(`${r.split}|${r.task_id}|${r.repeat}`);
  const own = finalOf(records.filter(r => r.candidate_id === candidateId && inScope(r)));
  const problems = [];
  let violations = 0;
  for (const r of own) {
    violations += r.integrity?.violations?.length ? 1 : 0;
    for (const h of r.integrity?.leakHits ?? []) problems.push(`leak ${r.task_id}#${r.repeat}: ${h}`);
    if (r.terminal_status === "route_violation") problems.push(`route violation ${r.task_id}#${r.repeat}: ${r.terminal_detail}`);
    if (r.terminal_status === "harness_crash") problems.push(`harness crash ${r.task_id}#${r.repeat}: ${r.terminal_detail}`);
  }
  const refViolations = reference ? finalOf(records.filter(r => r.candidate_id === reference && inScope(r))).filter(r => r.integrity?.violations?.length).length : 0;
  if (violations > refViolations) problems.push(`integrity: ${violations} run(s) with workspace integrity violations vs ${refViolations} for ${reference ?? "no reference"} (${own.filter(r => r.integrity?.violations?.length).map(r => `${r.task_id}#${r.repeat}: ${r.integrity.violations[0]}`).slice(0, 3).join("; ")})`);
  return problems;
}
const finalOf = (records) => { const m = new Map(); for (const r of records) { const p = m.get(r.unit_key); if (!p || r.attempt >= p.attempt) m.set(r.unit_key, r); } return [...m.values()]; };

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
 * Returns { adopt, verdict: ADOPT|KEEP_STABLE|INCONCLUSIVE|BLOCKED, reasons }.
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
  if (cmp.support >= a.support) return { adopt: true, verdict: "ADOPT", reasons };
  return { adopt: false, verdict: "KEEP_STABLE", reasons: [...reasons, "improvement not supported at the adoption threshold (no improvement shown is a normal result)"] };
}

/** Convenience wrappers binding the protocol's settings. */
export const screeningCompare = (pairs, protocol, seed) => compare(pairs, { draws: protocol.bootstrap.draws, seed, level: protocol.screening.level, event: "promotion", eps: protocol.gate.eps, minGain: protocol.gate.minGain, lossThreshold: protocol.gate.eps.overall });
export const taskLevelPromotion = (pairs, protocol, seed) => compare(pairs, { draws: protocol.bootstrap.draws, seed, level: "task", event: "promotion", eps: protocol.gate.eps, minGain: protocol.gate.minGain, lossThreshold: protocol.gate.eps.overall });
export const developmentCompare = (pairs, protocol, seed) => compare(pairs, { draws: protocol.bootstrap.draws, seed, level: protocol.development.level, event: "promotion", eps: protocol.gate.eps, minGain: protocol.gate.minGain, lossThreshold: protocol.gate.eps.overall });
export const adoptionCompare = (pairs, protocol, seed) => compare(pairs, { draws: protocol.bootstrap.draws, seed, level: protocol.adoption.level, event: "adoption", eps: protocol.adoption.eps, minGain: protocol.adoption.minGain, lossThreshold: 0, familyLossThreshold: protocol.adoption.familyRegression });
