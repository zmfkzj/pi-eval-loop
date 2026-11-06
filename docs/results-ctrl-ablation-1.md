# ctrl-ablation-1: controlled ablation of pi-orche (discovery)

Preregistration: `experiments/ctrl-ablation/PREREGISTRATION.md` (+ `prereg.json`, amendment A1). Records:
`records/ctrl-ablation-1/` (ledgers hash-chain verified, lock, frozen queue, analysis, fidelity, power). Full evidence including
every session transcript (main, orche workers, sub-workers): `state/ctrl-ablation-1/evidence/` (git-ignored, 704 MB).

**Verdict: KEEP_STABLE (INCONCLUSIVE for adoption).** No arm met the preregistered viability rule, so no candidate was locked and
no confirmation was run. Discovery tasks are exposed; every number below is exploratory.

## Execution

- 810/810 units (10 arms x 27 suite tasks x 3 repeats), randomized blocks (task, repeat) with shuffled arm order, one queue,
  6 parallel units; 2026-11-06 02:15-06:30 UTC; no pause, 0 infrastructure failures, 0 timeouts, 2 `agent_error` (150-request
  ceiling: T1 and V2 on p1-ticket-batch).
- Route `cliproxyapi/gpt-6-luna` medium for all 810 units; one environment digest `f5ce1410...`; no seed (provider has none).
- Model requests 16 111 (ceiling 45 000); smoke 117 + 123.
- Fidelity from captured transcripts: 81/81 units per arm realized the intended intervention (`fidelity.json`).

## Preregistered primary results (valid = completed, hidden pass, visible not failed, no legacy/strict integrity violation, no leak)

Strict byte identity changes the estimand relative to the historical runs; see the estimand section before comparing with them.

| arm | valid /81 | functional /81 | integrity fail | 3/3 tasks | 0/3 tasks | I | requests |
|---|---|---|---|---|---|---|---|
| S (stable orche) | 18 | 65 | 52 | 4 | 18 | 0.062 | 1954 |
| B0 (pure Pi) | 44 | 66 | 22 | 11 | 9 | 0.086 | 749 |
| P1 (orche + test rule) | 63 | 66 | 4 | 17 | 3 | 0.086 | 1866 |
| P2 (no "update tests") | 22 | 67 | 49 | 4 | 17 | 0.074 | 1912 |
| P3 (pure Pi + test rule) | 69 | 69 | 0 | 22 | 3 | 0.025 | 723 |
| D1 (direct, no delegation) | 50 | 68 | 21 | 13 | 7 | 0.086 | 841 |
| D2 (verbatim hand-off) | 25 | 70 | 48 | 5 | 14 | 0.099 | 1812 |
| T1 (worker tools = Pi) | 20 | 67 | 52 | 5 | 19 | 0.037 | 1731 |
| V1 (no verifiedBy) | 19 | 70 | 53 | 2 | 16 | 0.111 | 1852 |
| V2 (mandatory verifier) | 18 | 66 | 51 | 3 | 18 | 0.074 | 2671 |

Paired task contrasts vs S (dValid pt, task-cluster bootstrap 95% CI, Holm p): P1 +55.6 [+38.3, +71.6] p<.001; D1 +39.5
[+24.7, +55.6] .002; D2 +8.6 [+2.5, +16.0] .16; P2 +4.9 [-4.9, +14.8] 1; T1 +2.5 [-3.7, +11.1] 1; V1 +1.2 [-6.2, +9.9] 1; V2 0.0
[-6.2, +7.4] 1. P3-B0 +30.9 [+16.0, +46.9]; B0-S +32.1 [+16.0, +49.4]. Functional point differences vs S are +1 to +6 pt with
95% CIs within [-9, +14] pt: functional improvement was not demonstrated (nor equivalence). Full tables: `records/ctrl-ablation-1/discovery/analysis.md`.

