// ctx-state-1: explicit runtime settings (runner.orcheConfig overlay), harness identity per config, and the telemetry parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { orcheConfig } from "../src/runner.mjs";
import { unitTelemetry, wireRequests } from "../src/telemetry.mjs";
import { harnessIdentity, harnessOf, telemetrySummary } from "../experiments/ctx-state-1/lib.mjs";

const route = { provider: "cliproxyapi", model: "gpt-6-astra", effort: "high" };
const unit = { wallMs: 1000, maxRequests: 10 };

test("orcheConfig without overlay is unchanged (historical evaluator config)", () => {
  const cfg = orcheConfig(route, "single", unit);
  assert.deepEqual(cfg.single, { ledger: false, spawn: true, advisor: false });
  assert.equal(cfg.thinkingPolicy, undefined);
  assert.equal(cfg.default.extendedContext, undefined);
});

test("orcheConfig overlay merges explicit settings deeply and keeps the pinned route, tiers and limits", () => {
  const cfg = orcheConfig({ ...route, extendedContext: true }, "single", unit, { single: { ledger: true, maxSubWorkers: 8 }, thinkingPolicy: { mode: "fixed", checkpoints: true, evidence: "strict" }, workerCompaction: { policy: "absolute", triggerTokens: 32000 } });
  assert.deepEqual(cfg.single, { ledger: true, spawn: true, advisor: false, maxSubWorkers: 8 });
  assert.deepEqual(cfg.thinkingPolicy, { mode: "fixed", checkpoints: true, evidence: "strict" });
  assert.equal(cfg.workerCompaction.triggerTokens, 32000);
  for (const tier of Object.values(cfg.models)) assert.deepEqual(tier, { model: "cliproxyapi/gpt-6-astra", thinking: "high", extendedContext: true });
  assert.deepEqual(cfg.limits, { overallMs: 1000, assignmentMs: 1000, assignmentRequests: 10 });
  for (const key of ["models", "default", "limits", "routes", "mainMode"]) assert.throws(() => orcheConfig(route, "single", unit, { [key]: {} }), /may not set/);
});

test("arms with different settings never share a harness identity (unit key)", () => {
  const prereg = { harnessBase: { commit: "abc" } };
  const a0 = { id: "A0", mode: "single", orcheConfig: { single: { ledger: false } } };
  const a1 = { id: "A1", mode: "single", orcheConfig: { single: { ledger: true } } };
  assert.notEqual(harnessIdentity(a0, prereg), harnessIdentity(a1, prereg));
  assert.equal(harnessIdentity({ ...a0, base: "old" }, prereg).startsWith("old:single"), true);
  const h = harnessOf(a1, prereg, { dir: "/x" });
  assert.deepEqual(h.orcheConfig, { single: { ledger: true } });
  h.orcheConfig.single.ledger = false;
  assert.equal(a1.orcheConfig.single.ledger, true, "the harness gets a copy");
});

