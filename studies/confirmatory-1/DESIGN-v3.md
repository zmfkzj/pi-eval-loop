# confirmatory-1 design v3: measured calibration, integrity-censored difficulty, power with the measured private baseline (2026-11-07)

PROVISIONAL. Frozen before any holdout outcome (no main or confirmation holdout has been sealed, reserved or run). Supersedes
DESIGN-v2.md as the rationale of `protocol-v3.json`; every gate value of protocol-v2 is unchanged (minEffect 0.05, alpha 0.0125
holdout + 0.0125 confirmation, 144 + 144 tasks, 48 families each, 48 calibrated-hard tasks, 5 repeats, low-exposure 72,
family-level adoption, no prior-family reuse, max owner share 0.5, cross-provider review). DESIGN-v2.md and protocol-v2.json
stay as earlier registrations.

## 1. What was measured (empirical) vs simulated

| item | kind | source |
|---|---|---|
| stable baseline on 2 sealed calibration batches, 30 units, 599 target attempts | EMPIRICAL | `<private>/calibration/state-b{1,2}/runs.jsonl`, budget ledger |
| ctrl-confirm-2 final (1116/1116 units, public tasks) | EMPIRICAL | `evidence-v3.json` source c2 |
| pilot ctrl-ablation-1 | EMPIRICAL (earlier) | `evidence-v3.json` source pilot |
| adopt-and-confirm power, 72 rows | SIMULATION | `power3-main.json` (`power2.mjs --private cal:stable --template c2:OC:OCR`, 150 reps, 2000 draws) |
| integrity survival (n+1)/(n+1+K) | MODEL (uniform prior, independent runs) | not computed: no candidate integrity screen exists |

## 2. Calibration result and the integrity confound

Unit classes (raw reports, censoring infra-excluded@1): batch b1 (6 valid originals of b20261106T131706Z-47fd006e) success 9,
failure 3, **integrity 6**, infrastructure 0, harness 0; batch b2 (4 corrected versions, b20261107T041803Z-82b4cdf9) success 9,
failure 2, integrity 1, infrastructure 0. Grader defects: the 4 defective originals were excluded before dispatch
(exclusions-v1.json) and never measured. The raw b1 report made "easy" hard (mean graded rate 0.44): every one of those
failures was a strict-integrity violation (the agent edited an existing test file) while the hidden tests passed 1.0. That is
an integrity observation, not cognitive difficulty.

Fix (src/calibration.mjs `CENSORING_V2 = "infra-integrity-excluded@2"`): integrity units carry no difficulty evidence (neither
failure nor success), infrastructure/harness units stay censored, a task needs >= 2 valid units, a level needs >= 3 sufficient
tasks, and `verifyCalibrationReport` refuses any hard level certified under a rule that counts integrity failures. Integrity
remains a separate blocking gate (candidate integrity veto, strict integrity in the evaluator) - unchanged. The raw reports are
kept byte-identical; derived reports (`calibration-report.derived-v2.json`, `recalibrate-v2.mjs`) were written from the same
ledgers. Because @2 was registered after the first measurement it is accepted only as a restriction (a level hard under @2 but
not @1 would be flagged `postHocAddition`; none occurred).

Derived result: **no level is calibrated hard.** b1: easy 1 sufficient task (rate 1.0) + 2 insufficient; medium 3 tasks mean
0.67. b2: declared-hard 3 tasks mean 0.78; medium 1 task 1.0. Per task exact 95% intervals are in the derived reports; the only
task with 0 successes (toolshed-catchup, 0/3 valid) has interval [0, 0.71]: three runs cannot show that a task is "truly hard",
only that it was not solved three times. Consequence: the protocol's 48 calibrated-hard tasks per holdout have **no supply**
today, and the declared tiers of the current authoring source over-state difficulty for this baseline.

## 3. Power with the measured private baseline (power3-main.json)

Private pool now = the measured calibration tasks (10 tasks, 5 families, graded mean 0.60), external pool = ctrl-confirm-2 OC
(93 tasks, 54 families, mean 0.09). Adopt-and-confirm (the evaluator's full conjunction: holdout adoption incl. family-level
and task/family support gates, then a separate confirmation batch; zero candidate violations), registered design N 144 + 144,
r 5, alpha 0.0125/0.0125, minEffect 0.05, at the target effect 0.15:

| scenario | power3 (measured private) | power2 (pilot private) |
|---|---|---|
| logit, sigmaFamily 0.5 | 0.78 +- 0.03 | 0.84 +- 0.03 |
| template c2 OCR-OC | 0.67 +- 0.04 | 0.80 +- 0.03 |
| logit, sigmaFamily 1.0 | 0.36 +- 0.04 | 0.57 +- 0.04 |

Other sizes at 0.15 (logit sf0.5 / template / sf1): 96: 0.57 / 0.34 / 0.26; 192: 0.79 / 0.67 / 0.43; 288: 0.72 / 0.70 / 0.25.
The sharp null never adopts (0 in every size). Power is not monotone in N here (288 below 192); a likely cause is that with a
private pool of only 5 families larger batches resample the same few families (more family-level vetoes) - an artefact of the
tiny pool, not a property of real supply (not separately verified).

Adequacy is **not shown**: the best scenario is below 0.8 before the integrity survival factor (unknown: no pre-holdout
candidate screen; at the strict-integrity violation rate per run seen in the ctrl-confirm-2 OC arm (0.45) survival over
K = 1440 candidate runs would be ~0; the survival product itself assumes independent runs and a uniform prior). 144 + 144 and the 0.15 target stay provisional; neither is raised or relaxed to claim adequacy.

Limitations of this simulation (not evidence of supply): (a) the private baseline comes from 10 tasks of ONE authoring account;
(b) simulated families are drawn with replacement from 5 real families and are not independent supply families; (c) the
simulated "hard stratum" is chosen by graded rate <= 0.5 in that pool (it includes integrity failures) and is NOT calibrated-hard
evidence; (d) graded baseline rates include integrity failures because the evaluation will grade them so - correct for power,
wrong for difficulty; (e) the candidate effect model (logit shift or the public OCR-OC contrast) is transported from public tasks
to private ones without measurement; (f) Monte Carlo 150 reps, 2000 permutation draws (protocol 20000).

## 4. Supply, provenance and exposure (2026-11-07)

See README "Continuation 2026-11-07 (W5, part 2)" for counts. Source concentration: 100% of private tasks come from one
authoring account (ai-claude-opus-5-5 sub-worker sessions); role-separated sessions are not independent authors, and
cross-provider review does not establish training non-exposure or independence. `maxOwnerShare 0.5` therefore cannot be met by
private supply alone.

Sibling-answer leaks: several starting repositories contained a sibling task's reference file verbatim. The per-unit sandbox
boundary was not taken as the safety argument (running the container sends the sibling's answer to the target provider; every
review sent it to reviewer providers). Unsealed constructions were versioned (sibling-isolation, `sibling.mjs`), non-isolable
ones excluded or withdrawn; sealed calibration tasks keep their content and their target runs are recorded as exposure
(`<private>/exposure-sibling-2026-11-07.json`).

## 5. Readiness (separately)

- main holdout: blocked (no sealed eligible batch; supply far below 144 tasks / 48 families; 0 calibrated-hard tasks).
- confirmation holdout: blocked (needs a distinct, family-disjoint batch of the same size).
- calibration: reports verified, no level hard -> blocked for the calibrated-hard requirement.
- analysis plan: provisional (section 3).
