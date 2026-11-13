# ctx-state-1 results (2026-11-07): baseline, pilots and the main M0-M4 ablation — performance INCONCLUSIVE, KEEP_STABLE

Preregistration: `experiments/ctx-state-1/PREREGISTRATION.md` and one prereg file per stage (`prereg-{baseline,pilot,pilot-s1,main}.json`).
Records: `records/ctx-state-1/{baseline,pilot,pilot-s1,main}/` (runs.jsonl ledger, lock.json, queue.json, campaign.json,
grading.json, fidelity.json; for pilot-s1 and main also audit.json and analysis.json; main also run.log, run.out.jsonl and the
holdout supply status). Evidence (wire journals, transcripts, diffs) stays in the git-ignored `state/ctx-state-1-<stage>/evidence/`.
All numbers are real-model runs (`cliproxyapi/gpt-6-astra`, effort high, extendedContext) in the evaluator sandbox. Discovery tasks
are exposed suite tasks plus the experiment's own multi-turn task; no holdout was used.

## Reproduce

```bash
# each stage: a NEW state directory (an existing one resumes under its lock; a changed experiment is refused)
node pi-eval-loop/experiments/ctx-state-1/run.mjs --prereg pi-eval-loop/experiments/ctx-state-1/prereg-baseline.json --state pi-eval-loop/state/NEW-baseline
node pi-eval-loop/experiments/ctx-state-1/run.mjs --prereg pi-eval-loop/experiments/ctx-state-1/prereg-pilot.json    --state pi-eval-loop/state/NEW-pilot
node pi-eval-loop/experiments/ctx-state-1/run.mjs --prereg pi-eval-loop/experiments/ctx-state-1/prereg-pilot-s1.json --state pi-eval-loop/state/NEW-pilot-s1
node pi-eval-loop/experiments/ctx-state-1/run.mjs --prereg pi-eval-loop/experiments/ctx-state-1/prereg-main.json     --state pi-eval-loop/state/NEW-main
# trace fidelity (locked), supplemental audit and the analysis (both outside the locked tree; analysis recomputes both and writes
# fidelity.json, audit.json and analysis.json into the state directory)
node pi-eval-loop/experiments/ctx-state-1/fidelity.mjs --state pi-eval-loop/state/NEW-main
node pi-eval-loop/experiments/ctx-state-1-analysis/audit.mjs --state pi-eval-loop/state/NEW-main
node pi-eval-loop/experiments/ctx-state-1-analysis/analyze.mjs --state pi-eval-loop/state/NEW-main --prereg pi-eval-loop/experiments/ctx-state-1/prereg-main.json
# holdout supply status (read-only)
node pi-eval-loop/bin/eval-loop-supply.mjs status --pool /home/arthur/Code/agent_workflow/runs/eval-loop-supply
# checks
(cd pi-eval-loop && npm test)   # includes test/ctx-state.test.mjs
(cd orche && npx tsc --noEmit && npx vitest run test/extension/worker-compaction-pool.test.ts test/extension/task-ledger.test.ts test/extension/task-timeout-resume.test.ts)
```

Enable / disable the new orche features: `orche.config.json` key `workerCompaction` (orche `docs/compaction.md`). The arm settings
are the exact overlays in `prereg-main.json` `arms[].orcheConfig`; e.g. M4 = `single.ledger: true`, `thinkingPolicy: {mode: fixed,
checkpoints: true, evidence: strict}`, `workerCompaction: {policy: absolute, triggerTokens: 24000, keepRecentTokens: 6000,
essentials: extended, subWorkers: true}`. Removing `workerCompaction` (or `"window-ratio"`) restores the stable 50% policy with basic
essentials and no sub-worker compaction; that is the default.

## Baseline (pre-change orche e831a6b; existing features only)

| arm | settings | valid success | compactions | max observed input / request | requests (sum) |
|---|---|---|---|---|---|
| A0 | operational: ledger off, fixed, no checkpoints | 6/6 | 0 | 26-52k | 275 |
| A1 | + ledger, checkpoints, evidence strict | 6/6 | 0 | 28-55k | 306 |

Trace verification (fidelity.json): A1 units have 7-9 `orche-ledger` events in the main session, every checkpoint in the last
plan cites `[orche ref Tn]` refs, effort `high` on every request and no `thinking_change`; A0 has no ledger events and no refs.
Production runs `fixed` too, so no phase/fixed confound exists. Under the stable policy no worker compacted.

## Pilots (new orche 559bf27)

`prereg-pilot.json` (p1/p3 x 1, 24k/6k vs 32k/8k): 4/4 valid, 2-5 compactions per unit, all references valid, no fallback. The
24000/6000 trigger was frozen from it. `prereg-pilot-s1.json` (plumbing of the multi-turn task s1, M1 and M4 x 1): three resumed
turns completed in both units; both failed only the strict test-immutability check because the task's own smoke test imported a
module the task asks to change. The smoke test was rewritten before the main lock (task digest in `records/ctx-state-1/main/lock.json`);
the pilot was not used in any outcome analysis.

