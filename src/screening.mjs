// Practical candidate-screening route (2026-11-08; exploration@1 config with `mode: "screening"`, driven by agent_workflow
// `evaluation: "screening"`). A NON-ADOPTING, fixed-budget staged workflow over a bounded candidate source:
//
//   1. smoke   (every candidate, model-free): materialize the frozen tree, dedupe by content identity, static patch limits,
//              the arms' own checks (typecheck + tests, candidate vs stable). Failure ends the candidate here, cheaply.
//   2. dev     (candidates that pass smoke): ONE paired stable-vs-candidate pass on a small, REUSABLE, previously exposed
//              development task list (frozen in the config), interleaved, early elimination on a candidate integrity problem.
//              Its result is selection feedback only (evidence class "development"), never independent confirmation.
//   3. holdout (only candidates the frozen dev rule qualified, at most once per candidate): ONE exploration-only pass on one fresh,
//              sealed, unused, lineage-clean batch (src/exploration.mjs runHoldout, every existing safeguard), admitted only when the
//              remaining caps cover it and fresh supply exists; otherwise the candidate waits (no target call).
//
// The best possible result is EXPLORATORY_SUPPORTED with adopt false: nothing is ever adopted, deployed, promoted, committed or
// scheduled from here (the stable reference never changes). Strong confirmatory/adoptive modes are separate and untouched.
//
// Budget: every target attempt is admitted by the ONE durable ledger of the config (request-budget.mjs; its ceiling, e.g. a series
// total shared with proposals and reviews, is fixed at creation and never changed here) through the isolated runtime's outbound
// gate. On top of it, `CappedBudget` refuses any reservation that would push this route's charged attempts (settled usage +
// open worst cases, read from the same durable ledger) past the per-stage, per-candidate, per-cycle or cumulative caps of the
// config, or that starts after the stage's persisted deadline. Charged attempts bound actual attempts (the gate admits an
// attempt only within the gate-covered charged total), so the caps bound actual provider attempts of this route. Exhaustion never expands anything: it is a durable wait or stop.
//
// One cycle (one state directory) runs one action: smoke(+dev) of the next candidate in fair rotation, or the holdout of one
// qualified candidate. The series registry (hash-chained, keyed by the candidate's runtime digest) persists dedupe, claims and
// stage results across rotated cycle directories, so a retry or a new cycle never repeats a paid stage or a holdout.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { Evaluator, simulatedBackend } from "./evaluator.mjs";
import { exploreProtocol, harnessOf, planTasks, runtimeDigest, RUNTIME } from "./exploration.mjs";
import { attemptAdmission } from "./admission.mjs";
import { criticalProblems } from "./gate.mjs";
import { finalAttempts } from "./metrics.mjs";
import { interleavedSchedule, scheduleProblems } from "./design.mjs";
import { merge, routeKey, sameRoute } from "./protocol.mjs";
import { patchKey } from "./archive.mjs";
import { loadLocal, verifySeal } from "./datasets.mjs";
import { poolState } from "./supply.mjs";
import { exercismProblem, readRegistry } from "./lineage.mjs";
import { acquireLock, atomicWriteJson, digestOf, ensureDir, fault, Ledger, LockBusyError, readJson, sha256 } from "./util.mjs";
import { abandonAssessment, acceptanceDecision, noProgress, recordAcceptance, acceptanceRepeats, assessmentPlan, candidateDemand, finishAssessment, INTERNAL_EVIDENCE, ASSESSMENT_EVIDENCE, internalEnabled, internalPaths, pendingAssessment, promote, reconcile, rollback as internalRollback, stageFit } from "./internal-promotion.mjs";

export const ROUTE = "screening";
export const REGISTRY_SCHEMA = "pi-eval-loop/screening-registry@1";
export const DEV_SCHEMA = "pi-eval-loop/screening-dev@1";
export const SMOKE_SCHEMA = "pi-eval-loop/screening-smoke@1";
/** Stage verdicts of this route (status@1 final.verdict). Holdout verdicts are the exploration ones (KEEP_STABLE, ...). */
export const VERDICTS = Object.freeze({ smokeRejected: "SMOKE_REJECTED", devRejected: "DEV_REJECTED", devNegative: "DEV_NEGATIVE", devInconclusive: "DEV_INCONCLUSIVE", devPromising: "DEV_PROMISING" });
/** Archive statuses a candidate needs to enter the queue by default (it passed the earlier loop's own screening). */
export const DEFAULT_ARCHIVE_INCLUDE = Object.freeze(["promoted", "dev_qualified", "selected", "holdout_blocked", "inconclusive"]);
/** Codes of this route that are model-free waits (retryable); every other block code stops for a human. */
export const SCREENING_WAIT_CODES = Object.freeze(["no-candidate", "dev-supply-empty", "supply-empty", "supply-wait", "supply-error", "runtime-wait"]);
/** Dataset purposes that make a task prospectively development material (never a holdout). */
export const DEV_PURPOSES = Object.freeze(["calibration", "development"]);
const CAP_KEYS = ["dev", "holdout", "perCandidate", "perCycle", "cumulative"];
const DEV_EVIDENCE = Object.freeze({ class: "development", confirmatoryClaim: false, generalizedClaim: false, note: "selection feedback on a small, reusable, previously exposed development task list: never independent confirmation, never an adoption" });

// ------------------------------------------------------------------------------------------------------------------ config
/** Problems of the `screening` section (pure). Every path absolute; every cap and bound explicit (no default allowance). */
export function screeningConfigProblems(c) {
  const p = [];
  const sc = c.screening;
  const abs = (v, k) => { if (typeof v !== "string" || !v.startsWith("/")) p.push(`${k} must be an absolute path`); };
  const posInt = (v, k) => { if (!(Number.isInteger(v) && v > 0)) p.push(`${k} must be a positive integer`); };
  const pos = (v, k) => { if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) p.push(`${k} must be a positive number`); };
  if (!sc || typeof sc !== "object") return ["mode screening needs a screening section"];
  abs(sc.registry, "screening.registry"); abs(sc.workDir, "screening.workDir"); abs(c.stable?.dir, "stable.dir");
  if (!/^[0-9a-f]{64}$/.test(c.stable?.runtimeDigest ?? "")) p.push("stable.runtimeDigest (frozen sha256) required");
  if (typeof c.stable?.commit !== "string") p.push("stable.commit required (the archive patch chains must reach it)");
  const src = sc.candidates?.sources;
  if (!Array.isArray(src) || !src.length) p.push("screening.candidates.sources (non-empty list) required");
  else src.forEach((s, i) => {
    if (s?.kind === "archive") { abs(s.dir, `screening.candidates.sources[${i}].dir`); if (s.include !== undefined && !(Array.isArray(s.include) && s.include.every(x => typeof x === "string"))) p.push(`screening.candidates.sources[${i}].include must be a list of statuses`); }
    else if (s?.kind === "tree") { abs(s.dir, `screening.candidates.sources[${i}].dir`); if (typeof s.id !== "string" || !/^[0-9a-f]{64}$/.test(s.identity?.runtimeDigest ?? "") || typeof s.identity?.commit !== "string") p.push(`screening.candidates.sources[${i}]: tree needs id and identity {runtimeDigest, commit}`); }
    else p.push(`screening.candidates.sources[${i}].kind must be archive or tree`);
  });
  posInt(sc.candidates?.maxCandidates, "screening.candidates.maxCandidates");
  if (sc.history !== undefined && !(Array.isArray(sc.history) && sc.history.every(h => (/^[0-9a-f]{64}$/.test(h?.runtimeDigest ?? "") || /^[0-9a-f]{64}$/.test(h?.archivePkey ?? "")) && typeof h.at === "string" && !Number.isNaN(Date.parse(h.at)) && typeof h.note === "string"))) p.push("screening.history must be [{runtimeDigest | archivePkey, at, note}] (holdout exposures before this route)");
  if (!Array.isArray(sc.dev?.tasks) || !sc.dev.tasks.length || !sc.dev.tasks.every(t => typeof t?.id === "string" && typeof t.dataset === "string" && t.dataset.startsWith("/"))) p.push("screening.dev.tasks [{id, dataset (absolute)}] required");
  posInt(sc.dev?.repeats, "screening.dev.repeats");
  if (sc.dev?.minTasks !== undefined && !(Number.isInteger(sc.dev.minTasks) && sc.dev.minTasks > 0 && sc.dev.minTasks <= (sc.dev.tasks?.length ?? 0))) p.push("screening.dev.minTasks must be an integer in 1..dev.tasks.length");
  if (sc.dev?.exclusions !== undefined && !(Array.isArray(sc.dev.exclusions) && sc.dev.exclusions.every(x => typeof x?.file === "string" && x.file.startsWith("/") && /^[0-9a-f]{64}$/.test(x.sha256 ?? "")))) p.push("screening.dev.exclusions must be [{file (absolute), sha256}]");
  if (sc.exposedDevTasks !== undefined && !(Array.isArray(sc.exposedDevTasks) && sc.exposedDevTasks.every(t => typeof t?.id === "string" && typeof t.dataset === "string" && t.dataset.startsWith("/")))) p.push("screening.exposedDevTasks must be [{id, dataset (absolute), note}]");
  if (!(Number.isInteger(sc.dev?.promote?.minNetSuccesses) && sc.dev.promote.minNetSuccesses >= 1)) p.push("screening.dev.promote.minNetSuccesses (integer >= 1) required");
  pos(sc.dev?.maxHours, "screening.dev.maxHours"); pos(sc.holdout?.maxHours, "screening.holdout.maxHours");
  if (typeof sc.holdout?.enabled !== "boolean") p.push("screening.holdout.enabled (true/false) required");
  for (const k of CAP_KEYS) posInt(sc.caps?.[k], `screening.caps.${k}`);
  if (sc.caps && Number.isInteger(sc.caps.cumulative) && Number.isInteger(c.budget?.limit) && sc.caps.cumulative > c.budget.limit) p.push("screening.caps.cumulative cannot exceed the ledger limit");
  if (sc.caps && sc.caps.perCycle < Math.max(sc.caps.dev ?? 0, sc.caps.holdout ?? 0)) p.push("screening.caps.perCycle must cover the larger stage cap (one stage per cycle)");
  if (sc.caps && sc.caps.perCandidate < (sc.caps.dev ?? 0)) p.push("screening.caps.perCandidate must cover the dev cap");
  if (sc.smoke !== undefined && typeof sc.smoke?.checks !== "boolean") p.push("screening.smoke.checks must be true/false");
  return p;
}

