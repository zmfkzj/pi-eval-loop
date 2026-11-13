# pi-eval-loop: design, protocol, security and research basis

Measured results: [`results-explore-real-2.md`](results-explore-real-2.md) (protocol-2, exploration-only train/dev search) and
[`results-abc-real-1.md`](results-abc-real-1.md) (protocol-1, truncated exploratory evidence).

pi-eval-loop is a headless, resumable program. It improves the pi-orche harness by running evaluation, failure analysis, candidate
patches, screening, development, a quality Pareto archive, one final holdout, an adoption gate and rollback. No user takes part. Every
required piece of state lives on disk. Nothing depends on an LLM conversation.

It is a **Git submodule** of the oh-my-pi-extensions umbrella: path `pi-eval-loop/`, repository `zmfkzj/pi-eval-loop`, branch
`main`. The umbrella lists it in its Pi manifest. It was first developed as an umbrella-tracked directory. Its submodule history
continues that work: each umbrella commit that touched `pi-eval-loop/` after the repository's first commit was imported with an
identical tree and an `Imported-From:` trailer. The package is not standalone: it evaluates the sibling `../orche` checkout and
reuses that checkout's sandbox helpers (`EVAL_LOOP_UMBRELLA` points a frozen copy at the live umbrella). The deploy snapshots
record every umbrella gitlink, so this submodule's own gitlink is recorded and verified like the others.

## 1. Loop and phases

```
prepare -> baselines -> search (repeat: parent -> analysis -> proposal -> integrity -> build -> screening -> development) -> select
        -> holdout (once) -> adoption gate -> adopt (local refs) -> post-adoption check (automatic rollback) -> done
```

| Phase | What happens | Code |
|---|---|---|
| prepare | First checks the state directory's integrity and protocol binding (a lost state or a missing, damaged or contradicting lock is a `StateIntegrityError`, nothing written) and an existing lock against the current protocol and evaluator bytes. Checks prerequisites (missing ones end in BLOCKED; nothing is simulated). Validates the grader of every task: the original must fail, the reference must pass. Builds family-grouped train/dev splits. Verifies the sealed holdout. Locks the protocol (sha256 of the protocol, every evaluator file and the dataset manifest) once, for a fresh or provably pre-lock state only, and records the binding (`state.protocolLock`). | `src/loop.mjs` `prepare`, `src/protocol.mjs` `lockProtocol`, `src/contract.mjs` `inspectProtocol` |
| baselines | Runs stable orche on train and dev; pure Pi (no extension) on train and dev; a k=3 independent-attempt pure-Pi arm on dev that submits the first attempt whose VISIBLE tests pass (no hidden information is used); the target mode's existing implementation (= stable when the target is `single`). The k-attempt arm *allows* up to k attempts; whether it used more compute is a measurement (reports list allowed vs actual attempts, requests and tokens per unit). It is not called equal-compute or opportunity-matched unless those measurements show it. | `baselines`, `baselineHarnesses` |
| search | Selects a parent (Pareto: archive front plus development-qualified; greedy: the current best only). Analyzes failures (train). The proposer edits a copy of the harness runtime. Then patch integrity, dedup, commit on the isolated branch `eval-loop/candidates/<ns>/<id>`, precheck (typecheck and test suite), adaptive screening, development (both stop dispatching on a recorded critical problem). | `newCandidate`, `screen`, `develop` |
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
- 5 consecutive infrastructure-tainted candidates; a trust-boundary breach halts at once (`state.halted`, terminal for the state
  directory: no later invocation explores, selects, consumes the holdout, adopts or starts a cycle; A/B/C siblings halt too).

The stop reason and the failed proposals per class are recorded (`state.searchStop`, `state.classFailures`, the report). The
candidate cap never interrupts an in-flight candidate. protocol-1's measured run `abc-real-1` used a 4-candidate cap set by session
time; that cap is withdrawn and the run is marked truncated. A finished cycle restarts (`--daemon`, or
`--once` again) only when its fingerprint changes: orche HEAD, stable, task digests, environment or protocol.

