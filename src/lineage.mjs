// Cross-pool lineage exclusion and the only sealing route of an exploration pool (2026-11-07; generalized from
// studies/exploratory-1/select-supply.mjs, which now keeps only its study defaults). A pool whose POLICY.json says
// {autoSeal: false} is never sealed by collectors or the generic `seal` (src/supply-cli.mjs); batches are formed here, after
// every exclusion source was read:
//   - every configured earlier supply registry (families, repositories and task ids),
//   - every configured earlier holdout dataset (families and task ids),
//   - every live batch of the pool itself (holdout or calibration; reserved and used included) and the tasks of retired batches
//     that were not restaged,
//   - the screening (development) tasks,
//   - Exercism problem equivalence: an exercise taken anywhere above forbids the same problem in every track.
// A missing source, a malformed registry line or an unreadable dataset aborts before anything is withdrawn or sealed (fail
// closed). The rule document is written once (refused if it exists), hashed, and its sha256 is the withdrawal evidence; the
// selection outcome goes to a separate <rule>.result.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLocal } from "./datasets.mjs";
import { mergeSupply, poolState, sealableCases, sealBatch, withdrawCase } from "./supply.mjs";
import { Ledger, sha256 } from "./util.mjs";
import { exploreProtocol, planTasks } from "./exploration.mjs";

export const BATCH_RULE = Object.freeze({ seed: "exploratory-1", maxTasks: 8, maxPerFamily: 2, maxPerOwner: 4, maxOwnerShare: 0.5, preferFreshFamilies: true });
export const RULE_TEXT = "withdraw every eligible unbatched case whose family, or Exercism problem in any track, occurs in an earlier supply registry, holdout dataset, live pool batch (holdout or calibration, reserved and used included), a retired batch's unrestaged tasks or the screening plan; every source must be readable (fail closed)";

const EXERCISM = /^x-exercism-[a-z]+-(.+)$/;
/** The canonical Exercism problem of a task id (a TypeScript port shares the problem of the JavaScript one), else null. */
export const exercismProblem = (id) => EXERCISM.exec(String(id ?? ""))?.[1] ?? null;

/** Families, repository slugs and task ids of a supply registry. Missing file or malformed line throws. */
export function readRegistry(path) {
  if (!existsSync(path)) throw new Error(`lineage source missing: ${path}`);
  // A supply registry is a hash-chained ledger: a broken or rewritten chain is not an exclusion source anyone can rely on.
  let chain; try { chain = new Ledger(path).verify(); } catch (error) { throw new Error(`lineage source unverifiable: ${path}: ${error.message}`); }
  if (chain.length) throw new Error(`lineage source chain broken: ${path}: ${chain[0]}`);
  const families = new Set(), ids = new Set(), repos = new Set();
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let e; try { e = JSON.parse(line); } catch { throw new Error(`lineage source malformed: ${path}:${i + 1}`); }
    if (e.family) families.add(e.family);
    if (typeof e.family === "string" && e.family.startsWith("gh:")) repos.add(e.family.slice(3).toLowerCase());
    if (e.repo) { families.add(`gh:${String(e.repo).toLowerCase()}`); repos.add(String(e.repo).toLowerCase()); }
    if (e.caseId) ids.add(e.caseId);
    for (const t of Array.isArray(e.tasks) ? e.tasks : []) ids.add(t);
  });
  return { families, ids, repos };
}

/** Validate a lineage source list ({registries: string[], datasets: string[]}): both arrays, absolute paths, not empty. */
export function sourcesProblems(sources) {
  const out = [];
  if (!sources || typeof sources !== "object") return ["lineage sources: {registries: [...], datasets: [...]} required"];
  for (const k of ["registries", "datasets"]) {
    if (!Array.isArray(sources[k]) || !sources[k].length) out.push(`lineage sources: ${k} must be a non-empty array (an empty inventory would exclude nothing)`);
    else for (const p of sources[k]) if (typeof p !== "string" || !p.startsWith("/")) out.push(`lineage sources: ${k} entry ${String(p)} must be an absolute path`);
  }
  return out;
}

/**
 * The forbidden keys (family or `exercism-problem:<slug>`) with the first source naming each. `excludeBatch`: a batch of the
 * pool left out (the batch a pass is about to use is checked against everything else).
 * @returns {Map<string, string>}
 */
export function forbiddenSet({ pool, screenPlan, sources, excludeBatch = null }) {
  const sp = sourcesProblems(sources);
  if (sp.length) throw new Error(sp.join("; "));
  if (!Array.isArray(screenPlan?.tasks) || !screenPlan.tasks.length) throw new Error("lineage: the screening tasks are a required exclusion source");
  const fam = new Map();
  const add = (k, why) => { if (k && !fam.has(k)) fam.set(k, why); };
  const addTask = (family, id, why) => { add(family, why); if (id) add(`task:${id}`, why); const p = exercismProblem(id); if (p) add(`exercism-problem:${p}`, `${why} (same Exercism problem)`); };
  for (const r of sources.registries) { const { families, ids } = readRegistry(r); for (const f of families) add(f, `registry ${r}`); for (const id of ids) addTask(null, id, `registry ${r}`); }
  for (const d of sources.datasets) {
    let tasks; try { tasks = loadLocal(d); } catch (error) { throw new Error(`lineage source unreadable: ${d}: ${error.message}`); }
    if (!tasks.length) throw new Error(`lineage source empty: ${d}`);
    for (const t of tasks) addTask(t.family, t.id, `dataset ${d}`);
  }
  const st = poolState(pool);
  if (st.chain.length) throw new Error(`pool registry tampered: ${st.chain.join("; ")}`);
  for (const b of st.batches.values()) { if (b.batch === excludeBatch) continue; for (const id of b.tasks) addTask(st.cases.get(id)?.family, id, `pool batch ${b.batch} (${b.purpose ?? "holdout"}${st.reservedBatches.has(b.batch) ? ", reserved" : ""})`); }
  for (const b of st.retired.values()) for (const id of b.tasks) if (!(b.retire.restaged ?? []).includes(id)) addTask(st.cases.get(id)?.family, id, `retired batch ${b.batch} (not restaged)`);
  for (const t of planTasks(screenPlan?.tasks ?? [])) addTask(t.family, t.id, "screening (development) task");
  return fam;
}

