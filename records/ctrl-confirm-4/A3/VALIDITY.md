# ctrl-confirm-4 — A3 post-launch runtime deviation, validation and continuation decision (2026-11-08)

Post-launch record. It is NOT part of the preregistration: `experiments/ctrl-confirm-4/PREREGISTRATION.md` and `prereg.json` are
unchanged (digest `faee9851…`); the original `state/ctrl-confirm-4/lock.json` (sha256 `e042b2fc…`) is unchanged. The re-binding
is `state/ctrl-confirm-4/continuation.json` (hash-chained, version 1), which names this file and the evidence below by sha256.
The decision was taken without looking at any per-arm outcome; only arm-blind terminal-status counts (completed / model_error)
and resource counters were read during the hold.

## 1. What happened (observed)

| time (UTC, 2026-11-08) | event | evidence |
|---|---|---|
| 03:14:04 | A2 preflight passed, envDigest `f5ce1410…` (provider 1.4.24) | `state/ctrl-confirm-4-preflight/preflight-post-reboot-A2.json` |
| 03:14–03:16 | smoke2 6/6 on that runtime | `state/ctrl-confirm-4-smoke2` |
| 03:17:09 | launch (grader validation 700/700) | `A2/POST-LAUNCH.md` |
| 04:06:37–04:07:22 | scheduled `aw-maint-pi-migration` (Pi 1.4→1.5 dev deps) reinstalled shared packages | ctimes in `provenance.json` |
| 04:33:59.754 | lock (envDigest `d3109082…` = provider 1.4.25), uses recorded (1 per batch) | `lock.json` |
| 04:34:00–04:47:06 | 49 dispatches, 41 results (40 completed, 1 model_error) | `runs.jsonl`, `provenance.json` |
| 04:48:21 | runner stopped (SIGTERM; no graceful drain existed); 04:48:42 durable operator hold (resources seq 109) | `resources.jsonl` |

Exact identities (`provenance.json`, `provider-1.4.24-to-1.4.25.diff`, `orche-node_modules-version-changes.json`,
`bun-global-vs-cache.json`):

- Validated runtime: provider **1.4.24** (index.ts `51ee8c36…`) — recomputing `environmentDigest` with the npm 1.4.24 package and every
  other current fact gives exactly `f5ce1410…`; with 1.4.25 it gives the locked `d3109082…`. node v24.21.0, pi CLI 1.5.0 (bundle
  hash unchanged), bwrap, route: unchanged.
- Provider 1.4.24 → 1.4.25: `index.ts` only appends the load error to an error message (failure path); `codex-stream.ts` adds
  module-location candidates for pi 1.5 layouts (`dist/openai-codex-responses.js`, nested and `~/.pi/runtime` paths) before the
  original `dist/api/openai-codex-responses.js`. The runtime contains exactly ONE such module
  (`@earendil-works/pi-ai/dist/api/openai-codex-responses.js`), and inside the sandbox HOME is private (no `~/.pi/runtime`), so
  both versions load the same codex stream module.
- orche/node_modules: 12 package-version changes (pi-* 1.4.0→1.5.0, undici, minimatch, pi-schema, glob-match). The harness
  (state/harness/OC, OCR; trees unchanged `6bfbe380…`/`503ae172…`) imports only `@ast-grep/napi`, `sharp`, `typescript`,
  `pi-gateway-images`, `typebox` and pi-* from node_modules; none of these changed, and pi-* / typebox are aliased by the pi loader
  to the host CLI's own modules (`pi-coding-agent/dist/core/extensions/loader.js` getAliases). PCR does not mount orche modules.
- bun global (pi CLI + its packages): 2 985 entries had ctime 04:07:22 because another project (`pi-commit`) hard-linked the same
  inodes from bun's cache; the content of all 124 packages is identical to bun's cache entries; `bun.lock` unchanged since 11-03.
- Model catalog: the host copy was refreshed at 04:45:59 by another session; every attempt refreshes its private copy from the
  proxy before its first model request (all 49 dispatches: GET /v1/models before the first POST); the gpt-6-luna entry differs only
  in `cost`/`lastSeenAt` (prices are zero inside the sandbox in every copy).

