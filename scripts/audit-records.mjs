#!/usr/bin/env node
// Machine-readable audit of a committed A/B/C record directory, recomputed from the raw ledgers only (never from generated
// reports): exact success counts and rates per arm/split (final attempt per unit), distinct real attempts across trajectories
// (B and C ledgers carry copies of the shared baseline units, so per-ledger sums double-count), measured execution
// opportunities (allowed vs actual attempts, requests, tokens), integrity-violation runs, search stops, candidate outcomes,
// selection, deployment verdicts and holdout consumption.
// Usage: node pi-eval-loop/scripts/audit-records.mjs <records-dir> [out.json]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const lines = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const rate = (s, n) => ({ successes: s, runs: n, rate: n ? s / n : null, percent: n ? Number((100 * s / n).toFixed(4)) : null });

/** @param {string} dir records directory with A/, B/, C/ */
export function auditRecords(dir) {
  const arms = ["A", "B", "C"].filter(a => existsSync(join(dir, a, "runs.jsonl")));
  const attempts = new Map();
  const perLedger = {};
  for (const a of arms) {
    const results = lines(join(dir, a, "runs.jsonl")).filter(e => e.type === "result").map(e => e.record);
    perLedger[a] = results.length;
    for (const r of results) attempts.set(`${r.unit_key}#${r.attempt}`, r);
  }
  const all = [...attempts.values()];
  const finals = new Map();
  for (const r of all) { const p = finals.get(r.unit_key); if (!p || r.attempt >= p.attempt) finals.set(r.unit_key, r); }
  const lock = readJson(join(dir, "A", "protocol.lock.json"));
  const k = lock.protocol?.baselines?.multiAttempt?.k ?? 1;
  const groups = {};
  for (const r of finals.values()) {
    const g = (groups[`${r.candidate_id}|${r.split}`] ??= { candidate: r.candidate_id, split: r.split, units: 0, successes: 0, attempts: 0, requests: 0, inputTokens: 0, outputTokens: 0, integrityViolationRuns: 0, leakRuns: 0 });
    g.units++; g.successes += r.task_success ? 1 : 0; g.attempts += r.attempts_used ?? 1; g.requests += r.model_requests ?? 0;
    g.inputTokens += r.input_tokens ?? 0; g.outputTokens += r.output_tokens ?? 0;
    g.integrityViolationRuns += r.integrity?.violations?.length ? 1 : 0; g.leakRuns += r.integrity?.leakHits?.length ? 1 : 0;
  }
  const cells = Object.values(groups).map(g => ({ ...g, ...rate(g.successes, g.units), allowedAttemptsPerUnit: g.candidate.startsWith("multi") ? k : 1, actualAttemptsPerUnit: g.attempts / g.units }));
  const ref = (split) => cells.find(c => c.candidate === "stable" && c.split === split);
  for (const c of cells) { const s = ref(c.split); c.requestsVsStable = s ? c.requests / s.requests : null; c.inputTokensVsStable = s ? c.inputTokens / s.inputTokens : null; }
  cells.sort((x, y) => (x.candidate + x.split).localeCompare(y.candidate + y.split));
  const trajectories = {};
  for (const a of arms) {
    const state = readJson(join(dir, a, "state.json"));
    const candDir = join(dir, a, "candidates");
    const candidates = existsSync(candDir) ? readdirSync(candDir).filter(id => existsSync(join(candDir, id, "candidate.json"))).map(id => readJson(join(candDir, id, "candidate.json"))).filter(c => c.origin === "proposer") : [];
    trajectories[a] = {
      phase: state.phase, strategy: state.strategy, searchStop: state.searchStop ?? null, counters: state.counters,
      candidates: candidates.map(c => ({ id: c.id, parent: c.parent, status: c.status, target: c.target ?? null, lastDecision: c.decisions?.at(-1)?.reason?.slice(0, 200) ?? null })),
      selection: state.selection?.selected ?? null, verdict: state.final?.verdict ?? null, adopt: state.final?.adopt ?? false,
    };
  }
  const ablation = existsSync(join(dir, "ablation.json")) ? readJson(join(dir, "ablation.json")) : null;
  return {
    records: basename(resolve(dir)), protocolVersion: lock.protocol?.version, protocolDigest: lock.protocolDigest,
    route: [...new Set(all.map(r => `${r.model_route}|${r.thinking_effort}`))], environmentDigests: [...new Set(all.map(r => r.environment_digest))],
    distinctAttempts: all.length, perLedgerResultRecords: perLedger, simulatedAttempts: all.filter(r => r.simulated).length,
    holdoutAttempts: all.filter(r => r.split === "holdout").length, splits: [...new Set(all.map(r => r.split))].sort(),
    multiAttemptK: k, cells, trajectories,
    ablation: ablation && { explorationOnly: ablation.explorationOnly ?? false, holdoutUses: ablation.holdoutUses, verdict: ablation.adoption?.verdict ?? null, adopt: ablation.adoption?.adopt ?? false, finals: Object.fromEntries(Object.entries(ablation.arms).map(([k2, v]) => [k2, v.id])) },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error("usage: audit-records.mjs <records-dir> [out.json]"); process.exit(2); }
  const audit = auditRecords(dir);
  const text = JSON.stringify(audit, null, 2) + "\n";
  if (out) writeFileSync(out, text); else process.stdout.write(text);
}
