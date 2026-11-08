#!/usr/bin/env node
// ctrl-confirm-4 collection phase 2 (prospective, COLLECTION.md): model-free acquisition of fresh external tasks into the NEW
// workspace-local supply root results/ctrl-confirm-4-supply. No agent ever runs here; nothing outside --root is written.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/supply.mjs plan     --root DIR --prior-plan FILE --prior-supply DIR --consumed DIR ...
//   node pi-eval-loop/experiments/ctrl-confirm-4/supply.mjs discover --root DIR --consumed DIR ...      (plan B: new keywords only)
//   node pi-eval-loop/experiments/ctrl-confirm-4/supply.mjs collect  --root DIR --slice i/k --until ISO
//
// Plan A = the ctrl-confirm-3 discovery plan's repositories that ctrl-confirm-3 never reached (no registry record, no clone), minus
// every repository named by any consumed root (registries, reports, sealed families) - re-checked now, so repositories collected by
// other pools after ctrl-confirm-3's discovery (e.g. agent_workflow) are excluded too. Plan B = repositories discovered with the
// NEW keywords only, minus plan A, minus everything ctrl-confirm-3 discovered (kept or excluded), minus consumed roots.
// collect: slice i/k of plan A in seeded order sha256(seed:repo:slug); when plan A's slice is exhausted before --until and plan B is
// frozen (plan-b.json exists), slice i/k of plan B in its seeded order. --until is checked before every repository: no repository
// is started at or after the cutoff. Progress (start/end per repository) is appended to pool-i/progress.jsonl, so a restarted
// collector skips finished repositories and records the interrupted one (never re-started; evidence kept).
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { collect, discoverRepos, mergeSupply, validateCase } from "../../src/supply.mjs";
import { atomicWriteJson, digestOf, ensureDir, sha256 } from "../../src/util.mjs";
import { externalSlugs, sliceOf } from "../ctrl-confirm-2/supply.mjs";
import { CONFIG as CC3_CONFIG, MAX_CASES_PER_REPO, consumedSlugs } from "../ctrl-confirm-3/supply.mjs";

