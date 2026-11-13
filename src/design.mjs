// Prospective evaluation design (protocol-4): the randomized, interleaved execution schedule of a holdout pass, the
// pre-registered analysis plan (exploratory vs confirmatory), the confirmatory checks that are ANDed onto the unchanged adoption
// gate, and the repeated-experiment (series) error budget.
//
// What each statistic is, and is not (docs/design.md "Prospective analysis plan"):
//  - The adoption gate of protocol-3 (task-level Bayesian bootstrap support >= adoption.support) stays a NECESSARY condition. Its
//    support is a posterior-predictive fraction, not a calibrated error rate.
//  - Family-level support (adoption.requireFamilyLevel): the same adoption event under the family-clustered Bayesian bootstrap
//    (stats.mjs level "family"): tasks of one repository/track move together. A model-based, more conservative check; with few
//    families it is still approximate and never an error rate.
//  - Randomization test (confirmatory plans only): one-sided test of the SHARP null "the harness label changes no unit outcome":
//    within every (task, repeat) block the two arms' outcomes are exchangeable. The schedule randomizes the order of the arms in a
//    block and the order of blocks, so a time trend or provider drift is not aligned with one arm; under the sharp null swapping
//    the arm labels within a block leaves the distribution unchanged. Statistic: mean over tasks of the per-task mean (over
//    repeats) of b - a, i.e. repeats are aggregated within their task and every task counts once. Its p-value is calibrated for
//    that sharp null on THESE tasks only: it is neither a minimum-effect test nor evidence of a population (task-generalized)
//    effect. Its resolution is limited: with d discordant blocks the smallest attainable p is 2^-d.
//  - Minimum effect: the pre-registered smallest effect of interest is compared with the plug-in estimate (descriptive). No
//    margin test is claimed.
//  - Leave-one-family-out: a sensitivity check (no family alone may carry the gain), not calibrated uncertainty.
//  - Series budget: every confirmatory test spends its pre-registered alpha from a shared, hash-chained ledger before any outcome
//    is seen; the union bound keeps the series-wide probability of a false sharp-null rejection <= alphaTotal under any
//    dependence between experiments. Interrupted experiments are never refunded.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRng } from "./rng.mjs";
import { compare, mean } from "./stats.mjs";
import { acquireLock, digestOf, ensureDir, Ledger, LockBusyError, sha256 } from "./util.mjs";

export const SCHEDULE_SCHEMA = "pi-eval-loop/schedule@1";
export const SERIES_SCHEMA = "pi-eval-loop/series@1";
export const PLAN_MODES = ["exploratory", "confirmatory"];
export const EXECUTIONS = ["interleaved", "sequential"];
const HEX64 = /^[0-9a-f]{64}$/;

// ------------------------------------------------------------------------------------------------------------------ schedule

/**
 * Randomized, interleaved schedule of one evaluation pass: blocks = (task, repeat), each holding one unit per arm; the block order
 * and the arm order inside every block are drawn from `seed` (derive it from the pre-registered seed and the frozen selection,
 * never from an outcome). Deterministic: the same inputs give the same schedule and digest. Units carry their planned position
 * (`index`, `block`, `slot`) so the dispatch order can be audited against the plan.
 * @param {{ arms: string[], tasks: string[], repeats: number, split: string, seed: string, bind?: any }} options
 */
export function interleavedSchedule({ arms, tasks, repeats, split, seed, bind = null }) {
  if (!arms.length || new Set(arms).size !== arms.length) throw new Error("schedule: arms must be distinct and non-empty");
  if (!(Number.isInteger(repeats) && repeats >= 1)) throw new Error("schedule: repeats must be a positive integer");
  const rng = createRng(`${seed}:interleaved-schedule`);
  const sortedArms = [...arms].sort(), sortedTasks = [...new Set(tasks)].sort();
  const blocks = [];
  for (const task of sortedTasks) for (let repeat = 0; repeat < repeats; repeat++) blocks.push({ task, repeat });
  const units = [];
  rng.shuffle(blocks).forEach((b, block) => {
    rng.shuffle(sortedArms).forEach((arm, slot) => units.push({ index: units.length, block, slot, arm, task: b.task, split, repeat: b.repeat }));
  });
  const plan = { schema: SCHEDULE_SCHEMA, seed, split, arms: sortedArms, tasks: sortedTasks, repeats, bind, units };
  return { ...plan, digest: digestOf(plan) };
}

