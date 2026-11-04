# pi-eval-loop report

Generated 2026-11-04T09:39:22.557Z. State: `/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/abc-real-1/B`. Phase **done**, cycle 1, strategy `greedy`.

Protocol `pi-eval-loop/protocol-1` digest `92a0876827652812`, locked 2026-11-04T05:17:24.495Z; seed `pi-eval-loop-2026-11-04`; agent route `cliproxyapi/gpt-6-luna` effort `medium` (all arms); bootstrap 10000 draws; screening support ≥ 0.8 (level execution), adoption support ≥ 0.95 (level task); exploratory overall loss allowance 0.03.

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

train 11 · dev 16 · holdout 7 tasks (family-disjoint). Excluded by grader validation: none.

- **train**: a7-auth-rotation (easy, pkg:invoice-sync), b1-static-traversal (medium, pkg:minihttp), b2-patch-endpoint (medium, pkg:minihttp), b3-pagination (medium, pkg:minihttp), b5-ctx-migration (medium, pkg:minihttp), b6-route-cache (medium, pkg:minihttp), d4-cache-fencing (hard, pkg:d4-cache-fencing), d5-streaming-ingest-ko (hard, pkg:d5-streaming-ingest-ko), p1-ticket-batch (hard, p-series), p2-handler-migration (hard, p-series), p3-library-features-ko (hard, p-series)
- **dev**: a1-rounding (easy, pkg:ledger), a2-discount-codes (easy, pkg:ledger), a3-refactor-tax (easy, pkg:ledger), a4-tests-fx (easy, pkg:ledger), a6-typo-message (easy, pkg:ledger), c1-timezone (medium, pkg:logtool), c2-since-flag-ko (medium, pkg:logtool), c4-malformed-lines (medium, pkg:logtool), c5-aggregate-perf (medium, pkg:logtool), c6-csv-export (medium, pkg:logtool), d1-transactional-outbox (hard, pkg:d1-transactional-outbox), d2-keyed-queue (hard, pkg:d2-keyed-queue), d3-money-migration-ko (hard, pkg:d3-money-migration-ko), d6-snapshot-pagination (hard, pkg:d6-snapshot-pagination), d7-config-reload (hard, pkg:d7-config-reload), d8-build-graph (hard, pkg:d8-build-graph)
- **holdout**: h1-interval-merge (medium, intervals), h2-csv-parse (hard, csv-parser), h3-retry-backoff (medium, retry), h4-semver-range (hard, semver), h5-lru-ttl (hard, cache), h6-markdown-toc (medium, markdown), h7-money-allocate (easy, money)

## Arms (posterior means with 95% task-level Bayesian-bootstrap intervals; descriptive)

