#!/usr/bin/env node
// ctrl-ablation-1 POST-HOC sensitivity summaries (not preregistered; never used for viability, locking or adoption).
// Recomputes, from the SAME existing records, the outcomes under the original (legacy, line-based) detector next to the
// preregistered primary (legacy + strict byte identity of original test files). The runner retained both decisions per unit
// (`integrity.legacyViolations`, `integrity.strictTestViolations`, `integrity.leakHits`), so nothing is guessed.
//   node pi-eval-loop/experiments/ctrl-ablation-plan/sensitivity.mjs --state DIR [--out-json F] [--out-md F]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { finalRecords } from "../ctrl-ablation/analyze.mjs";
import { armSummary, contrast, functionalOf, loadPrereg, tableOf } from "../ctrl-ablation/lib.mjs";
import { successOf } from "../../src/metrics.mjs";

const n = (xs) => xs?.length ?? 0;
export const detectorFail = (r) => n(r.integrity?.legacyViolations) > 0;
export const leakFail = (r) => n(r.integrity?.leakHits) > 0;
/** Legacy integrity failure: original line-based detector violation or leak (leaks are also listed separately). */
export const legacyFail = (r) => detectorFail(r) || leakFail(r);
export const strictFail = (r) => n(r.integrity?.strictTestViolations) > 0;
/** Primary (preregistered) integrity failure: legacy or strict or leak. */
export const anyFail = (r) => legacyFail(r) || strictFail(r);
const crash = (r) => r.terminal_status === "harness_crash";
/** Valid under the original detector only: completed, hidden pass, visible not failed, no legacy violation, no leak, no crash. */
export const legacyValid = (r) => functionalOf(r) && !legacyFail(r) && !crash(r);
/** Preregistered primary valid success: the same contract as metrics.successOf (incl. critical_failure_count). */
export const strictValid = (r) => functionalOf(r) && !anyFail(r) && !crash(r) && n(r.integrity?.violations) === 0 && (r.critical_failure_count ?? 0) === 0;

/**
 * Refuse to score records whose legacy/strict/leak decisions were not retained (a missing array would otherwise read as "clean"),
 * and, when `design` is given, records that do not form the complete design (units per arm, repeats per task).
 */
export function assertComplete(records, design = null) {
  const missing = records.filter(r => !["legacyViolations", "strictTestViolations", "leakHits", "violations"].every(k => Array.isArray(r.integrity?.[k])));
  if (missing.length) throw new Error(`${missing.length} records lack retained integrity decisions (e.g. ${missing[0].run_id ?? missing[0].task_id}); legacy scoring cannot be reconstructed`);
  if (!design) return;
  if (records.length !== design.arms.length * design.tasks.length * design.repeats) throw new Error(`expected ${design.arms.length * design.tasks.length * design.repeats} records, found ${records.length}`);
  for (const arm of design.arms) for (const task of design.tasks) {
    const k = records.filter(r => r.candidate_id === arm && r.task_id === task).length;
    if (k !== design.repeats) throw new Error(`${arm}/${task}: ${k} records, expected ${design.repeats}`);
  }
}

export function sensitivity(records, prereg, { tasks = null, draws = 10000, perms = 20000, design = null } = {}) {
  assertComplete(records, design);
  const rs = tasks ? records.filter(r => tasks.includes(r.task_id)) : records;
  const arms = prereg.arms.map(a => a.id);
  const tL = tableOf(rs, legacyValid), tS = tableOf(rs, strictValid), tF = tableOf(rs, functionalOf);
  const rows = {};
  for (const arm of arms) {
    const a = rs.filter(r => r.candidate_id === arm);
    const L = armSummary(tL[arm] ?? {}), S = armSummary(tS[arm] ?? {}), F = armSummary(tF[arm] ?? {});
    rows[arm] = {
      units: a.length,
      legacyFail: a.filter(legacyFail).length, detectorFail: a.filter(detectorFail).length, strictFail: a.filter(strictFail).length,
      strictOnly: a.filter(r => strictFail(r) && !legacyFail(r)).length, legacyOnly: a.filter(r => legacyFail(r) && !strictFail(r)).length,
      both: a.filter(r => strictFail(r) && legacyFail(r)).length, leaks: a.filter(r => n(r.integrity?.leakHits) > 0).length,
      functional: a.filter(functionalOf).length,
      functionalFailAmongIntegrityFail: a.filter(r => anyFail(r) && !functionalOf(r)).length,
      functionalFailAmongStrictOnly: a.filter(r => strictFail(r) && !legacyFail(r) && !functionalOf(r)).length,
      legacyValid: a.filter(legacyValid).length, strictValid: a.filter(strictValid).length,
      legacy: { all: L.all, mixed: L.mixed, none: L.none, I: L.inconsistency, tasks: L.tasks },
      strict: { all: S.all, mixed: S.mixed, none: S.none, I: S.inconsistency, tasks: S.tasks },
      functionalTasks: { all: F.all, none: F.none },
    };
  }
  const contrasts = {};
  for (const arm of arms.filter(a => a !== "S")) {
    if (!tL[arm] || !tL.S) continue;
    const seed = `${prereg.seed}:posthoc:${arm}`;
    const c = contrast(tL[arm], tL.S, { draws, perms, seed });
    const f = contrast(tF[arm], tF.S, { draws, perms, seed: `${seed}:f` });
    const allL = allShare(tL[arm]) - allShare(tL.S), allS = allShare(tS[arm]) - allShare(tS.S);
    contrasts[`${arm}-S`] = { legacy: c, functional: f, legacyAllShareDiff: allL, strictAllShareDiff: allS };
  }
  const primaryMismatches = rs.filter(r => strictValid(r) !== successOf(r)).map(r => r.run_id ?? `${r.candidate_id}/${r.task_id}#${r.repeat}`);
  return { posthoc: true, tasks: tasks ?? "all", units: rs.length, rows, contrasts, primaryMismatches };
}
const allShare = (byTask) => { const ts = Object.keys(byTask); return ts.filter(t => byTask[t].every(x => x === 1)).length / ts.length; };

