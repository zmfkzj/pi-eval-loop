# ctrl-confirm-4 — launch record and post-launch notes (2026-11-08)

Not launch-bound (records/ is not in `run.mjs` `experimentFiles()`); PREREGISTRATION.md is launch-bound and is NOT edited after the
launch (an edit would make every resume refuse the lock).

## Launch

- Unit `ctrl-confirm-4` (transient systemd user service; command and properties: `docs/ctrl-confirm-4-launch.md` §2), started
  2026-11-08T03:17:09Z. Grader validation of the 700 tasks 03:17-04:33Z (0 failures, model-free).
- `lock.json` 04:33:59.754Z (sha256 `e042b2fc…`): preregDigest `faee9851…`, queue 6 300 units (digest `7ef80abe…`), 700 tasks, files
  digest `9ea18eca…` (= the A2 preflight), harness trees OC `6bfbe380…`, OCR `503ae172…` (= A1/A2 preflights), envDigest
  `d3109082…` (see below). `queue.json` sha256 `82ed0e30…`.
- Holdout uses: exactly one per batch, by this state and preregistration (`USES.jsonl` of `ctrl-confirm-3-holdout-4206b2e38c1d` and
  `ctrl-confirm-4-holdout-9678d4a6a0da`). Batch-level semantics: the 35 + 149 unselected tasks of the two batches are consumed too.
- `campaign-start` 04:33:59.773Z: elapsed-wall deadline 2026-11-13T04:33:59.773Z; per-attempt reservation 150 requests / 10 M
  input / 100 k output / $1.30 (A2 pricing); token/cost headroom 8 reservations (A2).

## Runtime environment changed between the preflight and the lock (before any unit)

- A2 preflight (03:14Z) and smoke2 (03:14-03:16Z) ran with envDigest `f5ce1410…` (= ctrl-confirm-2 and the A1 preflight).
- At 04:06:37-39Z the scheduled agent_workflow job `aw-maint-pi-migration` (weekly Pi 1.4.0 -> 1.5.0 migration of the umbrella;
  not part of this study) reinstalled umbrella node_modules: `cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider`
  (now 1.4.25, `extensions/index.ts` changed -> envDigest `d3109082…`) and `orche/node_modules` (pi-* dev dependencies 1.4.0 -> 1.5.0;
  bound into the OC/OCR sandboxes as the harness node_modules; not part of any digest). pi CLI 1.5.0 unchanged since 2026-11-03.
- Every confirmation unit ran after that change (lock 04:33:59Z, first dispatch after it), so all arms share one runtime; arms are
  interleaved. It is a deviation from the validated environment (smoke2/preflight), not an arm imbalance. It is disclosed here and
  in `agent_workflow/runs/ops/ctrl-confirm-4-20261108/STATUS.json`.
- Because every attempt loads these components from disk and the runner checks the environment only at (re)start, a watchdog was
  added (not launch-bound): `experiments/ctrl-confirm-4/env-watch.mjs`, baseline `state/ctrl-confirm-4/env-baseline.json`
  (04:41:03Z; refused unless the current runtime equals the lock's environment and file digests), checked every 10 min by the
  transient timer `ctrl-confirm-4-envwatch.timer`. On any change of envDigest, launch-bound files, orche node_modules lock, provider
  tree or pi CLI/package it records `ENV-DRIFT` in `state/ctrl-confirm-4/env-watch.jsonl` and stops the runner unit. Resume only
  after the runtime is restored to the baseline (a resume refuses a changed envDigest/files anyway; node_modules is checked by the
  watchdog baseline only).

## A3 — hold, validation, continuation (2026-11-08 04:48–05:21Z)

The watchdog above only detected later drift; it could not validate the change that had already happened before the lock. The
campaign was therefore stopped at 04:48:21Z (SIGTERM — the launched code had no graceful drain; 8 attempts in flight) and held
(operator pause, resources seq 109) at 04:48:42Z. The in-flight control directories were copied to
`state/ctrl-confirm-4/evidence/held-20261108-controldirs/` (sha256 list `evidence/held-20261108-wire.sha256`). The env-watch timer
was stopped ~05:01Z; its `ENV-DRIFT` entry of 05:00:00Z (`filesDigest`) was caused by the A3 code edits made during the hold, not
by a runtime change. Validation, frozen runtime and decision: `records/ctrl-confirm-4/A3/VALIDITY.md`; re-binding:
`state/ctrl-confirm-4/continuation.json` v1 (hash `784e775c…`, 05:21:07Z); operator resume 05:21:5xZ; unit restarted 05:21:53Z on
the snapshot `results/ctrl-confirm-4-runtime/rt-20261108-a3`. The 8 interrupted attempts were reconciled at that start by the
registered attempt policy: 6 `aborted` (OC 3, OCR 2, PCR 1; final failures), 2 `infra_error` (OCR 1, PCR 1; retried); one had no
wire journal and was charged its full reservation.
