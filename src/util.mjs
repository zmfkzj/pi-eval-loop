// Small shared helpers: hashing, canonical JSON, atomic files, append-only hash-chained ledgers, process locks.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync, lstatSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** JSON with sorted object keys (stable digests regardless of insertion order). */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export const digestOf = (value) => sha256(canonical(value));

export function ensureDir(path, mode = 0o700) { mkdirSync(path, { recursive: true, mode }); return path; }

/** Write a file atomically: temp file in the same directory, fsync, rename. */
export function atomicWrite(path, data, mode = 0o600) {
  ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(temp, "w", mode);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export const atomicWriteJson = (path, value) => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { if (fallback !== undefined && (error.code === "ENOENT")) return fallback; throw error; }
}

/** Append-only JSONL ledger; every record carries the hash of the previous one (deletion/edits are detectable). */
export class Ledger {
  constructor(path) { this.path = path; ensureDir(dirname(path)); }
  records() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`${this.path}: corrupt line ${index + 1}`); }
    });
  }
  lastHash() { const all = this.records(); return all.length ? all.at(-1).hash : "genesis"; }
  append(record) {
    const prev = this.lastHash();
    const body = { ...record, seq: this.records().length, at: record.at ?? new Date().toISOString(), prev };
    const entry = { ...body, hash: digestOf(body) };
    const fd = openSync(this.path, "a", 0o600);
    try { writeSync(fd, `${JSON.stringify(entry)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    return entry;
  }
  /** Verify the chain; returns problems (empty = intact). */
  verify() {
    const problems = [];
    let prev = "genesis";
    this.records().forEach((entry, index) => {
      const { hash, ...body } = entry;
      if (entry.seq !== index) problems.push(`record ${index}: seq ${entry.seq}`);
      if (entry.prev !== prev) problems.push(`record ${index}: chain broken`);
      if (digestOf(body) !== hash) problems.push(`record ${index}: hash mismatch (edited)`);
      prev = hash;
    });
    return problems;
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** Boot identity of this host (Linux /proc); undefined where unavailable. */
export function bootId() { try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined; } catch { return undefined; } }
/** PID-namespace identity of this process (readlink /proc/self/ns/pid); undefined where unavailable. */
export function pidNamespace() { try { return readlinkSync("/proc/self/ns/pid"); } catch { return undefined; } }
/** Start time of a process (clock ticks since boot, /proc/<pid>/stat field 22); undefined when it cannot be read. */
export function processStart(pid) {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined; } catch { return undefined; }
}
const readRaw = (path) => { try { return readFileSync(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } };
const parseLock = (raw) => { try { return JSON.parse(raw); } catch { return undefined; } };
/** Lock owner fields safe to print (the ownership token stays in the file). */
export const lockOwner = (held) => held && typeof held === "object" ? { pid: held.pid, host: held.host, startTime: held.startTime, at: held.at } : undefined;

/** Contention for the controller lock: a live, foreign-host, unverifiable or concurrently changing owner. */
export class LockBusyError extends Error {
  /** @param {string} path @param {{ state: string, why: string }} verdict @param {any} owner */
  constructor(path, verdict, owner) {
    super(`state is locked (${verdict.state}: ${verdict.why}) (${path})`);
    this.code = "ELOCKBUSY"; this.path = path; this.verdict = verdict; this.owner = owner;
  }
}

/**
 * Classify a lock record. Only "stale" may be reclaimed: same host and either an earlier boot, or - in the same PID namespace - a
 * pid that no longer runs or whose start time differs from the recorded one (reused pid). A running pid whose start time cannot
 * be compared, a record of another PID namespace (container, bwrap --unshare-pid: its pid means nothing here), a record without
 * host or namespace identity (older format) and a record of another host are never reclaimed.
 * @returns {{ state: "live" | "stale" | "foreign-host" | "unverifiable", why: string }}
 */
export function classifyLock(held, { host = hostname(), boot = bootId(), pidNs = pidNamespace() } = {}) {
  if (!held || typeof held !== "object" || !Number.isInteger(held.pid) || held.pid <= 0) return { state: "unverifiable", why: "unreadable or incomplete lock record" };
  if (!held.host) return { state: "unverifiable", why: `lock record of pid ${held.pid} has no host identity (older format)` };
  if (held.host !== host) return { state: "foreign-host", why: `held by pid ${held.pid} on host ${held.host}` };
  if (held.bootId && boot && held.bootId !== boot) return { state: "stale", why: `pid ${held.pid} ran before the last reboot` };
  if (!held.pidNs || !pidNs) return { state: "unverifiable", why: `the PID namespace of pid ${held.pid} cannot be compared` };
  if (held.pidNs !== pidNs) return { state: "unverifiable", why: `pid ${held.pid} belongs to another PID namespace (${held.pidNs})` };
  if (!alive(held.pid)) return { state: "stale", why: `pid ${held.pid} is not running` };
  const start = processStart(held.pid);
  if (!held.startTime || !start) return { state: "unverifiable", why: `pid ${held.pid} is running and its start time cannot be compared` };
  if (start !== held.startTime) return { state: "stale", why: `pid ${held.pid} now belongs to another process (start time differs)` };
  return { state: "live", why: `pid ${held.pid} is running` };
}

/**
 * Read-only view of a lock file.
 * @returns {{ present: boolean, owner?: ReturnType<typeof lockOwner>, state?: string, why?: string }}
 */
export function inspectLock(path) {
  const raw = readRaw(path);
  if (raw === undefined) return { present: false };
  const held = parseLock(raw);
  return { present: true, owner: lockOwner(held), ...classifyLock(held) };
}

/**
 * A reclaim guard is written complete (link of a written file) and held for a few synchronous steps: a guard whose record is
 * unreadable or whose owner provably no longer runs is "stale-guard" (left by a recoverer that died; needs an operator);
 * otherwise "held".
 */
export function classifyGuard(g) {
  if (!g || typeof g !== "object" || !Number.isInteger(g.pid)) return { state: "stale-guard", why: "is unreadable" };
  const verdict = classifyLock(g);
  return verdict.state === "stale" ? { state: "stale-guard", why: `was left by a recoverer that is not running (${verdict.why})` } : { state: "held", why: verdict.why };
}
/** Read-only view of the reclaim guard of a lock: { present: false } or { present: true, state: "stale-guard" | "held", why }. */
export function inspectGuard(path) {
  const raw = readRaw(`${path}.reclaim`);
  return raw === undefined ? { present: false } : { present: true, ...classifyGuard(parseLock(raw)) };
}

/**
 * Exclusive controller lock (one loop per state directory). The record (pid, host, boot id, PID namespace, process start time,
 * token) is created atomically with its content (hard link of a written temp file; fails when a lock exists). Removal invariant:
 * the lock file is removed only (a) by its owner, while it still carries the owner's token, or (b) by a recoverer that holds the
 * reclaim guard `<lock>.reclaim` (also created by an exclusive link) and has re-read, under the guard, the same stale record it
 * classified. A new owner can only create the lock while no file exists, so a recoverer never removes a newly acquired lock.
 * Anything but a stale record (see classifyLock) or a record that changed throws LockBusyError; a held guard is "contended", a
 * guard left by a recoverer that died within its few synchronous steps is "stale-guard" (never removed automatically, since
 * removing it could break the guard's exclusivity; an operator removes it after checking that no controller runs).
 * @param {string} path
 * @param {{ beforeReclaim?: () => void, afterGuardBusy?: () => void }} [hooks] test hooks: after a record was judged stale, before
 *   the guard is taken; after the guard link failed (EEXIST), before the guard is read (a guard removed in between is a released
 *   guard: retry)
 */
export function acquireLock(path, { beforeReclaim, afterGuardBusy } = {}) {
  ensureDir(dirname(path));
  const record = { pid: process.pid, host: hostname(), bootId: bootId(), pidNs: pidNamespace(), startTime: processStart(process.pid), token: randomBytes(12).toString("hex"), at: new Date().toISOString() };
  const temp = `${path}.new-${record.token}`, guard = `${path}.reclaim`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
  const mine = (file) => parseLock(readRaw(file) ?? "")?.token === record.token;
  /** @type {any[]} */ const recovered = [];
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { linkSync(temp, path); } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const raw = readRaw(path);
        if (raw === undefined) continue;
        const held = parseLock(raw);
        const verdict = classifyLock(held);
        if (verdict.state !== "stale") throw new LockBusyError(path, verdict, lockOwner(held));
        beforeReclaim?.();
        try { linkSync(temp, guard); } catch (guardError) {
          if (guardError.code !== "EEXIST") throw guardError;
          afterGuardBusy?.();
          const guardRaw = readRaw(guard);
          // The guard holder finished (and removed it) between our failed link and this read: the guard was live, not stale.
          // Start over (the lock is re-read and re-classified); never report a guard that no longer exists as stale-guard.
          if (guardRaw === undefined) continue;
          const g = parseLock(guardRaw);
          const guardState = classifyGuard(g);
          if (guardState.state === "stale-guard") throw new LockBusyError(path, { state: "stale-guard", why: `the reclaim guard ${guard} ${guardState.why}: remove it after checking that no controller runs` }, lockOwner(g));
          throw new LockBusyError(path, { state: "contended", why: `another process holds the reclaim guard ${guard}` }, lockOwner(g));
        }
        try {
          const now = readRaw(path);
          if (now !== undefined && now !== raw) throw new LockBusyError(path, { state: "contended", why: "the lock changed while a stale record was being recovered" }, lockOwner(parseLock(now)));
          if (now !== undefined) unlinkSync(path);
        } finally { if (mine(guard)) unlinkSync(guard); }
        recovered.push({ ...lockOwner(held), why: verdict.why });
        continue;
      }
      let released = false;
      return {
        stale: recovered.length > 0, recovered, owner: lockOwner(record),
        release() { if (released) return; released = true; try { if (mine(path)) unlinkSync(path); } catch { /* gone */ } },
      };
    }
    throw new LockBusyError(path, { state: "contended", why: "the lock kept changing" }, undefined);
  } finally { rmSync(temp, { force: true }); }
}

/** Files of a tree (relative paths), skipping the named directory components; symlinks are reported, never followed. */
export function walkFiles(root, { skip = [".git", "node_modules"] } = {}) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (skip.includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) out.push({ path: relative(root, path), symlink: readlinkSync(path) });
      else if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) out.push({ path: relative(root, path), size: statSync(path).size });
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

/** Content digest of a tree (path, symlink target or content hash). */
export function treeDigest(root, options) {
  return sha256(walkFiles(root, options).map(file => file.symlink !== undefined ? `l ${file.path} ${file.symlink}` : `f ${file.path} ${sha256(readFileSync(join(root, file.path)))}`).join("\n"));
}

/** Map of relative path -> text for a tree (tests and integrity diffs). */
export function textMap(root, options) {
  const map = new Map();
  for (const file of walkFiles(root, options)) if (file.symlink === undefined && file.size <= 2 * 1024 * 1024) map.set(file.path, readFileSync(join(root, file.path), "utf8"));
  return map;
}

export const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  return out;
}

/**
 * Fault injection for crash tests (2026-11-07): when EVAL_LOOP_FAULT names this point, the process is killed with SIGKILL right
 * here (no finally, no cleanup, lock files stay behind) -- the interruption a power loss or OOM kill would cause. A no-op otherwise.
 * @param {string} name
 */
export function fault(name) {
  if (process.env.EVAL_LOOP_FAULT === name) process.kill(process.pid, "SIGKILL");
}
