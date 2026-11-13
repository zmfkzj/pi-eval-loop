# confirmatory-1 design reassessment (v2, PROVISIONAL, 2026-11-07)

Operator decision (2026-11-07): "금액 무제한. 요청 4500 유지. 사람 검토 없음. 방법 찾기. 재검토 수행." This document redoes the
prospective design with the evidence that exists now. **No holdout outcome exists** (no batch sealed for holdout, none
reserved or used); v2 is frozen before any holdout outcome. It is PROVISIONAL: it does not claim an adequate sample size.
Machine-readable: `protocol-v2.json`, `study-v2.json`; simulation `power2.mjs` → `power2-main.json`; inputs `evidence-v2.json`.

## 1. Evidence used, and what it is

| source | arms | units | role | prospective? |
|---|---|---|---|---|
| ctrl-ablation-1 discovery (live checkout records, 2026-11-06) | S (stable orche), B0, P1, P3, D1, D2 | 486 | pilot: baseline rates, heterogeneity, integrity rates | retrospective, exposed suite tasks |
| ctrl-confirm-2 (peer experiment, still running) | OC, OCR, PC, PCR | 706 at snapshot | external-task baseline, a real contrast (OCR−OC) | **interim** snapshot of an unfinished experiment: shape only, no inference |
| confirmatory-1 calibration (private tasks) | stable | 0 | would be the private-task baseline | **not measured** (section 5) |

Every outcome is re-scored with THIS evaluator's estimand (`record.task_success`: completed, hidden pass, visible not failed, no
strict integrity violation) and unit classes (`calibration.mjs unitClass`). Ids are pseudonymized in `evidence-v2.json`.
Using the pilot (exposed suite tasks) for the private stratum is a **transport assumption** and is labelled as such.

## 2. The integrity-rate discrepancy (52/81 vs 54/81)

v1 (RATIONALE.md) scored the pilot with the LEGACY line-based detector (`pilot.mjs legacyValid`): stable S 54/81 valid, 13/81
legacy violations. The records' own `integrity.violations` come from the evaluator that recorded them, which enforces STRICT
test immutability (any byte change of an existing test file is a violation). Under that detector stable S has 52/81 runs
with a violation (47 of them otherwise pass the hidden tests) and only 18/81 successes. ctrl-confirm-2 shows the same pattern:
OC 85/176, OCR 27/176, PC 15/178, PCR 4/176 (interim). P3 has 0/81. The violations are almost all "existing test file was
modified (strict test immutability)": the orche harness edits existing test files as part of its workflow.

So v1 was built on the wrong detector for this evaluator: its baseline rates were too high and its candidate integrity
scenarios (v ≤ 1%) were far below what orche-family harnesses actually show.

## 3. The actual gate conjunction (unchanged)

Holdout (`src/loop.mjs` → `adoptionDecision`): no candidate run with an integrity violation (critical), no incomplete units,
infrastructure rate ≤ watchdog.maxInfraRate, task-level and family-level bootstrap support, **no family-level regression**,
and the confirmatory checks (alpha 0.0125, minEffect 0.05, family-clustered test, hard stratum ≥ 48, low-exposure ≥ 72).
Then an independent confirmation batch: no violation, confirmatory checks at alpha 0.0125. Series budget 0.05.
`power2.mjs` calls the production functions (`adoptionCompare`, `familyAdoptionCompare`, `confirmatoryChecks`,
`adoptionDecision`) with infrastructure failures (rate 2.3% from ctrl-confirm-2), the private/external mixture and calibrated-hard
families. 150 replications per cell (MCSE ≤ 0.04); bootstrap/permutation draws 2000 (production 10000/20000).

## 4. Results

Adopt-and-confirm probability with **no candidate integrity violation** (best case), family σ 0.5 / task σ 0.75 (logit model) and
the real OCR−OC per-task contrast as template:

| N main = N conf | repeats | 10 pp | 15 pp | 20 pp | 15 pp, σ 1.0/1.0 | null |
|---|---|---|---|---|---|---|
| 96 | 5 | 0.09 / 0.05 | 0.67 / 0.53 | 0.90 / 0.81 | 0.39 | 0 |
| 144 | 3 | 0.09 / 0.03 | 0.57 / 0.45 | 0.82 / 0.74 | 0.32 | 0 |
| **144** | **5** | 0.26 / 0.27 | **0.84 / 0.80** | 0.96 / 0.90 | 0.57 | 0 |
| 192 | 5 | 0.44 / 0.51 | 0.83 / 0.83 | 0.96 / 0.91 | 0.54 | 0 |
| 288 | 3 | 0.26 / 0.28 | 0.59 / 0.49 | 0.72 / 0.60 | 0.25 | 0 |
| 288 | 5 | 0.58 / 0.60 | 0.76 / 0.77 | 0.95 / 0.79 | 0.43 | 0 |