## Main ablation (frozen `prereg-main.json`; 5 arms x 7 tasks x 3 repeats = 105 units)

Arms (one factor per adjacent contrast, same model/effort/tools/limits): M0 operational settings; M1 + ledger, checkpoints, strict
evidence (existing preservation); M2 + absolute worker trigger 24000/6000, basic essentials (timing); M3 + extended essentials with
transcript reference (retrieval package); M4 + `orche_spawn` sub-worker compaction (sub-workers). Tasks: p1, p2, p3, d1, d5, d7 and
`s1-amended-billing` (three user turns, each a separate Pi process resuming the same session: tickets + a single-use batch id; an
amended rounding rule that supersedes session 1's; export of the batch id seen in session 1).

### Interruption accounting

The campaign started 2026-11-07T14:06:02Z and was killed by SIGTERM at 15:12Z when the owning pi session ended (26 results, 5
dispatched units without a result). It was resumed at 17:47:34Z under the unchanged lock (`run.log`). The only lock difference at
resume was `experiments/ctx-state-1/analyze.mjs`, written at 14:07:03Z (after the lock, before the first result at 14:13:50Z); it was
moved to `experiments/ctx-state-1-analysis/` so the locked tree is byte-identical, then the lock comparison was empty. The evaluator
reconciled the 5 interrupted units from their wire journals as `aborted` (6-39 completed model calls each; not retryable under the
protocol), so they count as NOT successful: M0 d1#0, M0 p2#2, M1 d1#0, M3 d1#0, M4 d1#0. They have no grading and no telemetry: their
regressions, critical failures and compactions are UNKNOWN (the 0 in the ledger is a default, not an observation). The campaign
finished at 20:25:28Z with 105/105 final records, 5989 requests, no pause (request ceiling 26000, wall ceiling 12 h including the
downtime: 6 h 19 min used). Infra rate 0/105 (the preregistered `maxInfraRate` 0.1 is not enforced by the shared driver; it was
checked at every progress check and never approached).

### Outcomes (primary: valid success; per task the repeats r0 r1 r2)

| task | M0 | M1 | M2 | M3 | M4 |
|---|---|---|---|---|---|
| d1-transactional-outbox | 0* 1 1 | 0* 1 1 | 1 1 0 | 0* 1 1 | 0* 1 1 |
| d5-streaming-ingest-ko | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 |
| d7-config-reload | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 |
| p1-ticket-batch | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 |
| p2-handler-migration | 1 1 0* | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 |
| p3-library-features-ko | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 | 1 1 1 |
| s1-amended-billing | 1 1 1 | 1 1 1 | 1 1 0 | 1 1 1 | 1 1 1 |
| **valid / 21** | 19 | 20 | 19 | 20 | 20 |

`*` = reconciled interruption. Failures that ran to completion: M2 d1#2 (hidden tests failed, `requirements-generalization`), M2
s1#2 (hidden tests passed, an existing test file was modified: strict test immutability, 1 critical failure). No arm had timeouts,
route violations or infra errors. Among graded units: regressions 0 in every arm, critical failures 0/0/1/0/0.

### Contrasts (paired by (task, repeat), 21 complete pairs each, no missing cell)

| contrast | effect separated | dRate | task-bootstrap 95% CI | better/worse tasks | exact sign-flip p | Holm | verdict |
|---|---|---|---|---|---|---|---|
| M1-M0 | existing preservation | +0.048 | [0, 0.143] | 1/0 | 1.00 | 1.00 | INCONCLUSIVE |
| M2-M1 | compaction timing | -0.048 | [-0.143, 0] | 0/1 | 1.00 | 1.00 | INCONCLUSIVE |
| M3-M2 | extended essentials / retrieval package | +0.048 | [0, 0.143] | 1/0 | 1.00 | 1.00 | INCONCLUSIVE |
| M4-M3 | sub-worker compaction | 0 | [0, 0] | 0/0 | 1.00 | 1.00 | INCONCLUSIVE |

Every difference is one task in one repeat; the M1-M0 difference comes from the interrupted units (sensitivity without the
reconciled units, descriptive only: M1-M0 0, M2-M1 -0.119, M3-M2 +0.119, M4-M3 0, exact p >= 0.5). Ties at the ceiling are not
equivalence. Design limitation found in the analysis: with 7 tasks the exact within-task sign-flip has 128 patterns, so the smallest
attainable p is 2/128 = 0.0156 and the smallest Holm-adjusted p over four contrasts is 0.0625; the frozen rule (CI lower bound > 0
and Holm p < 0.05) could not have produced VIABLE on this task set whatever the outcomes. The analysis written before the first
result used ctrl-ablation-1's Monte Carlo sign-flip and per-arm repeat means (`analysis.json` `contrasts`); it gives the same
verdicts. The literal preregistered version (`contrastsPaired`: explicit (task, repeat) pairs, exact enumeration) decides.

### Interventions and requested scenarios (what really happened, from traces)

| arm | compactions (units) | worker + sub-worker | summary / task requests | est. tokens before -> after | essentials max chars | references valid | loop-guard cancels (fallbacks) | max input per request | max requests per unit (cap 300) |
|---|---|---|---|---|---|---|---|---|---|
| M0 | 0 | - | 0 / 923 | - | - | - | 0 | 53.5k | 103 |
| M1 | 0 | - | 0 / 1134 | - | - | - | 0 | 55.5k | 114 |
| M2 | 63 (21 of 21) | 63 + 0 | 90 / 1143 | 26.2k -> 15.1k | 12510 | n/a (basic) | 2 (2) | 47.9k | 118 |
| M3 | 63 (19 of 20) | 63 + 0 | 80 / 1227 | 26.5k -> 16.4k | 14705 | 63/63 | 2 (2) | 51.1k | 129 |
| M4 | 71 (20 of 20) | 63 + 8 | 97 / 1172 | 26.2k -> 16.2k | 18181 | 63/63 | 4 (4) | 46.4k | 132 |

(Graded units with telemetry only; max input includes the never-compacted main session.) Ledger events in every M1-M4 unit and none
in M0; effort `high` on every request, no thinking change. No compaction failed, no essentials section was missing. Summary requests
never exhausted the unit limits (max 132 of 300 requests, max 27 of 45 min).

- Repeated compaction on long work: yes in M2-M4 (up to 8 compactions per unit). No outcome difference.
- Mid-task constraint change (s1 turn 2 supersedes the session 1 tie rule): 15/15 s1 units pass the hidden tests of the amended rule
  (the superseded rule was not reactivated in any arm); one M2 unit failed integrity. The task does not discriminate between arms.
- Past-evidence retrieval: `audit.json` separates verified transcript reads (matched call, non-error result containing session
  entries) from heuristic hits. Verified reads: 2 calls in one unit (M4 s1#0: the handed-over W2 read W1's transcript), 0 in all
  other arms, and 0 reads after the reading worker's own compaction in any arm. The locked fidelity/telemetry counters
  (`transcript_reads`, 6-11 per arm, also in M0) are heuristic and overcount. The s1 batch id was carried by the resumed main
  session, never retrieved from a transcript. Retrieval was available (63/63 valid references) but essentially unused: its effect
  is untested.
- Worker resume / replacement: in all 15 s1 units of every arm the worker of the previous turn was gone (its Pi process ended) and
  the next turn's worker received orche's handover (29 handover prompts naming the gone worker and its transcript; 5 ledger
  "Continuing task" briefings in M1/M3/M4). That is a live replacement after a clean process end. A worker killed MID-task and then
  recovered was not part of the frozen design: it is covered only by mock tests (`orche/test/extension/worker-compaction-pool.test.ts`
  "a compacted worker that is stopped mid-task is replaced after a reload", `task-timeout-resume.test.ts`), so live mid-task
  recovery remains unverified by a controlled run.
- Multi-worker integration: 41 graded units ran `orche_spawn` sub-workers (151 sub-worker sessions); all 41 were valid. Sub-worker
  compaction happened only in M4 (8 compactions). Spawning alone is not evidence of a state-preservation benefit; M4-M3 is a tie.

Unknown / not measured: repetition of failed approaches and state loss beyond the hidden tests (no direct instrument); outcomes and
telemetry of the 5 reconciled units; production-model effects.

## Holdout

Not performed. Two independent reasons: (1) the frozen rule (`prereg-main.json` analysis.holdout) reserves a holdout only for a
viable contrast and none is viable; (2) the existing supply pool has no eligible batch now (`records/ctx-state-1/main/supply-status-recheck.json`,
identical to the 14:20Z status in `supply-status.json`): batch b20261105T082536Z-7e3cc8f8 has no hard task with an accepted
difficulty basis, batch b20261105T093919Z-006937cf is already used (reserved by state/aw-scheduled), and only 2 unbatched eligible
cases exist. No batch was reserved or sealed; the concurrent ctrl-confirm-3/4 supplies were not touched.

## External validity

All arms ran on the substitute route gpt-6-astra/high. Production orche workers run on claude-opus-5-5, which the evaluator's
fail-closed sandbox gate cannot admit (only the codex responses endpoints are allowed: `src/sandbox.mjs` `ALLOWED`); the gate was not
bypassed. Nothing here establishes a production-model effect.

## Decision

Implementation: complete (opt-in `workerCompaction`; existing ledger/checkpoints reused). Performance: INCONCLUSIVE (all four
contrasts; ceiling effects, 7 tasks, one-unit differences). Holdout confirmation: not performed (frozen rule; supply blocked).
Operational default: KEEP_STABLE (`workerCompaction` absent = 50% window, basic essentials, sub-worker compaction off; ledger and
checkpoints stay as configured by the operator).
