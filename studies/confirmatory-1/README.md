# confirmatory-1: prerequisites of a confirmatory adoption claim (prepared 2026-11-06; nothing deployed or run)

| file | what |
|---|---|
| `RATIONALE.md` | registered analysis plan and its derivation (PROVISIONAL) |
| `protocol.json` | protocol-4 confirmatory protocol for the isolated pool (rationale sha256 registered) |
| `study.json` | readiness inputs (target effect, required power, power files, calibration report/approval slots) |
| `pilot.mjs` -> `pilot.json` | real ctrl-ablation-1 outcomes (legacy-valid estimand) used to parameterize the simulation |
| `power.mjs` -> `power.json`, `power-focus.json` | operating characteristics of the coded decision (holdout + confirmation) |
| `assemble.mjs` | builds intake-ready private tasks from role-separated material (copies identities/verdicts, invents nothing) |
| `calibrate.mjs` | bounded, approval-gated calibration runner (stable harness on the calibration batch) |
| `supply-calibration.json` | sealing config of the calibration batch only (one account allowed: a calibration set is never a holdout) |
| `approval.template.json` | the operator input a calibration run needs |
| `readiness.json` | last readiness report (non-secret) |

Private material (instructions, code, hidden tests, references, reviews, role identities, logs) lives ONLY in
`/home/arthur/Code/agent_workflow/runs/eval-loop-confirmatory-1/` (git-ignored, mode 0700; pool in `pool/`). That pool is
referenced by no live or scheduled protocol, so nothing there can start an experiment.

## Commands executed in this preparation (all model-free)

```bash
node studies/confirmatory-1/pilot.mjs --runs <live>/pi-eval-loop/records/ctrl-ablation-1/discovery/runs.jsonl --out studies/confirmatory-1/pilot.json
node studies/confirmatory-1/power.mjs --reps 200 --out studies/confirmatory-1/power.json
node studies/confirmatory-1/power.mjs --reps 200 --grid focus --out studies/confirmatory-1/power-focus.json
node studies/confirmatory-1/assemble.mjs --root $PRIV --roles $PRIV/roles.json --publication-check $PRIV/publication-check.json
EVAL_LOOP_UMBRELLA=<umbrella> node bin/eval-loop-supply.mjs intake-private --pool $PRIV/pool --src $PRIV/intake/calibration --overlap-pool <aw>/runs/eval-loop-supply
EVAL_LOOP_UMBRELLA=<umbrella> node bin/eval-loop-supply.mjs seal --purpose calibration --pool $PRIV/pool --config studies/confirmatory-1/supply-calibration.json
EVAL_LOOP_UMBRELLA=<umbrella> node bin/eval-loop-supply.mjs intake-private --pool $PRIV/pool --src $PRIV/intake/holdout-candidates --overlap-pool <aw>/runs/eval-loop-supply
node studies/confirmatory-1/calibrate.mjs --batch $PRIV/pool/batches/b20261106T131706Z-47fd006e --harness-commit <sha> --max-requests 1500 --dry-run
EVAL_LOOP_UMBRELLA=<umbrella> node bin/eval-loop.mjs --preflight --protocol studies/confirmatory-1/protocol.json --state <new dir>
EVAL_LOOP_UMBRELLA=<umbrella> node bin/eval-loop-supply.mjs readiness --protocol studies/confirmatory-1/protocol.json --study studies/confirmatory-1/study.json --overlap-pool <aw>/runs/eval-loop-supply
```

## Inputs still needed (in this order; each is a separate human decision)

1. Calibration spending approval: copy `approval.template.json` to the private storage, fill `approvedBy`/`approvedAt`, keep
   or lower `maxRequests` (4500 = 30 units x the 150-request unit ceiling, never exceeded; expected ~724 requests and ~6.9 M
   input tokens from the pilot stable arm; list-price estimate from the cliproxyapi catalog for gpt-6-luna, $0.10/M input:
   roughly $1 expected, below $10 worst case - an estimate, not a billing figure). Then export the stable orche commit
   (`e831a6b2bc19f0c707b55505db33a11b2c9d4d4a`, the stable of aw-scheduled and ctrl-ablation-1) WITHOUT touching the live repo:
   `mkdir H && git -C <umbrella>/orche archive e831a6b2bc19f0c707b55505db33a11b2c9d4d4a | tar -x -C H`, and run
   `node studies/confirmatory-1/calibrate.mjs --batch <calibration batch> --state <new dir> --harness-dir H --harness-commit
   e831a6b2... --max-requests 4500 --approval <approval file>`; set `study.json` `calibration.report` to the written report.