/** Problems of a stored schedule against the one recomputed from its inputs (empty = identical). */
export function scheduleProblems(stored, expected) {
  if (!stored || typeof stored !== "object") return ["no stored schedule"];
  const problems = [];
  if (stored.digest !== expected.digest) problems.push(`schedule digest ${String(stored.digest).slice(0, 12)} != recomputed ${expected.digest.slice(0, 12)}`);
  const { digest, ...plan } = stored;
  if (digestOf(plan) !== digest) problems.push("stored schedule does not match its own digest (edited)");
  return problems;
}

/**
 * Actual first-dispatch order of a schedule's units from the evaluator ledger (dispatch records in ledger order), compared with
 * the planned order. Retries (attempt > 1) are listed apart. `keyOf(unit)` maps a scheduled unit to its unit key.
 * @param {any[]} ledgerRecords @param {{ units: any[] }} schedule @param {(unit: any) => string} keyOf
 */
export function executionOrder(ledgerRecords, schedule, keyOf) {
  const index = new Map(schedule.units.map(u => [keyOf(u), u.index]));
  const dispatches = ledgerRecords.filter(r => r.type === "dispatch" && index.has(r.unit_key));
  const first = dispatches.filter(r => r.attempt === 1).map(r => index.get(r.unit_key));
  const retries = dispatches.filter(r => r.attempt > 1).map(r => ({ index: index.get(r.unit_key), attempt: r.attempt }));
  const results = new Set(ledgerRecords.filter(r => r.type === "result" && index.has(r.unit_key)).map(r => r.unit_key));
  let inversions = 0;
  for (let i = 1; i < first.length; i++) if (first[i] < first[i - 1]) inversions++;
  return { planned: schedule.units.length, dispatched: first.length, completed: results.size, firstDispatchOrder: first, followsPlan: inversions === 0, inversions, retries };
}

// ---------------------------------------------------------------------------------------------------------- randomization test

const EXACT_MAX = 16;
/**
 * One-sided randomization (sign-flip within (task, repeat) blocks) test of b > a under the sharp null of exchangeable arm labels.
 * `tasks`: [{ task, family, a: number[], b: number[] }] with a[r] and b[r] from the same block. Returns
 * { valid, why?, statistic, p, exact, discordantBlocks, minAttainableP, draws }. Monte Carlo p-values are (1 + hits) / (1 + draws)
 * (never zero); exact enumeration is used up to 2^16 sign patterns.
 * @param {Array<{ task: string, a: number[], b: number[] }>} tasks @param {{ draws?: number, seed?: string }} [options]
 */
