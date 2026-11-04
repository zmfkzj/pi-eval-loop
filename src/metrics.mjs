// Run records (one per evaluated unit = harness x task x repeat) and their aggregation. Records are written only by the controller
// from its own observations (process exit, the Pi JSON stream it captured, the proxy's wire totals outside the sandbox, the
// sandboxed grader); nothing a candidate or agent writes into its workspace decides a status.
import { digestOf } from "./util.mjs";
import { mean } from "./stats.mjs";

export const RUN_SCHEMA = "pi-eval-loop/run-1";
/** Terminal statuses. Only `infra_error` and `model_unavailable` with ZERO successful model requests may be retried. */
export const TERMINALS = ["completed", "agent_error", "timeout", "aborted", "model_error", "model_unavailable", "grader_error", "infra_error", "route_violation", "harness_crash"];
export const RETRYABLE = new Set(["infra_error", "model_unavailable"]);

export const unitKey = ({ harness, task, split, repeat, protocolDigest }) => digestOf({ h: harness.id, c: harness.commit ?? null, task, split, repeat, p: protocolDigest });

/** May this attempt be re-run? Never once a model request completed (a later failure is the run's outcome, not infrastructure). */
export const retryable = (record) => RETRYABLE.has(record.terminal_status) && (record.model_requests_completed ?? 0) === 0;

/** The pre-registered success criterion: normal termination AND independent hidden + visible grading AND clean integrity. */
export function successOf(r) {
  return r.terminal_status === "completed" && r.hidden_test_pass === true && r.visible_test_pass !== false && (r.integrity?.violations?.length ?? 0) === 0 && (r.critical_failure_count ?? 0) === 0;
}

export function makeRecord(fields) {
  const record = {
    schema: RUN_SCHEMA,
    run_id: fields.run_id, unit_key: fields.unit_key, attempt: fields.attempt ?? 1,
    candidate_id: fields.candidate_id, harness_kind: fields.harness_kind, harness_commit: fields.harness_commit ?? null, mode: fields.mode ?? null,
    task_id: fields.task_id, split: fields.split, family: fields.family, hard: !!fields.hard, repeat: fields.repeat, context: fields.context,
    model_route: fields.model_route, thinking_effort: fields.thinking_effort, environment_digest: fields.environment_digest, protocol_digest: fields.protocol_digest,
    terminal_status: fields.terminal_status, terminal_detail: fields.terminal_detail ?? "",
    agent_reported_status: fields.agent_reported_status ?? null,
    hidden_test_pass: fields.hidden_test_pass ?? null, visible_test_pass: fields.visible_test_pass ?? null,
    correctness_score: fields.correctness_score ?? 0, regression_count: fields.regression_count ?? 0, critical_failure_count: fields.critical_failure_count ?? 0,
    integrity: fields.integrity ?? { violations: [], suspicious: [], leakHits: [] },
    model_requests: fields.model_requests ?? 0, model_requests_completed: fields.model_requests_completed ?? 0,
    input_tokens: fields.input_tokens ?? 0, output_tokens: fields.output_tokens ?? 0, cache_tokens: fields.cache_tokens ?? 0, cache_write_tokens: fields.cache_write_tokens ?? 0,
    wall_time: fields.wall_time ?? 0, attempts_used: fields.attempts_used ?? fields.attempt ?? 1,
    failure_class: fields.failure_class ?? null, evidence_dir: fields.evidence_dir ?? null,
    started_at: fields.started_at, ended_at: fields.ended_at ?? new Date().toISOString(),
    simulated: !!fields.simulated,
  };
  if (!TERMINALS.includes(record.terminal_status)) throw new Error(`unknown terminal status ${record.terminal_status}`);
  record.task_success = successOf(record);
  return record;
}

/** The authoritative (last) attempt of every unit among the records. */
export function finalAttempts(records) {
  const byUnit = new Map();
  for (const r of records) { const prev = byUnit.get(r.unit_key); if (!prev || r.attempt >= prev.attempt) byUnit.set(r.unit_key, r); }
  return [...byUnit.values()];
}

/** Per-task 0/1 outcomes of one harness on a split; `expected` units missing make the aggregate incomplete (refused upstream). */
export function outcomesOf(records, candidateId, split, tasks) {
  const finals = finalAttempts(records.filter(r => r.candidate_id === candidateId && r.split === split));
  const out = {};
  for (const task of tasks) out[task] = finals.filter(r => r.task_id === task).sort((a, b) => a.repeat - b.repeat).map(r => (r.task_success ? 1 : 0));
  return out;
}

/** Missing scheduled units (selective omission guard): every scheduled unit key must have a final record. */
export const missingUnits = (records, scheduledKeys) => { const have = new Set(records.map(r => r.unit_key)); return scheduledKeys.filter(key => !have.has(key)); };

/** Pairs for stats.compare over the tasks both arms ran (matched repeat counts are the caller's schedule). */
export function pairsOf(records, { a, b, split, tasks, meta }) {
  const oa = outcomesOf(records, a, split, tasks), ob = outcomesOf(records, b, split, tasks);
  return tasks.map(task => ({ task, family: meta[task]?.family ?? task, hard: !!meta[task]?.hard, a: oa[task], b: ob[task] }));
}

/** Descriptive summary of one harness on a split (all metrics of the request, including resources - never an objective). */
export function summarize(records, candidateId, split) {
  const runs = finalAttempts(records.filter(r => r.candidate_id === candidateId && (split === undefined || r.split === split)));
  const byTask = new Map();
  for (const r of runs) { if (!byTask.has(r.task_id)) byTask.set(r.task_id, []); byTask.get(r.task_id).push(r); }
  const taskRates = [...byTask.values()].map(list => mean(list.map(r => (r.task_success ? 1 : 0))));
  const hard = runs.filter(r => r.hard);
  const count = (fn) => runs.filter(fn).length;
  const sum = (key) => runs.reduce((s, r) => s + (r[key] ?? 0), 0);
  return {
    candidate_id: candidateId, split: split ?? "all", runs: runs.length, tasks: byTask.size,
    task_success: count(r => r.task_success), success_rate: runs.length ? count(r => r.task_success) / runs.length : null,
    hidden_test_pass: count(r => r.hidden_test_pass === true), mean_correctness: mean(runs.map(r => r.correctness_score)),
    repeat_success_rate: taskRates.length ? mean(taskRates.map(p => p * p)) : null, // pass^2: two independent repeats both succeed
    all_repeats_pass_tasks: [...byTask.values()].filter(list => list.every(r => r.task_success)).length,
    hard_task_success_rate: hard.length ? hard.filter(r => r.task_success).length / hard.length : null,
    regression_count: sum("regression_count"), critical_failure_count: sum("critical_failure_count"),
    integrity_violations: runs.reduce((s, r) => s + (r.integrity?.violations?.length ?? 0), 0),
    terminal: Object.fromEntries(Object.entries(runs.reduce((acc, r) => { acc[r.terminal_status] = (acc[r.terminal_status] ?? 0) + 1; return acc; }, {})).sort()),
    infra_rate: runs.length ? count(r => r.terminal_status === "infra_error" || r.terminal_status === "model_unavailable") / runs.length : 0,
    input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), cache_tokens: sum("cache_tokens"), model_requests: sum("model_requests"), wall_time_ms: sum("wall_time"),
    simulated_runs: count(r => r.simulated),
  };
}
