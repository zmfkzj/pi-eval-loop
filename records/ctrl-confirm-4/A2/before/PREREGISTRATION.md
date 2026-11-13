# ctrl-confirm-4 — preregistration (corrected, feasibility-gated confirmation with managed execution resources)

Registered 2026-11-07, before any ctrl-confirm-4 outcome existed (no agent has run on any ctrl-confirm-4 or ctrl-confirm-3 holdout
task). Machine-readable twin: `prereg.json`. Amendments are appended with a timestamp and a reason; earlier text is never edited.

## 0. Status and relation to earlier experiments

- ctrl-ablation-1 (KEEP_STABLE), ctrl-confirm-2 (INCONCLUSIVE / KEEP_STABLE, 1 116 units) and ctrl-confirm-3 (BLOCKED at its gate, 0
  units) keep their verdicts. ctrl-confirm-2 data are exposed and used for planning only. ctrl-confirm-3's records and its supply
  cutoff are unchanged; its sealed batch `ctrl-confirm-3-holdout-4206b2e38c1d` (159 tasks, 0 uses, seal `b9e9a055…`) is reused AS
  ITSELF (seal re-verified, 0 uses re-verified at assembly, at the gate and at launch; never copied or re-sealed).
- The user (2026-11-07) approved more tasks, higher finite budget/time ceilings and resource management. This preregistration
  prepares a launch-ready configuration; it does NOT launch. A launch requires the gate (§6) to pass on the realized supply and a
  deliberate `run.mjs --launch`, which refuses without a passed gate bound to this file's digest and to fresh sealed batches.

## 1. Question, arms, outcomes, analysis (unchanged from ctrl-confirm-3)

H1 OCR > OC on E1 (valid-success rate) AND E2 (all 3 repeats legacy-valid), co-primary, intersection-union; H2 OCR > PCR only after a
CONFIRMED H1 (fixed sequence). Arms OC / OCR / PCR with the identical integrity contract (sha256 12ce46a1…), testIntegrityRule
(fb8e0a93…), OCR patch (1c36e2b7…), orche e831a6b, route `cliproxyapi/gpt-6-luna` effort medium, 20 min / 150 requests per attempt,
grader 120 s, concurrency 8, 3 repeats, one seeded randomized queue of (task, repeat) blocks holding one unit of each arm (blocks and
in-block order shuffled). Primary unit outcome legacy-valid (line-based detector incl. the 161605a Node-runner false-positive fix);
strict byte identity is a sensitivity; hidden tests never mounted for agents; full transcripts (main + orche sub-sessions), diffs,
test hashes, grades, resources captured and leak-scanned. Inference: ctrl-confirm-3 `stats.mjs` exact family sign-flip, one-sided
p < 0.025 on BOTH endpoints, interval by test inversion with the CI/decision agreement check; complete design required for
CONFIRMED; adoption rule of ctrl-confirm-2 (recommendation only, never a deployment). Analysis code: `analyze.mjs`.

## 2. Execution semantics added in ctrl-confirm-4 (fixed before any unit)

- Attempts: another attempt only after (i) zero completed model calls with an infrastructure status (max 1, unchanged) or (ii) a
  provider credit/auth/rate failure, recognised from the provider's own message (outcome-independent), max 2 such attempts per unit,
  not counted against (i). Everything else is final; no outcome-dependent retry. Primary analysis uses the final attempt; sensitivity
  scores every unit whose first attempt was provider-interrupted with that attempt (`analyze.mjs`).
- Resource management (`resources.mjs`, `run.mjs`): before every attempt a reservation (150 requests, 10 M input, 100 k output tokens,
  its API-equivalent cost, and an attempt time bound of 20 + 2 + 2 min) is persisted; dispatch only if consumed + reserved + this
  reservation stays within every ceiling, the active time plus the attempt bound stays within the active ceiling, and now plus the
  bound stays before the elapsed-wall deadline. Settlement records the actual usage from the proxy wire journal (requests started,
  tokens of completed responses; a request without usage is charged 96 k input / 4 k output) or, when nothing survives, the whole
  reservation. Active time = union of intervals with >= 1 attempt in flight; a crashed session's interval is closed at its last
  heartbeat + 60 s; the wall deadline is fixed once at the first launch. A ceiling, a provider failure, a route violation or 5
  consecutive infrastructure failures stop dispatch; attempts in flight drain and are recorded; rate-limit pauses may auto-resume after
  15 min idle (max 6); credit/auth/route pauses need the operator (same command). A ceiling reached ends the campaign: missing units
  are failures, H1 cannot be CONFIRMED (no extension, no optional stopping, no sample expansion). Interrupted attempts: surviving
  processes are stopped, wire evidence kept under `evidence/orphans/`, the attempt recorded from its wire journal (a completed model
  call = `aborted` failure, never redrawn). One runner per state (exclusive lock; a dead runner's lock is kept as evidence).
- Durable execution: `systemd-run --user` with `RuntimeMaxSec` = the elapsed-wall ceiling (`docs/ctrl-confirm-4-launch.md`).

## 3. Planning-scenario reconciliation (ctrl-confirm-3 A1) and the chosen design model

ctrl-confirm-3 named `scale:1` in `prereg.json` and the latent model at +3.9 pt in its document and gate code (A1). For ctrl-confirm-4
ONE interpretation is fixed now, before any new outcome:

- **Primary planning model: `latent:0.039`** — each simulated task's success probability is drawn from the posterior of a historical
  task's pooled difficulty (12 repeats); OCR = expit(logit p + beta) with beta giving a population E1 effect of +3.9 pt (the
  ctrl-confirm-2 point estimate). Reasons: (1) it is the model of ctrl-confirm-3's §8/§9 and gate code (the later, fully specified
  text); (2) it transfers to NEW tasks through their difficulty distribution, whereas `scale:s` places the effect on the specific
  historical tasks and uses their noisy observed differences as the true effect pattern (it folds the sampling noise of a 93-task
  estimate into effect heterogeneity, i.e. an assurance-type number); (3) sparse effects and repeat dependence are now modelled
  explicitly within the latent framework and reported (below).
