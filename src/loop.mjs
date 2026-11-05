// The persistent, resumable optimization loop (one cycle):
//   prepare (protocol lock, prerequisites, grader validation, family-grouped splits, sealed holdout)
//   -> baselines (stable orche on train+dev; pure Pi, target mode, k independent attempts on dev)
//   -> search: select parent -> failure analysis -> candidate patch (isolated worktree) -> patch/build checks -> screening
//      (matched repeats, adaptive) -> development -> archive / Pareto front -> watchdog
//   -> final selection (development) -> holdout (once) -> adoption gate -> adopt (local refs) / keep stable -> post-adoption check
// Every step is recorded on disk; a crash resumes at the recorded phase and reuses completed units. A BLOCKED state keeps the phase
// it interrupted (blocked.resumePhase) and resumes there once the cause clears; a HALTED state (trust boundary or state integrity)
// is terminal for its state directory: nothing explores, selects, consumes the holdout or adopts again.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Archive, patchKey, pointDesc, pointGt, selectParent } from "./archive.mjs";
import { analyze } from "./analysis.mjs";
import { Deployer } from "./deploy.mjs";
import { Evaluator } from "./evaluator.mjs";
import { adoptionCompare, adoptionDecision, criticalProblems, developmentCompare, developmentDecision, screeningCompare, screeningDecision, taskLevelPromotion } from "./gate.mjs";
import { changedProtected, patchIntegrity, protectedSnapshot } from "./integrity.mjs";
import { finalAttempts, missingUnits, pairsOf, summarize } from "./metrics.mjs";
import { bindingOf, evaluatorFiles, fileDigests, lockProtocol, PACKAGE_DIR, StateIntegrityError, UMBRELLA } from "./protocol.mjs";
import { inspectState, POOL_EMPTY, POOL_UNUSABLE } from "./contract.mjs";
import { createRng } from "./rng.mjs";
import { describeArm } from "./stats.mjs";
import { holdoutHard, holdoutLedger, holdoutStatus, loadLocal, loadSuite, screeningBatch, splitByFamily, taskDigest, validateSplits, verifySeal } from "./datasets.mjs";
import { assignmentFor, reserveBatch } from "./supply.mjs";
import { atomicWriteJson, digestOf, ensureDir, Ledger, LockBusyError, readJson, sha256 } from "./util.mjs";
import { changes, commit as commitWorktree, createWorktree, head, snapshotWorktree } from "./worktree.mjs";
import { writeEvidence } from "./proposer.mjs";
import { compareChecks } from "./checks.mjs";

export const PHASES = ["prepare", "baselines", "search", "select", "holdout", "adopt", "post-adopt", "done", "blocked"];
/** Arms that measure the stable harness: their samples count only for the current stable commit (an adoption changes it). */
const STABLE_ARMS = new Set(["stable", "stable-default-mode"]);
/** Phases whose comparisons pair new runs with samples recorded earlier in the cycle (they cannot mix environments). */
const ENV_BOUND_PHASES = new Set(["search", "holdout"]);
/** Phases before the selection is frozen: the holdout preflight applies only here. */
const PRE_HOLDOUT_PHASES = new Set(["prepare", "baselines", "search", "select"]);

/** Refusal to act on a halted state directory (trust-boundary breach or state-integrity violation; terminal, never auto-cleared). */
export class HaltedError extends Error {
  /** @param {string} reason @param {string} action */
  constructor(reason, action) { super(`state is HALTED (${reason}); refusing ${action}`); this.code = "EHALTED"; this.reason = reason; }
}

const LEGACY_BLOCKED = "blocked state without a recorded resume phase after selection/holdout/adoption (older format): resuming could repeat a decided cycle; continue in a new state directory";
/** Resume phase of an older blocked state that did not record one: only states without any decision of the cycle may restart at prepare. */
function legacyResumePhase(state) {
  const decided = state.selection || state.final || state.holdoutUse || state.adoption || state.cycleFingerprint;
  return decided ? undefined : "prepare";
}

/**
 * @typedef {object} LoopOptions
 * @property {string} stateDir state directory of this trajectory
 * @property {any} protocol resolved protocol (DEFAULT_PROTOCOL merged with overrides)
 * @property {{ run(input: any): Promise<any>, simulated?: boolean }} [backend] task-run backend (real Pi or simulated)
 * @property {Record<string, string>} [env] environment for proposer sessions
 * @property {string} [envDigest] digest of the pinned task environment
 * @property {{ kind?: string, propose(input: any): Promise<any> }} [proposer] candidate proposer
 * @property {"pareto" | "greedy"} [strategy] Pareto loop (C) or quality-only greedy loop (B)
 * @property {(worktree: string, which?: string[], logDir?: string) => Promise<any>} [checks] harness checks of a candidate worktree
 * @property {() => Promise<Array<{ name: string, ok: boolean, detail?: string }>>} [prerequisites] environment prerequisites
 * @property {{ tasks: any[], holdoutDir?: string, holdoutTasks?: any[] }} [datasets] injected datasets (tests; without holdoutTasks the holdout comes from the protocol path)
 * @property {(dir: string) => any} [validateGrader] grader validation hook
 * @property {string} [umbrella] umbrella repository root
 * @property {string} [orche] orche repository (target harness)
 * @property {(line: string) => void} [log] progress log
 * @property {string} [holdoutLedgerPath] holdout use ledger (defaults to the holdout directory)
 * @property {string} [idPrefix] candidate id prefix (A/B/C trajectories)
 * @property {string} [stopBefore] phase at which runCycle returns (A/B/C freezing, tests)
 * @property {any} [fault] fault injection for deployment tests
 * @property {{ halted?: { stateDir: string, reason: string } | null }} [haltGroup] shared by sibling trajectories (A/B/C): one halt stops all
 */

export class Loop {
  /** @type {string} */ stateDir;
  /** @type {any} */ protocol;
  /** @type {LoopOptions["backend"]} */ backend;
  /** @type {LoopOptions["env"]} */ env;
  /** @type {string | undefined} */ envDigest;
  /** @type {LoopOptions["proposer"]} */ proposer;
  /** @type {"pareto" | "greedy"} */ strategy;
  /** @type {LoopOptions["checks"]} */ checks;
  /** @type {LoopOptions["prerequisites"]} */ prerequisites;
  /** @type {LoopOptions["datasets"]} */ datasets;
  /** @type {LoopOptions["validateGrader"]} */ validateGrader;
  /** @type {string} */ umbrella;
  /** @type {string} */ orche;
  /** @type {(line: string) => void} */ log;
  /** @type {string | undefined} */ holdoutLedgerPath;
  /** @type {string | undefined} */ idPrefix;
  /** @type {string | undefined} */ stopBefore;
  /** @type {any} */ fault;
  /** @type {LoopOptions["haltGroup"]} */ haltGroup;
  /** @type {any} */ _state;

  /** @param {LoopOptions} opts */
  constructor(opts) {
    Object.assign(this, opts);
    this.strategy ??= "pareto";
    this.umbrella ??= UMBRELLA;
    this.orche ??= join(this.umbrella, "orche");
    this.log ??= (line) => process.stderr.write(`[eval-loop] ${line}\n`);
    ensureDir(this.stateDir);
    this.events = new Ledger(join(this.stateDir, "events.jsonl"));
    this.archive = new Archive(this.stateDir);
    this.deployer = new Deployer({ umbrella: this.umbrella, stateDir: this.stateDir, branch: this.protocol.deploy.branch, mode: this.protocol.deploy.mode, fault: opts.fault });
    this.stopping = false;
  }
  statePath() { return join(this.stateDir, "state.json"); }
  get state() {
    if (!this._state) {
      this._state = readJson(this.statePath(), { phase: "prepare", cycle: 1, strategy: this.strategy, counters: { candidates: 0, noProgress: 0, consecutiveInfra: 0 }, startedAt: new Date().toISOString() });
      // Older states kept the last signal as `interrupted`; it is history, never the outcome of a later invocation.
      if (this._state.interrupted) { this._state.lastInterruption ??= this._state.interrupted; delete this._state.interrupted; }
    }
    return this._state;
  }
  save() { this.state.updatedAt = new Date().toISOString(); atomicWriteJson(this.statePath(), this.state); }
  event(type, data = {}) { this.events.append({ type, ...data }); }
  setPhase(phase, extra = {}) { Object.assign(this.state, extra); this.state.phase = phase; this.save(); this.event("phase", { phase }); this.log(`phase -> ${phase}`); }

