# ctrl-confirm-2 — preregistration

Registered 2026-11-06, before any outcome of this experiment on its holdout existed. Machine-readable twin: `prereg.json` (its
digest is locked with every run as `preregDigest`). Amendments are appended at the end with a timestamp and a reason; earlier text
is never edited.

## 0. Status and relation to ctrl-ablation-1

- ctrl-ablation-1 (810 units, 27 exposed suite tasks) selected **no viable candidate** under its preregistered rule; that rule
  contained a flawed consistency gate (dI <= 0 treats "always fails" like "always succeeds"). Its verdict stays KEEP_STABLE and is
  not re-decided here.
- This is a NEW, prospectively registered experiment with a corrected endpoint, a new task population and a redesigned contrast.
  It is not a retroactive rescue of ctrl-ablation-1, and no number of ctrl-ablation-1 is claimed as a confirmed success.
- The 810 earlier outcomes informed only the prospective choice of the intervention and the sample-size planning (§8); they are not
  pooled with, refitted to, or compared as one condition with the outcomes of this experiment.

## 1. Question

Primary: under an evaluation integrity contract that is disclosed identically to every arm, does adding the test-preservation rule
to every orche-created session (OCR) raise (E1) the valid-success rate and (E2) the share of tasks that are reliably successful
(all 3 repeats valid) relative to stable orche (OC), on independent external tasks?

Secondary (mechanism, never adopting): OCR vs pure Pi with the same rule (PCR: harness difference under matched instructions),
PCR vs PC (the same rule in pure Pi), OC vs PC (harness difference without the rule), and the interaction.

Hypotheses are two-sided in reporting: harm is reported as such.

## 2. Why the contrast was redesigned (instruction vs capability)

In ctrl-ablation-1 the strict byte-identity criterion was enforced by the evaluator but told only to P1/P3; most of P1's gain over S
was compliance with an evaluator criterion once stated. To avoid claiming an instruction effect as a harness capability:

- Every arm now receives the same **baseline integrity contract** (`prereg.json` `integrityContract`) appended to the task
  instruction (identical bytes, recorded per task as `instructions` digests in the lock). It states exactly the rules of the PRIMARY
  (legacy line-based) detector: no deletion/removed or changed lines of existing tests, no skip/only markers, no runner-config or
  package.json resolution changes, no test-environment detection or grading references, no symlinks. Appending tests is allowed.
- The candidate's extra is only the `testIntegrityRule` (stricter: existing tests byte-identical, new tests in new files) in the
  system prompt of every orche-created session. The rule text and the patch bytes are identical to ctrl-ablation-1 P1 (test asserts
  it); the arm is renamed OCR because the condition differs (disclosed contract), so it does not "replicate P1".
- PCR (pure Pi + the same rule, Pi's `--append-system-prompt`) gives the matched-instruction comparison: OCR - PCR is the only
  contrast that compares harnesses under identical instructions; OCR - OC estimates the effect of the rule inside orche, i.e. an
  instruction effect of a deployable prompt change, not a capability of the harness.
- In orche arms the contract reaches the editing worker only through the main session's hand-off (orche requires the original
  request verbatim); whether it arrived is reported per unit by `fidelity.mjs` (`contractReachedWorker`), it is a harness behaviour
  shared by OC and OCR.

## 3. Arms (2 x 2: harness x rule; exact bytes locked by digest)

| arm | harness | rule | lineage |
|---|---|---|---|
| OC | orche e831a6b, single mode, historical evaluator config | none | ctrl-ablation-1 S + contract |
| OCR | OC + `variants/OCR.diff` (rule appended to every orche-created session) | testIntegrityRule | ctrl-ablation-1 P1 bytes + contract |
| PC | pure Pi, built-in read/bash/edit/write, historical flags | none | ctrl-ablation-1 B0 + contract |
| PCR | PC + `--append-system-prompt testIntegrityRule` | testIntegrityRule | ctrl-ablation-1 P3 + contract |

Variants are built in the state directory from `git archive e831a6b` plus the patch (reverse-check of every hunk); the orche checkout,
its defaults and production configuration are not touched.

## 4. Fixed conditions

- Route `cliproxyapi/gpt-6-luna`, effort medium, for every session of every arm (proxy-enforced; off-route = route_violation).
- Per-unit ceilings identical for all arms: 20 min wall, 150 model requests (all sessions of the unit), grader 120 s.
- Environment digest recorded and checked; same bubblewrap sandbox, offline, hidden tests never mounted for agents; the visible tree
  is the upstream tree at the parent commit (no history, no reference); all transcripts captured and leak-scanned.