Efficiency (protocol-3; gates, thresholds and decision rules unchanged; `efficiency` in the protocol). explore-real-2 spent
85 % of its task-agent input tokens on screening, and all 20 candidates were rejected because task agents edited existing tests
under them, while every proposal targeted another class. protocol-3 therefore removes work that cannot change a decision:
- **Failure-driven targeting** (`gateBlockingFirst`): a class the critical gate rejects on ONE run (`integrity`, `harness-crash`;
  `src/analysis.mjs` `GATE_BLOCKING`) is targeted first while it recurs (parent train runs + recent critical rejections >= 2). The
  proposer also gets `rejections.json`: the violation texts of recent critical rejections (no task id, split, repeat or holdout
  material). This connects the observed failure (agents changing existing tests) to candidates that change how the harness
  instructs its agents; it does not by itself make any candidate better, which only the evaluation can show.
- **Precheck** (`precheck: ["typecheck", "test"]`): the candidate's harness checks run before any model run, and "test" applies the
  adoption rule (`compareChecks` against stable's checks, measured once per stable commit and environment). A candidate failing it
  could never be adopted. Status `build_failed`. Flaky orche tests can reject a candidate here as they would at adoption.
- **Early critical stop** (`stopOnCritical`): the candidate's screening units run before the parent's (repeat-major, tasks where
  the parent showed critical problems first), and once ANY recorded attempt of the candidate in scope has a critical problem no
  further unit of that candidate (nor the parent's units of that round) is dispatched; units already running finish and are
  recorded, and a resumed round with decided evidence dispatches nothing. Development (dev, then the candidate's own train runs)
  stops the same way and records `dev_rejected` without a development point. The decision is the one the full round would reach
  (a critical problem rejects whatever the statistics; the full round contains the same runs); a stopped round is never a
  sample, estimate or progress. Faux replay (`test/efficiency.test.mjs`): 6 candidates all rejected for integrity, candidate
  screening units 72 -> 22 with identical decisions; a valid candidate runs every unit with an identical development point.
  Counterfactual on the recorded explore-real-2 screening outcomes (dispatch waves of 6, the whole wave counted): 360 -> 144
  candidate units, 129.4 M -> 56.8 M input tokens. That replay assumes the same outcomes in another dispatch order; it is an
  estimate, not a measurement.
- **Reuse only for an identical identity**: a recorded outcome is reused only under the same unit key: harness id and commit,
  task, split, repeat, protocol digest (route, effort, unit limits, seed) and environment digest (node, Pi CLI file and version,
  provider package and entry, bwrap, route; `environmentDigest` does not hash every dependency file, so it is an identity check, not
  proof of identical behaviour). Task contents, grader expectations and evaluator bytes are fixed per state by the lock. Within a
  state directory this reuses the parent's screening units, a candidate's screening units in its development train runs, and the
  baselines of a next cycle when nothing in that identity changed. Every statistic (`Loop.samples()`) uses only records of the
  current protocol and environment and, for the stable arms, of the current stable commit; critical checks keep reading every
  record and attempt. An environment change inside a cycle (search or holdout phase) blocks (`retryable: false`) instead of
  comparing across environments; before the search the baselines are measured in the current environment, and after the cycle
  the next one starts in the new environment. Nothing is reused across state directories or protocol versions (a new holdout
  means a new protocol version and new baselines).
- **No budget**: there is no token, cost or money limit or quota (operator decision); `merge` rejects unknown keys, so none can
  be configured by accident. Cost still never enters a gate; the non-financial safety stops above are unchanged.

Exploration-only protocol: `datasets.holdout: null` loads, grades and consumes no holdout. The cycle ends after selection with
deployment **BLOCKED** (recorded separately from the exploration outcome); `--ablation` freezes B/C finals and skips the joint
holdout pass. This is how train/dev search continues after the only holdout was consumed (`protocols/explore-real-2.json`).

Persistence: `state.json` and `selection.json` are written atomically (tmp + fsync + rename). `runs.jsonl`, `events.jsonl`,
`stable-history.jsonl` and `USES.jsonl` are append-only hash chains (`Ledger.verify`). `state.json` exists from the first step;
records without it are a lost state that no invocation re-initializes (`src/contract.mjs` `inspectState`). Likewise a state is
bound to its `protocol.lock.json` (`state.protocolLock`: protocol digest and digest of the whole lock); a missing, unreadable,
malformed or contradicting lock is a `state_error` and is never re-created for the current evaluator, except before the lock
step of a fresh directory (`inspectProtocol`). A controller lock
with host, boot id, PID namespace, pid start time and token prevents duplicate runs; only verified-dead or reused-pid locks are recovered,
under a reclaim guard (`src/util.mjs` `acquireLock`). Every
unit is journaled (`dispatch`, with run id and control dir) before its model requests. After a crash, reconcile reads the proxy's
wire journal. If any model call completed, the run is recorded as `aborted` (a failure in the denominator, never redrawn).
Otherwise it is `infra_error` and may be retried (`infra.maxRetries` = 1). On SIGINT/SIGTERM/SIGHUP the CLI kills every running
sandbox process group and route proxy, records `state.lastInterruption` (history only) and exits 130. A BLOCKED state records
the phase it interrupted (`blocked.resumePhase`) and resumes there when the cause clears, so a finished, adopting or
post-adoption cycle is never re-run and a holdout-use record is never re-associated with another selection; the holdout
phase recomputes the frozen selection digest before any holdout access (a mismatch halts).
The supervisor contract (outcomes, exit codes, summary) is in the README.

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
  version, **deployment stays BLOCKED**. The supply below provides such holdouts from public sources.

### Holdout supply from public sources (`eval-loop-supply`, `src/supply.mjs`)

Independent holdouts are supplied without anyone authoring tasks: real upstream changes of public projects, adapted mechanically
and sealed in a pool OUTSIDE this package (the package exports `datasets/`; `poolPath` refuses pools inside it). The aw wrapper
uses `agent_workflow/runs/eval-loop-supply` (git-ignored, mode 0700).

- **Sources** (criteria fixed in `DEFAULT_SUPPLY` and recorded with their digest in the pool registry before collection): npm
  packages found by fixed keyword searches whose latest version's test script runs `node --test`, with no runtime dependencies,
  an accepted SPDX license and a GitHub repository. Upstream history: default branch, first parent, no merges, committed on/after
  `since`, not by a bot, a descriptive subject, added/modified files only (deletions/renames cannot be overlaid), no manifest or
  lockfile change, text only, >= 1 runnable test file and >= 1 non-test code file changed, size bounds. Diversity (2026-11-06): at
  most `discovery.maxReposPerOwner` (3) repositories per GitHub account per collection, and never-scanned repositories first, then
  the least recently scanned (registry `scan` records; failed clones/scans included; older pools: commit-case decision times), so
  repeated collections move through new projects instead of re-reading the same capped set.
- **Offline precheck** (before validation and its per-repository budget): a test file that `node --test` starts by default, or a
  hidden test, that imports a package at statement level which is neither a Node builtin nor the package itself is rejected
  (`test-imports-unavailable-package`, package names recorded). Dynamic/optional imports, `import type`, comments and `#imports`
  are not counted (static reading never claims more than it can see); the sandbox validation stays authoritative for the rest.
  On 2026-11-05, 56 of 130 decisions failed `original-visible-suite-not-passing-offline`, most of them on such imports (ava, tape,
  delay, sinon, expect, ...).
- **Adaptation without invention**: `repo/` = the upstream tree at the parent commit (with its license file); `hidden/` = the
  commit's own post-change test files (renamed to `*.holdout.test.*` only when the runner would not pick them up; the mapping is
  recorded); `reference/` = the commit's own post-change non-test files; instruction = a fixed preamble + the upstream commit message
  (trailer lines removed). Provenance: repository URL, immutable parent/fix SHAs, dates, author name, branch head at collection,
  license SPDX + license file hash + copyright line. Only tasks built this way are labelled `external`.
- **License**: package.json SPDX in the allow list AND a root license file whose text matches it; otherwise rejected.
- **Overlap** (reason codes; finding none is not proof of absence): exact commit and `git patch-id --stable` against every
  earlier supply decision; file content hashes of hidden/reference against every earlier task (orche suite, bundled holdouts);
  repository family and npm package name against earlier datasets; repository slug, SHA and task id against the texts of orche
  experiments/docs/results and this package's records/docs. Not detected: semantic near-duplicates in unrelated repositories.
- **Mechanical validation** in the grading sandbox (no network), repeated (2x): the original's visible suite passes offline; the
  original FAILS the hidden tests with failing tests reported (timeouts rejected); the reference passes the hidden tests AND the
  visible suite (a task whose fix breaks old assertions is unsolvable without editing tests, which integrity forbids); identical
  counts on every repeat. The engine validates every holdout task again at prepare. A grader error or timeout decides a case at
  its first run (the remaining runs are skipped), and a repository with `commits.maxTimeoutsPerRepo` (2) timeouts in one
  collection leaves its remaining commits undecided for a later one (budget only: acceptance still needs every run).
- **Batch** (candidate-blind): eligible cases ordered by `sha256(seed:id)` (with `preferFreshFamilies`: families that were in no
  earlier batch of the pool first, a preference that never relaxes a rule), the first accepted hard case first, at most
  `maxPerFamily` per repository and `maxPerOwner` per GitHub account, up to `maxTasks`, and since 2026-11-06 no account above
  `maxOwnerShare` (0.5) of the tasks actually sealed (the largest size T whose fill reaches T tasks with every account at most
  floor(0.5 T)); sealed only when the protocol minima hold (6 tasks, 4 families, a hard task with an accepted basis).
  `PROVENANCE.json` (rule, caps, coverage incl. `maxOwnerShare`, `familiesInEarlierBatches`) and `SEAL.json` are inside the
  sealed directory. Existing batches are never re-selected or rewritten; the first eligible batch (4/6 one account) would not
  seal under this rule today. `status` reports each batch's account shares and a read-only outlook of the next selection.
- **Difficulty**: the commit source's tier is a size proxy of the upstream fix (`difficultyBasis: "size-proxy"`; a commit-built
  task.json cannot claim another basis except "source" with the annotation recorded). Patch size does not establish difficulty,
  so `holdout.hardBasis` (default declared/curator/source) never accepts it: such tasks are not hard for the holdout stratum,
  coverage, gate or preflight. A "source" basis counts only with a substantive `difficultySource` (dataset, label or value, URL
  or revision, and a matching tier; `datasets.mjs` sourceAnnotated), otherwise it is "source-unannotated". Difficulty is never
  calibrated by running a model on holdout tasks. The first real batch (2026-11-05) is structurally valid but blocked for this
  reason; the hard stratum comes from the annotated source below.
- **Annotated source: Exercism JavaScript and TypeScript tracks** (`eval-loop-supply collect-exercism [--track]`, `src/supply-exercism.mjs`). Each practice
  exercise carries a maintainer-assigned `difficulty` (1-10) in the track's config.json, and Exercism's documentation
  (exercism/docs `building/tracks/config-json.md`) fixes the reading 1-3 easy, 4-7 medium, 8-10 hard; the rubric text is verified
  at a pinned docs revision before any tier is assigned, and both revisions are recorded in `difficultySource`. Only the tiers in
  `DEFAULT_SUPPLY.exercism.tiers` (hard) are collected. Adaptation: `repo/` = the exercise directory as a student receives it
  (without `.meta/`); `hidden/` = the upstream spec byte-identical under a non-runner name, a fixed node:test bridge (resolution
  hook: `@jest/globals` -> a fixed shim, jest's extension fallback for relative imports) and the real `expect` package at the
  version of the track's lockfile, vendored offline with versions, integrity and licenses (`VENDOR.json`); xtest/xit/xdescribe are
  enabled as Exercism's CI does, `test.skip` stays skipped; `reference/` = the maintainers' example solution with Exercism CI's
  only rewrite (`from '../` -> `from './`); instruction = fixed preamble + the exercise's .docs verbatim. Specs using jest features
  the bridge does not carry are rejected. Validation runs with `visibleSuite: "none"`: the visible run must pass and find no
  tests, and the original must execute as many hidden tests as the reference (failures on tests, not on loading); all other
  checks unchanged; the commit source keeps the default. Exposure: exercises listed in public benchmark sets (default: Aider's
  polyglot benchmark, whose set was picked from model results) for the track's benchmark language (JavaScript; TypeScript ports
  are judged by the JavaScript list) are always excluded; listings in the benchmark's other languages (cpp, go, java, python,
  rust) are recorded per task (`upstream.benchmarkListings`, registry `listedLanguages`, an extra limitation) and exclude the task
  only with `exercism.excludeScope: "any-language"`. An exercise is taken once per pool across revisions (`sourceKey`), and an
  Exercism *problem* once per pool across tracks: a case whose problem was already accepted from another track (eligible,
  sealed, reserved or used; older registry records are read through their `sourceKey`) is rejected `problem-taken-in-supply`;
  a rejected attempt does not take the problem. The usual family/name/content checks apply, and each track is one family
  (`gh:exercism/javascript`, `gh:exercism/typescript`, both of the `exercism` account, so the account caps bind them together).
  TypeScript (2026-11-06): Node >= 23 starts `*.test.ts` and `test-*.mjs` by default, so the student's copy of the spec is renamed
  to the hidden copy's non-runner name (byte-identical, noted in the instruction) and Exercism's CLI runner `test-runner.mjs`
  (corepack/yarn) is left out; exercises carry no LICENSE, so the verified track LICENSE is copied in; `expect` is vendored at
  the TypeScript lockfile's version (29.7.0); spec and proof run unchanged under Node's built-in type stripping (no compiler, no
  type check) and a proof that needs more (enums, parameter properties) fails validation. Limitation: these exercises and many
  solutions have been public for years, so pretraining exposure is likely; the hard tier is a curator annotation, not a measured
  difficulty; hard exercises are few (JavaScript 9, TypeScript 8, mostly the same problems, most of them benchmark-listed), so
  this source supplies only a handful of hard tasks in total.
