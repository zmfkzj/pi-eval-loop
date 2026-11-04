# pi-eval-loop report

Generated 2026-11-04T14:05:15.493Z. State: `/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/explore-real-2/A`. Phase **done**, cycle 1, strategy `pareto`.

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
| multi3 | dev | 48 | 44/48 (91.67%) | 91.67% [78.4%, 98.5%] | 88.89% [64.2%, 99.3%] | 86.11% [70.0%, 97.5%] | completed:48 | 2 | 2 | 1456402/76098 | 2277 |
| pure | train | 33 | 22/33 (66.67%) | 66.67% [40.7%, 87.9%] | 40.00% [10.7%, 74.6%] | 58.59% [33.4%, 84.5%] | completed:33 | 2 | 2 | 1142298/62904 | 1706 |
| pure | dev | 48 | 42/48 (87.50%) | 87.50% [71.0%, 97.0%] | 77.78% [46.9%, 96.4%] | 80.56% [62.3%, 95.2%] | completed:48 | 2 | 2 | 1526956/77023 | 2326 |
| stable | train | 33 | 20/33 (60.61%) | 60.61% [32.2%, 85.5%] | 13.33% [0.3%, 45.8%] | 58.59% [30.6%, 84.7%] | agent_error:2 completed:31 | 4 | 4 | 10376660/231223 | 6782 |
| stable | dev | 48 | 39/48 (81.25%) | 81.25% [62.8%, 93.8%] | 55.56% [26.2%, 82.7%] | 72.92% [53.6%, 91.0%] | completed:48 | 7 | 7 | 7502081/172695 | 5029 |

Tokens and wall time are recorded and never used by any gate.

### Measured execution opportunities

| arm | split | allowed attempts/unit | actual attempts/unit | model requests/unit | input tokens/unit | requests vs stable | input tokens vs stable |
|---|---|---:|---:|---:|---:|---:|---:|
| multi3 | dev | 3 | 1.02 | 9.3 | 30342 | 0.50 | 0.19 |
| pure | train | 1 | 1.00 | 8.9 | 34615 | 0.27 | 0.11 |
| pure | dev | 1 | 1.00 | 9.5 | 31812 | 0.51 | 0.20 |
| stable | train | 1 | 1.00 | 33.0 | 314444 | 1.00 | 1.00 |
| stable | dev | 1 | 1.00 | 18.5 | 156293 | 1.00 | 1.00 |

A k-attempt arm stops at the first attempt whose visible tests pass, so its allowed attempts are an upper bound; only the actual attempts, requests and tokens describe the compute it used. No arm is labelled compute- or opportunity-matched unless these ratios are close to 1.

## Pareto front (development: Q_overall, Q_hard, Q_consistency)

- stable: overall 81.3%, hard 55.6%, consistency 72.9%

## Search, selection, holdout and adoption

- search stop: –; candidates this cycle: 0; consecutive no-progress: 0
- selection: none
- **deployment verdict: BLOCKED**
  - exploration outcome (separate from deployment): no candidate selected (none)
  - exploration-only protocol (datasets.holdout = null): no unconsumed independent holdout is available, so no candidate can be validated or deployed; a development selection is not evidence of improvement
  - exploration-only protocol: no holdout was loaded, graded or consumed in this state directory

## Resource usage (recorded only)

Optimizer (proposer) requests 0, tokens in/out 0/0. Evaluated runs: 210 (all attempts: 210).

## Integrity of the records

runs ledger chain: intact; events ledger: intact.

## Limitations

- Bootstrap support is a posterior-predictive fraction under a Dirichlet model of THESE tasks and runs; it is not a probability of real-world generalization, and few runs remain few observations.
- Screening support at level `execution` ignores task-sampling uncertainty (as in ParetoSaddler); development and adoption use task-level resampling.
- Hard/medium/easy tiers of the suite tasks are a pre-registered prefix rule (a=easy, b/c=medium, d/p=hard), not a measured difficulty.
- Suite tasks are exposed (used by earlier orche experiments): they are train/dev only and never an independent holdout.
