#!/usr/bin/env node
// ctrl-confirm-4 frozen runtime (A3, 2026-11-08; launch-bound). Every attempt executes code loaded FROM DISK: node, the pi CLI and
// its packages, the cliproxyapi provider extension, the orche harness's node_modules and the model catalog copied into the agent dir.
// The shared copies of these are mutated by host maintenance (aw-maint-pi-migration reinstalled umbrella node_modules at
// 2026-11-08T04:06:37Z, between the preflight and the lock). This module makes the campaign's runtime a private, read-only snapshot
// and verifies it:
//   - snapshot: copy the runtime closure into results/ctrl-confirm-4-runtime/<id>/, write MANIFEST.json (sha256 of every file, symlink
//     target, mode), make everything read-only, write FINGERPRINT.json (lstat fingerprint after sealing);
//   - RuntimeGuard.start(): FULL content verification against the manifest bound by the state's continuation, read-only modes, no
//     symlink escaping the snapshot, and every runtime path of the host environment inside the snapshot;
//   - RuntimeGuard.check(): before EVERY dispatch and after every attempt (before its result is recorded): lstat fingerprint of the
//     snapshot and the state's harness trees + sha256 of the reused evaluator files (proxy, bridge, sandbox.ts, protocol.ts).
//     Any difference fails closed (held "runtime" pause; a mid-unit difference is recorded with the attempt, never dropped).
//   - continuation.json: versioned, hash-chained post-launch bindings of a launched state. The original lock.json is never changed.
//     A continuation may only re-bind the environment digest, the launch-bound file digests and the runtime snapshot; the
//     preregistration, queue, tasks, instructions, grading, harness trees and holdout seals must equal the ORIGINAL lock.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/runtime.mjs snapshot --dest DIR
//   node pi-eval-loop/experiments/ctrl-confirm-4/runtime.mjs verify --root DIR
//   EVAL_LOOP_* (see envFor) node <root>/node/bin/node .../runtime.mjs continue --state DIR --reason TEXT [--evidence FILE ...]
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { atomicWriteJson, digestOf, sha256 } from "../../src/util.mjs";

export const LAYOUT = { node: "node", piModules: "bun-global/node_modules", provider: "provider", orcheModules: "orche-node_modules", catalog: "catalog" };
const TOP_FILES = new Set(["MANIFEST.json", "FINGERPRINT.json"]);

/** Every entry under root (sorted, relative), never following symlinks; top-level MANIFEST/FINGERPRINT excluded. */
export function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = relative(root, path);
      if (TOP_FILES.has(rel)) continue;
      const st = lstatSync(path);
      out.push({ rel, path, st });
      if (st.isDirectory()) visit(path);
    }
  };
  visit(root);
  return out;
}

const kind = (st) => (st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isFile() ? "f" : "x");

/** Content manifest: path, kind, permission bits, size, sha256 (files) or target (symlinks). */
export function manifestOf(root) {
  const entries = walk(root).map(({ rel, path, st }) => {
    const k = kind(st);
    if (k === "x") throw new Error(`unsupported file type in the runtime snapshot: ${rel}`);
    return k === "f" ? [rel, k, st.mode & 0o7777, st.size, sha256(readFileSync(path))] : k === "l" ? [rel, k, 0, 0, readlinkSync(path)] : [rel, k, st.mode & 0o7777, 0, ""];
  });
  return { entries, digest: digestOf(entries.map(e => [e[0], e[1], e[3], e[4]])) };
}

/** Fast identity: lstat of every entry (kind, mode, size, mtime, ctime, inode). Any write, chmod or replacement changes it. */
export function fingerprintOf(root) {
  return digestOf(walk(root).map(({ rel, st }) => [rel, kind(st), st.mode, st.size, Number(st.mtimeMs), Number(st.ctimeMs), st.ino]));
}

/** Problems of the symlinks of a snapshot: every target must resolve inside the snapshot (dangling links are allowed if relative and inside). */
export function linkEscapes(root) {
  const out = [];
  for (const { rel, path, st } of walk(root)) {
    if (!st.isSymbolicLink()) continue;
    const target = readlinkSync(path);
    const abs = resolve(dirname(path), target);
    if (target.startsWith("/") || !(abs === root || abs.startsWith(root + sep))) out.push(`${rel} -> ${target}`);
  }
  return out;
}

