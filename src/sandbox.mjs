// Execution environment: the bubblewrap sandbox and fail-closed route proxy reused from orche's witness-replay pilot, plus an
// endpoint gate in front of that proxy (the proxy itself admits every GET and forwards any path with the real key substituted;
// candidates must only reach the inference and model-list endpoints).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { UMBRELLA } from "./protocol.mjs";
import { digestOf, ensureDir, sha256 } from "./util.mjs";

export const ORCHE = join(UMBRELLA, "orche");
const WR = join(ORCHE, "experiments/witness-replay");
export const PROXY = join(WR, "proxy.mjs");
export const BRIDGE = join(WR, "bridge.mjs");
// Reused by import (Node strips the types; the module has only node: imports).
const sandboxModule = await import(join(WR, "sandbox.ts"));
export const { bwrapArgs, runSandboxed, HIDDEN_ROOTS, BWRAP } = sandboxModule;

export const BRIDGE_PORT = 18317;
export const MOUNTS = { socket: "/run/eval-loop/model.sock", bridge: "/opt/eval-loop/bridge.mjs", launch: "/opt/eval-loop/launch.sh", provider: "/opt/eval-loop/provider", harness: "/opt/eval-loop/harness" };
export const PLACEHOLDER_KEY = "pi-eval-loop-placeholder-key";
export const ALLOWED = [{ method: "GET", path: /^\/v1\/models(\?|$)/ }, { method: "POST", path: /^\/backend-api\/codex\/responses(\?|$)/ }, { method: "POST", path: /^\/backend-api\/responses(\?|$)/ }];

/**
 * The ONLY parts of an orche harness checkout that a sandboxed agent (task agent or proposer) ever sees: the extension runtime.
 * orche's tracked fixtures (train/dev hidden tests and reference solutions), experiments, tests, docs and its .git pointer stay
 * outside every model-facing sandbox.
 */
export const HARNESS_RUNTIME = ["src", "prompts", "package.json", "tsconfig.json"];
export const harnessBinds = (dir, to, { rw = false } = {}) => HARNESS_RUNTIME.filter(name => existsSync(join(dir, name))).map(name => ({ from: join(dir, name), to: `${to}/${name}`, rw }));

/** Resolved host environment (all overridable by EVAL_LOOP_* variables). */
export function hostEnvironment() {
  const piCli = process.env.EVAL_LOOP_PI_CLI ?? join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const piModules = resolve(piCli, "../../../../..");
  return {
    node: process.execPath, nodeDir: resolve(process.execPath, "../.."), piCli, piModules,
    provider: process.env.EVAL_LOOP_PROVIDER ?? join(UMBRELLA, "cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider"),
    agentDir: process.env.EVAL_LOOP_AGENT_DIR ?? join(homedir(), ".pi/agent"),
    upstream: process.env.EVAL_LOOP_UPSTREAM ?? "http://127.0.0.1:8317",
    bwrap: BWRAP, orche: ORCHE,
  };
}

const version = (cmd, args) => { try { return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).toString().trim(); } catch { return undefined; } };
const fileHash = (path) => { try { return sha256(readFileSync(path)); } catch { return undefined; } };

/** Digest of everything that must be identical across compared arms (not the harness itself). */
export function environmentDigest(env, route) {
  const providerPkg = (() => { try { return JSON.parse(readFileSync(join(env.provider, "package.json"), "utf8")).version; } catch { return undefined; } })();
  const facts = { node: process.version, piCli: fileHash(env.piCli), piVersion: (() => { try { return JSON.parse(readFileSync(resolve(env.piCli, "../../../package.json"), "utf8")).version; } catch { return undefined; } })(), provider: providerPkg, providerIndex: fileHash(join(env.provider, "extensions/index.ts")), bwrap: fileHash(env.bwrap), route, hiddenRoots: HIDDEN_ROOTS, gate: ALLOWED.map(a => `${a.method} ${a.path}`) };
  return { digest: digestOf(facts), facts };
}

/** Upstream reachability (GET of the model list; no model request, nothing printed). */
export async function upstreamReachable(upstream, timeoutMs = 3000) {
  return new Promise(resolveCheck => {
    const url = new URL("/v1/models", upstream);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", timeout: timeoutMs }, res => { res.resume(); resolveCheck({ ok: res.statusCode !== undefined, status: res.statusCode }); });
    req.on("timeout", () => { req.destroy(); resolveCheck({ ok: false, error: "timeout" }); });
    req.on("error", error => resolveCheck({ ok: false, error: error.code ?? String(error) }));
    req.end();
  });
}

