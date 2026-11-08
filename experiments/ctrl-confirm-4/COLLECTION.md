# ctrl-confirm-4 — collection phase 2 (prospective rules, written 2026-11-07T18:30Z before any phase-2 acquisition)

Context: ctrl-confirm-3 ended BLOCKED at its feasibility gate (`experiments/ctrl-confirm-3/PREREGISTRATION.md` A2). Its records,
its supply root `results/ctrl-confirm-3-supply/` (collection cutoff 2026-11-07T17:00Z, `STOP_RULE.txt`) and its sealed batch
`ctrl-confirm-3-holdout-4206b2e38c1d` (159 tasks, 0 uses) are NOT changed. The user approved more tasks and higher finite budgets
(2026-11-07). This is a NEW collection phase with its own root, plans and stop rule; nothing here re-opens the ctrl-confirm-3 cutoff.
No agent runs on any collected case in this phase (model-free: clone, commit scan, extraction, sandboxed grader validation).

## Root and code

- Root: `results/ctrl-confirm-4-supply/` (git-ignored, outside every agent sandbox). Code: `experiments/ctrl-confirm-4/supply.mjs`,
  reusing `src/supply.mjs` unchanged and the ctrl-confirm-3 collection configuration (same commit filters, license list, validation
  repeats/timeouts, at most 3 cases per repository) with seed `ctrl-confirm-4/supply`.

## Plans (frozen files, written once)

- **Plan A** (`plan-a.json`): repositories of the ctrl-confirm-3 discovery plan (`results/ctrl-confirm-3-supply/repos.json`, 3 574
  kept) that ctrl-confirm-3 never reached: no registry record and no clone (incl. partial `*.git.tmp-*` clones) in any of its pools.
  ctrl-confirm-3 assigned the first 2 400 repositories (seeded order) to 12 slices; the collectors died at ~15:12Z with 832 cloned.
  A repository that was assigned but never cloned was never processed in any way and no agent ever ran on any ctrl-confirm-3 case,
  so it carries no exposure; the interrupted repository of each slice (partial clone) and every cloned repository are excluded.
- Exclusions re-evaluated now, for plan A and plan B: every repository named by the external pool
  (`/home/arthur/Code/agent_workflow/runs/eval-loop-supply`), and every repository touched by any consumed root: ctrl-confirm-2 supply
  and holdout, ctrl-confirm-3 supply (registries, reports, caches) and holdout (families of the 159 sealed tasks: those tasks may be
  reused as themselves, never as another case of the same family), and every pool below `/home/arthur/Code/agent_workflow/runs`
  (incl. `eval-loop-confirmatory-1`, collected after the ctrl-confirm-3 discovery; read-only, registries/reports only).
- **Plan B** (`plan-b.json`): repositories found by npm discovery with the NEW keywords only (`NEW_KEYWORDS`), same package filters
  (`node --test` script, no runtime dependencies, accepted license), minus plan A, minus everything the ctrl-confirm-3 discovery found
  (kept or excluded), minus the exclusions above. Plan B is used only after a slice exhausts its plan-A part (below).

## Collection and stop rule (finite)

- 12 collector processes, slice i/12 of plan A in seeded order sha256(seed:repo:slug), then (if `plan-b.json` is frozen by then)
  slice i/12 of plan B in its seeded order. Each runs as a transient systemd user unit with `RuntimeMaxSec` (bounded, survives a
  session end), `nice 15`, idle I/O class (a concurrent experiment on this machine is not starved).
- **Cutoff: 2026-11-08T01:00:00Z.** No repository is started at or after the cutoff (checked before every repository); every unit is
  killed by systemd at the cutoff + 20 min. Eligible records with registry time `at` > cutoff are retained as evidence but do NOT
  count. Collectors are never restarted after the cutoff. A collector that dies earlier may be restarted before the cutoff with the
  same command; it skips repositories with a recorded start and records the interrupted one as `interrupted` (never re-processed).
- Every repository start/end is appended to `pool-i/progress.jsonl` (time, pid, plan, eligible count, error codes). Slice reports
  and per-unit journals are retained.
- No early stop on counts; the phase ends at the cutoff or when all slices are exhausted.

## Use

Counting eligible cases (registry time <= cutoff) -> ctrl-confirm-4 assembly (exposure audit, conflict review, engine grader
validation, candidate-blind seeded selection, max 3 per family/repository) -> a NEW sealed batch (0 uses). Nothing is used for a
confirmation in this round.
