// Autonomous improvement lifecycle (2026-11-07): the bridge exploration -> prospectively registered confirmatory holdout ->
// gate-driven adoption -> smoke -> independent post-adoption confirmation, on top of the exploration route (src/explore-cycle.mjs).
// This module holds the pieces that are not exploration: the confirmatory policy (a registered study protocol, bound by sha256,
// complete by src/design.mjs planCompleteness, declared ready by its own readiness record, affordable under the ONE attempt ledger),
// the release pointer deployer (content-addressed immutable harness releases + an atomically replaced pointer + a hash-chained
// history; no git commit, no working-tree change) and the smoke run. Nothing here lowers a gate: the confirmatory pass uses the
// registered protocol's thresholds and the original adoption gate (src/gate.mjs adoptionDecision) with its confirmatory checks.
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Evaluator } from "./evaluator.mjs";
import { planCompleteness, planPath, seriesFits } from "./design.mjs";
import { exploreProtocol, runtimeDigest } from "./exploration.mjs";
import { merge } from "./protocol.mjs";
import { acquireLock, atomicWriteJson, digestOf, ensureDir, fault, Ledger, readJson, sha256 } from "./util.mjs";
import { attemptAdmission } from "./admission.mjs";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LIFECYCLE_OUTCOMES = Object.freeze(["explored-negative", "confirm-negative", "adopted", "confirmed", "rolled-back"]);

// ------------------------------------------------------------------------------------------------------------- confirmatory policy
/**
 * The confirmatory protocol of the lifecycle and its admission (model-free, read-only). `cfg.confirmation`:
 *   { protocol: abs path of a registered study protocol ({holdout, adoption, analysisPlan} with analysisPlan.mode "confirmatory"),
 *     protocolSha256, readiness: abs path of the study's readiness record, attemptsPerUnit: measured upper bound of target attempts
 *     per unit (no default), smokeAttempts, deploy: { dir } }.
 * Returns { problems: [{code, why}], p (merged protocol), plan, units, minRemaining, protocolSha256, readinessSha256 }.
 * Codes: config-invalid (fail closed), confirmation-plan-not-ready (plan incomplete or the study's own readiness record does not
 * declare its analysis plan fulfilled -- e.g. provisional power), confirmation-infeasible (the remaining attempts of the ONE
 * ledger cannot cover the registered confirmatory pass + post-adoption confirmation + smoke).
 */
