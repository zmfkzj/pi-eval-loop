# ctx-state-1: long-task state preservation in pi-orche (registered 2026-11-07)

Question: do orche's state-preservation features (existing: task ledger, strict Task DAG checkpoints; new, opt-in: early worker
compaction, extended essentials with a checked transcript reference, sub-worker compaction) change final task success and
requirement compliance on long tasks? Cost, tokens and time are observed, never objectives.

Driver: `run.mjs` (ctrl-ablation-1 campaign machinery: frozen interleaved queue, the loop's sandboxed runner, exactly-once
evaluator ledger, lock of preregistration/evaluator/experiment/harness/task digests). Every stage has its own prereg file, state
directory, lock and records. Arms are explicit orche runtime settings (`runner.orcheConfig` overlay) on a pinned orche commit; the
arm settings are part of the harness identity (unit key). Route: `cliproxyapi/gpt-6-astra` effort `high` with `extendedContext`
(production main model and thinking; production workers run on claude-opus-5-5, which the fail-closed sandbox gate cannot admit),
identical in every arm; `thinkingPolicy` fixed (no effort change). Advisor off in every arm (not newly enabled). Unit limits
45 min / 300 requests, identical in every arm; summary requests count against the same cap and are reported separately.

## Stages

1. `prereg-baseline.json` — A0 (operational policy) vs A1 (+ `single.ledger`, checkpoints, evidence strict) on the PRE-change
   commit e831a6b (existing features only); 6 longest exposed suite tasks x 1. Purpose: R2 trace verification and pilot lengths.
2. `prereg-pilot.json` — new commit 559bf27, A1 settings + `workerCompaction` absolute 24k/6k vs 32k/8k (extended essentials,
   sub-workers on) on p1/p3 x 1. Purpose: load check and intervention occurrence (compactions, references, fallbacks). Excluded
   from any outcome analysis.
3. Main (planned, frozen design; NOT run in this assignment, see results): arms on 559bf27, one factor per adjacent contrast:
   M0 = A0 settings; M1 = A1 settings; M2 = M1 + absolute trigger (basic essentials); M3 = M2 + extended essentials (retrieval);
   M4 = M3 + sub-worker compaction. Trigger fixed from the pilot: 24000/6000 (repeated compactions, no loop-guard fallback in the
   pilot). Tasks: the six baseline tasks plus long tasks with a mid-task amendment; repeats >= 3. Primary: valid success
   (ctrl-ablation-1 definition, strict test immutability); inference: task-cluster paired bootstrap and within-task randomization,
   Holm over the four contrasts; viability as ctrl-ablation-1 §9. A holdout batch is reserved through the existing supply route
   only if a contrast is viable (a once-only holdout is not consumed without a candidate).

Stop rules: the campaign pauses on the safety limits of each prereg (`budget`), never on outcomes. No stage is re-run to find a
passing result; a changed design is a new stage with a new state directory.
