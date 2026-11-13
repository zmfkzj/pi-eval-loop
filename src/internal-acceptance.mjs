// internal-acceptance@1 (2026-11-14, user-approved; docs/internal-promotion.md section 10): batch eligibility of the opt-in
// internal promotion track, in its OWN namespace. Research pools, research protocols, exploration defaults and their
// registration are never written or reinterpreted here.
//
// What changes for internal acceptance only:
//   - the protocol (src/exploration.mjs internalAcceptanceProtocol): no hard-stratum quota, no cross-provider review quota;
//   - the pool: a SEPARATE internal pool (screening.internal.acceptance.pool) fed only by `internalIntake`;
//   - the exclusion rule: name-only cross-pool exclusion is replaced by an ACTUAL-EXPOSURE decision (exposureIndex + taskExposure),
//     re-applied at intake, at sealing, when a batch is offered, and immediately before a batch is consumed.
//
// What the engine verifies MECHANICALLY (fail closed: a missing, unreadable, malformed or tampered source blocks every decision):
//   - executed tasks: every task id in a runner ledger (runs.jsonl dispatch/result) under the configured runRoots, and every task of
//     a used batch whose own run ledger is not readable; their FAMILIES (any exposed family member blocks the family);
//   - consumed material: calibration-purpose batches, configured exposure datasets (dev, calibration, used holdouts), the screening
//     development tasks of every internal epoch, the internal pool's own batches (used or reserved);
//   - live reservations (a reserved, unused batch): refused, its exposure can still change;
//   - content exposure by name: any file under the configured contentRoots (review/adjudication/analysis output) naming the task;
//   - duplicates: hidden/reference file hashes and Exercism problem equivalence against exposed material; content fingerprint
//     against the internal pool (no second import of the same content under another id);
//   - origin provenance: the origin pool's hash chain, the case record and its content digest (the copied bytes are the recorded
//     ones), the origin's passing validation record, and a fresh grader validation of the copy.
// What needs ATTRIBUTABLE AUDIT evidence (the engine checks presence, identity, hashes and consistency, not the truth):
//   - source coverage: that runRoots/pools/datasets/contentRoots are every place the loop ran or showed tasks
//     (pi-eval-loop/internal-source-coverage@1, bound by sha256 in the config);
//   - per task: no model or analyst session ever saw its content, and the original selection was candidate-blind
//     (pi-eval-loop/internal-exposure-audit@1). "unknown", a missing entry or a conflict with a mechanical finding refuses the task.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadLocal, holdoutLedger, verifySeal } from "./datasets.mjs";
import { exercismProblem } from "./lineage.mjs";
import { INTERNAL_ACCEPTANCE_POLICY, internalAcceptanceProtocol, planTasks } from "./exploration.mjs";
import { caseDigest, evidenceContentProblems, firstEligibleBatch, mergeSupply, minimaOf, poolPath, poolState, priorHoldoutFamilies, registryOf, retireBatch, sealBatch, sealableCases } from "./supply.mjs";
import { acquireLock, atomicWriteJson, ensureDir, sha256, walkFiles } from "./util.mjs";

export const AUDIT_SCHEMA = "pi-eval-loop/internal-exposure-audit@1";
export const COVERAGE_SCHEMA = "pi-eval-loop/internal-source-coverage@1";
export const INTAKE_SCHEMA = "pi-eval-loop/internal-intake@1";
export const INTERNAL_POOL_EVIDENCE = Object.freeze(["validation.private.json", "intake.private.json"]);
const HEX = /^[0-9a-f]{64}$/;
const ORIGIN_STATUSES = new Set(["eligible", "withdrawn"]);
const SOURCE_KINDS = ["runRoots", "pools", "datasets", "contentRoots"];

/** The acceptance section of a config (or null): screening.internal.acceptance. */
export const acceptanceOf = (cfg) => cfg?.screening?.internal?.acceptance ?? null;
export const internalAcceptanceEnabled = (cfg) => cfg?.screening?.internal?.enabled === true && acceptanceOf(cfg)?.policy === INTERNAL_ACCEPTANCE_POLICY;

/** The pool holdout/acceptance batches come from: the internal pool under internal-acceptance@1, else the exploration pool. */
export const holdoutPoolOf = (cfg) => (internalAcceptanceEnabled(cfg) ? acceptanceOf(cfg).pool : cfg.pool);