export function randomizationTest(tasks, { draws = 20_000, seed = "randomization" } = {}) {
  if (!tasks.length) return { valid: false, why: "no tasks" };
  const blocks = [];
  for (const t of tasks) {
    if (!t.a?.length || t.a.length !== t.b?.length) return { valid: false, why: `task ${t.task}: unmatched blocks (${t.a?.length ?? 0} vs ${t.b?.length ?? 0} repeats)` };
    for (let r = 0; r < t.a.length; r++) {
      const d = t.b[r] - t.a[r];
      if (!Number.isFinite(d)) return { valid: false, why: `task ${t.task}: missing outcome in block ${r}` };
      // Weight of a block in the statistic: tasks count equally, repeats are averaged within their task.
      if (d !== 0) blocks.push({ w: 1 / (tasks.length * t.a.length), d });
    }
  }
  const stat = (signs) => blocks.reduce((s, b, i) => s + (signs ? signs(i) : 1) * b.w * b.d, 0);
  const observed = stat(undefined);
  const n = blocks.length;
  const minAttainableP = n === 0 ? 1 : 2 ** -n;
  const tol = 1e-12;
  if (n === 0) return { valid: true, statistic: 0, p: 1, exact: true, discordantBlocks: 0, minAttainableP, draws: 1 };
  if (n <= EXACT_MAX) {
    let hits = 0;
    const total = 2 ** n;
    for (let mask = 0; mask < total; mask++) if (stat(i => ((mask >> i) & 1 ? -1 : 1)) >= observed - tol) hits++;
    return { valid: true, statistic: observed, p: hits / total, exact: true, discordantBlocks: n, minAttainableP, draws: total };
  }
  const rng = createRng(`${seed}:randomization`);
  let hits = 0;
  for (let j = 0; j < draws; j++) { const flips = blocks.map(() => (rng.next() < 0.5 ? -1 : 1)); if (stat(i => flips[i]) >= observed - tol) hits++; }
  return { valid: true, statistic: observed, p: (1 + hits) / (1 + draws), exact: false, discordantBlocks: n, minAttainableP: Math.max(minAttainableP, 1 / (1 + draws)), draws };
}

/** Plug-in overall delta (uniform task weights, repeats averaged within task). */
export const pointDelta = (tasks) => tasks.length ? mean(tasks.map(t => mean(t.b) - mean(t.a))) : NaN;

/** Leave-one-family-out sensitivity: the plug-in delta without each family (needs >= 2 families). */
export function leaveOneFamilyOut(tasks) {
  const families = [...new Set(tasks.map(t => t.family ?? t.task))].sort();
  if (families.length < 2) return { ok: false, why: `${families.length} family: no leave-one-out possible`, byFamily: {} };
  const byFamily = Object.fromEntries(families.map(f => [f, pointDelta(tasks.filter(t => (t.family ?? t.task) !== f))]));
  const worst = Math.min(...Object.values(byFamily));
  return { ok: worst > 0, worst, byFamily };
}

// ---------------------------------------------------------------------------------------------------------------- plan shape

const num01 = (v) => typeof v === "number" && v > 0 && v < 1;
const posInt = (v) => Number.isInteger(v) && v >= 1;
const str = (v) => typeof v === "string" && v.trim().length > 0;

/** Type/range problems of protocol-4 keys (an exploratory plan may leave its confirmatory fields null). */
export function planShapeProblems(p) {
  const problems = [];
  const plan = p.analysisPlan;
  if (!EXECUTIONS.includes(p.holdout?.execution)) problems.push(`holdout.execution must be one of ${EXECUTIONS.join("|")}`);
  if (typeof p.adoption?.requireFamilyLevel !== "boolean") problems.push("adoption.requireFamilyLevel must be a boolean");
  if (!(p.holdout?.maxOwnerShare === null || num01(p.holdout?.maxOwnerShare) || p.holdout?.maxOwnerShare === 1)) problems.push("holdout.maxOwnerShare must be null or in (0,1]");
  if (!["allow", "forbid"].includes(p.holdout?.priorFamilyReuse)) problems.push("holdout.priorFamilyReuse must be allow|forbid");
  if (!plan || typeof plan !== "object") { problems.push("analysisPlan missing"); return problems; }
  if (!PLAN_MODES.includes(plan.mode)) problems.push(`analysisPlan.mode must be one of ${PLAN_MODES.join("|")}`);
  const optional = (v, ok, name, what) => { if (v !== null && v !== undefined && !ok(v)) problems.push(`analysisPlan.${name} must be ${what} or null`); };
  optional(plan.minEffect, num01, "minEffect", "in (0,1)");
  optional(plan.alpha, (v) => num01(v) && v <= 0.5, "alpha", "in (0,0.5]");
  for (const k of ["minTasks", "minFamilies", "minHardTasks"]) optional(plan[k], posInt, k, "a positive integer");
  if (!(Number.isInteger(plan.permutationDraws) && plan.permutationDraws >= 1000)) problems.push("analysisPlan.permutationDraws must be an integer >= 1000");
  optional(plan.series?.alphaTotal, num01, "series.alphaTotal", "in (0,1)");
  optional(plan.confirmation?.alpha, (v) => num01(v) && v <= 0.5, "confirmation.alpha", "in (0,0.5]");
  for (const k of ["minTasks", "minFamilies"]) optional(plan.confirmation?.[k], posInt, `confirmation.${k}`, "a positive integer");
  optional(plan.lowExposure?.minTasks, posInt, "lowExposure.minTasks", "a positive integer");
  if (plan.lowExposure && !Array.isArray(plan.lowExposure.provenance)) problems.push("analysisPlan.lowExposure.provenance must be a list");
  else if ((plan.lowExposure?.provenance ?? []).includes("external")) problems.push("analysisPlan.lowExposure.provenance must not contain \"external\": public-source provenance is never low exposure");
  return problems;
}

