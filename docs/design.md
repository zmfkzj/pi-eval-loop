# pi-eval-loop: design, protocol, security and research basis

Measured results: [`results-explore-real-2.md`](results-explore-real-2.md) (protocol-2, exploration-only train/dev search) and
[`results-abc-real-1.md`](results-abc-real-1.md) (protocol-1, truncated exploratory evidence).

pi-eval-loop is a headless, resumable program. It improves the pi-orche harness by running evaluation, failure analysis, candidate
patches, screening, development, a quality Pareto archive, one final holdout, an adoption gate and rollback. No user takes part. Every
required piece of state lives on disk. Nothing depends on an LLM conversation.

It is an **in-umbrella subextension**: the directory `pi-eval-loop/` of the oh-my-pi-extensions umbrella, listed in the umbrella's Pi
manifest. It is **not (yet) a standalone Git submodule**. A submodule needs its own remote repository, and creating or pushing one
was not authorized. A gitlink without a reachable remote would break every other clone (bootstrap/install). Turning it into a
submodule later takes four steps: create the remote, `git subtree split -P pi-eval-loop`, push, then replace the directory with a
submodule.

## 1. Loop and phases

```
prepare -> baselines -> search (repeat: parent -> analysis -> proposal -> integrity -> build -> screening -> development) -> select
        -> holdout (once) -> adoption gate -> adopt (local refs) -> post-adoption check (automatic rollback) -> done
```

| Phase | What happens | Code |
|---|---|---|
| prepare | Checks prerequisites (missing ones end in BLOCKED; nothing is simulated). Validates the grader of every task: the original must fail, the reference must pass. Builds family-grouped train/dev splits. Verifies the sealed holdout. Locks the protocol (sha256 of the protocol, every evaluator file and the dataset manifest). | `src/loop.mjs` `prepare`, `src/protocol.mjs` `lockProtocol` |
| baselines | Runs stable orche on train and dev; pure Pi (no extension) on train and dev; a k=3 independent-attempt pure-Pi arm on dev that submits the first attempt whose VISIBLE tests pass (no hidden information is used); the target mode's existing implementation (= stable when the target is `single`). The k-attempt arm *allows* up to k attempts; whether it used more compute is a measurement (reports list allowed vs actual attempts, requests and tokens per unit). It is not called equal-compute or opportunity-matched unless those measurements show it. | `baselines`, `baselineHarnesses` |
| search | Selects a parent (Pareto: archive front plus development-qualified; greedy: the current best only). Analyzes failures (train). The proposer edits a copy of the harness runtime. Then patch integrity, dedup, commit on the isolated branch `eval-loop/candidates/<ns>/<id>`, typecheck, adaptive screening, development. | `newCandidate`, `screen`, `develop` |
| select | Picks the best development-qualified candidate without a family regression and freezes it (`selection.json`, digest) BEFORE any holdout access. | `select` |
| holdout | Appends the use to the holdout's hash-chained `USES.jsonl` before the first run. Then one pass over all arms. | `holdout` |
| adopt / post-adopt | Crash-safe local ref adoption, a smoke run, automatic rollback on a crash or route violation. | `src/deploy.mjs`, `adopt`, `postAdopt` |

