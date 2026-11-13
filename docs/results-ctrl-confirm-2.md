# ctrl-confirm-2: prospectively registered confirmation of the test-preservation rule (independent external holdout)

Preregistration: `experiments/ctrl-confirm-2/PREREGISTRATION.md` (+ `prereg.json`, digest `c57de714…`). Records:
`records/ctrl-confirm-2/` (holdout provenance/eligibility, plan, smoke, confirmation lock/queue/ledger/analysis). Full evidence incl.
every transcript: `state/ctrl-confirm-2/evidence/` (git-ignored).

Status of this document: **COMPLETE** (fixed sample 1 116 / 1 116 units, all dispatched inside the 14 h wall ceiling; the start
section was written at launch, the resumption and result sections after the last unit).

## What this experiment is (and is not)

- A NEW prospectively registered experiment. ctrl-ablation-1 selected no viable candidate under its (flawed) preregistered rule and
  stays KEEP_STABLE; nothing here re-decides or rescues it.
- Corrected endpoint: co-primary E1 valid-success rate and E2 reliable success (share of tasks with all 3 repeats valid);
  inconsistency I is descriptive only.
- Primary scoring: the historical line-based integrity detector (incl. the 161605a false-positive fix), identical for all arms;
  strict byte identity is a secondary sensitivity scoring.
- Every arm gets the same disclosed baseline integrity contract in the task; the candidate adds only the stricter
  test-preservation rule to every orche session. OCR - OC therefore measures an instruction effect inside orche (a deployable prompt
  change), not a harness capability; OCR - PCR is the matched-instruction harness comparison.

## Holdout

- 93 tasks, 54 families (upstream repositories), 51 accounts: real upstream commits (2026-04-27 .. 2026-11-05) of public npm
  packages (MIT 85, BSD-3-Clause 5, Apache-2.0 3), collected model-free into `results/ctrl-confirm-2-supply/` with the loop's own
  supply code, repositories disjoint from the pre-existing external pool (read-only check), the orche suite, bundled datasets and
  earlier records. Exposure audit, conflict review and engine grader validation: 93/93 clean (`records/ctrl-confirm-2/holdout/`).
- Sealed batch `results/ctrl-confirm-2-holdout/ctrl-confirm-2-holdout-3e83b1b2af67`, seal `1dbe7180…`; its single use was recorded in
  its `USES.jsonl` at 2026-11-06T13:57:31.888Z, before the first unit.
- Limitation: public code; absence from pretraining data is not established. Size-proxy tiers are not difficulty claims.

## Start evidence

- Run `ctrl-confirm-2`, state `pi-eval-loop/state/ctrl-confirm-2`, launched 2026-11-06T13:51:21Z (grader validation 93/93), lock
  written 13:57:31.882Z, first unit result 13:57:32Z; 1 116 units (93 x 4 arms x 3 repeats), concurrency 8, randomized interleaved
  queue (digest `7f9d9fd8…`), environment digest `f5ce1410…` (same as ctrl-ablation-1), route `cliproxyapi/gpt-6-luna` medium.
- Lock copy: `records/ctrl-confirm-2/confirmation/lock.json` (45 locked files, harness trees, task and instruction digests).
- Checkpoint: `state/ctrl-confirm-2/campaign.json` after every unit (done/unsettled/in-flight, requests, terminal-status counts, no
  success counts). Resume after any interruption (same frozen order, exactly-once ledger, infra-only retry):

  `node pi-eval-loop/experiments/ctrl-confirm-2/run.mjs --state /home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/ctrl-confirm-2 --dataset /home/arthur/Code/oh-my-pi-extensions/results/ctrl-confirm-2-holdout/ctrl-confirm-2-holdout-3e83b1b2af67`

- Analysis once complete: `node pi-eval-loop/experiments/ctrl-confirm-2/analyze.mjs --state pi-eval-loop/state/ctrl-confirm-2` and
  `node pi-eval-loop/experiments/ctrl-confirm-2/fidelity.mjs --state pi-eval-loop/state/ctrl-confirm-2`.

## Result

### Run history (resumptions under the frozen policy)

- Invocation 1 (13:51:21Z launch, lock 13:57:31Z): ended by SIGTERM at 14:52Z when the operating Pi session shut down (not a
  campaign pause). 181 results; 8 dispatched attempts had no result.
- Invocation 2 (2026-11-06T22:48:20Z, same frozen resume command, lock re-verified: 45/45 locked files, harness trees, queue digest
  and holdout seal unchanged; holdout use re-recognized, not re-recorded): the 8 interrupted attempts were reconciled from their wire
  journals by the evaluator (`Evaluator.reconcile`) as `aborted` (14-65 completed model calls each; 298 requests), never redrawn;
  the 370 pre-resume ledger lines stayed byte-identical. At 02:31:55-02:33:37Z the configured provider briefly reported credit
  exhaustion (`auth_unavailable ... credit_balance_exhausted`): 6 units ended `model_error`, then 3 units `route_violation`
  ("1 refused off-route request, 0 off-route responses": the route guard refused, nothing off-route answered). The runner paused
  on the route violation as preregistered (§9) and exited at 02:37:31Z with 183 units never dispatched.
