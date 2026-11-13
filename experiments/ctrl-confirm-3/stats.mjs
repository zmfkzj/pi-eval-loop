// ctrl-confirm-3: the ONE inferential procedure shared by the preregistered analysis (analyze.mjs) and the power / type-I
// simulation (power.mjs). Pure functions, no model calls, no randomness (exact enumeration).
//
// Data: table[arm][task] = 0/1 outcomes of the r scheduled repeats (missing = 0). Pairing unit = task, cluster = family.
// Per family f: x_f = sum over its tasks of the paired difference (E1: k_A - k_B, integer; E2: all-r indicator difference, integer).
// Estimate = sum_f x_f / (u * N) (u = r for E1, 1 for E2; N = tasks): the TASK-weighted mean difference, exactly the arm-rate
// difference of the complete design (families are not averaged with equal weight).
//
// Test: exact family-level sign-flip (randomization) test of S = sum_f x_f. Valid (exact) under the null that, within every family,
// the joint distribution of the outcomes is invariant to swapping the two arm labels (family differences symmetric about 0,
// independent across families). Under a "weak" null (zero mean effect but asymmetric, heterogeneous family effects) it is not exact;
// its size there is checked by simulation (power.mjs: partial / heterogeneous nulls), not assumed.
// The distribution of S over the 2^F sign vectors is computed exactly by dynamic programming over integer sums (no Monte Carlo).
//
// Interval: test inversion under a constant per-task shift d (H0_d: x_f - d * u * n_f symmetric): the 95% interval is
// [smallest grid d not rejected by the one-sided "greater" test at 0.025, largest grid d not rejected by the "less" test at 0.025],
// grid step 1/grid. The shift model is a working model (for the discrete E2 it is an approximation): the interval is reported for
// uncertainty, the DECISION uses the exact p at d = 0 only. Because the same exact test is inverted, the lower bound is > 0 exactly
// when the one-sided p at 0 is < 0.025, provided the acceptance set is an interval; analyze.mjs verifies this on a scan grid and
// reports any disagreement instead of assuming it.

export const ALPHA = 0.025;
const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };

/**
 * Exact sign-flip tail probabilities of S = sum(eps_f * |x_f|) at the observed sum(x_f), eps_f uniform on {-1, +1} independently.
 * xs must be integers. Returns P(S >= obs) (pGreater), P(S <= obs) (pLess) and the number of nonzero families.
 */
