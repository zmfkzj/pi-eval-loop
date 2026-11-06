# ctrl-ablation-1: post-hoc legacy vs strict sensitivity (NOT preregistered; no decision uses it)

Same records, two scorings. Primary (preregistered) = legacy detector + strict byte identity of original test files.
Legacy = the original line-based detector + leak scan only (the historical estimand family). Both decisions were retained per unit.

## All 810 units (27 tasks x 3 repeats per arm)

Counts are records (units), not violation messages. `strict-only` = strict violation without legacy violation or leak.

| arm | detector (legacy) fail | leak | strict fail | strict-only | both | legacy-only | functional | func-fail among integrity-fail | func-fail among strict-only | legacy-valid | strict-valid (primary) | r/r tasks legacy / strict | 0/r tasks legacy / strict | I legacy / strict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S | 13 | 0 | 52 | 39 | 13 | 0 | 65 | 5 | 3 | 54 | 18 | 15 / 4 | 6 / 18 | 0.074 / 0.062 |
| B0 | 4 | 0 | 22 | 18 | 4 | 0 | 66 | 0 | 0 | 62 | 44 | 17 / 11 | 3 / 9 | 0.086 / 0.086 |
| P1 | 0 | 0 | 4 | 4 | 0 | 0 | 66 | 1 | 1 | 66 | 63 | 20 / 17 | 3 / 3 | 0.049 / 0.086 |
| P2 | 9 | 0 | 49 | 40 | 9 | 0 | 67 | 4 | 2 | 60 | 22 | 17 / 4 | 5 / 17 | 0.062 / 0.074 |
| P3 | 0 | 0 | 0 | 0 | 0 | 0 | 69 | 0 | 0 | 69 | 69 | 22 / 22 | 3 / 3 | 0.025 / 0.025 |
| D1 | 7 | 0 | 21 | 14 | 7 | 0 | 68 | 3 | 2 | 62 | 50 | 17 / 13 | 3 / 7 | 0.086 / 0.086 |
| D2 | 9 | 0 | 48 | 39 | 9 | 0 | 70 | 3 | 3 | 61 | 25 | 17 / 5 | 2 / 14 | 0.099 / 0.099 |
| T1 | 17 | 0 | 52 | 35 | 17 | 0 | 67 | 5 | 2 | 53 | 20 | 14 / 5 | 6 / 19 | 0.086 / 0.037 |
| V1 | 13 | 0 | 53 | 40 | 13 | 0 | 70 | 2 | 2 | 57 | 19 | 15 / 2 | 3 / 16 | 0.111 / 0.111 |
| V2 | 13 | 0 | 51 | 38 | 13 | 0 | 66 | 3 | 2 | 54 | 18 | 14 / 3 | 5 / 18 | 0.099 / 0.074 |

strict-valid vs metrics.successOf mismatches: 0.

## Legacy-scored paired contrasts vs S (task-cluster bootstrap 95% CI; within-task randomization p; unadjusted, post-hoc)

| contrast | d legacy-valid pt [CI] | p | tasks +/- | d functional pt [CI] | d r/r share legacy / strict pt |
|---|---|---|---|---|---|
| B0-S | +9.9 [-2.5, +23.5] | 0.228 | 7/3 | +1.2 [-4.9, +11.1] | +7.4 / +25.9 |
| P1-S | +14.8 [+2.5, +29.6] | 0.063 | 8/3 | +1.2 [-6.2, +9.9] | +18.5 / +48.1 |
| P2-S | +7.4 [-2.5, +17.3] | 0.249 | 7/2 | +2.5 [-3.7, +8.6] | +7.4 / +0.0 |
| P3-S | +18.5 [+6.2, +32.1] | 0.015 | 9/1 | +4.9 [-1.2, +12.3] | +25.9 / +66.7 |
| D1-S | +9.9 [+1.2, +19.8] | 0.097 | 9/3 | +3.7 [-3.7, +12.3] | +7.4 / +33.3 |
| D2-S | +8.6 [+1.2, +16.0] | 0.064 | 7/1 | +6.2 [-0.0, +13.6] | +7.4 / +3.7 |
| T1-S | -1.2 [-12.3, +9.9] | 1.000 | 4/5 | +2.5 [-3.7, +9.9] | -3.7 / +3.7 |
| V1-S | +3.7 [-6.2, +12.3] | 0.618 | 6/3 | +6.2 [-1.2, +13.6] | +0.0 / -7.4 |
| V2-S | -0.0 [-8.6, +8.6] | 1.000 | 3/3 | +1.2 [-8.6, +11.1] | -3.7 / -3.7 |

## The 16 former dev tasks only (480 units; descriptive, for orientation against abc-real-1 / explore-real-2 — not a regression test)

| arm | legacy-valid /48 | strict-valid /48 | functional /48 | legacy fail | strict fail |
|---|---|---|---|---|---|
| S | 36 | 14 | 42 | 7 | 32 |
| B0 | 42 | 28 | 44 | 2 | 16 |
| P1 | 43 | 42 | 43 | 0 | 2 |
| P2 | 40 | 18 | 44 | 5 | 29 |
| P3 | 45 | 45 | 45 | 0 | 0 |
| D1 | 42 | 34 | 44 | 2 | 12 |
| D2 | 39 | 18 | 44 | 5 | 29 |
| T1 | 36 | 16 | 44 | 9 | 31 |
| V1 | 35 | 13 | 43 | 8 | 32 |
| V2 | 36 | 14 | 42 | 7 | 31 |
