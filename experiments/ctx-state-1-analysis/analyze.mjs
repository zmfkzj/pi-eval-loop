#!/usr/bin/env node
// ctx-state-1 main analysis (preregistered in prereg-main.json): final records of the exactly-once ledger -> per-arm summaries,
// the four adjacent contrasts (task-cluster bootstrap CI + within-task sign-flip p, Holm), viability, and descriptive telemetry and
// trace fidelity per arm. Read-only over the state; writes analysis.json next to it.
//   node pi-eval-loop/experiments/ctx-state-1-analysis/analyze.mjs --state DIR --prereg FILE
//
// Location: written 2026-11-07T14:07:03Z, one minute after the main lock (14:06:02Z) and before the first main result
// (14:13:50Z). experiments/ctx-state-1/ is digested whole into every stage lock, so the script lives next to it rather than in it:
// the locked experiment stays byte-identical and the interrupted main campaign resumes under its original lock.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { INFRA, armSummary, contrast, holm, integrityFailOf, mean, tableOf, validOf, telemetrySummary } from "../ctx-state-1/lib.mjs";
import { stateFidelity } from "../ctx-state-1/fidelity.mjs";
import { stateAudit } from "./audit.mjs";

const CONTRASTS = [["M1", "M0"], ["M2", "M1"], ["M3", "M2"], ["M4", "M3"]];

/** A unit the evaluator reconciled after the controller was interrupted (no grading, no telemetry; counted as not successful). */
export const reconciledOf = (r) => /^controller interrupted/.test(String(r.terminal_detail ?? ""));

/**
 * Exact two-sided within-task sign-flip p of the mean per-task difference: all 2^T sign patterns (T tasks), counting patterns whose
 * |mean| is at least the observed |mean|. With T = 7 the smallest attainable p is 2/128.
 */
export function exactSignFlip(diffs) {
  const T = diffs.length;
  if (!T) return { p: 1, patterns: 0, minP: 1 };
  const obs = Math.abs(diffs.reduce((s, d) => s + d, 0) / T);
  let hits = 0;
  for (let mask = 0; mask < 2 ** T; mask++) {
    let s = 0;
    for (let i = 0; i < T; i++) s += (mask >> i) & 1 ? -diffs[i] : diffs[i];
    if (Math.abs(s / T) >= obs - 1e-12) hits++;
  }
  return { p: hits / 2 ** T, patterns: 2 ** T, minP: 2 / 2 ** T };
}

/**
 * Explicitly paired cells of arms a and b: (task, repeat) where BOTH have a usable final record. Returns per-task lists of a's and
 * b's outcomes over the complete pairs only, and the cells missing on either side.
 */
export function pairedTables(usable, a, b, metric) {
  const cell = (arm) => new Map(usable.filter(r => r.candidate_id === arm).map(r => [`${r.task_id}#${r.repeat}`, metric(r) ? 1 : 0]));
  const A = cell(a), B = cell(b);
  const ta = {}, tb = {}, missing = [];
  for (const key of new Set([...A.keys(), ...B.keys()])) {
    if (!A.has(key) || !B.has(key)) { missing.push({ cell: key, has: A.has(key) ? a : b }); continue; }
    const task = key.split("#")[0];
    (ta[task] ??= []).push(A.get(key)); (tb[task] ??= []).push(B.get(key));
  }
  return { a: ta, b: tb, pairs: Object.values(ta).reduce((s, xs) => s + xs.length, 0), missing };
}

export function finalRecords(stateDir) {
  const byKey = new Map();
  for (const line of readFileSync(join(stateDir, "runs.jsonl"), "utf8").split("\n").filter(Boolean)) {
    const e = JSON.parse(line);
    if (e.type === "result") byKey.set(e.unit_key, e.record);
  }
  return [...byKey.values()];
}

