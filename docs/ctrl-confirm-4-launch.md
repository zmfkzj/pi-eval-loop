# ctrl-confirm-4 — preflight, launch, resume and audit guide

Nothing here is run automatically. A confirmation launch is a deliberate user decision after the gate passes.

> **Current state (2026-11-08):** LAUNCHED on the user's instruction ("남은 작업 진행") as the transient user unit
> `ctrl-confirm-4` at 03:17:09Z (state `pi-eval-loop/state/ctrl-confirm-4`). Pre-launch validation and hardening: PREREGISTRATION.md
> A2; machine-readable status and recovery index: `agent_workflow/runs/ops/ctrl-confirm-4-20261108/STATUS.json`. Do NOT launch
> again: a second launch on another state is refused by the batches' use ledgers; a resume uses the SAME command (§4).

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

## 2. Launch (durable, bounded; survives the Pi session, NOT a host reboot)

```sh
mkdir -p pi-eval-loop/state/ctrl-confirm-4
systemd-run --user --unit=ctrl-confirm-4 --working-directory=/home/arthur/Code/oh-my-pi-extensions \
  -p Restart=on-failure -p RestartSec=300 -p StartLimitBurst=3 -p StartLimitIntervalSec=21600 -p "RestartPreventExitStatus=2 64" \
  -p RuntimeMaxSec=432000 -p TimeoutStopSec=180 -p KillMode=control-group \
  -p StandardOutput=append:/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/ctrl-confirm-4/run.out \
  -p StandardError=append:/home/arthur/Code/oh-my-pi-extensions/pi-eval-loop/state/ctrl-confirm-4/run.err \
  $(which node) pi-eval-loop/experiments/ctrl-confirm-4/run.mjs --state pi-eval-loop/state/ctrl-confirm-4 --launch
```

`RuntimeMaxSec` = 120 h = the elapsed-wall ceiling; the resource ledger enforces it independently (no attempt starts unless it can
finish before the deadline). Restart policy: a crash (exit 1) restarts after 5 min, at most 3 times in 6 h; BLOCKED (exit 2) and
usage errors (64) never restart. A restart reconciles and continues; it never bypasses a held pause (§4). The first `--launch`
validates the graders of the 700 tasks (~1-2 h, model-free; `grading.json`), then writes `lock.json` + `queue.json`, records one
use in each sealed batch's `USES.jsonl`, writes `campaign-start` (deadline fixed once) in `resources.jsonl`, then dispatches.
A transient unit does not come back after a host reboot: re-run the same `systemd-run` command (after `systemctl --user
reset-failed ctrl-confirm-4` if the old unit is listed as failed). That is a resume of the same state, not a new experiment.

## 3. Monitoring

- `node pi-eval-loop/experiments/ctrl-confirm-4/status.mjs --state pi-eval-loop/state/ctrl-confirm-4` (read-only; `--json`):
  phase, grader validation, units final, terminal-status counts (never success counts), consumed / reserved / ceilings, active
  hours, wall deadline, unresolved pause, runner liveness, holdout uses, FINAL.
- `state/ctrl-confirm-4/campaign.json`: the runner's checkpoint after every unit.
- `systemctl --user status ctrl-confirm-4`; `tail -f state/ctrl-confirm-4/run.err`.
- Do not look at per-arm success during the run (no optional stopping exists; there is nothing to decide).

## 4. Pause and resume

- The runner pauses itself on: a ceiling (final - the campaign ends), a provider credit/auth failure, a route violation, 5 consecutive
  infrastructure failures, `--max-units`. Rate-limit pauses auto-resume after 15 min idle (max 6 per invocation).
- Credit / auth / route / infrastructure / operator pauses are HELD (A2): every later invocation, including an automatic service
  restart, exits with `HELD` and dispatches nothing until the operator fixes the cause and resumes with `--operator-resume`:
  `systemctl --user reset-failed ctrl-confirm-4` (if listed), then the §2 command with `--operator-resume` appended.
- Resume = the SAME launch command (same state). It checks the lock (any changed file, task, harness or environment refuses), takes
  the single-runner lock (a live runner refuses; a dead runner's lock is kept as `runner.lock.stale-*`), closes a crashed session's
  active interval at its last heartbeat + 60 s, stops surviving processes of interrupted attempts, reconciles them from their wire
  journals (evidence under `evidence/orphans/`; a crash between a result and its settlement is settled from the kept
  controller-wire evidence), settles open reservations (no surviving evidence: the full reservation is charged), and continues the
  frozen queue. It never resets the deadline, the budget, the queue or the uses, and never redraws a unit.
- Stop: `systemctl --user stop ctrl-confirm-4` (SIGTERM; in-flight attempts become orphans that the next resume reconciles).
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
