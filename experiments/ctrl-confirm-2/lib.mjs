// ctrl-confirm-2: pure helpers (endpoints, complete-design tables, family-clustered paired inference, decision rules).
// No model calls. run.mjs, analyze.mjs, power.mjs and test/ctrl-confirm.test.mjs use these.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRng } from "../../src/rng.mjs";
import { functionalOf } from "../ctrl-ablation/lib.mjs";

export const EXPERIMENT_DIR = dirname(fileURLToPath(import.meta.url));
export const loadPrereg = (path = join(EXPERIMENT_DIR, "prereg.json")) => JSON.parse(readFileSync(path, "utf8"));

const n = (xs) => (Array.isArray(xs) ? xs.length : 0);
const CRITICAL = new Set(["harness_crash", "route_violation"]);

/**
 * Retained per-unit decisions are REQUIRED: a record without the separate legacy/strict/leak arrays cannot be scored (a missing array
 * would otherwise read as clean).
 */
export function assertRetained(r) {
  const i = r.integrity ?? {};
  if (!Array.isArray(i.legacyViolations) || !Array.isArray(i.strictTestViolations) || !Array.isArray(i.leakHits)) throw new Error(`record ${r.run_id ?? r.unit_key ?? "?"} lacks retained legacy/strict/leak decisions`);
}

/** PRIMARY unit outcome: functional success AND no legacy (line-based) violation AND no leak AND no harness crash / route violation.
 *  A unit that is not functionally successful (incl. infra/aborted/reconciled records without integrity data) is a failure. */
export const legacyValid = (r) => { if (!functionalOf(r) || CRITICAL.has(r.terminal_status)) return false; assertRetained(r); return n(r.integrity.legacyViolations) === 0 && n(r.integrity.leakHits) === 0; };
/** SECONDARY (sensitivity): the primary AND every original test file byte-identical. */
export const strictValid = (r) => legacyValid(r) && n(r.integrity.strictTestViolations) === 0;
export { functionalOf };

/**
 * Complete-design table of 0/1 outcomes per arm and task, indexed by repeat. Every scheduled (arm, task, repeat) appears; a unit
 * without a final record is a FAILURE (intent-to-evaluate) and is listed in `missing`; two final records for one unit throw.
 */
export function designTable(records, metric, { arms, tasks, repeats }) {
  const table = {}, missing = [];
  const seen = new Set();
  for (const r of records) {
    const k = `${r.candidate_id}|${r.task_id}|${r.repeat}`;
    if (seen.has(k)) throw new Error(`duplicate final record for ${k}`);
    seen.add(k);
  }
  const byKey = new Map(records.map(r => [`${r.candidate_id}|${r.task_id}|${r.repeat}`, r]));
  for (const a of arms) {
    table[a] = {};
    for (const t of tasks) {
      table[a][t] = [];
      for (let i = 0; i < repeats; i++) {
        const r = byKey.get(`${a}|${t}|${i}`);
        if (!r) missing.push(`${a}|${t}|${i}`);
        table[a][t].push(r && metric(r) ? 1 : 0);
      }
    }
  }
  const extra = records.filter(r => !arms.includes(r.candidate_id) || !tasks.includes(r.task_id) || !(r.repeat >= 0 && r.repeat < repeats));
  if (extra.length) throw new Error(`records outside the design: ${extra.slice(0, 3).map(r => `${r.candidate_id}|${r.task_id}|${r.repeat}`).join(", ")}`);
  return { table, missing };
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
/** Valid-success rate of a task (k/r) and reliable success (all r scheduled repeats successful). */
export const rateOf = (xs) => sum(xs) / xs.length;
export const reliableOf = (xs) => (xs.length > 0 && xs.every(x => x === 1) ? 1 : 0);
/** Descriptive only: unbiased within-task variance k(r-k)/(r(r-1)). */
export const inconsistency = (xs) => { const k = sum(xs), r = xs.length; return r < 2 ? 0 : (k * (r - k)) / (r * (r - 1)); };

export function armSummary(byTask) {
  const tasks = Object.keys(byTask).sort();
  const rows = tasks.map(t => byTask[t]);
  return {
    tasks: tasks.length, units: sum(rows.map(x => x.length)), successes: sum(rows.map(sum)),
    rate: mean(rows.map(rateOf)), reliable: mean(rows.map(reliableOf)), reliableTasks: sum(rows.map(reliableOf)),
    noneTasks: rows.filter(x => sum(x) === 0).length, mixedTasks: rows.filter(x => sum(x) > 0 && sum(x) < x.length).length,
    inconsistency: mean(rows.map(inconsistency)),
  };
}

const quantile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))]; };

/**
 * Paired contrast a - b over the tasks of the design, clustered by family (tasks nested in families, repeats nested in tasks):
 *  - estimate: mean over tasks of the per-task difference (rate: k/r difference; reliable: all-r indicator difference);
 *  - 95% interval: family-cluster bootstrap (resample families with replacement, keep each family's tasks; percentile);
 *  - p: family-level sign-flip randomization (each family's summed difference flips sign under H0 of exchangeable arm labels within
 *    task blocks; Monte Carlo), one-sided (greater) and two-sided.
 */
