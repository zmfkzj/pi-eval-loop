// Isolated calibration runtime (2026-11-07; studies/confirmatory-1/ISOLATED-RUNTIME.md).
//
// A PRIVATE CLIProxyAPI process (a copy of the verified 8.0.57 c2f402b4 binary) that serves only the calibration route:
//   route proxy (sandbox.mjs, per unit) -> 127.0.0.1:<outerPort> (host bridge) -> <dir>/sock/gw.sock
//     -> [bwrap: own network, pid, ipc namespaces; /home and /tmp are empty tmpfs except <dir>]
//        inner bridge -> gateway 127.0.0.1:<gwPort> -> requests.proxy-url 127.0.0.1:<gatePort> -> inner bridge -> <dir>/sock/gate.sock
//     -> outbound attempt gate (src/outbound-gate.mjs, host) -> chatgpt.com:443 only, one durable ledger record per attempt.
// The namespace has no route to the network: the gate is its only exit (no bypass by config, environment proxy or bug). The
// live gateway's config, auth directory and refresh tokens are not visible inside (tmpfs /home). Its config lives in <dir>
// (0400, hash pinned in the manifest): nobody else can hot-reload it.
//
// Credential: an ACCESS-TOKEN-ONLY snapshot of the operator's configured codex OAuth credential (the one the live gateway uses
// for cliproxyapi/gpt-6-luna, i.e. the approved target route). The refresh token is never copied, so refresh state is not
// duplicated and cannot race the live gateway's rotation; refresh is impossible anyway (no network but the gate, whose
// allowlist excludes the token endpoint). The snapshot is used only while the token is valid for longer than the gateway's
// proactive refresh lead (96 h, sdk/cliproxy/auth/types.go CodexOuterRefreshLead) plus a margin, so the private gateway never
// even attempts a refresh; an expired or revoked token fails closed (401, counted as an attempt).
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { sha256 } from "./util.mjs";

export const PINNED_GATEWAY = { version: "8.0.57", commit: "c2f402b4", sha256: "047e384525c93abe1c98cdf3769ed5b720f621030f9777254c2985c11904c985" };
export const CODEX_REFRESH_LEAD_H = 96;
export const RUNTIME_SCHEMA = "pi-eval-loop/isolated-runtime@1";
export const ALLOW = ["chatgpt.com:443"];
export const PORTS = { gw: 18418, gate: 18419 };

/** exp (ms) of a JWT access token, decoded locally (never printed). */
export function jwtExpiryMs(token) {
  const part = String(token ?? "").split(".")[1];
  if (!part) throw new Error("access token is not a JWT");
  const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  if (!Number.isFinite(claims.exp)) throw new Error("access token has no exp claim");
  return claims.exp * 1000;
}

/**
 * Access-token-only snapshot of a codex OAuth auth file. Refuses a disabled, prefixed (not served for the unprefixed target
 * model) or non-codex credential, and a token valid for less than the refresh lead + minHours.
 * @returns {{ snapshot: any, facts: any }}
 */
export function snapshotCredential({ source, now = Date.now(), minHours = 6 }) {
  const raw = readFileSync(source, "utf8");
  const a = JSON.parse(raw);
  if (a.type !== "codex") throw new Error("credential snapshot: not a codex OAuth credential");
  if (a.disabled === true) throw new Error("credential snapshot: the credential is disabled in the live gateway");
  if (String(a.prefix ?? "").trim()) throw new Error("credential snapshot: a prefixed credential is not the one serving the unprefixed target route");
  if (!a.access_token || !a.account_id) throw new Error("credential snapshot: access_token/account_id missing");
  const exp = jwtExpiryMs(a.access_token);
  const usableUntil = exp - (CODEX_REFRESH_LEAD_H + minHours) * 3600_000;
  if (usableUntil <= now) throw new Error(`credential snapshot: token expires ${new Date(exp).toISOString()}; within the ${CODEX_REFRESH_LEAD_H} h refresh lead + ${minHours} h margin the private gateway would try to refresh (refused: re-snapshot after the live gateway has refreshed)`);
  const snapshot = { type: "codex", access_token: a.access_token, account_id: a.account_id, email: a.email, plan_type: a.plan_type, expired: new Date(exp).toISOString(), last_refresh: a.last_refresh, disabled: false, prefix: "", websockets: false, priority: 0, note: "pi-eval-loop isolated calibration runtime: access-token-only snapshot (no refresh token)" };
  return { snapshot, facts: { sourceFile: source, sourceLastRefresh: a.last_refresh ?? null, accessTokenSha256: sha256(a.access_token).slice(0, 16), accountIdSha256: sha256(a.account_id).slice(0, 16), expiresAt: new Date(exp).toISOString(), usableUntil: new Date(usableUntil).toISOString(), refreshTokenCopied: false, idTokenCopied: false } };
}

