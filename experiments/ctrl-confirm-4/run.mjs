#!/usr/bin/env node
// ctrl-confirm-4 driver: the preregistered randomized, interleaved (task, repeat) x arm queue on the sealed external holdout batches
// named by prereg.json, with the loop's sandboxed runner and exactly-once evaluator ledger, plus experiment-local resource management
// (resources.mjs): per-attempt reservation before dispatch, settlement to actual usage, active-time accounting across sessions,
// strict ceilings with in-flight draining, provider-failure pauses, orphan reconciliation and a single-runner lock.
// It never proposes, selects, adopts or deploys.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/run.mjs --state DIR --launch      (confirmation: records the holdout uses, then runs)
//   node pi-eval-loop/experiments/ctrl-confirm-4/run.mjs --state DIR --smoke       (plumbing on exposed suite tasks; no holdout)
//   [--max-units N] [--auto-resume-rate-min M]
// A confirmation must be started with --launch (deliberate); resuming the same state repeats the same command. Durable form: see
// docs/ctrl-confirm-4-launch.md (systemd-run --user with RuntimeMaxSec = the campaign wall ceiling).
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Evaluator, realBackend, wireJournals } from "../../src/evaluator.mjs";
import { loadLocal, loadSuite, taskDigest, verifySeal } from "../../src/datasets.mjs";
import { validateGrader } from "../../src/grader.mjs";
import { makeRecord, retryable } from "../../src/metrics.mjs";
import { completedModelCalls, environmentDigest, hostEnvironment, prerequisites, stopProxies, wireEntries } from "../../src/sandbox.mjs";
import { UMBRELLA, evaluatorFiles, fileDigests } from "../../src/protocol.mjs";
import { atomicWriteJson, digestOf, ensureDir, sha256 } from "../../src/util.mjs";
import { INFRA, buildHarness, buildQueue, harnessIdentity, lockMismatches } from "../ctrl-ablation/lib.mjs";
import { recordHoldoutUse } from "../ctrl-confirm-2/run.mjs";
import { EXPERIMENT_DIR, loadPrereg } from "./lib.mjs";
import { ResourceManager, RunnerLock, providerFailure, recordUsage, stopOrphans, wireUsage } from "./resources.mjs";
import { RuntimeGuard, continuedLockProblems, effectiveLock, readContinuation } from "./runtime.mjs";

/** Files whose bytes define this experiment beyond src/ (this directory + reused experiment code). */
export function experimentFiles() {
  const own = ["lib.mjs", "run.mjs", "resources.mjs", "runtime.mjs", "power.mjs", "gate.mjs", "assemble.mjs", "analyze.mjs", "prereg.json", "PREREGISTRATION.md"].map(f => join(EXPERIMENT_DIR, f));
  const reused = ["ctrl-ablation/lib.mjs", "ctrl-confirm-2/lib.mjs", "ctrl-confirm-2/run.mjs", "ctrl-confirm-2/variants/OCR.diff", "ctrl-confirm-3/stats.mjs"].map(f => join(EXPERIMENT_DIR, "..", f));
  return [...own, ...reused].map(f => resolve(f)).filter(existsSync).sort();
}

/** Evaluator files outside this package's src/ (loaded from the orche working tree by every attempt: proxy, bridge, ...). */
export const reusedEvaluatorFiles = () => evaluatorFiles().filter(f => !f.startsWith(resolve(EXPERIMENT_DIR, "../../src") + "/"));

export const instructionOf = (task, prereg) => `${task.instruction.replace(/\s+$/, "")}\n\n${prereg.integrityContract}`;

export function harnessOf(arm, prereg, built) {
  const h = { id: arm.id, kind: arm.kind, commit: harnessIdentity(arm, prereg, EXPERIMENT_DIR) };
  if (arm.kind === "orche") Object.assign(h, { dir: built.dir, mode: arm.mode });
  if (arm.appendSystemPrompt) h.appendSystemPrompt = prereg[arm.appendSystemPrompt];
  return h;
}

