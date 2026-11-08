#!/usr/bin/env node
// ctrl-confirm-3: fresh external task acquisition into a NEW workspace-local supply root (model-free; no agent ever runs here).
//
//   node pi-eval-loop/experiments/ctrl-confirm-3/supply.mjs discover --root DIR --external-pool DIR --consumed DIR [--consumed DIR ...]
//   node pi-eval-loop/experiments/ctrl-confirm-3/supply.mjs collect  --root DIR --slice i/k [--limit M]
//
// Reuses the loop's public-source supply (src/supply.mjs: npm discovery, upstream-commit adaptation, license/provenance checks,
// validation in the grading sandbox) and the ctrl-confirm-2 wrapper helpers unchanged. Exclusions, applied BEFORE any clone:
//   * every repository named by the pre-existing external pool (read-only: its registry and collection reports);
//   * every repository named by any CONSUMED supply root (`--consumed`, e.g. results/ctrl-confirm-2-supply): every registry record
//     and every collection-report repository list of every pool below it, including the assigned-but-unfinished slices, and every
//     family of a sealed holdout below it. A repository that a consumed root only listed in its discovery plan but never assigned
//     to a slice (never cloned, no case, no agent exposure) is NOT consumed and may be collected (recorded in repos.json).
// It never writes outside --root and never reads hidden material of any other pool (registries and reports only).
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { collect, discoverRepos, mergeSupply, validateCase } from "../../src/supply.mjs";
import { atomicWriteJson, digestOf, ensureDir, sha256 } from "../../src/util.mjs";
import { WAVE2_KEYWORDS, externalSlugs, sliceOf } from "../ctrl-confirm-2/supply.mjs";

/** Keywords added for ctrl-confirm-3 (fixed before any collection; the union with the earlier lists is searched). */
export const EXTRA_KEYWORDS = ["util", "utils", "helper", "helpers", "tool", "tools", "library", "lib", "sdk", "client", "agent", "ai", "llm", "mcp", "openai", "claude", "bot", "plugin", "middleware", "router", "server", "websocket", "testing", "test", "validator", "formatter", "linter", "minify", "web", "database", "storage", "kv", "sqlite", "auth", "jwt", "password", "encryption", "hmac", "rate-limit", "events", "pubsub", "scheduler", "job", "task", "workflow", "automation", "github", "text-processing", "nlp", "language", "image", "audio", "pdf", "spreadsheet", "chart", "canvas", "game", "simulation", "finance", "blockchain", "web3", "geo", "music", "zero-dependency", "no-dependencies", "dependency-free", "lightweight", "tiny", "minimal", "small", "fast", "simple", "pure", "isomorphic", "universal", "deno", "bun", "esm-only", "commonjs", "polyfill", "spec", "rfc", "protocol", "codec", "serializer", "msgpack", "cbor", "jsonschema", "openapi", "graphql", "rest", "http-client", "proxy", "tui", "logging", "metrics", "monitoring", "tracing", "assertion", "snapshot", "fixture", "fake", "template-engine", "static-site", "changelog", "monorepo", "eslint-plugin", "vite-plugin", "claude-code", "codex", "cursor", "prompt", "embeddings", "rag", "tokenizer", "dotenv", "secrets", "hooks", "context", "memory", "cost", "usage", "audit", "guard", "policy", "permissions", "sandbox"];
const WAVE1_KEYWORDS = ["parser", "string", "array", "object", "url", "path", "json", "cli", "promise", "stream", "validation", "format", "color", "time", "date", "math", "hash", "diff", "glob", "utility", "encode", "escape", "semver", "template", "markdown", "csv", "yaml", "query", "cache", "ansi", "terminal", "html", "regex", "number", "text", "filesystem", "async", "event", "buffer", "crypto"];
export const CONFIG = { discovery: { keywords: [...new Set([...WAVE1_KEYWORDS, ...WAVE2_KEYWORDS, ...EXTRA_KEYWORDS])], perKeyword: 1000, delayMs: 1200, maxRepos: 6000 }, commits: { maxValidatePerRepo: 4 }, batch: { maxTasks: 12, maxPerFamily: 2, maxPerOwner: 4, seed: "ctrl-confirm-3/supply" } };
export const MAX_CASES_PER_REPO = 3;

