// Paired, clustered Bayesian bootstrap (Rubin 1981) for quality-first harness comparison.
//
// ParetoSaddler (arXiv 2611.02079, Eq. 7-8) draws Dirichlet(1_R) weights over the R repeated executions of every screening task and
// averages tasks uniformly: it captures execution variability on FIXED tasks only (their Appendix L names this limitation). Here:
//   level "execution" : the paper's estimator (task weights uniform, repeats Dirichlet) - uncertainty of these tasks' runs only;
//   level "task"      : task weights ~ Dirichlet(1_T), SHARED by both arms (paired contrast), repeats nested per task and arm;
//   level "family"    : family weights ~ Dirichlet(1_F), task weights within each family, repeats nested (clustered by family).
// The draws are not new observations: few runs stay few runs; the support is a posterior-predictive fraction under this model,
// never a probability that the harness generalizes.
import { createRng } from "./rng.mjs";

export const OBJECTIVES = ["overall", "hard", "consistency"];

function taskWeights(rng, tasks, level) {
  const n = tasks.length;
  if (level === "execution") return new Array(n).fill(1 / n);
  if (level === "task") return rng.dirichlet(n);
  if (level === "family") {
    const families = [...new Set(tasks.map(t => t.family ?? t.task))];
    const fw = rng.dirichlet(families.length);
    const weights = new Array(n).fill(0);
    families.forEach((family, fi) => {
      const members = tasks.map((t, i) => (t.family ?? t.task) === family ? i : -1).filter(i => i >= 0);
      const inner = rng.dirichlet(members.length);
      members.forEach((i, k) => { weights[i] = fw[fi] * inner[k]; });
    });
    return weights;
  }
  throw new Error(`unknown bootstrap level ${level}`);
}

const weightedRate = (rng, values) => {
  if (!values.length) return NaN;
  const w = rng.dirichlet(values.length);
  let p = 0; for (let i = 0; i < values.length; i++) p += w[i] * values[i];
  return p;
};

/** Objectives of one arm under task weights v and per-task success rates p. */
function objectives(tasks, v, p) {
  let overall = 0, consistency = 0, hard = 0, hardWeight = 0;
  for (let i = 0; i < tasks.length; i++) {
    overall += v[i] * p[i]; consistency += v[i] * p[i] * p[i];
    if (tasks[i].hard) { hard += v[i] * p[i]; hardWeight += v[i]; }
  }
  return { overall, consistency, hard: hardWeight > 0 ? hard / hardWeight : NaN };
}

/** Plug-in point estimates (uniform task weights, raw repeat means) of one arm. */
export function pointEstimate(tasks, side) {
  const p = tasks.map(t => mean(t[side]));
  return objectives(tasks, new Array(tasks.length).fill(1 / tasks.length), p);
}

export const mean = (values) => values.length ? values.reduce((s, v) => s + v, 0) / values.length : NaN;
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : NaN;

/**
 * Quality-first promotion event of one draw (the quality-only analogue of ParetoSaddler's Eq. 7): some objective improves by more
 * than its minimum gain while every other available objective loses at most its allowance.
 */
export function promotionEvent(delta, { eps, minGain }, available) {
  for (const objective of available) {
    if (!(delta[objective] > (minGain[objective] ?? 0))) continue;
    if (available.every(other => other === objective || delta[other] >= -(eps[other] ?? 0))) return true;
  }
  return false;
}

/** Deployment event: overall improves AND no other objective loses more than its (strict) adoption allowance. */
export function adoptionEvent(delta, { eps, minGain }, available) {
  if (!(delta.overall > (minGain.overall ?? 0))) return false;
  return available.every(other => other === "overall" || delta[other] >= -(eps[other] ?? 0));
}

/**
 * Paired bootstrap comparison of arm `a` (parent / stable) and arm `b` (candidate) over the same tasks.
 * tasks: [{ task, family, hard, a: number[], b: number[] }] (values in [0,1]; both arms need >= 1 value per task).
 * Returns support for `event` (promotion|adoption|custom predicate), per-objective delta summaries and per-family deltas.
 * @param {Array<{ task: string, family?: string, hard?: boolean, a: number[], b: number[] }>} tasks
 * @param {{ draws?: number, seed?: string, level?: string, event?: "promotion" | "adoption" | ((delta: Record<string, number>) => boolean),
 *   eps?: Record<string, number>, minGain?: Record<string, number>, lossThreshold?: number, familyLossThreshold?: number }} [options]
 */
