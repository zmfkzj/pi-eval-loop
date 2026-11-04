# pi-eval-loop report

Generated 2026-11-04T14:05:15.864Z. State: `/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/explore-real-2/B`. Phase **done**, cycle 1, strategy `greedy`.

Protocol `pi-eval-loop/protocol-2` digest `393f3019e86013bf`, locked 2026-11-04T10:01:21.116Z; seed `pi-eval-loop-2026-11-04`; agent route `cliproxyapi/gpt-6-luna` effort `medium` (all arms); bootstrap 10000 draws; screening support ≥ 0.8 (level execution), adoption support ≥ 0.95 (level task); exploratory overall loss allowance 0.03.

## Prerequisites

| check | ok | detail |
|---|---|---|
| bwrap | yes | bubblewrap 0.11.1 |
| bwrap-namespaces | yes | user/net/pid namespaces usable |
| pi-cli | yes | /home/arthur/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js |
| provider | yes | /home/arthur/Code/oh-my-pi-extensions/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider |
| orche | yes | /home/arthur/Code/oh-my-pi-extensions/orche |
| git | yes | git version 2.53.0 |
| credentials | yes | cliproxyapi.json apiKey: set |
| model-catalog | yes | /home/arthur/.pi/agent/cliproxyapi-models.json |
| upstream | yes | http://127.0.0.1:8317 answered 401 |

## Datasets

train 11 · dev 16 · holdout 0 tasks (family-disjoint). Excluded by grader validation: none.

- **train**: a7-auth-rotation (easy, pkg:invoice-sync), b1-static-traversal (medium, pkg:minihttp), b2-patch-endpoint (medium, pkg:minihttp), b3-pagination (medium, pkg:minihttp), b5-ctx-migration (medium, pkg:minihttp), b6-route-cache (medium, pkg:minihttp), d4-cache-fencing (hard, pkg:d4-cache-fencing), d5-streaming-ingest-ko (hard, pkg:d5-streaming-ingest-ko), p1-ticket-batch (hard, p-series), p2-handler-migration (hard, p-series), p3-library-features-ko (hard, p-series)
- **dev**: a1-rounding (easy, pkg:ledger), a2-discount-codes (easy, pkg:ledger), a3-refactor-tax (easy, pkg:ledger), a4-tests-fx (easy, pkg:ledger), a6-typo-message (easy, pkg:ledger), c1-timezone (medium, pkg:logtool), c2-since-flag-ko (medium, pkg:logtool), c4-malformed-lines (medium, pkg:logtool), c5-aggregate-perf (medium, pkg:logtool), c6-csv-export (medium, pkg:logtool), d1-transactional-outbox (hard, pkg:d1-transactional-outbox), d2-keyed-queue (hard, pkg:d2-keyed-queue), d3-money-migration-ko (hard, pkg:d3-money-migration-ko), d6-snapshot-pagination (hard, pkg:d6-snapshot-pagination), d7-config-reload (hard, pkg:d7-config-reload), d8-build-graph (hard, pkg:d8-build-graph)
- **holdout**: none

## Arms (exact plug-in points with 95% task-level Bayesian-bootstrap intervals; descriptive)