/** Keywords new in ctrl-confirm-4 (fixed before discovery; plan B searches ONLY these). */
export const NEW_KEYWORDS = ["react-hooks", "vue", "svelte", "solid", "preact", "astro", "next", "nuxt", "remix", "electron", "tauri", "react-native", "expo", "vscode", "vscode-extension", "neovim", "obsidian", "raycast", "figma", "slack", "discord", "telegram", "whatsapp", "notion", "airtable", "stripe", "paypal", "shopify", "aws", "s3", "lambda", "cloudflare", "workers", "vercel", "netlify", "supabase", "firebase", "postgres", "mysql", "redis", "mongodb", "orm", "query-builder", "migration", "backup", "docker", "kubernetes", "ci", "github-actions", "deploy", "devops", "terraform", "yaml-parser", "frontmatter", "mdx", "remark", "rehype", "unified", "babel", "postcss", "tailwind", "esbuild", "rollup", "webpack", "bundler", "transpiler", "typescript", "jsdoc", "dts", "codegen", "scaffold", "generator-cli", "boilerplate", "starter", "framework", "microservice", "rpc", "grpc", "protobuf", "avro", "thrift", "jsonrpc", "sse", "server-sent-events", "webhook", "oauth", "openid", "saml", "session", "cookie", "csrf", "cors", "helmet", "headers", "url-parser", "querystring", "punycode", "idn", "domain", "whois", "geoip", "maps", "coordinates", "distance", "haversine", "astronomy", "physics", "chemistry", "biology", "genomics", "bioinformatics", "health", "fitness", "weather", "sports", "chess", "poker", "dice", "cards", "puzzle", "sudoku", "maze", "noise", "procedural", "animation", "easing", "tween", "color-conversion", "palette", "contrast", "accessibility", "a11y", "aria", "keyboard", "shortcut", "clipboard", "drag-and-drop", "gesture", "touch", "scroll", "virtual-list", "pagination", "infinite-scroll", "form", "input-mask", "datepicker", "autocomplete", "typeahead", "search-engine", "full-text-search", "inverted-index", "bloom-filter", "trie", "skip-list", "ring-buffer", "priority-queue", "union-find", "topological-sort", "dijkstra", "pathfinding", "graph-algorithm", "sorting-algorithm", "combinatorics", "permutation", "prime", "fibonacci", "fraction", "rational", "complex-number", "linear-algebra", "fft", "signal-processing", "interpolation", "regression", "clustering", "machine-learning", "neural-network", "tensor", "dataframe", "pivot", "aggregation", "histogram", "percentile", "quantile", "sampling", "shuffle", "seedrandom", "prng", "entropy", "password-generator", "otp", "totp", "2fa", "qrcode", "barcode", "ean", "isbn", "iban", "credit-card", "luhn", "phone", "postal-code", "address", "country", "language-detection", "transliteration", "romanization", "hangul", "korean", "japanese", "chinese", "cjk", "rtl", "bidi", "grapheme", "normalize", "collation", "natural-sort", "diff-match-patch", "patience-diff", "three-way-merge", "crdt", "operational-transform", "sync", "offline", "indexeddb", "localstorage", "service-worker", "pwa", "worker-threads", "child-process", "cluster", "ipc", "signals", "graceful-shutdown", "health-check", "circuit-breaker", "backoff", "bulkhead", "idempotency", "dedupe", "batching", "dataloader", "stream-processing", "backpressure", "ndjson", "line-reader", "tail", "log-parser", "syslog", "apache", "nginx", "access-log", "user-agent", "bot-detection", "robots-txt", "sitemap", "rss", "atom", "feed", "scraper", "crawler", "html-parser", "css-selector", "xpath", "sanitizer", "xss", "escape-html", "entities", "minifier", "beautifier", "prettier-plugin", "code-formatter", "syntax-highlighting", "tokenizer-js", "parser-combinator", "peg", "grammar", "interpreter", "vm", "bytecode", "wasm", "webassembly", "emulator", "assembler", "disassembler", "hex", "hexdump", "endianness", "bitfield", "bitset", "varint", "leb128", "crc", "adler32", "murmurhash", "xxhash", "fnv", "sha", "md5", "blake", "argon2", "bcrypt", "scrypt", "pbkdf2", "aes", "rsa", "ecdsa", "ed25519", "x509", "pem", "asn1", "der", "base32", "base58", "bech32", "multibase", "cid", "ipfs", "torrent", "magnet", "p2p", "webrtc", "socket", "tcp", "udp", "dns-over-https", "ping", "port", "netmask", "cidr", "ipv6", "mac-address", "snmp", "mqtt", "amqp", "kafka", "nats", "zeromq", "message-queue", "event-sourcing", "cqrs", "saga", "state-machine", "fsm", "statechart", "behavior-tree", "rule-engine", "expression-evaluator", "formula", "calculator", "units", "unit-conversion", "measurement", "temperature", "bytes-format", "filesize", "pretty-ms", "relative-time", "countdown", "stopwatch", "rate-limiter", "token-bucket", "leaky-bucket", "quota", "billing", "invoice", "tax", "accounting", "ledger", "double-entry", "budget", "expense", "crypto-currency", "bitcoin", "ethereum", "solana", "nft", "wallet"];

/** Collection configuration: ctrl-confirm-3's (same filters, validation, per-repository limits) with a ctrl-confirm-4 seed. */
export const CONFIG = { ...CC3_CONFIG, batch: { ...CC3_CONFIG.batch, seed: "ctrl-confirm-4/supply" } };
export const DISCOVERY_B = { ...CONFIG, discovery: { ...CC3_CONFIG.discovery, keywords: NEW_KEYWORDS.filter(k => !CC3_CONFIG.discovery.keywords.includes(k)), maxRepos: 20000 } };