- **Refresh** (`eval-loop-supply refresh`, model-free, for schedulers): commit source, every Exercism track, then seal batches
  until the next would miss a minimum; a failing source is recorded and the others run; a pool `.refresh.lock` serializes runs
  (exit 3 when busy). Exit 0 = an eligible, unreserved, unused batch is available afterwards (the engine's own
  `firstEligibleBatch`), 2 = none. It never reserves (that stays `eval-loop --init`) and never touches sealed batches. With only
  `--protocol` (no `--pool`), `refresh` and `status` use that protocol's `datasets.holdoutPool`, resolved like the engine does, so
  an unattended caller cannot refresh a different pool than the one experiments reserve from. agent_workflow calls it this way
  from its supply wait (`refreshEvalLoopSupply`, off unless its config `supplyRefresh.enabled`).
- **Reservation and use**: a protocol with `datasets.holdoutPool` (and `holdout: null`) reserves, under the pool lock, the first
  unreserved, seal-intact, eligible batch for its state directory at the fresh initialization (a retry of the same experiment
  gets the same batch; another experiment never gets it). The resolved batch path is locked with the protocol: one batch per
  experiment; a later cycle of the same experiment is BLOCKED by the preflight once the batch is used, so a new batch means a new
  experiment (new state directory, explicit init). No batch: BLOCKED (retryable) before the lock and before any run.
