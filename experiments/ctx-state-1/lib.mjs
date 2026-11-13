// ctx-state-1: pure helpers of the long-task state-preservation ablation (arms = explicit orche runtime settings on a pinned orche
// commit). Reuses the ctrl-ablation-1 queue, harness export, lock comparison and statistics; adds the config overlay to the
// harness identity so that two arms with different settings never share a unit key. test/ctx-state.test.mjs covers it.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestOf } from "../../src/util.mjs";
import { buildHarness as buildCtrlHarness } from "../ctrl-ablation/lib.mjs";

export { buildQueue, lockMismatches, armSummary, contrast, holm, tableOf, functionalOf, integrityFailOf, validOf, INFRA, mean } from "../ctrl-ablation/lib.mjs";

export const EXPERIMENT_DIR = dirname(fileURLToPath(import.meta.url));
export const loadPrereg = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The orche commit an arm runs on: its own `base` (e.g. the pre-change baseline) or the preregistration's harnessBase. */
export const baseOf = (arm, prereg) => arm.base ?? prereg.harnessBase.commit;

/** Harness identity bound into every unit key: orche commit, mode and the digest of the arm's explicit runtime settings. */
export function harnessIdentity(arm, prereg) {
  const overlay = arm.orcheConfig ? `+cfg:${digestOf(arm.orcheConfig).slice(0, 16)}` : "";
  return `${baseOf(arm, prereg)}:${arm.mode}${overlay}`;
}

/** Export the arm's orche commit into the state directory (ctrl-ablation buildHarness on a per-arm base; no patch). */
export function buildHarness(arm, prereg, { stateDir, orcheDir }) {
  const view = { ...prereg, harnessBase: { ...prereg.harnessBase, commit: baseOf(arm, prereg) } };
  return buildCtrlHarness({ id: arm.id }, view, { stateDir, orcheDir, experimentDir: EXPERIMENT_DIR });
}

/** The harness object the evaluator/runner receives: the overlay becomes the run's explicit orche settings (runner.orcheConfig). */
export function harnessOf(arm, prereg, built) {
  return { id: arm.id, kind: "orche", mode: arm.mode, commit: harnessIdentity(arm, prereg), dir: built.dir, ...(arm.orcheConfig ? { orcheConfig: structuredClone(arm.orcheConfig) } : {}) };
}

/** Files whose bytes define this experiment beyond the loop evaluator (driver, analysis, preregistrations). */
export function experimentFiles(experimentDir = EXPERIMENT_DIR) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (!/\.md$/.test(e.name) || e.name === "PREREGISTRATION.md") out.push(p); } };
  walk(experimentDir);
  return out.sort();
}

/** Per-arm telemetry aggregate of final records (descriptive; never an objective). */
export function telemetrySummary(records) {
  const t = records.map(r => r.telemetry).filter(Boolean);
  const sum = (f) => t.reduce((s, x) => s + (f(x) ?? 0), 0);
  return {
    units: records.length, withTelemetry: t.length,
    compactions: sum(x => x.compaction.count), unitsWithCompaction: t.filter(x => x.compaction.count > 0).length,
    subWorkerCompactions: sum(x => x.compaction.sub_worker_compactions),
    summaryRequestsObserved: sum(x => x.requests.summary_observed), taskRequestsObserved: sum(x => x.requests.task_observed),
    maxInputTokensObserved: t.length ? Math.max(0, ...t.map(x => x.requests.max_input_tokens_observed ?? 0)) : null,
    cancelled: sum(x => x.compaction.cancelled), failed: sum(x => x.compaction.failed), fallbacks: sum(x => x.compaction.fallbacks),
    transcriptReads: sum(x => x.retrieval.transcript_reads), transcriptReadsAfterCompaction: sum(x => x.retrieval.transcript_reads_after_compaction),
    essentialsMissing: [...new Set(t.flatMap(x => x.compaction.essentials_missing ?? []))],
  };
}
