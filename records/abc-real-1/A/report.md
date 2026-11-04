# pi-eval-loop report

Generated 2026-11-04T09:39:22.237Z. State: `/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/abc-real-1/A`. Phase **done**, cycle 1, strategy `pareto`.

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
| C-c001 | holdout | 21 | 13/21 | 61.6% [27.9%, 89.8%] | 11.2% [0.1%, 45.9%] | 59.1% [24.9%, 88.8%] | completed:21 | 8 | 2666400/73192 | 2280 |
| multi3 | dev | 48 | 46/48 | 95.9% [85.1%, 99.8%] | 94.5% [74.1%, 100.0%] | 93.8% [80.0%, 99.6%] | completed:48 | 1 | 1417929/76888 | 2322 |
| pure | train | 33 | 21/33 | 63.6% [35.5%, 86.6%] | 26.5% [2.9%, 65.6%] | 60.6% [32.3%, 85.2%] | completed:33 | 2 | 1200234/63120 | 1814 |
| pure | dev | 48 | 43/48 | 89.5% [74.7%, 97.9%] | 83.3% [53.1%, 98.5%] | 85.3% [67.0%, 96.7%] | completed:48 | 3 | 1358249/73863 | 2249 |
| stable | train | 33 | 18/33 | 54.8% [26.4%, 81.6%] | 0.0% [0.0%, 0.0%] | 54.8% [26.4%, 81.6%] | completed:32 timeout:1 | 6 | 8539186/190571 | 5993 |
| stable | dev | 48 | 37/48 | 77.0% [56.9%, 92.0%] | 50.1% [19.9%, 79.9%] | 71.8% [49.7%, 89.2%] | completed:48 | 5 | 8000848/180933 | 5469 |
| stable | holdout | 21 | 15/21 | 71.6% [39.5%, 94.1%] | 33.2% [4.4%, 76.2%] | 66.8% [33.3%, 92.4%] | completed:21 | 4 | 2511623/72806 | 2256 |

Tokens and wall time are recorded and never used by any gate.

## Candidates (every attempt is kept)

| id | parent | target | status | hypothesis | files | screening support (exec / task) | dev Q_overall | dev vs stable P(loss>eps) |
|---|---|---|---|---|---|---|---|---|
| C-c001 | stable | requirements-generalization | holdout_blocked | Requiring implementers to audit every original-request clause against implementation and passing behavioral checks before completion should  | src/extension/workers.ts | 1.000 / 1.000 @3r | 79.1% | 0.277 |

Decision trail per candidate: `/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/abc-real-1/A/candidates/<id>/candidate.json` (decisions[]), patch: `patch.diff`, optimizer evidence: `evidence/`.

## Pareto front (development: Q_overall, Q_hard, Q_consistency)

- C-c001: overall 79.1%, hard 72.0%, consistency 72.9%

## Search, selection, holdout and adoption

- search stop: –; candidates this cycle: 0; consecutive no-progress: 0
- selection: C-c001
- **verdict: BLOCKED** for C-c001
  - no independent holdout: provenance not accepted for independent claims: h1-interval-merge=implementer-authored-sealed-before-search, h2-csv-parse=implementer-authored-sealed-before-search, h3-retry-backoff=implementer-authored-sealed-before-search, h4-semver-range=implementer-authored-sealed-before-search, h5-lru-ttl=implementer-authored-sealed-before-search, h6-markdown-toc=implementer-authored-sealed-before-search, h7-money-allocate=implementer-authored-sealed-before-search
  - critical failures: integrity: 8 run(s) with workspace integrity violations vs 4 for stable (h2-csv-parse#2: changed/removed 1 line(s) of test file test/csv.test.js: "test(\"simple rows\", () => {"; h2-csv-parse#0: changed/removed 1 line(s) of test file test/csv.test.js: "test(\"simple rows\", () => {"; h4-semver-range#2: changed/removed 1 line(s) of test file test/semver.test.js: "test(\"exact versions\", () => {")
  - relevant test/typecheck suite not passing in the candidate: candidate passed fewer tests (3006 < 3007); tests failing only with the candidate: test/extension/task.test.ts > orche_task persistent session workers > keeps the omitted-mode SDK implement instruction byte-identical to HEAD
  - holdout independence at first use: NO (provenance not accepted for independent claims: h1-interval-merge=implementer-authored-sealed-before-search, h2-csv-parse=implementer-authored-sealed-before-search, h3-retry-backoff=implementer-authored-sealed-before-search, h4-semver-range=implementer-authored-sealed-before-search, h5-lru-ttl=implementer-authored-sealed-before-search, h6-markdown-toc=implementer-authored-sealed-before-search, h7-money-allocate=implementer-authored-sealed-before-search)
  - holdout overall delta -0.095 [-0.367, 0.088], adoption support 0.135 over 7 tasks / 7 families

## Resource usage (recorded only)

Optimizer (proposer) requests 12, tokens in/out 296412/2275. Evaluated runs: 252 (all attempts: 252).

## Integrity of the records

runs ledger chain: intact; events ledger: intact.

## Limitations

- Bootstrap support is a posterior-predictive fraction under a Dirichlet model of THESE tasks and runs; it is not a probability of real-world generalization, and few runs remain few observations.
- Screening support at level `execution` ignores task-sampling uncertainty (as in ParetoSaddler); development and adoption use task-level resampling.
- Hard/medium/easy tiers of the suite tasks are a pre-registered prefix rule (a=easy, b/c=medium, d/p=hard), not a measured difficulty.
- Suite tasks are exposed (used by earlier orche experiments): they are train/dev only and never an independent holdout.
- The holdout used here was NOT independent; no adoption claim can rest on it.