- **Acknowledged optimism:** +3.9 pt is the estimate of the experiment that motivated this follow-up (95% interval [0.0, +7.7]); the
  true effect may be smaller. The design is powered only for an effect of about the historical size. Sensitivity (4 000 simulations,
  historical composition, `records/ctrl-confirm-4/plan/power-historical.json`): at N = 700, latent +3.0 pt 0.59, +2.0 pt 0.28,
  sparse (50% of families respond, same mean) 0.79; at N = 800: +3.0 pt 0.66, +2.0 pt 0.32. Designing for +2.0 pt would need
  N > 1 600 (0.62 at 1 600) - beyond any supply and budget of this phase. An INCONCLUSIVE result is absence of evidence, not
  evidence of no effect.
- **Required N:** smallest grid N (300…1 600; 650/700/750/800/850 included) whose H1 power - the exact preregistered decision rule,
  E1 AND E2, family sign-flip - has a Wilson 95% Monte Carlo LOWER bound >= 0.80 under `latent:0.039`, simulated with the REALIZED
  family-size composition of the sealed fresh batches (`power-realized.json`). Historical composition: N = 700 (0.824 [0.812, 0.836]);
  N = 650 0.780.
- Type-I / null checks (same rule): `latent:0`, `latent-od:0:0.2` (correlated repeats), `null:E2-only-null`, `null:E1-only-null`,
  `null:skewed-heterogeneous-E1`; values in `power-historical.json` (H1 <= 0.025 + MC error expected; the IUT is conservative).
  These checks cover specific generative models; they are not a proof of validity under every null.
- Composition: the realized family sizes (1-3 tasks per family, cap 3) replace the historical families in the gate simulation;
  difficulty transfers from the ctrl-confirm-2 calibration population (different repositories) - a limitation.

## 4. Tasks

- Collection phase 2 (`COLLECTION.md`, rules frozen 2026-11-07T18:30Z, cutoff 2026-11-08T01:00Z) into `results/ctrl-confirm-4-supply`
  plus the reused ctrl-confirm-3 batch. Assembly `assemble.mjs`: ctrl-confirm-2/3 exposure audit codes, consumed roots (ctrl-confirm-2
  supply + holdout, ctrl-confirm-3 supply, agent_workflow pools and their import copy), the reused batch as family/commit/content
  guard, the cutoff, conflict review (rule of ctrl-confirm-2), engine grader validation, candidate-blind seeded selection with
  family <= 3 and owner <= 6 counted ACROSS the reused batch. New sealed batch under `results/ctrl-confirm-4-holdout/` (0 uses).
- agent_workflow (`/home/arthur/Code/agent_workflow`, read-only): its two pools were imported byte-for-byte with a hashed manifest
  (`records/ctrl-confirm-4/import/aw-import-manifest.json`): 79 cases, 0 independent-holdout eligible (17 authored-private, 13
  public-benchmark exercism, 11 agent-exposed, 26 lineage of the used external pool, 12 source-rejected). They are quarantined for
  train/pilot/smoke use only and never enter a confirmation.
- Design selection (if the gate passes): N_req tasks from the union of fresh sealed batches by sha256('ctrl-confirm-4/design:'+id)
  order with the same caps; filled into `prereg.json` `holdout` by amendment BEFORE the final gate evaluation and launch.

## 5. Ceilings (finite; user-approved scope 2026-11-07) and cost

| | ctrl-confirm-3 | ctrl-confirm-4 |
|---|---|---|
| requests (all attempts) | 45 000 | 210 000 |
| active hours (>= 1 attempt in flight) | 16 | 52 |
| elapsed wall from first launch | 30 h | 120 h |
| input tokens (incl. cached) | - | 3.4 B |
| output tokens | - | 32 M |
| API-equivalent cost | - | $300 |

