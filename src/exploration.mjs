// Exploration-only passes (2026-11-07; moved from studies/exploratory-1/explore.mjs so the recurring route src/explore-cycle.mjs and
// the study share one implementation): an integrity screen of a fixed candidate on development tasks (runScreen) and ONE
// exploration-only holdout pass stable vs candidate on one sealed fresh batch (runHoldout). Never adopts, deploys, commits or
// schedules: the analysis plan is exploratory, so the best verdict is EXPLORATORY_SUPPORTED with adopt false.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Evaluator } from "./evaluator.mjs";
import { holdoutHard, holdoutLedger, holdoutStatus, loadLocal, verifySeal, datasetPurpose } from "./datasets.mjs";
import { adoptionCompare, adoptionDecision, criticalProblems, familyAdoptionCompare } from "./gate.mjs";
import { finalAttempts, missingUnits, pairsOf } from "./metrics.mjs";
import { confirmatoryChecks, evidenceLabel, executionOrder, interleavedSchedule, planCompleteness, planPath, scheduleProblems, spendAlpha } from "./design.mjs";
import { DEFAULT_PROTOCOL, merge, routeKey, routeProblems } from "./protocol.mjs";
import { reserveBatch, assignmentFor, firstEligibleBatch } from "./supply.mjs";
import { acquireLock, atomicWriteJson, digestOf, ensureDir, fault, readJson, sha256 } from "./util.mjs";
import { attemptAdmission, pressureVerdict } from "./admission.mjs";

export const RUNTIME = ["src", "prompts", "package.json", "tsconfig.json"];

/** sha256 over the sorted (path, sha256) list of the harness runtime files (what the sandbox mounts). */
export function runtimeDigest(dir) {
  const rows = [];
  const walk = (rel) => {
    const abs = join(dir, rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) rows.push(`${r}\t${createHash("sha256").update(readFileSync(join(dir, r))).digest("hex")}`);
    }
  };
  for (const name of RUNTIME) {
    if (!existsSync(join(dir, name))) continue;
    if (readdirSync(dir, { withFileTypes: true }).find(e => e.name === name)?.isDirectory()) walk(name);
    else rows.push(`${name}\t${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")}`);
  }
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}

export const SCREEN_CONTEXT = "exploratory-1:screen";
export const HOLDOUT_CONTEXT = "exploratory-1:holdout";

/**
 * The exploratory protocol: every gate of the package protocol (6 tasks, 4 families, a hard task, size-proxy never hard, one use,
 * independence, integrity, family regression, family-level support) plus stricter choices: hard only by an annotated source,
 * cross-provider review for low-exposure tasks, no family of an earlier holdout/calibration/development set, account share
 * <= 0.5, strict existing-test immutability, all transcripts captured and leak-scanned, exploratory plan (never ADOPT).
 */
export function exploreProtocol(route) {
  const p = merge(structuredClone(DEFAULT_PROTOCOL), {
    holdout: { acceptedProvenance: ["external", "private-reviewed"], hardBasis: ["source"], privateReview: "cross-provider", priorFamilyReuse: "forbid", maxOwnerShare: 0.5, execution: "interleaved" },
    analysisPlan: { mode: "exploratory" },
  });
  p.integrity = { strictTestFiles: true };
  p.capture = { transcripts: true };
  // Only the target route changes; the proposer remains independently selected. Omission keeps the original default identity.
  if (route !== undefined) {
    const problems = routeProblems(route);
    if (problems.length) throw new Error(`target route: ${problems.join("; ")}`);
    p.route = { ...route };
  }
  return p;
}

/** An environment digest by value: environmentDigest() returns {digest, facts}; older callers pass the digest string. */
export const envKey = (e) => (e && typeof e === "object" ? e.digest ?? JSON.stringify(e) : e ?? null);

/** The two arms of a pass: "stable" (plan.stable) and the candidate arm "c1" (plan.candidate; its identity.commit names the exact candidate). */
export const harnessOf = (id, plan) => id === "stable" ? { id: "stable", kind: "orche", commit: plan.stable?.commit ?? "unpinned-stable", mode: "single", dir: plan.stable.dir } : { id: "c1", kind: "orche", commit: plan.candidate.identity?.commit ?? `unpinned:${runtimeDigest(plan.candidate.dir).slice(0, 16)}`, mode: "single", dir: plan.candidate.dir };

