# ctx-state-1 results (2026-11-07): baseline and pilot only — performance INCONCLUSIVE, keep the stable policy

Preregistration: `experiments/ctx-state-1/PREREGISTRATION.md`. Records: `records/ctx-state-1/{baseline,pilot}/` (runs.jsonl ledger,
lock.json, queue.json, campaign.json, grading.json, fidelity.json). Evidence (wire journals, transcripts, diffs) stays in the
git-ignored `state/ctx-state-1-{baseline,pilot}/evidence/`. All numbers are real-model runs (`cliproxyapi/gpt-6-astra`, high,
extendedContext) in the evaluator sandbox; one repeat per cell. Discovery tasks are exposed suite tasks; no holdout was used.

## Reproduce

```bash
node pi-eval-loop/experiments/ctx-state-1/run.mjs --prereg pi-eval-loop/experiments/ctx-state-1/prereg-baseline.json --state pi-eval-loop/state/NEW-baseline
node pi-eval-loop/experiments/ctx-state-1/run.mjs --prereg pi-eval-loop/experiments/ctx-state-1/prereg-pilot.json --state pi-eval-loop/state/NEW-pilot
node pi-eval-loop/experiments/ctx-state-1/fidelity.mjs --state pi-eval-loop/state/NEW-pilot
```

## Baseline (pre-change orche e831a6b; existing features only)

| arm | settings | valid success | compactions | max observed input / request | requests (sum) |
|---|---|---|---|---|---|
| A0 | operational: ledger off, fixed, no checkpoints | 6/6 | 0 | 26-52k | 275 |
| A1 | + ledger, checkpoints, evidence strict | 6/6 | 0 | 28-55k | 306 |

Trace verification (fidelity.json): A1 units have 7-9 `orche-ledger` events in the main session, every checkpoint in the last
plan cites `[orche ref Tn]` refs (21-43 tagged results per unit), effort `high` on every request and no `thinking_change`; A0
has no ledger events and no refs. The configured combination works in the current code. Production runs `fixed` too, so no
phase/fixed confound exists. Paired difference A1-A0: 0 of 6 tasks differ (both at ceiling): no evidence either way; a tie on six
tasks is not equivalence.

Under the stable policy no worker compacted (contexts stay far below 50% of a 922k window): the stable arms cannot show a
compaction-related state loss or gain on these tasks.

## Pilot (new orche 559bf27; A1 settings + workerCompaction absolute, extended essentials, sub-workers on)

| arm | task | valid | Pi compactions (worker+sub) | summary requests (wire, no session id) | references | fallbacks | max input |
|---|---|---|---|---|---|---|---|
| PT24 (24k/6k) | p1 | yes | 5 (4 + 1 sub-worker) | 6 | 4/4 valid | 0 | 23.9k |
| PT24 | p3 | yes | 4 | 5 | 4/4 valid | 0 | 28.7k |
| PT32 (32k/8k) | p1 | yes | 2 | 3 | 2/2 valid | 0 | 33.0k |
| PT32 | p3 | yes | 2 | 3 | 2/2 valid | 0 | 32.0k |

The interventions really happened: the new code loaded in the real Pi 1.5 sandbox, workers compacted repeatedly at the absolute
trigger (`policy: absolute`, `early: true`), every essentials message carried request, plan, ledger, work log and a disk-checked
transcript reference, one sub-worker compacted, no compaction failed or was refused. Summary requests are counted apart from task
requests (one more than compactions where Pi split a turn). No worker re-read its transcript (0 transcript reads): retrieval was
offered but not needed on these tasks, so its effect is untested.

## Not done / unknowns

- The frozen main stage (M0-M4, >= 3 repeats, amended-constraint tasks) was not run: this assignment's model-request budget ended
  after the pilot. Without it there is no controlled contrast for timing, retrieval or sub-worker support.
- Mid-task user corrections and kill-and-resume are not expressible in the single `pi -p` runner; they are covered only by mock
  integration tests (`orche/test/extension/worker-compaction-pool.test.ts`, `orche/test/pi/worker-compaction.test.ts`).
- No holdout consumed (preregistered: only with a viable contrast).
- Ceiling: 16/16 valid successes across all runs; the suite's long tasks do not discriminate on this route.

## Decision

Implementation: complete (opt-in). Performance: INCONCLUSIVE. Operational default: KEEP_STABLE (`workerCompaction` absent =
50% window, basic essentials, sub-worker compaction off; ledger and checkpoints stay as configured by the operator).
