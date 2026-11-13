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
npm run eval:loop -- --preflight --protocol FILE [--state DIR]   # read-only: holdout this experiment has/would get, eligible?
node pi-eval-loop/bin/eval-loop-supply.mjs collect --pool DIR   # public-source holdout supply: collect, validate, seal a batch
node pi-eval-loop/bin/eval-loop-supply.mjs status --pool DIR    # batches, reservations, uses, reason-code counts (non-secret)
node pi-eval-loop/bin/eval-loop-supply.mjs collect-exercism --pool DIR [--track exercism/typescript] [--no-seal]  # annotated source: Exercism JS/TS hard exercises (difficulty 8-10)
node pi-eval-loop/bin/eval-loop-supply.mjs refresh --pool DIR --protocol FILE   # unattended model-free pass: all sources + seal; exit 0 = eligible unused batch available, 2 = none, 3 = busy
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
| `integrity` | `state_error` caused by the protocol binding (below): `protocol_lock_missing`, `protocol_lock_corrupt`, `protocol_lock_mismatch` or `protocol_records_corrupt` |
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
| `state_error` | 4 | `state.json` is missing (records exist), unreadable, invalid, or absent under `--require-state`; or the protocol binding is damaged (`integrity`, see **Protocol binding**). Nothing was changed | Never retry; restore the state or start a new directory |
| `busy` | 75 | Another controller lock is held or cannot be verified. `lock.state`: `live`, `foreign-host` or `unverifiable`; `contended` (another process is recovering it, or it changed during recovery); `stale-guard` (a recoverer died holding `DIR/.lock.reclaim`; a human removes the guard after checking that no controller runs) | Retry later (a persistent `unverifiable`/`stale-guard` needs a human); never kill the owner on the PID alone |
| `interrupted` | 130 | SIGINT/SIGTERM/SIGHUP | Rerun `--resume` |
| `incomplete` / `error` | 1 | The loop returned before `done` without one of the reasons above / an unexpected exception, including file-system errors before or after the lock and uncaught exceptions or rejections (same cleanup as a signal) | Bounded retries, then a human |
| `usage` | 64 | Bad arguments (an unknown `--strategy` is now 64, formerly 2), or a lock-taking mode other than `--rollback` (including `--ablation`) on a trajectory `DIR/A|B|C` of an ablation (use `--ablation` on the parent) | Fix the call |

**Status summary.** `eval-loop --status --summary --state DIR` is read-only and takes no lock. It prints one line:
`{"schema":"pi-eval-loop/status@1","stateDir","layout":"loop"|"ablation","health":"fresh"|"present"|"missing"|"corrupt","condition","lock",...}`.

