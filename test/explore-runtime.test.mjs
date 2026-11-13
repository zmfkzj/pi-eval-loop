// The recurring exploration route on its REAL isolated runtime path (2026-11-07): pinned gateway binary in a bwrap network
// namespace, outbound attempt gate charging a fixture ledger, a local TLS stand-in for the provider (chatgpt.com rerouted in test
// mode; fake JWT-shaped tokens only). Each cycle runs in its own child process (fresh env) with a backend that sends real HTTP model
// requests through the runtime (test/fixtures/http-backend.mjs). Checked: the provider never receives more requests than the gate
// admitted against the ledger, no request uses any other upstream (the shared gateway is never a fallback), and expired
// credentials, a misbound ledger, a foreign EVAL_LOOP_UPSTREAM, a failed start, concurrent cycles, a killed cycle and budget
// exhaustion all end without unmetered attempts. Skipped (each invariant then unverified here) when the pinned binary, bwrap or
// openssl is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { LIVE, fakeJwt, makeCert, standIn, stopRuntime, waitStopped } from "../studies/confirmatory-1/isolated-runtime.mjs";
import { prepareRuntime, runtimeProblems, gatewayPids } from "../src/isolated-runtime.mjs";
import { RequestBudget } from "../src/request-budget.mjs";
import { caseDigest, poolState, registryOf } from "../src/supply.mjs";
import { holdoutLedger, sealOf } from "../src/datasets.mjs";
import { runtimeDigest } from "../src/exploration.mjs";
import { Ledger, sha256 } from "../src/util.mjs";