  /** Record BLOCKED, keeping the phase to resume once the cause clears (a repeated block keeps the original resume phase). */
  block(blocked) {
    const resumePhase = this.state.phase === "blocked" ? this.state.blocked?.resumePhase : this.state.phase;
    this.setPhase("blocked", { blocked: { retryable: false, ...blocked, resumePhase, at: new Date().toISOString() } });
    return false;
  }
  /** Terminal stop of this state directory (trust boundary or state integrity). Recorded once; later calls keep the first reason. */
  halt(reason, data = {}) {
    this.stopping = true;
    if (!this.state.halted) { this.state.halted = reason; this.state.haltedAt = new Date().toISOString(); }
    this.save();
    this.event("halted", { reason, ...data });
    this.log(`HALTED: ${reason}`);
    if (this.haltGroup && !this.haltGroup.halted) this.haltGroup.halted = { stateDir: this.stateDir, reason };
  }
  /** True when this state is halted; a halt of a sibling trajectory (shared haltGroup) halts this one too. */
  haltedNow() {
    const peer = this.haltGroup?.halted;
    if (!this.state.halted && peer && peer.stateDir !== this.stateDir) this.halt(`halted with sibling trajectory ${peer.stateDir}: ${peer.reason}`);
    return Boolean(this.state.halted);
  }
  /** @param {string} action */
  assertNotHalted(action) { if (this.state.halted) throw new HaltedError(this.state.halted, action); }
  /**
   * Record the lock this state is bound to (once; persisted before any lock-dependent step). A state bound to another lock is a
   * StateIntegrityError: a state is never re-bound. An older state without a binding is bound to its EXISTING verified lock.
   */
  bindLock(lock, created) {
    const binding = bindingOf(lock), had = this.state.protocolLock;
    if (had) {
      if (had.protocolDigest !== binding.protocolDigest || had.lockDigest !== binding.lockDigest) throw new StateIntegrityError("protocol.lock.json differs from the lock this state is bound to", { integrity: "protocol_lock_mismatch" });
      return;
    }
    this.state.protocolLock = binding;
    this.save();
    this.event(created ? "protocol-locked" : "protocol-bound", { protocolDigest: binding.protocolDigest, lockDigest: binding.lockDigest });
  }

  // ---------------------------------------------------------------------------------------------------------------------- prepare
  async prepare() {
    this.assertNotHalted("prepare");
    const p = this.protocol;
    // Integrity first, read from disk (never only the cached state): a lost state or a missing, damaged or contradicting
    // protocol lock stops here, before prerequisites, grader validation, model calls or any write (see contract.mjs).
    const disk = inspectState(this.stateDir);
    // A structurally invalid state.json (no integrity code) keeps its earlier handling (the CLI refuses it in preflight; through
    // the API the phase checks halt where they apply); its lock is only ever verified, never created. Invalid JSON fails on read.
    if (disk.health === "missing" || disk.integrity) throw new StateIntegrityError(`state directory ${this.stateDir}: ${disk.detail}`, { health: disk.health, integrity: disk.integrity });
    if (disk.health === "present") {
      if (disk.state.halted) throw new HaltedError(disk.state.halted, "prepare");
      if (digestOf(this.state.protocolLock ?? null) !== digestOf(disk.state.protocolLock ?? null)) throw new StateIntegrityError("the loaded state's protocol binding differs from state.json on disk", { integrity: "protocol_lock_mismatch" });
    }
    // A missing lock may be created only by a fresh initialization or a provably pre-lock state (crash or block before the lock).
    const createLock = disk.health === "fresh" || disk.protocol?.status === "unlocked";
    // The state file exists from the first step on: records without state.json always mean a lost state (see contract.mjs).
    if (disk.health === "fresh") {
      if (this.state.protocolLock) throw new StateIntegrityError("state.json vanished while this loop was bound to a protocol lock", { health: "missing", integrity: "protocol_lock_missing" });
      this.save();
    }
    // A supply pool resolves to the batch reserved for THIS state directory (idempotent: retries get the same batch; only a state
    // that can still create its lock may reserve one). Resolved before the lock check so the locked protocol names that batch.
    if (p.datasets.holdoutPool && !p.datasets.holdout) {
      const stop = this.resolveHoldoutPool(createLock);
      if (stop) return this.block(stop);
    }
    if (disk.health !== "fresh" && !createLock) {
      // An existing lock is checked against the current protocol and evaluator bytes before any other work (the dataset digest
      // follows after grading below).
      const early = lockProtocol(this.stateDir, p, { orcheDir: this.orche });
      this.bindLock(early.lock, false);
      if (early.problems.length) return this.block({ reason: "protocol/evaluator/dataset changed since the lock: start a new protocol version in a new state directory", problems: early.problems });
    }
    let restored;
    if (this.state.phase === "blocked") {
      const back = this.state.blocked?.resumePhase ?? legacyResumePhase(this.state);
      if (!back || back === "blocked" || !PHASES.includes(back)) { this.state.blocked = { ...this.state.blocked, reason: LEGACY_BLOCKED, retryable: false }; this.save(); return false; }
      // Restored in memory; persisted when prepare succeeds, or kept as blocked.resumePhase when it blocks again.
      restored = back; this.state.phase = back; delete this.state.blocked;
    }
    // An environment change inside a cycle (Pi, provider, node, bwrap): screening and development pair new runs with the baselines
    // and the holdout pass with its own earlier units, so mixing environments is refused (fail closed) instead of silently compared
    // or silently restarted. Before the search (prepare/baselines) the baselines are simply measured in the current environment;
    // after the cycle (done) the next cycle starts in the new one.
    if (this.state.cycleEnv !== undefined && this.state.cycleEnv !== (this.envDigest ?? null) && ENV_BOUND_PHASES.has(this.state.phase)) {
      return this.block({ reason: "environment changed during the cycle: samples of different environments are never compared; restore the recorded environment or continue in a new state directory", recordedEnvironment: this.state.cycleEnv, currentEnvironment: this.envDigest ?? null, retryable: false });
    }
    const prereq = this.prerequisites ? await this.prerequisites() : [];
    const missing = prereq.filter(x => !x.ok);
    this.state.prerequisites = prereq;
    if (missing.length) return this.block({ reason: "missing prerequisites", missing, retryable: true });
    // Injected datasets (tests) without holdout tasks load the holdout from the (possibly pool-resolved) protocol path.
    const injected = this.datasets ? (this.datasets.holdoutTasks ? this.datasets : { ...this.datasets, ...this.loadHoldout() }) : this.loadDatasets();
    // An exploration-only protocol never loads, grades or splits a holdout, even when one is injected.
    const loaded = p.datasets.holdout ? injected : { ...injected, holdoutDir: undefined, holdoutTasks: [] };
    // Holdout hard stratum: only hard tiers with an accepted difficulty basis (protocol holdout.hardBasis; never a size proxy).
    const data = { ...loaded, holdoutTasks: loaded.holdoutTasks.map(t => (t.hard && !holdoutHard(t, p) ? { ...t, hard: false, hardUnverified: true } : t)) };
    // Grader validation (model-free): original must fail, reference must pass. Failing tasks are excluded by this rule only.
    const gradingPath = join(this.stateDir, "grading.json");
    const grading = readJson(gradingPath, {});
    for (const task of [...data.tasks, ...data.holdoutTasks]) {
      if (grading[task.id]) continue;
      grading[task.id] = this.validateGrader ? await this.validateGrader(task) : { ok: true, expected: {}, baselineFailing: [] };
      atomicWriteJson(gradingPath, grading);
    }
    const valid = data.tasks.filter(t => grading[t.id].ok);
    const excluded = data.tasks.filter(t => !grading[t.id].ok).map(t => ({ id: t.id, problems: grading[t.id].problems }));
    let split = splitByFamily(valid, { seed: p.seed, trainShare: p.datasets.trainShare });
    const rng = createRng(`${p.seed}:subsample`);
    if (p.datasets.maxTrain) split.train = rng.shuffle(split.train).slice(0, p.datasets.maxTrain).sort();
    if (p.datasets.maxDev) split.dev = rng.shuffle(split.dev).slice(0, p.datasets.maxDev).sort();
    const holdout = data.holdoutTasks.filter(t => grading[t.id].ok).map(t => t.id).sort();
    const tasksById = Object.fromEntries([...data.tasks, ...data.holdoutTasks].map(t => [t.id, t]));
    const problems = validateSplits(tasksById, { train: split.train, dev: split.dev, holdout });
    if (problems.length) return this.block({ reason: "split validation failed", problems });
    const datasetManifest = { train: split.train, dev: split.dev, holdout, excluded, digests: Object.fromEntries(Object.values(tasksById).map(t => [t.id, taskDigest(t)])), holdoutSeal: data.holdoutDir ? verifySeal(data.holdoutDir).seal?.digest ?? null : null, meta: Object.fromEntries(Object.values(tasksById).map(t => [t.id, { family: t.family, tier: t.tier, hard: t.hard, ...(t.difficultyBasis ? { difficultyBasis: t.difficultyBasis } : {}), ...(t.hardUnverified ? { hardUnverified: true } : {}), source: t.source, provenance: t.provenance }])) };
    const { lock, problems: lockProblems, created } = lockProtocol(this.stateDir, p, { datasetDigest: digestOf(datasetManifest), orcheDir: this.orche, create: createLock });
    this.bindLock(lock, created);
    if (lockProblems.length) return this.block({ reason: "protocol/evaluator/dataset changed since the lock: start a new protocol version in a new state directory", problems: lockProblems });
    atomicWriteJson(join(this.stateDir, "datasets.json"), datasetManifest);
    this.protocolDigest = lock.protocolDigest;
    this.tasksById = tasksById; this.split = { ...split, holdout }; this.grading = grading; this.holdoutDir = data.holdoutDir;
    this.evaluator = new Evaluator({ stateDir: this.stateDir, protocol: p, protocolDigest: lock.protocolDigest, envDigest: this.envDigest, tasksById, grading, backend: this.backend, log: this.log });
    // The stable harness: the local eval-loop/stable ref when one exists (an earlier adoption), else orche's HEAD commit.
    if (!this.state.stable) {
      let stableCommit; try { stableCommit = execGit(this.orche, ["rev-parse", "--verify", "--quiet", `refs/heads/${p.deploy.branch}^{commit}`]); } catch { stableCommit = head(this.orche); }
      this.state.stable = { id: "stable", commit: stableCommit };
      this.save();
    }
    if (!this.archive.get("stable")) this.archive.create({ id: "stable", parent: null, status: "baseline", origin: "baseline", commit: this.state.stable.commit, hypothesis: null });
    this.harnesses = this.baselineHarnesses();
    // Model-free holdout preflight before any baseline, proposer or candidate run (see holdoutPreflight).
    const pre = this.holdoutPreflight();
    if (pre) return this.block(pre);
    if (restored) { this.save(); this.event("unblocked", { phase: restored }); this.log(`unblocked -> ${restored}`); }
    return true;
  }

