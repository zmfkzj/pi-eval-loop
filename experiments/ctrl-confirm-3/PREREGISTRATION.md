# ctrl-confirm-3 — preregistration (corrected inference, feasibility-gated follow-up)

Registered 2026-11-07, before any ctrl-confirm-3 outcome existed (no agent has run on any ctrl-confirm-3 task). Machine-readable
twin: `prereg.json`. Amendments are appended at the end with a timestamp and a reason; earlier text is never edited.

## 0. Status and relation to earlier experiments

- ctrl-confirm-2 (1 116 units, sealed holdout `ctrl-confirm-2-holdout-3e83b1b2af67`) stays **INCONCLUSIVE / KEEP_STABLE** under its
  own frozen rule. Nothing here re-decides it. Its holdout and its supply pools (`results/ctrl-confirm-2-supply/`) are consumed and
  are never used for confirmation; its outcomes are used ONLY for planning (§8). ctrl-ablation-1 stays KEEP_STABLE.
- This is a new experiment with (i) a corrected, internally coherent inferential procedure, (ii) a power calculation that simulates
  exactly that decision rule, and (iii) a feasibility gate (§9) that is evaluated before any confirmation unit. The gate decides
  whether a confirmation is launched at all; a failed gate means NO confirmation run, never an underpowered run labelled as one.

## 1. Question and claim limits

- **H1 (primary, prompt reproducibility inside orche):** under the identical disclosed integrity contract, does adding the
  test-preservation rule to every orche-created session (OCR) raise E1 valid-success rate AND E2 reliable success relative to stable
  orche (OC)? A confirmed H1 is an instruction effect of a deployable prompt change, NOT a delegation/harness capability effect.
- **H2 (secondary, fixed sequence, user-goal harness comparison under matched instructions):** OCR vs pure Pi with the same rule
  (PCR). Tested only if H1 is CONFIRMED. Without a confirmed H2, no superiority of orche over pure Pi is claimed.
- Two-sided reporting: harm is reported as harm.

## 2. Design correction (the observed methodological problem)

ctrl-confirm-2 planned power with a family-level t interval (`experiments/ctrl-confirm-2/power.mjs:62-63`) but decided with a
percentile family bootstrap interval AND a Monte Carlo family sign-flip p < 0.025 (`experiments/ctrl-confirm-2/lib.mjs:130`). The
two parts of the decision were not compatible: for the sparse E2 only 4 families had a nonzero difference (all positive), so the
exact sign-flip p cannot be below 1/16 = 0.0625, while the percentile interval was [+1.0, +9.0]. The planned power (0.79) did not
describe the rule actually applied.

Correction (`stats.mjs`, one procedure used by analysis AND simulation):
- Per family f: x_f = sum over its tasks of the paired task difference (E1: k_OCR - k_OC; E2: all-3 indicator difference).
  Estimate = sum_f x_f / (u N): the task-weighted mean difference (= the arm-rate difference of the complete design).
- Test: EXACT family-level sign-flip randomization test of sum_f x_f, computed by dynamic programming over integer sums (no Monte
  Carlo error). Exact under the null that within each family the joint outcome distribution is invariant to swapping the two arm
  labels (family differences symmetric about 0, independent across families). Under weak nulls (zero mean but asymmetric,
  heterogeneous effects) it is not exact; its size there was checked by simulation (§8), not assumed.
- Interval: inversion of the SAME exact test under a constant per-task shift (grid 1/300 = 0.33 pt). The shift model is a working
  model (approximate for the discrete E2); the interval reports uncertainty, the decision uses only the exact p at 0. The analysis
  checks and reports that the acceptance set is contiguous and that "lower bound > 0" agrees with "p < 0.025"
  (`ciDecisionAgree`); a disagreement is reported, never resolved in favour of a confirmation.
- Applied to the (historical, exposed) ctrl-confirm-2 data for illustration only: E1 +3.9 pt, exact p 0.0352, interval [0.0, +7.7];
  E2 +4.3 pt, exact p 0.0625, interval [0.0, +8.3] — compatible with its INCONCLUSIVE verdict.
- Verified by `test/ctrl-confirm-3.test.mjs`: DP equals exhaustive enumeration (zeros, ties, unequal sizes, negative effects);
  4 / 5 / 6 concordant families give p = 1/16, 1/32, 1/64; task weighting; CI/decision agreement and contiguous acceptance sets on
  random designs; identical decisions of the analysis path (with intervals) and the simulation path (p only); size under global,
  partial and skewed nulls.

