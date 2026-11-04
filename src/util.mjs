// Small shared helpers: hashing, canonical JSON, atomic files, append-only hash-chained ledgers, process locks.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync, lstatSync, readlinkSync } from "node:fs";
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

/** Exclusive controller lock (one loop per state directory). A lock of a dead process is taken over and reported. */
export function acquireLock(path) {
  ensureDir(dirname(path));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); closeSync(fd);
      let released = false;
      return { stale: attempt > 0, release() { if (released) return; released = true; try { const held = readJson(path); if (held.pid === process.pid) rmSync(path, { force: true }); } catch { /* gone */ } } };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let held; try { held = readJson(path); } catch { held = {}; }
      if (held.pid && alive(held.pid) && held.pid !== process.pid) throw new Error(`state is locked by running process ${held.pid} (${path})`);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`cannot acquire lock ${path}`);
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