## 2. Did any unit see more than one runtime? (per unit, not by inference from the lock)

No. The record field `environment_digest` is copied from the lock and is NOT a measurement; per-unit provenance therefore uses
the start time of each attempt against the last content-relevant change (ctime) of every runtime component, plus each attempt's
own wire journal: all 41 results and 8 interrupted attempts started at or after 04:34:00, after the last change (04:07:22);
every POST went to `/backend-api/codex/responses`, model gpt-6-luna, effort medium, answered by gpt-6-luna. One interrupted PCR
attempt has no wire journal (killed before its first request). The 41 completed units ran WITHOUT the A3 per-dispatch guard; their
runtime identity rests on these ctime/wire facts.

## 3. What changed for the estimand (assessed without outcomes)

- Hypotheses, endpoints, tests, decision rule, arms, route, tasks, queue, ceilings: unchanged.
- Agent-visible inputs: unchanged once the frozen runtime is mounted at the original paths (see 4). Without that, the snapshot path
  enters pi's system prompt (3 documentation paths): smoke4 first requests were +45..+52 bytes in every arm.
- The provider version the validated environment (preflight, smokes, ctrl-confirm-2 pilot) used is 1.4.24; the campaign uses 1.4.25
  for ALL units. Differences are confined to module location and an error message (above). Residual risk: a behavioural difference
  of the codex stream path not visible in request sizes; judged negligible and identical across arms.
- The planning effect (+3.9 pt) comes from ctrl-confirm-2 under the earlier provider; it was already an assumption.

## 4. Frozen runtime and measured validation

- Snapshot `results/ctrl-confirm-4-runtime/rt-20261108-a3` (manifest `2e7424bb…`, 40 549 entries, read-only, sealed lstat
  fingerprint): byte-identical copies of node, bun global node_modules, provider 1.4.25, orche node_modules (without host test
  caches) and the catalog (diff -r against the shared trees: identical). Inside a sandbox, node and pi are mounted at their original
  host paths (`EVAL_LOOP_BOX_*`), provider and orche modules at the fixed mount points as before.
- Guard (`experiments/ctrl-confirm-4/runtime.mjs`): full content verification at every runner start; lstat fingerprint of the
  snapshot + harness trees + sha256 of the reused orche evaluator files before every dispatch and after every attempt; a change
  holds the campaign (`runtime` pause), a mid-unit change is recorded with the attempt and makes the analysis audit fail.
- Preflight on the frozen runtime (`state/ctrl-confirm-4-preflight/preflight-A3-frozen-runtime.json`): identities, seals, batch
  match, prerequisites, route authorization (authenticated model listing, 0 inference) ok; envDigest `d3109082…` = lock; harness
  trees = lock; uses = 1 per batch (consumed by this state — expected after launch, the only reason `infrastructureReady` is false).
- Smokes on exposed suite tasks (separate state ledgers; never the held-out batches): smoke3 0 requests (a read-only catalog copy
  blocked the provider — fixed in `src/runner.mjs`), smoke4 64 requests / $0.016 (snapshot paths visible), smoke5 on the final code:
  6/6 completed; first-request sizes vs smoke2 (validated runtime) differ by -3..+3 bytes, the same range as two runs of the SAME
  runtime (smoke vs smoke2: -3..+2) — `request-shape-*.json`.

## 5. Decision

RESUME the same state (no new state, no re-draw, no repeated unit, no new holdout use): the trial has a single actual runtime for
all units, that runtime is now frozen and guarded, its agent-visible inputs match the validated environment within run-to-run
noise, and no outcome-dependent change is involved. Limitations to report with the result: (1) the validated provider was 1.4.24,
the campaign's is 1.4.25; (2) the first 41 results predate the per-dispatch guard (provenance by ctime + wire); (3) the 8
attempts interrupted at 04:48:21 are reconciled by the registered attempt policy (completed model calls > 0 → `aborted`, a final
failure; none → retryable); they are an operator interruption, not an outcome; (4) the 04:48 stop had no graceful drain (added
now: SIGUSR1). If any of these is judged unacceptable later, the result is reported as provisional, never re-run on these tasks.
