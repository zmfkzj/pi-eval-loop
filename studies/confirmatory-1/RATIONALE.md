# confirmatory-1: prospective analysis plan and its rationale (PROVISIONAL)

Registered 2026-11-06 (before any holdout or calibration outcome of this plan exists; no main or confirmation batch has been
reserved, run or seen). Protocol: `studies/confirmatory-1/protocol.json` (its `analysisPlan.rationale.sha256` is the sha256 of
this file; any edit makes the plan incomplete and blocks the experiment). Status: **PROVISIONAL / NOT ADEQUATELY POWERED for the
effect sizes observed so far** (section 6) and **BLOCKED on supply** (section 7). Nothing in this document is a performance claim.

## 1. Question and estimand

Does a candidate pi-orche harness selected by the loop improve valid task success over the stable harness on new, unexposed
coding tasks? Unit outcome = the evaluator's success (`src/metrics.mjs successOf`: completed, hidden tests pass with the
reference count, visible suite not failed, no task-agent integrity violation, no critical failure). Primary estimand = the
task-weighted mean difference (candidate - stable) of per-task success rates, repeats averaged within a task, on the sealed
holdout tasks. Every protocol-3 rule stays necessary (critical rule, task-level adoption support >= 0.95 with the hard and
consistency allowances, family-regression rule, hard stratum present, checks); protocol-4 adds the family-clustered support and
the confirmatory checks (`src/design.mjs confirmatoryChecks`): randomization (sign-flip within (task, repeat) blocks) test of
the sharp null at alpha, family-clustered P(delta > 0) >= 1 - alpha, plug-in delta >= minEffect (descriptive), leave-one-family-
out (sensitivity), low-exposure stratum direction; then an independent confirmation on a second sealed batch.

## 2. Unit, cluster and sampling structure

- Block = (task, repeat), one unit per arm, randomized interleaved order (`holdout.execution: "interleaved"`; seeded, frozen
  before the first dispatch).
- Task = the sampling unit of the claim; family = project (`private:<owner>/<project>`, tasks of one project share a code base);
  account = the accountable author or source (all AI-authored tasks of one model/provider are ONE account).
- Families of main, confirmation and calibration batches are disjoint (`priorFamilyReuse: "forbid"`, one pool, calibration
  families count as prior).

## 3. Evidence used (real measurements only; transport limits stated)

- `studies/confirmatory-1/pilot.json`, extracted by `pilot.mjs` from the hash-chained ledger of the real, randomized and
  interleaved ctrl-ablation-1 campaign (live checkout `pi-eval-loop/records/ctrl-ablation-1/discovery/runs.jsonl`, sha256
  fa847b16...; 810 units = 10 arms x 27 exposed orche suite tasks x 3 repeats; route cliproxyapi/gpt-6-luna medium), scored with
  the estimand of this evaluator (legacy detector, no strict byte identity). Stable S: 54/81 valid (hard tier 10/33); legacy
  integrity violations per run: S 13/81, B0 4/81, D1 7/81, D2 9/81, P1 0/81, P3 0/81. Legacy-scored contrasts vs S (ctrl-ablation
  post-hoc, unadjusted): P1 +14.8, D1 +9.9, B0 +9.9, D2 +8.6, P2 +7.4, V1 +3.7, T1 -1.2, V2 0.0 points.
- The loop's own qualified candidates (aw-scheduled, development split, task level): c002 +8.3, c011 +6.3, c012 +2.1 points
  (development is selection-biased; the aw-scheduled holdout verdict was BLOCKED and is not used as a performance measurement).
- Transport limits: pilot tasks are 27 exposed suite tasks from one generator family style, not the private tasks this plan
  targets; pilot families are few (13, mostly 1 task), so family-level heterogeneity is poorly identified; the beta-binomial
  method-of-moments prior strength hits its lower bound (2) for S, D1 and D2 (strongly bimodal tasks). Per-task baseline rates
  and the distribution of per-task effects on new tasks are therefore assumptions, varied below.

## 4. Simulation (offline, model-free)

`studies/confirmatory-1/power.mjs` simulates the exact conjunction coded in this evaluator by calling `adoptionCompare`,
`familyAdoptionCompare`, `adoptionDecision` and `confirmatoryChecks` on simulated outcomes, holdout and confirmation each, and
counts ADOPT, CONFIRMED and both. Generative models: (a) template:D1 / template:D2 = shrunk per-task pilot rates of S and of a
real intervention arm, the per-task difference scaled to the target mean effect, simulated families resampling pilot families
(within-family correlation through shared tasks); (b) logit = stable rate from the pilot, logit shift beta + family effect
N(0, 0.5) + task effect N(0, 0.75) (and 1.0/1.0 as a heterogeneity sensitivity). Candidate integrity-violation probability per
run v in {0, 0.005, 0.02}. Hard share = one third of the tasks (whole hard families). 200 replicates per cell (Monte Carlo SE
<= 0.035), bootstrap and permutation draws 2000 in the simulation (the protocol uses 10000/20000). Outputs:
`power.json` (N = 24..144, r = 3, alpha 0.0125) and `power-focus.json` (N = 96/144, r = 3/5, alpha 0.0125/0.025).

