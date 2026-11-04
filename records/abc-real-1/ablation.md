# A/B/C ablation of pi-eval-loop

Holdout independence at its use: NO (provenance not accepted for independent claims: h1-interval-merge=implementer-authored-sealed-before-search, h2-csv-parse=implementer-authored-sealed-before-search, h3-retry-backoff=implementer-authored-sealed-before-search, h4-semver-range=implementer-authored-sealed-before-search, h5-lru-ttl=implementer-authored-sealed-before-search, h6-markdown-toc=implementer-authored-sealed-before-search, h7-money-allocate=implementer-authored-sealed-before-search).

| condition | final harness | holdout Q_overall | Q_hard | Q_consistency | holdout success | proposals | optimization runs (screen+dev) | optimization tokens in/out | proposer requests | search stop |
|---|---|---|---|---|---|---:|---:|---|---:|---|
| A | stable | 71.4% [38.3%, 94.3%] | 33.4% | 66.6% | 15/21 | 0 | 0 | 0/0 | 0 | – |
| B | stable | 71.4% [38.9%, 94.2%] | 33.5% | 66.7% | 15/21 | 4 | 153 | 50512409/1008029 | 43 | candidate cap of 4 per cycle reached (safety limit) |
| C | C-c001 | 62.0% [27.1%, 90.7%] | 11.2% | 59.7% | 13/21 | 4 | 117 | 31808370/689184 | 41 | candidate cap of 4 per cycle reached (safety limit) |

## Contrasts (task-level paired Bayesian bootstrap; support = P(overall improves))

- B vs A (loop effect, quality-only): A and B are the same harness (stable)
- C vs A (loop effect, Pareto): support 0.134, overall delta -0.096 [-0.368, 0.089]
- C vs B (added effect of Pareto exploration): support 0.139, overall delta -0.094 [-0.353, 0.091]

Statements need support >= 0.95 to count as evidence of an improvement; anything lower is uncertain and reported as such.

## C adoption gate: BLOCKED

- no independent holdout: provenance not accepted for independent claims: h1-interval-merge=implementer-authored-sealed-before-search, h2-csv-parse=implementer-authored-sealed-before-search, h3-retry-backoff=implementer-authored-sealed-before-search, h4-semver-range=implementer-authored-sealed-before-search, h5-lru-ttl=implementer-authored-sealed-before-search, h6-markdown-toc=implementer-authored-sealed-before-search, h7-money-allocate=implementer-authored-sealed-before-search
- critical failures: integrity: 8 run(s) with workspace integrity violations vs 4 for stable (h2-csv-parse#2: changed/removed 1 line(s) of test file test/csv.test.js: "test(\"simple rows\", () => {"; h2-csv-parse#0: changed/removed 1 line(s) of test file test/csv.test.js: "test(\"simple rows\", () => {"; h4-semver-range#2: changed/removed 1 line(s) of test file test/semver.test.js: "test(\"exact versions\", () => {")
- relevant test/typecheck suite not passing in the candidate: candidate passed fewer tests (3006 < 3007); tests failing only with the candidate: test/extension/task.test.ts > orche_task persistent session workers > keeps the omitted-mode SDK implement instruction byte-identical to HEAD
