// `isolated-runtime.mjs resnapshot` (2026-11-13; docs/runtime-resnapshot.md): unattended, model-free replacement of a stopped
// runtime's access-token-only snapshot from its live source. Every case runs the real CLI (or the function behind it) on a
// throwaway runtime directory with fake JWT-shaped tokens; no real credential, runtime or ledger is involved.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { RESNAPSHOT_SCHEMA, resnapshotRuntime, runtimeLockPath, snapshotOf } from "../src/isolated-runtime.mjs";
import { acquireLock } from "../src/util.mjs";
import { tempDir } from "./helpers.mjs";

const CLI = new URL("../studies/confirmatory-1/isolated-runtime.mjs", import.meta.url).pathname;
const NOW = Date.parse("2026-11-14T00:00:00.000Z");
const H = 3600_000;
const sha = (b) => createHash("sha256").update(b).digest("hex");
/** A JWT-shaped fake whose signature part is a recognizable marker (it must never appear in any output). */
const jwt = (expMs, tag) => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), tag })).toString("base64url"), `SIGSECRET${tag}`].join(".");

/** A prepared-looking runtime (the binary is irrelevant to resnapshot) and its live source credential. */
function fixture({ oldExp = NOW + 110 * H, sourceExp = NOW + 200 * H, account = "acct-1", sourceAccount = account } = {}) {
  const root = tempDir("el-resnap-");
  const dir = join(root, "rt");
  for (const d of ["auth", "agent", "logs", "sock", "home"]) mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });
  const live = { type: "codex", access_token: jwt(oldExp, "old"), refresh_token: "RTSECRET-live", id_token: "IDSECRET-live", account_id: account, email: "op@example.invalid", last_refresh: "2026-11-09T05:15:02+09:00", disabled: false };
  const snap = snapshotOf(live, { source: join(root, "live.json"), now: NOW - 200 * H });
  writeFileSync(join(dir, "auth", "codex-snapshot.json"), JSON.stringify(snap.snapshot, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, "auth", "kv.db"), "gateway state");
  writeFileSync(join(dir, "config.yaml"), "config-version: 8\n", { mode: 0o400 });
  writeFileSync(join(dir, "agent", "cliproxyapi.json"), JSON.stringify({ apiKey: "iso-AGENTKEYSECRET" }), { mode: 0o600 });
  const manifest = { schema: "pi-eval-loop/isolated-runtime@1", mode: "live", createdAt: "2026-11-13T08:00:00.000Z", dir, configSha256: sha("config-version: 8\n"), ports: { outer: 18420, gw: 18418, gate: 18419 }, allow: ["chatgpt.com:443"], credential: snap.facts, budget: { path: join(root, "budget", "ledger.jsonl"), limit: 300000, scope: "terra-test scope" }, upstream: "http://127.0.0.1:18420", agentDir: join(dir, "agent") };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const source = join(root, "live.json");
  writeFileSync(source, JSON.stringify({ ...live, access_token: jwt(sourceExp, "new"), refresh_token: "RTSECRET-rotated", id_token: "IDSECRET-rotated", account_id: sourceAccount }), { mode: 0o600 });
  return { root, dir, source };
}

/** Content + mode of every file under a directory (what "no change" means). */
function tree(dir) {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[relative(dir, p)] = `${sha(readFileSync(p))}:${(statSync(p).mode & 0o777).toString(8)}`; } };
  walk(dir);
  return out;
}

function cli(args, { now = NOW } = {}) {
  const r = spawnSync(process.execPath, [CLI, "resnapshot", ...args], { encoding: "utf8", env: { ...process.env, EVAL_LOOP_TEST_NOW_MS: String(now) } });
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `exactly one stdout line: ${r.stdout}`);
  const out = JSON.parse(lines[0]);
  assert.equal(out.schema, RESNAPSHOT_SCHEMA);
  assert.equal(typeof out.ok, "boolean");
  assert.ok(Array.isArray(out.problems));
  assert.ok(out.usableUntil === null || new Date(out.usableUntil).toISOString() === out.usableUntil, "usableUntil is ISO (or null when unknown)");
  for (const marker of ["SIGSECRET", "RTSECRET", "IDSECRET", "AGENTKEYSECRET"]) assert.ok(!r.stdout.includes(marker) && !r.stderr.includes(marker), `${marker} disclosed`);
  return { code: r.status, out, stderr: r.stderr };
}