## 3. Arms (exact bytes frozen; `prereg.json` `arms`, `identity`)

| arm | harness | rule | role |
|---|---|---|---|
| OC | orche e831a6b, single, historical evaluator config | none | control (H1) |
| OCR | OC + `experiments/ctrl-confirm-2/variants/OCR.diff` (sha256 1c36e2b7…) | testIntegrityRule | candidate |
| PCR | pure Pi, built-in tools + `--append-system-prompt testIntegrityRule` | testIntegrityRule | matched-instruction comparator (H2) |

- Every arm receives the identical baseline integrity contract (sha256 12ce46a1…, bytes identical to ctrl-confirm-2; test asserts
  it). The ONLY OCR-OC difference is the testIntegrityRule (sha256 fb8e0a93…) in the system prompt of every orche-created session.
- PC is dropped: OC vs OCR isolates the prompt effect; OCR vs PCR is the matched-instruction harness comparison; PC-based
  mechanism contrasts were descriptive in ctrl-confirm-2. Minimal arm set: 3.

## 4. Fixed conditions (unchanged from ctrl-confirm-2)

Route `cliproxyapi/gpt-6-luna`, effort medium, every session (off-route = route violation); per-unit ceilings 20 min wall, 150 model
requests, grader 120 s; same bubblewrap sandbox, offline, hidden tests never mounted for agents, transcripts captured and
leak-scanned; environment digest checked; concurrency 8; one seeded randomized queue of (task, repeat) blocks holding one unit of
each arm, block and in-block order shuffled; 3 repeats.

## 5. Tasks

- Source: real upstream commits of public npm packages (license-checked, provenance recorded) collected model-free into the NEW
  workspace-local supply `results/ctrl-confirm-3-supply/` (`supply.mjs`, reusing `src/supply.mjs` unchanged).
- Excluded BEFORE cloning: every repository named by the pre-existing external pool (read-only registry/reports); every repository
  named by any ctrl-confirm-2 supply pool (14 pools: registries and slice reports incl. unfinished slices: 543 slugs); every family
  of the consumed ctrl-confirm-2 holdout (54). A repository that ctrl-confirm-2 only listed in its discovery plan but never assigned
  to a slice (never cloned, no case, no agent exposure) is not consumed and may be collected.
- Assembly (`assemble.mjs`): the ctrl-confirm-2 exposure audit (external pool commits/patches/repos, earlier datasets, names in
  earlier experiments/records, content hashes) PLUS explicit consumed-root audit codes (repository / commit / case id / family /
  hidden+reference content hash of every ctrl-confirm-2 supply pool and holdout); instruction/contract conflict screen (regex flag +
  recorded review); engine grader validation; candidate-blind seeded selection (sha256(seed:id), at most 3 per repository and 6 per
  account). Sealed batch (`SEAL.json`, `USES.jsonl` max 1 use) under `results/ctrl-confirm-3-holdout/` (git-ignored, outside every
  agent sandbox). Public code: pretraining contamination cannot be ruled out.

## 6. Outcomes (unchanged definitions)

Primary unit outcome legacy-valid (existing line-based detector incl. the 161605a Node-runner false-positive fix, identical for all
arms; no leak, no harness crash / route violation). E1 = mean over tasks of k/3; E2 = share of tasks with all 3 scheduled repeats
legacy-valid (missing = failure). Strict byte identity: sensitivity only. Functional success, failure counts, families, terminal
statuses, requests/tokens/wall: secondary/descriptive.

## 7. Analysis

- H1: CONFIRMED iff the design is complete AND exact one-sided p < 0.025 for BOTH E1 and E2 (intersection-union; no further
  adjustment). NOT_CONFIRMED_HARM_INDICATED iff a one-sided p in the harmful direction is < 0.025. Otherwise INCONCLUSIVE.
- H2: same rule for OCR - PCR, tested only after a CONFIRMED H1 (fixed sequence; familywise one-sided 0.025 for the claims).
- Intent-to-evaluate; infra-only retry once; sensitivity without infra-only units (descriptive). Family table and every family
  with OCR < OC recorded.
- Adoption (recommendation only): unchanged from ctrl-confirm-2 (`experiments/ctrl-confirm-2/lib.mjs` `adoption`): any family
  regression or functional point loss -> USER_REVIEW; never an automatic deployment, never a default change.
