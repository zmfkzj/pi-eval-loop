# pi-eval-loop

A headless, resumable optimization loop for the pi-orche harness that puts quality first. It is a **Pi subextension bundled as
the Git submodule `pi-eval-loop/`** of the oh-my-pi-extensions umbrella (repository `zmfkzj/pi-eval-loop`, branch `main`). The
umbrella lists it in `package.json` `pi.extensions`. It expects the umbrella layout around it: `../orche` is the target harness and
the sandbox helpers come from there; see `docs/design.md`.

It runs:
- baselines;
- failure analysis;
- candidate patches in isolated worktrees;
- screening and development with a paired, clustered Bayesian bootstrap;
- a quality Pareto archive;
- one sealed holdout pass;
- an adoption gate;
- local-ref adoption with automatic rollback.

The loop adapts ParetoSaddler (arXiv:2611.02079) to quality-only objectives. It is **not** a reproduction of that paper: see
`docs/design.md` §3 for what is taken and what differs.

## Usage (umbrella root)

```bash
npm run eval:loop -- --once        # one cycle (prepare -> baselines -> search -> select -> holdout -> adoption gate)
npm run eval:loop -- --resume      # continue an interrupted or blocked cycle from its state directory
npm run eval:loop -- --resume --require-state   # same, but refuse to initialize when no loop state exists (supervisors)
npm run eval:loop -- --daemon      # keep running; a finished cycle restarts only after a substantive change
npm run eval:report                # write report.md / report.json of the state
npm run eval:loop -- --status [--summary] | --doctor | --rollback [--reason R] | --verify-stable --tasks DIR
npm run eval:loop -- --ablation    # A (stable) / B (quality-only greedy loop) / C (quality-first Pareto loop)
npm run eval:loop -- --ablation --state pi-eval-loop/state/explore-real-2 --protocol pi-eval-loop/protocols/explore-real-2.json
                                   # exploration-only A/B/C: train/dev search, no holdout, deployment BLOCKED
npm run eval:loop -- --selftest    # credential-free end-to-end run with a faux model (SIMULATED; plumbing only)
# options: --state DIR (default pi-eval-loop/state/default, git-ignored)  --protocol FILE (overrides; locked at first run)
```

Inside Pi: `/eval-loop status|report|doctor|help`. The loop itself never runs in an interactive session.

If a prerequisite is missing (bwrap with namespaces, Pi CLI, provider, orche, git, credentials, model catalog, upstream), the run
ends as `BLOCKED` and is recorded as such. No simulated result is ever presented as a measurement.

## Unattended operation contract

For cron, systemd or a Temporal activity that calls the CLI repeatedly. Schemas and codes are defined in `src/contract.mjs`.

**Invocation.** Run `eval-loop --resume --require-state --state DIR` from the umbrella root. Start a new experiment once
with `--once --state NEW_DIR` or `--resume --state NEW_DIR`, on a directory that does not exist or is empty. An invocation
runs at most one cycle. When the cycle is already done, it starts the next one only after a substantive change; otherwise
it reports `idle`. A supervisor's own schedule replaces `--daemon`. The CLI never waits for input.

**Outcome line.** Every lock-taking mode ends with one single-line JSON object on stdout:

- Lock-taking modes: `--once`, `--resume`, `--daemon`, `--rollback`, `--verify-stable`, `--ablation`.
- In `--daemon`, one line per finished cycle; the last line belongs to the invocation.
- Logs go to stderr.

Fields:
`{"schema":"pi-eval-loop/outcome@1","outcome","exitCode","stateDir","phase","cycle","status":<summary or null>,"at", ...}`.

Extra fields:

| Field | Present when |
|---|---|
| `mode`, `note` | Applicable to the mode / outcome |
| `initialized: true` | A fresh directory started a loop |
| `health`, `detail` | `state_error` |
| `lock: {state, why, owner: {pid, host, startTime, at}}` | `busy` |
| `signal` | `interrupted` |
| `error: {name, code}` | `error`; the message and stack go to stderr |