export function signFlipExact(xs) {
  if (!xs.every(Number.isInteger)) throw new Error("signFlipExact needs integer family sums");
  let a = xs.map(Math.abs).filter(v => v > 0);
  const obsRaw = xs.reduce((s, v) => s + v, 0);
  if (!a.length) return { pGreater: 1, pLess: 1, nonzero: 0 };
  const g = a.reduce(gcd, 0);
  a = a.map(v => v / g);
  const obs = obsRaw / g; // integer: every x_f is a multiple of g
  const T = a.reduce((s, v) => s + v, 0);
  let cur = new Float64Array(2 * T + 1), nxt = new Float64Array(2 * T + 1);
  cur[T] = 1;
  let reach = 0;
  for (const v of a) {
    nxt.fill(0, T - reach - v, T + reach + v + 1);
    for (let i = T - reach; i <= T + reach; i++) { const p = cur[i]; if (p) { nxt[i - v] += 0.5 * p; nxt[i + v] += 0.5 * p; } }
    reach += v;
    [cur, nxt] = [nxt, cur];
  }
  let ge = 0, le = 0;
  for (let i = 0; i <= 2 * T; i++) { const s = i - T; if (s >= obs) ge += cur[i]; if (s <= obs) le += cur[i]; }
  return { pGreater: Math.min(1, ge), pLess: Math.min(1, le), nonzero: a.length };
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
export const rateOf = (xs) => sum(xs) / xs.length;
export const reliableOf = (xs) => (xs.length > 0 && xs.every(x => x === 1) ? 1 : 0);
export const ENDPOINTS = { E1: { unit: (r) => r, task: (xs) => sum(xs) }, E2: { unit: () => 1, task: reliableOf } };

/** Family sums x_f (integers), family sizes n_f, tasks, repeats r and task-level differences for endpoint E1 or E2. */
export function familyData(tableA, tableB, familyOf, endpoint) {
  const tasks = Object.keys(tableA).filter(t => tableB[t]).sort();
  if (!tasks.length) throw new Error("no paired tasks");
  const r = tableA[tasks[0]].length;
  for (const t of tasks) { if (tableA[t].length !== r || tableB[t].length !== r) throw new Error(`task ${t}: unequal repeat counts`); if (!familyOf[t]) throw new Error(`no family for ${t}`); }
  const fn = ENDPOINTS[endpoint].task;
  const d = Object.fromEntries(tasks.map(t => [t, fn(tableA[t]) - fn(tableB[t])]));
  const fams = [...new Set(tasks.map(t => familyOf[t]))].sort();
  const idx = new Map(fams.map((f, i) => [f, i]));
  const x = new Array(fams.length).fill(0), n = new Array(fams.length).fill(0);
  for (const t of tasks) { const i = idx.get(familyOf[t]); x[i] += d[t]; n[i]++; }
  return { tasks, fams, x, n, r, u: ENDPOINTS[endpoint].unit(r), d };
}

/** One-sided exact p values of the shifted hypothesis H0_d (d on the grid j / grid, in endpoint units per task). */
export function shiftedP({ x, n, u }, j, grid) {
  return signFlipExact(x.map((v, i) => grid * v - u * j * n[i]));
}

/** Test-inversion 95% interval on the grid (bisection from the estimate; the acceptance set is checked separately). */
export function invertInterval(data, { grid = 300, alpha = ALPHA } = {}) {
  const N = sum(data.n), est = sum(data.x) / (data.u * N);
  const j0 = Math.round(est * grid);
  const bound = (side) => {
    const ok = (j) => (side === "lower" ? shiftedP(data, j, grid).pGreater : shiftedP(data, j, grid).pLess) >= alpha;
    let inside = j0, step = 1, outside = null;
    if (!ok(inside)) throw new Error("estimate not accepted by its own test");
    const dir = side === "lower" ? -1 : 1;
    while (outside === null) { const j = inside + dir * step; if (Math.abs(j) > 1.5 * grid) { outside = dir * Math.ceil(1.5 * grid); break; } if (ok(j)) { inside = j; step *= 2; } else outside = j; }
    while (Math.abs(outside - inside) > 1) { const mid = Math.trunc((inside + outside) / 2); if (ok(mid)) inside = mid; else outside = mid; }
    return inside / grid;
  };
  return [bound("lower"), bound("upper")];
}

/** Acceptance-set check on a scan grid: is the set of accepted shifts (both one-sided tests at alpha) contiguous, and do its ends
 *  match the bisection bounds (to one grid step)? */
export function acceptanceScan(data, ci, { grid = 300, alpha = ALPHA, span = 0.25, step = 3 } = {}) {
  const lo = Math.round((ci[0] - span) * grid), hi = Math.round((ci[1] + span) * grid);
  const acc = [];
  for (let j = lo; j <= hi; j += step) { const p = shiftedP(data, j, grid); acc.push([j, p.pGreater >= alpha && p.pLess >= alpha]); }
  const inIdx = acc.map(([, a], i) => (a ? i : -1)).filter(i => i >= 0);
  const contiguous = inIdx.length === 0 || inIdx[inIdx.length - 1] - inIdx[0] + 1 === inIdx.length;
  const ends = inIdx.length ? [Number(acc[inIdx[0]][0]) / grid, Number(acc[inIdx[inIdx.length - 1]][0]) / grid] : null;
  const tol = (step + 1) / grid;
  return { contiguous, scanEnds: ends, matchesBisection: Boolean(ends) && Math.abs(ends[0] - ci[0]) <= tol && Math.abs(ends[1] - ci[1]) <= tol };
}

/** Paired family-clustered contrast A - B on one endpoint: estimate, exact p values, optional interval. */
export function endpointContrast(tableA, tableB, familyOf, endpoint, { ci = true, grid = 300 } = {}) {
  const data = familyData(tableA, tableB, familyOf, endpoint);
  const N = data.tasks.length, est = sum(data.x) / (data.u * N);
  const p = signFlipExact(data.x);
  const out = { endpoint, tasks: N, families: data.fams.length, nonzeroFamilies: p.nonzero, estimate: est, pOneSided: p.pGreater, pOneSidedLess: p.pLess, pTwoSided: Math.min(1, 2 * Math.min(p.pGreater, p.pLess)), better: data.tasks.filter(t => data.d[t] > 0).length, worse: data.tasks.filter(t => data.d[t] < 0).length };
  if (ci) {
    out.ci95 = invertInterval(data, { grid });
    out.ciGrid = 1 / grid;
    out.acceptance = acceptanceScan(data, out.ci95, { grid });
    out.ciDecisionAgree = (out.ci95[0] > 0) === (out.pOneSided < ALPHA) && (out.ci95[1] < 0) === (out.pOneSidedLess < ALPHA);
  }
  return out;
}

export const contrast = (tableA, tableB, familyOf, opts) => ({ E1: endpointContrast(tableA, tableB, familyOf, "E1", opts), E2: endpointContrast(tableA, tableB, familyOf, "E2", opts) });

/**
 * Preregistered decision of a co-primary contrast (intersection-union over E1 and E2; each endpoint one-sided exact p < 0.025;
 * IUT controls the error of the joint claim at 0.025 without further adjustment). Depends ONLY on the exact p values and on design
 * completeness, so the power simulation evaluates exactly this function.
 */
export function coPrimaryDecision(c, { complete = true, alpha = ALPHA } = {}) {
  const harm = c.E1.pOneSidedLess < alpha || c.E2.pOneSidedLess < alpha;
  if (!complete) return { verdict: "INCONCLUSIVE", harmIndicated: harm, why: "design incomplete (missing units are failures; confirmation needs the complete fixed sample)" };
  if (c.E1.pOneSided < alpha && c.E2.pOneSided < alpha) return { verdict: "CONFIRMED", harmIndicated: false, why: "E1 and E2: exact one-sided family sign-flip p < 0.025 (equivalently the inverted 95% lower bound > 0)" };
  if (harm) return { verdict: "NOT_CONFIRMED_HARM_INDICATED", harmIndicated: true, why: "a co-primary endpoint has exact one-sided p < 0.025 in the harmful direction" };
  return { verdict: "INCONCLUSIVE", harmIndicated: false, why: "at least one co-primary endpoint did not reach exact one-sided p < 0.025 (absence of evidence, not evidence of no effect)" };
}

/**
 * Fixed-sequence hierarchy (FWER 0.025 one-sided for the claims below, no alpha split): H1 OCR > OC (prompt effect inside orche,
 * co-primary); H2 OCR > PCR (orche + rule vs pure Pi + the same rule: matched-instruction harness comparison) is TESTED only if H1 is
 * CONFIRMED and uses the same co-primary rule. tables: { OCR, OC, PCR? }.
 */
export function hierarchy(tables, familyOf, { complete = true, ci = false, grid = 300 } = {}) {
  const h1c = contrast(tables.OCR, tables.OC, familyOf, { ci, grid });
  const h1 = coPrimaryDecision(h1c, { complete });
  const out = { H1: { contrast: h1c, decision: h1 } };
  if (tables.PCR) {
    const h2c = contrast(tables.OCR, tables.PCR, familyOf, { ci, grid });
    out.H2 = { contrast: h2c, decision: h1.verdict === "CONFIRMED" ? coPrimaryDecision(h2c, { complete }) : { verdict: "NOT_TESTED", harmIndicated: h2c.E1.pOneSidedLess < ALPHA || h2c.E2.pOneSidedLess < ALPHA, why: "H1 not confirmed (fixed sequence)" } };
  }
  return out;
}
