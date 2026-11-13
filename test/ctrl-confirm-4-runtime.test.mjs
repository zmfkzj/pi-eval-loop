// ctrl-confirm-4 A3: frozen runtime snapshot, per-dispatch identity guard, versioned continuation of a launched state, held
// pauses across restarts, graceful drain. Deterministic and model-free (simulated backends, temporary trees only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.mjs";
import { makeRecord } from "../src/metrics.mjs";
import { buildQueue } from "../experiments/ctrl-ablation/lib.mjs";
import { RuntimeGuard, appendContinuation, buildSnapshot, continuationProblems, effectiveLock, envFor, envProblems, fingerprintOf, LAYOUT } from "../experiments/ctrl-confirm-4/runtime.mjs";
import { heldPause, lockState, resourceManagerOf, runCampaign } from "../experiments/ctrl-confirm-4/run.mjs";
import { boxView } from "../src/sandbox.mjs";

const PRICING = { inputPerM: 0.1, cachedInputPerM: 0.01, cacheWritePerM: 0.125, outputPerM: 0.5 };
const BUDGET = { maxRequestsTotal: 1e9, maxInputTokens: 1e12, maxOutputTokens: 1e12, maxCostUsdApiEquivalent: 1e9, maxActiveHours: 1e6, maxCampaignWallHours: 1e6, maxConsecutiveInfra: 5 };
const prereg = () => ({
  id: "cc4-test", seed: "cc4-test", route: { provider: "p", model: "m", effort: "medium" }, unit: { wallMs: 60_000, maxRequests: 10, graderMs: 1000 }, infra: { maxRetries: 1, maxProviderRetries: 2 },
  parallelism: 2, capture: {}, integrity: {}, repeats: 2, arms: [{ id: "OC" }, { id: "OCR" }], pricing: PRICING, budget: BUDGET,
  resources: { reservePerAttempt: { requests: 10, input: 10_000, output: 1_000 }, attemptSetupMs: 1000, heartbeatMs: 0, unknownUsageRequestCharge: { input: 5000, output: 500 }, planned: null },
});
const fixture = (p, tasks = ["a", "b", "c"]) => ({
  tasksById: Object.fromEntries(tasks.map(t => [t, { id: t, family: `f-${t}`, instruction: "x" }])),
  harness: { OC: { id: "OC", kind: "pure", commit: "c0" }, OCR: { id: "OCR", kind: "pure", commit: "c1" } },
  grading: {}, queue: buildQueue({ arms: ["OC", "OCR"], tasks, repeats: p.repeats, seed: p.seed }), lock: { smoke: false, preregDigest: "pd", envDigest: "ed", queueDigest: "qd" },
});
const rec = (input) => makeRecord({ run_id: input.runId, unit_key: input.unitKey, attempt: input.attempt, candidate_id: input.harness.id, task_id: input.task.id, split: input.split, repeat: input.repeat, model_route: "p/m", thinking_effort: "medium", protocol_digest: input.protocolDigest, environment_digest: input.envDigest, terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, model_requests: 4, model_requests_completed: 4, input_tokens: 2000, cache_tokens: 1500, cache_write_tokens: 0, output_tokens: 100, started_at: new Date().toISOString() });
const backendOf = (fn, delay = 2) => ({ simulated: true, async run(input) { await new Promise(r => setTimeout(r, delay)); return fn(input); } });

/** A small fake runtime closure (node dir, pi modules with the CLI path, provider, orche modules with a cache dir, catalog). */
function sources(root) {
  const mk = (rel, files) => { mkdirSync(join(root, rel), { recursive: true }); for (const [f, c] of Object.entries(files)) { mkdirSync(join(root, rel, f, ".."), { recursive: true }); writeFileSync(join(root, rel, f), c); } return join(root, rel); };
  const piModules = mk("bun/node_modules", { "@earendil-works/pi-coding-agent/dist/bundle/cli.js": "cli", "@earendil-works/pi-coding-agent/package.json": "{\"version\":\"1.5.0\"}", "x/index.js": "x" });
  symlinkSync("../x/index.js", join(piModules, "@earendil-works", "link.js"));
  const orcheModules = mk("orche/node_modules", { "typebox/index.js": "t", ".vite/cache.json": "{}" });
  mk("agent", { "cliproxyapi-models.json": "{}" });
  return { node: mk("node", { "bin/node": "n" }), piModules, provider: mk("provider", { "extensions/index.ts": "p", "package.json": "{\"version\":\"1.4.25\"}" }), orcheModules, catalog: [join(root, "agent/cliproxyapi-models.json")] };
}

