# Internal promotion track (2026-11-13; opt-in `screening.internal`)

Status: implemented and tested with **simulated** backends only (`test/internal-promotion.test.mjs`). It is not activated
anywhere. The consumer (agent_workflow) owns the live config, ledger, runtime, schedules and proposer. Assumed daily-use model:
`gpt-6.1-terra` (user statement), so the target route of a live config stays `cliproxyapi/gpt-6.1-terra` (medium).

## 1. What it is, and what it is not

The track is an **operational** improvement loop for the internal *evaluation stable*: the harness tree the next screening
cycle uses as its stable arm. What it is not:

- It does not do research confirmation. It never produces `ADOPT`, a confirmatory claim or confirmatory-1 evidence.
  `studies/confirmatory-1` (protocol v1-v3, readiness, owner/hard quotas, 144+144) and the `autonomous` lifecycle are unchanged.
- It does not deploy to a service. It moves only the pointer in `<internal.dir>/eval-stable` (a `Releases` store). Putting a
  release into daily use is a separate, explicit consumer step. Every final says `serviceDeployment: "none"`.
- Its evidence is not proof of broad generalization. The labels are:
  - `development`: the reusable dev/regression tasks. Their scores are adaptively selected evidence.
  - `internal-acceptance`: one fresh, exploration-eligible batch per promotion decision.

  The decision rules are **operational and unvalidated**. The config must state `policy: "operational-unvalidated"`.

Without the section, plain `mode: "screening"` behaves exactly as before. Registration order, holdout and caps are unchanged;
the screening and lifecycle tests still pass.

## 2. Lifecycle (one action per cycle; `bin/eval-loop-explore.mjs --resume`)

1. **smoke + dev.** The screening stages run unchanged. Dev is a paired, interleaved, same-route comparison against the current
   evaluation stable on the frozen dev tasks. The rule is `minNetSuccesses` plus no candidate integrity violation; integrity is
   never loosened. The result is a `development` label.
2. **Waiting.** Qualified candidates wait for a fresh batch without any model call.
   - When `maxWaitingQualified` candidates are waiting, no further dev is paid for: the cycle waits with `supply-empty`.
   - Preflight reports `screening.internal.candidateDemand.wanted: false`. This is the consumer gate for paid proposals.
3. **Acceptance.** The qualified candidate with the best dev net (`select: "best-dev-net"`) gets ONE pass on ONE fresh batch.
   - The pass is the screening holdout stage, unchanged: exploration eligibility, one use, lineage, evidence re-check,
     interleaving and caps.
   - Before anything is claimed, `stageFit` must show that `2 x tasks x repeats x attemptsPerUnit.acceptance <= caps.holdout`.
     Otherwise the cycle stops with `prerequisite-failed` and the batch is not consumed.
   - Admission also requires route headroom for the assessment that follows (`caps.holdout + caps.dev`).
4. **Promotion.** Only a completed pass with verdict `EXPLORATORY_SUPPORTED` and zero candidate integrity or strict violations
   promotes the candidate.
   - The promotion is a CAS on the evaluation-stable pointer against the stable digest **and the history record** the pass
     measured (`Releases.adopt` `expectSeq`).
   - A moved pointer, including A -> B -> A, is recorded once as `STALE_BASELINE`. The result is never applied to another stable.
   - The promotion record carries the assessment obligation (`assessBy`).
5. **Assessment.** This is the first action of the next cycle. The promoted arm runs against the previous stable on the
   regression (dev) tasks, under its own key (`assess:<digest>`) and `caps.dev`. The decision:
   - **KEEP** only for a complete pass with no critical problem and net >= 0.
   - **ROLLBACK** otherwise: a critical problem, net < 0, incomplete pairs or infrastructure-only units.
   - **ROLLBACK_UNASSESSED** without a model call when the deadline has passed, the assessment cannot fit its cap or headroom,
     or the regression tasks became unusable.

   An interrupted assessment resumes. A runtime or credential wait is model-free and retried until `assessBy`; after that it
   rolls back. A promotion is never left standing unassessed.
