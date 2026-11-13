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
  // Shared ledger (budget policy shared-total-only): no per-run ceiling, no sub-cap; --max-requests is refused.
  const terra = calibrationPlan({ ...base, protocol: studyProtocol({ route: "cliproxyapi/gpt-6.1-terra" }), context: "terra-v4:calibration", budgetLimit: 300000, budgetScope: TERRA_SCOPE });
  assert.ok(!terra.problems.some(p => /cap|limit|context|budget-limit|max-requests/.test(p)), terra.problems.join("; "));
  assert.deepEqual([terra.route.model, terra.context, terra.budget.ledgerLimit, terra.budget.ledgerScope, terra.budget.policy, terra.budget.maxRequests, "subCap" in terra.budget], ["gpt-6.1-terra", "terra-v4:calibration", 300000, TERRA_SCOPE, "shared-total-only", null, false]);
  assert.notEqual(digestOf({ ...terra, problems: undefined }), digestOf({ ...calibrationPlan({ ...base, protocol: studyProtocol({ route: "cliproxyapi/gpt-6.1-terra", effort: "high" }), context: "terra-v4:calibration", budgetLimit: 300000, budgetScope: TERRA_SCOPE }), problems: undefined }), "effort is part of the resume identity");
  assert.ok(calibrationPlan({ ...base, maxRequests: 20000, budgetLimit: 300000, budgetScope: TERRA_SCOPE }).problems.some(p => /--max-requests is not accepted with a shared ledger/.test(p)), "a legacy per-run ceiling is refused, never silently kept");
  assert.ok(calibrationPlan({ ...base, budgetLimit: 300000 }).problems.some(p => /budget-scope/.test(p)));
  assert.ok(calibrationPlan({ ...base, maxRequests: 10, context: "bad context!" }).problems.some(p => /--context/.test(p)));
  // Approval: a shared-ledger approval states the policy and carries no ceiling; an old bounded approval is not widened.
  const root = tempDir();
  const approval = join(root, "approval.json"), old = join(root, "old.json");
  const common = { approvedBy: "op", approvedAt: "2026-11-13T00:00:00Z", authorization: { kind: "signed", signature: "s" }, scope: { batchSeal: terra.seal, budgetLedger: "/x/ledger.jsonl" } };
  writeFileSync(approval, JSON.stringify({ budgetPolicy: "shared-total-only", ...common }));
  writeFileSync(old, JSON.stringify({ maxRequests: 20000, ...common }));
  assert.deepEqual(approvalProblems(approval, 0, terra).filter(p => /maxRequests|budgetPolicy/.test(p)), []);
  assert.ok(approvalProblems(old, 0, terra).some(p => /re-approve/.test(p)), "a bounded approval is not extended into an unbounded one");
  assert.ok(approvalProblems(old, 0, terra).some(p => /budgetPolicy/.test(p)));
  // confirmatory-1's own study ledger (default, research provenance): unchanged, maxRequests <= 4500 and equal to the approval.
  assert.ok(approvalProblems(old, 20000, def).some(p => new RegExp(`<= ${HARD_CAP}`).test(p)));
});

test("shared-total-only: the former sub-ceiling API is removed (throws), and a calibration's reservations are bounded only by the shared ledger", async () => {
  const root = tempDir();
  const path = join(root, "budget", "series.jsonl");
  const a = new RequestBudget({ path, limit: 300000, scope: TERRA_SCOPE }), b = new RequestBudget({ path, limit: 300000, scope: TERRA_SCOPE });
  await assert.rejects(a.reserve(6, {}, { subCap: { key: "calibration:terra-v4:calibration", limit: 10 } }), /subCap was removed/);
  assert.throws(() => attemptAdmission(a, () => ({ perRequest: 2 }), { subCap: { key: "g", limit: 7 } }), /subCap was removed/);
  // A calibration admission reserves amount x K against the global ledger only: 6 + 2 > 7 would have been refused before.
  const adm = attemptAdmission(a, () => ({ perRequest: 2 }));
  assert.ok(await adm.reserve(3, {})); assert.ok(await adm.reserve(1, {}));
  // Concurrent processes still share ONE ceiling under the ledger lock (fail closed at the global limit).
  const tight = join(root, "budget", "tight.jsonl");
  const t1 = new RequestBudget({ path: tight, limit: 10, scope: TERRA_SCOPE }), t2 = new RequestBudget({ path: tight, limit: 10, scope: TERRA_SCOPE });
  const both = await Promise.all([t1.reserve(6), t2.reserve(6)]);
  assert.equal(both.filter(Boolean).length, 1, "two processes cannot both pass the global ceiling");
  assert.match((both[0] ? t2 : t1).refusal, /request ceiling 10/);
  assert.equal(b.status().limit, 300000);
  await assert.rejects(new RequestBudget({ path, limit: 4500, scope: TERRA_SCOPE }).reserve(1), /created with limit 300000/);
  await assert.rejects(new RequestBudget({ path, limit: 300000, scope: BUDGET_SCOPE }).reserve(1), /scope differs/);
});