export function analyze(records, prereg, fidelity = [], audit = []) {
  const usable = records.filter(r => !INFRA.has(r.terminal_status));
  const table = tableOf(usable, validOf);
  const arms = prereg.arms.map(a => a.id);
  const summary = Object.fromEntries(arms.map(id => {
    const rs = usable.filter(r => r.candidate_id === id), fid = fidelity.filter(u => u.arm === id);
    return [id, {
      ...armSummary(table[id] ?? {}),
      infra: records.filter(r => r.candidate_id === id && INFRA.has(r.terminal_status)).length,
      // Reconciled after the controller interruption: not graded, no telemetry (their regressions/critical counts are UNKNOWN, not 0).
      reconciled: rs.filter(reconciledOf).map(r => `${r.task_id}#${r.repeat}`), withoutTelemetry: rs.filter(r => !r.telemetry).length,
      integrityFailures: rs.filter(integrityFailOf).length, hiddenPass: rs.filter(r => r.hidden_test_pass).length,
      regressions: rs.reduce((s, r) => s + (r.regression_count ?? 0), 0), critical: rs.reduce((s, r) => s + (r.critical_failure_count ?? 0), 0),
      terminal: rs.reduce((acc, r) => { acc[r.terminal_status] = (acc[r.terminal_status] ?? 0) + 1; return acc; }, {}),
      requests: rs.reduce((s, r) => s + (r.model_requests ?? 0), 0), meanWallS: Math.round(mean(rs.map(r => r.wall_time ?? 0)) / 1000),
      telemetry: telemetrySummary(rs),
      fidelity: {
        units: fid.length, ledgerUnits: fid.filter(u => u.observed.ledgerEvents > 0).length, efforts: [...new Set(fid.flatMap(u => u.observed.efforts))],
        earlyCompactions: fid.reduce((s, u) => s + u.observed.earlyCompactions, 0), referencesValid: fid.reduce((s, u) => s + u.observed.references.filter(x => x === "valid").length, 0),
        referencesOther: fid.reduce((s, u) => s + u.observed.references.filter(x => x && x !== "valid").length, 0),
        cancelled: fid.flatMap(u => u.observed.cancelled), subWorkerCompactions: fid.reduce((s, u) => s + u.observed.subWorkerCompactions, 0), spawned: fid.reduce((s, u) => s + (u.observed.spawns ?? 0), 0),
        heuristicTranscriptCallsOk: fid.reduce((s, u) => s + u.observed.retrieval.filter(x => x.ok).length, 0),
      },
      audit: (() => {
        const a = audit.filter(u => u.arm === id);
        return {
          units: a.length, transcriptCalls: a.reduce((s, u) => s + u.transcriptCalls, 0), verifiedReads: a.reduce((s, u) => s + u.verifiedReads, 0),
          unitsWithVerifiedRead: a.filter(u => u.verifiedReads > 0).length, verifiedReadsAfterOwnCompaction: a.reduce((s, u) => s + u.verifiedReadsAfterOwnCompaction, 0),
          heuristicOnly: a.reduce((s, u) => s + u.heuristicOnly, 0), batchIdRetrievedFromTranscript: a.filter(u => u.batchIdRetrieved).length,
          handovers: a.reduce((s, u) => s + u.handovers, 0), handoversWithVerifiedRead: a.reduce((s, u) => s + u.handoversWithVerifiedRead, 0),
          ledgerBriefings: a.reduce((s, u) => s + u.assignments.filter(x => x.ledgerBriefing).length, 0),
          unitsWithSubWorkers: a.filter(u => u.subWorkerSessions > 0).length, unitsWithSubWorkersValid: a.filter(u => u.subWorkerSessions > 0 && u.success).length,
          subWorkerSessions: a.reduce((s, u) => s + u.subWorkerSessions, 0), subWorkerCompactionEntries: a.reduce((s, u) => s + u.subWorkerCompactionEntries, 0),
        };
      })(),
      s1: (() => {
        const s = fid.filter(u => u.task === "s1-amended-billing");
        return { units: s.length, allTurnsCompleted: s.filter(u => (u.turns ?? []).length === 3 && u.turns.every(t => t.status === "completed")).length, workerPerTurn: s.map(u => u.observed.mainTurns.map(t => t.orcheTaskCalls).join("/")), valid: s.filter(u => u.success).length, hiddenPass: s.filter(u => u.hidden).length, failingHidden: s.flatMap(u => u.failingHidden) };
      })(),
    }];
  }));
  // As written before the first result (ctrl-ablation-1 contrast(): Monte Carlo sign-flip p, per-arm repeat means): kept for
  // transparency. The preregistration text says "paired by (task, repeat)" and "exact within-task sign-flip": contrastsPaired
  // implements that literally and is the one the verdict uses.
  const pairs = CONTRASTS.filter(([a, b]) => table[a] && table[b]);
  const contrasts = Object.fromEntries(pairs.map(([a, b]) => [`${a}-${b}`, contrast(table[a], table[b], { seed: `${prereg.seed}:${a}-${b}` })]));
  const adjusted = holm(Object.fromEntries(Object.entries(contrasts).map(([k, c]) => [k, c.p])));
  for (const [k, c] of Object.entries(contrasts)) {
    const [a, b] = k.split("-");
    c.pHolm = adjusted[k];
    c.viable = c.dRateCI[0] > 0 && c.pHolm < 0.05 && summary[a].critical <= summary[b].critical;
    c.verdict = c.viable ? "VIABLE" : "INCONCLUSIVE";
  }
  const contrastsPaired = Object.fromEntries(CONTRASTS.map(([a, b]) => {
    const p = pairedTables(usable, a, b, validOf);
    const boot = contrast(p.a, p.b, { seed: `${prereg.seed}:${a}-${b}:paired`, perms: 1 });
    const tasks = Object.keys(p.a).sort();
    const diffs = tasks.map(t => mean(p.a[t]) - mean(p.b[t]));
    const exact = exactSignFlip(diffs);
    return [`${a}-${b}`, { pairs: p.pairs, missingCells: p.missing, tasks: tasks.length, dRate: mean(diffs), dRateCI: boot.dRateCI, better: boot.better, worse: boot.worse, pExact: exact.p, minAttainableP: exact.minP, minAttainablePHolm: Math.min(1, CONTRASTS.length * exact.minP) }];
  }));
  const adjustedPaired = holm(Object.fromEntries(Object.entries(contrastsPaired).map(([k, c]) => [k, c.pExact])));
  for (const [k, c] of Object.entries(contrastsPaired)) {
    const [a, b] = k.split("-");
    c.pHolm = adjustedPaired[k];
    c.viable = c.missingCells.length === 0 && c.dRateCI[0] > 0 && c.pHolm < 0.05 && summary[a].critical <= summary[b].critical;
    c.verdict = c.viable ? "VIABLE" : "INCONCLUSIVE";
  }
  // Descriptive sensitivity (NOT a decision input): the same paired rates without the units reconciled after the interruption.
  const sensitivity = Object.fromEntries(CONTRASTS.map(([a, b]) => {
    const p = pairedTables(usable.filter(r => !reconciledOf(r)), a, b, validOf);
    const tasks = Object.keys(p.a).sort();
    const diffs = tasks.map(t => mean(p.a[t]) - mean(p.b[t]));
    return [`${a}-${b}`, { pairs: p.pairs, dRate: mean(diffs), pExact: exactSignFlip(diffs).p }];
  }));
  const infraRate = records.length ? records.filter(r => INFRA.has(r.terminal_status)).length / records.length : 0;
  return {
    records: records.length, usable: usable.length, infraRate, maxInfraRate: prereg.budget?.maxInfraRate ?? null,
    reconciled: records.filter(reconciledOf).map(r => ({ arm: r.candidate_id, task: r.task_id, repeat: r.repeat, terminal: r.terminal_status, detail: r.terminal_detail })),
    summary, contrasts, contrastsPaired, sensitivityWithoutReconciled: sensitivity,
    anyViable: Object.values(contrastsPaired).some(c => c.viable),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, prereg: { type: "string" } } });
  const stateDir = resolve(values.state);
  const prereg = JSON.parse(readFileSync(resolve(values.prereg), "utf8"));
  // Always recomputed from the evidence (a stored fidelity.json may predate the last units).
  const fidelity = stateFidelity(stateDir), audit = stateAudit(stateDir);
  writeFileSync(join(stateDir, "fidelity.json"), `${JSON.stringify(fidelity, null, 2)}\n`);
  writeFileSync(join(stateDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
  const result = analyze(finalRecords(stateDir), prereg, fidelity, audit);
  writeFileSync(join(stateDir, "analysis.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ records: result.records, infraRate: result.infraRate, reconciled: result.reconciled.length, summary: Object.fromEntries(Object.entries(result.summary).map(([k, v]) => [k, { successes: v.successes, units: v.units, rate: v.rate, integrityFailures: v.integrityFailures, critical: v.critical, reconciled: v.reconciled }])), contrastsPaired: result.contrastsPaired, anyViable: result.anyViable }, null, 1)}\n`);
}
