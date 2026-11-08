#!/usr/bin/env node
// ctrl-confirm-3 sample-size planning and type-I validation. Model-free; uses ONLY already-exposed historical data
// (ctrl-confirm-2 per-task legacy-valid outcomes of all four arms under the disclosed contract) for calibration; never reads any
// ctrl-confirm-3 outcome. Every simulated experiment is decided by the SAME function as the analysis (stats.mjs hierarchy ->
// coPrimaryDecision on exact family sign-flip p values), incl. the fixed-sequence H2 gate.
//
// Generative model (planning assumption, not a claim): a simulated task population is a family bootstrap of the 54 historical
// families (whole families with all their tasks, preserving within-family dependence, concordant failures and the sparse
// discordance of E2). Each task carries per-arm success probabilities = its observed k/3 shrunk toward the arm mean with a
// beta-binomial prior fitted by method of moments. The candidate's per-task effect is the shrunk OCR - OC difference scaled by `s`
// (s = 1: centred on the historical estimate, with its family-bootstrap uncertainty; s = 0.5: attenuated, e.g. winner's curse;
// s = 0: identical arms = exact null). Partial nulls (one co-primary endpoint null, the other beneficial) and an asymmetric,
// heterogeneous weak null are built by calibrating per-task effects to a zero population mean of one endpoint. r = 3 repeats are
// independent Bernoulli draws. N tasks per experiment are drawn as whole families until N is reached (last family truncated).
//   node pi-eval-loop/experiments/ctrl-confirm-3/power.mjs [--sims N] [--out FILE] [--tasks 93,150,...]
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createRng } from "../../src/rng.mjs";
import { hierarchy } from "./stats.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG = resolve(HERE, "../..");
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const clip = (p) => Math.min(1, Math.max(0, p));

/** Historical calibration: per-task outcomes per arm and families (ctrl-confirm-2 analysis + sealed holdout task.json). */
export function historical({ analysisPath = join(PKG, "records/ctrl-confirm-2/confirmation/analysis.json"), holdoutDir = resolve(PKG, "../results/ctrl-confirm-2-holdout/ctrl-confirm-2-holdout-3e83b1b2af67") } = {}) {
  const a = JSON.parse(readFileSync(analysisPath, "utf8"));
  const familyOf = {};
  for (const e of readdirSync(holdoutDir, { withFileTypes: true })) if (e.isDirectory() && existsSync(join(holdoutDir, e.name, "task.json"))) familyOf[e.name] = JSON.parse(readFileSync(join(holdoutDir, e.name, "task.json"), "utf8")).family;
  return { perTask: a.perTask, familyOf, tasks: Object.keys(a.perTask.OC).sort() };
}

export function priorStrength(ks, r) {
  const ps = ks.map(k => k / r), m = mean(ps), v = ps.reduce((s, p) => s + (p - m) ** 2, 0) / Math.max(1, ps.length - 1);
  const between = Math.max(1e-6, v - (m * (1 - m)) / r);
  return Math.min(200, Math.max(1, (m * (1 - m)) / between - 1));
}

/** Families -> tasks -> shrunk probabilities per arm. */
export function calibrate(h, arms = ["OC", "OCR", "PC", "PCR"], { shrink = true } = {}) {
  const r = h.perTask.OC[h.tasks[0]].length;
  const p = {}, info = {};
  for (const arm of arms) {
    const ks = h.tasks.map(t => h.perTask[arm][t].reduce((s, x) => s + x, 0));
    const m = mean(ks) / r, a = shrink ? priorStrength(ks, r) : 0; // shrink:false = raw k/r (optimistic bound: 0/3 and 3/3 tasks become deterministic)
    info[arm] = { rate: m, priorStrength: a };
    h.tasks.forEach((t, i) => { (p[t] ??= {})[arm] = (ks[i] + a * m) / (r + a); });
  }
  // Shared task latent (planning model "latent"): the task's success probability pooled over the 12 repeats of all four historical
  // arms (task difficulty dominates: 59/93 tasks 0/3 and 16/93 3/3 in BOTH OC and OCR), posterior Beta(K + a m, 12 - K + a (1 - m)).
  const R = arms.length * r, Ks = h.tasks.map(t => arms.reduce((s, arm) => s + h.perTask[arm][t].reduce((u, x) => u + x, 0), 0));
  const M = mean(Ks) / R, A = priorStrength(Ks, R);
  info.latent = { rate: M, priorStrength: A, repeats: R };
  const drawRng = createRng("ctrl-confirm-3/power/latent-calibration");
  h.tasks.forEach((t, i) => { const ab = [Ks[i] + A * M, R - Ks[i] + A * (1 - M)]; p[t].latent = ab; p[t].latentDraws = Array.from({ length: 64 }, () => betaDraw(drawRng, ...ab)); });
  const fams = {};
  for (const t of h.tasks) (fams[h.familyOf[t]] ??= []).push(p[t]);
  return { families: Object.values(fams), info, r };
}

