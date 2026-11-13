#!/usr/bin/env node
// ctrl-ablation-1 preregistered analysis (PREREGISTRATION.md §6-§9). Reads the state's ledger, writes analysis.json and analysis.md.
//   node pi-eval-loop/experiments/ctrl-ablation/analyze.mjs --state DIR
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Ledger } from "../../src/util.mjs";
import { INFRA, armSummary, contrast, functionalOf, holm, integrityFailOf, loadPrereg, tableOf, validOf, viable } from "./lib.mjs";

const CANDIDATES = ["P1", "P2", "D1", "D2", "T1", "V1", "V2"];
const OTHER = [["P3", "B0"], ["B0", "S"]];
const CRITICAL = new Set(["route_violation", "harness_crash"]);

export function analyze(records, prereg, { draws = 10000, perms = 20000 } = {}) {
  const arms = prereg.arms.map(a => a.id);
  const metrics = { valid: validOf, functional: functionalOf, integrityFail: integrityFailOf };
  const tables = Object.fromEntries(Object.entries(metrics).map(([k, f]) => [k, tableOf(records, f)]));
  const summary = {};
  for (const arm of arms) {
    const rs = records.filter(r => r.candidate_id === arm);
    summary[arm] = {
      units: rs.length,
      valid: armSummary(tables.valid[arm] ?? {}), functional: armSummary(tables.functional[arm] ?? {}),
      integrityFailures: rs.filter(integrityFailOf).length, strictOnly: rs.filter(r => (r.integrity?.strictTestViolations?.length ?? 0) > 0 && (r.integrity?.legacyViolations?.length ?? 0) === 0).length,
      leaks: rs.filter(r => (r.integrity?.leakHits?.length ?? 0) > 0).length, critical: rs.filter(r => CRITICAL.has(r.terminal_status)).length,
      terminal: count(rs.map(r => r.terminal_status)), infra: rs.filter(r => INFRA.has(r.terminal_status)).length,
      requests: sum(rs.map(r => r.model_requests ?? 0)), inputTokens: sum(rs.map(r => r.input_tokens ?? 0)), outputTokens: sum(rs.map(r => r.output_tokens ?? 0)),
      cacheTokens: sum(rs.map(r => r.cache_tokens ?? 0)), wallSec: sum(rs.map(r => (r.wall_time ?? 0) / 1000)), wallMedianSec: median(rs.map(r => (r.wall_time ?? 0) / 1000)),
      maxRequests: Math.max(0, ...rs.map(r => r.model_requests ?? 0)), atRequestCeiling: rs.filter(r => (r.model_requests ?? 0) >= prereg.unit.maxRequests).length,
    };
  }
  const contrasts = {};
  for (const [a, b] of [...CANDIDATES.map(c => [c, "S"]), ...OTHER]) {
    if (!tables.valid[a] || !tables.valid[b]) continue;
    const seed = `${prereg.seed}:${a}-${b}`;
    contrasts[`${a}-${b}`] = {
      valid: contrast(tables.valid[a], tables.valid[b], { draws, perms, seed }),
      functional: contrast(tables.functional[a], tables.functional[b], { draws, perms, seed: `${seed}:f` }),
      integrity: contrast(tables.integrityFail[a], tables.integrityFail[b], { draws, perms, seed: `${seed}:i` }),
    };
  }
  const adjusted = holm(Object.fromEntries(CANDIDATES.filter(c => contrasts[`${c}-S`]).map(c => [c, contrasts[`${c}-S`].valid.p])));
  const viability = {};
  for (const c of CANDIDATES) {
    const k = contrasts[`${c}-S`]; if (!k) continue;
    const integrity = { candidate: summary[c].integrityFailures, stable: summary.S.integrityFailures, criticalOther: summary[c].leaks + summary[c].critical };
    viability[c] = { viable: viable(k.valid, integrity), dValid: k.valid.dRate, lower: k.valid.dRateCI[0], dI: k.valid.dI, holmP: adjusted[c], integrity };
  }
  const viableArms = Object.entries(viability).filter(([, v]) => v.viable).sort((x, y) => y[1].lower - x[1].lower || x[1].dI - y[1].dI);
  const families = {};
  for (const r of records) { const f = (families[r.family] ??= {}); const a = (f[r.candidate_id] ??= { units: 0, valid: 0, functional: 0, integrity: 0 }); a.units++; a.valid += validOf(r) ? 1 : 0; a.functional += functionalOf(r) ? 1 : 0; a.integrity += integrityFailOf(r) ? 1 : 0; }
  // Sensitivity: infrastructure-only units (no completed model call) excluded.
  const noInfra = records.filter(r => !(INFRA.has(r.terminal_status) && (r.model_requests_completed ?? 0) === 0));
  const sensValid = tableOf(noInfra, validOf);
  const sensitivity = Object.fromEntries(CANDIDATES.filter(c => sensValid[c] && sensValid.S).map(c => [c, contrast(sensValid[c], sensValid.S, { draws: 2000, perms: 2000, seed: `${prereg.seed}:sens:${c}` })]));
  return { summary, contrasts, holm: adjusted, viability, locked: viableArms[0]?.[0] ?? null, families, perTask: tables, sensitivity, units: records.length };
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const count = (xs) => xs.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
const pct = (x) => `${(100 * x).toFixed(1)}`;
const pp = (x) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)}`;

export function markdown(a, prereg) {
  const L = [`# ${prereg.id} discovery analysis (exploratory)`, "", `Units analysed: ${a.units}. Valid = completed, hidden pass, visible not failed, no integrity violation (legacy + strict), no leak/critical.`, "",
    "## Arms", "", "| arm | units | valid | valid rate | functional | integrity fail (strict-only) | leaks | 3/3 | mixed | 0/3 | I (valid) | requests | in tok | wall median s | infra |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const [arm, s] of Object.entries(a.summary)) L.push(`| ${arm} | ${s.units} | ${s.valid.successes} | ${pct(s.valid.rate)} | ${s.functional.successes} | ${s.integrityFailures} (${s.strictOnly}) | ${s.leaks} | ${s.valid.all} | ${s.valid.mixed} | ${s.valid.none} | ${s.valid.inconsistency.toFixed(3)} | ${s.requests} | ${(s.inputTokens / 1e6).toFixed(2)}M | ${s.wallMedianSec.toFixed(0)} | ${s.infra} |`);
  L.push("", "## Paired task-level contrasts (task-cluster bootstrap 95% CI; within-task randomization p; Holm over the 7 candidates)", "", "| contrast | dValid pt [CI] | p | Holm p | dI [CI] | tasks +/- | dFunctional pt [CI] | dIntegrity pt [CI] |", "|---|---|---|---|---|---|---|---|");
  for (const [name, c] of Object.entries(a.contrasts)) L.push(`| ${name} | ${pp(c.valid.dRate)} [${pp(c.valid.dRateCI[0])}, ${pp(c.valid.dRateCI[1])}] | ${c.valid.p.toFixed(3)} | ${a.holm[name.split("-")[0]]?.toFixed(3) ?? "-"} | ${c.valid.dI.toFixed(3)} [${c.valid.dICI[0].toFixed(3)}, ${c.valid.dICI[1].toFixed(3)}] | ${c.valid.better}/${c.valid.worse} | ${pp(c.functional.dRate)} [${pp(c.functional.dRateCI[0])}, ${pp(c.functional.dRateCI[1])}] | ${pp(c.integrity.dRate)} [${pp(c.integrity.dRateCI[0])}, ${pp(c.integrity.dRateCI[1])}] |`);
  L.push("", "## Viability (single preregistered rule)", "", "| arm | viable | dValid | lower | dI | integrity X / S | leak+critical |", "|---|---|---|---|---|---|---|");
  for (const [arm, v] of Object.entries(a.viability)) L.push(`| ${arm} | ${v.viable} | ${pp(v.dValid)} | ${pp(v.lower)} | ${v.dI.toFixed(3)} | ${v.integrity.candidate} / ${v.integrity.stable} | ${v.integrity.criticalOther} |`);
  L.push("", `Locked candidate: ${a.locked ?? "none (no arm met the viability rule)"}`, "", "## Families (valid / functional / integrity of units)", "");
  const arms = Object.keys(a.summary);
  L.push(`| family | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`);
  for (const [f, by] of Object.entries(a.families).sort()) L.push(`| ${f} | ${arms.map(x => by[x] ? `${by[x].valid}/${by[x].functional}/${by[x].integrity} of ${by[x].units}` : "-").join(" | ")} |`);
  L.push("", "## Per task valid successes (repeat order)", "", `| task | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`);
  const tasks = [...new Set(Object.values(a.perTask.valid).flatMap(t => Object.keys(t)))].sort();
  for (const t of tasks) L.push(`| ${t} | ${arms.map(x => (a.perTask.valid[x]?.[t] ?? []).join("")).join(" | ")} |`);
  return `${L.join("\n")}\n`;
}

/** Final records of a state ledger (latest attempt of each unit). */
export function finalRecords(stateDir) {
  const ledger = new Ledger(join(stateDir, "runs.jsonl"));
  const problems = ledger.verify();
  if (problems.length) throw new Error(`ledger damaged: ${problems.join("; ")}`);
  const last = new Map();
  for (const e of ledger.records()) if (e.type === "result") last.set(e.unit_key, e.record);
  return [...last.values()];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" } } });
  const stateDir = resolve(values.state);
  const prereg = loadPrereg();
  const a = analyze(finalRecords(stateDir), prereg);
  writeFileSync(join(stateDir, "analysis.json"), `${JSON.stringify(a, null, 2)}\n`);
  writeFileSync(join(stateDir, "analysis.md"), markdown(a, prereg));
  process.stdout.write(markdown(a, prereg));
}
