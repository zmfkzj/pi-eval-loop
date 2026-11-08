#!/usr/bin/env node
// ctrl-confirm-4 holdout assembly (model-free; no agent ever ran on these tasks): eligible cases of collection phase 2
// (results/ctrl-confirm-4-supply, registry time <= the COLLECTION.md cutoff) -> exposure audit (ctrl-confirm-2/3 audit codes +
// every consumed root, the reusable ctrl-confirm-3 batch as a family/commit/content guard, the agent_workflow pools and their
// import copy) -> instruction/contract conflict screen -> engine grader validation -> candidate-blind seeded selection with caps
// counted ACROSS the reusable ctrl-confirm-3 batch -> a NEW sealed dataset (0 uses) + eligibility record. The ctrl-confirm-3 batch
// is only read (seal verified, 0 uses verified); it is never copied, re-sealed or modified.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/assemble.mjs screen --supply DIR --external-pool DIR --consumed DIR... --reuse DIR --cutoff ISO --out DIR
//   node pi-eval-loop/experiments/ctrl-confirm-4/assemble.mjs seal   (same) --review FILE
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { holdoutLedger, loadLocal, sealOf, verifySeal } from "../../src/datasets.mjs";
import { atomicWriteJson, digestOf, ensureDir, readJson, sha256 } from "../../src/util.mjs";
import { candidates as cc3Candidates } from "../ctrl-confirm-3/assemble.mjs";

export const SELECTION = { seed: "ctrl-confirm-4/holdout", maxPerFamily: 3, maxPerOwner: 6, maxTasks: 5000 };

