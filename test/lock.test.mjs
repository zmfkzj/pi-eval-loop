// Controller lock: identity (host, boot, pid start time, token), stale recovery only for verified-dead or reused pids, guard-
// serialized recovery (a recoverer never removes a newly acquired lock), contention as LockBusyError, owner-checked release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { acquireLock, bootId, classifyLock, inspectLock, LockBusyError, pidNamespace, processStart } from "../src/util.mjs";

const UTIL = pathToFileURL(new URL("../src/util.mjs", import.meta.url).pathname).href;
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const record = (over = {}) => JSON.stringify({ pid: deadPid(), host: hostname(), bootId: bootId(), pidNs: pidNamespace(), startTime: "1", token: "old", at: "2026-01-01T00:00:00Z", ...over });
const busy = (fn, state) => assert.throws(fn, (error) => error instanceof LockBusyError && error.verdict.state === state, `expected busy (${state})`);

/** A node child that runs `body` (ES module; `acquireLock` imported) and reports lines on stdout. */
function child(body) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireLock } from ${JSON.stringify(UTIL)};\n${body}`], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  const lines = [];
  const waiters = [];
  proc.stdout.on("data", (chunk) => { out += chunk; let i; while ((i = out.indexOf("\n")) >= 0) { lines.push(out.slice(0, i)); out = out.slice(i + 1); waiters.splice(0).forEach(w => w()); } });
  const next = () => new Promise((ok) => { if (lines.length) ok(lines.shift()); else waiters.push(() => ok(lines.shift())); });
  // "close" (stdout drained and process gone), not "exit": a line still in the pipe is never lost, and a child that dies without
  // reporting resolves its waiters with "exit:<code>" instead of hanging the test.
  const exited = new Promise((ok) => proc.once("close", (code) => { lines.push(`exit:${code}`); waiters.splice(0).forEach(w => w()); ok(code); }));
  return { proc, next, exited };
}

test("a dead owner's lock is recovered; the new record carries host, boot id, start time and token", () => {
  const dir = tempDir();
  try {
    const path = join(dir, ".lock");
    writeFileSync(path, record());
    const lock = acquireLock(path);
    assert.equal(lock.stale, true);
    assert.match(lock.recovered[0].why, /is not running/);
    const held = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(held.pid, process.pid);
    assert.equal(held.host, hostname());
    assert.equal(held.startTime, processStart(process.pid));
    assert.ok(held.token && held.token !== "old");
    assert.equal(inspectLock(path).state, "live");
    lock.release();
    assert.equal(existsSync(path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a reused pid (running process, different start time) and an earlier boot are stale; a running pid with unknown start time is not", () => {
  const dir = tempDir();
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const path = join(dir, ".lock");
    writeFileSync(path, record({ pid: sleeper.pid, startTime: "1" }));
    assert.equal(classifyLock(JSON.parse(readFileSync(path, "utf8"))).state, "stale");
    const lock = acquireLock(path);
    assert.match(lock.recovered[0].why, /start time differs/);
    lock.release();
    writeFileSync(path, record({ pid: sleeper.pid, startTime: processStart(sleeper.pid), bootId: "an-earlier-boot" }));
    if (bootId()) { const l = acquireLock(path); assert.match(l.recovered[0].why, /before the last reboot/); l.release(); }
    const unknownStart = record({ pid: sleeper.pid, startTime: undefined });
    writeFileSync(path, unknownStart);
    busy(() => acquireLock(path), "unverifiable");
    assert.equal(readFileSync(path, "utf8"), unknownStart, "never reclaimed on pid liveness alone");
  } finally { sleeper.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("a live owner (another process) and this same process are busy; after the owner dies its lock is recovered", async () => {
  const dir = tempDir();
  const path = join(dir, ".lock");
  const owner = child(`acquireLock(${JSON.stringify(path)}); console.log("ready"); setInterval(() => {}, 1000);`);
  try {
    assert.equal(await owner.next(), "ready");
    const before = readFileSync(path, "utf8");
    busy(() => acquireLock(path), "live");
    assert.equal(readFileSync(path, "utf8"), before);
    owner.proc.kill("SIGKILL");
    await owner.exited;
    const mine = acquireLock(path);
    assert.equal(mine.stale, true);
    busy(() => acquireLock(path), "live"); // the same pid is no permission to take the lock again
    mine.release();
  } finally { owner.proc.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("foreign-host, other-PID-namespace, older-format (no host/namespace) and unreadable records are never reclaimed", () => {
  const dir = tempDir();
  try {
    const path = join(dir, ".lock");
    for (const [text, state] of [[record({ host: "elsewhere.example" }), "foreign-host"], [record({ pidNs: "pid:[1]" }), "unverifiable"], [record({ pidNs: undefined }), "unverifiable"], [JSON.stringify({ pid: deadPid(), at: "x" }), "unverifiable"], ["", "unverifiable"], ["{garbage", "unverifiable"]]) {
      writeFileSync(path, text);
      busy(() => acquireLock(path), state);
      assert.equal(readFileSync(path, "utf8"), text);
      assert.equal(inspectLock(path).state, state);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("guard-serialized recovery: a recoverer that judged a record stale never removes a lock acquired in the meantime", () => {
  const dir = tempDir();
  try {
    const path = join(dir, ".lock");
    // (1) Another recoverer wins between the stale judgement and the guard.
    writeFileSync(path, record());
    /** @type {any} */ let winner, winnerText;
    busy(() => acquireLock(path, { beforeReclaim: () => { winner = acquireLock(path); winnerText = readFileSync(path, "utf8"); } }), "contended");
    assert.equal(readFileSync(path, "utf8"), winnerText, "the winner's lock is untouched");
    assert.equal(existsSync(`${path}.reclaim`), false);
    winner.release();
    // (2) The stale record disappears and a brand-new owner acquires normally before the guard is taken.
    writeFileSync(path, record());
    /** @type {any} */ let fresh, freshText;
    busy(() => acquireLock(path, { beforeReclaim: () => { unlinkSync(path); fresh = acquireLock(path); freshText = readFileSync(path, "utf8"); } }), "contended");
    assert.equal(readFileSync(path, "utf8"), freshText);
    fresh.release();
    // (3) A held reclaim guard: busy, the stale record stays for its holder.
    const stale = record();
    writeFileSync(path, stale);
    writeFileSync(`${path}.reclaim`, JSON.stringify({ pid: process.pid, host: hostname(), bootId: bootId(), pidNs: pidNamespace(), startTime: processStart(process.pid), token: "guard" }));
    busy(() => acquireLock(path), "contended");
    assert.equal(readFileSync(path, "utf8"), stale);
    // (4) A guard left by a dead recoverer: a distinct, documented busy state; neither the guard nor the record is removed.
    const leftover = record({ token: "dead-guard" });
    writeFileSync(`${path}.reclaim`, leftover);
    busy(() => acquireLock(path), "stale-guard");
    assert.equal(readFileSync(`${path}.reclaim`, "utf8"), leftover);
    assert.equal(readFileSync(path, "utf8"), stale);
    // (5) Regression (seen 2026-11-08 under a loaded parallel suite as "busy:stale-guard" in the competing-acquisition test): a live
    // recoverer's guard that is released between our failed guard link and our read of it is NOT a stale guard; the acquisition
    // starts over and recovers. (Same fix as the agent_workflow clone, 2026-11-06.)
    writeFileSync(`${path}.reclaim`, JSON.stringify({ pid: process.pid, host: hostname(), bootId: bootId(), pidNs: pidNamespace(), startTime: processStart(process.pid), token: "live-guard" }));
    let removed = 0;
    const won = acquireLock(path, { afterGuardBusy: () => { removed++; unlinkSync(`${path}.reclaim`); } });
    assert.equal(removed, 1);
    assert.equal(won.stale, true, "the stale record was recovered after the retry");
    assert.equal(existsSync(`${path}.reclaim`), false);
    won.release();
    assert.equal(existsSync(path), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release is owner-checked: a replaced lock file is not removed by the previous owner", () => {
  const dir = tempDir();
  try {
    const path = join(dir, ".lock");
    const lock = acquireLock(path);
    const other = record({ token: "someone-else" });
    writeFileSync(path, other);
    lock.release();
    assert.equal(readFileSync(path, "utf8"), other);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("competing acquisitions (fresh and over a stale record): exactly one process wins", async () => {
  // The winner holds the lock until every competitor has reported (the parent writes `done`), not for a fixed time: under load a
  // late competitor must still meet the live lock, so a second "ok" can only come from a real mutual-exclusion failure.
  for (const startStale of [false, true]) {
    const dir = tempDir();
    try {
      const path = join(dir, ".lock"), go = join(dir, "go"), done = join(dir, "done");
      if (startStale) writeFileSync(path, record());
      const body = `import { existsSync } from "node:fs";
