// Machine-readable contract of the headless CLI for unattended supervisors (cron, systemd, a Temporal activity): state-directory
// health, the public status summary (allowlisted fields only) and the invocation outcome / exit-code table. README section
// "Unattended operation contract" documents the same schema.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PHASES } from "./loop.mjs";
import { inspectGuard, inspectLock } from "./util.mjs";

export const OUTCOME_SCHEMA = "pi-eval-loop/outcome@1";
export const STATUS_SCHEMA = "pi-eval-loop/status@1";

/**
 * Invocation outcomes and their exit codes. idle: a finished cycle and no substantive change; cycle_done: a cycle reached phase
 * done during this invocation (its deployment verdict, e.g. an exploration-only BLOCKED verdict, is in status.final); ok: a
 * non-loop mode (rollback, verify-stable, ablation) finished; blocked: a prerequisite/lock/split problem stopped the loop (state
 * phase blocked, resumes at blocked.resumePhase); halted: terminal trust-boundary or state-integrity stop (never cleared by a
 * retry); state_error: missing (records without state.json), corrupt or required-but-absent state, nothing was changed; busy:
 * another live, foreign-host or unverifiable controller lock; interrupted: SIGINT/SIGTERM/SIGHUP; incomplete: the loop returned
 * before done without one of the reasons above; error: unexpected failure (details on stderr); usage: bad arguments.
 */
export const EXIT = Object.freeze({ idle: 0, cycle_done: 0, ok: 0, error: 1, incomplete: 1, blocked: 2, halted: 3, state_error: 4, usage: 64, busy: 75, interrupted: 130 });

/** Top-level entries that show an experiment existed (lock files and empty directories do not). */
function evidenceOf(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith(".lock"))
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

/**
 * Health of one loop state directory, read-only: fresh (no state.json, no records: a new loop may start), present (valid state),
 * missing (records but no state.json: the state was lost; never re-initialized), corrupt (unreadable, invalid JSON or structure).
 * @returns {{ health: "fresh" | "present" | "missing" | "corrupt", state?: any, detail?: string, evidence?: string[] }}
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
  return problems.length ? { health: "corrupt", detail: `state.json is structurally invalid: ${problems.join("; ")}` } : { health: "present", state };
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
  const bad = ARMS.find(name => arms[name].health === "missing" || arms[name].health === "corrupt");
  if (bad) return { health: arms[bad].health, detail: `trajectory ${bad}: ${arms[bad].detail}`, arms };
  if (arms.A.health === "fresh" && (arms.B.health !== "fresh" || arms.C.health !== "fresh" || existsSync(join(dir, "ablation.json")))) return { health: "missing", detail: "trajectory A has no state while B/C or ablation results exist", arms };
  const haltedArm = ARMS.find(name => arms[name].state?.halted);
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
    const trajectories = Object.fromEntries(ARMS.map(name => { const arm = info.arms[name]; return [name, arm?.health === "present" ? { health: "present", ...stateSummary(arm.state) } : { health: arm?.health ?? "fresh" }]; }));
    const conditions = Object.values(trajectories).map(t => /** @type {any} */ (t).condition);
    const condition = info.health === "missing" || info.health === "corrupt" ? "state_error" : info.halted ? "halted" : conditions.includes("blocked") ? "blocked" : info.health === "fresh" ? "none" : existsSync(join(dir, "ablation.json")) ? "cycle_complete" : "in_progress";
    return { ...base, layout: "ablation", health: info.health, condition, detail: info.detail ?? null, trajectories };
  }
  const info = inspectState(dir);
  if (info.health !== "present") return { ...base, layout: "loop", health: info.health, condition: info.health === "fresh" ? "none" : "state_error", detail: info.detail ?? null };
  return { ...base, layout: "loop", health: "present", ...stateSummary(info.state) };
}

/**
 * The one outcome line of a lock-taking invocation.
 * @param {keyof typeof EXIT} outcome @param {{ stateDir: string, state?: any, [key: string]: any }} fields
 */
export function outcomeRecord(outcome, { stateDir, state, ...extra }) {
  return { schema: OUTCOME_SCHEMA, outcome, exitCode: EXIT[outcome], stateDir, phase: state?.phase ?? null, cycle: state?.cycle ?? null, ...extra, status: state ? stateSummary(state) : null, at: new Date().toISOString() };
}