- **Preflight** (`Loop.holdoutPreflight`, model-free, at every prepare before the selection is frozen): the holdout must be sealed,
  of accepted provenance, unexposed, with an intact ledger and no use, and cover the minima after grader validation. Failing it
  blocks permanently before baselines, proposals or candidate runs. At the holdout phase the status is checked again: a holdout
  that is no longer independent is neither consumed nor run (final verdict BLOCKED); a use appended just before a crash is
  recovered for its own frozen selection instead of being appended twice. `eval-loop --preflight` prints the same check read-only.
- **Secrecy and its limits**: hidden tests and reference solutions stay in the pool (cases, batches); reports and the registry
  carry ids, URLs, counts and reason codes only (per-case validation detail is in `validation.private.json` next to the case).
  Model-facing sandboxes hide `/home`, so task agents and the proposer cannot read the pool; any unsandboxed process of the same
  user can. Public code may have been in a model's pretraining data; recency and the overlap checks reduce, not exclude, that.

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

## Protocol-4: prospective analysis plan, interleaved holdout, low-exposure tier, confirmation (2026-11-06)

Every protocol-3 gate, threshold and decision rule is kept and remains a NECESSARY condition; protocol-4 only adds checks.
Code: `src/design.mjs`, `src/loop.mjs` (holdout, confirmAdoption), `src/gate.mjs` (adoptionDecision), `src/datasets.mjs`
(holdoutStatus), `src/supply.mjs`, `src/calibration.mjs`. Tests: `test/design.test.mjs`, `test/protocol4.test.mjs`,
`test/supply-safeguards.test.mjs`.