/** Tasks: smoke = exposed suite tasks; confirmation = the selected tasks of the sealed batches named by the preregistration. */
export function loadTasks({ prereg, smoke, orcheDir, datasetsRoot = resolve(UMBRELLA, "results") }) {
  if (smoke) {
    const tasks = loadSuite(join(orcheDir, "fixtures/suite")).filter(t => prereg.smoke.tasks.includes(t.id));
    if (tasks.length !== prereg.smoke.tasks.length) throw new Error("smoke tasks missing");
    return { tasks, seals: null, batches: [] };
  }
  const tasks = [], seals = {}, batches = [];
  for (const b of prereg.holdout.batches) {
    const dir = resolve(datasetsRoot, b.path);
    const seal = verifySeal(dir);
    if (!seal.ok) throw new Error(`holdout seal ${b.path}: ${seal.why}`);
    if (seal.seal.digest !== b.sealDigest) throw new Error(`holdout seal ${seal.seal.digest} of ${b.path} is not the preregistered ${b.sealDigest}`);
    seals[b.path] = seal.seal.digest; batches.push(dir);
    const want = new Set(prereg.holdout.taskIds);
    tasks.push(...loadLocal(dir).filter(t => want.has(t.id)));
  }
  const ids = tasks.map(t => t.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...prereg.holdout.taskIds].sort())) throw new Error("holdout tasks differ from the preregistered selection");
  const bad = tasks.filter(t => t.provenance !== "external" || !t.hidden);
  if (bad.length) throw new Error(`holdout tasks without external provenance or hidden tests: ${bad.map(t => t.id).join(", ")}`);
  return { tasks, seals, batches };
}

/** @param {{ stateDir: string, prereg: any, smoke?: boolean, orcheDir?: string, env?: any, validate?: any, envDigest?: string, datasetsRoot?: string }} o */
export async function prepare({ stateDir, prereg, smoke = false, orcheDir = join(UMBRELLA, "orche"), env = hostEnvironment(), validate = validateGrader, envDigest = undefined, datasetsRoot }) {
  const { tasks, seals, batches } = loadTasks({ prereg, smoke, orcheDir, datasetsRoot });
  const tasksById = Object.fromEntries(tasks.map(t => [t.id, { ...t, instruction: instructionOf(t, prereg) }]));
  const harness = {}, harnessDigests = {};
  for (const arm of prereg.arms) {
    const built = arm.kind === "orche" ? buildHarness(arm, prereg, { stateDir, orcheDir, experimentDir: EXPERIMENT_DIR }) : undefined;
    harness[arm.id] = harnessOf(arm, prereg, built);
    harnessDigests[arm.id] = { identity: harness[arm.id].commit, tree: built?.digest ?? null };
  }
  const gradingPath = join(stateDir, "grading.json");
  const grading = existsSync(gradingPath) ? JSON.parse(readFileSync(gradingPath, "utf8")) : {};
  for (const t of tasks) if (!grading[t.id]) { grading[t.id] = await validate({ task: t, scratch: join(stateDir, "tmp", `grading-${t.id}`), env }); atomicWriteJson(gradingPath, grading); }
  const bad = tasks.filter(t => !grading[t.id].ok);
  if (bad.length) throw new Error(`grader validation failed: ${bad.map(t => `${t.id}: ${grading[t.id].problems.join("; ")}`).join(" | ")}`);
  const queue = buildQueue({ arms: prereg.arms.map(a => a.id), tasks: tasks.map(t => t.id), repeats: smoke ? prereg.smoke.repeats : prereg.repeats, seed: `${prereg.seed}${smoke ? ":smoke" : ""}` });
  const lock = {
    experiment: prereg.id, smoke, preregDigest: digestOf(prereg), envDigest: envDigest ?? environmentDigest(env, prereg.route).digest, queueDigest: digestOf(queue),
    files: fileDigests([...evaluatorFiles(orcheDir), ...experimentFiles()]), harness: harnessDigests,
    tasks: Object.fromEntries(tasks.map(t => [t.id, taskDigest(t)])), instructions: Object.fromEntries(tasks.map(t => [t.id, sha256(tasksById[t.id].instruction)])),
    grading: Object.fromEntries(tasks.map(t => [t.id, { expected: grading[t.id].expected, baselineFailing: grading[t.id].baselineFailing }])),
    holdoutSeals: seals,
  };
  return { tasksById, harness, grading, queue, lock, batches };
}