export function confirmationPolicy(cfg, { remaining = null, reserved = 0 } = {}) {
  const c = cfg.confirmation, problems = [];
  const bad = (why) => ({ problems: [{ code: "config-invalid", why }] });
  if (!c || typeof c !== "object") return bad("confirmation section required in autonomous mode");
  for (const k of ["protocol", "readiness"]) if (typeof c[k] !== "string" || !c[k].startsWith("/")) return bad(`confirmation.${k} must be an absolute path`);
  if (!/^[0-9a-f]{64}$/.test(c.protocolSha256 ?? "")) return bad("confirmation.protocolSha256 required");
  if (!(Number.isInteger(c.attemptsPerUnit) && c.attemptsPerUnit > 0)) return bad("confirmation.attemptsPerUnit (measured upper bound per unit) required");
  if (!(Number.isInteger(c.smokeAttempts) && c.smokeAttempts > 0)) return bad("confirmation.smokeAttempts required");
  if (typeof c.deploy?.dir !== "string" || !c.deploy.dir.startsWith("/")) return bad("confirmation.deploy.dir must be an absolute path");
  if (!existsSync(c.protocol) || sha256(readFileSync(c.protocol)) !== c.protocolSha256) return bad("confirmation.protocol missing or changed since it was bound (sha256)");
  let reg; try { reg = JSON.parse(readFileSync(c.protocol, "utf8")); } catch (error) { return bad(`confirmation.protocol unreadable: ${error.message}`); }
  if (reg?.analysisPlan?.mode !== "confirmatory") return bad("confirmation.protocol must register a confirmatory analysis plan");
  const part = { holdout: reg.holdout ?? {}, adoption: reg.adoption ?? {}, analysisPlan: reg.analysisPlan };
  let p; try { p = merge(exploreProtocol(), part); } catch (error) { return bad(`confirmation.protocol does not fit the protocol schema: ${error.message}`); }
  const plan = p.analysisPlan;
  // Floors: a registered protocol may only be stricter than the exploration route's original gates (never disable a check).
  for (const f of floorProblems(p)) return bad(`confirmation.protocol weakens an original gate: ${f}`);
  for (const m of planCompleteness(p, { base: PACKAGE_DIR })) problems.push({ code: "confirmation-plan-not-ready", why: `registered plan incomplete: ${m}` });
  if (!problems.length) {
    const fit = seriesFits(planPath(plan.series.ledger, PACKAGE_DIR), { series: plan.series.id, alphaTotal: plan.series.alphaTotal, alpha: plan.alpha + (plan.confirmation?.required ? plan.confirmation.alpha : 0), stateDir: "(admission)" });
    if (!fit.ok) problems.push({ code: "confirmation-infeasible", why: `series error budget: ${fit.why}` });
  }
  // attemptsPerUnit must cover the largest per-unit attempt count actually measured on this candidate's screen (no guess below it).
  const measured = measuredAttemptsPerUnit(cfg);
  if (measured === null) problems.push({ code: "confirmation-plan-not-ready", why: "no measured per-unit attempt counts (screen.runs) to size the confirmation budget" });
  else if (c.attemptsPerUnit < measured) return bad(`confirmation.attemptsPerUnit ${c.attemptsPerUnit} is below the measured per-unit maximum ${measured}`);
  let readinessSha256 = null;
  if (!existsSync(c.readiness)) problems.push({ code: "confirmation-plan-not-ready", why: `readiness record missing: ${c.readiness}` });
  else {
    readinessSha256 = sha256(readFileSync(c.readiness));
    let r; try { r = JSON.parse(readFileSync(c.readiness, "utf8")); } catch { r = null; }
    const cond = Array.isArray(r?.conditions) ? r.conditions.find(x => x.id === "analysis-plan") : null;
    // The readiness record must be about THIS registered protocol (bound by its sha256), else it says nothing about it.
    if (r && r.protocolSha256 !== c.protocolSha256) problems.push({ code: "confirmation-plan-not-ready", why: "readiness record is not bound to this protocol (protocolSha256 missing or different): stale or substituted evidence" });
    if (!cond) problems.push({ code: "confirmation-plan-not-ready", why: "readiness record has no analysis-plan condition" });
    else if (cond.status !== "fulfilled") problems.push({ code: "confirmation-plan-not-ready", why: `the study's analysis plan is ${cond.status} (power/effect justification not established; nothing is assumed adequate): ${(cond.reasons ?? []).join("; ").slice(0, 300)}` });
  }
  const repeats = p.holdout.repeats;
  const confUnits = 2 * (plan.minTasks ?? 0) * repeats;
  const postUnits = plan.confirmation?.required ? 2 * (plan.confirmation.minTasks ?? 0) * repeats : 0;
  const minRemaining = (confUnits + postUnits) * c.attemptsPerUnit + c.smokeAttempts;
  if (remaining !== null && remaining < minRemaining) problems.push({ code: "confirmation-infeasible", why: `the registered confirmation needs ${confUnits} + ${postUnits} units x ${c.attemptsPerUnit} attempts + smoke ${c.smokeAttempts} = ${minRemaining} attempts; only ${remaining} attempts of the cumulative ledger are available for it${reserved ? ` (ledger remaining ${remaining + reserved} minus the exploration headroom ${reserved})` : ""}; even at 1 attempt per unit it needs ${confUnits + postUnits} (the cap is never raised here)` });
  return { problems, p, plan, units: { confirm: confUnits, post: postUnits }, minRemaining, protocolSha256: c.protocolSha256, readinessSha256, registered: part };
}

/** The protocol of one confirmatory test (purpose holdout | confirmation): confirmation thresholds never below the holdout floors. */
export function testProtocol(registered, purpose) {
  const part = structuredClone(registered);
  if (purpose === "confirmation") {
    const conf = part.analysisPlan.confirmation;
    const base = exploreProtocol().holdout;
    const minTasks = Math.max(conf.minTasks, base.minTasks), minFamilies = Math.max(conf.minFamilies, base.minFamilies);
    part.analysisPlan = { ...part.analysisPlan, alpha: conf.alpha, minTasks, minFamilies };
    part.holdout = { ...part.holdout, minTasks: Math.max(minTasks, part.holdout.minTasks ?? 0), minFamilies: Math.max(minFamilies, part.holdout.minFamilies ?? 0) };
  }
  return part;
}

