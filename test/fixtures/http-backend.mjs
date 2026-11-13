// Offline test backend for the recurring exploration route's REAL runtime path (2026-11-07): each unit sends `turns` real HTTP
// model requests (nested turns) to process.env.EVAL_LOOP_UPSTREAM -- which the cycle sets from the isolated runtime's manifest --
// with the runtime's agent key, so every provider attempt crosses the private gateway and its outbound gate (budget admission)
// before it reaches the local TLS stand-in for the provider. The outcome record itself comes from the simulated backend; its
// model_requests is the number of requests actually sent. Never a real provider (the stand-in is a loopback server).
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simulatedBackend } from "../../src/evaluator.mjs";

function post(port, key) {
  const body = JSON.stringify({ model: "gpt-6-luna", messages: [{ role: "user", content: "t" }], stream: false });
  return new Promise((resolve) => {
    const q = http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, timeout: 60_000 }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    q.on("error", () => resolve(0)); q.on("timeout", () => { q.destroy(); resolve(0); });
    q.end(body);
  });
}

/** @param {{ turns?: number, log?: string }} [o] */
export function httpBackend({ turns = 2, log = null } = {}) {
  const sim = simulatedBackend({ seed: "rt", skill: (h) => ({ p: h.id === "c1" ? 0.8 : 0.3 }) });
  const seen = { calls: 0, sent: 0, upstreams: new Set() };
  return {
    simulated: false,
    seen,
    async run(o) {
      const up = process.env.EVAL_LOOP_UPSTREAM, agent = process.env.EVAL_LOOP_AGENT_DIR;
      seen.upstreams.add(up); seen.calls++;
      const key = JSON.parse(readFileSync(join(agent, "cliproxyapi.json"), "utf8")).apiKey;
      let sent = 0;
      for (let i = 0; i < turns; i++) { await post(Number(new URL(up).port), key); sent++; }
      seen.sent += sent;
      if (log) { const { appendFileSync } = await import("node:fs"); appendFileSync(log, `${JSON.stringify({ pid: process.pid, upstream: up, sent })}\n`); }
      const rec = await sim.run(o);
      return { ...rec, model_requests: sent, model_requests_completed: sent };
    },
  };
}
