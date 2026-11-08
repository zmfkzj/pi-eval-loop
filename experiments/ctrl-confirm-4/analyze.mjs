#!/usr/bin/env node
// ctrl-confirm-4 frozen analysis (PREREGISTRATION.md §5): final attempt per scheduled unit -> legacy-valid design tables ->
// ctrl-confirm-3 stats.mjs hierarchy (exact family sign-flip, E1 AND E2, H2 only after a CONFIRMED H1) with intervals and the
// CI/decision agreement check; strict and functional as sensitivity; provider-interrupted attempts scored as failures as a
// sensitivity; resources from the resource ledger. Missing units are failures (complete design required for CONFIRMED).
//   node pi-eval-loop/experiments/ctrl-confirm-4/analyze.mjs --state DIR
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Ledger, digestOf } from "../../src/util.mjs";
import { armSummary, designTable } from "../ctrl-confirm-2/lib.mjs";
import { adoption, functionalOf, hierarchy, legacyValid, loadPrereg, strictValid } from "./lib.mjs";
import { ChainLedger, providerFailure } from "./resources.mjs";

const n = (xs) => (Array.isArray(xs) ? xs.length : 0);
const CRITICAL = new Set(["harness_crash", "route_violation"]);

/** Final (last) result per unit key, and the first provider-interrupted attempt per unit (for the sensitivity). */
export function finalRecords(stateDir) {
  const ledger = new Ledger(join(stateDir, "runs.jsonl"));
  const bad = ledger.verify();
  if (bad.length) throw new Error(`ledger damaged: ${bad.join("; ")}`);
  const last = new Map(), provider = new Map();
  for (const e of ledger.records()) if (e.type === "result") { last.set(e.unit_key, e.record); if (providerFailure(e.record) && !provider.has(e.unit_key)) provider.set(e.unit_key, e.record); }
  return { final: [...last.values()], providerFirst: provider };
}

export function analyze({ final, providerFirst }, prereg, { tasks, familyOf }) {
  const arms = prereg.arms.map(a => a.id), design = { arms, tasks, repeats: prereg.repeats };
  const tables = (metric, recs = final) => designTable(recs, metric, design);
  const legacy = tables(legacyValid), strict = tables(strictValid), functional = tables(functionalOf);
  const complete = legacy.missing.length === 0;
  const h = (t) => hierarchy(t.table, familyOf, { complete, ci: true });
  const primary = h(legacy);
  const summary = Object.fromEntries(arms.map(a => { const rs = final.filter(r => r.candidate_id === a); return [a, { legacy: armSummary(legacy.table[a]), strict: armSummary(strict.table[a]), functional: armSummary(functional.table[a]), legacyFail: rs.filter(r => n(r.integrity?.legacyViolations) > 0).length, strictFail: rs.filter(r => n(r.integrity?.strictTestViolations) > 0).length, leaks: rs.filter(r => n(r.integrity?.leakHits) > 0).length, critical: rs.filter(r => CRITICAL.has(r.terminal_status)).length, terminal: rs.reduce((m, r) => ({ ...m, [r.terminal_status]: (m[r.terminal_status] ?? 0) + 1 }), {}) }]; }));
  const families = {};
  for (const t of tasks) { const f = (families[familyOf[t]] ??= {}); for (const a of arms) { const x = (f[a] ??= { units: 0, valid: 0 }); x.units += legacy.table[a][t].length; x.valid += legacy.table[a][t].reduce((s, v) => s + v, 0); } }
  const familyRegressions = Object.entries(families).filter(([, f]) => f.OCR.valid / f.OCR.units < f.OC.valid / f.OC.units).map(([k]) => k).sort();
  const functionalDelta = summary.OCR.functional.rate - summary.OC.functional.rate;
  const verdict = adoption({ decision: primary.H1.decision, candidate: summary.OCR, control: summary.OC, familyRegressions, functionalDelta });
  const providerScored = final.map(r => providerFirst.get(r.unit_key) ?? r);
  return { complete, missing: legacy.missing, design: { ...design, scheduled: arms.length * tasks.length * prereg.repeats }, units: final.length, primary, verdict, summary, familyRegressions, sensitivity: { strict: h(strict), functional: h(functional), providerInterruptedAsFailure: { units: providerFirst.size, result: h(tables(legacyValid, providerScored)) } }, perTask: legacy.table };
}