/** Load tasks of a plan (each from its dataset directory, by id). */
export function planTasks(entries) {
  const byDir = new Map();
  return entries.map(e => {
    if (!byDir.has(e.dataset)) byDir.set(e.dataset, loadLocal(e.dataset));
    const t = byDir.get(e.dataset).find(x => x.id === e.id);
    if (!t) throw new Error(`plan task ${e.id} not in ${e.dataset}`);
    return t;
  });
}

/** Fixed phrases of c1's guard messages (c1/existing-tests.ts REFUSAL_MARK, CHANGE_MARK). */
export const GUARD_MARKS = { refused: "is read-only: the project's existing tests must stay byte-for-byte unchanged", changed: "Note: this call changed existing test file(s)" };

/** Guard events of one unit, counted from its captured MAIN-session transcripts (evidence transcripts, try N, sessions). */
export function guardEvents(evidenceDir) {
  const out = { refused: 0, changed: 0, transcripts: 0 };
  const root = join(evidenceDir ?? "", "transcripts");
  if (!evidenceDir || !existsSync(root)) return out;
  for (const t of readdirSync(root)) {
    const sessions = join(root, t, "sessions");
    if (!existsSync(sessions)) continue;
    for (const f of readdirSync(sessions, { recursive: true }).map(String).filter(f => f.endsWith(".jsonl"))) {
      out.transcripts++;
      for (const line of readFileSync(join(sessions, f), "utf8").split("\n")) {
        if (!line.includes("existing test")) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e?.type !== "message" || e.message?.role !== "toolResult") continue;
        const text = JSON.stringify(e.message.content ?? "");
        if (text.includes(GUARD_MARKS.refused)) out.refused++;
        if (text.includes(GUARD_MARKS.changed)) out.changed++;
      }
    }
  }
  return out;
}

