// Simulated-only fault controls (simulation.crash / simulation.byPhase, src/explore-cycle.mjs) through the REAL CLI:
// bin/eval-loop-explore.mjs refresh / --resume / --status as separate processes, no injected backend. The two rollback routes
// of the autonomous lifecycle (post-adoption smoke failure, failed independent post-adoption confirmation) run end to end on
// the real release history, pool, holdout use ledgers, series alpha ledger and request budget. Also: the controls are refused
// outside a simulated cycle, in mode screening and when malformed, and leave a cycle without them unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { caseDigest, poolState, registryOf } from "../src/supply.mjs";
import { holdoutLedger, sealOf } from "../src/datasets.mjs";
import { runtimeDigest } from "../src/exploration.mjs";
import { Releases } from "../src/lifecycle.mjs";
import { loadExploration, simulationFaultPhase } from "../src/explore-cycle.mjs";
import { Ledger, sha256 } from "../src/util.mjs";

const BIN = fileURLToPath(new URL("../bin/eval-loop-explore.mjs", import.meta.url));
const SRC = { dataset: "Exercism TS", label: "difficulty 9", value: 9, url: "https://example.org/x", tier: "hard" };
function tree(dir, text) { mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, "src", "x.ts"), text); writeFileSync(join(dir, "package.json"), "{}"); return dir; }
function dataset(dir, specs) { for (const [id, family] of specs) { mkdirSync(join(dir, id, "repo"), { recursive: true }); writeFileSync(join(dir, id, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, family, tier: "easy", instruction: `Solve ${id}`, provenance: "external" })); } writeFileSync(join(dir, "SEAL.json"), JSON.stringify(sealOf(dir))); return dir; }
function stage(pool, id, family, hard) {
  const d = join(pool, "cases", id);
  for (const p of ["repo", "hidden", "reference"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, "repo", "index.js"), `export const id = "${id}";\n`); writeFileSync(join(d, "hidden", "h.test.js"), "// h\n"); writeFileSync(join(d, "reference", "index.js"), "// r\n");
  writeFileSync(join(d, "task.json"), JSON.stringify({ id, family, tier: hard ? "hard" : "easy", instruction: `Solve ${id}`, provenance: "external", ...(hard ? { difficultyBasis: "source", difficultySource: SRC } : {}) }));
  writeFileSync(join(d, "validation.private.json"), JSON.stringify({ ok: true, code: "valid" }));
  registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family, tier: hard ? "hard" : "easy", difficultyBasis: hard ? "source" : "declared", contentDigest: caseDigest(d) });
}
const stageN = (pool, tag, n) => { for (let i = 1; i <= n; i++) stage(pool, `${tag}${i}`, `gh:${tag}${i}/r`, i === 1); };

/** Autonomous simulated world (same shape as test/lifecycle.test.mjs) whose config carries the given simulation section. */
function world(root, simulation, extra = {}) {
  const cand = tree(join(root, "cand"), "export const c = 1;\n"), stable = tree(join(root, "stable"), "export const s = 1;\n");
  const report = join(root, "screen-report.json"); writeFileSync(report, JSON.stringify({ accepted: true }));
  const runs = join(root, "screen-runs.jsonl"); writeFileSync(runs, `${JSON.stringify({ type: "result", record: { model_requests: 5 } })}\n`);
  const reg = join(root, "old-registry.jsonl"); new Ledger(reg).append({ type: "case", caseId: "x-old-1", family: "gh:old/repo", status: "eligible" });
  const pool = join(root, "pool"); mkdirSync(pool, { recursive: true }); mkdirSync(join(root, "orche"));
  writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false }));
  const rationale = join(root, "rationale.md"); writeFileSync(rationale, "power simulation (fixture)\n");
  const protocol = { holdout: { repeats: 3, minTasks: 8, minFamilies: 8, acceptedProvenance: ["external", "private-reviewed"], hardBasis: ["source"], execution: "interleaved", maxOwnerShare: 0.5, priorFamilyReuse: "forbid", privateReview: "cross-provider" }, adoption: { requireFamilyLevel: true },
    analysisPlan: { mode: "confirmatory", registeredAt: "2026-11-07T00:00:00Z", rationale: { document: rationale, sha256: sha256(readFileSync(rationale)) }, minEffect: 0.05, alpha: 0.05, minTasks: 8, minFamilies: 8, minHardTasks: 1, permutationDraws: 2000,
      series: { id: "test-series", ledger: join(root, "series", "ledger.jsonl"), alphaTotal: 0.2 }, lowExposure: { required: false, minTasks: null, provenance: ["private-reviewed"] }, confirmation: { required: true, pool, alpha: 0.05, minTasks: 8, minFamilies: 8 } } };
  const protoFile = join(root, "protocol.json"); writeFileSync(protoFile, JSON.stringify(protocol));
  const readiness = join(root, "readiness.json"); writeFileSync(readiness, JSON.stringify({ protocolSha256: sha256(readFileSync(protoFile)), conditions: [{ id: "analysis-plan", status: "fulfilled", reasons: [] }] }));
  const cfg = { schema: "pi-eval-loop/exploration@1", mode: "autonomous", seriesSeed: "lc", candidate: { dir: cand, identity: { commit: "cand@1", runtimeDigest: runtimeDigest(cand) } }, stable: { dir: stable, commit: "stable@1", runtimeDigest: runtimeDigest(stable) },
    screen: { report, reportSha256: sha256(readFileSync(report)), runs, tasks: [{ id: "d1", dataset: dataset(join(root, "screen-tasks"), [["d1", "gh:dev/x"]]) }] }, pool, lineage: { registries: [reg], datasets: [dataset(join(root, "old-holdout"), [["o1", "gh:old/ds"]])] },
    budget: { ledger: join(root, "budget", "ledger.jsonl"), limit: 4500, scope: "lc", minRemaining: 120 }, runtime: { simulated: true }, simulation, orcheDir: join(root, "orche"), parallelism: 2,
    batchRule: { seed: "lc", maxTasks: 6, maxPerFamily: 1, maxPerOwner: 3, maxOwnerShare: 0.5, preferFreshFamilies: true }, supply: { collector: "none" },
    confirmation: { protocol: protoFile, protocolSha256: sha256(readFileSync(protoFile)), readiness, attemptsPerUnit: 6, smokeAttempts: 10, deploy: { dir: join(root, "deploy") } }, ...extra };
  const file = join(root, "lifecycle.json"); writeFileSync(file, JSON.stringify(cfg));
  return { cfg, file, pool, releases: new Releases(cfg.confirmation.deploy.dir) };
}