function gammaDraw(rng, k) {
  if (k < 1) return gammaDraw(rng, k + 1) * Math.pow(Math.max(rng.next(), 1e-300), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = Math.max(rng.next(), 1e-300), u2 = rng.next(); x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = Math.max(rng.next(), 1e-300);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
export function betaDraw(rng, a, b) { const x = gammaDraw(rng, a), y = gammaDraw(rng, b); return x / (x + y); }
const logit = (p) => Math.log(p / (1 - p)), expit = (z) => 1 / (1 + Math.exp(-z));

/** Effect scenarios: map a task's calibrated probabilities to (pOC, pOCR, pPCR) of the simulation. */
export function scenarioOf(name, pool) {
  const all = pool.families.flat();
  // Root of c -> mean target over the pool (bisection on [-1, 1]; direction from the end points; throws without a sign change).
  const zeroBy = (f, target) => {
    const g = (c) => mean(all.map(q => target(q, f(q, c))));
    const up = g(1) > g(-1);
    if (Math.sign(g(-1)) === Math.sign(g(1))) throw new Error("scenario calibration: no sign change");
    let lo = -1, hi = 1;
    for (let i = 0; i < 80; i++) { const c = (lo + hi) / 2; if ((g(c) > 0) === up) hi = c; else lo = c; }
    return (lo + hi) / 2;
  };
  const scaled = (s) => (q) => ({ OC: q.OC, OCR: clip(q.OC + s * (q.OCR - q.OC)), PCR: q.PCR });
  if (name.startsWith("scale:")) return scaled(Number(name.slice(6)));
  if (name.startsWith("latent:")) {
    // Shared-latent model: OC = PCR = p (posterior draw per simulated task), OCR = expit(logit p + beta) with beta calibrated so the
    // population E1 effect equals the target (e.g. 0.039 = ctrl-confirm-2 point estimate; 0.02 attenuated; 0 = exact null).
    const target = Number(name.slice(7));
    const draws = all.flatMap(q => q.latentDraws.map(p => Math.min(1 - 1e-9, Math.max(1e-9, p))));
    const e1 = (b) => mean(draws.map(p => expit(logit(p) + b) - p));
    let lo = -5, hi = 5;
    for (let i = 0; i < 80; i++) { const c = (lo + hi) / 2; if (e1(c) > target) hi = c; else lo = c; }
    const beta = target === 0 ? 0 : (lo + hi) / 2;
    const map = (q, rng) => { const p = Math.min(1 - 1e-9, Math.max(1e-9, betaDraw(rng, ...q.latent))); return { OC: p, OCR: expit(logit(p) + beta), PCR: p }; };
    map.population = { beta, E1: mean(draws.map(p => expit(logit(p) + beta) - p)), E2: mean(draws.map(p => expit(logit(p) + beta) ** 3 - p ** 3)) };
    return map;
  }
  if (name === "null:E2-only-null") {
    // E1 benefit on low-probability tasks, compensating loss on high-probability tasks so that the population E2 effect is 0.
    const f = (q, b) => clip(q.OC < 0.5 ? q.OC + 0.06 : q.OC - b);
    const b = zeroBy((q, c) => f(q, c), (q, x) => x ** 3 - q.OC ** 3);
    return (q) => ({ OC: q.OC, OCR: f(q, b), PCR: q.PCR });
  }
  if (name === "null:E1-only-null") {
    // E2 benefit on high-probability tasks, compensating loss on low-probability tasks so that the population E1 effect is 0.
    const f = (q, b) => clip(q.OC >= 0.5 ? q.OC + 0.12 : q.OC - b);
    const b = zeroBy((q, c) => f(q, c), (q, x) => x - q.OC);
    return (q) => ({ OC: q.OC, OCR: f(q, b), PCR: q.PCR });
  }
  if (name === "null:skewed-heterogeneous-E1") {
    // Large benefit on a few tasks, small losses on most (asymmetric), population E1 effect calibrated to 0.
    const f = (q, c) => clip(q.OC + (q.OCR - q.OC) * 3 + c);
    const c = zeroBy(f, (q, x) => x - q.OC);
    return (q) => ({ OC: q.OC, OCR: f(q, c), PCR: q.PCR });
  }
  throw new Error(`unknown scenario ${name}`);
}

/** Population (expected) effects of a scenario on E1 and E2 over the calibration pool (descriptive). */
export function populationEffect(pool, map, r = 3) {
  if (map.population) return { E1: map.population.E1, E2: map.population.E2, beta: map.population.beta };
  const all = pool.families.flat().map(q => map(q));
  return { E1: mean(all.map(q => q.OCR - q.OC)), E2: mean(all.map(q => q.OCR ** r - q.OC ** r)) };
}

/** One simulated experiment -> tables per arm and familyOf. */
export function simulate(pool, map, { tasks, repeats = 3, rng, withPCR = false }) {
  const T = { OC: {}, OCR: {}, ...(withPCR ? { PCR: {} } : {}) }, familyOf = {};
  let n = 0, f = 0;
  while (n < tasks) {
    const fam = pool.families[rng.int(pool.families.length)];
    for (const q0 of fam) {
      if (n >= tasks) break;
      const q = map(q0, rng), id = `t${n}`;
      familyOf[id] = `f${f}`;
      for (const arm of Object.keys(T)) T[arm][id] = Array.from({ length: repeats }, () => (rng.next() < q[arm] ? 1 : 0));
      n++;
    }
    f++;
  }
  return { tables: T, familyOf };
}

/** Monte Carlo operating characteristics of the exact preregistered rule for one design and scenario. */
export function operating(pool, scenario, { tasks, repeats = 3, sims = 2000, withPCR = false, seed = "ctrl-confirm-3/power" }) {
  const map = scenarioOf(scenario, pool);
  const rng = createRng(`${seed}:${scenario}:${tasks}:${repeats}:${withPCR}`);
  let h1 = 0, e1 = 0, e2 = 0, harm = 0, h2 = 0;
  for (let s = 0; s < sims; s++) {
    const { tables, familyOf } = simulate(pool, map, { tasks, repeats, rng, withPCR });
    const h = hierarchy(tables, familyOf, { ci: false });
    if (h.H1.decision.verdict === "CONFIRMED") h1++;
    if (h.H1.decision.verdict === "NOT_CONFIRMED_HARM_INDICATED") harm++;
    if (h.H1.contrast.E1.pOneSided < 0.025) e1++;
    if (h.H1.contrast.E2.pOneSided < 0.025) e2++;
    if (h.H2?.decision.verdict === "CONFIRMED") h2++;
  }
  const pr = (k) => ({ p: k / sims, mcse: Math.sqrt((k / sims) * (1 - k / sims) / sims) });
  return { scenario, tasks, repeats, sims, population: populationEffect(pool, map, repeats), H1confirmed: pr(h1), E1pass: pr(e1), E2pass: pr(e2), harmIndicated: pr(harm), ...(withPCR ? { H2confirmed: pr(h2) } : {}) };
}

/** Requests and active hours from ctrl-confirm-2 realized per-unit rates (all attempts) at a given concurrency. */
export const RATES = { OC: { requests: 8578 / 279, minutes: (16.6 * 60) / 279 }, OCR: { requests: 8219 / 279, minutes: (16.2 * 60) / 279 }, PC: { requests: 2738 / 279, minutes: (5.0 * 60) / 279 }, PCR: { requests: 2697 / 279, minutes: (5.0 * 60) / 279 } };
export function cost(arms, tasks, repeats = 3, concurrency = 8) {
  const units = arms.length * tasks * repeats;
  const requests = arms.reduce((s, a) => s + RATES[a].requests * tasks * repeats, 0);
  const activeHours = arms.reduce((s, a) => s + RATES[a].minutes * tasks * repeats, 0) / 60 / concurrency;
  return { units, requests: Math.round(requests), activeHours: Math.round(activeHours * 10) / 10 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { sims: { type: "string", default: "2000" }, out: { type: "string" }, tasks: { type: "string", default: "93,150,200,300,400,600" }, scenarios: { type: "string" }, "no-shrink": { type: "boolean", default: false } } });
  const h = historical();
  const pool = calibrate(h, undefined, { shrink: !values["no-shrink"] });
  const sims = Number(values.sims);
  const sizes = values.tasks.split(",").map(Number);
  const scenarios = values.scenarios ? values.scenarios.split(",") : ["scale:1", "scale:0.5", "scale:0", "null:E2-only-null", "null:E1-only-null", "null:skewed-heterogeneous-E1"];
  const rows = [];
  for (const sc of scenarios) for (const tasks of sizes) { const row = operating(pool, sc, { tasks, sims, withPCR: true }); rows.push(row); process.stderr.write(`${sc} N=${tasks}: H1 ${row.H1confirmed.p.toFixed(3)} E1 ${row.E1pass.p.toFixed(3)} E2 ${row.E2pass.p.toFixed(3)} H2 ${row.H2confirmed.p.toFixed(3)}\n`); }
  const out = { shrink: !values["no-shrink"], calibration: { source: "records/ctrl-confirm-2/confirmation/analysis.json perTask (legacy-valid) + sealed ctrl-confirm-2 holdout families (exposed, historical; planning only)", tasks: h.tasks.length, families: pool.families.length, arms: pool.info }, method: "see file header", rows, costs: Object.fromEntries(sizes.map(n => [n, { "OC+OCR": cost(["OC", "OCR"], n), "OC+OCR+PCR": cost(["OC", "OCR", "PCR"], n) }])) };
  const text = `${JSON.stringify(out, null, 1)}\n`;
  if (values.out) writeFileSync(values.out, text); else process.stdout.write(text);
}