Viability (dValid >= 3.7 pt, lower bound > 0, dI <= 0, integrity <= S, no leak/critical): P1 and D1 meet every clause except
dI <= 0 (+0.025 each); all others fail the success clauses. Locked candidate: none.

## Estimand change: strict byte identity vs the historical detector

The primary integrity rule (preregistered) is the original line-based detector PLUS byte identity of every original test file.
This does not relax integrity, but it is a different, stricter estimand than abc-real-1 / explore-real-2 (line-based detector
only): appending a test to an existing file, reformatting it or renaming a test is a failure here and was not there. S = 18/81
is therefore NOT comparable with the historical 37/48 and is not evidence that stable orche regressed.

Post-hoc sensitivity (NOT preregistered; no viability, lock or adoption decision uses it), same 810 records, both decisions
retained per unit (`integrity.legacyViolations`, `integrity.strictTestViolations`, `integrity.leakHits`), so nothing is
reconstructed: `records/ctrl-ablation-1/discovery/posthoc-sensitivity.{md,json}`
(`experiments/ctrl-ablation-plan/sensitivity.mjs`). "Legacy" = the current line-based detector incl. the 161605a Node-runner-name
false-positive fix (the historical runs used the detector without that fix; the fix only removes false positives).

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

Counts are records, not violation messages; strict-only = strict violation without a legacy violation or leak. Valid loss
from the strict rule = strict-only records that were functionally successful (S: 39 - 3 = 36 = 54 - 18). strict-valid equals
`metrics.successOf` on all 810 records (0 mismatches); the script refuses records without retained decisions or an incomplete design.

No unit failed the legacy rule without also failing the strict rule (legacy-only = 0 everywhere); leak hits 0 in every arm. Legacy-scored paired
contrasts vs S (post-hoc, unadjusted, task-cluster bootstrap 95% CI): P1 +14.8 [+2.5, +29.6]; D1 +9.9 [+1.2, +19.8]; D2 +8.6
[+1.2, +16.0]; B0 +9.9 [-2.5, +23.5]; P2 +7.4 [-2.5, +17.3]; V1 +3.7 [-6.2, +12.3]; T1 -1.2 [-12.3, +9.9]; V2 0.0 [-8.6, +8.6].
On the 16 former dev tasks only, legacy-valid is S 36/48 and B0 42/48 (historical: 37 and 39 vs 43 and 42) — orientation only,
not a replication test (different time, randomized interleaving, detector fix).

## Interpretation (randomized discovery; exposed tasks; exploratory)

- Measured: under both scorings most valid-success differences come from integrity failures. Functional success is 65-70/81 in
  every arm and functional contrasts vs S have 95% intervals of roughly -9 to +14 pt: a functional improvement was NOT
  demonstrated, and equivalence was not shown either (the intervals allow differences of several points both ways).
- Trace-supported mechanism: 100% of strict violations are explicit `edit`/`write` (2 `bash`) calls on an original test file in
  the captured transcripts, by the orche worker in delegating arms and by the main session in B0 and D1; P1 still had 4 worker edits.
- Randomized (within this task set) effects of each intervention as realized:
  - P1 (stated test-preservation rule in every orche session): large reduction of integrity failures under both scorings.
  - D1 is a BUNDLE, and its effect is the effect of the bundle, not of delegation alone. Versus S, D1 changes at once: no
    hand-off and no worker sessions; the main prompt becomes orche's direct-mode prompt (3.3k chars, no "add or update tests",
    no task_plan / checklist / `verifiedBy` demands) instead of the single-mode main prompt (18k chars) plus the implement-worker
    prompt; the editing session gets orche's 10 tools (read, grep, find, ls, edit, write, ast_search, ast_rewrite, diagnostics,
    bash) instead of the worker's; one session instead of two contexts. Which component matters is not identified.
  - P2, D2, T1, V1, V2 each change one element and none reduced strict failures materially (48-53 vs 52). Isolation limits: D2
    keeps the fixed `R1:` line so `verifiedBy` enforcement stays (it changes the hand-off text, not the checklist mechanism);
    T1 keeps orche's bash wrapper and task_plan/orche_spawn/report_result; V2 adds sub-worker sessions charged to the same
    ceiling (one V2 and one T1 unit hit the 150-request ceiling: the 2 agent_error units). Absence of an effect here is not proof of no effect.