  /**
   * Before the search spends anything: the holdout this experiment will be judged on must be independent and unused (sealed,
   * accepted provenance, unexposed, intact ledger with no use) and cover the adoption minima after grader validation (tasks,
   * families, a hard task). Skipped for exploration-only protocols, for requireIndependent: false, and once this cycle has
   * recorded its own holdout use (a resumed holdout phase). Failing it blocks permanently: the holdout is bound to the lock, so
   * the experiment can never reach an adoption; a new batch means a new experiment (new state directory).
   */
  holdoutPreflight() {
    const p = this.protocol;
    if (!p.datasets.holdout || !p.holdout.requireIndependent || this.state.holdoutUse || !PRE_HOLDOUT_PHASES.has(this.state.phase)) return undefined;
    const tasks = this.split.holdout.map(id => this.tasksById[id]);
    const reasons = [];
    if (!this.holdoutDir) reasons.push(`holdout dataset not found: ${p.datasets.holdout}`);
    else {
      const status = holdoutStatus(tasks, this.holdoutDir, p, { orcheDir: this.orche, ledgerPath: this.holdoutLedgerPath });
      if (!status.independent) reasons.push(status.why);
    }
    const coverage = { tasks: tasks.length, families: new Set(tasks.map(t => t.family)).size, hard: tasks.filter(t => t.hard).length, hardUnverified: tasks.filter(t => t.hardUnverified).length };
    if (coverage.tasks < p.holdout.minTasks) reasons.push(`holdout too small after grader validation: ${coverage.tasks} tasks (need ${p.holdout.minTasks})`);
    if (coverage.families < p.holdout.minFamilies) reasons.push(`holdout too narrow: ${coverage.families} families (need ${p.holdout.minFamilies})`);
    if (p.adoption.requireHardStratum && coverage.hard === 0) reasons.push(`holdout has no hard stratum (hard tasks with an accepted difficulty basis ${JSON.stringify(p.holdout.hardBasis)}: 0${coverage.hardUnverified ? `; ${coverage.hardUnverified} hard by an unaccepted basis such as size-proxy` : ""})`);
    if (!reasons.length) {
      if (!this.state.holdoutPreflight) { this.state.holdoutPreflight = { ok: true, at: new Date().toISOString(), coverage }; this.save(); }
      return undefined;
    }
    this.event("holdout-preflight-failed", { reasons, coverage });
    return { reason: "holdout preflight: no independent, unused holdout with the required coverage for this experiment; nothing was searched. Supply a new batch (eval-loop-supply) and start a new experiment in a new state directory", preflight: { reasons, coverage, holdout: p.datasets.holdout }, retryable: false };
  }

  /** Resolve datasets.holdoutPool to this state's batch (reserving one when the state may still create its lock). */
  resolveHoldoutPool(mayReserve) {
    const p = this.protocol;
    const pool = resolve(PACKAGE_DIR, p.datasets.holdoutPool);
    let a;
    try { a = assignmentFor(pool, this.stateDir) ?? (mayReserve ? reserveBatch(pool, this.stateDir, p, { orcheDir: this.orche }) : undefined); }
    catch (error) { return { reason: POOL_UNUSABLE, pool, detail: String(error.message).slice(0, 300), retryable: error instanceof LockBusyError }; }
    if (!a) return { reason: "this experiment already has a protocol lock but no batch reservation in the supply pool: refusing to reserve one now", pool, retryable: false };
    if (a.none) return { reason: POOL_EMPTY, pool, candidates: a.none.slice(0, 10), retryable: true };
    p.datasets.holdout = a.dir;
    if (this.state.holdoutBatch?.batch !== a.batch) { this.state.holdoutBatch = { batch: a.batch, pool, reservedAt: a.reservedAt, reservation: a.seq }; this.save(); }
    return undefined;
  }

  loadDatasets() {
    const tasks = loadSuite(join(this.orche, "fixtures/suite")).filter(t => (!this.protocol.datasets.include || this.protocol.datasets.include.includes(t.id)) && !(this.protocol.datasets.exclude ?? []).includes(t.id));
    return { tasks, ...this.loadHoldout() };
  }
  loadHoldout() {
    // datasets.holdout = null: an exploration-only protocol (train/dev search and selection; no holdout is loaded, graded or used).
    if (!this.protocol.datasets.holdout) return { holdoutDir: undefined, holdoutTasks: [] };
    const holdoutDir = resolve(PACKAGE_DIR, this.protocol.datasets.holdout);
    const holdoutTasks = existsSync(holdoutDir) ? loadLocal(holdoutDir) : [];
    return { holdoutDir: existsSync(holdoutDir) ? holdoutDir : undefined, holdoutTasks };
  }

  worktreeFor(id, commit) { return snapshotWorktree(this.orche, commit, join(this.stateDir, "worktrees", id)).dir; }
  harness(id) {
    const c = this.archive.get(id);
    if (id === "stable") return { id, kind: "orche", commit: this.state.stable.commit, mode: this.protocol.target.mode, dir: this.worktreeFor("stable", this.state.stable.commit) };
    if (c?.kind === "control") return c.harness;
    return { id, kind: "orche", commit: c.commit, mode: this.protocol.target.mode, dir: c.worktree };
  }
  baselineHarnesses() {
    const b = this.protocol.baselines, out = [];
    if (b.pure) out.push({ id: "pure", kind: "pure" });
    if (b.multiAttempt?.k > 1) out.push({ id: `multi${b.multiAttempt.k}`, kind: "multi", k: b.multiAttempt.k });
    if (b.targetMode && this.protocol.target.mode !== "single") out.push({ id: "stable-default-mode", kind: "orche", commit: this.state.stable.commit, mode: "single", dir: this.worktreeFor("stable", this.state.stable.commit) });
    for (const h of out) if (!this.archive.get(h.id)) this.archive.create({ id: h.id, parent: null, status: "baseline", origin: "control", kind: "control", harness: h, hypothesis: null });
    return out;
  }
  units(split, repeats, tasks = this.split[split]) { const out = []; for (const task of tasks) for (let r = 0; r < repeats; r++) out.push({ task, split, repeat: r }); return out; }
  records() { return this.evaluator.records(); }
  /**
   * Inputs of every statistic (comparisons, development points, failure analysis, evidence): records of this protocol and environment
   * and, for the stable arms, of the current stable commit. Critical checks keep using `records()` (all identities and attempts).
   */
  samples() { const stable = this.state.stable?.commit; return this.evaluator.samples().filter(r => !STABLE_ARMS.has(r.candidate_id) || r.harness_commit === stable); }