export function lockState(stateDir, lock, queue) {
  const path = join(stateDir, "lock.json");
  if (!existsSync(path)) {
    if (readContinuation(stateDir)) throw new Error("a continuation exists without its lock.json");
    const { runtime, ...first } = lock;
    writeFileSync(join(stateDir, "queue.json"), JSON.stringify(queue, null, 1)); atomicWriteJson(path, { ...first, ...(runtime ? { runtime } : {}), lockedAt: new Date().toISOString() }); return JSON.parse(readFileSync(path, "utf8"));
  }
  const recorded = JSON.parse(readFileSync(path, "utf8"));
  const eff = effectiveLock(stateDir, recorded);
  if (eff.problems.length) throw new Error(`continuation damaged: ${eff.problems.join("; ")}`);
  // A3: a continued state compares frozen fields with the ORIGINAL lock and the environment / files / runtime with the latest
  // continuation version (runtime.mjs); an un-continued state keeps the original comparison (+ a recorded runtime, if any).
  const problems = eff.version > 0 ? continuedLockProblems(recorded, eff.lock, lock, eff.version) : lockMismatches(recorded, lock);
  if (eff.version === 0 && recorded.runtime && recorded.runtime.manifestDigest !== lock.runtime?.manifestDigest) problems.push("runtime snapshot changed");
  for (const id of new Set([...Object.keys(recorded.instructions ?? {}), ...Object.keys(lock.instructions ?? {})])) if (recorded.instructions?.[id] !== lock.instructions?.[id]) problems.push(`instructions.${id} changed`);
  if (JSON.stringify(recorded.holdoutSeals ?? null) !== JSON.stringify(lock.holdoutSeals ?? null)) problems.push("holdoutSeals changed");
  if (problems.length) throw new Error(`lock mismatch (a changed experiment needs a new state directory or a validated continuation): ${[...new Set(problems)].join("; ")}`);
  return { ...eff.lock, continuation: eff.version };
}

/**
 * Attempt policy (outcome-independent): another attempt is allowed only after an attempt with ZERO completed model calls and an
 * infrastructure status (at most maxRetries such attempts), or after a provider credit/auth/rate failure (at most
 * maxProviderRetries; these never count against maxRetries). Everything else is final.
 */
export function attemptPolicy(results, { maxRetries, maxProviderRetries }) {
  const last = results.at(-1);
  if (!last) return "dispatch";
  if (providerFailure(last)) return results.filter(r => providerFailure(r)).length <= maxProviderRetries ? "retry" : "final";
  if (retryable(last)) return results.filter(r => retryable(r) && !providerFailure(r)).length <= maxRetries ? "retry" : "final";
  return "final";
}

/** Evaluator with per-attempt reservations, settlement, wire preservation and orphan reconciliation (src/ unchanged). */
export class ResourceEvaluator extends Evaluator {
  /** @param {any} options */
  constructor({ rm, policy, orphanGraceMs = 5000, guard = null, ...opts }) {
    super(/** @type {any} */ (opts));
    /** @type {ResourceManager} */ this.rm = rm;
    /** @type {any} */ this.policy = policy;
    /** @type {number} */ this.orphanGraceMs = orphanGraceMs;
    /** A3: runtime identity guard ({ id, check(): string | null }); null = no frozen runtime (smoke/tests without a snapshot). */
    /** @type {any} */ this.guard = guard;
  }
  /** A3: a runtime identity change holds the campaign (operator decision) and is recorded in the resource ledger. */
  runtimeDrift(phase, unitKey, attemptId, detail) {
    this.rm.log({ type: "runtime-drift", phase, unitKey, attemptId, detail });
    if (!this.rm.paused) this.rm.pause(`runtime identity changed (${phase}): ${detail}`, "runtime");
  }
  results(key) { return this.ledger.records().filter(r => r.unit_key === key && r.type === "result").map(r => r.record); }
  policyOf(key) { return attemptPolicy(this.results(key), this.policy); }
  attemptIdOf(dispatch) { return dispatch.attemptId ?? `${dispatch.unit_key}:a${dispatch.attempt}`; }

  /** Usage of an attempt: the proxy wire journals under controlDir when present (primary measurement), else the record. */
  /** @returns {{ usage: any, source: string, unknownUsageRequests?: number } | null} */
  usageOf(controlDir, record) {
    const files = controlDir ? wireJournals(controlDir) : [];
    if (files.length) return { ...wireUsage(files.flatMap(wireEntries), this.policy), source: "wire" };
    if (record) return { usage: recordUsage(record, this.policy.pricing), source: "record" };
    return null;
  }

