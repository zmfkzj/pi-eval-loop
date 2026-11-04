# Measured run `explore-real-2` (2026-11-04): exploration-only train/dev search under protocol-2

**Result: the search ran to its pre-registered stop in both arms and found no candidate. B and C each proposed 10 candidates; all
20 were rejected at screening by the protocol-2 critical-integrity rule. Nothing was selected. Deployment is BLOCKED.** This is a
real measurement: 570 real attempts, 0 simulated. All numbers come from `pi-eval-loop/records/explore-real-2/` (`ablation.md`,
`A|B|C/report.md`, ledgers and candidate archives). No improvement of any kind is claimed.

## Setup

| Item | Value |
|---|---|
| Command | `EVAL_LOOP_UMBRELLA=<umbrella> node <frozen copy>/pi-eval-loop/bin/eval-loop.mjs --ablation --state pi-eval-loop/state/explore-real-2 --protocol pi-eval-loop/protocols/explore-real-2.json` |
| Code | commit 38cbee5, run from a `git archive` copy of that commit (later doc/test edits cannot change the locked evaluator bytes) |
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

### Holdout isolation

`holdout-v1` (implementer-authored, consumed once by `abc-real-1`) was not loaded, graded or used: `A/datasets.json` has
`holdout: []` and `holdoutSeal: null`, every ledger record is `train` or `dev`, `datasets/holdout-v1/USES.jsonl` is unchanged, and
no holdout task id appears in any optimizer evidence (`candidates/*/optimizer-evidence/`, train failures and dev aggregates only).

## Baselines (A; descriptive)

| Arm | Train success | Dev success (exact) | Dev 95% interval | Dev runs with integrity violations | Dev model requests / input tokens | Attempts per dev unit (allowed / actual) |
|---|---:|---:|---|---:|---:|---|
| stable orche (single) | 20/33 (60.61%) | 39/48 = 81.25% | [63.1, 93.9] | 7 | 889 / 7.50 M | 1 / 1.00 |
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
`eval-loop/stable` does not exist in orche or the umbrella.

## Limitations and what would change the result

- The strict integrity rule rejects a candidate for a single task-agent edit of an existing test file. At the stable rate (~10–15%
  of runs) a candidate is very unlikely to have zero violations in 18 screening runs unless it reduces such edits. This run shows
  the rule binding; it does not show whether a harness change can reduce the edits.
- The search kept proposing one hypothesis family because the target choice is the most frequent train failure class and the
  duplicate guard is lexical. A new protocol version that targets the class responsible for the rejections, or uses a semantic
  duplicate guard, would be a different search. It must be pre-registered before it runs.
- Train/dev tasks are exposed suite tasks. Development figures are descriptive. No holdout claim and no deployment are possible
  until an externally curated, unexposed holdout is added in a new protocol version.