// ------------------------------------------------------------------------------------------------------------------ registry
const registryOf = (cfg) => new Ledger(cfg.screening.registry);

/** Registry stages that run the target model. */
const MODEL_STAGES = Object.freeze(["dev", "holdout"]);
/**
 * Target-route consistency of a series registry (pure): every paid stage result must have been measured on the config's target
 * route (a result without `route` predates route selection and was measured on the package default). Development and holdout
 * results of another model or effort are never reused as selection evidence: a route change needs a new registry.
 */
export function registryRouteProblems(records, cfg) {
  const target = exploreProtocol(cfg.route).route, def = exploreProtocol().route;
  const foreign = records.filter(r => r.type === "result" && MODEL_STAGES.includes(r.stage) && !sameRoute(r.route ?? def, target));
  if (!foreign.length) return [];
  const r0 = foreign[0].route ?? def;
  return [`screening registry holds ${foreign.length} dev/holdout result(s) measured on ${routeKey(r0)} (${r0.effort}), not on the target route ${routeKey(target)} (${target.effort}): a route change needs a new registry (no evidence carries across routes)`];
}

/** Verified registry records (throws when the chain is broken: fail closed). */
export function registryRecords(cfg) {
  const led = registryOf(cfg);
  const problems = led.verify();
  if (problems.length) throw new Error(`screening registry chain broken: ${problems.slice(0, 2).join("; ")}`);
  return led.records();
}

/**
 * Candidate view (pure over registry records + config history): one entry per content identity in registration order, with its
 * stage results, claims and holdout exposure. status: rejected | negative | inconclusive | qualified | holdout-done | exposed |
 * pending | claimed.
 */
export function candidateView(records, cfg) {
  const byKey = new Map();
  for (const r of records) {
    if (r.type === "candidate" && !byKey.has(r.key)) byKey.set(r.key, { ...r, results: {}, claims: {}, holdoutClaims: [] });
  }
  for (const r of records) {
    const c = byKey.get(r.key);
    if (!c) continue;
    if (r.type === "claim" && r.stage === "holdout") c.holdoutClaims.push(r);
    else if (r.type === "claim" && !c.claims[r.stage]) c.claims[r.stage] = r;
    if (r.type === "result" && !c.results[r.stage]) c.results[r.stage] = r;
  }
  const list = [...byKey.values()];
  const hist = cfg.screening.history ?? [];
  const byPkey = new Map(list.filter(c => c.pkey).map(c => [c.pkey, c]));
  // A holdout exposure: a pre-route history entry, a holdout result, or a holdout claim whose batch records this cycle's use.
  const consumed = (r) => { try { const f = join(cfg.pool, "batches", r.batch ?? "", "USES.jsonl"); return existsSync(f) && readFileSync(f, "utf8").includes(JSON.stringify(join(r.stateDir, r.sub ?? "holdout"))); } catch { return true; } };
  const exposureOf = (c) => {
    const h = hist.find(x => (x.runtimeDigest && x.runtimeDigest === c.key) || (x.archivePkey && x.archivePkey === c.pkey));
    if (h) return { at: h.at, note: h.note, source: "history" };
    if (c.results.holdout) return { at: c.results.holdout.at, note: "holdout result of this route", source: "route" };
    const used = c.holdoutClaims.find(consumed);
    return used ? { at: used.at, note: `holdout consumed by ${basename(used.stateDir)}`, source: "route" } : null;
  };
  for (const c of list) c.exposure = exposureOf(c);
  const parentExposure = (pk) => { const h = hist.find(x => x.archivePkey === pk || x.runtimeDigest === pk); if (h) return { at: h.at }; const pc = byPkey.get(pk) ?? byKey.get(pk); return pc?.exposure ?? null; };
  // Development exposure (informational; holdout exclusion of the observed tasks is done by screeningExclusionTasks): a candidate
  // inherits the development tasks its ancestors were screened on.
  const devExp = new Map();
  for (const r of records) if (r.type === "dev-exposure") devExp.set(r.key, [...(devExp.get(r.key) ?? []), ...(r.tasks ?? []).map(t => ({ id: t.id, at: r.at, basis: r.basis ?? "dev-exposure" }))]);
  for (const c of list) {
    const anc = (c.parents ?? []).map(pk => (byPkey.get(pk) ?? byKey.get(pk))?.key).filter(Boolean);
    c.devExposure = [...(devExp.get(c.key) ?? []), ...anc.flatMap(k => (devExp.get(k) ?? []).map(t => ({ ...t, inherited: k })))];
  }
  for (const c of list) {
    // Tuned after a holdout result: a candidate created after one of its parents was exposed to a final holdout never gets one.
    c.taintedBy = (c.parents ?? []).find(pk => { const e = parentExposure(pk); return e && (!c.createdAt || Date.parse(c.createdAt) >= Date.parse(e.at)); }) ?? null;
    const sm = c.results.smoke, dv = c.results.dev;
    c.status = c.results.holdout ? "holdout-done"
      : c.exposure ? "exposed"
      : sm && sm.verdict === VERDICTS.smokeRejected ? "rejected"
      : dv ? ({ [VERDICTS.devPromising]: "qualified", [VERDICTS.devRejected]: "rejected", [VERDICTS.devNegative]: "negative" }[dv.verdict] ?? "inconclusive")
      : (c.claims.dev || c.claims.smoke) ? "claimed" : "pending";
  }
  return list;
}

// ------------------------------------------------------------------------------------------------------------------ candidates
const treeName = (id, key) => `${String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)}-${key.slice(0, 16)}`;

/** Archive candidates (bounded source): candidate.json + patch.diff, the patch chain resolved through `parent` to the stable commit. */
export function archiveCandidates(source, stableCommit) {
  const dir = source.dir;
  if (!existsSync(dir)) return { list: [], problems: [`archive ${dir} missing`] };
  const include = new Set(source.include ?? DEFAULT_ARCHIVE_INCLUDE);
  const all = new Map();
  for (const name of readdirSync(dir).sort()) {
    const f = join(dir, name, "candidate.json");
    if (!existsSync(f)) continue;
    try { all.set(name, JSON.parse(readFileSync(f, "utf8"))); } catch { /* unreadable entries are skipped (never repaired) */ }
  }
  const list = [];
  for (const [name, c] of all) {
    if (!include.has(c.status)) continue;
    const chain = []; let cur = c, guard = 0, problem = null, foreignBase = false;
    while (cur && guard++ < 20) {
      const patch = join(dir, cur.id ?? "", "patch.diff");
      if (!existsSync(patch)) { problem = `${cur.id}: patch.diff missing`; break; }
      chain.unshift({ id: cur.id, patch, base: cur.base });
      if (cur.base === stableCommit) break;
      if (!cur.parent || cur.parent === "stable") { problem = `${cur.id}: base ${String(cur.base).slice(0, 12)} is not the stable commit ${String(stableCommit).slice(0, 12)}`; foreignBase = true; break; }
      cur = all.get(cur.parent) ?? null;
      if (!cur) problem = `${c.id}: parent ${c.parent} not in the archive`;
    }
    const patches = chain.map(x => readFileSync(x.patch, "utf8"));
    list.push({ id: `${basename(dir.replace(/\/candidates\/?$/, ""))}/${name}`, source: dir, archiveId: name, status: c.status, createdAt: c.createdAt ?? null, chain: chain.map(x => x.id), parents: chain.slice(0, -1).map((_, i) => patchKey(patches.slice(0, i + 1).join("\n"))), patches, pkey: patchKey(patches.join("\n")), problem, foreignBase, hypothesis: String(c.hypothesis?.text ?? "").slice(0, 300) });
  }
  return { list, problems: [] };
}

