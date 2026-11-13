#!/usr/bin/env node
// Offline power / operating-characteristic simulation of the protocol-4 CONFIRMATORY decision (confirmatory-1 plan).
//
// What is simulated: the conjunction actually coded in this evaluator, unchanged:
//   holdout:      critical rule (any task-agent integrity violation / leak / route violation / crash in ANY candidate run -> BLOCKED)
//                 AND protocol-3 adoption gate (task-level Bayesian bootstrap support >= adoption.support, hard/consistency
//                 allowances, family-regression rule, hard stratum present) AND family-clustered adoption support
//                 AND confirmatoryChecks (randomization test at alpha, family-clustered P(delta>0) >= 1-alpha, plug-in delta >=
//                 minEffect, leave-one-family-out, low-exposure stratum direction, coverage / discordance resolution);
//   confirmation: an independent second batch, confirmatoryChecks at confirmation.alpha AND no critical candidate run.
// Functions called: src/gate.mjs adoptionCompare / familyAdoptionCompare / adoptionDecision, src/design.mjs confirmatoryChecks.
//
// Generative models (parameters from studies/confirmatory-1/pilot.json = real ctrl-ablation-1 records, legacy-valid estimand):
//   template:<ARM>  per-task stable/candidate success probabilities are the beta-binomial-shrunk pilot estimates of S and of a
//                   real intervention arm, the candidate-minus-stable difference scaled to the target effect; simulated families
//                   resample pilot families (tasks of one family are drawn from the same pilot family: within-family correlation).
//   logit           stable probability from the shrunk pilot S estimates; logit(pB) = logit(pA) + beta + u_family + e_task,
//                   u ~ N(0, sigmaFamily), e ~ N(0, sigmaTask); beta solved for the target mean effect.
// Repeats are Bernoulli given the task probability (within-task correlation comes from the shared task probability).
// The candidate's per-run integrity violation probability v is an explicit scenario input (pilot: 0/81 for P1, P3 up to 17/81).
//
// Simulation shortcuts (documented in RATIONALE.md): bootstrap/permutation draws are 2000 (the protocol uses 10000/20000);
// Monte Carlo SE of a power estimate p from R replicates is sqrt(p(1-p)/R) and is reported per row.
//
//   node studies/confirmatory-1/power.mjs [--reps 200] [--out power.json] [--grid main|focus]
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRng } from "../../src/rng.mjs";
import { adoptionCompare, adoptionDecision, familyAdoptionCompare } from "../../src/gate.mjs";
import { confirmatoryChecks } from "../../src/design.mjs";
import { DEFAULT_PROTOCOL, merge } from "../../src/protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const variance = (xs) => { const m = mean(xs); return xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1); };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logit = (p) => Math.log(p / (1 - p));
const expit = (x) => 1 / (1 + Math.exp(-x));

/** Beta-binomial prior strength (a+b) by method of moments, bounded to [2, 200] (as experiments/ctrl-ablation-plan/power.mjs). */
export function priorStrength(ks, r) {
  const ps = ks.map(k => k / r), m = mean(ps), v = variance(ps);
  const between = Math.max(1e-6, v - m * (1 - m) / r);
  return clamp(m * (1 - m) / between - 1, 2, 200);
}

/** Pilot task table: per task the shrunk stable rate pS and, per template arm, the shrunk candidate rate. */
export function pilotTable(pilot, templates) {
  const S = pilot.arms.S.tasks, ids = Object.keys(S).sort(), r = 3;
  const shrink = (arm) => {
    const ks = ids.map(id => pilot.arms[arm].tasks[id].outcomes.reduce((s, x) => s + x, 0));
    const strength = priorStrength(ks, r), m = mean(ks) / r;
    return { strength, rates: Object.fromEntries(ids.map((id, i) => [id, (ks[i] + strength * m) / (r + strength)])) };
  };
  const s = shrink("S");
  const arms = Object.fromEntries(templates.map(a => [a, shrink(a)]));
  const tasks = ids.map(id => ({ id, family: S[id].family, hard: S[id].tier === "hard", pS: s.rates[id], pX: Object.fromEntries(templates.map(a => [a, arms[a].rates[id]])) }));
  return { tasks, strength: { S: s.strength, ...Object.fromEntries(templates.map(a => [a, arms[a].strength])) } };
}