  /** Crash recovery for one dispatch without result: stop survivors, keep the wire evidence, record the failure, settle. */
  async reconcileOrphan(dispatch) {
    const stopped = dispatch.controlDir ? await stopOrphans(dispatch.controlDir, { graceMs: this.orphanGraceMs }) : [];
    const keep = join(this.stateDir, "evidence", "orphans", dispatch.run_id);
    for (const f of dispatch.controlDir ? wireJournals(dispatch.controlDir) : []) cpSync(f, join(keep, f.slice(dispatch.controlDir.length + 1)), { force: true });
    const measured = this.usageOf(dispatch.controlDir, null);
    const record = this.reconcile(dispatch);
    const id = this.attemptIdOf(dispatch);
    if (measured) this.rm.settle(id, { ...measured.usage }, "orphan-wire", { unknownUsageRequests: measured.unknownUsageRequests, stoppedProcesses: stopped.length });
    else this.rm.settle(id, { ...this.rm.reserveVec }, "orphan-conservative-full-reservation", { note: "no wire journal survived: the whole reservation is charged", stoppedProcesses: stopped.length });
    return record;
  }

  /** Evidence directory of one attempt (same naming as runOne). */
  evidenceOf(d) { return join(this.stateDir, "evidence", d.harness.id, `${d.split}-${d.task}-r${d.repeat}-a${d.attempt}-${d.unit_key.slice(0, 8)}`); }

  /**
   * Usage of an attempt whose result was recorded but whose reservation was not settled (crash between the two writes): the wire
   * journals are the primary measurement (control directory if it survived, else the controller-wire copy kept with the
   * evidence BEFORE the result was written), the record only when no wire journal exists (A2 hardening: a controller-error record
   * carries no token counts, so the record alone would under-charge).
   */
  recordedUsageOf(d, record) {
    if (d.controlDir && wireJournals(d.controlDir).length) return this.usageOf(d.controlDir, record);
    const kept = join(this.evidenceOf(d), "controller-wire");
    if (wireJournals(kept).length) return { ...this.usageOf(kept, record), source: "evidence-wire" };
    return this.usageOf(null, record);
  }

  /** Startup: reconcile every dispatch without result, then settle reservations whose attempt was never dispatched or already recorded. */
  async reconcileAll() {
    const recs = this.ledger.records();
    const dispatches = recs.filter(r => r.type === "dispatch");
    const done = new Set(recs.filter(r => r.type === "result").map(r => `${r.unit_key}:a${r.record.attempt}`));
    for (const d of dispatches) if (!done.has(`${d.unit_key}:a${d.attempt}`)) await this.reconcileOrphan(d);
    for (const [id, res] of this.rm.state().open) {
      const d = dispatches.find(x => this.attemptIdOf(x) === id);
      if (!d) { this.rm.settle(id, { requests: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, costUsd: 0 }, "not-dispatched", { note: "reservation written, dispatch never recorded: the backend never started" }); continue; }
      const r = this.results(d.unit_key).find(x => x.attempt === d.attempt);
      const m = r ? this.recordedUsageOf(d, r) : null;
      this.rm.settle(id, m ? m.usage : { ...res.amount }, m ? `result-reconciled-${m.source}` : "conservative-full-reservation", { unknownUsageRequests: m?.unknownUsageRequests ?? 0 });
      if (d.controlDir) rmSync(d.controlDir, { recursive: true, force: true });
    }
  }