- **Interleaved execution** (`holdout.execution: "interleaved"`, default): blocks (task, repeat) with one unit per arm; block
  order and arm order inside a block drawn from the seed and the frozen selection; one shared queue; schedule frozen
  (`holdout-schedule.json`, `state.holdoutSchedule.digest`) before the first dispatch and bound to selection, protocol,
  environment, holdout seal and arm commits. A resumed pass re-derives it (a different one halts), reuses recorded units and
  reconciles dispatched-but-unrecorded ones; dispatch records carry the planned index; `final.execution` reports whether first
  dispatches followed the plan. `"sequential"` keeps the protocol-3 order and is labelled as time-confounded.
- **Family dependence** (`adoption.requireFamilyLevel: true`): the adoption event must also reach `adoption.support` under the
  family-clustered Bayesian bootstrap. Model-based and approximate with few families; never an error rate.
- **Analysis plan** (`analysisPlan`). `exploratory` (default): NEVER a production adoption. Every protocol-3 rule and the
  family-level check still apply; a candidate that passes them all gets verdict `EXPLORATORY_SUPPORTED` (`final.adopt` false,
  `final.candidateAccepted` true, archive status `holdout_exploratory_supported`): a labelled measurement, nothing deployed, no
  confirmatory or generalized claim. `confirmatory` (the only way to ADOPT): every value is operator-supplied with a
  written rationale document whose sha256 is registered (no sample size, effect size or alpha is defaulted); missing items,
  coverage below the plan, or an exhausted series budget BLOCK before the search; at use the alpha is spent first. Checks ANDed
  onto the gate: a one-sided randomization (within-block sign-flip) test of the SHARP null "arm labels exchangeable within each
  (task, repeat) block" (repeats averaged within task, tasks weighted equally; exact up to 2^16 patterns, Monte Carlo
  (1+hits)/(1+draws) beyond; smallest attainable p = 2^-discordant blocks; valid for THESE tasks only, not a minimum-effect or
  population claim), family-clustered P(delta>0) >= 1-alpha, plug-in delta >= minEffect (descriptive), leave-one-family-out
  (sensitivity only), optional low-exposure stratum agreement. Unanswerable -> INCONCLUSIVE, unsupported -> KEEP_STABLE.