- Pause investigation (metadata only, before any outcome was opened): units dispatched during the window kept running and ended
  `completed` on the configured route up to 02:37Z, so the exhaustion was transient and no evaluator defect existed.
- Invocation 3 (02:47:08Z, same command): dispatched the remaining 183 units; last dispatch 03:56:08.5Z, before the wall
  ceiling 2026-11-07T03:57:31.903Z (startedAt + 14 h, downtime included); the in-flight units drained by 04:00:25.6Z
  (frozen semantics: dispatch stops at the ceiling, running units finish). Active runtime of the resumption 5 h 02 min;
  campaign wall to the last result 14 h 02 min.
- Per-attempt operator log: `state/ctrl-confirm-2/supervision.log` (copy in `records/ctrl-confirm-2/confirmation/`).

### Integrity before analysis

`records/ctrl-confirm-2/confirmation/integrity-audit.json` (`integrity-audit.mjs`, outcome-blind, run before the analysis):
lock copy identical, 45/45 locked file digests, OC/OCR harness tree digests, queue digest, seal and exactly one holdout use (this
state) verified; run-ledger chain intact; 1 116 dispatches / 1 116 results, one result per attempt, 0 redraws, 0 outstanding units;
every record on `cliproxyapi/gpt-6-luna` medium with the locked protocol and environment digests; infrastructure-only rate 0 / 1 116
(ceiling 10%: not compromised); 3 critical statuses (the route violations above: OC 1, PCR 2, OCR 0); requests 22 232 / 40 000.

### Result (preregistered analysis: `records/ctrl-confirm-2/confirmation/analysis.md`, `analysis.json`)

- Complete design, 1 116 / 1 116 units, intent-to-evaluate (every non-success, incl. the 8 reconciled aborts, 9 provider-window
  failures and 3 earlier model errors, is a failure; none is infra-only, so the sensitivity excludes 0 units).
- **Primary OCR - OC (legacy-valid): INCONCLUSIVE.** E1 valid-success rate OCR 30.1% (84/279) vs OC 26.2% (73/279): +3.9 pt,
  95% CI [+0.4, +7.8], one-sided p 0.034; E2 reliable success 22/93 vs 18/93: +4.3 pt [+1.0, +9.0], one-sided p 0.065. Both lower
  bounds are above 0, but neither one-sided p is below the preregistered 0.025, so the intersection-union rule does not confirm.
  This is absence of confirmatory evidence, not evidence of no effect.
- **Adoption: KEEP_STABLE** (primary INCONCLUSIVE). Also recorded: family regressions OCR < OC in 2 families
  (`gh:ahmtsahin/agent-context-bench`, `gh:codyrobertson/gh-issue-lease`). Nothing is deployed and no default changes.
- Strict sensitivity (byte identity of original tests): OCR - OC E1 +16.1 pt [+9.5, +23.6], E2 +11.8 pt [+5.9, +18.7]; strict test
  violations OCR 33 vs OC 125 units (secondary scoring, not the primary decision). Functional (no integrity condition): +3.9 pt
  [+0.4, +8.0].
- Secondary (legacy, Holm over 6): OCR - PCR, PCR - PC, OC - PC all adjusted p = 1.0. Interaction on E1 +5.4 pt (descriptive).
- Arms: PC 28.3% (79/279, 20/93 reliable), PCR 26.9% (75/279, 20/93). Leak hits: PCR 1 unit, others 0. Harness crashes 0.
- Resources (all attempts): 22 232 requests (OC 8 578, OCR 8 219, PC 2 738, PCR 2 697), input tokens 335.3 M (cache 296.7 M),
  output 3.23 M, unit wall 42.8 h; the 8 reconciled attempts add 298 requests whose tokens/wall time were not recoverable
  (`Evaluator.reconcile` records requests only).
- Fidelity (`records/ctrl-confirm-2/confirmation/fidelity.json`): PC 279/279, PCR 279/279, OCR 275/279, OC 274/279. All OCR and 4
  of the 5 OC failures are the 8 reconciled attempts, which carry no `evidence_dir` (their partial evidence holds only events and
  stderr: `orphan-fidelity.json`, 0/8 verifiable); 1 OC failure is a `route_violation` unit (0 model calls, never delegated).
  Every other unit passed (contract in every task message, rule only in OCR/PCR). Unverifiable units were not excluded.

### Limits

- Public upstream code: absence from pretraining data is not established.
- The 9 provider-window failures (OC 4, OCR 2, PCR 3, PC 0) and 3 earlier model errors are scored as failures by the frozen
  classification (they are not infra-only: model calls had completed or a route violation was recorded); no post-hoc exclusion.
- The campaign was interrupted once by the operating session (7 h 56 min downtime) and paused once by the route guard; both
  resumptions used the frozen command and order, and the downtime counted against the 14 h ceiling.
