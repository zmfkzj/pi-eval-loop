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

Without the section, plain `mode: "screening"` behaves exactly as before, except for the engine-wide budget policy
`shared-total-only` (2026-11-13, README "Budget"), which removed every screening cap. Registration order and the holdout rules
are unchanged; the screening and lifecycle tests still pass.

## 2. Lifecycle (one action per cycle; `bin/eval-loop-explore.mjs --resume`)

1. **smoke + dev.** The screening stages run unchanged. Dev is a paired, interleaved, same-route comparison against the current
   evaluation stable on the frozen dev tasks. The rule is `minNetSuccesses` plus no candidate integrity violation; integrity is
   never loosened. The result is a `development` label.
2. **Waiting.** Qualified candidates wait for a fresh batch without any model call.
   - When `maxWaitingQualified` candidates are waiting, no further dev is paid for: the cycle waits with `supply-empty`.
   - Preflight reports `screening.internal.candidateDemand.wanted: false`. This is the consumer gate for paid proposals.
3. **Acceptance.** The qualified candidate with the best dev net (`select: "best-dev-net"`) gets ONE pass on ONE fresh batch.
   - The pass is the screening holdout stage, unchanged: exploration eligibility, one use, lineage, evidence re-check,
     interleaving and the stage deadline.
   - Admission reads only the ONE shared ledger. The pass starts only when its remaining allowance (settled plus every role's
     open worst cases) covers the estimated acceptance pass plus the assessment that must follow (`passNeed`). Otherwise the
     candidate does not get the batch, nothing is claimed and the batch is not consumed. There is no stage cap or cost fit.
4. **Promotion.** Only a completed pass with verdict `EXPLORATORY_SUPPORTED` and zero candidate integrity or strict violations
   promotes the candidate.
   - The promotion is a CAS on the evaluation-stable pointer against the stable digest **and the history record** the pass
     measured (`Releases.adopt` `expectSeq`).
   - A moved pointer, including A -> B -> A, is recorded once as `STALE_BASELINE`. The result is never applied to another stable.
   - The promotion record carries the assessment obligation (`assessBy`).
