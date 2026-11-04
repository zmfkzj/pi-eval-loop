# Measured run `abc-real-1` (2026-11-04): real-model baselines, candidates and A/B/C

> **TRUNCATED EXPLORATORY EVIDENCE.** The search was capped at 4 candidates per trajectory because of the implementing session's
> wall time (a limit the user forbade), and only 3 candidates per arm were evaluated. It is not a completion of the requested
> quality-first search. Corrections (exact rates, the multi3 label, the integrity rule) are listed in
> [`records/abc-real-1/STATUS.md`](../records/abc-real-1/STATUS.md) and applied below; the records themselves are unchanged.
> The compliant continued search is [`results-explore-real-2.md`](results-explore-real-2.md).

**Result: no harness improvement was found that generalizes. Nothing was adopted: the adoption gate returned BLOCKED.** This is a
real measurement, not a simulation: 522 real attempts, 0 simulated. Every number below comes from the committed records in
`pi-eval-loop/records/abc-real-1/`. The full per-arm reports are `A|B|C/report.md`; the joint result is `ablation.md` /
`ablation.json` (generated under protocol-1: their Q columns are bootstrap Monte Carlo means, see STATUS.md).

## Setup

| Item | Value |
|---|---|
| Command | `npm run eval:loop -- --ablation --state pi-eval-loop/state/abc-real-1 --protocol pi-eval-loop/protocols/abc-real-1.json` |
| Code | commit a01b074; the protocol lock holds the sha256 of every evaluator file |
| Agent route (every arm) | `cliproxyapi/gpt-6-luna`, effort medium, Pi CLI 1.5.0 (the user's global install); one environment digest for all 522 attempts |
| Target harness | pi-orche `e831a6b`, mode `single` (stable = orche HEAD; the target mode's existing implementation is the same harness) |
| Optimizer | plain Pi on `cliproxyapi/gpt-6.1-sol` effort high, in the sandbox, on a copy of the harness runtime |
| Train | 11 orche suite tasks, 3 repeats |
| Dev | 16 orche suite tasks, 3 repeats |
| Holdout | 7 `holdout-v1` tasks, 3 repeats; family-disjoint; one recorded use in `datasets/holdout-v1/USES.jsonl` |
| Defaults | 10,000 draws; screening .80 at execution level, 3–9 repeats; development and adoption at task level, adoption .95; ε_overall 3 points |
| Operational overrides (recorded) | 6 parallel units per trajectory; at most 4 candidates per trajectory, set by the session wall time (the default was 40). **This cap was time-motivated and is withdrawn**; see STATUS.md |

## Baselines (descriptive; exact rates, 95% task-level bootstrap intervals in the reports)

| Arm | Train success | Dev success (exact) | Dev 95% interval | Dev model requests / input tokens | Actual attempts per dev unit |
|---|---:|---:|---|---:|---:|
| stable orche (single) | 18/33 (54.55%) | 37/48 = 77.0833% | [56.9, 92.0] | 917 / 8.00 M | 1.00 |
| pure Pi (no extension) | 21/33 (63.64%) | 43/48 = 89.5833% | [74.7, 97.9] | 427 / 1.36 M | 1.00 |
| multi3: up to 3 independent pure-Pi attempts, first passing visible tests | – | 46/48 = 95.8333% | [85.1, 99.8] | 432 / 1.42 M | 1.00 (allowed 3) |

Observation, not a tested claim: with this model and effort, plain Pi solved more dev tasks than stable orche in single mode, and
orche used about 2.1× the model requests and 5.9× the input tokens. **multi3 is not an equal-compute control**: the first attempt
passed the visible tests in every one of its 48 dev units, so it never used a second attempt and is effectively a second
independent single-attempt sample of pure Pi. Nothing in this run measures what extra attempts or orche-level compute buy.

## Candidates (every attempt kept; `B|C/candidates/<id>/`)

| id | Parent | File | Outcome |
|---|---|---|---|
| B-c001 | stable | src/extension/workers.ts | Screening support 1.00. Dev 37/48 = 77.0833%, identical to stable (the earlier "77.1% vs 77.0%" was bootstrap noise; support .56). Dev-rejected: 9 vs 5 runs with task-agent workspace-integrity violations |
| B-c002 | stable | src/extension/workers.ts | Screening .76 (extended band). Rejected: 11 vs 10 task-agent integrity runs |
| B-c003 | stable | src/extension/workers.ts | Screening .61: rejected |
| B-c004 | stable | src/tools/bash.ts | **Not evaluated** (see defect 1) |
| C-c001 | stable | src/extension/workers.ts | Screening 1.00. Dev 38/48 = 79.1667% vs 37/48 = 77.0833% (support .69, P(loss>3 points) .28). Development-qualified, **selected** under protocol-1. It had task-agent integrity violations in 3 screening, 5 dev and 2 development-train runs; protocol-2 would have rejected it at screening |
| C-c002 | C-c001 | src/extension/workers.ts | Rejected: 1 vs 0 integrity runs |
| C-c003 | C-c001 | prompts/c1-engineering-discipline.md | Rejected: 3 vs 2 integrity runs |
| C-c004 | C-c001 | src/extension/workers.ts | **Not evaluated** (see defect 1) |

Every proposal changed only pi-orche harness files: worker instructions, a prompt and the bash tool. None changed task code,
tests, the evaluator or the controller. The protected-state digests were unchanged around every proposal. Proposer usage was
9–12 requests per candidate, 0.3–0.5 M input tokens.

## Holdout and A/B/C (one joint pass)

| Condition | Final harness | Holdout success (exact) | 95% interval | Q_hard |
|---|---|---:|---|---|
| A stable | stable | 15/21 = 71.4286% | [38.3, 94.3] | 33.4% (MC mean) |
| B quality-only (greedy) | stable (no candidate selected) | 15/21 | same harness as A | |
| C quality-first Pareto | C-c001 | 13/21 = 61.9048% | [27.1, 90.7] | 11.2% (MC mean) |

- **C vs A** (task-level paired bootstrap): P(overall improves) = 0.134, overall Δ −9.6 points [−36.8, +8.9]. The development gain
  did not carry over to the holdout. The direction is uncertain, and no improvement is supported.
- **B vs A**: B ended on the stable harness, so there is no difference by construction.
- **C vs B**: support 0.139, Δ −9.4 points.
- **Usage** (screening and development runs / model input tokens / proposer requests):
  - B: 153 runs / 50.5 M / 43 requests.
  - C: 117 runs / 31.8 M / 41 requests.
- Both conditions had the same proposal cap (4 each, time-motivated) and the same tasks, route and protocol. They are not
  compute-matched, and each one's actual usage is listed above.

**Adoption gate for C-c001: BLOCKED.** Three independent reasons, each sufficient:
1. The holdout is implementer-authored: provenance is not accepted for independent claims, by design (`docs/design.md` §4).
2. Critical: 8 holdout runs with task-agent workspace-integrity violations vs 4 for stable (agents changing lines of existing
   test files; no leak, route violation or harness-patch violation).
3. The candidate failed an orche test that passes for stable in the same sandbox:
   `test/extension/task.test.ts > keeps the omitted-mode SDK implement instruction byte-identical to HEAD`; it passed 3006 vs 3007
   tests. The fail-closed check gate caught a real regression.

Even with an external holdout, the statistics alone would have given KEEP_STABLE (support 0.134 < 0.95). The stable harness stays
in place, and no local stable ref was moved.

## Defects found by this run and their status

1. **Candidate cap stopped the search right after the 4th proposal**, so B-c004 and C-c004 were never evaluated. Both trajectories
   were affected the same way (3 evaluated + 1 abandoned each). Fixed after the run: the cap now waits for the in-flight candidate
   (`src/loop.mjs` `watchdog`, test "the candidate cap never leaves the last created candidate unevaluated"). The run's records
   are kept unchanged.
2. Report rendering of candidates rejected before statistics ("@undefinedr"). Fixed in `src/report.mjs`.

## Limitations of this measurement

- Few tasks: 7 holdout tasks give wide intervals.
- The holdout was written by the implementing agent. It is not externally curated and has now been used once, so it is no longer
  independent.
- The candidate budget was 4 per trajectory, set by session wall time, and only 3 per arm were evaluated. This is one truncated
  cycle; the continued search is `explore-real-2`.
- protocol-1 treated task-agent integrity violations as critical only when the candidate had more of them than its reference.
  That rule let C-c001 reach selection with as many violating runs as stable. protocol-2 rejects any such run regardless of the
  baseline (`src/gate.mjs` `criticalProblems`).
- The Pi CLI for the runs is the user's 1.5.0. The umbrella's compatibility gate pins 1.4.0 for extension loading tests.
