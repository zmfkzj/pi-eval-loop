#!/usr/bin/env node
// Isolated calibration runtime CLI (2026-11-07; ISOLATED-RUNTIME.md). Model-free except what calibrate.mjs later sends through it.
//
//   node isolated-runtime.mjs prepare  --dir D --budget-ledger L [--budget-limit N --budget-scope S] [--models F] [--credential F]
//                                        [--outer-port 18420] [--binary B]   (defaults: confirmatory-1 4500 / scope, LIVE.models)
//   node isolated-runtime.mjs start    --dir D          (detached supervisor: gate + host bridge + bwrap sandbox with the gateway)
//   node isolated-runtime.mjs status   --dir D          (problems, attempt counts; prints no secret)
//   node isolated-runtime.mjs stop     --dir D
//   node isolated-runtime.mjs resnapshot --dir D [--credential F]
//                                      (model-free; stopped, unused runtime only; one JSON line pi-eval-loop/runtime-resnapshot@1;
//                                       exit 0 done, 1 refused, 2 source within the 96 h + 6 h lead, 3 busy, 64 usage;
//                                       docs/runtime-resnapshot.md)
//   node isolated-runtime.mjs selftest --scratch S      (real binary, local TLS stand-in for chatgpt.com, throwaway ledger;
//                                                        never touches the study ledger or the provider)
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import http from "node:http";
import http2 from "node:http2";
import { RequestBudget } from "../../src/request-budget.mjs";
import { startOutboundGate } from "../../src/outbound-gate.mjs";
import { tcpToUnix } from "../../src/runtime-bridge.mjs";
import { PORTS, RESNAPSHOT_EXIT, RESNAPSHOT_SCHEMA, gatewayPids, prepareRuntime, resnapshotRuntime, runtimeLockPath, runtimeProblems, snapshotCredential } from "../../src/isolated-runtime.mjs";
import { acquireLock, sleep } from "../../src/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../src");
const BRIDGE = join(SRC, "runtime-bridge.mjs");
export const LIVE = {
  binary: "/home/arthur/Downloads/EasyCLIProxyAPI-v0.3.20-Linux-amd64/cpa-core/cli-proxy-api",
  credential: "/home/arthur/Downloads/EasyCLIProxyAPI-v0.3.20-Linux-amd64/oauth/codex-865e38dd-kzzang131@gmail.com-pro.json",
  models: "/home/arthur/.pi/agent/cliproxyapi-models.json",
};
// Same ledger identity as calibrate.mjs (one global budget).
export const BUDGET = { limit: 4500, scope: "confirmatory-1: target-model calibration requests (all runs, resumes and reruns)" };

/**
 * Ledger identity of a runtime's attempt gate: the confirmatory-1 default (4500 / its scope) unless both are given, e.g. a
 * Terra series ledger `--budget-limit 300000 --budget-scope "<the ledger's init scope>"`. The identity must equal the ledger's
 * init record (RequestBudget refuses any other), so a runtime never charges a ledger under another identity.
 * @param {{ limit?: string | number, scope?: string }} [options]
 */
export function budgetIdentity({ limit, scope } = {}) {
  if (limit === undefined && scope === undefined) return { ...BUDGET };
  if (limit === undefined || scope === undefined || !String(scope).trim()) throw new Error("--budget-limit and --budget-scope go together (the ledger's exact init limit and scope)");
  if (!/^[1-9][0-9]*$/.test(String(limit))) throw new Error("--budget-limit must be a positive integer");
  return { limit: Number(limit), scope: String(scope) };
}