test("A3 snapshot: copied, manifest-bound, read-only and sealed; host caches dropped; a full start verification passes", () => {
  const dir = tempDir(), src = sources(join(dir, "src")), root = join(dir, "rt");
  const s = buildSnapshot(root, src);
  assert.ok(s.manifestDigest && s.entries > 5);
  const g = new RuntimeGuard({ root });
  assert.deepEqual(g.start(), []);
  assert.equal(g.check(), null);
  assert.throws(() => writeFileSync(join(root, LAYOUT.provider, "extensions/index.ts"), "changed"), /EACCES|EPERM/);
  assert.equal(JSON.parse(readFileSync(join(root, "MANIFEST.json"), "utf8")).list.some(e => e[0].includes(".vite")), false);
  const env = { nodeDir: join(root, "node"), piModules: join(root, LAYOUT.piModules), piCli: envFor(root).EVAL_LOOP_PI_CLI, provider: envFor(root).EVAL_LOOP_PROVIDER, orcheModules: envFor(root).EVAL_LOOP_ORCHE_MODULES, catalogDir: envFor(root).EVAL_LOOP_CATALOG_DIR };
  assert.deepEqual(envProblems(env, root), []);
  assert.match(envProblems({ ...env, orcheModules: src.orcheModules }, root).join(), /orcheModules/, "a shared path outside the snapshot is refused");
  assert.throws(() => buildSnapshot(root, src), /exists/);
  // in-box locations: the snapshot's node / pi trees are mounted where they were copied from (same paths inside the sandbox)
  const vars = envFor(root);
  assert.equal(vars.EVAL_LOOP_BOX_NODE_DIR, src.node); assert.equal(vars.EVAL_LOOP_BOX_PI_MODULES, src.piModules);
  const boxed = { ...env, node: join(root, "node/bin/node"), boxNodeDir: src.node, boxPiModules: src.piModules };
  assert.deepEqual(envProblems(boxed, root, { node: src.node, piModules: src.piModules }), []);
  assert.match(envProblems({ ...boxed, boxPiModules: join(root, LAYOUT.piModules) }, root, { node: src.node, piModules: src.piModules }).join(), /in-box pi modules/);
  const view = boxView(boxed);
  assert.equal(view.node, join(src.node, "bin/node")); assert.equal(view.piCli, join(src.piModules, "@earendil-works/pi-coding-agent/dist/bundle/cli.js"));
  assert.deepEqual(view.piBind, { from: join(root, LAYOUT.piModules), to: src.piModules });
  const plain = boxView({ node: "/n/bin/node", nodeDir: "/n", piCli: "/p/x/cli.js", piModules: "/p" });
  assert.deepEqual([plain.node, plain.piCli, plain.nodeBind.to], ["/n/bin/node", "/p/x/cli.js", "/n"], "no snapshot: identity");
});

test("A3 guard: a content change, a chmod (made writable) or a replaced file fails both the start verification and the per-dispatch check", () => {
  const dir = tempDir(), src = sources(join(dir, "src")), root = join(dir, "rt");
  buildSnapshot(root, src);
  const f = join(root, LAYOUT.orcheModules, "typebox/index.js");
  chmodSync(join(root, LAYOUT.orcheModules, "typebox"), 0o755); chmodSync(f, 0o644);
  const g = new RuntimeGuard({ root });
  assert.match(g.check(), /snapshot changed/, "chmod alone changes the fingerprint");
  writeFileSync(f, "patched");
  const problems = g.start().join(" | ");
  assert.match(problems, /content differs/); assert.match(problems, /writable/); assert.match(problems, /fingerprint/);
  const g2 = new RuntimeGuard({ root, manifestDigest: "something-else" });
  assert.match(g2.start().join(), /not the bound/);
});

test("A3 guard: symlinks escaping the snapshot are refused when building; a watched harness tree and extra evaluator files are checked", () => {
  const dir = tempDir(), src = sources(join(dir, "src"));
  symlinkSync("/etc/hostname", join(src.orcheModules, "escape"));
  assert.throws(() => buildSnapshot(join(dir, "rt"), src), /escape the snapshot/);
  const src2 = sources(join(dir, "src2")), root = join(dir, "rt2");
  buildSnapshot(root, src2);
  const harness = join(dir, "harness"); mkdirSync(harness); writeFileSync(join(harness, "a.ts"), "a");
  const extra = join(dir, "proxy.mjs"); writeFileSync(extra, "proxy");
  const g = new RuntimeGuard({ root, extraFiles: [extra] }).watchTree(harness);
  assert.equal(g.check(), null);
  writeFileSync(join(harness, "a.ts"), "b");
  assert.match(g.check(), /harness tree changed/);
  const g3 = new RuntimeGuard({ root, extraFiles: [extra] });
  writeFileSync(extra, "proxy2");
  assert.match(g3.check(), /evaluator file changed/);
  assert.equal(typeof fingerprintOf(root), "string");
});