/** Changed runtime files between two trees (relative paths; pure over the file system). */
export function changedFiles(a, b) {
  const files = (dir) => {
    const out = new Map();
    const walk = (rel) => { const abs = join(dir, rel); for (const e of readdirSync(abs, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(r); else if (e.isFile()) out.set(r, sha256(readFileSync(join(dir, r)))); } };
    for (const name of RUNTIME) { const p = join(dir, name); if (!existsSync(p)) continue; if (statSync(p).isDirectory()) walk(name); else out.set(name, sha256(readFileSync(p))); }
    return out;
  };
  const x = files(a), y = files(b);
  return [...new Set([...x.keys(), ...y.keys()])].filter(k => x.get(k) !== y.get(k)).sort();
}

/**
 * Register new candidates of every source (model-free): materialize archive candidates (stable tree + patch chain, `git apply`)
 * under workDir/trees, compute the content identity, dedupe by runtime digest (and normalized patch key), and append candidate
 * records -- bounded by maxCandidates. A patch chain that does not apply is registered with a SMOKE_REJECTED result (no model).
 */
export function syncCandidates(cfg, { log = () => {} } = {}) {
  const sc = cfg.screening;
  const led = registryOf(cfg);
  let records = registryRecords(cfg);
  if (!records.length) records = [led.append({ type: "init", schema: REGISTRY_SCHEMA, stable: { commit: cfg.stable.commit, runtimeDigest: cfg.stable.runtimeDigest }, caps: sc.caps, config: cfg.file })];
  const init = records.find(r => r.type === "init");
  if (init.stable?.runtimeDigest !== cfg.stable.runtimeDigest) throw new Error("screening registry belongs to another stable reference (a new reference needs a new registry)");
  const known = new Set(records.filter(r => r.type === "candidate").map(r => r.key));
  const knownPatch = new Set(records.filter(r => r.type === "candidate" || r.type === "alias").map(r => r.pkey).filter(Boolean));
  const seenSource = new Set(records.filter(r => r.type === "candidate" || r.type === "alias").map(r => r.sourceId));
  let count = records.filter(r => r.type === "candidate").length;
  const added = [];
  const trees = ensureDir(join(sc.workDir, "trees"), 0o700);
  for (const s of sc.candidates.sources) {
    const entries = s.kind === "tree" ? [{ id: s.id, tree: s }] : archiveCandidates(s, cfg.stable.commit).list;
    for (const e of entries) {
      if (count >= sc.candidates.maxCandidates) return { added, capped: true };
      const sourceId = e.id;
      if (seenSource.has(sourceId)) continue;
      // Internal track: an archive entry based on another evaluation stable belongs to that stable's epoch (not registered here).
      if (internalEnabled(cfg) && e.foreignBase) continue;
      if (e.tree) {
        const key = e.tree.identity.runtimeDigest;
        let actual = null; try { actual = runtimeDigest(e.tree.dir); } catch { /* unreadable */ }
        if (known.has(key)) { led.append({ type: "alias", key, sourceId }); seenSource.add(sourceId); continue; }
        const rec = led.append({ type: "candidate", key, sourceId, id: e.id, kind: "tree", dir: e.tree.dir, commit: e.tree.identity.commit, parents: (e.tree.parents ?? []), createdAt: e.tree.createdAt ?? null });
        known.add(key); seenSource.add(sourceId); count++; added.push(rec);
        if (actual !== key) led.append({ type: "result", key, stage: "smoke", verdict: VERDICTS.smokeRejected, reasons: ["tree differs from its declared frozen identity"], model: false });
        continue;
      }
      if (knownPatch.has(e.pkey)) { led.append({ type: "alias", key: null, pkey: e.pkey, sourceId }); seenSource.add(sourceId); continue; }
      let problem = e.problem, dir = null, key = null;
      if (!problem) {
        const tmp = join(trees, `.tmp-${process.pid}-${Date.now()}`);
        rmSync(tmp, { recursive: true, force: true });
        cpSync(cfg.stable.dir, tmp, { recursive: true, filter: (x) => !x.endsWith("/.codegraph") && !x.includes("/.git/") && !x.endsWith("/.git") });
        // `git apply` inside an enclosing repository resolves paths against THAT repository and silently skips paths outside
        // the current directory (2026-11-08: the work directory lives in a git checkout). The ceiling keeps git from discovering
        // any enclosing repository, so it patches exactly this copy; every patch must also report its changed files.
        const gitEnv = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(tmp), GIT_DIR: join(tmp, ".no-git") };
        for (const [i, patch] of e.patches.entries()) {
          const stat = spawnSync("git", ["apply", "--numstat", "-"], { cwd: tmp, input: patch, encoding: "utf8", env: gitEnv });
          const r = stat.status === 0 && stat.stdout.trim() ? spawnSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd: tmp, input: patch, encoding: "utf8", env: gitEnv }) : stat;
          if (r.status !== 0 || !stat.stdout.trim()) { problem = `patch ${e.chain[i]} does not apply to the stable tree: ${String(r.stderr || "no changed file").trim().slice(0, 200)}`; break; }
        }
        if (!problem && runtimeDigest(tmp) === cfg.stable.runtimeDigest) problem = `patch chain ${e.chain.join("+")} produced no runtime change against the stable tree`;
        if (!problem) {
          key = runtimeDigest(tmp);
          dir = join(trees, treeName(e.archiveId, key));
          if (existsSync(dir)) rmSync(tmp, { recursive: true, force: true }); else renameSync(tmp, dir);
        } else rmSync(tmp, { recursive: true, force: true });
      }
      if (!key) key = `patch:${e.pkey}`;
      if (known.has(key)) { led.append({ type: "alias", key, pkey: e.pkey, sourceId }); seenSource.add(sourceId); knownPatch.add(e.pkey); continue; }
      const rec = led.append({ type: "candidate", key, sourceId, id: e.id, kind: "archive", dir, commit: `${cfg.stable.commit}+${e.chain.join("+")}:${e.pkey.slice(0, 16)}`, pkey: e.pkey, chain: e.chain, parents: e.parents, archiveStatus: e.status, createdAt: e.createdAt, hypothesis: e.hypothesis });
      known.add(key); knownPatch.add(e.pkey); seenSource.add(sourceId); count++; added.push(rec);
      if (problem) led.append({ type: "result", key, stage: "smoke", verdict: VERDICTS.smokeRejected, reasons: [problem], model: false });
      log(`registered ${e.id} ${key.slice(0, 16)}${problem ? ` (smoke rejected: ${problem.slice(0, 80)})` : ""}`);
    }
  }
  return { added, capped: false };
}

// ------------------------------------------------------------------------------------------------------------------ dev supply
/**
 * Identities of every historical holdout (and every task already observed by this route's development screening) that a
 * development task must never share: task id, family, cross-track Exercism problem. Sources (all must be readable, chains
 * intact, datasets non-empty -- otherwise this THROWS, and the caller treats every development task as ineligible):
 *   lineage registries (earlier supply universes), lineage datasets (historical holdout datasets), pool batches whose purpose is
 *   not development/calibration (holdout, reserved, used), every retired batch, any batch with a reservation or a USES.jsonl,
 * (A former holdout task that this route showed to candidates by mistake stays rejected here because its holdout dataset is a
 * lineage source; its exposure additionally keeps it, and its family, out of every new holdout.)
 */
export function holdoutIdentities(cfg) {
  const keys = new Map();
  const add = (family, id, why) => {
    if (family && !keys.has(`family:${family}`)) keys.set(`family:${family}`, why);
    if (id && !keys.has(`task:${id}`)) keys.set(`task:${id}`, why);
    const ex = exercismProblem(id); if (ex && !keys.has(`exercism-problem:${ex}`)) keys.set(`exercism-problem:${ex}`, `${why} (same Exercism problem)`);
  };
  const src = cfg.lineage ?? {};
  if (!Array.isArray(src.registries) || !src.registries.length || !Array.isArray(src.datasets) || !src.datasets.length) throw new Error("historical holdout inventory missing (lineage registries and datasets are required)");
  for (const r of src.registries) { const { families, ids } = readRegistry(r); for (const f of families) add(f, null, `supply registry ${r}`); for (const id of ids) add(null, id, `supply registry ${r}`); }
  for (const d of src.datasets) {
    let tasks; try { tasks = loadLocal(d); } catch (error) { throw new Error(`holdout dataset unreadable: ${d}: ${error.message}`); }
    if (!tasks.length) throw new Error(`holdout dataset empty: ${d}`);
    for (const t of tasks) add(t.family, t.id, `holdout dataset ${d}`);
  }
  const st = poolState(cfg.pool);
  if (st.chain.length) throw new Error(`pool registry chain broken: ${st.chain[0]}`);
  const used = (b) => existsSync(join(cfg.pool, "batches", b, "USES.jsonl"));
  for (const b of st.batches.values()) {
    if (DEV_PURPOSES.includes(b.purpose) && !st.reservedBatches.has(b.batch) && !used(b.batch)) continue;
    for (const id of b.tasks) add(st.cases.get(id)?.family, id, `pool batch ${b.batch} (${b.purpose ?? "holdout"}${st.reservedBatches.has(b.batch) ? ", reserved" : ""}${used(b.batch) ? ", used" : ""})`);
  }
  for (const b of st.retired.values()) for (const id of b.tasks) add(st.cases.get(id)?.family, id, `retired batch ${b.batch}`);
  // Development tasks this route already used are NOT holdout identities: development material is reusable across candidates.
  // They are excluded from every new holdout instead (screeningExclusionTasks -> screen.tasks -> batch selection and pre-use check).
  return keys;
}

/** Development tasks this route has already shown to candidates: config `exposedDevTasks` + registry `dev-exposure` records (planned tasks count). */
export function exposedDevTasks(cfg) {
  const out = [];
  const seen = new Set();
  const push = (t, why) => { if (seen.has(`${t.dataset}\0${t.id}`)) return; seen.add(`${t.dataset}\0${t.id}`); let family = t.family ?? null; if (!family) { try { family = JSON.parse(readFileSync(join(t.dataset, t.id, "task.json"), "utf8")).family ?? null; } catch { throw new Error(`exposed development task ${t.id} unreadable in ${t.dataset} (exposure provenance must stay readable)`); } } out.push({ id: t.id, dataset: t.dataset, family, why }); };
  for (const t of cfg.screening?.exposedDevTasks ?? []) push(t, t.note ?? "config exposedDevTasks");
  if (cfg.screening?.registry && existsSync(cfg.screening.registry)) for (const r of registryRecords(cfg)) if (r.type === "dev-exposure") for (const t of r.tasks ?? []) push(t, `${r.basis ?? "dev-exposure"} ${r.at}`);
  return out;
}

/** Tasks every new holdout batch must avoid in screening mode: the current development tasks plus every exposed development task. */
export function screeningExclusionTasks(c) {
  const tasks = [...(c.screening?.dev?.tasks ?? [])];
  const seen = new Set(tasks.map(t => `${t.dataset}\0${t.id}`));
  for (const t of exposedDevTasks(c)) if (!seen.has(`${t.dataset}\0${t.id}`)) { seen.add(`${t.dataset}\0${t.id}`); tasks.push({ id: t.id, dataset: t.dataset }); }
  return tasks;
}

/**
 * Eligibility of development tasks (model-free, fail closed). A task is eligible only when its dataset is a sealed batch
 * (SEAL.json verifies) with PROVENANCE.json purpose calibration|development listing the task, never reserved or used, the task is
 * in no configured exclusion list (file sha256 must match), and its id, family and Exercism problem occur in no historical holdout
 * source (holdoutIdentities). Missing or corrupt evidence makes the task -- or, for a shared source, every task -- ineligible.
 * @returns {{ eligible: object[], rejected: {id: string, why: string}[], ok: boolean, why: string }}
 */