Plan at N = 700 / 800 (ctrl-confirm-2 measured per-unit rates of OC/OCR/PCR, all attempts): 146 729 / 167 690 requests, 35.6 / 40.7
active h, 2.32 B / 2.65 B input tokens (89% cached), 21.6 M / 24.6 M output; API-equivalent $56 / $64 with the measured cache
share, $62 / $71 if every uncached input token is billed as a 30-min cache write, $243 / $277 with no cache at all. Prices: OpenAI API
Standard gpt-6-luna $0.10 input / $0.01 cached / $0.125 cache write (30 min) / $0.50 output per 1 M tokens (official pricing pages
retrieved 2026-11-07). The route is CLIProxyAPI; actual billing of the upstream account is not verified and may differ. The gate
requires plan x 1.2 within every ceiling; the ceilings support N up to ~830.

## 6. Feasibility gate (`gate.mjs`)

Launch only if (a) N_req exists (§3), (b) sealed fresh external tasks >= N_req, (c) requests, (d) active hours, (e) tokens and (f)
API-equivalent cost of N_req x 1.2 are within the ceilings. The gate record binds this file's digest, the power file's sha256 and
configuration digest, every batch's seal digest and use count, and the realized composition. Failed gate: no confirmation unit;
batches stay unused; the blocker is reported.

## 7. Realized supply and gate result

(appended as an amendment after sealing, before any agent run)

## Amendments

### A1 — §7 realized supply, design selection and gate (2026-11-08T02:35Z, W7; before any ctrl-confirm-4 agent run)

- Collection phase 2: started 18:25:58Z, cutoff 2026-11-08T01:00:00Z (respected; no repository started after it; units stopped by
  01:01:07Z). Plan A 2 740 repositories (834 excluded before cloning: 832 touched by ctrl-confirm-3, 2 by agent_workflow pools), plan B
  (new keywords, frozen 20:07:59Z) 2 656 of 3 828 discovered (1 172 excluded). Started: A 2 740 / B 2 327; 1 interrupted repository
  (collector 11 died at 19:37:09Z on an EACCES while removing a repository test's scratch directory; restarted 20:32:47Z before the
  cutoff, the interrupted repository recorded and not re-processed, `COLLECTOR_EVENTS.txt`). Registry entries 7 421; eligible records
  763 at <= cutoff, 2 after the cutoff (retained, not counted). Hashes: `results/ctrl-confirm-4-supply/REGISTRY_HASHES_AT_CLOSE.sha256`.
- Assembly: 763 audit-clean (0 hits against 30 consumed pools / 4 sealed holdouts: 742 repositories, 149 families, 2 695 commits,
  1 295 content hashes, incl. the reused batch); conflict review (`records/ctrl-confirm-4/holdout/conflict-review.json`): 24
  regex-flagged and all 232 test-mentioning instructions screened, 62 read, 9 conflicts excluded; engine grader validation excluded 5;
  24 eligible not selected (family <= 3 / owner <= 6 counted across the reused batch). New batch
  `ctrl-confirm-4-holdout-9678d4a6a0da` (725 tasks, 399 families, seal `a698916e…`, 0 uses).
- Withdrawn before any use: `ctrl-confirm-4-holdout-46ca85d00b77` (seal `b59b4fd1…`, 520 tasks). A copy of the conflict review had
  been placed under `pi-eval-loop/records/` (read by the exposure scan) before sealing, so all 232 test-mentioning candidates were
  excluded as "named in earlier records" by their own review (232/232 identical). The batch is kept unchanged with
  `…46ca85d00b77.WITHDRAWN.json`; the re-seal used the same frozen candidates, rule, seed and caps.
- Union of fresh batches: 884 tasks, 484 families (no shared family or id; max 3 per family, 6 per owner); ctrl-confirm-3 batch seal
  and 0 uses re-verified.
- Power with the realized composition (`records/ctrl-confirm-4/plan/power-realized.json`, 4 000 simulations; family sizes of the
  884-task union): `latent:0.039` N = 650 0.785 [0.772, 0.797], **N = 700 0.824 [0.811, 0.835] -> N_req = 700**. At N = 700:
  latent +3.0 pt 0.585, +2.0 pt 0.274, sparse 50% / 25% of families 0.791 / 0.733, correlated repeats (rho 0.2) 0.789, `scale:1`
  0.468; nulls (latent 0, latent-od 0, E1-only, E2-only, skewed) 0.004-0.023 over N 500-850. A first realized-composition run
  replicated tasks cyclically within families, which shifted the calibrated population effects (E1-only null had +0.8 pt E1); it is
  kept as `power-realized.DEFECTIVE-cycled-composition.json` and replaced by size-biased family / uniform task sampling (test asserts
  the population effects).
- Design selection (`records/ctrl-confirm-4/plan/design-selection.json`): 700 tasks, 439 families (124 from the reused batch, 576
  new) in sha256('ctrl-confirm-4/design:'+id) order with the same caps; `prereg.json` `holdout` filled. The design subset has more
  single-task families than the union whose sizes were simulated (more independent families: the power figure is not optimistic on
  this account). A launch records ONE use in EACH batch (batch-level semantics): the 35 + 149 unselected tasks become unusable too.
- Gate: see `records/ctrl-confirm-4/plan/gate.json` (evaluated after this amendment, bound to the final `prereg.json` digest).
- Nothing was launched. A confirmation launch is the user's decision (`docs/ctrl-confirm-4-launch.md`).