/** The private gateway config (no retry rounds, one credential, no plugins/management/discovery, every upstream through the gate). */
export function privateConfigYaml({ apiKey, authDir }) {
  return `# pi-eval-loop isolated calibration runtime (generated; do not edit: its sha256 is pinned in manifest.json)
config-version: 8
models:
  catalog: ""
  codex-catalog: ""
  devin-catalog: ""
server:
  host: "127.0.0.1"
  port: ${PORTS.gw}
  max-request-body-bytes: 0
  response-compression:
    enabled: false
  github-token: ""
  trusted-proxies: []
  commercial-mode: false
  discovery:
    enabled: false
management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
  disable-auto-update-panel: true
access:
  api-keys:
    - "${apiKey}"
routing:
  strategy: "fill-first"
  session-affinity: false
  force-model-prefix: false
  retry:
    request-retry: 0
    max-retry-credentials: 1
    max-retry-interval: 0
  cooldown:
    disable-cooling: true
    save-cooldown-status: false
    transient-error-cooldown-seconds: -1
requests:
  proxy-url: "http://127.0.0.1:${PORTS.gate}"
  tls-handshake-timeout-seconds: 30
  passthrough-headers: false
  nonstream-keepalive-interval: 0
  streaming:
    keepalive-seconds: 0
    bootstrap-retries: 0
upstream:
  codex:
    response-steering: false
    upstream-request-compression: false
oauth:
  auth-dir: "${authDir}"
observability:
  logs:
    debug: false
    logging-to-file: false
    request-log: false
  usage:
    usage-statistics-enabled: true
  pprof:
    enable: false
plugins:
  enabled: false
`;
}

/** Problems of a generated private config (exact invariants the attempt bound and isolation rely on). */
export function configProblems(text) {
  const out = [];
  const need = [/^\s+request-retry: 0$/m, /^\s+max-retry-credentials: 1$/m, /^\s+bootstrap-retries: 0$/m, new RegExp(`^\\s+proxy-url: "http://127\\.0\\.0\\.1:${PORTS.gate}"$`, "m"), /^plugins:\n\s+enabled: false$/m, /^\s+secret-key: ""$/m, /^\s+host: "127\.0\.0\.1"$/m, /^\s+upstream-request-compression: false$/m, /^\s+force-model-prefix: false$/m];
  for (const re of need) if (!re.test(text)) out.push(`config lacks ${re.source}`);
  if (/^\s*(codex-api-key|openai-compatibility|home):/m.test(text)) out.push("config names extra upstreams or Home mode");
  if ((text.match(/request-retry:/g) ?? []).length !== 1) out.push("config: request-retry must appear exactly once");
  return out;
}

/**
 * Prepare <dir>: binary copy (pinned sha), config (0400), auth snapshot (0600), private agent dir (own client key, models
 * catalog copy) and manifest. `credential` = { snapshot, facts } or, for the model-free selftest, a fake one.
 */
export function prepareRuntime({ dir, binary, credential, modelsCatalog, outerPort, mode, budget }) {
  if (!["live", "test"].includes(mode)) throw new Error("mode must be live | test");
  if (existsSync(join(dir, "manifest.json"))) throw new Error(`${dir} is already prepared (a runtime is never re-prepared in place: use a new directory)`);
  const binSha = sha256(readFileSync(binary));
  if (binSha !== PINNED_GATEWAY.sha256) throw new Error(`gateway binary ${binary} is not the verified build (${PINNED_GATEWAY.version} ${PINNED_GATEWAY.commit})`);
  for (const d of [dir, join(dir, "auth"), join(dir, "sock"), join(dir, "home"), join(dir, "agent"), join(dir, "logs")]) { mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); }
  copyFileSync(binary, join(dir, "cli-proxy-api")); chmodSync(join(dir, "cli-proxy-api"), 0o500);
  const apiKey = `iso-${randomBytes(18).toString("hex")}`;
  const config = privateConfigYaml({ apiKey, authDir: join(dir, "auth") });
  writeFileSync(join(dir, "config.yaml"), config, { mode: 0o400 });
  writeFileSync(join(dir, "auth", "codex-snapshot.json"), JSON.stringify(credential.snapshot, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, "agent", "cliproxyapi.json"), JSON.stringify({ apiKey, baseUrl: `http://127.0.0.1:${outerPort}`, providerId: "cliproxyapi", providerName: "CLIProxyAPI" }), { mode: 0o600 });
  if (modelsCatalog) copyFileSync(modelsCatalog, join(dir, "agent", "cliproxyapi-models.json"));
  const manifest = { schema: RUNTIME_SCHEMA, mode, createdAt: new Date().toISOString(), dir: resolve(dir), gateway: { ...PINNED_GATEWAY, copiedFrom: binary }, configSha256: sha256(config), ports: { outer: outerPort, ...PORTS }, allow: ALLOW, credential: credential.facts, budget, upstream: `http://127.0.0.1:${outerPort}`, agentDir: join(resolve(dir), "agent") };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

