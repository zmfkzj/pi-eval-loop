# Measured run `abc-real-1` (2026-11-04): real-model baselines, candidates and A/B/C

**Result: no harness improvement was found that generalizes. Nothing was adopted: the adoption gate returned BLOCKED.** This is a
real measurement, not a simulation: 522 real attempts, 0 simulated. Every number below comes from the committed records in
`pi-eval-loop/records/abc-real-1/`. The full per-arm reports are `A|B|C/report.md`; the joint result is `ablation.md` /
`ablation.json`.

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
| Operational overrides (recorded) | 6 parallel units per trajectory; at most 4 candidates per trajectory, set by the session wall time (the default is 40) |

## Baselines (descriptive; 95% task-level bootstrap intervals in the reports)

| Arm | Train success | Dev success | Dev Q_overall | Dev Q_hard | Input tokens on dev |
|---|---:|---:|---|---|---:|
| stable orche (single) | 18/33 | 37/48 | 77.0% [56.9, 92.0] | 50.1% | 8.0 M |
| pure Pi (no extension) | 21/33 | 43/48 | 89.5% [74.7, 97.9] | 83.3% | 1.4 M |
| 3 independent pure-Pi attempts, first passing visible tests (equal-compute control) | – | 46/48 | 95.9% [85.1, 99.8] | 94.5% | 1.4 M |

Observation, not a tested claim: with this model and effort, plain Pi solved more dev tasks than stable orche in single mode, and
orche used about 6× the input tokens. The k-attempt control shows how much extra attempts alone can buy. On these tasks it beats
both single-attempt harnesses.

## Candidates (every attempt kept; `B|C/candidates/<id>/`)

| id | Parent | File | Outcome |
|---|---|---|---|
| B-c001 | stable | src/extension/workers.ts | Screening support 1.00. Dev 77.1% vs stable 77.0% (support .56). Dev-rejected: 9 vs 5 runs with workspace-integrity violations |
| B-c002 | stable | src/extension/workers.ts | Screening .76 (extended band). Rejected: 11 vs 10 integrity runs |
| B-c003 | stable | src/extension/workers.ts | Screening .61: rejected |
| B-c004 | stable | src/tools/bash.ts | **Not evaluated** (see defect 1) |
| C-c001 | stable | src/extension/workers.ts | Screening 1.00. Dev 79.1% vs 77.0% (support .69, P(loss>3 points) .28). Development-qualified, **selected** |
| C-c002 | C-c001 | src/extension/workers.ts | Rejected: 1 vs 0 integrity runs |
| C-c003 | C-c001 | prompts/c1-engineering-discipline.md | Rejected: 3 vs 2 integrity runs |
| C-c004 | C-c001 | src/extension/workers.ts | **Not evaluated** (see defect 1) |

Every proposal changed only pi-orche harness files: worker instructions, a prompt and the bash tool. None changed task code,
tests, the evaluator or the controller. The protected-state digests were unchanged around every proposal. Proposer usage was
9–12 requests per candidate, 0.3–0.5 M input tokens.

## Holdout and A/B/C (one joint pass)

| Condition | Final harness | Holdout success | Q_overall | Q_hard |
|---|---|---:|---|---|
| A stable | stable | 15/21 | 71.4% [38.3, 94.3] | 33.4% |
| B quality-only (greedy) | stable (no candidate selected) | 15/21 | same harness as A | |
| C quality-first Pareto | C-c001 | 13/21 | 62.0% [27.1, 90.7] | 11.2% |

- **C vs A** (task-level paired bootstrap): P(overall improves) = 0.134, overall Δ −9.6 points [−36.8, +8.9]. The development gain
  did not carry over to the holdout. The direction is uncertain, and no improvement is supported.
- **B vs A**: B ended on the stable harness, so there is no difference by construction.
- **C vs B**: support 0.139, Δ −9.4 points.
- **Usage** (screening and development runs / model input tokens / proposer requests):
  - B: 153 runs / 50.5 M / 43 requests.
  - C: 117 runs / 31.8 M / 41 requests.
- Both conditions had the same proposal budget (4 each) and the same tasks, route and protocol. Neither is compute-matched beyond
  that, and each one's actual usage is listed above.

**Adoption gate for C-c001: BLOCKED.** Three independent reasons, each sufficient:
1. The holdout is implementer-authored: provenance is not accepted for independent claims, by design (`docs/design.md` §4).
2. Critical: 8 holdout runs with workspace-integrity violations vs 4 for stable.
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
- The candidate budget was 4 per trajectory, set by session wall time. This is one cycle.
- The workspace-integrity rule (any changed line of an existing test file is a violation; a candidate with more such runs than its
  reference is critical) is strict. With counts this small it can reject candidates on noise. It was pre-registered and applied to
  every arm alike.
- The Pi CLI for the runs is the user's 1.5.0. The umbrella's compatibility gate pins 1.4.0 for extension loading tests.
