// Study-identity parameters (2026-11-13; docs/terra-study-v4.md): route, context, shared series ledger identity and the
// calibration sub-ceiling, runtime budget identity and pilot provenance. Throwaway ledgers only: the deployed terra-1 ledger is
// never opened.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROTOCOL } from "../src/protocol.mjs";
import { RequestBudget } from "../src/request-budget.mjs";
import { attemptAdmission } from "../src/admission.mjs";
import { Ledger, digestOf } from "../src/util.mjs";
import { BUDGET_SCOPE, CONTEXT, HARD_CAP, approvalProblems, calibrationPlan, catalogModels, contextOf, studyProtocol } from "../studies/confirmatory-1/calibrate.mjs";
import { BUDGET, budgetIdentity } from "../studies/confirmatory-1/isolated-runtime.mjs";
import { extractPilot, DEFAULT_CAMPAIGN } from "../studies/confirmatory-1/pilot.mjs";
import { tempDir } from "./helpers.mjs";

const TERRA_SCOPE = "terra-test: all target-model requests of a throwaway series";
const CALIBRATE = new URL("../studies/confirmatory-1/calibrate.mjs", import.meta.url).pathname;
const RUNTIME_CLI = new URL("../studies/confirmatory-1/isolated-runtime.mjs", import.meta.url).pathname;

test("study protocol: the default is DEFAULT_PROTOCOL itself; --route/--effort select another route; malformed values refused", () => {
  assert.equal(studyProtocol(), DEFAULT_PROTOCOL);
  const p = studyProtocol({ route: "cliproxyapi/gpt-6.1-terra" });
  assert.deepEqual(p.route, { provider: "cliproxyapi", model: "gpt-6.1-terra", effort: DEFAULT_PROTOCOL.route.effort });
  assert.equal(studyProtocol({ route: "cliproxyapi/gpt-6.1-terra", effort: "high" }).route.effort, "high");
  assert.deepEqual(p.unit, DEFAULT_PROTOCOL.unit, "only the route changes");
  assert.equal(DEFAULT_PROTOCOL.route.model, "gpt-6-luna", "the default protocol is not mutated");
  for (const bad of [{ route: "gpt-6.1-terra" }, { route: "a/b c" }, { route: "cliproxyapi/gpt-6.1-terra", effort: "extreme" }, { effort: "high" }]) assert.throws(() => studyProtocol(bad));
});