- `condition` is one of `none`, `in_progress`, `blocked`, `halted`, `cycle_complete`, `state_error`.
- `lock` is `{state: absent|live|stale|foreign-host|unverifiable, pid, host, at, guard?: held|stale-guard}`, the lock that
  governs the directory (a trajectory reports its ablation's lock); the token is never printed.
- For a present state it adds `phase`, `cycle`, `strategy`, `protocolDigest`, `resumePhase`,
  `blocked{reason,retryable,missing[names],problemCount}`, `halted{reason,at}`, `cycleComplete`, `searchStop` (null while
  searching), `counters{candidates,noProgress}`, `final{verdict,candidate,adopt,explorationOnly,rolledBack,reasonCount}`,
  `adopted{at}`, `doneAt`, `updatedAt` and `lastInterruption{at,signal}`.
- `protocolDigest` is the sha256 of the locked protocol (the digest also recorded in `report.json` and the holdout ledger;
  not secret). In the summary it comes from the verified lock on disk; in an outcome's `status` from the state's binding. It
  is `null` before the lock step, and in the summary also when the lock cannot be verified (e.g. a halted state whose lock is
  damaged). A supervisor can pin the first digest it sees and treat any later change as a new experiment.
- An ablation directory lists `trajectories.A/B/C`.
- The summary never carries prompts, task or holdout content, problem texts, gate reasons or credentials.
- `lastInterruption` is history only. Older states' `interrupted` field is migrated to it, and neither decides an outcome.
- Exit 4 when the health is `missing` or `corrupt` (with `integrity` for a damaged protocol binding), else 0.
- Plain `--status` still prints the full `state.json`. When the health is `missing` or `corrupt` (including a damaged
  protocol binding of the loop or of a trajectory of an ablation directory) it then prints a `state_error` outcome line and
  exits 4, like `--summary` (formerly it exited 0 for a lost or structurally invalid state).

**Protocol binding.** The first `prepare` of a state directory writes `protocol.lock.json` (protocol, digests of every
evaluator file, dataset digest) and records in `state.json` the binding `protocolLock{protocolDigest,lockDigest}`, where
`lockDigest` covers the whole lock. Every later invocation checks, before prerequisites, grader validation, model calls,
holdout use or any write:

- The lock exists, parses, is well-formed and internally consistent (`protocolDigest` = digest of its protocol).
- It matches the state's binding and the journal (`events.jsonl`, whose hash chain must be intact): every
  `protocol-locked`/`protocol-bound` event names the same protocol digest (and lock digest, where recorded); a state whose
  journal recorded a lock digest must still carry its binding; a directory whose journal shows more than one
  `protocol-locked` event (an earlier re-lock) is refused. The trajectories of an ablation are bound to the same lock.
- A missing lock is created only for a fresh directory (a leftover `state.json.tmp-*` of an interrupted first write is not a
  record) or a provably pre-lock state: a crash, or a BLOCKED missing prerequisite or split validation,
  between creating `state.json` and writing the lock (phase `prepare`, cycle 1, no decisions, only `state.json`,
  `events.jsonl` with prepare/blocked phases, `grading.json` and a report without a protocol digest). Anything else with a
  missing lock is `state_error` `protocol_lock_missing`; the CLI never re-locks the current evaluator over existing evidence.
- An older state without a binding is bound to its existing, verified lock on the next run (event `protocol-bound`), never
  to the current evaluator. When the current protocol or evaluator differs from that lock it stays `blocked` as before.
- A halted state stays `halted` (exit 3) whatever its lock: a halt takes precedence. `--rollback` reads no lock and still
  works on any state.

The Loop API enforces the same checks (`prepare` throws `StateIntegrityError`; `runAblation` returns `state_error`;
`lockProtocol` only verifies unless the controller passes `create` for a proven pre-lock state). These checks detect lost,
partial or inconsistent records. They are not a signature: someone who rewrites `state.json`, the lock and `events.jsonl`
(recomputing its hash chain) together is not detected.

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

**Recovery.** Nothing clears a halt, a lost state, a damaged protocol binding or a protocol-lock BLOCKED automatically, and
there is no override flag. A missing or damaged `protocol.lock.json` is never regenerated: restore the original file (its
content must match the recorded binding) or continue in a new state directory.
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
| Efficiency (protocol-3, same gates) | Recurring gate-blocking failure classes (task-agent integrity, harness crash) are targeted first, with the critical reasons of recent rejected candidates as proposer evidence; harness checks (typecheck and the test suite under the adoption rule) run before any model run; once a critical problem is recorded no further screening/development unit of that candidate is dispatched (candidate before parent; a stopped round is never a sample or estimate); recorded outcomes are reused only for an identical unit key (harness commit, task, split, repeat, protocol and environment digest) and statistics use only the current identity. No token, cost or money limit exists (operator decision); the safety limits below are unchanged. Faux evidence: `test/efficiency.test.mjs`; savings on real runs are not measured yet |
| Real measurements | `abc-real-1` (protocol-1): truncated exploratory evidence (time-motivated 4-candidate cap, 3 evaluated per arm). `explore-real-2` (protocol-2): exploration-only train/dev search to the pre-registered stop; see `docs/results-explore-real-2.md` |
| Holdout | `holdout-v1` is implementer-authored and was consumed once by `abc-real-1`; it is not independent and is not reused |
| Holdout supply | `eval-loop-supply` collects real upstream changes of public npm projects (license-checked, provenance-recorded, deduplicated, validated in the grading sandbox), seals candidate-blind batches in a pool outside the package, and a protocol with `datasets.holdoutPool` reserves one per experiment; the engine blocks before any run without an eligible unused batch (docs/design.md §4). Supply tiers are a size proxy and never count as the hard stratum (`holdout.hardBasis`), so the first real batch is structurally valid but BLOCKED (no accepted hard task). The hard stratum comes from `collect-exercism`: Exercism JavaScript and TypeScript exercises whose maintainers rate them 8-10 (hard by Exercism's documented rubric; `difficultyBasis: "source"` with the annotation pinned; one problem once per pool across tracks). Batches cap one account at half of the sealed tasks; discovery caps repositories per account and rotates to unscanned projects; tests importing packages unavailable offline are rejected before validation; `refresh` runs everything unattended. Public code and exercises may be in pretraining data: not excluded (other-language benchmark listings are recorded per task) |
| Deployment | **BLOCKED**: no externally curated independent holdout exists. No adoption and no real performance improvement are claimed |
| Operational limits | Cost and time are not optimization targets; safety limits only: 200 candidates/cycle backstop, 72 h hang watchdog, 10 failed proposals per failure class since the last progress (cannot fire before the 10-candidate patience with the defaults), infra stops, 120 requests / 30 min per proposer session, 4 files / 200 diff lines per patch, 20 min / 150 requests per task unit (exact list: `docs/results-explore-real-2.md`) |
| Exploration quality | Not demonstrated: the 20 explore-real-2 proposals were variants of one hypothesis, and none targeted the integrity class that rejected them all (protocol-3 targets it first; whether that yields better candidates is not measured) |
| Diagnostics | No package typecheck script; `node pi-eval-loop/scripts/checkjs-compare.mjs <base> <out>` compares tsc checkJs output (record: `records/explore-real-2/checks/checkjs/`) |
| Packaging | Git submodule `pi-eval-loop/` of the umbrella (`zmfkzj/pi-eval-loop`, branch `main`). Its history continues the umbrella-directory commits it was converted from (`Imported-From:` trailers). The pinned commit must be pushed before fresh clones can initialize it |

## Protocol-4 (2026-11-06; local, not deployed)

- Default analysis plan is **exploratory**: the holdout still runs every protocol-3 gate plus a family-level check, but a
  passing candidate is `EXPLORATORY_SUPPORTED` (`final.adopt` false, nothing deployed). Only a complete, pre-registered
  **confirmatory** plan (`analysisPlan`, operator-written rationale document with sha256, effect size, alpha, coverage, shared
  series error budget) can produce `ADOPT`, and only when its confirmatory checks pass in addition to every original gate.
- Holdout arms run in one randomized, interleaved schedule frozen before the first run; `--confirm-adoption` re-measures an
  adoption on a separate sealed, unused batch (dormant until configured; never scheduled).
- `status@1` adds `final.evidence` and `acceptance` (candidate accepted / production adopted / confirmed kept apart; a missing
  confirmation is never reported as success). Experiments recorded under protocol-3 are refused read-only.
- Prerequisites of a confirmatory claim (2026-11-06): `studies/confirmatory-1/` holds the registered PROVISIONAL plan
  (`RATIONALE.md`, `protocol.json`, simulation `power.mjs` on real ctrl-ablation-1 records), the bounded calibration runner
  (`calibrate.mjs`, approval-gated) and `study.json`; private task material lives only in the git-ignored
  `agent_workflow/runs/eval-loop-confirmatory-1/`. `eval-loop-supply readiness --protocol studies/confirmatory-1/protocol.json
  --study studies/confirmatory-1/study.json` reports each prerequisite as fulfilled/provisional/blocked (read-only). Today:
  plan provisional (underpowered at typical effects), private review/calibration/main/confirmation blocked. Details:
  `docs/design.md` "Protocol-4".

## Recurring exploration-only route (2026-11-07; implemented in this clone, not deployed, dormant)

`bin/eval-loop-explore.mjs` (`src/explore-cycle.mjs`) speaks the same machine contract as `bin/eval-loop.mjs` for the modes the recurring orchestration uses. agent_workflow drives it with `evaluation: "exploration-only"`.

- `--status --summary` returns status@1 with `layout: "explore"` and an allowlisted `exploration` block (`outcome`, `code`, `batch`).
- `--preflight` returns preflight@1 with a `code`: `ok`, `supply-empty`, `runtime-wait`, `budget-exhausted`, `budget-unusable`, `prerequisite-failed` or `config-invalid`.
- `--resume [--require-state]` runs one cycle and returns outcome@1.
- `refresh --protocol` returns supply-refresh@1 (exit 0, 2 or 3).

The `--protocol` file is a `pi-eval-loop/exploration@1` config. Every path in it must be absolute. It names:
- the frozen candidate and stable harnesses, each with its runtime digest;
- the accepted screen report and its sha256, plus the screening tasks;
- the exploration pool;
- the lineage sources (non-empty lists of supply registries and earlier holdout datasets);
- the single budget ledger, with `limit`, `scope` and `minRemaining`;
- the isolated runtime, which may be `simulated` only together with `simulation.enabled`, for offline tests.

**How a cycle runs**
1. On init, the cycle binds to the sha256 of its config and to every evaluator file in `protocol.lock.json`. Any change after that is a `state_error`.
2. It re-checks lineage and retires contaminated, never-reserved batches with an evidence document.
3. It takes the pool's first eligible batch, freezes `plan.json`, and runs ONE pass with `src/exploration.mjs` `runHoldout`. That pass reserves the batch and records its single use before the first run; a resume reuses both.

Every final has `adopt: false`, `explorationOnly: true` and evidence class `exploratory`. Blocked paths get distinct codes and never dispatch a model call:
- supply and runtime waits are retryable;
- budget exhaustion and failed prerequisites are not.

A budget refusal in the middle of a pass pauses the pass. It stays blocked with `budget-exhausted` and no further attempt is made.

**Supply and evidence**
- **Collectors never seal the pool.** The pool's `POLICY.json` has `autoSeal: false`, so collectors and the generic `seal` never form batches; `src/lineage.mjs` `selectAndSeal` is the only sealing route. It does three things:
  - It reads every exclusion source, and fails closed if one is missing, has a broken hash chain, or is malformed or empty.
  - It excludes families, task ids, repositories and Exercism problem equivalents from registries, datasets, every pool batch, retired tasks that were not restaged, and the screening tasks.
  - It re-applies the same exclusion inside `sealBatch`, under the pool lock.
- **Refresh.** Each refresh rotates its discovery keywords and skips repositories the lineage registries already hold, before cloning them.
- **Evidence is never deleted at seal time.** Sealing moves each staged case byte for byte to `<pool>/evidence/<batch>/<id>` and registers the sha256 of every file the batch does not seal, such as `validation.private.json`.
- **Restage.** `retireBatch` restages from those exact bytes and verifies them; on any mismatch it refuses. A batch sealed before this change has no preserved evidence, so its restage records an `evidenceGap`. Under `POLICY.requireEvidence` such a case is never sealable. Missing or corrupt required evidence also makes a case unsealable.

**Required evidence (always enforced by the route, 2026-11-07).** Every case of an exploration batch must carry `validation.private.json` recording a PASSED validation (`{ok: true, code: "valid"}`). This holds whatever the pool's POLICY says: a config's `evidence.required` can only add files, and `evidence: false` or a malformed value is `config-invalid`.
- Sealed batches are re-checked before use (`batchEvidenceProblems`): the archive must exist, match its hashes and hold the required content. This includes a restart in phase `selected`.
- A batch that fails is retired without restaging and never consumed.
- Cases sealed or restaged before 2026-11-07 have no preserved evidence, so this route can never use them. Their records are kept as they are.

**Crash recovery.** `recoverPool` runs before every seal, retire, refresh and cycle init. It finishes interrupted seals (batch rename, batch record, evidence record, evidence move) and retirements (retire record, restage rename, restaged record):
- only hash-verified bytes are moved;
- orphan batch directories are moved aside, never used;
- tasks that cannot be verified are withdrawn as `restage-interrupted`;
- a second run changes nothing.

`test/supply-crash.test.mjs` SIGKILLs a real child process at each point (`src/util.mjs` `fault`).

**Real runtime path.** Every non-simulated cycle verifies the isolated runtime (`runtime.mode` live/test) and refuses to start in any of these cases:
- a misbound ledger (path, limit or scope);
- a foreign `EVAL_LOOP_UPSTREAM` or agent dir;
- an expired token (any mode).

It auto-starts the runtime when configured, and stops it when no other cycle uses it. It settles reservations left open by dead cycles at the attempt floor (`RequestBudget.reconcileDead`).

`test/explore-runtime.test.mjs` runs the pinned binary in bwrap against a TLS stand-in and checks that the provider never receives more requests than the gate admitted against the fixture ledger, across:
- expired credentials, a misbound ledger and a shared-gateway upstream;
- a failed start;
- a full pass with redirects and 500s;
- a cycle killed mid-pass and resumed;
- two concurrent cycles;
- budget exhaustion mid-pass, plus a restart.

The test is skipped, naming what is missing, without the pinned binary, bwrap or openssl.

**Tests:** `test/explore-cycle.test.mjs` runs the real CLI with a simulated target model and covers:
- two cycles on two different batches;
- an idle retry;
- an empty-supply wait;
- budget exhaustion across restarts;
- the fixed ledger cap;
- config binding;
- refresh exclusivity.

`test/evidence-lifecycle.test.mjs` and `test/exploratory-selection.test.mjs` cover the evidence lifecycle and the lineage selection. agent_workflow `test/integration/evalLoopExploration.test.ts` drives the same CLI through Temporal: planning, supply wait and refresh, two cycles, a follow-up that does not enable the schedule, and a budget stop.

**Rollout** (not executed; it needs human approval): agent_workflow `docs/운영-가이드.md` §8-9b.

## Autonomous lifecycle route (2026-11-07; `mode: "autonomous"`)

The same CLI (`bin/eval-loop-explore.mjs`) runs one durable state machine when the exploration config sets `mode: "autonomous"` and a `confirmation` section. agent_workflow drives it with `evaluation: "autonomous"` and its own schedule ID `aw-eval-loop-autonomous`. The three eval-loop schedule IDs are mutually exclusive: start, `aw schedule enable` and the follow-up all refuse while another one is enabled. The old adoptive route (`bin/eval-loop.mjs`, `aw-eval-loop`) is not used and stays paused.

**Config `confirmation`** (all paths absolute):
- `protocol` + `protocolSha256`: the registered confirmatory protocol (`analysisPlan.mode: confirmatory`, complete per `planCompleteness`).
- `readiness`: the study readiness record. It must carry `protocolSha256` equal to the registered protocol, and its `analysis-plan` condition must be `fulfilled`. Otherwise the code is `confirmation-plan-not-ready`. Power is never assumed.
- `attemptsPerUnit`: at least the measured per-unit maximum in `screen.runs` (`config-invalid` below it). `smokeAttempts`.
- `deploy.dir`: the release store (`src/lifecycle.mjs` `Releases`).

**Phases** (`explore.json` `phase`; status `lifecycle.stage`):
1. **Exploration**: `init → selected → running`, as in exploration-only mode. Its readiness, run before any batch is reserved, also requires:
   - the candidate differs from the deployed release (else `candidate-deployed`, stop);
   - the registered confirmation is ready (else `confirmation-plan-not-ready`, model-free wait);
   - the registered confirmation is affordable after this exploration from the same ledger, computed as 2 × (holdout + confirmation) minimum units × `attemptsPerUnit` + smoke (else `confirmation-infeasible`, stop; the cap is never raised);
   - the series alpha ledger still admits it (`seriesFits`).
2. **Promotion**: only a completed exploration with `EXPLORATORY_SUPPORTED` is promoted. The candidate arm must have no integrity or strict violations and no unmeasured units. Anything else ends as `explored-negative`.
3. **`promoted`**: writes `registration.json` (0400, sha256 kept in the state) BEFORE any confirmatory outcome. It holds the candidate, the baseline (the deployed release), the protocol and readiness sha256, the exploration final sha256 and the budget sizing. A changed deployed release makes the exploration evidence stale (`explored-negative`). A changed candidate tree is `prerequisite-failed`.
4. **`confirm-wait → confirm-selected → confirm-running`**:
   - **Batch**: a fresh, unused, sealed, lineage-clean batch meeting the registered holdout minima (tasks, families, accepted-basis hard tasks). If none exists, the code is `confirmation-supply-empty` (a model-free wait), and the pool records `selection/demand-confirmatory.json` so that `refresh` seals a batch of the registered size instead of exploration-sized ones.
   - **Headroom**: checked for the ACTUAL selected batch, plus the post-confirmation and smoke, before anything is reserved.
   - **Pass**: the plan (`confirm-plan.json`, sha256 in state) is frozen before the batch is consumed. `runHoldout` then runs with `analysis.mode: confirmatory`: alpha is spent once in the series ledger before consumption, the batch is used once, and both the original gate and `confirmatoryChecks` apply.
   - **Floors**: the protocol is merged over `exploreProtocol()`. `floorProblems` refuses any registered protocol that weakens holdout size, repeats, support, independence, hard stratum, family level, checks, owner share or prior-family reuse. Confirmation minima are `max`ed against the holdout floors.
5. **Adoption**: only `ADOPT` with `adopt: true`, `confirmatoryClaim: true`, no candidate violations and nothing unmeasured moves to `adopting`. Everything else is `confirm-negative`, never deployed.
6. **`adopting`**: `Releases.adopt` moves the release pointer by compare-and-swap from the registered baseline.
7. **`smoke`**: one run of the RESOLVED deployed tree, through the same gate and ledger. On failure, `Releases.rollback` → `rolled-back`.
8. **`postconfirm-wait → … → done`** (when `analysisPlan.confirmation.required`): the previous release is compared with the adopted one on a DIFFERENT fresh batch with the confirmation alpha. `CONFIRMED` gives `confirmed`. `NOT_CONFIRMED`, `INCONCLUSIVE` or a consumed `BLOCKED` gives rollback → `rolled-back`. Without a registered confirmation, the outcome is `adopted` with `confirmation: not-registered`.

**Status** keeps the four facts apart:
- `acceptance.stage`: `candidate-accepted-exploratory`, `adopted-unconfirmed`, `adopted-confirmed`, `rolled-back` or `not-accepted`;
- `final.verdict`/`adopt`: the gate decision;
- `lifecycle.deployed`: the release;
- `lifecycle.confirmation`.

**Releases** (`<deploy.dir>`, no git):
- `releases/<runtimeDigest>/`: content-addressed copies, verified before the atomic rename.
- `history.jsonl`: the hash-chained commit log (`init`/`adopt`/`rollback`, idempotent per key).
- `current.json`: a derived pointer, repaired from the history under `.deploy.lock`.
- SIGKILL at `release:after-store` / `release:after-record` converges to one consistent release (`test/lifecycle.test.mjs`).
- The consumer, the next cycle's stable arm, resolves the deployed release from the history.

**Tests**: `test/lifecycle.test.mjs` (simulated target model; real ledger, pool, seal, reservation, use, series and release code) covers:
- the full positive path to `CONFIRMED`, with supply waits;
- negative exploration;
- confirmatory gate rejection;
- smoke failure, `NOT_CONFIRMED` and `INCONCLUSIVE` rollbacks;
- plan-not-ready, an unbound readiness record, weakening floors, an unaffordable confirmation and an under-measured `attemptsPerUnit`;
- SIGKILL after the confirmatory use, with one use and one alpha spend;
- a stale candidate;
- ledger exhaustion before the confirmatory batch;
- release crash points.

agent_workflow `test/integration/evalLoopAutonomous.test.ts` drives it through Temporal.

## Practical screening route (2026-11-08; `mode: "screening"`, non-adopting default)

`src/screening.mjs`, run by the same CLI (`bin/eval-loop-explore.mjs`) when the exploration config sets `mode: "screening"` and a `screening` section. agent_workflow drives it with `evaluation: "screening"` and the schedule ID `aw-eval-loop-screening`. The four eval-loop schedule IDs exclude each other.

**What it is.** A cheap, fixed-budget feedback loop over a bounded candidate source. It does not replace the confirmatory/adoptive standard. Every final has `adopt: false` and `explorationOnly: true`. The stable reference never changes; nothing is deployed, promoted, committed or scheduled.

**Stages.** One cycle (one state directory) runs one action:
1. **smoke** (every candidate, model-free): the frozen tree must match its identity; runtime changes only under `src/` and `prompts/`, at most 4 files; the arms' typecheck and tests, candidate vs stable. A failure ends the candidate as `SMOKE_REJECTED`, with zero target calls.
2. **dev** (candidates that pass smoke, in the same cycle): one interleaved stable-vs-candidate pass on the configured reusable development tasks (`screening.dev.tasks`, frozen with per-task digests). Any candidate integrity problem stops further dispatch and gives `DEV_REJECTED`. Verdicts: `DEV_PROMISING` (net successes >= `promote.minNetSuccesses` and hidden passes not below the stable's), `DEV_NEGATIVE` (net <= 0), or `DEV_INCONCLUSIVE` (anything else, unmeasured units, cap/time stop, infrastructure errors). The evidence class is `development`: selection feedback, never confirmation, never a power claim.
3. **holdout** (only `DEV_PROMISING`, at most once per candidate): one exploration-only pass (`runHoldout`, every existing gate and safeguard) on one fresh, sealed, unused, lineage-clean batch. The development tasks' families are excluded from batches. The best verdict is `EXPLORATORY_SUPPORTED`, never an adoption.

**Development tasks (eligibility, fail closed).** A development task is reusable across candidates, but only if it was prospectively designated as development material and never held out. `devEligibility` checks every configured task:
- before planning, before the first paid unit, and when a frozen plan resumes;
- the dataset must be a sealed batch (SEAL.json verifies) whose PROVENANCE.json purpose is `calibration` or `development` and lists the task;
- the batch must never have been reserved or used (no `USES.jsonl`);
- the task must not appear in any configured exclusion list (`dev.exclusions`, sha256-pinned);
- its id, family and cross-track Exercism problem must occur in no historical holdout source: lineage registries, lineage datasets, holdout-purpose/reserved/used/retired pool batches.

A missing, broken or empty source makes every task ineligible; it never yields an empty exclusion list. With fewer than `dev.minTasks` eligible tasks, pending candidates wait as `dev-supply-empty` (model-free). Former holdouts are never filled in.

**Development exposure.** Each dev claim records its planned tasks as a registry `dev-exposure` (conservative). Those tasks and the config's `exposedDevTasks` join `screen.tasks`, so batch selection and the pre-use lineage check keep them and their families out of every new holdout. Descendants inherit their ancestors' development exposure (`devExposure`, informational).

**Candidates.** Sources are bounded by `maxCandidates`:
- `archive`: an earlier loop's candidate archive. Default statuses: promoted, dev_qualified, selected, holdout_blocked, inconclusive. The patch chain is resolved through `parent` to the stable commit and applied with `git apply` to a copy of the stable tree under `workDir/trees`.
- `tree`: a frozen tree with its identity.

The series registry (`screening.registry`, hash-chained) is keyed by the runtime digest. It holds candidates, aliases, claims and stage results:
- the same patch or digest is an alias and is never run twice;
- the rotation follows registration order;
- a retry or a new cycle never repeats a paid stage.

`screening.history` records holdout exposures that happened before this route. A candidate already exposed to a final holdout never gets another one. Neither does a candidate created after a parent's exposure (tuned after a holdout result).

**Budget.** All attempts go through the ONE ledger of the config (its ceiling is fixed at creation) and the isolated runtime's outbound gate. `CappedBudget` refuses a reservation when this route's charged attempts (settled + open worst case, read from that ledger, tagged `meta.route = "screening"`) would exceed any of these:
- `caps.dev` / `caps.holdout` (per stage);
- `caps.perCandidate`;
- `caps.perCycle`;
- `caps.cumulative`.

It also refuses after the stage's persisted deadline (`dev.maxHours`, `holdout.maxHours`). Before any stage, the planner requires the whole stage cap as headroom. A qualified candidate waiting for supply keeps its holdout headroom reserved from further dev spending. In live mode, a ledger whose settled charges exceed its outbound attempts is refused. A series lock admits one screening cycle at a time.

**Waits and stops** (`exploration.code`):
- model-free waits: `no-candidate`, `dev-supply-empty` (pending candidates but too few eligible development tasks; no refresh), `supply-empty` (only a qualified candidate waiting; triggers the refresh), `runtime-wait`;
- stops: `budget-exhausted` (caps or ledger cannot fund the next stage, or a cumulative/global refusal mid-pass), `time-exhausted` (holdout deadline), `prerequisite-failed` (immutable input drift, grader failure). Nothing expands a cap.
- A cap or deadline hit during dev ends the stage cheaply as `DEV_INCONCLUSIVE`.

**Tests:** `test/screening.test.mjs` runs the real CLI with a simulated target model. It covers:
- smoke rejection without a model, archive dedupe;
- dev negative, rejected (early elimination) and promising;
- supply wait, then one holdout, then no second holdout even with fresh supply;
- no-candidate wait;
- exhausted cumulative cap, stage deadline, stage cap, cumulative refusal mid-pass;
- series lock, SIGKILL mid-dev + resume;
- candidate, dev-task and config drift;
- development eligibility: holdout-purpose, missing-provenance, used, holdout-family, cross-track Exercism, sealed holdout pool batch, exclusion list and its sha, missing or tampered sources (fail closed);
- dev-supply wait with pending candidates (zero calls, no claim);
- a dev-set change that never re-runs decided candidates, observed dev tasks kept out of new holdout batches, descendant exposure;
- never an adoption.

agent_workflow `test/integration/evalLoopScreening.test.ts` drives it through Temporal.


## Layout

| Path | Contents |
|---|---|
| `bin/eval-loop.mjs` | CLI entry |
| `src/cli.mjs` | CLI modes, preflight, supervised step, lock, signal/exit cleanup |
| `src/contract.mjs` | Outcome/exit-code table, state health, public status summary |
| `extension/index.js` | Pi command |
| `src/loop.mjs` | Phases, state machine, watchdog |
| `src/protocol.mjs` | Pre-registered defaults, the lock and the state's lock binding |
| `src/stats.mjs` | Paired, clustered Bayesian bootstrap |
| `src/gate.mjs` | Screening, development and adoption gates |
| `src/archive.mjs` | Lineage, dedup, Pareto front |
| `src/datasets.mjs` | Splits, exposure scan, seal, holdout use ledger |
| `src/supply.mjs`, `src/supply-cli.mjs`, `bin/eval-loop-supply.mjs` | Public-source holdout supply: discovery, adaptation, license/provenance, overlap, validation, sealed batches, reservations, preflight |
| `src/supply-exercism.mjs` | Annotated holdout source: Exercism JavaScript and TypeScript tracks (maintainer difficulty + documented rubric -> `difficultyBasis: "source"`), node:test bridge for the unchanged jest spec with vendored `expect`, cross-track problem dedupe, benchmark listings per language |
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
| `experiments/ctrl-ablation/` | Preregistered controlled ablation of orche (separate driver, never adopts): `run.mjs`, `analyze.mjs`, `fidelity.mjs`, variant patches; results `docs/results-ctrl-ablation-1.md` |
| `experiments/ctrl-confirm-2/` | Prospectively registered confirmation (2 x 2: orche / pure Pi x test-preservation rule, disclosed integrity contract, legacy-scored co-primary valid rate + reliable success) on a fresh workspace-local external holdout: `supply.mjs`, `assemble.mjs`, `run.mjs`, `analyze.mjs`, `fidelity.mjs`, `power.mjs`; results `docs/results-ctrl-confirm-2.md` |

Tests: `npm test` in this directory (`EL_TEST_TMP` sets the temp root). Root `npm run test:compat` runs them too. The
unattended contract is covered by `test/lifecycle.test.mjs`, `test/lock.test.mjs`, `test/cli-contract.test.mjs` and
`test/protocol-lock.test.mjs` (protocol binding).