/** Pools (directories with registry.jsonl) and sealed holdouts (directories with SEAL.json) below a consumed root (depth <= 3). */
export function consumedSlugs(root) {
  const slugs = new Set(), pools = [];
  const visit = (d, depth) => {
    if (depth > 3 || !existsSync(d)) return;
    if (existsSync(join(d, "registry.jsonl"))) { pools.push(d); for (const s of externalSlugs(d)) slugs.add(s); }
    if (existsSync(join(d, "SEAL.json"))) for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && existsSync(join(d, e.name, "task.json"))) { const f = JSON.parse(readFileSync(join(d, e.name, "task.json"), "utf8")).family; if (f) slugs.add(String(f).replace(/^gh:/, "").toLowerCase()); }
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !["cases", "cache", "tmp", "repo", "hidden", "reference"].includes(e.name)) visit(join(d, e.name), depth + 1);
  };
  visit(resolve(root), 0);
  return { slugs, pools };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: "string" }, "external-pool": { type: "string" }, consumed: { type: "string", multiple: true }, slice: { type: "string" }, limit: { type: "string" } } });
  const cmd = positionals[0];
  if (!values.root || !["discover", "collect"].includes(cmd)) { process.stderr.write("usage: supply.mjs discover|collect --root DIR [--external-pool DIR] [--consumed DIR ...] [--slice i/k] [--limit M]\n"); return 64; }
  const root = ensureDir(resolve(values.root));
  const cfg = mergeSupply(CONFIG);
  const log = (s) => process.stderr.write(`[ctrl-confirm-3 supply] ${s}\n`);
  if (cmd === "discover") {
    if (existsSync(join(root, "repos.json"))) throw new Error("repos.json exists: never re-discover into a used root");
    const external = externalSlugs(values["external-pool"]);
    const consumed = new Set(), consumedPools = [];
    for (const c of values.consumed ?? []) { const r = consumedSlugs(c); for (const s of r.slugs) consumed.add(s); consumedPools.push(...r.pools); }
    const repos = await discoverRepos(cfg, { log });
    const why = (slug) => (external.has(slug) ? "external-pool" : consumed.has(slug) ? "consumed-supply-or-holdout" : null);
    const kept = repos.filter(r => !why(r.slug));
    atomicWriteJson(join(root, "repos.json"), { at: new Date().toISOString(), config: cfg, configDigest: digestOf(cfg), externalPool: values["external-pool"] ?? null, consumedRoots: values.consumed ?? [], consumedPools, externalSlugs: external.size, consumedSlugs: [...consumed].sort(), discovered: repos.length, excluded: repos.filter(r => why(r.slug)).map(r => ({ slug: r.slug, why: why(r.slug) })), repos: kept });
    process.stdout.write(`${JSON.stringify({ discovered: repos.length, excluded: repos.length - kept.length, kept: kept.length })}\n`);
    return 0;
  }
  const [i, k] = String(values.slice ?? "0/1").split("/").map(Number);
  const plan = JSON.parse(readFileSync(join(root, "repos.json"), "utf8"));
  if (plan.configDigest !== digestOf(cfg)) throw new Error("repos.json was discovered with another configuration");
  // Seeded, outcome-blind order (sha256(seed:repo:slug)); --limit M keeps the first M. Order and limit go into every slice report.
  const limit = values.limit ? Number(values.limit) : Infinity;
  const ordered = [...plan.repos].sort((a, b) => sha256(`${cfg.batch.seed}:repo:${a.slug}`).localeCompare(sha256(`${cfg.batch.seed}:repo:${b.slug}`))).slice(0, limit);
  const repos = sliceOf(ordered, i, k);
  const pool = ensureDir(join(root, `pool-${i}`));
  const { gradeWorkspace } = await import("../../src/grader.mjs");
  const { ORCHE, hostEnvironment } = await import("../../src/sandbox.mjs");
  const env = hostEnvironment();
  const tmpRoot = ensureDir(join(pool, "tmp"));
  const validate = (dir, opts = {}) => validateCase(dir, { env, scratch: mkdtempSync(join(tmpRoot, "v-")), repeats: cfg.validation.repeats, timeoutMs: cfg.validation.timeoutMs, gradeWorkspace, ...opts });
  const summary = await collect({ pool, cfg, repos, env, orcheDir: ORCHE, log, validate, maxCasesPerRepo: MAX_CASES_PER_REPO });
  ensureDir(join(pool, "reports"));
  writeFileSync(join(pool, "reports", `collect-slice-${i}-of-${k}.json`), `${JSON.stringify({ ...summary, plan: { limit: Number.isFinite(limit) ? limit : null, order: "sha256(batch.seed:repo:slug)", slice: `${i}/${k}` } }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ slice: `${i}/${k}`, repositories: summary.repositories, eligible: summary.eligible.length, errors: summary.errors.length })}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(code => process.exit(code), error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