(logit / template; full table with failure reasons in `power2-main.json`.)

Findings:
1. **More tasks can lower adoption power.** At 15 pp, holdout adoption peaks at 144–192 tasks (5 repeats) and falls at 288
   (0.85 → 0.76; σ 1.0: 0.58 → 0.43); with 3 repeats 288 is no better than 144. The cause is the family-regression veto:
   with more families, the chance that some family shows a regression grows. Confirmation alone keeps improving with N.
2. **5 repeats beat 3 everywhere**: they reduce the noise behind spurious family regressions.
3. **A 10 pp effect is not a realistic target** under this gate: ≤ 0.27 at 144×5 and ≤ 0.60 even at 288×5.
4. **The integrity veto dominates everything else.** With K = 2 × N × repeats candidate runs (1440 at 144×5) that must ALL be
   free of strict violations, P(no violation) = (1 − v)^K: 0.49 at v = 0.05%, 0.24 at 0.1%, 0.01 at 0.3%, 0 at 1%. Observed v for
   orche-family arms is 15–64%, for PC 8%, PCR 2.3%, P3 0/81. With n violation-free pre-holdout candidate runs and a uniform prior on
   v, P(no violation) = (n+1)/(n+1+K): 0.12 at n = 200, 0.41 at n = 1000. Fewer runs (smaller N or 3 repeats) raise this factor
   but lower the statistical part; at v = 0.05% the products are ≈ 0.41 (144×5), 0.37 (144×3), 0.42 (96×5).
5. No false adoption under the null in any cell (0/150 per cell; not a precise error-rate estimate).

## 5. Revised design (PROVISIONAL v2) and why

- **Main 144 + confirmation 144 tasks, 3 per family (48 + 48 disjoint families), 5 repeats**: the best simulated cell for the
  statistical part; 288 per batch is not supported (it lowers adoption power through the family-regression veto).
  The earlier "288 tasks" is therefore the total of both batches at this design, not an established need, and it stays
  provisional until the private baseline is measured.
- **Target effect 15 pp** (not 10 pp): the only real contrast available (OCR−OC, +15.7 pp raw, interim, external tasks) is
  of that size, and 10 pp cannot reach useful power under this gate at any N ≤ 288. A candidate expected to give ~10 pp
  should not use this confirmatory track.
- **Unchanged gates**: alpha 0.0125 + 0.0125, minEffect 0.05, series 0.05, family-level adoption, strict integrity veto, hard
  stratum ≥ 48 (calibrated), low-exposure ≥ 72 private-reviewed per batch, max owner share 0.5. None was loosened.
- **New entry condition for a candidate** (`study-v2.json plan.candidateIntegrity`): a pre-holdout integrity screen on
  non-holdout tasks. Readiness multiplies the simulated power by (n+1)/(n+1+K) and stays provisional without it. Because the
  stable orche harness edits existing test files in about half its runs, an orche-family candidate must first be shown to
  stop doing so; otherwise the confirmatory track cannot adopt it, whatever the sample size.
- **Private review** policy `cross-provider` (DESIGN in docs/design.md "Non-human review").

At this design the simulated statistical part is 0.84 / 0.80 at 15 pp (MCSE 0.03), i.e. just at the 0.8 line under the
best-case integrity assumption, 0.57 under larger heterogeneity. Readiness therefore reports the plan as **provisional**.

## 6. Information still required (and how it changes the plan)

1. Private-task baseline rates (calibration): blocked (README "Calibration"); the transport assumption above stays until then.
2. The candidate's strict-integrity rate (pre-holdout screen); without it no adoption probability can be stated.
3. ctrl-confirm-2 final data (after the peer finishes): replace the interim template; refit heterogeneity.
4. If private baselines are much lower than assumed (many floor tasks), the family-level tests lose power: re-run `power2.mjs`
   with `--private cal:stable` before any batch is sealed.

Re-running: `node studies/confirmatory-1/evidence.mjs --source pilot=...:S,B0,P1,P3,D1,D2 --source c2=...:OC,OCR,PC,PCR --out
evidence-v2.json` then `node studies/confirmatory-1/power2.mjs --evidence evidence-v2.json --reps 150 --grid main`.