## 5. Results that fix the numbers

- Error control: under the sharp null (pB = pA) and the zero-mean heterogeneous nulls, ADOPT occurred 0/200 times in every cell
  (95% upper bound 0.015 per cell); the randomization test is exact/Monte-Carlo valid for the sharp null irrespective of N and r.
- Integrity violations dominate: any candidate violation in any holdout run BLOCKS (unchanged protocol-2 rule). With v = 0.005
  and N = 144, r = 3 the holdout ADOPT rate at delta 0.10 fell to 0.06 (critical in 171/200); v = 0.02 gives 0 at every N.
  A candidate needs a per-run violation probability well below 1/(N r) for any design to have power; this is a property of the
  candidate, not of the sample size, and the plan does not relax the rule.
- Effect 0.10 (the median of observed intervention effects): ADOPT AND CONFIRMED <= 0.34 in every explored design (N <= 144,
  r <= 5, alpha <= 0.025, all models). Effect 0.15: logit 0.90 +- 0.02 at N = 144, r = 5, alpha 0.0125 (0.94 at alpha 0.025);
  templates 0.33-0.58 (their family losses trigger the family-regression and leave-one-family-out rules by design).
  Effect 0.05: <= 0.01 everywhere.
- Binding constraints observed: task-level support (overall and the hard/consistency allowances) at small N; family-clustered
  support and the family-clustered P(delta > 0) >= 1 - alpha at moderate N; family regression with template heterogeneity.

## 6. Registered design and why

| item | value | reason |
|---|---|---|
| minEffect (smallest effect of interest) | 0.05 | effects below ~5 points are within the spread of null-like arms in the pilot (V1 +3.7, T1 -1.2, V2 0.0) and not worth a production change; it is a descriptive floor, not the power target |
| design effect (power target) | 0.15 | the only effect at which a feasible design reaches >= 0.8 for adopt AND confirm under any model; it is at the top of the observed range (P1 +14.8) - typical effects (~0.10) are NOT adequately covered |
| main holdout | 144 tasks, 48 families x 3, >= 48 calibrated-hard tasks | largest design simulated; below it power at 0.15 drops (logit, r = 5: N = 96 -> 0.75) |
| repeats | 5 (holdout.repeats) | r = 5 raised adopt-and-confirm at 0.15 from 0.67 to 0.90 (N = 144, logit); stronger than the default 3 |
| alpha (holdout), confirmation alpha | 0.0125 each | one-sided 0.025 per experiment split between decision and independent confirmation |
| series | id orche-confirmatory-series-1, alphaTotal 0.05 | union bound over at most two confirmatory experiments before the operator decides a new budget |
| hard subgroup | difficultyBasis "calibrated" only (`holdout.hardBasis: ["calibrated"]`), feature declared-tier, level hard iff mean stable rate <= 0.5 with >= 3 tasks (calibration set, separate families) | author labels alone are not difficulty evidence; the threshold puts "hard" below the pilot's stable rate (0.67) and was fixed before any calibration run |
| low-exposure stratum | required, >= 72 private-reviewed tasks, direction must agree | public tasks may be in pretraining data |
| confirmation | required; same pool, separate sealed batch, 144 tasks / 48 families | independent replication on disjoint families |
| execution | interleaved, randomized, frozen schedule | needed by the randomization test; removes time/provider drift from the arm contrast |
| review | `holdout.privateReview: "human"` | AI-agent review is recorded but is not human review |

Power at this design (v = 0): adopt-and-confirm 0.90 (logit, delta 0.15), 0.33-0.56 (templates, delta 0.15), 0.20-0.34 (all
models, delta 0.10). The plan is therefore registered as PROVISIONAL: it is adequate only for large, homogeneous effects. Moving
to adequacy for 0.10 would need either substantially more tasks than 144 per batch with five repeats, or a different (new
protocol version) decision rule; neither is assumed here.

## 7. What blocks execution (no model call has been made under this plan)

1. Supply: 288 holdout tasks (2 x 144) plus the calibration set; available: 7 eligible holdout candidates (one AI account, so the
   0.5 account-share cap cannot be met), 10 calibration tasks (sealed, calibration purpose, not measured).
2. Human review: all private tasks were authored, tested and reviewed by AI-agent sessions of one model/provider; under
   `privateReview: "human"` none is eligible.
3. Calibration measurement: needs a chargeable stable-harness run (30 units, worst case 4,500 requests at the 150-request unit
   ceiling; expected ~724 requests and ~6.9 M input tokens from the pilot S arm) and an explicit operator request ceiling.
4. Series ledger, rationale and plan are in place; the experiment itself, holdout reservation, adoption and confirmation are
   separate human decisions.
