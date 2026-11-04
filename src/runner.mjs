// One evaluated unit: a harness (pure Pi, an orche worktree, or k independent pure attempts) on one task, inside the sandbox, on
// the pinned route, then the independent grader and the mechanical integrity checks. Everything that decides the record comes
// from the controller's own observations: the process exit, the JSON event stream it captured, the wire journal its proxy wrote
// outside the sandbox and the sandboxed grader.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ensureDir, textMap, treeDigest, walkFiles, sha256, redact } from "./util.mjs";
import { BRIDGE, BRIDGE_PORT, LAUNCH, MOUNTS, PLACEHOLDER_KEY, completedModelCalls, harnessBinds, runSandboxed, startModelPath, wireEntries } from "./sandbox.mjs";
import { gradeWorkspace } from "./grader.mjs";
import { stageWorkspace } from "./datasets.mjs";
import { makeRecord } from "./metrics.mjs";
import { workspaceIntegrity, leakScan, sessionToolCalls } from "./integrity.mjs";
import { classifyFailure } from "./analysis.mjs";

export const BOX = "/tmp/box";
export const TASK_SUFFIX = "\n\nWork in the current directory (a git repository with the project). Make the change the task asks for and keep the existing tests passing. Do not commit. Stop when you are done.";

/** Private orche config of a run: every model tier pinned to the one route, product defaults otherwise. */
export function orcheConfig(route, mode, unit) {
  const ref = { model: `${route.provider}/${route.model}`, thinking: route.effort };
  const tiers = ["main", "orchestrator", "worker", "strong-orchestrator", "strong-worker", "advisor", "strong-advisor"];
  return {
    mainMode: mode, routes: {}, default: { ...ref }, models: Object.fromEntries(tiers.map(tier => [tier, { ...ref }])),
    single: { ledger: false, spawn: true, advisor: false }, concurrentSessions: { enabled: false }, bashReview: { enabled: false },
    limits: { overallMs: unit.wallMs, assignmentMs: unit.wallMs, assignmentRequests: unit.maxRequests },
  };
}

export const piSettings = (route) => ({ defaultProvider: route.provider, defaultModel: route.model, defaultThinkingLevel: route.effort, quietStartup: true, transport: "sse" });

function lastAssistant(eventsText) {
  let last; let tools = 0; const toolNames = {}; let toolErrors = 0;
  for (const line of eventsText.split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "message_end" && e.message?.role === "assistant") last = e.message;
    if (e.type === "tool_execution_end") { tools++; toolNames[e.toolName] = (toolNames[e.toolName] ?? 0) + 1; if (e.isError) toolErrors++; }
  }
  const text = last && Array.isArray(last.content) ? last.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
  return { last, tools, toolNames, toolErrors, finalText: text };
}

/** Terminal status of one Pi invocation from controller observations (never from files the agent wrote). */
export function terminalOf({ run, events, wire, totals, gateRefusals, stderr }) {
  const completed = completedModelCalls(wire);
  const refusedRoute = (totals.refused?.route ?? 0) + (totals.refused?.unverifiable ?? 0);
  if (refusedRoute > 0 || (totals.offRouteResponses ?? 0) > 0) return { status: "route_violation", detail: `${refusedRoute} refused off-route request(s), ${totals.offRouteResponses ?? 0} off-route response(s)` };
  if (/Pi extension load failed|Failed to load extension|Error loading extension|extension.*failed to load/i.test(stderr)) return { status: "harness_crash", detail: stderr.split("\n").find(l => /extension/i.test(l))?.slice(0, 300) ?? "extension load failure" };
  if (run.guardFired) return { status: "timeout", detail: "unit wall-time guard" };
  const { last } = events;
  if (!last) {
    if (completed === 0) return { status: (totals.forwarded ?? 0) > 0 || (totals.providerErrors ?? 0) > 0 ? "model_unavailable" : "infra_error", detail: `no assistant message, ${totals.forwarded ?? 0} forwarded, exit ${run.code}${gateRefusals.length ? `, ${gateRefusals.length} gated` : ""}: ${stderr.slice(-300)}` };
    return { status: "agent_error", detail: `no final assistant message after ${completed} completed model call(s), exit ${run.code}` };
  }
  const reason = String(last.stopReason ?? "");
  if (reason === "error") {
    const error = String(last.errorMessage ?? "").slice(0, 300);
    if ((totals.refused?.budget ?? 0) > 0) return { status: "agent_error", detail: `request budget exhausted: ${error}` };
    if (completed === 0) return { status: "model_unavailable", detail: error };
    return { status: "model_error", detail: error };
  }
  if (reason === "aborted") return { status: "aborted", detail: "aborted" };
  if (run.code !== 0) return { status: "agent_error", detail: `exit ${run.code}, stopReason ${reason}` };
  return { status: "completed", detail: reason };
}

