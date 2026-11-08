// ctrl-confirm-4: resource management (reservations, ceilings, active time, crashes, orphans, provider pauses, single runner),
// attempt policy, and the planning/gate code. Deterministic and model-free: simulated backends only, no paid calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { tempDir } from "./helpers.mjs";
import { makeRecord } from "../src/metrics.mjs";
import { Ledger } from "../src/util.mjs";
import { buildQueue } from "../experiments/ctrl-ablation/lib.mjs";
import { ChainLedger, DuplicateRunnerError, ResourceManager, RunnerLock, costOf, processesWith, providerFailure, stopOrphans, wireUsage } from "../experiments/ctrl-confirm-4/resources.mjs";
import { attemptPolicy, runCampaign, resourceManagerOf } from "../experiments/ctrl-confirm-4/run.mjs";

const PRICING = { inputPerM: 0.1, cachedInputPerM: 0.01, cacheWritePerM: 0.125, outputPerM: 0.5 };
const BUDGET = { maxRequestsTotal: 1e9, maxInputTokens: 1e12, maxOutputTokens: 1e12, maxCostUsdApiEquivalent: 1e9, maxActiveHours: 1e6, maxCampaignWallHours: 1e6, maxConsecutiveInfra: 5 };
const prereg = (over = {}) => ({
  id: "cc4-test", seed: "cc4-test", route: { provider: "p", model: "m", effort: "medium" }, unit: { wallMs: 60_000, maxRequests: 10, graderMs: 1000 }, infra: { maxRetries: 1, maxProviderRetries: 2 },
  parallelism: 4, capture: {}, integrity: {}, repeats: 2, arms: [{ id: "OC" }, { id: "OCR" }], pricing: PRICING,
  resources: { reservePerAttempt: { requests: 10, input: 10_000, output: 1_000 }, attemptSetupMs: 1000, heartbeatMs: 0, unknownUsageRequestCharge: { input: 5000, output: 500 }, planned: null },
  ...over, budget: { ...BUDGET, ...(over.budget ?? {}) },
});
function fixture(p, tasks = ["a", "b", "c"]) {
  const tasksById = Object.fromEntries(tasks.map(t => [t, { id: t, family: `f-${t}`, instruction: "x" }]));
  const harness = { OC: { id: "OC", kind: "pure", commit: "c0" }, OCR: { id: "OCR", kind: "pure", commit: "c1" } };
  const queue = buildQueue({ arms: ["OC", "OCR"], tasks, repeats: p.repeats, seed: p.seed });
  return { tasksById, harness, grading: {}, queue, lock: { smoke: false, preregDigest: "pd", envDigest: "ed", queueDigest: "qd" } };
}
const rec = (input, over = {}) => makeRecord({ run_id: input.runId, unit_key: input.unitKey, attempt: input.attempt, candidate_id: input.harness.id, task_id: input.task.id, split: input.split, repeat: input.repeat, model_route: "p/m", thinking_effort: "medium", protocol_digest: input.protocolDigest, environment_digest: input.envDigest, terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, model_requests: 4, model_requests_completed: 4, input_tokens: 2000, cache_tokens: 1500, cache_write_tokens: 0, output_tokens: 100, started_at: new Date().toISOString(), ...over });
const backendOf = (fn, delay = 2) => ({ simulated: true, async run(input) { await new Promise(r => setTimeout(r, delay)); return fn(input); } });

test("chain ledger: append, reload, tamper detection", () => {
  const dir = tempDir(); const l = new ChainLedger(join(dir, "r.jsonl"));
  l.append({ type: "a" }); l.append({ type: "b" });
  assert.deepEqual(new ChainLedger(join(dir, "r.jsonl")).verify(), []);
  writeFileSync(join(dir, "r.jsonl"), readFileSync(join(dir, "r.jsonl"), "utf8").replace('"b"', '"c"'));
  assert.ok(new ChainLedger(join(dir, "r.jsonl")).verify().length > 0);
});

test("runner lock: a live runner refuses a second one; a dead runner's lock is moved aside (kept) and taken over", () => {
  const dir = tempDir();
  const a = RunnerLock.acquire(dir);
  assert.throws(() => RunnerLock.acquire(dir), DuplicateRunnerError);
  a.release();
  writeFileSync(join(dir, "runner.lock"), JSON.stringify({ pid: 999999999, host: hostname(), at: "x" }));
  const b = RunnerLock.acquire(dir, { isAlive: () => false });
  assert.ok(b.takeover && existsSync(b.takeover.keptAt));
  assert.throws(() => RunnerLock.acquire(dir), DuplicateRunnerError, "the new holder is alive");
  b.release();
});

test("cost: input includes cached and cache-write tokens (no double counting)", () => {
  assert.ok(Math.abs(costOf({ input: 1_000_000, cached: 900_000, cacheWrite: 0, output: 0 }, PRICING) - (0.1 * 0.1 + 0.9 * 0.01)) < 1e-12);
  assert.ok(Math.abs(costOf({ input: 1e6, cached: 0, cacheWrite: 1e6, output: 1e6 }, PRICING) - (0.125 + 0.5)) < 1e-12);
});

