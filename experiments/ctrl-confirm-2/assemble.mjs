#!/usr/bin/env node
// ctrl-confirm-2 holdout assembly (model-free; no agent ever ran on these tasks): pooled eligible cases of the workspace-local
// supply pools -> exposure audit -> instruction/contract conflict screen -> engine grader validation -> candidate-blind seeded
// selection -> sealed dataset with provenance and an eligibility record.
//
//   node pi-eval-loop/experiments/ctrl-confirm-2/assemble.mjs screen  --supply DIR --external-pool DIR --out DIR
//        writes DIR/candidates.json (all eligible cases, audit results, conflict-screen flags) for the conflict review
//   node pi-eval-loop/experiments/ctrl-confirm-2/assemble.mjs seal    --supply DIR --external-pool DIR --out DIR --review FILE
//        applies the recorded conflict review, validates with the engine grader, selects, copies and seals DIR/<batch>/
//
// Hidden tests and reference solutions stay under DIR (umbrella results/, git-ignored, outside the pi-eval-loop package and outside
// every agent sandbox); reports name only ids, families, codes, hashes and URLs.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { caseDigest, knownCorpus, poolState } from "../../src/supply.mjs";
import { exposureScan, loadLocal, sealOf } from "../../src/datasets.mjs";
import { atomicWriteJson, digestOf, ensureDir, readJson, sha256, walkFiles } from "../../src/util.mjs";

export const SELECTION = { seed: "ctrl-confirm-2/holdout", maxPerFamily: 3, maxPerOwner: 6, maxTasks: 120 };
/** Instruction phrases that may REQUIRE changing existing tests (flag for review; never decided by outcome). */
export const TEST_CHANGE_FLAG = /\b(update|updat(?:ed|es|ing)|modif(?:y|ied|ies)|chang(?:e|ed|es|ing)|fix(?:ed|es|ing)?|adjust(?:ed|s)?|rewr(?:ite|ote)|remov(?:e|ed|es)|renam(?:e|ed|es)|delet(?:e|ed|es)|skip(?:ped|s)?|refactor(?:ed|s)?)\b[^\n.]{0,60}\b(tests?|specs?|snapshots?|fixtures?|assertions?)\b|\b(tests?|specs?)\b[^\n.]{0,30}\b(updated|changed|modified|fixed|adjusted|rewritten|removed|renamed)\b/i;

