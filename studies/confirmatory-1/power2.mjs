#!/usr/bin/env node
// Design reassessment (confirmatory-1 v2, 2026-11-07; offline, model-free). Operating characteristics of the UNCHANGED protocol-4
// decision, holdout AND independent confirmation, on generative models fitted to real ledgers (evidence-v2.json from
// evidence.mjs): ctrl-ablation-1 (pilot, exposed suite tasks), ctrl-confirm-2 (external public tasks, stable orche OC and three
// other arms) and the confirmatory-1 calibration (private tasks, stable orche).
//
// Parity with the loop (src/loop.mjs holdout pass and --confirm-adoption):
//   holdout       adoptionDecision(adoptionCompare, { critical, incomplete: [], infraRate, familyCmp, confirmatory }) with
//                 confirmatoryChecks(pairs, plan incl. lowExposure) - the same functions and the same evidence fields; pairs
//                 carry the provenance of their task (private / external mixture, as the account cap forces);
//   confirmation  critical -> NOT_CONFIRMED, else confirmatoryChecks at confirmation.alpha (CONFIRMED / INCONCLUSIVE /
//                 NOT_CONFIRMED); the loop's confirmation has no infra-rate rule, the simulation has none either.
// infraRate counts infra_error/model_unavailable units (failures for both arms, as in the loop's pairs); incomplete units are
// assumed absent (any missing unit BLOCKS the holdout: an operational, not a statistical, risk).
// Integrity: the candidate's per-run violation probability v is a scenario input; additionally a closed form integrates v over
// the posterior after 0 violations in n pre-holdout candidate runs under a UNIFORM prior (posterior Beta(1, n+1)):
// E[(1-v)^K] = (n+1)/(n+1+K), K = candidate runs in holdout + confirmation. It depends on that prior; it is not prior-free.
//
//   node studies/confirmatory-1/power2.mjs --evidence evidence-v2.json [--reps 200] [--grid main|integrity|focus] [--out FILE]
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRng } from "../../src/rng.mjs";
import { adoptionCompare, adoptionDecision, familyAdoptionCompare } from "../../src/gate.mjs";
import { confirmatoryChecks } from "../../src/design.mjs";
import { DEFAULT_PROTOCOL, merge } from "../../src/protocol.mjs";

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logit = (p) => Math.log(p / (1 - p));
const expit = (x) => 1 / (1 + Math.exp(-x));
/** Beta-binomial prior strength (a+b) by method of moments, bounded to [2, 200] (identical to power.mjs priorStrength). */
export function priorStrength(ks, r) {
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ps = ks.map(k => k / r), m = mean(ps), v = ps.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, ps.length - 1);
  const between = Math.max(1e-6, v - m * (1 - m) / r);
  return clamp(m * (1 - m) / between - 1, 2, 200);
}
function gauss(rng) { const u = 1 - rng.next(), v = rng.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/**
 * Baseline pools from evidence: per source arm, families with their tasks' shrunk stable success rates (beta-binomial,
 * method-of-moments strength bounded to [2, 200], as power.mjs). Censored/infrastructure repeats are left out of a task's rate.
 */
export function baselinePool(evidence, source, arm) {
  const a = evidence.sources[source]?.arms?.[arm];
  if (!a) throw new Error(`evidence has no ${source}:${arm}`);
  const rows = Object.entries(a.tasks).map(([id, t]) => { const ys = t.outcomes.filter((y, i) => y !== undefined && y !== null && !["infrastructure", "harness-fault", "censored"].includes(t.classes[i])); return { id, family: t.family, hard: t.hard, k: ys.reduce((s, y) => s + y, 0), n: ys.length }; }).filter(r => r.n > 0);
  const r = Math.max(...rows.map(x => x.n));
  const strength = priorStrength(rows.map(x => Math.round(x.k * r / x.n)), r);
  const m = rows.reduce((s, x) => s + x.k, 0) / rows.reduce((s, x) => s + x.n, 0);
  const fam = {};
  for (const x of rows) (fam[x.family] ??= []).push({ ...x, p: (x.k + strength * m) / (x.n + strength) });
  const infra = (a.classes.infrastructure ?? 0) / Math.max(1, a.units);
  return { source, arm, strength, mean: m, tasks: rows.length, families: Object.values(fam), infra, integrityRate: a.integrityRuns / Math.max(1, a.units) };
}

/** Candidate rates from a real contrast (template): per task the shrunk difference of arm B vs arm A, scaled to the target. */
export function contrastPool(evidence, source, armA, armB) {
  const A = baselinePool(evidence, source, armA), B = baselinePool(evidence, source, armB);
  const pb = new Map(B.families.flat().map(t => [t.id, t.p]));
  return { ...A, families: A.families.map(f => f.filter(t => pb.has(t.id)).map(t => ({ ...t, d: pb.get(t.id) - t.p }))).filter(f => f.length), contrast: `${armB}-${armA}`, rawDelta: B.mean - A.mean };
}

/** True probabilities of one simulated batch: F families of `perFamily`, a `privateShare` of the families from the private pool. */
export function drawBatch(rng, pools, sc, plan) {
  const out = [];
  const F = Math.ceil(plan.tasks / plan.perFamily);
  const Fp = Math.round(F * plan.privateShare);
  const Fh = Math.ceil(plan.minHardTasks / plan.perFamily);
  // Hard stratum = calibrated-hard private families (mean stable rate <= 0.5 in the pool), drawn first; the rest as sampled.
  const hardPool = pools.private.families.filter(f => f.reduce((s, t) => s + t.p, 0) / f.length <= 0.5);
  for (let f = 0; f < F; f++) {
    const priv = f < Fp, pool = priv ? pools.private : pools.external;
    const hardFam = priv && f < Fh && hardPool.length > 0;
    const fams = hardFam ? hardPool : pool.families;
    const src = fams[rng.int(fams.length)];
    const u = sc.sigmaFamily * gauss(rng);
    const size = Math.min(plan.perFamily, plan.tasks - f * plan.perFamily);
    for (let k = 0; k < size; k++) {
      const t = src[rng.int(src.length)];
      const pA = clamp(t.p, 0.02, 0.98);
      const d = sc.model === "template" ? (t.d ?? pools.templateDs[rng.int(pools.templateDs.length)]) : undefined;
      const pB = sc.model === "template" ? clamp(pA + sc.scale * d, 0, 1) : expit(logit(pA) + sc.beta + u + sc.sigmaTask * gauss(rng));
      out.push({ task: `sim-f${f}-t${k}`, family: `sim-f${f}`, hard: hardFam, provenance: priv ? "private-reviewed" : "external", pA, pB });
    }
  }
  return out;
}

/** One pass: stable a, candidate b; infra q fails a unit of either arm (failure, counted in infraRate); candidate violates w.p. v. */
export function observe(rng, design, repeats, { v, q }) {
  let critical = 0, infra = 0, units = 0;
  const pairs = design.map(t => {
    const a = [], b = [];
    for (let i = 0; i < repeats; i++) {
      const ia = rng.next() < q, ib = rng.next() < q;
      infra += (ia ? 1 : 0) + (ib ? 1 : 0); units += 2;
      a.push(!ia && rng.next() < t.pA ? 1 : 0);
      const viol = !ib && rng.next() < v; if (viol) critical++;
      b.push(!ib && !viol && rng.next() < t.pB ? 1 : 0);
    }
    return { task: t.task, family: t.family, hard: t.hard, provenance: t.provenance, a, b };
  });
  return { pairs, critical, infraRate: infra / units };
}

export function simProtocol2(plan) {
  return merge(structuredClone(DEFAULT_PROTOCOL), { bootstrap: { draws: plan.draws }, holdout: { priorFamilyReuse: "forbid", acceptedProvenance: ["external", "private-reviewed"], repeats: plan.repeats }, adoption: { requireFamilyLevel: true }, analysisPlan: { mode: "confirmatory", alpha: plan.alpha, minEffect: plan.minEffect, minTasks: plan.tasks, minFamilies: Math.ceil(plan.tasks / plan.perFamily), minHardTasks: plan.minHardTasks, permutationDraws: plan.permutationDraws, lowExposure: { required: true, minTasks: plan.lowExposureMin, provenance: ["private-reviewed"] } } });
}

export function holdoutVerdict2(obs, protocol, plan, seed) {
  const critical = obs.critical ? [`integrity: ${obs.critical} candidate run(s) with violations`] : [];
  const cmp = adoptionCompare(obs.pairs, protocol, seed);
  const familyCmp = familyAdoptionCompare(obs.pairs, protocol, seed);
  const ap = protocol.analysisPlan;
  const confirmatory = confirmatoryChecks(obs.pairs, { alpha: ap.alpha, minEffect: ap.minEffect, minTasks: ap.minTasks, minFamilies: ap.minFamilies, minHardTasks: ap.minHardTasks, lowExposure: ap.lowExposure, draws: plan.draws, permutationDraws: plan.permutationDraws, seed });
  const d = adoptionDecision(cmp, protocol, { holdoutIndependent: true, critical, checksPassed: true, routeOk: true, incomplete: [], infraRate: obs.infraRate, familyCmp, confirmatory });
  const why = d.verdict === "ADOPT" ? "adopt" : critical.length ? "critical" : obs.infraRate > protocol.watchdog.maxInfraRate ? "infra" : d.reasons.some(r => /^family regression/.test(r)) ? "family-regression" : cmp.support < protocol.adoption.support ? "task-support" : familyCmp.support < protocol.adoption.support ? "family-support" : confirmatory.inconclusive.length ? `inconclusive:${confirmatory.inconclusive[0].split(/[:(]/)[0].trim()}` : confirmatory.failed.length ? `failed:${confirmatory.failed[0].split(/[:(]/)[0].trim()}` : d.verdict;
  return { verdict: d.verdict, why };
}

export function confirmationVerdict2(obs, protocol, plan, seed) {
  const ap = protocol.analysisPlan;
  const c = confirmatoryChecks(obs.pairs, { alpha: plan.confAlpha, minEffect: ap.minEffect, minTasks: plan.confTasks, minFamilies: Math.ceil(plan.confTasks / plan.perFamily), lowExposure: ap.lowExposure, draws: plan.draws, permutationDraws: plan.permutationDraws, seed });
  if (obs.critical) return { verdict: "NOT_CONFIRMED", why: "critical" };
  return { verdict: c.ok ? "CONFIRMED" : c.inconclusive.length ? "INCONCLUSIVE" : "NOT_CONFIRMED", why: c.ok ? "ok" : (c.inconclusive[0] ?? c.failed[0]).split(/[:(]/)[0].trim() };
}

/** Solve beta (logit) or scale (template) so that the expected true mean effect equals sc.effect. */
export function calibrate(pools, sc, plan) {
  const expected = (param) => { const rng = createRng(`cal2:${JSON.stringify(sc)}:${plan.privateShare}`); let s = 0, n = 0; for (let i = 0; i < 300; i++) for (const t of drawBatch(rng, pools, { ...sc, beta: param, scale: param }, plan)) { s += t.pB - t.pA; n++; } return s / n; };
  if (sc.effect === 0 && (sc.model === "template" || (!sc.sigmaFamily && !sc.sigmaTask))) return { ...sc, beta: 0, scale: 0, achieved: 0 };
  let lo = sc.model === "template" ? 0 : -4, hi = sc.model === "template" ? 8 : 4;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (expected(mid) < sc.effect) lo = mid; else hi = mid; }
  const p = (lo + hi) / 2;
  return { ...sc, beta: p, scale: p, achieved: expected(p) };
}

export function run(pools, sc, plan, reps) {
  const protocol = simProtocol2(plan);
  const rng = createRng(`power2:${JSON.stringify(sc)}:${JSON.stringify(plan)}`);
  const n = { adopt: 0, confirmed: 0, both: 0 }, why = {}, cwhy = {};
  for (let i = 0; i < reps; i++) {
    const h = holdoutVerdict2(observe(rng, drawBatch(rng, pools, sc, plan), plan.repeats, sc), protocol, plan, `s2-h-${i}`);
    const c = confirmationVerdict2(observe(rng, drawBatch(rng, pools, sc, { ...plan, tasks: plan.confTasks }), plan.repeats, sc), protocol, plan, `s2-c-${i}`);
    why[h.why] = (why[h.why] ?? 0) + 1; cwhy[c.why] = (cwhy[c.why] ?? 0) + 1;
    if (h.verdict === "ADOPT") n.adopt++;
    if (c.verdict === "CONFIRMED") n.confirmed++;
    if (h.verdict === "ADOPT" && c.verdict === "CONFIRMED") n.both++;
  }
  const rate = (k) => ({ p: k / reps, mcse: Math.sqrt((k / reps) * (1 - k / reps) / reps) });
  return { scenario: sc, plan, reps, adopt: rate(n.adopt), confirmed: rate(n.confirmed), adoptAndConfirmed: rate(n.both), holdoutReasons: why, confirmationReasons: cwhy };
}

/** E[(1-v)^K] after 0 violations in n candidate runs (uniform prior on v): the integrity survival factor. */
export const integritySurvival = (n, K) => (n + 1) / (n + 1 + K);

export const BASE = { repeats: 3, perFamily: 3, alpha: 0.0125, confAlpha: 0.0125, minEffect: 0.05, draws: 2000, permutationDraws: 2000, privateShare: 0.5 };
export function planOf(N, extra = {}) {
  const p = { ...BASE, tasks: N, confTasks: N, ...extra };
  p.minHardTasks = Math.max(p.perFamily, Math.round(N / 3 / p.perFamily) * p.perFamily);
  p.lowExposureMin = Math.round(N * p.privateShare);
  return p;
}

export function grid(kind, q) {
  const plans = [], scenarios = [];
  if (kind === "main") {
    for (const N of [96, 144, 192, 288]) for (const repeats of [3, 5]) plans.push(planOf(N, { repeats }));
    for (const effect of [0, 0.10, 0.15, 0.20]) {
      scenarios.push({ model: "logit", sigmaFamily: 0.5, sigmaTask: 0.75, effect, v: 0, q });
      if (effect > 0) scenarios.push({ model: "template", effect, v: 0, q });
    }
    scenarios.push({ model: "logit", sigmaFamily: 0, sigmaTask: 0, effect: 0, v: 0, q, note: "sharp null" });
    scenarios.push({ model: "logit", sigmaFamily: 1.0, sigmaTask: 1.0, effect: 0.15, v: 0, q, note: "larger heterogeneity" });
  } else if (kind === "integrity") {
    for (const N of [96, 144, 288]) plans.push(planOf(N, { repeats: 5 }));
    for (const v of [0.001, 0.003, 0.01, 0.025]) scenarios.push({ model: "logit", sigmaFamily: 0.5, sigmaTask: 0.75, effect: 0.15, v, q });
    scenarios.push({ model: "logit", sigmaFamily: 0.5, sigmaTask: 0.75, effect: 0.15, v: 0, q: 0.08, note: "infrastructure 8%" });
  } else {
    for (const N of [144, 288]) for (const perFamily of [2, 3]) plans.push(planOf(N, { repeats: 5, perFamily }));
    for (const effect of [0.10, 0.15]) scenarios.push({ model: "logit", sigmaFamily: 0.5, sigmaTask: 0.75, effect, v: 0, q });
  }
  return { plans, scenarios };
}

if (isMainThread && import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { evidence: { type: "string" }, reps: { type: "string", default: "200" }, grid: { type: "string", default: "main" }, out: { type: "string" }, workers: { type: "string", default: "4" }, private: { type: "string", default: "pilot:S" }, external: { type: "string", default: "c2:OC" }, template: { type: "string", default: "c2:OC:OCR" } } });
  const evidence = JSON.parse(readFileSync(values.evidence, "utf8"));
  const [ps, pa] = values.private.split(":"), [es, ea] = values.external.split(":"), [ts, ta, tb] = values.template.split(":");
  const pools = { private: baselinePool(evidence, ps, pa), external: baselinePool(evidence, es, ea) };
  const template = contrastPool(evidence, ts, ta, tb);
  const q = Math.max(pools.private.infra, pools.external.infra);
  const { plans, scenarios } = grid(values.grid, q);
  const jobs = []; for (const plan of plans) for (const sc of scenarios) jobs.push({ plan, sc });
  const results = new Array(jobs.length); let next = 0; const reps = Number(values.reps); const started = Date.now();
  await new Promise((done, fail) => {
    let active = 0;
    const launch = () => {
      if (next >= jobs.length) { if (!active) done(); return; }
      const i = next++; active++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { pools, template, job: jobs[i], reps } });
      w.once("message", (m) => { results[i] = m; }); w.once("error", fail);
      w.once("exit", () => { active--; process.stderr.write(`[power2] ${results.filter(Boolean).length}/${jobs.length} ${((Date.now() - started) / 1000).toFixed(0)}s\n`); launch(); });
    };
    for (let k = 0; k < Math.max(1, Math.min(Number(values.workers), availableParallelism() - 1)); k++) launch();
  });
  const summary = (p) => ({ source: `${p.source}:${p.arm}`, tasks: p.tasks, families: p.families.length, mean: p.mean, strength: p.strength, infra: p.infra, integrityRate: p.integrityRate });
  const out = { schema: "pi-eval-loop/confirmatory-1-power2@1", generatedAt: new Date().toISOString(), evidence: { path: values.evidence }, pools: { private: summary(pools.private), external: summary(pools.external), template: { ...summary(template), contrast: template.contrast, rawDelta: template.rawDelta } }, infraRateUsed: q, reps, notes: "draws/permutationDraws 2000 in simulation (protocol 10000/20000); mcse = binomial Monte Carlo SE", results };
  const text = `${JSON.stringify(out, null, 1)}\n`;
  if (values.out) writeFileSync(values.out, text); else process.stdout.write(text);
} else if (!isMainThread) {
  const { pools, template, job, reps } = workerData;
  const p = job.sc.model === "template" ? { private: pools.private, external: template, templateDs: template.families.flat().map(t => t.d) } : pools;
  // Template: external families carry real per-task contrasts (d); private tasks get the template's mean shift via the scale.
  const sc = calibrate(p, job.sc, job.plan);
  parentPort.postMessage(run(p, sc, job.plan, reps));
}