test("wire usage: completed usage summed; started-without-end and usage-less responses charged conservatively", () => {
  const e = [{ phase: "start", method: "POST" }, { phase: "end", method: "POST", status: 200, usage: { input: 100, cached: 60, output: 10 } }, { phase: "start", method: "POST" }, { phase: "start", method: "POST" }, { phase: "end", method: "POST", status: 200 }];
  const w = wireUsage(e, { unknownRequest: { input: 5000, output: 500 }, pricing: PRICING });
  assert.equal(w.usage.requests, 3); assert.equal(w.unknownUsageRequests, 2);
  assert.equal(w.usage.input, 100 + 2 * 5000); assert.equal(w.usage.output, 10 + 2 * 500);
});

test("provider failure classification uses outcome-independent provider signals only", () => {
  assert.equal(providerFailure({ terminal_status: "model_error", terminal_detail: "auth_unavailable: ... credit_balance_exhausted: You have no credits remaining" }), "credit");
  assert.equal(providerFailure({ terminal_status: "model_error", terminal_detail: "Codex error: You have no credits remaining." }), "credit");
  assert.equal(providerFailure({ terminal_status: "infra_error", terminal_detail: "HTTP 429 Too Many Requests" }), "rate");
  assert.equal(providerFailure({ terminal_status: "model_error", terminal_detail: "Bad Gateway" }), null);
  assert.equal(providerFailure({ terminal_status: "completed", terminal_detail: "429" }), null, "a completed attempt is never re-run");
});

test("attempt policy: infra retries bounded and outcome-independent; provider retries separate; everything else final", () => {
  const P = { maxRetries: 1, maxProviderRetries: 2 };
  const infra = { terminal_status: "infra_error", model_requests_completed: 0 };
  const credit = { terminal_status: "model_error", terminal_detail: "no credits remaining", model_requests_completed: 7 };
  assert.equal(attemptPolicy([], P), "dispatch");
  assert.equal(attemptPolicy([infra], P), "retry");
  assert.equal(attemptPolicy([infra, infra], P), "final");
  assert.equal(attemptPolicy([credit], P), "retry");
  assert.equal(attemptPolicy([credit, infra], P), "retry", "provider attempts do not use the infra retry");
  assert.equal(attemptPolicy([credit, credit, credit], P), "final");
  assert.equal(attemptPolicy([{ terminal_status: "completed", hidden_test_pass: false }], P), "final", "a failed outcome is never retried");
  assert.equal(attemptPolicy([{ terminal_status: "aborted", model_requests_completed: 3 }], P), "final");
});

test("campaign: complete queue, per-attempt reservations settled exactly once to actual usage, active time recorded", async () => {
  const state = tempDir(), p = prereg(), prep = fixture(p);
  const rm = resourceManagerOf(state, p); rm.startSession();
  const s = await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend: backendOf(rec), rm, log: () => {} });
  rm.endSession("done");
  assert.equal(s.unsettled, 0); assert.equal(s.done, prep.queue.length);
  const st = rm.state();
  assert.equal(st.open.size, 0);
  assert.equal(st.consumed.requests, prep.queue.length * 4);
  assert.equal(st.consumed.input, prep.queue.length * 2000);
  const settles = rm.ledger.records().filter(e => e.type === "settle");
  assert.equal(new Set(settles.map(e => e.attemptId)).size, settles.length, "no double charge");
  assert.ok(st.activeMs > 0 && st.openSince === null);
  const again = await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend: backendOf(() => { throw new Error("must not run"); }), rm: (() => { const r = resourceManagerOf(state, p); r.startSession(); return r; })(), log: () => {} });
  assert.equal(again.ran, 0, "a settled queue dispatches nothing on resume");
});

test("request ceiling under concurrency: reservations prevent overshoot; refused attempts are never dispatched; missing units stay unsettled", async () => {
  const state = tempDir(), p = prereg({ parallelism: 8, budget: { maxRequestsTotal: 55 } }), prep = fixture(p, ["a", "b", "c", "d", "e", "f"]);
  const rm = resourceManagerOf(state, p); rm.startSession();
  let dispatched = 0, maxConcurrent = 0, now = 0;
  const backend = backendOf((i) => { dispatched++; return rec(i, { model_requests: 10, model_requests_completed: 10 }); }, 5);
  const wrapped = { simulated: true, async run(i) { now++; maxConcurrent = Math.max(maxConcurrent, now); try { return await backend.run(i); } finally { now--; } } };
  const s = await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend: wrapped, rm, log: () => {} });
  const st = rm.state();
  assert.ok(st.consumed.requests <= 55, `consumed ${st.consumed.requests}`);
  assert.equal(dispatched, 5, "floor(55 / 10-request reservation) attempts");
  assert.equal(s.paused.kind, "cap"); assert.ok(s.unsettled > 0);
  assert.ok(maxConcurrent > 1, "workers really ran concurrently");
  const dispatches = new Ledger(join(state, "runs.jsonl")).records().filter(r => r.type === "dispatch").length;
  assert.equal(dispatches, 5, "no dispatch record for a refused attempt");
});