/** Resolve a plan path (absolute, or relative to `base`). */
export const planPath = (path, base) => (isAbsolute(path) ? path : resolve(base, path));

/**
 * Completeness of a confirmatory plan: every value it needs is pre-registered by the operator (nothing is defaulted: no sample
 * size, effect size or error budget is invented here). Returns a list of missing/invalid items (empty = complete). An exploratory
 * plan is always complete (it claims nothing beyond exploration).
 * @param {any} p protocol @param {{ base: string }} options base directory for relative paths
 */
export function planCompleteness(p, { base }) {
  const plan = p.analysisPlan;
  if (plan?.mode !== "confirmatory") return [];
  const missing = [];
  if (!str(plan.registeredAt) || Number.isNaN(Date.parse(plan.registeredAt))) missing.push("analysisPlan.registeredAt (ISO time the plan was written, before the experiment)");
  if (!str(plan.rationale?.document) || !HEX64.test(plan.rationale?.sha256 ?? "")) missing.push("analysisPlan.rationale {document, sha256}: the written justification of the sample size, effect size and error budget (e.g. a simulation under stated assumptions)");
  else {
    const doc = planPath(plan.rationale.document, base);
    if (!existsSync(doc)) missing.push(`analysisPlan.rationale.document not found: ${doc}`);
    else if (sha256(readFileSync(doc)) !== plan.rationale.sha256) missing.push("analysisPlan.rationale.document changed since registration (sha256 differs)");
  }
  if (!num01(plan.minEffect)) missing.push("analysisPlan.minEffect (smallest overall effect of interest, absolute success-rate difference)");
  if (!(num01(plan.alpha) && plan.alpha <= 0.5)) missing.push("analysisPlan.alpha (one-sided error spent by this experiment)");
  if (!posInt(plan.minTasks) || plan.minTasks < p.holdout.minTasks) missing.push(`analysisPlan.minTasks (>= holdout.minTasks ${p.holdout.minTasks})`);
  if (!posInt(plan.minFamilies) || plan.minFamilies < p.holdout.minFamilies) missing.push(`analysisPlan.minFamilies (>= holdout.minFamilies ${p.holdout.minFamilies})`);
  if (p.adoption.requireHardStratum && !posInt(plan.minHardTasks)) missing.push("analysisPlan.minHardTasks (>= 1: the hard stratum is required)");
  if (!str(plan.series?.id) || !str(plan.series?.ledger) || !num01(plan.series?.alphaTotal)) missing.push("analysisPlan.series {id, ledger, alphaTotal}: the shared error budget of repeated experiments");
  else if (num01(plan.alpha) && plan.alpha + (plan.confirmation?.required ? plan.confirmation?.alpha ?? 0 : 0) > plan.series.alphaTotal + 1e-12) missing.push("analysisPlan.alpha (+ confirmation.alpha) exceeds series.alphaTotal");
  if (p.holdout.execution !== "interleaved") missing.push("holdout.execution must be \"interleaved\" (the randomization test needs randomized arm order)");
  if (p.holdout.requireIndependent !== true) missing.push("holdout.requireIndependent must be true");
  if (p.adoption.requireFamilyLevel !== true) missing.push("adoption.requireFamilyLevel must be true");
  if (p.holdout.priorFamilyReuse !== "forbid") missing.push("holdout.priorFamilyReuse must be \"forbid\" (holdouts of consecutive experiments must not share families)");
  if (p.holdout.maxOwnerShare === null || !(p.holdout.maxOwnerShare <= 0.5)) missing.push("holdout.maxOwnerShare must be <= 0.5");
  const low = plan.lowExposure ?? {};
  if (typeof low.required !== "boolean") missing.push("analysisPlan.lowExposure.required (true|false: whether a low-exposure stratum must agree)");
  else if (low.required) {
    if (!posInt(low.minTasks)) missing.push("analysisPlan.lowExposure.minTasks");
    if (!Array.isArray(low.provenance) || !low.provenance.length) missing.push("analysisPlan.lowExposure.provenance (e.g. [\"private-reviewed\"])");
    else if (low.provenance.some(x => !p.holdout.acceptedProvenance.includes(x))) missing.push("holdout.acceptedProvenance must include every analysisPlan.lowExposure.provenance");
  }
  const conf = plan.confirmation ?? {};
  if (typeof conf.required !== "boolean") missing.push("analysisPlan.confirmation.required (true|false)");
  else if (conf.required) {
    if (!str(conf.pool)) missing.push("analysisPlan.confirmation.pool (a supply pool holding a separate sealed, unused confirmation batch)");
    if (!(num01(conf.alpha) && conf.alpha <= 0.5)) missing.push("analysisPlan.confirmation.alpha");
    if (!posInt(conf.minTasks)) missing.push("analysisPlan.confirmation.minTasks");
    if (!posInt(conf.minFamilies)) missing.push("analysisPlan.confirmation.minFamilies");
  }
  return missing;
}

