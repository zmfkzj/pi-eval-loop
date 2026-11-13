// CLIProxyAPI provider compatibility (2026-11-13): the unscoped pi-cliproxyapi-provider 0.16.x (current cliproxyapi bundle) next
// to the legacy @router-for-me package. Unit checks of layout detection, endpoint gate and private configuration, then the REAL
// installed extension inside the real sandbox (task-agent runner and proposer) against the local faux upstream: no provider, no
// credential, no budget.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALLOWED, CPA_ALLOWED, PLACEHOLDER_KEY, PROVIDER_CANDIDATES, allowedEndpoints, cpaModelEntries, defaultProviderDir, environmentDigest, hostEnvironment, prerequisites, privateProviderSetup, providerLayout, upstreamKey } from "../src/sandbox.mjs";
import { DEFAULT_PROTOCOL, UMBRELLA, merge } from "../src/protocol.mjs";
import { tempDir } from "./helpers.mjs";

const pkg = (dir, json) => { mkdirSync(join(dir, "extensions"), { recursive: true }); writeFileSync(join(dir, "extensions/index.ts"), "export default () => {};\n"); if (json) writeFileSync(join(dir, "package.json"), JSON.stringify(json)); return dir; };
const INSTALLED = join(UMBRELLA, "cliproxyapi/node_modules/pi-cliproxyapi-provider");
const installedVersion = (() => { try { return JSON.parse(readFileSync(join(INSTALLED, "package.json"), "utf8")).version; } catch { return null; } })();

test("provider layout: unscoped 0.16.x is cpa, the scoped (or unnamed) package legacy, another unscoped version unverified; explicit override", () => {
  const root = tempDir();
  const cpa = pkg(join(root, "cpa"), { name: "pi-cliproxyapi-provider", version: "0.16.10" });
  const next = pkg(join(root, "next"), { name: "pi-cliproxyapi-provider", version: "0.17.0" });
  const legacy = pkg(join(root, "legacy"), { name: "@router-for-me/pi-cliproxyapi-provider", version: "1.4.21" });
  const bare = pkg(join(root, "bare"), null);
  assert.deepEqual([providerLayout(cpa, "").layout, providerLayout(cpa, "").supported], ["cpa", true]);
  assert.deepEqual([providerLayout(next, "").layout, providerLayout(next, "").supported], ["cpa", false]);
  assert.match(providerLayout(next, "").detail, /unverified version/);
  assert.deepEqual([providerLayout(legacy, "").layout, providerLayout(bare, "").layout], ["legacy", "legacy"]);
  assert.deepEqual([providerLayout(next, "cpa").layout, providerLayout(next, "cpa").supported], ["cpa", true]);
  assert.deepEqual([providerLayout(cpa, "legacy").layout, providerLayout(cpa, "bogus").supported], ["legacy", false]);
});

test("default provider: the installed unscoped package first, the legacy scoped one as fallback, EVAL_LOOP_PROVIDER overrides", () => {
  const root = tempDir();
  const first = join(root, "a"), second = pkg(join(root, "b"), null);
  assert.equal(defaultProviderDir([first, second]), second, "a missing candidate is skipped");
  pkg(first, null);
  assert.equal(defaultProviderDir([first, second]), first);
  assert.equal(defaultProviderDir([join(root, "x"), join(root, "y")]), join(root, "x"), "nothing installed: the current path (reported missing)");
  assert.equal(PROVIDER_CANDIDATES[0], INSTALLED);
  const saved = process.env.EVAL_LOOP_PROVIDER;
  try {
    delete process.env.EVAL_LOOP_PROVIDER;
    if (existsSync(join(INSTALLED, "extensions/index.ts"))) assert.equal(hostEnvironment().provider, INSTALLED);
    process.env.EVAL_LOOP_PROVIDER = second;
    assert.equal(hostEnvironment().provider, second);
  } finally { if (saved === undefined) delete process.env.EVAL_LOOP_PROVIDER; else process.env.EVAL_LOOP_PROVIDER = saved; }
});