/** bwrap argv for the gateway sandbox (no network but loopback; only <dir>, node and the bridge script visible under /home). */
export function sandboxArgs({ dir, env = {} }) {
  const nodeDir = resolve(process.execPath, "../..");
  const args = ["--die-with-parent", "--new-session", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--ro-bind", "/", "/", "--tmpfs", "/home", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--tmpfs", "/run", "--dev", "/dev", "--proc", "/proc", "--ro-bind", nodeDir, nodeDir, "--ro-bind", SRC, SRC, "--bind", dir, dir];
  for (const [k, v] of Object.entries(env)) if (k === "SSL_CERT_FILE") args.push("--ro-bind", v, v);
  args.push("--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", join(dir, "home"));
  for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
  args.push("--chdir", dir, process.execPath, BRIDGE, "inner", String(PORTS.gate), join(dir, "sock", "gate.sock"), join(dir, "sock", "gw.sock"), String(PORTS.gw), join(dir, "cli-proxy-api"), join(dir, "config.yaml"), join(dir, "logs", "gateway.log"), join(dir, "sock", "inner.ready"));
  return args;
}

/** The supervisor (foreground; `start` runs it detached). */
async function supervise(dir) {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const budget = new RequestBudget({ path: m.budget.path, limit: m.budget.limit, scope: m.budget.scope });
  budget.status(); // fail closed before anything listens
  const test = m.mode === "test" ? JSON.parse(readFileSync(join(dir, "test-route.json"), "utf8")) : null;
  const route = test ? (host, port) => (host === "chatgpt.com" && port === 443 ? { host: "127.0.0.1", port: test.port } : { host, port }) : undefined;
  const gate = await startOutboundGate({ budget, allow: m.allow, listen: { path: join(dir, "sock", "gate.sock") }, route, journal: join(dir, "logs", "gate.jsonl"), log: (l) => process.stderr.write(`${l}\n`) });
  const outer = await tcpToUnix(m.ports.outer, join(dir, "sock", "gw.sock"));
  const env = test ? { SSL_CERT_FILE: test.ca } : {};
  const child = spawn("/usr/bin/bwrap", sandboxArgs({ dir, env }), { stdio: ["ignore", "inherit", "inherit"] });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ supervisor: process.pid, sandbox: child.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const stop = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, stop);
  child.on("exit", async (code) => { outer.close(); await gate.close(); process.stderr.write(`supervisor: sandbox exited ${code}\n`); process.exit(code === 0 ? 0 : 1); });
}

/** Start detached and wait until the runtime verifies (or fail). */
export async function startRuntime(dir, { timeoutMs = 45_000, mode = "live" } = {}) {
  // Serialized with `resnapshot` (the credential is never replaced while a start is in progress, and vice versa).
  let lock;
  try { lock = acquireLock(runtimeLockPath(dir)); } catch (error) { throw new Error(`runtime operation in progress (${runtimeLockPath(dir)}): ${String(error?.message ?? error).slice(0, 200)}`); }
  try { return await startRuntimeLocked(dir, { timeoutMs, mode }); } finally { lock.release(); }
}

async function startRuntimeLocked(dir, { timeoutMs, mode }) {
  const st = (() => { try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); } catch { return null; } })();
  if (st && existsSync(`/proc/${st.supervisor}`)) throw new Error(`runtime already running (supervisor ${st.supervisor})`);
  const log = openSync(join(dir, "logs", "supervisor.log"), "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "supervise", "--dir", dir], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let problems = [];
  while (Date.now() < deadline) {
    await sleep(500);
    problems = runtimeProblems(dir, { running: true, mode });
    if (!problems.length) {
      // The gateway must also answer on the outer port (model list; no provider request).
      const ok = await new Promise(r => { const q = http.get({ host: "127.0.0.1", port: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).ports.outer, path: "/v1/models", headers: { authorization: `Bearer ${JSON.parse(readFileSync(join(dir, "agent", "cliproxyapi.json"), "utf8")).apiKey}` }, timeout: 3000 }, res => { res.resume(); r(res.statusCode === 200); }); q.on("error", () => r(false)); q.on("timeout", () => { q.destroy(); r(false); }); });
      if (ok) return { pid: child.pid };
      problems = ["gateway not answering yet"];
    }
  }
  throw new Error(`runtime did not become ready: ${problems.join("; ")}`);
}

export function stopRuntime(dir) {
  const st = (() => { try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); } catch { return null; } })();
  if (st && existsSync(`/proc/${st.supervisor}`)) process.kill(st.supervisor, "SIGTERM");
}