// ---------------------------------------------------------------------------------------------------------- confirmatory checks

/**
 * Confirmatory checks of one paired comparison (holdout: stable vs candidate; confirmation: previous vs adopted), ANDed onto the
 * adoption gate. Returns { ok, inconclusive: string[], failed: string[], passed: string[], results }. `inconclusive`: the data
 * cannot answer the plan (coverage below the pre-registered minima, unmatched blocks, too few discordant blocks to reach alpha);
 * `failed`: answered, not supported.
 * @param {Array<{ task: string, family?: string, hard?: boolean, provenance?: string, a: number[], b: number[] }>} pairs
 * @param {{ alpha: number, minEffect: number, minTasks: number, minFamilies: number, minHardTasks?: number, lowExposure?: { required: boolean, minTasks?: number, provenance?: string[] },
 *   draws: number, permutationDraws: number, seed: string }} plan
 */
export function confirmatoryChecks(pairs, plan) {
  const inconclusive = [], failed = [], passed = [];
  const families = new Set(pairs.map(t => t.family ?? t.task)).size, hard = pairs.filter(t => t.hard).length;
  const coverage = { tasks: pairs.length, families, hardTasks: hard };
  if (pairs.length < plan.minTasks) inconclusive.push(`tasks ${pairs.length} < pre-registered ${plan.minTasks}`);
  if (families < plan.minFamilies) inconclusive.push(`families ${families} < pre-registered ${plan.minFamilies}`);
  if (plan.minHardTasks && hard < plan.minHardTasks) inconclusive.push(`accepted hard tasks ${hard} < pre-registered ${plan.minHardTasks}`);
  const results = { coverage };
  if (!pairs.length) return { ok: false, inconclusive: [...inconclusive, "no paired tasks"], failed, passed, results };
  const perm = randomizationTest(pairs, { draws: plan.permutationDraws, seed: plan.seed });
  results.randomization = perm;
  if (!perm.valid) inconclusive.push(`randomization test not applicable: ${perm.why}`);
  else if (perm.minAttainableP > plan.alpha) inconclusive.push(`randomization test cannot reach alpha ${plan.alpha}: ${perm.discordantBlocks} discordant block(s), smallest attainable p ${perm.minAttainableP.toFixed(4)}`);
  else if (perm.p <= plan.alpha) passed.push(`randomization test (sharp null, these tasks): p ${perm.p.toFixed(4)} <= alpha ${plan.alpha}`);
  else failed.push(`randomization test (sharp null, these tasks): p ${perm.p.toFixed(4)} > alpha ${plan.alpha}`);
  const fam = compare(pairs, { draws: plan.draws, seed: `${plan.seed}:confirmatory-family`, level: "family", event: (d) => d.overall > 0 });
  results.familyPositive = { support: fam.support, delta: fam.delta.overall };
  if (fam.support >= 1 - plan.alpha) passed.push(`family-clustered P(delta > 0) ${fam.support.toFixed(4)} >= ${1 - plan.alpha}`);
  else failed.push(`family-clustered P(delta > 0) ${fam.support.toFixed(4)} < ${(1 - plan.alpha).toFixed(4)}`);
  const point = pointDelta(pairs);
  results.point = point;
  if (point >= plan.minEffect) passed.push(`estimated overall delta ${point.toFixed(4)} >= smallest effect of interest ${plan.minEffect} (descriptive, not a margin test)`);
  else failed.push(`estimated overall delta ${point.toFixed(4)} < smallest effect of interest ${plan.minEffect}`);
  const lofo = leaveOneFamilyOut(pairs);
  results.leaveOneFamilyOut = lofo;
  if (lofo.ok) passed.push(`leave-one-family-out: every family removed keeps delta > 0 (worst ${lofo.worst.toFixed(4)}; sensitivity only)`);
  else if (lofo.why) inconclusive.push(`leave-one-family-out: ${lofo.why}`);
  else failed.push(`leave-one-family-out: removing one family leaves delta ${lofo.worst.toFixed(4)} <= 0`);
  const low = plan.lowExposure;
  if (low?.required) {
    const stratum = pairs.filter(t => (low.provenance ?? []).includes(t.provenance));
    const d = pointDelta(stratum);
    results.lowExposure = { tasks: stratum.length, delta: stratum.length ? d : null };
    if (stratum.length < (low.minTasks ?? 1)) inconclusive.push(`low-exposure stratum ${stratum.length} task(s) < pre-registered ${low.minTasks}`);
    else if (d >= 0) passed.push(`low-exposure stratum (${stratum.length} tasks) agrees in direction: delta ${d.toFixed(4)} >= 0`);
    else failed.push(`low-exposure stratum (${stratum.length} tasks) reverses: delta ${d.toFixed(4)} < 0`);
  }
  return { ok: inconclusive.length === 0 && failed.length === 0, inconclusive, failed, passed, results };
}

