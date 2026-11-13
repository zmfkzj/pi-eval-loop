#!/usr/bin/env node
// ctrl-confirm-4 sample-size planning, sensitivity and type-I checks (model-free; historical ctrl-confirm-2 outcomes only, which are
// exposed and used for PLANNING ONLY). Every simulated experiment is decided by ctrl-confirm-3 stats.mjs `hierarchy` - the analysis
// function of ctrl-confirm-4 (unchanged decision rule: exact family sign-flip, one-sided p < 0.025 on E1 AND E2).
//
// Generative models (planning assumptions; none is a claim about the truth):
//   latent:d            ctrl-confirm-3 primary model: per simulated task p ~ posterior of a historical task's pooled difficulty (12
//                       repeats); OC = PCR = p; OCR = expit(logit p + beta), beta calibrated to population E1 effect d.
//   latent-sparse:d:f   sparse informative FAMILIES: only a random fraction f of simulated families responds (OCR = expit(logit p +
//                       beta_f)); the others have no effect. beta_f is calibrated so the population E1 effect is still d.
//   latent-od:d:rho     repeat dependence: per task x arm the success probability is drawn Beta(mean, (1 - rho) / rho) around the
//                       latent model's value, so the 3 repeats of a task x arm are correlated (intra-class correlation rho).
//   scale:s, null:*     ctrl-confirm-3 sensitivity / null models (effect located on the historically discordant tasks; s = 1 is
//                       centred on the historical estimate with its family-bootstrap uncertainty).
// Composition: "historical" draws whole historical families (ctrl-confirm-2 family sizes); a realized-sizes composition draws family
// sizes from the sealed supply and fills each family from ONE size-biased historical family (tasks uniform with replacement), so
// every slot's task is uniform over the historical tasks (population effects as calibrated) and within-family dependence is kept.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/power.mjs --sims 4000 --out FILE [--tasks ...] [--scenarios ...] [--composition ...]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createRng } from "../../src/rng.mjs";
import { digestOf } from "../../src/util.mjs";
import { betaDraw, calibrate, cost, historical, scenarioOf as scenarioOf3 } from "../ctrl-confirm-3/power.mjs";
import { hierarchy } from "../ctrl-confirm-3/stats.mjs";

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const logit = (p) => Math.log(p / (1 - p)), expit = (z) => 1 / (1 + Math.exp(-z));
const clamp = (p) => Math.min(1 - 1e-9, Math.max(1e-9, p));

/** Calibrate a logit shift so that frac * mean(expit(logit p + b) - p) over the latent draws equals the target E1 effect. */
export function calibrateShift(draws, target, frac = 1) {
  if (target === 0) return 0;
  const e1 = (b) => frac * mean(draws.map(p => expit(logit(p) + b) - p));
  let lo = -8, hi = 8;
  if (e1(hi) < target) throw new Error(`effect ${target} unreachable with responsive fraction ${frac}`);
  for (let i = 0; i < 90; i++) { const c = (lo + hi) / 2; if (e1(c) > target) hi = c; else lo = c; }
  return (lo + hi) / 2;
}

/**
 * Scenario -> { taskMap(q, rng, familyState) -> { OC, OCR, PCR }, familyState(rng), od, population }. Family state carries the
 * family-level responsiveness of latent-sparse; od is the repeat intra-class correlation (0 = independent repeats).
 */