test("active time: idle/paused time excluded; crash gap closed at last heartbeat + interval; deadline fixed at first launch; admission leaves time for an attempt", () => {
  const state = tempDir(); let t = Date.parse("2026-01-01T00:00:00Z");
  const mk = () => new ResourceManager({ stateDir: state, budget: { ...BUDGET, maxActiveHours: 1, maxCampaignWallHours: 10 }, reserve: { requests: 1, input: 1, output: 1 }, pricing: PRICING, attemptTimeBoundMs: 20 * 60_000, heartbeatMs: 60_000, now: () => t });
  const rm = mk(); rm.startSession();
  const deadline = rm.state().campaign.wallDeadline;
  rm.reserve("u1:a1"); t += 10 * 60_000; rm.settle("u1:a1", { requests: 1 }, "record");
  t += 5 * 3600_000; // idle (paused) time
  assert.equal(Math.round(rm.activeMsNow() / 60000), 10);
  rm.reserve("u2:a1"); t += 3 * 60_000; rm.log({ type: "heartbeat" }); t += 2 * 3600_000; // crash: no settle, no active-end
  const rm2 = mk(); rm2.startSession();
  assert.equal(Math.round(rm2.activeMsNow() / 60000), 10 + 3 + 1, "crash gap bounded by last heartbeat + 1 interval");
  assert.equal(rm2.state().campaign.wallDeadline, deadline, "resume never resets the deadline");
  assert.equal(rm2.state().open.size, 1, "the crashed attempt's reservation is still charged until reconciled");
  // 14 min used of 60: an attempt bound of 20 min fits (34 <= 60); after 30 more active minutes it no longer does.
  assert.equal(rm2.refusal(), null);
  rm2.reserve("u3:a1"); t += 30 * 60_000; rm2.settle("u3:a1", { requests: 1 }, "record");
  assert.match(rm2.refusal(), /active-time ceiling/);
  t = Date.parse(deadline);
  assert.match(mk().refusal() ?? "", /active-time|deadline/);
});

test("crash recovery: orphan dispatch reconciled from its wire journal (evidence kept, never re-drawn); never-dispatched reservation released; lost evidence charged in full", async () => {
  const state = tempDir(), p = prereg(), prep = fixture(p, ["a"]);
  const rm = resourceManagerOf(state, p); rm.startSession();
  const ledger = new Ledger(join(state, "runs.jsonl"));
  // Build three crashed attempts by hand, as a killed runner would leave them.
  const { ResourceEvaluator } = await import("../experiments/ctrl-confirm-4/run.mjs");
  const ev = new ResourceEvaluator({ rm, policy: { maxRetries: 1, maxProviderRetries: 2, pricing: PRICING, unknownRequest: p.resources.unknownUsageRequestCharge }, orphanGraceMs: 10, stateDir: state, protocol: { route: p.route, infra: p.infra, parallelism: 1 }, protocolDigest: "pd", envDigest: "ed", tasksById: prep.tasksById, grading: {}, backend: backendOf(rec) });
  const k1 = ev.keyOf(prep.harness.OC, "a", "confirmation", 0), k2 = ev.keyOf(prep.harness.OCR, "a", "confirmation", 0), k3 = ev.keyOf(prep.harness.OC, "a", "confirmation", 1);
  const cd = mkdtempSync(join(tempDir(), "el4-")); mkdirSync(join(cd, "s1"));
  writeFileSync(join(cd, "s1", "wire.jsonl"), [{ phase: "start", method: "POST" }, { phase: "end", method: "POST", status: 200, final: "response.completed", usage: { input: 3000, cached: 2000, output: 50 } }, { phase: "start", method: "POST" }].map(x => JSON.stringify(x)).join("\n") + "\n");
  rm.reserve(`${k1}:a1`); ledger.append({ type: "dispatch", unit_key: k1, attempt: 1, attemptId: `${k1}:a1`, run_id: "r1", controlDir: cd, harness: { id: "OC", kind: "pure", commit: "c0" }, task: "a", split: "confirmation", repeat: 0 });
  rm.reserve(`${k2}:a1`); // crash before the dispatch record
  rm.reserve(`${k3}:a1`); ledger.append({ type: "dispatch", unit_key: k3, attempt: 1, attemptId: `${k3}:a1`, run_id: "r3", controlDir: join(state, "gone"), harness: { id: "OC", kind: "pure", commit: "c0" }, task: "a", split: "confirmation", repeat: 1 });
  const rm2 = resourceManagerOf(state, p); rm2.startSession();
  ev.rm = rm2;
  await ev.reconcileAll();
  const settles = Object.fromEntries(rm2.ledger.records().filter(e => e.type === "settle").map(e => [e.attemptId, e]));
  assert.equal(settles[`${k1}:a1`].source, "orphan-wire");
  assert.equal(settles[`${k1}:a1`].usage.input, 3000 + 5000, "one request without usage charged conservatively");
  assert.equal(settles[`${k2}:a1`].source, "not-dispatched"); assert.equal(settles[`${k2}:a1`].usage.requests, 0);
  assert.equal(settles[`${k3}:a1`].source, "orphan-conservative-full-reservation"); assert.equal(settles[`${k3}:a1`].usage.requests, 10);
  assert.ok(existsSync(join(state, "evidence", "orphans", "r1", "s1", "wire.jsonl")), "wire evidence preserved");
  assert.equal(ev.results(k1)[0].terminal_status, "aborted", "a completed model call makes the orphan a failure, never a redraw");
  assert.equal(ev.policyOf(k1), "final");
  assert.equal(ev.policyOf(k3), "retry", "an orphan with zero completed calls is an infra attempt (bounded retry)");
  await ev.reconcileAll();
  assert.equal(rm2.ledger.records().filter(e => e.type === "settle").length, 3, "reconciliation is idempotent (no double charge)");
});

