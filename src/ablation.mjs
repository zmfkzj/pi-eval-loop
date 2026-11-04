// A/B/C comparison of the optimizer itself:
//   A  baseline: the stable harness, no optimization;
//   B  quality-only loop: failure analysis, patch, repeated screening, development - but one greedy trajectory (the current best is
//      the only parent; no Pareto archive, no multi-objective promotion);
//   C  quality-first Pareto loop: the full system.
// A's baseline runs are measured once and shared by B and C (same harness, protocol, environment and unit keys); B and C then run as
// SEPARATE trajectories with the same tasks, model, protocol, proposer and candidate budget. Their final candidates (frozen first)
// and A are evaluated together on the holdout in ONE pass of A's ordinary loop path (one recorded use): C's result goes through
// the same adoption gate, adoption, post-adoption check and rollback as a normal cycle.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { holdoutLedger } from "./datasets.mjs";
import { explorationOnlyFinal } from "./loop.mjs";
import { finalAttempts, pairsOf, summarize } from "./metrics.mjs";
import { compare, describeArm } from "./stats.mjs";
import { atomicWrite, atomicWriteJson, digestOf } from "./util.mjs";

const SHARED = ["runs.jsonl", "grading.json", "protocol.lock.json", "datasets.json"];

function seedTrajectory(fromDir, toDir, baseState) {
  mkdirSync(toDir, { recursive: true });
  if (existsSync(join(toDir, "state.json"))) return;
  for (const f of SHARED) if (existsSync(join(fromDir, f))) cpSync(join(fromDir, f), join(toDir, f));
  cpSync(join(fromDir, "candidates"), join(toDir, "candidates"), { recursive: true });
  atomicWriteJson(join(toDir, "state.json"), { phase: "search", cycle: 1, counters: { candidates: 0, noProgress: 0, consecutiveInfra: 0 }, stable: baseState.stable, startedAt: new Date().toISOString(), sharedBaselineFrom: fromDir });
}

/**
 * loopFactory({ stateDir, strategy }) -> Loop. Returns { ok, summary }. Resumable: every trajectory keeps its own state.
 */
