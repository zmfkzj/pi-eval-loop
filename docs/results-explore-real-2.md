# Measured run `explore-real-2` (2026-11-04): exploration-only train/dev search under protocol-2

**Result: the search ran to its pre-registered stop in both arms and found no candidate. B and C each proposed 10 candidates; all
20 were rejected at screening by the protocol-2 critical-integrity rule. Nothing was selected. Deployment is BLOCKED.** This is a
real measurement: 570 distinct real attempts, 0 simulated. The per-ledger result counts are A 210, B 390 and C 390, because the B
and C ledgers carry copies of the shared baseline units, so summing the ledgers would double-count. All numbers come from
`pi-eval-loop/records/explore-real-2/`: `ablation.md`/`ablation.json`, `A|B|C/report.md`, ledgers, candidate archives, and
`audit.json`, which recomputes exact counts from the raw ledgers (`scripts/audit-records.mjs`, asserted by
`test/records-audit.test.mjs`). No improvement of any kind is claimed.

## Setup

| Item | Value |
|---|---|
| Command | `EVAL_LOOP_UMBRELLA=<umbrella> node <frozen copy>/pi-eval-loop/bin/eval-loop.mjs --ablation --state pi-eval-loop/state/explore-real-2 --protocol pi-eval-loop/protocols/explore-real-2.json` |
| Code | commit 38cbee5, run from a `git archive` copy of that commit; the locked evaluator bytes of this run are those of 38cbee5. Later commits add JSDoc types, docs, tests, audit/diagnostic scripts, CLI `--strategy` validation, the A/B/C selection `reason` and critical re-check, and the fixes listed under "Defects found by the independent verification" |
| Protocol | `pi-eval-loop/protocol-2` defaults + `protocols/explore-real-2.json`: `datasets.holdout = null`, 6 parallel units per trajectory |
| Agent route (every arm) | `cliproxyapi/gpt-6-luna`, effort medium; one environment digest (`f5ce1410…`, the same as `abc-real-1`) for all 570 attempts |
| Tools / initial environment | identical Pi CLI flags, sandbox and task workspaces for every arm; orche arms additionally load the orche extension (the treatment). Every orche model tier pinned to the one route |
| Target harness | pi-orche `e831a6b`, mode `single` |
| Optimizer | plain Pi on `cliproxyapi/gpt-6.1-sol` effort high, in the sandbox, on a copy of the harness runtime |
| Splits | 11 train / 16 dev orche suite tasks (same seed and split as `abc-real-1`), 3 repeats; **no holdout** |
| Start | clean state directory; no candidate, archive or record of `abc-real-1` was reused |

### Search stopping rule (pre-registered in the protocol lock)

