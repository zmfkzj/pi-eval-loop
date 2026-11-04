# Status of `abc-real-1`: TRUNCATED EXPLORATORY EVIDENCE (immutable)

Added 2026-11-04 by the follow-up correction. Every other file in this directory is the original artifact of the run and is kept
byte-for-byte (ledgers, archive, generated `report.md`/`ablation.md`, the locked protocol `protocols/abc-real-1.json`). This file
is the only addition. It does not change any measurement.

## Why it is truncated

- The protocol override capped each search trajectory at **4 candidates because of the implementing session's wall time**
  (`protocols/abc-real-1.json`). The user forbade low optimization limits motivated by cost or time. A boundary bug then left the
  4th candidate of each trajectory unevaluated, so **only 3 candidates per arm were evaluated** (B-c001..c003, C-c001..c003).
- The search therefore never reached its pre-registered stopping rule (10 consecutive candidates without meaningful progress).
  This run is **not** a completion of the requested quality-first search. It is exploratory evidence only.
- The continued, compliant search is `explore-real-2` (`records/explore-real-2/`, `docs/results-explore-real-2.md`): a clean
  start under protocol-2, train/dev only, with the consumed holdout neither loaded nor used.

## Errata for the generated reports in this directory (raw records unchanged)

1. **Rates.** The generated reports print the Monte Carlo posterior mean of the task-level bootstrap as "Q_overall". The exact
   empirical rates of the committed counts are: stable dev 37/48 = **77.0833%**, pure Pi dev 43/48 = **89.5833%**, multi3 dev
   46/48 = **95.8333%**, C-c001 dev 38/48 = **79.1667%**, B-c001 dev 37/48 = **77.0833%** (identical to stable; the "77.1% vs
   77.0%" shown for B-c001 was bootstrap noise), stable holdout 15/21 = **71.4286%**, C-c001 holdout 13/21 = **61.9048%**.
   protocol-1 also used the Monte Carlo mean as the development point for the Pareto front and selection; protocol-2 uses exact
   plug-in points.
2. **multi3 is not an equal-compute control.** It allows up to 3 independent pure-Pi attempts per unit and submits the first one
   whose visible tests pass. In this run it used **exactly 1 attempt in all 48 dev units** (432 model requests, 1.42 M input
   tokens), while stable orche used 917 requests and 8.00 M input tokens on the same units. multi3 is therefore a second,
   independent single-attempt sample of pure Pi, not a compute- or opportunity-matched baseline for orche. The 46/48 vs 43/48
   difference is between two samples of the same configuration.
3. **Integrity and C-c001.** Every mechanically detected violation in this run is a **task-agent** workspace violation: the agent
   changed or removed lines of an existing test file (mostly reformatting one-line minified test files while adding tests). No
   leak attempt, route violation, harness crash or **harness-candidate patch** violation occurred. Each such run already counts as
   a task failure. protocol-1 made them critical only when the candidate had MORE violating runs than its reference in the same
   scope, and the development check ignored the candidate's own development-train runs. C-c001 had 3 violating runs in its
   screening batch (the parent stable had at least as many), 5 on dev (stable 5) and 2 in its development-train runs (unchecked),
   so it reached selection; on the holdout it had 8 vs 4 and was BLOCKED. Under protocol-2 any such run is critical regardless of
   the baseline, so C-c001 would have been rejected at screening. The stable harness itself has violating runs (dev 5/48,
   train 6/33, holdout 4/21); it is the incumbent, not a promoted candidate.
4. **Holdout.** `holdout-v1` is implementer-authored and was used once here (`datasets/holdout-v1/USES.jsonl`). It is no longer
   independent, must not be reused for tuning, and was not shown to any later optimizer.