export async function runAblation({ stateDir, loopFactory, protocolPath, pids, log = () => {} }) {
  loopFactory ??= async (opts) => (await import("./app.mjs")).realLoop({ ...opts, protocolPath, pids });
  const A = await loopFactory({ stateDir: join(stateDir, "A"), strategy: "pareto" });
  if (!(await A.prepare())) return { ok: false, summary: { phase: "blocked", blocked: A.state.blocked } };
  if (["prepare", "baselines"].includes(A.state.phase)) { A.setPhase("baselines"); await A.baselines(); }
  A.state.role = "A (baseline, no optimization)"; A.save();
  const trajectories = {};
  for (const [name, strategy] of [["B", "greedy"], ["C", "pareto"]]) {
    seedTrajectory(A.stateDir, join(stateDir, name), A.state);
    const loop = await loopFactory({ stateDir: join(stateDir, name), strategy });
    loop.idPrefix = `${name}-c`;
    loop.stopBefore = "holdout";
    loop.state.strategy = strategy; loop.state.role = name === "B" ? "B (quality-only loop)" : "C (quality-first Pareto loop)"; loop.save();
    trajectories[name] = loop;
  }
  await Promise.all(Object.values(trajectories).map(loop => loop.runCycle()));
  for (const [name, loop] of Object.entries(trajectories)) if (!["holdout", "done"].includes(loop.state.phase)) return { ok: false, summary: { phase: `${name}: ${loop.state.phase}`, blocked: loop.state.blocked, halted: loop.state.halted } };
  // Freeze every condition's final harness (no selection = the stable harness itself) BEFORE any holdout access, then run the ONE
  // joint holdout pass through A's ordinary trusted path: holdout -> adoption gate (C vs A) -> adopt -> post-adoption check.
  const finals = {};
  for (const [name, loop] of Object.entries(trajectories)) {
    const id = loop.state.selection?.selected ?? null;
    finals[name] = id ? { id, commit: loop.archive.get(id).commit } : { id: "stable", commit: A.state.stable.commit };
    if (id && !A.archive.get(id)) A.archive.put({ ...loop.archive.get(id), copiedFrom: loop.stateDir });
  }
  const explorationOnly = !A.protocol.datasets.holdout;
  if (!A.state.selection) {
    const measured = [finals.B.id, finals.C.id].filter(id => id !== "stable");
    const selected = finals.C.id === "stable" ? null : finals.C.id;
    const selection = { at: new Date().toISOString(), selected, commit: selected ? finals.C.commit : undefined, extraArms: measured.filter(id => id !== selected), ablation: finals, frozenDigest: digestOf({ finals, protocol: A.protocolDigest }) };
    atomicWriteJson(join(A.stateDir, "selection.json"), selection);
    A.event("selection", selection);
    // Exploration-only: the finals are frozen and recorded; no holdout, adoption gate, adoption or ref change follows.
    if (explorationOnly) { const final = explorationOnlyFinal(selection); A.event("adoption-decision", final); A.setPhase("done", { selection, final }); }
    else if (measured.length) A.setPhase("holdout", { selection });
    else A.setPhase("done", { selection, final: { verdict: "KEEP_STABLE", adopt: false, reasons: ["neither B nor C selected a candidate on development; the holdout was not consumed"] } });
  }
  if (!explorationOnly) await A.runCycle();
  if (A.state.phase !== "done") return { ok: false, summary: { phase: `A: ${A.state.phase}`, blocked: A.state.blocked, halted: A.state.halted } };
  const p = A.protocol;
  const arms = { A: { id: "stable", commit: A.state.stable.commit }, B: finals.B, C: finals.C };
  const records = A.records();
  const tasks = A.split.holdout, meta = A.tasksById, seed = `${p.seed}:ablation`;
  const pairs = (a, b) => pairsOf(records, { a, b, split: "holdout", tasks, meta });
  const one = (id) => pairs(id, id).map(t => ({ ...t, a: t.b }));
  const measuredHoldout = records.some(r => r.split === "holdout");
  const conditions = {};
  // Development (selection) split, descriptive only: each final was SELECTED on these results (winner's curse), so a development
  // difference is never evidence of improvement. Records of both trajectories share the stable baseline unit keys.
  const devRecords = finalAttempts([...A.records(), ...Object.values(trajectories).flatMap(loop => loop.records())]);
  const devPairs = (a, b) => pairsOf(devRecords, { a, b, split: "dev", tasks: A.split.dev, meta });
  for (const [name, h] of Object.entries(arms)) {
    const loop = name === "A" ? A : trajectories[name];
    const optRecs = name === "A" ? [] : finalAttempts(loop.records()).filter(r => r.context?.startsWith("screen:") || r.context?.startsWith("develop:"));
    const proposals = name === "A" ? [] : loop.archive.all().filter(c => c.origin === "proposer");
    const proposerUsage = proposals.reduce((s, c) => ({ requests: s.requests + (c.proposer?.usage?.requests ?? 0), input: s.input + (c.proposer?.usage?.input ?? 0), output: s.output + (c.proposer?.usage?.output ?? 0) }), { requests: 0, input: 0, output: 0 });
    conditions[name] = {
      final: h.id, commit: h.commit ?? null,
      holdout: measuredHoldout ? describeArm(one(h.id), { draws: p.bootstrap.draws, seed: `${seed}:${name}` }) : null, holdoutSummary: measuredHoldout ? summarize(records, h.id, "holdout") : null,
      development: describeArm(devPairs(h.id, h.id).map(t => ({ ...t, a: t.b })), { draws: p.bootstrap.draws, seed: `${seed}:dev:${name}` }), developmentSummary: summarize(devRecords, h.id, "dev"),
      candidatesProposed: proposals.length, candidateStatuses: proposals.reduce((acc, c) => { acc[c.status] = (acc[c.status] ?? 0) + 1; return acc; }, {}),
      optimizationRuns: optRecs.length, optimizationTokens: { input: optRecs.reduce((s, r) => s + r.input_tokens, 0), output: optRecs.reduce((s, r) => s + r.output_tokens, 0), cache: optRecs.reduce((s, r) => s + (r.cache_tokens ?? 0), 0), requests: optRecs.reduce((s, r) => s + r.model_requests, 0) }, proposerUsage,
      searchStop: name === "A" ? null : loop.state.searchStop, selection: name === "A" ? null : loop.state.selection,
    };
  }
  const contrast = (a, b) => !measuredHoldout ? { notMeasured: true } : arms[a].id === arms[b].id ? { identical: true, note: `${a} and ${b} are the same harness (${arms[a].id})` } : (() => { const c = compare(pairs(arms[a].id, arms[b].id), { draws: p.bootstrap.draws, seed: `${seed}:${a}-${b}`, level: "task", event: (d) => d.overall > 0 }); return { support: c.support, delta: c.delta, point: c.point }; })();
  const comparisons = { "B vs A (loop effect, quality-only)": contrast("A", "B"), "C vs A (loop effect, Pareto)": contrast("A", "C"), "C vs B (added effect of Pareto exploration)": contrast("B", "C") };
  const devContrast = (a, b) => arms[a].id === arms[b].id ? { identical: true, note: `${a} and ${b} are the same harness (${arms[a].id})` } : (() => { const c = compare(devPairs(arms[a].id, arms[b].id), { draws: p.bootstrap.draws, seed: `${seed}:dev:${a}-${b}`, level: "task", event: (d) => d.overall > 0 }); return { support: c.support, delta: c.delta, point: c.point, selectionBiased: true }; })();
  const developmentComparisons = { "B vs A": devContrast("A", "B"), "C vs A": devContrast("A", "C"), "C vs B": devContrast("B", "C") };
  const holdoutUse = holdoutLedger(A.holdoutDir ?? A.stateDir, A.holdoutLedgerPath).records().filter(r => r.stateDir === A.stateDir);
  const result = { generatedAt: new Date().toISOString(), explorationOnly, arms, conditions, comparisons, developmentComparisons, adoption: A.state.final, independence: A.state.holdoutIndependentAtStart ?? null, holdoutUses: holdoutUse.length, rolledBack: A.state.final?.rolledBack ?? null, simulated: records.some(r => r.simulated) };
  const resultPath = join(stateDir, "ablation.json");
  atomicWriteJson(resultPath, result);
  atomicWrite(join(stateDir, "ablation.md"), ablationMarkdown(result), 0o644);
  return { ok: true, summary: { arms, comparisons: Object.fromEntries(Object.entries(comparisons).map(([k, v]) => [k, v.identical ? v.note : v.notMeasured ? "holdout not measured" : `support ${v.support.toFixed(3)}, delta ${v.delta.overall.mean.toFixed(3)}`])), adoption: { verdict: result.adoption?.verdict, reasons: result.adoption?.reasons }, report: join(stateDir, "ablation.md") } };
}