export async function waitStopped(dir, ms = 15_000) { const d = Date.now() + ms; while (Date.now() < d) { if (!gatewayPids(dir).length) { const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); if (!existsSync(`/proc/${st.supervisor}`)) return true; } await sleep(200); } return false; }

// ---------------------------------------------------------------- selftest (model-free) ----------------------------------------
/** A JWT-shaped fake token (selftest only; never a real credential). */
export const fakeJwt = (expSec) => ["e30", Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url"), "sig"].join(".");

export function makeCert(scratch) {
  const ca = join(scratch, "ca.pem"), caKey = join(scratch, "ca.key"), key = join(scratch, "leaf.key"), csr = join(scratch, "leaf.csr"), crt = join(scratch, "leaf.pem"), ext = join(scratch, "leaf.ext");
  const o = { stdio: "ignore" };
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "2", "-subj", "/CN=pi-eval-loop selftest CA"], o);
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=chatgpt.com"], o);
  writeFileSync(ext, "subjectAltName=DNS:chatgpt.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", crt, "-days", "2", "-extfile", ext], o);
  return { ca, key: readFileSync(key), cert: readFileSync(crt) };
}

const SSE_OK = [
  { type: "response.created", response: { id: "resp_selftest", object: "response", status: "in_progress", model: "gpt-6-luna", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] } },
  { type: "response.completed", response: { id: "resp_selftest", object: "response", status: "completed", model: "gpt-6-luna", output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
].map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join("");

/** Local TLS stand-in for chatgpt.com: counts connections and requests per connection; behaviour set per phase. */
export async function standIn(cert) {
  // HTTP/2 with HTTP/1.1 fallback, like chatgpt.com: the gateway's Chrome uTLS profile negotiates h2 here.
  const s = { mode: "500", connections: 0, requests: 0, maxPerConnection: 0, paths: [], protocols: {} };
  const perConn = new WeakMap();
  const server = http2.createSecureServer({ key: cert.key, cert: cert.cert, allowHTTP1: true }, (req, res) => {
    const conn = req.httpVersion === "2.0" ? req.stream.session : req.socket;
    const n = (perConn.get(conn) ?? 0) + 1; perConn.set(conn, n);
    s.requests++; s.maxPerConnection = Math.max(s.maxPerConnection, n); s.paths.push(`${req.method} ${req.url.split("?")[0]}`); s.protocols[req.httpVersion] = (s.protocols[req.httpVersion] ?? 0) + 1;
    req.resume();
    req.on("end", () => {
      if (s.mode === "reset") { if (req.stream) req.stream.session.destroy(); else req.socket.destroy(); return; }
      if (s.mode === "redirect") { if (req.url.includes("selftest-redirected")) { res.writeHead(500); res.end("{}"); } else { res.writeHead(307, { location: "https://chatgpt.com/backend-api/codex/responses?selftest-redirected=1" }); res.end(); } return; }
      if (s.mode === "ok") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(SSE_OK); return; }
      const code = Number(s.mode);
      res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `selftest ${code}`, type: "selftest" } }));
    });
  });
  server.on("secureConnection", () => { s.connections++; });
  await new Promise(ok => server.listen(0, "127.0.0.1", ok));
  return { s, server, port: server.address().port };
}

export function ask({ port, key, path = "/v1/chat/completions" }) {
  const body = path.includes("chat") ? { model: "gpt-6-luna", messages: [{ role: "user", content: "selftest" }], stream: false } : { model: "gpt-6-luna", input: "selftest", stream: true };
  return new Promise(r => {
    const q = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, timeout: 60_000 }, res => { let t = ""; res.on("data", c => { t += c; }); res.on("end", () => r({ status: res.statusCode, ok: t.includes("ok") })); });
    q.on("error", e => r({ status: 0, error: e.code })); q.on("timeout", () => { q.destroy(); r({ status: 0, error: "timeout" }); });
    q.end(JSON.stringify(body));
  });
}