test("orphan processes of an interrupted attempt are stopped before reconciliation", async () => {
  const dir = mkdtempSync(join(tempDir(), "el4-orphan-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", dir], { stdio: "ignore", detached: true });
  await new Promise(r => setTimeout(r, 200));
  assert.ok(processesWith(dir).some(p => p.pid === child.pid));
  const found = await stopOrphans(dir, { graceMs: 300 });
  assert.ok(found.some(p => p.pid === child.pid));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(processesWith(dir).length, 0);
});

test("provider credit failure: dispatch pauses, in-flight attempts drain, no retry is spent, the unit resumes later in frozen order", async () => {
  const state = tempDir(), p = prereg({ parallelism: 2 }), prep = fixture(p, ["a", "b", "c", "d"]);
  let credit = true, calls = 0;
  const backend = backendOf((i) => { calls++; return credit && calls === 3 ? rec(i, { terminal_status: "model_error", terminal_detail: "auth_unavailable: credit_balance_exhausted: You have no credits remaining", model_requests_completed: 5, hidden_test_pass: false }) : rec(i); });
  const rm = resourceManagerOf(state, p); rm.startSession();
  const s1 = await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend, rm, log: () => {} });
  rm.endSession("paused");
  assert.equal(s1.paused.kind, "credit");
  assert.ok(calls <= 4, `dispatch stopped right after the failure (${calls} attempts)`);
  credit = false;
  const rm2 = resourceManagerOf(state, p); rm2.startSession();
  const s2 = await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend, rm: rm2, log: () => {} });
  assert.equal(s2.unsettled, 0, "the credit-failed unit got its provider re-attempt after the operator resume");
  const results = new Ledger(join(state, "runs.jsonl")).records().filter(r => r.type === "result");
  assert.equal(results.length, prep.queue.length + 1);
  assert.equal(rm2.state().open.size, 0);
});

test("rate-limit pause auto-resumes after a fixed idle wait (bounded), without counting the wait as active time", async () => {
  const state = tempDir(), p = prereg({ parallelism: 1 }), prep = fixture(p, ["a"]);
  let n = 0;
  const backend = backendOf((i) => (++n === 1 ? rec(i, { terminal_status: "infra_error", terminal_detail: "HTTP 429 rate limit", model_requests: 1, model_requests_completed: 0, hidden_test_pass: false }) : rec(i)));
  const rm = resourceManagerOf(state, p); rm.startSession();
  let waited = 0;
  const s = await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend, rm, log: () => {}, autoResumeRateMs: 60_000, sleep: async (ms) => { waited += ms; } });
  assert.equal(s.unsettled, 0); assert.equal(waited, 60_000);
  assert.ok(rm.ledger.records().some(e => e.type === "resume"));
});

test("controller exception: usage measured from the wire journal before the control directory is removed (no lost usage)", async () => {
  const state = tempDir(), p = prereg({ parallelism: 1 }), prep = fixture(p, ["a"]);
  const backend = { simulated: true, async run(i) { mkdirSync(join(i.controlDir, "s"), { recursive: true }); writeFileSync(join(i.controlDir, "s", "wire.jsonl"), `${JSON.stringify({ phase: "start", method: "POST" })}\n${JSON.stringify({ phase: "end", method: "POST", status: 200, final: "response.completed", usage: { input: 700, cached: 0, output: 7 } })}\n`); throw new Error("controller crashed"); } };
  const rm = resourceManagerOf(state, p); rm.startSession();
  await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend, rm, log: () => {}, maxUnits: 1 });
  const s = rm.ledger.records().find(e => e.type === "settle");
  assert.equal(s.source, "wire"); assert.equal(s.usage.input, 700); assert.equal(s.usage.requests, 1);
  const r = new Ledger(join(state, "runs.jsonl")).records().find(e => e.type === "result").record;
  assert.equal(r.terminal_status, "aborted");
  assert.ok(existsSync(join(state, "evidence", "OC")) || existsSync(join(state, "evidence", "OCR")));
});

