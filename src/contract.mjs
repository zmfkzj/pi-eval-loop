// Machine-readable contract of the headless CLI for unattended supervisors (cron, systemd, a Temporal activity): state-directory
// health, the public status summary (allowlisted fields only) and the invocation outcome / exit-code table. README section
// "Unattended operation contract" documents the same schema.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PHASES } from "./loop.mjs";
import { bindingOf, isBinding, LOCK_FILE, readLock } from "./protocol.mjs";
import { digestOf, inspectGuard, inspectLock } from "./util.mjs";

export const OUTCOME_SCHEMA = "pi-eval-loop/outcome@1";
export const STATUS_SCHEMA = "pi-eval-loop/status@1";

/**
 * Invocation outcomes and their exit codes. idle: a finished cycle and no substantive change; cycle_done: a cycle reached phase
 * done during this invocation (its deployment verdict, e.g. an exploration-only BLOCKED verdict, is in status.final); ok: a
 * non-loop mode (rollback, verify-stable, ablation) finished; blocked: a prerequisite/lock/split problem stopped the loop (state
 * phase blocked, resumes at blocked.resumePhase); halted: terminal trust-boundary or state-integrity stop (never cleared by a
 * retry); state_error: missing (records without state.json), corrupt or required-but-absent state, or a damaged protocol binding
 * (`integrity`: protocol_lock_missing|corrupt|mismatch, protocol_records_corrupt), nothing was changed; busy:
 * another live, foreign-host or unverifiable controller lock; interrupted: SIGINT/SIGTERM/SIGHUP; incomplete: the loop returned
 * before done without one of the reasons above; error: unexpected failure (details on stderr); usage: bad arguments.
 */
export const EXIT = Object.freeze({ idle: 0, cycle_done: 0, ok: 0, error: 1, incomplete: 1, blocked: 2, halted: 3, state_error: 4, usage: 64, busy: 75, interrupted: 130 });

/**
 * Top-level entries that show an experiment existed (lock files, empty directories and the temporary file of an interrupted first
 * state.json write do not).
 */
function evidenceOf(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith(".lock") && !entry.name.startsWith("state.json.tmp-"))
    .filter(entry => !entry.isDirectory() || readdirSync(join(dir, entry.name)).length > 0)
    .map(entry => entry.name).sort();
}

/** Structural problems of a parsed state.json (empty = usable). */
export function validateState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return ["not a JSON object"];
  const problems = [];
  if (!PHASES.includes(state.phase)) problems.push(`unknown phase ${JSON.stringify(state.phase)}`);
  if (!Number.isInteger(state.cycle) || state.cycle < 1) problems.push("cycle is not a positive integer");
  const counters = state.counters;
  if (!counters || typeof counters !== "object" || Array.isArray(counters)) problems.push("counters missing");
  else for (const key of ["candidates", "noProgress", "consecutiveInfra"]) if (!Number.isInteger(counters[key]) || counters[key] < 0) problems.push(`counters.${key} is not a non-negative integer`);
  if (state.phase === "blocked" && (!state.blocked || typeof state.blocked.reason !== "string")) problems.push("phase blocked without blocked.reason");
  // The phase a run continues in (a blocked state resumes at its recorded phase) must carry the decisions it builds on.
  const effective = state.phase === "blocked" ? state.blocked?.resumePhase : state.phase;
  if (state.phase === "blocked" && effective !== undefined && !PHASES.includes(effective)) problems.push(`unknown resume phase ${JSON.stringify(effective)}`);
  if (["holdout", "adopt", "post-adopt"].includes(effective)) {
    const sel = state.selection;
    const frozen = sel && typeof sel === "object" && typeof sel.frozenDigest === "string" && sel.frozenDigest.length > 0;
    const candidate = sel?.selected === null || (typeof sel?.selected === "string" && sel.selected.length > 0 && typeof sel?.commit === "string" && sel.commit.length > 0);
    if (!frozen || !candidate) problems.push(`phase ${effective} without a frozen selection (selected/commit/frozenDigest)`);
  }
  if (["adopt", "post-adopt"].includes(effective) && !(state.final?.adopt === true && typeof state.selection?.selected === "string" && state.final.candidate === state.selection.selected)) problems.push(`phase ${effective} without an ADOPT decision for the selection`);
  if (state.holdoutUse !== undefined && (typeof state.holdoutUse !== "object" || state.holdoutUse === null)) problems.push("holdoutUse is not an object");
  if (state.halted !== undefined && (typeof state.halted !== "string" || !state.halted)) problems.push("halted is not a reason string");
  return problems;
}