Search stop (protocol-2, pre-registered): the search cycle ends after **10 consecutive candidates without meaningful progress**
(the user's default). Progress means: Pareto loop, a development-qualified, critical-clean candidate that no other development-set
member weakly dominates (a tie is not progress); quality-only loop, a new single best. Point comparisons use a 1e-9 tolerance
(`POINT_EPS`, `src/archive.mjs`), so identical outcomes summed in another order are a tie, never progress, domination or a win over
stable. The other rules are safety stops, none motivated by cost or time:
- a failure class is exhausted after `maxFailuresPerClass` failed proposals targeting it among the consecutive no-progress
  candidates since the last progress (or the cycle start). Every counted failure is a no-progress candidate, so exhaustion can
  never end a cycle before the patience. With the defaults (10 and 10) it cannot fire first at all: it only blocks a class and
  rotates the target when a protocol sets it below `noProgressCandidates` (identical patches and near-identical failed
  hypotheses are refused anyway; the cycle ends when no addressable class remains). The explore-real-2 run used the earlier
  cumulative-per-cycle count; there both stops fell on the same candidate;
- a runaway backstop of 200 candidates per cycle (a fully evaluated candidate keeps ≤ ~90 MB of worktree and evidence);
- a 72 h cycle hang watchdog;
- 5 consecutive infrastructure-tainted candidates; a trust-boundary breach halts at once.

The stop reason and the failed proposals per class are recorded (`state.searchStop`, `state.classFailures`, the report). The
candidate cap never interrupts an in-flight candidate. protocol-1's measured run `abc-real-1` used a 4-candidate cap set by session
time; that cap is withdrawn and the run is marked truncated. A finished cycle restarts (`--daemon`, or
`--once` again) only when its fingerprint changes: orche HEAD, stable, task digests, environment or protocol.

Exploration-only protocol: `datasets.holdout: null` loads, grades and consumes no holdout. The cycle ends after selection with
deployment **BLOCKED** (recorded separately from the exploration outcome); `--ablation` freezes B/C finals and skips the joint
holdout pass. This is how train/dev search continues after the only holdout was consumed (`protocols/explore-real-2.json`).

Persistence: `state.json` and `selection.json` are written atomically (tmp + fsync + rename). `runs.jsonl`, `events.jsonl`,
`stable-history.jsonl` and `USES.jsonl` are append-only hash chains (`Ledger.verify`). A pid lock prevents duplicate runs. Every
unit is journaled (`dispatch`, with run id and control dir) before its model requests. After a crash, reconcile reads the proxy's
wire journal. If any model call completed, the run is recorded as `aborted` (a failure in the denominator, never redrawn).
Otherwise it is `infra_error` and may be retried (`infra.maxRetries` = 1). On SIGINT/SIGTERM/SIGHUP the CLI kills every sandbox
process group.

## 2. Metrics

Every record has the requested fields:
- task_success, correctness_score, terminal_status, hidden_test_pass, regression_count, critical_failure_count
- input_tokens, output_tokens, cache_tokens, wall_time
- model_route, thinking_effort, environment_digest, harness_commit, candidate_id

Plus visible-test outcome, integrity details, failure class and evidence paths (`src/metrics.mjs`). repeat_success_rate and
hard_task_success_rate come from `summarize`.

A run counts as a success only when ALL of these hold:
- the controller saw `completed`;
- the independent hidden grading passed;
- visible tests are not failing;
- there is no integrity violation.

Terminal states are timeout, aborted, model_unavailable, model_error, agent_error, infra_error, harness_crash, route_violation and
completed. They come from controller observations (exit, guard, wire journal, proxy totals), never from files the agent wrote.

## 3. Statistics (quality-first adaptation of ParetoSaddler)

Source: arXiv:2611.02079, "ParetoSaddler: Pareto-Guided Optimization of Agent Harnesses for Quality and Cost". Qian, Park, Tan, Yu,
Zhang, Cavallaro, Xia, Chen, Xu, Kang, Zheng, Somashekar, Zhang, Bansal, Lin, Rühle (16 authors), submitted 1 Nov 2026. The
abstract page and the HTML full text were read on 2026-11-04. What this package takes from the paper, with sections and equations:

- Separation of intermediate promotion from final deployment selection (abstract, Sec. 4).
- Repeated executions per task, and the Bayesian bootstrap (Rubin 1981) with J = 10,000 draws.
- The promotion event E = [ΔQ>0 ∧ ΔC≤ε_C] ∨ [ΔC<0 ∧ ΔQ≥−ε_Q] (Eq. 7) and support p̂ = mean 1{E} ≥ γ (Eq. 8).
- The paper's own settings: γ = 0.7, ε_Q = 0.1, ε_C = +∞, training mini-batches of 3 tasks (Sec. 5).

**This package adapts the method; it does not reproduce the paper.** It reuses none of the authors' code (AutoSaddler, EvoDAG).
Its differences from the paper:

- **Objectives**: there is no cost objective. The quality objectives are Q_overall (success rate), Q_hard (hard-stratum success
  rate) and Q_consistency (mean of p², which rewards repeat stability). Tokens and time are only recorded.
- **Promotion event**: some objective improves (> minGain) while every other objective loses at most its allowance. The allowance
  for Q_overall is at most 3 percentage points (validated). Q_hard and Q_consistency each have 5 points.
- **Uncertainty levels**:
  - `execution`: the paper's estimator. Repeats are Dirichlet; tasks are fixed.
  - `task`: task weights ~ Dirichlet, shared by both arms (a paired contrast), with repeats nested per task and arm.
  - `family`: clustered by task family.
  - Screening uses `execution` (γ = 0.80, as in the paper). Development and adoption use `task` (adoption γ = 0.95). A
    deterministic test shows that the task level is more cautious when a gain comes from one task
    (`test/stats-gate.test.mjs`).
- **Adaptive screening**: at least 3 repeats. A result within ±0.10 of γ is EXTENDED by 3 repeats, up to 9. If it is still near
  the threshold, the candidate is INCONCLUSIVE: kept in the archive, never deployed.
- **Deployment**: adoption requires all of the following. A failure on any of them is BLOCKED, too little evidence is
  INCONCLUSIVE, and no improvement is KEEP_STABLE:
  - an overall improvement with support ≥ 0.95 at task level on an independent holdout;
  - no family regression;
  - ≥ 6 tasks and ≥ 4 families with a hard stratum;
  - no critical failure anywhere in the candidate's record (train, dev and holdout, every attempt);
  - complete units;
  - passing checks;
  - one environment/route digest.
- Bootstrap support is a posterior-predictive fraction under this resampling model. It is **not** the probability that a harness
  generalizes. Resampling few runs does not create observations.
- Point estimates (development points of the archive, the Pareto front, progress, selection and the reports) are the exact
  plug-in values (uniform task weights, raw repeat means). protocol-1 used the bootstrap Monte Carlo mean there, which let
  sampling noise separate identical outcomes (e.g. B-c001 vs stable in `abc-real-1`).

## 4. Datasets

- **Train/dev**: orche's `fixtures/suite`, 27 gradable coding tasks (rubric-only tasks excluded). Tiers: a = easy, b/c = medium,
  d/p = hard. Family = the task repository's package name, with the p-series as one family; there is no family overlap across
  splits (validated). These tasks were used by earlier orche experiments. They are **exposed** and never serve as a holdout.
- **Holdout**: `datasets/holdout-v1`, 7 fresh tasks in 7 families (1 easy, 3 medium, 3 hard), sealed (`SEAL.json`, sha256 of every
  file; any symlink breaks the seal) and committed before the first search (commit 2edcef1). **Provenance:
  implementer-authored** — written by the agent that built this loop. The optimizer never saw them. They are synthetic, not
  externally curated, and prove nothing about broad generalization. The default protocol therefore accepts only `external`
  provenance for an adoption: on holdout-v1 the holdout is measured once, but deployment stays BLOCKED. An operator may accept
  the label only in a new protocol version, which is visible in the lock and the report.
- **Single use**: a use is recorded before the first holdout run. After `maxUses` (1) uses the set is no longer independent. A
  tampered ledger is detected. holdout-v1 was used once by `abc-real-1` (2026-11-04): it is consumed, must not be reused for
  tuning, and is not loaded by `explore-real-2`. Until an externally curated, unexposed holdout is added in a new protocol
  version, **deployment stays BLOCKED**.

## 5. Trust boundaries and integrity

Mechanical enforcement:

| Boundary | Mechanism | Test |
|---|---|---|
| Task agents see only their workspace and the harness runtime (`src`, `prompts`, `package.json`, `tsconfig.json`). Not visible: orche fixtures (train/dev hidden tests, references), tests, experiments, `.git`. | bwrap: host read-only, `/home /tmp /var/tmp /run /opt /mnt /media /srv /root` replaced by tmpfs, no network; `agentBinds` | `test/isolation.test.mjs` (probes from inside a real sandbox, including planted symlinks into credentials, holdout and suite) |
| The model is reachable only through a unix socket: an endpoint gate allows the model list and Responses only, in front of witness-replay's fail-closed pinned-route proxy (real key swapped in on the host; the sandbox holds a placeholder) | `src/sandbox.mjs` `startModelPath`, `ALLOWED` | real smoke runs; proxy refusals become `route_violation` |
| The proposer edits a COPY of the harness runtime. The trusted host copies regular-file changes back (symlinks refused). Then patch integrity checks them (changed paths listed with rename detection off, so a moved file reports its deleted source too, and a rename counts both paths and the whole file against the 4-file / 200-line limits): allowed paths `src/`, `prompts/`; tests, runner/module config, package.json and env files are protected even there; no test-environment detection or forced exits, no evaluation-aware or task-specific content, no new network access; at most 4 files and 200 lines | `src/proposer.mjs`, `src/integrity.mjs` `patchIntegrity` | `test/integrity.test.mjs` |
| The evaluator, grader, protocol, splits, baseline snapshot, results and holdout seal are outside every candidate sandbox. Their digests are compared before and after each proposal: a change halts the loop as a trust-boundary breach. | `protectedState`, `lockProtocol` | `test/loop.test.mjs` |
| Grading runs in its own sandbox on a disposable copy (visible, hidden, custom). The hidden test count must equal the reference count. | `src/grader.mjs` | grader validation in prepare |
| Workspace integrity (ultra-ab rules reused) plus symlinks, module rewiring, runner injection, test detection and grading-material references. protocol-2: a task-agent violation, leak attempt, route violation or harness crash in ANY run attempt under a candidate is critical and rejects it at screening, development, selection and adoption, whatever the baseline did (the reference count is reported as context only). Harness-candidate violations (its patch) are rejected at proposal time. The stable incumbent's own violations are reported, not excused. | `workspaceIntegrity`, `criticalProblems` | `test/integrity.test.mjs`, `test/critical-exploration.test.mjs` |
| Check results fail closed: a missing, partial, early-exit or forged vitest summary fails, as do fewer or skipped tests, a non-zero exit without failed tests, or tests failing only with the candidate. Failures shared with stable in the same sandbox are listed as environment failures. | `src/checks.mjs` `compareChecks` | `test/integrity.test.mjs` |
| Results cannot be omitted or forged: hash-chained ledgers; every scheduled unit must have a final record (`missingUnits`), else BLOCKED | `Ledger`, `missingUnits` | `test/integrity.test.mjs`, `test/stats-gate.test.mjs` |
| Controlled conditions: every compared harness runs on one route and effort (all orche tiers pinned); the environment digest is recorded per run | `orcheConfig`, `environmentDigest` | `test/integrity.test.mjs` |

Self-attestation is never evidence: an agent's final message and any file it writes are ignored for terminal state and success.
An LLM is used only as the proposer (outside the compared harnesses, on its own route), never as a judge.

## 6. Archive, lineage and selection

`candidates/<id>/candidate.json` holds:
- parent, children, the isolated branch and commit;
- the diff, the hypothesis and the targeted failure class;
- screening (support, MCSE, repeats, decisions) and development (vs stable, family deltas, Pareto point);
- every decision with its reason.

Statuses cover rejected_patch, duplicate, build_failed, screening, promoted, rejected, inconclusive, dev_rejected, dev_qualified, selected,
holdout_blocked, holdout_kept_stable, adopted and rolled_back. Development-qualified candidates are never deleted, even when
dominated. Duplicates are refused by normalized patch hash and hypothesis similarity, and failure classes and parents that keep
failing are capped.

## 7. Adoption and rollback

Adoption moves only LOCAL refs: `refs/heads/eval-loop/stable` in orche, and an umbrella commit with the same tree and the new orche
gitlink on the umbrella's `eval-loop/stable`. It never touches a checkout, `main`/`master` or a remote. Steps:

1. The intent (the previous snapshot and the planned umbrella commit) is journaled before any ref moves.
2. Each ref moves by compare-and-swap from its recorded value.
3. A resumed adoption reuses the intent, so it never treats a half-changed state as the rollback target.

The previous snapshot records the umbrella commit, every submodule gitlink and checkout HEAD, the configuration digests (with the
bytes of loop-owned configuration kept) and the evaluation.

Rollback restores refs and configuration and verifies refs, the effective commit, every gitlink and the configuration. It is
idempotent. It runs automatically:
- after a post-adoption crash or route violation;
- after `--verify-stable --tasks <sealed dir>`, which compares the previous stable with the adopted harness on a sealed task set
  that selection never saw: a supported regression (≥ .95) rolls back.

Crash points are tested in `test/deploy.test.mjs`.

## 8. A/B/C

`--ablation` runs three conditions:

- **A**: the stable harness. Its baselines are measured once and shared.
- **B**: a quality-only loop with one greedy trajectory: analysis, patch, repeated evaluation, current best as the only parent, no
  Pareto archive.
- **C**: the full quality-first Pareto loop.

B and C are separate trajectories with the same tasks, protocol, route, proposer and pre-registered stopping rule (so the number
of candidates each uses is an outcome, reported per arm). Their finals are frozen first. A, B and C then share ONE holdout pass
through A's ordinary holdout → adoption gate → adopt → post-adoption path (exploration-only protocols stop after freezing). The
report covers:
- each condition's quality with exact points and intervals (development: descriptive and selection-biased);
- candidates, screening/development runs, tokens and proposer usage;
- the contrasts B−A, C−A and C−B with support.

Unsupported differences are reported as uncertain. Conditions are not compute-matched, so the report lists each one's actual
model usage. The k-attempt baseline can separate extra compute from harness effects only to the extent that its measured attempts,
requests and tokens show extra compute was actually used.

## 9. Generalizing beyond pi-orche

A harness is `{ id, kind, commit, mode, dir }`; a task is `{ id, family, tier, instruction, repo, hidden, reference }`. To support
another extension:
- add a harness kind to `src/runner.mjs` (which extension file to load, which runtime paths to mount);
- point `datasets` at its tasks;
- give tasks without executable grading a custom `grade.mjs`.

Tasks that cannot be graded objectively must not be counted as successes from an LLM judgment alone.