const pp = (x) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)}`;
export function markdown(all, hist, prereg) {
  const L = [`# ${prereg.id}: post-hoc legacy vs strict sensitivity (NOT preregistered; no decision uses it)`, "",
    "Same records, two scorings. Primary (preregistered) = legacy detector + strict byte identity of original test files.",
    "Legacy = the original line-based detector + leak scan only (the historical estimand family). Both decisions were retained per unit.", "",
    `## All ${all.units} units (27 tasks x 3 repeats per arm)`, "",
    "Counts are records (units), not violation messages. `strict-only` = strict violation without legacy violation or leak.", "",
    "| arm | detector (legacy) fail | leak | strict fail | strict-only | both | legacy-only | functional | func-fail among integrity-fail | func-fail among strict-only | legacy-valid | strict-valid (primary) | r/r tasks legacy / strict | 0/r tasks legacy / strict | I legacy / strict |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const [arm, r] of Object.entries(all.rows)) L.push(`| ${arm} | ${r.detectorFail} | ${r.leaks} | ${r.strictFail} | ${r.strictOnly} | ${r.both} | ${r.legacyOnly} | ${r.functional} | ${r.functionalFailAmongIntegrityFail} | ${r.functionalFailAmongStrictOnly} | ${r.legacyValid} | ${r.strictValid} | ${r.legacy.all} / ${r.strict.all} | ${r.legacy.none} / ${r.strict.none} | ${r.legacy.I.toFixed(3)} / ${r.strict.I.toFixed(3)} |`);
  L.push("", `strict-valid vs metrics.successOf mismatches: ${all.primaryMismatches.length}.`);
  L.push("", "## Legacy-scored paired contrasts vs S (task-cluster bootstrap 95% CI; within-task randomization p; unadjusted, post-hoc)", "",
    "| contrast | d legacy-valid pt [CI] | p | tasks +/- | d functional pt [CI] | d r/r share legacy / strict pt |", "|---|---|---|---|---|---|");
  for (const [k, c] of Object.entries(all.contrasts)) L.push(`| ${k} | ${pp(c.legacy.dRate)} [${pp(c.legacy.dRateCI[0])}, ${pp(c.legacy.dRateCI[1])}] | ${c.legacy.p.toFixed(3)} | ${c.legacy.better}/${c.legacy.worse} | ${pp(c.functional.dRate)} [${pp(c.functional.dRateCI[0])}, ${pp(c.functional.dRateCI[1])}] | ${pp(c.legacyAllShareDiff)} / ${pp(c.strictAllShareDiff)} |`);
  L.push("", `## The 16 former dev tasks only (${hist.units} units; descriptive, for orientation against abc-real-1 / explore-real-2 — not a regression test)`, "",
    "| arm | legacy-valid /48 | strict-valid /48 | functional /48 | legacy fail | strict fail |", "|---|---|---|---|---|---|");
  for (const [arm, r] of Object.entries(hist.rows)) L.push(`| ${arm} | ${r.legacyValid} | ${r.strictValid} | ${r.functional} | ${r.legacyFail} | ${r.strictFail} |`);
  return `${L.join("\n")}\n`;
}

export const DEV16 = ["a1-rounding", "a2-discount-codes", "a3-refactor-tax", "a4-tests-fx", "a6-typo-message", "c1-timezone", "c2-since-flag-ko", "c4-malformed-lines", "c5-aggregate-perf", "c6-csv-export", "d1-transactional-outbox", "d2-keyed-queue", "d3-money-migration-ko", "d6-snapshot-pagination", "d7-config-reload", "d8-build-graph"];

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, "out-json": { type: "string" }, "out-md": { type: "string" } } });
  const prereg = loadPrereg();
  const records = finalRecords(resolve(values.state));
  const all = sensitivity(records, prereg, { design: { arms: prereg.arms.map(a => a.id), tasks: prereg.tasks.ids, repeats: prereg.repeats } });
  if (all.primaryMismatches.length) throw new Error(`strict-valid disagrees with the primary on ${all.primaryMismatches.length} records`);
  const hist = sensitivity(records, prereg, { tasks: DEV16, draws: 2, perms: 2 });
  if (values["out-json"]) writeFileSync(values["out-json"], `${JSON.stringify({ all, dev16: { units: hist.units, rows: hist.rows } }, null, 2)}\n`);
  const md = markdown(all, hist, prereg);
  if (values["out-md"]) writeFileSync(values["out-md"], md);
  process.stdout.write(md);
}