6. **Rollback.** Rollback is a CAS through `Releases.rollback({ exact: true })`. Only the adoption record itself can be rolled
   back, not a later record that reached the same bytes again. Manual rollback:
   `eval-loop-explore internal-rollback --protocol CFG --release-key KEY --reason TEXT`.

**Crash safety.**
- The release history (hash chain) and the internal registry (`<dir>/internal.jsonl`, hash chain) are reconciled at every cycle
  start (`reconcile`). An adoption or rollback missing from the internal registry is recorded, with its assessment obligation.
- A decided rollback that the pointer does not show yet is finished next (`pendingRollback`).
- Tested: SIGKILL right after the CAS, then resume → exactly one adoption and one promote record.

**Stop conditions.**
- Waits, all model-free and retryable: no candidate, no fresh batch, waiting throttle, runtime or credential.
- Stops for a human: global ledger or cumulative cap (`budget-exhausted`), cost-fit refusal, integrity or input drift.
- No-progress: after `maxAcceptancesWithoutPromotion` consecutive acceptance passes without a promotion, the cycle stops with `no-progress` before another batch is spent. Proposal-level no-progress limits stay the consumer's (README "Operational limits").
- The cycle never spends to exhaust the 300000 ceiling. Useful results arrive per stage: smoke in minutes, dev after one paired
  pass, acceptance after one batch.

## 3. Epochs, exposure and lineage (`LINEAGE_RULE`)

**Epochs.**
- Each evaluation stable has its own screening registry and work directory under `<dir>/epochs/<digest16>/`. The screening
  registry stays bound to one stable, as before; the top-level `screening.registry` is not used by this track.
- A cycle that has frozen anything keeps its epoch. A fresh cycle follows the current pointer.
- Archive candidates based on another evaluation stable are not registered in this epoch.
- The consumer's proposer must base new patches on the current evaluation stable's `commit` (see `internal-status`).

**Exposure is global and durable.**
- Every candidate that any epoch exposed to a holdout (a result, or a consumed claim with a `USES` record) is added to the
  effective `screening.history`. It never gets another batch in any epoch, and a rollback keeps that exposure.
- Every dev task any epoch showed is added to `exposedDevTasks`. Those tasks are excluded from new batches, including by
  `refresh`.

**Descendants of the current evaluation stable are not tainted by its acceptance exposure.** Every batch is fresh, one-use and
lineage-clean against all earlier batches. The test asserts that the descendant's batch differs and shares no family with the
batch its parent was accepted on.

**Limits of the overlap checks.** Overlap checks are lexical. Semantic equivalence is not detected, and "unexposed" never
establishes absence from model training data.

**Protected results.** Holdout and acceptance results are marked `protected: true` in the registry. Consumer contract: their
task-level details (`final.json`, runs, reasons) must never be passed into proposer feedback.

## 4. Configuration (example; the live values are the consumer's decision)

```json
"screening": {
  "...": "plain screening fields unchanged (dev, holdout.enabled true, caps, candidates)",
  "internal": {
    "enabled": true,
    "dir": "/abs/path/eval-loop-terra-1/internal",
    "policy": "operational-unvalidated",
    "select": "best-dev-net",
    "maxWaitingQualified": 1,
    "maxAcceptancesWithoutPromotion": 3,
    "attemptsPerUnit": { "dev": 31, "acceptance": 144 },
    "assessment": { "enabled": true, "maxHours": 48 }
  }
}
```

**`attemptsPerUnit` is an operator estimate.** Caps are never changed by the engine.
- `internal-status` reports measured per-unit stats by stage, the fit, and risks (measured p90 above the estimate).
- Recorded Terra evidence as of 2026-11-13 ~13:00Z, read only:

  | Stage | Units (n) | Mean | p90 | Max |
  |---|---|---|---|---|
  | dev | 22 | 18.6 | 24 | 31 |
  | calibration (hard tasks) | 30 | 77.5 | 124 | 144 |

  No Terra holdout or acceptance unit has been measured.