  async runOne(harness, unit, context) {
    if (this.inflight.has(unit.key)) throw new Error(`unit ${unit.key} is already running (duplicate execution refused)`);
    this.inflight.add(unit.key);
    try {
      for (const d of this.unitState(unit.key).pending) await this.reconcileOrphan(d);
      while (true) {
        const state = this.unitState(unit.key);
        if (this.policyOf(unit.key) === "final") return state.last;
        const attempt = state.attempts + 1, attemptId = `${unit.key}:a${attempt}`;
        // A3: the frozen runtime is re-verified immediately before every dispatch; a change holds the campaign (nothing reserved).
        const before = this.guard?.check() ?? null;
        if (before) { this.runtimeDrift("pre-dispatch", unit.key, attemptId, before); return state.last; }
        // Admission + reservation are synchronous: no other worker can interleave between the check and the reservation.
        if (!this.rm.reserve(attemptId, { unitKey: unit.key, arm: harness.id, task: unit.task, repeat: unit.repeat, attempt })) return state.last; // refused/paused: unit stays unsettled
        const runId = `${harness.id}-${unit.task}-${unit.split}-r${unit.repeat}-a${attempt}-${unit.key.slice(0, 8)}`;
        const controlDir = mkdtempSync(join(tmpdir(), "el4-"));
        const evidence = join(this.stateDir, "evidence", harness.id, `${unit.split}-${unit.task}-r${unit.repeat}-a${attempt}-${unit.key.slice(0, 8)}`);
        this.ledger.append({ type: "dispatch", unit_key: unit.key, attempt, attemptId, run_id: runId, controlDir, harness: { id: harness.id, kind: harness.kind, commit: harness.commit ?? null, mode: harness.mode ?? null }, task: unit.task, split: unit.split, repeat: unit.repeat, context, simulated: !!this.backend.simulated, ...(this.guard ? { runtime: this.guard.id } : {}) });
        let record;
        try {
          record = await this.backend.run({ harness, task: this.tasksById[unit.task], repeat: unit.repeat, split: unit.split, context, protocol: this.protocol, protocolDigest: this.protocolDigest, envDigest: this.envDigest, scratch: join(controlDir, "scratch"), controlDir, evidence, attempt, unitKey: unit.key, runId, grading: this.grading[unit.task] });
        } catch (error) {
          const completed = completedModelCalls(wireJournals(controlDir).flatMap(wireEntries));
          record = makeRecord({ run_id: runId, unit_key: unit.key, attempt, candidate_id: harness.id, harness_kind: harness.kind, harness_commit: harness.commit, mode: harness.mode, task_id: unit.task, split: unit.split, family: this.tasksById[unit.task]?.family, hard: this.tasksById[unit.task]?.hard, repeat: unit.repeat, context,
            model_route: `${this.protocol.route.provider}/${this.protocol.route.model}`, thinking_effort: this.protocol.route.effort, environment_digest: this.envDigest, protocol_digest: this.protocolDigest,
            terminal_status: completed > 0 ? "aborted" : "infra_error", terminal_detail: `controller error: ${String(error?.message ?? error).slice(0, 300)}`, model_requests_completed: completed, started_at: new Date().toISOString(), simulated: !!this.backend.simulated });
        }
        record.attempt = attempt; record.unit_key = unit.key;
        // A3: verified again after the attempt, before its outcome is recorded. A change during the attempt is recorded WITH the
        // attempt (the outcome is kept, never dropped or re-run) and holds the campaign for an operator decision.
        const after = this.guard ? this.guard.check() : null;
        if (this.guard) record.runtime = { id: this.guard.id, verifiedAfter: after === null, ...(after ? { drift: after } : {}) };
        if (after) this.runtimeDrift("mid-unit", unit.key, attemptId, after);
        const measured = this.usageOf(controlDir, record);
        // Wire evidence is kept with the attempt before the control directory is removed (the runner also copies it on success).
        for (const f of wireJournals(controlDir)) cpSync(f, join(evidence, "controller-wire", f.slice(controlDir.length + 1)), { force: true });
        this.ledger.append({ type: "result", unit_key: unit.key, record });
        this.rm.settle(attemptId, measured.usage, measured.source, { unknownUsageRequests: measured.unknownUsageRequests ?? 0 });
        const pf = providerFailure(record);
        if (pf && !this.rm.paused) this.rm.pause(`provider ${pf} failure in ${runId}: ${String(record.terminal_detail ?? "").slice(0, 160)}`, pf);
        if (record.terminal_status === "route_violation" && !this.rm.paused) this.rm.pause(`route violation in ${runId}`, "route");
        this.log(`${harness.id} ${unit.split}/${unit.task}#${unit.repeat} a${attempt}: ${record.terminal_status}`);
        rmSync(controlDir, { recursive: true, force: true });
      }
    } finally { this.inflight.delete(unit.key); }
  }
}

/** Units of the frozen queue that still need an attempt under the attempt policy. */
export const unsettled = (queue, evaluator, harness, split) => queue.filter(u => evaluator.policyOf(evaluator.keyOf(harness[u.arm], u.task, split, u.repeat)) !== "final");

/**
 * Run the frozen queue under the resource manager. Dispatch stops (never decides) on a ceiling, a provider failure, a route
 * violation, repeated infrastructure failures or --max-units; attempts in flight drain and are recorded. A ceiling reached ends the
 * campaign: missing units are failures in the analysis (no extension, no sample expansion). Rate-limit pauses may auto-resume after
 * a fixed wait (idle time is not active time); credit/auth/route pauses need an operator resume (same command).
 */
