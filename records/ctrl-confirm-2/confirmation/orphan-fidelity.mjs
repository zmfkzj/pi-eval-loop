#!/usr/bin/env node
// Supplementary (descriptive, not preregistered) fidelity check of the 8 attempts reconciled after the 2026-11-06 14:52Z controller
// interruption. Evaluator.reconcile records no evidence_dir, so the frozen fidelity.mjs looks at an empty path for them; their
// partial transcripts still exist at the evaluator's deterministic evidence path. This reads them with the frozen unitFidelity and
// writes orphan-fidelity.json. It changes no record and no locked result; the reconciled units stay `aborted` failures.
//   node pi-eval-loop/records/ctrl-confirm-2/confirmation/orphan-fidelity.mjs --state DIR [--out FILE]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { sessionsOf } = await import(join(PKG, "experiments/ctrl-ablation/fidelity.mjs"));
const { unitFidelity } = await import(join(PKG, "experiments/ctrl-confirm-2/fidelity.mjs"));
const { loadPrereg } = await import(join(PKG, "experiments/ctrl-confirm-2/lib.mjs"));

const { values } = parseArgs({ options: { state: { type: "string" }, out: { type: "string" } } });
const stateDir = resolve(values.state);
const prereg = loadPrereg();
const entries = readFileSync(join(stateDir, "runs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
const out = entries.filter(e => e.type === "result" && e.reconciled).map(e => {
  const r = e.record;
  const dir = join(stateDir, "evidence", r.candidate_id, `${r.split}-${r.task_id}-r${r.repeat}-a${r.attempt}-${r.unit_key.slice(0, 8)}`);
  const arm = prereg.arms.find(a => a.id === r.candidate_id);
  const f = existsSync(dir) ? unitFidelity(arm, sessionsOf(dir)) : null;
  return { run_id: r.run_id, arm: arm.id, terminal_status: r.terminal_status, evidenceDir: dir, exists: existsSync(dir), fidelity: f };
});
const text = `${JSON.stringify({ at: new Date().toISOString(), units: out.length, ok: out.filter(u => u.fidelity?.ok).length, perUnit: out }, null, 2)}\n`;
if (values.out) writeFileSync(values.out, text);
process.stdout.write(text);
