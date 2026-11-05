// Failure analysis. Every run gets a mechanical failure CLASS from observations (terminal status, tool use, edits, visible/hidden
// grading). Classes are observations of WHERE a run failed, not proven causes; cross-task/cross-repeat aggregation turns them
// into HYPOTHESES (status "unverified") that a candidate may target; a later candidate's evaluation is the verification.

export const FAILURE_CLASSES = {
  "termination-premature": "ended without changing anything although the task expects a change",
  "termination-timeout": "ran out of the unit wall-time guard",
  "tool-use": "most tool calls failed",
  "implementation": "changed code but the visible tests fail",
  "verification-skipped": "never ran the tests and the result fails grading",
  "requirements-generalization": "visible tests pass but the hidden (independent) grading fails",
  "integrity": "weakened tests, injected configuration, or reached for grading material",
  "model-or-infra": "the model or infrastructure failed (not a harness behaviour)",
  "harness-crash": "the harness itself failed to load or crashed",
};

/** Mechanical class of a failed run (undefined for a success). */
export function classifyFailure(record, facts = {}) {
  if (record.task_success) return null;
  if ((record.integrity?.violations?.length ?? 0) + (record.integrity?.leakHits?.length ?? 0) > 0) return "integrity";
  if (record.terminal_status === "harness_crash") return "harness-crash";
  if (["infra_error", "model_unavailable", "model_error", "grader_error", "route_violation"].includes(record.terminal_status)) return "model-or-infra";
  if (record.terminal_status === "timeout") return "termination-timeout";
  if ((facts.tools ?? 0) >= 4 && (facts.toolErrors ?? 0) / Math.max(1, facts.tools) > 0.5) return "tool-use";
  if ((facts.diffBytes ?? 0) === 0) return "termination-premature";
  const ranTests = facts.ranTests === true;
  if (record.visible_test_pass === false) return ranTests ? "implementation" : "verification-skipped";
  if (record.visible_test_pass === true && record.hidden_test_pass === false) return "requirements-generalization";
  return "implementation";
}

/**
 * Classes that the critical gate rejects on a SINGLE run of a candidate, whatever its success rate (gate.mjs criticalProblems):
 * while the parent harness still produces them at a recurring rate, a candidate rarely survives screening (explore-real-2: 20 of
 * 20 candidates rejected for task-agent integrity while the proposals targeted another class), so they are targeted first.
 */
export const GATE_BLOCKING = Object.freeze(["integrity", "harness-crash"]);

/**
 * Aggregate failure evidence of one harness on the train split.
 * Returns { observations: per task, recurring: classes with counts, hypotheses: [{class, tasks, persistence, addressable, status}] }.
 * `reference` (optional) = records of another harness (e.g. pure Pi) on the same tasks to separate model limits from harness limits.
 * `rejections` (optional) = { [class]: number of recent candidates rejected by the critical gate for that class } (no task data).
 * Order: recurring gate-blocking classes first (runs of the parent + candidate rejections >= 2), then by failed runs.
 */
export function analyze(records, { reference = [], rejections = {}, gateFirst = true } = {}) {
  const byTask = new Map();
  for (const r of records) { if (!byTask.has(r.task_id)) byTask.set(r.task_id, []); byTask.get(r.task_id).push(r); }
  const observations = [];
  const classes = {};
  for (const [task, runs] of [...byTask].sort()) {
    const fails = runs.filter(r => !r.task_success);
    const rate = 1 - fails.length / runs.length;
    const persistence = fails.length === runs.length ? "persistent" : fails.length === 0 ? "none" : "mixed";
    const refRuns = reference.filter(r => r.task_id === task);
    const refRate = refRuns.length ? refRuns.filter(r => r.task_success).length / refRuns.length : null;
    const taskClasses = {};
    for (const r of fails) { const c = r.failure_class ?? "unclassified"; taskClasses[c] = (taskClasses[c] ?? 0) + 1; classes[c] ??= { runs: 0, tasks: new Set() }; classes[c].runs++; classes[c].tasks.add(task); }
    observations.push({ task, runs: runs.length, successRate: rate, persistence, classes: taskClasses, referenceSuccessRate: refRate, hard: runs[0]?.hard ?? false,
      excerpts: fails.slice(0, 2).map(r => ({ repeat: r.repeat, terminal: r.terminal_status, detail: String(r.terminal_detail ?? "").slice(0, 200), visible: r.visible_test_pass, hidden: r.hidden_test_pass, final: String(r.final_text_excerpt ?? "").slice(0, 300) })) });
  }
  const hypotheses = Object.entries(classes).filter(([c]) => !["model-or-infra", "unclassified"].includes(c)).map(([c, v]) => {
    const tasks = [...v.tasks].sort();
    const mixed = tasks.filter(t => observations.find(o => o.task === t)?.persistence === "mixed").length;
    const refHelps = tasks.filter(t => { const o = observations.find(x => x.task === t); return o?.referenceSuccessRate !== null && o?.referenceSuccessRate > o?.successRate; }).length;
    return {
      class: c, description: FAILURE_CLASSES[c] ?? c, runs: v.runs, tasks,
      recurrence: tasks.length > 1 ? "recurring across tasks" : "single task",
      reproducibility: mixed ? `${mixed}/${tasks.length} task(s) mixed (sometimes succeed: behaviour-dependent, plausibly harness-addressable)` : "persistent on every repeat (could be a model limit)",
      modelVsHarness: refHelps ? `${refHelps} task(s) where the reference harness did better: harness-attributable evidence` : "no reference harness did better on these tasks: model-limit not excluded",
      status: "unverified", gateBlocking: false, candidateRejections: 0, priority: "by failed runs",
    };
  });
  // A gate-blocking class seen only through candidate rejections (the parent's own train runs did not show it) is still a target.
  for (const c of GATE_BLOCKING) {
    if (!(rejections[c] >= 2) || hypotheses.some(h => h.class === c)) continue;
    hypotheses.push({ class: c, description: FAILURE_CLASSES[c], runs: 0, tasks: [], recurrence: "recent candidates rejected for it", reproducibility: "observed in candidate screening/development runs", modelVsHarness: "not separated", status: "unverified", gateBlocking: true, candidateRejections: 0, priority: "by failed runs" });
  }
  for (const h of hypotheses) {
    const gate = GATE_BLOCKING.includes(h.class);
    h.gateBlocking = gate;
    h.candidateRejections = gate ? (rejections[h.class] ?? 0) : 0;
    h.priority = gateFirst && gate && h.runs + h.candidateRejections >= 2 ? "gate-blocking (one run rejects a candidate)" : "by failed runs";
  }
  const first = (h) => (h.priority.startsWith("gate-blocking") ? 0 : 1);
  if (gateFirst) hypotheses.sort((a, b) => first(a) - first(b) || (b.runs + b.candidateRejections) - (a.runs + a.candidateRejections));
  else hypotheses.sort((a, b) => b.runs - a.runs);
  return { observations, hypotheses, infraRuns: classes["model-or-infra"]?.runs ?? 0 };
}