/** Problems of screening.internal.acceptance (pure). */
export function acceptanceConfigProblems(c) {
  const a = acceptanceOf(c);
  if (a === null || a === undefined) return [];
  const p = [], abs = (v) => typeof v === "string" && v.startsWith("/");
  if (a.policy !== INTERNAL_ACCEPTANCE_POLICY) p.push(`screening.internal.acceptance.policy must be "${INTERNAL_ACCEPTANCE_POLICY}"`);
  if (!abs(a.pool)) p.push("screening.internal.acceptance.pool must be an absolute path (a separate internal pool)");
  else if (typeof c.pool === "string" && resolve(a.pool) === resolve(c.pool)) p.push("screening.internal.acceptance.pool must differ from the exploration/research pool");
  const s = a.sources;
  if (!s || typeof s !== "object") p.push("screening.internal.acceptance.sources {runRoots, pools, datasets, contentRoots} required");
  else for (const k of SOURCE_KINDS) {
    if (!Array.isArray(s[k])) p.push(`screening.internal.acceptance.sources.${k} must be an array of absolute paths`);
    else for (const x of s[k]) if (!abs(x)) p.push(`screening.internal.acceptance.sources.${k} entry ${String(x)} must be an absolute path`);
  }
  if (s && Array.isArray(s.runRoots) && !s.runRoots.length) p.push("screening.internal.acceptance.sources.runRoots must not be empty (no runner ledger = exposure unknown)");
  if (s && Array.isArray(s.pools) && abs(a.pool) && s.pools.some(x => resolve(x) === resolve(a.pool))) p.push("screening.internal.acceptance.sources.pools must not list the internal pool (it is always a source)");
  if (!a.coverage || !abs(a.coverage.document) || !HEX.test(a.coverage.sha256 ?? "")) p.push("screening.internal.acceptance.coverage {document: absolute path, sha256} required (attributable source-coverage statement)");
  return p;
}

// --------------------------------------------------------------------------------------------------------------- audit documents
function readDoc(path) { try { const bytes = readFileSync(path); return { bytes, json: JSON.parse(bytes.toString("utf8")) }; } catch (error) { return { error: String(error.message).slice(0, 160) }; } }
const auditorProblems = (a, where) => (!a || typeof a.name !== "string" || !a.name.trim() || !["human", "agent"].includes(a.kind) ? [`${where}: auditor {name, kind human|agent} required (attributable)`] : []);
const sameList = (x, y) => JSON.stringify([...(x ?? [])].map(v => resolve(v)).sort()) === JSON.stringify([...(y ?? [])].map(v => resolve(v)).sort());

/** Source-coverage statement: present, hash as configured, attributable, naming exactly the configured sources (else stale). */
export function coverageProblems(cfg) {
  const a = acceptanceOf(cfg), out = [];
  const d = readDoc(a.coverage.document);
  if (d.error) return [`source-coverage-missing: ${a.coverage.document} unreadable (${d.error})`];
  if (sha256(d.bytes) !== a.coverage.sha256) return [`source-coverage-stale: ${a.coverage.document} differs from the configured sha256`];
  const j = d.json;
  if (j.schema !== COVERAGE_SCHEMA) out.push(`source-coverage-invalid: schema ${COVERAGE_SCHEMA} required`);
  out.push(...auditorProblems(j.auditor, "source-coverage-invalid"));
  if (typeof j.statement !== "string" || !j.statement.trim()) out.push("source-coverage-invalid: statement required (every place this loop ran or showed tasks is listed)");
  for (const k of SOURCE_KINDS) if (!sameList(j.sources?.[k], a.sources[k])) out.push(`source-coverage-stale: the statement's sources.${k} differ from the configured ones`);
  return out;
}

// --------------------------------------------------------------------------------------------------------------- exposure index
function walk(root, visit, depth = 8) {
  const go = (dir, d) => { if (d > depth) return; for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") go(p, d + 1); } else if (e.isFile()) visit(p, e.name); } };
  go(root, 0);
}
/** Task ids dispatched or measured in one runner ledger (throws on a malformed line: fail closed). */
export function ledgerTasks(file) {
  const out = new Map();
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let e; try { e = JSON.parse(line); } catch { throw new Error(`run ledger malformed: ${file}:${i + 1}`); }
    if (e.type === "dispatch" && e.task) out.set(e.task, out.get(e.task) ?? null);
    if (e.type === "result" && e.record?.task_id) out.set(e.record.task_id, e.record.family ?? out.get(e.record.task_id) ?? null);
  });
  return out;
}
const fileHashes = (dir) => { const out = []; for (const sub of ["hidden", "reference"]) if (existsSync(join(dir, sub))) for (const f of walkFiles(join(dir, sub))) if (f.size > 64 && f.symlink === undefined) out.push(sha256(readFileSync(join(dir, sub, f.path)))); return out; };

/**
 * The actual-exposure index over every configured source plus the internal pool and every epoch's development tasks. Blockers
 * (missing/unreadable/tampered sources, exposed tasks without a known family) make every decision fail closed.
 */