- Inferential power (P(H1 CONFIRMED)) is distinguished from passing the stricter adoption gates, which can only lower it.

## 8. Power and type-I planning (`power.mjs`, `records/ctrl-confirm-3/plan/`)

Every simulated experiment is decided by `stats.mjs` `hierarchy` (the analysis function). Calibration: ctrl-confirm-2 per-task
legacy-valid outcomes of all four arms (exposed, historical; planning only). Populations = family bootstrap of the 54 historical
families (preserves within-family dependence, concordant failures and sparse E2 discordance). Monte Carlo SE <= 0.008 (4 000 sims).

- **Primary planning model "latent"** (fixed before the gate): a task's success probability is drawn per simulated task from its
  posterior given all 12 historical repeats of the task (task difficulty dominates: 59/93 tasks 0/3 and 16/93 3/3 in both OC and
  OCR); OC = PCR = p; OCR = expit(logit p + beta) with beta calibrated to a population E1 effect target. Targets: +6.0 pt
  (optimistic), **+3.9 pt (ctrl-confirm-2 point estimate; already optimistic for a follow-up chosen because the estimate looked
  promising)**, +2.0 pt (attenuated), 0 (exact null).
- H1 power (latent): +3.9 pt: N=93 0.08, 200 0.24, 300 0.40, 400 0.55, 600 0.75, **800 0.86**, 1200 0.97; +2.0 pt: N=600 0.23,
  1200 0.49, 2400 0.81; +6.0 pt: N=300 0.79, 400 0.91. E2 is the binding endpoint (E1 alone reaches 0.86 at N=300 under +3.9 pt).
- Sensitivity models: (a) bootstrap of per-task shrunk probabilities with the effect scaled from the observed OCR-OC differences
  (`power-bootstrap-shrunk.json`): scale 1: N=300 0.21, 800 0.57, 1200 0.77, 1600 > 0.8; scale 0.5: <= 0.06 up to N=1600;
  (b) unshrunk raw k/3 (optimistic bound; 0/3 and 3/3 tasks deterministic, `power-noshrink.json`): scale 1: N=300 0.78, 400 0.91.
  Power is strongly model-dependent; no single number is a guarantee.
- Type-I / null behaviour (every value <= 0.025 + 2 MC SE, MC SE ~0.0025 at 0.025): global null H1 0.002-0.006 (E1 alone
  0.009-0.028, E2 alone 0.007-0.022; the IUT is conservative from E2 discreteness); partial null E2 = 0 with E1 +4.3 pt (bootstrap
  pool): H1 0.010-0.021; partial null E1 = 0 with E2 +6.3 pt: H1 0.012-0.025; skewed heterogeneous weak null for E1: E1 size
  0.013-0.024 (N 93-1600).
- Limitations: the calibration population is ctrl-confirm-2's (different repositories than any new supply); a constant logit
  shift is one effect model; repeats are modelled as independent; the provider has no seed.

## 9. Feasibility gate and run semantics (decided before any confirmation unit)

- Gate (`gate.mjs`): launch only if (a) N_req = smallest simulated N with H1 power >= 0.80 under latent +3.9 pt exists, (b) sealed
  fresh tasks >= N_req, (c) planned requests (ctrl-confirm-2 realized per-unit rates incl. all attempts: OC 30.7, OCR 29.5, PCR 9.7
  requests/unit) <= 45 000, (d) planned active hours at concurrency 8 <= 16. The budget is finite and of the order of the last
  approved campaign (40 000 requests, 14 h).
- Run semantics fixed now for any launch: active time = time with >= 1 unit in flight (paused time excluded), elapsed wall ceiling
  30 h recorded immutably in the lock at first launch; requests charged = completed model requests of every attempt (incl.
  reconciled orphans) + a persisted 150-request reservation per in-flight unit written before dispatch; provider credit/auth
  exhaustion pauses dispatch (never decides) and resumes in the frozen order; interrupted attempts are reconciled from their wire
  journals as failures (never redrawn); a ceiling ends the run with missing units = failures and H1 INCONCLUSIVE (no completion
  pressure, no extension, no optional stopping, no sample expansion). The ctrl-confirm-2 runner does not implement active-time
  accounting or persisted reservations; a launch therefore also requires implementing and testing these first.
- If the gate fails: no confirmation unit is dispatched; the sealed batch keeps 0 uses for a future, separately approved
  experiment; the blocker is reported.

## 10. Realized supply and gate result (filled at sealing, before any agent run)