/** Screening verdict over final attempts (pure). */
export function screenVerdict(records, plan) {
  const fin = finalAttempts(records.filter(r => r.candidate_id === "c1"));
  const planned = plan.tasks.length * plan.repeats;
  const units = fin.map(r => {
    const g = guardEvents(r.evidence_dir);
    return { task: r.task_id, repeat: r.repeat, terminal: r.terminal_status, success: r.task_success === true, hiddenPass: r.hidden_test_pass === true,
      legacy: r.integrity?.legacyViolations ?? r.integrity?.violations ?? [], strict: r.integrity?.strictTestViolations ?? null, leaks: r.integrity?.leakHits ?? [],
      requests: r.model_requests ?? 0, guard: g };
  });
  const allAttempts = records.filter(r => r.candidate_id === "c1");
  const problems = [];
  if (fin.length < planned) problems.push(`${planned - fin.length} planned unit(s) not measured`);
  const violating = allAttempts.filter(r => r.integrity?.violations?.length);
  if (violating.length) problems.push(`integrity violations in ${violating.length} attempt(s): ${violating.slice(0, 3).map(r => `${r.task_id}#${r.repeat}: ${r.integrity.violations[0]}`).join(" | ")}`);
  if (units.some(u => u.strict === null)) problems.push("strict test immutability was not checked for every unit");
  const leaks = allAttempts.filter(r => r.integrity?.leakHits?.length);
  if (leaks.length) problems.push(`leak hits in ${leaks.length} attempt(s)`);
  const crash = allAttempts.filter(r => ["harness_crash", "route_violation"].includes(r.terminal_status));
  if (crash.length) problems.push(`${crash.length} harness crash/route violation(s)`);
  if (!plan.simulated && units.some(u => u.guard.transcripts === 0)) problems.push("a unit has no captured main-session transcript (guard evidence missing)");
  return { accepted: problems.length === 0, problems, planned, measured: fin.length, attempts: allAttempts.length,
    totals: { success: units.filter(u => u.success).length, hiddenPass: units.filter(u => u.hiddenPass).length, legacyViolations: units.filter(u => u.legacy.length).length, strictViolations: units.filter(u => u.strict?.length).length, leaks: units.filter(u => u.leaks.length).length,
      guardRefusals: units.reduce((s, u) => s + u.guard.refused, 0), guardDetectedChanges: units.reduce((s, u) => s + u.guard.changed, 0), unitsWithGuardDetections: units.filter(u => u.guard.changed > 0).length, requests: units.reduce((s, u) => s + u.requests, 0) },
    units };
}

function lockPlan(state, plan) {
  ensureDir(state);
  const digest = digestOf(plan);
  const prior = readJson(join(state, "plan-lock.json"), null);
  if (prior && prior.digest !== digest) throw new Error("state belongs to another plan (a frozen plan is never changed; use a new state directory)");
  if (!prior) atomicWriteJson(join(state, "plan-lock.json"), { digest, at: new Date().toISOString() });
  return digest;
}

function pressureWatch(pressure, evaluator, events, ms = 15_000) {
  if (!pressure) return null;
  const since = Date.now();
  const timer = setInterval(() => {
    try { const v = pressureVerdict({ failures: pressure.read(since) }); if (v.action !== "none") { events.push({ at: new Date().toISOString(), ...v }); evaluator.halted ??= `peer protection: ${v.why}`; } }
    catch (error) { events.push({ at: new Date().toISOString(), action: "halt", why: String(error?.message ?? error).slice(0, 200) }); evaluator.halted ??= "peer protection: gateway failure records unreadable (fail closed)"; }
  }, ms);
  timer.unref?.();
  return timer;
}

/** Run (or resume) the screen. */
export async function runScreen({ plan, state, backend, budget, bound, validate, envDigest, pressure = null, parallelism = 2, log = () => {} }) {
  if (!budget) throw new Error("screen: a RequestBudget is required");
  const digest = lockPlan(state, plan);
  const lock = acquireLock(join(state, "screen.lock"));
  try {
    const tasks = planTasks(plan.tasks);
    const tasksById = Object.fromEntries(tasks.map(t => [t.id, t]));
    const grading = readJson(join(state, "grading.json"), {});
    for (const t of tasks) if (!grading[t.id]) { grading[t.id] = validate ? await validate(t) : { ok: true, expected: {}, baselineFailing: [] }; atomicWriteJson(join(state, "grading.json"), grading); }
    const bad = tasks.filter(t => !grading[t.id].ok).map(t => t.id);
    if (bad.length) { const out = { accepted: false, problems: [`grader validation failed: ${bad.join(", ")}`] }; atomicWriteJson(join(state, "screen-report.json"), out); return out; }
    const p = merge(exploreProtocol(plan.route), { parallelism });
    p.integrity = { strictTestFiles: true }; p.capture = { transcripts: true };
    const evaluator = new Evaluator({ stateDir: state, protocol: p, protocolDigest: digest, envDigest, tasksById, grading, backend, log, admission: attemptAdmission(budget, bound) });
    const units = []; for (const e of plan.tasks) for (let r = 0; r < plan.repeats; r++) units.push({ task: e.id, split: "screen", repeat: r });
    const events = [];
    const timer = pressureWatch(pressure, evaluator, events);
    try { await evaluator.evaluate(harnessOf("c1", plan), units, SCREEN_CONTEXT); } finally { if (timer) clearInterval(timer); }
    const verdict = screenVerdict(evaluator.records(), { ...plan, simulated: !!backend.simulated });
    const report = { schema: "pi-eval-loop/exploratory-screen@1", planDigest: digest, candidate: plan.candidate.identity, route: p.route, simulated: !!backend.simulated, halted: evaluator.halted ?? null, peerEvents: events, ...verdict, accepted: verdict.accepted && !evaluator.halted, budget: (() => { const s = budget.status(); return { charged: s.charged, attempts: s.attempts, openReservations: s.openReservations, remaining: s.remaining }; })(), at: new Date().toISOString() };
    if (evaluator.halted) report.problems = [...report.problems, `halted: ${evaluator.halted}`];
    atomicWriteJson(join(state, "screen-report.json"), report);
    return report;
  } finally { lock.release(); }
}

/** Families the fresh batch must not contain: earlier holdouts, calibration sets, the screening (development) tasks. */
export function forbiddenFamilies({ plan, extraDatasets = [], pools = [] }, priorHoldoutFamilies) {
  const out = new Set();
  for (const pool of pools) for (const f of priorHoldoutFamilies({ pool: pool.dir, exclude: pool.exclude })) out.add(f);
  for (const d of extraDatasets) { try { for (const t of loadLocal(d)) out.add(t.family); } catch { /* listed but unreadable: reported by the caller */ } }
  for (const t of planTasks(plan.screen.tasks)) out.add(t.family);
  return out;
}

/** Run (or resume) the ONE holdout pass. Returns the final decision (also written to final.json). */
export async function runHoldout({ plan, state, backend, budget, bound, validate, envDigest, checks, pressure = null, parallelism = 2, log = () => {}, priorFamilies, orcheDir, poolDir, preflightOnly = false, requireValidation = false }) {
  // requireValidation (the recurring route with a real backend): a missing grader validator fails closed instead of defaulting to ok.
  if (requireValidation && (!validate || !checks)) throw new Error("holdout: grader validation and arm checks are required");
  if (!budget) throw new Error("holdout: a RequestBudget is required");
  const digest = lockPlan(state, plan);
  const lock = acquireLock(join(state, "holdout.lock"));
  try {
    const done = readJson(join(state, "final.json"), null);
    // A recorded decision is returned only for the plan it was made under (a changed plan or a foreign final.json is refused).
    if (done) { if (done.planDigest !== digest) throw new Error("holdout: final.json was recorded under another plan (refused)"); return done; }
    // plan.analysis (lifecycle, src/lifecycle.mjs): a confirmatory test of a registered protocol, purpose "holdout" (the adoption
    // decision) or "confirmation" (independent post-adoption confirmation: previous release vs adopted). Without it: exploratory.
    const conf = plan.analysis?.mode === "confirmatory" ? plan.analysis : null;
    if (conf && !["holdout", "confirmation"].includes(conf.purpose)) throw new Error("holdout: analysis.purpose must be holdout|confirmation");
    const p = merge(merge(exploreProtocol(plan.route), conf ? conf.protocol : {}), { parallelism });
    p.integrity = { strictTestFiles: true }; p.capture = { transcripts: true };
    const finish = (final) => { const f = { ...final, purpose: conf?.purpose ?? "exploration", planDigest: digest, evidence: final.evidence ?? evidenceLabel(p, { adopt: false }), at: new Date().toISOString() }; atomicWriteJson(join(state, "final.json"), f); return f; };
    const batch = plan.holdout.batch;
    const seal = verifySeal(batch);
    if (!seal.ok || seal.seal.digest !== plan.holdout.seal) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`holdout seal ${seal.ok ? "differs from the frozen plan" : seal.why}`] });
    if (datasetPurpose(batch) !== "holdout") return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: ["not a holdout-purpose batch"] });
    const screen = readJson(plan.screen.report, null);
    if (!screen?.accepted || sha256(readFileSync(plan.screen.report)) !== plan.screen.reportSha256) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: ["no accepted integrity screen bound to this plan (holdout not consumed, not run)"] });
    const tasks = loadLocal(batch);
    // hard = an accepted hard task under THIS protocol's hard basis (a confirmatory protocol may accept only calibrated hard).
    const tasksById = Object.fromEntries(tasks.map(t => [t.id, { ...t, hard: holdoutHard(t, p) }]));
    const ledger = holdoutLedger(batch);
    const identity = { protocolDigest: digest, selected: "c1", commit: plan.candidate.identity.commit, frozenDigest: digestOf({ candidate: plan.candidate.identity, screen: plan.screen.reportSha256, seal: plan.holdout.seal, ...(conf ? { purpose: conf.purpose, stable: plan.stable.runtimeDigest } : {}) }) };
    const mine = ledger.verify().length === 0 ? ledger.records().find(r => r.type === "use" && r.stateDir === resolve(state) && r.protocolDigest === identity.protocolDigest && r.frozenDigest === identity.frozenDigest) : undefined;
    // Arm identity (2026-11-07): both trees must be the frozen ones, before the batch is consumed and again on every resume.
    const cRuntime = runtimeDigest(plan.candidate.dir);
    if (cRuntime !== plan.candidate.identity.runtimeDigest || (plan.candidate.diff && sha256(readFileSync(plan.candidate.diff)) !== plan.candidate.identity.diffSha256)) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: !!mine, reasons: [`candidate tree differs from the frozen identity${mine ? "" : " (not consumed, not run)"}`] });
    if (plan.stable.runtimeDigest && runtimeDigest(plan.stable.dir) !== plan.stable.runtimeDigest) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: !!mine, reasons: [`stable tree differs from the frozen identity${mine ? "" : " (not consumed, not run)"}`] });
    // Model-free prerequisites BEFORE consumption: every task's grader (start fails the hidden tests, the reference passes) and
    // the arms' own checks (typecheck + tests, candidate vs stable). Their results are kept and reused on resume.
    const grading = readJson(join(state, "grading.json"), {});
    for (const t of tasks) if (!grading[t.id]) { grading[t.id] = validate ? await validate(t) : { ok: true, expected: {}, baselineFailing: [] }; atomicWriteJson(join(state, "grading.json"), grading); }
    const badGrader = tasks.filter(t => !grading[t.id].ok).map(t => t.id);
    if (badGrader.length && !mine) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`grader validation failed (not consumed, not run): ${badGrader.join(", ")}`] });
    let chk = readJson(join(state, "checks.json"), null);
    if (!chk) { chk = checks ? await checks() : { pass: false, problems: ["no checks runner"] }; atomicWriteJson(join(state, "checks.json"), chk); }
    if (!chk.pass && !mine) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`candidate checks failed (not consumed, not run): ${(chk.problems ?? []).join("; ").slice(0, 300)}`] });
    let status = readJson(join(state, "independence.json"), null);
    const preflight = () => ({ preflight: "passed", batch, tasks: tasks.length, graders: tasks.length, checks: { pass: chk.pass }, independence: status, budget: (() => { const b = budget.status(); return { remaining: b.remaining, openReservations: b.openReservations, minRemaining: plan.holdout.minRemaining }; })() });
    if (preflightOnly && mine) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: true, reasons: ["preflight on a state whose batch is already used"] });
    if (!mine) {
      const s = budget.status();
      if (s.remaining < plan.holdout.minRemaining) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`request budget: ${s.remaining} attempts remain, the frozen plan needs >= ${plan.holdout.minRemaining} before the batch is consumed (not consumed, not run)`] });
      if (s.openReservations > 0) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`request budget: ${s.openReservations} open reservation(s) of another process (not consumed, not run)`] });
      status = holdoutStatus(tasks, batch, p, { orcheDir, priorFamilies });
      if (!status.independent) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`no independent holdout at the time of use (not consumed, not run): ${status.why}`] });
      if (conf) {
        // A confirmatory test: the registered plan complete at the moment of use, and its alpha spent from the shared series
        // budget BEFORE the batch is consumed (idempotent per state/purpose/binding; never refunded).
        const miss = planCompleteness(p, { base: conf.base ?? process.cwd() });
        if (miss.length) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`confirmatory plan incomplete at the time of use (not consumed, not run): ${miss.join("; ").slice(0, 300)}`] });
        if (!preflightOnly) {
          const ap = p.analysisPlan;
          const spend = spendAlpha(planPath(ap.series.ledger, conf.base ?? process.cwd()), { series: ap.series.id, alphaTotal: ap.series.alphaTotal, alpha: ap.alpha, stateDir: resolve(state), purpose: conf.purpose, bind: { protocolDigest: digest, frozenDigest: identity.frozenDigest } });
          if (spend.refused) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`series error budget (not consumed, not run): ${spend.refused}`] });
        }
      }
      if (poolDir) {
        // The pool must hand out exactly the frozen batch: checked before reserving (no stray reservation of another batch),
        // and the reservation itself must return it (an existing reservation of this state is returned unchanged on resume).
        if (!assignmentFor(poolDir, state)) {
          const pick = firstEligibleBatch(poolDir, p, { orcheDir });
          if (pick.none || resolve(pick.dir) !== resolve(batch)) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`the pool would not hand out the frozen batch (not reserved, not consumed): ${pick.none ? pick.none.join("; ") : pick.batch}`] });
        }
        if (preflightOnly) return preflight();
        const r = reserveBatch(poolDir, state, p, { orcheDir });
        if (r.none || resolve(r.dir) !== resolve(batch)) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`pool reservation did not return the frozen batch: ${r.none ? r.none.join("; ") : r.batch}`] });
      }
      if (preflightOnly) return preflight();
      atomicWriteJson(join(state, "independence.json"), status);
      ledger.append({ type: "use", stateDir: resolve(state), ...identity, purpose: conf ? `confirmatory ${conf.purpose}` : "exploration-only (never adoption)", independentBefore: status.independent, why: status.why });
      fault("holdout:after-use");
    } else if (poolDir && !assignmentFor(poolDir, state)) {
      return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: true, reasons: ["holdout use recorded but the pool reservation is missing (state integrity)"] });
    }
    const evaluator = new Evaluator({ stateDir: state, protocol: p, protocolDigest: digest, envDigest, tasksById, grading, backend, log, admission: attemptAdmission(budget, bound) });
    const harness = { stable: harnessOf("stable", plan), c1: harnessOf("c1", plan) };
    const ids = tasks.map(t => t.id).sort();
    const schedule = interleavedSchedule({ arms: ["stable", "c1"], tasks: ids, repeats: p.holdout.repeats, split: "holdout", seed: `${plan.seed}:holdout:${identity.frozenDigest}`, bind: { ...identity, seal: plan.holdout.seal, arms: [{ id: "stable", commit: harness.stable.commit }, { id: "c1", commit: identity.commit }] } });
    const stored = readJson(join(state, "holdout-schedule.json"), null);
    if (stored) { const sp = scheduleProblems(stored, schedule); if (sp.length || stored.digest !== schedule.digest) return finish({ verdict: "BLOCKED", adopt: false, holdoutEvaluated: true, reasons: ["the frozen schedule differs from the recorded one (resume refused)", ...sp] }); }
    else atomicWriteJson(join(state, "holdout-schedule.json"), schedule);
    const events = [];
    const timer = pressureWatch(pressure, evaluator, events);
    try { await evaluator.evaluateScheduled(schedule.units.map(u => ({ harness: harness[u.arm], unit: u })), HOLDOUT_CONTEXT); } finally { if (timer) clearInterval(timer); }
    if (evaluator.halted) { atomicWriteJson(join(state, "holdout-paused.json"), { halted: evaluator.halted, peerEvents: events, at: new Date().toISOString() }); return { paused: evaluator.halted, holdoutEvaluated: true }; }
    const order = executionOrder(evaluator.ledger.records(), schedule, (u) => evaluator.keyOf(harness[u.arm], u.task, u.split, u.repeat));
    const passKeys = new Set(schedule.units.map(u => evaluator.keyOf(harness[u.arm], u.task, u.split, u.repeat)));
    const records = evaluator.records();
    const incomplete = missingUnits(records, [...passKeys]);
    // Samples of this pass: its protocol digest and ONE environment, compared by digest value. (2026-11-07: the CLI passes
    // environmentDigest()'s {digest, facts} object; Evaluator.samples() compares by identity, so after the JSON round trip of the
    // ledger it matched nothing and the analysis crashed after all 36 units were measured. The unit keys depend on that object,
    // so it is kept for resume; the analysis compares envKey values instead.)
    const envOf = envKey(envDigest);
    const samples = records.filter(r => r.protocol_digest === digest && envKey(r.environment_digest) === envOf);
    const pairs = pairsOf(samples.filter(r => passKeys.has(r.unit_key)), { a: "stable", b: "c1", split: "holdout", tasks: ids, meta: tasksById });
    const cmp = adoptionCompare(pairs, p, `${plan.seed}:holdout:c1`);
    const familyCmp = familyAdoptionCompare(pairs, p, `${plan.seed}:holdout-family:c1`);
    const screenRecords = plan.screen.runs && existsSync(plan.screen.runs) ? readFileSync(plan.screen.runs, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e?.type === "result").map(e => e.record) : [];
    const critical = criticalProblems([...screenRecords, ...records], "c1", { reference: "stable" });
    const holdRecs = finalAttempts(records.filter(r => passKeys.has(r.unit_key)));
    const envs = new Set(holdRecs.map(r => envKey(r.environment_digest)));
    const routeOk = holdRecs.length > 0 && envs.size === 1 && holdRecs.every(r => r.terminal_status !== "route_violation" && r.model_route === routeKey(p.route) && r.thinking_effort === p.route.effort);
    const infraRate = holdRecs.length ? holdRecs.filter(r => ["infra_error", "model_unavailable"].includes(r.terminal_status)).length / holdRecs.length : 0;
    // chk: the arms' checks, run before consumption (checks.json).
    const ap = p.analysisPlan;
    const confirmatory = conf && !incomplete.length ? confirmatoryChecks(pairs.map(t => ({ ...t, provenance: tasksById[t.task]?.provenance })), { alpha: ap.alpha, minEffect: ap.minEffect, minTasks: ap.minTasks, minFamilies: ap.minFamilies, minHardTasks: ap.minHardTasks, lowExposure: ap.lowExposure, draws: p.bootstrap.draws, permutationDraws: ap.permutationDraws, seed: `${plan.seed}:${conf.purpose}` }) : null;
    let decision = adoptionDecision(cmp, p, { holdoutIndependent: status?.independent === true, holdoutWhy: status?.why, critical, checksPassed: chk.pass, checksDetail: chk.problems?.join("; ") || "ok", routeOk, routeDetail: `${envs.size} environment digest(s), target route ${routeKey(p.route)} (${p.route.effort})`, incomplete, infraRate, familyCmp, confirmatory });
    if (!conf && decision.adopt) throw new Error("exploratory plan produced an adopt decision (gate contract violated)");
    if (conf?.purpose === "confirmation") {
      // Independent post-adoption confirmation: CONFIRMED only when the full gate AND the confirmatory checks pass on this
      // separate batch; a gate refusal or failed check is NOT_CONFIRMED; unanswerable data is INCONCLUSIVE. Never an adoption.
      const v = decision.adopt ? "CONFIRMED" : (incomplete.length || decision.verdict === "INCONCLUSIVE") ? "INCONCLUSIVE" : decision.verdict === "BLOCKED" ? "INCONCLUSIVE" : "NOT_CONFIRMED";
      decision = { ...decision, verdict: v, adopt: false, confirmationVerdict: v };
    }
    const arm = (id) => { const rs = holdRecs.filter(r => r.candidate_id === id); return { units: rs.length, success: rs.filter(r => r.task_success).length, hiddenPass: rs.filter(r => r.hidden_test_pass).length, integrityViolations: rs.filter(r => r.integrity?.violations?.length).length, strictViolations: rs.filter(r => r.integrity?.strictTestViolations?.length).length, requests: rs.reduce((s, r) => s + (r.model_requests ?? 0), 0) }; };
    return finish({ candidate: "c1", verdict: decision.verdict, adopt: conf?.purpose === "holdout" ? decision.adopt === true : false, candidateAccepted: decision.candidateAccepted === true, reasons: decision.reasons, holdoutEvaluated: true,
      ...(confirmatory ? { confirmatory: { ok: confirmatory.ok, passed: confirmatory.passed, failed: confirmatory.failed, inconclusive: confirmatory.inconclusive, coverage: confirmatory.results.coverage } } : {}),
      evidence: evidenceLabel(p, { adopt: conf?.purpose === "holdout" && decision.adopt === true, confirmatory }),
      holdout: { batch, seal: plan.holdout.seal, tasks: cmp.tasks, families: cmp.families, hardTasks: cmp.hardTasks, support: cmp.support, familySupport: familyCmp.support, delta: cmp.delta.overall, point: cmp.point },
      arms: { stable: arm("stable"), c1: arm("c1") }, critical, incomplete: incomplete.length, execution: { scheduleDigest: schedule.digest, planned: order.planned, dispatched: order.dispatched, followsPlan: order.followsPlan, inversions: order.inversions }, independence: status, checks: chk, peerEvents: events, simulated: !!backend.simulated,
      budget: (() => { const s = budget.status(); return { charged: s.charged, attempts: s.attempts, openReservations: s.openReservations, remaining: s.remaining }; })() });
  } finally { lock.release(); }
}
