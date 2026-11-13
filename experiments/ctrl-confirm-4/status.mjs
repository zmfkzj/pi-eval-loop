#!/usr/bin/env node
// ctrl-confirm-4 status (READ-ONLY: writes nothing, never dispatches, never prints per-arm success). Phase, progress, terminal-status
// counts, resources (consumed / reserved / ceilings / remaining), active hours, wall deadline, unresolved pause, runner liveness,
// holdout uses and completion files. Not launch-bound (not in run.mjs experimentFiles).
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/status.mjs --state pi-eval-loop/state/ctrl-confirm-4 [--json]
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPrereg } from "./lib.mjs";

const ZERO = () => ({ requests: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, costUsd: 0 });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const lines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

/** Status of a state directory (pure read). */
export function statusOf(stateDir, prereg, { datasetsRoot, now = Date.now() } = {}) {
  const res = lines(join(stateDir, "resources.jsonl"));
  const consumed = ZERO(), open = new Map(); let pause = null, campaign = null, activeMs = 0, openSince = null, lastBeat = null;
  for (const e of res) {
    const t = Date.parse(e.at);
    if (e.type === "campaign-start") campaign = e;
    else if (e.type === "reserve") open.set(e.attemptId, e);
    else if (e.type === "settle") { open.delete(e.attemptId); for (const k of Object.keys(consumed)) consumed[k] += e.usage?.[k] ?? 0; }
    else if (e.type === "active-start") { openSince = t; lastBeat = t; }
    else if (e.type === "heartbeat") lastBeat = t;
    else if (e.type === "active-end") { if (openSince !== null) activeMs += Math.max(0, Date.parse(e.endAt ?? e.at) - openSince); openSince = null; }
    else if (e.type === "pause") pause = { kind: e.kind, reason: e.reason, at: e.at };
    else if (e.type === "resume") pause = null;
  }
  const lock = readJson(join(stateDir, "runner.lock"));
  const runnerAlive = lock ? alive(lock.pid) : false;
  if (openSince !== null) activeMs += (runnerAlive ? now : Math.min(now, (lastBeat ?? openSince) + 60_000)) - openSince;
  const b = prereg.budget;
  const caps = { requests: b.maxRequestsTotal, input: b.maxInputTokens, output: b.maxOutputTokens, costUsd: b.maxCostUsdApiEquivalent };
  const reserved = ZERO(); for (const r of open.values()) for (const k of Object.keys(reserved)) reserved[k] += r.amount?.[k] ?? 0;
  const remaining = Object.fromEntries(Object.entries(caps).map(([k, c]) => [k, c - consumed[k] - reserved[k]]));
  const campaignJson = readJson(join(stateDir, "campaign.json"));
  const grading = readJson(join(stateDir, "grading.json"));
  const uses = datasetsRoot ? prereg.holdout.batches.map(x => ({ batch: x.path, uses: lines(join(datasetsRoot, x.path, "USES.jsonl")).length, byThisState: lines(join(datasetsRoot, x.path, "USES.jsonl")).filter(u => u.stateDir === resolve(stateDir)).length })) : null;
  const final = readJson(join(stateDir, "FINAL.json")), analysis = existsSync(join(stateDir, "analysis.json")), analysisError = existsSync(join(stateDir, "analysis-error.json"));
  const phase = final ? (analysis ? "FINISHED (analysis written)" : analysisError ? "FINISHED (analysis FAILED)" : "FINISHED") : !existsSync(join(stateDir, "lock.json")) ? (runnerAlive ? "PREPARING (grader validation)" : "NOT STARTED / prepare stopped") : pause && !runnerAlive ? `PAUSED (${pause.kind})` : runnerAlive ? "RUNNING" : "STOPPED (resume with the same command)";
  return {
    at: new Date(now).toISOString(), phase, runner: lock ? { pid: lock.pid, alive: runnerAlive, since: lock.at } : null,
    grading: grading ? { validated: Object.keys(grading).length, failed: Object.values(grading).filter(g => !g.ok).length, of: prereg.holdout.taskIds.length } : null,
    progress: campaignJson ? { total: campaignJson.total, done: campaignJson.done, unsettled: campaignJson.unsettled, terminal: campaignJson.terminal, updatedAt: campaignJson.updatedAt } : null,
    resources: { consumed, reserved, openReservations: open.size, ceilings: caps, remaining, activeHours: Math.round(activeMs / 36_000) / 100, maxActiveHours: b.maxActiveHours, wallDeadline: campaign?.wallDeadline ?? null, planned: prereg.resources.planned },
    continuation: (readJson(join(stateDir, "continuation.json"))?.versions ?? []).map(v => ({ version: v.version, at: v.at, runtime: v.binding?.runtime?.manifestDigest?.slice(0, 16) ?? null, envDigest: v.binding?.envDigest?.slice(0, 12) })),
    runtimeDrifts: res.filter(e => e.type === "runtime-drift").map(e => ({ phase: e.phase, at: e.at, detail: e.detail })),
    pause, holdoutUses: uses, final, envWatch: lines(join(stateDir, "env-watch.jsonl")).at(-1) ?? null, envDrift: lines(join(stateDir, "env-watch.jsonl")).filter(e => e.type === "ENV-DRIFT"),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, prereg: { type: "string" }, json: { type: "boolean", default: false } } });
  const { UMBRELLA } = await import("../../src/protocol.mjs");
  const s = statusOf(resolve(values.state ?? "pi-eval-loop/state/ctrl-confirm-4"), loadPrereg(values.prereg), { datasetsRoot: resolve(UMBRELLA, "results") });
  if (values.json) process.stdout.write(`${JSON.stringify(s, null, 1)}\n`);
  else {
    const r = s.resources, pct = (k) => `${r.consumed[k].toLocaleString("en")} / ${r.ceilings[k].toLocaleString("en")}`;
    process.stdout.write([`ctrl-confirm-4 @ ${s.at}: ${s.phase}`, `runner: ${s.runner ? `pid ${s.runner.pid} ${s.runner.alive ? "alive" : "dead"}` : "none"}`,
      s.grading ? `grader validation: ${s.grading.validated}/${s.grading.of} (${s.grading.failed} failed)` : "grader validation: -",
      s.progress ? `units: ${s.progress.done}/${s.progress.total} final, terminal ${JSON.stringify(s.progress.terminal)}` : "units: -",
      `requests ${pct("requests")}  input ${pct("input")}  output ${pct("output")}  API-eq $${r.consumed.costUsd.toFixed(2)} / $${r.ceilings.costUsd}`,
      `reserved now: ${r.openReservations} attempts; active ${r.activeHours} h / ${r.maxActiveHours} h; wall deadline ${r.wallDeadline ?? "-"}`,
      `pause: ${s.pause ? `${s.pause.kind} @ ${s.pause.at}: ${s.pause.reason}` : "none"}`, `holdout uses: ${JSON.stringify(s.holdoutUses)}`, `continuation: ${s.continuation.length ? s.continuation.map(v => `v${v.version} @ ${v.at} runtime ${v.runtime}`).join("; ") : "none"}; runtime drifts ${s.runtimeDrifts.length}${s.runtimeDrifts.length ? ` (${s.runtimeDrifts.map(d => d.phase).join(",")})` : ""}`,
      `env watch: last ${s.envWatch ? `${s.envWatch.type} @ ${s.envWatch.at}` : "-"}; drift events ${s.envDrift.length}${s.envDrift.length ? ` (${s.envDrift.at(-1).changed.join(",")})` : ""}`, s.final ? `FINAL: ${s.final.reason}` : ""].filter(Boolean).join("\n") + "\n");
  }
}
