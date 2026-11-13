#!/usr/bin/env node
// Confirmation sizing for ctrl-ablation-1 (PREREGISTRATION.md §9), calibrated on the discovery records of the locked candidate X
// and the stable control S. Pilot-based hierarchical simulation, not a normal-approximation extrapolation:
//  - every discovery task gives a pair of success probabilities (p_S, p_X), shrunk toward the arm mean with a Beta prior whose
//    strength is fitted by the method of moments on the S arm (between-task over-dispersion);
//  - a simulated confirmation draws NEW tasks by resampling discovery FAMILIES (clusters) and their tasks, optionally scaling the
//    task effects by `shrink` (winner's-curse discount: the candidate was selected as the best of 7);
//  - each simulated task gets r repeats per arm; the co-primary passes when the task-cluster 95% interval of dValid is above 0
//    AND that of dI (inconsistency) is below 0 (intersection-union, each one-sided 0.025; t intervals over tasks).
//   node pi-eval-loop/experiments/ctrl-ablation-plan/power.mjs --state DIR --candidate X [--sims N]
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createRng } from "../../src/rng.mjs";
import { finalRecords } from "../ctrl-ablation/analyze.mjs";
import { inconsistency, tableOf, validOf } from "../ctrl-ablation/lib.mjs";

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const T975 = (df) => df >= 120 ? 1.98 : df >= 60 ? 2.0 : df >= 40 ? 2.02 : df >= 30 ? 2.04 : df >= 20 ? 2.09 : 2.26;

/** Beta prior strength (a+b) by method of moments from per-task successes k of r; bounded to [2, 200]. */
export function priorStrength(ks, r) {
  const ps = ks.map(k => k / r), m = mean(ps), v = sd(ps) ** 2;
  const within = m * (1 - m) / r;
  const between = Math.max(1e-6, v - within);
  return Math.min(200, Math.max(2, m * (1 - m) / between - 1));
}

export function calibrate(records, candidate, control = "S") {
  const t = tableOf(records, validOf);
  const fam = Object.fromEntries(records.map(r => [r.task_id, r.family]));
  const tasks = Object.keys(t[control]).filter(x => t[candidate]?.[x]).sort();
  const r = t[control][tasks[0]].length;
  const kS = tasks.map(x => t[control][x].reduce((s, y) => s + y, 0)), kX = tasks.map(x => t[candidate][x].reduce((s, y) => s + y, 0));
  const strength = priorStrength(kS, r), mS = mean(kS) / r, mX = mean(kX) / r;
  const shrunk = (k, m) => (k + strength * m) / (r + strength);
  const pairs = tasks.map((x, i) => ({ task: x, family: fam[x], pS: shrunk(kS[i], mS), pX: shrunk(kX[i], mX) }));
  return { pairs, strength, mS, mX, r };
}

export function power({ pairs }, { tasks, repeats, shrink = 1, sims = 2000, seed = "power" }) {
  const rng = createRng(`${seed}:${tasks}:${repeats}:${shrink}`);
  const families = [...new Set(pairs.map(p => p.family))];
  const byFamily = Object.fromEntries(families.map(f => [f, pairs.filter(p => p.family === f)]));
  let pass = 0, passValid = 0;
  for (let s = 0; s < sims; s++) {
    const dV = [], dI = [];
    while (dV.length < tasks) {
      const fam = byFamily[families[rng.int(families.length)]];
      const p = fam[rng.int(fam.length)];
      const pX = Math.min(1, Math.max(0, p.pS + shrink * (p.pX - p.pS)));
      let kS = 0, kX = 0;
      for (let i = 0; i < repeats; i++) { if (rng.next() < p.pS) kS++; if (rng.next() < pX) kX++; }
      dV.push((kX - kS) / repeats); dI.push(inconsistency(kX, repeats) - inconsistency(kS, repeats));
    }
    const t = T975(tasks - 1), n = Math.sqrt(tasks);
    const validOk = mean(dV) - t * sd(dV) / n > 0, consOk = mean(dI) + t * sd(dI) / n < 0;
    if (validOk) passValid++;
    if (validOk && consOk) pass++;
  }
  return { coPrimary: pass / sims, validOnly: passValid / sims };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, candidate: { type: "string" }, sims: { type: "string", default: "2000" } } });
  const cal = calibrate(finalRecords(resolve(values.state)), values.candidate);
  const rows = [];
  for (const shrink of [1, 0.5]) for (const repeats of [3, 4, 6]) for (const tasks of [30, 60, 90, 120, 180, 240]) rows.push({ shrink, repeats, tasks, ...power(cal, { tasks, repeats, shrink, sims: Number(values.sims) }) });
  process.stdout.write(`${JSON.stringify({ candidate: values.candidate, priorStrength: cal.strength, discoveryRates: { S: cal.mS, X: cal.mX }, rows }, null, 1)}\n`);
}
