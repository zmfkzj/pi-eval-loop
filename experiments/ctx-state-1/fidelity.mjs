#!/usr/bin/env node
// ctx-state-1 trace fidelity: did each arm's settings really apply in the runs? Read-only over a state's evidence (record.json, the
// proxy's wire journal, the captured transcripts). Never decides an outcome; it reports what the traces show.
//   node pi-eval-loop/experiments/ctx-state-1/fidelity.mjs --state DIR
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const lines = (path) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean) : [];
const walk = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).map(f => join(dir, f)) : [];

/** Trace facts of one unit's evidence directory. */
export function unitFidelity(dir) {
  const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
  const files = walk(join(dir, "transcripts"));
  const wire = readdirSync(dir).filter(f => /^wire-.*\.jsonl$/.test(f)).flatMap(f => lines(join(dir, f)));
  const efforts = [...new Set(wire.filter(e => e.phase === "end" && e.method === "POST").map(e => String(e.effort)))];
  const models = [...new Set(wire.filter(e => e.phase === "end" && e.method === "POST").map(e => String(e.respModel ?? e.model)))];
  const mainSession = files.filter(f => /\/sessions\/[^/]+\.jsonl$/.test(f)).flatMap(lines);
  const ledgerEvents = mainSession.filter(e => e.type === "custom" && e.customType === "orche-ledger").map(e => e.data?.event);
  const events = files.filter(f => f.endsWith("events.jsonl")).flatMap(lines);
  const plans = events.filter(e => e.type === "task_plan");
  const lastPlan = plans.at(-1)?.plan;
  const checkpoints = (lastPlan?.nodes ?? []).filter(n => n.checkpoint);
  const workerTexts = files.filter(f => f.includes("/workers/") && f.endsWith(".jsonl")).map(f => readFileSync(f, "utf8"));
  const refsTagged = workerTexts.reduce((s, t) => s + (t.match(/\[orche ref T\d+/g) ?? []).length, 0);
  const thinkingChanges = events.filter(e => e.type === "thinking_change").length;
  const compactions = events.filter(e => e.type === "compaction");
  const overlay = record.runtime_settings?.orche ?? null;
  return {
    arm: record.candidate_id, task: record.task_id, terminal: record.terminal_status, success: record.task_success,
    configured: { ledger: overlay?.single?.ledger ?? null, thinkingPolicy: overlay?.thinkingPolicy ?? null, workerCompaction: overlay?.workerCompaction ?? null, extendedContext: overlay?.default?.extendedContext ?? null },
    observed: {
      efforts, models, thinkingChanges,
      ledgerEvents: ledgerEvents.length, ledgerKinds: [...new Set(ledgerEvents)],
      taskPlans: plans.length, checkpointsInLastPlan: checkpoints.length, checkpointsCitingRefs: checkpoints.filter(n => (n.checkpoint.evidence ?? []).some(x => /\bT\d+\b/.test(x))).length,
      refsTagged, workerSessions: files.filter(f => f.includes("/workers/") && f.endsWith(".jsonl")).length,
      compactions: compactions.length, compactionPolicies: [...new Set(compactions.map(c => c.policy ?? "unknown"))], earlyCompactions: compactions.filter(c => c.early).length,
      references: compactions.map(c => c.reference ?? null), essentialsSections: [...new Set(compactions.flatMap(c => c.essentialsSections ?? []))],
      cancelled: events.filter(e => e.type === "compaction_cancelled").map(e => e.cause), failed: events.filter(e => e.type === "compaction_failed").length,
      subWorkerCompactions: events.filter(e => e.type === "spawn").flatMap(e => (e.workers ?? []).map(w => w.compactions ?? 0)).reduce((s, n) => s + n, 0),
      piCompactionEntries: record.telemetry?.compaction?.count ?? null, summaryRequests: record.telemetry?.requests?.summary_observed ?? null,
      maxInputObserved: record.telemetry?.requests?.max_input_tokens_observed ?? null, transcriptReads: record.telemetry?.retrieval?.transcript_reads ?? null,
    },
  };
}

export function stateFidelity(stateDir) {
  const root = join(stateDir, "evidence");
  const units = [];
  for (const arm of existsSync(root) ? readdirSync(root) : []) for (const unit of readdirSync(join(root, arm))) if (existsSync(join(root, arm, unit, "record.json"))) units.push(unitFidelity(join(root, arm, unit)));
  return units.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" } } });
  const stateDir = resolve(values.state);
  const units = stateFidelity(stateDir);
  writeFileSync(join(stateDir, "fidelity.json"), `${JSON.stringify(units, null, 2)}\n`);
  for (const u of units) process.stdout.write(`${u.arm} ${u.task} ${u.terminal} success=${u.success} efforts=${u.observed.efforts} ledger=${u.observed.ledgerEvents} plans=${u.observed.taskPlans} ckpt=${u.observed.checkpointsInLastPlan}/${u.observed.checkpointsCitingRefs} refs=${u.observed.refsTagged} thinkChg=${u.observed.thinkingChanges} subs=${u.observed.workerSessions} cmp=${u.observed.compactions}(${u.observed.compactionPolicies}) early=${u.observed.earlyCompactions} cancel=${u.observed.cancelled} subCmp=${u.observed.subWorkerCompactions} maxIn=${u.observed.maxInputObserved}\n`);
}