(appended below as an amendment when the supply is sealed)

## Amendments

### A1 — 2026-11-07T18:10Z (W7, continuation of the interrupted W6 assignment; before any ctrl-confirm-3 agent run)

Recorded discrepancy, not a change: `prereg.json` `feasibilityGate.rule` (written 11:37Z) names planning scenario `scale:1`, whereas
§8/§9 above and `gate.mjs` (`PRIMARY_SCENARIO = "latent:0.039"`, switched 11:49Z; this document written 12:00Z) name the latent model
at +3.9 pt. Both were fixed before any ctrl-confirm-3 outcome and before sealing. No file is rewritten; the gate is evaluated under
BOTH readings (`gate.mjs --scenario`, default unchanged), and the run decision is the same under either, so no reading is selected
for being favourable. `power*.json` were not regenerated.

### A2 — §10 realized supply and gate result (filled at sealing, 2026-11-07T18:10Z, before any agent run)

- Supply: 174 509 npm packages -> 4 169 repositories; 595 excluded before cloning (535 consumed ctrl-confirm-2 slugs incl.
  unfinished slices, 60 external pool) -> 3 574 kept; collection of the first 2 400 (seeded order, 12 slices) started 13:26:40Z and
  ended for all slices at ~15:12:45Z when the owning session shut down (832 of 2 400 repositories cloned; no slice finished). The
  recorded stop rule (cutoff 17:00Z, `STOP_RULE.txt`) was respected: no restart; 0 of 1 554 registry entries are after the cutoff;
  all 163 eligible records count (`records/ctrl-confirm-3/holdout/supply-STOPPED_AT.txt`, with registry hashes).
- Assembly: 163 eligible, 163 audit-clean (0 hits against the 14 consumed ctrl-confirm-2 pools + holdout: 259 repositories,
  54 families, commits, case ids, content hashes; 0 hits against the 543 consumed slugs incl. unfinished slices); conflict review
  (`records/ctrl-confirm-3/holdout/conflict-review.json`, rule of ctrl-confirm-2): 10 regex-flagged and all 66 test-mentioning
  instructions screened, 3 excluded as conflicts; engine grader validation excluded 1; 159 selected (85 families, 82 owners, at most
  3 per family; MIT/Apache-2.0/ISC).
- Sealed batch `ctrl-confirm-3-holdout-4206b2e38c1d` (seal digest `b9e9a055…`, `results/ctrl-confirm-3-holdout/`, git-ignored),
  **0 uses**; eligibility record copied to `records/ctrl-confirm-3/holdout/`.
- Gate (`records/ctrl-confirm-3/plan/gate.json`, `gate-prereg-json-scale1.json`): **launch = false** under both readings.
  latent +3.9 pt: N_req 800 (a pass); (b) 159 < 800; (c) 167 690 planned requests > 45 000; (d) 40.6 active hours > 16.
  scale:1: N_req 1 600; (b), (c) 335 381, (d) 81.3 h all fail. The largest N within the request ceiling is 214 tasks (H1 power
  ~0.26 interpolated under latent +3.9 pt; 0.12 at N=200 under scale:1). The sealed 159 tasks would cost ~33 300 requests / 8.1 h but give
  H1 power between 0.08 (N=93) and 0.24 (N=200) under the primary model.
- Consequence (§9, fixed before outcomes): **no confirmation unit is dispatched**; ctrl-confirm-3 ends as BLOCKED (feasibility gate
  failed), adoption status KEEP_STABLE; the batch keeps 0 uses for a future, separately approved experiment. The runner
  prerequisites of §9 (active-time accounting, persisted reservations) were therefore not implemented. ctrl-confirm-2 and
  ctrl-ablation-1 verdicts are unchanged.

### A3 — 2026-11-08T02:30Z (W7; no ctrl-confirm-3 outcome exists)

ctrl-confirm-3 stays BLOCKED; nothing above is re-decided and its supply cutoff is not re-opened. After the user approved more tasks
and higher finite ceilings (2026-11-07), the follow-up is a NEW experiment, `experiments/ctrl-confirm-4/` (own preregistration,
own collection phase with its own cutoff, `COLLECTION.md`). The sealed batch `ctrl-confirm-3-holdout-4206b2e38c1d` is reused there as
itself (seal and 0 uses re-verified; never copied, re-sealed or modified). The planning-scenario discrepancy of A1 is resolved
prospectively for ctrl-confirm-4 only (its §3).
