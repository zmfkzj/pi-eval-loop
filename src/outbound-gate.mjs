// Outbound attempt gate of the isolated calibration runtime (2026-11-07; docs/design.md "Request budget", studies/confirmatory-1/
// ISOLATED-RUNTIME.md).
//
// The isolated gateway (a private CLIProxyAPI process in its own network namespace, src/isolated-runtime.mjs) has exactly ONE way
// to reach the network: this HTTP CONNECT proxy, configured as its `requests.proxy-url`. Every provider attempt the gateway makes
// (first try, gateway-internal retry, credential fallback, zstd re-send, redirect) is a new CONNECT here: for chatgpt.com the
// pinned CLIProxyAPI build dials a fresh uTLS connection per HTTP round trip and closes it afterwards (helps/utls_client.go
// utlsRoundTripper.RoundTrip + roundTripUtlsConnection, DisableKeepAlives / one HTTP/2 client conn per round trip), so one tunnel
// carries at most one provider request. The selftest (isolated-runtime.mjs --selftest) re-measures that contract on the real
// binary against a local TLS stand-in before any chargeable call.
//
// Per CONNECT, BEFORE the upstream connection is opened, the gate calls budget.admitAttempt() (src/request-budget.mjs): one
// durable `attempt` record in the study's single cumulative ledger, admitted only while attempts + 1 <= the charged total
// (settled usage + open reservations <= limit). A refusal, an unusable ledger, a host outside the allowlist or a non-CONNECT
// request is answered 403/503 and nothing leaves. The gate never terminates TLS: it sees no prompt, answer or token.
import http from "node:http";
import net from "node:net";
import { appendFileSync, existsSync, rmSync } from "node:fs";

/**
 * Start the gate. `allow`: ["host:port"] (exact). `route(host, port)`: the address actually dialled (tests point chatgpt.com at a
 * local TLS stand-in; production dials the named host). `journal`: jsonl path for non-secret events (host, verdict, n).
 * @param {{ budget: { admitAttempt(meta: any): Promise<any>, refusal?: string | null }, allow: string[], listen: { path?: string, port?: number, host?: string },
 *   route?: (host: string, port: number) => { host: string, port: number }, journal?: string, log?: (line: string) => void }} options
 * @returns {Promise<{ server: http.Server, address: any, stats: { admitted: number, refused: number, failed: number }, close(): Promise<void> }>}
 */
export async function startOutboundGate({ budget, allow, listen, route = (host, port) => ({ host, port }), journal, log = () => {} }) {
  const allowed = new Set(allow.map(a => a.toLowerCase()));
  const stats = { admitted: 0, refused: 0, failed: 0 };
  const note = (event) => { if (journal) { try { appendFileSync(journal, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 }); } catch { /* journal is evidence, not accounting */ } } };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    // Plain-HTTP proxying (absolute-URI requests) would bypass the per-tunnel accounting: refused.
    stats.refused++; note({ verdict: "refused", why: "not a CONNECT", method: req.method });
    res.writeHead(403, { "content-type": "text/plain" }); res.end("outbound gate: only CONNECT to allowlisted hosts\n");
  });
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  server.on("connect", async (req, client, head) => {
    client.on("error", () => {});
    const target = String(req.url ?? "").toLowerCase();
    const m = target.match(/^([a-z0-9.-]+):(\d{1,5})$/);
    if (!m || !allowed.has(target)) {
      stats.refused++; note({ verdict: "refused", why: "host not allowlisted", target: target.slice(0, 120) }); log(`gate: refused ${target.slice(0, 80)} (not allowlisted)`);
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return;
    }
    let ticket;
    try { ticket = await budget.admitAttempt({ target }); } catch (error) {
      stats.refused++; note({ verdict: "refused", why: `accounting unusable: ${String(error?.message ?? error).slice(0, 200)}`, target }); log(`gate: accounting unusable, refusing: ${error?.message}`);
      client.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return;
    }
    if (!ticket) {
      stats.refused++; note({ verdict: "refused", why: budget.refusal ?? "budget", target }); log(`gate: ${budget.refusal}`);
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return;
    }
    stats.admitted++; note({ verdict: "admitted", target, n: ticket.n, seq: ticket.seq });
    const to = route(m[1], Number(m[2]));
    const upstream = net.connect(to.port, to.host);
    let open = false;
    upstream.once("connect", () => { open = true; client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head?.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
    const close = () => { upstream.destroy(); client.destroy(); };
    upstream.on("error", (error) => { if (!open) { stats.failed++; note({ verdict: "upstream-failed", target, n: ticket.n, error: error.code ?? String(error).slice(0, 80) }); client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); } else close(); });
    upstream.on("close", close); client.on("close", close);
  });
  if (listen.path && existsSync(listen.path)) rmSync(listen.path);
  await new Promise((ok, fail) => { server.once("error", fail); if (listen.path) server.listen(listen.path, ok); else server.listen(listen.port ?? 0, listen.host ?? "127.0.0.1", ok); });
  return {
    server, address: server.address(), stats,
    close: () => new Promise(ok => { for (const s of sockets) s.destroy(); server.close(() => ok()); }),
  };
}