| outcome | exit | meaning | supervisor action |
|---|---|---|---|
| `idle` | 0 | Finished cycle, no substantive change since | Schedule the next check |
| `cycle_done` | 0 | A cycle reached phase `done` in this invocation. The deployment verdict is `status.final.verdict`; an exploration-only protocol finishes `cycle_done` with verdict `BLOCKED` and `explorationOnly: true` | Report the verdict |
| `ok` | 0 | `--rollback`, `--verify-stable` or `--ablation` finished | — |
| `blocked` | 2 | A prerequisite, split or protocol-lock problem stopped the loop. `status.blocked.retryable` is true only for missing prerequisites. The state resumes at `status.resumePhase` | Retry later when retryable; otherwise a human must act (a changed protocol or evaluator needs a new state directory) |
| `halted` | 3 | Trust-boundary breach or state-integrity violation; terminal for the directory | Never retry; human review |
| `state_error` | 4 | `state.json` is missing (records exist), unreadable, invalid, or absent under `--require-state`. Nothing was changed | Never retry; restore the state or start a new directory |
| `busy` | 75 | Another controller lock is held or cannot be verified. `lock.state`: `live`, `foreign-host` or `unverifiable`; `contended` (another process is recovering it, or it changed during recovery); `stale-guard` (a recoverer died holding `DIR/.lock.reclaim`; a human removes the guard after checking that no controller runs) | Retry later (a persistent `unverifiable`/`stale-guard` needs a human); never kill the owner on the PID alone |
| `interrupted` | 130 | SIGINT/SIGTERM/SIGHUP | Rerun `--resume` |
| `incomplete` / `error` | 1 | The loop returned before `done` without one of the reasons above / an unexpected exception, including file-system errors before or after the lock and uncaught exceptions or rejections (same cleanup as a signal) | Bounded retries, then a human |
| `usage` | 64 | Bad arguments (an unknown `--strategy` is now 64, formerly 2), or a lock-taking mode other than `--rollback` (including `--ablation`) on a trajectory `DIR/A|B|C` of an ablation (use `--ablation` on the parent) | Fix the call |

**Status summary.** `eval-loop --status --summary --state DIR` is read-only and takes no lock. It prints one line:
`{"schema":"pi-eval-loop/status@1","stateDir","layout":"loop"|"ablation","health":"fresh"|"present"|"missing"|"corrupt","condition","lock",...}`.

- `condition` is one of `none`, `in_progress`, `blocked`, `halted`, `cycle_complete`, `state_error`.
- `lock` is `{state: absent|live|stale|foreign-host|unverifiable, pid, host, at, guard?: held|stale-guard}`, the lock that
  governs the directory (a trajectory reports its ablation's lock); the token is never printed.
- For a present state it adds `phase`, `cycle`, `strategy`, `resumePhase`,
  `blocked{reason,retryable,missing[names],problemCount}`, `halted{reason,at}`, `cycleComplete`, `searchStop` (null while
  searching), `counters{candidates,noProgress}`, `final{verdict,candidate,adopt,explorationOnly,rolledBack,reasonCount}`,
  `adopted{at}`, `doneAt`, `updatedAt` and `lastInterruption{at,signal}`.
- An ablation directory lists `trajectories.A/B/C`.
- The summary never carries prompts, task or holdout content, problem texts, gate reasons or credentials.
- `lastInterruption` is history only. Older states' `interrupted` field is migrated to it, and neither decides an outcome.
- Exit 4 when the health is `missing` or `corrupt`, else 0.
- Plain `--status` still prints the full `state.json`.

**Locks.** The controller lock is `DIR/.lock`. An ablation and all its trajectories share the ablation directory's lock (a
`--rollback --state DIR/A` takes `DIR/.lock`).

- It records pid, host, boot id, PID namespace (`/proc/self/ns/pid`), `/proc` start time and a token, and is created
  atomically.
- It is recovered only when the owner provably no longer runs: same host and an earlier boot, or same host and PID namespace
  with a dead pid or a pid whose start time differs (reused).
- Recovery holds `DIR/.lock.reclaim` and re-reads the record first, so a newly acquired lock is never removed.
- These locks stay busy: foreign hosts, another PID namespace (a container or `bwrap --unshare-pid` on the same host),
  records without host, namespace or start time (older format), unreadable records, and running pids whose start time
  cannot be read. Remove such a lock by hand only after checking that no controller runs.
- The CLI does not know about supervisor locks (for example agent_workflow maintenance or target locks). The supervisor
  holds those around the invocation.

**Supervisor duties.**

- Send SIGTERM to the controller. Its handler kills the registered sandbox process groups and the route proxies, writes the
  report and prints the `interrupted` line.
- If the controller does not exit within a grace period, send SIGKILL to its whole process group:
  - Sandboxes are bwrap with `--die-with-parent`, `--new-session` and `--unshare-pid`, so they end with the controller.
  - The route proxy runs in the controller's process group, so it survives a SIGKILL of the controller pid alone. The group
    kill is needed for it.
  - No further cleanup hook is needed.
- Never relaunch while `busy`.
- Run with the same `--state` and `--protocol` every time. Keep `HOME`, `PATH` and the credentials of the original run.
- Do not commit, push or deploy on the CLI's behalf. Adoption only moves the local `eval-loop/stable` refs after the gates.

