// Byte pipes between a TCP port on 127.0.0.1 and a unix socket (isolated calibration runtime, src/isolated-runtime.mjs).
// Runs on the host (outer bridge: route proxy -> gateway socket) and inside the gateway's network namespace (inner bridges).
//   node runtime-bridge.mjs inner <gatePort> <gateSocket> <gwSocket> <gwPort> <binary> <config> <logFile> [readyFile]
import net from "node:net";
import { existsSync, openSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const pipe = (a, b) => { a.pipe(b); b.pipe(a); const close = () => { a.destroy(); b.destroy(); }; a.on("error", close); b.on("error", close); a.on("close", close); b.on("close", close); };

/** Listen on 127.0.0.1:port; every connection is piped to the unix socket. */
export function tcpToUnix(port, socketPath) {
  const server = net.createServer(c => pipe(c, net.createConnection(socketPath)));
  return new Promise((ok, fail) => { server.once("error", fail); server.listen(Number(port), "127.0.0.1", () => ok(server)); });
}
/** Listen on a unix socket; every connection is piped to 127.0.0.1:port. */
export function unixToTcp(socketPath, port) {
  if (existsSync(socketPath)) rmSync(socketPath);
  const server = net.createServer(c => pipe(c, net.createConnection(Number(port), "127.0.0.1")));
  return new Promise((ok, fail) => { server.once("error", fail); server.listen(socketPath, () => ok(server)); });
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "inner") {
  // Inside the sandbox (own network namespace, loopback only): the gate is reachable only through gateSocket; the gateway's
  // listener is exported only through gwSocket. Then the gateway binary runs in the foreground; this process exits with it.
  const [, , , gatePort, gateSocket, gwSocket, gwPort, binary, config, logFile, ready] = process.argv;
  await tcpToUnix(gatePort, gateSocket);
  await unixToTcp(gwSocket, gwPort);
  const out = openSync(logFile, "a", 0o600);
  const child = spawn(binary, ["-config", config, "-local-model"], { stdio: ["ignore", out, out], env: process.env });
  if (ready) writeFileSync(ready, String(child.pid));
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { child.kill("SIGTERM"); });
  child.on("exit", (code) => process.exit(code ?? 1));
}