/** Pilot families split by majority tier (hard / not hard). */
function familyPools(tasks) {
  const fam = {};
  for (const t of tasks) (fam[t.family] ??= []).push(t);
  const all = Object.values(fam);
  return { hard: all.filter(ts => ts.filter(t => t.hard).length * 2 > ts.length), easy: all.filter(ts => ts.filter(t => t.hard).length * 2 <= ts.length) };
}

/**
 * True per-task probabilities of one simulated holdout: F families of m tasks, Fh of them hard.
 * Returns [{ task, family, hard, pA, pB }].
 */
export function drawDesign(rng, table, sc, { tasks: N, perFamily: m, hardFamilies: Fh }) {
  const pools = familyPools(table.tasks);
  const F = Math.ceil(N / m), out = [];
  for (let f = 0; f < F; f++) {
    const hard = f < Fh, size = Math.min(m, N - f * m);
    const family = `sim-f${f}`;
    if (sc.model === "logit") {
      const pool = table.tasks.filter(t => t.hard === hard);
      const u = sc.sigmaFamily * gauss(rng);
      for (let k = 0; k < size; k++) {
        const t = pool[rng.int(pool.length)];
        const pA = clamp(t.pS, 0.03, 0.97);
        out.push({ task: `${family}-t${k}`, family, hard, pA, pB: expit(logit(pA) + sc.beta + u + sc.sigmaTask * gauss(rng)) });
      }
    } else {
      const src = (hard ? pools.hard : pools.easy)[rng.int((hard ? pools.hard : pools.easy).length)];
      for (let k = 0; k < size; k++) {
        const t = src[rng.int(src.length)];
        out.push({ task: `${family}-t${k}`, family, hard, pA: t.pS, pB: clamp(t.pS + sc.scale * (t.pX[sc.template] - t.pS), 0, 1) });
      }
    }
  }
  return out;
}

