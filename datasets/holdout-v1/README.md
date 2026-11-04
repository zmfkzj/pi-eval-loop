# holdout-v1 (sealed)

Seven fresh coding tasks in seven families (tiers: 1 easy, 3 medium, 3 hard) used ONLY for the final holdout evaluation of
pi-eval-loop. Each task has `repo/` (the only part an agent sees), `hidden/` (grading tests, copied into a disposable grading
copy inside the sandbox) and `reference/` (the solution used to validate the grader: the original repository must fail and the
reference must pass).

Provenance: written by the implementing agent for this dataset before any optimization run (`provenance:
implementer-authored-sealed-before-search`). They were never used by earlier orche experiments (exposure scan), are never mounted
into the optimizer's sandbox, and the optimizer never receives their instructions, results or failure details. They are not an
externally curated benchmark: the author also built the loop, which is a recorded limitation.

`SEAL.json` holds the sha256 of every file; the loop refuses the holdout when any file differs. `USES.jsonl` is the
hash-chained use ledger: a use is appended before the first holdout run of a final evaluation; after `holdout.maxUses` (1) uses the
set is no longer independent and cannot back an adoption.