| arm | split | runs | success | Q_overall | Q_hard | Q_consistency (pass^2) | terminal | runs with integrity violations | critical | in/out tokens | wall s |
|---|---|---:|---:|---|---|---|---|---:|---:|---|---:|
| B-c001 | train | 18 | 13/18 (72.22%) | 72.22% [39.9%, 94.4%] | 33.33% [4.3%, 75.4%] | 61.11% [28.9%, 91.7%] | completed:18 | 3 | 3 | 4019887/79797 | 2404 |
| B-c002 | train | 18 | 10/18 (55.56%) | 55.56% [20.1%, 88.0%] | 11.11% [0.1%, 46.3%] | 51.85% [17.3%, 86.8%] | completed:18 | 5 | 5 | 6375810/127621 | 3336 |
| B-c003 | train | 18 | 6/18 (33.33%) | 33.33% [10.0%, 62.0%] | 26.67% [5.9%, 56.4%] | 14.81% [2.7%, 48.3%] | completed:18 | 6 | 6 | 10507301/191268 | 4709 |
| B-c004 | train | 18 | 10/18 (55.56%) | 55.56% [23.0%, 85.4%] | 22.22% [1.8%, 60.0%] | 44.44% [15.2%, 80.8%] | completed:18 | 3 | 3 | 7924005/139383 | 3715 |
| B-c005 | train | 18 | 11/18 (61.11%) | 61.11% [28.0%, 88.5%] | 16.67% [0.2%, 61.5%] | 50.00% [19.8%, 84.4%] | completed:18 | 4 | 4 | 5186317/111326 | 2714 |
| B-c006 | train | 18 | 9/18 (50.00%) | 50.00% [17.1%, 83.0%] | 11.11% [0.1%, 45.0%] | 42.59% [12.5%, 79.7%] | completed:18 | 2 | 2 | 7003820/153859 | 3402 |
| B-c007 | train | 18 | 9/18 (50.00%) | 50.00% [14.6%, 85.4%] | 0.00% [0.0%, 0.0%] | 50.00% [14.6%, 85.4%] | completed:18 | 3 | 3 | 6259599/150974 | 3299 |
| B-c008 | train | 18 | 12/18 (66.67%) | 66.67% [30.9%, 93.2%] | 16.67% [0.2%, 61.6%] | 59.26% [24.7%, 91.2%] | completed:18 | 4 | 4 | 4726116/99199 | 2778 |
| B-c009 | train | 18 | 12/18 (66.67%) | 66.67% [28.6%, 94.4%] | 0.00% [0.0%, 0.0%] | 66.67% [28.6%, 94.4%] | completed:18 | 4 | 4 | 6941429/125904 | 3452 |
| B-c010 | train | 18 | 9/18 (50.00%) | 50.00% [17.0%, 82.9%] | 25.00% [2.7%, 63.1%] | 42.59% [12.4%, 79.5%] | completed:18 | 2 | 2 | 8407019/173294 | 4189 |
| multi3 | dev | 48 | 44/48 (91.67%) | 91.67% [78.4%, 98.5%] | 88.89% [64.2%, 99.3%] | 86.11% [70.0%, 97.5%] | completed:48 | 2 | 2 | 1456402/76098 | 2277 |
| pure | train | 33 | 22/33 (66.67%) | 66.67% [40.7%, 87.9%] | 40.00% [10.7%, 74.6%] | 58.59% [33.4%, 84.5%] | completed:33 | 2 | 2 | 1142298/62904 | 1706 |
| pure | dev | 48 | 42/48 (87.50%) | 87.50% [71.0%, 97.0%] | 77.78% [46.9%, 96.4%] | 80.56% [62.3%, 95.2%] | completed:48 | 2 | 2 | 1526956/77023 | 2326 |
| stable | train | 33 | 20/33 (60.61%) | 60.61% [32.2%, 85.5%] | 13.33% [0.3%, 45.8%] | 58.59% [30.6%, 84.7%] | agent_error:2 completed:31 | 4 | 4 | 10376660/231223 | 6782 |
| stable | dev | 48 | 39/48 (81.25%) | 81.25% [62.8%, 93.8%] | 55.56% [26.2%, 82.7%] | 72.92% [53.6%, 91.0%] | completed:48 | 7 | 7 | 7502081/172695 | 5029 |

Tokens and wall time are recorded and never used by any gate.

### Measured execution opportunities

| arm | split | allowed attempts/unit | actual attempts/unit | model requests/unit | input tokens/unit | requests vs stable | input tokens vs stable |
|---|---|---:|---:|---:|---:|---:|---:|
| B-c001 | train | 1 | 1.00 | 22.4 | 223327 | 0.37 | 0.39 |
| B-c002 | train | 1 | 1.00 | 34.1 | 354212 | 0.56 | 0.61 |
| B-c003 | train | 1 | 1.00 | 38.9 | 583739 | 0.64 | 1.01 |
| B-c004 | train | 1 | 1.00 | 36.3 | 440223 | 0.60 | 0.76 |
| B-c005 | train | 1 | 1.00 | 31.1 | 288129 | 0.51 | 0.50 |
| B-c006 | train | 1 | 1.00 | 36.9 | 389101 | 0.61 | 0.67 |
| B-c007 | train | 1 | 1.00 | 32.3 | 347756 | 0.53 | 0.60 |
| B-c008 | train | 1 | 1.00 | 25.1 | 262562 | 0.41 | 0.46 |
| B-c009 | train | 1 | 1.00 | 31.9 | 385635 | 0.53 | 0.67 |
| B-c010 | train | 1 | 1.00 | 41.6 | 467057 | 0.69 | 0.81 |
| multi3 | dev | 3 | 1.02 | 9.3 | 30342 | 0.50 | 0.19 |
| pure | train | 1 | 1.00 | 8.9 | 34615 | 0.27 | 0.11 |
| pure | dev | 1 | 1.00 | 9.5 | 31812 | 0.51 | 0.20 |
| stable | train | 1 | 1.00 | 33.0 | 314444 | 1.00 | 1.00 |
| stable | dev | 1 | 1.00 | 18.5 | 156293 | 1.00 | 1.00 |

