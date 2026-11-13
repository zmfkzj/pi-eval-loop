#!/usr/bin/env node
// ctrl-confirm-2: fresh external holdout acquisition into a WORKSPACE-LOCAL supply root (model-free).
//
//   node pi-eval-loop/experiments/ctrl-confirm-2/supply.mjs discover --root DIR [--external-pool DIR]
//   node pi-eval-loop/experiments/ctrl-confirm-2/supply.mjs collect  --root DIR --slice i/k
//
// Reuses the loop's public-source supply (src/supply.mjs: npm discovery, upstream-commit adaptation, license/provenance checks,
// overlap checks, validation in the grading sandbox) unchanged. What this wrapper adds, fixed before any collection:
//   * a larger discovery (CONFIG below) so that repositories beyond the first, already-collected 60 are reached;
//   * exclusion, BEFORE cloning, of every repository named anywhere in the pre-existing external pool (read-only: its registry
//     and its collection reports), so no family of the consumed or the unused batch can re-enter;
//   * k disjoint repository slices collected in parallel, each into its own pool (registries never shared between processes).
// It never writes outside --root and never reads hidden material of the external pool (registry and reports only).
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { collect, discoverRepos, mergeSupply, validateCase } from "../../src/supply.mjs";
import { atomicWriteJson, digestOf, ensureDir, sha256 } from "../../src/util.mjs";

/** Fixed collection configurations (recorded with their digest in every slice registry). Wave 1: the loop's default keywords with
 *  no repository cap. Wave 2 (added before any outcome because wave 1 reached only 128 qualifying repositories): a broader keyword
 *  list and 1000 packages per keyword; repositories of wave 1 and of the external pool are excluded before cloning. */
export const WAVE2_KEYWORDS = ["javascript", "node", "nodejs", "esm", "module", "browser", "http", "api", "fetch", "log", "logger", "debug", "config", "env", "parse", "stringify", "serialize", "convert", "transform", "compare", "sort", "search", "filter", "map", "set", "queue", "tree", "graph", "list", "iterator", "generator", "random", "uuid", "id", "slug", "case", "unicode", "emoji", "i18n", "locale", "currency", "money", "duration", "timer", "schedule", "cron", "retry", "throttle", "debounce", "limit", "concurrency", "worker", "process", "shell", "command", "args", "argv", "options", "prompt", "progress", "table", "svg", "dom", "css", "style", "assert", "mock", "benchmark", "performance", "compression", "base64", "binary", "bytes", "file", "fs", "directory", "watch", "pipe", "error", "schema", "type", "types", "check", "detect", "os", "git", "npm", "package", "version", "sanitize", "security", "token", "checksum", "geometry", "vector", "matrix", "statistics", "algorithm", "data-structure", "heap", "lru", "memoize", "emitter", "observable", "signal", "state", "immutable", "clone", "deep", "merge", "patch", "equal", "get", "flatten", "range", "pad", "trim", "truncate", "wrap", "indent", "word", "tokenize", "lexer", "ast", "compiler", "bigint", "decimal", "round", "ms", "calendar", "timezone", "iso8601", "jsonl", "ini", "toml", "xml", "sql", "mime", "email", "ip", "dns", "network", "tsv", "utf8", "ascii", "char", "emoji", "levenshtein", "fuzzy", "pluralize", "humanize", "license", "semantic", "functional", "fp", "lazy", "abort", "timeout", "sleep", "delay", "mutex", "lock", "pool"];
export const CONFIGS = {
  1: { discovery: { maxRepos: 1000 }, commits: { maxValidatePerRepo: 4 }, batch: { maxTasks: 12, maxPerFamily: 2, maxPerOwner: 4, seed: "ctrl-confirm-2/supply" } },
  2: { discovery: { keywords: [...new Set(WAVE2_KEYWORDS)], perKeyword: 1000, delayMs: 1500, maxRepos: 2000 }, commits: { maxValidatePerRepo: 4 }, batch: { maxTasks: 12, maxPerFamily: 2, maxPerOwner: 4, seed: "ctrl-confirm-2/supply" } },
};
export const CONFIG = CONFIGS[1];
export const MAX_CASES_PER_REPO = 3;

