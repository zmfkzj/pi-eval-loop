# ctrl-confirm-4 — preflight, launch, resume and audit guide

Nothing here is run automatically. A confirmation launch is a deliberate user decision after the gate passes.

> **Current state (2026-11-08):** LAUNCHED on the user's instruction ("남은 작업 진행") at 03:17:09Z (lock 04:33:59Z, state
> `pi-eval-loop/state/ctrl-confirm-4`). HELD 04:48Z–05:21Z for a post-launch runtime deviation (shared packages reinstalled between
> the preflight and the lock), validated and continued on a frozen runtime snapshot: `records/ctrl-confirm-4/A3/VALIDITY.md`,
> `state/ctrl-confirm-4/continuation.json` v1. RUNNING again since 05:21:53Z (unit `ctrl-confirm-4`). Status / recovery index:
> `agent_workflow/runs/ops/ctrl-confirm-4-20261108/STATUS.json`. Do NOT launch again: a second launch on another state is refused by
> the batches' use ledgers; a resume uses the SAME command (§2 A3 form).

## 0. Preconditions (all must hold)

1. `records/ctrl-confirm-4/plan/gate.json` has `launch: true`, bound to the CURRENT `experiments/ctrl-confirm-4/prereg.json` digest and
   to the fresh sealed batches named in `prereg.json` `holdout.batches` (seal digests, 0 uses). `run.mjs --launch` refuses otherwise.
2. `prereg.json` `holdout.batches` / `holdout.taskIds` were filled by amendment (design selection) BEFORE the final gate evaluation.
3. `node --test test/ctrl-confirm-4.test.mjs test/ctrl-confirm-3.test.mjs` and `npm test` pass on the launch tree.
4. Preflight (model-free: one unauthenticated and one authenticated `GET /v1/models`, no inference request; never records a use).
   Write it OUTSIDE the scanned roots (`records/`, `docs/`), e.g. under `state/ctrl-confirm-4-preflight/`:

```sh
node pi-eval-loop/experiments/ctrl-confirm-4/preflight.mjs \
  --batch results/ctrl-confirm-3-holdout/ctrl-confirm-3-holdout-4206b2e38c1d \
  --batch results/ctrl-confirm-4-holdout/ctrl-confirm-4-holdout-9678d4a6a0da \
  --gate pi-eval-loop/records/ctrl-confirm-4/plan/gate.json \
  --out pi-eval-loop/state/ctrl-confirm-4-preflight/preflight-<date>.json
```

## 1. Optional plumbing smoke (exposed suite tasks only; a few cents API-equivalent)

A smoke state is bound to the experiment files: after any change of a launch-bound file use a NEW smoke state directory.

```sh
node pi-eval-loop/experiments/ctrl-confirm-4/run.mjs --state pi-eval-loop/state/ctrl-confirm-4-smoke2 --smoke
```

## 2. Launch / resume (durable, bounded; survives the Pi session, NOT a host reboot)

Since A3 a continued state BLOCKS (exit 2) unless it runs on the frozen runtime snapshot its `continuation.json` binds: the runner
is the snapshot's own node, and `runtime.mjs envFor` gives the paths (`EVAL_LOOP_RUNTIME`, `EVAL_LOOP_PI_CLI`, `EVAL_LOOP_PROVIDER`,
`EVAL_LOOP_ORCHE_MODULES`, `EVAL_LOOP_CATALOG_DIR`, `EVAL_LOOP_BOX_NODE_DIR`, `EVAL_LOOP_BOX_PI_MODULES`; no credential). The
service command never carries `--operator-resume` (an automatic restart must not release a hold; see §4).

```sh
cd /home/arthur/Code/oh-my-pi-extensions
S=pi-eval-loop/state/ctrl-confirm-4; R=$(realpath results/ctrl-confirm-4-runtime/rt-20261108-a3)
ENVP=$(node --input-type=module -e 'const {envFor}=await import("./pi-eval-loop/experiments/ctrl-confirm-4/runtime.mjs"); console.log(Object.entries(envFor(process.argv[1])).map(([k,v])=>`--setenv=${k}=${v}`).join(" "))' $R)
RMS=$(( $(date -d 2026-11-13T04:33:59Z +%s) - $(date +%s) + 3600 ))   # up to the campaign's wall deadline + drain time
systemctl --user reset-failed ctrl-confirm-4 2>/dev/null
systemd-run --user --unit=ctrl-confirm-4 --working-directory=$PWD $ENVP \
  -p Restart=on-failure -p RestartSec=300 -p StartLimitBurst=3 -p StartLimitIntervalSec=21600 -p "RestartPreventExitStatus=2 64" \
  -p RuntimeMaxSec=$RMS -p TimeoutStopSec=180 -p KillMode=control-group \
  -p StandardOutput=append:$PWD/$S/run.out -p StandardError=append:$PWD/$S/run.err \
  $R/node/bin/node pi-eval-loop/experiments/ctrl-confirm-4/run.mjs --state $S --launch
```

Every start: full content verification of the snapshot (manifest `2e7424bb…`, read-only, sealed fingerprint, no escaping link,
every runtime path inside it, in-box paths = the original host paths), the lock check against the original lock + continuation
(frozen fields vs the ORIGINAL lock; env/files/runtime vs the latest continuation), single-runner lock, held-pause check,
reconciliation of interrupted attempts. Before every dispatch and after every attempt: the snapshot fingerprint, the harness trees
and the reused orche evaluator files (a change holds the campaign, `runtime` pause). The wall deadline (fixed once at the lock) is
enforced by the resource ledger; `RuntimeMaxSec` only backs it up. Restart policy: a crash (exit 1) restarts after 5 min, at most
3 times in 6 h; BLOCKED (2) and usage errors (64) never restart; a HELD exit is 0 (no restart).
A transient unit does not come back after a host reboot: run the same block again (a resume of the same state; the interrupted
attempts are reconciled; a reboot loses /tmp control dirs, so their reservations are charged in full).

