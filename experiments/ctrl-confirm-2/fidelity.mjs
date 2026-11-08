#!/usr/bin/env node
// ctrl-confirm-2 intervention fidelity from the captured transcripts of every unit:
//  - every arm: the disclosed integrity contract is in the main session's task message;
//  - orche arms: delegation happened, and whether the contract reached the editing worker (hand-off request) is REPORTED
//    (a harness behaviour shared by OC and OCR, not an intervention check);
//  - OCR: the test rule is in the system prompt of every orche-created session; PCR: in the main system prompt; OC/PC: nowhere.
//   node pi-eval-loop/experiments/ctrl-confirm-2/fidelity.mjs --state DIR [--out FILE]
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { sessionsOf } from "../ctrl-ablation/fidelity.mjs";
import { loadPrereg } from "./lib.mjs";

export const RULE_HEAD = "Test integrity (overrides conflicting test-update or cleanup instructions)";
export const CONTRACT_HEAD = "Evaluation integrity contract (applies to every solution";

export function unitFidelity(arm, sessions) {
  const main = sessions.find(s => s.kind === "main"), workers = sessions.filter(s => s.kind !== "main");
  const handoffs = main ? main.toolCalls.filter(c => c.name === "orche_task") : [];
  const c = {};
  c.mainSession = !!main;
  c.contractInTask = !!main && main.userTexts.some(t => t.includes(CONTRACT_HEAD));
  const ruleAnywhere = sessions.some(s => s.system.includes(RULE_HEAD));
  if (arm.kind === "orche") c.delegated = handoffs.length > 0 && workers.some(w => w.kind === "worker");
  if (arm.id === "OCR") c.ruleInEveryOrcheSession = workers.length > 0 && workers.every(w => w.system.includes(RULE_HEAD));
  else if (arm.id === "PCR") c.ruleInMainSystemPrompt = !!main && main.system.includes(RULE_HEAD);
  else c.noRule = !ruleAnywhere;
  const workerTexts = workers.filter(w => w.kind === "worker").flatMap(w => w.userTexts).join("\n");
  const reported = { contractReachedWorker: arm.kind === "orche" ? workerTexts.includes(CONTRACT_HEAD) : null };
  return { ok: Object.values(c).every(v => v === true), checks: c, reported, handoffs: handoffs.length, sessions: sessions.map(s => s.kind) };
}

export function fidelityReport(stateDir, prereg = loadPrereg()) {
  const results = readFileSync(join(stateDir, "runs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(e => e.type === "result").map(e => e.record);
  const last = new Map(); for (const r of results) last.set(r.unit_key, r);
  const byArm = {};
  for (const r of last.values()) {
    const arm = prereg.arms.find(a => a.id === r.candidate_id);
    const f = unitFidelity(arm, sessionsOf(r.evidence_dir ?? ""));
    const a = byArm[arm.id] ??= { units: 0, ok: 0, failing: {}, contractReachedWorker: 0, handoffs: 0 };
    a.units++; if (f.ok) a.ok++; a.handoffs += f.handoffs; if (f.reported.contractReachedWorker) a.contractReachedWorker++;
    for (const [k, v] of Object.entries(f.checks)) if (v !== true) (a.failing[k] ??= []).push(r.run_id);
  }
  return byArm;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, out: { type: "string" } } });
  const text = JSON.stringify(fidelityReport(resolve(values.state)), null, 2);
  if (values.out) writeFileSync(values.out, `${text}\n`); else process.stdout.write(`${text}\n`);
}
