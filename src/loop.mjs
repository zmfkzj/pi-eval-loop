// The persistent, resumable optimization loop (one cycle):
//   prepare (protocol lock, prerequisites, grader validation, family-grouped splits, sealed holdout)
//   -> baselines (stable orche on train+dev; pure Pi, target mode, k independent attempts on dev)
//   -> search: select parent -> failure analysis -> candidate patch (isolated worktree) -> patch/build checks -> screening
//      (matched repeats, adaptive) -> development -> archive / Pareto front -> watchdog
//   -> final selection (development) -> holdout (once) -> adoption gate -> adopt (local refs) / keep stable -> post-adoption check
// Every step is recorded on disk; a crash resumes at the recorded phase and reuses completed units.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Archive, patchKey, selectParent } from "./archive.mjs";
import { analyze } from "./analysis.mjs";
import { Deployer } from "./deploy.mjs";
import { Evaluator } from "./evaluator.mjs";
import { adoptionCompare, adoptionDecision, criticalProblems, developmentCompare, developmentDecision, screeningCompare, screeningDecision, taskLevelPromotion } from "./gate.mjs";
import { changedProtected, patchIntegrity, protectedSnapshot } from "./integrity.mjs";
import { finalAttempts, missingUnits, pairsOf, summarize } from "./metrics.mjs";
import { evaluatorFiles, fileDigests, lockProtocol, PACKAGE_DIR, UMBRELLA } from "./protocol.mjs";
import { createRng } from "./rng.mjs";
import { describeArm } from "./stats.mjs";
import { holdoutLedger, holdoutStatus, loadLocal, loadSuite, screeningBatch, splitByFamily, taskDigest, validateSplits, verifySeal } from "./datasets.mjs";
import { atomicWriteJson, digestOf, ensureDir, Ledger, readJson, sha256 } from "./util.mjs";
import { changes, commit as commitWorktree, createWorktree, head, snapshotWorktree } from "./worktree.mjs";
import { writeEvidence } from "./proposer.mjs";
import { compareChecks } from "./checks.mjs";

export const PHASES = ["prepare", "baselines", "search", "select", "holdout", "adopt", "post-adopt", "done", "blocked"];

export class Loop {
  /**
   * opts: { stateDir, protocol, backend, env, envDigest, proposer, strategy ("pareto"|"greedy"), checks(worktree, which) -> {pass},
   *         prerequisites() -> [{name, ok}], datasets? (injected for tests: { tasks, holdoutDir, holdoutTasks }), umbrella, orche, log }
   */
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
  get state() { return this._state ??= readJson(this.statePath(), { phase: "prepare", cycle: 1, strategy: this.strategy, counters: { candidates: 0, noProgress: 0, consecutiveInfra: 0 }, startedAt: new Date().toISOString() }); }
  save() { this.state.updatedAt = new Date().toISOString(); atomicWriteJson(this.statePath(), this.state); }
  event(type, data = {}) { this.events.append({ type, ...data }); }
  setPhase(phase, extra = {}) { Object.assign(this.state, extra); this.state.phase = phase; this.save(); this.event("phase", { phase }); this.log(`phase -> ${phase}`); }

