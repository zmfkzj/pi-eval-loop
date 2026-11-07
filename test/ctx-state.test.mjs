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
