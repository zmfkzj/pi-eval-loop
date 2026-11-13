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
/** Endpoint gate of the legacy provider (@router-for-me/pi-cliproxyapi-provider 1.x: Codex backend paths). */
export const ALLOWED = [{ method: "GET", path: /^\/v1\/models(\?|$)/ }, { method: "POST", path: /^\/backend-api\/codex\/responses(\?|$)/ }, { method: "POST", path: /^\/backend-api\/responses(\?|$)/ }];
/** Endpoint gate of pi-cliproxyapi-provider 0.16.x: the OpenAI-compatible root `<base>/v1` (GPT routes use the Responses API). */
export const CPA_ALLOWED = [{ method: "GET", path: /^\/v1\/models(\?|$)/ }, { method: "POST", path: /^\/v1\/responses(\?|$)/ }];

// ------------------------------------------------------------------------------------------------------ provider packages
// Two CLIProxyAPI provider packages exist with different configuration semantics (docs/provider-compat.md):
//   legacy  @router-for-me/pi-cliproxyapi-provider 1.x: reads <PI_CODING_AGENT_DIR>/cliproxyapi.json (+ cliproxyapi-models.json),
//           base URL = host root, Codex backend paths;
//   cpa     pi-cliproxyapi-provider 0.16.x (github.com/0xRichardH): reads $HOME/.pi/agent/pi-cliproxyapi-provider/config.json
//           (connection; CLIPROXYAPI_* environment overrides it), registers its default name "cpa" unless providerName is set,
//           and in offline / print mode serves the model list ONLY from its snapshot
//           $HOME/.cache/pi-cliproxyapi-provider/<base64url(providerName \n baseUrl)>/cpa-models.json; base URL = <root>/v1,
//           GPT routes POST <base>/responses.
/** Provider package locations in the umbrella's cliproxyapi bundle: the current unscoped package first, the legacy one second. */
export const PROVIDER_CANDIDATES = [join(UMBRELLA, "cliproxyapi/node_modules/pi-cliproxyapi-provider"), join(UMBRELLA, "cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider")];
/** The first installed candidate (else the current package's path, which prerequisites() then reports as missing). */
export const defaultProviderDir = (candidates = PROVIDER_CANDIDATES) => candidates.find(dir => existsSync(join(dir, "extensions/index.ts"))) ?? candidates[0];
export const PROVIDER_LAYOUTS = ["legacy", "cpa"];
/** Unscoped package versions whose configuration layout was verified against the package source (config.ts, discovery.ts). */
export const CPA_SUPPORTED = /^0\.16\.\d+$/;

/**
 * Configuration layout of a provider package: { layout, name, version, supported, detail }. An unscoped pi-cliproxyapi-provider
 * 0.16.x is "cpa"; the scoped package (or a tree without a package name, as before) is "legacy". Another unscoped version is
 * reported unsupported (its layout was not verified) unless EVAL_LOOP_PROVIDER_LAYOUT names the layout explicitly.
 */
export function providerLayout(dir, override = process.env.EVAL_LOOP_PROVIDER_LAYOUT) {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { /* no package.json: legacy tree */ }
  const name = typeof pkg.name === "string" ? pkg.name : undefined, version = typeof pkg.version === "string" ? pkg.version : undefined;
  const id = `${name ?? "(unnamed)"}@${version ?? "?"}`;
  if (override) {
    if (!PROVIDER_LAYOUTS.includes(override)) return { layout: null, name, version, supported: false, detail: `EVAL_LOOP_PROVIDER_LAYOUT=${override}: must be ${PROVIDER_LAYOUTS.join(" | ")}` };
    return { layout: override, name, version, supported: true, detail: `${id}: layout ${override} (EVAL_LOOP_PROVIDER_LAYOUT)` };
  }
  if (name === "pi-cliproxyapi-provider") {
    const supported = CPA_SUPPORTED.test(version ?? "");
    return { layout: "cpa", name, version, supported, detail: supported ? `${id}: layout cpa` : `${id}: unverified version (supported 0.16.x; set EVAL_LOOP_PROVIDER_LAYOUT=cpa to accept its layout explicitly)` };
  }
  return { layout: "legacy", name, version, supported: true, detail: `${id}: layout legacy` };
}
/** Layout of an environment's provider (hostEnvironment records it; hand-built environments are resolved here). */
export const layoutOf = (env) => env.providerLayout ?? providerLayout(env.provider).layout ?? "legacy";
/** The endpoint gate of an environment's provider. */
export const allowedEndpoints = (env) => (layoutOf(env) === "cpa" ? CPA_ALLOWED : ALLOWED);