2. Human review of the private tasks (or an explicit protocol decision `holdout.privateReview: "ai-allowed"` in a NEW protocol
   version) and tasks from more accountable sources: one AI account can never hold more than half of a holdout.
3. Enough supply for 2 x 144 tasks in 2 x 48 families with >= 48 calibrated-hard tasks per main batch, sealed in this pool
   (`seal`, default holdout config), then readiness must report main-holdout and confirmation-holdout fulfilled.
4. A decision on the PROVISIONAL plan (underpowered at effect 0.10): accept it as is, or register a new plan version.

## Eventual final evaluation (NOT executed; needs explicit approval, never scheduled)

`eval-loop --once --state <new dir> --protocol studies/confirmatory-1/protocol.json` (reserves the first eligible batch, runs
the search, spends alpha, holdout pass) and, only after an ADOPT, `eval-loop --confirm-adoption --state <same dir>`.

## Continuation 2026-11-07 (operator: "금액 무제한. 요청 4500 유지. 사람 검토 없음. 방법 찾기. 재검토 수행.")

- Approval recorded without a signature: `approval-2026-11-07.json` (relayed instruction, `humanSignatory: false`).
- **Target-model requests: limit 4500 / used 0 / remaining 4500.** The budget ledger
  `<private>/budget/target-model-requests.jsonl` does not exist (no reservation was ever made).
