#!/usr/bin/env node
// ctrl-confirm-2 preregistered analysis (PREREGISTRATION.md §6-§8). Reads the state's ledger and frozen queue; writes analysis.json
// and analysis.md next to them. Refuses a damaged ledger; scores the COMPLETE design (missing units = failures, reported).
//   node pi-eval-loop/experiments/ctrl-confirm-2/analyze.mjs --state DIR
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Ledger } from "../../src/util.mjs";
import { INFRA } from "../ctrl-ablation/lib.mjs";
import { adoption, armSummary, designTable, familyContrast, functionalOf, holm, legacyValid, loadPrereg, primaryDecision, rateOf, strictValid } from "./lib.mjs";

const PRIMARY = ["OCR", "OC"];
const SECONDARY = [["OCR", "PCR"], ["PCR", "PC"], ["OC", "PC"]];
const CRITICAL = new Set(["harness_crash", "route_violation"]);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const n = (xs) => (Array.isArray(xs) ? xs.length : 0);

export function finalRecords(stateDir) {
  const ledger = new Ledger(join(stateDir, "runs.jsonl"));
  const bad = ledger.verify();
  if (bad.length) throw new Error(`ledger damaged: ${bad.join("; ")}`);
  const last = new Map();
  for (const e of ledger.records()) if (e.type === "result") last.set(e.unit_key, e.record);
  return [...last.values()];
}

