#!/usr/bin/env node
// Empirical inputs of the design reassessment (confirmatory-1 v2, 2026-11-07; model-free, read-only). Extracts from runner ledgers
// (hash chain verified on a snapshot copy, never on the live file) per arm and task: final outcomes per repeat under THIS
// evaluator's estimand (record.task_success), unit classes (src/calibration.mjs unitClass), integrity violations, families,
// declared tier, and requests per unit. Sources:
//   --source name=PATH:ARM[,ARM...][:context-prefix]   e.g. confirm2=/.../runs.jsonl:OC,OCR,PC,PCR   cal=/.../runs.jsonl:stable
// Output: { sources: { name: { path, sha256, snapshotUnits, arms: { ARM: { tasks: { id: { family, hard, outcomes[], classes[] } },
// units, success, classes, integrityRuns, requestsPerUnit } } } } }.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { Ledger, sha256 } from "../../src/util.mjs";
import { unitClass } from "../../src/calibration.mjs";
import { retryable } from "../../src/metrics.mjs";

export function extract(path, arms, contextPrefix = "", scratch = tmpdir()) {
  const snap = join(scratch, `evidence-${process.pid}-${Date.now()}.jsonl`);
  copyFileSync(path, snap);
  // A live ledger may end in a torn line while being appended: keep only complete lines of the snapshot.
  const text = readFileSync(snap, "utf8"); const complete = text.slice(0, text.lastIndexOf("\n") + 1); writeFileSync(snap, complete);
  const ledger = new Ledger(snap);
  const chain = ledger.verify();
  if (chain.length) throw new Error(`${path}: chain broken in the snapshot: ${chain[0]}`);
  const final = new Map();
  for (const e of ledger.records()) {
    if (e.type !== "result") continue;
    const r = e.record;
    if (!arms.includes(r.candidate_id) || !String(r.context ?? "").startsWith(contextPrefix) || r.simulated) continue;
    const k = `${r.candidate_id}|${r.task_id}|${r.repeat}`;
    if (!final.has(k) || r.attempt >= final.get(k).attempt) final.set(k, r);
  }
  const out = {};
  for (const arm of arms) {
    const tasks = {}; const classes = {}; let units = 0, success = 0, integrityRuns = 0, requests = 0;
    for (const r of [...final.values()].filter(x => x.candidate_id === arm)) {
      const c = retryable(r) ? "censored" : unitClass(r);
      // Ids are pseudonymized (sha256 prefixes): another study's holdout ids are not copied into this study's files.
      const t = (tasks[`t:${sha256(String(r.task_id)).slice(0, 12)}`] ??= { family: `f:${sha256(String(r.family)).slice(0, 12)}`, hard: !!r.hard, outcomes: [], classes: [] });
      t.outcomes[r.repeat] = r.task_success ? 1 : 0; t.classes[r.repeat] = c;
      classes[c] = (classes[c] ?? 0) + 1; units++; success += r.task_success ? 1 : 0; requests += r.model_requests ?? 0;
      if ((r.integrity?.violations?.length ?? 0) > 0 || (r.integrity?.leakHits?.length ?? 0) > 0) integrityRuns++;
    }
    out[arm] = { tasks, units, success, classes, integrityRuns, requestsPerUnit: units ? requests / units : null };
  }
  return { path, sha256: sha256(complete), snapshotUnits: final.size, arms: out };
}

/** Merge extracts of disjoint ledgers into one source (tasks must not overlap). */
export function mergeExtracts(parts) {
  const arms = {};
  for (const p of parts) for (const [arm, a] of Object.entries(p.arms)) {
    const m = (arms[arm] ??= { tasks: {}, units: 0, success: 0, classes: {}, integrityRuns: 0, requests: 0 });
    for (const [id, t] of Object.entries(a.tasks)) { if (m.tasks[id]) throw new Error(`task ${id} in two merged ledgers`); m.tasks[id] = t; }
    m.units += a.units; m.success += a.success; m.integrityRuns += a.integrityRuns; m.requests += (a.requestsPerUnit ?? 0) * a.units;
    for (const [c, n] of Object.entries(a.classes)) m.classes[c] = (m.classes[c] ?? 0) + n;
  }
  for (const m of Object.values(arms)) { m.requestsPerUnit = m.units ? m.requests / m.units : null; delete m.requests; }
  return { path: parts.map(p => p.path).join("+"), sha256: parts.map(p => p.sha256).join("+"), snapshotUnits: parts.reduce((s, p) => s + p.snapshotUnits, 0), arms };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { source: { type: "string", multiple: true }, out: { type: "string" }, scratch: { type: "string" } } });
  const sources = {};
  for (const s of values.source ?? []) {
    const [name, rest] = [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)];
    const [path, arms, prefix] = rest.split(":");
    // PATH1+PATH2: one source over several ledgers (e.g. the two calibration batches); task ids never overlap across them.
    const parts = path.split("+").map(p => extract(p, arms.split(","), prefix ?? "", values.scratch ?? tmpdir()));
    sources[name] = parts.length === 1 ? parts[0] : mergeExtracts(parts);
  }
  const text = `${JSON.stringify({ schema: "pi-eval-loop/confirmatory-1-evidence@1", generatedAt: new Date().toISOString(), sources }, null, 1)}\n`;
  if (values.out) writeFileSync(values.out, text); else process.stdout.write(text);
}
