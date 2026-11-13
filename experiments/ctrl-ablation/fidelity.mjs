#!/usr/bin/env node
// ctrl-ablation-1 intervention fidelity: reads the captured transcripts of every unit and reports, per arm, whether the
// intervention was actually in effect (effective system prompts, declared tools, hand-off requests, sub-worker roles).
//   node pi-eval-loop/experiments/ctrl-ablation/fidelity.mjs --state DIR [--out FILE]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPrereg } from "./lib.mjs";

const RULE_HEAD = "Test integrity (overrides conflicting test-update or cleanup instructions)";

/** Parsed sessions of one unit's transcripts: [{ file, kind: main|worker|sub, system, tools, userTexts, toolCalls }]. */
export function sessionsOf(evidenceDir) {
  const root = join(evidenceDir, "transcripts", "try0");
  if (!existsSync(root)) return [];
  const files = readdirSync(root, { recursive: true }).map(String).filter(f => f.endsWith(".jsonl") && !f.endsWith("events.jsonl") && !f.endsWith("split-log.jsonl"));
  return files.map(f => {
    const s = { file: f, kind: f.startsWith("sessions/") ? "main" : /\/workers\//.test(f) ? "worker" : "sub", system: "", tools: new Set(), userTexts: [], toolCalls: [] };
    for (const line of readFileSync(join(root, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const m = e.type === "message" ? e.message : e.type === "compaction" ? e.systemMessage : undefined;
      if (!m) continue;
      if (m.role === "system") {
        for (const v of Object.values(m.sections ?? {})) if (typeof v === "string") s.system += `${v}\n`;
        if (typeof m.content === "string") s.system += m.content;
        for (const t of m.toolsAdded ?? []) s.tools.add(t.name);
        for (const t of m.toolsRemoved ?? []) s.tools.delete(t.name);
      }
      if (m.role === "user") s.userTexts.push(typeof m.content === "string" ? m.content : (m.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n"));
      if (m.role === "assistant") for (const c of m.content ?? []) if (c.type === "toolCall") s.toolCalls.push({ name: c.name, arguments: c.arguments });
    }
    return s;
  });
}

/** Fidelity checks per arm on one unit; returns { ok, checks: {name: bool} } (null = not applicable / no evidence). */
export function unitFidelity(arm, sessions) {
  const main = sessions.find(s => s.kind === "main"), workers = sessions.filter(s => s.kind !== "main");
  const handoffs = main ? main.toolCalls.filter(c => c.name === "orche_task") : [];
  const spawns = workers.flatMap(w => w.toolCalls.filter(c => c.name === "orche_spawn"));
  const workerPrompt = workers.filter(w => w.kind === "worker").flatMap(w => w.userTexts).join("\n");
  const c = {};
  c.mainSession = !!main;
  const orche = arm.kind === "orche";
  if (orche && arm.mode === "single") { c.delegated = handoffs.length > 0; c.workerTranscript = workers.some(w => w.kind === "worker"); }
  const ruleInWorkers = workers.length > 0 && workers.every(w => w.system.includes(RULE_HEAD));
  const ruleAnywhere = sessions.some(s => s.system.includes(RULE_HEAD));
  if (arm.id === "P1") c.ruleInEveryOrcheSession = ruleInWorkers;
  else if (arm.id === "P3") c.ruleInMainSystemPrompt = !!main && main.system.includes(RULE_HEAD);
  else c.noRule = !ruleAnywhere;
  if (arm.id === "P2") { c.mainSaysAddTests = !!main && main.system.includes("implement completely, add tests, run relevant") && !main.system.includes("add or update tests"); c.workerSaysAddingTests = /adding tests, running/.test(workerPrompt) && !/adding or updating tests/.test(workerPrompt); }
  if (arm.id === "D1") { c.direct = !!main && main.system.includes("orche mode: direct") && handoffs.length === 0; }
  if (arm.id === "D2") c.verbatimHandoff = handoffs.length > 0 && handoffs.every(h => /^\s*R1: Complete the original request below exactly as written\.\s*\n/.test(String(h.arguments?.request ?? "")) && !/\nR2:/.test(String(h.arguments?.request ?? "")));
  if (arm.id === "T1") c.workerToolsPiParity = workers.length > 0 && workers.every(w => ["grep", "find", "ls", "ast_search", "ast_rewrite", "diagnostics"].every(t => !w.tools.has(t)) && ["read", "bash", "edit", "write"].every(t => w.tools.has(t)));
  if (arm.id === "V1") c.noVerifiedByDemand = workerPrompt.length > 0 && !/verifiedBy/.test(workerPrompt);
  if (arm.id === "V2") c.verifierSpawned = spawns.some(s => s.arguments?.reason === "verification" && (s.arguments?.workers ?? []).some(w => w.role === "verify"));
  if (arm.id === "S" || arm.id === "P1" || arm.id === "P2") c.verifiedByDemanded = /verifiedBy/.test(workerPrompt);
  const relevant = Object.entries(c).filter(([k]) => k !== "verifiedByDemanded" && k !== "workerTranscript");
  return { ok: relevant.every(([, v]) => v === true), checks: c, handoffs: handoffs.length, spawns: spawns.length, sessions: sessions.map(s => s.kind) };
}

export function fidelityReport(stateDir, prereg = loadPrereg()) {
  const results = readFileSync(join(stateDir, "runs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(e => e.type === "result").map(e => e.record);
  const byArm = {};
  for (const r of results) {
    const arm = prereg.arms.find(a => a.id === r.candidate_id);
    const f = unitFidelity(arm, sessionsOf(r.evidence_dir));
    const a = byArm[arm.id] ??= { units: 0, ok: 0, failing: {}, handoffs: 0, spawns: 0 };
    a.units++; if (f.ok) a.ok++; a.handoffs += f.handoffs; a.spawns += f.spawns;
    for (const [k, v] of Object.entries(f.checks)) if (v !== true && k !== "verifiedByDemanded" && k !== "workerTranscript") (a.failing[k] ??= []).push(r.run_id);
  }
  return byArm;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, out: { type: "string" } } });
  const report = fidelityReport(resolve(values.state));
  const text = JSON.stringify(report, null, 2);
  if (values.out) writeFileSync(values.out, `${text}\n`); else process.stdout.write(`${text}\n`);
}