export async function runCampaign({ stateDir, prereg, prepared, backend, rm, log = (l) => process.stderr.write(`${l}\n`), maxUnits = Infinity, resume = "", autoResumeRateMs = 0, maxAutoResumes = 6, sleep = (ms) => new Promise(r => setTimeout(r, ms)), orphanGraceMs = 5000, guard = null }) {
  const { tasksById, harness, grading, queue, lock } = prepared;
  const protocol = { route: prereg.route, unit: prereg.unit, infra: prereg.infra, parallelism: prereg.parallelism, capture: prereg.capture, integrity: prereg.integrity };
  const split = lock.smoke ? "smoke" : "confirmation";
  const policy = { maxRetries: prereg.infra.maxRetries, maxProviderRetries: prereg.infra.maxProviderRetries, pricing: prereg.pricing, unknownRequest: prereg.resources.unknownUsageRequestCharge };
  const evaluator = new ResourceEvaluator({ rm, policy, orphanGraceMs, guard, stateDir, protocol, protocolDigest: lock.preregDigest, envDigest: lock.envDigest, tasksById, grading, backend, log });
  await evaluator.reconcileAll();
  const campaignPath = join(stateDir, "campaign.json");
  const campaign = existsSync(campaignPath) ? JSON.parse(readFileSync(campaignPath, "utf8")) : {};
  campaign.startedAt ??= new Date().toISOString();
  let ran = 0, consecutiveInfra = 0, autoResumes = 0;
  const checkpoint = () => {
    const records = evaluator.records();
    const left = unsettled(queue, evaluator, harness, split).length;
    Object.assign(campaign, { experiment: prereg.id, split, preregDigest: lock.preregDigest, queueDigest: lock.queueDigest, total: queue.length, done: queue.length - left, unsettled: left, terminal: records.reduce((m, r) => ({ ...m, [r.terminal_status]: (m[r.terminal_status] ?? 0) + 1 }), {}), resources: rm.snapshot(prereg.resources.planned), updatedAt: new Date().toISOString(), resume });
    atomicWriteJson(campaignPath, campaign);
  };
  checkpoint();
  while (true) {
    const pending = unsettled(queue, evaluator, harness, split).map(u => ({ ...u, split, key: evaluator.keyOf(harness[u.arm], u.task, split, u.repeat) }));
    let next = 0;
    const worker = async () => {
      while (next < pending.length && !rm.paused) {
        if (ran >= maxUnits) { rm.pause("max-units", "operator"); break; }
        const u = pending[next++];
        ran++;
        const record = await evaluator.runOne(harness[u.arm], u, `${prereg.id}:${split}`);
        if (record) consecutiveInfra = INFRA.has(record.terminal_status) ? consecutiveInfra + 1 : 0;
        if (consecutiveInfra >= prereg.budget.maxConsecutiveInfra && !rm.paused) rm.pause(`${consecutiveInfra} consecutive infrastructure failures`, "infra");
        checkpoint();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(prereg.parallelism, pending.length)) }, worker));
    checkpoint();
    if (rm.paused?.kind === "rate" && autoResumeRateMs > 0 && autoResumes < maxAutoResumes && unsettled(queue, evaluator, harness, split).length) {
      autoResumes++; log(`rate-limit pause: waiting ${Math.round(autoResumeRateMs / 60000)} min (auto-resume ${autoResumes}/${maxAutoResumes})`);
      await sleep(autoResumeRateMs); rm.resume(`automatic resume ${autoResumes} after a rate-limit pause`); continue;
    }
    break;
  }
  const summary = { ran, total: queue.length, done: campaign.done, unsettled: campaign.unsettled, paused: rm.paused, resources: rm.snapshot(), at: new Date().toISOString() };
  campaign.invocations = [...(campaign.invocations ?? []), { ...summary, resources: undefined }];
  atomicWriteJson(campaignPath, campaign);
  return summary;
}