test("resnapshot: replaces the snapshot from the live source (same account), updates the manifest facts, keeps config, budget, ports, agent and the source", () => {
  const { dir, source } = fixture();
  const before = tree(dir), sourceBefore = { bytes: readFileSync(source), mtime: statSync(source).mtimeMs };
  const m0 = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const { code, out, stderr } = cli(["--dir", dir]);
  assert.equal(code, 0, JSON.stringify(out));
  assert.deepEqual({ ok: out.ok, code: out.code, usableUntil: out.usableUntil, problems: out.problems }, { ok: true, code: "resnapshotted", usableUntil: new Date(NOW + 200 * H - 102 * H).toISOString(), problems: [] });
  assert.equal(stderr, "");
  const snap = JSON.parse(readFileSync(join(dir, "auth", "codex-snapshot.json"), "utf8"));
  assert.equal(snap.refresh_token, undefined); assert.equal(snap.id_token, undefined);
  assert.equal(snap.account_id, "acct-1");
  assert.match(snap.access_token, /SIGSECRETnew$/);
  const m1 = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(m1.credential.usableUntil, out.usableUntil);
  assert.equal(m1.credential.expiresAt, new Date(NOW + 200 * H).toISOString());
  assert.notEqual(m1.credential.accessTokenSha256, m0.credential.accessTokenSha256);
  assert.deepEqual([m1.credential.accountIdSha256, m1.credential.refreshTokenCopied, m1.credential.idTokenCopied, m1.credential.resnapshotAt], [m0.credential.accountIdSha256, false, false, new Date(NOW).toISOString()]);
  for (const k of ["budget", "ports", "configSha256", "allow", "upstream", "agentDir", "mode", "createdAt", "dir"]) assert.deepEqual(m1[k], m0[k], k);
  const after = tree(dir);
  for (const f of ["config.yaml", "auth/kv.db", "agent/cliproxyapi.json"]) assert.equal(after[f], before[f], f);
  assert.match(after["auth/codex-snapshot.json"], /:600$/, "snapshot mode kept");
  assert.match(after["manifest.json"], /:600$/, "manifest mode kept");
  assert.deepEqual(Object.keys(after).filter(f => !(f in before)).sort(), ["logs/resnapshot.jsonl"], "nothing but the audit line is added");
  for (const f of ["manifest.json", "logs/resnapshot.jsonl"]) for (const marker of ["SIGSECRET", "RTSECRET", "IDSECRET"]) assert.ok(!readFileSync(join(dir, f), "utf8").includes(marker), `${f}: ${marker}`);
  assert.deepEqual({ bytes: readFileSync(source), mtime: statSync(source).mtimeMs }, sourceBefore, "the live source is only read");
  // Idempotent: a second run with the same source changes nothing.
  const t1 = tree(dir);
  const again = cli(["--dir", dir]);
  assert.deepEqual([again.code, again.out.ok, again.out.code, again.out.usableUntil], [0, true, "unchanged", out.usableUntil]);
  assert.deepEqual(tree(dir), t1);
});

test("resnapshot: an EXPIRED old snapshot is what it repairs; --credential names another source file of the same account", () => {
  const { root, dir, source } = fixture({ oldExp: NOW - 1 * H });
  const other = join(root, "copy.json"); writeFileSync(other, readFileSync(source));
  const { code, out } = cli(["--dir", dir, "--credential", other]);
  assert.deepEqual([code, out.ok, out.code], [0, true, "resnapshotted"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).credential.sourceFile, other);
});

test("resnapshot: source exactly at the 96 h lead + 6 h margin exits 2 without change; 1 s beyond completes", () => {
  const edge = fixture({ oldExp: NOW + 50 * H, sourceExp: NOW + 102 * H });
  const before = tree(edge.dir);
  const r = cli(["--dir", edge.dir]);
  assert.deepEqual([r.code, r.out.ok, r.out.code], [2, false, "source-in-refresh-lead"]);
  assert.equal(r.out.usableUntil, JSON.parse(readFileSync(join(edge.dir, "manifest.json"), "utf8")).credential.usableUntil, "the unchanged runtime's usableUntil");
  assert.match(r.out.problems[0], /96 h refresh lead \+ 6 h margin/);
  assert.deepEqual(tree(edge.dir), before);
  const over = fixture({ oldExp: NOW + 50 * H, sourceExp: NOW + 102 * H + 1000 });
  const ok = cli(["--dir", over.dir]);
  assert.deepEqual([ok.code, ok.out.ok, ok.out.usableUntil], [0, true, new Date(NOW + 1000).toISOString()]);
});