export function exposureIndex(cfg, { devTasks = null } = {}) {
  const a = acceptanceOf(cfg), s = a.sources;
  const ids = new Map(), families = new Map(), live = new Map(), hashes = new Map(), problems = new Map(), famOf = new Map(), blockers = [];
  const exposeId = (id, why, family) => { if (!ids.has(id)) ids.set(id, why); if (family) famOf.set(id, family); const p = exercismProblem(id); if (p && !problems.has(p)) problems.set(p, `${why} (same Exercism problem)`); };
  const exposedDirs = [];
  for (const k of SOURCE_KINDS) for (const x of s[k]) if (!existsSync(x)) blockers.push(`source-missing: ${k} ${x}`);
  if (blockers.length) return { ids, families, live, hashes, problems, blockers, famOf };
  // Pools: case families, consumed material, live reservations; used batches resolved through their own run ledgers.
  const pools = [...s.pools, a.pool].filter(p => existsSync(join(p, "registry.jsonl")));
  for (const pool of pools) {
    let st; try { st = poolState(pool); } catch (error) { blockers.push(`source-unreadable: pool ${pool}: ${String(error.message).slice(0, 120)}`); continue; }
    if (st.chain.length) { blockers.push(`source-tampered: pool ${pool}: ${st.chain[0]}`); continue; }
    for (const r of st.cases.values()) if (r.family) famOf.set(r.caseId, r.family);
    const own = resolve(pool) === resolve(a.pool);
    for (const b of [...st.batches.values(), ...st.retired.values()]) {
      const dir = join(pool, "batches", b.batch);
      const uses = existsSync(join(dir, "USES.jsonl")) ? holdoutLedger(dir).records() : [];
      const where = `${own ? "internal" : "source"} pool ${pool} batch ${b.batch}`;
      const all = (why) => { for (const id of b.tasks) { exposeId(id, `${where} (${why})`); exposedDirs.push(join(dir, id)); } };
      if (b.purpose === "calibration") { all("calibration: measured"); continue; }
      if (own && (uses.length || st.reservedBatches.has(b.batch))) { all("internal acceptance batch"); continue; }
      if (uses.length) {
        // A used batch: exposure is what its passes dispatched, read from each use's own run ledger; unreadable = whole batch.
        const runFiles = uses.map(u => (typeof u.stateDir === "string" ? join(u.stateDir, "runs.jsonl") : null));
        if (runFiles.every(f => f && existsSync(f))) {
          for (const f of runFiles) {
            let m; try { m = ledgerTasks(f); } catch (error) { blockers.push(`source-unreadable: ${String(error.message).slice(0, 160)}`); continue; }
            for (const [id, fam] of m) { exposeId(id, `${where} (dispatched in ${f})`, fam); exposedDirs.push(join(dir, id)); }
          }
        } else all("used; a run ledger of its passes is not readable: whole batch treated as exposed");
      } else if (st.reservedBatches.has(b.batch)) { for (const id of b.tasks) if (!live.has(id)) live.set(id, `${where} (reserved, unused: exposure can still change)`); }
    }
  }
  // Runner ledgers anywhere under runRoots.
  for (const root of s.runRoots) {
    try { walk(root, (p, name) => { if (name !== "runs.jsonl") return; for (const [id, fam] of ledgerTasks(p)) exposeId(id, `executed (${p})`, fam); }); }
    catch (error) { blockers.push(`source-unreadable: runRoots ${root}: ${String(error.message).slice(0, 160)}`); }
  }
  // Datasets (dev, calibration, used holdouts) and every epoch's development tasks: shown or measured.
  for (const d of s.datasets) {
    let ts; try { ts = loadLocal(d); } catch (error) { blockers.push(`source-unreadable: dataset ${d}: ${String(error.message).slice(0, 120)}`); continue; }
    for (const t of ts) { exposeId(t.id, `exposure dataset ${d}`, t.family); exposedDirs.push(t.dir ?? join(d, t.id)); }
  }
  const dev = devTasks ?? [...(cfg.screening?.dev?.tasks ?? []), ...(cfg.screening?.exposedDevTasks ?? [])].filter(t => t.dataset);
  try { for (const t of planTasks(dev.map(x => ({ id: x.id, dataset: x.dataset })))) { exposeId(t.id, "development/regression task", t.family); exposedDirs.push(t.dir ?? join(t.dataset ?? "", t.id)); } }
  catch (error) { blockers.push(`source-unreadable: development tasks: ${String(error.message).slice(0, 120)}`); }
  // Families of every exposed task; an exposed task whose family is unknown leaves family exposure unknown (fail closed).
  const unresolved = [];
  for (const [id, why] of ids) { const f = famOf.get(id); if (f) { if (!families.has(f)) families.set(f, `${id}: ${why}`); } else unresolved.push(id); }
  if (unresolved.length) blockers.push(`family-unresolved: ${unresolved.length} exposed task id(s) without a known family (${unresolved.slice(0, 3).join(", ")}): add the pool or dataset that defines them to the sources`);
  for (const dir of exposedDirs) { try { for (const h of fileHashes(dir)) if (!hashes.has(h)) hashes.set(h, dir); } catch { /* absent copy: identity and family still excluded */ } }
  return { ids, families, live, hashes, problems, blockers, famOf };
}

