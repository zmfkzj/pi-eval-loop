// CLI of the holdout supply (bin/eval-loop-supply.mjs). Never runs a model; prints one non-secret JSON summary on stdout.
//
// refresh (2026-11-06): one unattended, model-free replenishment pass for schedulers: the commit source, every configured
// Exercism track, then seal batches from the eligible cases until the next one would not meet the minima. A failing source
// (network, rate limit) is recorded and the others still run. Exit 0 = at least one sealed, unreserved, unused, eligible batch
// is available afterwards (the engine's own check, firstEligibleBatch); 2 = none (the waiting loop keeps waiting without model
// calls); 3 = another refresh holds the pool's refresh lock; 64 = usage. Reserved or used batches are never touched: sealing
// only reads unbatched cases, and reservation stays the engine's (eval-loop --init) business.
import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadProtocol, PACKAGE_DIR } from "./protocol.mjs";
import { acquireLock, atomicWriteJson, ensureDir, LockBusyError } from "./util.mjs";
import { collect, firstEligibleBatch, intakePrivate, mergeSupply, minimaOf, poolPath, poolPolicy, poolStatus, sealBatch, validateCase } from "./supply.mjs";

const USAGE = "usage: eval-loop-supply collect|collect-exercism|intake-private|seal|status|refresh|readiness --pool DIR [--config FILE] [--protocol FILE] [--repos owner/name,...] [--track owner/name] [--src DIR] [--overlap-pool DIR ...] [--study FILE]  (readiness: --protocol FILE --study FILE, read-only) [--purpose holdout|calibration] [--max-cases-per-repo N] [--max-batches N] [--skip-commits] [--no-seal]  (refresh/status: --pool defaults to the protocol's datasets.holdoutPool; intake-private needs --src: reviewed, newly authored tasks)";

/**
 * @param {string[]} argv
 * @param {{ collectors?: { orcheDir?: string, repos?: any[], validate?: any, fetchJson?: any, exercism?: Record<string, any> } }} [options] test seams (local repositories, fake validation)
 */