export function devEligibility(cfg, tasks = cfg.screening.dev.tasks) {
  const dev = cfg.screening.dev;
  const need = dev.minTasks ?? dev.tasks.length;
  const all = (why) => ({ eligible: [], rejected: tasks.map(t => ({ id: t.id, why })), ok: false, why: `development supply unusable: ${why}` });
  let hist; try { hist = holdoutIdentities(cfg); } catch (error) { return all(`historical holdout provenance unreadable (fail closed): ${String(error.message).slice(0, 240)}`); }
  const excluded = new Map();
  for (const x of dev.exclusions ?? []) {
    let raw; try { raw = readFileSync(x.file); } catch { return all(`exclusion list ${x.file} unreadable`); }
    if (sha256(raw) !== x.sha256) return all(`exclusion list ${x.file} changed (sha256 mismatch)`);
    let doc; try { doc = JSON.parse(raw.toString("utf8")); } catch { return all(`exclusion list ${x.file} malformed`); }
    for (const e of doc.exclusions ?? []) excluded.set(e.task, `${basename(x.file)}: ${String(e.reason ?? "excluded").slice(0, 120)}`);
  }
  let st = null; try { st = poolState(cfg.pool); } catch { /* reported per task below */ }
  const eligible = [], rejected = [];
  for (const t of tasks) {
    const why = [];
    const prov = readJson(join(t.dataset, "PROVENANCE.json"), null);
    if (!prov) why.push("dataset has no readable PROVENANCE.json (no prospective development designation)");
    else {
      if (!DEV_PURPOSES.includes(prov.purpose)) why.push(`dataset purpose ${prov.purpose ?? "?"} is not ${DEV_PURPOSES.join("|")}`);
      if (!Array.isArray(prov.tasks) || !prov.tasks.some(x => (x?.id ?? x) === t.id)) why.push("task not listed in the dataset provenance");
    }
    let seal; try { seal = verifySeal(t.dataset); } catch (error) { seal = { ok: false, why: error.message }; }
    if (!seal.ok) why.push(`seal: ${seal.why}`);
    if (existsSync(join(t.dataset, "USES.jsonl"))) why.push("dataset has holdout uses (USES.jsonl)");
    if (st && st.reservedBatches.has(basename(t.dataset))) why.push("dataset batch was reserved for a holdout");
    let task = null; try { task = JSON.parse(readFileSync(join(t.dataset, t.id, "task.json"), "utf8")); } catch { why.push("task.json unreadable"); }
    if (task && task.id !== undefined && task.id !== t.id) why.push(`task.json id ${task.id} differs`);
    for (const k of [task?.family ? `family:${task.family}` : null, `task:${t.id}`, exercismProblem(t.id) ? `exercism-problem:${exercismProblem(t.id)}` : null].filter(Boolean)) if (hist.has(k)) why.push(`${k} occurs in ${hist.get(k)}`);
    if (excluded.has(t.id)) why.push(`excluded: ${excluded.get(t.id)}`);
    if (why.length) rejected.push({ id: t.id, why: why.join("; ") }); else eligible.push({ id: t.id, dataset: t.dataset, family: task.family });
  }
  const ok = eligible.length >= need;
  return { eligible, rejected, ok, why: ok ? "" : `development supply: ${eligible.length} eligible task(s) < ${need} required${rejected.length ? ` (rejected: ${rejected.slice(0, 3).map(r => `${r.id}: ${r.why.slice(0, 160)}`).join(" | ")}${rejected.length > 3 ? ` | +${rejected.length - 3}` : ""})` : ""}` };
}

// ------------------------------------------------------------------------------------------------------------------ caps
/** Charged attempts of the route's reservations in the ledger records, grouped (pure). */
export function routeUsage(records, { key = null, stageId = null, cycle = null } = {}) {
  const res = new Map();
  for (const r of records) {
    if (r.type === "reserve" && r.meta?.route === ROUTE) res.set(r.id, { amount: r.amount, used: null, meta: r.meta });
    else if (r.type === "settle" && res.has(r.id)) res.get(r.id).used = r.used;
  }
  const out = { route: 0, candidate: 0, stage: 0, cycle: 0, open: 0 };
  for (const x of res.values()) {
    const c = x.used === null ? x.amount : Math.max(x.used, 0);
    if (x.used === null) out.open++;
    out.route += c;
    if (key && x.meta.screeningKey === key) out.candidate += c;
    if (stageId && x.meta.screeningStage === stageId) out.stage += c;
    if (cycle && x.meta.screeningCycle === cycle) out.cycle += c;
  }
  return out;
}

/**
 * A view of the durable RequestBudget that refuses reservations past the route caps or after the stage deadline. Check and
 * reserve are serialized in-process; across processes the series lock admits one screening cycle at a time, and the global
 * ceiling stays enforced by the inner ledger under its own lock.
 */