  // -------------------------------------------------------------------------------------------------------------------- baselines
  async baselines() {
    const p = this.protocol;
    this.state.cycleEnv = this.envDigest ?? null; this.save();
    const stable = this.harness("stable");
    await this.evaluator.evaluate(stable, this.units("train", p.screening.minRepeats), "baseline:stable:train");
    await this.evaluator.evaluate(stable, this.units("dev", p.development.repeats), "baseline:stable:dev");
    for (const h of this.harnesses) {
      if (h.kind === "pure") await this.evaluator.evaluate(h, this.units("train", p.screening.minRepeats), `baseline:${h.id}:train`);
      await this.evaluator.evaluate(h, this.units("dev", p.development.repeats), `baseline:${h.id}:dev`);
    }
    this.recordDevelopment("stable", { qualified: true, reasons: ["baseline"] });
    this.setPhase("search");
  }

  devPairs(a, b) { return pairsOf(this.samples().filter(r => r.repeat < this.protocol.development.repeats), { a, b, split: "dev", tasks: this.split.dev, meta: this.tasksById }); }
  recordDevelopment(id, decision, cmp) {
    const pairs = this.devPairs(id, id).map(t => ({ ...t, a: t.b }));
    const described = describeArm(pairs, { draws: this.protocol.bootstrap.draws, seed: `${this.protocol.seed}:dev:${id}` });
    // Exact plug-in point estimates (uniform task weights, raw repeat means), never the Monte Carlo posterior mean: identical
    // outcomes must give identical points, or bootstrap noise would decide the Pareto front, progress and selection.
    const point = Object.fromEntries(Object.entries(described).map(([k, v]) => [k, v.point]));
    const c = this.archive.get(id);
    c.development = { tasks: this.split.dev.length, repeats: this.protocol.development.repeats, point, posterior: described, qualified: decision.qualified, reasons: decision.reasons, vsStable: cmp ? { support: cmp.support, lossSupport: cmp.lossSupport, delta: cmp.delta, familyDelta: cmp.familyDelta } : undefined, summary: summarize(this.samples(), id, "dev") };
    this.archive.put(c);
  }

  // ----------------------------------------------------------------------------------------------------------------------- search
  watchdog() {
    const w = this.protocol.watchdog, c = this.state.counters;
    if (this.stopping) return "interrupted";
    if (c.noProgress >= w.noProgressCandidates) return `no meaningful progress in ${c.noProgress} consecutive candidates`;
    // The cap counts created candidates; an in-flight candidate is always finished (never left unevaluated by the cap).
    if (!this.state.current && c.candidates >= w.maxCandidatesPerCycle) return `candidate cap of ${w.maxCandidatesPerCycle} per cycle reached (safety limit)`;
    if (Date.now() - Date.parse(this.state.cycleStartedAt ?? this.state.startedAt) > w.maxCycleWallMs) return "cycle wall-time watchdog";
    if (c.consecutiveInfra >= w.maxConsecutiveInfra) return `infrastructure failing (${c.consecutiveInfra} consecutive candidates with infra-tainted screening)`;
    return undefined;
  }

  async search() {
    this.state.cycleStartedAt ??= new Date().toISOString();
    // A/B/C trajectories search on baselines measured by A: they are bound to the environment they start searching in.
    if (this.state.cycleEnv === undefined) { this.state.cycleEnv = this.envDigest ?? null; this.save(); }
    while (true) {
      if (this.haltedNow()) return;
      const stop = this.watchdog();
      // An interruption is not a stop reason of the search: the phase stays "search" and a resume continues it.
      if (stop === "interrupted") { this.event("search-interrupted", {}); return; }
      if (stop) { this.event("search-stopped", { reason: stop, classFailures: this.classFailures() }); this.state.searchStop = stop; this.state.classFailures = this.classFailures(); this.save(); this.setPhase("select"); return; }
      const current = this.state.current;
      if (current) await this.continueCandidate(current.id);
      else if (!(await this.newCandidate())) { this.state.searchStop = `no addressable failure class left (each remaining class exhausted after ${this.protocol.watchdog.maxFailuresPerClass} failed targeted proposals since the last progress, or no train failure to target)`; this.state.classFailures = this.classFailures(); this.event("search-stopped", { reason: this.state.searchStop, classFailures: this.state.classFailures }); this.setPhase("select"); return; }
    }
  }

  chooseTarget(parentId) {
    const samples = this.samples();
    const recs = finalAttempts(samples.filter(r => r.candidate_id === parentId && r.split === "train"));
    const reference = finalAttempts(samples.filter(r => r.candidate_id === "pure" && r.split === "train"));
    const gateFirst = this.protocol.efficiency.gateBlockingFirst;
    const rejected = gateFirst ? this.recentCriticalRejections() : [];
    const rejections = {};
    for (const r of rejected) for (const c of r.classes) rejections[c] = (rejections[c] ?? 0) + 1;
    const analysis = analyze(recs, { reference, rejections, gateFirst });
    const failures = this.classFailures();
    const blocked = Object.entries(failures).filter(([, n]) => n >= this.protocol.watchdog.maxFailuresPerClass).map(([c]) => c);
    // Integrity failures are targetable: removing a failure type (e.g. task agents editing existing tests) is quality progress, and
    // while it recurs it blocks every candidate at the critical gate, so it comes first (protocol-3 efficiency.gateBlockingFirst).
    const target = analysis.hypotheses.find(h => !blocked.includes(h.class));
    return { analysis, target, blocked, recs, rejected };
  }

  /**
   * Candidates rejected by the critical gate among the consecutive no-progress candidates since the last progress, with the gate
   * classes and the violation texts of their reasons (task id, split and repeat removed; never holdout or hidden material).
   */
  recentCriticalRejections() {
    const since = this.state.lastProgressAt ?? this.state.startedAt, last = this.state.counters?.noProgress ?? 0;
    if (last <= 0) return [];
    const pool = this.archive.all().filter(c => c.origin === "proposer" && (c.createdAt ?? "") > since)
      .sort((x, y) => (x.createdAt ?? "").localeCompare(y.createdAt ?? "") || x.id.localeCompare(y.id)).slice(-last);
    const out = [];
    for (const c of pool) {
      if (!["rejected", "dev_rejected"].includes(c.status)) continue;
      const reason = String(c.decisions?.at(-1)?.reason ?? "");
      if (!reason.startsWith("critical:")) continue;
      const parts = reason.slice("critical:".length).split("; ").map(s => s.trim());
      const classes = new Set(), violations = [];
      for (const part of parts) {
        const v = /^task-agent integrity violation [^:]+: (.*)$/.exec(part);
        if (v) { classes.add("integrity"); violations.push(v[1].slice(0, 300)); }
        else if (/^task-agent leak attempt/.test(part) || /^integrity: /.test(part)) classes.add("integrity");
        else if (/^harness crash/.test(part)) classes.add("harness-crash");
      }
      if (classes.size) out.push({ candidate: c.id, targetedClass: c.hypothesis?.targetFailureClass ?? c.target ?? null, hypothesis: String(c.hypothesis?.text ?? "").slice(0, 300), classes: [...classes], violations });
    }
    return out;
  }

