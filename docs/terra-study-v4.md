# Terra study v4: tooling supplied and readiness blockers (2026-11-13)

Status: **tooling only. No Terra study v4 is registered, calibrated, powered or ready.** Nothing in this document is a
measurement. No model was run, no task procured, no study activated and no review acquired for it.

## What the earlier evidence is (and is not)

`studies/confirmatory-1` v3 (`DESIGN-v3.md`, `protocol-v3.json`, `readiness-v3.json`, `power3-main.json`, the calibration
reports under the confirmatory-1 pool) was measured on **cliproxyapi/gpt-6-luna** (medium). None of it is evidence about
cliproxyapi/gpt-6.1-terra: difficulty levels, baseline rates, integrity rates and power all depend on the target model. A Terra
study must re-measure them; the v3 numbers below are quoted only to size the gap and stay luna evidence as of 2026-11-07.

## Interfaces supplied (engine, this release)

| Need | Interface | Default (confirmatory-1 unchanged) |
|---|---|---|
| target route of a calibration | `calibrate.mjs --route PROVIDER/MODEL [--effort LEVEL]` (`studyProtocol`); runner, plan, report and environment digest all use it; a non-default route must be in the runtime's model catalog | `DEFAULT_PROTOCOL.route` (cliproxyapi/gpt-6-luna medium) |
| evaluator context (state identity) | `calibrate.mjs --context ID` | `confirmatory-1:calibration` |
| shared series ledger | `calibrate.mjs --budget-ledger L --budget-limit N --budget-scope S` (N/S = the ledger's init record exactly; RequestBudget refuses another identity); `--max-requests` (<= N, approved) becomes a sub-ceiling of this context's reservations inside L, enforced under the ledger lock across runs, resumes and concurrent processes (`RequestBudget.reserve(.., { subCap })`, `attemptAdmission(.., { subCap })`) | a ledger of its own whose limit is `--max-requests` (hard cap 4500) |
| approval ceiling | the approval's `maxRequests` must be <= the shared ledger limit (instead of 4500) and equal `--max-requests` | <= 4500 |
| runtime ledger identity | `isolated-runtime.mjs prepare --budget-limit N --budget-scope S` (both or neither); calibrate blocks when the runtime's gate charges another identity | 4500 / confirmatory-1 scope |
| models catalog of a runtime | `isolated-runtime.mjs prepare --models FILE` | `~/.pi/agent/cliproxyapi-models.json` (read only) |
| runtime directory | `prepare/start/stop/status/resnapshot --dir D`, `calibrate.mjs --runtime D` | none |
| credential continuity | `isolated-runtime.mjs resnapshot --dir D` (docs/runtime-resnapshot.md) | - |
| provider 0.16.x | automatic (docs/provider-compat.md) | - |
| pilot provenance | `pilot.mjs --runs R --campaign LABEL` (records observed `model_route`s) | the ctrl-ablation-1 / luna label |
| power | `power.mjs --pilot FILE`, `power2.mjs --evidence FILE ...` already take their inputs as files | committed v1/v2 inputs |

Resume identity: a non-default context, ledger identity and the route/effort are part of the calibration plan digest, so a
state directory can never be resumed under another route or ledger. Default plans keep their previous digest.

## Example (placeholders; do not point a test at the deployed ledger)

```bash
# 1. a private runtime bound to the series ledger (needs the pinned gateway binary and a live source credential)
node pi-eval-loop/studies/confirmatory-1/isolated-runtime.mjs prepare --dir RUNTIME \
  --budget-ledger LEDGER --budget-limit 300000 --budget-scope "<exact init scope of LEDGER>" \
  --models CATALOG.json --credential SOURCE.json
# 2. plan only (model-free, writes nothing): shows route, context, ledger identity, worst case and every blocker
node pi-eval-loop/studies/confirmatory-1/calibrate.mjs --dry-run --batch CALIBRATION_BATCH --harness-dir STABLE_EXPORT \
  --harness-commit SHA --max-requests 20000 --approval APPROVAL.json --budget-ledger LEDGER \
  --budget-limit 300000 --budget-scope "<exact init scope of LEDGER>" \
  --route cliproxyapi/gpt-6.1-terra --effort medium --context terra-v4:calibration \
  --runtime RUNTIME --gateway-db GATEWAY_USAGE.db --reviews REVIEWS --state STATE
# 3. the same without --dry-run runs it (chargeable: needs an explicit approval for its --max-requests)
# 4. pilot / power from the Terra calibration ledger (offline)
node pi-eval-loop/studies/confirmatory-1/pilot.mjs --runs STATE/runs.jsonl --campaign "terra-v4 calibration <date>" --out PILOT.json
node pi-eval-loop/studies/confirmatory-1/power.mjs --pilot PILOT.json --out POWER.json
```

## Remaining readiness blockers (not resolved here)

1. **New Terra calibration.** No calibration has run on gpt-6.1-terra. The v3 (luna) reports have no calibrated-hard level; a
   Terra holdout needs tasks with an accepted `calibrated` difficulty basis measured on Terra (v3 registered 48 calibrated-hard
   tasks per main batch).
2. **New analysis plan and power evidence.** A Terra v4 registration needs its own rationale (target effect, alpha split, repeats)
   and simulated adopt-and-confirm power from Terra pilot/calibration data. v3 (luna) was provisional: 0.78 / 0.67 / 0.36
   (logit sf0.5 / template / logit sf1) < 0.8 at effect 0.15, and no pre-holdout candidate integrity evidence for 1440 runs.
3. **Task supply.** Main holdout 144 tasks in >= 48 families AND a family-disjoint confirmation holdout of 144 tasks in >= 48
   families (144 + 144, 48 + 48), sealed, unused, eligible. v3 supply (2026-11-07): 11 unbatched eligible tasks, 6 families.
4. **Private review / low exposure.** At least 72 private-reviewed, low-exposure tasks per holdout (cross-provider review
   policy). v3 had 12 accepted private reviews in total.
5. **Owner concentration.** `holdout.maxOwnerShare` is 0.5, but every private task comes from ONE authoring account
   (`private:ai-claude-opus-5-5`); role-separated sessions are not independent authors. Private supply alone cannot meet the
   rule: independent authoring sources (or eligible external tasks) must hold more than half of each holdout.
6. **Approvals.** A chargeable calibration needs its recorded approval (`calibration-approval@2`); holdout runs, adoption and
   confirmation need separate human approval.
7. ~~Target route of the recurring exploration / screening / autonomous protocols~~ (resolved 2026-11-13 by the config
   `route` field and one shared attempt total: `docs/target-route-and-shared-total.md`). Engine support only: no Terra run,
   registration, readiness or supply exists because of it.
