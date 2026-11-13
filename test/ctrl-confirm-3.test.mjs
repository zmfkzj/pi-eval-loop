// ctrl-confirm-3: exact family sign-flip test vs exhaustive enumeration, test-inversion interval / decision compatibility, the
// shared co-primary decision and hierarchy, and the decision equivalence of the power simulation and the analysis.
// Simulated data here are checks of the procedure, never measurements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRng } from "../src/rng.mjs";
import { ALPHA, coPrimaryDecision, contrast, endpointContrast, familyData, hierarchy, invertInterval, signFlipExact } from "../experiments/ctrl-confirm-3/stats.mjs";

const brute = (xs) => {
  const F = xs.length, obs = xs.reduce((s, v) => s + v, 0);
  let ge = 0, le = 0;
  for (let m = 0; m < 2 ** F; m++) { let s = 0; for (let f = 0; f < F; f++) s += (m >> f) & 1 ? -Math.abs(xs[f]) : Math.abs(xs[f]); if (s >= obs) ge++; if (s <= obs) le++; }
  return { pGreater: ge / 2 ** F, pLess: le / 2 ** F };
};

test("exact sign-flip equals exhaustive enumeration (zeros, ties, unequal magnitudes, negative effects)", () => {
  const rng = createRng("cc3-brute");
  const cases = [[1, 1, 1, 1], [1, 1, 1, 1, 1], [0, 0, 2, -1, 3, 0, 1], [-2, -1, -3], [3, -3, 3, -3], [0, 0, 0], [6, 2, 4], [9, -3, 1, 1, 0, -2, 5, 7, -1, 2, 2, 3]];
  for (let i = 0; i < 60; i++) cases.push(Array.from({ length: 1 + rng.int(12) }, () => rng.int(13) - 6));
  for (const xs of cases) {
    const e = signFlipExact(xs), b = brute(xs);
    assert.ok(Math.abs(e.pGreater - b.pGreater) < 1e-12 && Math.abs(e.pLess - b.pLess) < 1e-12, `${xs}: ${JSON.stringify(e)} vs ${JSON.stringify(b)}`);
  }
});

test("sparse E2 discreteness: 4 all-positive nonzero families give p = 1/16, 5 give 1/32 (> 0.025), 6 give 1/64", () => {
  assert.equal(signFlipExact([1, 1, 1, 1, 0, 0, 0]).pGreater, 0.0625);
  assert.equal(signFlipExact([1, 1, 1, 1, 1]).pGreater, 0.03125);
  assert.ok(signFlipExact([1, 1, 1, 1, 1]).pGreater >= ALPHA, "five concordant families cannot pass 0.025");
  assert.equal(signFlipExact([1, 1, 1, 1, 1, 1]).pGreater, 1 / 64);
  assert.deepEqual(signFlipExact([0, 0]), { pGreater: 1, pLess: 1, nonzero: 0 });
  assert.throws(() => signFlipExact([0.5]), /integer/);
});

const randomDesign = (rng, { F = 20, maxPer = 3, pA = 0.3, pB = 0.3, r = 3 } = {}) => {
  const A = {}, B = {}, fam = {};
  for (let f = 0; f < F; f++) { const m = 1 + rng.int(maxPer); for (let t = 0; t < m; t++) { const id = `f${f}t${t}`; fam[id] = `f${f}`; const qa = Math.min(1, Math.max(0, pA + (rng.next() - 0.5) * 0.6)), qb = Math.min(1, Math.max(0, pB + (rng.next() - 0.5) * 0.6)); A[id] = Array.from({ length: r }, () => (rng.next() < qa ? 1 : 0)); B[id] = Array.from({ length: r }, () => (rng.next() < qb ? 1 : 0)); } }
  return { A, B, fam };
};

test("estimate is task-weighted (family sums / total tasks), not an equal-family average", () => {
  const A = { a1: [1, 1, 1], a2: [1, 1, 1], a3: [1, 1, 1], b1: [0, 0, 0] }, B = { a1: [0, 0, 0], a2: [0, 0, 0], a3: [0, 0, 0], b1: [1, 1, 1] };
  const fam = { a1: "a", a2: "a", a3: "a", b1: "b" };
  const c = endpointContrast(A, B, fam, "E1", { ci: false });
  assert.equal(c.estimate, 0.5); // (3 - 1) / 4, an equal-family average would be 0
  assert.deepEqual(familyData(A, B, fam, "E1").x, [9, -3]);
});