test("planning: new scenarios keep the preregistered population effect; nulls stay within size; sparse/repeat-dependent effects cost power", async () => {
  const { calibrate, historical } = await import("../experiments/ctrl-confirm-3/power.mjs");
  const { operating, scenarioOf, requiredN, wilson } = await import("../experiments/ctrl-confirm-4/power.mjs");
  const pool = calibrate(historical());
  for (const s of ["latent:0.039", "latent-sparse:0.039:0.25", "latent-od:0.039:0.2"]) assert.ok(Math.abs(scenarioOf(s, pool).population.E1 - 0.039) < 1e-6, s);
  const sims = 600;
  for (const s of ["latent:0", "latent-od:0:0.2"]) { const r = operating(pool, s, { tasks: 400, sims }); assert.ok(r.H1confirmed.p <= 0.025 + 2 * Math.sqrt(0.025 * 0.975 / sims), `${s} size ${r.H1confirmed.p}`); }
  const base = operating(pool, "latent:0.039", { tasks: 400, sims }).H1confirmed.p;
  const sparse = operating(pool, "latent-sparse:0.039:0.25", { tasks: 400, sims }).H1confirmed.p;
  assert.ok(sparse < base, `sparse ${sparse} < ${base}`);
  const sized = operating(pool, "latent:0.039", { tasks: 200, sims: 50, composition: { sizes: [1, 1, 2, 3] } });
  assert.equal(sized.composition, "realized-sizes");
  const [lo, hi] = wilson(80, 100); assert.ok(lo < 0.8 && hi > 0.8);
  const rows = [{ scenario: "x", tasks: 100, composition: "historical", H1confirmed: { wilson95: [0.79, 0.85] } }, { scenario: "x", tasks: 200, composition: "historical", H1confirmed: { wilson95: [0.81, 0.86] } }];
  assert.equal(requiredN(rows, "x"), 200, "the Monte Carlo lower bound, not the point estimate, must reach the target");
});

test("gate: binds prereg/power/batches; supply, budget and composition failures block; a used or broken batch never counts", async () => {
  const { gate, planned } = await import("../experiments/ctrl-confirm-4/gate.mjs");
  const { loadPrereg } = await import("../experiments/ctrl-confirm-4/lib.mjs");
  const p = loadPrereg();
  const plan = planned(p, 800);
  assert.equal(plan.units, 7200);
  assert.ok(Math.abs(plan.requests - 167690) <= 2, `requests ${plan.requests}`);
  assert.ok(Math.abs(plan.activeHours - 40.6) <= 0.2, `active ${plan.activeHours}`);
  const mkTasks = (n, fam = (i) => `f${Math.floor(i / 2)}`) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, family: fam(i), external: true, hidden: true }));
  const sizesOf = (ts) => { const m = {}; for (const t of ts) m[t.family] = (m[t.family] ?? 0) + 1; return Object.values(m).sort((a, b) => a - b); };
  const tasks = mkTasks(900);
  const power = { configDigest: "c", config: { composition: { sizes: sizesOf(tasks) } }, rows: [700, 800].map(n => ({ scenario: "latent:0.039", tasks: n, composition: "realized-sizes", H1confirmed: { p: 0.85, wilson95: [n === 700 ? 0.79 : 0.81, 0.9] } })) };
  const ok = gate({ prereg: p, power, powerSha256: "s", batches: [{ dir: "A", sealOk: true, sealDigest: "a", uses: 0, tasks }] });
  assert.equal(ok.checks.a_powerReachable.nRequired, 800);
  assert.equal(ok.launch, true, JSON.stringify(Object.entries(ok.checks).filter(([, c]) => !c.pass)));
  const short = gate({ prereg: p, power: { ...power, config: { composition: { sizes: sizesOf(tasks.slice(0, 500)) } } }, powerSha256: "s", batches: [{ dir: "A", sealOk: true, sealDigest: "a", uses: 0, tasks: tasks.slice(0, 500) }] });
  assert.equal(short.launch, false); assert.equal(short.checks.b_supply.pass, false);
  const used = gate({ prereg: p, power, powerSha256: "s", batches: [{ dir: "A", sealOk: true, sealDigest: "a", uses: 1, tasks }] });
  assert.equal(used.launch, false, "a used batch is not fresh");
  const mismatch = gate({ prereg: p, power: { ...power, config: { composition: { sizes: [1, 2, 3] } } }, powerSha256: "s", batches: [{ dir: "A", sealOk: true, sealDigest: "a", uses: 0, tasks }] });
  assert.equal(mismatch.checks.a_powerReachable.pass, false, "power simulated with another composition does not bind");
  const tight = gate({ prereg: { ...p, budget: { ...p.budget, maxRequestsTotal: 45000 } }, power, powerSha256: "s", batches: [{ dir: "A", sealOk: true, sealDigest: "a", uses: 0, tasks }] });
  assert.equal(tight.checks.c_requests.pass, false);
});