  async newCandidate() {
    const p = this.protocol;
    const rng = createRng(`${p.seed}:parent:${this.state.counters.candidates}`);
    const best = this.state.greedyBest ?? "stable";
    const first = selectParent(this.archive, { strategy: this.strategy, rng, maxChildFailures: p.watchdog.maxChildFailuresPerParent, current: best });
    // A parent without an addressable train failure cannot guide a change: fall back to other archived parents (pareto) before stopping.
    const options = this.strategy === "greedy" ? [first] : [...new Set([first, ...this.archive.front(), ...this.archive.developmentSet().map(c => c.id).filter(id => this.archive.get(id).origin !== "control"), "stable"])];
    let parentId, chosen;
    for (const option of options) { const attempt = this.chooseTarget(option); if (attempt.target) { parentId = option; chosen = attempt; break; } }
    if (!chosen) return false;
    const parent = this.harness(parentId);
    const { analysis, target, blocked, recs, rejected } = chosen;
    const id = this.archive.nextId(this.idPrefix ?? "c");
    const dir = join(this.stateDir, "worktrees", id);
    const wt = createWorktree(this.orche, id, parent.commit, dir, sha256(this.stateDir).slice(0, 8));
    const candDir = join(this.stateDir, "candidates", id);
    ensureDir(candDir);
    atomicWriteJson(join(candDir, "analysis.json"), analysis);
    this.archive.create({ id, parent: parentId, origin: "proposer", strategy: this.strategy, worktree: wt.dir, branch: wt.branch, base: parent.commit, target: target.class, hypothesis: null });
    const pc = this.archive.get(parentId); pc.children = [...(pc.children ?? []), id]; this.archive.put(pc);
    this.state.counters.candidates++;
    this.state.current = { id, step: "propose" };
    this.save();
    this.event("candidate-created", { id, parent: parentId, target: target.class });
    // Evidence for the optimizer: train failures, development aggregates and the critical reasons of recent rejected candidates (never
    // holdout, never hidden test content).
    const evidenceDir = writeEvidence(join(candDir, "evidence"), { trainRecords: recs, analysis, devSummary: summarize(this.samples(), parentId, "dev"), tasksById: this.tasksById, rejections: rejected });
    const before = this.protectedState();
    const result = await this.proposer.propose({ worktree: wt.dir, evidenceDir, protocol: p, env: this.env, parentId, targetClass: target.class, blockedClasses: blocked, logDir: join(candDir, "proposer") });
    const after = this.protectedState();
    const breached = changedProtected(before, after);
    const c = this.archive.get(id);
    c.proposer = { usage: result.usage, detail: result.detail };
    this.archive.put(c);
    if (breached.length) {
      this.archive.decide(id, "rejected_patch", `TRUST BOUNDARY: protected state changed during candidate generation: ${breached.join(", ")}`);
      this.state.current = null;
      this.event("trust-boundary-breach", { id, breached });
      this.halt(`trust boundary breach: ${breached.join(", ")}`, { id });
      return true;
    }
    if (!result.ok) { this.archive.decide(id, "rejected_patch", `proposer: ${result.detail}`, { hypothesis: { text: "", targetFailureClass: target.class } }); this.endCandidate(false); return true; }
    const hyp = { text: result.hypothesis.hypothesis, targetFailureClass: target.class, expectedEffect: result.hypothesis.expectedEffect ?? "" };
    const { files, patch } = changes(wt.dir, parent.commit);
    writeFileSync(join(candDir, "patch.diff"), patch);
    const integ = patchIntegrity(files, patch, p, { taskIds: Object.keys(this.tasksById) });
    const update = { hypothesis: hyp, files, patchKey: patchKey(patch), patchSha256: sha256(patch), patchStats: { added: integ.added, removed: integ.removed } };
    if (integ.violations.length) { this.archive.decide(id, "rejected_patch", `patch integrity: ${integ.violations.slice(0, 5).join("; ")}`, update); this.endCandidate(false); return true; }
    const dup = this.archive.duplicateOf(patch, hyp, p.watchdog.hypothesisSimilarity);
    if (dup && dup.id !== id) { this.archive.decide(id, "duplicate", `duplicate of ${dup.id}: ${dup.why}`, update); this.endCandidate(false); return true; }
    const sha = commitWorktree(wt.dir, `eval-loop candidate ${id}: ${hyp.text.slice(0, 200)}\n\nParent: ${parentId} (${parent.commit})\nTarget failure class: ${hyp.targetFailureClass}`);
    this.archive.decide(id, "created", "patch accepted", { ...update, commit: sha });
    // Harness checks before any model run (model-free; protocol-3 efficiency.precheck). With "test" the adoption rule applies (the
    // candidate's typecheck passes and its test suite does no worse than stable's in the same sandbox): failing it, the candidate
    // could never be adopted, so screening it would only spend runs.
    const which = p.efficiency.precheck;
    const build = this.checks ? await this.checks(wt.dir, which, join(candDir, "checks")) : { pass: true };
    let failed;
    if (this.checks && which.includes("test")) {
      const cmp = compareChecks(await this.stableChecks(which), build);
      if (!cmp.pass) failed = `precheck failed (adoption check rule against stable): ${cmp.problems.slice(0, 4).join("; ").slice(0, 600)}`;
    } else if (!build.pass) failed = `typecheck failed: ${JSON.stringify(build.results?.typecheck?.tail ?? "").slice(0, 400)}`;
    if (failed) { this.archive.decide(id, "build_failed", failed); this.endCandidate(false); return true; }
    this.state.current = { id, step: "screen", repeats: p.screening.minRepeats, batch: screeningBatch(this.split.train, this.tasksById, p.screening.tasks, `${p.seed}:screen:${id}`) };
    this.archive.decide(id, "screening", `screening batch ${this.state.current.batch.join(", ")}`);
    this.save();
    return true;
  }

  /** Stable's precheck results, measured once per stable commit, environment and check list (cached in the state directory). */
  async stableChecks(which) {
    const commit = this.state.stable.commit, identity = digestOf({ commit, env: this.envDigest ?? null, which });
    const dir = join(this.stateDir, "candidates", "stable", `precheck-${identity.slice(0, 12)}`);
    const cached = readJson(join(dir, "result.json"), null);
    if (cached?.identity === identity) return cached.result;
    const result = await this.checks(this.harness("stable").dir, which, dir);
    atomicWriteJson(join(dir, "result.json"), { identity, commit, environment: this.envDigest ?? null, which, result, at: new Date().toISOString() });
    return result;
  }

  async continueCandidate(id) {
    const step = this.state.current.step;
    if (step === "propose") {
      // Interrupted during generation: the candidate's patch state is unknown; reject (recorded) rather than guess.
      this.archive.decide(id, "rejected_patch", "interrupted during candidate generation (not resumed: the patch cannot be trusted)");
      this.endCandidate(false); return;
    }
    if (step === "screen") return this.screen(id);
    if (step === "develop") return this.develop(id);
    this.endCandidate(false);
  }

  /**
   * Dispatch order for a candidate's screening units when critical problems stop it early: tasks where the parent's recorded train
   * runs showed critical problems first, then the batch order; repeat-major (every task once before any second repeat). The order
   * changes only WHEN a rejection is found, never the decision or the units of a round that runs to the end.
   */
  criticalFirstOrder(units, parentId) {
    const bad = {};
    for (const r of finalAttempts(this.records().filter(r => r.candidate_id === parentId && r.split === "train"))) if (criticalProblems([r], parentId).length) bad[r.task_id] = (bad[r.task_id] ?? 0) + 1;
    const taskOrder = [...new Set(units.map(u => u.task))];
    const rank = (t) => taskOrder.indexOf(t);
    return [...units].sort((a, b) => a.repeat - b.repeat || (bad[b.task] ?? 0) - (bad[a.task] ?? 0) || rank(a.task) - rank(b.task));
  }

