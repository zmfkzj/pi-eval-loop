#!/usr/bin/env node
// ctrl-confirm-3 holdout assembly (model-free; no agent ever ran on these tasks): eligible cases of the NEW workspace-local supply
// -> exposure audit (ctrl-confirm-2 audit + EXPLICIT consumed ctrl-confirm-2 supply pools and holdout) -> instruction/contract
// conflict screen -> engine grader validation -> candidate-blind seeded selection -> sealed dataset (0 uses) + eligibility record.
//
//   node pi-eval-loop/experiments/ctrl-confirm-3/assemble.mjs screen --supply DIR --external-pool DIR --consumed DIR... --out DIR
//   node pi-eval-loop/experiments/ctrl-confirm-3/assemble.mjs seal   --supply DIR --external-pool DIR --consumed DIR... --out DIR --review FILE
//
// Hidden tests and references stay under DIR (umbrella results/, git-ignored, outside the package and every agent sandbox).
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadLocal, sealOf } from "../../src/datasets.mjs";
import { atomicWriteJson, digestOf, ensureDir, readJson, sha256, walkFiles } from "../../src/util.mjs";
import { candidates as baseCandidates, externalIds, select } from "../ctrl-confirm-2/assemble.mjs";

export const SELECTION = { seed: "ctrl-confirm-3/holdout", maxPerFamily: 3, maxPerOwner: 6, maxTasks: 2000 };