const keyOf = (forbidden, family, id) => forbidden.has(family) ? family : forbidden.has(`task:${id}`) ? `task:${id}` : (exercismProblem(id) && forbidden.has(`exercism-problem:${exercismProblem(id)}`) ? `exercism-problem:${exercismProblem(id)}` : null);

/** The withdrawal list: sealable cases whose family or Exercism problem is forbidden. */
export function lineageHits(pool, forbidden) {
  const sealable = sealableCases(pool, poolState(pool));
  return { sealable, hits: sealable.filter(r => keyOf(forbidden, r.family, r.caseId)).map(r => { const key = keyOf(forbidden, r.family, r.caseId); return { caseId: r.caseId, family: r.family, key, why: forbidden.get(key) }; }) };
}

/** Tasks of a sealed batch that are forbidden by every source except the batch itself (re-checked right before a pass uses it). */
export function batchLineageProblems({ pool, batch, screenPlan, sources }) {
  const st = poolState(pool);
  const b = st.batches.get(batch);
  if (!b) return [`batch ${batch} is not a live batch of the pool`];
  const forbidden = forbiddenSet({ pool, screenPlan, sources, excludeBatch: batch });
  return b.tasks.map(id => ({ id, key: keyOf(forbidden, st.cases.get(id)?.family, id) })).filter(x => x.key).map(x => `${x.id}: ${x.key} occurs in ${forbidden.get(x.key)}`);
}

/** Repository slugs and accounts named by the lineage registries (discovery skips them: their families are forbidden anyway). */
export function lineageRepos(sources) {
  const repos = new Set();
  for (const r of sources.registries) for (const s of readRegistry(r).repos) repos.add(s);
  return repos;
}

export function minimaOfExplore() {
  const p = exploreProtocol();
  return { minTasks: p.holdout.minTasks, minFamilies: p.holdout.minFamilies, requireHard: p.adoption.requireHardStratum, hardBasis: p.holdout.hardBasis };
}

/**
 * Exclusions, then the seal. The rule document is written once (refused if it exists) and its sha256 is the withdrawal evidence.
 * @returns {{ rule: string, ruleSha256: string, withdrawn: any[], sealed: any, result: string }}
 */
export function selectAndSeal({ pool, screenPlan, screenPlanPath = null, out, sources, batchRule = BATCH_RULE, minima = minimaOfExplore(), requireEvidence = [], at = new Date().toISOString(), now = new Date() }) {
  pool = resolve(pool); out = resolve(out);
  if (existsSync(out)) throw new Error(`rule document ${out} exists (immutable once written)`);
  const forbidden = forbiddenSet({ pool, screenPlan, sources });
  const { hits } = lineageHits(pool, forbidden);
  const rule = { schema: "pi-eval-loop/exploratory-lineage@1", at, rule: RULE_TEXT, sources, screenPlan: screenPlanPath, forbiddenKeys: forbidden.size, withdrawn: hits, batchRule, minima, requireEvidence };
  writeFileSync(out, `${JSON.stringify(rule, null, 1)}\n`, { mode: 0o400, flag: "wx" });
  const evidence = { document: out, sha256: sha256(readFileSync(out)) };
  for (const h of hits) withdrawCase({ pool, caseId: h.caseId, code: "lineage-forbidden-family", reason: `${h.key === h.family ? `family ${h.family}` : h.key} occurs in ${h.why}`, evidence });
  // Defence in depth: nothing forbidden may remain sealable after the withdrawals.
  const left = lineageHits(pool, forbidden).hits;
  if (left.length) throw new Error(`lineage: still sealable after withdrawal: ${left.map(h => h.caseId).join(", ")}`);
  // The seal re-applies the same exclusion under the pool lock (a case staged between the withdrawals and the seal is judged too).
  const sealed = sealBatch({ pool, cfg: mergeSupply({ batch: batchRule }), minima, now, requireEvidence, exclude: (r) => !!keyOf(forbidden, r.family, r.caseId) });
  const result = out.replace(/\.json$/, "") + ".result.json";
  writeFileSync(result, `${JSON.stringify({ schema: "pi-eval-loop/exploratory-selection@1", rule: evidence, withdrawn: hits.map(h => h.caseId), sealed }, null, 1)}\n`, { mode: 0o600 });
  return { rule: out, ruleSha256: evidence.sha256, withdrawn: hits, sealed, result };
}