test("launch refusal: no gate, a failed gate, another prereg digest or unbound batches all refuse a confirmation launch", async () => {
  const { launchRefusal } = await import("../experiments/ctrl-confirm-4/run.mjs");
  const { digestOf } = await import("../src/util.mjs");
  const dir = tempDir();
  const p = { holdout: { batches: [{ path: "b", sealDigest: "s1" }], taskIds: ["t"] } };
  assert.match(launchRefusal(p, join(dir, "none.json")), /no gate/);
  writeFileSync(join(dir, "g.json"), JSON.stringify({ launch: false, checks: { b_supply: { pass: false } } }));
  assert.match(launchRefusal(p, join(dir, "g.json")), /did not pass.*b_supply/);
  writeFileSync(join(dir, "g.json"), JSON.stringify({ launch: true, checks: {}, bindings: { preregDigest: "other", batches: [] } }));
  assert.match(launchRefusal(p, join(dir, "g.json")), /another preregistration/);
  writeFileSync(join(dir, "g.json"), JSON.stringify({ launch: true, checks: {}, bindings: { preregDigest: digestOf(p), batches: [{ sealDigest: "s1", uses: 1 }] } }));
  assert.match(launchRefusal(p, join(dir, "g.json")), /not bound/);
  writeFileSync(join(dir, "g.json"), JSON.stringify({ launch: true, checks: {}, bindings: { preregDigest: digestOf(p), batches: [{ sealDigest: "s1", uses: 0 }] } }));
  assert.equal(launchRefusal(p, join(dir, "g.json")), null);
});

test("analysis: complete simulated design -> exact hierarchy with intervals; missing units make the design incomplete; provider-interrupted sensitivity", async () => {
  const { analyze, finalRecords } = await import("../experiments/ctrl-confirm-4/analyze.mjs");
  const state = tempDir(), p = prereg({ parallelism: 4, repeats: 3, arms: [{ id: "OC" }, { id: "OCR" }, { id: "PCR" }] }), tasks = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const prep = fixture(p, tasks);
  prep.harness.PCR = { id: "PCR", kind: "pure", commit: "c2" };
  prep.queue = buildQueue({ arms: ["OC", "OCR", "PCR"], tasks, repeats: 3, seed: p.seed });
  const ok = (i) => i.harness.id === "OCR" || Number(i.task.id.slice(1)) % 3 === 0;
  let first = true;
  const backend = backendOf((i) => {
    if (first && i.harness.id === "OC") { first = false; return rec(i, { terminal_status: "model_error", terminal_detail: "no credits remaining", model_requests_completed: 2, hidden_test_pass: false }); }
    return rec(i, { hidden_test_pass: ok(i), integrity: { violations: [], legacyViolations: [], strictTestViolations: [], leakHits: [] } });
  });
  for (let k = 0; k < 2; k++) { const rm = resourceManagerOf(state, p); rm.startSession(); await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend, rm, log: () => {} }); rm.endSession("x"); }
  const familyOf = Object.fromEntries(tasks.map(t => [t, `f-${t}`]));
  const a = analyze(finalRecords(state), p, { tasks, familyOf });
  assert.equal(a.complete, true); assert.equal(a.units, 108);
  assert.ok(a.primary.H1.contrast.E1.estimate > 0.5);
  assert.equal(a.primary.H1.contrast.E1.ciDecisionAgree, true);
  assert.equal(a.sensitivity.providerInterruptedAsFailure.units, 1);
  const partial = analyze({ final: finalRecords(state).final.slice(1), providerFirst: new Map() }, p, { tasks, familyOf });
  assert.equal(partial.complete, false); assert.equal(partial.primary.H1.decision.verdict === "CONFIRMED", false);
});

test("design selection: candidate-blind seeded order with family/owner caps over the union; null when the union cannot supply N", async () => {
  const { designSelection } = await import("../experiments/ctrl-confirm-4/gate.mjs");
  const tasks = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, family: `gh:o${i % 5}/r${i % 10}`, external: true, hidden: true }));
  const b = [{ dir: "A", sealOk: true, uses: 0, tasks: tasks.slice(0, 20) }, { dir: "B", sealOk: true, uses: 0, tasks: tasks.slice(20) }];
  const s = designSelection(b, 25);
  assert.equal(s.length, 25);
  const per = (k) => s.reduce((m, t) => ({ ...m, [k(t)]: (m[k(t)] ?? 0) + 1 }), {});
  assert.ok(Object.values(per(t => t.family)).every(v => v <= 3)); assert.ok(Object.values(per(t => t.family.split("/")[0])).every(v => v <= 6));
  assert.deepEqual(designSelection(b, 25).map(t => t.id), s.map(t => t.id), "deterministic");
  assert.equal(designSelection(b, 31), null, "5 owners x 6 = 30 at most");
  assert.equal(designSelection([{ ...b[0], uses: 1 }], 5), null, "a used batch contributes nothing");
});