- **Series error budget** (`analysisPlan.series`): a shared hash-chained ledger outside any state directory; each confirmatory
  test spends its alpha before outcomes exist (union bound over the series, valid under dependence), locked across processes,
  idempotent per frozen binding, never refunded; damaged ledgers refuse.
- **Eligibility boundary**: `holdoutStatus` (preflight, pool eligibility, moment of use) re-checks account concentration
  (`holdout.maxOwnerShare`, 0.5), prior-family reuse when `holdout.priorFamilyReuse: "forbid"` (families of used/reserved/
  calibration batches and used package datasets; a batch is never its own prior; unknown -> fail closed), dataset purpose,
  review records of `private-reviewed` tasks and calibrated difficulty references. "Unexposed" = not named in earlier
  experiments; public provenance never establishes training non-exposure.
- **Supply overlap**: repository root commits (forks/mirrors; only with complete history, shallow = unknown) and lexical
  near-duplicates of reference code in OTHER families (identifier-abstracted 6-token shingles, Jaccard >= 0.7) are rejected.
  Lexical only: semantic independence is not established.
- **Low-exposure tier**: `eval-loop-supply intake-private --src DIR [--overlap-pool DIR ...]` takes newly authored tasks with
  provenance `private-reviewed`, a complete review record and the usual mechanical validation; tasks with an upstream origin
  are refused. Record (2026-11-06, `datasets.mjs reviewProblems`): named problem/test/reference authors with their kind
  (`human` | `ai-agent`), tests not by the reference author, family `private:<accountable author>/<project>` (all tasks of one
  author or one model/provider are ONE account for the concentration cap), reviewers who authored nothing, each with kind,
  time, an `accept` verdict and the items THEY checked; every required item must be attributable to a reviewer's own check or
  to an attestation of a named non-author that states its method (e.g. the operator's publication check); the review document
  lives under the task's `review/` directory, travels into the pool and the sealed batch, and its sha256 is re-verified at
  intake and at every eligibility check. `holdout.privateReview: "human"` (default) makes a task without a human reviewer
  ineligible; `"ai-allowed"` is an explicit operator decision (visible in the lock). `--overlap-pool` adds other pools (for
  example the live supply pool) READ-ONLY to the id/content/near-duplicate checks. The record is still an attestation:
  separate AI sessions are not independent people, and nothing here proves absence from model training data.
- **Non-human review** (2026-11-07, operator decision "no human review"; `holdout.privateReview: "cross-provider"`,
  `datasets.mjs crossProviderProblems`, harness `studies/confirmatory-1/review.mjs`): instead of a human reviewer a private
  task needs verified cross-provider evidence, re-read from documents under its `review/` directory (sha256 in task.json):
  (1) BLIND tests written from instruction + starting repository only by an AI reviewer of a provider that is neither an
  author's nor the target model's, running as pure Pi in the evaluator's bubblewrap sandbox (filesystem-enforced: the mount set
  holds only the bundle; a denial probe with positive controls in the same mount set records every withheld path - task
  directory, hidden tests, reference, review notes, private storage, agent transcripts, credentials - as absent); the reference
  must pass them twice and the starting repository must fail them; (2) an ADVERSARIAL review by a third provider (full task)
  whose mutants (plausible wrong solutions) are run against the official hidden tests; (3) every mutant the official tests
  accept and every non-accept verdict resolved by an adjudication of a non-author provider. Each document names the reviewed
  task-content digest (instruction, repo, hidden, reference): any change of the task voids its reviews (a new version needs new
  reviews; relabelling is not evidence). Response models in the wire journal must belong to the claimed provider. What it
  does not establish: independence of the providers' training data, training non-exposure (every reviewer provider received the
  content), or independent AUTHORSHIP - review never changes the account of the author (one authoring source = one account).
