# Target route selection and one shared attempt total (2026-11-13)

Status: **engine support, verified with simulated backends, a local fake upstream and temporary ledgers only.** Nothing here
is a Terra measurement. No model was called, no live gateway, credential, schedule or consumer ledger was touched. Terra
calibration, analysis plan, power evidence, task supply and approvals remain open (`docs/terra-study-v4.md`).

## 1. Target route of exploration / screening / autonomous configs

An `exploration@1` config (any `mode`) may name the TARGET route at top level:

```json
"route": { "provider": "cliproxyapi", "model": "gpt-6.1-terra", "effort": "medium" }
```

- **Absent**: the package default (`DEFAULT_PROTOCOL.route`, cliproxyapi/gpt-6-luna medium). Plans, digests and records of
  configs without `route` are unchanged.
- **Present**: exactly `{provider, model, effort}`; `effort` one of `minimal low medium high xhigh max ultra`. Anything else
  (null, a string, missing/extra field, empty id, unknown effort) is `config-invalid`.
- **Catalog**: for a live config the route must be served by the isolated runtime's OWN catalog snapshot
  (`<runtime>/manifest.json` `agentDir`, `cliproxyapi-models.json` / `cpa-models.json`), and an entry with a
  `thinkingLevelMap` must map the effort to a level. Otherwise preflight/run block with `prerequisite-failed` before anything is
  reserved or dispatched (`src/isolated-runtime.mjs` `routeCatalogProblems`). The mutable global catalog is never consulted.
- **Where it is used** (every target-model call): screening dev and holdout, exploration-only holdout, autonomous exploration,
  confirmatory holdout, post-adoption deployment smoke, post-adoption confirmation; the environment digest of every live pass;
  the peer-pressure meter (`gatewayPressureMeter`, failures of the selected model only); calibration already takes
  `calibrate.mjs --route/--effort` (`docs/terra-study-v4.md`), now validated against the same catalog snapshot (model and effort).
