#!/usr/bin/env node
// ctrl-confirm-4 feasibility gate (PREREGISTRATION.md §6), evaluated before any confirmation unit. Binds every input by digest:
// the preregistration, the power file (and its simulation configuration), every sealed batch (seal re-verified, 0 uses verified)
// and the realized family composition. The required N is read from the power rows simulated WITH the realized composition.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/gate.mjs --power FILE --batch DIR [--batch DIR ...] --out FILE
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { holdoutLedger, loadLocal, verifySeal } from "../../src/datasets.mjs";
import { digestOf, sha256 } from "../../src/util.mjs";
import { requiredN } from "./power.mjs";
import { costOf } from "./resources.mjs";
import { loadPrereg } from "./lib.mjs";

/** Planned resources of a design (ctrl-confirm-2 measured per-unit rates of the planned arms, all attempts). */
export function planned(prereg, tasks) {
  const units = prereg.arms.length * tasks * prereg.repeats, per = tasks * prereg.repeats;
  const sum = (k) => prereg.arms.reduce((s, a) => s + prereg.resources.ratesPerUnit[a.id][k] * per, 0);
  const usage = { requests: Math.round(sum("requests")), input: Math.round(sum("input")), cached: Math.round(sum("cached")), cacheWrite: 0, output: Math.round(sum("output")) };
  const activeHours = sum("minutes") / 60 / prereg.parallelism;
  return { tasks, units, ...usage, activeHours: Math.round(activeHours * 10) / 10, costUsdCached: Math.round(costOf(usage, prereg.pricing) * 100) / 100, costUsdNoCache: Math.round(costOf({ ...usage, cached: 0 }, prereg.pricing) * 100) / 100, costUsdAllCacheWrite: Math.round(costOf({ ...usage, cacheWrite: usage.input - usage.cached }, prereg.pricing) * 100) / 100 };
}

/** Sealed batches: seal digest re-computed, zero uses, tasks and family composition. */
export function batchesOf(dirs) {
  return dirs.map(dir => {
    const seal = verifySeal(dir);
    const uses = holdoutLedger(dir).records().length;
    const tasks = seal.ok ? loadLocal(dir).map(t => ({ id: t.id, family: t.family, external: t.provenance === "external", hidden: Boolean(t.hidden) })) : [];
    return { dir, sealOk: seal.ok, sealDigest: seal.seal?.digest ?? null, uses, tasks };
  });
}

/**
 * Design selection (only after a passed preliminary gate): N tasks from the union of fresh batches in sha256(seed:id) order with at
 * most 3 per family and 6 per owner; candidate-blind (ids and families only, no outcome exists).
 */
export function designSelection(batches, n, { seed = "ctrl-confirm-4/design", maxPerFamily = 3, maxPerOwner = 6 } = {}) {
  const pool = batches.filter(x => x.sealOk && x.uses === 0).flatMap(x => x.tasks.map(t => ({ ...t, batch: x.dir }))).filter(t => t.external && t.hidden);
  const perFamily = {}, perOwner = {}, picked = [];
  for (const t of pool.sort((a, b) => sha256(`${seed}:${a.id}`).localeCompare(sha256(`${seed}:${b.id}`)))) {
    const owner = String(t.family).replace(/^gh:/, "").split("/")[0];
    if (picked.length >= n || (perFamily[t.family] ?? 0) >= maxPerFamily || (perOwner[owner] ?? 0) >= maxPerOwner) continue;
    picked.push(t); perFamily[t.family] = (perFamily[t.family] ?? 0) + 1; perOwner[owner] = (perOwner[owner] ?? 0) + 1;
  }
  return picked.length === n ? picked : null;
}

export function gate({ prereg, power, powerSha256, batches }) {
  const g = prereg.feasibilityGate, b = prereg.budget, m = g.margin;
  const fresh = batches.filter(x => x.sealOk && x.uses === 0);
  const tasks = fresh.flatMap(x => x.tasks).filter(t => t.external && t.hidden);
  const families = [...new Set(tasks.map(t => t.family))];
  const sizes = families.map(f => tasks.filter(t => t.family === f).length).sort((a, c) => c - a);
  const composition = JSON.stringify(power.config.composition?.sizes ?? null) === JSON.stringify([...sizes].sort((a, c) => a - c)) ? "realized-sizes" : null;
  const nReq = composition ? requiredN(power.rows, g.primaryScenario, { target: g.powerTarget, composition }) : null;
  const plan = nReq ? planned(prereg, nReq) : null;
  const checks = {
    a_powerReachable: { pass: nReq !== null, scenario: g.primaryScenario, rule: "smallest grid N whose H1 power Wilson 95% lower bound >= target, simulated with the realized family composition", compositionBound: composition !== null, nRequired: nReq },
    b_supply: { pass: nReq !== null && tasks.length >= nReq, sealedFresh: tasks.length, families: families.length, batches: batches.map(x => ({ dir: x.dir, sealOk: x.sealOk, sealDigest: x.sealDigest, uses: x.uses, tasks: x.tasks.length })) },
    c_requests: { pass: !!plan && plan.requests * m <= b.maxRequestsTotal, planned: plan?.requests ?? null, withMargin: plan ? Math.round(plan.requests * m) : null, ceiling: b.maxRequestsTotal },
    d_activeHours: { pass: !!plan && plan.activeHours * m <= b.maxActiveHours, planned: plan?.activeHours ?? null, ceiling: b.maxActiveHours },
    e_tokens: { pass: !!plan && plan.input * m <= b.maxInputTokens && plan.output * m <= b.maxOutputTokens, plannedInput: plan?.input ?? null, plannedOutput: plan?.output ?? null, ceilings: [b.maxInputTokens, b.maxOutputTokens] },
    f_costApiEquivalent: { pass: !!plan && plan.costUsdCached * m <= b.maxCostUsdApiEquivalent, plannedCached: plan?.costUsdCached ?? null, plannedNoCache: plan?.costUsdNoCache ?? null, ceiling: b.maxCostUsdApiEquivalent },
  };
  const sensitivity = nReq ? power.rows.filter(r => r.tasks === nReq && r.composition === composition).map(r => ({ scenario: r.scenario, H1: r.H1confirmed.p, wilson95: r.H1confirmed.wilson95 })) : [];
  return { launch: Object.values(checks).every(c => c.pass), checks, sensitivityAtNRequired: sensitivity, planned: plan, composition: { tasks: tasks.length, families: families.length, sizes }, bindings: { preregDigest: digestOf(prereg), powerSha256, powerConfigDigest: power.configDigest, batches: batches.map(x => ({ dir: x.dir, sealDigest: x.sealDigest, uses: x.uses })) } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { power: { type: "string" }, batch: { type: "string", multiple: true }, out: { type: "string" }, prereg: { type: "string" } } });
  const text = readFileSync(values.power);
  const g = { at: new Date().toISOString(), powerFile: values.power, ...gate({ prereg: loadPrereg(values.prereg), power: JSON.parse(text), powerSha256: sha256(text), batches: batchesOf(values.batch ?? []) }) };
  const out = `${JSON.stringify(g, null, 1)}\n`;
  if (values.out) writeFileSync(values.out, out);
  process.stdout.write(`${JSON.stringify({ launch: g.launch, nRequired: g.checks.a_powerReachable.nRequired, sealedFresh: g.checks.b_supply.sealedFresh, failed: Object.entries(g.checks).filter(([, c]) => !c.pass).map(([k]) => k) })}\n`);
}