/**
 * CPA model-list entries for a private provider snapshot, from a catalog directory: a frozen `cpa-models.json` (the provider's
 * own cache envelope { fetchedAt, data }, a /v1/models response { data } or a plain array) when present, else the model ids of
 * `cliproxyapi-models.json` (the catalog the legacy provider and the route proxy's price table use). [] when neither exists.
 */
export function cpaModelEntries(catalogDir) {
  const read = (name) => { try { return JSON.parse(readFileSync(join(catalogDir, name), "utf8")); } catch { return undefined; } };
  const keep = (m) => m && typeof m.id === "string" && m.id.trim() !== "";
  const shape = (m) => ({ id: m.id, object: typeof m.object === "string" ? m.object : "model", ...(typeof m.owned_by === "string" ? { owned_by: m.owned_by } : {}), ...(typeof m.created === "number" ? { created: m.created } : {}) });
  const frozen = read("cpa-models.json");
  const list = Array.isArray(frozen) ? frozen : Array.isArray(frozen?.data) ? frozen.data : Array.isArray(read("cliproxyapi-models.json")?.models) ? read("cliproxyapi-models.json").models : [];
  const out = new Map();
  for (const m of list.filter(keep)) out.set(m.id, shape(m));
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Write the provider configuration of ONE sandboxed Pi (task agent, proposer, reviewer) into its private agent dir / HOME (host
 * paths) and return the CLIPROXYAPI_* variables of its sandbox environment. Both layouts point the provider at the in-box bridge
 * with the placeholder key (the real key exists only in the host-side route proxy). `providerName` is the route's provider (the
 * `--model` prefix); `catalogDir` supplies the cpa model snapshot.
 */
export function privateProviderSetup({ env, agent, home, bridgeUrl, providerName, catalogDir }) {
  if (layoutOf(env) === "cpa") {
    const baseUrl = `${bridgeUrl}/v1`;
    const configDir = ensureDir(join(home, ".pi/agent/pi-cliproxyapi-provider"));
    writeFileSync(join(configDir, "config.json"), `${JSON.stringify({ providerName, baseUrl, authRequired: true, authHeader: true }, null, 2)}\n`, { mode: 0o600 });
    const cache = ensureDir(join(home, ".cache/pi-cliproxyapi-provider", Buffer.from(`${providerName}\n${baseUrl}`).toString("base64url")));
    writeFileSync(join(cache, "cpa-models.json"), `${JSON.stringify({ fetchedAt: Date.now(), data: cpaModelEntries(catalogDir) })}\n`, { mode: 0o600 });
    return { CLIPROXYAPI_BASE_URL: baseUrl, CLIPROXYAPI_PROVIDER_NAME: providerName, CLIPROXYAPI_API_KEY: PLACEHOLDER_KEY, CLIPROXYAPI_FAST: "0" };
  }
  writeFileSync(join(agent, "cliproxyapi.json"), JSON.stringify({ apiKey: PLACEHOLDER_KEY, baseUrl: bridgeUrl, providerId: "cliproxyapi", providerName: "CLIProxyAPI" }), { mode: 0o600 });
  return { CLIPROXYAPI_BASE_URL: bridgeUrl, CLIPROXYAPI_API_KEY: PLACEHOLDER_KEY, CLIPROXYAPI_FAST: "0" };
}

/**
 * The upstream key of an agent dir (host side only; never printed): `cliproxyapi.json` apiKey (legacy layout, isolated runtimes),
 * else a literal `apiKey` of `pi-cliproxyapi-provider/config.json` (a `!command` expression is not executed). "" when absent.
 */
