// The CLI's machine contract as a supervisor sees it (real bin/eval-loop.mjs subprocesses, no model: every case ends before a loop
// can evaluate anything, and HOME/agent dir point to an empty directory): outcome line + exit code for state_error, halted, busy,
// usage; --status --summary; signal and exit cleanup of sandbox process groups and route proxies; the reused bwrap isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { bwrapArgs } from "../src/sandbox.mjs";

const CLI = fileURLToPath(new URL("../bin/eval-loop.mjs", import.meta.url));
const SRC = (name) => pathToFileURL(fileURLToPath(new URL(`../src/${name}`, import.meta.url))).href;
const HOLDOUT_USES = fileURLToPath(new URL("../datasets/holdout-v1/USES.jsonl", import.meta.url));
const VALID = { phase: "search", cycle: 1, strategy: "pareto", counters: { candidates: 1, noProgress: 0, consecutiveInfra: 0 }, startedAt: "2026-01-01T00:00:00Z" };

function cli(root, args) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: home, EVAL_LOOP_AGENT_DIR: join(home, "agent") } });
  const last = r.stdout.trim().split("\n").at(-1) ?? "";
  let outcome; try { outcome = JSON.parse(last); } catch { outcome = undefined; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outcome };
}
/** Names, sizes and content hashes of a tree (to show nothing changed). */
function snapshot(dir) {
  const out = {};
  const walk = (d, rel = "") => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name), r = join(rel, e.name); if (e.isDirectory()) walk(p, r); else out[r] = createHash("sha256").update(readFileSync(p)).digest("hex"); } };
  if (existsSync(dir)) walk(dir);
  return out;
}
const hashOf = (path) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
async function gone(pid, ms = 5_000) { const end = Date.now() + ms; while (Date.now() < end) { if (!alive(pid)) return true; await new Promise(r => setTimeout(r, 50)); } return !alive(pid); }

