#!/usr/bin/env node
// Derived calibration reports under "infra-integrity-excluded@2" (confirmatory-1, 2026-11-07; model-free, no target call).
//
// The raw reports written by calibrate.mjs (censoring infra-excluded@1) stay byte-identical. This writes, next to each, a derived
// report from the SAME runner ledger with integrity-violating units censored (src/calibration.mjs CENSORING_V2) and
// minValidUnitsPerTask = 2. The @2 rule was registered AFTER the first measurement (it was prompted by easy tasks that passed the
// hidden tests 1.0 yet "failed" on strict integrity), so it is accepted only as a restriction: a level hard under @2 but not
// under @1 is flagged postHocAddition and not used; the derived file records both rule outcomes.
//
//   node studies/confirmatory-1/recalibrate-v2.mjs --state DIR [--state DIR ...]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CENSORING_V2, buildCalibrationReport, outcomesFromLedger, unitClassesFromLedger, verifyCalibrationReport } from "../../src/calibration.mjs";
import { loadLocal } from "../../src/datasets.mjs";
import { sha256 } from "../../src/util.mjs";

export const MIN_VALID_UNITS = 2;

export function deriveV2(statePath) {
  const rawPath = join(statePath, "calibration-report.json");
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  const m = raw.measuredWith;
  const excluded = new Set((raw.rule.exclusions ?? []).map(x => x.task));
  const tasks = loadLocal(raw.batchDir).map(t => t.id).filter(id => !excluded.has(id)).sort();
  const outcomes = outcomesFromLedger(m.ledger, { harnessId: m.harnessId, context: m.context, repeats: m.repeats, tasks, censoring: CENSORING_V2 });
  const report = buildCalibrationReport({ batchDir: raw.batchDir, outcomes, feature: raw.feature, hardMaxRate: raw.rule.hardMaxRate, minTasksPerLevel: raw.rule.minTasksPerLevel, measuredWith: { ...m, ledgerSha256: undefined }, censoring: CENSORING_V2, minValidUnitsPerTask: MIN_VALID_UNITS, unitClasses: unitClassesFromLedger(m.ledger, { harnessId: m.harnessId, context: m.context, repeats: m.repeats, tasks }), exclusions: raw.rule.exclusions ?? [] });
  const v1Hard = raw.rule.hardLevels ?? [];
  const postHocAddition = report.rule.hardLevels.filter(l => !v1Hard.includes(l));
  report.derivation = { from: rawPath, rawSha256: sha256(readFileSync(rawPath)), registered: "2026-11-07, after the first measurement: accepted as a restriction only", v1HardLevels: v1Hard, v2HardLevels: report.rule.hardLevels, postHocAddition, usableHardLevels: report.rule.hardLevels.filter(l => v1Hard.includes(l)) };
  return { report, problems: verifyCalibrationReport(report) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string", multiple: true } } });
  const rows = [];
  for (const s of (values.state ?? []).map(x => resolve(x))) {
    const out = join(s, "calibration-report.derived-v2.json");
    if (existsSync(out)) { rows.push({ state: s, skipped: "derived report exists (never rewritten)" }); continue; }
    const { report, problems } = deriveV2(s);
    writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`, { mode: 0o600 });
    rows.push({ state: s, out, problems, levels: report.levels, derivation: report.derivation, unitClasses: report.unitClasses });
  }
  process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
}