export async function main(argv, { collectors = {} } = {}) {
  let values, positionals;
  try { ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { pool: { type: "string" }, config: { type: "string" }, protocol: { type: "string" }, repos: { type: "string" }, track: { type: "string" }, src: { type: "string" }, "overlap-pool": { type: "string", multiple: true }, study: { type: "string" }, purpose: { type: "string" }, "max-cases-per-repo": { type: "string" }, "max-batches": { type: "string" }, "skip-commits": { type: "boolean" }, "no-seal": { type: "boolean" } } })); }
  catch (error) { process.stderr.write(`${error.message}\n${USAGE}\n`); return 64; }
  const cmd = positionals[0];
  if (!["collect", "collect-exercism", "intake-private", "seal", "status", "refresh", "readiness"].includes(cmd)) { process.stderr.write(`${USAGE}\n`); return 64; }
  const purpose = values.purpose ?? "holdout";
  if (!["holdout", "calibration"].includes(purpose) || (values.purpose && cmd !== "seal")) { process.stderr.write(`--purpose holdout|calibration applies to seal only\n${USAGE}\n`); return 64; }
  if (cmd === "intake-private" && !values.src) { process.stderr.write(`intake-private needs --src DIR\n${USAGE}\n`); return 64; }
  const log = (s) => process.stderr.write(`[supply] ${s}\n`);
  const protocol = loadProtocol(values.protocol);
  // readiness (2026-11-06): read-only, model-free status of a confirmatory study's prerequisites; exit 0 = ready, 2 = not ready.
  if (cmd === "readiness") {
    if (!values.protocol || !values.study) { process.stderr.write(`readiness needs --protocol FILE and --study FILE\n${USAGE}\n`); return 64; }
    const { ORCHE } = await import("./sandbox.mjs");
    const { readiness } = await import("./readiness.mjs");
    const r = readiness({ protocol, study: JSON.parse(readFileSync(values.study, "utf8")), studyPath: resolve(values.study), overlapPools: (values["overlap-pool"] ?? []).map(p => resolve(p)), orcheDir: collectors.orcheDir ?? ORCHE });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return r.status === "ready" ? 0 : 2;
  }
  // refresh/status without --pool: the pool the engine reserves from (datasets.holdoutPool, resolved like src/loop.mjs), so an
  // unattended caller (agent_workflow's supply-wait) names only the protocol and can never refresh a different pool.
  const poolArg = values.pool ?? (["refresh", "status"].includes(cmd) && values.protocol && protocol.datasets?.holdoutPool ? resolve(PACKAGE_DIR, protocol.datasets.holdoutPool) : undefined);
  if (!poolArg) { process.stderr.write(`--pool is required (or --protocol naming datasets.holdoutPool for refresh/status)\n${USAGE}\n`); return 64; }
  const pool = poolPath(poolArg);
  const cfg = mergeSupply(values.config ? JSON.parse(readFileSync(values.config, "utf8")) : {});
  const minima = minimaOf(protocol);
  const { ORCHE, hostEnvironment } = await import("./sandbox.mjs");
  const orcheDir = collectors.orcheDir ?? ORCHE;
  const print = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (cmd === "status") { print(poolStatus(pool, protocol, { orcheDir, cfg })); return 0; }
  // Pool policy (2026-11-07): a study pool whose batches must be formed by a lineage-aware selector (POLICY.json
  // {autoSeal: false, sealVia}) is never sealed by collect/refresh, and the generic `seal` refuses; only the named selector
  // (calling sealBatch after its cross-pool exclusions) seals. Two contaminated batches were auto-sealed before this existed.
  const policy = poolPolicy(pool);
  if (policy.autoSeal === false && cmd === "seal") { process.stderr.write(`pool policy: batches of ${pool} are sealed only by ${policy.sealVia ?? "its study selector"}\n`); return 64; }
  const noSeal = values["no-seal"] || policy.autoSeal === false;
  let refreshLock;
  if (cmd === "refresh") {
    try { refreshLock = acquireLock(join(ensureDir(pool, 0o700), ".refresh.lock")); }
    catch (error) { if (error instanceof LockBusyError) { print({ schema: "pi-eval-loop/supply-refresh@1", busy: String(error.message).slice(0, 300) }); return 3; } throw error; }
  }
  try {
    /** @type {any} */ let summary = {};
    let validate;
    const validator = async () => {
      if (validate) return validate;
      if (collectors.validate) return (validate = collectors.validate);
      const { gradeWorkspace } = await import("./grader.mjs");
      const env = hostEnvironment();
      const tmpRoot = ensureDir(join(pool, "tmp"));
      return (validate = (dir, opts = {}) => validateCase(dir, { env, scratch: mkdtempSync(join(tmpRoot, "v-")), repeats: cfg.validation.repeats, timeoutMs: cfg.validation.timeoutMs, gradeWorkspace, ...opts }));
    };
    const runCommits = async () => {
      const repos = collectors.repos ?? (values.repos ? values.repos.split(",").map(s => s.trim().toLowerCase()).filter(Boolean).map(slug => ({ slug, url: `https://github.com/${slug}.git` })) : undefined);
      return collect({ pool, cfg, repos, orcheDir, log, validate: await validator(), fetchJson: collectors.fetchJson, maxCasesPerRepo: values["max-cases-per-repo"] ? Number(values["max-cases-per-repo"]) : Infinity });
    };
    const runExercism = async () => {
      const { collectExercism, trackOf } = await import("./supply-exercism.mjs");
      const slugs = values.track ? [values.track] : (cfg.exercism.tracks ?? [trackOf(cfg.exercism)]).map(t => t.slug);
      /** @type {any[]} */ const out = [];
      for (const slug of slugs) {
        try { out.push(await collectExercism({ pool, cfg, orcheDir, log, validate: await validator(), track: slug, ...(collectors.exercism?.[slug] ?? {}) })); }
        catch (error) { if (cmd !== "refresh") throw error; out.push({ track: { repository: `https://github.com/${slug}` }, error: String(error.message).slice(0, 300) }); }
      }
      return out;
    };
    if (cmd === "collect") summary = await runCommits();
    else if (cmd === "collect-exercism") { const tracks = await runExercism(); summary = tracks.length === 1 ? tracks[0] : { tracks }; }
    else if (cmd === "intake-private") summary = await intakePrivate({ pool, src: resolve(values.src), orcheDir, cfg, log, validate: await validator(), overlapPools: (values["overlap-pool"] ?? []).map(p => resolve(p)) });
    else if (cmd === "refresh") {
      summary = { schema: "pi-eval-loop/supply-refresh@1", at: new Date().toISOString(), sources: {}, errors: [] };
      if (!values["skip-commits"]) {
        try { const s = await runCommits(); summary.sources.commits = { repositories: s.repositories, commitsQualified: s.commitsQualified, eligible: s.eligible.length, caseRejects: s.caseRejects, errors: s.errors.length }; }
        catch (error) { summary.errors.push({ source: "commits", message: String(error.message).slice(0, 300) }); }
      }
      try { summary.sources.exercism = (await runExercism()).map(s => s.error ? { track: s.track.repository, error: s.error } : { track: s.track.repository, commit: s.track.commit, candidates: s.candidates, eligible: s.eligible.length, caseRejects: s.caseRejects }); }
      catch (error) { summary.errors.push({ source: "exercism", message: String(error.message).slice(0, 300) }); }
      for (const t of summary.sources.exercism ?? []) if (t.error) summary.errors.push({ source: t.track, message: t.error });
    }
    if (cmd === "refresh") {
      summary.sealed = [];
      const max = values["max-batches"] ? Number(values["max-batches"]) : 10;
      for (let i = 0; i < max && !noSeal; i++) {
        const s = sealBatch({ pool, cfg, minima });
        if (s.blocked) { summary.sealBlocked = { why: s.blocked, coverage: s.coverage, eligible: s.eligible }; break; }
        summary.sealed.push({ batch: s.batch, coverage: s.coverage, seal: s.seal });
      }
      const pick = firstEligibleBatch(pool, protocol, { orcheDir });
      summary.available = pick.none ? { ok: false, reasons: pick.none.slice(0, 10) } : { ok: true, batch: pick.batch, coverage: pick.coverage };
      summary.outlook = poolStatus(pool, protocol, { orcheDir, cfg }).outlook;
    } else if (cmd === "seal" || (cmd.startsWith("collect") && !noSeal)) {
      // A calibration set needs no hard stratum (it measures difficulty); it is never eligible as a holdout.
      const sealed = sealBatch({ pool, cfg, minima: purpose === "calibration" ? { ...minima, minFamilies: 1, requireHard: false } : minima, purpose });
      summary.batch = sealed.blocked ? { blocked: sealed.blocked, coverage: sealed.coverage, eligible: sealed.eligible } : { batch: sealed.batch, coverage: sealed.coverage, seal: sealed.seal };
      summary.sealBlocked = !!sealed.blocked;
    }
    if (policy.autoSeal === false && cmd !== "intake-private") summary.sealSkipped = `pool policy: sealed only by ${policy.sealVia ?? "its study selector"}`;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    atomicWriteJson(join(pool, "reports", `${cmd}-${stamp}.json`), summary);
    print(summary);
    if (cmd === "refresh") return summary.available.ok ? 0 : 2;
    return summary.sealBlocked === true ? 2 : 0;
  } finally { refreshLock?.release(); }
}
