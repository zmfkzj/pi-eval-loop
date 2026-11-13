# exploratory-1 (2026-11-07)

One fixed harness candidate (**c1**) gets an integrity screen on non-holdout tasks. After that, it gets at most **one** exploration-only holdout pass against the stable harness.

This study is separate from `studies/confirmatory-1`, which keeps its own DESIGN-v3 and readiness-v3. Nothing here adopts, deploys, promotes, commits or schedules anything, and nothing here is confirmatory evidence.

## Candidate c1
- `build-candidate.mjs` exports the stable archive e831a6b2 and applies `c1.diff`. It creates no commit; the candidate is identified by its digests (`candidateIdentity`: diff sha256 + runtime digest).
- c1 adds three things:
  1. The test-integrity rule in both the main session and the orche sessions.
  2. A guard that refuses edit, write and ast_rewrite on existing test files.
  3. Detection of out-of-band test changes made by shell or worker. These are reported to the model and never undone. The guard writes nothing.
- The evaluator decides integrity, with `integrity.strictTestFiles` set: existing test files must stay byte-identical, plus the legacy line rules. All transcripts are captured (`capture.transcripts`).

## Screen (development tasks only)
`explore.mjs screen` uses the frozen `screen-plan.json`: 10 tasks × 2 repeats. The tasks are 4 calibration-only tasks and 6 consumed ctrl-confirm-2 holdout tasks.

The acceptance rule was fixed before the run: zero legacy, strict or leak violations, every unit measured, no crash or route violation.

- **First run:** void. A controller bug (`runner.mjs` missing the `dirname` import) aborted it. Its state is kept as `screen-aborted-controller-error` (45 attempts).
- **screen-2:** accepted. 20/20 units measured, 0 violations, 18 successes, 460 requests. The guard detected one out-of-band change, and that unit's final tree was clean.
- **How much this proves:** 0/20 bounds the violation rate only loosely. The one-sided 95% upper bound is about 14%.

## Supply and selection
- **Sealing boundary:** the study pool carries `POLICY.json` (`autoSeal: false`, `sealVia: select-supply.mjs`). With it, `eval-loop-supply collect|refresh` never seal and the generic `seal` refuses (`src/supply-cli.mjs`, `poolPolicy` in `src/supply.mjs`).
  - Before this policy existed, two collector auto-sealed batches contained tasks of earlier holdouts. They were retired with evidence (`retireBatch`; `retire-autoseal-2026-11-07.json`), and their directories are kept as provenance.
- **Selection:** `select-supply.mjs` withdraws every unbatched case whose family, or whose Exercism problem in any track, occurs in any of these sources:
  - the earlier supply registries;
  - the holdout datasets;
  - the pool's live batches (calibration, reserved and used batches included);
  - retired-but-unrestaged tasks;
  - the screening tasks.

  Every source must be readable, or the selection fails closed. The rule document is written once, hashed, and used as the withdrawal evidence; the seal result is written to a separate `*.result.json`. The seal itself (`sealBatch`) is candidate-blind and seed-ordered, and enforces:
  - 6 tasks, 4 families;
  - at least one hard task with an annotated source;
  - account share ≤ 0.5.
- **Fresh third owner:** found by explicit `collect --repos` on scouted zero-dependency `node --test` repositories that appear in no earlier registry. This produced `x-fastify-forwarded-90ece3bf26`: MIT licence, commit 2026-09-04, base fails and reference passes.
  - Other targeted repositories produced no task. They were rejected by the collector's own rules (mostly `test-imports-unavailable-package`, i.e. the grader runs offline with no node_modules).
- **Batch** `b20261107T080727Z-91019bdd`:
  - 6 tasks, 4 families, 3 owners.
  - The one hard task is Exercism TS knapsack (track difficulty 9).
  - The other tasks are 3 private tasks from one authoring account, Exercism TS clock, and fastify/forwarded.

## Holdout pass
- **Frozen plan:** `holdout-plan.json`, written before any outcome existed (exposure limitations included).
- **Order of steps:** `explore.mjs holdout` checks everything model-free *before* consuming the batch:
  1. seal and purpose;
  2. that the accepted screen report is bound to the plan by sha256;
  3. arm identities (c1 digests, stable runtime digest);
  4. every grader (start fails, reference passes);
  5. the arms' checks;
  6. budget headroom (`minRemaining`, no foreign open reservation);
  7. independence;
  8. that the pool would hand out exactly the frozen batch.

  Only then does it reserve the batch and record its single use. A resume reuses both the reservation and the use. `--preflight` runs all of these checks without reserving or consuming.
- **Gate:** `adoptionDecision` with `analysisPlan.mode = "exploratory"` cannot produce ADOPT.
- **Result** (`readiness.json`; `$P/explore/holdout/final.json`): the pass ran once, all 36/36 units were measured, and the schedule was followed with 0 inversions.
  - **Verdict:** KEEP_STABLE, adopt false.
    - Task-level support for c1 is 0.9625. Family-clustered support is 0.9456, below the 0.95 threshold, so the verdict is not supported.
  - **Integrity violations:** stable had strict and legacy integrity violations in 8 of 18 units, every one an edit to an existing test file. c1 had 0 of 18.
  - **Success:** c1 succeeded in 15/18 units, stable in 8/18.
  - **Hidden tests:** c1 passed them in 15/18 units, stable in 14/18. Nearly all of c1's difference is therefore integrity, not solving more tasks.
  - **Requests:** stable 335, c1 364.
  - **What this does not claim:** with 6 tasks this is not confirmatory, and it supports no generalization claim.
  - **Analysis incident:** after the last unit, the analysis threw. `Evaluator.samples()` compared the `{digest, facts}` environment object by identity. `envKey` in `explore.mjs` fixed this, with a regression test.
    - The pass resumed from its recorded units: nothing was rerun and no model call was made.
    - The crash log is kept as `holdout-analysis-crash-1.err`.

## Budget
Every target-model attempt goes through the isolated runtime's outbound gate and the single ledger `runs/eval-loop-confirmatory-1/budget/target-model-requests.jsonl`. That ledger has a cap of 4500 actual attempts, shared by the calibration, the screens and this pass. Authoring and review model calls are outside that ledger and are reported separately.

## Commands
```
node studies/exploratory-1/build-candidate.mjs --stable $P/harness-e831a6b2 --out $P/harness-candidates/c1 [--verify]
node studies/exploratory-1/explore.mjs screen  --state DIR --plan screen-plan.json  --runtime $P/runtime/iso-1 --budget-ledger … --gateway-db …
node studies/exploratory-1/select-supply.mjs  --pool $P/pool --screen-plan screen-plan.json --out lineage-rule.json [--dry-run]
node studies/exploratory-1/explore.mjs holdout --state DIR --plan holdout-plan.json --runtime … --budget-ledger … --gateway-db … [--preflight]
```
Tests: `test/exploratory.test.mjs`, `test/exploratory-selection.test.mjs`, and `retireBatch` in `test/isolated-calibration.test.mjs`.

## Recurring route (2026-11-07)
The study's runner functions now live in `src/exploration.mjs` and its lineage selection in `src/lineage.mjs` (this directory re-exports them). The recurring exploration-only route `bin/eval-loop-explore.mjs` reuses both — see the package README "Recurring exploration-only route". Its config for this pool: `$P/explore/exploration-recurring.json`. Dormant; not deployed.
