// Ledger-backed execution of evaluation units: every attempt is locked (a `dispatch` record with its run id and control directory)
// BEFORE any model request, every outcome is appended (never replaced), a crash between dispatch and result is reconciled from the
// proxy's wire journal (a model call that completed means the attempt counts as `aborted`, never re-drawn), and only attempts with
// zero completed model calls and an infrastructure status are retried, at most protocol.infra.maxRetries times.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, ensureDir } from "./util.mjs";
import { makeRecord, retryable, unitKey } from "./metrics.mjs";
import { completedModelCalls, wireEntries } from "./sandbox.mjs";

/** Every wire journal under a unit's control directory (one per Pi attempt). */
export function wireJournals(controlDir) {
  if (!existsSync(controlDir)) return [];
  return readdirSync(controlDir, { recursive: true }).map(String).filter(p => p.endsWith("wire.jsonl")).map(p => join(controlDir, p));
}

export class Evaluator {
  constructor({ stateDir, protocol, protocolDigest, envDigest, tasksById, grading, backend, log = () => {} }) {
    Object.assign(this, { stateDir, protocol, protocolDigest, envDigest, tasksById, grading, backend, log });
    this.ledger = new Ledger(join(stateDir, "runs.jsonl"));
    this.inflight = new Set();
  }
  /** Final records (results) of all units, latest attempt last. */
  records() { return this.ledger.records().filter(r => r.type === "result").map(r => r.record); }
  keyOf(harness, task, split, repeat) { return unitKey({ harness, task, split, repeat, protocolDigest: this.protocolDigest }); }

  /** State of one unit from the ledger: { done: record|undefined, attempts, pending: dispatch without result }. */
  unitState(key) {
    const entries = this.ledger.records().filter(r => r.unit_key === key);
    const results = entries.filter(r => r.type === "result");
    const dispatches = entries.filter(r => r.type === "dispatch");
    const last = results.at(-1)?.record;
    const pending = dispatches.filter(d => !results.some(r => r.record.attempt === d.attempt));
    return { last, attempts: dispatches.length, pending };
  }

  /** Reconcile a dispatched attempt whose result was never stored (crash). */
  reconcile(dispatch) {
    const wire = dispatch.controlDir ? wireJournals(dispatch.controlDir).flatMap(wireEntries) : [];
    const completed = completedModelCalls(wire);
    const record = makeRecord({
      run_id: dispatch.run_id, unit_key: dispatch.unit_key, attempt: dispatch.attempt, candidate_id: dispatch.harness.id, harness_kind: dispatch.harness.kind, harness_commit: dispatch.harness.commit, mode: dispatch.harness.mode,
      task_id: dispatch.task, split: dispatch.split, family: this.tasksById[dispatch.task]?.family, hard: this.tasksById[dispatch.task]?.hard, repeat: dispatch.repeat, context: dispatch.context,
      model_route: `${this.protocol.route.provider}/${this.protocol.route.model}`, thinking_effort: this.protocol.route.effort, environment_digest: this.envDigest, protocol_digest: this.protocolDigest,
      terminal_status: completed > 0 ? "aborted" : "infra_error", terminal_detail: `controller interrupted; reconciled from the wire journal: ${completed} completed model call(s)`,
      model_requests: wire.filter(e => e.phase === "start" && e.method === "POST").length, model_requests_completed: completed, started_at: dispatch.at, simulated: dispatch.simulated,
    });
    this.ledger.append({ type: "result", unit_key: dispatch.unit_key, record, reconciled: true });
    return record;
  }