export function upstreamKey(agentDir) {
  try { const k = JSON.parse(readFileSync(join(agentDir, "cliproxyapi.json"), "utf8")).apiKey; if (k) return String(k); } catch { /* absent */ }
  try { const k = JSON.parse(readFileSync(join(agentDir, "pi-cliproxyapi-provider/config.json"), "utf8")).apiKey; if (typeof k === "string" && k && !k.startsWith("!")) return k; } catch { /* absent */ }
  return "";
}

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
  const nodeDir = resolve(process.execPath, "../..");
  return {
    node: process.execPath, nodeDir, piCli, piModules,
    provider: process.env.EVAL_LOOP_PROVIDER ?? defaultProviderDir(),
    agentDir: process.env.EVAL_LOOP_AGENT_DIR ?? join(homedir(), ".pi/agent"),
    upstream: process.env.EVAL_LOOP_UPSTREAM ?? "http://127.0.0.1:8317",
    bwrap: BWRAP, orche: ORCHE,
    // Optional frozen copies (ctrl-confirm-4 runtime snapshot): the harness node_modules and the model catalog that every attempt
    // copies into its private agent dir. Defaults are the shared umbrella / agent locations (unchanged behaviour).
    orcheModules: process.env.EVAL_LOOP_ORCHE_MODULES ?? join(ORCHE, "node_modules"),
    catalogDir: process.env.EVAL_LOOP_CATALOG_DIR ?? process.env.EVAL_LOOP_AGENT_DIR ?? join(homedir(), ".pi/agent"),
    // Where the node and pi trees appear INSIDE a sandbox (default: where they are on the host). A snapshot is mounted at the
    // original host locations so the agent sees the same paths (pi puts its install path into the system prompt).
    boxNodeDir: process.env.EVAL_LOOP_BOX_NODE_DIR ?? nodeDir,
    boxPiModules: process.env.EVAL_LOOP_BOX_PI_MODULES ?? piModules,
  };
}

/** The node / pi locations as seen inside a sandbox + the binds that put them there (identity when no snapshot is used). */
export function boxView(env) {
  const nodeDir = env.boxNodeDir ?? env.nodeDir, piModules = env.boxPiModules ?? env.piModules;
  const swap = (path, from, to) => (path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
  return {
    nodeDir, piModules, node: swap(env.node, env.nodeDir, nodeDir), piCli: swap(env.piCli, env.piModules, piModules),
    nodeBind: { from: env.nodeDir, to: nodeDir }, piBind: { from: env.piModules, to: piModules },
  };
}

const version = (cmd, args) => { try { return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).toString().trim(); } catch { return undefined; } };
const fileHash = (path) => { try { return sha256(readFileSync(path)); } catch { return undefined; } };

