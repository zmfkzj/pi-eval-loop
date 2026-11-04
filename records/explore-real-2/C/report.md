# pi-eval-loop report

Generated 2026-11-04T14:05:16.230Z. State: `/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/explore-real-2/C`. Phase **done**, cycle 1, strategy `pareto`.

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
| C-c001 | train | 18 | 10/18 (55.56%) | 55.56% [22.3%, 86.4%] | 22.22% [0.7%, 68.2%] | 48.15% [17.2%, 83.3%] | completed:17 timeout:1 | 4 | 4 | 8144235/152037 | 4577 |
| C-c002 | train | 18 | 10/18 (55.56%) | 55.56% [19.9%, 88.0%] | 0.00% [0.0%, 0.0%] | 51.85% [17.3%, 86.6%] | completed:18 | 2 | 2 | 5583990/114329 | 2809 |
| C-c003 | train | 18 | 13/18 (72.22%) | 72.22% [35.6%, 96.0%] | 16.67% [0.2%, 62.5%] | 68.52% [31.7%, 95.3%] | completed:18 | 2 | 2 | 3453000/78862 | 2435 |
| C-c004 | train | 18 | 10/18 (55.56%) | 55.56% [19.7%, 87.9%] | 11.11% [0.1%, 47.0%] | 51.85% [17.3%, 86.4%] | completed:18 | 2 | 2 | 5923804/126794 | 3391 |
| C-c005 | train | 18 | 11/18 (61.11%) | 61.11% [26.5%, 89.7%] | 16.67% [0.2%, 60.7%] | 53.70% [20.1%, 87.4%] | completed:18 | 1 | 1 | 7262484/133903 | 3644 |
| C-c006 | train | 18 | 14/18 (77.78%) | 77.78% [43.1%, 97.8%] | 33.33% [1.2%, 83.7%] | 74.07% [38.5%, 97.1%] | completed:18 | 1 | 1 | 5316325/103578 | 2969 |
| C-c007 | train | 18 | 9/18 (50.00%) | 50.00% [18.5%, 81.9%] | 22.22% [1.9%, 60.8%] | 38.89% [11.4%, 76.9%] | completed:18 | 4 | 4 | 5053578/102782 | 2897 |
| C-c008 | train | 18 | 11/18 (61.11%) | 61.11% [28.4%, 88.7%] | 16.67% [0.2%, 60.8%] | 50.00% [19.8%, 84.4%] | completed:18 | 3 | 3 | 6554127/118285 | 4133 |
| C-c009 | train | 18 | 9/18 (50.00%) | 50.00% [17.4%, 82.8%] | 22.22% [0.6%, 67.6%] | 42.59% [12.6%, 79.3%] | completed:18 | 5 | 5 | 7551790/137589 | 3593 |
| C-c010 | train | 18 | 11/18 (61.11%) | 61.11% [24.6%, 91.0%] | 0.00% [0.0%, 0.0%] | 57.41% [21.9%, 89.7%] | completed:18 | 1 | 1 | 7167363/136243 | 3287 |
| multi3 | dev | 48 | 44/48 (91.67%) | 91.67% [78.4%, 98.5%] | 88.89% [64.2%, 99.3%] | 86.11% [70.0%, 97.5%] | completed:48 | 2 | 2 | 1456402/76098 | 2277 |
| pure | train | 33 | 22/33 (66.67%) | 66.67% [40.7%, 87.9%] | 40.00% [10.7%, 74.6%] | 58.59% [33.4%, 84.5%] | completed:33 | 2 | 2 | 1142298/62904 | 1706 |
| pure | dev | 48 | 42/48 (87.50%) | 87.50% [71.0%, 97.0%] | 77.78% [46.9%, 96.4%] | 80.56% [62.3%, 95.2%] | completed:48 | 2 | 2 | 1526956/77023 | 2326 |
| stable | train | 33 | 20/33 (60.61%) | 60.61% [32.2%, 85.5%] | 13.33% [0.3%, 45.8%] | 58.59% [30.6%, 84.7%] | agent_error:2 completed:31 | 4 | 4 | 10376660/231223 | 6782 |
| stable | dev | 48 | 39/48 (81.25%) | 81.25% [62.8%, 93.8%] | 55.56% [26.2%, 82.7%] | 72.92% [53.6%, 91.0%] | completed:48 | 7 | 7 | 7502081/172695 | 5029 |

Tokens and wall time are recorded and never used by any gate.

### Measured execution opportunities