/** Host sources of the runtime closure (defaults = the shared host locations this campaign was locked with). */
export function hostSources() {
  const node = resolve(process.execPath, "../..");
  return {
    node, piModules: join(homedir(), ".bun/install/global/node_modules"),
    provider: join(resolve(dirname(new URL(import.meta.url).pathname), "../../.."), "cliproxyapi/node_modules/@router-for-me/pi-cliproxyapi-provider"),
    orcheModules: join(resolve(dirname(new URL(import.meta.url).pathname), "../../.."), "orche/node_modules"),
    catalog: [join(homedir(), ".pi/agent/cliproxyapi-models.json"), join(homedir(), ".pi/agent/models.json")],
  };
}

/** Environment variables that point the runner and every attempt at a snapshot (no credential is part of a snapshot). Inside a
 * sandbox the node and pi trees are mounted at the host locations they were copied from (same paths in the agent's prompt). */
export function envFor(root) {
  const sources = (() => { try { return JSON.parse(readFileSync(join(root, "MANIFEST.json"), "utf8")).sources ?? {}; } catch { return {}; } })();
  return {
    ...(sources.node ? { EVAL_LOOP_BOX_NODE_DIR: sources.node } : {}),
    ...(sources.piModules ? { EVAL_LOOP_BOX_PI_MODULES: sources.piModules } : {}),
    EVAL_LOOP_RUNTIME: root,
    EVAL_LOOP_PI_CLI: join(root, LAYOUT.piModules, "@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    EVAL_LOOP_PROVIDER: join(root, LAYOUT.provider),
    EVAL_LOOP_ORCHE_MODULES: join(root, LAYOUT.orcheModules),
    EVAL_LOOP_CATALOG_DIR: join(root, LAYOUT.catalog),
  };
}

/** Build a snapshot: copy, manifest, read-only, fingerprint. Refuses an existing destination. */
export function buildSnapshot(dest, sources = hostSources()) {
  if (existsSync(dest)) throw new Error(`snapshot destination exists: ${dest}`);
  execFileSync("mkdir", ["-p", "-m", "0700", dest]);
  const cp = (from, to) => { execFileSync("mkdir", ["-p", dirname(join(dest, to))]); execFileSync("cp", ["-a", "--no-preserve=ownership", from, join(dest, to)]); };
  cp(sources.node, LAYOUT.node);
  cp(sources.piModules, LAYOUT.piModules);
  cp(sources.provider, LAYOUT.provider);
  cp(sources.orcheModules, LAYOUT.orcheModules);
  for (const cache of [".vite", ".vite-temp"]) execFileSync("rm", ["-rf", join(dest, LAYOUT.orcheModules, cache)]); // host test caches, never loaded by an attempt
  execFileSync("mkdir", ["-p", join(dest, LAYOUT.catalog)]);
  for (const f of sources.catalog) if (existsSync(f)) execFileSync("cp", ["-p", f, join(dest, LAYOUT.catalog)]);
  const escapes = linkEscapes(dest);
  if (escapes.length) throw new Error(`symlinks escape the snapshot: ${escapes.slice(0, 5).join(", ")}`);
  execFileSync("chmod", ["-R", "a-w", dest]);
  execFileSync("chmod", ["u+w", dest]);
  const m = manifestOf(dest);
  const facts = { at: new Date().toISOString(), sources: { ...sources }, layout: LAYOUT, entries: m.entries.length, digest: m.digest };
  writeFileSync(join(dest, "MANIFEST.json"), `${JSON.stringify({ ...facts, list: m.entries })}\n`, { mode: 0o444 });
  writeFileSync(join(dest, "FINGERPRINT.json"), `${JSON.stringify({ at: new Date().toISOString(), digest: fingerprintOf(dest) })}\n`, { mode: 0o444 });
  chmodSync(dest, 0o555);
  return { root: dest, manifestDigest: m.digest, entries: m.entries.length };
}

/** Runtime paths of a host environment that must lie inside the snapshot root (+ in-box locations = the copied host locations). */
export function envProblems(env, root, sources = null) {
  const want = {
    nodeDir: join(root, LAYOUT.node), piModules: join(root, LAYOUT.piModules), provider: join(root, LAYOUT.provider),
    orcheModules: join(root, LAYOUT.orcheModules), catalogDir: join(root, LAYOUT.catalog),
  };
  const out = Object.entries(want).filter(([k, v]) => resolve(env[k] ?? "") !== v).map(([k, v]) => `${k} is ${env[k]}, not ${v}`);
  if (!resolve(env.piCli ?? "").startsWith(want.piModules + sep)) out.push(`piCli ${env.piCli} is outside the snapshot`);
  if (sources) {
    if ((env.boxNodeDir ?? env.nodeDir) !== sources.node) out.push(`in-box node dir ${env.boxNodeDir} is not the original ${sources.node}`);
    if ((env.boxPiModules ?? env.piModules) !== sources.piModules) out.push(`in-box pi modules ${env.boxPiModules} are not the original ${sources.piModules}`);
  }
  return out;
}

/** Per-dispatch identity guard of a snapshot + extra trees (harness) + extra files (evaluator files outside src/). */
export class RuntimeGuard {
  /** @param {{ root: string, manifestDigest?: string, extraFiles?: string[] }} o */
  constructor({ root, manifestDigest, extraFiles = [] }) {
    this.root = resolve(root);
    const manifest = JSON.parse(readFileSync(join(this.root, "MANIFEST.json"), "utf8"));
    /** @type {string} */ this.manifestDigest = manifest.digest;
    /** @type {any} */ this.sources = manifest.sources ?? null;
    this.expected = manifestDigest ?? manifest.digest;
    this.sealedFingerprint = JSON.parse(readFileSync(join(this.root, "FINGERPRINT.json"), "utf8")).digest;
    this.extraFiles = Object.fromEntries(extraFiles.map(f => [f, existsSync(f) ? sha256(readFileSync(f)) : null]));
    /** @type {Record<string, string>} */ this.trees = {};
    this.id = this.manifestDigest.slice(0, 16);
  }
  /** Full verification (content). Returns problems ([] = ok). */
  start(env) {
    const out = [];
    if (this.manifestDigest !== this.expected) out.push(`snapshot manifest ${this.manifestDigest.slice(0, 12)} is not the bound ${String(this.expected).slice(0, 12)}`);
    const m = manifestOf(this.root);
    if (m.digest !== this.manifestDigest) out.push("snapshot content differs from its MANIFEST.json");
    const writable = m.entries.filter(e => e[1] !== "l" && (e[2] & 0o222)).map(e => e[0]);
    if (writable.length) out.push(`writable entries in the snapshot: ${writable.slice(0, 3).join(", ")}${writable.length > 3 ? ` (+${writable.length - 3})` : ""}`);
    const escapes = linkEscapes(this.root);
    if (escapes.length) out.push(`symlinks escape the snapshot: ${escapes.slice(0, 3).join(", ")}`);
    if (fingerprintOf(this.root) !== this.sealedFingerprint) out.push("snapshot lstat fingerprint differs from the sealed FINGERPRINT.json (modified, chmod-ed or replaced since sealing)");
    if (env) out.push(...envProblems(env, this.root, this.sources));
    for (const [f, h] of Object.entries(this.extraFiles)) if (h === null) out.push(`missing ${f}`);
    return out;
  }
  /** Add a tree (e.g. a state's harness copy) whose lstat fingerprint must not change from now on. */
  watchTree(dir) { this.trees[dir] = fingerprintOf(dir); return this; }
  /** Fast check before a dispatch / after an attempt: null = unchanged, else the reason. */
  check() {
    if (fingerprintOf(this.root) !== this.sealedFingerprint) return "runtime snapshot changed (lstat fingerprint)";
    for (const [dir, fp] of Object.entries(this.trees)) if (fingerprintOf(dir) !== fp) return `harness tree changed: ${dir}`;
    for (const [f, h] of Object.entries(this.extraFiles)) if (!existsSync(f) || sha256(readFileSync(f)) !== h) return `evaluator file changed: ${f}`;
    return null;
  }
}

// ---------------------------------------------------------------- continuation (versioned post-launch bindings)

const CONT = "continuation.json";
/** Fields a continuation may re-bind; everything else of the lock must stay as originally recorded. */
export const AMENDABLE = ["envDigest", "files", "runtime"];
export const FROZEN = ["experiment", "smoke", "preregDigest", "queueDigest", "harness", "tasks", "instructions", "grading", "holdoutSeals"];

export function readContinuation(stateDir) {
  const p = join(stateDir, CONT);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** Problems of a continuation file: chain, original-lock binding. */
export function continuationProblems(stateDir, cont = readContinuation(stateDir)) {
  if (!cont) return [];
  const out = [];
  const lockBytes = readFileSync(join(stateDir, "lock.json"));
  if (sha256(lockBytes) !== cont.originalLockSha256) out.push("lock.json differs from the lock the continuation was made for");
  let prev = null;
  cont.versions.forEach((v, i) => {
    const { hash, ...body } = v;
    if (v.version !== i + 1) out.push(`version ${i + 1} numbered ${v.version}`);
    if (v.prevHash !== prev) out.push(`version ${v.version}: broken chain`);
    if (digestOf(body) !== hash) out.push(`version ${v.version}: hash mismatch (edited)`);
    prev = hash;
  });
  return out;
}

/** The effective lock: the original record with the latest continuation's bindings (or the original when none). */
export function effectiveLock(stateDir, recorded) {
  const cont = readContinuation(stateDir);
  if (!cont) return { lock: recorded, version: 0, problems: [] };
  const problems = continuationProblems(stateDir, cont);
  const last = cont.versions.at(-1);
  return { lock: { ...recorded, envDigest: last.binding.envDigest, files: last.binding.files, runtime: last.binding.runtime }, version: last.version, problems };
}

/**
 * Compare a freshly prepared lock with the effective lock. Frozen fields are compared with the ORIGINAL record; amendable fields
 * with the effective binding; a continued state requires the same runtime snapshot.
 */
export function continuedLockProblems(original, effective, current, version) {
  const out = [];
  for (const k of FROZEN) if (JSON.stringify(original[k] ?? null) !== JSON.stringify(current[k] ?? null)) out.push(`${k} changed (frozen since the launch)`);
  if (effective.envDigest !== current.envDigest) out.push(`envDigest ${String(current.envDigest).slice(0, 12)} is not the bound ${String(effective.envDigest).slice(0, 12)}`);
  for (const f of new Set([...Object.keys(effective.files ?? {}), ...Object.keys(current.files ?? {})])) if (effective.files?.[f] !== current.files?.[f]) out.push(`files.${f} changed`);
  if (version > 0 && (current.runtime?.manifestDigest ?? null) !== (effective.runtime?.manifestDigest ?? null)) out.push(`runtime snapshot ${current.runtime?.manifestDigest?.slice(0, 12) ?? "none"} is not the bound ${effective.runtime?.manifestDigest?.slice(0, 12)}`);
  return out;
}

/** Append a continuation version (caller holds the runner lock and has validated). Returns the new version. */
export function appendContinuation(stateDir, { reason, binding, evidence = [], facts = {}, at = new Date().toISOString() }) {
  const cont = readContinuation(stateDir) ?? { schema: "ctrl-confirm-4/continuation@1", originalLockSha256: sha256(readFileSync(join(stateDir, "lock.json"))), versions: [] };
  const problems = continuationProblems(stateDir, cont);
  if (problems.length) throw new Error(`continuation damaged: ${problems.join("; ")}`);
  const body = { version: cont.versions.length + 1, at, prevHash: cont.versions.at(-1)?.hash ?? null, reason, binding, evidence, facts };
  cont.versions.push({ ...body, hash: digestOf(body) });
  atomicWriteJson(join(stateDir, CONT), cont);
  return cont.versions.at(-1);
}

const lastHash = (file) => { try { const lines = readFileSync(file, "utf8").trim().split("\n"); return JSON.parse(lines.at(-1)).hash ?? null; } catch { return null; } };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { dest: { type: "string" }, root: { type: "string" }, state: { type: "string" }, reason: { type: "string" }, evidence: { type: "string", multiple: true } } });
  if (cmd === "snapshot") { process.stdout.write(`${JSON.stringify(buildSnapshot(resolve(values.dest ?? "")))}\n`); return; }
  if (cmd === "verify") {
    const g = new RuntimeGuard({ root: values.root ?? process.env.EVAL_LOOP_RUNTIME ?? "" });
    const { hostEnvironment } = await import("../../src/sandbox.mjs");
    const problems = g.start(process.env.EVAL_LOOP_RUNTIME ? hostEnvironment() : undefined);
    process.stdout.write(`${JSON.stringify({ root: g.root, manifestDigest: g.manifestDigest, ok: problems.length === 0, problems })}\n`);
    process.exit(problems.length ? 2 : 0);
  }
  if (cmd === "continue") {
    // Validated re-binding of a HELD, launched state to the CURRENT launch-bound files and runtime snapshot. Never dispatches.
    const stateDir = resolve(values.state ?? ""), root = process.env.EVAL_LOOP_RUNTIME;
    if (!root) throw new Error("EVAL_LOOP_RUNTIME (and the other envFor variables) must point at the snapshot");
    const { RunnerLock } = await import("./resources.mjs");
    const run = await import("./run.mjs");
    const { loadPrereg } = await import("./lib.mjs");
    const { hostEnvironment, environmentDigest } = await import("../../src/sandbox.mjs");
    const prereg = loadPrereg();
    const lockFile = RunnerLock.acquire(stateDir);
    try {
      const rm = run.resourceManagerOf(stateDir, prereg);
      const pause = rm.state().pause;
      if (!pause || !run.HELD_PAUSES.has(pause.kind)) throw new Error("the state is not held (operator/runtime pause required before a continuation)");
      const env = hostEnvironment();
      const guard = new RuntimeGuard({ root, extraFiles: run.reusedEvaluatorFiles() });
      const gp = guard.start(env);
      if (gp.length) throw new Error(`runtime snapshot invalid: ${gp.join("; ")}`);
      const original = JSON.parse(readFileSync(join(stateDir, "lock.json"), "utf8"));
      const prepared = await run.prepare({ stateDir, prereg, smoke: Boolean(original.smoke), env });
      const current = { ...prepared.lock, runtime: { root, manifestDigest: guard.manifestDigest } };
      const frozen = FROZEN.filter(k => JSON.stringify(original[k] ?? null) !== JSON.stringify(current[k] ?? null));
      if (frozen.length) throw new Error(`frozen lock fields differ: ${frozen.join(", ")}`);
      const eff = effectiveLock(stateDir, original);
      if (eff.problems.length) throw new Error(`continuation damaged: ${eff.problems.join("; ")}`);
      const changedFiles = Object.fromEntries([...new Set([...Object.keys(eff.lock.files), ...Object.keys(current.files)])].filter(f => eff.lock.files[f] !== current.files[f]).map(f => [f, { from: eff.lock.files[f] ?? null, to: current.files[f] ?? null }]));
      const runs = rm.state();
      const results = readFileSync(join(stateDir, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => r.type === "result").length;
      const v = appendContinuation(stateDir, {
        reason: values.reason ?? "",
        binding: { envDigest: current.envDigest, files: current.files, runtime: current.runtime },
        evidence: (values.evidence ?? []).map(f => ({ path: resolve(f), sha256: sha256(readFileSync(f)) })),
        facts: { envDigest: { from: eff.lock.envDigest, to: current.envDigest, facts: environmentDigest(env, prereg.route).facts }, changedFiles, runsChainHead: lastHash(join(stateDir, "runs.jsonl")), resourcesChainHead: lastHash(join(stateDir, "resources.jsonl")), resultRecords: results, openReservations: runs.open.size, pause, node: process.version },
      });
      process.stdout.write(`${JSON.stringify({ version: v.version, hash: v.hash, changedFiles: Object.keys(changedFiles), envDigest: current.envDigest.slice(0, 12), runtime: guard.manifestDigest.slice(0, 12) })}\n`);
    } finally { lockFile.release(); }
    return;
  }
  process.stderr.write("usage: runtime.mjs snapshot --dest DIR | verify --root DIR | continue --state DIR --reason TEXT [--evidence FILE ...]\n");
  process.exit(64);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