export function scenarioOf(name, pool) {
  const draws = pool.families.flat().flatMap(q => q.latentDraws.map(clamp));
  const latentP = (q, rng) => clamp(betaDraw(rng, ...q.latent));
  const parts = name.split(":");
  if (parts[0] === "latent" || parts[0] === "latent-od") {
    const d = Number(parts[1]), rho = parts[0] === "latent-od" ? Number(parts[2]) : 0;
    const beta = calibrateShift(draws, d);
    return { taskMap: (q, rng) => { const p = latentP(q, rng); return { OC: p, OCR: expit(logit(p) + beta), PCR: p }; }, familyState: () => null, od: rho, population: { E1: mean(draws.map(p => expit(logit(p) + beta) - p)), E2: mean(draws.map(p => expit(logit(p) + beta) ** 3 - p ** 3)), beta, rho } };
  }
  if (parts[0] === "latent-sparse") {
    const d = Number(parts[1]), f = Number(parts[2]);
    const beta = calibrateShift(draws, d, f);
    return { taskMap: (q, rng, responsive) => { const p = latentP(q, rng); return { OC: p, OCR: responsive ? expit(logit(p) + beta) : p, PCR: p }; }, familyState: (rng) => rng.next() < f, od: 0, population: { E1: f * mean(draws.map(p => expit(logit(p) + beta) - p)), E2: f * mean(draws.map(p => expit(logit(p) + beta) ** 3 - p ** 3)), beta, responsiveFamilies: f } };
  }
  const m = scenarioOf3(name, pool);
  return { taskMap: (q, rng) => m(q, rng), familyState: () => null, od: 0, population: null };
}

/** Success probability of one task x arm with repeat dependence: Beta(mean p, precision (1 - rho) / rho) (rho = 0: p itself). */
export function armProbability(p, rho, rng) {
  if (!rho) return p;
  const k = (1 - rho) / rho;
  return betaDraw(rng, Math.max(1e-6, p * k), Math.max(1e-6, (1 - p) * k));
}

/**
 * One simulated experiment -> { tables, familyOf }. composition: "historical" or { sizes: number[] }.
 * @param {any} pool @param {any} sc @param {{ tasks: number, repeats?: number, rng: any, withPCR?: boolean, composition?: any }} o
 */
export function simulate(pool, sc, { tasks, repeats = 3, rng, withPCR = false, composition = "historical" }) {
  const T = { OC: {}, OCR: {}, ...(withPCR ? { PCR: {} } : {}) }, familyOf = {};
  let n = 0, f = 0;
  const cum = composition === "historical" ? null : pool.families.reduce((a, f) => [...a, (a.at(-1) ?? 0) + f.length], []);
  while (n < tasks) {
    // historical: a uniformly drawn historical family with all its tasks (every historical task has the same expected weight).
    // realized sizes: a SIZE-BIASED historical family and its tasks drawn uniformly with replacement, so each slot's task is
    // uniform over the historical tasks (the scenario's calibrated population effect is preserved) while the tasks of one simulated
    // family share a historical family (within-family dependence kept).
    const pick = composition === "historical" ? 0 : rng.int(cum.at(-1));
    const fam = composition === "historical" ? pool.families[rng.int(pool.families.length)] : pool.families[cum.findIndex(c => c > pick)];
    const size = composition === "historical" ? fam.length : composition.sizes[rng.int(composition.sizes.length)];
    const state = sc.familyState(rng);
    for (let j = 0; j < size && n < tasks; j++) {
      const q = sc.taskMap(composition === "historical" ? fam[j] : fam[rng.int(fam.length)], rng, state), id = `t${n}`;
      familyOf[id] = `f${f}`;
      for (const arm of Object.keys(T)) { const pa = armProbability(q[arm], sc.od, rng); T[arm][id] = Array.from({ length: repeats }, () => (rng.next() < pa ? 1 : 0)); }
      n++;
    }
    f++;
  }
  return { tables: T, familyOf };
}

