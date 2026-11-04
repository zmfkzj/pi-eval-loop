// Report generation from the state directory alone (no model calls): report.md + report.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Archive } from "./archive.mjs";
import { finalAttempts, pairsOf, summarize } from "./metrics.mjs";
import { describeArm } from "./stats.mjs";
import { Ledger, atomicWrite, atomicWriteJson, readJson } from "./util.mjs";

const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? "–" : `${(100 * x).toFixed(1)}%`);
const num = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? "–" : Number(x).toFixed(d));
const interval = (v) => v ? `${pct(v.mean)} [${pct(v.lo95)}, ${pct(v.hi95)}]` : "–";

export function buildReport(stateDir) {
  const state = readJson(join(stateDir, "state.json"), null);
  if (!state) return { markdown: `# pi-eval-loop report\n\nNo state in ${stateDir}: the loop has not run here.\n`, json: { empty: true } };
  const lock = readJson(join(stateDir, "protocol.lock.json"), null);
  const datasets = readJson(join(stateDir, "datasets.json"), null);
  const archive = new Archive(stateDir);
  const runsLedger = new Ledger(join(stateDir, "runs.jsonl"));
  const records = runsLedger.records().filter(r => r.type === "result").map(r => r.record);
  const finals = finalAttempts(records);
  const simulated = finals.some(r => r.simulated);
  const draws = lock?.protocol?.bootstrap?.draws ?? 10_000;
  const seed = lock?.protocol?.seed ?? "report";
  const arms = [...new Set(finals.map(r => r.candidate_id))].sort();
  const splits = ["train", "dev", "holdout"];
  const meta = datasets?.meta ?? {};
  const armRows = [];
  for (const arm of arms) for (const split of splits) {
    const tasks = [...new Set(finals.filter(r => r.candidate_id === arm && r.split === split).map(r => r.task_id))].sort();
    if (!tasks.length) continue;
    const pairs = pairsOf(records, { a: arm, b: arm, split, tasks, meta }).map(t => ({ ...t, a: t.b }));
    const posterior = describeArm(pairs, { draws, seed: `${seed}:report:${arm}:${split}` });
    armRows.push({ arm, split, posterior, summary: summarize(records, arm, split) });
  }
  const candidates = archive.all();
  const history = new Ledger(join(stateDir, "stable-history.jsonl")).records();
  const proposerUsage = candidates.reduce((s, c) => ({ requests: s.requests + (c.proposer?.usage?.requests ?? 0), input: s.input + (c.proposer?.usage?.input ?? 0), output: s.output + (c.proposer?.usage?.output ?? 0) }), { requests: 0, input: 0, output: 0 });
  const integrity = { runsLedger: runsLedger.verify(), events: new Ledger(join(stateDir, "events.jsonl")).verify() };
  const json = { generatedAt: new Date().toISOString(), stateDir, simulated, phase: state.phase, cycle: state.cycle, strategy: state.strategy, protocolDigest: lock?.protocolDigest, protocol: lock?.protocol, prerequisites: state.prerequisites, blocked: state.blocked, datasets, arms: armRows, candidates, front: archive.front(), selection: state.selection, final: state.final, searchStop: state.searchStop, counters: state.counters, deployHistory: history, proposerUsage, ledgerIntegrity: integrity, runs: finals.length };

  const L = [];
  L.push("# pi-eval-loop report", "");
  if (simulated) L.push("> **SIMULATED RUNS PRESENT.** Records marked `simulated` come from a test backend or the faux upstream; they are pipeline checks, not performance measurements.", "");
  L.push(`Generated ${json.generatedAt}. State: \`${stateDir}\`. Phase **${state.phase}**, cycle ${state.cycle}, strategy \`${state.strategy}\`.`, "");
  if (state.blocked) L.push(`**BLOCKED:** ${state.blocked.reason}`, ...(state.blocked.missing ?? []).map(m => `- missing: ${m.name} — ${m.detail}`), ...(state.blocked.problems ?? []).map(p => `- ${p}`), "");
  if (lock) L.push(`Protocol \`${lock.protocol.version}\` digest \`${lock.protocolDigest.slice(0, 16)}\`, locked ${lock.lockedAt}; seed \`${lock.protocol.seed}\`; agent route \`${lock.protocol.route.provider}/${lock.protocol.route.model}\` effort \`${lock.protocol.route.effort}\` (all arms); bootstrap ${draws} draws; screening support ≥ ${lock.protocol.screening.support} (level ${lock.protocol.screening.level}), adoption support ≥ ${lock.protocol.adoption.support} (level ${lock.protocol.adoption.level}); exploratory overall loss allowance ${lock.protocol.gate.eps.overall}.`, "");
  if (state.prerequisites?.length) { L.push("## Prerequisites", "", "| check | ok | detail |", "|---|---|---|"); for (const p of state.prerequisites) L.push(`| ${p.name} | ${p.ok ? "yes" : "**no**"} | ${String(p.detail ?? "").replace(/\|/g, "/")} |`); L.push(""); }
  if (datasets) {
    L.push("## Datasets", "", `train ${datasets.train.length} · dev ${datasets.dev.length} · holdout ${datasets.holdout.length} tasks (family-disjoint). Excluded by grader validation: ${datasets.excluded.map(e => e.id).join(", ") || "none"}.`, "");
    for (const split of ["train", "dev", "holdout"]) L.push(`- **${split}**: ${datasets[split].map(id => `${id} (${meta[id]?.tier}, ${meta[id]?.family})`).join(", ") || "none"}`);
    L.push("");
  }
  if (armRows.length) {
    L.push("## Arms (posterior means with 95% task-level Bayesian-bootstrap intervals; descriptive)", "", "| arm | split | runs | success | Q_overall | Q_hard | Q_consistency (pass^2) | terminal | critical | in/out tokens | wall s |", "|---|---|---:|---:|---|---|---|---|---:|---|---:|");
    for (const row of armRows) { const s = row.summary; L.push(`| ${row.arm} | ${row.split} | ${s.runs} | ${s.task_success}/${s.runs} | ${interval(row.posterior.overall)} | ${interval(row.posterior.hard)} | ${interval(row.posterior.consistency)} | ${Object.entries(s.terminal).map(([k, v]) => `${k}:${v}`).join(" ")} | ${s.critical_failure_count} | ${s.input_tokens}/${s.output_tokens} | ${(s.wall_time_ms / 1000).toFixed(0)} |`); }
    L.push("", "Tokens and wall time are recorded and never used by any gate.", "");
  }
  const cands = candidates.filter(c => c.origin === "proposer");
  if (cands.length) {
    L.push("## Candidates (every attempt is kept)", "", "| id | parent | target | status | hypothesis | files | screening support (exec / task) | dev Q_overall | dev vs stable P(loss>eps) |", "|---|---|---|---|---|---|---|---|---|");
    for (const c of cands) L.push(`| ${c.id} | ${c.parent} | ${c.target ?? c.hypothesis?.targetFailureClass ?? "–"} | ${c.status} | ${String(c.hypothesis?.text ?? "").replace(/\|/g, "/").slice(0, 140)} | ${(c.files ?? []).join(" ")} | ${c.screening ? `${num(c.screening.support)} / ${num(c.screening.supportTaskLevel)} @${c.screening.repeats}r` : "–"} | ${c.development?.point ? pct(c.development.point.overall) : "–"} | ${c.development?.vsStable ? num(c.development.vsStable.lossSupport) : "–"} |`);
    L.push("", `Decision trail per candidate: \`${join(stateDir, "candidates/<id>/candidate.json")}\` (decisions[]), patch: \`patch.diff\`, optimizer evidence: \`evidence/\`.`, "");
  }
  L.push("## Pareto front (development: Q_overall, Q_hard, Q_consistency)", "", archive.front().map(id => `- ${id}: ${(() => { const p = archive.get(id).development.point; return `overall ${pct(p.overall)}, hard ${pct(p.hard)}, consistency ${pct(p.consistency)}`; })()}`).join("\n") || "- (none)", "");
  L.push("## Search, selection, holdout and adoption", "");
  L.push(`- search stop: ${state.searchStop ?? "–"}; candidates this cycle: ${state.counters?.candidates ?? 0}; consecutive no-progress: ${state.counters?.noProgress ?? 0}`);
  if (state.selection) L.push(`- selection: ${state.selection.selected ?? "none"}${state.selection.reason ? ` (${state.selection.reason})` : ""}`);
  if (state.final) {
    L.push(`- **verdict: ${state.final.verdict}**${state.final.candidate ? ` for ${state.final.candidate}` : ""}`);
    for (const r of state.final.reasons ?? []) L.push(`  - ${r}`);
    if (state.final.independence) L.push(`  - holdout independence at first use: ${state.final.independence.independent ? "yes" : "NO"} (${state.final.independence.why})`);
    if (state.final.holdout) L.push(`  - holdout overall delta ${num(state.final.holdout.delta.overall.mean)} [${num(state.final.holdout.delta.overall.lo95)}, ${num(state.final.holdout.delta.overall.hi95)}], adoption support ${num(state.final.holdout.support)} over ${state.final.holdout.tasks} tasks / ${state.final.holdout.families} families`);
    if (state.final.rolledBack) L.push(`  - automatic rollback at ${state.final.rolledBack.at}`);
  }
  if (history.length) { L.push("", "### Stable history (local refs only; never pushed)", ""); for (const h of history) L.push(`- ${h.at} ${h.type}${h.candidateId ? ` ${h.candidateId}` : ""}${h.commit ? ` orche ${h.commit.slice(0, 12)}` : ""}${h.reason ? `: ${h.reason}` : ""}${h.problems?.length ? ` problems: ${h.problems.join("; ")}` : ""}`); }
  L.push("", "## Resource usage (recorded only)", "", `Optimizer (proposer) requests ${proposerUsage.requests}, tokens in/out ${proposerUsage.input}/${proposerUsage.output}. Evaluated runs: ${finals.length} (all attempts: ${records.length}).`, "");
  L.push("## Integrity of the records", "", `runs ledger chain: ${integrity.runsLedger.length ? `**BROKEN** (${integrity.runsLedger.slice(0, 3).join("; ")})` : "intact"}; events ledger: ${integrity.events.length ? "**BROKEN**" : "intact"}.`, "");
  L.push("## Limitations", "", "- Bootstrap support is a posterior-predictive fraction under a Dirichlet model of THESE tasks and runs; it is not a probability of real-world generalization, and few runs remain few observations.", "- Screening support at level `execution` ignores task-sampling uncertainty (as in ParetoSaddler); development and adoption use task-level resampling.", "- Hard/medium/easy tiers of the suite tasks are a pre-registered prefix rule (a=easy, b/c=medium, d/p=hard), not a measured difficulty.", "- Suite tasks are exposed (used by earlier orche experiments): they are train/dev only and never an independent holdout.");
  if (state.final?.independence && !state.final.independence.independent) L.push("- The holdout used here was NOT independent; no adoption claim can rest on it.");
  if (simulated) L.push("- Simulated records are not measurements.");
  L.push("");
  return { markdown: L.join("\n"), json };
}

export function writeReport(stateDir) {
  const { markdown, json } = buildReport(stateDir);
  if (existsSync(stateDir)) { atomicWrite(join(stateDir, "report.md"), markdown, 0o644); atomicWriteJson(join(stateDir, "report.json"), json); }
  return { markdown, json, path: join(stateDir, "report.md") };
}
export { readFileSync };