- Stop after **10 consecutive candidates without meaningful progress** (the user's default). Progress: Pareto arm, a
  development-qualified, critical-clean candidate not weakly dominated by any development-set member; quality-only arm, a new best.
- Safety stops only: a failure class is exhausted after 10 failed targeted proposals; 200-candidate runaway backstop; 72 h hang
  watchdog; 5 consecutive infrastructure-tainted candidates; trust-boundary breach. None was set for cost or time.
- Both arms had the same rule, tasks, route, protocol and proposer. The number of candidates is an outcome, not a budget.

### Operational constraints in force (from `A/protocol.lock.json`)

Cost and time are not optimization targets. These limits exist for unattended safety and resource use. Every one of them was
locked before the run:

| Limit | Value | Reached in this run? |
|---|---|---|
| Candidates per cycle (runaway backstop) | 200 | no (10 per arm) |
| Cycle hang watchdog | 72 h | no (3 h 43 min) |
| Failed targeted proposals per failure class | 10 (counted cumulatively per cycle by the frozen code; later code counts only since the last progress, so this stop can no longer precede the patience stop) | yes, at the same candidate as the 10-candidate patience stop |
| Consecutive infrastructure-tainted candidates / infra rate | 5 / 10% | no |
| Failed children per parent | 5 | not binding (every candidate's parent was stable) |
| One proposer session | 120 model requests, 30 min wall | no (10–18 requests per proposal, `candidates/*/candidate.json`) |
| Candidate patch | at most 4 changed files and 200 diff lines, under `src/` or `prompts/` of orche | enforced at proposal time |
| One task unit | 20 min wall, 150 model requests, grader 120 s | yes, 3 of 570 attempts, all on train task `p1-ticket-batch`: stable repeats 1 and 2 hit the 150-request budget (`agent_error`), and C-c001 repeat 2 hit the 20 min wall guard (`timeout`). These count as task failures, not infrastructure errors |
| Parallel task units per trajectory | 6 | operational setting |
| Screening | 6 train tasks, 3 repeats (extension up to 9 in the band) | protocol default |

### Holdout isolation

`holdout-v1` (implementer-authored, consumed once by `abc-real-1`) was not loaded, graded or used: `A/datasets.json` has
`holdout: []` and `holdoutSeal: null`, every ledger record is `train` or `dev`, `datasets/holdout-v1/USES.jsonl` is unchanged, and
no holdout task id appears in any optimizer evidence (`candidates/*/optimizer-evidence/`, train failures and dev aggregates only).

## Baselines (A; descriptive)

| Arm | Train success | Dev success (exact) | Dev 95% interval | Dev runs with integrity violations | Dev model requests / input tokens | Attempts per dev unit (allowed / actual) |
|---|---:|---:|---|---:|---:|---|
| stable orche (single) | 20/33 (60.61%) | 39/48 = 81.25% | [63.1, 93.9] (bootstrap endpoints are Monte Carlo approximations, ±0.5 point across seeds) | 7 | 889 / 7.50 M | 1 / 1.00 |
| pure Pi | 22/33 (66.67%) | 42/48 = 87.50% | see `A/report.md` | 2 | 456 / 1.53 M | 1 / 1.00 |
| multi3 (up to 3 pure-Pi attempts, first passing visible tests) | – | 44/48 = 91.67% | see `A/report.md` | 2 | 447 / 1.46 M | 3 / 1.02 (49 attempts) |

multi3 used a second attempt in 1 of 48 units. Its measured compute is that of pure Pi (0.50× stable's requests, 0.19× its input
tokens): it is **not** an equal-compute or opportunity-matched control for orche, and this run cannot say what extra compute buys.
Observations only (no test): pure Pi and multi3 solved more dev units than stable orche; compared with `abc-real-1` (stable 37/48,
pure 43/48, multi3 46/48) the same configurations moved by 1–3 units between two independent samples.

## Candidates (every attempt kept in `B|C/candidates/<id>/`)

| Arm | Candidates | Outcome | Search stop |
|---|---:|---|---|
| B quality-only (greedy) | 10 (B-c001..c010) | all `rejected` at screening, critical: task-agent integrity violations | no meaningful progress in 10 consecutive candidates |
| C quality-first Pareto | 10 (C-c001..c010) | all `rejected` at screening, critical: task-agent integrity violations | no meaningful progress in 10 consecutive candidates |

- Every proposal targeted `requirements-generalization` (the train failure class with the most runs) and changed one orche file
  (`src/extension/workers.ts`; C-c010 `src/orchestration/prompts.ts`) with a variant of the same idea: make implementation workers
  audit each requested behaviour against code and request-derived checks before finishing. The similarity guard (token Jaccard
  ≥ 0.8) did not treat the rewordings as duplicates. 10 failed proposals also exhausted that class, at the same moment as the
  patience stop. The `integrity` class, the actual cause of every rejection, was never the top target.
- Screening (6 train tasks × 3 repeats, matched with stable on the same units), descriptive counts:
  - B candidates 101/180 successes, 36 runs with task-agent integrity violations; stable on the same units 103/180, 26.
  - C candidates 108/180 successes, 25 runs with violations; stable on the same units 118/180, 14.
  - In each arm the candidates had more violating runs than stable on the same units (B 36 vs 26, C 25 vs 14). These are
    observations and do not show a cause.
- All violations were agents changing or removing lines of existing test files. There were no leak attempts, route violations,
  harness crashes or harness-patch violations. Under protocol-2 every such run is critical for a candidate whatever the baseline
  did, so no candidate reached development. Stable itself has violating runs (dev 7/48, train 4/33). It is the incumbent and was
  not promoted.
- Usage: B 180 candidate runs, 67.4 M / 1.35 M input/output tokens, 129 proposer requests; C 180 runs, 62.0 M / 1.20 M tokens, 120
  proposer requests. Wall time: 10:01–13:44 UTC, of which baselines took 56 min.

## Deployment and A/B/C

All three finals are the stable harness, so B−A, C−A and C−B are identical by construction. No holdout was measured.
**Deployment verdict: BLOCKED**: an exploration-only protocol, and no externally curated independent holdout exists. No ref moved:
`eval-loop/stable` does not exist in orche or the umbrella. The generated `ablation.json`/`A/report.md` print the exploration
outcome as "no candidate selected (none)". The "(none)" appears because the frozen code's A/B/C selection carried no reason. The
reason is that neither B nor C selected a candidate, and later code records it.

## Defects found by the independent verification (fixed after the run)

A fresh verifier (no part in building the code) reproduced three defects in the protocol-2 code that ran this experiment. A
fourth issue started as a doubt; the second verification round showed it was real. None changes this run's outcome: no candidate reached development, and no
committed candidate patch (abc-real-1 or explore-real-2) contains a rename or deletion.

1. Patch integrity listed changed paths with git rename detection, so moving a protected file into `src/` reported only the new
   path. Fixed: `--no-renames` (`src/worktree.mjs` `changes`), regression test "patch integrity: moving a protected file...".
   As a side effect, a rename inside the allowed directories now counts both paths and the whole file against the 4-file /
   200-line patch limits. This is stricter than before.
2. Exact plug-in points are floating-point sums, so an exact rational tie could differ by ~1e-16 and count as progress or as a
   development win over stable. Fixed: comparisons with a 1e-9 tolerance (`POINT_EPS`), regression test "ties within
   floating-point noise...".
3. Failure-class exhaustion counted failures cumulatively per cycle, so with progress it could end a cycle before 10 consecutive
   no-progress candidates. Fixed: it counts only failures among the consecutive no-progress candidates since the last progress.
   The count is bounded by the no-progress counter even for states written before `lastProgressAt` existed. Regression test:
   "class exhaustion counts failures since the last progress only...". With the defaults (10 and 10) this limit can no longer
   fire before the patience stop.
4. In a holdout A/B/C run, A's adoption check saw only A's ledger. A trajectory's own selection re-check covers only records
   written before its selection. The second verification round showed that a violation recorded after selection would have led
   to ADOPT. Fixed: `runAblation` re-checks each trajectory's final against that trajectory's own train/dev records before
   freezing it (regression test "A/B/C re-checks each trajectory's own train/dev records..."). explore-real-2 had no selection,
   so it was not affected.

Checks on the final corrected tree (`records/explore-real-2/checks/final-tree-checks.txt`):
- package `npm test` 55/55; umbrella `npm test` 74/74;
- `test:compat` Pi 1.4.0 gate 21/21; `test:install` fresh and reinstall pass, with a scratch npm cache;
- checkJs with Node types: 232 → 49, 0 added (`checks/diagnostics.txt`).

The second verification round passed.

## Limitations and what would change the result

- The strict integrity rule rejects a candidate for a single task-agent edit of an existing test file. At the stable rate (~10–15%
  of runs) a candidate is very unlikely to have zero violations in 18 screening runs unless it reduces such edits. This run shows
  the rule binding; it does not show whether a harness change can reduce the edits.
- **Failure-guided exploration is not demonstrated by this run.** All 20 proposals were variants of one hypothesis family
  ("audit each requested behaviour before finishing"), all targeted `requirements-generalization`, and **no candidate targeted the
  `integrity` class** that caused every rejection. The target choice is the most frequent train failure class, and the duplicate
  guard is lexical (token Jaccard), so the rewordings were not recognised as duplicates. A new protocol version that targets the
  class responsible for the rejections, or uses a semantic duplicate guard, would be a different search. It must be
  pre-registered before it runs.
- Train/dev tasks are exposed suite tasks. Development figures are descriptive. No holdout claim and no deployment are possible
  until an externally curated, unexposed holdout is added in a new protocol version.