test("endpoint gate per layout: /v1/responses only for cpa; a legacy environment keeps its gate entry and digest facts", () => {
  const root = tempDir();
  const legacy = { provider: pkg(join(root, "legacy"), { name: "@router-for-me/pi-cliproxyapi-provider", version: "1.4.21" }), piCli: join(root, "none"), bwrap: "/usr/bin/bwrap" };
  const cpa = { ...legacy, provider: pkg(join(root, "cpa"), { name: "pi-cliproxyapi-provider", version: "0.16.11" }) };
  assert.equal(allowedEndpoints(legacy), ALLOWED);
  assert.equal(allowedEndpoints(cpa), CPA_ALLOWED);
  const admits = (list, method, path) => list.some(a => a.method === method && a.path.test(path));
  assert.ok(admits(CPA_ALLOWED, "POST", "/v1/responses") && !admits(ALLOWED, "POST", "/v1/responses"));
  assert.ok(!admits(CPA_ALLOWED, "POST", "/v1/chat/completions") && !admits(CPA_ALLOWED, "POST", "/backend-api/codex/responses"));
  // Literal gate strings of every legacy digest since protocol-1 (regression: the legacy digest must not move).
  assert.deepEqual(environmentDigest(legacy, DEFAULT_PROTOCOL.route).facts.gate, ["GET /^\\/v1\\/models(\\?|$)/", "POST /^\\/backend-api\\/codex\\/responses(\\?|$)/", "POST /^\\/backend-api\\/responses(\\?|$)/"]);
  assert.notEqual(environmentDigest(legacy, DEFAULT_PROTOCOL.route).digest, environmentDigest(cpa, DEFAULT_PROTOCOL.route).digest);
});

test("private provider setup: cpa writes the sandbox HOME config and the seeded model snapshot (never ~/.pi); legacy writes cliproxyapi.json", () => {
  const root = tempDir();
  const catalog = join(root, "catalog"); mkdirSync(catalog);
  writeFileSync(join(catalog, "cliproxyapi-models.json"), JSON.stringify({ models: [{ id: "gpt-6.1-terra", cost: { input: 1 } }, { id: "gpt-6.1-sol" }, { id: "" }] }));
  assert.deepEqual(cpaModelEntries(catalog).map(m => m.id), ["gpt-6.1-sol", "gpt-6.1-terra"]);
  writeFileSync(join(catalog, "cpa-models.json"), JSON.stringify({ fetchedAt: 1, data: [{ id: "gpt-6.1-terra", object: "model", owned_by: "openai", created: 5 }] }));
  assert.deepEqual(cpaModelEntries(catalog), [{ id: "gpt-6.1-terra", object: "model", owned_by: "openai", created: 5 }], "a frozen cpa-models.json is preferred");
  const env = { provider: pkg(join(root, "cpa"), { name: "pi-cliproxyapi-provider", version: "0.16.10" }) };
  const agent = join(root, "agent"), home = join(root, "home"); mkdirSync(agent); mkdirSync(home);
  const realConfig = join(homedir(), ".pi/agent/pi-cliproxyapi-provider/config.json");
  const before = existsSync(realConfig) ? readFileSync(realConfig, "utf8") : null;
  const out = privateProviderSetup({ env, agent, home, bridgeUrl: "http://127.0.0.1:18317", providerName: "cliproxyapi", catalogDir: catalog });
  assert.deepEqual(out, { CLIPROXYAPI_BASE_URL: "http://127.0.0.1:18317/v1", CLIPROXYAPI_PROVIDER_NAME: "cliproxyapi", CLIPROXYAPI_API_KEY: PLACEHOLDER_KEY, CLIPROXYAPI_FAST: "0" });
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".pi/agent/pi-cliproxyapi-provider/config.json"), "utf8")), { providerName: "cliproxyapi", baseUrl: "http://127.0.0.1:18317/v1", authRequired: true, authHeader: true });
  const key = Buffer.from("cliproxyapi\nhttp://127.0.0.1:18317/v1").toString("base64url");
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".cache/pi-cliproxyapi-provider", key, "cpa-models.json"), "utf8")).data.map(m => m.id), ["gpt-6.1-terra"]);
  assert.ok(!existsSync(join(agent, "cliproxyapi.json")), "no legacy file for the cpa layout");
  assert.equal(existsSync(realConfig) ? readFileSync(realConfig, "utf8") : null, before, "the real ~/.pi config is untouched");
  const legacyEnv = { provider: pkg(join(root, "legacy"), { name: "@router-for-me/pi-cliproxyapi-provider", version: "1.4.21" }) };
  const agent2 = join(root, "agent2"); mkdirSync(agent2);
  assert.deepEqual(privateProviderSetup({ env: legacyEnv, agent: agent2, home, bridgeUrl: "http://127.0.0.1:18317", providerName: "cliproxyapi", catalogDir: catalog }), { CLIPROXYAPI_BASE_URL: "http://127.0.0.1:18317", CLIPROXYAPI_API_KEY: PLACEHOLDER_KEY, CLIPROXYAPI_FAST: "0" });
  assert.equal(JSON.parse(readFileSync(join(agent2, "cliproxyapi.json"), "utf8")).apiKey, PLACEHOLDER_KEY);
});