/** Task ids named in any file under contentRoots (review/adjudication/analysis outputs): content exposure by name. */
export function contentMentions(cfg, ids) {
  const hits = new Map(), want = [...new Set(ids)].map(id => [id, id.toLowerCase()]);
  for (const root of acceptanceOf(cfg).sources.contentRoots) {
    walk(root, (p) => {
      const rel = relative(root, p).toLowerCase();
      let text = "";
      try { if (statSync(p).size < 4 * 1024 * 1024) text = readFileSync(p, "utf8").toLowerCase(); } catch { /* unreadable */ }
      for (const [id, low] of want) if (!hits.has(id) && (rel.includes(low) || text.includes(low))) hits.set(id, p);
    });
  }
  return hits;
}

/** Exposure decision of one task against an index (pure; [] = no mechanical exposure found). `self`: reasons of its own batch. */
export function taskExposure(index, { id, family, dir }, { contentHits = new Map(), self = null } = {}) {
  const out = [];
  if (index.blockers.length) out.push(...index.blockers.map(b => `exposure-unknown: ${b}`));
  const not = (why) => !self || !self(why);
  if (index.ids.has(id) && not(index.ids.get(id))) out.push(`exposed-task: ${index.ids.get(id)}`);
  if (family && index.families.has(family) && not(index.families.get(family))) out.push(`exposed-family: ${family} (${index.families.get(family)})`);
  if (index.live.has(id)) out.push(`live-reservation: ${index.live.get(id)}`);
  const p = exercismProblem(id);
  if (p && index.problems.has(p) && not(index.problems.get(p))) out.push(`exercism-equivalent: ${index.problems.get(p)}`);
  if (contentHits.has(id)) out.push(`content-exposed: named in ${contentHits.get(id)}`);
  if (dir) for (const h of fileHashes(dir)) if (index.hashes.has(h) && not(index.hashes.get(h))) { out.push(`duplicate-content: a hidden/reference file equals exposed material (${index.hashes.get(h)})`); break; }
  return out;
}

// --------------------------------------------------------------------------------------------------------------- audit + intake
/** Problems of an exposure audit document (presence, attribution, selection evidence hash). */
export function auditProblems(path, { originPool }) {
  const d = readDoc(path);
  if (d.error) return { problems: [`audit-missing: ${path} unreadable (${d.error})`] };
  const j = d.json, out = [];
  if (j.schema !== AUDIT_SCHEMA) out.push(`audit-invalid: schema ${AUDIT_SCHEMA} required`);
  out.push(...auditorProblems(j.auditor, "audit-invalid"));
  if (typeof j.at !== "string" || Number.isNaN(Date.parse(j.at))) out.push("audit-invalid: at (ISO time) required");
  if (!j.origin?.pool || resolve(j.origin.pool) !== resolve(originPool)) out.push("audit-conflict: origin.pool differs from the origin pool being imported");
  const sel = j.selection;
  if (sel?.candidateBlind !== true) out.push("audit-incomplete: selection.candidateBlind true required (the original selection did not depend on any candidate)");
  else { const sd = sel.document ? readDoc(sel.document) : { error: "no document" }; if (sd.error || sha256(sd.bytes) !== sel.sha256) out.push(`audit-evidence-mismatch: selection.document missing or its sha256 differs (${sd.error ?? "hash"})`); }
  if (!j.tasks || typeof j.tasks !== "object") out.push("audit-incomplete: tasks {<id>: {contentExposure, modelSessions, analystSessions}} required");
  return { problems: out, doc: j, sha256: sha256(d.bytes) };
}
function auditTaskProblems(entry) {
  if (!entry) return ["audit-incomplete: no audit entry for this task"];
  const out = [];
  for (const k of ["contentExposure", "modelSessions", "analystSessions"]) {
    if (entry[k] === "none") continue;
    out.push(entry[k] === undefined || entry[k] === "unknown" ? `audit-incomplete: ${k} ${entry[k] ?? "missing"}` : `audit-exposed: ${k} ${JSON.stringify(entry[k]).slice(0, 80)}`);
  }
  return out;
}