console.log("ready");
while (!existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 2));
try { const lock = acquireLock(${JSON.stringify(path)}); console.log("ok"); while (!existsSync(${JSON.stringify(done)})) await new Promise(r => setTimeout(r, 5)); lock.release(); } catch (e) { console.log("busy:" + (e.verdict?.state ?? e.message)); }`;
      const kids = Array.from({ length: 6 }, () => child(body));
      // Parent-side bound (no fixed hold time in the children): a stuck run fails here, and every child is killed and reaped.
      const within = (promise, what) => Promise.race([promise, new Promise((_, fail) => setTimeout(() => fail(new Error(`timed out waiting for ${what}`)), 60_000).unref())]);
      let outcomes = [];
      try {
        for (const k of kids) assert.equal(await within(k.next(), "ready"), "ready");
        writeFileSync(go, "");
        outcomes = await within(Promise.all(kids.map(k => k.next())), "outcomes");
        writeFileSync(done, "");
        await within(Promise.all(kids.map(k => k.exited)), "children to exit");
      } finally {
        writeFileSync(done, "");
        for (const k of kids) if (k.proc.exitCode === null && k.proc.signalCode === null) k.proc.kill("SIGKILL");
        await Promise.all(kids.map(k => k.exited));
      }
      assert.equal(outcomes.filter(o => o === "ok").length, 1, `${startStale ? "stale" : "fresh"}: ${outcomes.join(", ")}`);
      assert.ok(outcomes.every(o => o === "ok" || /^busy:(live|contended)$/.test(o)), outcomes.join(", "));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

const bwrap = spawnSync("bwrap", ["--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "/bin/true"]).status === 0;
test("a live owner in another PID namespace on the same host (bwrap --unshare-pid) is never taken over", { skip: !bwrap && "bwrap with pid namespaces unavailable" }, async () => {
  const dir = tempDir();
  const path = join(dir, ".lock");
  const holder = spawn("bwrap", ["--die-with-parent", "--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", process.execPath, "--input-type=module", "-e", `import { acquireLock } from ${JSON.stringify(UTIL)}; acquireLock(${JSON.stringify(path)}); console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((ok, fail) => { holder.stdout.once("data", ok); holder.once("exit", (code) => fail(new Error(`holder exited ${code}`))); });
    const text = readFileSync(path, "utf8");
    assert.notEqual(JSON.parse(text).pidNs, pidNamespace());
    busy(() => acquireLock(path), "unverifiable");
    assert.equal(readFileSync(path, "utf8"), text);
  } finally { holder.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});