- With 6-8 tasks x 3 repeats x 2 arms, an acceptance pass needs 36-48 units, which is 5184-6912 attempts at 144/unit. The live
  `caps.holdout` of 1100 covers that only at about 23-30 attempts/unit.
- The cost fit therefore refuses acceptance with hard-task-like estimates until the consumer raises `caps.holdout`/`perCycle`
  inside the same 299715 ledger, or accepts a lower, evidenced estimate. That is a consumer and user decision; nothing here
  raises it.

**Required.** `cumulative >= holdout + dev` when the assessment is enabled. Every charge goes to the ONE configured ledger; there
is no new allowance.

## 5. Interfaces

| Interface | Description |
|---|---|
| `--preflight` | Adds `screening.internal` {epoch, evaluationStable {runtimeDigest, commit, releaseSeq}, pendingAssessment, waitingQualified, candidateDemand {wanted, why}, serviceDeployment}. `next: "assessment"` when one is due. |
| `--status` | status@1 adds `internal` {epoch, acceptance {verdict, decision, batch}, decision, releaseKey, rolledBack, serviceDeployment "none", researchAdopt false}. `acceptance.stage` is one of `internal-promoted`, `internal-promotion-kept`, `internal-rolled-back`, `internal-stale-baseline`, `internal-not-promoted`; `productionAdopted` is always false. |
| Final verdicts | `INTERNAL_PROMOTED`, `INTERNAL_NOT_PROMOTED`, `STALE_BASELINE`, `KEEP`, `ROLLBACK`, `ROLLBACK_UNASSESSED`, `ASSESSMENT_SKIPPED`. Dev/smoke verdicts are unchanged. |
| `internal-status --protocol CFG` | internal-status@1, read-only. Evaluation stable; promotions, stale refusals, assessments and rollbacks; epochs with exposure and waiting; pool supply outlook; cost evidence. |
| `internal-rollback --protocol CFG --release-key KEY --reason TEXT` | Operator rollback (CAS, exact, idempotent; takes the internal lock). |
| Releases contract for a service deployer | `<dir>/eval-stable/current.json` + `history.jsonl` (hash chain). Read `current()`, deploy explicitly, keep your own rollback. pi-eval-loop never does this. |

## 6. Supply (why it is the binding constraint)

**The internal track does not relax batch eligibility.** Acceptance uses the exploration rules: accepted provenance, a hard task
with an annotated `source` basis, at least 6 tasks and 4 families, owner share <= 0.5, no family of an earlier
holdout/calibration/development set, one use.

**Pool state as of 2026-11-13 13:0xZ** (`eval-loop-confirmatory-1/pool`, registry unchanged since 2026-11-07, 0 `refresh`
records in that pool):

| Item | Value |
|---|---|
| Unbatched eligible cases (inventory) | 29 |
| Of those, sealable now | 19 |
| Families | 7 (owners: private 8, exercism 11) |
| Accepted hard | 0 |
| `nextBatch` | not ok: 4 < 6 tasks, 3 < 4 families, no accepted hard |
| Batches currently eligible | 0 |

- **Yield of the earlier public-commit collection:** 37 + 8 eligible of 373 case records. The main rejection causes were
  unavailable test imports (138), symlinks (48) and a visible suite not passing offline (20).

**Sources.**
- Public npm commits (`collect`, run by `refresh` or the cycle) carry pretraining-exposure risk, and they are never hard by
  size.
- Exercism (`collect-exercism`) is the only automatic source of `source`-hard tasks. It is finite and publicly exposed.
- Private tasks (`intake-private` with cross-provider review) need independent authors. A single AI author is one owner.

Unlimited novel tasks or independent authors are not assumed. When supply is short, the track waits: no paid dev beyond the
throttle, no reuse of protected batches.