const poolsOf = (supply) => {
  const out = [];
  const visit = (d, depth) => { if (depth > 2 || !existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { const p = join(d, e.name); if (/^pool-\d+$/.test(e.name) && existsSync(join(p, "registry.jsonl"))) out.push(p); else if (!["cases", "cache", "tmp", "batches"].includes(e.name)) visit(p, depth + 1); } };
  visit(supply, 0);
  return out.sort();
};

/** External pool identifiers (read-only): commits, patch ids, source keys, repositories. */
export function externalIds(externalPool) {
  const ids = { commits: new Set(), patches: new Set(), repos: new Set(), sourceKeys: new Set() };
  const reg = join(externalPool, "registry.jsonl");
  if (!existsSync(reg)) return ids;
  for (const line of readFileSync(reg, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(line); if (r.commit) ids.commits.add(r.commit); if (r.patchId) ids.patches.add(r.patchId); if (r.repo) ids.repos.add(String(r.repo).toLowerCase()); if (r.sourceKey) ids.sourceKeys.add(r.sourceKey); }
  return ids;
}

/** All eligible, content-intact cases of the supply pools with their exposure audit and conflict-screen flag. */
export function candidates({ supply, externalPool, orcheDir }) {
  const ext = externalIds(externalPool);
  const corpus = knownCorpus({ orcheDir, pool: undefined, extraTextRoots: [externalPool] });
  const seenIds = new Map(), out = [];
  for (const pool of poolsOf(supply)) {
    const st = poolState(pool);
    if (st.chain.length) throw new Error(`${pool}: registry chain broken: ${st.chain.join("; ")}`);
    for (const r of st.cases.values()) {
      if (r.status !== "eligible") continue;
      const dir = join(pool, "cases", r.caseId);
      const audit = [];
      if (!existsSync(join(dir, "task.json"))) { out.push({ id: r.caseId, pool, excluded: "case-directory-missing" }); continue; }
      if (caseDigest(dir) !== r.contentDigest) audit.push("content-changed-since-validation");
      const t = readJson(join(dir, "task.json"));
      const slug = String(r.repo).toLowerCase();
      if (ext.commits.has(r.commit)) audit.push("commit-in-external-pool");
      if (r.patchId && ext.patches.has(r.patchId)) audit.push("patch-in-external-pool");
      if (ext.repos.has(slug)) audit.push("family-in-external-pool");
      if (corpus.families.has(t.family)) audit.push("family-in-earlier-datasets");
      if (corpus.texts.some(x => x.includes(slug) || x.includes(r.caseId) || (r.commit && x.includes(r.commit.slice(0, 12))))) audit.push("named-in-earlier-experiments-or-external-pool");
      for (const sub of ["hidden", "reference"]) for (const f of walkFiles(join(dir, sub))) if (f.size > 64 && corpus.fileHashes.has(sha256(readFileSync(join(dir, sub, f.path))))) { audit.push("content-matches-earlier-task"); break; }
      if (seenIds.has(r.caseId)) audit.push("duplicate-case-id-across-pools");
      seenIds.set(r.caseId, pool);
      const hiddenFiles = walkFiles(join(dir, "hidden")).map(f => f.path);
      if (!hiddenFiles.length) audit.push("no-hidden-tests");
      if (existsSync(join(dir, "repo", ".git"))) audit.push("repository-history-in-visible-tree");
      const message = t.upstream?.adaptation ? t.instruction : t.instruction;
      out.push({ id: r.caseId, pool, family: t.family, owner: t.family.replace(/^gh:/, "").split("/")[0], tier: t.tier, difficultyBasis: t.difficultyBasis, contentDigest: r.contentDigest, commitUrl: t.upstream?.commitUrl, committedAt: t.upstream?.committedAt, license: t.upstream?.license?.spdx, audit: [...new Set(audit)], testChangeFlag: TEST_CHANGE_FLAG.test(message), instruction: t.instruction });
    }
  }
  const exposure = exposureScan(out.map(c => c.id), { orcheDir });
  for (const c of out) if (exposure[c.id]?.exposed) c.audit = [...(c.audit ?? []), "id-exposed-in-orche-records"];
  return { pools: poolsOf(supply), corpusCoverage: corpus.coverage, candidates: out };
}

/** Candidate-blind selection: sha256(seed:id) order, at most maxPerFamily per repository and maxPerOwner per account, up to maxTasks. */
export function select(list, sel = SELECTION) {
  const order = [...list].sort((a, b) => sha256(`${sel.seed}:${a.id}`).localeCompare(sha256(`${sel.seed}:${b.id}`)));
  const picked = [], perFamily = {}, perOwner = {};
  for (const c of order) {
    if (picked.length >= sel.maxTasks || (perFamily[c.family] ?? 0) >= sel.maxPerFamily || (perOwner[c.owner] ?? 0) >= sel.maxPerOwner) continue;
    picked.push(c); perFamily[c.family] = (perFamily[c.family] ?? 0) + 1; perOwner[c.owner] = (perOwner[c.owner] ?? 0) + 1;
  }
  return picked;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { supply: { type: "string" }, "external-pool": { type: "string" }, out: { type: "string" }, review: { type: "string" } } });
  const cmd = positionals[0];
  if (!["screen", "seal"].includes(cmd) || !values.supply || !values["external-pool"] || !values.out) { process.stderr.write("usage: assemble.mjs screen|seal --supply DIR --external-pool DIR --out DIR [--review FILE]\n"); return 64; }
  const { ORCHE, hostEnvironment } = await import("../../src/sandbox.mjs");
  const out = ensureDir(resolve(values.out));
  const cand = candidates({ supply: resolve(values.supply), externalPool: resolve(values["external-pool"]), orcheDir: ORCHE });
  if (cmd === "screen") {
    atomicWriteJson(join(out, "candidates.json"), { at: new Date().toISOString(), ...cand });
    const ok = cand.candidates.filter(c => !c.excluded && !c.audit.length);
    process.stdout.write(`${JSON.stringify({ eligible: cand.candidates.length, auditClean: ok.length, families: new Set(ok.map(c => c.family)).size, flagged: ok.filter(c => c.testChangeFlag).map(c => c.id) })}\n`);
    return 0;
  }
  // seal
  if (!values.review) throw new Error("seal needs --review (the recorded conflict review)");
  const review = JSON.parse(readFileSync(values.review, "utf8"));
  const env = hostEnvironment();
  const { validateGrader } = await import("../../src/grader.mjs");
  const decisions = [];
  const clean = [];
  for (const c of cand.candidates) {
    if (c.excluded) { decisions.push({ id: c.id, decision: "excluded", why: c.excluded }); continue; }
    if (c.audit.length) { decisions.push({ id: c.id, family: c.family, decision: "excluded", why: c.audit }); continue; }
    if (c.testChangeFlag && !review.decisions?.[c.id]) throw new Error(`flagged task ${c.id} has no recorded conflict review`);
    const r = review.decisions?.[c.id];
    if (r && r.conflict) { decisions.push({ id: c.id, family: c.family, decision: "excluded", why: `instruction-test-change-conflict: ${r.reason}` }); continue; }
    clean.push(c);
  }
  // Engine grader validation (original fails hidden, reference passes) in task order; failures are excluded BEFORE selection.
  const tmp = ensureDir(join(out, "tmp"));
  const verdicts = new Map();
  let nextC = 0;
  // 6 validations in parallel (independent sandboxes); the result does not depend on timing (decisions are kept in candidate order).
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (nextC < clean.length) {
      const c = clean[nextC++];
      const dir = join(c.pool, "cases", c.id);
      const task = { id: c.id, dir, repo: join(dir, "repo"), hidden: join(dir, "hidden") };
      verdicts.set(c.id, await validateGrader({ task, scratch: mkdtempSync(join(tmp, "g-")), env }));
    }
  }));
  const valid = [];
  for (const c of clean) {
    const v = verdicts.get(c.id);
    if (!v.ok || v.referenceVisiblePass !== true) { decisions.push({ id: c.id, family: c.family, decision: "excluded", why: v.ok ? "reference-breaks-visible-suite (engine)" : `engine-grader: ${v.problems.map(p => p.slice(0, 80)).join("; ")}` }); continue; }
    valid.push({ ...c, engineExpected: v.expected });
  }
  rmSync(tmp, { recursive: true, force: true });
  const picked = select(valid);
  for (const c of valid) decisions.push({ id: c.id, family: c.family, decision: picked.includes(c) ? "selected" : "eligible-not-selected (family/owner/size cap)" });
  const ids = picked.map(c => c.id).sort();
  const batch = `ctrl-confirm-2-holdout-${digestOf(ids).slice(0, 12)}`;
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
  atomicWriteJson(join(tmpDir, "PROVENANCE.json"), { schema: "pi-eval-loop/ctrl-confirm-2-holdout@1", batch, createdAt: new Date().toISOString(), selection: { ...SELECTION, rule: "sha256(seed:id) order; caps per repository (family) and account (owner); candidate-blind" }, pools: cand.pools, tasks, limitations: ["Public upstream code: absence from model pretraining data is not established.", "Overlap checks: exact commits, patch ids, repository names, file content hashes, texts of earlier experiments/records and of the pre-existing external pool's registry and reports; semantic near-duplicates are not detected.", "Tiers are a size proxy of the upstream fix, not measured difficulty."] });
  const seal = sealOf(tmpDir);
  if (seal.symlinks.length) throw new Error(`symlinks: ${seal.symlinks.join(", ")}`);
  atomicWriteJson(join(tmpDir, "SEAL.json"), { ...seal, batch, sealedAt: new Date().toISOString() });
  cpSync(tmpDir, dir, { recursive: true });
  rmSync(tmpDir, { recursive: true, force: true });
  loadLocal(dir); // structural check (task.json fields)
  const families = new Set(picked.map(c => c.family));
  const eligibility = { at: new Date().toISOString(), batch, dir, sealDigest: seal.digest, tasks: ids.length, families: families.size, owners: new Set(picked.map(c => c.owner)).size, taskIds: ids, perFamily: Object.fromEntries([...families].sort().map(f => [f, picked.filter(c => c.family === f).length])), decisions, reviewDigest: sha256(readFileSync(values.review)) };
  atomicWriteJson(join(out, `${batch}.ELIGIBILITY.json`), eligibility);
  process.stdout.write(`${JSON.stringify({ batch, sealDigest: seal.digest, tasks: ids.length, families: families.size })}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(code => process.exit(code), error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