test("inverted interval and decision are compatible on random designs (null, beneficial, harmful), acceptance sets contiguous", () => {
  const rng = createRng("cc3-ci");
  let agree = 0, total = 0;
  for (let i = 0; i < 40; i++) {
    const d = randomDesign(rng, { F: 8 + rng.int(20), pA: 0.2 + rng.next() * 0.4, pB: 0.3 });
    for (const ep of ["E1", "E2"]) {
      const data = familyData(d.A, d.B, d.fam, ep);
      if (!data.x.some(v => v !== 0)) continue;
      const c = endpointContrast(d.A, d.B, d.fam, ep, { grid: 60 });
      total++;
      if (c.ciDecisionAgree) agree++;
      assert.ok(c.acceptance.contiguous, `acceptance set not contiguous: ${JSON.stringify(data.x)}`);
      assert.ok(c.ci95[0] <= c.estimate + 1 / 60 && c.ci95[1] >= c.estimate - 1 / 60);
    }
  }
  assert.equal(agree, total, `CI/decision disagreement in ${total - agree} of ${total}`);
});

test("co-primary decision: IUT over E1 and E2, harm, incomplete design; hierarchy gates H2 on H1", () => {
  const e = (p, pl = 1 - p) => ({ pOneSided: p, pOneSidedLess: pl });
  assert.equal(coPrimaryDecision({ E1: e(0.01), E2: e(0.02) }).verdict, "CONFIRMED");
  assert.equal(coPrimaryDecision({ E1: e(0.01), E2: e(0.0625) }).verdict, "INCONCLUSIVE");
  assert.equal(coPrimaryDecision({ E1: e(0.99, 0.01), E2: e(0.5) }).verdict, "NOT_CONFIRMED_HARM_INDICATED");
  assert.equal(coPrimaryDecision({ E1: e(0.01), E2: e(0.02) }, { complete: false }).verdict, "INCONCLUSIVE");
  const rng = createRng("cc3-h");
  const d = randomDesign(rng, { F: 10 });
  const h = hierarchy({ OCR: d.A, OC: d.B, PCR: d.B }, d.fam);
  if (h.H1.decision.verdict !== "CONFIRMED") assert.equal(h.H2.decision.verdict, "NOT_TESTED");
  // A strong, consistent benefit confirms H1 and then tests H2.
  const A = {}, B = {}, fam = {};
  for (let f = 0; f < 30; f++) { A[`t${f}`] = [1, 1, 1]; B[`t${f}`] = f % 5 === 0 ? [1, 1, 1] : [0, 1, 0]; fam[`t${f}`] = `f${f}`; }
  const s = hierarchy({ OCR: A, OC: B, PCR: B }, fam);
  assert.equal(s.H1.decision.verdict, "CONFIRMED"); assert.equal(s.H2.decision.verdict, "CONFIRMED");
});

test("analysis path (with intervals) and simulation path (p values only) give the same decision", () => {
  const rng = createRng("cc3-eq");
  for (let i = 0; i < 25; i++) {
    const d = randomDesign(rng, { F: 15 + rng.int(25), pA: 0.25 + rng.next() * 0.3, pB: 0.3 });
    const full = coPrimaryDecision(contrast(d.A, d.B, d.fam, { grid: 60 }));
    const fast = coPrimaryDecision(contrast(d.A, d.B, d.fam, { ci: false }));
    assert.equal(full.verdict, fast.verdict);
  }
});

test("interval bisection respects the grid and brackets the estimate", () => {
  const data = { x: [3, 2, -1, 0, 4, 1], n: [3, 2, 1, 1, 3, 2], u: 3 };
  const [lo, hi] = invertInterval(data, { grid: 90 });
  assert.ok(lo < 9 / (3 * 12) && hi > 9 / (3 * 12));
  assert.ok(Number.isInteger(Math.round(lo * 90 * 1e6) / 1e6));
});

const HOLDOUT2 = new URL("../../results/ctrl-confirm-2-holdout/ctrl-confirm-2-holdout-3e83b1b2af67", import.meta.url);
test("power simulation: the exact rule holds its size under the global null and under partial / skewed nulls (within MC error)", { skip: !existsSync(HOLDOUT2) && "historical ctrl-confirm-2 holdout (git-ignored) not present" }, async () => {
  const { historical, calibrate, operating, populationEffect, scenarioOf } = await import("../experiments/ctrl-confirm-3/power.mjs");
  const pool = calibrate(historical());
  for (const sc of ["null:E2-only-null", "null:E1-only-null", "null:skewed-heterogeneous-E1"]) {
    const e = populationEffect(pool, scenarioOf(sc, pool));
    assert.ok(Math.abs(sc === "null:E2-only-null" ? e.E2 : e.E1) < 1e-9, `${sc} calibration`);
  }
  const sims = 600;
  const g = operating(pool, "scale:0", { tasks: 200, sims, seed: "test" });
  assert.ok(g.H1confirmed.p <= ALPHA + 3 * Math.sqrt(ALPHA * (1 - ALPHA) / sims), JSON.stringify(g.H1confirmed));
  assert.ok(g.E1pass.p <= ALPHA + 3 * Math.sqrt(ALPHA * (1 - ALPHA) / sims) && g.E2pass.p <= ALPHA + 3 * Math.sqrt(ALPHA * (1 - ALPHA) / sims));
  const partialE2 = operating(pool, "null:E2-only-null", { tasks: 200, sims, seed: "test" });
  assert.ok(partialE2.H1confirmed.p <= ALPHA + 3 * Math.sqrt(ALPHA * (1 - ALPHA) / sims), `IUT size with E2 null: ${JSON.stringify(partialE2.H1confirmed)}`);
  const partialE1 = operating(pool, "null:E1-only-null", { tasks: 200, sims, seed: "test" });
  assert.ok(partialE1.H1confirmed.p <= ALPHA + 3 * Math.sqrt(ALPHA * (1 - ALPHA) / sims), `IUT size with E1 null: ${JSON.stringify(partialE1.H1confirmed)}`);
  const skew = operating(pool, "null:skewed-heterogeneous-E1", { tasks: 200, sims, seed: "test" });
  assert.ok(skew.E1pass.p <= ALPHA + 3 * Math.sqrt(ALPHA * (1 - ALPHA) / sims), `E1 size under skewed weak null: ${JSON.stringify(skew.E1pass)}`);
});