test("realized-size composition keeps every scenario's calibrated population effect (each slot's task uniform over historical tasks)", async () => {
  const { calibrate, historical } = await import("../experiments/ctrl-confirm-3/power.mjs");
  const { scenarioOf, simulate } = await import("../experiments/ctrl-confirm-4/power.mjs");
  const { createRng } = await import("../src/rng.mjs");
  const pool = calibrate(historical());
  const sizes = [1, 1, 1, 2, 2, 3, 3, 3];
  for (const [s, e1] of [["latent:0.039", 0.039], ["null:E1-only-null", 0], ["null:skewed-heterogeneous-E1", 0]]) {
    const sc = scenarioOf(s, pool), rng = createRng(`pop:${s}`); let d = 0, n = 0;
    for (let k = 0; k < 120; k++) simulate(pool, { ...sc, taskMap: (q, r, st) => { const x = sc.taskMap(q, r, st); d += x.OCR - x.OC; n++; return x; } }, { tasks: 600, rng, composition: { sizes } });
    assert.ok(Math.abs(d / n - e1) < 0.004, `${s}: simulated E1 ${d / n}`);
  }
});

// ---- A2 pre-launch hardening (2026-11-08; outcome-independent, no design change) ----

test("A2 overrun headroom: token/cost admission keeps parallelism x reservation below each ceiling; requests (hard proxy cap) need none; reservation cost uses the cache-write price", () => {
  const p = prereg({ parallelism: 4, budget: { maxInputTokens: 100_000, maxRequestsTotal: 1000 } });
  const rm = resourceManagerOf(tempDir(), p); rm.startSession();
  assert.equal(rm.overrunSlots, 4);
  assert.ok(Math.abs(rm.reserveVec.costUsd - (10_000 * 0.125 + 1_000 * 0.5) / 1e6) < 1e-12, "input reserved at max(uncached, cache-write) price");
  // 10k per attempt + 4 x 10k headroom: admitted while reserved + 10k + 40k <= 100k -> 6 reservations (without headroom: 10).
  let n = 0; while (rm.reserve(`u${n}:a1`)) n++;
  assert.equal(n, 6); assert.match(rm.paused.reason, /input-token ceiling .*headroom 40000/);
  const q = prereg({ parallelism: 4, budget: { maxRequestsTotal: 30 } });
  const rq = resourceManagerOf(tempDir(), q); rq.startSession();
  let m = 0; while (rq.reserve(`u${m}:a1`)) m++;
  assert.equal(m, 3, "request admission unchanged: floor(30 / 10)");
});

test("A2 crash between result and settlement: the open reservation is settled from the kept controller-wire evidence (not the token-less record); nothing re-runs", async () => {
  const state = tempDir(), p = prereg(), prep = fixture(p, ["a"]);
  const rm = resourceManagerOf(state, p); rm.startSession();
  const { ResourceEvaluator } = await import("../experiments/ctrl-confirm-4/run.mjs");
  const mkEv = (r) => new ResourceEvaluator({ rm: r, policy: { maxRetries: 1, maxProviderRetries: 2, pricing: PRICING, unknownRequest: p.resources.unknownUsageRequestCharge }, orphanGraceMs: 10, stateDir: state, protocol: { route: p.route, infra: p.infra, parallelism: 1 }, protocolDigest: "pd", envDigest: "ed", tasksById: prep.tasksById, grading: {}, backend: backendOf(() => { throw new Error("must not run"); }) });
  const ev = mkEv(rm), k = ev.keyOf(prep.harness.OC, "a", "confirmation", 0);
  const ledger = new Ledger(join(state, "runs.jsonl"));
  rm.reserve(`${k}:a1`);
  const d = { type: "dispatch", unit_key: k, attempt: 1, attemptId: `${k}:a1`, run_id: "r1", controlDir: join(state, "tmpfs-lost"), harness: { id: "OC", kind: "pure", commit: "c0" }, task: "a", split: "confirmation", repeat: 0 };
  ledger.append(d);
  const kept = join(ev.evidenceOf(d), "controller-wire", "s1"); mkdirSync(kept, { recursive: true });
  writeFileSync(join(kept, "wire.jsonl"), [{ phase: "start", method: "POST" }, { phase: "end", method: "POST", status: 200, usage: { input: 9000, cached: 1000, output: 90 } }].map(x => JSON.stringify(x)).join("\n") + "\n");
  ledger.append({ type: "result", unit_key: k, record: { ...makeRecord({ run_id: "r1", unit_key: k, attempt: 1, candidate_id: "OC", task_id: "a", split: "confirmation", repeat: 0, terminal_status: "aborted", terminal_detail: "controller error", model_requests_completed: 1, started_at: new Date().toISOString() }), attempt: 1, unit_key: k } });
  // crash here: the result is durable, the settlement is not
  const rm2 = resourceManagerOf(state, p); rm2.startSession();
  const ev2 = mkEv(rm2); ev2.ledger = new Ledger(join(state, "runs.jsonl"));
  await ev2.reconcileAll();
  const s = rm2.ledger.records().filter(e => e.type === "settle");
  assert.equal(s.length, 1); assert.equal(s[0].source, "result-reconciled-evidence-wire"); assert.equal(s[0].usage.input, 9000); assert.equal(s[0].usage.requests, 1);
  assert.equal(ev2.policyOf(k), "final", "the recorded outcome is final: never re-run");
  await ev2.reconcileAll();
  assert.equal(rm2.ledger.records().filter(e => e.type === "settle").length, 1, "idempotent");
});