export function compare(tasks, { draws = 10_000, seed, level = "task", event = "promotion", eps = {}, minGain = {}, lossThreshold = 0.03, familyLossThreshold = 0.15 } = {}) {
  if (!tasks.length) throw new Error("compare: no tasks");
  for (const t of tasks) if (!t.a?.length || !t.b?.length) throw new Error(`compare: task ${t.task} lacks observations for both arms (matched observations required)`);
  // Same seed for every event at one level: the draws (and so the events) are evaluated on identical resamples.
  const rng = createRng(`${seed}:${level}`);
  const available = OBJECTIVES.filter(o => o !== "hard" || tasks.some(t => t.hard));
  const deltas = Object.fromEntries(available.map(o => [o, new Float64Array(draws)]));
  const families = [...new Set(tasks.map(t => t.family ?? t.task))];
  const familyDelta = Object.fromEntries(families.map(f => [f, new Float64Array(draws)]));
  const test = typeof event === "function" ? event : event === "adoption" ? adoptionEvent : promotionEvent;
  let hits = 0, losses = 0;
  for (let j = 0; j < draws; j++) {
    const v = taskWeights(rng, tasks, level);
    const pa = tasks.map(t => weightedRate(rng, t.a));
    const pb = tasks.map(t => weightedRate(rng, t.b));
    const qa = objectives(tasks, v, pa), qb = objectives(tasks, v, pb);
    const delta = {};
    // Differences below floating-point resolution are exactly zero (identical outcomes must never count as an improvement).
    for (const o of available) { const d = qb[o] - qa[o]; delta[o] = Math.abs(d) < 1e-12 ? 0 : d; deltas[o][j] = delta[o]; }
    if (test(delta, { eps, minGain }, available)) hits++;
    if (delta.overall < -lossThreshold) losses++;
    for (const f of families) {
      let num = 0, den = 0;
      tasks.forEach((t, i) => { if ((t.family ?? t.task) === f) { num += v[i] * (pb[i] - pa[i]); den += v[i]; } });
      familyDelta[f][j] = den > 0 && Math.abs(num / den) >= 1e-12 ? num / den : 0;
    }
  }
  const support = hits / draws;
  const summarize = (array, below) => { const sorted = Float64Array.from(array).sort(); return { mean: mean(array), lo95: quantile(sorted, 0.025), hi95: quantile(sorted, 0.975), probPositive: array.filter(x => x > 0).length / array.length, probNegative: array.filter(x => x < 0).length / array.length, ...(below !== undefined ? { probBelow: array.filter(x => x < -below).length / array.length } : {}) }; };
  return {
    level, event: typeof event === "function" ? "custom" : event, draws, seed, support, mcse: Math.sqrt(support * (1 - support) / draws),
    lossThreshold, lossSupport: losses / draws, familyLossThreshold,
    tasks: tasks.length, families: families.length, hardTasks: tasks.filter(t => t.hard).length,
    observations: { a: tasks.reduce((s, t) => s + t.a.length, 0), b: tasks.reduce((s, t) => s + t.b.length, 0) },
    available,
    point: { a: pointEstimate(tasks, "a"), b: pointEstimate(tasks, "b") },
    delta: Object.fromEntries(available.map(o => [o, summarize(deltas[o])])),
    familyDelta: Object.fromEntries(families.map(f => [f, summarize(familyDelta[f], familyLossThreshold)])),
  };
}

/**
 * One arm's posterior summary (task-level bootstrap) for reports.
 * @param {Array<{ task: string, family?: string, hard?: boolean, a: number[], b?: number[] }>} tasks
 * @param {{ draws?: number, seed?: string, level?: string }} [options]
 */
export function describeArm(tasks, { draws = 10_000, seed, level = "task" } = {}) {
  const rng = createRng(`${seed}:describe:${level}`);
  const available = OBJECTIVES.filter(o => o !== "hard" || tasks.some(t => t.hard));
  const values = Object.fromEntries(available.map(o => [o, new Float64Array(draws)]));
  for (let j = 0; j < draws; j++) {
    const v = taskWeights(rng, tasks, level);
    const q = objectives(tasks, v, tasks.map(t => weightedRate(rng, t.a)));
    for (const o of available) values[o][j] = q[o];
  }
  const point = pointEstimate(tasks, "a");
  return Object.fromEntries(available.map(o => { const sorted = Float64Array.from(values[o]).sort(); return [o, { point: point[o], mean: mean(values[o]), lo95: quantile(sorted, 0.025), hi95: quantile(sorted, 0.975) }]; }));
}

/** Wilson score interval of k successes in n trials (descriptive, per-run, ignores clustering). */
export function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - r) / d, (c + r) / d];
}
