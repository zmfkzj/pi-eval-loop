// Credential-free stand-in for CLIProxyAPI's Responses endpoint (tests and `eval-loop selftest` only; its runs are marked
// simulated and never count as real measurements). It speaks the OpenAI Responses SSE stream Pi's provider parses, so the
// whole real path is exercised: sandbox -> bridge -> endpoint gate -> route proxy -> this server -> Pi tools -> grader.
//
// Policy per task (identified by its instruction text in the user message): with probability `solve` (seeded by session) the
// "model" writes the reference files with Pi's `write` tool, otherwise it stops without changes. A harness whose system prompt
// contains SKILL_MARKER uses `solveWithMarker` instead - a stand-in for a harness change that really improves behaviour.
// Policy "cheat" deletes the visible test directory (an integrity violation the checks must catch).
import http from "node:http";
import zlib from "node:zlib";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createRng } from "./rng.mjs";

const MODELS = JSON.parse(readFileSync(new URL("../test/fixtures/codex-models.json", import.meta.url), "utf8"));
export const SKILL_MARKER = "Before you finish, re-read every requirement of the task once more.";

function referenceFiles(taskDir) {
  const root = join(taskDir, "reference");
  const out = {};
  const visit = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) visit(p); else out[relative(root, p)] = readFileSync(p, "utf8"); } };
  if (existsSync(root)) visit(root);
  return out;
}

const decode = (enc, buf) => !enc || enc === "identity" ? buf : enc === "zstd" ? zlib.zstdDecompressSync(buf) : enc === "gzip" ? zlib.gunzipSync(buf) : enc === "br" ? zlib.brotliDecompressSync(buf) : enc === "deflate" ? zlib.inflateSync(buf) : buf;
const sse = (events) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const userText = (input) => (Array.isArray(input) ? input : []).filter(i => i?.role === "user" || i?.type === "message").flatMap(i => Array.isArray(i.content) ? i.content.map(c => c.text ?? "") : [String(i.content ?? "")]).join("\n");

/**
 * Start the faux upstream. tasks: [{ id, dir, instruction, policy: { solve, solveWithMarker, cheat? } }]; model = the route model.
 * Resolves with { url, stop(), requests }.
 */
export async function startFauxUpstream({ tasks, model, seed = "faux", port = 0 }) {
  const requests = [];
  const plans = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      // The gateway's codex model list (shape captured from CLIProxyAPI, long texts elided), so the provider registers the route.
      if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ models: MODELS })); return; }
      let body; try { body = JSON.parse(decode(req.headers["content-encoding"], Buffer.concat(chunks)).toString("utf8")); } catch { res.writeHead(400); res.end("{}"); return; }
      const session = String(body.prompt_cache_key ?? "none");
      const text = userText(body.input);
      const task = tasks.find(t => text.includes(t.instruction.slice(0, 120)));
      const marked = String(body.instructions ?? "").includes(SKILL_MARKER) || JSON.stringify(body.input ?? []).includes(SKILL_MARKER);
      requests.push({ session, task: task?.id, marked, path: req.url });
      if (!plans.has(session)) {
        const rng = createRng(`${seed}:${session}`);
        const policy = task?.policy ?? { solve: 0 };
        const p = marked && policy.solveWithMarker !== undefined ? policy.solveWithMarker : policy.solve;
        const steps = [];
        if (task && policy.cheat) steps.push({ name: "bash", arguments: { command: "rm -rf test" } });
        else if (task && rng.next() < p) for (const [path, content] of Object.entries(referenceFiles(task.dir))) steps.push({ name: "write", arguments: { path, content } });
        plans.set(session, steps);
      }
      const done = (Array.isArray(body.input) ? body.input : []).filter(i => i?.type === "function_call_output").length;
      const step = plans.get(session)[done];
      const id = `resp_${requests.length}`;
      const usage = { input_tokens: 1000 + 10 * done, output_tokens: 50, total_tokens: 1050 + 10 * done, input_tokens_details: { cached_tokens: 500 }, output_tokens_details: { reasoning_tokens: 0 } };
      const events = [{ type: "response.created", response: { id, model, status: "in_progress" } }];
      if (step) {
        const item = { type: "function_call", id: `fc_${done}`, call_id: `call_${session.slice(-8)}_${done}`, name: step.name, arguments: JSON.stringify(step.arguments), status: "completed" };
        events.push({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }, { type: "response.output_item.done", output_index: 0, item });
      } else {
        const message = task ? "Done." : "I could not identify the task.";
        events.push({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: `msg_${done}`, role: "assistant", content: [] } },
          { type: "response.output_text.delta", output_index: 0, item_id: `msg_${done}`, content_index: 0, delta: message },
          { type: "response.output_item.done", output_index: 0, item: { type: "message", id: `msg_${done}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: message, annotations: [] }] } });
      }
      events.push({ type: "response.completed", response: { id, model, status: "completed", usage } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(events));
    });
  });
  await new Promise(ok => server.listen(port, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, stop: () => new Promise(ok => server.close(() => ok())) };
}