test("A2 held pauses: credit/auth/route/infra/operator pauses survive a restart until --operator-resume; rate/cap pauses never hold; final = settled or ceiling", async () => {
  const { heldPause, isFinal } = await import("../experiments/ctrl-confirm-4/run.mjs");
  for (const kind of ["credit", "auth", "route", "infra", "operator"]) {
    const state = tempDir(), p = prereg();
    const rm = resourceManagerOf(state, p); rm.startSession(); rm.pause(`x ${kind}`, kind); rm.endSession("paused");
    const rm2 = resourceManagerOf(state, p);
    assert.equal(heldPause(rm2, false)?.kind, kind, `${kind} holds after restart`);
    assert.equal(heldPause(resourceManagerOf(state, p), false)?.kind, kind, "still held on a second restart");
    assert.equal(heldPause(rm2, true), null, "operator resume releases");
    assert.equal(heldPause(resourceManagerOf(state, p), false), null, "the resume is durable");
  }
  for (const kind of ["rate", "cap"]) {
    const state = tempDir(), p = prereg();
    const rm = resourceManagerOf(state, p); rm.startSession(); rm.pause("x", kind);
    assert.equal(heldPause(resourceManagerOf(state, p), false), null);
  }
  assert.equal(isFinal({ unsettled: 0 }), true); assert.equal(isFinal({ unsettled: 3, paused: { kind: "cap" } }), true);
  assert.equal(isFinal({ unsettled: 3, paused: { kind: "credit" } }), false); assert.equal(isFinal({ unsettled: 3, paused: null }), false);
});

test("A2 holdout uses: a crash between the two batch-use writes records only the missing use on restart; another state is refused; audit requires exactly one use per batch by this state", async () => {
  const { recordHoldoutUse } = await import("../experiments/ctrl-confirm-2/run.mjs");
  const { auditState } = await import("../experiments/ctrl-confirm-4/analyze.mjs");
  const { holdoutLedger } = await import("../src/datasets.mjs");
  const { digestOf } = await import("../src/util.mjs");
  const root = tempDir(), state = join(root, "state"); mkdirSync(state);
  for (const b of ["b1", "b2"]) mkdirSync(join(root, "results", b), { recursive: true });
  const p = prereg({ holdout: { batches: [{ path: "b1", sealDigest: "s1" }, { path: "b2", sealDigest: "s2" }] } });
  const pd = digestOf(p);
  recordHoldoutUse(join(root, "results", "b1"), { stateDir: state, experiment: "x", preregDigest: pd, seal: "s1" });
  // crash before b2; restart repeats both writes
  assert.equal(recordHoldoutUse(join(root, "results", "b1"), { stateDir: state, experiment: "x", preregDigest: pd, seal: "s1" }).reused, true);
  assert.equal(recordHoldoutUse(join(root, "results", "b2"), { stateDir: state, experiment: "x", preregDigest: pd, seal: "s2" }).reused, false);
  assert.equal(holdoutLedger(join(root, "results", "b1")).records().length, 1);
  assert.throws(() => recordHoldoutUse(join(root, "results", "b1"), { stateDir: join(root, "other"), experiment: "x", preregDigest: pd, seal: "s1" }), /already used/);
  const rm = resourceManagerOf(state, p); rm.startSession(); rm.reserve("u:a1");
  let a = auditState(state, p, { datasetsRoot: join(root, "results"), holdoutLedger });
  assert.equal(a.ok, false); assert.equal(a.openReservations, 1);
  rm.settle("u:a1", { requests: 3, input: 10, output: 1, costUsd: 0 }, "record");
  a = auditState(state, p, { datasetsRoot: join(root, "results"), holdoutLedger });
  assert.equal(a.ok, true); assert.deepEqual(a.holdoutUses.map(u => [u.uses, u.byThisState]), [[1, 1], [1, 1]]);
});

test("A2 preflight: the supplied batches must be exactly the preregistered ones (an empty or partial list never passes)", async () => {
  const { batchMatch } = await import("../experiments/ctrl-confirm-4/preflight.mjs");
  const p = { holdout: { batches: [{ path: "h3/b3", sealDigest: "s3" }, { path: "h4/b4", sealDigest: "s4" }] } };
  assert.equal(batchMatch(p, []).ok, false);
  assert.equal(batchMatch(p, [{ dir: "/r/h3/b3", sealDigest: "s3" }]).ok, false);
  assert.equal(batchMatch(p, [{ dir: "/r/h3/b3", sealDigest: "s3" }, { dir: "/r/h4/b4", sealDigest: "sX" }]).ok, false);
  assert.equal(batchMatch(p, [{ dir: "/r/h3/b3", sealDigest: "s3" }, { dir: "/r/h4/b4", sealDigest: "s4" }, { dir: "/r/h5/b5", sealDigest: "s5" }]).ok, false);
  assert.equal(batchMatch(p, [{ dir: "/r/h4/b4", sealDigest: "s4" }, { dir: "/r/h3/b3", sealDigest: "s3" }]).ok, true);
});
