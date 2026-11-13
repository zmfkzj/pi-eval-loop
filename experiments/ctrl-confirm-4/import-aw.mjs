#!/usr/bin/env node
// ctrl-confirm-4: read-only import of the task pools found in the sibling repository agent_workflow (user request 2026-11-07:
// "../agent_workflow 쪽에 추가된 과제가 있는지 확인해서 병합"). The source is never written. Every file is copied byte-for-byte into
// --out (git-ignored results/, outside every agent sandbox) and hashed; each case gets an eligibility class with the evidence.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/import-aw.mjs --source /home/arthur/Code/agent_workflow --out DIR --manifest FILE
//
// Classes (none of them is an independent external holdout; all are QUARANTINED for train/pilot/smoke use only):
//   authored-private      implementer/agent-authored cases (source "private-reviewed", ids cf1-*): not external, not independent
//   public-benchmark      exercism exercises listed in a public agent benchmark (aider polyglot): other generator, contaminated
//   agent-exposed         an agent already ran on the case (a run record names it under the sibling's experiment states)
//   lineage-used-pool     identical to / same family as cases of the pre-existing external pool, whose batch was reserved/used
//   source-rejected       the sibling's own validator rejected, withdrew or superseded the case (kept as record only)
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { atomicWriteJson, ensureDir, sha256 } from "../../src/util.mjs";

const POOLS = ["runs/eval-loop-confirmatory-1/pool", "runs/eval-loop-supply"];
const SKIP = new Set(["cache", "tmp"]);

export function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!(dir === base && SKIP.has(e.name))) walk(p, base, out); }
    else if (e.isFile()) out.push(relative(base, p));
  }
  return out;
}

const readJsonl = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));

/** Last case record per id, batch membership and reservations of one pool registry. */
export function poolState(registry) {
  const last = new Map(), batches = new Map(), reserved = new Map(), retired = new Map();
  for (const r of registry) {
    if (r.type === "case") last.set(r.caseId, r);
    if (r.type === "batch") batches.set(r.batch, r.tasks ?? []);
    if (r.type === "reserve") reserved.set(r.batch, r.stateDir);
    if (r.type === "retire") retired.set(r.batch, r.code);
  }
  return { last, batches, reserved, retired };
}

/** Eligibility class of one case (first matching rule; see the header). */
export function classify({ id, record, exposedIds, usedPoolIds, usedPoolFamilies }) {
  const family = String(record?.family ?? (record?.repo ? `gh:${record.repo}` : "")).toLowerCase();
  if (record && ["rejected", "withdrawn", "superseded"].includes(record.status)) return { cls: "source-rejected", why: `${record.status}: ${record.code ?? ""}` };
  if (exposedIds.has(id)) return { cls: "agent-exposed", why: `agent run records: ${[...exposedIds.get(id)].slice(0, 3).join(", ")}` };
  if (record?.source === "private-reviewed" || id.startsWith("cf1-")) return { cls: "authored-private", why: "authored for the sibling's study (private-reviewed), not an upstream public task" };
  if (record?.source === "exercism" || id.startsWith("x-exercism-")) return { cls: "public-benchmark", why: `exercism exercise${record?.listedIn ? ` listed in ${record.listedIn}` : ""}` };
  if (usedPoolIds.has(id) || (family && usedPoolFamilies.has(family))) return { cls: "lineage-used-pool", why: `same case or family as the pre-existing external pool (family ${family})` };
  return { cls: "unclassified-quarantine", why: "provenance/exposure could not be established independently" };
}