  async screen(id) {
    const p = this.protocol, cur = this.state.current;
    const c = this.archive.get(id);
    const parent = this.harness(c.parent), cand = this.harness(id);
    const units = this.units("train", cur.repeats, cur.batch);
    const scope = new Set(units.map(u => `${u.split}|${u.task}|${u.repeat}`));
    // Every recorded attempt of the candidate in this round's scope, whatever its identity (a clean retry never erases a violation).
    const criticalNow = () => criticalProblems(this.records(), id, { reference: c.parent, units: scope });
    const early = p.efficiency.stopOnCritical;
    if (early) {
      // The candidate first: a critical problem rejects it whatever the statistics, so its remaining units and the parent's units
      // (needed only for the comparison) are not dispatched once one is recorded. Units already running finish and are recorded.
      await this.evaluator.evaluate(cand, this.criticalFirstOrder(units, c.parent), `screen:${id}:candidate`, { stopWhen: () => criticalNow().length > 0 });
      if (!criticalNow().length) await this.evaluator.evaluate(parent, units, `screen:${id}:parent`);
    } else {
      await this.evaluator.evaluate(parent, units, `screen:${id}:parent`);
      await this.evaluator.evaluate(cand, units, `screen:${id}:candidate`);
    }
    const records = this.records();
    const critical = criticalNow();
    // Statistics only from samples of this identity, exactly the scheduled (task, repeat) slots of this round.
    const inScope = this.samples().filter(r => r.split === "train" && scope.has(`${r.split}|${r.task_id}|${r.repeat}`));
    const pairs = pairsOf(inScope, { a: c.parent, b: id, split: "train", tasks: cur.batch, meta: this.tasksById });
    const missing = pairs.filter(t => t.a.length !== cur.repeats || t.b.length !== cur.repeats);
    const candRuns = finalAttempts(records.filter(r => r.candidate_id === id && scope.has(`${r.split}|${r.task_id}|${r.repeat}`)));
    const infraRate = candRuns.length ? candRuns.filter(r => ["infra_error", "model_unavailable"].includes(r.terminal_status)).length / candRuns.length : 0;
    const round = { at: new Date().toISOString(), repeats: cur.repeats, tasks: cur.batch };
    if (critical.length) {
      // Recorded as a critical rejection only; a round stopped early is never a statistical sample or estimate.
      const ranCand = finalAttempts(records.filter(r => r.candidate_id === id && r.split === "train" && scope.has(`${r.split}|${r.task_id}|${r.repeat}`))).length;
      const stoppedEarly = early && ranCand < units.length ? { candidateUnitsRecorded: ranCand, scheduled: units.length, parentUnitsSkipped: true } : undefined;
      this.archive.decide(id, "rejected", `critical: ${critical.slice(0, 4).join("; ")}`, { screening: { ...(c.screening ?? {}), rounds: [...(c.screening?.rounds ?? []), { ...round, critical, stoppedEarly }] } });
      if (stoppedEarly) this.event("screening-stopped-early", { id, ...stoppedEarly });
      this.endCandidate(false, infraRate); return;
    }
    if (missing.length) throw new Error(`screening of ${id}: unmatched observations for ${missing.map(t => t.task).join(", ")}`);
    const seed = `${p.seed}:screen:${id}:${cur.repeats}`;
    const cmp = screeningCompare(pairs, p, seed);
    const taskCmp = taskLevelPromotion(pairs, p, seed);
    const decision = screeningDecision(cmp, { support: p.screening.support, band: p.screening.band, maxRepeats: p.screening.maxRepeats }, { repeats: cur.repeats, infraRate, maxInfraRate: p.watchdog.maxInfraRate });
    const screening = { batch: cur.batch, repeats: cur.repeats, support: cmp.support, supportTaskLevel: taskCmp.support, mcse: cmp.mcse, delta: cmp.delta, point: cmp.point, decision: decision.decision, reasons: decision.reasons, rounds: [...(c.screening?.rounds ?? []), { ...round, support: cmp.support, supportTaskLevel: taskCmp.support, decision: decision.decision }] };
    this.event("screening", { id, repeats: cur.repeats, support: cmp.support, decision: decision.decision });
    if (decision.decision === "EXTEND") { this.archive.decide(id, "screening", `extend: ${decision.reasons.join("; ")}`, { screening }); cur.repeats = Math.min(p.screening.maxRepeats, cur.repeats + p.screening.step); this.save(); return; }
    if (decision.decision === "PROMOTE") { this.archive.decide(id, "promoted", decision.reasons.join("; "), { screening }); this.state.current = { id, step: "develop" }; this.save(); return; }
    this.archive.decide(id, decision.decision === "INCONCLUSIVE" ? "inconclusive" : "rejected", decision.reasons.join("; "), { screening });
    this.endCandidate(false, infraRate);
  }

  async develop(id) {
    const p = this.protocol;
    const cand = this.harness(id);
    // Every run of the candidate outside the holdout (screening, development and its own train runs, every attempt and identity)
    // must be critical-clean.
    const criticalNow = () => criticalProblems(this.records().filter(r => r.split !== "holdout"), id, { reference: "stable" });
    const early = p.efficiency.stopOnCritical ? { stopWhen: () => criticalNow().length > 0 } : {};
    const devUnits = this.units("dev", p.development.repeats), trainUnits = this.units("train", p.screening.minRepeats);
    await this.evaluator.evaluate(cand, devUnits, `develop:${id}`, early);
    // Its own train runs: the evidence when it becomes a parent.
    if (!(early.stopWhen && criticalNow().length)) await this.evaluator.evaluate(cand, trainUnits, `develop:${id}:train`, early);
    const critical = criticalNow();
    const missing = missingUnits(this.samples(), [...devUnits, ...trainUnits].map(u => this.evaluator.keyOf(cand, u.task, u.split, u.repeat)));
    if (critical.length && missing.length) {
      // Stopped early on a critical problem: rejected (as the full evaluation would be) without a development point: a partial
      // evaluation is never recorded as a development estimate or sample.
      const c = this.archive.get(id);
      c.development = { qualified: false, aborted: { reason: "critical problem recorded; remaining units not dispatched", unitsMissing: missing.length, scheduled: devUnits.length + trainUnits.length } };
      this.archive.put(c);
      this.archive.decide(id, "dev_rejected", `critical: ${critical.slice(0, 5).join("; ")}`);
      this.event("development-stopped-early", { id, unitsMissing: missing.length });
      this.event("development", { id, qualified: false, front: this.archive.front(), progress: false });
      this.endCandidate(false, 0);
      return;
    }
    const cmp = developmentCompare(this.devPairs("stable", id), p, `${p.seed}:dev:${id}`);
    const decision = developmentDecision(cmp, p, critical);
    this.recordDevelopment(id, decision, cmp);
    this.archive.decide(id, decision.qualified ? "dev_qualified" : "dev_rejected", decision.reasons.join("; "));
    let progress;
    if (this.strategy === "greedy") {
      // Quality-only ablation: the single current best by development Q_overall replaces the parent; no archive of alternatives.
      // Progress = a new best (no Pareto bookkeeping in this arm).
      const best = this.archive.get(this.state.greedyBest ?? "stable");
      progress = greedyProgress(decision.qualified, this.archive.get(id).development.point, best.development.point);
      if (progress) this.state.greedyBest = id;
    } else {
      // Pareto loop: progress = a development-qualified candidate that no other development-set member weakly dominates (a point
      // identical to an existing one is not progress).
      progress = decision.qualified && !this.archive.weaklyDominated(id);
    }
    const front = this.archive.front();
    this.event("development", { id, qualified: decision.qualified, front, progress });
    this.endCandidate(progress, 0);
  }

  /** Failed targeted proposals per class among the consecutive no-progress candidates since the last progress (or the cycle start). */
  classFailures() { return this.archive.failuresByClass({ since: this.state.lastProgressAt ?? this.state.startedAt, last: this.state.counters?.noProgress ?? 0 }); }

  endCandidate(progress, infraRate = 0) {
    const c = this.state.counters;
    c.noProgress = progress ? 0 : c.noProgress + 1;
    if (progress) this.state.lastProgressAt = new Date().toISOString();
    c.consecutiveInfra = infraRate > this.protocol.watchdog.maxInfraRate ? c.consecutiveInfra + 1 : 0;
    this.state.current = null;
    this.save();
  }

  protectedState() {
    const entries = {
      orcheHead: () => head(this.orche),
      orcheStatus: () => sha256(execGit(this.orche, ["status", "--porcelain"])),
      umbrellaHead: () => head(this.umbrella),
      evaluator: () => digestOf(fileDigests(evaluatorFiles(this.orche))),
      runsLedger: () => String(new Ledger(join(this.stateDir, "runs.jsonl")).verify().length),
    };
    if (this.holdoutDir) entries.holdoutSeal = () => String(verifySeal(this.holdoutDir).ok);
    for (const c of this.archive.all()) if (c.commit && c.worktree && c.status !== "created") entries[`worktree:${c.id}`] = () => { try { return head(c.worktree); } catch { return "absent"; } };
    return protectedSnapshot(entries);
  }