/** One CLI process; returns the last JSON line of stdout and the exit code. */
function cli(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 240_000 });
  const line = r.stdout.trim().split("\n").filter(Boolean).at(-1);
  return { code: r.status, out: line ? JSON.parse(line) : null, stderr: r.stderr };
}
const refresh = (w) => cli(["refresh", "--protocol", w.file]);
const resume = (w, state, first = false) => cli(["--resume", ...(first ? [] : ["--require-state"]), "--state", state, "--protocol", w.file]);
const usesOf = (pool) => Object.fromEntries([...poolState(pool).batches.values()].map(b => [b.batch, existsSync(join(pool, "batches", b.batch, "USES.jsonl")) ? holdoutLedger(join(pool, "batches", b.batch)).records().map(r => r.purpose ?? r.stateDir ?? "used") : []]));
const P = { stable: 0.05, c1: 0.95 };

test("fault controls: phase mapping and config validation (simulated-only, not in screening, well-formed)", () => {
  assert.deepEqual(["selected", "running", "confirm-wait", "confirm-running", "adopting", "smoke", "postconfirm-selected", "postconfirm-running", "promoted", "done", undefined].map(simulationFaultPhase),
    ["exploration", "exploration", "confirm", "confirm", null, "smoke", "postconfirm", "postconfirm", null, null, null]);
  const root = tempDir();
  try {
    const w = world(root, { enabled: true, p: P, crash: ["deployed"], byPhase: { postconfirm: { c1: 0, stable: 0.95 } } });
    assert.equal(loadExploration(w.file).simulated, true, "a simulated cycle accepts both controls");
    const variant = (patch) => { const f = join(root, `v-${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify({ ...w.cfg, ...patch })); return f; };
    const refused = (patch, re) => assert.throws(() => loadExploration(variant(patch)), re);
    // Live (simulation off): refused, whatever the runtime says.
    refused({ simulation: { enabled: false, crash: ["deployed"] }, runtime: { dir: join(root, "rt") } }, /simulated-only fault controls/);
    refused({ simulation: { byPhase: { smoke: { deployed: 0 } } }, runtime: { dir: join(root, "rt") } }, /simulated-only fault controls/);
    refused({ simulation: { enabled: true, crash: ["deployed"] }, runtime: { dir: join(root, "rt") } }, /simulated-only fault controls/);
    // Malformed.
    refused({ simulation: { enabled: true, crash: [] } }, /simulation\.crash must be/);
    refused({ simulation: { enabled: true, crash: ["../x"] } }, /simulation\.crash must be/);
    refused({ simulation: { enabled: true, byPhase: { adopting: { c1: 0 } } } }, /unknown phase/);
    refused({ simulation: { enabled: true, byPhase: { postconfirm: { c1: 2 } } } }, /success probabilities/);
    refused({ simulation: { enabled: true, byPhase: [] } }, /non-empty object/);
    // The CLI reports a refused config as usage before touching any state.
    const st = join(root, "never");
    const r = cli(["--resume", "--state", st, "--protocol", variant({ simulation: { enabled: false, crash: ["deployed"] }, runtime: { dir: join(root, "rt") } })]);
    assert.equal(r.out.outcome, "usage", r.stderr); assert.match(r.out.detail, /simulated-only fault controls/); assert.equal(existsSync(st), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [name, simulation, expectConfirmation, expectReason] of [
  ["post-adoption smoke failure (simulation.crash [deployed])", { enabled: true, p: P, crash: ["deployed"] }, null, /rolled back: smoke harness_crash/],
  ["failed independent post-adoption confirmation (simulation.byPhase.postconfirm)", { enabled: true, p: P, byPhase: { postconfirm: { c1: 0, stable: 0.95 } } }, "NOT_CONFIRMED", /rolled back: independent confirmation NOT_CONFIRMED/],
]) {
  test(`real CLI rollback: ${name} -> previous release deployed again, used batches recorded once, cycle closed`, { timeout: 600_000 }, () => {
    const root = tempDir();
    try {
      const w = world(root, simulation);
      stageN(w.pool, "e", 6);
      assert.equal(refresh(w).code, 0);
      const state = join(root, "c");
      let r = resume(w, state, true);
      assert.equal(r.out.outcome, "blocked", r.stderr);
      assert.equal(r.out.status.lifecycle.stage, "confirm-wait"); assert.equal(r.out.status.lifecycle.explorationVerdict, "EXPLORATORY_SUPPORTED");
      stageN(w.pool, "k", 8); assert.equal(refresh(w).out.sealed[0]?.purpose, "confirmatory");
      r = resume(w, state);
      if (expectConfirmation) {
        // Smoke passed (no crash control); the release is the candidate until the independent confirmation decides.
        assert.equal(r.out.status.lifecycle.stage, "postconfirm-wait", JSON.stringify(r.out.status.lifecycle));
        assert.equal(r.out.status.acceptance.stage, "adopted-unconfirmed");
        assert.equal(w.releases.current().runtimeDigest, w.cfg.candidate.identity.runtimeDigest);
        stageN(w.pool, "m", 8); assert.equal(refresh(w).out.sealed[0]?.purpose, "confirmatory");
        r = resume(w, state);
      }
      assert.equal(r.code, 0, r.stderr); assert.equal(r.out.outcome, "cycle_done", JSON.stringify(r.out.status?.blocked ?? r.out));
      const st = r.out.status;
      assert.equal(st.lifecycle.outcome, "rolled-back", JSON.stringify(st.lifecycle)); assert.equal(st.lifecycle.rolledBack, true); assert.equal(st.lifecycle.deployed, null);
      assert.equal(st.final.adopt, false); assert.equal(st.final.rolledBack, true);
      assert.equal(st.acceptance.stage, "rolled-back"); assert.equal(st.acceptance.productionAdopted, false);
      if (expectConfirmation) assert.equal(st.lifecycle.confirmation, expectConfirmation);
      const saved = JSON.parse(readFileSync(join(state, "explore.json"), "utf8"));
      assert.ok(saved.final.reasons.some(x => expectReason.test(x)), saved.final.reasons.join(" | "));
      if (!expectConfirmation) { const sm = JSON.parse(readFileSync(join(state, "smoke", "smoke.json"), "utf8")); assert.equal(sm.ok, false); assert.equal(sm.terminal, "harness_crash"); }
      // The previous release is deployed again; history init -> adopt -> rollback.
      assert.equal(w.releases.current().runtimeDigest, w.cfg.stable.runtimeDigest, "the previous release is deployed again");
      assert.deepEqual(w.releases.history.records().map(x => x.type), ["init", "adopt", "rollback"]);
      // Every consumed batch keeps its use record (exploration, confirmatory holdout, and the confirmation when it ran) and alpha
      // was spent once per confirmatory test that ran.
      const used = Object.values(usesOf(w.pool)).filter(u => u.length);
      assert.equal(used.length, expectConfirmation ? 3 : 2); assert.ok(used.every(u => u.length === 1), JSON.stringify(used));
      const spends = new Ledger(join(root, "series", "ledger.jsonl")).records().filter(x => x.type === "spend").map(x => x.purpose).sort();
      assert.deepEqual(spends, expectConfirmation ? ["confirmation", "holdout"] : ["holdout"]);
      // Closed: a further resume is idle and charges nothing; status agrees.
      const charged = new Ledger(join(root, "budget", "ledger.jsonl")).records().length;
      r = resume(w, state);
      assert.equal(r.out.outcome, "idle"); assert.equal(new Ledger(join(root, "budget", "ledger.jsonl")).records().length, charged);
      const s = cli(["--status", "--summary", "--state", state]);
      assert.equal(s.code, 0); assert.equal(s.out.lifecycle.outcome, "rolled-back");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("real CLI: without fault controls the same simulated world is confirmed (controls change nothing when absent)", { timeout: 600_000 }, () => {
  const root = tempDir();
  try {
    const w = world(root, { enabled: true, p: P });
    stageN(w.pool, "e", 6); refresh(w);
    const state = join(root, "c");
    resume(w, state, true);
    stageN(w.pool, "k", 8); refresh(w);
    let r = resume(w, state);
    assert.equal(r.out.status.lifecycle.stage, "postconfirm-wait", JSON.stringify(r.out.status.lifecycle));
    stageN(w.pool, "m", 8); refresh(w);
    r = resume(w, state);
    assert.equal(r.out.status.lifecycle.outcome, "confirmed", JSON.stringify(r.out.status.lifecycle));
    assert.equal(w.releases.current().runtimeDigest, w.cfg.candidate.identity.runtimeDigest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