/**
 * Resource / use audit of a state (read-only): resource-ledger chain, open reservations, consumption vs ceilings, and the holdout
 * use records of every preregistered batch (exactly one use each, by THIS state and preregistration).
 */
export function auditState(stateDir, prereg, { datasetsRoot, holdoutLedger }) {
  const resources = new ChainLedger(join(stateDir, "resources.jsonl"));
  const chain = resources.verify();
  const open = new Map(), consumed = { requests: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, costUsd: 0 };
  for (const e of resources.records()) {
    if (e.type === "reserve") open.set(e.attemptId, e);
    else if (e.type === "settle") { open.delete(e.attemptId); for (const k of Object.keys(consumed)) consumed[k] += e.usage?.[k] ?? 0; }
  }
  const b = prereg.budget;
  const withinCeilings = consumed.requests <= b.maxRequestsTotal && consumed.input <= b.maxInputTokens && consumed.output <= b.maxOutputTokens && consumed.costUsd <= b.maxCostUsdApiEquivalent;
  const uses = prereg.holdout.batches.map(x => {
    const recs = holdoutLedger(resolve(datasetsRoot, x.path)).records();
    return { path: x.path, uses: recs.length, byThisState: recs.filter(u => u.stateDir === resolve(stateDir) && u.preregDigest === digestOf(prereg)).length };
  });
  // A3: a runtime change seen AFTER an attempt (mid-unit) taints the evidence (audit not ok); one caught before a dispatch does not.
  const drifts = resources.records().filter(e => e.type === "runtime-drift").map(e => ({ phase: e.phase, at: e.at, attemptId: e.attemptId, detail: e.detail }));
  const midUnitDrifts = drifts.filter(d => d.phase === "mid-unit").length;
  const cont = existsSync(join(stateDir, "continuation.json")) ? JSON.parse(readFileSync(join(stateDir, "continuation.json"), "utf8")) : null;
  const continuation = cont ? { versions: cont.versions.map(v => ({ version: v.version, at: v.at, hash: v.hash, envDigest: v.binding?.envDigest, runtime: v.binding?.runtime?.manifestDigest ?? null, resultRecordsAtVersion: v.facts?.resultRecords ?? null })) } : null;
  const ok = chain.length === 0 && open.size === 0 && withinCeilings && uses.every(u => u.uses === 1 && u.byThisState === 1) && midUnitDrifts === 0;
  return { ok, resourceChain: chain, openReservations: open.size, consumed, withinCeilings, holdoutUses: uses, runtimeDrifts: drifts, midUnitDrifts, continuation };
}

/** The frozen analysis of a state + its audit, written to analysis.json (deterministic apart from the timestamp). */
export async function analyzeState(stateDir, prereg) {
  const lock = JSON.parse(readFileSync(join(stateDir, "lock.json"), "utf8"));
  if (lock.preregDigest !== digestOf(prereg)) throw new Error("prereg differs from the state's lock");
  const queue = JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8"));
  const tasks = [...new Set(queue.map(u => u.task))].sort();
  const { loadLocal, holdoutLedger } = await import("../../src/datasets.mjs");
  const { UMBRELLA } = await import("../../src/protocol.mjs");
  const datasetsRoot = resolve(UMBRELLA, "results");
  const familyOf = {};
  for (const b of prereg.holdout.batches) for (const t of loadLocal(resolve(datasetsRoot, b.path))) familyOf[t.id] = t.family;
  for (const t of tasks) if (!familyOf[t]) throw new Error(`no family for ${t}`);
  const audit = auditState(stateDir, prereg, { datasetsRoot, holdoutLedger });
  if (audit.resourceChain.length) throw new Error("resource ledger damaged");
  const a = { at: new Date().toISOString(), preregDigest: lock.preregDigest, queueDigest: lock.queueDigest, audit, ...analyze(finalRecords(stateDir), prereg, { tasks, familyOf }) };
  writeFileSync(join(stateDir, "analysis.json"), `${JSON.stringify(a, null, 2)}\n`);
  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, prereg: { type: "string" } } });
  const a = await analyzeState(resolve(values.state), loadPrereg(values.prereg));
  process.stdout.write(`${JSON.stringify({ H1: a.primary.H1.decision.verdict, H2: a.primary.H2?.decision.verdict, adoption: a.verdict.verdict, complete: a.complete, auditOk: a.audit.ok })}\n`);
}