  // ---------------------------------------------------------------------------------------------------------------------- prepare
  async prepare() {
    const p = this.protocol;
    const prereq = this.prerequisites ? await this.prerequisites() : [];
    const missing = prereq.filter(x => !x.ok);
    this.state.prerequisites = prereq;
    if (missing.length) { this.setPhase("blocked", { blocked: { reason: "missing prerequisites", missing } }); return false; }
    const data = this.datasets ?? this.loadDatasets();
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
    if (problems.length) { this.setPhase("blocked", { blocked: { reason: "split validation failed", problems } }); return false; }
    const datasetManifest = { train: split.train, dev: split.dev, holdout, excluded, digests: Object.fromEntries(Object.values(tasksById).map(t => [t.id, taskDigest(t)])), holdoutSeal: data.holdoutDir ? verifySeal(data.holdoutDir).seal?.digest ?? null : null, meta: Object.fromEntries(Object.values(tasksById).map(t => [t.id, { family: t.family, tier: t.tier, hard: t.hard, source: t.source, provenance: t.provenance }])) };
    const { lock, problems: lockProblems, created } = lockProtocol(this.stateDir, p, { datasetDigest: digestOf(datasetManifest), orcheDir: this.orche });
    if (lockProblems.length) { this.setPhase("blocked", { blocked: { reason: "protocol/evaluator/dataset changed since the lock: start a new protocol version in a new state directory", problems: lockProblems } }); return false; }
    atomicWriteJson(join(this.stateDir, "datasets.json"), datasetManifest);
    this.protocolDigest = lock.protocolDigest;
    this.tasksById = tasksById; this.split = { ...split, holdout }; this.grading = grading; this.holdoutDir = data.holdoutDir;
    this.evaluator = new Evaluator({ stateDir: this.stateDir, protocol: p, protocolDigest: lock.protocolDigest, envDigest: this.envDigest, tasksById, grading, backend: this.backend, log: this.log });
    if (created) this.event("protocol-locked", { protocolDigest: lock.protocolDigest });
    // The stable harness: the local eval-loop/stable ref when one exists (an earlier adoption), else orche's HEAD commit.
    if (!this.state.stable) {
      let stableCommit; try { stableCommit = execGit(this.orche, ["rev-parse", "--verify", "--quiet", `refs/heads/${p.deploy.branch}^{commit}`]); } catch { stableCommit = head(this.orche); }
      this.state.stable = { id: "stable", commit: stableCommit };
      this.save();
    }
    if (!this.archive.get("stable")) this.archive.create({ id: "stable", parent: null, status: "baseline", origin: "baseline", commit: this.state.stable.commit, hypothesis: null });
    this.harnesses = this.baselineHarnesses();
    return true;
  }