- No sampling seed exists on the provider: repeats are independent draws.
- Concurrency 8 units; one randomized queue for all arms (the smoke ran at 6; concurrency changes no unit's conditions).

## 5. Tasks (holdout) — see §11 for the sealed batch

- Source: real upstream commits of public npm packages (license-checked, provenance recorded), collected model-free into the
  workspace-local supply `results/ctrl-confirm-2-supply/` by `supply.mjs` (the loop's own `src/supply.mjs` collector, unchanged),
  in repositories that are not in the pre-existing external pool (read-only check of its registry and reports), the orche suite,
  `datasets/holdout-v1` or any earlier record. Instruction = fixed preamble + the upstream commit message; hidden tests = the
  upstream test files of the commit; reference = the upstream code change (validation only).
- Eligibility (all before any agent run): supply validation in the grading sandbox (original passes visible suite offline, fails
  hidden tests by failing assertions; reference passes hidden and visible; deterministic over 2 repeats); exposure audit
  (`assemble.mjs`: commits/patch ids/repositories of the external pool, families/content of earlier datasets, names in earlier
  experiments and records); instruction/contract conflict screen (regex flag + recorded human review: a task whose instruction
  requires changing existing tests is excluded); engine grader validation (`validateGrader`); candidate-blind seeded selection
  (sha256(seed:id) order, at most 3 tasks per repository = family and 6 per account, at most 120).
- The batch is sealed (`SEAL.json`); its single use is recorded in its `USES.jsonl` before the first unit; it can never back a
  second experiment.

## 6. Outcomes

- Unit outcome (PRIMARY): legacy-valid = completed AND hidden tests pass (expected count) AND visible suite not failed AND no legacy
  line-based integrity violation (the existing detector incl. the 161605a Node-runner-name false-positive fix, identical for all
  arms) AND no leak hit in any captured transcript AND no harness crash / route violation.
- Co-primary endpoints per arm: **E1** valid-success rate = mean over tasks of k/3; **E2** reliable success = share of tasks with all
  3 scheduled repeats legacy-valid (a missing repeat is a failure; never imputed as success).
- Secondary: strict-valid (E1/E2 with every original test file byte-identical; sensitivity only, and its arm contrasts confound
  disclosure of the stricter rule), functional success, legacy/strict/leak failure counts, 0/3 and mixed counts, inconsistency I
  (descriptive only, never a gate), families, terminal statuses, requests/tokens/wall.

## 7. Analysis

- Pairing unit: task (repeats nested); clustering unit: family (= upstream repository; tasks nested). Repeats are never counted as
  independent samples.
- Every contrast: per-task differences of E1 (k/3) and E2 (all-3 indicator); estimate = mean over tasks; 95% interval =
  family-cluster bootstrap (10 000 draws, seeded, percentile); p = family-level sign-flip randomization (20 000, seeded), one- and
  two-sided.
- PRIMARY OCR - OC: CONFIRMED iff for BOTH E1 and E2 the lower 95% bound > 0 AND the one-sided p < 0.025 (intersection-union; no
  further adjustment for this single primary contrast). NOT_CONFIRMED_HARM_INDICATED if an upper bound < 0. Otherwise
  INCONCLUSIVE (absence of evidence; not evidence of no effect).
- Secondary: OCR - PCR, PCR - PC, OC - PC on E1 and E2 (Holm over these 6 two-sided p values), interaction on E1 descriptive.
- Intent-to-evaluate: every scheduled unit counts; agent errors, timeouts and infrastructure failures after the single infra-only
  retry (zero completed model calls) are failures. Sensitivity: infrastructure-only units excluded.
- Code: `analyze.mjs` (+ `lib.mjs`), frozen in the lock.

## 8. Sample size and its planning

- Fixed sample: all selected tasks x 4 arms x 3 repeats; no interim efficacy or futility look; outcomes are not inspected during the
  run (operator log shows terminal statuses only).
- Planning (`power.mjs`, model-free, exposed discovery data only): task pairs of ctrl-ablation-1 S and P1 under the LEGACY scoring,
  Beta-shrunk (method of moments), families of 2 tasks sharing one pair (conservative clustering), effect scaled by 1 / 0.5 / 0.25 / 0
  (winner's curse; the disclosed contract can absorb part of the effect), family-level t intervals for both endpoints. See §11 for
  the power at the realized N. Because the supply, not the budget, limits N, the run is launched at the full eligible N even if the
  planned power is below 0.8; an INCONCLUSIVE result is then the expected outcome under small effects and is reported as such.

## 9. Stopping, invalidation and resources

- Dispatch pauses (never decides) on: 5 consecutive infrastructure failures; aggregate requests + 150 per in-flight unit > 40 000;
  campaign wall > 14 h; a route violation or evaluator defect. A paused campaign resumes in the same frozen order with the same
  command (`campaign.json` `resume`); units are never re-run except the evaluator's infra-only retry.
- If the infrastructure rate exceeds 10% the run is reported as infrastructure-compromised and cannot confirm. If a ceiling ends it
  early, missing units count as failures and the primary decision is INCONCLUSIVE (incomplete design).
- Expected resources (from ctrl-ablation-1 rates: S 24, P1 23, B0 9, P3 9 requests per unit): 1 116 units, about 18 000 model
  requests (ceiling 40 000) and about 4.5-6 h at concurrency 8 if the holdout behaves like the suite (hard ceiling 14 h); realized
  requests, tokens and wall time are reported per arm. No paid provisioning, no provider substitution: the configured route only.

## 10. Adoption (recommendation only; no deployment, no default change, no lock change)

- ADOPTION_CANDIDATE only if: primary CONFIRMED; zero leak / harness crash / route violation in OCR; OCR legacy failures <= OC and
  strict failures <= OC; no family where OCR's valid-success point estimate is below OC's; OCR functional point estimate not below
  OC's. A family regression or a functional point loss sends the result to USER_REVIEW (no tolerance margin is defined, none is
  invented). Anything else: KEEP_STABLE. Even ADOPTION_CANDIDATE never deploys automatically: the user decides.

## 11. Realized holdout, N and planning (filled at sealing, before any unit)

- Sealed batch `ctrl-confirm-2-holdout-3e83b1b2af67` in `results/ctrl-confirm-2-holdout/` (umbrella, git-ignored, outside the
  package and every agent sandbox), seal sha256 `1dbe71800c0fa04b5648aca1a47bdf9013f95a7fd399176f6e3bf2c72aa2b7ca`; uses 0 at
  registration. Non-secret copies: `records/ctrl-confirm-2/holdout/` (ELIGIBILITY, PROVENANCE, conflict review, supply summary).
- Supply: wave 1 = the loop's default npm discovery (128 qualifying repositories, 58 already named by the external pool -> 70
  collected); wave 2 = broader keywords (1 835 qualifying repositories, 82 excluded as external or wave 1), of which the first 600 in
  a seeded order (sha256 of slug) were assigned to 10 slices; 3 slices were stopped by the operator at 13:45Z for time
  (outcome-blind: no agent had run on any case), so 493 of the 600 were processed. 93 eligible cases.
- Eligibility: 93/93 audit-clean (no commit, patch, repository, content or name overlap with the external pool, the suite, bundled
  datasets or earlier records); 0 regex conflict flags; 19 instructions mentioning tests read in full, 0 conflicts (all describe
  added tests; `conflict-review.json`); 93/93 pass the engine grader validation (original fails hidden, reference passes hidden and
  the original visible suite). Selection caps were not binding: **N = 93 tasks, 54 families (repositories), 51 accounts**; family
  sizes 31 x 1, 7 x 2, 16 x 3. Licenses MIT 85, BSD-3-Clause 5, Apache-2.0 3; upstream commits 2026-04-27 .. 2026-11-05; size-proxy
  tiers easy 12 / medium 43 / hard 38 (not a difficulty claim).
- Design: 93 x 4 arms x 3 repeats = **1 116 units**.
- Planned power at the realized family structure (`records/ctrl-confirm-2/plan/power.json`, 4 000 simulations): co-primary
  0.79 (E1 0.89, E2 0.82) if the full discovery legacy effect of P1 over S held; 0.18 at half of it; 0.05 at a quarter; 0.009 with no
  effect (type-I check). The discovery effect was measured without the disclosed contract, which may absorb much of it, so an
  INCONCLUSIVE result is a likely and legitimate outcome.

## 12. Smoke (excluded from analysis)

- 1 unit per arm on 2 already exposed suite tasks (`a6-typo-message`, `c4-malformed-lines`) in `state/ctrl-confirm-2-smoke`, to
  check variant fidelity, contract delivery, transcript capture, original-test hashes, legacy/strict separation, ledger resume and
  leak scanning. Smoke outcomes are never analysed with the holdout.
- Result (12:01Z): 8/8 units completed (79 requests); fidelity 8/8 (contract in every task message, rule only in OCR/PCR, contract
  reached the orche worker in all 4 orche units); every unit has its transcripts, `tests.json` hashes and separate legacy / strict /
  leak decisions (one OC unit had a strict-only violation and stayed legacy-valid: the two scorings are separated); a second
  invocation dispatched 0 units (resume). Records: `records/ctrl-confirm-2/smoke/`.
- The smoke ran with this experiment's run-time code; between the smoke and the confirmation lock only non-run-time files changed
  (`analyze.mjs`: smoke repeat count; `power.mjs`: realized family sizes; `supply.mjs`: seeded `--limit`; `assemble.mjs`: parallel
  validation; `prereg.json`: holdout fields, parallelism 8, planned units; this file). `run.mjs`, `lib.mjs`, `fidelity.mjs`, the
  reused ctrl-ablation files and every `src/` evaluator file are byte-identical to the smoke lock (39 files compared).

## Amendments