/**
 * The evidence label of a decision: what may be claimed from it. Exploratory: never a confirmatory or generalized-improvement
 * claim. Confirmatory: the sharp-null rejection on these tasks plus the family-level and sensitivity checks; claims about real
 * coding ability beyond public tasks need the low-exposure stratum; a generalized claim needs the independent confirmation.
 * @param {any} protocol @param {{ adopt?: boolean, confirmatory?: any }} [options]
 */
export function evidenceLabel(protocol, { adopt, confirmatory } = {}) {
  const plan = protocol.analysisPlan ?? { mode: "exploratory" };
  if (plan.mode !== "confirmatory") return { class: "exploratory", confirmatoryClaim: false, generalizedClaim: false, note: "exploratory measurement: never a production adoption, no confirmatory or generalized-improvement claim (analysisPlan.mode exploratory)", confirmation: "not planned" };
  const low = plan.lowExposure?.required ? "public and low-exposure strata" : "public-source tasks only (exposure to model training not established)";
  return { class: "confirmatory", confirmatoryClaim: Boolean(adopt && confirmatory?.ok), generalizedClaim: false, scope: low, note: adopt ? "confirmatory checks passed; a generalized claim needs the independent post-adoption confirmation" : "no confirmatory claim", confirmation: plan.confirmation?.required ? "required: pending" : "not planned" };
}

// --------------------------------------------------------------------------------------------------------------------- series