- **Not changed by it**: the proposer route (`protocol.proposer.route`, or the consumer's own proposer route) and reviewer
  routes (`review.mjs --model/--effort`). Screening smoke stays model-free.

### Identity and safety checks

- The config file digest (cycle `protocol.lock.json`, which now also names `route`) binds every cycle state: a changed route is
  a new config, so a state directory never continues under another route (`state_error`).
- The route is frozen into every plan (`plan.json`, `screen-plan.json`, `holdout-plan*.json`, `confirm-plan.json`,
  `postconfirm-plan.json`) and the confirmation `registration.json`; plan digests are the records' `protocol_digest`.
- Every evidence record carries `model_route` and `thinking_effort` of the selected route; a holdout decision additionally
  requires every final record to match the pass's route and effort (`routeOk`).
- No evidence carries across routes (provider, model and effort each count):
  - a screening registry holding dev/holdout results of another route (a result without `route` is the default route) blocks
    the series with `prerequisite-failed` (preflight and run): a route change needs a new registry;
  - exploration-only / autonomous: the bound integrity screen report must name the target route (an old report without
    `route` was measured on the default) -> otherwise `prerequisite-failed`;
  - autonomous: the registered confirmatory protocol must name the target route (`route` in the protocol file, else it is the
    default route) -> otherwise `config-invalid`; `attemptsPerUnit` is sized only from `screen.runs` records of the target route.
  The studies' existing luna protocols (`protocol-v3.json`, `readiness-v3.json`, power) are not rewritten and do not satisfy a
  Terra target.

## 2. One shared total across roles

ONE `RequestBudget` ledger (its `init` limit and scope are immutable) can carry every charged attempt of a series:

| Role | How it charges | Counts toward the limit | Funds outbound gate attempts |
|---|---|---|---|
| screening dev / holdout, exploration, confirmation, deployment smoke, post-confirmation, retries | `attemptAdmission` reservations (`meta.route` e.g. `screening`), gate `attempt` records | yes | yes (gate-covered) |
| calibration (`calibrate.mjs --budget-ledger L --budget-limit N --budget-scope S`) | gate-covered reservations against the ledger only (no `--max-requests`, no sub-ceiling since 2026-11-13) | yes | yes |
| proposer (agent_workflow) | `reserve(max, { route: "proposal" })`, settle the proxy's forwarded count | yes | **no** (off-gate) |
| reviewer (`review.mjs --budget-ledger L --budget-limit N --budget-scope S`) | `reserve(--max-requests, { route: "review" })` per session, settle forwarded | yes | **no** (off-gate) |

Rules (`src/request-budget.mjs`):

- `charged` (all roles) <= `limit` decides every reservation: one total, no per-role allowance.
- Off-gate routes are `RETAINED_ROUTES = ["proposal", "review"]`. `budgetTotals` reports `gatedCharged`, `gatedOpenAmount`,
  `gatedOpenReservations` and `offGateCharged` next to `charged`.
- The outbound gate admits an attempt only while `attempts + 1 <= gatedCharged` AND a gate-covered reservation is open: a
  settled or open proposal/review reservation, or settled slack of a closed unit, never lets traffic leave.
- `attempts > gatedCharged` is a ledger inconsistency: every reservation then throws (fail closed). A legacy ledger whose
  attempts were covered only by proposal charges is refused, never reinterpreted.
- A gate-covered settlement is raised to its attempt floor (computed on gate-covered charges); an off-gate settlement records
  exactly the reported count (callers clamp it to the reservation).
- `reconcileDead`: dead gate-covered reservations settle at their attempt floor, dead off-gate ones at their FULL amount.
- The screening dev slack check now compares `attempts` with `gatedCharged - gatedOpenAmount`: settled proposals or reviews in
  the same ledger no longer trip it, while any other gate-covered slack still fails closed.
- Budget policy `shared-total-only` (user decision 2026-11-13: "공유 상한 하나만 사용"): the ledger limit is the ONLY spending limit.
  - Screening `caps` (dev, holdout, perCandidate, perCycle, cumulative), the internal track's cost fit and the calibration
    `--max-requests` sub-ceiling (`RequestBudget.reserve` / `attemptAdmission` `subCap`) are removed: `subCap` throws, legacy
    `screening.caps` are ignored and reported, and a shared-ledger calibration refuses `--max-requests` and a bounded approval.
  - Admission checks that remain all read the shared `remaining` (settled + every role's open worst cases), so proposals and
    reviews already reduce them. They are: per-unit worst-case reservations; the screening planner's
    `passNeed` (sizing estimate: the next pass plus a waiting holdout / internal assessment); the autonomous `minRemaining`; and
    confirmation affordability.
  - Kept on purpose (not spending caps):
    - termination bounds per run or session: `unit.maxRequests`, `wallMs`, the reviewer's per-session `--max-requests`,
      stage deadlines;
    - integrity and early elimination;
    - no-progress stops;
    - trial design (tasks, repeats, families);
    - preregistered completed research campaigns (ctrl-confirm prereg budgets);
    - confirmatory-1's own study ledger (no `--budget-limit`: limit = the approved `--max-requests` <= 4500, research
      provenance).
- An open reservation of any role still blocks a holdout batch from being consumed (unchanged, conservative).

Limits of the accounting: proposal and review requests are counted by the route proxy (`forwarded`), not by an outbound gate,
so gateway-internal retries of those calls are not visible to the ledger; the worst case is reserved up front and an abandoned
reservation keeps it. Since 2026-11-13 (`src/admission.mjs` `offGateAdmission`) an off-gate session can instead be charged in
**upstream-attempt-bound** units (forwarded x the gateway's `gatewayAttemptBound`, re-read at settlement; a bound that grew or
became unreadable charges the full reservation). That is a bound only under the assumption that the gateway kept the read
configuration during the session (`gatewayIsolationProblems` lists the setups where it cannot change); with a shared,
hot-reloadable gateway it is not a proof. `budgetTotals` reports `offGateUnits` {upstreamAttemptBound, proxyForwarded} and
`upstreamAttemptsBounded` (false while any off-gate charge is proxy-forwarded). `review.mjs --gateway-config CFG` uses the
bound; `--require-attempt-bound` refuses a session without it (strict total). The agent_workflow proposer still charges
`proxy-forwarded` until the consumer adopts `offGateAdmission` (consumer-owned; see docs/internal-promotion.md section 7).

## 3. Consumer configuration (agent_workflow; the consumer owns its files)

For a series with one 300000 total that already spent attempts in older ledgers:

1. Create ONE new ledger whose `init` limit is the user total minus everything already charged elsewhere (for terra-1:
   300000 - 261 (`target-model-requests.jsonl`) - 24 (`eval-ledger-2.jsonl`) = **299715**; proposal ledgers 0) and whose scope
   states that derivation; freeze the old ledgers (never point a config at them again). A fresh 300000 ledger would reset the
   already charged spend.
2. Bind the isolated runtime to it: `isolated-runtime.mjs prepare --dir RT --budget-ledger L --budget-limit 299715
   --budget-scope "<exact scope>" --models <catalog with gpt-6.1-terra> ...`. The exploration config's `budget` must equal the
   runtime manifest's `budget.path/limit/scope` exactly (else `prerequisite-failed`, misbound runtime).
3. Every config (screening, autonomous) names `budget: { ledger: L, limit: 299715, scope: "<exact scope>" }` and
   `route: { provider: "cliproxyapi", model: "gpt-6.1-terra", effort: "medium" }`; screening uses a NEW `screening.registry`
   and `workDir` (the old registry holds luna results and is refused for Terra); every cycle uses a new state directory.
4. Proposals: drop the separate `proposer.ledger` so the proposer reserves in `L` with `meta.route: "proposal"` (requires an
   engine release with this change: the slack check of earlier releases fails closed on it).
5. Reviews: pass `--budget-ledger L --budget-limit 299715 --budget-scope "<exact scope>"` to `review.mjs`.
6. Calibration: `calibrate.mjs --budget-ledger L --budget-limit 299715 --budget-scope "<exact scope>"
   --route cliproxyapi/gpt-6.1-terra --effort medium --context <terra context> --runtime RT ...` with an approval that states
   `budgetPolicy: "shared-total-only"` and carries no `maxRequests` (an older bounded approval must be re-approved; it is never
   widened).
7. Autonomous mode additionally needs a Terra-registered confirmatory protocol (`"route"` in the protocol file), a readiness
   record bound to it and a Terra integrity screen (report with `route`, `screen.runs` with Terra `model_route`); none of these
   exist yet (`docs/terra-study-v4.md`).