test("telemetry: observed vs estimated, task vs summary requests, compactions, retrieval, failures", () => {
  const wire = [
    { phase: "end", method: "POST", session: "s1", usage: { input: 9000, cached: 7000, output: 100 } },
    { phase: "end", method: "POST", session: "s1", usage: { input: 31000, cached: 7000, output: 100 } },
    { phase: "end", method: "POST", usage: { input: 25000, cached: 0, output: 900 } },
    { phase: "end", method: "GET", path: "/v1/models" },
  ];
  assert.equal(wireRequests(wire).length, 3);
  const session = [
    { type: "message", timestamp: "2026-11-07T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }] } },
    { type: "compaction", timestamp: "2026-11-07T00:01:00.000Z", tokensBefore: 30500, usage: { input: 25000, output: 900, cacheRead: 0 } },
    { type: "message", timestamp: "2026-11-07T00:02:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "grep -n toolu_1 /home/a/.pi/agent/orche/records/x/workers/W1-1.jsonl" } }] } },
  ].map(e => JSON.stringify(e)).join("\n");
  const events = [
    { type: "compaction", reason: "threshold", policy: "absolute", tokensBefore: 30500, tokensAfter: 14000, essentialsChars: 5000, essentialsMissing: [], reference: "valid" },
    { type: "compaction_cancelled", reason: "threshold", cause: "loop_guard", fallback: "stable" },
    { type: "compaction_failed", reason: "threshold", errorMessage: "x" },
    { type: "spawn", workers: [{ id: "W1.1", compactions: 2 }] },
  ].map(e => JSON.stringify(e)).join("\n");
  const t = unitTelemetry({ files: [{ path: "agent/orche/records/x/workers/W1-1.jsonl", text: session }, { path: "agent/orche/records/x/run/events.jsonl", text: events }], wire, runtime: { orcheOverlay: { a: 1 } } });
  assert.equal(t.requests.total_observed, 3);
  assert.equal(t.requests.summary_observed, 1);
  assert.equal(t.requests.task_observed, 2);
  assert.equal(t.requests.max_input_tokens_observed, 31000);
  assert.equal(t.compaction.count, 1);
  assert.deepEqual(t.compaction.by_policy, { absolute: 1 });
  assert.deepEqual(t.compaction.tokens_before_estimated, [30500]);
  assert.deepEqual(t.compaction.summary_usage_observed, { input: 25000, output: 900 });
  assert.equal(t.compaction.sub_worker_compactions, 2);
  assert.deepEqual(t.compaction.cancelled_by_cause, { loop_guard: 1 });
  assert.equal(t.compaction.failed, 1);
  assert.equal(t.compaction.fallbacks, 1);
  assert.equal(t.retrieval.transcript_reads, 1);
  assert.equal(t.retrieval.transcript_reads_after_compaction, 1);
  const s = telemetrySummary([{ telemetry: t }, {}]);
  assert.equal(s.compactions, 1);
  assert.equal(s.withTelemetry, 1);
});

import { addTotals, userTurns, TASK_SUFFIX } from "../src/runner.mjs";
import { loadSuite } from "../src/datasets.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";

test("multi-turn: user turns are the instruction then the task's turns, each with the task suffix; single-turn tasks unchanged", () => {
  assert.deepEqual(userTurns({ instruction: "do X" }), [`do X${TASK_SUFFIX}`]);
  assert.deepEqual(userTurns({ instruction: "do X", turns: ["amend Y", "finish Z"] }), [`do X${TASK_SUFFIX}`, `amend Y${TASK_SUFFIX}`, `finish Z${TASK_SUFFIX}`]);
});

test("multi-turn: totals of the turns' model paths add up (the unit limits cover all turns)", () => {
  assert.deepEqual(addTotals({ forwarded: 3, input: 10, refused: { budget: 0, route: 1 }, model: "m" }, { forwarded: 2, input: 5, refused: { budget: 1 }, cached: 4, model: "m" }), { forwarded: 5, input: 15, refused: { budget: 1, route: 1 }, cached: 4, model: "m" });
  assert.deepEqual(addTotals({}, { forwarded: 1 }), { forwarded: 1 });
});

test("multi-turn: the suite loader carries `turns` only when they are nonempty strings", () => {
  const dir = joinPath(dirname(fileURLToPath(import.meta.url)), "../experiments/ctx-state-1/tasks");
  const [task] = loadSuite(dir).filter(t => t.id === "s1-amended-billing");
  assert.equal(task.turns.length, 2);
  assert.match(task.turns[0], /supersedes the session 1 tie rule/);
  assert.match(task.instruction, /do NOT start ticket D yet/);
});

import { exactSignFlip, pairedTables, reconciledOf } from "../experiments/ctx-state-1-analysis/analyze.mjs";
import { transcriptCalls } from "../experiments/ctx-state-1-analysis/audit.mjs";

test("analysis: exact sign-flip enumerates all 2^T patterns; 7 tasks cannot reach Holm p < 0.05 over four contrasts", () => {
  const all = exactSignFlip([1, 1, 1, 1, 1, 1, 1]);
  assert.equal(all.patterns, 128);
  assert.equal(all.p, 2 / 128);
  assert.ok(4 * all.minP > 0.05);
  assert.equal(exactSignFlip([0, 0, 0]).p, 1);
  assert.equal(exactSignFlip([1, -1]).p, 1);
  assert.equal(exactSignFlip([]).p, 1);
});

test("analysis: contrasts pair (task, repeat) cells explicitly and report cells missing on either side", () => {
  const r = (arm, task, repeat, ok) => ({ candidate_id: arm, task_id: task, repeat, ok });
  const usable = [r("A", "t1", 0, 1), r("A", "t1", 1, 0), r("B", "t1", 0, 0), r("A", "t2", 0, 1), r("B", "t2", 1, 1)];
  const p = pairedTables(usable, "A", "B", x => x.ok === 1);
  assert.deepEqual(p.a, { t1: [1] });
  assert.deepEqual(p.b, { t1: [0] });
  assert.equal(p.pairs, 1);
  assert.deepEqual(p.missing.map(m => m.cell).sort(), ["t1#1", "t2#0", "t2#1"]);
  assert.equal(reconciledOf({ terminal_detail: "controller interrupted; reconciled from the wire journal: 9 completed model call(s)" }), true);
  assert.equal(reconciledOf({ terminal_detail: "stop" }), false);
});

test("audit: only a matched, non-error call on a transcript file that returned session entries is a verified read", () => {
  const call = (id, name, args) => ({ type: "message", timestamp: `2026-01-01T00:00:0${id}Z`, message: { role: "assistant", content: [{ type: "toolCall", id: `c${id}`, name, arguments: args }] } });
  const result = (id, text, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: `c${id}`, isError, content: [{ type: "text", text }] } });
  const entries = [
    call(1, "read", { path: "/tmp/box/agent/orche/records/x/workers/W1-2026.jsonl" }), result(1, '{"type":"message","message":{"role":"toolResult","content":"Issued batch id: B-0123456789ab"}}'),
    { type: "compaction", timestamp: "2026-01-01T00:00:02Z" },
    call(3, "bash", { command: "ls /tmp/box/agent/orche/records/x/workers/" }), result(3, "W1-2026.jsonl"),
    call(4, "write", { path: "notes/data.jsonl", content: "{}" }), result(4, "ok"),
    call(5, "grep", { pattern: "batch", path: "/tmp/box/sessions/s.jsonl" }), result(5, "no such file", true),
    call(6, "read", { path: "/tmp/box/agent/orche/records/x/workers/W2-2026.jsonl" }), result(6, '{"type":"session","id":"x"}'),
  ];
  const calls = transcriptCalls(entries);
  assert.deepEqual(calls.map(c => [c.target, c.verified, c.afterOwnCompaction, c.batchIdInResult]), [
    ["W1-2026.jsonl", true, false, true], ["s.jsonl", false, true, false], ["W2-2026.jsonl", true, true, false],
  ]);
});
