// Attributable telemetry of one unit, computed by the controller from its own captures after the run: the wire journal its proxy
// wrote outside the sandbox (provider-reported usage per request) and the captured transcripts (Pi session JSONL files and orche's
// run records). Pure functions of their inputs; nothing an agent writes into its workspace is read.
//
// Naming: `*_observed` values come from the provider (wire usage, the usage Pi stores on a compaction entry); `*_estimated` values
// are Pi/orche token estimates (chars/4 heuristics). They are never mixed in one field. The record's `context` field is the
// evaluator's phase label and is not touched here.

export const TELEMETRY_SCHEMA = "pi-eval-loop/telemetry-1";

const parseLines = (text) => {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return out;
};

/** Requests of the wire journal: completed POSTs with provider usage. `session` is the prompt cache key the provider got (absent for Pi's summary requests). */
export function wireRequests(wire) {
  return (wire ?? []).filter(e => e && e.phase === "end" && e.method === "POST").map(e => ({ session: e.session, status: e.status, input: e.usage?.input, cached: e.usage?.cached, output: e.usage?.output, refused: !!e.refused }));
}

/** Tool calls of a Pi session JSONL (assistant toolCall parts), with the entry timestamp. */
function sessionToolCalls(entries) {
  const calls = [];
  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) if (part?.type === "toolCall") calls.push({ name: part.name, arguments: part.arguments ?? {}, at: Date.parse(entry.timestamp ?? "") || 0 });
  }
  return calls;
}

const TRANSCRIPT_REF = /\.jsonl\b|orche\/records|\/sessions\//;

/**
 * Telemetry of one attempt. `files`: [{ path, text }] of the captured transcripts (relative to the box), `wire`: the proxy's
 * journal entries, `runtime`: the settings the harness ran with (orche config overlay applied, route).
 */
export function unitTelemetry({ files = [], wire = [], runtime = undefined }) {
  const sessions = files.filter(f => f.path.endsWith(".jsonl") && !f.path.endsWith("events.jsonl"));
  const eventFiles = files.filter(f => f.path.endsWith("events.jsonl"));
  const piCompactions = [];
  let retrievalCalls = 0, retrievalCallsAfterCompaction = 0;
  const sessionCompactionCounts = {};
  for (const file of sessions) {
    const entries = parseLines(file.text);
    const compactions = entries.filter(e => e?.type === "compaction");
    if (compactions.length) sessionCompactionCounts[file.path] = compactions.length;
    for (const c of compactions) piCompactions.push({ session: file.path, at: Date.parse(c.timestamp ?? "") || 0, tokensBeforeEstimated: c.tokensBefore ?? null, fromExtension: !!c.fromHook, usageObserved: c.usage ? { input: c.usage.input ?? 0, output: c.usage.output ?? 0, cacheRead: c.usage.cacheRead ?? 0 } : null });
    const firstCompaction = compactions.length ? Math.min(...compactions.map(c => Date.parse(c.timestamp ?? "") || Infinity)) : Infinity;
    for (const call of sessionToolCalls(entries)) {
      if (!TRANSCRIPT_REF.test(JSON.stringify(call.arguments))) continue;
      retrievalCalls++;
      if (call.at >= firstCompaction) retrievalCallsAfterCompaction++;
    }
  }
  const orche = eventFiles.flatMap(f => parseLines(f.text));
  const ofType = (type) => orche.filter(e => e?.type === type);
  const compactEvents = ofType("compaction");
  const subCompactions = ofType("spawn").flatMap(e => (e.workers ?? []).map(w => w.compactions ?? 0)).reduce((s, n) => s + n, 0);
  const cancelled = ofType("compaction_cancelled");
  const failed = ofType("compaction_failed");
  const byKey = (list, key) => list.reduce((acc, e) => { const k = String(e[key] ?? "unknown"); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const requests = wireRequests(wire);
  const usable = requests.filter(r => typeof r.input === "number");
  // Pi's default summary requests carry no session id (prompt cache key): the provider sees them without one. Every task request
  // of a Pi session carries its session id.
  const summaryWire = requests.filter(r => !r.session).length;
  const essentials = compactEvents.filter(e => typeof e.essentialsChars === "number");
  return {
    schema: TELEMETRY_SCHEMA,
    runtime: runtime ?? null,
    requests: {
      total_observed: requests.length,
      summary_observed: summaryWire,
      task_observed: requests.length - summaryWire,
      max_input_tokens_observed: usable.length ? Math.max(...usable.map(r => r.input)) : null,
      input_tokens_observed: usable.reduce((s, r) => s + r.input, 0),
    },
    compaction: {
      // Pi session entries: the authoritative count of compactions that happened (every session of the attempt, sub-workers included).
      count: piCompactions.length,
      sessions: sessionCompactionCounts,
      by_reason: byKey(compactEvents, "reason"),
      by_policy: byKey(compactEvents, "policy"),
      orche_events: compactEvents.length,
      sub_worker_compactions: subCompactions,
      tokens_before_estimated: compactEvents.map(e => e.tokensBefore ?? null),
      tokens_after_estimated: compactEvents.map(e => e.tokensAfter ?? null),
      summary_usage_observed: piCompactions.reduce((acc, c) => c.usageObserved ? { input: acc.input + c.usageObserved.input, output: acc.output + c.usageObserved.output } : acc, { input: 0, output: 0 }),
      essentials_max_chars: essentials.length ? Math.max(...essentials.map(e => e.essentialsChars)) : null,
      essentials_missing: [...new Set(essentials.flatMap(e => e.essentialsMissing ?? []))],
      reference: byKey(compactEvents.filter(e => e.reference), "reference"),
      cancelled: cancelled.length, cancelled_by_cause: byKey(cancelled, "cause"),
      failed: failed.length, failed_by_reason: byKey(failed, "reason"),
      fallbacks: cancelled.filter(e => e.fallback).length,
    },
    retrieval: { transcript_reads: retrievalCalls, transcript_reads_after_compaction: retrievalCallsAfterCompaction },
  };
}