/** A confirmation launch needs a passed gate bound to THIS preregistration and to sealed batches with zero uses (null = allowed). */
export function launchRefusal(prereg, gatePath) {
  if (!existsSync(gatePath)) return `no gate record at ${gatePath}`;
  const g = JSON.parse(readFileSync(gatePath, "utf8"));
  if (g.launch !== true) return `the feasibility gate did not pass (${Object.entries(g.checks ?? {}).filter(([, c]) => !c.pass).map(([k]) => k).join(", ")})`;
  if (g.bindings?.preregDigest !== digestOf(prereg)) return "the gate was evaluated for another preregistration digest";
  if (!prereg.holdout.batches.length || !prereg.holdout.taskIds.length) return "the preregistration names no sealed batches / selected tasks";
  for (const b of prereg.holdout.batches) if (!(g.bindings.batches ?? []).some(x => x.sealDigest === b.sealDigest && x.uses === 0)) return `batch ${b.path} is not bound (fresh) by the gate`;
  return null;
}

export function resourceManagerOf(stateDir, prereg, opts = {}) {
  const attemptTimeBoundMs = prereg.unit.wallMs + prereg.unit.graderMs + prereg.resources.attemptSetupMs;
  return new ResourceManager({ stateDir, budget: prereg.budget, reserve: prereg.resources.reservePerAttempt, pricing: prereg.pricing, attemptTimeBoundMs, heartbeatMs: prereg.resources.heartbeatMs, overrunSlots: prereg.parallelism, ...opts });
}

/** Pause kinds that survive a restart until an operator resumes (A2: a service restart must not bypass them; A3: + runtime). */
export const HELD_PAUSES = new Set(["credit", "auth", "route", "infra", "operator", "runtime"]);

/** null = may dispatch; else the unresolved pause that holds this invocation (resolved only by --operator-resume). */
export function heldPause(rm, operatorResume) {
  const p = rm.state().pause;
  if (!p || !HELD_PAUSES.has(p.kind)) return null;
  if (operatorResume) { rm.resume(`operator resume (--operator-resume) of the ${p.kind} pause at ${p.at}: ${String(p.reason).slice(0, 160)}`); return null; }
  return p;
}

/** The campaign is final when every unit is settled or a ceiling ended it (cap pauses are never resumed). */
export const isFinal = (summary) => summary.unsettled === 0 || summary.paused?.kind === "cap";