export class CappedBudget {
  constructor(inner, { caps, stage, key, stageId, cycle, deadline }) {
    Object.assign(this, { inner, caps, stage, key, stageId, cycle, deadline });
    this.refusal = null; this.chain = Promise.resolve();
  }
  headroom(records = this.inner.verified()) {
    const u = routeUsage(records, { key: this.key, stageId: this.stageId, cycle: this.cycle });
    return { usage: u, left: Math.min(this.caps.cumulative - u.route, this.caps.perCandidate - u.candidate, this.caps[this.stage] - u.stage, this.caps.perCycle - u.cycle) };
  }
  status() { const s = this.inner.status(); const h = this.headroom(); return { ...s, remaining: Math.min(s.remaining, h.left), ledgerRemaining: s.remaining, route: h.usage }; }
  verified() { return this.inner.verified(); }
  reserve(amount, meta = {}) {
    const run = async () => {
      if (this.deadline && Date.now() > Date.parse(this.deadline)) { this.refusal = `request budget refused by the screening time bound: the ${this.stage} stage deadline ${this.deadline} has passed (no new attempt starts)`; return null; }
      const recs = this.inner.verified();
      const { usage: u } = this.headroom(recs);
      const over = [["cumulative", u.route, this.caps.cumulative], ["per-candidate", u.candidate, this.caps.perCandidate], [`${this.stage} stage`, u.stage, this.caps[this.stage]], ["per-cycle", u.cycle, this.caps.perCycle]].find(([, used, cap]) => used + amount > cap);
      if (over) { this.refusal = `request budget refused by the screening ${over[0]} cap: charged ${over[1]} + ${amount} would exceed ${over[2]}`; return null; }
      const t = await this.inner.reserve(amount, { ...meta, route: ROUTE, screeningKey: this.key, screeningStage: this.stageId, screeningCycle: this.cycle });
      if (!t) this.refusal = `${this.inner.refusal ?? "request budget refused"} (global ledger)`;
      else { this.reserved = (this.reserved ?? 0) + 1; fault(`screening:${this.stage}-reserve-${this.reserved}`); }
      return t;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
  settle(ticket, used, detail) { return this.inner.settle(ticket, used, detail); }
  reconcileDead(detail) { return this.inner.reconcileDead(detail); }
}

/** Remaining route headroom for a stage of `key` before anything is reserved (pure over ledger records). */
export function stageHeadroom(records, caps, stage, key, ledgerRemaining) {
  const u = routeUsage(records, { key });
  return Math.min(ledgerRemaining, caps.cumulative - u.route, caps.perCandidate - u.candidate, caps[stage], caps.perCycle);
}

// ------------------------------------------------------------------------------------------------------------------ dev
/** Digest of every file of a directory (frozen inputs: development task directories). */
export function dirDigest(dir) {
  const rows = [];
  const walk = (rel) => { for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(r); else if (e.isFile()) rows.push(`${r}\t${sha256(readFileSync(join(dir, r)))}`); } };
  walk("");
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}

/**
 * Development verdict over the final attempts (pure; the rule is frozen in the dev plan before any outcome):
 *   DEV_REJECTED      any candidate integrity violation, strict existing-test change, leak, crash or route violation
 *   DEV_INCONCLUSIVE  unmeasured units (halt, cap, time) or infrastructure-only outcomes
 *   DEV_PROMISING     net successes (candidate - stable) >= minNetSuccesses, candidate hidden passes >= stable's
 *   DEV_NEGATIVE      net successes <= 0
 *   DEV_INCONCLUSIVE  otherwise
 */
export function devVerdict(records, plan, { halted = null } = {}) {
  const planned = plan.dev.tasks.length * plan.dev.repeats;
  const fin = finalAttempts(records.filter(r => r.split === "dev"));
  const arm = (id) => fin.filter(r => r.candidate_id === id);
  const s = arm("stable"), c = arm("c1");
  const critical = criticalProblems(records.filter(r => r.split === "dev"), "c1", { reference: "stable" });
  const strict = records.filter(r => r.candidate_id === "c1" && r.integrity?.strictTestViolations?.length);
  const infra = fin.filter(r => ["infra_error", "model_unavailable"].includes(r.terminal_status));
  const ok = (r) => r.task_success === true;
  const totals = { stable: { units: s.length, success: s.filter(ok).length, hiddenPass: s.filter(r => r.hidden_test_pass === true).length, requests: s.reduce((n, r) => n + (r.model_requests ?? 0), 0) },
    c1: { units: c.length, success: c.filter(ok).length, hiddenPass: c.filter(r => r.hidden_test_pass === true).length, integrityViolations: c.filter(r => r.integrity?.violations?.length).length, strictViolations: strict.length, requests: c.reduce((n, r) => n + (r.model_requests ?? 0), 0) } };
  const net = totals.c1.success - totals.stable.success;
  const reasons = [];
  let verdict;
  if (critical.length || strict.length) { verdict = VERDICTS.devRejected; reasons.push(...critical.slice(0, 4), ...(strict.length ? [`strict existing-test changes in ${strict.length} candidate attempt(s)`] : [])); }
  else if (s.length < planned || c.length < planned) { verdict = VERDICTS.devInconclusive; reasons.push(`${2 * planned - s.length - c.length} planned unit(s) not measured${halted ? ` (${halted})` : ""}`); }
  else if (infra.length) { verdict = VERDICTS.devInconclusive; reasons.push(`${infra.length} unit(s) ended in infrastructure errors`); }
  else if (net >= plan.dev.promote.minNetSuccesses && totals.c1.hiddenPass >= totals.stable.hiddenPass) { verdict = VERDICTS.devPromising; reasons.push(`net successes ${net} >= ${plan.dev.promote.minNetSuccesses} and hidden passes ${totals.c1.hiddenPass} >= ${totals.stable.hiddenPass} (screening rule, not a power claim)`); }
  else if (net <= 0) { verdict = VERDICTS.devNegative; reasons.push(`net successes ${net} <= 0`); }
  else { verdict = VERDICTS.devInconclusive; reasons.push(`net successes ${net} below the promotion rule (${plan.dev.promote.minNetSuccesses})`); }
  return { verdict, accepted: verdict === VERDICTS.devPromising, reasons, planned: 2 * planned, measured: s.length + c.length, net, infra: infra.length, totals };
}

/** Run (or resume) the ONE development pass of a frozen plan (stable vs candidate, interleaved, early elimination). */
export async function runDev({ plan, state, backend, budget, bound, validate, envDigest, parallelism = 1, log = () => {} }) {
  ensureDir(state);
  const digest = digestOf(plan);
  const prior = readJson(join(state, "plan-lock.json"), null);
  if (prior && prior.digest !== digest) throw new Error("dev: state belongs to another plan (a frozen plan is never changed)");
  if (!prior) atomicWriteJson(join(state, "plan-lock.json"), { digest, at: new Date().toISOString() });
  const done = readJson(join(state, "dev-report.json"), null);
  if (done) return done;
  const lock = acquireLock(join(state, "dev.lock"));
  try {
    const tasks = planTasks(plan.dev.tasks);
    for (const t of plan.dev.tasks) { const d = join(t.dataset, t.id); if (dirDigest(d) !== plan.dev.taskDigests[t.id]) return { blocked: `development task ${t.id} changed since the plan was frozen (immutable input drift)` }; }
    const grading = readJson(join(state, "grading.json"), {});
    for (const t of tasks) if (!grading[t.id]) { grading[t.id] = validate ? await validate(t) : { ok: true, expected: {}, baselineFailing: [] }; atomicWriteJson(join(state, "grading.json"), grading); }
    const bad = tasks.filter(t => !grading[t.id].ok).map(t => t.id);
    if (bad.length) return { blocked: `grader validation failed for development task(s) ${bad.join(", ")} (not run)` };
    const p = merge(exploreProtocol(plan.route), { parallelism });
    p.integrity = { strictTestFiles: true }; p.capture = { transcripts: true };
    const tasksById = Object.fromEntries(tasks.map(t => [t.id, t]));
    const base = attemptAdmission(budget, bound);
    let evaluator = null;
    // Early elimination: once the candidate shows a critical problem, no further unit (of either arm) is dispatched.
    const admission = { ...base, reserve: async (amount, meta) => { const crit = criticalProblems(evaluator.records(), "c1", { reference: "stable" }); if (crit.length) { admission.refusal = `early elimination: ${crit[0]}`; return null; } admission.refusal = null; const t = await base.reserve(amount, meta); if (!t) admission.refusal = base.refusal; return t; }, settle: (t, u, d) => base.settle(t, u, d), refusal: null };
    evaluator = new Evaluator({ stateDir: state, protocol: p, protocolDigest: digest, envDigest, tasksById, grading, backend, log, admission });
    const harness = { stable: harnessOf("stable", plan), c1: harnessOf("c1", plan) };
    const schedule = interleavedSchedule({ arms: ["stable", "c1"], tasks: tasks.map(t => t.id).sort(), repeats: plan.dev.repeats, split: "dev", seed: `${plan.seed}:dev`, bind: { planDigest: digest, arms: [{ id: "stable", commit: harness.stable.commit }, { id: "c1", commit: harness.c1.commit }] } });
    const stored = readJson(join(state, "dev-schedule.json"), null);
    if (stored) { const sp = scheduleProblems(stored, schedule); if (sp.length) return { blocked: `the frozen dev schedule differs from the recorded one: ${sp[0]}` }; }
    else atomicWriteJson(join(state, "dev-schedule.json"), schedule);
    await evaluator.evaluateScheduled(schedule.units.map(u => ({ harness: harness[u.arm], unit: u })), "screening:dev");
    const halted = evaluator.halted;
    const v = devVerdict(evaluator.records(), plan, { halted });
    const b = budget.status();
    const report = { schema: DEV_SCHEMA, planDigest: digest, candidate: plan.candidate.identity, stable: { commit: plan.stable.commit, runtimeDigest: plan.stable.runtimeDigest }, simulated: !!backend.simulated, halted: halted ?? null, ...v,
      evidence: DEV_EVIDENCE, budget: { routeCharged: b.route?.route ?? null, stageCharged: b.route?.stage ?? null, remaining: b.remaining, ledgerRemaining: b.ledgerRemaining ?? null, openReservations: b.openReservations }, at: new Date().toISOString() };
    // A refusal by the cumulative cap or the global ledger is not a cheap stage end: the series stops (no dev result recorded).
    if (halted && /cumulative cap|global ledger|accounting unavailable|settlement failed|isolated runtime/.test(halted)) return { paused: halted, report };
    atomicWriteJson(join(state, "dev-report.json"), report);
    return report;
  } finally { lock.release(); }
}

// ------------------------------------------------------------------------------------------------------------------ smoke
/** Static limits of the candidate change (model-free): runtime files only under the proposer's allowed paths, file count. */
export function staticSmoke(cand, stable) {
  const p = exploreProtocol().proposer;
  const changed = changedFiles(stable.dir, cand.dir);
  const problems = [];
  if (!changed.length) problems.push("candidate runtime is identical to the stable reference");
  const outside = changed.filter(f => !p.allowedPaths.some(a => f.startsWith(a)));
  if (outside.length) problems.push(`changes outside ${p.allowedPaths.join(", ")}: ${outside.slice(0, 4).join(", ")}`);
  if (changed.length > p.maxChangedFiles) problems.push(`${changed.length} changed runtime files > ${p.maxChangedFiles}`);
  return { changed, problems };
}

// ------------------------------------------------------------------------------------------------------------------ planning
/**
 * The next action of the series (pure over the candidate view, the ledger records and supply facts):
 *   { kind: "holdout", candidate } | { kind: "dev", candidate } | { wait: code, why } | { stop: code, why }.
 * Holdout first for a qualified candidate when affordable and supplied; dev of the next pending candidate in registration order
 * only while it leaves the cap headroom a waiting qualified candidate needs; otherwise a model-free wait or a stop.
 */
export function planAction(view, { caps, ledgerRemaining, records, supply, holdoutEnabled, devSupply = { ok: true }, internal = null }) {
  const free = (stage, key) => stageHeadroom(records, caps, stage, key, ledgerRemaining);
  const routeLeft = Math.min(ledgerRemaining, caps.cumulative - routeUsage(records).route);
  let qualified = view.filter(c => c.status === "qualified" && !c.taintedBy);
  // Internal track (opt-in): the best development net first (ties: registration order); the acceptance needs the route headroom
  // of its own stage AND of the assessment that must follow a promotion; at most maxWaitingQualified candidates wait.
  if (internal?.select === "best-dev-net") qualified = qualified.map((c, i) => ({ c, i })).sort((a, b) => ((b.c.results.dev?.net ?? 0) - (a.c.results.dev?.net ?? 0)) || (a.i - b.i)).map(x => x.c);
  const holdoutNeeds = caps.holdout, follow = internal?.assessmentReserve ?? 0;
  let reserveFor = 0, why = [], waiting = 0;
  if (holdoutEnabled) for (const c of qualified) {
    if (free("holdout", c.key) < holdoutNeeds || routeLeft < holdoutNeeds + follow) { why.push(`${c.id}: holdout needs ${holdoutNeeds} attempts of cap headroom${follow ? ` plus ${follow} for the assessment after a promotion` : ""}, ${Math.min(free("holdout", c.key), routeLeft)} left`); continue; }
    if (!supply.ok) { why.push(`${c.id}: qualified, waiting for a fresh unused holdout batch (${supply.why})`); reserveFor = Math.max(reserveFor, holdoutNeeds + follow); waiting++; continue; }
    return { kind: "holdout", candidate: c };
  }
  if (internal && waiting >= internal.maxWaitingQualified) return { wait: "supply-empty", why: [`${waiting} qualified candidate(s) wait for a fresh acceptance batch: no further paid development screening (internal.maxWaitingQualified ${internal.maxWaitingQualified})`, ...why].join(" | ") };
  const pending = view.filter(c => c.status === "pending");
  // No eligible development set: pending candidates wait (model-free) instead of being screened on ineligible tasks.
  if (pending.length && !devSupply.ok) {
    if (reserveFor) return { wait: "supply-empty", why: [...why, devSupply.why].join(" | ") };
    return { wait: "dev-supply-empty", why: `${pending.length} pending candidate(s) wait: ${devSupply.why}` };
  }
  for (const c of pending) {
    if (free("dev", c.key) < caps.dev || routeLeft - caps.dev < reserveFor) { why.push(`${c.id}: dev needs ${caps.dev} attempts of cap headroom${reserveFor ? ` while ${reserveFor} stay reserved for a qualified candidate's holdout` : ""}, ${free("dev", c.key)} left`); break; }
    return { kind: "dev", candidate: c };
  }
  if (reserveFor) return { wait: "supply-empty", why: why.join(" | ") };
  if (pending.length || (holdoutEnabled && qualified.length)) return { stop: "budget-exhausted", why: why.join(" | ") || "caps exhausted" };
  return { wait: "no-candidate", why: `no pending candidate (${view.length} registered: ${summarize(view)})` };
}
const summarize = (view) => Object.entries(view.reduce((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

// ------------------------------------------------------------------------------------------------------------------ simulation
/** Offline backend of a screening cycle: per-candidate skill (simulation.byCandidate[id]: {p, violate, infra}). */
export function screeningSimBackend(cfg, cand, stage = null) {
  const sim = cfg.simulation ?? {};
  // simulation.byStage.<stage>.<candidate id> (simulated only): a stage-specific skill, e.g. a promoted harness that regresses in
  // the internal assessment.
  const own = (stage && sim.byStage?.[stage]?.[cand.id]) ?? sim.byCandidate?.[cand.id] ?? {};
  return simulatedBackend({ seed: `${sim.seed ?? "sim"}:${cand.key.slice(0, 8)}`, skill: (h) => h.id === "stable" ? { p: sim.p?.stable ?? 0.5 } : { p: own.p ?? sim.p?.c1 ?? 0.5, violation: own.violate === true, infra: own.infra === true } });
}

// ------------------------------------------------------------------------------------------------------------------ cycle
/**
 * One screening cycle inside the explore-cycle CLI (same lock, same explore.json, same runtime and holdout pass helpers).
 * ctx: { cfg, stateDir, deps, ready, orcheDir, s (get/set), block, done, pass, setupRun, initialized, helpers: { nextBatch, recoverPool, retireContaminated, liveDeps, outcome } }.
 */
export async function screeningCycle(ctx) {
  const { cfg, stateDir, deps, ready, helpers } = ctx;
  const sc = cfg.screening;
  const internal = internalEnabled(cfg) ? sc.internal : null;
  let series, track = null;
  // Internal track: one lock over every epoch (each epoch registry has its own series lock below).
  if (internal) { try { ensureDir(internalPaths(cfg).dir, 0o700); track = acquireLock(internalPaths(cfg).lock); } catch (error) { if (error instanceof LockBusyError) return helpers.outcome("busy", stateDir, { lock: { state: "live", series: true } }); throw error; } }
  try { series = acquireLock(`${sc.registry}.lock`); } catch (error) { track?.release(); if (error instanceof LockBusyError) return helpers.outcome("busy", stateDir, { lock: { state: "live", series: true } }); throw error; }
  try {
    if (internal) reconcile(cfg);
    let s = ctx.s;
    const set = (v) => { ctx.s = v; s = v; helpers.save(stateDir, v); };
    // Final of an internal-track action (promotion decision, assessment, rollback): never ADOPT, never a research claim.
    const finishInternal = (verdict, outcomeName, extra = {}) => { set({ ...s, outcome: outcomeName, internal: { ...(s.internal ?? {}), ...(extra.internal ?? {}) } }); return ctx.done(null, { verdict, candidate: s.screening?.candidate ?? null, adopt: false, explorationOnly: true, stage: s.screening?.stage ?? null, serviceDeployment: "none", ...extra }); };
    const block = (code, reason, retryable, back) => { const o = ctx.block(code, reason, retryable, back); s = ctx.s; return o; };
    const budget = ready.budget;
    if (s.phase === "blocked") set({ ...s, phase: s.resumePhase ?? "init", blocked: undefined });
    // ---------------------------------------------------------------- init: sync candidates, plan, freeze
    if (s.phase === "init") {
      try { syncCandidates(cfg, { log: deps.log ?? (() => {}) }); } catch (error) { return block("prerequisite-failed", `candidate registry: ${String(error.message).slice(0, 250)}`, false, "init"); }
      const records = registryRecords(cfg);
      const mixed = registryRouteProblems(records, cfg);
      if (mixed.length) return block("prerequisite-failed", mixed.join(" | "), false, "init");
      const view = candidateView(records, cfg);
      let supply = { ok: false, why: "holdout disabled" };
      if (sc.holdout.enabled && view.some(c => c.status === "qualified")) {
        try { helpers.recoverPool(cfg.pool); helpers.retireContaminated(cfg); const pick = helpers.nextBatch(cfg, { orcheDir: ctx.orcheDir }); supply = pick.none ? { ok: false, why: pick.none.slice(0, 2).join("; ") } : { ok: true, pick }; }
        catch (error) { supply = { ok: false, why: `supply check: ${String(error.message).slice(0, 200)}` }; }
      }
      const ledgerRecs = budget.verified();
      const devSet = devEligibility(cfg);
      const seed = `${cfg.seriesSeed ?? "screening"}:${basename(stateDir)}`;
      // Internal track: an outstanding post-promotion assessment (or its decided rollback) comes before anything else.
      if (internal) {
        const due = pendingAssessment(cfg);
        if (due?.pendingRollback) { const r = internalRollback(cfg, { releaseKey: due.releaseKey, reason: due.pendingRollback.why, by: "assessment" }); set({ ...s, screening: { stage: "assessment", candidate: due.candidate.id, key: due.to.release } }); return finishInternal("ROLLBACK", "completed", { internal: { decision: due.pendingRollback.verdict, rollback: r, releaseKey: due.releaseKey }, evidence: ASSESSMENT_EVIDENCE }); }
        if (due) {
          const left = stageHeadroom(ledgerRecs, sc.caps, "dev", `assess:${due.to.release}`, budget.status().remaining);
          const fit = stageFit({ tasks: devSet.eligible.length, repeats: sc.dev.repeats, attemptsPerUnit: internal.attemptsPerUnit.dev, cap: sc.caps.dev });
          const overdue = due.assessBy && Date.now() > Date.parse(due.assessBy);
          const cannot = overdue ? `assessment deadline ${due.assessBy} passed` : !devSet.ok ? `regression tasks unusable: ${devSet.why}` : !fit.ok ? `assessment cannot fit its cap: ${fit.why}` : left < sc.caps.dev ? `assessment needs ${sc.caps.dev} attempts of headroom, ${left} left` : null;
          if (cannot) { const r = abandonAssessment(cfg, due, `${cannot}: an unassessed promotion is rolled back (fail closed)`); set({ ...s, screening: { stage: "assessment", candidate: due.candidate.id, key: due.to.release } }); return finishInternal("ROLLBACK_UNASSESSED", "completed", { internal: { decision: r.verdict, why: r.why, rollback: r.result, releaseKey: due.releaseKey }, evidence: ASSESSMENT_EVIDENCE }); }
          const devTasks = devSet.eligible.map(t => ({ id: t.id, dataset: t.dataset }));
          const plan = assessmentPlan(cfg, due, { devTasks, taskDigests: Object.fromEntries(devTasks.map(t => [t.id, dirDigest(join(t.dataset, t.id))])), seed: `${seed}:assessment` });
          plan.deadline = due.assessBy;
          atomicWriteJson(join(stateDir, "assessment-plan.json"), plan);
          set({ ...s, phase: "internal-assessing", screening: { stage: "assessment", candidate: due.candidate.id, key: due.to.release, releaseKey: due.releaseKey, planSha256: sha256(readFileSync(join(stateDir, "assessment-plan.json"))), deadline: due.assessBy } });
        }
      }
      if (s.phase === "init") {
      const act = planAction(view, { caps: sc.caps, ledgerRemaining: budget.status().remaining, records: ledgerRecs, supply, holdoutEnabled: sc.holdout.enabled, devSupply: devSet,
        internal: internal ? { select: internal.select ?? "best-dev-net", maxWaitingQualified: internal.maxWaitingQualified, assessmentReserve: internal.assessment.enabled ? sc.caps.dev : 0 } : null });
      if (act.wait) return block(act.wait, act.why, true, "init");
      if (act.stop) return block(act.stop, act.why, false, "init");
      const c = act.candidate;
      const candidate = { id: c.id, key: c.key, dir: c.dir, identity: { id: c.id, kind: "orche", commit: c.commit, runtimeDigest: c.key } };
      const stable = { dir: cfg.stable.dir, commit: cfg.stable.commit, runtimeDigest: cfg.stable.runtimeDigest, ...(internal ? { releaseSeq: cfg.stable.releaseSeq ?? null } : {}) };
      if (internal) {
        // The configured per-unit estimate must let the stage cap cover the whole pass (both arms) before anything is claimed.
        const fit = act.kind === "dev" ? stageFit({ tasks: devSet.eligible.length, repeats: sc.dev.repeats, attemptsPerUnit: internal.attemptsPerUnit.dev, cap: sc.caps.dev })
          : stageFit({ tasks: supply.pick?.coverage?.tasks ?? 0, repeats: acceptanceRepeats(cfg), attemptsPerUnit: internal.attemptsPerUnit.acceptance, cap: sc.caps.holdout });
        if (!fit.ok) return block("prerequisite-failed", `internal ${act.kind === "dev" ? "dev" : "acceptance"} stage: ${fit.why} (nothing claimed, no batch consumed; caps or the estimate are a human decision)`, false, "init");
        const stuck = act.kind === "holdout" ? noProgress(cfg) : null;
        if (stuck) return block("no-progress", stuck, false, "init");
      }
      if (act.kind === "dev") {
        const devTasks = devSet.eligible.map(t => ({ id: t.id, dataset: t.dataset }));
        const plan = { schema: "pi-eval-loop/screening-plan@1", stage: "dev", ...(cfg.route !== undefined ? { route: cfg.route } : {}), seed, stable, candidate, dev: { tasks: devTasks, repeats: sc.dev.repeats, promote: sc.dev.promote, taskDigests: Object.fromEntries(devTasks.map(t => [t.id, dirDigest(join(t.dataset, t.id))])), eligibility: { rule: "sealed calibration|development dataset, never reserved/used, no historical holdout id/family/Exercism problem, not excluded", rejected: devSet.rejected } }, caps: sc.caps, deadlineHours: sc.dev.maxHours };
        atomicWriteJson(join(stateDir, "screen-plan.json"), plan);
        registryOf(cfg).append({ type: "claim", key: c.key, stage: "smoke", stateDir });
        set({ ...s, phase: "smoke", screening: { stage: "smoke", candidate: c.id, key: c.key, planSha256: sha256(readFileSync(join(stateDir, "screen-plan.json"))) } });
      } else {
        const dev = c.results.dev;
        const pick = supply.pick;
        const seal = verifySeal(pick.dir);
        if (!seal.ok) return block("supply-error", `batch seal: ${seal.why}`, true, "init");
        const plan = { ...(cfg.route !== undefined ? { route: cfg.route } : {}), seed, stable, candidate, screen: { report: dev.report, reportSha256: dev.reportSha256, runs: dev.runs, tasks: cfg.screen.tasks }, holdout: { batch: pick.dir, seal: seal.seal.digest, pool: cfg.pool, minRemaining: sc.caps.holdout } };
        // A selection dropped before consumption (pool would not hand out the batch) re-plans into a NEW sub-directory: a frozen
        // plan is never changed in place, and an unconsumed claim is not an exposure.
        const n = records.filter(r => r.type === "claim" && r.stage === "holdout" && r.stateDir === stateDir).length;
        const sub = n ? `holdout-${n + 1}` : "holdout";
        const planFile = n ? `holdout-plan-${n + 1}.json` : "holdout-plan.json";
        atomicWriteJson(join(stateDir, planFile), plan);
        registryOf(cfg).append({ type: "claim", key: c.key, stage: "holdout", stateDir, sub, batch: basename(pick.dir) });
        set({ ...s, phase: "holdout-selected", batch: pick.dir, screening: { stage: "holdout", candidate: c.id, key: c.key, sub, planFile, planSha256: sha256(readFileSync(join(stateDir, planFile))), deadline: new Date(Date.now() + sc.holdout.maxHours * 3_600_000).toISOString() } });
      }
      }
    }
    const scs = s.screening;
    const cand = () => { const v = candidateView(registryRecords(cfg), cfg).find(x => x.key === scs.key); if (!v) throw new Error(`candidate ${scs.key} not in the registry`); return v; };
    // Paid stage results name the target route they were measured on (registryRouteProblems refuses mixing routes).
    const record = (stage, verdict, extra = {}) => { if (!cand().results[stage]) registryOf(cfg).append({ type: "result", key: scs.key, stage, verdict, stateDir, ...(MODEL_STAGES.includes(stage) ? { route: exploreProtocol(cfg.route).route } : {}), ...extra }); };
    const finish = (verdict, outcomeName, extra = {}) => { set({ ...s, outcome: outcomeName }); return ctx.done(null, { verdict, candidate: scs.candidate, adopt: false, explorationOnly: true, stage: scs.stage, ...extra }); };
    // ---------------------------------------------------------------- smoke (model-free)
    if (s.phase === "smoke") {
      const plan = readJson(join(stateDir, "screen-plan.json"), null);
      if (!plan || sha256(readFileSync(join(stateDir, "screen-plan.json"))) !== scs.planSha256) return helpers.outcome("state_error", stateDir, { health: "corrupt", detail: "frozen screen-plan.json missing or changed" });
      let smoke = readJson(join(stateDir, "smoke.json"), null);
      if (!smoke) {
        const problems = [];
        let actual = null; try { actual = runtimeDigest(plan.candidate.dir); } catch (error) { problems.push(`candidate tree unreadable: ${error.message}`); }
        if (actual && actual !== plan.candidate.identity.runtimeDigest) problems.push("candidate tree differs from its frozen identity (immutable input drift)");
        let st = null; try { st = runtimeDigest(plan.stable.dir); } catch { /* reported below */ }
        if (st !== plan.stable.runtimeDigest) return block("prerequisite-failed", "stable tree differs from its frozen identity (immutable input drift; no candidate is judged against a changed reference)", false, "smoke");
        const stat = problems.length ? { changed: [], problems: [] } : staticSmoke(plan.candidate, plan.stable);
        problems.push(...stat.problems);
        let checks = null;
        if (!problems.length && sc.smoke?.checks !== false) {
          const sim = cfg.simulated && !deps.checks;
          if (sim) checks = (cfg.simulation?.smokeFail ?? []).includes(plan.candidate.id) ? { pass: false, problems: ["simulated candidate check failure"] } : { pass: true, problems: [] };
          else checks = await (deps.checks ?? (await helpers.liveDeps(cfg, join(stateDir, "smoke"), plan)).checks)();
          if (!checks.pass) problems.push(`checks: ${(checks.problems ?? []).join("; ").slice(0, 300)}`);
        }
        smoke = { schema: SMOKE_SCHEMA, candidate: plan.candidate.identity, pass: problems.length === 0, problems, changed: stat.changed, checks: checks ? { pass: checks.pass, problems: (checks.problems ?? []).slice(0, 8) } : null, modelCalls: 0, at: new Date().toISOString() };
        atomicWriteJson(join(stateDir, "smoke.json"), smoke);
      }
      if (!smoke.pass) { record("smoke", VERDICTS.smokeRejected, { reasons: smoke.problems.slice(0, 4), model: false }); return finish(VERDICTS.smokeRejected, "completed", { reasons: smoke.problems.slice(0, 6), evidence: { class: "development", confirmatoryClaim: false, note: "model-free smoke" }, budget: { charged: 0 } }); }
      record("smoke", "SMOKE_PASSED", { model: false });
      // Re-check the frozen development tasks right before the first paid unit (a stale plan never bypasses the eligibility rule).
      const recheck = devEligibility(cfg, plan.dev.tasks);
      if (recheck.rejected.length) return block("prerequisite-failed", `frozen development task(s) no longer eligible: ${recheck.rejected.slice(0, 2).map(r => `${r.id}: ${r.why.slice(0, 200)}`).join(" | ")}`, false, "smoke");
      registryOf(cfg).append({ type: "claim", key: scs.key, stage: "dev", stateDir });
      registryOf(cfg).append({ type: "dev-exposure", key: scs.key, stateDir, basis: "planned dev tasks (conservative: every planned task counts as observed)", tasks: plan.dev.tasks.map(t => ({ id: t.id, dataset: t.dataset })) });
      set({ ...s, phase: "dev-running", screening: { ...scs, stage: "dev", deadline: new Date(Date.now() + plan.deadlineHours * 3_600_000).toISOString() } });
      fault("screening:after-smoke");
    }
    // ---------------------------------------------------------------- dev
    if (s.phase === "dev-running") {
      const sc2 = s.screening;
      const plan = readJson(join(stateDir, "screen-plan.json"), null);
      if (!plan || sha256(readFileSync(join(stateDir, "screen-plan.json"))) !== sc2.planSha256) return helpers.outcome("state_error", stateDir, { health: "corrupt", detail: "frozen screen-plan.json missing or changed" });
      if (runtimeDigest(plan.candidate.dir) !== plan.candidate.identity.runtimeDigest) return block("prerequisite-failed", "candidate tree differs from its frozen identity (immutable input drift)", false, "dev-running");
      if (runtimeDigest(plan.stable.dir) !== plan.stable.runtimeDigest) return block("prerequisite-failed", "stable tree differs from its frozen identity (immutable input drift)", false, "dev-running");
      const devDir = join(stateDir, "dev");
      let report = readJson(join(devDir, "dev-report.json"), null);
      if (!report) {
        const recheck = devEligibility(cfg, plan.dev.tasks);
        if (recheck.rejected.length) return block("prerequisite-failed", `frozen development task(s) no longer eligible: ${recheck.rejected.slice(0, 2).map(r => `${r.id}: ${r.why.slice(0, 200)}`).join(" | ")}`, false, "dev-running");
        // Gate-covered charges only: off-gate routes (RETAINED_ROUTES: proposals, reviews) are charged in the same ledger but never
        // count as outbound-attempt allowance (request-budget.mjs budgetTotals), so their settlements cannot create slack here.
        if (!cfg.simulated && (() => { const st = budget.status(); return st.attempts < st.gatedCharged - st.gatedOpenAmount; })()) return block("prerequisite-failed", "the ledger's settled gate-covered charges exceed its outbound attempts (slack an attempt could use outside this stage's reservations): fail closed", false, "dev-running");
        const run = await ctx.setupRun({ stable: plan.stable, candidate: plan.candidate });
        if (run.out) return run.out;
        if (cfg.simulated && !deps.backend) run.backend = screeningSimBackend(cfg, { id: plan.candidate.id, key: plan.candidate.identity.runtimeDigest });
        const capped = new CappedBudget(budget, { caps: sc.caps, stage: "dev", key: sc2.key, stageId: `${stateDir}:dev`, cycle: stateDir, deadline: sc2.deadline });
        const r = await runDev({ plan, state: devDir, backend: run.backend, budget: capped, bound: run.bound, validate: run.validate, envDigest: run.envDigest, parallelism: cfg.parallelism, log: deps.log ?? (() => {}) });
        if (r.blocked) return block("prerequisite-failed", r.blocked, false, "dev-running");
        if (r.paused) { const runtime = /isolated runtime/.test(r.paused); return block(runtime ? "runtime-wait" : "budget-exhausted", r.paused, runtime, "dev-running"); }
        report = r;
      }
      const sha = sha256(readFileSync(join(devDir, "dev-report.json")));
      record("dev", report.verdict, { report: join(devDir, "dev-report.json"), reportSha256: sha, runs: join(devDir, "runs.jsonl"), net: report.net, charged: report.budget?.stageCharged ?? null });
      const out = report.infra > report.planned / 2 ? "infra-stop" : "completed";
      return finish(report.verdict, out, { reasons: report.reasons, evidence: DEV_EVIDENCE, arms: report.totals, dev: { net: report.net, planned: report.planned, measured: report.measured, reportSha256: sha }, budget: report.budget });
    }
    // ---------------------------------------------------------------- holdout (exploration-only pass, at most once per candidate)
    if (["holdout-selected", "holdout-running"].includes(s.phase)) {
      const sc2 = s.screening;
      const capped = new CappedBudget(budget, { caps: sc.caps, stage: "holdout", key: sc2.key, stageId: `${stateDir}:holdout`, cycle: stateDir, deadline: sc2.deadline });
      ready.budget = capped;
      if (cfg.simulated && !deps.backend) { const run = await ctx.setupRun(readJson(join(stateDir, sc2.planFile), {})); if (!run.out) run.backend = screeningSimBackend(cfg, { id: sc2.candidate, key: sc2.key }); }
      const x = await ctx.pass({ planFile: sc2.planFile, planSha: sc2.planSha256, sub: sc2.sub, back: "holdout-selected", dropTo: "init" });
      s = ctx.s;
      if (x.out) {
        if (s.phase === "blocked" && /screening time bound/.test(s.blocked?.reason ?? "")) { set({ ...s, outcome: "time-exhausted", blocked: { ...s.blocked, code: "time-exhausted", retryable: false } }); return helpers.outcome("blocked", stateDir, {}); }
        return x.out;
      }
      const r = x.r;
      const c1 = r.arms?.c1 ?? {};
      const out = !r.holdoutEvaluated || r.verdict === "BLOCKED" ? "consumed-blocked" : (c1.integrityViolations || c1.strictViolations) ? "integrity-stop" : r.incomplete ? "incomplete" : "completed";
      const finalSha256 = sha256(readFileSync(join(stateDir, sc2.sub, "final.json")));
      // protected: the result of a fresh batch; its task-level details must never feed a proposer (consumer contract).
      record("holdout", r.verdict, { report: join(stateDir, sc2.sub, "final.json"), reportSha256: finalSha256, outcome: out, batch: r.holdout ? basename(r.holdout.batch) : null, ...(internal ? { protected: true } : {}) });
      set({ ...s, exploration: { verdict: r.verdict, outcome: out } });
      if (!internal) return finish(r.verdict, out, { evidence: r.evidence, reasons: r.reasons ?? [], arms: r.arms, holdout: r.holdout ? { batch: basename(r.holdout.batch), tasks: r.holdout.tasks, families: r.holdout.families, support: r.holdout.support, familySupport: r.holdout.familySupport } : null, incomplete: r.incomplete ?? 0, budget: r.budget });
      const d = acceptanceDecision(r, out);
      const acceptance = { verdict: r.verdict, outcome: out, finalSha256, batch: r.holdout ? basename(r.holdout.batch) : null, decision: d.promote ? "PROMOTE" : "NOT_PROMOTED", why: d.why };
      recordAcceptance(cfg, { stateDir, candidate: { id: sc2.candidate, key: sc2.key }, verdict: r.verdict, decision: acceptance.decision, batch: acceptance.batch, outcome: out });
      const summary = { arms: r.arms, holdout: r.holdout ? { batch: basename(r.holdout.batch), tasks: r.holdout.tasks, families: r.holdout.families, support: r.holdout.support } : null, incomplete: r.incomplete ?? 0, budget: r.budget, acceptanceVerdict: r.verdict };
      if (!d.promote) return finishInternal("INTERNAL_NOT_PROMOTED", out, { internal: { acceptance }, evidence: INTERNAL_EVIDENCE, reasons: [d.why, ...(r.reasons ?? [])], ...summary });
      set({ ...s, phase: "internal-promoting", internal: { ...(s.internal ?? {}), acceptance, summary } });
    }
    // ---------------------------------------------------------------- internal: promotion of the evaluation stable (CAS)
    if (internal && s.phase === "internal-promoting") {
      const sc2 = s.screening;
      const plan = readJson(join(stateDir, sc2.planFile), null);
      if (!plan || sha256(readFileSync(join(stateDir, sc2.planFile))) !== sc2.planSha256) return helpers.outcome("state_error", stateDir, { health: "corrupt", detail: `frozen ${sc2.planFile} missing or changed` });
      const acc = s.internal.acceptance;
      const pr = promote(cfg, { stateDir, plan, evidence: { finalSha256: acc.finalSha256, batch: acc.batch, verdict: acc.verdict, decision: "PROMOTED" } });
      if (pr.stale) return finishInternal("STALE_BASELINE", "completed", { internal: { decision: "STALE_BASELINE", why: pr.why }, evidence: INTERNAL_EVIDENCE, reasons: [pr.why], ...s.internal.summary });
      return finishInternal("INTERNAL_PROMOTED", "completed", { internal: { decision: "PROMOTED", from: pr.previous.release, to: pr.record.to.release, releaseKey: stateDir, assessBy: pr.record.assessBy ?? null }, evidence: INTERNAL_EVIDENCE, reasons: [acc.why], ...s.internal.summary });
    }
    // ---------------------------------------------------------------- internal: post-promotion assessment (+ rollback)
    if (internal && s.phase === "internal-assessing") {
      const sc2 = s.screening;
      const f = join(stateDir, "assessment-plan.json");
      const plan = readJson(f, null);
      if (!plan || sha256(readFileSync(f)) !== sc2.planSha256) return helpers.outcome("state_error", stateDir, { health: "corrupt", detail: "frozen assessment-plan.json missing or changed" });
      const due = pendingAssessment(cfg);
      if (!due || due.releaseKey !== sc2.releaseKey) return finishInternal("ASSESSMENT_SKIPPED", "completed", { internal: { decision: "SKIPPED", why: "the promotion is no longer the evaluation stable (same history record) or was already assessed" }, evidence: ASSESSMENT_EVIDENCE });
      if (due.pendingRollback) { const r = internalRollback(cfg, { releaseKey: due.releaseKey, reason: due.pendingRollback.why, by: "assessment" }); return finishInternal("ROLLBACK", "completed", { internal: { decision: due.pendingRollback.verdict, rollback: r, releaseKey: due.releaseKey }, evidence: ASSESSMENT_EVIDENCE }); }
      const devDir = join(stateDir, "assessment");
      let report = readJson(join(devDir, "dev-report.json"), null);
      if (!report && due.assessBy && Date.now() > Date.parse(due.assessBy)) { const r = abandonAssessment(cfg, due, `assessment deadline ${due.assessBy} passed before a complete pass: an unassessed promotion is rolled back (fail closed)`); return finishInternal("ROLLBACK_UNASSESSED", "completed", { internal: { decision: r.verdict, why: r.why, rollback: r.result, releaseKey: due.releaseKey }, evidence: ASSESSMENT_EVIDENCE }); }
      if (!report) {
        if (runtimeDigest(plan.candidate.dir) !== plan.candidate.identity.runtimeDigest || runtimeDigest(plan.stable.dir) !== plan.stable.runtimeDigest) return block("prerequisite-failed", "an assessment arm's release differs from its frozen identity (immutable input drift)", false, "internal-assessing");
        const recheck = devEligibility(cfg, plan.dev.tasks);
        if (recheck.rejected.length) return block("prerequisite-failed", `regression task(s) no longer eligible: ${recheck.rejected.slice(0, 2).map(r => `${r.id}: ${r.why.slice(0, 200)}`).join(" | ")}`, false, "internal-assessing");
        if (!cfg.simulated && (() => { const st = budget.status(); return st.attempts < st.gatedCharged - st.gatedOpenAmount; })()) return block("prerequisite-failed", "the ledger's settled gate-covered charges exceed its outbound attempts: fail closed", false, "internal-assessing");
        const run = await ctx.setupRun({ stable: plan.stable, candidate: plan.candidate });
        if (run.out) return run.out;
        if (cfg.simulated && !deps.backend) run.backend = screeningSimBackend(cfg, { id: plan.candidate.id, key: plan.candidate.identity.runtimeDigest }, "assessment");
        const capped = new CappedBudget(budget, { caps: sc.caps, stage: "dev", key: `assess:${plan.candidate.identity.runtimeDigest}`, stageId: `${stateDir}:assessment`, cycle: stateDir, deadline: plan.deadline ?? null });
        const r = await runDev({ plan, state: devDir, backend: run.backend, budget: capped, bound: run.bound, validate: run.validate, envDigest: run.envDigest, parallelism: cfg.parallelism, log: deps.log ?? (() => {}) });
        if (r.blocked) return block("prerequisite-failed", r.blocked, false, "internal-assessing");
        if (r.paused) { const runtime = /isolated runtime/.test(r.paused); return block(runtime ? "runtime-wait" : "budget-exhausted", r.paused, runtime, "internal-assessing"); }
        report = r;
      }
      const d = finishAssessment(cfg, { rec: due, report, reportSha256: sha256(readFileSync(join(devDir, "dev-report.json"))), runs: join(devDir, "runs.jsonl") });
      return finishInternal(d.verdict, "completed", { internal: { decision: d.verdict, why: d.why, rollback: d.result ?? null, releaseKey: due.releaseKey }, evidence: ASSESSMENT_EVIDENCE, reasons: [d.why], arms: report.totals, dev: { net: report.net, planned: report.planned, measured: report.measured } });
    }
    return helpers.outcome("state_error", stateDir, { health: "corrupt", detail: `phase ${s.phase} is not part of the screening route` });
  } finally { series.release(); track?.release(); }
}

/** preflight@1 of a screening series (model-free, creates nothing): could a new cycle act now? */
export async function screeningPreflight(cfg, base, { budget, remaining, orcheDir, nextBatch }) {
  let records = [];
  try { records = existsSync(cfg.screening.registry) ? registryRecords(cfg) : []; } catch (error) { return { ...base, code: "prerequisite-failed", reasons: [String(error.message).slice(0, 300)] }; }
  const mixed = registryRouteProblems(records, cfg);
  if (mixed.length) return { ...base, code: "prerequisite-failed", reasons: mixed };
  const view = candidateView(records, cfg);
  // Sources not yet registered count as pending (registration is model-free and happens at cycle init).
  const seen = new Set(records.filter(r => r.type === "candidate" || r.type === "alias").map(r => r.sourceId));
  let unseen = 0;
  for (const s of cfg.screening.candidates.sources) { const list = s.kind === "tree" ? [{ id: s.id }] : archiveCandidates(s, cfg.stable.commit).list; unseen += list.filter(e => !seen.has(e.id)).length; }
  const room = Math.max(0, cfg.screening.candidates.maxCandidates - view.length);
  const placeholder = Array.from({ length: Math.min(unseen, room) }, (_, i) => ({ id: `unregistered-${i}`, key: `unregistered-${i}`, status: "pending", results: {}, claims: {} }));
  let supply = { ok: false, why: "holdout disabled" };
  if (cfg.screening.holdout.enabled && view.some(c => c.status === "qualified")) { try { const pick = nextBatch(cfg, { orcheDir }); supply = pick.none ? { ok: false, why: pick.none.slice(0, 2).join("; ") } : { ok: true, pick }; } catch (error) { supply = { ok: false, why: String(error.message).slice(0, 200) }; } }
  const devSet = devEligibility(cfg);
  const internal = internalEnabled(cfg) ? cfg.screening.internal : null;
  const act = planAction([...view, ...placeholder], { caps: cfg.screening.caps, ledgerRemaining: remaining, records: budget.verified(), supply, holdoutEnabled: cfg.screening.holdout.enabled, devSupply: devSet,
    internal: internal ? { select: internal.select ?? "best-dev-net", maxWaitingQualified: internal.maxWaitingQualified, assessmentReserve: internal.assessment.enabled ? cfg.screening.caps.dev : 0 } : null });
  const facts = { devTasks: { eligible: devSet.eligible.length, rejected: devSet.rejected.length }, candidates: view.length, unregistered: unseen, statuses: summarize(view), routeCharged: routeUsage(budget.verified()).route, cumulativeCap: cfg.screening.caps.cumulative };
  if (internal) {
    // Consumer contract: candidateDemand.wanted false = do not start a paid proposal now (candidates already wait or budget stops).
    const waiting = view.filter(c => c.status === "qualified" && !c.taintedBy).length;
    let due = null; try { due = pendingAssessment(cfg); } catch (error) { return { ...base, code: "prerequisite-failed", reasons: [`internal registry: ${String(error.message).slice(0, 250)}`], screening: facts }; }
    facts.internal = { epoch: cfg.stable.runtimeDigest.slice(0, 16), evaluationStable: { runtimeDigest: cfg.stable.runtimeDigest, commit: cfg.stable.commit, releaseSeq: cfg.stable.releaseSeq ?? null }, pendingAssessment: due ? { releaseKey: due.releaseKey, candidate: due.candidate.id, assessBy: due.assessBy ?? null, rollbackDecided: !!due.pendingRollback } : null, waitingQualified: waiting,
      candidateDemand: candidateDemand({ pending: view.filter(c => c.status === "pending").length + placeholder.length, waiting, maxWaitingQualified: internal.maxWaitingQualified, budgetStop: !!act.stop }), serviceDeployment: "none" };
    if (due) return { ...base, ok: true, code: "ok", screening: { ...facts, next: "assessment", candidate: due.candidate.id } };
  }
  if (act.wait) return { ...base, code: act.wait, reasons: [act.why], screening: facts };
  if (act.stop) return { ...base, code: act.stop, reasons: [act.why], screening: facts };
  return { ...base, ok: true, code: "ok", screening: { ...facts, next: act.kind, candidate: act.candidate.id }, ...(act.kind === "holdout" ? { holdout: { batch: supply.pick.batch, source: "pool" } } : {}) };
}

/** status@1 extra block of a screening cycle (allowlisted: stage, candidate id, outcome). */
export const screeningStatus = (s) => (s.screening ? { stage: s.screening.stage ?? null, candidate: s.screening.candidate ?? null } : {});