const listenerPid = (port) => {
  const { execFileSync } = process.getBuiltinModule("node:child_process");
  const out = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8", timeout: 5000 });
  const pids = [...new Set([...out.matchAll(/pid=(\d+)/g)].map(m => Number(m[1])))];
  return pids.length === 1 ? pids[0] : null;
};

/** Host pids of processes whose executable is <dir>/cli-proxy-api (inside the sandbox they have other pids). */
export function gatewayPids(dir) {
  const exe = join(resolve(dir), "cli-proxy-api");
  const out = [];
  for (const p of readdirSync("/proc").filter(n => /^\d+$/.test(n))) { try { if (readlinkSync(`/proc/${p}/exe`) === exe) out.push(Number(p)); } catch { /* gone or foreign */ } }
  return out;
}

/**
 * Problems of a prepared (and, with running: true, started) runtime. Everything an attempt bound or isolation relies on is
 * re-checked here at every reservation and settlement of a calibration (calibrate.mjs), not only at start.
 */
export function runtimeProblems(dir, { running = true, now = Date.now(), mode = "live", budgetPath } = {}) {
  const out = [];
  const mpath = join(dir, "manifest.json");
  if (!existsSync(mpath)) return [`no runtime manifest in ${dir}`];
  const m = JSON.parse(readFileSync(mpath, "utf8"));
  if (m.schema !== RUNTIME_SCHEMA) out.push("runtime manifest schema");
  if (m.mode !== mode) out.push(`runtime mode is ${m.mode}, not ${mode} (a selftest runtime never serves calibration)`);
  if (budgetPath && resolve(m.budget?.path ?? "") !== resolve(budgetPath)) out.push("the runtime's gate charges another budget ledger than --budget-ledger");
  try { if (sha256(readFileSync(join(dir, "cli-proxy-api"))) !== PINNED_GATEWAY.sha256) out.push("runtime binary differs from the verified build"); } catch { out.push("runtime binary unreadable"); }
  let config = "";
  try { config = readFileSync(join(dir, "config.yaml"), "utf8"); } catch { out.push("runtime config unreadable"); }
  if (sha256(config) !== m.configSha256) out.push("runtime config changed since prepare (hash differs)");
  out.push(...configProblems(config));
  const auths = readdirSync(join(dir, "auth")).filter(n => n.endsWith(".json"));
  if (auths.length !== 1) out.push(`runtime auth dir holds ${auths.length} credentials (exactly one)`);
  for (const f of auths) {
    try {
      const a = JSON.parse(readFileSync(join(dir, "auth", f), "utf8"));
      if (a.refresh_token || a.id_token) out.push(`${f}: carries refresh/id token state (access-token-only snapshot required)`);
      if (a.type !== "codex" || a.disabled || String(a.prefix ?? "") || a.websockets !== false) out.push(`${f}: must be an enabled, unprefixed codex credential with websockets false`);
      // Any mode: an expired access token is never served (test runtimes use fake JWT-shaped tokens with an expiry too).
      { const exp = jwtExpiryMs(a.access_token); if (!(exp > now)) out.push(`${f}: access token expired or without expiry`); }
      if (mode === "live") { const exp = jwtExpiryMs(a.access_token); if (exp - CODEX_REFRESH_LEAD_H * 3600_000 - 3600_000 <= now) out.push(`${f}: token within the refresh lead (expires ${new Date(exp).toISOString()}): refresh would be attempted`); }
    } catch (error) { out.push(`${f}: unreadable (${String(error?.message).slice(0, 80)})`); }
  }
  if (running) {
    const st = (() => { try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); } catch { return null; } })();
    if (!st || !existsSync(`/proc/${st.supervisor}`)) out.push("runtime supervisor not running");
    else {
      if (listenerPid(m.ports.outer) !== st.supervisor) out.push(`127.0.0.1:${m.ports.outer} is not served by the runtime supervisor`);
      const gws = gatewayPids(dir);
      if (gws.length !== 1) out.push(`${gws.length} gateway processes of this runtime (exactly one)`);
      else {
        try { if (readlinkSync(`/proc/${gws[0]}/ns/net`) === readlinkSync("/proc/self/ns/net")) out.push("the private gateway shares the host network namespace (direct egress possible)"); } catch { out.push("gateway network namespace unverifiable"); }
        try { const argv = readFileSync(`/proc/${gws[0]}/cmdline`, "utf8").split("\0"); if (argv[argv.indexOf("-config") + 1] !== join(resolve(dir), "config.yaml")) out.push("the private gateway reads another config"); } catch { out.push("gateway cmdline unreadable"); }
      }
      if (!existsSync(join(dir, "sock", "gate.sock"))) out.push("gate socket missing");
    }
  }
  return out;
}