/** The origin of a case: its latest record, its content record, and the directory holding exactly the recorded bytes. */
export function originOf(originPool, id) {
  let st; try { st = poolState(originPool); } catch (error) { return { problems: [`origin-unreadable: ${String(error.message).slice(0, 120)}`] }; }
  if (st.chain.length) return { problems: [`origin-tampered: ${st.chain[0]}`] };
  const latest = st.cases.get(id);
  if (!latest) return { problems: ["origin-missing: no case record in the origin pool"] };
  const content = [...st.records].reverse().find(r => r.type === "case" && r.caseId === id && HEX.test(r.contentDigest ?? ""));
  if (!content) return { problems: ["origin-missing: no content digest recorded"] };
  const dirs = [join(originPool, "cases", id), ...st.records.filter(r => r.type === "evidence" && r.caseId === id).map(r => join(originPool, r.dir))];
  const dir = dirs.find(d => existsSync(join(d, "task.json")) && caseDigest(d) === content.contentDigest);
  if (!dir) return { problems: ["origin-content-mismatch: no copy in the origin pool matches the recorded content digest"] };
  const out = [];
  if (!ORIGIN_STATUSES.has(latest.status)) out.push(`origin-status: ${latest.status} (only eligible or withdrawn cases may be audited for internal use)`);
  const v = existsSync(join(dir, "validation.private.json")) ? evidenceContentProblems("validation.private.json", readFileSync(join(dir, "validation.private.json"), "utf8")) : ["validation.private.json missing"];
  if (v.length) out.push(`origin-validation: ${v[0]}`);
  return { problems: out, latest, content, dir, family: latest.family ?? content.family };
}

function ensureInternalPool(pool) {
  ensureDir(pool, 0o700);
  const f = join(pool, "POLICY.json");
  if (!existsSync(f)) writeFileSync(f, `${JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false, sealVia: "eval-loop-explore refresh (internal-acceptance@1)", requireEvidence: [...INTERNAL_POOL_EVIDENCE], policy: INTERNAL_ACCEPTANCE_POLICY }, null, 1)}\n`, { mode: 0o600, flag: "wx" });
  if (!existsSync(join(pool, "registry.jsonl"))) registryOf(pool).append({ type: "init", schema: INTAKE_SCHEMA, policy: INTERNAL_ACCEPTANCE_POLICY });
}

/**
 * Read-only audit worksheet (creates nothing): per task, the origin record and digest, every mechanical finding, and the
 * attestations the audit must carry. It never says a task is cleared: clearance needs the attributable audit at intake.
 */
export function auditReport(cfg, { originPool, ids }) {
  originPool = resolve(originPool);
  const index = exposureIndex(cfg);
  const contentHits = contentMentions(cfg, ids);
  const cov = coverageProblems(cfg);
  const tasks = ids.map(id => {
    const o = originOf(originPool, id);
    if (!o.dir) return { id, problems: [...cov, ...o.problems] };
    return { id, family: o.family, originStatus: o.latest.status, originCode: o.latest.code ?? null, contentDigest: o.content.contentDigest, problems: [...cov, ...o.problems, ...taskExposure(index, { id, family: o.family, dir: o.dir }, { contentHits })], mustAttest: ["contentExposure none", "modelSessions none", "analystSessions none", "selection.candidateBlind (document + sha256)"] };
  });
  return { schema: "pi-eval-loop/internal-audit-report@1", policy: INTERNAL_ACCEPTANCE_POLICY, originPool, at: new Date().toISOString(), blockers: [...cov, ...index.blockers], tasks, mechanicallyClear: tasks.filter(t => !t.problems.length).map(t => t.id), note: "mechanically clear is NOT cleared: intake additionally requires the attributable audit entry of each task and a passing fresh grader validation" };
}

/**
 * Import audited material into the internal pool (copy; the origin pool is only read). Every task needs: a verified origin
 * (chain, record, content digest, passing validation), an attributable audit entry with no exposure, no mechanical exposure,
 * no duplicate, and a passing fresh validation of the copy. Refusals are recorded with codes; nothing is deleted elsewhere.
 * @param {{ cfg: any, originPool: string, audit: string, ids: string[], validate: (dir: string, opts?: any) => Promise<any>, now?: Date }} o
 */