  // ----------------------------------------------------------------------------------------------------------- select & holdout
  select() {
    this.assertNotHalted("selection");
    // A cycle selects once: after a holdout use or a final decision, a new selection would re-associate decided evidence.
    if (this.state.holdoutUse || this.state.final) { this.halt("state integrity: selection requested after this cycle's holdout use or final decision"); return; }
    const a = this.protocol.adoption;
    const qualified = this.archive.all().filter(c => c.status === "dev_qualified" || (c.status === "selected" && c.development?.qualified));
    // Defense in depth: a candidate with ANY critical problem in its non-holdout runs is never selected (whatever stable did).
    const nonHoldout = this.records().filter(r => r.split !== "holdout");
    const criticalOf = Object.fromEntries(qualified.map(c => [c.id, criticalProblems(nonHoldout, c.id, { reference: "stable" })]));
    const eligible = qualified.filter(c => {
      if (criticalOf[c.id].length) return false;
      const fam = c.development?.vsStable?.familyDelta ?? {};
      return !Object.values(fam).some(d => d.probBelow >= a.familyRegressionSupport);
    });
    const order = (x, y) => pointDesc(x.development.point.overall, y.development.point.overall) || pointDesc(x.development.point.hard ?? 0, y.development.point.hard ?? 0) || pointDesc(x.development.point.consistency ?? 0, y.development.point.consistency ?? 0) || x.id.localeCompare(y.id);
    // Quality-only ablation (greedy): its single current best; Pareto loop: the best development-qualified candidate of the archive.
    const best = this.strategy === "greedy" ? eligible.find(c => c.id === this.state.greedyBest) : [...eligible].sort(order)[0];
    const stable = this.archive.get("stable");
    const selection = { at: new Date().toISOString(), considered: qualified.map(c => c.id), eligible: eligible.map(c => c.id), criticalExcluded: qualified.filter(c => criticalOf[c.id].length).map(c => ({ id: c.id, critical: criticalOf[c.id].slice(0, 3) })), selected: best && pointGt(best.development.point.overall, stable.development.point.overall) ? best.id : null };
    if (!selection.selected) selection.reason = eligible.length ? "no development-qualified candidate beats the stable harness on development Q_overall" : "no development-qualified, critical-clean candidate without family regression";
    else { selection.commit = this.archive.get(selection.selected).commit; selection.frozenDigest = digestOf({ id: selection.selected, commit: selection.commit, protocol: this.protocolDigest }); this.archive.decide(selection.selected, "selected", "final selection on development (frozen before holdout access)"); }
    atomicWriteJson(join(this.stateDir, "selection.json"), selection);
    this.event("selection", selection);
    this.setPhase(selection.selected ? "holdout" : "done", { selection, final: selection.selected ? undefined : this.protocol.datasets.holdout ? { verdict: "KEEP_STABLE", reasons: [selection.reason] } : explorationOnlyFinal(selection) });
  }

  async holdout() {
    this.assertNotHalted("holdout evaluation");
    const p = this.protocol, sel = this.state.selection;
    // Defense in depth (contract.mjs validates the same): the holdout is only ever measured for a frozen selection.
    if (!sel?.frozenDigest || (sel.selected !== null && (typeof sel.selected !== "string" || !sel.selected || !sel.commit))) { this.halt("state integrity: holdout phase without a frozen selection"); return; }
    // The frozen digest is recomputed from the selection it froze (a single selection, or the A/B/C finals of an ablation).
    const frozen = sel.ablation ? digestOf({ finals: sel.ablation, protocol: this.protocolDigest }) : digestOf({ id: sel.selected, commit: sel.commit, protocol: this.protocolDigest });
    const finalsC = sel.ablation?.C, fromFinals = finalsC && finalsC.id !== "stable" ? finalsC.id : null;
    const ablationConsistent = !sel.ablation || (sel.selected === fromFinals && (fromFinals ? sel.commit === finalsC.commit : !sel.commit) && (sel.extraArms ?? []).every(id => [sel.ablation.B?.id, sel.ablation.C?.id].includes(id)));
    if (frozen !== sel.frozenDigest || !ablationConsistent) { this.halt("state integrity: the selection differs from the one frozen before holdout access"); return; }
    if (!p.datasets.holdout) {
      // Exploration-only protocol: nothing is evaluated here, no holdout ledger is touched and nothing can be deployed.
      const final = explorationOnlyFinal(sel);
      this.event("adoption-decision", final);
      this.setPhase("done", { final });
      return;
    }
    // Consume BEFORE the first holdout run (a crash still consumes it); a resumed holdout phase reuses its own recorded use.
    const ledger = this.holdoutDir ? holdoutLedger(this.holdoutDir, this.holdoutLedgerPath) : undefined;
    let use = this.state.holdoutUse;
    if (!use && ledger) {
      // A crash after the ledger append but before the state save: this frozen selection's own authenticated use is recovered
      // (never appended twice). A use by another state, protocol or selection is not this one's and counts as consumption.
      if (ledger.verify().length === 0) {
        const mine = ledger.records().find(r => r.type === "use" && r.stateDir === this.stateDir && r.protocolDigest === this.protocolDigest && r.selected === sel.selected && r.commit === sel.commit && r.frozenDigest === sel.frozenDigest);
        if (mine) { this.state.holdoutUse = use = mine; this.state.holdoutIndependentAtStart = { independent: mine.independentBefore, why: mine.why, recovered: true }; this.save(); this.event("holdout-use-recovered", { seq: mine.seq }); }
      }
    }
    const status = use ? this.state.holdoutIndependentAtStart : this.holdoutDir ? holdoutStatus(this.split.holdout.map(id => this.tasksById[id]), this.holdoutDir, p, { orcheDir: this.orche, ledgerPath: this.holdoutLedgerPath }) : { independent: false, why: "no holdout dataset" };
    if (!use && p.holdout.requireIndependent && !status.independent) {
      // Re-checked at the moment of use (the preflight ran before the search): a holdout that is no longer independent is neither
      // consumed nor run; deployment is BLOCKED and recorded as such.
      const final = { candidate: sel.selected ?? null, verdict: "BLOCKED", adopt: false, holdoutEvaluated: false, reasons: [`no independent holdout at the time of use (not consumed, not run): ${status.why}`] };
      this.event("adoption-decision", final);
      this.setPhase("done", { final });
      return;
    }
    if (use && !use.none && (use.stateDir !== this.stateDir || use.protocolDigest !== this.protocolDigest || use.selected !== sel.selected || use.commit !== sel.commit || use.frozenDigest !== sel.frozenDigest)) {
      // A recorded use belongs to exactly one frozen selection (incl. A/B/C extra arms via frozenDigest); it is never reused for another.
      this.halt("holdout integrity: the recorded holdout use does not match the frozen selection/protocol of this cycle", { use: use.seq });
      return;
    }
    if (!use) {
      this.state.holdoutIndependentAtStart = status;
      if (ledger) this.state.holdoutUse = ledger.append({ type: "use", stateDir: this.stateDir, protocolDigest: this.protocolDigest, selected: sel.selected, commit: sel.commit, frozenDigest: sel.frozenDigest, independentBefore: status.independent, why: status.why });
      else this.state.holdoutUse = { none: true };
      this.save();
    }
    const independent = this.state.holdoutIndependentAtStart;
    // Arms of this ONE holdout pass: stable, extra measured arms (A/B/C ablation finals) and the selected candidate.
    const arms = [...new Set(["stable", ...(sel.extraArms ?? []), ...(sel.selected ? [sel.selected] : [])])];
    let cmp, incomplete = [], records = [];
    const passKeys = new Set();
    if (this.split.holdout.length) {
      const units = this.units("holdout", p.holdout.repeats);
      for (const id of arms) await this.evaluator.evaluate(this.harness(id), units, `holdout:${id}`);
      records = this.records();
      for (const id of arms) for (const u of units) passKeys.add(this.evaluator.keyOf(this.harness(id), u.task, u.split, u.repeat));
      incomplete = missingUnits(records, [...passKeys]);
      // The comparison uses exactly the units of this pass (this identity), never holdout records of another identity.
      if (sel.selected) cmp = adoptionCompare(pairsOf(this.samples().filter(r => passKeys.has(r.unit_key)), { a: "stable", b: sel.selected, split: "holdout", tasks: this.split.holdout, meta: this.tasksById }), p, `${p.seed}:holdout:${sel.selected}`);
    }
    if (!sel.selected) {
      const final = { candidate: null, verdict: "KEEP_STABLE", adopt: false, reasons: ["no candidate selected on development; holdout measured for the listed arms only"], arms, incomplete: incomplete.length, independence: independent };
      this.event("adoption-decision", final);
      this.setPhase("done", { final });
      return;
    }
    const holdRecs = finalAttempts(records.filter(r => r.split === "holdout" && passKeys.has(r.unit_key)));
    // Critical problems anywhere in the candidate's record (train, dev and holdout, every attempt) block deployment.
    const critical = criticalProblems(records, sel.selected, { reference: "stable" });
    const envs = new Set(holdRecs.map(r => r.environment_digest));
    const routeOk = holdRecs.length > 0 && envs.size === 1 && holdRecs.every(r => r.terminal_status !== "route_violation");
    let checks = { pass: false, results: {}, problems: ["no checks runner"] };
    if (this.checks) {
      const stableChecks = await this.checks(this.harness("stable").dir, ["typecheck", "test"], join(this.stateDir, "candidates", "stable", "adoption-checks"));
      const candChecks = await this.checks(this.harness(sel.selected).dir, ["typecheck", "test"], join(this.stateDir, "candidates", sel.selected, "adoption-checks"));
      checks = { ...compareChecks(stableChecks, candChecks), results: candChecks.results, stable: stableChecks.results };
    }
    const infraRate = holdRecs.length ? holdRecs.filter(r => ["infra_error", "model_unavailable"].includes(r.terminal_status)).length / holdRecs.length : 0;
    const decision = adoptionDecision(cmp, p, { holdoutIndependent: independent.independent, holdoutWhy: independent.why, critical, checksPassed: checks.pass, checksDetail: checks.problems?.join("; ") || "ok", routeOk, routeDetail: `${envs.size} environment digest(s)`, incomplete, infraRate });
    const final = { candidate: sel.selected, verdict: decision.verdict, adopt: decision.adopt, reasons: decision.reasons, holdout: cmp ? { support: cmp.support, delta: cmp.delta, familyDelta: cmp.familyDelta, tasks: cmp.tasks, families: cmp.families, hardTasks: cmp.hardTasks, point: cmp.point } : null, independence: independent, checks };
    this.event("adoption-decision", final);
    this.archive.decide(sel.selected, decision.adopt ? "selected" : decision.verdict === "BLOCKED" ? "holdout_blocked" : "holdout_kept_stable", decision.reasons.join("; "));
    this.setPhase(decision.adopt ? "adopt" : "done", { final });
  }