/** Slugs a supply root touched: registry/report repositories plus every cloned repository in pool caches (scanned, maybe no case). */
export function touchedSlugs(root) {
  const out = new Set(consumedSlugs(root).slugs);
  if (!existsSync(root)) return out;
  for (const p of readdirSync(root)) {
    const cache = join(root, p, "cache", "repos");
    if (existsSync(cache)) for (const d of readdirSync(cache)) { const m = /^(.+?)\.git(\.tmp-\d+)?$/.exec(d); if (m) out.add(m[1].replace("__", "/").toLowerCase()); }
  }
  return out;
}

export function exclusionsOf({ externalPool, consumed = [] }) {
  const why = new Map();
  for (const s of externalSlugs(externalPool)) why.set(s, "external-pool");
  for (const c of consumed) for (const s of touchedSlugs(c)) if (!why.has(s)) why.set(s, `consumed:${c}`);
  return why;
}

export const seededOrder = (repos, seed) => [...repos].sort((a, b) => sha256(`${seed}:repo:${a.slug}`).localeCompare(sha256(`${seed}:repo:${b.slug}`)));

/** Repositories of slice i/k still to start: plan A first, then plan B if frozen. Finished or interrupted repositories are skipped. */
export function remainingRepos({ planA, planB, i, k, seed, progress }) {
  const started = new Set(progress.filter(p => p.type === "start").map(p => p.slug));
  const a = sliceOf(seededOrder(planA.repos, seed), i, k).map(r => ({ ...r, plan: "A" }));
  const b = planB ? sliceOf(seededOrder(planB.repos, seed), i, k).map(r => ({ ...r, plan: "B" })) : [];
  return [...a, ...b].filter(r => !started.has(r.slug));
}

const readJsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: "string" }, "external-pool": { type: "string" }, consumed: { type: "string", multiple: true }, "prior-plan": { type: "string" }, "prior-supply": { type: "string" }, slice: { type: "string" }, until: { type: "string" } } });
  const cmd = positionals[0];
  if (!values.root || !["plan", "discover", "collect"].includes(cmd)) { process.stderr.write("usage: supply.mjs plan|discover|collect --root DIR ...\n"); return 64; }
  const root = ensureDir(resolve(values.root));
  const log = (s) => process.stderr.write(`[ctrl-confirm-4 supply] ${new Date().toISOString()} ${s}\n`);
  const consumed = (values.consumed ?? []).map(c => resolve(c));
  if (cmd === "plan") {
    if (existsSync(join(root, "plan-a.json"))) throw new Error("plan-a.json exists: plans are frozen");
    const prior = JSON.parse(readFileSync(resolve(values["prior-plan"]), "utf8"));
    const why = exclusionsOf({ externalPool: values["external-pool"], consumed: [resolve(values["prior-supply"]), ...consumed] });
    const kept = prior.repos.filter(r => !why.has(r.slug.toLowerCase()));
    const excluded = prior.repos.filter(r => why.has(r.slug.toLowerCase())).map(r => ({ slug: r.slug, why: why.get(r.slug.toLowerCase()) }));
    atomicWriteJson(join(root, "plan-a.json"), { at: new Date().toISOString(), plan: "A", config: mergeSupply(CONFIG), configDigest: digestOf(mergeSupply(CONFIG)), priorPlan: resolve(values["prior-plan"]), priorPlanSha256: sha256(readFileSync(resolve(values["prior-plan"]))), priorSupply: resolve(values["prior-supply"]), externalPool: values["external-pool"] ?? null, consumedRoots: consumed, priorRepos: prior.repos.length, excluded, repos: kept });
    process.stdout.write(`${JSON.stringify({ prior: prior.repos.length, excluded: excluded.length, kept: kept.length })}\n`);
    return 0;
  }
  if (cmd === "discover") {
    if (existsSync(join(root, "plan-b.json"))) throw new Error("plan-b.json exists: plans are frozen");
    const planA = JSON.parse(readFileSync(join(root, "plan-a.json"), "utf8"));
    const priorPlan = JSON.parse(readFileSync(planA.priorPlan, "utf8"));
    const why = exclusionsOf({ externalPool: planA.externalPool, consumed: [planA.priorSupply, ...planA.consumedRoots] });
    for (const r of planA.repos) why.set(r.slug.toLowerCase(), "plan-a");
    for (const r of priorPlan.repos) if (!why.has(r.slug.toLowerCase())) why.set(r.slug.toLowerCase(), "ctrl-confirm-3-discovery");
    for (const r of priorPlan.excluded ?? []) if (!why.has(r.slug.toLowerCase())) why.set(r.slug.toLowerCase(), "ctrl-confirm-3-discovery-excluded");
    const cfg = mergeSupply(DISCOVERY_B);
    const repos = await discoverRepos(cfg, { log });
    const kept = repos.filter(r => !why.has(r.slug.toLowerCase()));
    atomicWriteJson(join(root, "plan-b.json"), { at: new Date().toISOString(), plan: "B", config: cfg, configDigest: digestOf(cfg), discovered: repos.length, excluded: repos.filter(r => why.has(r.slug.toLowerCase())).map(r => ({ slug: r.slug, why: why.get(r.slug.toLowerCase()) })), repos: kept });
    process.stdout.write(`${JSON.stringify({ discovered: repos.length, kept: kept.length })}\n`);
    return 0;
  }
  const until = Date.parse(values.until ?? "");
  if (!Number.isFinite(until)) throw new Error("collect needs --until ISO (the preregistered cutoff)");
  const [i, k] = String(values.slice ?? "0/1").split("/").map(Number);
  const cfg = mergeSupply(CONFIG);
  const planA = JSON.parse(readFileSync(join(root, "plan-a.json"), "utf8"));
  if (planA.configDigest !== digestOf(cfg)) throw new Error("plan-a.json was made with another configuration");
  const pool = ensureDir(join(root, `pool-${i}`));
  const progressFile = join(pool, "progress.jsonl");
  const note = (r) => appendFileSync(progressFile, `${JSON.stringify({ ...r, at: new Date().toISOString(), pid: process.pid })}\n`, { mode: 0o600 });
  const prior = readJsonl(progressFile);
  for (const s of prior.filter(p => p.type === "start" && !prior.some(e => e.type === "end" && e.slug === p.slug))) note({ type: "interrupted", slug: s.slug, plan: s.plan, note: "started by an earlier collector process that ended before finishing it; never restarted" });
  note({ type: "collector", slice: `${i}/${k}`, until: new Date(until).toISOString() });
  const { gradeWorkspace } = await import("../../src/grader.mjs");
  const { ORCHE, hostEnvironment } = await import("../../src/sandbox.mjs");
  const env = hostEnvironment();
  const tmpRoot = ensureDir(join(pool, "tmp"));
  const validate = (dir, opts = {}) => validateCase(dir, { env, scratch: mkdtempSync(join(tmpRoot, "v-")), repeats: cfg.validation.repeats, timeoutMs: cfg.validation.timeoutMs, gradeWorkspace, ...opts });
  let n = 0;
  while (true) {
    const planB = existsSync(join(root, "plan-b.json")) ? JSON.parse(readFileSync(join(root, "plan-b.json"), "utf8")) : null;
    const [repo] = remainingRepos({ planA, planB, i, k, seed: cfg.batch.seed, progress: readJsonl(progressFile) });
    if (!repo) { note({ type: "exhausted", planB: !!planB }); break; }
    if (Date.now() >= until) { note({ type: "cutoff", next: repo.slug }); break; }
    note({ type: "start", slug: repo.slug, plan: repo.plan });
    const s = await collect({ pool, cfg, repos: [repo], env, orcheDir: ORCHE, log, validate, maxCasesPerRepo: MAX_CASES_PER_REPO });
    note({ type: "end", slug: repo.slug, plan: repo.plan, eligible: s.eligible.length, errors: s.errors.map(e => e.code) });
    n++;
  }
  process.stdout.write(`${JSON.stringify({ slice: `${i}/${k}`, repositories: n })}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(code => process.exit(code), error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
