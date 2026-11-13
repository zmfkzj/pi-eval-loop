# ctrl-ablation-1 — preregistration

Registered 2026-11-06, before any outcome of this experiment existed. Machine-readable twin: `prereg.json` (its sha256 is
locked with every run). Amendments are appended at the end with a timestamp and a reason; earlier text is never edited.

## 1. Question and hypotheses

Objective: final **valid task success** and **consistency** of pi-orche (not cost). In abc-real-1 / explore-real-2 stable
pi-orche (e831a6b, single mode) had 76/96 valid dev successes against 85/96 for pure Pi; most of the gap was integrity
violations (existing test files changed), the rest functional failures. Those runs were not randomized (arms ran in time
blocks) and are exploratory. This experiment isolates single interventions on the same harness under randomized, interleaved
execution.

- H-P (prompt / test preservation): telling the agent that existing tests are read-only (P1, P3) or removing the
  "add or update tests" instruction (P2) reduces integrity failures without lowering functional success.
- H-D (decomposition / hand-off): no delegation (D1) or a verbatim hand-off (D2) changes valid success.
- H-T (tools): worker tool parity with pure Pi (T1) changes valid success.
- H-V (verification): removing `verifiedBy` (V1) or adding a mandatory independent verifier (V2) changes valid success.
Every hypothesis is two-sided in discovery: harm is as reportable as benefit.

## 2. Arms (one intervention each; exact bytes in `variants/*.diff`, locked by digest)

| arm | base | intervention |
|---|---|---|
| S | orche e831a6b | control: historical evaluator config (`runner.mjs` `orcheConfig`: single, spawn true, advisor false, ledger false) |
| B0 | pure Pi | control: historical flags, built-in tools read/bash/edit/write |
| P1 | S | `testIntegrityRule` (prereg.json) appended to the system prompt of every orche-created session (`src/pi/session-factory.ts`) |
| P2 | S | only "add or update tests" -> "add tests" (`mode.ts` single rule) and "adding or updating tests" -> "adding tests" (`workers.ts` implement prompt) |
| P3 | B0 | the same `testIntegrityRule` via Pi's documented `--append-system-prompt` (mechanism control for P1 outside orche) |
| D1 | orche e831a6b | `mainMode: "direct"` (no delegation). Bundled change, not separable: main also gets direct-mode prompt and orche's main tool set |
| D2 | S | hand-off = fixed line `R1: Complete the original request below exactly as written.` + Original request verbatim (R-id parsing stays, so `verifiedBy` enforcement is not silently disabled) |
| T1 | S | worker tools = read, bash, edit, write with Pi's built-in read/edit (orche's anchored read/edit not registered for orche-created sessions); task_plan/orche_spawn/report_result unchanged |
| V1 | S | `verifiedBy` removed from the implement prompt and from result-schema enforcement |
| V2 | S | the implement worker always spawns one fresh read-only verify sub-worker before reporting (max 2 rounds), charged to the same unit ceilings |

Variants are built in the experiment state directory from `git archive e831a6b` plus the patch; nothing is committed and the
orche checkout, its defaults and production configuration are untouched. Every variant typechecks (`tsc --noEmit`).
Intervention fidelity is checked from captured transcripts (`fidelity.mjs`): effective system prompts, tool declarations,
hand-off requests and sub-worker roles; arms whose fidelity check fails are reported as not realized.

## 3. Fixed conditions

- Route `cliproxyapi/gpt-6-luna`, effort medium, for every session of every arm (proxy-enforced; off-route = route_violation).
- Per-unit ceilings identical for all arms: 20 min wall, 150 model requests (all sessions of the unit count), grader 120 s.
- Environment digest (Node, Pi CLI, provider, bwrap, route) recorded and checked; same sandbox, offline, hidden tests never
  mounted for agents.
- Seeds: the provider exposes no sampling seed; repeats are independent draws, not seeded replicates.
- Concurrency 6 units; all arms share one randomized queue.

## 4. Tasks, repeats, randomization

- Discovery tasks: all 27 tasks of `orche/fixtures/suite` (16 former dev + 11 former train; exposed, therefore discovery only).
- 3 repeats per task and arm: 27 x 3 x 10 = 810 planned units.
- Blocks = (task, repeat), each containing one unit per arm; arm order within blocks and block order are shuffled with the
  seeded RNG (`rng.mjs`); the queue is frozen in the lock and resumed in the same order.
- Smoke (excluded from all analysis): 1 unit per arm on `datasets/holdout-v1/h1-interval-merge` (implementer-authored, already
  consumed, not in the discovery set), in a separate state directory, to check plumbing and fidelity only.

## 5. Integrity (never relaxed; identical for all arms)

- Existing detector (legacy) unchanged, including the 161605a Node-runner-name fix (audited before the run, see §10).
- Added strict rule: every original test file must be byte-identical at the end (append-only edits and reformatting count).
- Leak scan covers ALL captured transcripts (main + orche sub-sessions), not only the main session.
- Integrity-failing runs never count as successes. Fixtures and hidden tests are never modified by the setup.

## 6. Outcomes