| arm | split | runs | success | Q_overall | Q_hard | Q_consistency (pass^2) | terminal | critical | in/out tokens | wall s |
|---|---|---:|---:|---|---|---|---|---:|---|---:|
| B-c001 | train | 33 | 24/33 | 72.5% [45.3%, 92.0%] | 39.5% [9.0%, 76.2%] | 69.5% [41.2%, 90.6%] | agent_error:1 completed:32 | 3 | 14056696/249872 | 7381 |
| B-c001 | dev | 48 | 37/48 | 77.2% [57.8%, 91.1%] | 66.8% [34.0%, 91.8%] | 69.9% [48.2%, 87.1%] | completed:48 | 9 | 10050886/200322 | 6977 |
| B-c002 | train | 36 | 19/36 | 52.4% [21.3%, 82.5%] | 16.5% [1.7%, 44.2%] | 44.1% [14.0%, 78.3%] | agent_error:1 completed:35 | 11 | 13513110/270472 | 8127 |
| B-c003 | train | 18 | 4/18 | 22.2% [3.5%, 53.2%] | 13.4% [0.8%, 41.7%] | 13.8% [0.9%, 42.3%] | completed:17 timeout:1 | 5 | 8284930/179834 | 5313 |
| multi3 | dev | 48 | 46/48 | 95.9% [85.1%, 99.8%] | 94.5% [74.1%, 100.0%] | 93.8% [80.0%, 99.6%] | completed:48 | 1 | 1417929/76888 | 2322 |
| pure | train | 33 | 21/33 | 63.6% [35.5%, 86.6%] | 26.5% [2.9%, 65.6%] | 60.6% [32.3%, 85.2%] | completed:33 | 2 | 1200234/63120 | 1814 |
| pure | dev | 48 | 43/48 | 89.5% [74.7%, 97.9%] | 83.3% [53.1%, 98.5%] | 85.3% [67.0%, 96.7%] | completed:48 | 3 | 1358249/73863 | 2249 |
| stable | train | 51 | 28/51 | 56.0% [28.0%, 82.1%] | 3.2% [0.0%, 15.4%] | 54.9% [26.8%, 81.3%] | completed:49 timeout:2 | 10 | 13145973/298100 | 10110 |
| stable | dev | 48 | 37/48 | 77.0% [56.9%, 92.0%] | 50.1% [19.9%, 79.9%] | 71.8% [49.7%, 89.2%] | completed:48 | 5 | 8000848/180933 | 5469 |

Tokens and wall time are recorded and never used by any gate.

## Candidates (every attempt is kept)

| id | parent | target | status | hypothesis | files | screening support (exec / task) | dev Q_overall | dev vs stable P(loss>eps) |
|---|---|---|---|---|---|---|---|---|
| B-c001 | stable | requirements-generalization | dev_rejected | Requiring implementation workers to audit every behavioral clause against request-derived checks before completion should expose omissions t | src/extension/workers.ts | 1.000 / 1.000 @3r | 77.1% | 0.385 |
| B-c002 | stable | requirements-generalization | rejected | Requiring implementation workers to review every original requirement against code and focused checks before completion should catch omitted | src/extension/workers.ts | 0.760 / 0.715 @3r | – | – |
| B-c003 | stable | requirements-generalization | rejected | Requiring implementation workers to derive a clause-by-clause acceptance checklist from the original request and reconcile it with behaviora | src/extension/workers.ts | 0.610 / 0.663 @3r | – | – |
| B-c004 | stable | termination-timeout | screening | Requiring bounded, one-shot bash verification and diagnosis before retrying timed-out checks should prevent hanging checks and unchanged ret | src/tools/bash.ts | – | – | – |

Decision trail per candidate: `/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/abc-real-1/B/candidates/<id>/candidate.json` (decisions[]), patch: `patch.diff`, optimizer evidence: `evidence/`.

## Pareto front (development: Q_overall, Q_hard, Q_consistency)

- stable: overall 77.2%, hard 50.4%, consistency 71.9%

## Search, selection, holdout and adoption

- search stop: candidate cap of 4 per cycle reached (safety limit); candidates this cycle: 4; consecutive no-progress: 3
- selection: none (no development-qualified candidate without family regression)
- **verdict: KEEP_STABLE**
  - no development-qualified candidate without family regression

## Resource usage (recorded only)

Optimizer (proposer) requests 43, tokens in/out 1655114/7935. Evaluated runs: 363 (all attempts: 363).

## Integrity of the records

runs ledger chain: intact; events ledger: intact.

## Limitations

- Bootstrap support is a posterior-predictive fraction under a Dirichlet model of THESE tasks and runs; it is not a probability of real-world generalization, and few runs remain few observations.
- Screening support at level `execution` ignores task-sampling uncertainty (as in ParetoSaddler); development and adoption use task-level resampling.
- Hard/medium/easy tiers of the suite tasks are a pre-registered prefix rule (a=easy, b/c=medium, d/p=hard), not a measured difficulty.
- Suite tasks are exposed (used by earlier orche experiments): they are train/dev only and never an independent holdout.