- Accounting = provider ATTEMPTS: K = 4 per forwarded request on the current gateway (request-retry 3 → 4 rounds x 1 eligible
  codex credential, verified against CLIProxyAPI 8.0.57 c2f402b4 source and the running process's executable). Reservation 600 per
  unit attempt; expected ≈ 1736 attempts for the 18 valid calibration units.
- **Calibration is blocked (fail closed)**: (1) the only gateway is the shared live instance, whose config/credentials can be
  hot-reloaded by others during an attempt, so K is not invariant (a private gateway would need its own credential: copying the
  live OAuth credential shares refresh-token rotation with the live gateway and could break it); (2) the peer experiment
  ctrl-confirm-2 still runs on the same single credential (shared quota/latency). `calibrate.mjs --dry-run` lists the blockers.
- Calibration validity: 4 sealed calibration tasks have adjudicated grader defects and are excluded before any dispatch
  (`<private>/calibration/exclusions-v1.json`; the runner refuses without it). All three hard tasks are among them, so batch
  b20261106T131706Z-47fd006e alone can no longer calibrate a hard level. Corrected versions (dependencies-v2, returns-v2,
  statement-v2, plan-proration-v3, added tests verified, re-reviewed) are staged in `<private>/pool/calibration-staged/`
  (registry status calibration-only) for a separately sealed calibration batch; the original seal is unchanged.
- Non-human review applied: 7 holdout candidates superseded by cross-provider-verified versions (`-v2`, pool/cases;
  predecessors under pool/superseded); quoted-values stays out (its original reviewer verdict "revise" is unresolved).
  `review-summary.json` lists every session (no content).
- Design v2: `DESIGN-v2.md`, `protocol-v2.json` (privateReview cross-provider), `study-v2.json`, `power2-main.json`,
  `readiness-v2.json`. v1 files are kept unchanged.

## Continuation 2026-11-07 (W5): isolated runtime, corrected batch, bounded calibration, supply increment

- **Isolated calibration runtime** (`isolated-runtime.mjs`, `src/isolated-runtime.mjs`, `src/outbound-gate.mjs`,
  `src/runtime-bridge.mjs`): private copy of the verified CLIProxyAPI 8.0.57 binary in its own network namespace (bwrap
  `--unshare-net`, empty /home), config pinned by hash (request-retry 0, one credential, no plugins/management), access-token-only
  snapshot of the operator's codex credential (no refresh/id token; refused within the 96 h refresh lead). Its only exit is the
  outbound gate: one durable `attempt` record per provider attempt in the SAME ledger, admitted only while attempts + 1 <= charged
  (reservations), so actual attempts <= charged <= 4500 at every moment; settlements are raised to the attempt floor; the ledger
  anchor refuses truncation/removal. Model-free selftest on the real binary with an h2 TLS stand-in: 14/14 checks (retries,
  redirects counted, 8 concurrent with room for 3 -> 3, restart continuity, 401, truncation fail-closed, no startup traffic).
- **Corrected calibration batch** `b20261107T041803Z-82b4cdf9` (seal 727d4f20…; 4 corrected versions; `seal-corrected.mjs`,
  `supply.mjs sealCalibrationBatch`), after `triage.mjs` re-ran the blind tests on each version and checked that every
  adjudicated violation of the earlier versions is now rejected. Plan frozen before any result: `<private>/calibration/plan-v2.json`,
  `exclusions-v2-corrected.json`. Original seal and exclusions-v1 unchanged (hash-verified).
- **Calibration executed** (stable e831a6b2, gpt-6-luna medium, 3 repeats, 30 units, 0 infrastructure failures): ledger
  charged 599 = actual attempts 599, 0 open, remaining 3901. Registered rule: corrected batch hard level mean 0.78 (not hard),
  medium 0.67; original batch easy 0.44 / medium 0.56 -> `hardLevels: ["easy"]`, an artefact of strict-integrity failures
  (6/18 units edit existing test files; easy hidden-test pass 1.0). Reports: `<private>/calibration/state-b{1,2}/calibration-report.json`.
  One fail-closed pause (peer-protection meter "database is locked") was resumed with the same state and ledger.
- **Supply increment** (two new project families, 3 tasks each, declared medium/hard/hard): `sx-recur` (A4/T4/R4) and
  `gx-buildplan` (A5/T5/R5), role-separated sessions of the same author account; reference passes hidden tests twice, start fails;
  R4/R5 accept; cross-provider adversarial (gemini-3-flash) done, blind tests (grok) in progress; NOT yet intaken
  (`<private>/intake/supply-3-prereview/`, `reviews-v3/`). quoted-values stays out (instruction defect -> withdraw per remedy policy).
- `evidence-v3.json` (pilot, ctrl-confirm-2 final, private calibration); `power3-main.json` (power2 with the private baseline) is
  generated by `power2.mjs --private cal:stable --template c2:OC:OCR`. `review-summary.mjs` now deduplicates copied sessions.

## Continuation 2026-11-07 (W5, part 2): integrity-censored calibration, sibling-answer isolation, supply intake, v3 plan

- **Calibration classification** (`src/calibration.mjs` CENSORING_V2 `infra-integrity-excluded@2`; `recalibrate-v2.mjs`): integrity
  units are integrity observations and never difficulty evidence; >= 2 valid units per task; `verifyCalibrationReport` refuses
  hard levels certified under a rule that counts integrity failures. Raw reports unchanged; derived
  `<private>/calibration/state-b{1,2}/calibration-report.derived-v2.json`: **no level hard** (b1 easy 1 task 1.0 + 2 insufficient,
  medium 0.67; b2 declared-hard 0.78, medium 1.0). No new target call (ledger 599/4500, 0 open).
- **Sibling-answer leaks** (`sibling.mjs`; record `<private>/exposure-sibling-2026-11-07.json`, hashes/ids only): starting repos
  that held a sibling's reference file were versioned (sibling-isolation: start reverted, minimal solution verified) and
  re-reviewed cross-provider on the new content: cycle-report-v2, watch-staleness-v2, fail-schedule-v2 (then -v3: adjudicated
  test gap, blind tests added), offset-timeline-v2, gatekeeper-halfopen-v3 (supersedes v2). Not isolable: skip-move-exceptions
  (excluded, never intaken) and pallets-reservation-holds-v2 (registry status `withdrawn`, code sibling-answer-leak). Sealed
  calibration tasks toolshed-optimistic / lockerbill-plan-proration(-v3) keep their content; their target runs exposed sibling
  answers to the target provider (recorded). The per-unit sandbox is not used as the safety argument.
- **Intake** (isolated pool): 5 new eligible (`<private>/intake/supply-3-intake.json`) + halfopen-v3; unbatched eligible now 11
  tasks / 6 families / 1 authoring account. Earlier excerpt exposure in agent transcripts is recorded, not undone.
- **Plan v3** (`DESIGN-v3.md`, `protocol-v3.json` = v2 gates + new rationale, `study-v3.json`, `power3-main.json`,
  `readiness-v3.json`): adopt-and-confirm at 0.15 for 144+144 = 0.78 / 0.67 / 0.36 (logit sf0.5 / template / sf1) < 0.8; plan
  stays provisional; readiness `blocked` (calibration: no hard level; main/confirmation: no sealed batch).
- Review cost (deduplicated, `review-summary-v3.json`): 102 sessions over reviews-v2+v3, 1748 forwarded, priced $32.26 list;
  1238 forwarded on models without a catalog price (not free).