const pct = (x) => (x === undefined || x === null || Number.isNaN(x) ? "–" : `${(100 * x).toFixed(1)}%`);
const pct2 = (x) => (x === undefined || x === null || Number.isNaN(x) ? "–" : `${(100 * x).toFixed(2)}%`);
/** Exact plug-in point with the bootstrap 95% interval (the Monte Carlo posterior mean is never shown as the point). */
const pointInterval = (v) => v ? `${pct2(v.point ?? v.mean)} [${pct(v.lo95)}, ${pct(v.hi95)}]` : "–";
const rate = (s) => s ? `${s.task_success}/${s.runs} (${pct2(s.runs ? s.task_success / s.runs : NaN)})` : "not measured";
export function ablationMarkdown(r) {
  const L = ["# A/B/C ablation of pi-eval-loop", ""];
  if (r.simulated) L.push("> SIMULATED runs present: pipeline check, not a measurement.", "");
  if (r.explorationOnly) L.push("> EXPLORATION-ONLY protocol: train/dev search and development selection only. No holdout was loaded or used; deployment is BLOCKED. Development figures are descriptive and selection-biased.", "");
  else L.push(`Holdout independence at its use: ${r.independence?.independent ? "yes" : "NO"} (${r.independence?.why}).`, "");
  L.push("Points are exact plug-in estimates (uniform task weights); brackets are 95% task-level Bayesian-bootstrap intervals.", "");
  L.push("| condition | final harness | dev success | dev Q_overall | dev Q_hard | holdout success | holdout Q_overall | proposals | optimization runs (screen+dev) | optimization tokens in/out | proposer requests | search stop |", "|---|---|---|---|---|---|---|---:|---:|---|---:|---|");
  for (const [name, c] of Object.entries(r.conditions)) L.push(`| ${name} | ${c.final} | ${rate(c.developmentSummary)} | ${pointInterval(c.development?.overall)} | ${pointInterval(c.development?.hard)} | ${rate(c.holdoutSummary)} | ${pointInterval(c.holdout?.overall)} | ${c.candidatesProposed} | ${c.optimizationRuns} | ${c.optimizationTokens.input}/${c.optimizationTokens.output} | ${c.proposerUsage.requests} | ${c.searchStop ?? "–"} |`);
  const line = (v) => v.identical ? v.note : v.notMeasured ? "holdout not measured" : `support ${v.support.toFixed(3)}, overall delta mean ${v.delta.overall.mean.toFixed(3)} [${v.delta.overall.lo95.toFixed(3)}, ${v.delta.overall.hi95.toFixed(3)}] (exact points ${pct2(v.point.a.overall)} -> ${pct2(v.point.b.overall)})`;
  L.push("", "## Holdout contrasts (task-level paired Bayesian bootstrap; support = P(overall improves))", "");
  for (const [k, v] of Object.entries(r.comparisons)) L.push(`- ${k}: ${line(v)}`);
  if (r.developmentComparisons) {
    L.push("", "## Development contrasts (descriptive; the finals were selected on these data, so they are biased upward)", "");
    for (const [k, v] of Object.entries(r.developmentComparisons)) L.push(`- ${k}: ${line(v)}`);
  }
  L.push("", `Statements need support >= 0.95 on an independent holdout to count as evidence of an improvement; anything lower is uncertain and reported as such.`, "", `## Deployment (C adoption gate): ${r.adoption?.verdict}`, "", ...(r.adoption?.exploration ? [`- exploration outcome: ${r.adoption.exploration}`] : []), ...(r.adoption?.reasons ?? []).map(x => `- ${x}`), "");
  if (r.adoption?.adopt) L.push(`Adopted on local refs${r.rolledBack ? `, then ROLLED BACK by the post-adoption check (${JSON.stringify(r.rolledBack)})` : ""}.`, "");
  return L.join("\n");
}