test("calibration plan: confirmatory-1 defaults keep their identity; a Terra plan binds route, context and the shared ledger identity", () => {
  const base = { batch: join(tempDir(), "nobatch"), harnessDir: "/nonexistent", harnessCommit: "a".repeat(40), repeats: 3, hardMaxRate: 0.5, minTasksPerLevel: 3, budgetLedger: "/x/ledger.jsonl" };
  const def = calibrationPlan({ ...base, maxRequests: 4500 });
  assert.ok(!("context" in def) && !("ledgerLimit" in def.budget) && !("subCap" in def.budget), "no new keys in a default plan (existing state digests unchanged)");
  assert.deepEqual(def.route, DEFAULT_PROTOCOL.route);
  assert.equal(contextOf(def), CONTEXT);
  assert.ok(calibrationPlan({ ...base, maxRequests: 4501 }).problems.some(p => /hard cap 4500/.test(p)));
  const terra = calibrationPlan({ ...base, protocol: studyProtocol({ route: "cliproxyapi/gpt-6.1-terra" }), maxRequests: 20000, context: "terra-v4:calibration", budgetLimit: 300000, budgetScope: TERRA_SCOPE });
  assert.ok(!terra.problems.some(p => /cap|limit|context|budget-limit/.test(p)), terra.problems.join("; "));
  assert.deepEqual([terra.route.model, terra.context, terra.budget.ledgerLimit, terra.budget.ledgerScope, terra.budget.subCap, terra.budget.maxRequests], ["gpt-6.1-terra", "terra-v4:calibration", 300000, TERRA_SCOPE, true, 20000]);
  assert.notEqual(digestOf({ ...terra, problems: undefined }), digestOf({ ...calibrationPlan({ ...base, protocol: studyProtocol({ route: "cliproxyapi/gpt-6.1-terra", effort: "high" }), maxRequests: 20000, context: "terra-v4:calibration", budgetLimit: 300000, budgetScope: TERRA_SCOPE }), problems: undefined }), "effort is part of the resume identity");
  assert.ok(calibrationPlan({ ...base, maxRequests: 300001, budgetLimit: 300000, budgetScope: TERRA_SCOPE }).problems.some(p => /exceeds the shared ledger's limit 300000/.test(p)));
  assert.ok(calibrationPlan({ ...base, maxRequests: 10, budgetLimit: 300000 }).problems.some(p => /budget-scope/.test(p)));
  assert.ok(calibrationPlan({ ...base, maxRequests: 10, context: "bad context!" }).problems.some(p => /--context/.test(p)));
  // Approval: capped by the shared ledger limit instead of 4500.
  const root = tempDir();
  const approval = join(root, "approval.json");
  writeFileSync(approval, JSON.stringify({ maxRequests: 20000, approvedBy: "op", approvedAt: "2026-11-13T00:00:00Z", authorization: { kind: "signed", signature: "s" }, scope: { batchSeal: terra.seal, budgetLedger: "/x/ledger.jsonl" } }));
  assert.ok(!approvalProblems(approval, 20000, terra).some(p => /must be a positive integer/.test(p)));
  assert.ok(approvalProblems(approval, 20000, def).some(p => new RegExp(`<= ${HARD_CAP}`).test(p)));
});

test("shared ledger sub-ceiling: a context's reservations are capped inside the 300000 ledger under its lock (concurrent, resumed, settled)", async () => {
  const root = tempDir();
  const path = join(root, "budget", "series.jsonl");
  const a = new RequestBudget({ path, limit: 300000, scope: TERRA_SCOPE }), b = new RequestBudget({ path, limit: 300000, scope: TERRA_SCOPE });
  const cap = { subCap: { key: "calibration:terra-v4:calibration", limit: 10 } };
  const other = await a.reserve(500, { route: "screening" });
  assert.ok(other, "reservations outside the group do not count against it");
  const both = await Promise.all([a.reserve(6, {}, cap), b.reserve(6, {}, cap)]);
  assert.equal(both.filter(Boolean).length, 1, "two processes cannot both pass the sub-ceiling");
  const held = both.find(Boolean);
  assert.equal(await a.reserve(5, {}, cap), null);
  assert.match(a.refusal, /sub-ceiling 10 of calibration:terra-v4:calibration: charged 6/);
  await a.settle(held, 2);
  // A resumed process (a new instance) sees the settled usage: 2 + 8 <= 10.
  const resumed = new RequestBudget({ path, limit: 300000, scope: TERRA_SCOPE });
  assert.ok(await resumed.reserve(8, {}, cap));
  assert.equal(await resumed.reserve(1, {}, cap), null);
  const rec = new Ledger(path).records().filter(r => r.type === "reserve" && r.meta?.subCap);
  assert.ok(rec.every(r => r.meta.subCapLimit === 10));
  assert.equal(resumed.status().limit, 300000);
  await assert.rejects(new RequestBudget({ path, limit: 4500, scope: TERRA_SCOPE }).reserve(1), /created with limit 300000/);
  await assert.rejects(new RequestBudget({ path, limit: 300000, scope: BUDGET_SCOPE }).reserve(1), /scope differs/);
  await assert.rejects(a.reserve(1, {}, { subCap: { key: "k", limit: 300001 } }), /subCap/);
  // Through the admission used by calibrations: amount x K is reserved within the group.
  const adm = attemptAdmission(new RequestBudget({ path: join(root, "b2.jsonl"), limit: 300000, scope: TERRA_SCOPE }), () => ({ perRequest: 2 }), { subCap: { key: "g", limit: 7 } });
  assert.ok(await adm.reserve(3, {}));
  assert.equal(await adm.reserve(1, {}), null, "6 + 2 > 7");
});

test("calibrate --dry-run with Terra flags: plan shows route, context and ledger identity; the ledger is not touched; misbound runtime and missing catalog model block", () => {
  const root = tempDir();
  const ledger = join(root, "budget", "series.jsonl");
  mkdirSync(join(root, "budget"));
  writeFileSync(ledger, ""); const before = readFileSync(ledger);
  const rt = join(root, "rt"); mkdirSync(join(rt, "agent"), { recursive: true });
  writeFileSync(join(rt, "agent", "cliproxyapi-models.json"), JSON.stringify({ models: [{ id: "gpt-6-luna" }] }));
  writeFileSync(join(rt, "manifest.json"), JSON.stringify({ schema: "pi-eval-loop/isolated-runtime@1", mode: "live", budget: { path: ledger, limit: 4500, scope: BUDGET_SCOPE }, upstream: "http://127.0.0.1:1", agentDir: join(rt, "agent") }));
  const args = ["--batch", join(root, "nobatch"), "--harness-dir", root, "--harness-commit", "b".repeat(40), "--max-requests", "20000", "--budget-ledger", ledger, "--budget-limit", "300000", "--budget-scope", TERRA_SCOPE, "--route", "cliproxyapi/gpt-6.1-terra", "--effort", "medium", "--context", "terra-v4:calibration", "--runtime", rt, "--gateway-db", join(root, "none.db"), "--dry-run"];
  const env = { ...process.env }; delete env.EVAL_LOOP_UPSTREAM; delete env.EVAL_LOOP_AGENT_DIR;
  const r = spawnSync(process.execPath, [CALIBRATE, ...args], { encoding: "utf8", env });
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.route.model, out.route.effort, out.context, out.budget.ledgerLimit, out.budget.maxRequests, out.modelCalls, out.wouldRun], ["gpt-6.1-terra", "medium", "terra-v4:calibration", 300000, 20000, 0, false]);
  assert.ok(out.blocked.some(b => /another ledger identity/.test(b)), out.blocked.join("\n"));
  assert.ok(out.blocked.some(b => /not in the runtime's model catalog/.test(b)));
  assert.deepEqual(readFileSync(ledger), before, "a dry run never writes the ledger");
  assert.deepEqual(catalogModels(join(rt, "agent")), ["gpt-6-luna"]);
  const usage = spawnSync(process.execPath, [CALIBRATE, "--batch", "x", "--budget-limit", "300000"], { encoding: "utf8" });
  assert.equal(usage.status, 64);
  const badRoute = spawnSync(process.execPath, [CALIBRATE, "--batch", "x", "--route", "nope"], { encoding: "utf8" });
  assert.equal(badRoute.status, 64);
});

test("runtime budget identity: confirmatory-1 default, a Terra series identity, half-specified refused (prepare stops before any write)", () => {
  assert.deepEqual(budgetIdentity(), BUDGET);
  assert.deepEqual(budgetIdentity({ limit: "300000", scope: TERRA_SCOPE }), { limit: 300000, scope: TERRA_SCOPE });
  for (const bad of [{ limit: "300000" }, { scope: TERRA_SCOPE }, { limit: "0", scope: TERRA_SCOPE }, { limit: "3e5", scope: TERRA_SCOPE }]) assert.throws(() => budgetIdentity(bad));
  const root = tempDir();
  const r = spawnSync(process.execPath, [RUNTIME_CLI, "prepare", "--dir", join(root, "rt"), "--budget-ledger", join(root, "l.jsonl"), "--budget-limit", "300000"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--budget-limit and --budget-scope go together/);
  const missing = spawnSync(process.execPath, [RUNTIME_CLI, "prepare", "--dir", join(root, "rt"), "--budget-ledger", join(root, "l.jsonl"), "--models", join(root, "none.json")], { encoding: "utf8" });
  assert.match(missing.stderr, /--models .*not found/);
});

test("pilot provenance: --campaign labels another study's source; observed routes are recorded from the ledger", () => {
  const root = tempDir();
  const runs = join(root, "runs.jsonl");
  const ledger = new Ledger(runs);
  for (const task of ["a1-x", "d1-y"]) for (let repeat = 0; repeat < 3; repeat++) ledger.append({ type: "result", record: { run_id: `${task}-${repeat}`, unit_key: `${task}-${repeat}`, attempt: 1, candidate_id: "S", task_id: task, family: task, repeat, terminal_status: "completed", hidden_test_pass: repeat > 0, visible_test_pass: true, model_route: "cliproxyapi/gpt-6.1-terra", integrity: { legacyViolations: [], leakHits: [] } } });
  assert.equal(extractPilot(runs).source.campaign, DEFAULT_CAMPAIGN);
  const p = extractPilot(runs, { campaign: "terra-v4 pilot (example label)" });
  assert.deepEqual([p.source.campaign, p.source.routes], ["terra-v4 pilot (example label)", ["cliproxyapi/gpt-6.1-terra"]]);
  assert.deepEqual(p.arms.S.tasks["a1-x"].outcomes, [0, 1, 1]);
});