function gauss(rng) { const u = 1 - rng.next(), v = rng.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/** Observed outcomes of one pass (stable a, candidate b; r repeats); candidate runs violate integrity with probability v. */
export function observe(rng, design, repeats, v) {
  let critical = 0;
  const pairs = design.map(t => {
    const a = [], b = [];
    for (let i = 0; i < repeats; i++) {
      a.push(rng.next() < t.pA ? 1 : 0);
      const viol = rng.next() < v;
      if (viol) critical++;
      b.push(!viol && rng.next() < t.pB ? 1 : 0);
    }
    return { task: t.task, family: t.family, hard: t.hard, provenance: "private-reviewed", a, b };
  });
  return { pairs, critical };
}

export function simProtocol(plan) {
  return merge(structuredClone(DEFAULT_PROTOCOL), { bootstrap: { draws: plan.draws }, holdout: { priorFamilyReuse: "forbid", acceptedProvenance: ["private-reviewed"] }, analysisPlan: { mode: "confirmatory", alpha: plan.alpha, minEffect: plan.minEffect, minTasks: plan.tasks, minFamilies: Math.ceil(plan.tasks / plan.perFamily), minHardTasks: plan.minHardTasks, permutationDraws: plan.permutationDraws, lowExposure: { required: true, minTasks: plan.tasks, provenance: ["private-reviewed"] } } });
}

/** One holdout decision (verdict string) exactly as the loop composes it from the evaluator's functions. */
export function holdoutVerdict(obs, protocol, plan, seed) {
  const evidence = { holdoutIndependent: true, critical: obs.critical ? [`integrity: ${obs.critical} candidate run(s) with violations`] : [], checksPassed: true, routeOk: true, incomplete: [], infraRate: 0 };
  if (evidence.critical.length) return { verdict: "BLOCKED", why: "critical" };
  const cmp = adoptionCompare(obs.pairs, protocol, seed);
  const familyCmp = familyAdoptionCompare(obs.pairs, protocol, seed);
  const confirmatory = confirmatoryChecks(obs.pairs, { alpha: plan.alpha, minEffect: plan.minEffect, minTasks: plan.tasks, minFamilies: Math.ceil(plan.tasks / plan.perFamily), minHardTasks: plan.minHardTasks, lowExposure: protocol.analysisPlan.lowExposure, draws: plan.draws, permutationDraws: plan.permutationDraws, seed });
  const d = adoptionDecision(cmp, protocol, { ...evidence, familyCmp, confirmatory });
  const why = d.verdict === "ADOPT" ? "adopt" : cmp.support < protocol.adoption.support ? (cmp.delta.overall.probPositive < protocol.adoption.support ? "task-support:overall" : "task-support:hard-or-consistency-allowance") : familyCmp.support < protocol.adoption.support ? "family-support" : confirmatory.inconclusive.length ? "inconclusive" : confirmatory.failed.length ? `failed:${confirmatory.failed[0].split(/[:(]/)[0].trim()}` : d.verdict;
  return { verdict: d.verdict, why };
}

export function confirmationVerdict(obs, plan, seed) {
  if (obs.critical) return { verdict: "NOT_CONFIRMED", why: "critical" };
  const c = confirmatoryChecks(obs.pairs, { alpha: plan.confAlpha, minEffect: plan.minEffect, minTasks: plan.confTasks, minFamilies: Math.ceil(plan.confTasks / plan.perFamily), lowExposure: { required: true, minTasks: plan.confTasks, provenance: ["private-reviewed"] }, draws: plan.draws, permutationDraws: plan.permutationDraws, seed });
  return { verdict: c.ok ? "CONFIRMED" : c.inconclusive.length ? "INCONCLUSIVE" : "NOT_CONFIRMED", why: c.ok ? "ok" : (c.inconclusive[0] ?? c.failed[0]).split(/[:(]/)[0].trim() };
}

/** Solve the model's free parameter (template scale or logit beta) so the expected true mean effect equals sc.effect. */
export function calibrateScenario(table, sc, plan) {
  const expected = (param) => {
    const rng = createRng(`calibrate:${sc.model}:${sc.template ?? ""}:${sc.sigmaFamily ?? ""}`);
    const s = { ...sc, scale: param, beta: param };
    let sum = 0, n = 0;
    for (let i = 0; i < 400; i++) for (const t of drawDesign(rng, table, s, plan)) { sum += t.pB - t.pA; n++; }
    return sum / n;
  };
  if (sc.effect === 0 && sc.model !== "logit") return { ...sc, scale: 0, achieved: 0 };
  if (sc.effect === 0 && sc.model === "logit" && !sc.sigmaFamily && !sc.sigmaTask) return { ...sc, beta: 0, achieved: 0 };
  let lo = sc.model === "logit" ? -4 : 0, hi = sc.model === "logit" ? 4 : 6;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (expected(mid) < sc.effect) lo = mid; else hi = mid; }
  const param = (lo + hi) / 2;
  return { ...sc, scale: param, beta: param, achieved: expected(param) };
}

export function runScenario(table, sc, plan, reps) {
  const protocol = simProtocol(plan);
  const rng = createRng(`power:${JSON.stringify(sc)}:${JSON.stringify(plan)}`);
  const counts = { adopt: 0, confirmed: 0, both: 0 }, why = {}, cwhy = {};
  for (let i = 0; i < reps; i++) {
    const h = holdoutVerdict(observe(rng, drawDesign(rng, table, sc, plan), plan.repeats, sc.violation), protocol, plan, `sim-h-${i}`);
    const c = confirmationVerdict(observe(rng, drawDesign(rng, table, sc, { ...plan, tasks: plan.confTasks, hardFamilies: plan.confHardFamilies ?? plan.hardFamilies }), plan.repeats, sc.violation), plan, `sim-c-${i}`);
    why[h.why] = (why[h.why] ?? 0) + 1; cwhy[c.why] = (cwhy[c.why] ?? 0) + 1;
    if (h.verdict === "ADOPT") counts.adopt++;
    if (c.verdict === "CONFIRMED") counts.confirmed++;
    if (h.verdict === "ADOPT" && c.verdict === "CONFIRMED") counts.both++;
  }
  const rate = (k) => ({ p: k / reps, mcse: Math.sqrt((k / reps) * (1 - k / reps) / reps) });
  return { scenario: sc, plan, reps, adopt: rate(counts.adopt), confirmed: rate(counts.confirmed), adoptAndConfirmed: rate(counts.both), holdoutReasons: why, confirmationReasons: cwhy };
}

export const BASE_PLAN = { repeats: 3, perFamily: 3, alpha: 0.0125, confAlpha: 0.0125, minEffect: 0.05, draws: 2000, permutationDraws: 2000 };

export function grid(kind) {
  const plans = [], scenarios = [];
  const planOf = (N, extra = {}) => ({ ...BASE_PLAN, tasks: N, confTasks: N, hardFamilies: Math.max(1, Math.round(N / 3 / BASE_PLAN.perFamily)), minHardTasks: Math.max(1, Math.round(N / 3 / BASE_PLAN.perFamily)) * BASE_PLAN.perFamily, ...extra });
  if (kind === "focus") {
    // Sensitivity of the two largest designs to the plan's error split (alpha per test) and to more repeats per task.
    for (const N of [96, 144]) for (const alpha of [0.0125, 0.025]) for (const repeats of [3, 5]) plans.push(planOf(N, { alpha, confAlpha: alpha, repeats }));
    for (const effect of [0.10, 0.15]) {
      scenarios.push({ model: "template", template: "D1", effect, violation: 0 });
      scenarios.push({ model: "template", template: "D2", effect, violation: 0 });
      scenarios.push({ model: "logit", sigmaFamily: 0.5, sigmaTask: 0.75, effect, violation: 0 });
    }
    return { plans, scenarios };
  }
  for (const N of [24, 48, 72, 96, 144]) plans.push(planOf(N));
  for (const effect of [0, 0.05, 0.10, 0.15, 0.20]) {
    scenarios.push({ model: "template", template: "D1", effect, violation: 0 });
    scenarios.push({ model: "logit", sigmaFamily: 0.5, sigmaTask: 0.75, effect, violation: 0 });
    scenarios.push({ model: "template", template: "D2", effect, violation: 0 });
  }
  for (const violation of [0.005, 0.02]) scenarios.push({ model: "template", template: "D1", effect: 0.10, violation });
  scenarios.push({ model: "logit", sigmaFamily: 0, sigmaTask: 0, effect: 0, violation: 0, note: "sharp null (pB = pA)" });
  scenarios.push({ model: "logit", sigmaFamily: 1.0, sigmaTask: 1.0, effect: 0.10, violation: 0, note: "larger heterogeneity" });
  return { plans, scenarios };
}

if (isMainThread && import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { reps: { type: "string", default: "200" }, out: { type: "string" }, grid: { type: "string", default: "main" }, pilot: { type: "string", default: join(HERE, "pilot.json") } } });
  const pilotText = readFileSync(values.pilot, "utf8");
  const pilot = JSON.parse(pilotText);
  const table = pilotTable(pilot, ["D1", "D2"]);
  const { plans, scenarios } = grid(values.grid);
  const jobs = [];
  for (const plan of plans) for (const sc of scenarios) jobs.push({ plan, sc });
  const reps = Number(values.reps);
  const results = new Array(jobs.length);
  let next = 0;
  const started = Date.now();
  await new Promise((done, fail) => {
    let active = 0;
    const launch = () => {
      if (next >= jobs.length) { if (!active) done(); return; }
      const i = next++; active++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { table, job: jobs[i], reps } });
      w.once("message", (m) => { results[i] = m; });
      w.once("error", fail);
      w.once("exit", () => { active--; process.stderr.write(`[power] ${results.filter(Boolean).length}/${jobs.length} ${((Date.now() - started) / 1000).toFixed(0)}s\n`); launch(); });
    };
    for (let k = 0; k < Math.max(1, availableParallelism() - 2); k++) launch();
  });
  const out = { schema: "pi-eval-loop/confirmatory-1-power@1", generatedAt: new Date().toISOString(), pilot: { path: values.pilot, source: pilot.source, strength: table.strength }, reps, notes: "draws/permutationDraws 2000 in simulation; mcse = binomial Monte Carlo SE of each rate", results };
  const text = `${JSON.stringify(out, null, 1)}\n`;
  if (values.out) writeFileSync(values.out, text); else process.stdout.write(text);
} else if (!isMainThread) {
  const { table, job, reps } = workerData;
  const sc = calibrateScenario(table, job.sc, job.plan);
  parentPort.postMessage(runScenario(table, sc, job.plan, reps));
}