test("upstream key: cliproxyapi.json first, else a literal apiKey of the 0.16.x global config (a !command is never run)", () => {
  const root = tempDir();
  assert.equal(upstreamKey(root), "");
  mkdirSync(join(root, "pi-cliproxyapi-provider"));
  writeFileSync(join(root, "pi-cliproxyapi-provider/config.json"), JSON.stringify({ apiKey: "!cat /etc/hostname" }));
  assert.equal(upstreamKey(root), "");
  writeFileSync(join(root, "pi-cliproxyapi-provider/config.json"), JSON.stringify({ apiKey: "lit" }));
  assert.equal(upstreamKey(root), "lit");
  writeFileSync(join(root, "cliproxyapi.json"), JSON.stringify({ apiKey: "legacy" }));
  assert.equal(upstreamKey(root), "legacy");
});

// ---------------------------------------------------------------------------------------------- real installed extension
const env0 = hostEnvironment();
const realReady = existsSync(join(INSTALLED, "extensions/index.ts")) && existsSync(env0.piCli) && existsSync(env0.bwrap) && existsSync(join(UMBRELLA, "orche/node_modules")) && existsSync(join(UMBRELLA, "orche/fixtures/suite"));
const skip = realReady ? false : "installed provider, pi CLI, bwrap or orche checkout missing";

function realEnv(root, upstream) {
  const agent = join(root, "agent-src"); mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "cliproxyapi-models.json"), JSON.stringify({ models: [{ id: "gpt-6.1-terra", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }, { id: "gpt-6.1-sol" }] }));
  writeFileSync(join(agent, "cliproxyapi.json"), JSON.stringify({ apiKey: "unused-test-key" }), { mode: 0o600 });
  return { ...env0, provider: INSTALLED, agentDir: agent, catalogDir: agent, upstream, keyOverride: "faux-test-key" };
}

test(`real sandbox, installed pi-cliproxyapi-provider ${installedVersion}: the task agent registers cliproxyapi/gpt-6.1-terra offline and completes through the gate (faux upstream)`, { skip, timeout: 240_000 }, async () => {
  const { loadSuite } = await import("../src/datasets.mjs");
  const { startFauxUpstream } = await import("../src/faux-upstream.mjs");
  const { runUnit } = await import("../src/runner.mjs");
  const task = loadSuite(join(UMBRELLA, "orche/fixtures/suite")).find(t => t.id === "a1-rounding");
  const faux = await startFauxUpstream({ tasks: [{ ...task, policy: { solve: 1 } }], model: "gpt-6.1-terra", seed: "compat" });
  // Conflicting values in the controller's environment never reach the sandbox (it starts from an empty environment).
  const saved = { ...process.env };
  Object.assign(process.env, { CLIPROXYAPI_BASE_URL: "http://127.0.0.1:9/bogus", CLIPROXYAPI_PROVIDER_NAME: "cpa", CLIPROXYAPI_API_KEY: "conflicting" });
  try {
    const root = tempDir();
    const env = realEnv(root, faux.url);
    assert.equal(providerLayout(env.provider).layout, "cpa");
    const protocol = merge(structuredClone(DEFAULT_PROTOCOL), { route: { provider: "cliproxyapi", model: "gpt-6.1-terra", effort: "medium" }, unit: { wallMs: 150_000, graderMs: 60_000 } });
    const record = await runUnit({ harness: { id: "pure", kind: "pure" }, task, repeat: 0, split: "train", context: "compat", protocol, protocolDigest: "p", env, envDigest: "e", scratch: join(root, "scratch"), evidence: join(root, "evidence"), unitKey: "u", runId: "compat-1" });
    const stderr = readdirSync(join(root, "evidence")).filter(f => f.startsWith("stderr")).map(f => readFileSync(join(root, "evidence", f), "utf8")).join("\n");
    assert.equal(record.terminal_status, "completed", `${record.terminal_detail} ${stderr.slice(-600)}`);
    assert.ok(record.model_requests >= 2 && record.model_requests_completed === record.model_requests, JSON.stringify({ requests: record.model_requests, completed: record.model_requests_completed }));
    assert.equal(record.hidden_test_pass, true);
    assert.ok(faux.requests.length >= 2 && faux.requests.every(r => r.path === "/v1/responses"), JSON.stringify(faux.requests.map(r => r.path)));
    const wire = readdirSync(join(root, "evidence")).filter(f => /^wire-.*\.jsonl$/.test(f)).flatMap(f => readFileSync(join(root, "evidence", f), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)));
    assert.ok(wire.filter(e => e.phase === "end").every(e => e.model === "gpt-6.1-terra" && e.effort === "medium"), "every forwarded request carries the pinned route");
    assert.ok(!wire.some(e => e.phase === "refused"));
  } finally { process.env = saved; await faux.stop(); }
});