- Primary: valid success (completed, hidden pass, visible not failed, no integrity violation, no leak/critical).
- Consistency: per task, k successes of r=3; inconsistency I_t = k(r-k)/(r(r-1)) (unbiased estimate of p(1-p)); arm I = mean
  over tasks; also counts of 3/3, mixed and 0/3 tasks (consistent failure is reported separately: low I with 0/3 is not good).
- Secondary: functional success, integrity failures (legacy / strict / leak), terminal statuses, family breakdown,
  requests/tokens/wall per arm (recorded, not optimized).
- Pairing unit: task (repeats nested). 81 units per arm are NOT 81 independent tasks.

## 7. Analysis (exploratory)

Contrasts: P1-S, P2-S, D1-S, D2-S, T1-S, V1-S, V2-S (candidates); P3-B0 (mechanism); B0-S (replication of the historical gap).
For each: dValid and dI with task-cluster paired bootstrap 95% intervals (10 000 draws, seeded); within-task arm-label
randomization test of dValid (20 000 draws; exchangeability holds by the randomized interleaving); Holm over the 7 candidate
contrasts. Family tables descriptive. Primary analysis counts every scheduled unit (timeouts, agent errors and infrastructure
failures after the retry are failures); sensitivity analysis excludes infrastructure-only units.

## 8. Stopping and invalidation (no outcome-based stopping)

Fixed sample of 810 units; no interim efficacy or futility look. Dispatch pauses (never decides) on: 5 consecutive
infrastructure failures; aggregate model requests >= 45 000; campaign wall > 16 h; a route violation or evaluator defect.
If the overall infrastructure rate exceeds 10% the discovery is reported as infrastructure-compromised and no candidate is
locked. A paused campaign may resume in the same frozen order; units are never re-run except the evaluator's infra-only retry
(zero completed model calls, at most 1). If a ceiling ends the campaign early, only complete blocks are analysed and the
discovery is reported as incomplete.

## 9. Candidate lock, confirmation and adoption

- Viability (single rule, no alternative): dValid(X-S) >= +3.7 pt AND bootstrap 95% lower bound of dValid > 0 AND
  dI(X-S) <= 0 AND integrity failures(X) <= integrity failures(S) AND no leak/route_violation/harness_crash in X. At most one
  candidate is locked: the viable X with the largest lower bound (tie: lower I). The lock (`locked-candidate.json`: arm, patch
  digest, analysis code digest) is written before any confirmation run.
- Confirmation requires ALL of: a locked candidate; genuinely unused, externally sourced, sealed holdout tasks with families
  disjoint from the suite; a sample size from a hierarchical simulation calibrated on this discovery (task-level success pairs
  of S and X with shrinkage, family effects, repeats r in {3, 4, 6}) giving >= 0.8 power for the co-primary below at the
  available number of tasks; and authorization to record the holdout use in its pool ledger. The supply pool lives outside the
  workspace (`../../agent_workflow/runs/eval-loop-supply`); writing there is not authorized for this assignment, so if every
  other prerequisite holds confirmation is reported BLOCKED on that authorization. `datasets/holdout-v1` is consumed and
  implementer-authored and can never confirm.
- Confirmatory design (if run): arms X, S, B0; same blocking/interleaving; fixed sample; co-primary intersection-union test,
  each one-sided alpha 0.025: dValid(X-S) > 0 and dI(X-S) < 0 (task-cluster bootstrap bounds); X-B0 only after the primary
  passes (fixed sequence).
- Adoption (recommendation only; no default or production change in this experiment) needs the confirmatory co-primary to pass,
  integrity failures(X) <= S with every X failure audited, zero leak/route/crash, and no family with a lower valid-success point
  estimate than S (any such family -> user review, not automatic adoption). REJECT: dValid upper bound < 0 or worse integrity.
  Anything else, including a blocked confirmation: INCONCLUSIVE -> KEEP_STABLE. A discovery result alone never adopts.

## 10. Pre-run audit and resources

- Detector audit before discovery: the known false positives of explore-real-2 (`src/csv/test.mjs`) and aw-scheduled
  (`test-arabic-script.js`) are both the Node-runner-name class fixed by 161605a with regression tests; the strict rule and the
  all-transcript leak scan are exercised by unit tests and the smoke run before discovery and then frozen.
- Planned resources: 810 units; expected ~15-20k model requests and ~4-6 h at concurrency 6 (historical rates); hard ceilings
  per §8. Realized requests, tokens and wall time are reported per arm.

## Amendments

- A1 (2026-11-06T02:10Z, before any discovery unit; smoke only): smoke state `state/ctrl-ablation-1-smoke` showed every
  patched arm ran WITHOUT its patch: `git apply` inside the pi-eval-loop checkout silently skips paths outside the repository
  root. Fix (no change to any intervention text): `buildHarness` applies the patch with `GIT_CEILING_DIRECTORIES` set and then
  requires `git apply --reverse --check` to succeed; the variant test now builds inside the checkout. That smoke state is
  invalid for fidelity and is kept only as a record; the smoke is repeated in `state/ctrl-ablation-1-smoke2`. Smoke outcomes
  are never analysed.