test("calibrate --dry-run with Terra flags: plan shows route, context and ledger identity; the ledger is not touched; misbound runtime and missing catalog model block", () => {
  const root = tempDir();
  const ledger = join(root, "budget", "series.jsonl");
  mkdirSync(join(root, "budget"));
  writeFileSync(ledger, ""); const before = readFileSync(ledger);
  const rt = join(root, "rt"); mkdirSync(join(rt, "agent"), { recursive: true });
  writeFileSync(join(rt, "agent", "cliproxyapi-models.json"), JSON.stringify({ models: [{ id: "gpt-6-luna" }] }));
  writeFileSync(join(rt, "manifest.json"), JSON.stringify({ schema: "pi-eval-loop/isolated-runtime@1", mode: "live", budget: { path: ledger, limit: 4500, scope: BUDGET_SCOPE }, upstream: "http://127.0.0.1:1", agentDir: join(rt, "agent") }));
  const args = ["--batch", join(root, "nobatch"), "--harness-dir", root, "--harness-commit", "b".repeat(40), "--budget-ledger", ledger, "--budget-limit", "300000", "--budget-scope", TERRA_SCOPE, "--route", "cliproxyapi/gpt-6.1-terra", "--effort", "medium", "--context", "terra-v4:calibration", "--runtime", rt, "--gateway-db", join(root, "none.db"), "--dry-run"];
  const env = { ...process.env }; delete env.EVAL_LOOP_UPSTREAM; delete env.EVAL_LOOP_AGENT_DIR;
  const r = spawnSync(process.execPath, [CALIBRATE, ...args], { encoding: "utf8", env });
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.route.model, out.route.effort, out.context, out.budget.ledgerLimit, out.budget.maxRequests, out.modelCalls, out.wouldRun], ["gpt-6.1-terra", "medium", "terra-v4:calibration", 300000, null, 0, false]);
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

test("exploreProtocol(route): absent = the unchanged package default; explicit = only the target route changes (proposer independent); malformed = throws", async () => {
  const { exploreProtocol } = await import("../src/exploration.mjs");
  const { DEFAULT_PROTOCOL: D, routeProblems } = await import("../src/protocol.mjs");
  const { digestOf } = await import("../src/util.mjs");
  const base = exploreProtocol();
  assert.deepEqual(base.route, D.route);
  assert.equal(digestOf(exploreProtocol(undefined)), digestOf(base));
  const terra = exploreProtocol({ provider: "cliproxyapi", model: "gpt-6.1-terra", effort: "medium" });
  assert.deepEqual(terra.route, { provider: "cliproxyapi", model: "gpt-6.1-terra", effort: "medium" });
  assert.deepEqual(terra.proposer, base.proposer);
  assert.deepEqual({ ...terra, route: base.route }, base, "nothing but the target route differs");
  for (const bad of [null, "cliproxyapi/gpt-6.1-terra", { provider: "cliproxyapi", model: "gpt-6.1-terra" }, { provider: "cliproxyapi", model: "gpt-6.1-terra", effort: "turbo" }, { provider: "", model: "m", effort: "low" }, { provider: "p", model: "m", effort: "low", x: 1 }])
    assert.throws(() => exploreProtocol(bad), /target route/, JSON.stringify(bad));
  assert.deepEqual(routeProblems({ provider: "cliproxyapi", model: "bts/gpt-6.1-terra", effort: "ultra" }), []);
});

test("shared-total-only leaves research design and gates unchanged: confirmatory-1 v3 sizes, exploration holdout rule, confirmatory default calibration ceiling", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const v3 = JSON.parse(rf(new URL("../studies/confirmatory-1/protocol-v3.json", import.meta.url), "utf8"));
  assert.deepEqual([v3.holdout.minTasks, v3.holdout.minFamilies, v3.holdout.repeats, v3.analysisPlan.minHardTasks, v3.analysisPlan.confirmation.minTasks], [144, 48, 5, 48, 144]);
  const { exploreProtocol: ep } = await import("../src/exploration.mjs");
  const h = ep().holdout;
  assert.deepEqual([h.minTasks, h.minFamilies, h.repeats, h.maxUses], [6, 4, 3, 1]);
  assert.equal(HARD_CAP, 4500, "confirmatory-1's own study ledger keeps its registered ceiling (research provenance)");
});

test("adjudicate CLI joins the shared ledger like review (off-gate route review): incomplete ledger identity or a bad per-session limit is refused before any session", () => {
  const ADJ = new URL("../studies/confirmatory-1/adjudicate.mjs", import.meta.url).pathname;
  const root = tempDir();
  let r = spawnSync(process.execPath, [ADJ, "--reviews", root, "--budget-ledger", join(root, "l.jsonl")], { encoding: "utf8" });
  assert.equal(r.status, 64); assert.match(r.stderr, /go together/);
  r = spawnSync(process.execPath, [ADJ, "--reviews", root, "--max-requests", "0"], { encoding: "utf8" });
  assert.equal(r.status, 64); assert.match(r.stderr, /per-session request limit/);
  // No task: nothing runs, nothing is charged, the ledger file is not created.
  r = spawnSync(process.execPath, [ADJ, "--reviews", root, "--budget-ledger", join(root, "l.jsonl"), "--budget-limit", "300000", "--budget-scope", "t"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), []);
});