**Recovery.** Nothing clears a halt, a lost state or a protocol-lock BLOCKED automatically, and there is no override flag.
`--rollback` is the exception by design: it restores the previous local `eval-loop/stable` refs on any state, including
halted, lost or corrupt ones, and never evaluates or adopts. On a trajectory it holds the ablation's lock.
A human reviews the records (`report.md`, `events.jsonl`), then continues in a new state directory. Use a new protocol
version if needed; the holdout ledger and its once-only rule still apply. Every file in `src/` is part of the locked
evaluator. A state directory locked before an evaluator change therefore resumes as `blocked` ("evaluator file changed").
This is intentional: continue in a new state directory, and never rewrite a recorded lock.

## Status: what is done and what the evidence does not show

| Item | Status |
|---|---|
| Loop, CLI (`--once/--resume/--daemon/--report`), Pi command, isolation, gates, archive, adoption/rollback, A/B/C | Implemented and covered by `npm test` (faux/simulated runs are plumbing checks, never measurements) |
| Critical integrity rule | protocol-2: any task-agent integrity violation, leak, route violation or crash under a candidate rejects it, whatever the baseline did |
| Real measurements | `abc-real-1` (protocol-1): truncated exploratory evidence (time-motivated 4-candidate cap, 3 evaluated per arm). `explore-real-2` (protocol-2): exploration-only train/dev search to the pre-registered stop; see `docs/results-explore-real-2.md` |
| Holdout | `holdout-v1` is implementer-authored and was consumed once by `abc-real-1`; it is not independent and is not reused |
| Deployment | **BLOCKED**: no externally curated independent holdout exists. No adoption and no real performance improvement are claimed |
| Operational limits | Cost and time are not optimization targets; safety limits only: 200 candidates/cycle backstop, 72 h hang watchdog, 10 failed proposals per failure class since the last progress (cannot fire before the 10-candidate patience with the defaults), infra stops, 120 requests / 30 min per proposer session, 4 files / 200 diff lines per patch, 20 min / 150 requests per task unit (exact list: `docs/results-explore-real-2.md`) |
| Exploration quality | Not demonstrated: the 20 explore-real-2 proposals were variants of one hypothesis, and none targeted the integrity class that rejected them all |
| Diagnostics | No package typecheck script; `node pi-eval-loop/scripts/checkjs-compare.mjs <base> <out>` compares tsc checkJs output (record: `records/explore-real-2/checks/checkjs/`) |
| Packaging | Git submodule `pi-eval-loop/` of the umbrella (`zmfkzj/pi-eval-loop`, branch `main`). Its history continues the umbrella-directory commits it was converted from (`Imported-From:` trailers). The pinned commit must be pushed before fresh clones can initialize it |

## Layout

| Path | Contents |
|---|---|
| `bin/eval-loop.mjs` | CLI entry |
| `src/cli.mjs` | CLI modes, preflight, supervised step, lock, signal/exit cleanup |
| `src/contract.mjs` | Outcome/exit-code table, state health, public status summary |
| `extension/index.js` | Pi command |
| `src/loop.mjs` | Phases, state machine, watchdog |
| `src/protocol.mjs` | Pre-registered defaults and the lock |
| `src/stats.mjs` | Paired, clustered Bayesian bootstrap |
| `src/gate.mjs` | Screening, development and adoption gates |
| `src/archive.mjs` | Lineage, dedup, Pareto front |
| `src/datasets.mjs` | Splits, exposure scan, seal, holdout use ledger |
| `src/sandbox.mjs` | Reuses orche `experiments/witness-replay` sandbox, proxy and bridge; adds the endpoint gate and runtime-only mounts |
| `src/runner.mjs` | Sandboxed Pi runs, controller-derived terminal states |
| `src/grader.mjs` | Sandboxed independent grading |
| `src/integrity.mjs` | Reuses orche `experiments/ultra-ab/protocol.ts` rules |
| `src/evaluator.mjs` | Dispatch journal, exactly-once units, infra-only retry, crash reconcile |
| `src/proposer.mjs` | Optimizer agent on a runtime copy |
| `src/checks.mjs` | Fail-closed typecheck/test gate |
| `src/deploy.mjs` | Crash-safe local adoption and rollback |
| `src/ablation.mjs` | A/B/C |
| `src/report.mjs` | Reports |
| `datasets/holdout-v1/` | 7 sealed, implementer-authored holdout tasks (they cannot back an adoption under the default protocol) |
| `protocols/` | Recorded protocol overrides of measured runs |
| `records/` | Committed records of measured runs |

Tests: `npm test` in this directory (`EL_TEST_TMP` sets the temp root). Root `npm run test:compat` runs them too. The
unattended contract is covered by `test/lifecycle.test.mjs`, `test/lock.test.mjs` and `test/cli-contract.test.mjs`.