**Open user decision.** Whether the internal track may use a separate, explicitly named batch policy, for example one without
the hard-stratum requirement. It is not implemented, because it would change what an internal acceptance means.

## 7. Budget: what is enforced, and what is not

- **The ONE ledger** (live: `terra-total-3`, limit 299715 = 300000 - 285 charged earlier) is the ceiling for every role. Stage
  caps and the cost fit only refuse earlier; nothing resets, multiplies or adds an allowance. Stopping before the ceiling is
  normal.
- **Enforced unit for target-model calls (smoke, dev, acceptance, assessment):** outbound provider attempts, admitted one by one
  by the isolated runtime's CONNECT gate against gate-covered reservations. Reservations are worst-case (`unit.maxRequests x K`,
  K = 2) and are settled no lower than the attempt floor.
- **Off-gate (proposer, reviewer):** `offGateAdmission` charges either `upstream-attempt-bound` (forwarded x gateway retry bound,
  under the stated assumption) or `proxy-forwarded`, where gateway retries are unmetered. `budgetTotals.upstreamAttemptsBounded`
  says which.
  - **Today:** the reviewer CLI supports the bound (`review.mjs --gateway-config`, `--require-attempt-bound`). The agent_workflow
    proposer charges `proxy-forwarded`.
  - **Consumer handoff:** call `offGateAdmission(budget, { route: "proposal", bound: () => gatewayAttemptBound({ config, model }),
    requireBound: true })` around each proposer session, with the gateway's config in private storage
    (`gatewayIsolationProblems` empty).
  - **Still unverifiable:** a shared, hot-reloadable gateway can change its retry configuration mid-call. The provider-side
    count can be cross-checked with `gatewayUsageMeter` / usage logs.
- **Units, not interchangeable:** model request/attempt (ledger) ≠ eval run/unit (one task x arm x repeat; Terra dev about 19
  attempts) ≠ task ≠ batch (a sealed set of 6-8 tasks, used once).

## 8. Pilot evidence (separate empirical vs simulated)

**Empirical** (live Terra records, read only; nothing was run by this change):
- The latest dev pass (2026-11-13, candidate `b0/p-e69aedaa0073`) is `DEV_PROMISING` with net +6.
  - Candidate: 10/10. Stable: 4/10, with hidden tests passing 10/10 for both arms; the 6 stable failures are strict
    existing-test changes.
  - Across Terra dev units, stable violated integrity in 7/11 units and candidates in 2/12.
- This is development evidence on reused tasks. It is no claim beyond them, and the candidate is waiting for supply.
- No A/A replicate exists: one stable repeat per task, and one task observed twice (both violations).
- A live paid A/A, acceptance or assessment needs the consumer-owned runtime and ledger. This change wrote neither.

**Simulated** (`test/internal-promotion.test.mjs`): accept → keep, descendant → fresh disjoint batch → accept → regression →
rollback; crash after the CAS; throttled waits with zero charges; cost-fit refusal without consuming the batch; deadline
rollback without a model call; stale baseline; A -> B -> A; exact rollback; reconcile; and off-gate units. These show control
flow and accounting only. They are not evidence about Terra.

## 9. Consumer rollout prerequisites (not done here)

1. A new config with `screening.internal` and a new `internal.dir` under the consumer's run directory. Keep `terra-total-3` and
   the runtime binding unchanged.
2. Set `attemptsPerUnit` and `caps.holdout`/`perCycle` from the measured costs above, inside the same ledger (user decision on
   the trade-off).
3. Make the proposer base patches on `internal-status.evaluationStable.commit`, and honor `candidateDemand.wanted`.
4. Do not feed `protected` results to the proposer, and adopt `offGateAdmission` for proposals.
5. Supply: schedule `refresh`, and decide on intake of independent private tasks. Without accepted-hard supply, acceptance
   cannot run.
6. Any real-service deployment of an evaluation-stable release stays a separate, explicit step.