const MISSING = [[LIVE.binary, "pinned gateway binary"], ["/usr/bin/bwrap", "bwrap"]].filter(([p]) => !existsSync(p)).map(([, n]) => n);
if (spawnSync("openssl", ["version"]).status !== 0) MISSING.push("openssl");
const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/http-backend.mjs", import.meta.url));
const RT = fileURLToPath(new URL("../studies/confirmatory-1/isolated-runtime.mjs", import.meta.url));
const HARD = { dataset: "Exercism TS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
const SCOPE = "test exploration runtime";

const CHILD = `
import { runExploreCycle } from ${JSON.stringify(join(SRC_DIR, "explore-cycle.mjs"))};
import { httpBackend } from ${JSON.stringify(FIXTURE)};
import * as rt from ${JSON.stringify(RT)};
const [cfg, state, log, orche, turns] = process.argv.slice(1);
const o = await runExploreCycle(cfg, state, { deps: { backend: httpBackend({ turns: Number(turns), log }), validate: async () => ({ ok: true, expected: {}, baselineFailing: [] }), checks: async () => ({ pass: true, problems: [] }), envDigest: { digest: "rt", facts: {} }, orcheDir: orche, startRuntime: (d, o) => rt.startRuntime(d, { ...o, timeoutMs: 15000 }) } });
process.stdout.write(JSON.stringify({ outcome: o.outcome, code: o.status?.exploration?.code ?? null, outcomeKind: o.status?.exploration?.outcome ?? null, reason: o.status?.blocked?.reason ?? null, adopt: o.status?.final?.adopt ?? null }) + "\\n");
`;

function tree(dir, text) { mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src", "x.ts"), text); writeFileSync(join(dir, "package.json"), "{}"); return dir; }
function dataset(dir, specs) { for (const [id, family] of specs) { mkdirSync(join(dir, id, "repo"), { recursive: true }); writeFileSync(join(dir, id, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, family, tier: "easy", instruction: `Solve ${id}`, provenance: "external" })); } writeFileSync(join(dir, "SEAL.json"), JSON.stringify(sealOf(dir))); return dir; }
function stage(pool, id, family, hard) {
  const d = join(pool, "cases", id);
  for (const p of ["repo", "hidden", "reference"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(d, "hidden", "h.test.js"), "// h\n"); writeFileSync(join(d, "reference", "index.js"), "// r\n");
  writeFileSync(join(d, "task.json"), JSON.stringify({ id, family, tier: hard ? "hard" : "easy", instruction: `Solve ${id}`, provenance: "external", ...(hard ? { difficultyBasis: "source", difficultySource: HARD } : {}) }));
  writeFileSync(join(d, "validation.private.json"), JSON.stringify({ ok: true, code: "valid" }));
  registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family, tier: hard ? "hard" : "easy", difficultyBasis: hard ? "source" : "declared", contentDigest: caseDigest(d) });
}
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
function runChild(root, cfg, state, turns = 2, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }; delete env.EVAL_LOOP_UPSTREAM; delete env.EVAL_LOOP_AGENT_DIR; Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, cfg, state, join(root, "requests.jsonl"), join(root, "orche"), String(turns)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (c) => { out += c; }); child.stderr.on("data", (c) => { err += c; });
  const done = new Promise((ok) => child.on("exit", (code, signal) => ok({ code, signal, out: out.trim() ? JSON.parse(out.trim().split("\n").at(-1)) : null, err })));
  return { child, done };
}
const sentLog = (root) => existsSync(join(root, "requests.jsonl")) ? readFileSync(join(root, "requests.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

test("exploration route on the real isolated runtime: every provider request is a gate-admitted, ledger-charged attempt; every failure path stays metered and never falls back", { skip: MISSING.length ? `missing ${MISSING.join(", ")}: the runtime invariants of this test are unverified here` : false, timeout: 600_000 }, async () => {
  const root = tempDir();
  const cert = makeCert(root);
  const { s, server, port } = await standIn(cert);
  s.mode = "ok";
  const rtDir = join(root, "rt"), ledger = join(root, "budget", "ledger.jsonl");
  const LIMIT = 4000;
  try {
    const outer = await freePort();
    prepareRuntime({ dir: rtDir, binary: LIVE.binary, credential: { snapshot: { type: "codex", access_token: fakeJwt(Math.floor(Date.now() / 1000) + 30 * 86400), account_id: "t", disabled: false, prefix: "", websockets: false }, facts: { test: true, refreshTokenCopied: false } }, outerPort: outer, mode: "test", budget: { path: ledger, limit: LIMIT, scope: SCOPE } });
    writeFileSync(join(rtDir, "test-route.json"), JSON.stringify({ port, ca: join(root, "ca.pem") }));
    const manifest = JSON.parse(readFileSync(join(rtDir, "manifest.json"), "utf8"));
    const budget = new RequestBudget({ path: ledger, limit: LIMIT, scope: SCOPE });
    await budget.reserve(1, { test: "init" }).then((t) => budget.settle(t, 0));
    // World: frozen arms, screen, lineage sources, a pool requiring evidence.
    const cand = tree(join(root, "cand"), "export const c = 1;\n"), stable = tree(join(root, "stable"), "export const s = 1;\n");
    const report = join(root, "screen-report.json"); writeFileSync(report, JSON.stringify({ accepted: true }));
    const reg = join(root, "old-registry.jsonl"); new Ledger(reg).append({ type: "case", caseId: "x-old-1", family: "gh:old/repo", status: "eligible" });
    const pool = join(root, "pool"); mkdirSync(pool, { recursive: true }); mkdirSync(join(root, "orche"));
    writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false }));
    const base = { schema: "pi-eval-loop/exploration@1", seriesSeed: "rt", candidate: { dir: cand, identity: { commit: "cand@1", runtimeDigest: runtimeDigest(cand) } }, stable: { dir: stable, commit: "stable@1", runtimeDigest: runtimeDigest(stable) },
      screen: { report, reportSha256: sha256(readFileSync(report)), tasks: [{ id: "d1", dataset: dataset(join(root, "screen-tasks"), [["d1", "gh:dev/x"]]) }] }, pool, lineage: { registries: [reg], datasets: [dataset(join(root, "old-holdout"), [["o1", "gh:old/ds"]])] },
      budget: { ledger, limit: LIMIT, scope: SCOPE, minRemaining: 700 }, runtime: { dir: rtDir, autoStart: true, mode: "test" }, orcheDir: join(root, "orche"), parallelism: 2,
      batchRule: { seed: "rt", maxTasks: 6, maxPerFamily: 1, maxPerOwner: 3, maxOwnerShare: 0.5, preferFreshFamilies: true }, supply: { collector: "none" } };
    const cfgFile = (name, over = {}) => { const f = join(root, `${name}.json`); writeFileSync(f, JSON.stringify({ ...base, ...over })); return f; };
    const good = cfgFile("good");
    const { refreshExploration } = await import("../src/explore-cycle.mjs");
    let batchN = 0;
    const newBatch = async () => { batchN++; for (let i = 1; i <= 6; i++) stage(pool, `b${batchN}-${i}`, `gh:b${batchN}x${i}/r`, i === 1); const r = await refreshExploration(good, { deps: { orcheDir: join(root, "orche") } }); assert.equal(r.code, 0, JSON.stringify(r.out)); return r.out.available.batch; };
    const counters = () => ({ provider: s.requests, attempts: budget.status().attempts });
    const invariant = (label) => { const c = counters(); assert.ok(c.provider <= c.attempts, `${label}: provider received ${c.provider} > admitted attempts ${c.attempts}`); for (const l of sentLog(root)) assert.equal(l.upstream, manifest.upstream, `${label}: a request used ${l.upstream}`); return c; };
    await newBatch();

    // 1) Expired credential (any mode): blocked before any start or dispatch.
    const rtExp = join(root, "rt-exp"), ledgerExp = join(root, "budget", "exp.jsonl");
    prepareRuntime({ dir: rtExp, binary: LIVE.binary, credential: { snapshot: { type: "codex", access_token: fakeJwt(Math.floor(Date.now() / 1000) - 60), account_id: "t", disabled: false, prefix: "", websockets: false }, facts: { test: true } }, outerPort: await freePort(), mode: "test", budget: { path: ledgerExp, limit: LIMIT, scope: SCOPE } });
    let c0 = counters();
    let r = await runChild(root, cfgFile("expired", { runtime: { dir: rtExp, autoStart: true, mode: "test" }, budget: { ...base.budget, ledger: ledgerExp } }), join(root, "c-exp")).done;
    assert.equal(r.out?.code, "runtime-wait", r.err); assert.match(r.out.reason, /expired/);
    assert.deepEqual(counters(), c0); assert.equal(gatewayPids(rtExp).length, 0);
    // 2) Misbound: the config's ledger is not the one the runtime's gate charges.
    r = await runChild(root, cfgFile("misbound", { budget: { ...base.budget, ledger: join(root, "budget", "other.jsonl") } }), join(root, "c-mis")).done;
    assert.equal(r.out?.code, "runtime-wait", r.err); assert.match(r.out.reason, /another budget ledger/);
    assert.deepEqual(counters(), c0);
    // 3) A foreign upstream in the environment (the shared live gateway): refused, never used.
    r = await runChild(root, good, join(root, "c-shared"), 2, { EVAL_LOOP_UPSTREAM: "http://127.0.0.1:8317" }).done;
    assert.equal(r.out?.code, "prerequisite-failed", r.err); assert.match(r.out.reason, /not the isolated runtime/);
    assert.deepEqual(counters(), c0); assert.equal(sentLog(root).length, 0);
    // 4) Start failure: the runtime's outer port is taken -> the start fails, the cycle waits (no dispatch, nothing left running).
    const squat = net.createServer(); await new Promise((ok) => squat.listen(outer, "127.0.0.1", ok));
    r = await runChild(root, good, join(root, "c-start")).done;
    await new Promise((ok) => squat.close(ok));
    assert.equal(r.out?.code, "runtime-wait", r.err); assert.match(r.out.reason, /runtime start failed|not served by the runtime supervisor/);
    assert.deepEqual(counters(), c0);
    stopRuntime(rtDir); await waitStopped(rtDir).catch(() => {});
    // 5) A full cycle: auto-start, ONE pass with nested turns through the gate (mixed provider answers incl. redirects/500), stop.
    s.mode = "ok";
    const flip = setInterval(() => { s.mode = s.mode === "ok" ? "redirect" : s.mode === "redirect" ? "500" : "ok"; }, 150);
    r = await runChild(root, good, join(root, "c-ok"), 2).done;
    clearInterval(flip); s.mode = "ok";
    assert.equal(r.out?.outcome, "cycle_done", `${JSON.stringify(r.out)} ${r.err.slice(-800)}`); assert.equal(r.out.adopt, false);
    const c5 = invariant("full cycle");
    assert.ok(c5.provider > c0.provider, "the pass reached the provider stand-in");
    assert.ok(sentLog(root).length > 0 && sentLog(root).every((l) => l.upstream === manifest.upstream));
    assert.ok(runtimeProblems(rtDir, { running: true, mode: "test" }).some((p) => /supervisor not running/.test(p)), "the cycle stopped the runtime it started");
    // 6) Killed mid-pass, then resumed in a new process: exactly one use and one reservation; the dead process's open unit
    //    reservations are settled at the attempt floor; still no unmetered request.
    const B2 = await newBatch();
    const k = runChild(root, good, join(root, "c-kill"), 2);
    const t0 = Date.now(); while (sentLog(root).filter((l) => l.pid === k.child.pid).length < 4 && Date.now() - t0 < 60_000) await new Promise((ok) => setTimeout(ok, 100));
    k.child.kill("SIGKILL"); await k.done;
    invariant("after kill");
    r = await runChild(root, good, join(root, "c-kill"), 2).done;
    assert.equal(r.out?.outcome, "cycle_done", `${JSON.stringify(r.out)} ${r.err.slice(-800)}`);
    assert.equal(holdoutLedger(join(pool, "batches", B2)).records().length, 1, "one use across the kill");
    assert.equal(poolState(pool).records.filter((x) => x.type === "reserve" && x.batch === B2).length, 1);
    assert.equal(budget.status().openReservations, 0, "no reservation left open");
    invariant("after resume");
    assert.ok(runtimeProblems(rtDir, { running: true, mode: "test" }).some((p) => /supervisor not running/.test(p)), "the runtime started by the killed cycle was stopped by the next auto-starting cycle");
    // 7) Two cycles at the same time (two processes, one runtime, one ledger): at most one consumes; nothing unmetered.
    await newBatch();
    const [x, y] = await Promise.all([runChild(root, good, join(root, "c-con-1"), 2).done, runChild(root, good, join(root, "c-con-2"), 2).done]);
    const outs = [x.out, y.out];
    assert.ok(outs.some((o) => o?.outcome === "cycle_done"), JSON.stringify(outs));
    assert.ok(outs.every((o) => o?.outcome === "cycle_done" || ["runtime-wait", "supply-empty", "supply-wait", "supply-error"].includes(o?.code)), `${JSON.stringify(outs)} ${[x, y].map((z) => `${z.code}/${z.signal} ${z.err.slice(-700)}`).join(" | ")}`);
    invariant("concurrent");
    assert.equal(budget.status().openReservations, 0);
    // 8) Budget exhaustion mid-pass: only `minRemaining` attempts left and more turns than fit -> the pass pauses as
    //    budget-exhausted; a restart dispatches nothing; attempts never exceed the limit.
    await newBatch();
    const left = budget.status().remaining;
    const burn = await budget.reserve(left - 700, { test: "other use" }); await budget.settle(burn, left - 700);
    r = await runChild(root, good, join(root, "c-budget"), 40).done;
    assert.equal(r.out?.code, "budget-exhausted", `${JSON.stringify(r.out)} ${r.err.slice(-600)}`);
    const c8 = invariant("exhaustion");
    assert.ok(c8.attempts <= LIMIT);
    r = await runChild(root, good, join(root, "c-budget"), 40).done;
    assert.equal(r.out?.code, "budget-exhausted");
    assert.deepEqual(counters(), c8, "a restart after exhaustion dispatches nothing");
    const st = budget.status();
    assert.ok(st.charged >= st.attempts && st.problems.length === 0, JSON.stringify(st));
  } finally {
    stopRuntime(rtDir); await waitStopped(rtDir).catch(() => {}); server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