export function familyContrast(tableA, tableB, familyOf, { draws = 10000, perms = 20000, seed = "contrast" } = {}) {
  const tasks = Object.keys(tableA).filter(t => tableB[t]).sort();
  const fams = [...new Set(tasks.map(t => familyOf[t]))].sort();
  const per = (fn) => Object.fromEntries(tasks.map(t => [t, fn(tableA[t]) - fn(tableB[t])]));
  const out = { tasks: tasks.length, families: fams.length };
  for (const [name, fn] of [["rate", rateOf], ["reliable", reliableOf]]) {
    const d = per(fn);
    const famSum = fams.map(f => sum(tasks.filter(t => familyOf[t] === f).map(t => d[t])));
    const famN = fams.map(f => tasks.filter(t => familyOf[t] === f).length);
    const est = sum(famSum) / sum(famN);
    const rng = createRng(`${seed}:${name}:boot`);
    const boot = [];
    for (let i = 0; i < draws; i++) { let s = 0, m = 0; for (let j = 0; j < fams.length; j++) { const k = rng.int(fams.length); s += famSum[k]; m += famN[k]; } boot.push(s / m); }
    const prng = createRng(`${seed}:${name}:perm`);
    let ge = 0, abs = 0;
    for (let i = 0; i < perms; i++) {
      let s = 0;
      for (const x of famSum) s += prng.next() < 0.5 ? -x : x;
      const v = s / sum(famN);
      if (v >= est - 1e-12) ge++;
      if (Math.abs(v) >= Math.abs(est) - 1e-12) abs++;
    }
    out[name] = { estimate: est, ci95: [quantile(boot, 0.025), quantile(boot, 0.975)], pOneSided: (ge + 1) / (perms + 1), pTwoSided: (abs + 1) / (perms + 1), better: tasks.filter(t => d[t] > 0).length, worse: tasks.filter(t => d[t] < 0).length };
  }
  return out;
}

/** Holm adjustment of name -> p. */
export function holm(ps) {
  const e = Object.entries(ps).sort((a, b) => a[1] - b[1]);
  const out = {}; let run = 0;
  e.forEach(([k, p], i) => { run = Math.max(run, Math.min(1, (e.length - i) * p)); out[k] = run; });
  return out;
}

/**
 * Preregistered confirmatory decision of the primary contrast (intersection-union: BOTH endpoints must pass, each at one-sided
 * 0.025 via the lower bound of the two-sided 95% family-cluster bootstrap interval; the sign-flip one-sided p must also be < 0.025).
 * Returns CONFIRMED / NOT_CONFIRMED_HARM_INDICATED / INCONCLUSIVE.
 */
export function primaryDecision(c, { complete }) {
  if (!complete) return { verdict: "INCONCLUSIVE", why: "design incomplete (missing units counted as failures; confirmation requires the complete fixed sample)" };
  const pass = (e) => e.ci95[0] > 0 && e.pOneSided < 0.025;
  if (pass(c.rate) && pass(c.reliable)) return { verdict: "CONFIRMED", why: "both co-primary endpoints: 95% lower bound > 0 and one-sided p < 0.025" };
  if (c.rate.ci95[1] < 0 || c.reliable.ci95[1] < 0) return { verdict: "NOT_CONFIRMED_HARM_INDICATED", why: "a co-primary 95% upper bound is below 0" };
  return { verdict: "INCONCLUSIVE", why: "at least one co-primary endpoint did not reach its preregistered bound (absence of evidence, not evidence of no effect)" };
}

/**
 * Conservative adoption recommendation (never a deployment): ADOPTION_CANDIDATE only when the primary is CONFIRMED, the candidate has
 * zero leak / harness crash / route violation, no more legacy-integrity failures than the control, no more strict failures than the
 * control, and no family where its valid-success point estimate is below the control's. Any family regression or functional point
 * loss -> USER_REVIEW (no margin is invented). Otherwise KEEP_STABLE.
 */
export function adoption({ decision, candidate, control, familyRegressions, functionalDelta }) {
  if (decision.verdict !== "CONFIRMED") return { verdict: "KEEP_STABLE", why: `primary ${decision.verdict}` };
  const blockers = [];
  if (candidate.leaks + candidate.critical > 0) blockers.push("leak/crash/route violation in the candidate");
  if (candidate.legacyFail > control.legacyFail) blockers.push("more legacy integrity failures than the control");
  if (candidate.strictFail > control.strictFail) blockers.push("more strict test-immutability failures than the control");
  if (blockers.length) return { verdict: "KEEP_STABLE", why: blockers.join("; ") };
  const review = [];
  if (familyRegressions.length) review.push(`families with a lower valid-success point estimate: ${familyRegressions.join(", ")}`);
  if (functionalDelta < 0) review.push(`functional success point estimate lower (${(100 * functionalDelta).toFixed(1)} pt)`);
  if (review.length) return { verdict: "USER_REVIEW", why: review.join("; ") };
  return { verdict: "ADOPTION_CANDIDATE", why: "confirmed on both endpoints with no audited regression; recommendation only, no automatic deployment" };
}