test("--require-state refuses a missing or empty state directory: exit 4, nothing created", () => {
  const root = tempDir();
  try {
    const none = join(root, "none");
    const r = cli(root, ["--resume", "--require-state", "--state", none]);
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.equal(r.outcome.schema, "pi-eval-loop/outcome@1");
    assert.equal(r.outcome.outcome, "state_error");
    assert.equal(r.outcome.exitCode, 4);
    assert.equal(existsSync(none), false, "the directory is not even created");
    mkdirSync(join(root, "empty"));
    assert.equal(cli(root, ["--once", "--require-state", "--state", join(root, "empty")]).status, 4);
    assert.deepEqual(readdirSync(join(root, "empty")), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("records without state.json are a lost state for --once/--resume/--daemon (with or without --require-state): exit 4, untouched, no holdout use", () => {
  const root = tempDir();
  try {
    const dir = join(root, "lost");
    mkdirSync(join(dir, "candidates", "c001"), { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "{\"type\":\"phase\"}\n");
    writeFileSync(join(dir, "protocol.lock.json"), "{}\n");
    writeFileSync(join(dir, "candidates", "c001", "analysis.json"), "{}\n");
    const before = snapshot(dir), uses = hashOf(HOLDOUT_USES);
    for (const args of [["--once"], ["--resume"], ["--daemon", "--max-cycles", "1"], ["--resume", "--require-state"]]) {
      const r = cli(root, [...args, "--state", dir]);
      assert.equal(r.status, 4, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.equal(r.outcome.outcome, "state_error");
      assert.equal(r.outcome.health, "missing");
      assert.deepEqual(snapshot(dir), before, `${args.join(" ")}: state directory unchanged (no state.json, no lock left)`);
    }
    assert.equal(hashOf(HOLDOUT_USES), uses);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrupt or structurally invalid state.json: exit 4 for run modes and --status, file unchanged", () => {
  const root = tempDir();
  try {
    const dir = join(root, "bad");
    mkdirSync(dir);
    for (const text of ["{ not json", JSON.stringify({ phase: "holdout", cycle: 1, counters: {} }), "[]"]) {
      writeFileSync(join(dir, "state.json"), text);
      const r = cli(root, ["--resume", "--state", dir]);
      assert.equal(r.status, 4, r.stdout + r.stderr);
      assert.equal(r.outcome.health, "corrupt");
      assert.equal(readFileSync(join(dir, "state.json"), "utf8"), text);
      const s = cli(root, ["--status", "--summary", "--state", dir]);
      assert.equal(s.status, 4);
      assert.equal(s.outcome.condition, "state_error");
    }
    writeFileSync(join(dir, "state.json"), "{ not json");
    assert.equal(cli(root, ["--status", "--state", dir]).status, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a halted state refuses --resume, --verify-stable and --ablation with exit 3 and no change", () => {
  const root = tempDir();
  try {
    const dir = join(root, "halted");
    mkdirSync(dir);
    const text = JSON.stringify({ ...VALID, halted: "trust boundary breach: orcheStatus", haltedAt: "2026-01-02T00:00:00Z" });
    writeFileSync(join(dir, "state.json"), text);
    for (const args of [["--resume"], ["--once", "--require-state"], ["--verify-stable", "--tasks", root]]) {
      const r = cli(root, [...args, "--state", dir]);
      assert.equal(r.status, 3, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.equal(r.outcome.outcome, "halted");
      assert.equal(r.outcome.status.halted.reason, "trust boundary breach: orcheStatus");
    }
    assert.equal(readFileSync(join(dir, "state.json"), "utf8"), text);
    const abc = join(root, "abc");
    mkdirSync(join(abc, "A"), { recursive: true });
    writeFileSync(join(abc, "A", "state.json"), text);
    const r = cli(root, ["--ablation", "--state", abc]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    const summary = cli(root, ["--status", "--summary", "--state", abc]);
    assert.equal(summary.outcome.layout, "ablation");
    assert.equal(summary.outcome.condition, "halted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a live controller makes the next invocation busy (exit 75); the summary reports the lock without its token", async () => {
  const root = tempDir();
  const dir = join(root, "s");
  mkdirSync(dir);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ ...VALID, phase: "blocked", blocked: { reason: "missing prerequisites", retryable: true, resumePhase: "search", missing: [{ name: "upstream", detail: "http://x" }] } }));
  const owner = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireLock } from ${JSON.stringify(SRC("util.mjs"))}; acquireLock(${JSON.stringify(join(dir, ".lock"))}); console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((ok) => owner.stdout.once("data", ok));
    const lockText = readFileSync(join(dir, ".lock"), "utf8");
    const r = cli(root, ["--resume", "--state", dir]);
    assert.equal(r.status, 75, r.stdout + r.stderr);
    assert.equal(r.outcome.outcome, "busy");
    assert.equal(r.outcome.lock.state, "live");
    assert.equal(r.outcome.lock.owner.pid, owner.pid);
    assert.equal(readFileSync(join(dir, ".lock"), "utf8"), lockText);
    const s = cli(root, ["--status", "--summary", "--state", dir]);
    assert.equal(s.status, 0);
    assert.equal(s.stdout.trim().split("\n").length, 1, "one line of JSON");
    assert.equal(s.outcome.schema, "pi-eval-loop/status@1");
    assert.equal(s.outcome.condition, "blocked");
    assert.equal(s.outcome.resumePhase, "search");
    assert.deepEqual(s.outcome.blocked.missing, ["upstream"]);
    assert.equal(s.outcome.lock.state, "live");
    assert.equal(s.stdout.includes(JSON.parse(lockText).token), false);
    assert.equal(s.stdout.includes("http://x"), false);
  } finally { owner.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
});

test("errors outside the loop still end with an error outcome line; a trajectory of an ablation is refused (exit 64)", () => {
  const root = tempDir();
  try {
    const ro = join(root, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    const r = cli(root, ["--once", "--state", ro]);
    chmodSync(ro, 0o755);
    if (process.getuid?.() !== 0) {
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(r.outcome.outcome, "error");
      assert.equal(r.outcome.error.code, "EACCES");
    }
    const abc = join(root, "abc");
    mkdirSync(join(abc, "A"), { recursive: true });
    writeFileSync(join(abc, "A", "state.json"), JSON.stringify(VALID));
    for (const args of [["--resume", "--state", join(abc, "A")], ["--ablation", "--state", join(abc, "A")], ["--ablation", "--state", join(abc, "B")], ["--once", "--state", join(abc, "C")]]) {
      const t = cli(root, args);
      assert.equal(t.status, 64, `${args.join(" ")}: ${t.stdout}${t.stderr}`);
      assert.match(t.outcome.detail, /trajectory of the ablation/);
    }
    assert.deepEqual(readdirSync(abc).sort(), ["A", "home"].filter(n => existsSync(join(abc, n))).sort(), "no B/C directory or lock created");
    assert.equal(existsSync(join(abc, "A", ".lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a trajectory's --rollback takes the ablation's lock (busy while an ablation runs); the summary shows a stale reclaim guard", async () => {
  const root = tempDir();
  const abc = join(root, "abc");
  mkdirSync(join(abc, "A"), { recursive: true });
  writeFileSync(join(abc, "A", "state.json"), JSON.stringify(VALID));
  const owner = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireLock } from ${JSON.stringify(SRC("util.mjs"))}; acquireLock(${JSON.stringify(join(abc, ".lock"))}); console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((ok, fail) => { owner.stdout.once("data", ok); owner.once("exit", (code) => fail(new Error(`owner exited ${code}`))); });
    const r = cli(root, ["--rollback", "--state", join(abc, "A")]);
    assert.equal(r.status, 75, r.stdout + r.stderr);
    assert.equal(r.outcome.lock.state, "live");
    assert.equal(existsSync(join(abc, "A", ".lock")), false);
    const s = cli(root, ["--status", "--summary", "--state", join(abc, "A")]);
    assert.equal(s.outcome.lock.state, "live", "a trajectory reports the ablation's lock");
    owner.kill("SIGKILL");
    await new Promise((ok) => owner.once("exit", ok));
    writeFileSync(join(abc, ".lock.reclaim"), "");
    const g = cli(root, ["--status", "--summary", "--state", abc]);
    assert.equal(g.outcome.lock.state, "stale");
    assert.equal(g.outcome.lock.guard, "stale-guard");
    const b = cli(root, ["--ablation", "--state", abc]);
    assert.equal(b.status, 75, b.stdout + b.stderr);
    assert.equal(b.outcome.lock.state, "stale-guard");
  } finally { owner.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
});

test("usage errors end with a usage outcome (exit 64) before any lock", () => {
  const root = tempDir();
  try {
    const r = cli(root, ["--daemon", "--max-cycles", "0", "--state", join(root, "s")]);
    assert.equal(r.status, 64);
    assert.equal(r.outcome.outcome, "usage");
    assert.equal(existsSync(join(root, "s")), false);
    assert.equal(cli(root, ["--resume", "--bogus"]).status, 64);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A controller stand-in using the CLI's real cleanup with a real route proxy and a sandbox-like detached process group. */
function controller(dir, mode) {
  const script = join(dir, "controller.mjs");
  writeFileSync(script, `
import { spawn } from "node:child_process";
import { installCleanup } from ${JSON.stringify(SRC("cli.mjs"))};
import { startModelPath, stopProxies } from ${JSON.stringify(SRC("sandbox.mjs"))};
import { acquireLock, atomicWriteJson, readJson } from ${JSON.stringify(SRC("util.mjs"))};
const dir = ${JSON.stringify(dir)};
const lock = acquireLock(dir + "/.lock");
const loop = { stopping: false, state: readJson(dir + "/state.json"), save() { atomicWriteJson(dir + "/state.json", this.state); } };
const pids = new Set();
const group = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
pids.add(group.pid);
// Relative model dir (cwd = state dir): unix socket paths must stay short whatever the temp root is.
const model = await startModelPath({ dir: "model", route: { model: "m", effort: "low" }, maxRequests: 1, upstream: "http://127.0.0.1:9", agentDir: dir, keyOverride: "k" });
installCleanup({ stateDir: dir, getLoop: () => loop, pids, lock, stopProxies: () => stopProxies() });
console.log(JSON.stringify({ group: group.pid, proxy: model.pid }));
if (${JSON.stringify(mode)} === "exit") process.exit(0);
if (${JSON.stringify(mode)} === "throw") setTimeout(() => { throw new Error("boom outside main"); }, 50);
setInterval(() => {}, 1000);
`);
  writeFileSync(join(dir, "state.json"), JSON.stringify(VALID));
  const proc = spawn(process.execPath, [script], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  proc.stdout.on("data", c => { out += c; });
  const exit = new Promise((ok) => proc.once("exit", (code, signal) => ok({ code, signal })));
  // Fails (never hangs) when the controller dies before reporting its children.
  const first = new Promise((ok, fail) => {
    const t = setInterval(() => { if (out.includes("\n")) { clearInterval(t); ok(JSON.parse(out.split("\n")[0])); } }, 20);
    exit.then(({ code }) => { setTimeout(() => { clearInterval(t); fail(new Error(`controller exited ${code} before reporting: ${out}`)); }, 100); });
  });
  return { proc, first, exit, output: () => out };
}

test("SIGTERM to the controller pid alone: process groups and route proxy are killed, lastInterruption recorded, outcome interrupted, exit 130, lock released", async () => {
  const root = tempDir();
  try {
    const c = controller(root, "wait");
    const { group, proxy } = await c.first;
    assert.ok(alive(group) && alive(proxy));
    c.proc.kill("SIGTERM");
    const { code } = await c.exit;
    assert.equal(code, 130);
    const outcome = JSON.parse(c.output().trim().split("\n").at(-1));
    assert.equal(outcome.outcome, "interrupted");
    assert.equal(outcome.signal, "SIGTERM");
    assert.equal(outcome.exitCode, 130);
    assert.ok(await gone(group), "sandbox process group killed");
    assert.ok(await gone(proxy), "route proxy (controller's process group) not left behind");
    assert.equal(existsSync(join(root, ".lock")), false);
    const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    assert.equal(state.lastInterruption.signal, "SIGTERM");
    assert.equal(state.interrupted, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an ordinary exit runs the same cleanup (no proxy or group survives a graceful exit path)", async () => {
  const root = tempDir();
  try {
    const c = controller(root, "exit");
    const { group, proxy } = await c.first;
    assert.equal((await c.exit).code, 0);
    assert.ok(await gone(group));
    assert.ok(await gone(proxy));
    assert.equal(existsSync(join(root, ".lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an exception outside the main promise chain ends with the error outcome after the same cleanup (exit 1)", async () => {
  const root = tempDir();
  try {
    const c = controller(root, "throw");
    const { group, proxy } = await c.first;
    assert.equal((await c.exit).code, 1);
    const outcome = JSON.parse(c.output().trim().split("\n").at(-1));
    assert.equal(outcome.outcome, "error");
    assert.ok(await gone(group));
    assert.ok(await gone(proxy));
    assert.equal(existsSync(join(root, ".lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reused sandbox isolation keeps --die-with-parent, its own session and pid namespace (no extra SIGKILL hook needed for sandboxes)", () => {
  const args = bwrapArgs({ binds: [], env: { PATH: "/usr/bin:/bin" }, cwd: "/", command: ["/bin/true"] });
  for (const flag of ["--die-with-parent", "--new-session", "--unshare-pid"]) assert.ok(args.includes(flag), flag);
  assert.ok(statSync(CLI).isFile());
});
