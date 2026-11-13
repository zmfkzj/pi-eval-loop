#!/usr/bin/env node
// ctrl-confirm-2 sample-size planning for BOTH co-primary endpoints (valid-success rate and reliable success = all r repeats valid),
// with families -> tasks -> repeats. Conservative, model-free planning from ALREADY EXPOSED discovery records only (ctrl-ablation-1,
// legacy-scored P1 vs S); it never reads holdout outcomes.
//
// Model: each discovery task gives a pair (p_control, p_candidate) of legacy-valid probabilities, shrunk toward the arm means with a
// Beta prior fitted by method of moments (between-task over-dispersion). A simulated confirmation draws F families; every task of a
// family uses THE SAME drawn pair (perfect within-family correlation of the true probabilities: conservative for clustering). The
// candidate effect is scaled by `shrink` (winner's curse; the disclosed integrity contract of the new design may absorb part of
// the effect: 0.25 and 0 are reported too). Each task gets r Bernoulli repeats per arm. The co-primary passes when, for both
// endpoints, the family-level t interval's lower bound is > 0 (approximation of the preregistered family-cluster bootstrap).
//   node pi-eval-loop/experiments/ctrl-confirm-2/power.mjs --records FILE [--sims N] [--out FILE]
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createRng } from "../../src/rng.mjs";
import { Ledger } from "../../src/util.mjs";
import { legacyValid } from "./lib.mjs";

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const T975 = (df) => (df >= 120 ? 1.98 : df >= 60 ? 2.0 : df >= 40 ? 2.02 : df >= 30 ? 2.04 : df >= 20 ? 2.09 : df >= 15 ? 2.13 : df >= 10 ? 2.23 : 2.45);

export function priorStrength(ks, r) {
  const ps = ks.map(k => k / r), m = mean(ps), v = sd(ps) ** 2;
  const between = Math.max(1e-6, v - (m * (1 - m)) / r);
  return Math.min(200, Math.max(2, (m * (1 - m)) / between - 1));
}

/** Task pairs from final records (latest per unit) of the control and candidate arms. */
export function calibrate(records, { control = "S", candidate = "P1", metric = legacyValid } = {}) {
  const t = {};
  for (const r of records) ((t[r.candidate_id] ??= {})[r.task_id] ??= []).push(metric(r) ? 1 : 0);
  const tasks = Object.keys(t[control]).filter(x => t[candidate]?.[x]).sort();
  const r = t[control][tasks[0]].length;
  const kC = tasks.map(x => t[control][x].reduce((s, y) => s + y, 0)), kX = tasks.map(x => t[candidate][x].reduce((s, y) => s + y, 0));
  const strength = priorStrength(kC, r), mC = mean(kC) / r, mX = mean(kX) / r;
  const shrunk = (k, m) => (k + strength * m) / (r + strength);
  return { pairs: tasks.map((x, i) => ({ task: x, pC: shrunk(kC[i], mC), pX: shrunk(kX[i], mX) })), strength, mC, mX, r };
}

/** Power of the co-primary (and of each endpoint alone) for `tasks` tasks in families of `perFamily` tasks, `repeats` repeats. */
/** `familySizes` (the realized holdout's tasks per family) overrides tasks/perFamily. */
export function power({ pairs }, { tasks, perFamily = 2, familySizes = null, repeats = 3, shrink = 1, sims = 2000, seed = "ctrl-confirm-2/power" }) {
  const sizes = familySizes ?? Array.from({ length: Math.ceil(tasks / perFamily) }, (_, f) => Math.min(perFamily, tasks - f * perFamily));
  const rng = createRng(`${seed}:${sizes.join(",")}:${repeats}:${shrink}`);
  let both = 0, rateOnly = 0, relOnly = 0;
  const families = sizes.length;
  for (let s = 0; s < sims; s++) {
    const fR = [], fL = [];
    for (let f = 0; f < families; f++) {
      const p = pairs[rng.int(pairs.length)];
      const pX = Math.min(1, Math.max(0, p.pC + shrink * (p.pX - p.pC)));
      const m = sizes[f];
      let dR = 0, dL = 0;
      for (let t = 0; t < m; t++) {
        let kC = 0, kX = 0;
        for (let i = 0; i < repeats; i++) { if (rng.next() < p.pC) kC++; if (rng.next() < pX) kX++; }
        dR += (kX - kC) / repeats; dL += (kX === repeats ? 1 : 0) - (kC === repeats ? 1 : 0);
      }
      fR.push(dR / m); fL.push(dL / m);
    }
    const t = T975(families - 1), q = Math.sqrt(families);
    const okR = mean(fR) - t * sd(fR) / q > 0, okL = mean(fL) - t * sd(fL) / q > 0;
    if (okR) rateOnly++; if (okL) relOnly++; if (okR && okL) both++;
  }
  return { coPrimary: both / sims, rate: rateOnly / sims, reliable: relOnly / sims };
}

export function finalRecordsOf(path) {
  const ledger = new Ledger(path);
  const bad = ledger.verify();
  if (bad.length) throw new Error(`ledger damaged: ${bad.join("; ")}`);
  const last = new Map();
  for (const e of ledger.records()) if (e.type === "result") last.set(e.unit_key, e.record);
  return [...last.values()];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { records: { type: "string" }, sims: { type: "string", default: "2000" }, out: { type: "string" }, tasks: { type: "string" }, "family-sizes": { type: "string" } } });
  const cal = calibrate(finalRecordsOf(values.records));
  const sizes = values.tasks ? values.tasks.split(",").map(Number) : [20, 30, 40, 50, 60, 80, 100, 120];
  const rows = [];
  for (const shrink of [1, 0.5, 0.25, 0]) for (const repeats of [3]) for (const tasks of sizes) rows.push({ shrink, repeats, tasks, perFamily: 2, ...power(cal, { tasks, repeats, shrink, sims: Number(values.sims) }) });
  // The realized holdout (tasks per family of the sealed batch), when given.
  if (values["family-sizes"]) { const fs = values["family-sizes"].split(",").map(Number); for (const shrink of [1, 0.5, 0.25, 0]) rows.push({ shrink, repeats: 3, tasks: fs.reduce((s, x) => s + x, 0), realizedFamilies: fs.length, ...power(cal, { familySizes: fs, repeats: 3, shrink, sims: Number(values.sims) }) }); }
  const out = { source: values.records, calibration: { control: "S", candidate: "P1", metric: "legacy-valid", priorStrength: cal.strength, rates: { control: cal.mC, candidate: cal.mX }, tasks: cal.pairs.length }, method: "see file header", rows };
  const text = `${JSON.stringify(out, null, 1)}\n`;
  if (values.out) writeFileSync(values.out, text); else process.stdout.write(text);
}