- Not established: that delegation per se causes test edits; that any variant improves functional success; any effect outside
  these 27 exposed tasks.

## Design flaw in the preregistered consistency gate (acknowledged, not corrected retroactively)

I = mean k(r-k)/(r(r-1)) is symmetric in success and failure: a task that always fails (0/r) scores I = 0, the same as one that
always succeeds. As a hard survival gate (dI <= 0) it can reject an arm that turns consistent failures into reliable successes:
S has 18 strict 0/3 and 4 3/3 tasks, P1 has 3 and 17; P1 still fails dI <= 0 (+0.025) because it has more mixed tasks; D1 likewise. This
misaligns the gate with the user's objective (reliable SUCCESS). The preregistered decision stands: no candidate locked, no
confirmation, KEEP_STABLE.

Prospective correction proposal (for a NEW preregistration only, unconfirmed): replace the I gate with a reliable-success
endpoint, e.g. co-primary (a) dValid and (b) d share of tasks with r/r valid successes (or the unbiased per-task estimate of
p^r, k(k-1)(k-2)/(r(r-1)(r-2)) for r = 3), both required to have 95% lower bounds > 0; report I and 0/r counts descriptively; size
it with the pilot-calibrated simulation of `experiments/ctrl-ablation-plan/power.mjs` adapted to that endpoint, on a sealed,
unused, external holdout.

## Limits

- The strict rule (any byte change of an original test file) was not told to S/B0/P2/D*/T1/V*; some tasks ask for test work
  (b5-ctx-migration: "Update visible tests ..."). Much of the P1/P3 gain is compliance with the evaluator's criterion once it
  is stated; it is not a functional improvement.
- Confirmation was not possible in any case: no eligible unused external holdout batch exists in the supply pool (status:
  b20261105T082536Z has no accepted hard stratum; b20261105T093919Z used), the pool lives outside this workspace, and
  `datasets/holdout-v1` is consumed and implementer-authored. `power-P1.json` (pilot-calibrated hierarchical simulation) shows
  the valid-success contrast alone would be easy to confirm (power ~1 at 30 tasks x 3) while the I-based co-primary has power
  <= 0.39 even at 240 tasks x 6.

## Operational effects of the infrastructure edits

- Changed evaluator files: `src/integrity.mjs` (new `strictTestIntegrity`, opt-in) and `src/runner.mjs` (opt-in
  `--append-system-prompt`, all-transcript capture/leak scan, strict rule; default behaviour unchanged when the protocol does not
  set `capture`/`integrity.strictTestFiles`). New: `experiments/ctrl-ablation*/`, `test/ctrl-ablation.test.mjs`. Uncommitted.
- Loop states lock evaluator digests, so they refuse to resume on a changed evaluator ("evaluator file changed", by design):
  `state/aw-scheduled` (protocol-3, locked at pi-eval-loop 5c0acf9) now differs in `integrity.mjs` (already by 161605a) and
  `runner.mjs` (this experiment); `abc-real-1` and `explore-real-2` were already 18 and 24 files away before this experiment.
  No lock or historical state was edited to silence this; all historical states and records are untouched.
- Live pi-orche and its defaults are unchanged (`git -C orche status` clean; variants live only in
  `state/ctrl-ablation-1/harness/`).
- Reproducible historical replay: export the pinned evaluator into a separate directory (`git -C pi-eval-loop worktree add
  <dir> 5c0acf9` for aw-scheduled; `git -C <umbrella> archive a01b074|38cbee5 pi-eval-loop` for abc-real-1 / explore-real-2),
  copy the state there and run that evaluator; never bypass or rewrite locks.
- ctrl-ablation-1's own lock still matches every locked file (0 mismatches over 45 files).