## 3. Monitoring

- `node pi-eval-loop/experiments/ctrl-confirm-4/status.mjs --state pi-eval-loop/state/ctrl-confirm-4` (read-only; `--json`):
  phase, grader validation, units final, terminal-status counts (never success counts), consumed / reserved / ceilings, active
  hours, wall deadline, unresolved pause, runner liveness, holdout uses, FINAL.
- `state/ctrl-confirm-4/campaign.json`: the runner's checkpoint after every unit.
- Runtime identity: the per-dispatch guard (A3) replaces the 10-min watchdog of A2 (`env-watch.mjs`, timer stopped ~05:01Z; its
  last `ENV-DRIFT` entry of 05:00Z was caused by the A3 code edits during the hold, see A2/POST-LAUNCH.md). Drift events appear in
  `status.mjs` (`runtime drifts`) and in `resources.jsonl` (`runtime-drift`).
- `systemctl --user status ctrl-confirm-4`; `tail -f state/ctrl-confirm-4/run.err`.
- Do not look at per-arm success during the run (no optional stopping exists; there is nothing to decide).

## 4. Pause and resume

- The runner pauses itself on: a ceiling (final - the campaign ends), a provider credit/auth failure, a route violation, 5 consecutive
  infrastructure failures, `--max-units`. Rate-limit pauses auto-resume after 15 min idle (max 6 per invocation).
- Credit / auth / route / infrastructure / operator / runtime pauses are HELD: every later invocation, including an automatic
  service restart, exits with `HELD` (exit 0) and dispatches nothing. After fixing the cause (state stopped):
  `node pi-eval-loop/experiments/ctrl-confirm-4/operator.mjs resume --state pi-eval-loop/state/ctrl-confirm-4 --reason "..."`,
  then the §2 block. A ceiling pause is final and is never resumed. A changed runtime / launch-bound file needs a validated
  continuation version (`runtime.mjs continue`, state held) — `--operator-resume` never bypasses the lock or the runtime check.
- Graceful pause (preferred): `node pi-eval-loop/experiments/ctrl-confirm-4/operator.mjs drain --state pi-eval-loop/state/ctrl-confirm-4`
  (SIGUSR1: nothing new is dispatched, in-flight attempts finish and are recorded, the runner exits HELD). Hold a stopped state:
  `operator.mjs hold --state ... --reason "..."`.
- Resume reconciliation: the single-runner lock (a live runner refuses; a dead runner's lock is kept as `runner.lock.stale-*`),
  closes a crashed session's active interval at its last heartbeat + 60 s, stops surviving processes of interrupted attempts,
  reconciles them from their wire journals (evidence under `evidence/orphans/`; a crash between a result and its settlement is
  settled from the kept controller-wire evidence), settles open reservations (no surviving evidence: the full reservation is
  charged), and continues the frozen queue. It never resets the deadline, the budget, the queue or the uses, and never redraws a unit.
- Immediate stop: `systemctl --user stop ctrl-confirm-4` (SIGTERM; in-flight attempts become orphans that the next start
  reconciles by the registered attempt policy — completed model calls > 0 means `aborted`, a final failure; the state is left HELD).
- Never: edit `prereg.json` or any launch-bound file (`run.mjs` `experimentFiles()`), ceilings or the queue of a launched state;
  switch provider/model; buy credits from the runner; start a second runner on the same state.

## 5. After completion (or a final ceiling)

The runner itself writes `FINAL.json` and runs the frozen analysis once (`analysis.json` with an `audit` block; a failure is kept
in `analysis-error.json`). To re-run it by hand (deterministic apart from the timestamp):

```sh
node pi-eval-loop/experiments/ctrl-confirm-4/analyze.mjs --state pi-eval-loop/state/ctrl-confirm-4
```

Audit before reading the verdict: `audit.ok` (resource-ledger chain intact, no open reservation, consumption within the
ceilings, exactly one use per batch by this state and preregistration); `runs.jsonl` chain intact (analyze refuses otherwise);
every scheduled unit has a final record or is reported missing; route/leak/integrity counts; transcripts and wire journals present
per attempt. The verdict is a recommendation only (KEEP_STABLE unless H1 CONFIRMED and every adoption condition holds); never an
automatic deployment.

## 6. Relation to the autonomous lifecycle (agent_workflow confirmatory-1 / protocol-v3)

ctrl-confirm-4 does not replace protocol-v3 and covers none of its gates (different intervention, repeats, alpha, task strata and
resource ledger). `experiments/ctrl-confirm-4/lifecycle-bridge.mjs --state ... --protocol <clone>/studies/confirmatory-1/protocol-v3.json`
reads a FINISHED state and returns a fail-closed assessment: REJECTED_EVIDENCE (unfinished, tampered, replayed, foreign, unaudited
or incomplete), NO_SUPPORT, or SUPPORTING_EVIDENCE_ONLY (the OCR intervention may be submitted to the lifecycle as a candidate,
which must then pass every protocol-v3 gate itself). It never adopts, never counts as a protocol-v3 holdout or confirmation and
never spends the series alpha or the confirmatory-1 requests; the ctrl-confirm-4 batches become prior-used families.