test("frozen candidate identity: contract, rule and OCR patch are byte-identical to ctrl-confirm-2; arms OC/OCR/PCR", async () => {
  const { loadPrereg } = await import("../experiments/ctrl-confirm-3/lib.mjs");
  const p3 = loadPrereg(), p2 = JSON.parse((await import("node:fs")).readFileSync(new URL("../experiments/ctrl-confirm-2/prereg.json", import.meta.url), "utf8"));
  assert.equal(p3.integrityContract, p2.integrityContract);
  assert.equal(p3.testIntegrityRule, p2.testIntegrityRule);
  assert.deepEqual(p3.arms.map(a => a.id), ["OC", "OCR", "PCR"]);
  assert.equal(p3.analysis.primaryUnitOutcome, p2.analysis.primaryUnitOutcome);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update((await import("node:fs")).readFileSync(new URL("../experiments/ctrl-confirm-2/variants/OCR.diff", import.meta.url))).digest("hex"), p3.identity.ocrPatchSha256);
});

test("feasibility gate: no launch when the required N is unreachable, supply is short or a budget ceiling is exceeded", async () => {
  const { gate, requiredN } = await import("../experiments/ctrl-confirm-3/gate.mjs");
  const prereg = { repeats: 3, budget: { maxRequestsTotal: 45000, maxActiveHours: 16 } };
  const row = (tasks, p) => ({ scenario: "latent:0.039", tasks, H1confirmed: { p } });
  const unreachable = { rows: [row(100, 0.1), row(300, 0.3)] };
  assert.equal(requiredN(unreachable), null);
  assert.equal(gate({ power: unreachable, prereg, sealedTasks: 500 }).launch, false);
  const cheap = { rows: [row(50, 0.5), row(80, 0.85)] };
  assert.equal(gate({ power: cheap, prereg, sealedTasks: 79 }).launch, false, "supply short");
  assert.equal(gate({ power: cheap, prereg, sealedTasks: 80 }).launch, true);
  const big = { rows: [row(400, 0.9)] };
  assert.equal(gate({ power: big, prereg, sealedTasks: 1000 }).checks.c_requests.pass, false, "request ceiling");
});

test("feasibility gate reproduced from the saved power files: blocked under BOTH recorded scenario readings (latent:0.039 and prereg.json scale:1)", async () => {
  const { readFileSync } = await import("node:fs");
  const { gate } = await import("../experiments/ctrl-confirm-3/gate.mjs");
  const { loadPrereg } = await import("../experiments/ctrl-confirm-3/lib.mjs");
  const { cost } = await import("../experiments/ctrl-confirm-3/power.mjs");
  const prereg = loadPrereg();
  const read = (f) => JSON.parse(readFileSync(new URL(`../records/ctrl-confirm-3/plan/${f}`, import.meta.url), "utf8"));
  const latent = gate({ power: read("power.json"), prereg, sealedTasks: 10_000, scenario: "latent:0.039" });
  assert.equal(latent.checks.a_powerReachable.nRequired, 800);
  assert.equal(latent.checks.c_requests.pass, false);
  assert.equal(latent.checks.d_activeHours.pass, false);
  assert.equal(latent.launch, false, "even with unlimited supply the budget gate fails");
  const scale = gate({ power: read("power-bootstrap-shrunk.json"), prereg, sealedTasks: 10_000, scenario: "scale:1" });
  assert.equal(scale.checks.a_powerReachable.nRequired, 1600);
  assert.equal(scale.launch, false);
  // The largest N affordable under the request ceiling is far below either N_req.
  let n = 1; while (cost(["OC", "OCR", "PCR"], n + 1).requests <= prereg.budget.maxRequestsTotal) n++;
  assert.ok(n < 800 && n < 1600, `affordable N ${n}`);
});