- **Difficulty calibration**: `seal --purpose calibration` creates a set that is never eligible as a holdout;
  `buildCalibrationReport` turns measured baseline outcomes of that set into a rule (named feature, 0/1 outcomes only, every
  task measured); later tasks may use basis `calibrated` only with a verified report: sha256, calibration purpose, disjoint
  task ids and families, rule makes the level hard, AND (2026-11-06) `verifyCalibrationReport` re-derives it from the runner
  ledger it names (sha256, hash chain, no simulated record, recorded harness commit, no unresolved infrastructure failure, same
  outcomes digest, levels and hard levels recomputed from the pre-registered rule). Hand-supplied (`fixture`) reports are never
  accepted. `studies/confirmatory-1/calibrate.mjs` is the bounded runner. (2026-11-07) Unit classes are pre-registered
  (`calibration.mjs unitClass`): success / failure (completed, agent_error incl. request budget, timeout) / integrity (a valid
  failure, reported apart) / infrastructure (infra_error, model_unavailable, model_error, aborted, grader_error) / harness-fault
  (harness_crash, route_violation) / censored (never dispatched or unresolved). Under censoring `infra-excluded@1` infrastructure
  and harness-fault units carry no difficulty evidence (left out, never counted as 0); a task with no remaining outcome is
  unmeasured. Pre-registered exclusions (task, reason, evidence sha256) are part of the calibration plan digest, so they are fixed
  before the first dispatch; an excluded (grader-invalid) task is NOT dispatched, and the runner refuses to start while a task
  with a known grader defect in its cross-provider triage is not excluded (`calibrate.mjs knownDefectProblems`). A partial run writes
  `calibration-status.json` (unit classes, budget) and no report.
- **Request budget** (2026-11-07, `src/request-budget.mjs`): one durable, hash-chained, locked ledger shared by every
  calibration run, resume and rerun of a study (never per state directory); its ceiling is fixed by its first record. The
  accounting unit is a provider request ATTEMPT, gateway-internal retries and credential fallback included. `gatewayAttemptBound`
  derives K = (request-retry + 1) rounds x eligible credentials from the gateway's config and auth directory, following the
  retry contract of the verified build (CLIProxyAPI 8.0.57 c2f402b4, non-Home); anything that makes it unknowable refuses.
  The evaluator's admission hook reserves unit.maxRequests x K per ATTEMPT before its dispatch record and settles forwarded x K
  (internal retries are not observable, so every forwarded request is charged its worst case; a bound that changed during the
  attempt is charged at the larger K and halts). Unsettled reservations stay charged in full; a corrupt, edited or truncated
  ledger, a changed ceiling or unwritable storage refuse. K is invariant during an attempt only if nobody can change the
  gateway's config or credentials meanwhile: a real run therefore requires an ISOLATED gateway (the process serving the route
  runs the verified executable with a config inside the study's private storage); the shared live gateway is refused
  (`gatewayIsolationProblems`). Peer protection (429/503 failures halt) is not part of the accounting.