/** Digest of everything that must be identical across compared arms (not the harness itself). */
export function environmentDigest(env, route) {
  const providerPkg = (() => { try { return JSON.parse(readFileSync(join(env.provider, "package.json"), "utf8")).version; } catch { return undefined; } })();
  // The gate entry is the endpoint gate of the environment's provider layout (legacy: unchanged since protocol-1, so a legacy
  // environment keeps its digest).
  const facts = { node: process.version, piCli: fileHash(env.piCli), piVersion: (() => { try { return JSON.parse(readFileSync(resolve(env.piCli, "../../../package.json"), "utf8")).version; } catch { return undefined; } })(), provider: providerPkg, providerIndex: fileHash(join(env.provider, "extensions/index.ts")), bwrap: fileHash(env.bwrap), route, hiddenRoots: HIDDEN_ROOTS, gate: allowedEndpoints(env).map(a => `${a.method} ${a.path}`) };
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
  const pl = providerLayout(env.provider);
  add("provider", existsSync(join(env.provider, "extensions/index.ts")) && pl.supported, `${env.provider} (${pl.detail})`);
  add("orche", existsSync(join(env.orche, "src/extension/index.ts")) && existsSync(join(env.orche, "node_modules")), env.orche);
  add("git", version("git", ["--version"]), version("git", ["--version"]) ?? "missing");
  const credential = !!upstreamKey(env.agentDir);
  add("credentials", credential, credential ? "upstream apiKey: set" : `no apiKey in ${join(env.agentDir, "cliproxyapi.json")} or ${join(env.agentDir, "pi-cliproxyapi-provider/config.json")}`);
  const catalogDir = env.catalogDir ?? env.agentDir;
  const catalogs = ["cliproxyapi-models.json", "cpa-models.json"].map(name => join(catalogDir, name)).filter(existsSync);
  add("model-catalog", catalogs.length > 0, catalogs[0] ?? `no cliproxyapi-models.json or cpa-models.json in ${catalogDir}`);
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
 * Route-proxy children of this process that have not exited (evaluator and proposer model paths). The proxy runs in the
 * controller's process group (bwrap sandboxes have their own session and --die-with-parent); stopProxies() is the CLI's signal
 * and exit cleanup for them.
 * @type {Set<import("node:child_process").ChildProcess>}
 */
export const proxyChildren = new Set();
export function stopProxies(/** @type {any} */ signal = "SIGTERM") { for (const child of proxyChildren) { try { child.kill(signal); } catch { /* gone */ } } }

/**
 * Start the route proxy (orche proxy.mjs: pinned model+effort, request budget, key substitution, wire journal) on a private unix
 * socket, and the endpoint gate on the socket the sandbox gets. `allowed` = the endpoint gate of the sandbox's provider layout
 * (allowedEndpoints(env); default the legacy gate). Resolves with { socket, wireLog, totals(), stop() }.
 */
export async function startModelPath({ dir, route, maxRequests, upstream, agentDir, keyOverride, allowed = ALLOWED }) {
  ensureDir(dir);
  const proxySocket = join(dir, "proxy.sock"), gateSocket = join(dir, "gate.sock"), keyFile = join(dir, "key"), envelope = join(dir, "envelope.json");
  const wireLog = join(dir, "wire.jsonl");
  let key = keyOverride;
  if (key === undefined) key = upstreamKey(agentDir);
  writeFileSync(keyFile, key, { mode: 0o600 });
  writeFileSync(envelope, JSON.stringify({ route: { model: route.model, effort: route.effort }, maxRequests, placeholderKey: PLACEHOLDER_KEY, prices: catalogPrices(agentDir, route.model) }));
  const child = spawn(process.execPath, [PROXY, "--listen", proxySocket, "--target", upstream, "--log", wireLog, "--envelope", envelope, "--key-file", keyFile], { stdio: ["ignore", "pipe", "pipe"], detached: false });
  proxyChildren.add(child);
  child.once("exit", () => proxyChildren.delete(child));
  child.once("error", () => proxyChildren.delete(child));
  try {
    await new Promise((ok, fail) => {
      let text = "";
      const timer = setTimeout(() => fail(new Error(`proxy did not start: ${text}`)), 15_000);
      child.stdout.on("data", c => { text += c; if (/LISTENING /.test(text)) { clearTimeout(timer); ok(); } });
      child.stderr.on("data", c => { text += c; });
      child.once("error", error => { clearTimeout(timer); fail(error); });
      child.once("exit", code => { clearTimeout(timer); fail(new Error(`proxy exited ${code}: ${text}`)); });
    });
  } catch (error) { try { child.kill("SIGKILL"); } catch { /* gone */ } throw error; } finally { rmSync(keyFile, { force: true }); }
  const gateLog = [];
  const gate = http.createServer((req, res) => {
    const admitted = allowed.some(a => a.method === req.method && a.path.test(req.url ?? ""));
    if (!admitted) { gateLog.push({ at: new Date().toISOString(), method: req.method, path: String(req.url).slice(0, 200) }); res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "eval_loop_endpoint_refused", message: "endpoint not permitted" } })); req.resume(); return; }
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
    // Drop idle keep-alive connections first: gate.close() alone waits for them and could hang the cleanup.
    gate.closeAllConnections();
    await new Promise(ok => gate.close(() => ok()));
    child.kill("SIGTERM");
    await new Promise(ok => setTimeout(ok, 300));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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
