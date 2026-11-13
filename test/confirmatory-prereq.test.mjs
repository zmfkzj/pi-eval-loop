// Prerequisites of a confirmatory study (2026-11-06, synthetic, local, model-free): attributable review records with reviewer
// kinds and a verified review document, the human-review policy, private-task accounts, cross-pool overlap at intake, the
// bounded calibration runner (approval, request ceiling, simulated = fixture), and the read-only readiness report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rmSync, tempDir } from "./helpers.mjs";
import { concentrationOf, holdoutStatus, loadLocal, ownerOfFamily, reviewClass, reviewProblems } from "../src/datasets.mjs";
import { intakePrivate, mergeSupply, poolState, registryOf, sealBatch } from "../src/supply.mjs";
import { exclusionProblems, verifyCalibrationReport } from "../src/calibration.mjs";
import { DEFAULT_PROTOCOL, loadProtocol, merge } from "../src/protocol.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";
import { readiness } from "../src/readiness.mjs";
import { approvalProblems, calibrationPlan, runCalibration } from "../studies/confirmatory-1/calibrate.mjs";
import { RequestBudget } from "../src/request-budget.mjs";
import { BASE_PLAN, calibrateScenario, holdoutVerdict, observe, drawDesign, pilotTable, simProtocol } from "../studies/confirmatory-1/power.mjs";
import { createRng } from "../src/rng.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const CHECKS = ["instruction-sufficient", "tests-match-instruction", "reference-passes-hidden", "not-published", "no-public-source-copy"];
const DOC = "review document\n";
const okValidate = async () => ({ ok: true, code: "valid", expected: { hiddenTests: 1 }, detail: {} });
function fakeOrche(root) { const o = join(root, "orche"); mkdirSync(join(o, "experiments/x"), { recursive: true }); writeFileSync(join(o, "experiments/x/plan.md"), "notes\n"); return o; }

const record = ({ kind = "human", verdict = "accept", checked = CHECKS, attestations, family = "private:alice/proj" } = {}) => ({
  family, provenance: "private-reviewed", testProvenance: "independent-author",
  authorship: { problemAuthor: "A", testAuthor: "T", referenceAuthor: "A", kinds: { problemAuthor: "human", testAuthor: "human", referenceAuthor: "human" } },
  exposure: { published: false, authoredAt: "2026-10-01T00:00:00Z" },
  review: { reviewers: [{ id: "R", kind, at: "2026-10-02T00:00:00Z", verdict, checked }], checked: CHECKS, ...(attestations ? { attestations } : {}), document: "review/REVIEW.md", documentSha256: sha(DOC) },
});

/** A task source directory with distinct code per id (no lexical overlap between ids). */
function writeTask(dir, id, fields, { refText } = {}) {
  const d = join(dir, id), v = id.replace(/[^a-z0-9]/gi, "_");
  for (const p of ["repo/src", "hidden/test", "reference/src", "review"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, "repo/src/index.js"), `export const ${v} = 0;\n`);
  writeFileSync(join(d, "hidden/test/a.hidden.test.js"), `// ${id}\n`);
  writeFileSync(join(d, "reference/src/index.js"), refText ?? `export const ${v} = 1;\n`);
  writeFileSync(join(d, "review/REVIEW.md"), DOC);
  writeFileSync(join(d, "task.json"), JSON.stringify({ id, tier: "hard", instruction: `Implement ${id}`, ...fields }));
  return d;
}

