#!/usr/bin/env node
// Seal the corrected calibration-only batch and freeze its calibration plan (confirmatory-1, 2026-11-07; model-free).
//
// Seals every corrected version staged in <pool>/calibration-staged (src/supply.mjs sealCalibrationBatch) after checking, per
// task: the intake validation (validation.private.json ok), a complete cross-provider triage of THIS version (triage.mjs:
// blind tests re-run against this version, the version's own adversarial review, every adjudicated violation of its ancestors
// now rejected by its hidden tests) with no invalid class, and the version binding of that triage (task id). Then writes the
// frozen plan for BOTH calibration batches (<private>/calibration/plan-v2.json) BEFORE any target-model result exists. The
// original batch, its seal and exclusions-v1.json are only read (their hashes are recorded in the plan).
//
//   node studies/confirmatory-1/seal-corrected.mjs --private <root> [--dry-run]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { sealCalibrationBatch } from "../../src/supply.mjs";
import { verifySeal } from "../../src/datasets.mjs";
import { atomicWriteJson, sha256 } from "../../src/util.mjs";
import { INVALID_CLASSES } from "./calibrate.mjs";

export const ORIGINAL = { batch: "b20261106T131706Z-47fd006e", seal: "715eb3dbef4d51d2314fe7171571befa59bb24fc271cedf165552d8753d490ad" };
export const RULE = { feature: "declared-tier", hardMaxRate: 0.5, minTasksPerLevel: 3, repeats: 3, censoring: "infra-excluded@1" };

/** Problems of one staged corrected version (pure over files). */
export function correctedProblems({ id, dir, reviews }) {
  const out = [];
  try { const v = JSON.parse(readFileSync(join(dir, "validation.private.json"), "utf8")); if (v.ok !== true) out.push(`intake validation ${v.code}`); } catch { out.push("no intake validation"); }
  const p = join(reviews, id, "triage.json");
  if (!existsSync(p)) return [...out, "no cross-provider triage of this version"];
  const t = JSON.parse(readFileSync(p, "utf8"));
  if (t.task !== id) out.push(`triage bound to ${t.task}`);
  const bad = (t.classes ?? []).filter(c => c !== "ok");
  if (bad.length) out.push(`triage classes ${bad.join(", ")}`);
  if (!t.blind?.referencePasses || !t.blind?.discriminates) out.push("blind tests: reference must pass and the start must fail");
  if (t.adversarial?.verdict !== "accept") out.push(`adversarial verdict ${t.adversarial?.verdict}`);
  if (/-v\d+$/.test(id) && !(t.remedyCheck?.length && t.remedyCheck.every(r => r.hiddenAccepts === false))) out.push("remedy check: every adjudicated violation of the earlier versions must be rejected by the hidden tests");
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { private: { type: "string" }, "dry-run": { type: "boolean", default: false } } });
  const root = resolve(values.private ?? "/home/arthur/Code/agent_workflow/runs/eval-loop-confirmatory-1");
  const pool = join(root, "pool"), reviews = join(root, "reviews-v2");
  const ids = readdirSync(join(pool, "calibration-staged")).filter(n => existsSync(join(pool, "calibration-staged", n, "task.json"))).sort();
  const orig = join(pool, "batches", ORIGINAL.batch);
  const o = verifySeal(orig);
  if (!o.ok || o.seal.digest !== ORIGINAL.seal) { process.stderr.write("original calibration batch seal changed: refusing\n"); process.exit(2); }
  const problems = ids.flatMap(id => correctedProblems({ id, dir: join(pool, "calibration-staged", id), reviews }).map(p => `${id}: ${p}`));
  if (values["dry-run"] || problems.length) { process.stdout.write(`${JSON.stringify({ ids, problems, dryRun: values["dry-run"] })}\n`); process.exit(problems.length ? 2 : 0); }
  const cfg = JSON.parse(readFileSync(new URL("./supply-calibration.json", import.meta.url), "utf8"));
  const sealed = sealCalibrationBatch({ pool, ids, cfg: { ...cfg, purpose: "calibration-corrected-v2" }, checks: (id, dir) => correctedProblems({ id, dir, reviews }) });
  if (sealed.blocked) { process.stdout.write(`${JSON.stringify(sealed)}\n`); process.exit(2); }
  const exclusionsV1 = join(root, "calibration", "exclusions-v1.json");
  const exclusionsV2 = join(root, "calibration", "exclusions-v2-corrected.json");
  atomicWriteJson(exclusionsV2, { schema: "pi-eval-loop/calibration-exclusions@1", version: 2, registeredAt: new Date().toISOString(), targetModelResultsObserved: false, batchSeal: sealed.seal, rule: "same rule as exclusions-v1 (invalid triage classes exclude a task before dispatch); every corrected version passed its triage and remedy check, so nothing is excluded", exclusions: [] });
  const plan = {
    schema: "pi-eval-loop/calibration-plan-frozen@1", frozenAt: new Date().toISOString(), targetModelResultsObserved: false,
    purpose: "difficulty calibration only (never a holdout, adoption or confirmation)",
    harness: { id: "stable", kind: "orche", commit: "e831a6b2bc19f0c707b55505db33a11b2c9d4d4a" }, route: "cliproxyapi/gpt-6-luna (effort medium)", rule: RULE,
    batches: [
      { batch: ORIGINAL.batch, seal: ORIGINAL.seal, exclusions: { file: exclusionsV1, sha256: sha256(readFileSync(exclusionsV1)) }, measured: "the 6 tasks not excluded (4 excluded before dispatch: grader defects)" },
      { batch: sealed.batch, seal: sealed.seal, exclusions: { file: exclusionsV2, sha256: sha256(readFileSync(exclusionsV2)) }, measured: `all ${sealed.tasks.length} corrected versions`, tasks: sealed.tasks },
    ],
    analysis: "one calibration report per batch (src/calibration.mjs buildCalibrationReport, declared-tier levels, hard iff >= minTasksPerLevel tasks and mean success <= hardMaxRate); infrastructure/harness failures are censored (infra-excluded@1) and reported as unit classes, never as difficulty; the corrected batch carries the three declared-hard tasks, the original batch the easy/medium ones. Results of the excluded originals are never collected.",
    budget: { ledger: join(root, "budget", "target-model-requests.jsonl"), limit: 4500, accounting: "actual provider attempts admitted by the isolated runtime's outbound gate; unit reservations 150 x 2 before dispatch" },
  };
  atomicWriteJson(join(root, "calibration", "plan-v2.json"), plan);
  process.stdout.write(`${JSON.stringify({ sealed: { batch: sealed.batch, seal: sealed.seal, tasks: sealed.tasks, families: sealed.families }, plan: join(root, "calibration", "plan-v2.json") })}\n`);
}