async function main() {
  const { values } = parseArgs({ options: { state: { type: "string" }, smoke: { type: "boolean", default: false }, launch: { type: "boolean", default: false }, "max-units": { type: "string" }, prereg: { type: "string" }, "auto-resume-rate-min": { type: "string", default: "15" }, gate: { type: "string" }, "operator-resume": { type: "boolean", default: false } } });
  if (!values.state || values.smoke === values.launch) { process.stderr.write("usage: run.mjs --state DIR (--launch | --smoke) [--operator-resume] [--max-units N] [--auto-resume-rate-min M]\n"); process.exit(64); }
  const stateDir = ensureDir(resolve(values.state));
  const prereg = loadPrereg(values.prereg);
  if (!values.smoke) { const why = launchRefusal(prereg, values.gate ?? join(EXPERIMENT_DIR, "../../records/ctrl-confirm-4/plan/gate.json")); if (why) { process.stderr.write(`BLOCKED: ${why}\n`); process.exit(2); } }
  const lockFile = RunnerLock.acquire(stateDir);
  const env = hostEnvironment();
  const missing = (await prerequisites(env)).filter(p => !p.ok);
  if (missing.length) { lockFile.release(); process.stderr.write(`BLOCKED: missing prerequisites ${missing.map(m => m.name).join(", ")}\n`); process.exit(2); }
  const blocked = (why) => { lockFile.release(); process.stderr.write(`BLOCKED: ${why}\n`); process.exit(2); };
  // A3: frozen runtime. A continued state REQUIRES the snapshot its latest continuation binds; the snapshot is fully verified here
  // (content, read-only, no escaping link, every runtime path of this process inside it) and re-checked before every dispatch.
  const runtimeRoot = process.env.EVAL_LOOP_RUNTIME ? resolve(process.env.EVAL_LOOP_RUNTIME) : null;
  const cont = readContinuation(stateDir);
  if (cont && !runtimeRoot) blocked("this state was continued on a frozen runtime snapshot: set EVAL_LOOP_RUNTIME and the snapshot paths (runtime.mjs envFor)");
  let guard = null;
  if (runtimeRoot) {
    try { guard = new RuntimeGuard({ root: runtimeRoot, manifestDigest: cont?.versions.at(-1)?.binding.runtime?.manifestDigest, extraFiles: reusedEvaluatorFiles() }); } catch (error) { blocked(`runtime snapshot unreadable: ${error.message}`); }
    const problems = guard.start(env);
    if (problems.length) blocked(`runtime snapshot invalid: ${problems.join("; ")}`);
  }
  const prepared = await prepare({ stateDir, prereg, smoke: Boolean(values.smoke), env, datasetsRoot: undefined });
  if (guard) prepared.lock.runtime = { root: guard.root, manifestDigest: guard.manifestDigest };
  let lock;
  try { lock = lockState(stateDir, prepared.lock, prepared.queue); } catch (error) { blocked(String(error.message ?? error)); }
  if (guard) for (const h of Object.values(prepared.harness)) if (h.dir) guard.watchTree(h.dir);
  if (!values.smoke) for (const dir of prepared.batches) { const u = recordHoldoutUse(dir, { stateDir, experiment: prereg.id, preregDigest: lock.preregDigest, seal: lock.holdoutSeals[Object.keys(lock.holdoutSeals).find(k => dir.endsWith(k))] }); process.stderr.write(`holdout use of ${dir} ${u.reused ? "already recorded" : "recorded"} at ${u.use.at}\n`); }
  const rm = resourceManagerOf(stateDir, prereg);
  const held = heldPause(rm, values["operator-resume"]);
  if (held) {
    lockFile.release();
    process.stderr.write(`HELD: unresolved ${held.kind} pause (${held.at}): ${held.reason}. Fix the cause, then resume with --operator-resume (docs/ctrl-confirm-4-launch.md §4).\n`);
    process.stdout.write(`${JSON.stringify({ held })}\n`);
    return;
  }
  const resume = `node pi-eval-loop/experiments/ctrl-confirm-4/run.mjs --state ${stateDir} ${values.smoke ? "--smoke" : "--launch"}`;
  rm.startSession({ command: resume });
  // A3: SIGUSR1 = graceful drain (nothing new is dispatched, in-flight attempts finish and are recorded, then the runner exits held).
  // SIGTERM/SIGINT/SIGHUP stop at once (in-flight attempts become orphans that the next start reconciles) and also leave the state
  // held, so no automatic restart continues after an interruption.
  process.on("SIGUSR1", () => { if (!rm.paused) rm.pause("operator drain (SIGUSR1): nothing new is dispatched, in-flight attempts finish", "operator"); process.stderr.write("drain requested (SIGUSR1)\n"); });
  const onSignal = (signal) => { stopProxies("SIGTERM"); try { if (!rm.paused) rm.pause(`interrupted by ${signal}`, "operator"); rm.log({ type: "active-end", reason: `signal ${signal}` }); rm.endSession(`signal ${signal}`); } catch { /* best effort */ } lockFile.release(); process.stderr.write(`interrupted by ${signal}\n`); process.exit(130); };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, onSignal);
  const summary = await runCampaign({ stateDir, prereg, prepared: { ...prepared, lock }, backend: realBackend(env), rm, guard, maxUnits: values["max-units"] ? Number(values["max-units"]) : Infinity, resume, autoResumeRateMs: Number(values["auto-resume-rate-min"]) * 60_000 });
  rm.endSession(summary.paused ? `paused: ${summary.paused.reason}` : "queue settled");
  lockFile.release();
  if (isFinal(summary)) {
    // Completion: the frozen analysis + audit run once, deterministically, from the durable ledgers (never a decision to adopt).
    const final = { at: new Date().toISOString(), smoke: Boolean(values.smoke), reason: summary.unsettled === 0 ? "queue settled" : `ceiling: ${summary.paused?.reason}`, summary };
    atomicWriteJson(join(stateDir, "FINAL.json"), final);
    if (!values.smoke) {
      const { analyzeState } = await import("./analyze.mjs");
      try { const a = await analyzeState(stateDir, prereg); process.stderr.write(`analysis written: H1 ${a.primary.H1.decision.verdict}, complete ${a.complete}, audit ok ${a.audit.ok}\n`); }
      catch (error) { atomicWriteJson(join(stateDir, "analysis-error.json"), { at: new Date().toISOString(), error: String(error?.stack ?? error) }); process.stderr.write(`analysis failed: ${error}\n`); }
    }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { stopProxies("SIGTERM"); process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