test("review records: kinds, attributable checks, accepting verdicts, verified document; AI-only review is labelled and blocked unless the protocol allows it", async () => {
  const root = tempDir();
  try {
    assert.deepEqual(reviewProblems(record()), []);
    assert.match(reviewProblems(record({ kind: "robot" })).join(" "), /kind must be one of human\|ai-agent/);
    assert.match(reviewProblems(record({ verdict: "revise" })).join(" "), /verdict revise/);
    assert.match(reviewProblems(record({ checked: CHECKS.slice(0, 4) })).join(" "), /not attributable.*no-public-source-copy/);
    // An item no reviewer checked may be covered by an attributed attestation of a non-author that states its method...
    const attest = { item: "no-public-source-copy", by: "operator", kind: "human", at: "2026-10-03T00:00:00Z", method: "searched" };
    assert.deepEqual(reviewProblems(record({ checked: CHECKS.slice(0, 4), attestations: [attest] })), []);
    // ...but never by an author, and never without its method.
    assert.match(reviewProblems(record({ checked: CHECKS.slice(0, 4), attestations: [{ ...attest, by: "A" }] })).join(" "), /needs by \(not an author\)/);
    assert.match(reviewProblems(record({ checked: CHECKS.slice(0, 4), attestations: [{ ...attest, method: "" }] })).join(" "), /needs by/);
    assert.match(reviewProblems(record({ family: "private:proj" })).join(" "), /family must be private:<accountable author>/);
    // Document: present under review/ and matching its digest when the task directory is known.
    const dir = writeTask(join(root, "src"), "t-doc", record());
    assert.deepEqual(reviewProblems(record(), { dir }), []);
    writeFileSync(join(dir, "review/REVIEW.md"), "edited after review\n");
    assert.match(reviewProblems(record(), { dir }).join(" "), /does not match review.documentSha256/);
    assert.match(reviewProblems({ ...record(), review: { ...record().review, document: "../x.md" } }, { dir }).join(" "), /under the task's review\/ directory/);
    // Accounts: every task of one private author is one account, however many projects.
    assert.equal(ownerOfFamily("private:ai-model/p1"), "private:ai-model"); assert.equal(ownerOfFamily("gh:Foo/bar"), "foo");
    assert.equal(concentrationOf([{ family: "private:ai-model/p1" }, { family: "private:ai-model/p2" }]).maxOwnerShare, 1);
    assert.equal(reviewClass(record({ kind: "ai-agent" })), "ai-reviewed-only"); assert.equal(reviewClass(record()), "human-reviewed");
    // Intake: review/ travels with the task; a revise verdict or a changed document is rejected; eligibility re-verifies.
    const src = join(root, "intake");
    writeTask(src, "p-ai", record({ kind: "ai-agent", family: "private:bot/one" }));
    writeTask(src, "p-human", record({ family: "private:alice/two" }));
    writeTask(src, "p-revise", record({ verdict: "revise", family: "private:bot/three" }));
    const tampered = writeTask(src, "p-tampered", record({ family: "private:carol/four" }));
    writeFileSync(join(tampered, "review/REVIEW.md"), "changed\n");
    const pool = join(root, "pool");
    const s = await intakePrivate({ pool, src, orcheDir: fakeOrche(root), packageDir: join(root, "pkg"), validate: okValidate });
    assert.deepEqual(s.eligible.map(e => e.id).sort(), ["p-ai", "p-human"]);
    assert.equal(s.rejected["review-record-incomplete"], 2);
    assert.equal(statSync(join(pool, "cases", "p-ai", "review", "REVIEW.md")).isFile(), true);
    assert.equal([...poolState(pool).cases.values()].find(r => r.caseId === "p-ai").reviewClass, "ai-reviewed-only");
    const sealed = sealBatch({ pool, cfg: mergeSupply({ batch: { maxTasks: 12, maxPerFamily: 2, maxOwnerShare: 1, seed: "t" } }), minima: { minTasks: 2, minFamilies: 2, requireHard: false, hardBasis: [] } });
    assert.ok(sealed.batch, JSON.stringify(sealed));
    assert.equal(statSync(join(sealed.dir, "p-ai", "review", "REVIEW.md")).isFile(), true, "the sealed batch carries the review document");
    const proto = merge(structuredClone(DEFAULT_PROTOCOL), { holdout: { acceptedProvenance: ["private-reviewed"], minTasks: 1, minFamilies: 1, maxOwnerShare: 1 } });
    const tasks = loadLocal(sealed.dir);
    assert.match(holdoutStatus(tasks, sealed.dir, proto, { orcheDir: fakeOrche(root) }).why, /without an accepted review \(holdout.privateReview human\): p-ai/);
    assert.equal(holdoutStatus(tasks, sealed.dir, merge(structuredClone(proto), { holdout: { privateReview: "ai-allowed" } }), { orcheDir: fakeOrche(root) }).independent, true, "an explicit ai-allowed protocol accepts the labelled AI review");
    assert.throws(() => loadProtocol(writeJson(join(root, "bad.json"), { holdout: { privateReview: "anyone" } })), /privateReview must be human\|cross-provider\|ai-allowed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const writeJson = (p, o) => { writeFileSync(p, JSON.stringify(o)); return p; };

test("intake: tasks overlapping another pool (read-only) are rejected; the other pool is not written", async () => {
  const root = tempDir();
  try {
    const shared = "export function settle(entries) {\n  const totals = new Map();\n  for (const e of entries) totals.set(e.account, (totals.get(e.account) ?? 0) + e.amount);\n  return [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]));\n}\n";
    const other = join(root, "live-pool");
    writeTask(join(other, "cases"), "x-old", { family: "gh:someone/lib", provenance: "external" }, { refText: shared });
    const before = readdirSync(other, { recursive: true }).map(String).sort().join("|");
    const src = join(root, "src");
    writeTask(src, "p-copy", record({ family: "private:bob/copy" }), { refText: shared });
    const s = await intakePrivate({ pool: join(root, "pool"), src, orcheDir: fakeOrche(root), packageDir: join(root, "pkg"), validate: okValidate, overlapPools: [other] });
    assert.deepEqual(s.eligible, []);
    assert.equal(s.rejected["content-matches-earlier-task"], 1, JSON.stringify(s));
    assert.equal(readdirSync(other, { recursive: true }).map(String).sort().join("|"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("calibration runner: refuses holdouts and unapproved spending, never exceeds the request ceiling, and a simulation is only a fixture", async () => {
  const root = tempDir();
  try {
    const src = join(root, "src");
    for (const [i, tier] of [["1", "hard"], ["2", "hard"], ["3", "easy"], ["4", "easy"]]) writeTask(src, `c${i}`, { ...record({ family: `private:alice/f${i}` }), tier });
    const pool = join(root, "pool");
    await intakePrivate({ pool, src, orcheDir: fakeOrche(root), packageDir: join(root, "pkg"), validate: okValidate });
    const cfg = mergeSupply({ batch: { maxTasks: 12, maxPerFamily: 2, maxOwnerShare: 1, seed: "t" } });
    const cal = sealBatch({ pool, cfg, minima: { minTasks: 1, minFamilies: 1, requireHard: false, hardBasis: [] }, purpose: "calibration" });
    const harnessDir = join(root, "harness"); mkdirSync(harnessDir); writeFileSync(join(harnessDir, "package.json"), "{}");
    const commit = "e".repeat(40);
    const ledgerPath = join(root, "budget", "requests.jsonl");
    const plan = calibrationPlan({ batch: cal.dir, harnessDir, harnessCommit: commit, repeats: 3, maxRequests: 400, hardMaxRate: 0.5, minTasksPerLevel: 2, budgetLedger: ledgerPath });
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.units, 12); assert.equal(plan.budget.worstCaseFirstAttempts, 12 * DEFAULT_PROTOCOL.unit.maxRequests);
    assert.equal(plan.rule.censoring, "infra-excluded@1");
    assert.match(calibrationPlan({ batch: cal.dir, harnessDir, harnessCommit: commit, maxRequests: 4501, hardMaxRate: 0.5, minTasksPerLevel: 2 }).problems.join(" "), /exceeds the study's hard cap 4500/);
    assert.match(approvalProblems(undefined, 400, plan).join(" "), /no operator approval/);
    const relayed = { kind: "relayed-instruction", signature: null, humanSignatory: false, verbatim: "요청 4500 유지", recordedBy: "agent" };
    const approval = writeJson(join(root, "approval.json"), { maxRequests: 400, approvedBy: "operator (relayed)", approvedAt: "2026-11-06T00:00:00Z", authorization: relayed, scope: { batchSeal: plan.seal, budgetLedger: ledgerPath } });
    assert.deepEqual(approvalProblems(approval, 400, plan), []);
    assert.match(approvalProblems(approval, 300, plan).join(" "), /differs from --max-requests/, "the ceiling is exactly the approved one");
    assert.match(approvalProblems(writeJson(join(root, "a2.json"), { maxRequests: 400, approvedBy: "x", approvedAt: "2026-11-06T00:00:00Z", authorization: { ...relayed, signature: "forged", humanSignatory: true }, scope: { batchSeal: plan.seal, budgetLedger: ledgerPath } }), 400, plan).join(" "), /no agent signs for a person/);
    assert.match(approvalProblems(writeJson(join(root, "a3.json"), { maxRequests: 400, approvedBy: "x", approvedAt: "2026-11-06T00:00:00Z", authorization: relayed, scope: { batchSeal: plan.seal, budgetLedger: join(root, "other.jsonl") } }), 400, plan).join(" "), /one global budget/);
    // A holdout-purpose batch is never run for calibration.
    const writeHold = join(root, "src2"); writeTask(writeHold, "h1", record({ family: "private:bob/h" }));
    await intakePrivate({ pool, src: writeHold, orcheDir: fakeOrche(root), packageDir: join(root, "pkg"), validate: okValidate });
    const hold = sealBatch({ pool, cfg, minima: { minTasks: 1, minFamilies: 1, requireHard: false, hardBasis: [] } });
    assert.match(calibrationPlan({ batch: hold.dir, harnessDir, harnessCommit: commit, maxRequests: 400, hardMaxRate: 0.5, minTasksPerLevel: 2 }).problems.join(" "), /not a calibration-purpose set/);
    // Global ceiling 200 with a 150-request attempt reservation: at most one attempt holds a reservation at a time once 50 are
    // used, so dispatch stops as soon as charged + 150 > 200; nothing exceeds the ceiling and no report is built from a partial run.
    const backend = simulatedBackend({ skill: (h, t) => ({ p: t.tier === "hard" ? 0.2 : 0.9 }) });
    await assert.rejects(runCalibration({ plan, state: join(root, "state-x"), harnessDir, backend }), /RequestBudget is required/);
    const tightBudget = new RequestBudget({ path: join(root, "tight.jsonl"), limit: 200, scope: "t" });
    const tight = await runCalibration({ plan, state: join(root, "state-tight"), harnessDir, backend, parallelism: 1, budget: tightBudget });
    assert.match(tight.summary.paused, /request ceiling 200/); assert.equal(tight.report, undefined);
    assert.equal(tight.summary.ran, 11, JSON.stringify(tight.summary)); assert.ok(tight.summary.budget.charged <= 200);
    assert.equal(tight.status.unitClasses.censored, 1, "the unit never dispatched is censored, not a failure");
    // The SAME global budget is shared by a rerun in another state directory: it can only use what is left.
    const rerun = await runCalibration({ plan, state: join(root, "state-rerun"), harnessDir, backend, parallelism: 1, budget: tightBudget });
    assert.equal(rerun.summary.ran, 0); assert.ok(rerun.summary.budget.charged <= 200);
    // shared-total-only: a frozen plan of the removed sub-ceiling contract is refused (re-plan + re-approve), nothing dispatched.
    await assert.rejects(runCalibration({ plan: { ...plan, budget: { ...plan.budget, subCap: true } }, state: join(root, "state-subcap"), harnessDir, backend, parallelism: 1, budget: new RequestBudget({ path: join(root, "sub.jsonl"), limit: 300000, scope: "t" }) }), /removed per-context sub-ceiling/);
    const full = await runCalibration({ plan, state: join(root, "state-full"), harnessDir, backend, parallelism: 2, budget: new RequestBudget({ path: join(root, "roomy.jsonl"), limit: 4500, scope: "t" }) });
    assert.equal(full.summary.ran, 12); assert.equal(full.report.measuredWith.kind, "fixture"); assert.equal(full.summary.budget.charged, 60);
    assert.match(verifyCalibrationReport(full.report).join(" "), /not from a runner ledger/, "a simulated calibration is never evidence");
    // Pre-registered exclusions (part of the plan, so fixed before the first dispatch): the excluded task is run and recorded but
    // left out of the level means; an unknown task or a changed evidence document is refused.
    const evidence = join(root, "defect.json"); writeFileSync(evidence, "{\"defect\":\"reference fails blind tests\"}");
    const exclusions = [{ task: plan.tasks[0], reason: "reference fails independent blind tests", evidence: { document: evidence, sha256: sha(readFileSync(evidence)) } }];
    assert.match(calibrationPlan({ batch: cal.dir, harnessDir, harnessCommit: commit, maxRequests: 400, hardMaxRate: 0.5, minTasksPerLevel: 2, exclusions: [{ ...exclusions[0], task: "nope" }] }).problems.join(" "), /outside the batch/);
    const exPlan = calibrationPlan({ batch: cal.dir, harnessDir, harnessCommit: commit, repeats: 3, maxRequests: 400, hardMaxRate: 0.5, minTasksPerLevel: 2, exclusions });
    assert.deepEqual(exPlan.problems, []); assert.notEqual(JSON.stringify(exPlan.rule), JSON.stringify(plan.rule));
    const ex = await runCalibration({ plan: exPlan, state: join(root, "state-ex"), harnessDir, backend, parallelism: 2, budget: new RequestBudget({ path: join(root, "ex.jsonl"), limit: 4500, scope: "t" }) });
    assert.equal(ex.summary.ran, 9, "the excluded (invalid) task is not measured");
    const levelTasks = Object.values(ex.report.levels).reduce((s, l) => s + l.tasks, 0);
    assert.equal(levelTasks, 3, "three of four tasks enter the level means"); assert.equal(ex.report.rule.exclusions.length, 1);
    writeFileSync(evidence, "{}");
    assert.match(exclusionProblems(ex.report.rule.exclusions, plan.tasks).join(" "), /evidence document changed/);
    await assert.rejects(runCalibration({ plan: { ...plan, repeats: 2 }, state: join(root, "state-full"), harnessDir, backend, budget: new RequestBudget({ path: join(root, "roomy.jsonl"), limit: 4500, scope: "t" }) }), /another plan/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("readiness: read-only, model-free; reports blocked/provisional conditions with reasons and fulfilled ones with evidence", async () => {
  const root = tempDir();
  try {
    const src = join(root, "src");
    for (const i of [1, 2, 3]) writeTask(src, `zq-ready-${i}`, record({ kind: "ai-agent", family: `private:bot/f${i}` }));
    const pool = join(root, "pool");
    await intakePrivate({ pool, src, orcheDir: fakeOrche(root), packageDir: join(root, "pkg"), validate: okValidate });
    const docPath = join(root, "RATIONALE.md"); writeFileSync(docPath, "rationale\n");
    const protocol = merge(structuredClone(DEFAULT_PROTOCOL), {
      holdout: { minTasks: 6, minFamilies: 4, acceptedProvenance: ["private-reviewed"], hardBasis: ["calibrated"], priorFamilyReuse: "forbid", maxOwnerShare: 0.5 },
      analysisPlan: { mode: "confirmatory", registeredAt: "2026-11-06T00:00:00Z", rationale: { document: docPath, sha256: sha("rationale\n") }, minEffect: 0.05, alpha: 0.0125, minTasks: 6, minFamilies: 4, minHardTasks: 1, series: { id: "s", ledger: join(root, "series", "ledger.jsonl"), alphaTotal: 0.05 }, lowExposure: { required: true, minTasks: 1, provenance: ["private-reviewed"] }, confirmation: { required: true, pool, alpha: 0.0125, minTasks: 6, minFamilies: 4 } },
      datasets: { holdout: null, holdoutPool: pool },
    });
    const power = writeJson(join(root, "power.json"), { results: [{ plan: { tasks: 6, repeats: 3, alpha: 0.0125, confTasks: 6, confAlpha: 0.0125, minEffect: 0.05, perFamily: 1.5 }, scenario: { model: "logit", sigmaFamily: 0.5, effect: 0.1, violation: 0 }, reps: 200, adoptAndConfirmed: { p: 0.3, mcse: 0.03 } }] });
    const snapshot = () => readdirSync(root, { recursive: true }).map(String).sort().map(p => { const f = join(root, p); return statSync(f).isFile() ? `${p}:${sha(readFileSync(f))}` : p; }).join("|");
    const before = snapshot();
    const r = readiness({ protocol, study: { plan: { targetEffect: 0.1, requiredPower: 0.8, power: [power] } }, orcheDir: fakeOrche(root) });
    assert.equal(snapshot(), before, "readiness writes nothing (no reservation, use, registry or ledger record, not even the series directory)");
    const by = Object.fromEntries(r.conditions.map(c => [c.id, c]));
    assert.equal(r.status, "blocked"); assert.deepEqual(r.sideEffects, { modelCalls: 0, reservations: 0, uses: 0, writes: 0 });
    assert.equal(by["analysis-plan"].status, "provisional"); assert.match(by["analysis-plan"].reasons.join(" "), /below 0.8/);
    assert.match(by["analysis-plan"].reasons[0], /no pre-holdout candidate integrity evidence: 36 candidate runs/, "the integrity veto is part of adequacy");
    // A row that does not state the confirmation design (or a different one) does not count for a plan that requires it.
    const partial = writeJson(join(root, "power-partial.json"), { results: [{ plan: { tasks: 6, repeats: 3, alpha: 0.0125 }, scenario: { model: "logit", sigmaFamily: 0.5, effect: 0.1, v: 0 }, reps: 200, adoptAndConfirmed: { p: 0.99, mcse: 0.005 } }] });
    assert.match(readiness({ protocol, study: { plan: { targetEffect: 0.1, requiredPower: 0.8, power: [partial] } }, orcheDir: fakeOrche(root) }).conditions.find(c => c.id === "analysis-plan").reasons.join(" "), /no simulation result for the registered design/);
    assert.match(readiness({ protocol, study: { plan: { targetEffect: 0.1, requiredPower: 0.8, power: [power], requiredScenarios: ["logit:sf0.5", "template:c2:OC:OCR"] } }, orcheDir: fakeOrche(root) }).conditions.find(c => c.id === "analysis-plan").reasons.join(" "), /required simulation scenarios missing.*template:c2:OC:OCR/);
    // Adequate statistics are still provisional without candidate integrity evidence; with it the survival factor applies.
    const strong = writeJson(join(root, "power-strong.json"), { results: [{ plan: { tasks: 6, repeats: 3, alpha: 0.0125, confTasks: 6, confAlpha: 0.0125, minEffect: 0.05, perFamily: 1.5 }, scenario: { model: "logit", sigmaFamily: 0.5, effect: 0.1, v: 0 }, reps: 200, adoptAndConfirmed: { p: 0.99, mcse: 0.005 } }] });
    const noScreen = readiness({ protocol, study: { plan: { targetEffect: 0.1, requiredPower: 0.8, power: [strong] } }, orcheDir: fakeOrche(root) }).conditions.find(c => c.id === "analysis-plan");
    assert.equal(noScreen.status, "provisional");
    const screened = readiness({ protocol, study: { plan: { targetEffect: 0.1, requiredPower: 0.8, power: [strong], candidateIntegrity: { runs: 400, violations: 0 } } }, orcheDir: fakeOrche(root) }).conditions.find(c => c.id === "analysis-plan");
    assert.equal(screened.evidence.integritySurvival, 401 / 437); assert.equal(screened.status, "fulfilled");
    const short = readiness({ protocol, study: { plan: { targetEffect: 0.1, requiredPower: 0.8, power: [strong], candidateIntegrity: { runs: 20, violations: 0 } } }, orcheDir: fakeOrche(root) }).conditions.find(c => c.id === "analysis-plan");
    assert.equal(short.status, "provisional", "21/57 survival x 0.98 is below 0.8");
    assert.equal(by["series-budget"].status, "fulfilled");
    assert.equal(by["private-review"].status, "blocked"); assert.match(by["private-review"].reasons.join(" "), /3 of 3 private tasks have no review accepted under holdout.privateReview human.*AI-agent review is not human review/);
    assert.equal(by.calibration.status, "blocked"); assert.match(by.calibration.reasons.join(" "), /no sealed calibration-purpose batch/);
    assert.equal(by["main-holdout"].status, "blocked"); assert.equal(by["confirmation-holdout"].status, "blocked");
    assert.equal(by["cross-pool-overlap"].status, "fulfilled");
    // An incomplete plan (rationale changed after registration) and an exhausted series budget are blocked, not provisional.
    writeFileSync(docPath, "edited\n");
    const r2 = readiness({ protocol, study: { plan: { targetEffect: 0.1, requiredPower: 0.8, power: [power] } }, orcheDir: fakeOrche(root) });
    assert.equal(r2.conditions.find(c => c.id === "analysis-plan").status, "blocked");
    const small = merge(structuredClone(protocol), { analysisPlan: { series: { alphaTotal: 0.02 } } });
    writeFileSync(docPath, "rationale\n");
    assert.match(readiness({ protocol: small, study: {}, orcheDir: fakeOrche(root) }).conditions.find(c => c.id === "analysis-plan").reasons.join(" "), /exceeds series.alphaTotal/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("power simulation: the simulated decision is the evaluator's conjunction (sharp null never adopts; a violation blocks)", () => {
  const pilot = { arms: Object.fromEntries(["S", "D1"].map(arm => [arm, { tasks: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`t${i}`, { family: `f${i % 4}`, tier: i % 2 ? "hard" : "easy", outcomes: arm === "S" ? [i % 2, 1, 0] : [1, 1, i % 2] }])) }])) };
  const table = pilotTable(pilot, ["D1"]);
  const plan = { ...BASE_PLAN, draws: 300, permutationDraws: 300, tasks: 12, confTasks: 12, hardFamilies: 1, minHardTasks: 3 };
  const protocol = simProtocol(plan);
  const rng = createRng("t");
  const sc = calibrateScenario(table, { model: "logit", sigmaFamily: 0, sigmaTask: 0, effect: 0, violation: 0 }, plan);
  for (let i = 0; i < 5; i++) assert.notEqual(holdoutVerdict(observe(rng, drawDesign(rng, table, sc, plan), 3, 0), protocol, plan, `s${i}`).verdict, "ADOPT");
  const big = calibrateScenario(table, { model: "logit", sigmaFamily: 0, sigmaTask: 0, effect: 0.3, violation: 1 }, plan);
  assert.ok(Math.abs(big.achieved - 0.3) < 0.02);
  assert.equal(holdoutVerdict(observe(rng, drawDesign(rng, table, big, plan), 3, 1), protocol, plan, "v").why, "critical");
});

test("versioned remedy: a new version supersedes its staged, unsealed predecessor at intake; content mismatch, sealed or unknown predecessors are refused", async () => {
  const root = tempDir();
  try {
    const pool = join(root, "pool"), orcheDir = fakeOrche(root);
    const src1 = join(root, "src1"); writeTask(src1, "p1", record({ family: "private:alice/p" })); writeTask(src1, "p2", record({ family: "private:alice/q" }));
    await intakePrivate({ pool, src: src1, orcheDir, packageDir: join(root, "pkg"), validate: okValidate });
    const { taskContentDigest } = await import("../src/datasets.mjs");
    const p1 = JSON.parse(readFileSync(join(pool, "cases/p1/task.json"), "utf8"));
    const digest = taskContentDigest(join(pool, "cases/p1"), p1.instruction);
    // v2 = same task plus an added hidden test (the remedy), naming its predecessor and the content it came from.
    const src2 = join(root, "src2");
    const v2 = writeTask(src2, "p1-v2", { ...record({ family: "private:alice/p" }), version: 2, supersedes: { id: "p1", contentDigest: digest } });
    writeFileSync(join(v2, "repo/src/index.js"), readFileSync(join(pool, "cases/p1/repo/src/index.js")));
    writeFileSync(join(v2, "reference/src/index.js"), readFileSync(join(pool, "cases/p1/reference/src/index.js")));
    writeFileSync(join(v2, "hidden/test/b.xprov.test.js"), "// added by the remedy\n");
    const bad = writeTask(src2, "p2-v2", { ...record({ family: "private:alice/q" }), version: 2, supersedes: { id: "p2", contentDigest: "0".repeat(64) } });
    const r = await intakePrivate({ pool, src: src2, orcheDir, packageDir: join(root, "pkg"), validate: okValidate });
    assert.deepEqual(r.eligible.map(e => e.id), ["p1-v2"]);
    assert.equal(r.rejected["supersedes-content-mismatch"], 1, "a version must derive from the predecessor's current content");
    const st = poolState(pool);
    assert.equal(st.cases.get("p1").status, "superseded"); assert.equal(st.cases.get("p1").by, "p1-v2");
    assert.equal(st.cases.get("p2").status, "eligible", "a rejected version leaves its predecessor untouched");
    assert.ok(readdirSync(join(pool, "superseded")).includes("p1")); assert.ok(!readdirSync(join(pool, "cases")).includes("p1"));
    assert.ok(bad);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