/** Prerequisites of real (model) evaluation; each { name, ok, detail }. Credentials are checked for presence only. */
export async function prerequisites(env = hostEnvironment()) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  add("bwrap", existsSync(env.bwrap) && version(env.bwrap, ["--version"]), version(env.bwrap, ["--version"]) ?? `missing ${env.bwrap}`);
  const sandboxProbe = existsSync(env.bwrap) ? (() => { try { execFileSync(env.bwrap, bwrapArgs({ binds: [], env: { PATH: "/usr/bin:/bin" }, cwd: "/", command: ["/bin/true"] }), { stdio: "ignore", timeout: 20_000 }); return true; } catch { return false; } })() : false;
  add("bwrap-namespaces", sandboxProbe, sandboxProbe ? "user/net/pid namespaces usable" : "bwrap cannot create the sandbox (unprivileged user namespaces?)");
  add("pi-cli", existsSync(env.piCli), env.piCli);
  add("provider", existsSync(join(env.provider, "extensions/index.ts")), env.provider);
  add("orche", existsSync(join(env.orche, "src/extension/index.ts")) && existsSync(join(env.orche, "node_modules")), env.orche);
  add("git", version("git", ["--version"]), version("git", ["--version"]) ?? "missing");
  let credential = false;
  try { credential = !!JSON.parse(readFileSync(join(env.agentDir, "cliproxyapi.json"), "utf8")).apiKey; } catch { /* absent */ }
  add("credentials", credential, credential ? "cliproxyapi.json apiKey: set" : `no apiKey in ${join(env.agentDir, "cliproxyapi.json")}`);
  add("model-catalog", existsSync(join(env.agentDir, "cliproxyapi-models.json")), join(env.agentDir, "cliproxyapi-models.json"));
  const up = await upstreamReachable(env.upstream);
  add("upstream", up.ok, up.ok ? `${env.upstream} answered ${up.status}` : `${env.upstream}: ${up.error}`);
  return out;
}

/** Catalog entry prices of a model (for the proxy's list-price accounting; recorded, never an objective). */
export function catalogPrices(agentDir, model) {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "cliproxyapi-models.json"), "utf8"));
    const entry = (parsed.models ?? []).find(m => m.id === model);
    return entry?.cost ? { [model]: entry.cost } : {};
  } catch { return {}; }
}

/**
 * Start the route proxy (orche proxy.mjs: pinned model+effort, request budget, key substitution, wire journal) on a private unix
 * socket, and the endpoint gate on the socket the sandbox gets. Resolves with { socket, wireLog, totals(), stop() }.
 */
export async function startModelPath({ dir, route, maxRequests, upstream, agentDir, keyOverride }) {
  ensureDir(dir);
  const proxySocket = join(dir, "proxy.sock"), gateSocket = join(dir, "gate.sock"), keyFile = join(dir, "key"), envelope = join(dir, "envelope.json");
  const wireLog = join(dir, "wire.jsonl");
  let key = keyOverride;
  if (key === undefined) { try { key = String(JSON.parse(readFileSync(join(agentDir, "cliproxyapi.json"), "utf8")).apiKey ?? ""); } catch { key = ""; } }
  writeFileSync(keyFile, key, { mode: 0o600 });
  writeFileSync(envelope, JSON.stringify({ route: { model: route.model, effort: route.effort }, maxRequests, placeholderKey: PLACEHOLDER_KEY, prices: catalogPrices(agentDir, route.model) }));
  const child = spawn(process.execPath, [PROXY, "--listen", proxySocket, "--target", upstream, "--log", wireLog, "--envelope", envelope, "--key-file", keyFile], { stdio: ["ignore", "pipe", "pipe"], detached: false });
  try {
    await new Promise((ok, fail) => {
      let text = "";
      const timer = setTimeout(() => fail(new Error(`proxy did not start: ${text}`)), 15_000);
      child.stdout.on("data", c => { text += c; if (/LISTENING /.test(text)) { clearTimeout(timer); ok(); } });
      child.stderr.on("data", c => { text += c; });
      child.once("exit", code => { clearTimeout(timer); fail(new Error(`proxy exited ${code}: ${text}`)); });
    });
  } finally { rmSync(keyFile, { force: true }); }
  const gateLog = [];
  const gate = http.createServer((req, res) => {
    const allowed = ALLOWED.some(a => a.method === req.method && a.path.test(req.url ?? ""));
    if (!allowed) { gateLog.push({ at: new Date().toISOString(), method: req.method, path: String(req.url).slice(0, 200) }); res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "eval_loop_endpoint_refused", message: "endpoint not permitted" } })); req.resume(); return; }
    const up = http.request({ socketPath: proxySocket, path: req.url, method: req.method, headers: req.headers }, upRes => { res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res); });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  });
  gate.on("upgrade", (req, socket) => { gateLog.push({ method: req.method, path: req.url, upgrade: true }); socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  if (existsSync(gateSocket)) rmSync(gateSocket);
  await new Promise(ok => gate.listen(gateSocket, ok));
  const totals = () => { try { return JSON.parse(readFileSync(`${wireLog}.totals.json`, "utf8")); } catch { return {}; } };
  const stop = async () => {
    await new Promise(ok => gate.close(() => ok()));
    child.kill("SIGTERM");
    await new Promise(ok => setTimeout(ok, 300));
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  return { socket: gateSocket, wireLog, totals, gateRefusals: () => [...gateLog], stop, pid: child.pid };
}

/** Wire entries of a journal (end records = completed exchanges). */
export function wireEntries(wireLog) {
  if (!existsSync(wireLog)) return [];
  return readFileSync(wireLog, "utf8").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
}
/** Model requests that completed with a final response.completed event (a model call that succeeded). */
export const completedModelCalls = (entries) => entries.filter(e => e.phase === "end" && e.method === "POST" && e.status === 200 && e.final === "response.completed").length;

export const LAUNCH = [
  "#!/bin/sh",
  "# pi-eval-loop sandbox launcher: the bridge to the unit's model gate, then the command.",
  `"$EL_NODE" ${MOUNTS.bridge} ${BRIDGE_PORT} ${MOUNTS.socket} "$EL_BRIDGE_READY" &`,
  'i=0; while [ ! -s "$EL_BRIDGE_READY" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done',
  'exec "$@"', "",
].join("\n");