/** Registry time of the eligible decision of every case of every pool below a supply root. */
export function eligibleTimes(supply) {
  const at = new Map();
  for (const p of readdirSync(supply).filter(d => existsSync(join(supply, d, "registry.jsonl")))) {
    for (const line of readFileSync(join(supply, p, "registry.jsonl"), "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(line); if (r.type === "case" && r.status === "eligible") at.set(r.caseId, r.at); }
  }
  return at;
}

/** The reusable batch: seal intact, zero uses, its tasks (for cross-batch caps and audit). */
export function reusableBatch(dir) {
  const seal = verifySeal(dir);
  if (!seal.ok) throw new Error(`reusable batch ${dir}: seal ${seal.why}`);
  const ledger = holdoutLedger(dir);
  if (ledger.verify().length) throw new Error(`reusable batch ${dir}: use ledger damaged`);
  const uses = ledger.records();
  if (uses.length) throw new Error(`reusable batch ${dir} already has ${uses.length} use(s): it is not fresh`);
  const tasks = loadLocal(dir).map(t => ({ id: t.id, family: t.family, owner: String(t.family).replace(/^gh:/, "").split("/")[0] }));
  return { dir, sealDigest: seal.seal.digest, uses: 0, tasks };
}

/** Candidate-blind seeded selection; family/owner caps count the tasks already in the reusable batch. */
export function selectAcross(list, prior, sel = SELECTION) {
  const perFamily = {}, perOwner = {};
  for (const t of prior) { perFamily[t.family] = (perFamily[t.family] ?? 0) + 1; perOwner[t.owner] = (perOwner[t.owner] ?? 0) + 1; }
  const picked = [];
  for (const c of [...list].sort((a, b) => sha256(`${sel.seed}:${a.id}`).localeCompare(sha256(`${sel.seed}:${b.id}`)))) {
    if (picked.length >= sel.maxTasks || (perFamily[c.family] ?? 0) >= sel.maxPerFamily || (perOwner[c.owner] ?? 0) >= sel.maxPerOwner) continue;
    picked.push(c); perFamily[c.family] = (perFamily[c.family] ?? 0) + 1; perOwner[c.owner] = (perOwner[c.owner] ?? 0) + 1;
  }
  return picked;
}

export function screen({ supply, externalPool, consumed, reuse, cutoff, orcheDir }) {
  const reused = reusableBatch(reuse);
  const cand = cc3Candidates({ supply, externalPool, consumed: [...consumed, reuse], orcheDir });
  const times = eligibleTimes(supply);
  const cut = Date.parse(cutoff);
  const reusedIds = new Set(reused.tasks.map(t => t.id));
  for (const c of /** @type {any[]} */ (cand.candidates)) {
    const at = times.get(c.id);
    if (!at || Date.parse(at) > cut) { c.excluded = c.excluded ?? `after-collection-cutoff (${at ?? "no eligible record"} > ${cutoff})`; continue; }
    c.eligibleAt = at;
    if (reusedIds.has(c.id)) c.audit = [...new Set([...(c.audit ?? []), "case-in-reusable-batch"])];
  }
  return { ...cand, cutoff, reused: { dir: reused.dir, sealDigest: reused.sealDigest, uses: 0, tasks: reused.tasks.length } , reusedTasks: reused.tasks };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { supply: { type: "string" }, "external-pool": { type: "string" }, consumed: { type: "string", multiple: true }, reuse: { type: "string" }, cutoff: { type: "string" }, out: { type: "string" }, review: { type: "string" } } });
  const cmd = positionals[0];
  if (!["screen", "seal"].includes(cmd) || !values.supply || !values["external-pool"] || !values.out || !values.consumed?.length || !values.reuse || !values.cutoff) { process.stderr.write("usage: assemble.mjs screen|seal --supply DIR --external-pool DIR --consumed DIR... --reuse DIR --cutoff ISO --out DIR [--review FILE]\n"); return 64; }
  const { ORCHE, hostEnvironment } = await import("../../src/sandbox.mjs");
  const out = ensureDir(resolve(values.out));
  const cand = screen({ supply: resolve(values.supply), externalPool: resolve(values["external-pool"]), consumed: values.consumed.map(c => resolve(c)), reuse: resolve(values.reuse), cutoff: values.cutoff, orcheDir: ORCHE });
  if (cmd === "screen") {
    atomicWriteJson(join(out, "candidates.json"), { at: new Date().toISOString(), ...cand });
    const ok = cand.candidates.filter(c => !c.excluded && !c.audit.length);
    process.stdout.write(`${JSON.stringify({ eligibleRecords: cand.candidates.length, beforeCutoff: cand.candidates.filter(c => !String(c.excluded ?? "").startsWith("after-collection-cutoff")).length, auditClean: ok.length, families: new Set(ok.map(c => c.family)).size, flagged: ok.filter(c => c.testChangeFlag).length })}\n`);
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
  const tmp = ensureDir(join(out, `tmp-${Date.now()}`));
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
  const picked = selectAcross(valid, cand.reusedTasks);
  for (const c of valid) decisions.push({ id: c.id, family: c.family, decision: picked.includes(c) ? "selected" : "eligible-not-selected (family/owner cap incl. the reusable batch)" });
  const ids = picked.map(c => c.id).sort();
  const batch = `ctrl-confirm-4-holdout-${digestOf(ids).slice(0, 12)}`;
  const dir = join(out, batch);
  if (existsSync(dir)) throw new Error(`${dir} exists: never overwrite a sealed holdout`);
  const tmpDir = `${dir}.tmp`;
  if (existsSync(tmpDir)) throw new Error(`${tmpDir} exists (an interrupted sealing): inspect and keep it as evidence before retrying`);
  ensureDir(tmpDir);
  const tasks = [];
  for (const c of picked) {
    const src = join(c.pool, "cases", c.id);
    for (const part of ["task.json", "repo", "hidden", "reference"]) if (existsSync(join(src, part))) cpSync(join(src, part), join(tmpDir, c.id, part), { recursive: true });
    const t = readJson(join(src, "task.json"));
    tasks.push({ id: c.id, family: c.family, owner: c.owner, tier: c.tier, difficultyBasis: c.difficultyBasis, contentDigest: c.contentDigest, eligibleAt: c.eligibleAt, instructionSha256: sha256(t.instruction), conflictReview: review.decisions?.[c.id] ?? null, upstream: t.upstream });
  }
  atomicWriteJson(join(tmpDir, "PROVENANCE.json"), { schema: "pi-eval-loop/ctrl-confirm-4-holdout@1", batch, createdAt: new Date().toISOString(), collection: { root: resolve(values.supply), cutoff: values.cutoff, rules: "experiments/ctrl-confirm-4/COLLECTION.md" }, selection: { ...SELECTION, rule: "sha256(seed:id) order; caps per repository (family) and account (owner) counted across the reusable ctrl-confirm-3 batch; candidate-blind" }, reusableBatch: cand.reused, pools: cand.pools, consumed: cand.consumed, tasks, limitations: ["Public upstream code: absence from model pretraining data is not established.", "Overlap checks: exact commits, patch ids, repository names, file content hashes, texts of earlier experiments/records, the external pool, every ctrl-confirm-2/3 supply pool and holdout, and the agent_workflow pools; semantic near-duplicates are not detected.", "Tiers are a size proxy of the upstream fix, not measured difficulty."] });
  const seal = sealOf(tmpDir);
  if (seal.symlinks.length) throw new Error(`symlinks: ${seal.symlinks.join(", ")}`);
  atomicWriteJson(join(tmpDir, "SEAL.json"), { ...seal, batch, sealedAt: new Date().toISOString() });
  cpSync(tmpDir, dir, { recursive: true });
  rmSync(tmpDir, { recursive: true, force: true });
  loadLocal(dir);
  const families = new Set(picked.map(c => c.family));
  atomicWriteJson(join(out, `${batch}.ELIGIBILITY.json`), { at: new Date().toISOString(), batch, dir, sealDigest: seal.digest, cutoff: values.cutoff, tasks: ids.length, families: families.size, owners: new Set(picked.map(c => c.owner)).size, familySizes: [...families].map(f => picked.filter(c => c.family === f).length).sort((a, b) => b - a), taskIds: ids, perFamily: Object.fromEntries([...families].sort().map(f => [f, picked.filter(c => c.family === f).length])), reusableBatch: cand.reused, decisions, reviewDigest: sha256(readFileSync(values.review)) });
  process.stdout.write(`${JSON.stringify({ batch, sealDigest: seal.digest, tasks: ids.length, families: families.size })}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(code => process.exit(code), error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