| arm | split | allowed attempts/unit | actual attempts/unit | model requests/unit | input tokens/unit | requests vs stable | input tokens vs stable |
|---|---|---:|---:|---:|---:|---:|---:|
| C-c001 | train | 1 | 1.00 | 35.9 | 452458 | 0.59 | 0.78 |
| C-c002 | train | 1 | 1.00 | 28.1 | 310222 | 0.46 | 0.54 |
| C-c003 | train | 1 | 1.00 | 21.7 | 191833 | 0.36 | 0.33 |
| C-c004 | train | 1 | 1.00 | 26.4 | 329100 | 0.44 | 0.57 |
| C-c005 | train | 1 | 1.00 | 34.4 | 403471 | 0.57 | 0.70 |
| C-c006 | train | 1 | 1.00 | 25.9 | 295351 | 0.43 | 0.51 |
| C-c007 | train | 1 | 1.00 | 24.3 | 280754 | 0.40 | 0.49 |
| C-c008 | train | 1 | 1.00 | 32.4 | 364118 | 0.54 | 0.63 |
| C-c009 | train | 1 | 1.00 | 37.6 | 419544 | 0.62 | 0.73 |
| C-c010 | train | 1 | 1.00 | 35.8 | 398187 | 0.59 | 0.69 |
| multi3 | dev | 3 | 1.02 | 9.3 | 30342 | 0.50 | 0.19 |
| pure | train | 1 | 1.00 | 8.9 | 34615 | 0.27 | 0.11 |
| pure | dev | 1 | 1.00 | 9.5 | 31812 | 0.51 | 0.20 |
| stable | train | 1 | 1.00 | 33.0 | 314444 | 1.00 | 1.00 |
| stable | dev | 1 | 1.00 | 18.5 | 156293 | 1.00 | 1.00 |

A k-attempt arm stops at the first attempt whose visible tests pass, so its allowed attempts are an upper bound; only the actual attempts, requests and tokens describe the compute it used. No arm is labelled compute- or opportunity-matched unless these ratios are close to 1.

## Candidates (every attempt is kept)

| id | parent | target | status | hypothesis | files | screening support (exec / task) | dev Q_overall | dev vs stable P(loss>eps) |
|---|---|---|---|---|---|---|---|---|
| C-c001 | stable | requirements-generalization | rejected | Requiring implementation workers to audit every original behavioral clause against concrete assertions before completion should expose omitt | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| C-c002 | stable | requirements-generalization | rejected | Requiring implementation workers to map every stated requirement to code and a passing behavioral assertion before completion should expose  | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| C-c003 | stable | requirements-generalization | rejected | Requiring implementation workers to derive behavioral checks from every requested clause before completion should expose omitted boundaries  | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| C-c004 | stable | requirements-generalization | rejected | Requiring implementation workers to reconcile every original-request clause with code and request-derived behavioral checks before completio | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| C-c005 | stable | requirements-generalization | rejected | Requiring implementers to map each original requirement clause to implementation and behavioral evidence before completion should expose con | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| C-c006 | stable | requirements-generalization | rejected | Requiring implementation workers to audit every requested behavioral clause against implementation and request-derived checks before complet | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| C-c007 | stable | requirements-generalization | rejected | Requiring implementation workers to audit every original requirement clause against code and executed assertions before completion should ex | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| C-c008 | stable | requirements-generalization | rejected | Requiring implementation workers to check every requested behavior against request-derived executable checks before completion should expose | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| C-c009 | stable | requirements-generalization | rejected | Requiring implementation workers to audit every requested behavioral clause against code and request-derived executed assertions before comp | src/extension/workers.ts | rejected before statistics (critical) | – | – |
| C-c010 | stable | requirements-generalization | rejected | Requiring implementation workers to derive checks from every behavioral clause of the original request and close boundary and rule-interacti | src/orchestration/prompts.ts | rejected before statistics (critical) | – | – |

Decision trail per candidate: `/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/explore-real-2/C/candidates/<id>/candidate.json` (decisions[]), patch: `patch.diff`, optimizer evidence: `evidence/`.

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

Optimizer (proposer) requests 120, tokens in/out 5246383/23258. Evaluated runs: 390 (all attempts: 390).

## Integrity of the records

runs ledger chain: intact; events ledger: intact.

## Limitations

- Bootstrap support is a posterior-predictive fraction under a Dirichlet model of THESE tasks and runs; it is not a probability of real-world generalization, and few runs remain few observations.
- Screening support at level `execution` ignores task-sampling uncertainty (as in ParetoSaddler); development and adoption use task-level resampling.
- Hard/medium/easy tiers of the suite tasks are a pre-registered prefix rule (a=easy, b/c=medium, d/p=hard), not a measured difficulty.
- Suite tasks are exposed (used by earlier orche experiments): they are train/dev only and never an independent holdout.
