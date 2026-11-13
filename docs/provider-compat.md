# CLIProxyAPI provider compatibility (2026-11-13)

Every sandboxed Pi that pi-eval-loop starts (task agent `src/runner.mjs`, proposer `src/proposer.mjs`, confirmatory reviewer
`studies/confirmatory-1/review.mjs`) loads ONE CLIProxyAPI provider extension with `-e /opt/eval-loop/provider/extensions/index.ts`
and talks to the host only through the in-box bridge, the endpoint gate and the pinned-route proxy. Two provider packages exist and
they configure themselves differently, so the engine detects the package and writes the matching private configuration.

## Supported packages

| Layout | Package | Verified versions | Configuration the provider reads (inside the sandbox) | Inference path through the gate |
|---|---|---|---|---|
| `cpa` | `pi-cliproxyapi-provider` (unscoped, github.com/0xRichardH) | **0.16.x** (checked against 0.16.10 source: `src/config.ts`, `src/discovery.ts`, `src/catalog.ts`, `src/registration.ts`; the bundle lock names 0.16.11) | `$HOME/.pi/agent/pi-cliproxyapi-provider/config.json` (connection) overridden by `CLIPROXYAPI_*`; model list ONLY from `$HOME/.cache/pi-cliproxyapi-provider/<base64url(providerName + "\n" + baseUrl)>/cpa-models.json` in offline / print mode | `POST /v1/responses` (GPT routes use the Responses API), `GET /v1/models` |
| `legacy` | `@router-for-me/pi-cliproxyapi-provider` | 1.x (e.g. 1.4.21) | `<PI_CODING_AGENT_DIR>/cliproxyapi.json` (+ `cliproxyapi-models.json`) | `POST /backend-api/codex/responses`, `POST /backend-api/responses`, `GET /v1/models` |

Any other unscoped version (0.17+, < 0.16) is reported by `prerequisites()` as an unverified version (`provider` not ok, run
BLOCKED) unless `EVAL_LOOP_PROVIDER_LAYOUT=cpa` accepts its layout explicitly. A tree without a package name is treated as legacy
(the behaviour before this change).

## What the engine writes per sandbox (`src/sandbox.mjs privateProviderSetup`)

cpa layout, for route `cliproxyapi/<model>`:

- `<box>/home/.pi/agent/pi-cliproxyapi-provider/config.json` = `{ providerName: "<route.provider>", baseUrl: "http://127.0.0.1:18317/v1", authRequired: true, authHeader: true }`
  (the package's default provider name is `cpa`; the engine sets the route's provider so `--model cliproxyapi/<model>` resolves);
- `<box>/home/.cache/pi-cliproxyapi-provider/<key>/cpa-models.json` = `{ fetchedAt, data: [...] }` seeded from the catalog
  directory (`EVAL_LOOP_CATALOG_DIR`, else `EVAL_LOOP_AGENT_DIR`): a frozen `cpa-models.json` when present (the provider's cache
  envelope, a `/v1/models` response or a plain array), else the model ids of `cliproxyapi-models.json`. Without this snapshot
  `pi --offline -p` registers only the provider's placeholder and fails with `Model "cliproxyapi/<model>" not found`;
- sandbox environment `CLIPROXYAPI_BASE_URL=http://127.0.0.1:18317/v1`, `CLIPROXYAPI_PROVIDER_NAME=<route.provider>`,
  `CLIPROXYAPI_API_KEY=<placeholder>` (the real key exists only in the host-side route proxy).

legacy layout: `<box>/agent/cliproxyapi.json` with the placeholder key and `CLIPROXYAPI_BASE_URL=http://127.0.0.1:18317` (unchanged).

Both HOME and the agent dir are the sandbox's private directories; nothing is written under the operator's `~/.pi` or `~/.cache`.
The sandbox starts from an empty environment, so `CLIPROXYAPI_*` values of the controller never reach the provider.

## Overrides

| Variable | Effect |
|---|---|
| `EVAL_LOOP_PROVIDER` | provider package directory (default: the first installed of `<umbrella>/cliproxyapi/node_modules/pi-cliproxyapi-provider`, `<umbrella>/cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider`) |
| `EVAL_LOOP_PROVIDER_LAYOUT` | `cpa` or `legacy`: force the layout (e.g. accept an unverified unscoped version) |
| `EVAL_LOOP_CATALOG_DIR` | where `cliproxyapi-models.json` / `cpa-models.json` are read for the private model snapshot |
| `EVAL_LOOP_AGENT_DIR` | host agent dir of the upstream key: `cliproxyapi.json` `apiKey`, else a literal `apiKey` of `pi-cliproxyapi-provider/config.json` (a `!command` is never executed) |

## Environment digest

The digest's `gate` fact is the endpoint gate of the provider's layout. A legacy environment keeps exactly its previous facts and
digest (verified against release b8c5b99 with the 1.4.21 copy); switching to the 0.16.x package changes `provider`, `providerIndex`
and `gate`, so it is a new environment, as it should be.

## Verification (no provider, no credential, no budget)

`test/provider-compat.test.mjs` runs the installed 0.16.x extension in the real bwrap sandbox against the local faux upstream:
a task-agent unit on route `cliproxyapi/gpt-6.1-terra` completes with every forwarded request on `/v1/responses` at the pinned
model and effort, and the proposer registers `cliproxyapi/gpt-6.1-sol` privately and reaches the upstream through the gate.

Not covered: `experiments/ctrl-confirm-4/runtime.mjs hostSources()` still names the scoped package as the source of a NEW frozen
runtime snapshot (that campaign is locked; pass `sources` explicitly to snapshot another package).
