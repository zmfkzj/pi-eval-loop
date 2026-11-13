#!/usr/bin/env node
// Fresh holdout batch of exploratory-1 (2026-11-07; model-free). The implementation is src/lineage.mjs (shared with the recurring
// route src/explore-cycle.mjs); this file keeps the study's lineage sources as defaults and its CLI.
//
//   node studies/exploratory-1/select-supply.mjs --pool DIR --screen-plan FILE --out FILE [--dry-run]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as lineage from "../../src/lineage.mjs";

export { BATCH_RULE, RULE_TEXT, exercismProblem, readRegistry, lineageHits, minimaOfExplore } from "../../src/lineage.mjs";

export const SOURCES = {
  registries: ["/home/arthur/Code/agent_workflow/runs/eval-loop-supply/registry.jsonl", ...[0, 1, 2, 3].map(i => `/home/arthur/Code/oh-my-pi-extensions/results/ctrl-confirm-2-supply/pool-${i}/registry.jsonl`)],
  datasets: ["/home/arthur/Code/oh-my-pi-extensions/results/ctrl-confirm-2-holdout/ctrl-confirm-2-holdout-3e83b1b2af67", "/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/datasets/holdout-v1", "/home/arthur/Code/pi-eval-loop/datasets/holdout-v1"],
};

export const forbiddenSet = (o) => lineage.forbiddenSet({ sources: SOURCES, ...o });
export const selectAndSeal = (o) => lineage.selectAndSeal({ sources: SOURCES, ...o });

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { pool: { type: "string" }, "screen-plan": { type: "string" }, out: { type: "string" }, "dry-run": { type: "boolean", default: false } } });
  const pool = resolve(values.pool);
  const screenPlan = JSON.parse(readFileSync(values["screen-plan"], "utf8"));
  if (values["dry-run"]) {
    const forbidden = forbiddenSet({ pool, screenPlan });
    const { sealable, hits } = lineage.lineageHits(pool, forbidden);
    process.stdout.write(`${JSON.stringify({ forbiddenKeys: forbidden.size, withdraw: hits, sealable: sealable.filter(r => !hits.some(h => h.caseId === r.caseId)).map(r => `${r.caseId} ${r.family} ${r.tier} ${r.difficultyBasis ?? ""}`) }, null, 1)}\n`);
    process.exit(0);
  }
  const r = selectAndSeal({ pool, screenPlan, screenPlanPath: resolve(values["screen-plan"]), out: values.out });
  process.stdout.write(`${JSON.stringify({ withdrawn: r.withdrawn.length, ruleSha256: r.ruleSha256, sealed: r.sealed, result: r.result })}\n`);
  process.exit(r.sealed.blocked ? 2 : 0);
}