/** @param {any[]} records @param {any} prereg @param {{ tasks: string[], familyOf: Record<string, string>, draws?: number, perms?: number }} options */
export function analyze(records, prereg, { tasks, familyOf, draws = 10000, perms = 20000 }) {
  const arms = prereg.arms.map(a => a.id), repeats = prereg.repeats;
  const design = { arms, tasks, repeats };
  const legacy = designTable(records, legacyValid, design), strict = designTable(records, strictValid, design), functional = designTable(records, functionalOf, design);
  const complete = legacy.missing.length === 0;
  const summary = {};
  for (const arm of arms) {
    const rs = records.filter(r => r.candidate_id === arm);
    summary[arm] = {
      units: rs.length, legacy: armSummary(legacy.table[arm]), strict: armSummary(strict.table[arm]), functional: armSummary(functional.table[arm]),
      legacyFail: rs.filter(r => n(r.integrity?.legacyViolations) > 0).length, strictFail: rs.filter(r => n(r.integrity?.strictTestViolations) > 0).length,
      strictOnly: rs.filter(r => n(r.integrity?.strictTestViolations) > 0 && n(r.integrity?.legacyViolations) === 0).length,
      leaks: rs.filter(r => n(r.integrity?.leakHits) > 0).length, critical: rs.filter(r => CRITICAL.has(r.terminal_status)).length,
      terminal: rs.reduce((m, r) => ({ ...m, [r.terminal_status]: (m[r.terminal_status] ?? 0) + 1 }), {}), infra: rs.filter(r => INFRA.has(r.terminal_status)).length,
      requests: sum(rs.map(r => r.model_requests ?? 0)), inputTokens: sum(rs.map(r => r.input_tokens ?? 0)), outputTokens: sum(rs.map(r => r.output_tokens ?? 0)), cacheTokens: sum(rs.map(r => r.cache_tokens ?? 0)),
      wallHours: sum(rs.map(r => (r.wall_time ?? 0) / 3600_000)), atRequestCeiling: rs.filter(r => (r.model_requests ?? 0) >= prereg.unit.maxRequests).length,
    };
  }
  const c = (a, b, table, tag) => familyContrast(table[a], table[b], familyOf, { draws, perms, seed: `${prereg.seed}:${tag}:${a}-${b}` });
  const primary = { legacy: c(...PRIMARY, legacy.table, "legacy"), strict: c(...PRIMARY, strict.table, "strict"), functional: c(...PRIMARY, functional.table, "functional") };
  const decision = primaryDecision(primary.legacy, { complete });
  const secondary = {};
  const ps = {};
  for (const [a, b] of SECONDARY) {
    const k = `${a}-${b}`;
    secondary[k] = { legacy: c(a, b, legacy.table, "legacy"), strict: c(a, b, strict.table, "strict"), functional: c(a, b, functional.table, "functional") };
    ps[`${k}:E1`] = secondary[k].legacy.rate.pTwoSided; ps[`${k}:E2`] = secondary[k].legacy.reliable.pTwoSided;
  }
  const holmSecondary = holm(ps);
  const interaction = mean(tasks.map(t => (rateOf(legacy.table.OCR[t]) - rateOf(legacy.table.OC[t])) - (rateOf(legacy.table.PCR[t]) - rateOf(legacy.table.PC[t]))));
  const families = {};
  for (const t of tasks) { const f = (families[familyOf[t]] ??= {}); for (const a of arms) { const x = (f[a] ??= { tasks: 0, units: 0, valid: 0 }); x.tasks++; x.units += legacy.table[a][t].length; x.valid += sum(legacy.table[a][t]); } }
  const familyRegressions = Object.entries(families).filter(([, f]) => f.OCR.valid / f.OCR.units < f.OC.valid / f.OC.units).map(([k]) => k).sort();
  const verdict = adoption({ decision, candidate: summary.OCR, control: summary.OC, familyRegressions, functionalDelta: primary.functional.rate.estimate });
  // Sensitivity: infrastructure-only units (zero completed model calls) excluded, design re-scored on what remains (descriptive).
  const noInfra = records.filter(r => !(INFRA.has(r.terminal_status) && (r.model_requests_completed ?? 0) === 0));
  const sens = designTable(noInfra, legacyValid, design);
  return {
    units: records.length, design: { ...design, scheduled: arms.length * tasks.length * repeats }, complete, missing: legacy.missing,
    summary, primary, decision, verdict, secondary, holmSecondary, interaction, families, familyRegressions,
    sensitivityNoInfra: { excluded: records.length - noInfra.length, primary: familyContrast(sens.table.OCR, sens.table.OC, familyOf, { draws: 2000, perms: 2000, seed: `${prereg.seed}:sens` }) },
    perTask: legacy.table, perTaskStrict: strict.table,
  };
}
const mean = (xs) => sum(xs) / xs.length;
const pp = (x) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)}`;
const ci = (e) => `${pp(e.estimate)} [${pp(e.ci95[0])}, ${pp(e.ci95[1])}]`;

export function markdown(a, prereg) {
  const L = [`# ${prereg.id} analysis (preregistered)`, "", `Units: ${a.units} of ${a.design.scheduled} scheduled (${a.design.arms.length} arms x ${a.design.tasks.length} tasks x ${a.design.repeats}); complete: ${a.complete}${a.missing.length ? ` (missing ${a.missing.length}, scored as failures)` : ""}.`, "",
    `**Primary (OCR - OC, legacy-valid): ${a.decision.verdict}** — ${a.decision.why}. Adoption status: **${a.verdict.verdict}** — ${a.verdict.why}.`, "",
    "## Arms", "", "| arm | legacy-valid units | E1 rate | E2 reliable tasks | 0/r tasks | strict-valid units | strict E2 | functional units | legacy fail | strict fail (strict-only) | leak | critical | infra | requests | wall h |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const [arm, s] of Object.entries(a.summary)) L.push(`| ${arm} | ${s.legacy.successes}/${s.legacy.units} | ${(100 * s.legacy.rate).toFixed(1)} | ${s.legacy.reliableTasks}/${s.legacy.tasks} | ${s.legacy.noneTasks} | ${s.strict.successes} | ${s.strict.reliableTasks} | ${s.functional.successes} | ${s.legacyFail} | ${s.strictFail} (${s.strictOnly}) | ${s.leaks} | ${s.critical} | ${s.infra} | ${s.requests} | ${s.wallHours.toFixed(1)} |`);
  L.push("", "## Contrasts (pt; family-cluster bootstrap 95% CI; sign-flip p one-sided / two-sided)", "", "| contrast | scoring | E1 rate | p1 / p2 | E2 reliable | p1 / p2 | tasks +/- (E1) |", "|---|---|---|---|---|---|---|");
  const row = (name, k, e) => L.push(`| ${name} | ${k} | ${ci(e.rate)} | ${e.rate.pOneSided.toFixed(4)} / ${e.rate.pTwoSided.toFixed(4)} | ${ci(e.reliable)} | ${e.reliable.pOneSided.toFixed(4)} / ${e.reliable.pTwoSided.toFixed(4)} | ${e.rate.better}/${e.rate.worse} |`);
  for (const k of ["legacy", "strict", "functional"]) row("OCR-OC (primary)", k, a.primary[k]);
  for (const [name, s] of Object.entries(a.secondary)) for (const k of ["legacy", "strict", "functional"]) row(name, k, s[k]);
  L.push("", `Holm (secondary, legacy, 6 tests): ${Object.entries(a.holmSecondary).map(([k, v]) => `${k} ${v.toFixed(4)}`).join("; ")}. Interaction (OCR-OC)-(PCR-PC) on E1: ${pp(a.interaction)} pt (descriptive).`);
  L.push(`Sensitivity without infra-only units (${a.sensitivityNoInfra.excluded} excluded): OCR-OC E1 ${ci(a.sensitivityNoInfra.primary.rate)}, E2 ${ci(a.sensitivityNoInfra.primary.reliable)}.`);
  L.push("", `## Families (legacy-valid units / units); regressions OCR < OC: ${a.familyRegressions.join(", ") || "none"}`, "", `| family | tasks | ${a.design.arms.join(" | ")} |`, `|---|---|${a.design.arms.map(() => "---").join("|")}|`);
  for (const [f, by] of Object.entries(a.families).sort()) L.push(`| ${f} | ${by.OC.tasks} | ${a.design.arms.map(x => `${by[x].valid}/${by[x].units}`).join(" | ")} |`);
  L.push("", "## Per task legacy-valid outcomes (repeat order)", "", `| task | ${a.design.arms.join(" | ")} |`, `|---|${a.design.arms.map(() => "---").join("|")}|`);
  for (const t of a.design.tasks) L.push(`| ${t} | ${a.design.arms.map(x => a.perTask[x][t].join("")).join(" | ")} |`);
  return `${L.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, prereg: { type: "string" } } });
  const stateDir = resolve(values.state);
  const prereg = loadPrereg(values.prereg);
  const lock = JSON.parse(readFileSync(join(stateDir, "lock.json"), "utf8"));
  if (lock.preregDigest !== (await import("../../src/util.mjs")).digestOf(prereg)) throw new Error("prereg differs from the state's lock");
  const queue = JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8"));
  const tasks = [...new Set(queue.map(u => u.task))].sort();
  const records = finalRecords(stateDir);
  // Families come from the sealed dataset (a task without any record still has its family); records only fill smoke states.
  const familyOf = Object.fromEntries(records.map(r => [r.task_id, r.family]));
  if (!lock.smoke && prereg.holdout.dir) { const { loadLocal } = await import("../../src/datasets.mjs"); const { UMBRELLA } = await import("../../src/protocol.mjs"); for (const t of loadLocal(resolve(UMBRELLA, prereg.holdout.dir))) familyOf[t.id] = t.family; }
  for (const t of tasks) if (!familyOf[t]) throw new Error(`no family for ${t} (no record)`);
  const a = analyze(records, lock.smoke ? { ...prereg, repeats: prereg.smoke.repeats } : prereg, { tasks, familyOf });
  writeFileSync(join(stateDir, "analysis.json"), `${JSON.stringify(a, null, 2)}\n`);
  writeFileSync(join(stateDir, "analysis.md"), markdown(a, prereg));
  process.stdout.write(markdown(a, prereg));
}
