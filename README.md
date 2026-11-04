# pi-eval-loop

A headless, resumable optimization loop for the pi-orche harness that puts quality first. It is an **in-umbrella Pi
subextension**: listed in the umbrella's `package.json` `pi.extensions`. It is not yet a standalone Git submodule, because creating
a remote repository was not authorized; see `docs/design.md`.

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
npm run eval:loop -- --resume      # continue an interrupted cycle from its state directory
npm run eval:loop -- --daemon      # keep running; a finished cycle restarts only after a substantive change
npm run eval:report                # write report.md / report.json of the state
npm run eval:loop -- --status | --doctor | --rollback [--reason R] | --verify-stable --tasks DIR
npm run eval:loop -- --ablation    # A (stable) / B (quality-only greedy loop) / C (quality-first Pareto loop)
npm run eval:loop -- --ablation --state pi-eval-loop/state/explore-real-2 --protocol pi-eval-loop/protocols/explore-real-2.json
                                   # exploration-only A/B/C: train/dev search, no holdout, deployment BLOCKED
npm run eval:loop -- --selftest    # credential-free end-to-end run with a faux model (SIMULATED; plumbing only)
# options: --state DIR (default pi-eval-loop/state/default, git-ignored)  --protocol FILE (overrides; locked at first run)
```

Inside Pi: `/eval-loop status|report|doctor|help`. The loop itself never runs in an interactive session.

If a prerequisite is missing (bwrap with namespaces, Pi CLI, provider, orche, git, credentials, model catalog, upstream), the run
ends as `BLOCKED` and is recorded as such. No simulated result is ever presented as a measurement.

## Status: what is done and what the evidence does not show

| Item | Status |
|---|---|
| Loop, CLI (`--once/--resume/--daemon/--report`), Pi command, isolation, gates, archive, adoption/rollback, A/B/C | Implemented and covered by `npm test` (faux/simulated runs are plumbing checks, never measurements) |
| Critical integrity rule | protocol-2: any task-agent integrity violation, leak, route violation or crash under a candidate rejects it, whatever the baseline did |
| Real measurements | `abc-real-1` (protocol-1): truncated exploratory evidence (time-motivated 4-candidate cap, 3 evaluated per arm). `explore-real-2` (protocol-2): exploration-only train/dev search to the pre-registered stop; see `docs/results-explore-real-2.md` |
| Holdout | `holdout-v1` is implementer-authored and was consumed once by `abc-real-1`; it is not independent and is not reused |
| Deployment | **BLOCKED**: no externally curated independent holdout exists. No adoption and no real performance improvement are claimed |
| Packaging | In-umbrella subextension directory, not a standalone submodule (no remote was authorized) |

## Layout

| Path | Contents |
|---|---|
| `bin/eval-loop.mjs` | CLI: lock, signals, child cleanup |
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

Tests: `npm test` in this directory (`EL_TEST_TMP` sets the temp root). Root `npm run test:compat` runs them too.
