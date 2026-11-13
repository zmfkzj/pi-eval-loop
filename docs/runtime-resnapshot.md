# Isolated runtime credential re-snapshot (2026-11-13)

```bash
node studies/confirmatory-1/isolated-runtime.mjs resnapshot --dir D [--credential F]
```

Model-free. Replaces the access-token-only codex snapshot of the isolated runtime `D` (prepared by `isolated-runtime.mjs prepare`)
with the CURRENT access token of its live source credential, so an unattended series keeps a usable runtime after the live
gateway has refreshed its token. Implementation: `src/isolated-runtime.mjs resnapshotRuntime`, CLI `resnapshotCli`; tests
`test/runtime-resnapshot.test.mjs`.

## Output

Exactly one JSON line on stdout for every outcome (usage errors included); nothing on stderr:

```json
{"schema":"pi-eval-loop/runtime-resnapshot@1","ok":true,"usableUntil":"2026-11-20T02:15:02.000Z","code":"resnapshotted","problems":[]}
```

- `ok`: true only on exit 0.
- `usableUntil`: on success the new snapshot's usable-until time; on a refusal the runtime's UNCHANGED manifest value; `null` when
  it is unknown (usage error, unreadable manifest). The consumer (agent_workflow `checkEvalLoopCredential`) reads `usableUntil` only
  when `ok` is true and keeps its own manifest reading otherwise.
- `code`: success `resnapshotted` (snapshot + manifest replaced), `repaired` (same token, manifest facts rewritten), `unchanged`
  (nothing to do); refusals below.
- `problems`: human-readable reasons; never token, key or file content.

## Exit codes (every non-zero exit leaves the runtime unchanged)

| Exit | Codes | Meaning / safe handling |
|---|---|---|
| 0 | `resnapshotted`, `repaired`, `unchanged` | completed |
| 2 | `source-in-refresh-lead` | the SOURCE token itself expires within the 96 h refresh lead + 6 h margin (`usableUntil = exp - 102 h <= now`): wait for the live gateway's own refresh, retry later |
| 3 | `busy` | the runtime is running or used: live `state.json` supervisor or sandbox, a gateway process of `D/cli-proxy-api`, a live pid in `D/users/`, a held `D/.runtime-op.lock` (a start or another re-snapshot), or activity that cannot be verified; retry when stopped |
| 1 | `account-mismatch`, `source-older`, `source-invalid`, `source-missing`, `no-source`, `runtime-invalid`, `account-unverifiable`, `write-failed`, `write-failed-inconsistent`, `internal-error` | refused, needs an operator: a source of another account (vs the snapshot's `account_id` AND the manifest's `accountIdSha256`), a source token expiring before the current snapshot's, an unreadable / non-codex / disabled / prefixed source, a runtime without exactly one credential. Retrying is harmless (model-free, nothing changes) but will not succeed until the cause is fixed. `write-failed`: the manifest could not be written and the previous snapshot was restored; `write-failed-inconsistent` (restore also failed) is the only state that needs inspection before the next start |
| 64 | `usage` | bad arguments |

## What it does (under `D/.runtime-op.lock`, which `startRuntime` also takes)

1. Refuses unless the runtime is provably idle (see exit 3).
2. Reads the source (`--credential F`, default the manifest's `credential.sourceFile`); the source is only read: never written,
   refreshed or rotated.
3. Applies the `prepare` rules unchanged (`snapshotOf`): codex, enabled, unprefixed, `access_token` + `account_id`, JWT expiry,
   and the readiness lead `CODEX_REFRESH_LEAD_H` (96 h) + 6 h. Boundary: a source expiring exactly 102 h after now is refused (2).
   An expired OLD snapshot is no obstacle (that is what this repairs).
4. Requires the same account (snapshot and manifest) and a source token not older than the current snapshot's.
5. Writes the new snapshot (access token, account, email, plan, expiry, last refresh; never `refresh_token` or `id_token`)
   atomically with the old file mode, then the manifest with `credential` = the new facts (`accessTokenSha256`, `accountIdSha256`,
   `expiresAt`, `usableUntil`, `refreshTokenCopied: false`, `idTokenCopied: false`, `resnapshotAt`). `config.yaml`, its pinned
   hash, ports, agent dir, budget binding and the gateway's other auth-dir state (`kv.db`) are not touched. A non-secret audit line
   is appended to `D/logs/resnapshot.jsonl`.

## Known limits

- The gateway's own `auth/kv.db` is left as is; whether CLIProxyAPI 8.0.57 caches token state there was not verified (no live
  gateway was started). A stale cached token would fail closed (401, one counted attempt), never use another credential.
- A process that starts the runtime with a release older than this one does not take `.runtime-op.lock`; the activity checks
  (supervisor, gateway process, users) still apply.