/** Status of a series ledger: { ok, problems, spent, records } (a missing ledger is an empty series; a damaged one is not ok). */
export function seriesStatus(ledgerPath, seriesId) {
  // A missing ledger is an empty series; reading it must not create its directory (read-only callers: preflight, readiness).
  if (!existsSync(ledgerPath)) return { ok: true, problems: [], spent: 0, records: [] };
  const ledger = new Ledger(ledgerPath);
  let records;
  try { records = ledger.records(); } catch (error) { return { ok: false, problems: [String(error.message)], spent: NaN, records: [] }; }
  const problems = ledger.verify();
  const foreign = records.filter(r => r.series !== seriesId);
  if (foreign.length) problems.push(`ledger holds ${foreign.length} record(s) of another series`);
  const spends = records.filter(r => r.type === "spend" && r.series === seriesId);
  return { ok: problems.length === 0, problems, spent: spends.reduce((s, r) => s + r.alpha, 0), records: spends };
}

/**
 * Spend `alpha` of the series for one frozen test (purpose "holdout" | "confirmation"), before any outcome of that test exists.
 * Idempotent per (stateDir, purpose, bind digest): a resumed experiment gets its own record back. Serialized by a lock next to
 * the ledger, so concurrent experiments never overspend. Returns { record, recovered } or { refused: reason }. Never refunds.
 * @param {string} ledgerPath @param {{ series: string, alphaTotal: number, alpha: number, stateDir: string, purpose: string, bind: any }} spend
 */
export function spendAlpha(ledgerPath, { series, alphaTotal, alpha, stateDir, purpose, bind }, { waitMs = 30_000 } = {}) {
  ensureDir(dirname(ledgerPath));
  const lockPath = join(dirname(ledgerPath), `.${series.replace(/[^A-Za-z0-9._-]/g, "_")}.series.lock`);
  // Serialized across processes: a live competing spend is waited for (bounded), never raced.
  let lock;
  for (const deadline = Date.now() + waitMs; !lock;) {
    try { lock = acquireLock(lockPath); } catch (error) {
      if (!(error instanceof LockBusyError) || Date.now() > deadline) return { refused: `series ledger busy: ${String(error.message).slice(0, 200)}` };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const st = seriesStatus(ledgerPath, series);
    if (!st.ok) return { refused: `series ledger unusable: ${st.problems.join("; ")}` };
    const bindDigest = digestOf(bind);
    const own = st.records.find(r => r.stateDir === stateDir && r.purpose === purpose);
    if (own) return own.bindDigest === bindDigest ? { record: own, recovered: true } : { refused: `this experiment already spent alpha for ${purpose} under another frozen binding (seq ${own.seq})` };
    if (st.spent + alpha > alphaTotal + 1e-12) return { refused: `series ${series} error budget exhausted: spent ${st.spent.toFixed(4)} + ${alpha} > ${alphaTotal}` };
    const record = new Ledger(ledgerPath).append({ type: "spend", schema: SERIES_SCHEMA, series, alpha, alphaTotal, stateDir, purpose, bindDigest, bind });
    return { record, recovered: false };
  } finally { lock.release(); }
}

/** Read-only budget check for a preflight: would this experiment's pre-registered spends fit? */
export function seriesFits(ledgerPath, { series, alphaTotal, alpha, stateDir }) {
  const st = seriesStatus(ledgerPath, series);
  if (!st.ok) return { ok: false, why: `series ledger unusable: ${st.problems.join("; ")}` };
  const others = st.records.filter(r => r.stateDir !== stateDir).reduce((s, r) => s + r.alpha, 0);
  const mine = st.records.filter(r => r.stateDir === stateDir).reduce((s, r) => s + r.alpha, 0);
  const need = Math.max(0, alpha - mine);
  return others + mine + need <= alphaTotal + 1e-12 ? { ok: true, spent: st.spent } : { ok: false, why: `series ${series} error budget exhausted: spent ${st.spent.toFixed(4)} (by ${new Set(st.records.map(r => r.stateDir)).size} experiment(s)) + ${need} > ${alphaTotal}` };
}