- **Readiness** (`eval-loop-supply readiness --protocol FILE --study FILE [--overlap-pool DIR ...]`, `src/readiness.mjs`):
  read-only, model-free report of a confirmatory study's prerequisites (analysis plan incl. its simulated power at the target
  effect, series budget, private review, calibration, main and confirmation holdouts, cross-pool overlap), each
  fulfilled / provisional / blocked with reasons and evidence; exit 0 only when all are fulfilled. It never reserves, seals,
  consumes, runs or writes.
- **Independent confirmation** (`eval-loop --confirm-adoption`): re-measures previous vs adopted commits on a separate,
  unused, eligible batch reserved under `<state>#confirmation` (own seal excluded), spends `confirmation.alpha`, runs
  interleaved, applies the confirmatory checks; CONFIRMED / NOT_CONFIRMED / INCONCLUSIVE / BLOCKED (dormant without a
  confirmatory plan or batch: nothing consumed). `--verify-stable` is refused under a confirmatory plan; its absence of a
  supported regression is never a confirmation.
- **Older experiments**: a state locked under another protocol version is refused read-only (nothing saved, bound, reserved
  or reported); its recorded files stay byte-identical (`test/protocol4.test.mjs`). Start new experiments in new state
  directories.
- **Deployer guard**: `Loop.adopt()` (also on resume) halts unless the decision is ADOPT under a confirmatory plan with a
  confirmatory evidence label and passing confirmatory checks.
- **Machine-consumed stages** (`status@1` `acceptance`, `src/contract.mjs` acceptanceOf): `candidate-accepted-exploratory`,
  `adoption-decided-not-applied`, `adopted-unconfirmed`, `adopted-confirmed`, `adopted-not-confirmed`, `rolled-back`,
  `not-accepted`; `confirmed` is true only after `--confirm-adoption` returned CONFIRMED (absence is never success);
  `legacy` = recorded without a protocol-4 evidence label. agent_workflow treats EXPLORATORY_SUPPORTED, ADOPT without the
  confirmatory label, and an adoption whose planned confirmation is not CONFIRMED as not-normal (no schedule enabling, no
  rotation, no automatic repair); an incomplete plan or exhausted budget is "external input required", not a supply shortage.

### Rollout (not done; needs a separate human decision)
1. Until a confirmatory plan is registered, protocol-4 produces exploratory measurements only; no adoption happens.
2. Experiments recorded under protocol-3 (for example `state/aw-scheduled`) are refused read-only by the protocol-4 CLI;
   the scheduled series then stops for a human decision (new experiment directory) instead of resuming them.
3. Confirmation stays dormant (`BLOCKED`, nothing consumed) until a plan with `confirmation.required` and a pool holding a
   separate sealed unused batch exist; it is run by hand (`eval-loop --confirm-adoption`), never by a schedule.

### Required external inputs and their state (2026-11-06, study `studies/confirmatory-1/`)
1. Rationale: registered (`RATIONALE.md`, simulation `power.mjs` on real ctrl-ablation-1 records) but PROVISIONAL: adequate
   power only for effects >= 0.15 under the homogeneous model; <= 0.34 adopt-and-confirm at the typical effect 0.10.
2. Series ledger and total alpha: chosen in the plan (0.05, two experiments); an operator may replace them by a new version.
3. Private tasks: 18 authored, 17 accepted and taken in (10 calibration, 7 holdout candidates) by AI-agent sessions of one
   model with separated roles; no human reviewer, one account -> not eligible under `privateReview: "human"` and the 0.5 cap.
4. Calibration: batch sealed (calibration purpose); not measured: needs an operator-approved request ceiling for ~30 units.
5. Main and confirmation batches: not sealed (288 tasks needed, 7 eligible candidates, one account).
6. Deployment of this code to the live checkout and any schedule change: separate human approval.