5. **Assessment.** This is the first action of the next cycle. The promoted arm runs against the previous stable on the
   regression (dev) tasks, under its own key (`assess:<digest>`), against the shared ledger. The decision:
   - **KEEP** only for a complete pass with no critical problem and net >= 0.
   - **ROLLBACK** otherwise: a critical problem, net < 0, incomplete pairs or infrastructure-only units.
   - **ROLLBACK_UNASSESSED** without a model call when the deadline has passed, the shared ledger can no longer cover the
     assessment (e.g. another role spent it after the promotion), or the regression tasks became unusable.

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
- Stops for a human: the shared ledger cannot cover the next pass (`budget-exhausted`), integrity or input drift.
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
  "...": "plain screening fields unchanged (dev, holdout.enabled true, candidates); no caps",
  "estimate": { "attemptsPerUnit": { "dev": 31, "holdout": 144 } },
  "internal": {
    "enabled": true,
    "dir": "/abs/path/eval-loop-terra-1/internal",
    "policy": "operational-unvalidated",
    "select": "best-dev-net",
    "maxWaitingQualified": 1,
    "maxAcceptancesWithoutPromotion": 3,
    "assessment": { "enabled": true, "maxHours": 48 }
  }
}
```

**`screening.estimate.attemptsPerUnit` is an operator estimate for sizing the shared-ledger admission, not a cap.** It never ends a
running pass. Each unit reserves its own worst case against the shared ledger, and a refusal is a durable stop.
- `internal-status` reports measured per-unit stats by stage, the pass needs, and risks (measured p90 above the estimate).
- Recorded Terra evidence as of 2026-11-13 ~13:00Z, read only:

  | Stage | Units (n) | Mean | p90 | Max |
  |---|---|---|---|---|
  | dev | 22 | 18.6 | 24 | 31 |
  | calibration (hard tasks) | 30 | 77.5 | 124 | 144 |

  No Terra holdout or acceptance unit has been measured.
- With 6-8 tasks x 3 repeats x 2 arms, an acceptance pass needs 36-48 units, which is 5184-6912 attempts at 144/unit. Under
  `shared-total-only` that is admitted whenever the shared ledger's remaining allowance covers it plus the assessment.
- The earlier `caps.holdout`/`perCycle`/cost-fit refusal no longer exists. A legacy `screening.caps` section is ignored and
  reported; `internal.attemptsPerUnit` is refused with a message naming `screening.estimate.attemptsPerUnit` (the track was never
  activated).

Every charge goes to the ONE configured ledger; there is no new allowance and no per-stage limit.

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
the hard-stratum requirement. It is not implemented, because it would change what an internal acceptance means. The
recommended definition is in section 10; it is a proposal and has not been applied.

## 7. Budget: what is enforced, and what is not

- **The ONE ledger** (live: `terra-total-3`, limit 299715 = 300000 - 285 charged in earlier ledgers; its own charges keep
  counting) is the only spending limit for every role (`shared-total-only`). Pass sizing only refuses to start a pass the shared
  allowance cannot cover. Nothing resets, multiplies or adds an allowance. Stopping before the ceiling is normal.
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
rollback; crash after the CAS; throttled waits with zero charges; acceptance withheld while the shared ledger cannot cover it plus
its assessment (batch untouched); assessment unaffordable after another role spent the allowance → rollback without a model
call; deadline
rollback without a model call; stale baseline; A -> B -> A; exact rollback; reconcile; and off-gate units. These show control
flow and accounting only. They are not evidence about Terra.

## 9. Consumer rollout prerequisites (not done here)

1. A new config with `screening.internal` and a new `internal.dir` under the consumer's run directory. Keep `terra-total-3` and
   the runtime binding unchanged.
2. Delete `screening.caps` (ignored) and set `screening.estimate.attemptsPerUnit` from the measured costs above (sizing only;
   the shared ledger stays the only limit).
3. Make the proposer base patches on `internal-status.evaluationStable.commit`, and honor `candidateDemand.wanted`.
4. Do not feed `protected` results to the proposer, and adopt `offGateAdmission` for proposals.
5. Supply: schedule `refresh`, and decide on intake of independent private tasks. Without accepted-hard supply, acceptance
   cannot run.
6. Any real-service deployment of an evaluation-stable release stays a separate, explicit step.

## 10. Proposed internal acceptance batch policy (PROPOSAL, NOT APPLIED)

Status: a recommendation for the user, written 2026-11-13. Nothing below is implemented. Applying it needs explicit user
approval, a new named engine policy (for example `internal-acceptance@1`) with tests, and a new internal pool. The research
regime is not changed by it: confirmatory-1, Terra v4, readiness and `cross-pool-overlap` stay as they are.

**Today.** Internal acceptance uses the exploration holdout rules unchanged (`src/exploration.mjs` `exploreProtocol`):
- at least 6 tasks and 4 families, from accepted provenance;
- `hardBasis ["source"]` with at least one hard task;
- owner share <= 0.5;
- prior family reuse forbidden;
- one use per batch;
- lineage and cross-pool exclusion by name.

Consumer evidence (read only, 2026-11-14 ~00:10 KST, `eval-loop-terra-1/supply-inventory/INVENTORY.md` and
`ENGINE-REQUEST-terra-v4.md`):
- 628 never-dispatched ctrl-confirm-3/4 tasks were checked; 569 re-validated as eligible.
- All 569 are blocked by `cross-pool-overlap` because their IDs are named in committed ctrl-confirm-4 records. 533 of them are
  now `withdrawn`.
- 36 were used for calibration and review; 27 of those 36 showed test-gap or reference-vs-blind defects.
- Source-hard supply is exhausted.

### Retain (validity and exposure safeguards; not relaxable for an internal decision)

| Safeguard | Why it matters for an operational decision |
|---|---|
| Sealed, byte-verified batch; grader validated offline (reference passes hidden, visible suite passes offline, deterministic); license and provenance recorded | Without valid graders the comparison measures nothing |
| No implementer-authored tasks, no public-benchmark-listed tasks | Known contamination or author bias |
| One use per acceptance batch; protected results never reach the proposer | Otherwise the acceptance becomes tuning data (adaptive leakage) |
| **True exposure exclusion**, durable across epochs: any task or family with a dispatched model unit in any runner ledger; any task of a used holdout (`USES`); dev, regression and calibration tasks; any task whose content was shown to a proposer, reviewer, adjudicator or human analyst of this loop | This is what independence from the candidate's selection actually requires |
| Baseline independence: no family of the batch that promoted the current evaluation stable, and the descendant rule (`LINEAGE_RULE`) | A stable must not be confirmed on its own selection data |
| Fork, near-duplicate and lexical duplicate checks | Duplicates inflate the effective sample |
| Operational diversity: at least 4 families and owner share <= 0.5 | Cheap guard against a single-repo verdict. The 569-task inventory (337 owners) can meet it easily |

### Separate (research-specific; keep for the research track only, drop as requirements for internal acceptance)

| Research rule | Internal policy | Reason |
|---|---|---|
| Calibrated-hard quota (48 per main holdout) and `hardBasis` source/calibrated with at least one hard task | Not required. Record each task's difficulty basis (declared tier, size proxy, calibration when present) and report the mix | It serves a research claim about hard tasks. A batch where both arms saturate simply does not promote (INCONCLUSIVE/KEEP_STABLE), which is fail-safe |
| 144+144 tasks, 48+48 families, 5 repeats, power >= 0.8, integrity-survival prior | Not required | Generalization claims. The internal claim is narrower (section 1), and rollback limits the cost of a wrong promotion |
| Private-reviewed / cross-provider review, low-exposure quota (72) | Not required. Public-commit tasks are allowed, with pretraining exposure reported as a limitation | Both arms share the target model, so contamination mostly hits both arms. It is a known bias, not a blocker for an operational choice |
| `cross-pool-overlap` by name only | Replace with the evidence-based exposure exclusion above (internal pool only) | A name in a committed record is not exposure. Dispatch, use or content shown to a session is |

### Registered-but-never-dispatched tasks (the 569/533)

- **Eligible for an internal pool only.** The engine itself (not a consumer script) must re-verify, at sealing time, that the
  task and its family have zero dispatched units in every runner ledger on the machine.
- **Content exposure must also be ruled out.** The task's content must never have been given to any model or human session of
  this loop (proposal, review, adjudication, analysis). Deterministic screens such as conflict detection are fine.
- **The original selection must have been candidate-blind**, and no per-task result may exist. `dispatch = 0` alone is not
  enough.
- **No laundering.** The tasks keep their provenance pointer to ctrl-confirm-3/4, and the internal pool records why they are
  admitted. They are never moved back into a research pool, and the research `withdrawn` records stay as they are.
- **Always excluded:**
  - the 36 calibration/review tasks (shown to models);
  - the 27 tasks with grading defects (validity);
  - the 9 tasks measured x3;
  - every task of the 103 dispatched ctrl-confirm-4 tasks and their families.

### Size and decision

- **Batch size and the promotion threshold** stay a user choice from an effect, variance and risk analysis. The current 6-8
  tasks, 3 repeats and the exploratory rule are operational defaults, not validated sizes. With 569 candidates of supply,
  larger batches are possible; their cost comes out of the one shared ledger.
- **Labels.** Results are labelled `internal-acceptance` with the policy id. They are never research confirmation and never
  reusable as a research holdout.

### Adoption conditions

1. User approval of this policy text.
2. Engine policy `internal-acceptance@1`: its own batch rule and exposure verifier, plus tests. Exploration and research
   defaults stay unchanged.
3. A new internal pool separate from research pools.
4. The consumer re-imports through the engine verifier, never by moving files.

### Would change this recommendation

- A user goal of an external or generalization claim: keep the research rules.
- Evidence that tasks in the 569 were shown to a loop session.
- A much smaller verified supply than reported.
- Measured A/A noise so large that a 6-8 task batch cannot separate arms (then larger batches or no promotion).