async function main() {
  const { values } = parseArgs({ options: { source: { type: "string" }, out: { type: "string" }, manifest: { type: "string" } } });
  const source = resolve(values.source), out = resolve(values.out);
  if (existsSync(out)) throw new Error(`${out} exists: an import is written once`);
  const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"]).toString().trim();
  const ignored = POOLS.map(p => ({ pool: p, gitIgnored: (() => { try { execFileSync("git", ["-C", source, "check-ignore", "-q", p]); return true; } catch { return false; } })() }));
  const files = [];
  for (const p of POOLS) {
    const src = join(source, p);
    for (const f of walk(src).sort()) {
      const abs = join(src, f);
      files.push({ path: `${p}/${f}`, bytes: statSync(abs).size, sha256: sha256(readFileSync(abs)) });
      cpSync(abs, join(out, p, f), { preserveTimestamps: true });
    }
  }
  // Agent exposure: any run record / schedule / grading file of the sibling's experiment states that names a case id.
  const exposedIds = new Map();
  const states = join(source, "runs/eval-loop-confirmatory-1/explore");
  const caseIds = new Set();
  const pools = Object.fromEntries(POOLS.map(p => [p, poolState(readJsonl(join(source, p, "registry.jsonl")))]));
  for (const s of Object.values(pools)) { for (const id of s.last.keys()) caseIds.add(id); for (const t of s.batches.values()) for (const id of t) caseIds.add(id); }
  for (const id of caseIds) {
    try {
      const hits = execFileSync("grep", ["-rlF", "--include=record.json", "--include=*schedule*.json", "--include=runs.jsonl", id, states], { maxBuffer: 1 << 26 }).toString().split("\n").filter(Boolean);
      if (hits.length) exposedIds.set(id, new Set(hits.map(h => relative(source, h))));
    } catch { /* grep exit 1 = no hit */ }
  }
  const ext = pools["runs/eval-loop-supply"];
  const usedPoolIds = new Set([...ext.last.keys()].filter(id => ext.last.get(id).status === "eligible"));
  for (const t of ext.batches.values()) for (const id of t) usedPoolIds.add(id);
  const usedPoolFamilies = new Set([...ext.last.values()].map(r => String(r.family ?? (r.repo ? `gh:${r.repo}` : "")).toLowerCase()).filter(Boolean));
  const cases = [];
  for (const [p, s] of Object.entries(pools)) {
    const inBatch = new Map();
    for (const [b, t] of s.batches) for (const id of t) inBatch.set(id, [...(inBatch.get(id) ?? []), b]);
    for (const id of new Set([...s.last.keys(), ...inBatch.keys()])) {
      const record = s.last.get(id);
      const external = p === "runs/eval-loop-supply";
      const c = external ? { cls: "lineage-used-pool", why: "pre-existing external pool (already excluded by ctrl-confirm-3; batch b20261105T093919Z reserved by a state)" } : classify({ id, record, exposedIds, usedPoolIds, usedPoolFamilies });
      if (record?.status && ["rejected", "withdrawn", "superseded"].includes(record.status) && !inBatch.has(id) && !existsSync(join(source, p, "cases", id))) continue; // rejected before extraction: counted below, not listed
      cases.push({ id, pool: p, sourceStatus: record?.status ?? null, sourceCode: record?.code ?? null, source: record?.source ?? null, repo: record?.repo ?? null, commit: record?.commit ?? null, batches: inBatch.get(id) ?? [], reservedBy: (inBatch.get(id) ?? []).map(b => s.reserved.get(b)).filter(Boolean), retiredBatches: (inBatch.get(id) ?? []).filter(b => s.retired.has(b)), class: c.cls, why: c.why, independentHoldoutEligible: false, use: "quarantine: train/pilot/smoke only" });
    }
  }
  const counts = (key) => cases.reduce((m, c) => ({ ...m, [c[key]]: (m[c[key]] ?? 0) + 1 }), {});
  const registryCounts = Object.fromEntries(Object.entries(pools).map(([p, s]) => [p, [...s.last.values()].reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {})]));
  const manifest = {
    schema: "ctrl-confirm-4/aw-import@1", at: new Date().toISOString(), source, sourceHead: head, sourcePoolsGitIgnored: ignored,
    note: "runs/ is git-ignored in the source, so HEAD does not pin these bytes: every copied file is listed with its sha256 (copy == source at import time)",
    copiedTo: out, files: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0), filesSha256: sha256(JSON.stringify(files)),
    registryStatusCounts: registryCounts, listed: cases.length, byClass: counts("class"), independentHoldoutEligible: 0, cases, fileList: files,
  };
  atomicWriteJson(resolve(values.manifest), manifest);
  process.stdout.write(`${JSON.stringify({ files: files.length, listed: cases.length, byClass: manifest.byClass, independent: 0 })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