/** Records a state directory may hold before its protocol lock exists (prepare writes state, grading results, then the lock). */
const PRE_LOCK_FILES = new Set(["state.json", "events.jsonl", "grading.json", "report.md", "report.json"]);
const preLockFile = (name) => PRE_LOCK_FILES.has(name) || [...PRE_LOCK_FILES, LOCK_FILE].some(base => name.startsWith(`${base}.tmp-`));

/** The parsed journal; throws when a line is not JSON or the hash chain is broken (a deleted or edited event). */
function readEvents(dir) {
  const path = join(dir, "events.jsonl");
  if (!existsSync(path)) return [];
  const records = readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  let prev = "genesis";
  records.forEach((entry, index) => {
    const { hash, ...body } = entry ?? {};
    if (entry?.seq !== index || entry.prev !== prev || digestOf(body) !== hash) throw new Error(`events.jsonl: hash chain broken at record ${index}`);
    prev = hash;
  });
  return records;
}

/**
 * Why a state without protocol.lock.json is NOT a pre-lock state (empty = provably never locked: the controller crashed or was
 * blocked between creating state.json and writing the lock). Every step after the lock leaves a trace checked here, so a
 * deleted lock is never mistaken for a fresh initialization.
 */
function preLockViolations(dir, state) {
  const out = [];
  const effective = state.phase === "blocked" ? state.blocked?.resumePhase ?? "prepare" : state.phase;
  if (effective !== "prepare") out.push(`phase ${effective}`);
  if (state.cycle !== 1 || state.history) out.push(`cycle ${state.cycle}`);
  if (state.counters?.candidates) out.push("candidates counted");
  for (const key of ["stable", "selection", "final", "holdoutUse", "adoption", "cycleFingerprint", "sharedBaselineFrom"]) if (state[key] !== undefined) out.push(`state.${key}`);
  const extra = evidenceOf(dir).filter(name => !preLockFile(name));
  if (extra.length) out.push(`records ${extra.slice(0, 6).join(", ")}`);
  let events;
  try { events = readEvents(dir); } catch { out.push("events.jsonl unreadable or its hash chain broken"); events = []; }
  if (events.some(e => !(e?.type === "phase" && ["prepare", "blocked"].includes(e.phase)))) out.push("events after the lock step");
  // Only the blocks that happen before the lock step (prerequisites, split validation) are pre-lock; a lock-check block proves a lock.
  if (state.phase === "blocked" && !["missing prerequisites", "split validation failed"].includes(state.blocked?.reason)) out.push(`blocked: ${String(state.blocked?.reason).slice(0, 60)}`);
  if (existsSync(join(dir, "report.json"))) {
    try { const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")); if (report?.protocolDigest != null) out.push("report.json names a protocol digest"); } catch { out.push("report.json unreadable"); }
  }
  return out;
}

/**
 * Protocol binding of a structurally valid state (read-only). The state records the lock it is bound to (state.protocolLock =
 * bindingOf(lock)); the lock must exist, be well-formed and match that binding and the journal: every protocol-locked or
 * protocol-bound event names its protocol digest (and lock digest, when recorded), a state whose journal recorded a lock digest
 * must still carry its binding, and a lock is created at most once per directory. Without a lock the state must be provably
 * pre-lock (unlocked: the next prepare may create it); anything else is a damaged experiment. This detects lost, partial or
 * inconsistent records; it is not a signature (a deliberate rewrite of state.json, the journal and the lock together is not
 * detectable without a secret).
 * @returns {{ ok: true, status: "bound" | "unlocked", protocolDigest: string | null, lockDigest: string | null, legacy?: boolean } | { ok: false, integrity: string, detail: string }}
 */
export function inspectProtocol(dir, state) {
  const fail = (integrity, detail) => ({ ok: /** @type {const} */ (false), integrity, detail });
  const binding = state.protocolLock;
  if (binding !== undefined && !isBinding(binding)) return fail("protocol_lock_corrupt", "state.protocolLock is not a valid lock binding");
  let read;
  try { read = readLock(dir); } catch (error) { if (error?.code !== "ESTATEINTEGRITY") throw error; return fail(error.integrity, error.message); }
  if (!read.present) {
    if (binding) return fail("protocol_lock_missing", `${LOCK_FILE} is missing but the state is bound to protocol ${binding.protocolDigest.slice(0, 16)}: refusing to re-lock`);
    const why = preLockViolations(dir, state);
    return why.length ? fail("protocol_lock_missing", `${LOCK_FILE} is missing but the state has progressed past the lock step (${why.join("; ")}): refusing to re-lock`) : { ok: true, status: "unlocked", protocolDigest: null, lockDigest: null };
  }
  const lock = read.lock, bound = bindingOf(lock);
  if (binding && (binding.protocolDigest !== bound.protocolDigest || binding.lockDigest !== bound.lockDigest)) return fail("protocol_lock_mismatch", `${LOCK_FILE} differs from the lock this state is bound to (protocol ${binding.protocolDigest.slice(0, 16)} vs ${bound.protocolDigest.slice(0, 16)})`);
  let events;
  try { events = readEvents(dir); } catch { return fail("protocol_records_corrupt", "events.jsonl unreadable or its hash chain is broken: the protocol lock cannot be cross-checked"); }
  const journal = events.filter(e => e?.type === "protocol-locked" || e?.type === "protocol-bound");
  const other = journal.find(e => e.protocolDigest !== lock.protocolDigest || (e.lockDigest !== undefined && e.lockDigest !== bound.lockDigest));
  if (other) return fail("protocol_lock_mismatch", `${LOCK_FILE} differs from the ${other.type} event (seq ${other.seq})`);
  if (!binding && journal.some(e => e.lockDigest !== undefined)) return fail("protocol_lock_mismatch", "state.json lost the lock binding its journal recorded: refusing to bind it again");
  if (journal.filter(e => e.type === "protocol-locked").length > 1) return fail("protocol_lock_mismatch", "the journal records more than one protocol lock for this state directory (an earlier re-lock)");
  return { ok: true, status: "bound", protocolDigest: lock.protocolDigest, lockDigest: bound.lockDigest, legacy: binding ? undefined : true };
}

/**
 * Health of one loop state directory, read-only: fresh (no state.json, no records: a new loop may start), present (valid state),
 * missing (records but no state.json: the state was lost; never re-initialized), corrupt (unreadable, invalid JSON or structure,
 * or a damaged protocol binding: `integrity` names it). A halted state stays present (halted takes precedence; it is terminal).
 * @returns {{ health: "fresh" | "present" | "missing" | "corrupt", state?: any, detail?: string, evidence?: string[], integrity?: string, protocol?: any }}
 */
export function inspectState(dir) {
  let raw;
  try { raw = readFileSync(join(dir, "state.json"), "utf8"); } catch (error) {
    if (error.code !== "ENOENT") return { health: "corrupt", detail: `state.json unreadable (${error.code})` };
    const evidence = evidenceOf(dir);
    return evidence.length ? { health: "missing", evidence, detail: `state.json is missing but the state directory holds experiment records (${evidence.slice(0, 6).join(", ")})` } : { health: "fresh", evidence };
  }
  let state;
  try { state = JSON.parse(raw); } catch { return { health: "corrupt", detail: "state.json is not valid JSON" }; }
  const problems = validateState(state);
  if (problems.length) return { health: "corrupt", detail: `state.json is structurally invalid: ${problems.join("; ")}` };
  const protocol = /** @type {any} */ (inspectProtocol(dir, state));
  if (!protocol.ok && !state.halted) return { health: "corrupt", integrity: protocol.integrity, detail: protocol.detail, state };
  return { health: "present", state, protocol };
}

export const ARMS = ["A", "B", "C"];
/** An A/B/C ablation directory: no state.json of its own, trajectories in A/, B/, C/. */
export const isAblationDir = (dir) => !existsSync(join(dir, "state.json")) && (existsSync(join(dir, "A")) || existsSync(join(dir, "ablation.json")));

/**
 * Health of an ablation directory: every trajectory must be fresh or present, B/C exist only after A, and the directory itself
 * holds no loop state. halted names the first halted trajectory.
 */
export function inspectAblation(dir) {
  if (existsSync(join(dir, "state.json"))) return { health: "corrupt", detail: "the directory holds a loop state.json; an ablation needs its own directory", arms: {} };
  const arms = Object.fromEntries(ARMS.map(name => [name, inspectState(join(dir, name))]));
  const haltedArm = ARMS.find(name => arms[name].state?.halted);
  // A halt is terminal for every trajectory: it takes precedence over a damaged protocol binding (never over a lost/unreadable state).
  const bad = ARMS.find(name => arms[name].health === "missing" || (arms[name].health === "corrupt" && !(haltedArm && arms[name].integrity)));
  if (bad) return { health: arms[bad].health, detail: `trajectory ${bad}: ${arms[bad].detail}`, integrity: arms[bad].integrity, arms };
  if (arms.A.health === "fresh" && (arms.B.health !== "fresh" || arms.C.health !== "fresh" || existsSync(join(dir, "ablation.json")))) return { health: "missing", detail: "trajectory A has no state while B/C or ablation results exist", arms };
  if (!haltedArm) {
    // B and C are seeded with A's lock: every bound trajectory must be bound to the same lock.
    const locks = ARMS.filter(name => arms[name].protocol?.lockDigest).map(name => [name, arms[name].protocol.lockDigest]);
    const differs = locks.find(([, digest]) => digest !== locks[0][1]);
    if (differs) return { health: "corrupt", integrity: "protocol_lock_mismatch", detail: `trajectory ${differs[0]} is bound to a different protocol lock than trajectory ${locks[0][0]}`, arms };
  }
  return { health: arms.A.health === "fresh" ? "fresh" : "present", arms, halted: haltedArm ? { arm: haltedArm, reason: arms[haltedArm].state.halted } : undefined };
}

/** Current condition of a valid state: halted, blocked, cycle_complete or in_progress (historical interruptions never count). */
export const conditionOf = (state) => state.halted ? "halted" : state.phase === "blocked" ? "blocked" : state.phase === "done" ? "cycle_complete" : "in_progress";

/** Allowlisted public view of a state (no prompts, tasks, hidden/holdout material, problem texts, gate reasons or secrets). */
export function stateSummary(state) {
  const blocked = state.phase === "blocked" ? state.blocked ?? {} : undefined;
  const final = state.final;
  const last = state.lastInterruption ?? state.interrupted;
  return {
    condition: conditionOf(state),
    phase: state.phase, cycle: state.cycle, strategy: state.strategy ?? null,
    // sha256 of the locked protocol this state is bound to (null before the lock step or for a not yet re-bound older state).
    protocolDigest: isBinding(state.protocolLock) ? state.protocolLock.protocolDigest : null,
    resumePhase: blocked ? blocked.resumePhase ?? null : null,
    blocked: blocked ? { reason: String(blocked.reason ?? ""), retryable: blocked.retryable === true, missing: (blocked.missing ?? []).map(m => String(m.name)), problemCount: Array.isArray(blocked.problems) ? blocked.problems.length : 0 } : null,
    halted: state.halted ? { reason: String(state.halted), at: state.haltedAt ?? null } : null,
    cycleComplete: state.phase === "done" && Boolean(state.cycleFingerprint),
    searchStop: state.phase === "search" ? null : state.searchStop ?? null,
    counters: { candidates: state.counters?.candidates ?? 0, noProgress: state.counters?.noProgress ?? 0 },
    final: final ? { verdict: final.verdict ?? null, candidate: final.candidate ?? null, adopt: final.adopt === true, explorationOnly: final.explorationOnly === true, rolledBack: Boolean(final.rolledBack), reasonCount: Array.isArray(final.reasons) ? final.reasons.length : 0 } : null,
    adopted: state.adoption ? { at: state.adoption.at ?? null } : null,
    doneAt: state.doneAt ?? null, updatedAt: state.updatedAt ?? null,
    lastInterruption: last ? { at: last.at ?? null, signal: last.signal ?? null } : null,
  };
}

/** The ablation directory DIR when dir is one of its trajectories DIR/A|B|C (existing or not yet set up), else undefined. */
export const ablationParent = (dir) => ARMS.includes(basename(dir)) && isAblationDir(dirname(dir)) ? dirname(dir) : undefined;

/** The controller lock that governs dir (an ablation's trajectories share the ablation's lock), with its reclaim guard. */
const lockView = (dir) => {
  const path = join(ablationParent(dir) ?? dir, ".lock");
  const lock = /** @type {any} */ (inspectLock(path)), guard = /** @type {any} */ (inspectGuard(path));
  const view = lock.present ? { state: lock.state, pid: lock.owner?.pid ?? null, host: lock.owner?.host ?? null, at: lock.owner?.at ?? null } : { state: "absent" };
  return guard.present ? { ...view, guard: guard.state } : view;
};

/** `--status --summary`: health, lock and the allowlisted summary of a loop or ablation state directory (read-only). */
export function statusSummary(dir) {
  const base = { schema: STATUS_SCHEMA, stateDir: dir, lock: lockView(dir) };
  if (isAblationDir(dir)) {
    const info = inspectAblation(dir);
    const trajectories = Object.fromEntries(ARMS.map(name => { const arm = info.arms[name]; return [name, arm?.health === "present" ? { health: "present", ...stateSummary(arm.state), protocolDigest: arm.protocol?.protocolDigest ?? null } : { health: arm?.health ?? "fresh", ...(arm?.integrity ? { integrity: arm.integrity } : {}) }]; }));
    const conditions = Object.values(trajectories).map(t => /** @type {any} */ (t).condition);
    const condition = info.health === "missing" || info.health === "corrupt" ? "state_error" : info.halted ? "halted" : conditions.includes("blocked") ? "blocked" : info.health === "fresh" ? "none" : existsSync(join(dir, "ablation.json")) ? "cycle_complete" : "in_progress";
    return { ...base, layout: "ablation", health: info.health, condition, detail: info.detail ?? null, ...(info.integrity ? { integrity: info.integrity } : {}), trajectories };
  }
  const info = inspectState(dir);
  if (info.health !== "present") return { ...base, layout: "loop", health: info.health, condition: info.health === "fresh" ? "none" : "state_error", detail: info.detail ?? null, ...(info.integrity ? { integrity: info.integrity } : {}) };
  // The digest of the verified lock on disk (also for an older state that has not recorded its binding yet).
  return { ...base, layout: "loop", health: "present", ...stateSummary(info.state), protocolDigest: info.protocol?.protocolDigest ?? null };
}

/**
 * The one outcome line of a lock-taking invocation.
 * @param {keyof typeof EXIT} outcome @param {{ stateDir: string, state?: any, [key: string]: any }} fields
 */
export function outcomeRecord(outcome, { stateDir, state, ...extra }) {
  return { schema: OUTCOME_SCHEMA, outcome, exitCode: EXIT[outcome], stateDir, phase: state?.phase ?? null, cycle: state?.cycle ?? null, ...extra, status: state ? stateSummary(state) : null, at: new Date().toISOString() };
}