/** Original gates a registered protocol must not weaken (compared with the exploration route's protocol). */
export function floorProblems(p) {
  const b = exploreProtocol(), out = [];
  const ge = (path, x, y) => { if (!(x >= y)) out.push(`${path} ${x} < ${y}`); };
  ge("holdout.minTasks", p.holdout.minTasks, b.holdout.minTasks); ge("holdout.minFamilies", p.holdout.minFamilies, b.holdout.minFamilies);
  ge("holdout.repeats", p.holdout.repeats, b.holdout.repeats); ge("adoption.support", p.adoption.support, b.adoption.support);
  for (const k of ["requireIndependent"]) if (p.holdout[k] !== true) out.push(`holdout.${k} must stay true`);
  if (p.holdout.maxUses !== 1) out.push("holdout.maxUses must stay 1");
  for (const k of ["requireHardStratum", "requireFamilyLevel", "requireChecks"]) if (p.adoption[k] !== true) out.push(`adoption.${k} must stay true`);
  if ((p.holdout.hardBasis ?? []).includes("size-proxy")) out.push("size-proxy can never be a hard basis");
  if (!(p.holdout.maxOwnerShare <= b.holdout.maxOwnerShare)) out.push(`holdout.maxOwnerShare ${p.holdout.maxOwnerShare} > ${b.holdout.maxOwnerShare}`);
  if (p.holdout.priorFamilyReuse !== "forbid") out.push("holdout.priorFamilyReuse must stay forbid");
  return out;
}

/** The largest per-unit target attempt count measured in the candidate's screen (screen.runs), or null. */
export function measuredAttemptsPerUnit(cfg) {
  const f = cfg.screen?.runs;
  if (!f || !existsSync(f)) return null;
  let max = null;
  for (const l of readFileSync(f, "utf8").split("\n")) { if (!l) continue; let e; try { e = JSON.parse(l); } catch { continue; } if (e?.type === "result" && Number.isFinite(e.record?.model_requests)) max = Math.max(max ?? 0, e.record.model_requests); }
  return max;
}

// ------------------------------------------------------------------------------------------------------------- release pointer
/**
 * Release pointer deployer. `<dir>/releases/<runtimeDigest>/` holds an immutable copy of a harness tree (verified by digest);
 * `<dir>/current.json` names the deployed release; `<dir>/history.jsonl` (hash chain) records every init/adopt/rollback with the
 * deciding evidence. Adoption and rollback are compare-and-swap on current.json under `<dir>/.deploy.lock`, idempotent per key.
 */