test("resnapshot: busy runtime (live supervisor, live registered user, held operation lock) exits 3 and changes nothing; a dead user does not block", async () => {
  const { dir } = fixture();
  const before = tree(dir);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ supervisor: process.pid, sandbox: 999999999, startedAt: "x" }));
  let r = cli(["--dir", dir]);
  assert.deepEqual([r.code, r.out.ok, r.out.code], [3, false, "busy"]);
  assert.match(r.out.problems.join(" "), /supervisor \d+ is running/);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ supervisor: 999999999, sandbox: 999999998 }));
  mkdirSync(join(dir, "users"));
  writeFileSync(join(dir, "users", `${process.pid}.json`), JSON.stringify({ pid: process.pid }));
  r = cli(["--dir", dir]);
  assert.deepEqual([r.code, r.out.code], [3, "busy"]);
  assert.match(r.out.problems.join(" "), /runtime user/);
  // A concurrent runtime operation (start or another resnapshot) holds the lock.
  const { rmSync } = await import("node:fs");
  rmSync(join(dir, "users", `${process.pid}.json`));
  const lock = acquireLock(runtimeLockPath(dir));
  try { r = cli(["--dir", dir]); assert.deepEqual([r.code, r.out.code], [3, "busy"]); } finally { lock.release(); }
  const unchanged = tree(dir); delete unchanged["state.json"];
  assert.deepEqual(unchanged, before);
  // A user whose process is gone is not activity.
  const dead = await new Promise(ok => { const c = spawn(process.execPath, ["-e", "0"]); c.on("exit", () => ok(c.pid)); });
  writeFileSync(join(dir, "users", `${dead}.json`), JSON.stringify({ pid: dead }));
  r = cli(["--dir", dir]);
  assert.deepEqual([r.code, r.out.code], [0, "resnapshotted"]);
});

test("resnapshot: another account (vs the snapshot or the manifest), an older source, a malformed source or a broken runtime exit 1 without change or disclosure", () => {
  const mismatch = fixture({ sourceAccount: "acct-2" });
  let before = tree(mismatch.dir);
  let r = cli(["--dir", mismatch.dir]);
  assert.deepEqual([r.code, r.out.ok, r.out.code], [1, false, "account-mismatch"]);
  assert.deepEqual(tree(mismatch.dir), before);
  const manifestOnly = fixture();
  const m = JSON.parse(readFileSync(join(manifestOnly.dir, "manifest.json"), "utf8")); m.credential.accountIdSha256 = "0000000000000000";
  writeFileSync(join(manifestOnly.dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  r = cli(["--dir", manifestOnly.dir]);
  assert.deepEqual([r.code, r.out.code], [1, "account-mismatch"]);
  assert.match(r.out.problems.join(" "), /manifest/);
  const older = fixture({ oldExp: NOW + 300 * H, sourceExp: NOW + 200 * H });
  before = tree(older.dir);
  r = cli(["--dir", older.dir]);
  assert.deepEqual([r.code, r.out.code], [1, "source-older"]);
  assert.deepEqual(tree(older.dir), before);
  const bad = fixture();
  writeFileSync(bad.source, `{"access_token": "${jwt(NOW + 200 * H, "x")}", RTSECRET-broken`);
  before = tree(bad.dir);
  r = cli(["--dir", bad.dir]);
  assert.deepEqual([r.code, r.out.code], [1, "source-invalid"]);
  assert.deepEqual(tree(bad.dir), before);
  const noJwt = fixture();
  writeFileSync(noJwt.source, JSON.stringify({ type: "codex", account_id: "acct-1", access_token: "e30.!!!notbase64json.SIGSECRETz" }));
  r = cli(["--dir", noJwt.dir]);
  assert.deepEqual([r.code, r.out.code], [1, "source-invalid"]);
  r = cli(["--dir", join(bad.root, "nowhere")]);
  assert.deepEqual([r.code, r.out.code, r.out.usableUntil], [1, "runtime-invalid", null]);
  const two = fixture();
  writeFileSync(join(two.dir, "auth", "second.json"), "{}");
  r = cli(["--dir", two.dir]);
  assert.deepEqual([r.code, r.out.code], [1, "runtime-invalid"]);
  const missing = fixture();
  r = cli(["--dir", missing.dir, "--credential", join(missing.root, "absent.json")]);
  assert.deepEqual([r.code, r.out.code], [1, "source-missing"]);
});

test("resnapshot: usage errors are one JSON line with exit 64", () => {
  for (const args of [[], ["--dir"], ["--dir", "/x", "--bogus", "1"], ["--dir", "/x", "extra"]]) {
    const r = cli(args);
    assert.deepEqual([r.code, r.out.ok, r.out.code, r.out.usableUntil], [64, false, "usage", null], JSON.stringify(args));
  }
});

test("resnapshot: a failed manifest write restores the previous snapshot (snapshot and manifest never diverge)", () => {
  const { dir } = fixture();
  const before = tree(dir);
  const r = resnapshotRuntime({ dir, now: NOW, hooks: { beforeManifest: () => { throw new Error("injected"); } } });
  assert.deepEqual([r.exit, r.result.ok, r.result.code], [1, false, "write-failed"]);
  assert.deepEqual(tree(dir), before);
});

test("runtime start and resnapshot are serialized by one operation lock: a start never runs while the lock is held", async () => {
  const { startRuntime } = await import("../studies/confirmatory-1/isolated-runtime.mjs");
  const { dir } = fixture();
  const lock = acquireLock(runtimeLockPath(dir));
  try { await assert.rejects(startRuntime(dir, { timeoutMs: 1000, mode: "test" }), /runtime operation in progress/); } finally { lock.release(); }
  assert.ok(!readdirSync(join(dir, "logs")).includes("supervisor.log"), "no supervisor was spawned");
});