export async function internalIntake({ cfg, originPool, audit, ids, validate, now = new Date() }) {
  if (!internalAcceptanceEnabled(cfg)) throw new Error("internal intake: screening.internal.acceptance (internal-acceptance@1) is not configured");
  if (!validate) throw new Error("internal intake: a grader validator is required");
  const pool = poolPath(acceptanceOf(cfg).pool);
  originPool = resolve(originPool);
  if (originPool === resolve(pool)) throw new Error("internal intake: the origin pool cannot be the internal pool");
  const summary = { schema: INTAKE_SCHEMA, policy: INTERNAL_ACCEPTANCE_POLICY, originPool, at: now.toISOString(), imported: [], refused: {}, skipped: {} };
  const refuseAll = (why) => { for (const id of ids) summary.refused[id] = [why]; return summary; };
  if (!acceptanceOf(cfg).sources.pools.some(p => resolve(p) === originPool)) return refuseAll("source-coverage: the origin pool is not one of the configured exposure sources");
  const cov = coverageProblems(cfg);
  if (cov.length) return refuseAll(cov[0]);
  const au = auditProblems(audit, { originPool });
  if (au.problems.length) return refuseAll(au.problems[0]);
  ensureInternalPool(pool);
  const lock = acquireLock(join(pool, ".pool.lock"));
  try {
    const reg = registryOf(pool);
    if (reg.verify().length) throw new Error(`internal pool registry tampered: ${reg.verify()[0]}`);
    const st = poolState(pool);
    const index = exposureIndex(cfg);
    const contentHits = contentMentions(cfg, ids);
    const fingerprints = new Map([...st.cases.values()].filter(r => r.status === "eligible" || st.batched.has(r.caseId)).map(r => [r.origin?.contentDigest ?? r.contentDigest, r.caseId]));
    // Renamed copies: hidden/reference file hashes of everything already imported (staged cases and sealed batches).
    const imported = new Map();
    const addImported = (dir, id) => { try { for (const h of fileHashes(dir)) if (!imported.has(h)) imported.set(h, id); } catch { /* unreadable copy */ } };
    for (const r of st.cases.values()) if (r.status === "eligible") addImported(join(pool, "cases", r.caseId), r.caseId);
    for (const b of [...st.batches.values(), ...st.retired.values()]) for (const id of b.tasks) addImported(join(pool, "batches", b.batch, id), id);
    for (const id of [...new Set(ids)].sort()) {
      const prior = st.cases.get(id);
      if (prior && prior.status !== "rejected") { summary.skipped[id] = `already in the internal pool (${prior.status})`; continue; }
      const o = originOf(originPool, id);
      const problems = [...o.problems];
      if (o.dir) {
        const entry = au.doc.tasks?.[id];
        problems.push(...auditTaskProblems(entry));
        if (entry?.contentDigest && entry.contentDigest !== o.content.contentDigest) problems.push("audit-conflict: the audit names another content digest");
        if (fingerprints.has(o.content.contentDigest)) problems.push(`duplicate-import: the same content is already imported as ${fingerprints.get(o.content.contentDigest)}`);
        else { const h = fileHashes(o.dir).find(x => imported.has(x)); if (h) problems.push(`duplicate-import: a hidden/reference file equals the imported ${imported.get(h)}`); }
        problems.push(...taskExposure(index, { id, family: o.family, dir: o.dir }, { contentHits }));
        if (contentHits.has(id) && entry?.contentExposure === "none") problems.push("audit-conflict: the audit says no content exposure, a content root names the task");
      }
      const reject = (list) => { summary.refused[id] = list; reg.append({ type: "case", caseId: id, status: "rejected", code: list[0].split(":")[0], source: "internal-intake", origin: { pool: originPool, caseId: id }, problems: list.slice(0, 6), audit: { document: resolve(audit), sha256: au.sha256 } }); };
      if (problems.length) { reject(problems); continue; }
      const dir = join(pool, "cases", id);
      rmSync(dir, { recursive: true, force: true }); ensureDir(dir);
      for (const part of ["task.json", "repo", "hidden", "reference", "review"]) if (existsSync(join(o.dir, part))) cpSync(join(o.dir, part), join(dir, part), { recursive: true });
      if (caseDigest(dir) !== o.content.contentDigest) { rmSync(dir, { recursive: true, force: true }); reject(["origin-content-mismatch: the copy differs from the recorded content"]); continue; }
      let m; try { m = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")); } catch { rmSync(dir, { recursive: true, force: true }); reject(["task-json-unreadable"]); continue; }
      const v = await validate(dir, { visibleSuite: m.visibleSuite === "none" ? "none" : "required" });
      if (!v?.ok) { rmSync(dir, { recursive: true, force: true }); reject([`grader-invalid: fresh validation failed (${v?.code ?? "?"})`]); continue; }
      atomicWriteJson(join(dir, "validation.private.json"), v);
      const intake = { schema: INTAKE_SCHEMA, policy: INTERNAL_ACCEPTANCE_POLICY, at: now.toISOString(), origin: { pool: originPool, caseId: id, status: o.latest.status, code: o.latest.code ?? null, contentDigest: o.content.contentDigest, recordSeq: o.content.seq, dir: relative(originPool, o.dir) }, audit: { document: resolve(audit), sha256: au.sha256, auditor: au.doc.auditor, entry: au.doc.tasks[id] }, coverage: { ...acceptanceOf(cfg).coverage }, mechanical: { exposure: "none found", checkedAt: now.toISOString() } };
      atomicWriteJson(join(dir, "intake.private.json"), intake);
      reg.append({ type: "case", caseId: id, status: "eligible", code: "internal-audited", source: "internal-intake", family: m.family, tier: m.tier, difficultyBasis: m.difficultyBasis ?? "size-proxy", contentDigest: caseDigest(dir), origin: intake.origin, audit: { document: intake.audit.document, sha256: au.sha256 }, policy: INTERNAL_ACCEPTANCE_POLICY });
      fingerprints.set(o.content.contentDigest, id); addImported(dir, id);
      summary.imported.push({ id, family: m.family });
    }
    return summary;
  } finally { lock.release(); }
}

// --------------------------------------------------------------------------------------------------------------- re-checks
/** The audit and coverage evidence of an imported case still verify (hashes as recorded at intake). */
function intakeEvidenceProblems(cfg, dir, record) {
  const f = join(dir, "intake.private.json");
  if (!existsSync(f)) return ["intake-evidence-missing"];
  let j; try { j = JSON.parse(readFileSync(f, "utf8")); } catch { return ["intake-evidence-unreadable"]; }
  if (j.policy !== INTERNAL_ACCEPTANCE_POLICY) return [`intake-policy: ${j.policy}`];
  const d = readDoc(j.audit?.document ?? "");
  if (d.error || sha256(d.bytes) !== j.audit.sha256 || (record?.audit?.sha256 && record.audit.sha256 !== j.audit.sha256)) return ["audit-drift: the audit document changed or disappeared after intake"];
  if (j.coverage?.sha256 !== acceptanceOf(cfg).coverage.sha256) return ["source-coverage-stale: the coverage statement changed since intake (re-audit)"];
  return [];
}

/** Problems of one internal batch now (actual exposure, audit drift): [] = usable. The batch's own records are not exposure. */
export function internalBatchProblems(cfg, batch, { index = null } = {}) {
  const pool = acceptanceOf(cfg).pool;
  const st = poolState(pool);
  const b = st.batches.get(batch);
  if (!b) return [`${batch}: not a live batch of the internal pool`];
  const cov = coverageProblems(cfg);
  if (cov.length) return cov;
  index ??= exposureIndex(cfg);
  const dir = join(pool, "batches", batch);
  let tasks; try { tasks = loadLocal(dir); } catch (error) { return [`${batch}: unreadable (${error.message})`]; }
  const contentHits = contentMentions(cfg, tasks.map(t => t.id));
  const self = (why) => why.includes(`batch ${batch} `) || why.endsWith(`batch ${batch}`);
  const out = [];
  for (const t of tasks) {
    const ev = [...st.records].reverse().find(r => r.type === "evidence" && r.caseId === t.id && r.batch === batch);
    const evDir = ev ? join(pool, ev.dir) : join(pool, "cases", t.id);
    out.push(...intakeEvidenceProblems(cfg, evDir, st.cases.get(t.id)).map(p => `${t.id}: ${p}`));
    out.push(...taskExposure(index, { id: t.id, family: t.family, dir: join(dir, t.id) }, { contentHits, self }).map(p => `${t.id}: ${p}`));
  }
  return out;
}

/** Exposed families for the holdout pass's prior-family rule: actual exposure + the internal pool's own used/reserved batches. */
export function internalPriorFamilies(cfg, excludeBatch) {
  const pool = acceptanceOf(cfg).pool, index = exposureIndex(cfg);
  if (index.blockers.length) throw new Error(`internal exposure index: ${index.blockers[0]}`);
  const out = new Set();
  const self = (why) => why.includes(`batch ${excludeBatch} `) || why.endsWith(`batch ${excludeBatch}`);
  for (const [f, why] of index.families) if (!self(why)) out.add(f);
  for (const f of priorHoldoutFamilies({ pool, exclude: join(pool, "batches", excludeBatch) })) out.add(f);
  return out;
}

/** Seal one internal batch from audited cases that are still unexposed (under the pool lock; rule document written once). */
export function internalSeal(cfg, { now = new Date() } = {}) {
  const pool = acceptanceOf(cfg).pool;
  if (!existsSync(join(pool, "registry.jsonl"))) return { blocked: "internal pool is empty (no audited intake yet)" };
  const cov = coverageProblems(cfg);
  if (cov.length) return { blocked: cov[0] };
  const index = exposureIndex(cfg);
  if (index.blockers.length) return { blocked: `exposure unknown: ${index.blockers[0]}` };
  const st = poolState(pool);
  const cand = sealableCases(pool, st, { requireEvidence: [...INTERNAL_POOL_EVIDENCE] });
  const contentHits = contentMentions(cfg, cand.map(r => r.caseId));
  const excluded = new Map();
  for (const r of cand) {
    const dir = join(pool, "cases", r.caseId);
    const p = [...intakeEvidenceProblems(cfg, dir, r), ...taskExposure(index, { id: r.caseId, family: r.family, dir }, { contentHits })];
    if (p.length) excluded.set(r.caseId, p);
  }
  const protocol = internalAcceptanceProtocol(cfg.route);
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const out = join(ensureDir(join(pool, "selection"), 0o700), `${stamp}-internal-rule.json`);
  writeFileSync(out, `${JSON.stringify({ schema: "pi-eval-loop/internal-selection@1", policy: INTERNAL_ACCEPTANCE_POLICY, at: now.toISOString(), minima: minimaOf(protocol), batchRule: cfg.batchRule ?? null, excluded: Object.fromEntries(excluded), coverage: acceptanceOf(cfg).coverage }, null, 1)}\n`, { mode: 0o400, flag: "wx" });
  const allowed = new Set(cand.map(c => c.caseId));
  const sealed = sealBatch({ pool, cfg: mergeSupply({ batch: cfg.batchRule ?? {} }), minima: minimaOf(protocol), now, requireEvidence: [...INTERNAL_POOL_EVIDENCE], exclude: (r) => excluded.has(r.caseId) || !allowed.has(r.caseId), policy: INTERNAL_ACCEPTANCE_POLICY });
  return { ...sealed, rule: out, excluded: excluded.size };
}

/** Retire every live, never-reserved internal batch that is no longer usable (exposure or audit drift); evidence kept. */
export function internalRetire(cfg, { now = new Date() } = {}) {
  const pool = acceptanceOf(cfg).pool;
  if (!existsSync(join(pool, "registry.jsonl"))) return [];
  const st = poolState(pool), out = [];
  const index = exposureIndex(cfg);
  if (index.blockers.length) return out; // unknown exposure never retires (nor offers) anything
  for (const b of st.batches.values()) {
    if (st.reservedBatches.has(b.batch)) continue;
    const problems = internalBatchProblems(cfg, b.batch, { index });
    if (!problems.length) continue;
    const doc = join(ensureDir(join(pool, "retired"), 0o700), `${b.batch}-internal-${now.toISOString().replace(/[-:.]/g, "")}.json`);
    writeFileSync(doc, `${JSON.stringify({ schema: "pi-eval-loop/batch-retirement@1", at: now.toISOString(), batch: b.batch, why: "internal-acceptance@1 re-check before use", problems }, null, 1)}\n`, { mode: 0o400, flag: "wx" });
    retireBatch({ pool, batch: b.batch, code: "internal-exposure-recheck", reason: problems[0].slice(0, 200), evidence: { document: doc, sha256: sha256(readFileSync(doc)) } });
    out.push(b.batch);
  }
  return out;
}

/** The internal batch a cycle would use (read-only): first eligible under internal-acceptance@1 and clean on the re-check. */
export function internalNextBatch(cfg, { orcheDir }) {
  const pool = acceptanceOf(cfg).pool;
  if (!existsSync(join(pool, "registry.jsonl"))) return { none: ["internal pool is empty (no audited intake yet)"] };
  const cov = coverageProblems(cfg);
  if (cov.length) return { none: cov };
  const pick = firstEligibleBatch(pool, internalAcceptanceProtocol(cfg.route), { orcheDir });
  if (pick.none) return pick;
  if (!verifySeal(pick.dir).ok) return { none: [`${pick.batch}: seal broken`] };
  const p = internalBatchProblems(cfg, pick.batch);
  return p.length ? { none: [`${pick.batch}: internal re-check failed (a refresh retires it): ${p[0]}`] } : pick;
}

/** Pool overview of the internal track (read-only). */
export function internalSupply(cfg) {
  const a = acceptanceOf(cfg), pool = a.pool;
  const base = { policy: INTERNAL_ACCEPTANCE_POLICY, pool, notRequired: internalAcceptanceProtocol(cfg.route).policy.waived, retained: ["sealed batches", "validated graders", "provenance + origin digest", "one use", "protected results", "actual-exposure exclusion (task + family + content + duplicates)", ">= 6 tasks and >= 4 families", "owner share <= 0.5"], sizes: "operational defaults, unvalidated", blockers: [...coverageProblems(cfg)] };
  if (!existsSync(join(pool, "registry.jsonl"))) return { ...base, cases: {}, batches: [], blockers: [...base.blockers, "internal pool empty"] };
  const st = poolState(pool), byCode = {};
  for (const r of st.cases.values()) { const k = `${r.status}:${r.code ?? "-"}`; byCode[k] = (byCode[k] ?? 0) + 1; }
  const sealable = sealableCases(pool, st, { requireEvidence: [...INTERNAL_POOL_EVIDENCE] });
  const owners = {}; for (const r of sealable) { const o = String(r.family).replace(/^gh:/, "").split("/")[0]; owners[o] = (owners[o] ?? 0) + 1; }
  const index = exposureIndex(cfg);
  return { ...base, cases: byCode, sealable: { tasks: sealable.length, families: new Set(sealable.map(r => r.family)).size, owners }, batches: [...st.batches.values()].map(b => ({ batch: b.batch, tasks: b.tasks.length, reserved: st.reservedBatches.has(b.batch), used: existsSync(join(pool, "batches", b.batch, "USES.jsonl")) && holdoutLedger(join(pool, "batches", b.batch)).records().length > 0 })), blockers: [...base.blockers, ...index.blockers], exposure: { tasks: index.ids.size, families: index.families.size, liveReservations: index.live.size } };
}