/** Every mount of a task agent's sandbox (exported so the isolation tests probe exactly this set). */
export function agentBinds({ env, box, launch, socket, harness }) {
  const binds = [
    { from: env.nodeDir }, { from: env.piModules }, { from: box, to: BOX, rw: true },
    { from: env.provider, to: MOUNTS.provider }, { from: BRIDGE, to: MOUNTS.bridge }, { from: launch, to: MOUNTS.launch }, { from: socket, to: MOUNTS.socket, rw: true },
  ];
  if (harness.kind === "orche") binds.push(...harnessBinds(harness.dir, MOUNTS.harness), { from: join(env.orche, "node_modules"), to: `${MOUNTS.harness}/node_modules` });
  return binds;
}

/** One Pi invocation in the sandbox; returns observations and leaves the workspace in place. */
async function piAttempt({ harness, task, route, unit, env, box, evidence, sessionId, signalPids, control }) {
  const ws = join(box, "ws"), agent = join(box, "agent"), sessions = join(box, "sessions"), home = join(box, "home"), tmp = join(box, "tmp");
  rmSync(box, { recursive: true, force: true });
  for (const dir of [agent, sessions, home, tmp]) ensureDir(dir);
  stageWorkspace(task, ws);
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(env.agentDir, name))) copyFileSync(join(env.agentDir, name), join(agent, name));
  const bridgeUrl = `http://127.0.0.1:${BRIDGE_PORT}`;
  writeFileSync(join(agent, "cliproxyapi.json"), JSON.stringify({ apiKey: PLACEHOLDER_KEY, baseUrl: bridgeUrl, providerId: "cliproxyapi", providerName: "CLIProxyAPI" }), { mode: 0o600 });
  writeFileSync(join(agent, "settings.json"), JSON.stringify(piSettings(route), null, 2));
  if (harness.kind === "orche") writeFileSync(join(agent, "orche.config.json"), JSON.stringify(orcheConfig(route, harness.mode, unit), null, 2));
  // Short private control directory (unix socket paths are limited to ~108 bytes); the evaluator records it before dispatch so a
  // crash can be reconciled from the wire journal kept here.
  ensureDir(control);
  const launch = join(control, "launch.sh");
  writeFileSync(launch, LAUNCH, { mode: 0o555 });
  const model = await startModelPath({ dir: join(control, "model"), route, maxRequests: unit.maxRequests, upstream: env.upstream, agentDir: env.agentDir, keyOverride: env.keyOverride });
  const inside = (p) => p.replace(box, BOX);
  const binds = agentBinds({ env, box, launch, socket: model.socket, harness });
  const piArgs = [env.piCli, "--mode", "json", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve", "--no-context-files", "--offline",
    "-e", `${MOUNTS.provider}/extensions/index.ts`];
  if (harness.kind === "orche") piArgs.push("-e", `${MOUNTS.harness}/src/extension/index.ts`);
  piArgs.push("--model", `${route.provider}/${route.model}`, "--thinking", route.effort, "--session-dir", inside(sessions), "--session-id", sessionId, "--", `${task.instruction}${TASK_SUFFIX}`);
  const sandboxEnv = {
    PATH: `${env.nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: inside(home), TMPDIR: inside(tmp), LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb", TZ: "UTC",
    PI_CODING_AGENT_DIR: inside(agent), PI_CODING_AGENT_SESSION_DIR: inside(sessions), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1",
    CLIPROXYAPI_BASE_URL: bridgeUrl, CLIPROXYAPI_API_KEY: PLACEHOLDER_KEY, CLIPROXYAPI_FAST: "0", EL_NODE: env.node, EL_BRIDGE_READY: `${inside(tmp)}/.bridge-ready`,
  };
  const eventsPath = join(evidence, `events-${sessionId}.jsonl`), stderrPath = join(evidence, `stderr-${sessionId}.txt`);
  const started = Date.now();
  let run;
  try {
    run = await runSandboxed({ binds, env: sandboxEnv, cwd: inside(ws), command: ["/bin/sh", MOUNTS.launch, env.node, ...piArgs] }, { guardMs: unit.wallMs, stdout: eventsPath, stderr: stderrPath, keep: 64 * 1024, onSpawn: pid => signalPids?.add(pid) });
  } finally { await model.stop(); }
  const wire = wireEntries(model.wireLog);
  const totals = model.totals();
  cpSync(model.wireLog, join(evidence, `wire-${sessionId}.jsonl`), { force: true });
  if (existsSync(`${model.wireLog}.totals.json`)) cpSync(`${model.wireLog}.totals.json`, join(evidence, `wire-${sessionId}.totals.json`), { force: true });
  const eventsText = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
  const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "";
  const events = lastAssistant(eventsText);
  const terminal = terminalOf({ run, events, wire, totals, gateRefusals: model.gateRefusals(), stderr });
  const sessionText = readdirSync(sessions, { recursive: true }).filter(f => String(f).endsWith(".jsonl")).map(f => readFileSync(join(sessions, String(f)), "utf8")).join("\n");
  rmSync(launch, { force: true });
  return { ws, run, wallMs: Date.now() - started, totals, wire, completed: completedModelCalls(wire), events, terminal, sessionText, gateRefusals: model.gateRefusals(), stderrTail: stderr.slice(-2000) };
}

/**
 * Evaluate one unit. `harness` = { id, kind: pure|orche|multi, dir?, commit?, mode?, k? }.
 * Returns a run record (metrics.makeRecord) and writes evidence (events, wire journals, diff, grade, integrity) to `evidence`.
 */
export async function runUnit({ harness, task, repeat, split, context, protocol, protocolDigest, env, envDigest, scratch, evidence, attempt = 1, unitKey, runId, grading, signalPids, controlDir }) {
  controlDir ??= mkdtempSync(join(tmpdir(), "el-"));
  rmSync(evidence, { recursive: true, force: true });
  ensureDir(evidence);
  const startedAt = new Date().toISOString();
  const route = protocol.route, unit = protocol.unit;
  const attempts = harness.kind === "multi" ? harness.k : 1;
  const tries = [];
  let chosen;
  for (let i = 0; i < attempts; i++) {
    const box = join(scratch, `box-${i}`);
    const sessionId = `el-${runId}-${i}`.replace(/[^A-Za-z0-9._-]/g, "-");
    const tried = await piAttempt({ harness: harness.kind === "multi" ? { kind: "pure" } : harness, task, route, unit, env, box, evidence, sessionId, signalPids, control: i === 0 ? controlDir : join(controlDir, `try${i}`) });
    tries.push(tried);
    if (harness.kind !== "multi") { chosen = tried; break; }
    // Independent-attempt baseline: the first attempt whose VISIBLE tests pass is submitted (hidden tests are never consulted).
    if (tried.terminal.status === "completed") {
      const visible = await gradeWorkspace({ task: { ...task, hidden: undefined, customGrader: undefined }, workspace: tried.ws, scratch: join(scratch, `vis-${i}`), env, timeoutMs: unit.graderMs, baselineFailing: grading?.baselineFailing ?? [] });
      tried.visiblePass = visible.visible?.pass === true;
      if (tried.visiblePass) { chosen = tried; break; }
    }
    if (tried.completed === 0 && ["infra_error", "model_unavailable"].includes(tried.terminal.status)) { chosen = tried; break; }
  }
  chosen ??= tries.at(-1);
  const sumOf = (fn) => tries.reduce((s, t) => s + fn(t), 0);
  const integrity = workspaceIntegrity(textMap(task.repo), textMap(chosen.ws), walkFiles(chosen.ws));
  const leaks = leakScan(chosen.sessionText, chosen.events);
  integrity.leakHits = leaks;
  let grade = { hiddenPass: false };
  if (chosen.terminal.status !== "infra_error") grade = await gradeWorkspace({ task, workspace: chosen.ws, scratch: join(scratch, "grade"), env, timeoutMs: unit.graderMs, expected: grading?.expected ?? {}, baselineFailing: grading?.baselineFailing ?? [] });
  let diff = "";
  try { diff = execFileSync("git", ["diff", "--no-color", "HEAD"], { cwd: chosen.ws, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString(); execFileSync("git", ["add", "-A", "--force"], { cwd: chosen.ws, stdio: "ignore" }); diff = execFileSync("git", ["diff", "--no-color", "--cached", "HEAD"], { cwd: chosen.ws, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString(); } catch { /* unreadable */ }
  writeFileSync(join(evidence, "final.diff"), redact(diff, [env.keyOverride].filter(Boolean)));
  writeFileSync(join(evidence, "grade.json"), JSON.stringify(grade, null, 2));
  writeFileSync(join(evidence, "integrity.json"), JSON.stringify(integrity, null, 2));
  let terminal = chosen.terminal;
  if (grade.error && terminal.status === "completed") terminal = { status: "grader_error", detail: grade.error.slice(0, 300) };
  const critical = (terminal.status === "harness_crash" ? 1 : 0) + integrity.violations.length + leaks.length;
  const record = makeRecord({
    run_id: runId, unit_key: unitKey, attempt, candidate_id: harness.id, harness_kind: harness.kind, harness_commit: harness.commit, mode: harness.mode,
    task_id: task.id, split, family: task.family, hard: task.hard, repeat, context,
    model_route: `${route.provider}/${route.model}`, thinking_effort: route.effort, environment_digest: envDigest, protocol_digest: protocolDigest,
    terminal_status: terminal.status, terminal_detail: terminal.detail,
    agent_reported_status: chosen.events.last?.stopReason ?? null,
    hidden_test_pass: grade.hiddenPass === true, visible_test_pass: grade.visible ? grade.visible.pass : null,
    correctness_score: grade.correctness ?? 0, regression_count: grade.visible?.regressions?.length ?? 0, critical_failure_count: critical, integrity,
    model_requests: sumOf(t => t.totals.forwarded ?? 0), model_requests_completed: sumOf(t => t.completed),
    input_tokens: sumOf(t => t.totals.input ?? 0), output_tokens: sumOf(t => t.totals.output ?? 0), cache_tokens: sumOf(t => t.totals.cached ?? 0), cache_write_tokens: sumOf(t => t.totals.cacheWrite ?? 0),
    wall_time: sumOf(t => t.wallMs), attempts_used: tries.length, evidence_dir: evidence, started_at: startedAt,
  });
  const ranTests = sessionToolCalls(chosen.sessionText).some(call => call.name === "bash" && /\btest\b|--test/.test(JSON.stringify(call.arguments ?? {})));
  record.failure_class = classifyFailure(record, { ranTests, tools: chosen.events.tools, toolNames: chosen.events.toolNames, toolErrors: chosen.events.toolErrors, diffBytes: diff.length, grade });
  record.final_text_excerpt = chosen.events.finalText.slice(0, 600);
  record.workspace_digest = treeDigest(chosen.ws);
  writeFileSync(join(evidence, "record.json"), JSON.stringify(record, null, 2));
  for (let i = 0; i < tries.length; i++) rmSync(join(scratch, `box-${i}`), { recursive: true, force: true });
  return record;
}

export const evidenceDigest = (dir) => existsSync(dir) ? sha256(readdirSync(dir).sort().join("\n")) : null;