  loadDatasets() {
    const tasks = loadSuite(join(this.orche, "fixtures/suite")).filter(t => (!this.protocol.datasets.include || this.protocol.datasets.include.includes(t.id)) && !(this.protocol.datasets.exclude ?? []).includes(t.id));
    const holdoutDir = resolve(PACKAGE_DIR, this.protocol.datasets.holdout);
    const holdoutTasks = existsSync(holdoutDir) ? loadLocal(holdoutDir) : [];
    return { tasks, holdoutDir: existsSync(holdoutDir) ? holdoutDir : undefined, holdoutTasks };
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

  // -------------------------------------------------------------------------------------------------------------------- baselines
  async baselines() {
    const p = this.protocol;
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

  devPairs(a, b) { return pairsOf(this.records(), { a, b, split: "dev", tasks: this.split.dev, meta: this.tasksById }); }
  recordDevelopment(id, decision, cmp) {
    const pairs = this.devPairs(id, id).map(t => ({ ...t, a: t.b }));
    const described = describeArm(pairs, { draws: this.protocol.bootstrap.draws, seed: `${this.protocol.seed}:dev:${id}` });
    const point = Object.fromEntries(Object.entries(described).map(([k, v]) => [k, v.mean]));
    const c = this.archive.get(id);
    c.development = { tasks: this.split.dev.length, repeats: this.protocol.development.repeats, point, posterior: described, qualified: decision.qualified, reasons: decision.reasons, vsStable: cmp ? { support: cmp.support, lossSupport: cmp.lossSupport, delta: cmp.delta, familyDelta: cmp.familyDelta } : undefined, summary: summarize(this.records(), id, "dev") };
    this.archive.put(c);
  }

  // ----------------------------------------------------------------------------------------------------------------------- search
  watchdog() {
    const w = this.protocol.watchdog, c = this.state.counters;
    if (this.stopping) return "interrupted";
    if (c.noProgress >= w.noProgressCandidates) return `no meaningful progress in ${c.noProgress} consecutive candidates`;
    if (c.candidates >= w.maxCandidatesPerCycle) return `candidate cap of ${w.maxCandidatesPerCycle} per cycle reached (safety limit)`;
    if (Date.now() - Date.parse(this.state.cycleStartedAt ?? this.state.startedAt) > w.maxCycleWallMs) return "cycle wall-time watchdog";
    if (c.consecutiveInfra >= w.maxConsecutiveInfra) return `infrastructure failing (${c.consecutiveInfra} consecutive candidates with infra-tainted screening)`;
    return undefined;
  }

  async search() {
    this.state.cycleStartedAt ??= new Date().toISOString();
    while (true) {
      const stop = this.watchdog();
      if (stop) { this.event("search-stopped", { reason: stop }); this.state.searchStop = stop; this.save(); if (stop !== "interrupted") this.setPhase("select"); return; }
      const current = this.state.current;
      if (current) await this.continueCandidate(current.id);
      else if (!(await this.newCandidate())) { this.state.searchStop = "no addressable failure class left"; this.event("search-stopped", { reason: this.state.searchStop }); this.setPhase("select"); return; }
    }
  }

  chooseTarget(parentId) {
    const recs = finalAttempts(this.records().filter(r => r.candidate_id === parentId && r.split === "train"));
    const reference = finalAttempts(this.records().filter(r => r.candidate_id === "pure" && r.split === "train"));
    const analysis = analyze(recs, { reference });
    const failures = this.archive.failuresByClass();
    const blocked = Object.entries(failures).filter(([, n]) => n >= this.protocol.watchdog.maxFailuresPerClass).map(([c]) => c);
    const target = analysis.hypotheses.find(h => !blocked.includes(h.class) && h.class !== "integrity");
    return { analysis, target, blocked, recs };
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
    const { analysis, target, blocked, recs } = chosen;
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
    // Evidence for the optimizer: train failures and development aggregates only (never holdout, never hidden test content).
    const evidenceDir = writeEvidence(join(candDir, "evidence"), { trainRecords: recs, analysis, devSummary: summarize(this.records(), parentId, "dev"), tasksById: this.tasksById });
    const before = this.protectedState();
    const result = await this.proposer.propose({ worktree: wt.dir, evidenceDir, protocol: p, env: this.env, parentId, targetClass: target.class, blockedClasses: blocked, logDir: join(candDir, "proposer") });
    const after = this.protectedState();
    const breached = changedProtected(before, after);
    const c = this.archive.get(id);
    c.proposer = { usage: result.usage, detail: result.detail };
    this.archive.put(c);
    if (breached.length) {
      this.archive.decide(id, "rejected_patch", `TRUST BOUNDARY: protected state changed during candidate generation: ${breached.join(", ")}`);
      this.state.current = null; this.stopping = true; this.state.halted = `trust boundary breach: ${breached.join(", ")}`; this.save();
      this.event("trust-boundary-breach", { id, breached });
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
    const build = this.checks ? await this.checks(wt.dir, ["typecheck"], join(candDir, "checks")) : { pass: true };
    if (!build.pass) { this.archive.decide(id, "build_failed", `typecheck failed: ${JSON.stringify(build.results?.typecheck?.tail ?? "").slice(0, 400)}`); this.endCandidate(false); return true; }
    this.state.current = { id, step: "screen", repeats: p.screening.minRepeats, batch: screeningBatch(this.split.train, this.tasksById, p.screening.tasks, `${p.seed}:screen:${id}`) };
    this.archive.decide(id, "screening", `screening batch ${this.state.current.batch.join(", ")}`);
    this.save();
    return true;
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

  async screen(id) {
    const p = this.protocol, cur = this.state.current;
    const c = this.archive.get(id);
    const parent = this.harness(c.parent), cand = this.harness(id);
    const units = this.units("train", cur.repeats, cur.batch);
    await this.evaluator.evaluate(parent, units, `screen:${id}:parent`);
    await this.evaluator.evaluate(cand, units, `screen:${id}:candidate`);
    const records = this.records();
    const scope = new Set(units.map(u => `${u.split}|${u.task}|${u.repeat}`));
    const critical = criticalProblems(records, id, { reference: c.parent, units: scope });
    const pairs = pairsOf(records, { a: c.parent, b: id, split: "train", tasks: cur.batch, meta: this.tasksById }).map(t => ({ ...t, a: t.a.slice(0, cur.repeats), b: t.b.slice(0, cur.repeats) }));
    const missing = pairs.filter(t => t.a.length < cur.repeats || t.b.length < cur.repeats);
    const candRuns = finalAttempts(records.filter(r => r.candidate_id === id && scope.has(`${r.split}|${r.task_id}|${r.repeat}`)));
    const infraRate = candRuns.length ? candRuns.filter(r => ["infra_error", "model_unavailable"].includes(r.terminal_status)).length / candRuns.length : 0;
    const round = { at: new Date().toISOString(), repeats: cur.repeats, tasks: cur.batch };
    if (critical.length) { this.archive.decide(id, "rejected", `critical: ${critical.slice(0, 4).join("; ")}`, { screening: { ...(c.screening ?? {}), rounds: [...(c.screening?.rounds ?? []), { ...round, critical }] } }); this.endCandidate(false, infraRate); return; }
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
    await this.evaluator.evaluate(cand, this.units("dev", p.development.repeats), `develop:${id}`);
    // Its own train runs: the evidence when it becomes a parent.
    await this.evaluator.evaluate(cand, this.units("train", p.screening.minRepeats), `develop:${id}:train`);
    const records = this.records();
    const critical = criticalProblems(records, id, { reference: "stable", units: new Set(this.units("dev", p.development.repeats).map(u => `dev|${u.task}|${u.repeat}`)) });
    const cmp = developmentCompare(this.devPairs("stable", id), p, `${p.seed}:dev:${id}`);
    const decision = developmentDecision(cmp, p, critical);
    this.recordDevelopment(id, decision, cmp);
    this.archive.decide(id, decision.qualified ? "dev_qualified" : "dev_rejected", decision.reasons.join("; "));
    const front = this.archive.front();
    const progress = decision.qualified && front.includes(id);
    if (this.strategy === "greedy" && decision.qualified) {
      // Quality-only ablation: the single current best by development Q_overall replaces the parent; no archive of alternatives.
      const best = this.archive.get(this.state.greedyBest ?? "stable");
      if (this.archive.get(id).development.point.overall > best.development.point.overall) this.state.greedyBest = id;
    }
    this.event("development", { id, qualified: decision.qualified, front, progress });
    this.endCandidate(progress, 0);
  }

  endCandidate(progress, infraRate = 0) {
    const c = this.state.counters;
    c.noProgress = progress ? 0 : c.noProgress + 1;
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
    const a = this.protocol.adoption;
    const qualified = this.archive.all().filter(c => c.status === "dev_qualified" || (c.status === "selected" && c.development?.qualified));
    const eligible = qualified.filter(c => {
      const fam = c.development?.vsStable?.familyDelta ?? {};
      return !Object.values(fam).some(d => d.probBelow >= a.familyRegressionSupport);
    });
    const order = (x, y) => (y.development.point.overall - x.development.point.overall) || ((y.development.point.hard ?? 0) - (x.development.point.hard ?? 0)) || ((y.development.point.consistency ?? 0) - (x.development.point.consistency ?? 0)) || x.id.localeCompare(y.id);
    // Quality-only ablation (greedy): its single current best; Pareto loop: the best development-qualified candidate of the archive.
    const best = this.strategy === "greedy" ? eligible.find(c => c.id === this.state.greedyBest) : [...eligible].sort(order)[0];
    const stable = this.archive.get("stable");
    const selection = { at: new Date().toISOString(), considered: qualified.map(c => c.id), eligible: eligible.map(c => c.id), selected: best && best.development.point.overall > stable.development.point.overall ? best.id : null };
    if (!selection.selected) selection.reason = eligible.length ? "no development-qualified candidate beats the stable harness on development Q_overall" : "no development-qualified candidate without family regression";
    else { selection.commit = this.archive.get(selection.selected).commit; selection.frozenDigest = digestOf({ id: selection.selected, commit: selection.commit, protocol: this.protocolDigest }); this.archive.decide(selection.selected, "selected", "final selection on development (frozen before holdout access)"); }
    atomicWriteJson(join(this.stateDir, "selection.json"), selection);
    this.event("selection", selection);
    this.setPhase(selection.selected ? "holdout" : "done", { selection, final: selection.selected ? undefined : { verdict: "KEEP_STABLE", reasons: [selection.reason] } });
  }

  async holdout() {
    const p = this.protocol, sel = this.state.selection;
    const status = this.holdoutDir ? holdoutStatus(this.split.holdout.map(id => this.tasksById[id]), this.holdoutDir, p, { orcheDir: this.orche, ledgerPath: this.holdoutLedgerPath }) : { independent: false, why: "no holdout dataset" };
    // Consume BEFORE the first holdout run (a crash still consumes it); a resumed holdout phase reuses its own recorded use.
    const ledger = this.holdoutDir ? holdoutLedger(this.holdoutDir, this.holdoutLedgerPath) : undefined;
    if (!this.state.holdoutUse) {
      this.state.holdoutIndependentAtStart = status;
      if (ledger) this.state.holdoutUse = ledger.append({ type: "use", stateDir: this.stateDir, protocolDigest: this.protocolDigest, selected: sel.selected, commit: sel.commit, frozenDigest: sel.frozenDigest, independentBefore: status.independent, why: status.why });
      else this.state.holdoutUse = { none: true };
      this.save();
    }
    const independent = this.state.holdoutIndependentAtStart;
    // Arms of this ONE holdout pass: stable, extra measured arms (A/B/C ablation finals) and the selected candidate.
    const arms = [...new Set(["stable", ...(sel.extraArms ?? []), ...(sel.selected ? [sel.selected] : [])])];
    let cmp, incomplete = [], records = [];
    if (this.split.holdout.length) {
      const units = this.units("holdout", p.holdout.repeats);
      for (const id of arms) await this.evaluator.evaluate(this.harness(id), units, `holdout:${id}`);
      records = this.records();
      incomplete = missingUnits(records, arms.flatMap(id => units.map(u => this.evaluator.keyOf(this.harness(id), u.task, u.split, u.repeat))));
      if (sel.selected) cmp = adoptionCompare(pairsOf(records, { a: "stable", b: sel.selected, split: "holdout", tasks: this.split.holdout, meta: this.tasksById }), p, `${p.seed}:holdout:${sel.selected}`);
    }
    if (!sel.selected) {
      const final = { candidate: null, verdict: "KEEP_STABLE", adopt: false, reasons: ["no candidate selected on development; holdout measured for the listed arms only"], arms, incomplete: incomplete.length, independence: independent };
      this.event("adoption-decision", final);
      this.setPhase("done", { final });
      return;
    }
    const holdRecs = finalAttempts(records.filter(r => r.split === "holdout"));
    const critical = criticalProblems(records.filter(r => r.split === "holdout"), sel.selected, { reference: "stable" });
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
    const sel = this.state.selection, final = this.state.final;
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
   */
  async verifyStable({ tasks, split = "verify", repeats }) {
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
    const pairs = pairsOf(this.records(), { a: "previous-stable", b: adoptedId, split, tasks: tasks.map(t => t.id), meta: this.tasksById });
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
    const prev = this.state;
    const history = [...(prev.history ?? []), { cycle: prev.cycle, final: prev.final, selection: prev.selection, searchStop: prev.searchStop, doneAt: prev.doneAt, fingerprint: prev.cycleFingerprint }];
    this._state = { phase: "prepare", cycle: prev.cycle + 1, strategy: this.strategy, counters: { candidates: 0, noProgress: 0, consecutiveInfra: 0 }, startedAt: new Date().toISOString(), history };
    this.save();
    this.event("cycle-start", { cycle: this._state.cycle });
  }

  /** Run until the cycle is done (or blocked/interrupted). Returns the state. */
  async runCycle() {
    if (this.state.phase === "blocked") { delete this.state.blocked; this.state.phase = "prepare"; }
    if (!(await this.prepare())) return this.state;
    for (let guard = 0; guard < 10_000 && !this.stopping; guard++) {
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
export { readFileSync };