export async function selftest(scratch) {
  rmSync(scratch, { recursive: true, force: true }); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const cert = makeCert(scratch);
  const { s, server, port } = await standIn(cert);
  const dir = join(scratch, "rt"), ledger = join(scratch, "budget", "selftest.jsonl");
  const outer = 18490;
  const credential = { snapshot: { type: "codex", access_token: fakeJwt(Math.floor(Date.now() / 1000) + 30 * 86400), account_id: "selftest", disabled: false, prefix: "", websockets: false }, facts: { selftest: true, refreshTokenCopied: false } };
  prepareRuntime({ dir, binary: LIVE.binary, credential, outerPort: outer, mode: "test", budget: { path: ledger, limit: 60, scope: "selftest" } });
  writeFileSync(join(dir, "test-route.json"), JSON.stringify({ port, ca: join(scratch, "ca.pem") }));
  const budget = new RequestBudget({ path: ledger, limit: 60, scope: "selftest" });
  const key = JSON.parse(readFileSync(join(dir, "agent", "cliproxyapi.json"), "utf8")).apiKey;
  const results = { checks: [], scenarios: [] };
  const check = (name, ok, detail) => results.checks.push({ name, ok: !!ok, detail });
  const attempts = () => budget.status().attempts;
  try {
    // Before any reservation the gate admits nothing (startup traffic of the gateway, if any, is refused).
    await budget.reserve(1, { selftest: "init" }).then(t => budget.settle(t, 0));
    await startRuntime(dir, { mode: "test" });
    check("runtime verifies (pinned binary, pinned config, access-token-only snapshot, own network namespace, supervisor owns the port)", !runtimeProblems(dir, { running: true, mode: "test" }).length, runtimeProblems(dir, { running: true, mode: "test" }));
    await sleep(1500);
    check("no startup attempt reaches the provider without a reservation", attempts() === 0 && s.requests === 0, { attempts: attempts(), standInRequests: s.requests });
    const ticket = await budget.reserve(40, { selftest: "scenarios" });
    for (const [mode, path] of [["ok", "/v1/chat/completions"], ["ok", "/backend-api/codex/responses"], ["500", undefined], ["429", undefined], ["503", undefined], ["400", undefined], ["reset", undefined], ["redirect", undefined]]) {
      s.mode = mode;
      const a0 = attempts(), r0 = s.requests, c0 = s.connections;
      const out = await ask({ port: outer, key, path });
      await sleep(300);
      results.scenarios.push({ upstream: mode, path: path ?? "/v1/chat/completions", clientStatus: out.status, clientGotText: out.ok, gateAttempts: attempts() - a0, standInRequests: s.requests - r0, standInConnections: s.connections - c0 });
    }
    check("every provider request passed the gate as its own admitted attempt (requests <= attempts, one request per connection)", results.scenarios.every(x => x.standInRequests <= x.gateAttempts) && s.maxPerConnection <= 1, { maxRequestsPerConnection: s.maxPerConnection });
    check("request-retry 0: a failed attempt (500/429/503/400/reset) is not retried by the gateway", results.scenarios.filter(x => !["ok", "redirect"].includes(x.upstream)).every(x => x.gateAttempts === 1), results.scenarios.map(x => `${x.upstream}:${x.gateAttempts}`));
    check("a successful round trip reaches the client", results.scenarios.filter(x => x.upstream === "ok").some(x => x.clientStatus === 200), null);
    const redirect = results.scenarios.find(x => x.upstream === "redirect");
    check("redirects followed by the gateway are separate, counted attempts", redirect.gateAttempts === redirect.standInRequests && redirect.gateAttempts >= 2, redirect);
    // Concurrency at the cap: room for exactly 3 more attempts (charged = attempts + 3 after settlement).
    const used = attempts();
    await budget.settle(ticket, used + 3);
    s.mode = "500";
    const a0 = attempts(), r0 = s.requests;
    const many = await Promise.all(Array.from({ length: 8 }, () => ask({ port: outer, key })));
    await sleep(500);
    check("8 concurrent requests with room for 3: exactly 3 attempts admitted, the rest refused before leaving", attempts() - a0 === 3 && s.requests - r0 === 3, { admitted: attempts() - a0, reachedUpstream: s.requests - r0, clientStatuses: many.map(m => m.status) });
    check("with no open reservation nothing more leaves", budget.status().attempts <= budget.status().charged && budget.status().openReservations === 0, budget.status());
    // Restart: the counter lives only in the ledger.
    stopRuntime(dir); check("runtime stops", await waitStopped(dir), null);
    const before = attempts();
    await startRuntime(dir, { mode: "test" });
    const t2 = await budget.reserve(2, { selftest: "restart" });
    s.mode = "500"; await ask({ port: outer, key }); await ask({ port: outer, key }); await ask({ port: outer, key });
    await sleep(300);
    check("after a restart the gate continues from the durable ledger (2 reserved -> 2 admitted, the third refused)", attempts() === before + 2, { before, after: attempts() });
    // 401 (revoked/expired token): one attempt, no refresh reaches anything (no refresh token; token endpoint not allowlisted).
    const t3 = await budget.reserve(3, { selftest: "401" });
    s.mode = "401"; const a401 = attempts(), r401 = s.requests; const o401 = await ask({ port: outer, key }); await ask({ port: outer, key }); await sleep(500);
    const j401 = readFileSync(join(dir, "logs", "gate.jsonl"), "utf8");
    check("401: the first attempt is charged once; the credential is then not retried and no token endpoint is reachable", o401.status === 401 && attempts() - a401 >= 1 && attempts() - a401 === s.requests - r401 && !/auth\.openai\.com/.test(j401.split("\n").filter(l => l.includes('"admitted"')).join("\n")), { status: o401.status, attempts: attempts() - a401, reached: s.requests - r401 });
    results.scenarios.push({ upstream: "401", clientStatus: o401.status, gateAttempts: attempts() - a401, standInRequests: s.requests - r401, note: "2 client requests" });
    await budget.settle(t2, 0); await budget.settle(t3, 0);
    const st = budget.status();
    check("settlement floor: charged never falls below actual attempts", st.charged >= st.attempts && st.problems.length === 0, { charged: st.charged, attempts: st.attempts, settled: st.settledUsed });
    // A truncated ledger after initialisation refuses everything (anchor).
    const text = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    writeFileSync(`${ledger}.bak`, `${text.join("\n")}\n`);
    writeFileSync(ledger, `${text.slice(0, -2).join("\n")}\n`);
    s.mode = "500"; const r1 = s.requests; const tr = await ask({ port: outer, key }); await sleep(300);
    check("a truncated ledger is detected and the gate refuses (fail closed)", s.requests === r1 && tr.status !== 200, { status: tr.status });
    writeFileSync(ledger, readFileSync(`${ledger}.bak`)); rmSync(`${ledger}.bak`);
    const auth = JSON.parse(readFileSync(join(dir, "auth", "codex-snapshot.json"), "utf8"));
    check("the private snapshot has no refresh or id token", !auth.refresh_token && !auth.id_token, null);
    const journal = readFileSync(join(dir, "logs", "gate.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    results.gateJournal = { admitted: journal.filter(j => j.verdict === "admitted").length, refused: journal.filter(j => j.verdict === "refused").length, refusedHosts: [...new Set(journal.filter(j => j.why === "host not allowlisted").map(j => j.target))] };
    results.standIn = { paths: [...new Set(s.paths)], maxRequestsPerConnection: s.maxPerConnection, protocols: s.protocols };
  } finally {
    stopRuntime(dir); await waitStopped(dir).catch(() => {}); server.close();
  }
  results.ok = results.checks.every(c => c.ok);
  return results;
}

/**
 * `resnapshot` CLI: exactly one JSON line on stdout for EVERY outcome (usage errors included), nothing on stderr that could carry
 * credential content. Exit codes: RESNAPSHOT_EXIT.
 */
export function resnapshotCli(argv, { now = Date.now() } = {}) {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: { dir: { type: "string" }, credential: { type: "string" } }, strict: true, allowPositionals: false })); }
  catch { return { exit: RESNAPSHOT_EXIT.usage, result: { schema: RESNAPSHOT_SCHEMA, ok: false, usableUntil: null, code: "usage", problems: ["usage: isolated-runtime.mjs resnapshot --dir D [--credential F]"] } }; }
  if (!values.dir) return { exit: RESNAPSHOT_EXIT.usage, result: { schema: RESNAPSHOT_SCHEMA, ok: false, usableUntil: null, code: "usage", problems: ["usage: isolated-runtime.mjs resnapshot --dir D [--credential F]"] } };
  try { return resnapshotRuntime({ dir: values.dir, credential: values.credential, now }); }
  catch { return { exit: RESNAPSHOT_EXIT.refused, result: { schema: RESNAPSHOT_SCHEMA, ok: false, usableUntil: null, code: "internal-error", problems: ["resnapshot failed unexpectedly before any change could be confirmed; inspect the runtime (status) before use"] } }; }
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "resnapshot") {
  // Test hook (never set in production): a fixed clock, so lead-boundary tests are exact.
  const now = process.env.EVAL_LOOP_TEST_NOW_MS ? Number(process.env.EVAL_LOOP_TEST_NOW_MS) : Date.now();
  const { exit, result } = resnapshotCli(process.argv.slice(3), { now });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exit);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: { dir: { type: "string" }, "budget-ledger": { type: "string" }, "budget-limit": { type: "string" }, "budget-scope": { type: "string" }, models: { type: "string", default: LIVE.models }, credential: { type: "string", default: LIVE.credential }, binary: { type: "string", default: LIVE.binary }, "outer-port": { type: "string", default: "18420" }, scratch: { type: "string" } } });
  const dir = values.dir && resolve(values.dir);
  try {
    if (cmd === "prepare") {
      if (!dir || !values["budget-ledger"]) throw new Error("prepare needs --dir and --budget-ledger");
      const budget = budgetIdentity({ limit: values["budget-limit"], scope: values["budget-scope"] });
      if (!existsSync(values.models)) throw new Error(`--models ${values.models}: model catalog not found`);
      const credential = snapshotCredential({ source: values.credential });
      const m = prepareRuntime({ dir, binary: values.binary, credential, modelsCatalog: resolve(values.models), outerPort: Number(values["outer-port"]), mode: "live", budget: { path: resolve(values["budget-ledger"]), ...budget } });
      process.stdout.write(`${JSON.stringify({ prepared: dir, credential: m.credential, configSha256: m.configSha256, ports: m.ports, budget: m.budget })}\n`);
    } else if (cmd === "supervise") await supervise(dir);
    else if (cmd === "start") { const r = await startRuntime(dir); process.stdout.write(`${JSON.stringify({ started: dir, supervisor: r.pid, problems: runtimeProblems(dir) })}\n`); }
    else if (cmd === "stop") { stopRuntime(dir); process.stdout.write(`${JSON.stringify({ stopped: await waitStopped(dir) })}\n`); }
    else if (cmd === "status") {
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      const b = new RequestBudget({ path: m.budget.path, limit: m.budget.limit, scope: m.budget.scope });
      process.stdout.write(`${JSON.stringify({ dir, mode: m.mode, problems: runtimeProblems(dir, { running: true, mode: m.mode }), credential: m.credential, budget: (() => { try { const s = b.status(); return { limit: s.limit, charged: s.charged, attempts: s.attempts, openReservations: s.openReservations, remaining: s.remaining }; } catch (e) { return { error: e.message }; } })() })}\n`);
    } else if (cmd === "selftest") { const r = await selftest(resolve(values.scratch)); process.stdout.write(`${JSON.stringify(r, null, 1)}\n`); process.exit(r.ok ? 0 : 1); }
    else { process.stderr.write("usage: isolated-runtime.mjs prepare|start|status|stop|resnapshot|selftest ...\n"); process.exit(64); }
  } catch (error) { process.stderr.write(`isolated-runtime: ${error?.message ?? error}\n`); process.exit(2); }
}