export class Releases {
  // The hash-chained history is the commit log: the deployed release is the release named by its last init/adopt/rollback record.
  // current.json is a derived pointer for readers, rewritten after every record and repaired from the history whenever it differs
  // (an interruption between the history append and the pointer write leaves a recoverable, never ambiguous, state).
  constructor(dir) { this.dir = resolve(dir); this.history = new Ledger(join(this.dir, "history.jsonl")); }
  #last() {
    if (!existsSync(join(this.dir, "history.jsonl"))) return null;
    const problems = this.history.verify();
    if (problems.length) throw new Error(`release history chain broken: ${problems[0]}`);
    return this.history.records().filter(r => ["init", "adopt", "rollback"].includes(r.type)).at(-1) ?? null;
  }
  #check(rec) {
    const d = join(this.dir, "releases", rec.release);
    if (!existsSync(d) || runtimeDigest(d) !== rec.runtimeDigest) throw new Error(`deployed release ${rec.release} missing or changed on disk`);
    return { release: rec.release, runtimeDigest: rec.runtimeDigest, commit: rec.commit ?? null, by: rec.type, seq: rec.seq, dir: d };
  }
  /** The deployed release (from the history; verified on disk). Repairs a stale current.json when `repair`. Null before init. */
  current({ repair = false } = {}) {
    const last = this.#last();
    if (!last) return null;
    const cur = this.#check(last);
    const f = join(this.dir, "current.json");
    const ptr = readJson(f, null);
    if (repair && (ptr?.release !== cur.release || ptr?.seq !== cur.seq)) atomicWriteJson(f, { release: cur.release, runtimeDigest: cur.runtimeDigest, commit: cur.commit, seq: cur.seq, by: cur.by, repairedAt: ptr ? new Date().toISOString() : undefined });
    return cur;
  }
  #store(src, digest) {
    const d = join(this.dir, "releases", digest);
    if (existsSync(d)) { if (runtimeDigest(d) !== digest) throw new Error(`release ${digest} exists with other content`); return d; }
    const tmp = join(this.dir, "releases", `.tmp-${digest}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true }); ensureDir(dirname(tmp));
    cpSync(src, tmp, { recursive: true, filter: (x) => !/\/(\.git|node_modules|\.codegraph)$/.test(x) });
    if (runtimeDigest(tmp) !== digest) { rmSync(tmp, { recursive: true, force: true }); throw new Error("release copy does not reproduce the frozen runtime digest"); }
    renameSync(tmp, d);
    return d;
  }
  #locked(fn) { ensureDir(this.dir, 0o700); const lock = acquireLock(join(this.dir, ".deploy.lock")); try { const out = fn(); this.current({ repair: true }); return out; } finally { lock.release(); } }
  /** Seed the history with the stable harness (once). */
  init({ dir, runtimeDigest: want, commit }) {
    return this.#locked(() => {
      if (this.#last()) return this.current();
      if (runtimeDigest(dir) !== want) throw new Error("stable tree differs from its frozen runtime digest");
      this.#store(dir, want); fault("release:after-store");
      this.history.append({ type: "init", release: want, runtimeDigest: want, commit: commit ?? null }); fault("release:after-record");
      return this.current();
    });
  }
  /** Adopt `candidate` if the deployed release is still `expect` (idempotent per key; the stored copy is verified first). */
  adopt({ key, expect, candidate, evidence }) {
    return this.#locked(() => {
      const recs = this.history.records();
      const done = recs.find(r => r.type === "adopt" && r.key === key);
      if (done) { this.#check(done); return { resumed: true, record: done, previous: done.previous }; }
      const cur = this.current();
      if (!cur || cur.release !== expect) throw new Error(`release pointer moved (expected ${expect}, found ${cur?.release ?? "none"}): adoption refused`);
      this.#store(candidate.dir, candidate.runtimeDigest); fault("release:after-store");
      const rec = this.history.append({ type: "adopt", key, release: candidate.runtimeDigest, runtimeDigest: candidate.runtimeDigest, commit: candidate.commit, previous: { release: cur.release, runtimeDigest: cur.runtimeDigest, commit: cur.commit ?? null }, evidence });
      fault("release:after-record");
      return { resumed: false, record: rec, previous: rec.previous };
    });
  }
  /** Roll back the adoption `key` (only while it is the deployed release; idempotent). */
  rollback({ key, reason }) {
    return this.#locked(() => {
      const recs = this.history.records();
      const done = recs.find(r => r.type === "rollback" && r.key === key);
      if (done) return { resumed: true, record: done };
      const ad = recs.find(r => r.type === "adopt" && r.key === key);
      if (!ad) return { none: "nothing adopted under this key" };
      const cur = this.current();
      if (cur.release !== ad.release) throw new Error(`release ${ad.release} is no longer deployed (now ${cur.release}): rollback refused`);
      this.#check({ ...ad.previous, type: "rollback" });
      const rec = this.history.append({ type: "rollback", key, release: ad.previous.release, runtimeDigest: ad.previous.runtimeDigest, commit: ad.previous.commit, from: ad.release, reason: String(reason).slice(0, 300) });
      fault("release:after-record");
      return { resumed: false, record: rec };
    });
  }
}

// ------------------------------------------------------------------------------------------------------------- smoke
/**
 * Post-adoption smoke: the deployed harness must load and run (terminal status completed; pass/fail of the task does not matter)
 * on one development task, through the same attempt admission. Recorded in <state>/smoke.json (resume returns it).
 */
export async function runSmoke({ state, harness, task, backend, budget, bound, envDigest, validate, protocolDigest }) {
  const f = join(state, "smoke.json");
  const done = readJson(f, null);
  if (done) return done;
  ensureDir(state, 0o700);
  const p = exploreProtocol();
  const grading = { [task.id]: validate ? await validate(task) : { ok: true, expected: {}, baselineFailing: [] } };
  if (!grading[task.id].ok) { const out = { ok: false, why: `smoke task grader invalid: ${task.id}`, at: new Date().toISOString() }; atomicWriteJson(f, out); return out; }
  const evaluator = new Evaluator({ stateDir: state, protocol: p, protocolDigest: protocolDigest ?? digestOf({ smoke: harness.commit }), envDigest, tasksById: { [task.id]: task }, grading, backend, log: () => {}, admission: attemptAdmission(budget, bound) });
  const [rec] = await evaluator.evaluate(harness, [{ task: task.id, split: "smoke", repeat: 0 }], "lifecycle:smoke");
  if (evaluator.halted) return { paused: evaluator.halted };
  const out = { ok: rec?.terminal_status === "completed", terminal: rec?.terminal_status ?? null, detail: String(rec?.terminal_detail ?? "").slice(0, 200), requests: rec?.model_requests ?? 0, at: new Date().toISOString() };
  atomicWriteJson(f, out);
  return out;
}

export { planPath };