/** Wilson 95% interval of a Monte Carlo proportion. */
export function wilson(k, n, z = 1.96) {
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

/** @param {any} pool @param {string} scenario @param {{ tasks: number, repeats?: number, sims?: number, withPCR?: boolean, composition?: any, seed?: string }} o */
export function operating(pool, scenario, { tasks, repeats = 3, sims = 2000, withPCR = false, composition = "historical", seed = "ctrl-confirm-4/power" }) {
  const sc = scenarioOf(scenario, pool);
  const rng = createRng(`${seed}:${scenario}:${tasks}:${repeats}:${withPCR}:${digestOf(composition)}`);
  let h1 = 0, e1 = 0, e2 = 0, harm = 0, h2 = 0;
  for (let s = 0; s < sims; s++) {
    const { tables, familyOf } = simulate(pool, sc, { tasks, repeats, rng, withPCR, composition });
    const h = hierarchy(tables, familyOf, { ci: false });
    if (h.H1.decision.verdict === "CONFIRMED") h1++;
    if (h.H1.decision.verdict === "NOT_CONFIRMED_HARM_INDICATED") harm++;
    if (h.H1.contrast.E1.pOneSided < 0.025) e1++;
    if (h.H1.contrast.E2.pOneSided < 0.025) e2++;
    if (h.H2?.decision.verdict === "CONFIRMED") h2++;
  }
  const pr = (k) => ({ p: k / sims, mcse: Math.sqrt((k / sims) * (1 - k / sims) / sims), wilson95: wilson(k, sims) });
  return { scenario, tasks, repeats, sims, composition: composition === "historical" ? "historical" : "realized-sizes", population: sc.population, H1confirmed: pr(h1), E1pass: pr(e1), E2pass: pr(e2), harmIndicated: pr(harm), ...(withPCR ? { H2confirmed: pr(h2) } : {}) };
}

/** Smallest N of the grid whose H1 power has a Wilson 95% LOWER bound >= target (Monte Carlo error counted against the design). */
/** @param {any[]} rows @param {string} scenario @param {{ target?: number, composition?: string }} [o] */
export function requiredN(rows, scenario, { target = 0.8, composition = undefined } = {}) {
  const r = rows.filter(x => x.scenario === scenario && (!composition || x.composition === composition)).sort((a, b) => a.tasks - b.tasks);
  return r.find(x => x.H1confirmed.wilson95[0] >= target)?.tasks ?? null;
}

export const DEFAULT_GRID = [300, 400, 500, 600, 650, 700, 750, 800, 850, 900, 1000, 1200, 1600];
export const DEFAULT_SCENARIOS = ["latent:0.039", "latent:0.03", "latent:0.02", "latent-sparse:0.039:0.5", "latent-sparse:0.039:0.25", "latent-od:0.039:0.2", "scale:1", "scale:0.5", "latent:0", "latent-od:0:0.2", "null:E2-only-null", "null:E1-only-null", "null:skewed-heterogeneous-E1"];

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { sims: { type: "string", default: "4000" }, out: { type: "string" }, tasks: { type: "string" }, scenarios: { type: "string" }, composition: { type: "string", default: "historical" } } });
  const h = historical();
  const pool = calibrate(h);
  const sims = Number(values.sims);
  const sizes = values.tasks ? values.tasks.split(",").map(Number) : DEFAULT_GRID;
  const scenarios = values.scenarios ? values.scenarios.split(",") : DEFAULT_SCENARIOS;
  /** @type {any} */
  const composition = values.composition === "historical" ? "historical" : { sizes: JSON.parse(values.composition) };
  const rows = [];
  for (const sc of scenarios) for (const tasks of sizes) {
    const row = operating(pool, sc, { tasks, sims, withPCR: true, composition });
    rows.push(row);
    process.stderr.write(`${sc} N=${tasks}: H1 ${row.H1confirmed.p.toFixed(3)} [${row.H1confirmed.wilson95.map(x => x.toFixed(3)).join(",")}] E1 ${row.E1pass.p.toFixed(3)} E2 ${row.E2pass.p.toFixed(3)}\n`);
  }
  const config = { sims, sizes, scenarios, composition, seed: "ctrl-confirm-4/power", calibration: "records/ctrl-confirm-2/confirmation/analysis.json perTask + ctrl-confirm-2 holdout families" };
  const out = { schema: "ctrl-confirm-4/power@1", config, configDigest: digestOf(config), calibration: { tasks: h.tasks.length, families: pool.families.length, arms: pool.info }, rows, costs: Object.fromEntries(sizes.map(n => [n, cost(["OC", "OCR", "PCR"], n)])) };
  const text = `${JSON.stringify(out, null, 1)}\n`;
  if (values.out) writeFileSync(values.out, text); else process.stdout.write(text);
}