  adopt() {
    this.assertNotHalted("adoption");
    const sel = this.state.selection, final = this.state.final;
    if (!final?.adopt || final.candidate !== sel?.selected) { this.halt("state integrity: adoption requested without an ADOPT decision for the frozen selection"); return; }
    const result = this.deployer.adopt({ commit: sel.commit, candidateId: sel.selected, evaluation: { holdout: final.holdout, reportPath: join(this.stateDir, "report.md"), protocolDigest: this.protocolDigest }, configFiles: [join(this.stateDir, "protocol.lock.json")] });
    this.fault?.("loop:after-deploy");
    if (this.archive.get(sel.selected).status !== "adopted") this.archive.decide(sel.selected, "adopted", `adopted on local refs ${this.protocol.deploy.branch} (mode ${this.protocol.deploy.mode})`);
    this.fault?.("loop:after-archive");
    if (!result.resumed || !this.events.records().some(e => e.type === "adopted" && e.id === sel.selected)) this.event("adopted", { id: sel.selected, previous: result.previous.digest, next: result.next.digest });
    this.setPhase("post-adopt", { adoption: { at: new Date().toISOString(), previous: result.previous, next: result.next } });
  }

  /** Post-adoption check: the adopted harness must load and run (no crash) on one dev task; else automatic rollback. */
  async postAdopt() {
    const sel = this.state.selection;
    const probe = this.split.dev[0];
    const [rec] = await this.evaluator.evaluate(this.harness(sel.selected), [{ task: probe, split: "post-adopt", repeat: 0 }], "post-adopt:smoke");
    if (rec && (rec.terminal_status === "harness_crash" || rec.terminal_status === "route_violation")) {
      const rb = this.deployer.rollback({ reason: `post-adoption smoke: ${rec.terminal_status} ${rec.terminal_detail}` });
      this.archive.decide(sel.selected, "rolled_back", `automatic rollback: ${rec.terminal_status}`);
      this.state.final.rolledBack = { at: new Date().toISOString(), problems: rb.problems };
    }
    this.setPhase("done");
  }

  /**
   * Independent regression check of the current stable against the snapshot before the latest adoption, on a sealed task set
   * the selection never saw; a supported regression rolls back automatically.
   * @param {{ tasks: any[], split?: string, repeats?: number }} options repeats defaults to the protocol's holdout repeats
   */
  async verifyStable({ tasks, split = "verify", repeats }) {
    this.assertNotHalted("stable verification");
    const prev = this.deployer.previousStable();
    if (!prev) return { verdict: "NOTHING_TO_VERIFY" };
    const current = this.deployer.current();
    const adoptedId = this.archive.all().find(c => c.status === "adopted" && c.commit === current.orche.effective)?.id;
    if (!adoptedId) return { verdict: "NOTHING_TO_VERIFY", reason: "current stable is not an eval-loop adoption" };
    const prevHarness = { id: "previous-stable", kind: "orche", commit: prev.orche.effective, mode: this.protocol.target.mode, dir: this.worktreeFor("previous-stable", prev.orche.effective) };
    for (const t of tasks) this.tasksById[t.id] ??= t;
    const units = tasks.flatMap(t => Array.from({ length: repeats ?? this.protocol.holdout.repeats }, (_, r) => ({ task: t.id, split, repeat: r })));
    await this.evaluator.evaluate(prevHarness, units, "verify:previous");
    await this.evaluator.evaluate(this.harness(adoptedId), units, "verify:adopted");
    const pairs = pairsOf(this.samples(), { a: "previous-stable", b: adoptedId, split, tasks: tasks.map(t => t.id), meta: this.tasksById });
    const cmp = adoptionCompare(pairs.map(t => ({ ...t, a: t.b, b: t.a })), this.protocol, `${this.protocol.seed}:verify:${adoptedId}`); // previous vs adopted: support = previous better
    const regression = cmp.support >= this.protocol.adoption.support;
    const result = { verdict: regression ? "REGRESSION_ROLLED_BACK" : "NO_SUPPORTED_REGRESSION", support: cmp.support, delta: cmp.delta };
    if (regression) { const rb = this.deployer.rollback({ reason: `independent verification: previous stable better with support ${cmp.support}` }); this.archive.decide(adoptedId, "rolled_back", "independent post-adoption regression"); result.rollback = rb.problems; }
    this.event("verify-stable", result);
    return result;
  }

  /** Inputs whose change justifies a new cycle (new tasks, harness code, environment). */
  fingerprint() {
    return digestOf({ orche: head(this.orche), stable: this.state.stable?.commit, datasets: readJson(join(this.stateDir, "datasets.json"), {}).digests, env: this.envDigest, protocol: this.protocolDigest });
  }

  /** Start the next cycle after a finished one (new stable = the eval-loop/stable ref when an adoption happened). */
  nextCycle() {
    this.assertNotHalted("a new cycle");
    const prev = this.state;
    const history = [...(prev.history ?? []), { cycle: prev.cycle, final: prev.final, selection: prev.selection, searchStop: prev.searchStop, doneAt: prev.doneAt, fingerprint: prev.cycleFingerprint }];
    // The binding carries over: every cycle of a state directory runs under the one lock it was bound to.
    this._state = { phase: "prepare", cycle: prev.cycle + 1, strategy: this.strategy, counters: { candidates: 0, noProgress: 0, consecutiveInfra: 0 }, startedAt: new Date().toISOString(), history, protocolLock: prev.protocolLock };
    this.save();
    this.event("cycle-start", { cycle: this._state.cycle });
  }

  /** Run until the cycle is done (or blocked/halted/interrupted). Returns the state. A blocked state resumes at its recorded phase. */
  async runCycle() {
    if (this.haltedNow()) return this.state;
    if (!(await this.prepare())) return this.state;
    for (let guard = 0; guard < 10_000 && !this.stopping; guard++) {
      if (this.haltedNow()) break;
      const phase = this.state.phase;
      if (phase === this.stopBefore) break;
      if (phase === "prepare") this.setPhase("baselines");
      else if (phase === "baselines") await this.baselines();
      else if (phase === "search") await this.search();
      else if (phase === "select") this.select();
      else if (phase === this.stopBefore) break;
      else if (phase === "holdout") await this.holdout();
      else if (phase === "adopt") this.adopt();
      else if (phase === "post-adopt") await this.postAdopt();
      else break;
    }
    if (this.state.phase === "done" && !this.state.cycleFingerprint) { this.state.cycleFingerprint = this.fingerprint(); this.state.doneAt = new Date().toISOString(); this.save(); }
    return this.state;
  }
}

import { execFileSync } from "node:child_process";
function execGit(cwd, args) { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }

/**
 * Quality-only (greedy) progress: a development-qualified candidate whose exact Q_overall beats the current best by more than
 * floating-point noise (POINT_EPS).
 * @param {boolean} qualified @param {{ overall: number }} point @param {{ overall: number }} bestPoint
 */
export const greedyProgress = (qualified, point, bestPoint) => Boolean(qualified) && pointGt(point.overall, bestPoint.overall);

/** Final state of an exploration-only cycle: deployment BLOCKED (no holdout), recorded separately from the exploration outcome. */
export function explorationOnlyFinal(selection) {
  return {
    candidate: selection?.selected ?? null, verdict: "BLOCKED", adopt: false, explorationOnly: true,
    exploration: selection?.selected ? `selected on development and frozen: ${selection.selected}` : `no candidate selected (${selection?.reason ?? "none"})`,
    reasons: ["exploration-only protocol (datasets.holdout = null): no unconsumed independent holdout is available, so no candidate can be validated or deployed; a development selection is not evidence of improvement"],
  };
}
export { readFileSync };
