#!/usr/bin/env node
// exploratory-1: one fixed candidate (c1, build-candidate.mjs), an integrity screen on non-holdout tasks, then at most ONE
// exploration-only holdout pass (2026-11-07; README.md). Never adopts, deploys, commits or schedules anything.
//
//   screen   c1 alone on the frozen screening plan (development tasks: calibration-only tasks and consumed ctrl-confirm-2 holdout
//            tasks on which earlier harnesses changed existing tests). Acceptance, fixed before the first run: zero integrity
//            violations (legacy line rules AND strict byte-identity of every existing test file), zero leak hits, zero harness
//            crashes or route violations, every planned unit measured.
//   holdout  only after an accepted screen: stable vs c1 on one sealed fresh batch, randomized interleaved, the batch's use recorded
//            BEFORE the first run (a crash still consumes it; a resume finds its own use and never records a second), the
//            loop's adoption gate (gate.mjs adoptionDecision) under an exploratory analysis plan: the best possible verdict is
//            EXPLORATORY_SUPPORTED with adopt false.
// Spending: every target-model attempt is admitted by the study's single global request ledger (4500 actual provider attempts
// across calibration, screening and this pass; src/request-budget.mjs) through the isolated runtime's outbound gate.
//
//   node studies/exploratory-1/explore.mjs screen  --state DIR --plan FILE --runtime DIR --budget-ledger FILE --gateway-db FILE [--dry-run]
//   node studies/exploratory-1/explore.mjs holdout --state DIR --plan FILE --runtime DIR --budget-ledger FILE --gateway-db FILE [--dry-run | --preflight]
//            --dry-run: CLI-level checks only. --preflight (use a separate state dir): every model-free prerequisite of the pass
//            (seal, screen binding, arm identities, graders, checks, budget headroom, independence, the pool handing out exactly
//            the frozen batch) without reserving or consuming anything.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { realBackend } from "../../src/evaluator.mjs";
import { DEFAULT_PROTOCOL } from "../../src/protocol.mjs";
import { RequestBudget, gatewayPressureMeter } from "../../src/request-budget.mjs";
import { runtimeProblems } from "../../src/isolated-runtime.mjs";
import { forbiddenFamilies, runHoldout, runScreen } from "../../src/exploration.mjs";
import { BUDGET_SCOPE, GATED_RESERVATION_FACTOR, HARD_CAP, peerExperiments } from "../confirmatory-1/calibrate.mjs";
import { candidateIdentity } from "./build-candidate.mjs";
// The implementation lives in src/exploration.mjs (shared with the recurring route src/explore-cycle.mjs); re-exported here so the
// study's tests and records keep their import path.
export * from "../../src/exploration.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: { state: { type: "string" }, plan: { type: "string" }, runtime: { type: "string" }, "budget-ledger": { type: "string" }, "gateway-db": { type: "string" }, parallelism: { type: "string", default: "2" }, "pressure-minutes": { type: "string", default: "30" }, "dry-run": { type: "boolean", default: false }, preflight: { type: "boolean", default: false } } });
  if (!["screen", "holdout"].includes(cmd) || !values.plan || !values.state) { process.stderr.write("usage: explore.mjs screen|holdout --state DIR --plan FILE --runtime DIR --budget-ledger FILE --gateway-db FILE [--dry-run]\n"); process.exit(64); }
  const plan = JSON.parse(readFileSync(values.plan, "utf8"));
  const blocked = [];
  const ident = candidateIdentity(plan.candidate.dir);
  if (ident.runtimeDigest !== plan.candidate.identity.runtimeDigest || ident.diffSha256 !== plan.candidate.identity.diffSha256) blocked.push("candidate tree differs from the frozen identity");
  let bound = null, runtime = null;
  try {
    const dir = resolve(values.runtime ?? "");
    runtime = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    bound = () => { const pr = runtimeProblems(dir, { running: true, mode: "live", budgetPath: resolve(values["budget-ledger"] ?? "") }); if (pr.length) throw new Error(`isolated runtime: ${pr.join("; ")}`); return { perRequest: GATED_RESERVATION_FACTOR, gated: true }; };
    bound();
    process.env.EVAL_LOOP_UPSTREAM = runtime.upstream; process.env.EVAL_LOOP_AGENT_DIR = runtime.agentDir;
  } catch (error) { blocked.push(`isolated runtime unusable (fail closed): ${String(error?.message ?? error).slice(0, 300)}`); }
  const peers = peerExperiments().filter(x => !/exploratory-1\/explore\.mjs/.test(x.cmd));
  if (peers.length) blocked.push(`peer experiments running: ${peers.map(x => x.cmd).join(" | ")}`);
  let budget = null;
  try { budget = new RequestBudget({ path: resolve(values["budget-ledger"]), limit: HARD_CAP, scope: BUDGET_SCOPE }); budget.status(); } catch (error) { blocked.push(`budget: ${error.message}`); }
  const pressure = values["gateway-db"] && existsSync(values["gateway-db"]) ? gatewayPressureMeter({ db: resolve(values["gateway-db"]), model: DEFAULT_PROTOCOL.route.model }) : null;
  if (!pressure) blocked.push("--gateway-db: peer protection needs the live gateway's failure records");
  else { try { const n = pressure.read(Date.now() - Number(values["pressure-minutes"]) * 60_000); if (n > 0) blocked.push(`peer protection: ${n} target-model 429/503 failures on the live gateway recently`); } catch (error) { blocked.push(`pressure meter: ${error.message}`); } }
  if (values["dry-run"] || blocked.length) { process.stdout.write(`${JSON.stringify({ cmd, blocked, wouldRun: !blocked.length, budget: budget && (() => { try { const s = budget.status(); return { charged: s.charged, attempts: s.attempts, remaining: s.remaining, open: s.openReservations }; } catch { return null; } })(), candidate: ident, modelCalls: 0 })}\n`); process.exit(blocked.length ? 2 : 0); }
  const { environmentDigest, hostEnvironment, prerequisites, stopProxies, ORCHE } = await import("../../src/sandbox.mjs");
  const { validateGrader } = await import("../../src/grader.mjs");
  const env = hostEnvironment();
  const missing = (await prerequisites(env)).filter(x => !x.ok);
  if (missing.length) { process.stderr.write(`BLOCKED: missing prerequisites ${missing.map(m => m.name).join(", ")}\n`); process.exit(2); }
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => { stopProxies("SIGTERM"); process.exit(130); });
  const state = resolve(values.state);
  const common = { plan, state, backend: realBackend(env), budget, bound, pressure, parallelism: Number(values.parallelism), log: (l) => process.stderr.write(`${l}\n`), validate: (t) => validateGrader({ task: t, scratch: join(state, "grading-scratch", t.id), env }), envDigest: environmentDigest(env, DEFAULT_PROTOCOL.route) };
  if (cmd === "screen") { const r = await runScreen(common); process.stdout.write(`${JSON.stringify({ accepted: r.accepted, problems: r.problems, totals: r.totals, budget: r.budget })}\n`); process.exit(r.accepted ? 0 : 2); }
  const { priorHoldoutFamilies } = await import("../../src/supply.mjs");
  const { runChecks, compareChecks } = await import("../../src/checks.mjs");
  const { cpSync, rmSync } = await import("node:fs");
  const checks = async () => {
    const out = {};
    for (const [id, dir] of [["stable", plan.stable.dir], ["c1", plan.candidate.dir]]) { const wt = join(state, "checks", `wt-${id}`); rmSync(wt, { recursive: true, force: true }); cpSync(dir, wt, { recursive: true, filter: (x) => !x.endsWith("/.codegraph") }); out[id] = await runChecks({ worktree: wt, env, which: ["typecheck", "test"], logDir: join(state, "checks", id) }); rmSync(wt, { recursive: true, force: true }); }
    const c = compareChecks(out.stable, out.c1);
    return { ...c, results: Object.fromEntries(Object.entries(out.c1.results).map(([k, v]) => [k, { pass: v.pass, failing: v.failing }])) };
  };
  const priorFamilies = forbiddenFamilies({ plan, extraDatasets: plan.holdout.forbiddenFamilyDatasets ?? [], pools: (plan.holdout.forbiddenFamilyPools ?? []).map(d => ({ dir: d, exclude: plan.holdout.batch })) }, priorHoldoutFamilies);
  const r = await runHoldout({ ...common, checks, priorFamilies, orcheDir: ORCHE, poolDir: plan.holdout.pool, preflightOnly: values.preflight });
  if (r.preflight) { process.stdout.write(`${JSON.stringify(r)}\n`); process.exit(0); }
  process.stdout.write(`${JSON.stringify({ verdict: r.verdict, adopt: r.adopt, paused: r.paused, reasons: r.reasons?.slice(0, 6), arms: r.arms, budget: r.budget })}\n`);
  process.exit(r.verdict ? 0 : 2);
}
