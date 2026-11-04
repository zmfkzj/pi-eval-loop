# A/B/C ablation of pi-eval-loop

> EXPLORATION-ONLY protocol: train/dev search and development selection only. No holdout was loaded or used; deployment is BLOCKED. Development figures are descriptive and selection-biased.

Points are exact plug-in estimates (uniform task weights); brackets are 95% task-level Bayesian-bootstrap intervals.

| condition | final harness | dev success | dev Q_overall | dev Q_hard | holdout success | holdout Q_overall | proposals | optimization runs (screen+dev) | optimization tokens in/out | proposer requests | search stop |
|---|---|---|---|---|---|---|---:|---:|---|---:|---|
| A | stable | 39/48 (81.25%) | 81.25% [63.1%, 93.9%] | 55.56% [26.4%, 82.5%] | not measured | – | 0 | 0 | 0/0 | 0 | – |
| B | stable | 39/48 (81.25%) | 81.25% [62.8%, 94.0%] | 55.56% [26.6%, 82.7%] | not measured | – | 10 | 180 | 67351303/1352625 | 129 | no meaningful progress in 10 consecutive candidates |
| C | stable | 39/48 (81.25%) | 81.25% [62.5%, 93.9%] | 55.56% [26.2%, 82.8%] | not measured | – | 10 | 180 | 62010696/1204402 | 120 | no meaningful progress in 10 consecutive candidates |

## Holdout contrasts (task-level paired Bayesian bootstrap; support = P(overall improves))

- B vs A (loop effect, quality-only): holdout not measured
- C vs A (loop effect, Pareto): holdout not measured
- C vs B (added effect of Pareto exploration): holdout not measured

## Development contrasts (descriptive; the finals were selected on these data, so they are biased upward)

- B vs A: A and B are the same harness (stable)
- C vs A: A and C are the same harness (stable)
- C vs B: B and C are the same harness (stable)

Statements need support >= 0.95 on an independent holdout to count as evidence of an improvement; anything lower is uncertain and reported as such.

## Deployment (C adoption gate): BLOCKED

- exploration outcome: no candidate selected (none)
- exploration-only protocol (datasets.holdout = null): no unconsumed independent holdout is available, so no candidate can be validated or deployed; a development selection is not evidence of improvement