A k-attempt arm stops at the first attempt whose visible tests pass, so its allowed attempts are an upper bound; only the actual attempts, requests and tokens describe the compute it used. No arm is labelled compute- or opportunity-matched unless these ratios are close to 1.

## Candidates (every attempt is kept)

| id | parent | target | status | hypothesis | files | screening support (exec / task) | dev Q_overall | dev vs stable P(loss>eps) |
|---|---|---|---|---|---|---|---|---|
| B-c001 | stable | requirements-generalization | rejected | Requiring implementation workers to audit every original behavioral clause against concrete assertions before completion should expose omitt | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| B-c002 | stable | requirements-generalization | rejected | Requiring implementation workers to audit each original acceptance criterion and execute request-derived checks for uncovered behavior befor | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| B-c003 | stable | requirements-generalization | rejected | Requiring implementation workers to audit every original requirement against code and request-derived assertions before completion should ca | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| B-c004 | stable | requirements-generalization | rejected | Requiring implementation workers to audit every request clause against code and passing behavioral assertions before completion should catch | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| B-c005 | stable | requirements-generalization | rejected | Requiring implementation workers to review the original request clause by clause and execute checks for uncovered obligations before complet | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| B-c006 | stable | requirements-generalization | rejected | Requiring implementation workers to audit the original request clause by clause and exercise uncovered contract behavior before completion s | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| B-c007 | stable | requirements-generalization | rejected | Requiring implementation workers to audit each original acceptance criterion and run requirement-derived checks before declaring completion  | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| B-c008 | stable | requirements-generalization | rejected | Requiring implementation workers to audit each original requirement against enforcing code and focused checks before completion should catch | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| B-c009 | stable | requirements-generalization | rejected | Requiring implementers to audit every request clause against code and requirement-derived behavioral checks before completion should expose  | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| B-c010 | stable | requirements-generalization | rejected | Requiring implementation workers to audit every original-request behavioral clause and exercise uncovered clauses before completion should p | src/extension/workers.ts | rejected before statistics (critical) | – | – |

Decision trail per candidate: `/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/explore-real-2/B/candidates/<id>/candidate.json` (decisions[]), patch: `patch.diff`, optimizer evidence: `evidence/`.

## Pareto front (development: Q_overall, Q_hard, Q_consistency)

- stable: overall 81.3%, hard 55.6%, consistency 72.9%

## Search, selection, holdout and adoption

- search stop: no meaningful progress in 10 consecutive candidates; candidates this cycle: 10; consecutive no-progress: 10
- failed targeted proposals per failure class: requirements-generalization 10
- selection: none (no development-qualified, critical-clean candidate without family regression)
- **deployment verdict: BLOCKED**
  - exploration outcome (separate from deployment): no candidate selected (no development-qualified, critical-clean candidate without family regression)
  - exploration-only protocol (datasets.holdout = null): no unconsumed independent holdout is available, so no candidate can be validated or deployed; a development selection is not evidence of improvement
  - exploration-only protocol: no holdout was loaded, graded or consumed in this state directory

## Resource usage (recorded only)

Optimizer (proposer) requests 129, tokens in/out 5050974/22727. Evaluated runs: 390 (all attempts: 390).

## Integrity of the records

runs ledger chain: intact; events ledger: intact.

## Limitations

- Bootstrap support is a posterior-predictive fraction under a Dirichlet model of THESE tasks and runs; it is not a probability of real-world generalization, and few runs remain few observations.
- Screening support at level `execution` ignores task-sampling uncertainty (as in ParetoSaddler); development and adoption use task-level resampling.
- Hard/medium/easy tiers of the suite tasks are a pre-registered prefix rule (a=easy, b/c=medium, d/p=hard), not a measured difficulty.
- Suite tasks are exposed (used by earlier orche experiments): they are train/dev only and never an independent holdout.