/** Every repository slug the external pool names (registry case records + discovered lists of its reports). Read-only. */
export function externalSlugs(externalPool) {
  const slugs = new Set();
  if (!externalPool || !existsSync(externalPool)) return slugs;
  const reg = join(externalPool, "registry.jsonl");
  if (existsSync(reg)) for (const line of readFileSync(reg, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(line); if (r.repo) slugs.add(String(r.repo).toLowerCase()); }
  const reports = join(externalPool, "reports");
  if (existsSync(reports)) for (const f of readdirSync(reports).filter(n => n.endsWith(".json"))) {
    const d = JSON.parse(readFileSync(join(reports, f), "utf8"));
    for (const s of d.discovered ?? []) slugs.add(String(s).toLowerCase());
    for (const e of d.eligible ?? []) { const m = /github\.com\/([^/]+\/[^/]+)/.exec(e.url ?? ""); if (m) slugs.add(m[1].toLowerCase()); }
  }
  return slugs;
}

export const sliceOf = (repos, i, k) => repos.filter((_, n) => n % k === i);

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: "string" }, "external-pool": { type: "string" }, slice: { type: "string" }, wave: { type: "string", default: "1" }, "exclude-plan": { type: "string", multiple: true }, limit: { type: "string" } } });
  const cmd = positionals[0];
  if (!values.root || !["discover", "collect"].includes(cmd) || !CONFIGS[values.wave]) { process.stderr.write("usage: supply.mjs discover|collect --root DIR [--wave 1|2] [--external-pool DIR] [--exclude-plan repos.json ...] [--slice i/k]\n"); return 64; }
  const root = ensureDir(resolve(values.root));
  const cfg = mergeSupply(CONFIGS[values.wave]);
  const log = (s) => process.stderr.write(`[ctrl-confirm-2 supply] ${s}\n`);
  if (cmd === "discover") {
    const external = externalSlugs(values["external-pool"]);
    // Repositories already planned by an earlier wave are excluded as well (one family is collected in one wave only).
    for (const p of values["exclude-plan"] ?? []) for (const r of JSON.parse(readFileSync(p, "utf8")).repos) external.add(r.slug);
    const repos = await discoverRepos(cfg, { log });
    const kept = repos.filter(r => !external.has(r.slug));
    atomicWriteJson(join(root, "repos.json"), { at: new Date().toISOString(), config: cfg, configDigest: digestOf(cfg), externalPool: values["external-pool"] ?? null, externalSlugs: [...external].sort(), discovered: repos.length, excludedAsExternal: repos.filter(r => external.has(r.slug)).map(r => r.slug), repos: kept });
    process.stdout.write(`${JSON.stringify({ discovered: repos.length, excluded: repos.length - kept.length, kept: kept.length })}\n`);
    return 0;
  }
  const [i, k] = String(values.slice ?? "0/1").split("/").map(Number);
  const plan = JSON.parse(readFileSync(join(root, "repos.json"), "utf8"));
  if (plan.configDigest !== digestOf(cfg)) throw new Error("repos.json was discovered with another configuration");
  // --limit M: collect only the first M repositories in a seeded, outcome-blind order (sha256(seed:slug)); the order and the
  // limit are recorded in every slice report. Without --limit: discovery order, every repository.
  const limit = values.limit ? Number(values.limit) : Infinity;
  const ordered = Number.isFinite(limit) ? [...plan.repos].sort((a, b) => sha256(`${cfg.batch.seed}:repo:${a.slug}`).localeCompare(sha256(`${cfg.batch.seed}:repo:${b.slug}`))).slice(0, limit) : plan.repos;
  const repos = sliceOf(ordered, i, k);
  const pool = ensureDir(join(root, `pool-${i}`));
  const { gradeWorkspace } = await import("../../src/grader.mjs");
  const { ORCHE, hostEnvironment } = await import("../../src/sandbox.mjs");
  const env = hostEnvironment();
  const tmpRoot = ensureDir(join(pool, "tmp"));
  const validate = (dir, opts = {}) => validateCase(dir, { env, scratch: mkdtempSync(join(tmpRoot, "v-")), repeats: cfg.validation.repeats, timeoutMs: cfg.validation.timeoutMs, gradeWorkspace, ...opts });
  const summary = await collect({ pool, cfg, repos, env, orcheDir: ORCHE, log, validate, maxCasesPerRepo: MAX_CASES_PER_REPO });
  ensureDir(join(pool, "reports"));
  writeFileSync(join(pool, "reports", `collect-slice-${i}-of-${k}.json`), `${JSON.stringify({ ...summary, plan: { limit: Number.isFinite(limit) ? limit : null, order: Number.isFinite(limit) ? "sha256(batch.seed:repo:slug)" : "discovery", slice: `${i}/${k}` } }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ slice: `${i}/${k}`, repositories: summary.repositories, eligible: summary.eligible.length, errors: summary.errors.length })}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(code => process.exit(code), error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