/** A launched state: lock.json written by lockState, as the runner does. */
function launchedState(over = {}) {
  const state = tempDir();
  const lock = { experiment: "cc4", smoke: false, preregDigest: "P", envDigest: "E1", queueDigest: "Q", files: { "a.mjs": "h1", "b.mjs": "h2" }, harness: { OC: { tree: "t" } }, tasks: { a: "ta" }, instructions: { a: "ia" }, grading: { a: { expected: 1 } }, holdoutSeals: { b1: "s1" }, ...over };
  lockState(state, lock, [{ arm: "OC", task: "a", repeat: 0 }]);
  return { state, lock };
}

test("A3 drift before/after the lock: without a continuation any environment or file change is refused; a continuation re-binds ONLY env/files/runtime", () => {
  const { state, lock } = launchedState();
  const originalBytes = readFileSync(join(state, "lock.json"), "utf8");
  assert.throws(() => lockState(state, { ...lock, envDigest: "E2" }, []), /envDigest changed/);
  assert.throws(() => lockState(state, { ...lock, files: { ...lock.files, "a.mjs": "h1b" } }, []), /files\.a\.mjs changed/);
  const v = appendContinuation(state, { reason: "test", binding: { envDigest: "E2", files: { ...lock.files, "a.mjs": "h1b", "runtime.mjs": "h3" }, runtime: { root: "/rt", manifestDigest: "M1" } } });
  assert.equal(v.version, 1);
  const cur = { ...lock, envDigest: "E2", files: { ...lock.files, "a.mjs": "h1b", "runtime.mjs": "h3" }, runtime: { root: "/rt", manifestDigest: "M1" } };
  const eff = lockState(state, cur, []);
  assert.equal(eff.envDigest, "E2"); assert.equal(eff.continuation, 1);
  assert.equal(readFileSync(join(state, "lock.json"), "utf8"), originalBytes, "the original lock is never rewritten");
  assert.throws(() => lockState(state, { ...cur, runtime: { root: "/rt", manifestDigest: "M2" } }, []), /runtime snapshot/);
  assert.throws(() => lockState(state, { ...cur, runtime: undefined }, []), /runtime snapshot none/);
  assert.throws(() => lockState(state, { ...cur, envDigest: "E3" }, []), /envDigest/);
  for (const [k, val] of [["queueDigest", "Q2"], ["preregDigest", "P2"], ["tasks", { a: "tb" }], ["grading", { a: { expected: 2 } }], ["harness", { OC: { tree: "u" } }]]) {
    assert.throws(() => lockState(state, { ...cur, [k]: val }, []), new RegExp(`${k} changed`), `${k} stays frozen under a continuation`);
  }
  assert.throws(() => lockState(state, { ...cur, holdoutSeals: { b1: "s2" } }, []), /holdoutSeals/);
});

test("A3 continuation: hash-chained versions; an edited version or a replaced lock.json is detected and refused", () => {
  const { state, lock } = launchedState();
  appendContinuation(state, { reason: "v1", binding: { envDigest: "E2", files: lock.files, runtime: { manifestDigest: "M1" } } });
  appendContinuation(state, { reason: "v2", binding: { envDigest: "E2", files: lock.files, runtime: { manifestDigest: "M2" } } });
  assert.deepEqual(continuationProblems(state), []);
  assert.equal(effectiveLock(state, lock).lock.runtime.manifestDigest, "M2");
  const path = join(state, "continuation.json"), text = readFileSync(path, "utf8");
  writeFileSync(path, text.replace('"reason": "v1"', '"reason": "v1-edited"'));
  assert.match(continuationProblems(state).join(), /hash mismatch/);
  assert.throws(() => lockState(state, { ...lock, envDigest: "E2", runtime: { manifestDigest: "M2" } }, []), /continuation damaged/);
  writeFileSync(path, text);
  writeFileSync(join(state, "lock.json"), readFileSync(join(state, "lock.json"), "utf8").replace('"E1"', '"E9"'));
  assert.match(continuationProblems(state).join(), /lock\.json differs/);
  assert.throws(() => appendContinuation(state, { reason: "v3", binding: {} }), /damaged/);
});

const guardOf = () => { let drift = null; return { id: "rt-test", set: (d) => { drift = d; }, check: () => drift }; };