test(`real sandbox, installed pi-cliproxyapi-provider ${installedVersion}: the proposer registers its route privately and reaches the faux upstream through the gate`, { skip, timeout: 240_000 }, async () => {
  const { startFauxUpstream } = await import("../src/faux-upstream.mjs");
  const { proposeReal } = await import("../src/proposer.mjs");
  const faux = await startFauxUpstream({ tasks: [], model: "gpt-6.1-sol", seed: "compat-p" });
  try {
    const root = tempDir();
    const env = realEnv(root, faux.url);
    const worktree = join(root, "worktree"); mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "package.json"), "{\"name\":\"h\",\"private\":true}\n"); writeFileSync(join(worktree, "src/a.ts"), "export const a = 1;\n");
    const evidenceDir = join(root, "ev"); mkdirSync(evidenceDir);
    const protocol = merge(structuredClone(DEFAULT_PROTOCOL), { proposer: { route: { provider: "cliproxyapi", model: "gpt-6.1-sol", effort: "high" }, maxRequests: 4, wallMs: 150_000 } });
    const out = await proposeReal({ worktree, evidenceDir, protocol, env, parentId: "c0", targetClass: "termination-premature", blockedClasses: [], logDir: join(root, "log") });
    const stderr = existsSync(join(root, "log/stderr.txt")) ? readFileSync(join(root, "log/stderr.txt"), "utf8") : "";
    assert.equal(out.usage.exit, 0, stderr.slice(-600));
    assert.ok(out.usage.requests >= 1 && out.usage.completed === out.usage.requests, JSON.stringify(out.usage));
    assert.ok(faux.requests.length >= 1 && faux.requests.every(r => r.path === "/v1/responses"));
    assert.doesNotMatch(stderr, /not found/i);
  } finally { await faux.stop(); }
});

test(`real sandbox, installed pi-cliproxyapi-provider ${installedVersion}: the engine's selected target route (exploreProtocol + Evaluator + realBackend) sends cliproxyapi/gpt-6.1-terra upstream and records it (faux upstream, no live model)`, { skip, timeout: 240_000 }, async () => {
  const { loadSuite } = await import("../src/datasets.mjs");
  const { startFauxUpstream } = await import("../src/faux-upstream.mjs");
  const { Evaluator, realBackend } = await import("../src/evaluator.mjs");
  const { exploreProtocol } = await import("../src/exploration.mjs");
  const task = loadSuite(join(UMBRELLA, "orche/fixtures/suite")).find(t => t.id === "a1-rounding");
  const faux = await startFauxUpstream({ tasks: [{ ...task, policy: { solve: 1 } }], model: "gpt-6.1-terra", seed: "route" });
  try {
    const root = tempDir();
    const env = realEnv(root, faux.url);
    const route = { provider: "cliproxyapi", model: "gpt-6.1-terra", effort: "medium" };
    const protocol = merge(exploreProtocol(route), { unit: { wallMs: 150_000, graderMs: 60_000 }, parallelism: 1 });
    const evaluator = new Evaluator({ stateDir: join(root, "state"), protocol, protocolDigest: "p", envDigest: environmentDigest(env, protocol.route), tasksById: { [task.id]: task }, grading: { [task.id]: { ok: true, expected: {}, baselineFailing: [] } }, backend: realBackend(env) });
    const [rec] = await evaluator.evaluate({ id: "stable", kind: "pure" }, [{ task: task.id, split: "dev", repeat: 0 }], "route-check");
    assert.equal(rec.terminal_status, "completed", rec.terminal_detail);
    assert.equal(rec.model_route, "cliproxyapi/gpt-6.1-terra"); assert.equal(rec.thinking_effort, "medium");
    assert.ok(faux.requests.length >= 1 && faux.requests.every(r => r.model === "gpt-6.1-terra"), JSON.stringify(faux.requests.map(r => [r.model, r.effort])));
    assert.equal(environmentDigest(env, protocol.route).facts.route.model, "gpt-6.1-terra");
  } finally { await faux.stop(); }
});

test("prerequisites name the provider package and its layout", { skip: existsSync(join(INSTALLED, "package.json")) ? false : "no installed provider" }, async () => {
  const env = { ...env0, provider: INSTALLED, upstream: "http://127.0.0.1:9" };
  const p = (await prerequisites(env)).find(x => x.name === "provider");
  assert.ok(p.ok, p.detail);
  assert.match(p.detail, /pi-cliproxyapi-provider@0\.16\.\d+: layout cpa/);
});