  /** Run (or reuse) every unit [{ task, split, repeat }] of `harness`; returns the final records in unit order. */
  async evaluate(harness, units, context) {
    const queue = units.map(u => ({ ...u, key: this.keyOf(harness, u.task, u.split, u.repeat) }));
    const out = new Map();
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const unit = queue[next++];
        out.set(unit.key, await this.runOne(harness, unit, context));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.protocol.parallelism, queue.length)) }, worker));
    return queue.map(u => out.get(u.key));
  }

  async runOne(harness, unit, context) {
    if (this.inflight.has(unit.key)) throw new Error(`unit ${unit.key} is already running (duplicate execution refused)`);
    this.inflight.add(unit.key);
    try {
      let state = this.unitState(unit.key);
      for (const dispatch of state.pending) this.reconcile(dispatch);
      state = this.unitState(unit.key);
      while (true) {
        if (state.last && !(retryable(state.last) && state.attempts <= this.protocol.infra.maxRetries)) return state.last;
        const attempt = state.attempts + 1;
        const runId = `${harness.id}-${unit.task}-${unit.split}-r${unit.repeat}-a${attempt}-${unit.key.slice(0, 8)}`;
        const controlDir = mkdtempSync(join(tmpdir(), "el-"));
        const evidence = join(this.stateDir, "evidence", harness.id, `${unit.split}-${unit.task}-r${unit.repeat}-a${attempt}`);
        this.ledger.append({ type: "dispatch", unit_key: unit.key, attempt, run_id: runId, controlDir, harness: { id: harness.id, kind: harness.kind, commit: harness.commit ?? null, mode: harness.mode ?? null }, task: unit.task, split: unit.split, repeat: unit.repeat, context, simulated: !!this.backend.simulated });
        let record;
        try {
          record = await this.backend.run({ harness, task: this.tasksById[unit.task], repeat: unit.repeat, split: unit.split, context, protocol: this.protocol, protocolDigest: this.protocolDigest, envDigest: this.envDigest, scratch: join(controlDir, "scratch"), controlDir, evidence, attempt, unitKey: unit.key, runId, grading: this.grading[unit.task] });
        } catch (error) {
          // A controller-side failure: whether a model call already completed decides (from the wire journal), never a guess.
          const wire = wireJournals(controlDir).flatMap(wireEntries);
          const completed = completedModelCalls(wire);
          record = makeRecord({ run_id: runId, unit_key: unit.key, attempt, candidate_id: harness.id, harness_kind: harness.kind, harness_commit: harness.commit, mode: harness.mode, task_id: unit.task, split: unit.split, family: this.tasksById[unit.task]?.family, hard: this.tasksById[unit.task]?.hard, repeat: unit.repeat, context,
            model_route: `${this.protocol.route.provider}/${this.protocol.route.model}`, thinking_effort: this.protocol.route.effort, environment_digest: this.envDigest, protocol_digest: this.protocolDigest,
            terminal_status: completed > 0 ? "aborted" : "infra_error", terminal_detail: `controller error: ${String(error?.message ?? error).slice(0, 300)}`, model_requests_completed: completed, started_at: new Date().toISOString(), simulated: !!this.backend.simulated });
        }
        record.attempt = attempt; record.unit_key = unit.key;
        this.ledger.append({ type: "result", unit_key: unit.key, record });
        this.log(`${harness.id} ${unit.split}/${unit.task}#${unit.repeat} a${attempt}: ${record.terminal_status}${record.task_success ? " PASS" : ""}`);
        rmSync(controlDir, { recursive: true, force: true });
        state = this.unitState(unit.key);
      }
    } finally { this.inflight.delete(unit.key); }
  }
}

/** The real backend (sandboxed Pi + grader). */
export function realBackend(env) {
  return {
    simulated: false,
    async run(input) {
      const { runUnit } = await import("./runner.mjs");
      ensureDir(input.scratch);
      return runUnit({ ...input, env, controlDir: input.controlDir });
    },
  };
}

/**
 * Deterministic simulated backend for tests and dry runs (records marked `simulated`, never reported as measurements):
 * success ~ Bernoulli(p(harness, task)) seeded by the unit key and attempt. `skill(harness, task)` returns { p, crash?, violation?, infra? }.
 */
export function simulatedBackend({ skill, seed = "sim" }) {
  return {
    simulated: true,
    async run({ harness, task, repeat, split, context, protocol, protocolDigest, envDigest, attempt, unitKey, runId }) {
      const { createRng } = await import("./rng.mjs");
      const rng = createRng(`${seed}:${harness.id}:${task.id}:${split}:${repeat}:${attempt}`);
      const s = skill(harness, task, { repeat, attempt, split, context });
      const pass = rng.next() < s.p;
      const terminal = s.infra && attempt === 1 ? "infra_error" : s.crash ? "harness_crash" : "completed";
      return makeRecord({ run_id: runId, unit_key: unitKey, attempt, candidate_id: harness.id, harness_kind: harness.kind, harness_commit: harness.commit, mode: harness.mode, task_id: task.id, split, family: task.family, hard: task.hard, repeat, context,
        model_route: `${protocol.route.provider}/${protocol.route.model}`, thinking_effort: protocol.route.effort, environment_digest: envDigest, protocol_digest: protocolDigest,
        terminal_status: terminal, hidden_test_pass: terminal === "completed" && pass, visible_test_pass: true, correctness_score: pass ? 1 : 0.5,
        integrity: { violations: s.violation ? ["simulated violation"] : [], suspicious: [], leakHits: [] }, critical_failure_count: s.violation || s.crash ? 1 : 0,
        model_requests: terminal === "infra_error" ? 0 : 5, model_requests_completed: terminal === "infra_error" ? 0 : 5, input_tokens: 1000, output_tokens: 100, wall_time: 10, started_at: new Date().toISOString(), simulated: true,
        failure_class: pass ? null : (s.failureClass ?? "requirements-generalization") });
    },
  };
}