test("A3 pre-dispatch drift: nothing is reserved or dispatched, the campaign is held (runtime) and stays held across restarts until an operator resume", async () => {
  const state = tempDir(), p = prereg(), prep = fixture(p);
  const g = guardOf();
  const rm = resourceManagerOf(state, p); rm.startSession();
  let calls = 0;
  const s1 = await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend: backendOf((i) => { calls++; if (calls === 3) g.set("runtime snapshot changed (lstat fingerprint)"); return rec(i); }), rm, guard: g, log: () => {} });
  rm.endSession("paused");
  assert.equal(s1.paused.kind, "runtime");
  const st = rm.state();
  assert.equal(st.open.size, 0, "every reservation is settled (in-flight attempts finished)");
  const dispatched = readFileSync(join(state, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => e.type === "dispatch");
  assert.ok(dispatched.every(d => d.runtime === "rt-test"), "per-unit provenance: every dispatch records the runtime id");
  assert.equal(dispatched.length, calls, "no dispatch after the drift was seen");
  assert.ok(rm.ledger.records().some(e => e.type === "runtime-drift" && e.phase === "mid-unit"), "the drift seen after attempt 3 is recorded with that attempt");
  // restart (e.g. an automatic service restart): still held
  for (let i = 0; i < 2; i++) assert.equal(heldPause(resourceManagerOf(state, p), false)?.kind, "runtime");
  const settledBefore = st.consumed.requests;
  // operator fixes the runtime and resumes: the queue continues, completed units are never re-run, nothing is charged twice
  const rm2 = resourceManagerOf(state, p);
  assert.equal(heldPause(rm2, true), null); rm2.startSession();
  g.set(null);
  const ran = new Set();
  const s2 = await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend: backendOf((i) => { assert.ok(!ran.has(i.unitKey), "no unit runs twice"); ran.add(i.unitKey); return rec(i); }), rm: rm2, guard: g, log: () => {} });
  rm2.endSession("done");
  assert.equal(s2.unsettled, 0);
  assert.equal(ran.size, prep.queue.length - calls, "only the units that never ran are dispatched");
  const st2 = rm2.state();
  assert.equal(st2.consumed.requests, settledBefore + ran.size * 4);
  const settles = rm2.ledger.records().filter(e => e.type === "settle");
  assert.equal(new Set(settles.map(e => e.attemptId)).size, settles.length, "no double charge");
});

test("A3 mid-unit drift: the attempt's outcome is kept (flagged with the drift) and charged; nothing else is dispatched", async () => {
  const state = tempDir(), p = { ...prereg(), parallelism: 1 }, prep = fixture(p, ["a"]);
  const g = guardOf();
  const rm = resourceManagerOf(state, p); rm.startSession();
  const s = await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend: backendOf((i) => { g.set("evaluator file changed: proxy.mjs"); return rec(i); }), rm, guard: g, log: () => {} });
  assert.equal(s.paused.kind, "runtime");
  const results = readFileSync(join(state, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => e.type === "result");
  assert.equal(results.length, 1);
  assert.equal(results[0].record.runtime.verifiedAfter, false); assert.match(results[0].record.runtime.drift, /proxy\.mjs/);
  assert.equal(results[0].record.terminal_status, "completed", "the outcome itself is never altered or dropped");
  assert.equal(rm.state().open.size, 0); assert.equal(rm.state().consumed.requests, 4);
  const { auditState } = await import("../experiments/ctrl-confirm-4/analyze.mjs");
  const { holdoutLedger } = await import("../src/datasets.mjs");
  const audit = auditState(state, { ...p, holdout: { batches: [] } }, { datasetsRoot: state, holdoutLedger });
  assert.equal(audit.midUnitDrifts, 1); assert.equal(audit.ok, false, "a mid-unit runtime change taints the audit (evidence never silently accepted)");
});

test("A3 graceful drain: an operator pause during an attempt lets it finish and be recorded; nothing new is dispatched; the state stays held", async () => {
  const state = tempDir(), p = { ...prereg(), parallelism: 2 }, prep = fixture(p);
  const rm = resourceManagerOf(state, p); rm.startSession();
  let calls = 0;
  const s = await runCampaign({ stateDir: state, prereg: p, prepared: prep, backend: backendOf((i) => { calls++; if (calls === 2) rm.pause("operator drain (SIGUSR1)", "operator"); return rec(i); }, 5), rm, log: () => {} });
  assert.equal(s.paused.kind, "operator");
  const recs = readFileSync(join(state, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  assert.equal(recs.filter(e => e.type === "dispatch").length, recs.filter(e => e.type === "result").length, "every dispatched attempt finished and was recorded");
  assert.equal(rm.state().open.size, 0);
  assert.ok(calls <= 3, "at most the in-flight attempts finished after the drain");
  assert.equal(heldPause(resourceManagerOf(state, p), false)?.kind, "operator");
});