/** Identifiers of consumed roots: every pool (registry.jsonl) and sealed holdout (SEAL.json) below each root. */
export function consumedIds(roots) {
  const ids = { commits: new Set(), patches: new Set(), repos: new Set(), families: new Set(), fileHashes: new Set(), caseIds: new Set(), pools: [], holdouts: [] };
  const visit = (d, depth) => {
    if (depth > 3 || !existsSync(d)) return;
    if (existsSync(join(d, "registry.jsonl"))) { ids.pools.push(d); const e = externalIds(d); for (const k of ["commits", "patches", "repos"]) for (const v of e[k]) ids[k].add(v); for (const line of readFileSync(join(d, "registry.jsonl"), "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(line); if (r.caseId) ids.caseIds.add(r.caseId); } }
    if (existsSync(join(d, "SEAL.json"))) {
      ids.holdouts.push(d);
      for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && existsSync(join(d, e.name, "task.json"))) {
        const t = JSON.parse(readFileSync(join(d, e.name, "task.json"), "utf8"));
        ids.caseIds.add(e.name); if (t.family) ids.families.add(t.family); if (t.upstream?.commit) ids.commits.add(t.upstream.commit);
        for (const sub of ["hidden", "reference"]) for (const f of walkFiles(join(d, e.name, sub))) if (f.size > 64 && f.symlink === undefined) ids.fileHashes.add(sha256(readFileSync(join(d, e.name, sub, f.path))));
      }
    }
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !["cases", "cache", "tmp", "repo", "hidden", "reference", "node_modules"].includes(e.name)) visit(join(d, e.name), depth + 1);
  };
  for (const r of roots) visit(resolve(r), 0);
  return ids;
}

/** ctrl-confirm-2 audit + consumed-root audit codes. */
export function candidates({ supply, externalPool, consumed, orcheDir }) {
  const base = baseCandidates({ supply, externalPool, orcheDir });
  const ids = consumedIds(consumed);
  for (const c of base.candidates) {
    if (c.excluded) continue;
    const dir = join(c.pool, "cases", c.id);
    const t = readJson(join(dir, "task.json"));
    const slug = String(c.family ?? "").replace(/^gh:/, "").toLowerCase();
    const add = (code) => { c.audit = [...new Set([...(c.audit ?? []), code])]; };
    if (ids.repos.has(slug)) add("repository-in-consumed-supply");
    if (ids.families.has(c.family)) add("family-of-consumed-holdout");
    if (t.upstream?.commit && ids.commits.has(t.upstream.commit)) add("commit-in-consumed-supply-or-holdout");
    if (ids.caseIds.has(c.id)) add("case-id-in-consumed-supply-or-holdout");
    for (const sub of ["hidden", "reference"]) for (const f of walkFiles(join(dir, sub))) if (f.size > 64 && ids.fileHashes.has(sha256(readFileSync(join(dir, sub, f.path))))) { add("content-matches-consumed-holdout"); break; }
  }
  return { ...base, consumed: { roots: consumed, pools: ids.pools, holdouts: ids.holdouts, repos: ids.repos.size, families: ids.families.size, commits: ids.commits.size, fileHashes: ids.fileHashes.size } };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { supply: { type: "string" }, "external-pool": { type: "string" }, consumed: { type: "string", multiple: true }, out: { type: "string" }, review: { type: "string" } } });
  const cmd = positionals[0];
  if (!["screen", "seal"].includes(cmd) || !values.supply || !values["external-pool"] || !values.out || !values.consumed?.length) { process.stderr.write("usage: assemble.mjs screen|seal --supply DIR --external-pool DIR --consumed DIR... --out DIR [--review FILE]\n"); return 64; }
  const { ORCHE, hostEnvironment } = await import("../../src/sandbox.mjs");
  const out = ensureDir(resolve(values.out));
  const cand = candidates({ supply: resolve(values.supply), externalPool: resolve(values["external-pool"]), consumed: values.consumed.map(c => resolve(c)), orcheDir: ORCHE });
  if (cmd === "screen") {
    atomicWriteJson(join(out, "candidates.json"), { at: new Date().toISOString(), ...cand });
    const ok = cand.candidates.filter(c => !c.excluded && !c.audit.length);
    process.stdout.write(`${JSON.stringify({ eligible: cand.candidates.length, auditClean: ok.length, families: new Set(ok.map(c => c.family)).size, flagged: ok.filter(c => c.testChangeFlag).length })}\n`);
    return 0;
  }
  if (!values.review) throw new Error("seal needs --review (the recorded conflict review)");
  const review = JSON.parse(readFileSync(values.review, "utf8"));
  const env = hostEnvironment();
  const { validateGrader } = await import("../../src/grader.mjs");
  const decisions = [], clean = [];
  for (const c of cand.candidates) {
    if (c.excluded) { decisions.push({ id: c.id, decision: "excluded", why: c.excluded }); continue; }
    if (c.audit.length) { decisions.push({ id: c.id, family: c.family, decision: "excluded", why: c.audit }); continue; }
    if (c.testChangeFlag && !review.decisions?.[c.id]) throw new Error(`flagged task ${c.id} has no recorded conflict review`);
    const r = review.decisions?.[c.id];
    if (r && r.conflict) { decisions.push({ id: c.id, family: c.family, decision: "excluded", why: `instruction-test-change-conflict: ${r.reason}` }); continue; }
    clean.push(c);
  }
  const tmp = ensureDir(join(out, "tmp"));
  const verdicts = new Map();
  let nextC = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (nextC < clean.length) {
      const c = clean[nextC++];
      const dir = join(c.pool, "cases", c.id);
      verdicts.set(c.id, await validateGrader({ task: { id: c.id, dir, repo: join(dir, "repo"), hidden: join(dir, "hidden") }, scratch: mkdtempSync(join(tmp, "g-")), env }));
    }
  }));
  const valid = [];
  for (const c of clean) {
    const v = verdicts.get(c.id);
    if (!v.ok || v.referenceVisiblePass !== true) { decisions.push({ id: c.id, family: c.family, decision: "excluded", why: v.ok ? "reference-breaks-visible-suite (engine)" : `engine-grader: ${v.problems.map(p => p.slice(0, 80)).join("; ")}` }); continue; }
    valid.push({ ...c, engineExpected: v.expected });
  }
  rmSync(tmp, { recursive: true, force: true });
  const picked = select(valid, SELECTION);
  for (const c of valid) decisions.push({ id: c.id, family: c.family, decision: picked.includes(c) ? "selected" : "eligible-not-selected (family/owner/size cap)" });
  const ids = picked.map(c => c.id).sort();
  const batch = `ctrl-confirm-3-holdout-${digestOf(ids).slice(0, 12)}`;
  const dir = join(out, batch);
  if (existsSync(dir)) throw new Error(`${dir} exists: never overwrite a sealed holdout`);
  const tmpDir = `${dir}.tmp`;
  rmSync(tmpDir, { recursive: true, force: true });
  ensureDir(tmpDir);
  const tasks = [];
  for (const c of picked) {
    const src = join(c.pool, "cases", c.id);
    for (const part of ["task.json", "repo", "hidden", "reference"]) if (existsSync(join(src, part))) cpSync(join(src, part), join(tmpDir, c.id, part), { recursive: true });
    const t = readJson(join(src, "task.json"));
    tasks.push({ id: c.id, family: c.family, owner: c.owner, tier: c.tier, difficultyBasis: c.difficultyBasis, contentDigest: c.contentDigest, instructionSha256: sha256(t.instruction), conflictReview: review.decisions?.[c.id] ?? null, upstream: t.upstream });
  }
  atomicWriteJson(join(tmpDir, "PROVENANCE.json"), { schema: "pi-eval-loop/ctrl-confirm-3-holdout@1", batch, createdAt: new Date().toISOString(), selection: { ...SELECTION, rule: "sha256(seed:id) order; caps per repository (family) and account (owner); candidate-blind" }, pools: cand.pools, consumed: cand.consumed, tasks, limitations: ["Public upstream code: absence from model pretraining data is not established.", "Overlap checks: exact commits, patch ids, repository names, file content hashes, texts of earlier experiments/records, the pre-existing external pool's registry and reports, and every ctrl-confirm-2 supply pool and holdout; semantic near-duplicates are not detected.", "Tiers are a size proxy of the upstream fix, not measured difficulty."] });
  const seal = sealOf(tmpDir);
  if (seal.symlinks.length) throw new Error(`symlinks: ${seal.symlinks.join(", ")}`);
  atomicWriteJson(join(tmpDir, "SEAL.json"), { ...seal, batch, sealedAt: new Date().toISOString() });
  cpSync(tmpDir, dir, { recursive: true });
  rmSync(tmpDir, { recursive: true, force: true });
  loadLocal(dir);
  const families = new Set(picked.map(c => c.family));
  atomicWriteJson(join(out, `${batch}.ELIGIBILITY.json`), { at: new Date().toISOString(), batch, dir, sealDigest: seal.digest, tasks: ids.length, families: families.size, owners: new Set(picked.map(c => c.owner)).size, familySizes: [...families].map(f => picked.filter(c => c.family === f).length).sort((a, b) => b - a), taskIds: ids, perFamily: Object.fromEntries([...families].sort().map(f => [f, picked.filter(c => c.family === f).length])), decisions, reviewDigest: sha256(readFileSync(values.review)) });
  process.stdout.write(`${JSON.stringify({ batch, sealDigest: seal.digest, tasks: ids.length, families: families.size })}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(code => process.exit(code), error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
