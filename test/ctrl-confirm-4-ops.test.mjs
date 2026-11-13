// ctrl-confirm-4 operations helpers (not launch-bound): read-only status and the runtime-environment watchdog comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.mjs";
import { statusOf } from "../experiments/ctrl-confirm-4/status.mjs";
import { differences } from "../experiments/ctrl-confirm-4/env-watch.mjs";

const prereg = { budget: { maxRequestsTotal: 100, maxInputTokens: 1000, maxOutputTokens: 100, maxCostUsdApiEquivalent: 10, maxActiveHours: 5 }, resources: { planned: null }, holdout: { taskIds: ["a", "b"], batches: [{ path: "b1" }] } };
const jl = (xs) => xs.map(x => JSON.stringify(x)).join("\n") + "\n";

test("status: consumed/reserved/remaining from the resource ledger, unresolved pause, uses, drift; never per-arm success", () => {
  const root = tempDir(), state = join(root, "state"), data = join(root, "results");
  mkdirSync(state); mkdirSync(join(data, "b1"), { recursive: true });
  writeFileSync(join(state, "resources.jsonl"), jl([
    { type: "campaign-start", at: "2026-01-01T00:00:00Z", wallDeadline: "2026-01-06T00:00:00Z" },
    { type: "active-start", at: "2026-01-01T00:00:00Z" }, { type: "reserve", at: "2026-01-01T00:00:00Z", attemptId: "u1:a1", amount: { requests: 10, input: 100, output: 10, costUsd: 1 } },
    { type: "reserve", at: "2026-01-01T00:00:00Z", attemptId: "u2:a1", amount: { requests: 10, input: 100, output: 10, costUsd: 1 } },
    { type: "settle", at: "2026-01-01T00:30:00Z", attemptId: "u1:a1", usage: { requests: 4, input: 50, output: 5, costUsd: 0.2 } },
    { type: "active-end", at: "2026-01-01T01:00:00Z" }, { type: "pause", at: "2026-01-01T01:00:00Z", kind: "credit", reason: "no credits" },
  ]));
  writeFileSync(join(state, "lock.json"), "{}");
  writeFileSync(join(state, "campaign.json"), JSON.stringify({ total: 4, done: 1, unsettled: 3, terminal: { completed: 1 } }));
  writeFileSync(join(data, "b1", "USES.jsonl"), jl([{ stateDir: state }]));
  writeFileSync(join(state, "env-watch.jsonl"), jl([{ at: "x", type: "ok" }, { at: "y", type: "ENV-DRIFT", changed: ["providerTree"] }]));
  const s = statusOf(state, prereg, { datasetsRoot: data, now: Date.parse("2026-01-01T02:00:00Z") });
  assert.equal(s.resources.consumed.requests, 4); assert.equal(s.resources.reserved.requests, 10); assert.equal(s.resources.openReservations, 1);
  assert.equal(s.resources.remaining.requests, 100 - 4 - 10); assert.equal(s.resources.activeHours, 1);
  assert.equal(s.pause.kind, "credit"); assert.match(s.phase, /PAUSED \(credit\)/);
  assert.deepEqual(s.holdoutUses, [{ batch: "b1", uses: 1, byThisState: 1 }]);
  assert.equal(s.envDrift.length, 1);
  assert.ok(!JSON.stringify(s).includes("hidden_test_pass") && !JSON.stringify(s).includes("success"), "no success figures");
});

test("env watch: any changed runtime component is reported", () => {
  const a = { envDigest: "e", filesDigest: "f", orcheNodeModules: "n", providerTree: "p", piCli: "c", piPackage: "v" };
  assert.deepEqual(differences(a, { ...a }), []);
  assert.deepEqual(differences(a, { ...a, orcheNodeModules: "n2", piCli: "c2" }).sort(), ["orcheNodeModules", "piCli"]);
  assert.deepEqual(differences(a, { ...a, providerTree: null }), ["providerTree"]);
});

test("operator hold/resume (stopped state): durable held pause, resume records it; a ceiling pause is never resumed", async () => {
  const { spawnSync } = await import("node:child_process");
  const { resourceManagerOf } = await import("../experiments/ctrl-confirm-4/run.mjs");
  const { loadPrereg } = await import("../experiments/ctrl-confirm-4/lib.mjs");
  const OP = new URL("../experiments/ctrl-confirm-4/operator.mjs", import.meta.url).pathname;
  const op = (...args) => spawnSync(process.execPath, [OP, ...args], { encoding: "utf8" });
  const state = tempDir(), p = loadPrereg();
  const rm = resourceManagerOf(state, p); rm.startSession(); rm.endSession("x");
  assert.equal(op("resume", "--state", state, "--reason", "r").status, 1, "nothing to resume");
  assert.equal(op("hold", "--state", state).status, 64, "a reason is required");
  assert.equal(op("hold", "--state", state, "--reason", "validate runtime").status, 0);
  assert.equal(resourceManagerOf(state, p).state().pause.kind, "operator");
  assert.equal(op("hold", "--state", state, "--reason", "again").status, 1, "already held");
  assert.equal(op("resume", "--state", state, "--reason", "validated").status, 0);
  assert.equal(resourceManagerOf(state, p).state().pause, null);
  const rm2 = resourceManagerOf(state, p); rm2.pause("ceiling", "cap");
  const r = op("resume", "--state", state, "--reason", "no");
  assert.equal(r.status, 1); assert.match(r.stderr, /final/);
});
