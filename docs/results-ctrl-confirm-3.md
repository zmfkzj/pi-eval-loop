# ctrl-confirm-3: corrected inference and feasibility-gated follow-up — BLOCKED at the preregistered gate

Preregistration: `experiments/ctrl-confirm-3/PREREGISTRATION.md` (+ `prereg.json`; amendments A1, A2). Records:
`records/ctrl-confirm-3/` (plan: power, gate; holdout: provenance, eligibility, conflict review, supply stop record).

Status: **BLOCKED — no confirmation run.** The feasibility gate, fixed before any outcome, failed; no ctrl-confirm-3 agent unit was
dispatched (0 units, 0 model requests; no run state, lock or ledger exists). Adoption status stays **KEEP_STABLE**. ctrl-confirm-2
(INCONCLUSIVE / KEEP_STABLE) and ctrl-ablation-1 verdicts are unchanged.

## What was completed

- Corrected procedure (`experiments/ctrl-confirm-3/stats.mjs`): exact family-level sign-flip test (dynamic programming, no Monte
  Carlo) per co-primary endpoint, intersection-union over E1 and E2, interval by inversion of the same test; the decision uses only
  the exact p values, so interval and decision cannot disagree silently (checked and reported). Applied to the exposed ctrl-confirm-2
  data for illustration only: E1 +3.9 pt p 0.035, E2 +4.3 pt p 0.0625 (4 informative families) — consistent with INCONCLUSIVE.
- Power and size (`experiments/ctrl-confirm-3/power.mjs`, `records/ctrl-confirm-3/plan/`): every simulated experiment is decided by
  the analysis function. Planning effects are historical (ctrl-confirm-2), not new estimates. H1 power under the primary latent
  model at +3.9 pt: N=93 0.08, 300 0.40, 600 0.75, 800 0.86; at +2.0 pt N=2 400 0.81. Simulated size under the global null
  0.002-0.008 and under the partial / skewed nulls examined <= 0.025 + MC error. These are checks of specific generative models
  (independent repeats given the task probability, constant logit shift), not a proof of validity under every null.
- Fresh independent tasks: 159 tasks / 85 families sealed as `ctrl-confirm-3-holdout-4206b2e38c1d` (0 uses), excluding every
  consumed ctrl-confirm-2 repository, family, commit, case and content hash, and the pre-existing external pool. Collection was
  stopped early (session shutdown; recorded stop rule respected, no restart).

## Gate result (records/ctrl-confirm-3/plan/gate.json, gate-prereg-json-scale1.json)

| reading | N_req (power >= 0.80) | sealed | planned requests (ceiling 45 000) | active hours (ceiling 16) | launch |
|---|---|---|---|---|---|
| latent +3.9 pt (§9, gate.mjs) | 800 | 159 | 167 690 | 40.6 | no |
| scale:1 (prereg.json text) | 1 600 | 159 | 335 381 | 81.3 | no |

The budget alone blocks the run regardless of supply: the largest affordable N is 214 tasks (power ~0.26 under the primary model).
Running the 159 sealed tasks (~33 300 requests) would be an underpowered run (power 0.08-0.24) and is not labelled or run as a
confirmation.

## What would be needed (not authorized here)

A separately approved budget of roughly 170 000 requests and ~41 active hours at concurrency 8 (or a cheaper per-unit route, which
would be a different experiment), about 800 fresh sealed tasks, and the runner prerequisites of §9 (active-time accounting and
persisted per-unit request reservations) implemented and tested before launch.
