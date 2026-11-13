#!/usr/bin/env node
// Pilot evidence for the confirmatory-1 power/sensitivity simulation (offline, model-free).
//
// Source: the real, randomized and interleaved ctrl-ablation-1 discovery campaign (10 arms x 27 exposed orche suite tasks x 3
// repeats, 2026-11-06, route cliproxyapi/gpt-6-luna medium), read from its hash-chained evaluator ledger `runs.jsonl` (the
// committed record of the live checkout; read-only). The outcome is scored as this evaluator (protocol-4 clone, no strict test
// immutability) scores a unit: LEGACY-VALID = completed AND hidden pass AND visible not failed AND no line-based integrity
// violation AND no leak AND no harness crash (identical to ctrl-ablation's posthoc `legacyValid`). The strict byte-identity
// estimand of that campaign is NOT used, because the evaluator that would run the confirmatory holdout does not apply it.
//
//   node studies/confirmatory-1/pilot.mjs --runs <ctrl-ablation-1>/runs.jsonl [--out studies/confirmatory-1/pilot.json]
//
// Only exposed suite task ids, families, tiers and 0/1 outcomes are written (no prompt, test or solution content).
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { Ledger } from "../../src/util.mjs";

const n = (xs) => xs?.length ?? 0;
export const functionalOf = (r) => r.terminal_status === "completed" && r.hidden_test_pass === true && r.visible_test_pass !== false;
export const legacyViolation = (r) => n(r.integrity?.legacyViolations) > 0 || n(r.integrity?.leakHits) > 0;
export const legacyValid = (r) => functionalOf(r) && !legacyViolation(r) && r.terminal_status !== "harness_crash";
/** Tier of an orche suite task from its id (docs/design.md §4: a easy, b/c medium, d/p hard). */
export const suiteTier = (id) => (/^[dp]/.test(id) ? "hard" : /^[bc]/.test(id) ? "medium" : "easy");

export function extractPilot(runsPath) {
  const bytes = readFileSync(runsPath);
  const ledger = new Ledger(runsPath);
  const chain = ledger.verify();
  if (chain.length) throw new Error(`pilot: ledger chain broken: ${chain.slice(0, 3).join("; ")}`);
  const final = new Map();
  for (const rec of ledger.records()) {
    if (rec.type !== "result") continue;
    const r = rec.record;
    if (r.simulated) throw new Error("pilot: simulated record in a real ledger");
    const prev = final.get(r.unit_key);
    if (!prev || r.attempt >= prev.attempt) final.set(r.unit_key, r);
  }
  for (const r of final.values()) if (!Array.isArray(r.integrity?.legacyViolations) || !Array.isArray(r.integrity?.leakHits)) throw new Error(`pilot: ${r.run_id} lacks retained legacy/leak decisions`);
  const arms = {};
  for (const r of final.values()) {
    const arm = (arms[r.candidate_id] ??= { tasks: {}, runs: 0, legacyViolationRuns: 0, routeOrCrash: 0 });
    arm.runs++;
    if (legacyViolation(r)) arm.legacyViolationRuns++;
    if (["route_violation", "harness_crash"].includes(r.terminal_status)) arm.routeOrCrash++;
    const t = (arm.tasks[r.task_id] ??= { family: r.family, tier: suiteTier(r.task_id), outcomes: [] });
    t.outcomes[r.repeat] = legacyValid(r) ? 1 : 0;
  }
  for (const [id, arm] of Object.entries(arms)) for (const [task, t] of Object.entries(arm.tasks)) if (t.outcomes.length !== 3 || t.outcomes.some(x => x === undefined)) throw new Error(`pilot: incomplete design ${id}/${task}`);
  return { schema: "pi-eval-loop/confirmatory-1-pilot@1", source: { path: runsPath, sha256: createHash("sha256").update(bytes).digest("hex"), units: final.size, campaign: "ctrl-ablation-1 discovery (randomized interleaved blocks, 2026-11-06, cliproxyapi/gpt-6-luna medium)" }, estimand: "legacy-valid (completed, hidden pass, visible not failed, no line-based integrity violation, no leak, no harness crash)", arms };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { runs: { type: "string" }, out: { type: "string" } } });
  if (!values.runs) { process.stderr.write("usage: pilot.mjs --runs runs.jsonl [--out pilot.json]\n"); process.exit(64); }
  const pilot = extractPilot(values.runs);
  const text = `${JSON.stringify(pilot, null, 1)}\n`;
  if (values.out) writeFileSync(values.out, text); else process.stdout.write(text);
}
