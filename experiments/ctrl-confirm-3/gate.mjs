#!/usr/bin/env node
// ctrl-confirm-3 feasibility gate (prereg.json feasibilityGate), evaluated BEFORE any confirmation unit and without any new
// outcome: planned power (power.json), sealed fresh supply (ELIGIBILITY.json) and the finite budget.
//   node pi-eval-loop/experiments/ctrl-confirm-3/gate.mjs --power FILE [--eligibility FILE] [--out FILE]
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cost } from "./power.mjs";

export const GATE_ARMS = ["OC", "OCR", "PCR"];
/** Primary planning scenario: shared-latent model at the ctrl-confirm-2 E1 point estimate (+3.9 pt; optimistic for a follow-up). */
export const PRIMARY_SCENARIO = "latent:0.039";

/** Smallest simulated N whose H1 power under `scenario` is >= target (null when none in the simulated range). */
export function requiredN(power, scenario = PRIMARY_SCENARIO, target = 0.8) {
  const rows = power.rows.filter(r => r.scenario === scenario).sort((a, b) => a.tasks - b.tasks);
  return rows.find(r => r.H1confirmed.p >= target)?.tasks ?? null;
}

export function gate({ power, prereg, sealedTasks = null, concurrency = 8, scenario = PRIMARY_SCENARIO }) {
  const nReq = requiredN(power, scenario);
  const at = (n) => (n ? cost(GATE_ARMS, n, prereg.repeats, concurrency) : null);
  const maxN = Math.max(...power.rows.map(r => r.tasks));
  const checks = {
    a_powerReachable: { pass: nReq !== null, scenario, nRequired: nReq, note: nReq === null ? `H1 power under ${scenario} stays below 0.80 up to the largest simulated N = ${maxN}` : undefined },
    b_supply: { pass: nReq !== null && sealedTasks !== null && sealedTasks >= nReq, sealedTasks },
    c_requests: { pass: nReq !== null && at(nReq).requests <= prereg.budget.maxRequestsTotal, planned: at(nReq)?.requests ?? `> ${at(maxN).requests} (cost at N = ${maxN})`, ceiling: prereg.budget.maxRequestsTotal },
    d_activeHours: { pass: nReq !== null && at(nReq).activeHours <= prereg.budget.maxActiveHours, planned: at(nReq)?.activeHours ?? `> ${at(maxN).activeHours} (at N = ${maxN})`, ceiling: prereg.budget.maxActiveHours },
  };
  const powerAt = (n) => Object.fromEntries(power.rows.filter(r => r.tasks === n).map(r => [r.scenario, r.H1confirmed.p]));
  const feasibleN = sealedTasks ? power.rows.map(r => r.tasks).filter(n => n <= sealedTasks).sort((a, b) => b - a)[0] ?? null : null;
  return { launch: Object.values(checks).every(c => c.pass), checks, reference: { costAtSealed: sealedTasks ? cost(GATE_ARMS, sealedTasks, prereg.repeats, concurrency) : null, powerAtLargestSimulatedNWithinSupply: feasibleN ? { tasks: feasibleN, H1: powerAt(feasibleN) } : null } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { power: { type: "string" }, eligibility: { type: "string" }, out: { type: "string" }, scenario: { type: "string", default: PRIMARY_SCENARIO } } });
  const { loadPrereg } = await import("./lib.mjs");
  const power = JSON.parse(readFileSync(values.power, "utf8"));
  const sealedTasks = values.eligibility ? JSON.parse(readFileSync(values.eligibility, "utf8")).tasks : null;
  const g = { at: new Date().toISOString(), powerFile: values.power, eligibilityFile: values.eligibility ?? null, ...gate({ power, prereg: loadPrereg(), sealedTasks, scenario: values.scenario }) };
  const text = `${JSON.stringify(g, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, text);
  process.stdout.write(text);
}
