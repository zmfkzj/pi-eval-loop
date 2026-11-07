#!/usr/bin/env node
// ctx-state-1 supplemental trace audit (written after the main lock, outside the locked experiment tree; read-only over a state).
// The locked fidelity.mjs counts a "retrieval" for any tool call whose arguments mention a .jsonl / records / sessions path; that
// heuristic also matches listings, writes and unrelated JSONL. This audit separates:
//   - verified transcript reads: the call names a transcript file (a worker/sub-worker JSONL under orche/records or a session JSONL),
//     its result is matched by toolCallId, is not an error, and returned transcript content (serialized session entries);
//   - their timing relative to the reading session's own first compaction;
//   - worker continuity: per orche_task assignment the worker id, whether it was handed a gone worker's work (orche's handover
//     prompt), whether it was briefed from the task ledger, and whether it then verifiably read the previous worker's transcript.
//   node pi-eval-loop/experiments/ctx-state-1-analysis/audit.mjs --state DIR   (writes audit.json next to the state's records)
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const jsonl = (text) => text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
const walk = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).map(f => join(dir, f)) : [];
const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map(c => c?.text ?? "").join("\n") : "";

/** A path argument that names a transcript file (not a directory, not another JSONL). */
export const TRANSCRIPT_PATH = /(?:orche\/records\/[^\s"'`]*\/workers\/[^\s"'`/]+\.jsonl|\/sessions\/[^\s"'`/]+\.jsonl|\/workers\/W\d+[^\s"'`/]*\.jsonl)/;
/** Returned text that is serialized session entries (what a transcript read returns), not a listing or an error. */
export const TRANSCRIPT_CONTENT = /"type"\s*:\s*"(?:message|session|compaction|custom)"|"role"\s*:\s*"(?:user|assistant|toolResult)"|"toolCallId"\s*:/;
export const BATCH_ID = /Issued batch id: B-[0-9a-f]{12}/;

/** Every tool call of one session transcript that names a transcript path, classified. */
export function transcriptCalls(entries) {
  const results = new Map(entries.filter(e => e.type === "message" && e.message?.role === "toolResult").map(e => [e.message.toolCallId, e]));
  const firstCompaction = entries.find(e => e.type === "compaction");
  const out = [];
  for (const e of entries) {
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    for (const part of e.message.content ?? []) {
      if (part.type !== "toolCall") continue;
      const args = JSON.stringify(part.arguments ?? {});
      const path = TRANSCRIPT_PATH.exec(args)?.[0];
      if (!path) continue;
      const res = results.get(part.id);
      const text = textOf(res?.message?.content);
      const verified = !!res && !res.message.isError && TRANSCRIPT_CONTENT.test(text);
      out.push({
        tool: part.name, target: basename(path), matched: !!res, error: res ? !!res.message.isError : null, verified,
        afterOwnCompaction: firstCompaction ? String(e.timestamp ?? "") > String(firstCompaction.timestamp ?? "") : false,
        batchIdInResult: verified && BATCH_ID.test(text),
      });
    }
  }
  return out;
}

/** Continuity and retrieval facts of one unit's evidence directory. */
export function unitAudit(dir) {
  const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
  const files = walk(join(dir, "transcripts"));
  const workerFiles = files.filter(f => /\/workers\/[^/]+\.jsonl$/.test(f));
  const runs = files.filter(f => f.endsWith("/run.json")).map(f => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } }).filter(r => r?.kind === "task").sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const sessions = workerFiles.map(f => ({ file: basename(f), entries: jsonl(readFileSync(f, "utf8")) }));
  const firstUser = (entries) => textOf(entries.find(e => e.type === "message" && e.message?.role === "user")?.message?.content);
  const assignments = runs.map(r => {
    const file = basename(String(r.worker?.sessionFile ?? ""));
    const s = sessions.find(x => x.file === file);
    const prompt = s ? firstUser(s.entries) : "";
    const handover = /^## Handover: you \((W\d+)\) continue the work of worker (W\d+)/m.exec(prompt);
    const calls = s ? transcriptCalls(s.entries) : [];
    const previous = handover?.[2];
    return {
      worker: r.worker?.id ?? null, status: r.status, reusedWorker: r.assignment?.reusedWorker ?? null,
      handoverFrom: previous ?? null, ledgerBriefing: /## Continuing task /.test(prompt),
      readPreviousTranscript: previous ? calls.some(c => c.verified && c.target.startsWith(`${previous}-`)) : null,
      transcriptCalls: calls.length, verifiedReads: calls.filter(c => c.verified).length,
    };
  });
  const allCalls = sessions.flatMap(s => transcriptCalls(s.entries).map(c => ({ ...c, session: s.file })));
  const subs = sessions.filter(s => /^W\d+\.\d+-/.test(s.file));
  return {
    arm: record.candidate_id, task: record.task_id, repeat: record.repeat, terminal: record.terminal_status, success: record.task_success,
    assignments, handovers: assignments.filter(a => a.handoverFrom).length,
    handoversWithVerifiedRead: assignments.filter(a => a.readPreviousTranscript).length,
    transcriptCalls: allCalls.length, verifiedReads: allCalls.filter(c => c.verified).length,
    verifiedReadsAfterOwnCompaction: allCalls.filter(c => c.verified && c.afterOwnCompaction).length,
    heuristicOnly: allCalls.filter(c => !c.verified).length, batchIdRetrieved: allCalls.some(c => c.batchIdInResult),
    workerSessions: sessions.length, subWorkerSessions: subs.length, subWorkerCompactionEntries: subs.reduce((n, s) => n + s.entries.filter(e => e.type === "compaction").length, 0),
  };
}

export function stateAudit(stateDir) {
  const root = join(stateDir, "evidence");
  const units = [];
  for (const arm of existsSync(root) ? readdirSync(root) : []) for (const unit of readdirSync(join(root, arm))) if (existsSync(join(root, arm, unit, "record.json"))) units.push(unitAudit(join(root, arm, unit)));
  return units.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" } } });
  const stateDir = resolve(values.state);
  const units = stateAudit(stateDir);
  writeFileSync(join(stateDir, "audit.json"), `${JSON.stringify(units, null, 2)}\n`);
  for (const u of units) process.stdout.write(`${u.arm} ${u.task} r${u.repeat} ${u.terminal} success=${u.success} workers=${u.assignments.map(a => `${a.worker}${a.handoverFrom ? `<${a.handoverFrom}${a.readPreviousTranscript ? "+read" : ""}` : ""}${a.ledgerBriefing ? "+ledger" : ""}`).join(",")} transcriptCalls=${u.transcriptCalls} verified=${u.verifiedReads} afterCmp=${u.verifiedReadsAfterOwnCompaction} heuristicOnly=${u.heuristicOnly} batchId=${u.batchIdRetrieved}\n`);
}
