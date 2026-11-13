// Isolated calibration runtime, corrected calibration batch and review accounting (2026-11-07, model-free). The end-to-end
// runtime behaviour (real gateway binary, h2 stand-in, gate, restart, concurrency, truncation) is the selftest of
// studies/confirmatory-1/isolated-runtime.mjs; these tests pin the pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rmSync, tempDir } from "./helpers.mjs";
import { CODEX_REFRESH_LEAD_H, PINNED_GATEWAY, configProblems, jwtExpiryMs, prepareRuntime, privateConfigYaml, runtimeProblems, snapshotCredential } from "../src/isolated-runtime.mjs";
import { caseDigest, poolState, registryOf, retireBatch, sealBatch, sealCalibrationBatch, sealableCases, withdrawCase } from "../src/supply.mjs";
import { verifySeal, datasetPurpose } from "../src/datasets.mjs";
import { remedyChain } from "../studies/confirmatory-1/triage.mjs";
import { correctedProblems } from "../studies/confirmatory-1/seal-corrected.mjs";
import { summarize } from "../studies/confirmatory-1/review-summary.mjs";
import { INVALID_CLASSES, peerExperiments } from "../studies/confirmatory-1/calibrate.mjs";
import { sandboxArgs } from "../studies/confirmatory-1/isolated-runtime.mjs";

const jwt = (expSec) => ["e30", Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url"), "sig"].join(".");
const LIVE_BINARY = "/home/arthur/Downloads/EasyCLIProxyAPI-v0.3.20-Linux-amd64/cpa-core/cli-proxy-api";

test("private gateway config: exact invariants (no retry rounds, one credential, gate proxy, no plugins/management); any drift is a problem", () => {
  const text = privateConfigYaml({ apiKey: "k", authDir: "/x/auth" });
  assert.deepEqual(configProblems(text), []);
  assert.ok(configProblems(text.replace("request-retry: 0", "request-retry: 3")).length);
  assert.ok(configProblems(text.replace(/proxy-url: "[^"]+"/, 'proxy-url: ""')).length);
  assert.ok(configProblems(text.replace("plugins:\n  enabled: false", "plugins:\n  enabled: true")).length);
  assert.ok(configProblems(`${text}codex-api-key:\n  - api-key: x\n`).length);
});

test("credential snapshot: access token only (no refresh/id token), refused within the refresh lead, for prefixed or disabled credentials", () => {
  const root = tempDir();
  try {
    const now = Date.now();
    const src = join(root, "codex.json");
    const base = { type: "codex", access_token: jwt(Math.floor(now / 1000) + 10 * 86400), refresh_token: "r", id_token: "i", account_id: "acc", email: "e", disabled: false };
    writeFileSync(src, JSON.stringify(base));
    const { snapshot, facts } = snapshotCredential({ source: src, now });
    assert.equal(snapshot.refresh_token, undefined); assert.equal(snapshot.id_token, undefined);
    assert.equal(snapshot.websockets, false); assert.equal(facts.refreshTokenCopied, false);
    assert.ok(!JSON.stringify(facts).includes(base.access_token), "facts carry no secret");
    writeFileSync(src, JSON.stringify({ ...base, access_token: jwt(Math.floor(now / 1000) + (CODEX_REFRESH_LEAD_H + 2) * 3600) }));
    assert.throws(() => snapshotCredential({ source: src, now }), /refresh lead/);
    writeFileSync(src, JSON.stringify({ ...base, prefix: "bts" }));
    assert.throws(() => snapshotCredential({ source: src, now }), /prefixed/);
    writeFileSync(src, JSON.stringify({ ...base, disabled: true }));
    assert.throws(() => snapshotCredential({ source: src, now }), /disabled/);
    assert.throws(() => jwtExpiryMs("opaque"), /not a JWT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepared runtime: pinned binary/config, one access-token-only credential; tampering is detected; never re-prepared in place", { skip: !existsSync(LIVE_BINARY) && "verified gateway binary not on this host" }, () => {
  const root = tempDir();
  try {
    const dir = join(root, "rt");
    const credential = { snapshot: { type: "codex", access_token: jwt(Math.floor(Date.now() / 1000) + 30 * 86400), account_id: "a", disabled: false, prefix: "", websockets: false }, facts: { test: true } };
    const m = prepareRuntime({ dir, binary: LIVE_BINARY, credential, outerPort: 18499, mode: "test", budget: { path: join(root, "b.jsonl"), limit: 5, scope: "t" } });
    assert.equal(m.gateway.sha256, PINNED_GATEWAY.sha256);
    assert.deepEqual(runtimeProblems(dir, { running: false, mode: "test" }), []);
    assert.match(runtimeProblems(dir, { running: false, mode: "live" }).join(" "), /mode is test/, "a selftest runtime never serves calibration");
    assert.match(runtimeProblems(dir, { running: false, mode: "test", budgetPath: join(root, "other.jsonl") }).join(" "), /another budget ledger/);
    assert.match(runtimeProblems(dir, { running: true, mode: "test" }).join(" "), /supervisor not running/);
    writeFileSync(join(dir, "auth", "extra.json"), JSON.stringify({ type: "codex", access_token: "x", refresh_token: "r" }));
    assert.match(runtimeProblems(dir, { running: false, mode: "test" }).join(" "), /holds 2 credentials/);
    assert.throws(() => prepareRuntime({ dir, binary: LIVE_BINARY, credential, outerPort: 18499, mode: "test", budget: {} }), /already prepared/);
    const args = sandboxArgs({ dir });
    assert.ok(args.includes("--unshare-net") && args.includes("--clearenv"), "own network namespace, clean environment");
    assert.ok(args.indexOf("--tmpfs") < args.indexOf("--bind"), "the runtime dir is bound over the empty /home");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A pool with one sealed-holdout-free registry: staged corrected versions and an eligible holdout case. */
function makePool(root) {
  const pool = join(root, "pool");
  const stage = (id, family, dirName = "calibration-staged") => {
    const d = join(pool, dirName, id);
    mkdirSync(join(d, "repo"), { recursive: true }); mkdirSync(join(d, "hidden", "test"), { recursive: true }); mkdirSync(join(d, "reference"), { recursive: true });
    writeFileSync(join(d, "task.json"), JSON.stringify({ id, family, tier: "hard", instruction: "do it", provenance: "private-reviewed", version: 2, derivedFrom: { id: id.replace(/-v\d+$/, "") } }));
    writeFileSync(join(d, "repo", "a.js"), "export const a = 1;\n"); writeFileSync(join(d, "hidden", "test", "a.test.js"), "// t\n");
    return d;
  };
  const reg = registryOf(pool);
  for (const [id, fam] of [["c1-x-v2", "fam/x"], ["c1-y-v2", "fam/y"], ["c1-z-v2", "fam/holdout"]]) {
    const d = stage(id, fam);
    reg.append({ type: "case", caseId: id, status: "eligible", family: fam, contentDigest: caseDigest(d) });
    reg.append({ type: "case", caseId: id, status: "calibration-only" });
  }
  const h = stage("c1-h", "fam/holdout", "cases");
  reg.append({ type: "case", caseId: "c1-h", status: "eligible", family: "fam/holdout", contentDigest: caseDigest(h) });
  return pool;
}

test("corrected calibration seal: only calibration-only, unbatched, digest-matching, family-disjoint versions; any problem refuses all; staged copies kept", () => {
  const root = tempDir();
  try {
    const pool = makePool(root);
    const cfg = { batch: { seed: "s" } };
    // A check failing for one id refuses the whole seal.
    let r = sealCalibrationBatch({ pool, ids: ["c1-x-v2", "c1-y-v2"], cfg, checks: (id) => (id === "c1-y-v2" ? ["no triage"] : []) });
    assert.equal(r.blocked, "calibration seal refused"); assert.match(r.problems.join(" "), /c1-y-v2: no triage/);
    assert.match(sealCalibrationBatch({ pool, ids: ["c1-h"], cfg }).problems.join(" "), /calibration-only required/, "a holdout candidate is never sealed for calibration");
    assert.match(sealCalibrationBatch({ pool, ids: ["c1-z-v2"], cfg }).problems.join(" "), /also occurs in holdout material/, "calibration and holdout families stay disjoint");
    writeFileSync(join(pool, "calibration-staged", "c1-x-v2", "repo", "a.js"), "export const a = 2;\n");
    assert.match(sealCalibrationBatch({ pool, ids: ["c1-x-v2"], cfg }).problems.join(" "), /differs from its intake record/);
    writeFileSync(join(pool, "calibration-staged", "c1-x-v2", "repo", "a.js"), "export const a = 1;\n");
    r = sealCalibrationBatch({ pool, ids: ["c1-y-v2", "c1-x-v2"], cfg });
    assert.ok(r.batch, JSON.stringify(r));
    assert.deepEqual(r.tasks, ["c1-x-v2", "c1-y-v2"]);
    assert.equal(datasetPurpose(r.dir), "calibration");
    assert.equal(verifySeal(r.dir).ok, true);
    assert.ok(existsSync(join(pool, "calibration-staged", "c1-x-v2", "task.json")) && existsSync(join(pool, "cases", "c1-h", "task.json")), "staged versions and holdout cases are untouched");
    const st = poolState(pool);
    assert.equal(st.batches.get(r.batch).purpose, "calibration");
    assert.match(sealCalibrationBatch({ pool, ids: ["c1-x-v2"], cfg }).problems.join(" "), /already in a batch/, "never sealed twice");
    assert.deepEqual(st.chain, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrected-version checks and remedy chain: triage of this version, no invalid class, every adjudicated violation rejected", () => {
  const root = tempDir();
  try {
    const reviews = join(root, "reviews"), dir = join(root, "task", "c1-x-v2");
    mkdirSync(join(reviews, "c1-x-v2"), { recursive: true }); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "validation.private.json"), JSON.stringify({ ok: true, code: "valid" }));
    writeFileSync(join(dir, "task.json"), JSON.stringify({ id: "c1-x-v2", derivedFrom: { id: "c1-x" }, remedy: { violations: ["m1"] } }));
    assert.match(correctedProblems({ id: "c1-x-v2", dir, reviews }).join(" "), /no cross-provider triage/);
    const triage = { task: "c1-x-v2", classes: ["ok"], blind: { referencePasses: true, discriminates: true }, adversarial: { verdict: "accept" }, remedyCheck: [{ mutant: "m1", hiddenAccepts: false }] };
    writeFileSync(join(reviews, "c1-x-v2", "triage.json"), JSON.stringify(triage));
    assert.deepEqual(correctedProblems({ id: "c1-x-v2", dir, reviews }), []);
    writeFileSync(join(reviews, "c1-x-v2", "triage.json"), JSON.stringify({ ...triage, remedyCheck: [{ mutant: "m1", hiddenAccepts: true }], classes: ["remedy-incomplete"] }));
    assert.equal(correctedProblems({ id: "c1-x-v2", dir, reviews }).length, 2);
    assert.ok(INVALID_CLASSES.includes("remedy-incomplete"), "the calibration runner refuses an unremedied version too");
    // Remedy chain: the version's own violations plus every adjudicated violation of its ancestors, located by mutant name.
    mkdirSync(join(reviews, "c1-x", "adjudicate-adversarial-g-1", "output"), { recursive: true });
    writeFileSync(join(reviews, "c1-x", "adjudicate-adversarial-g-1", "output", "adjudication.json"), JSON.stringify({ mutants: [{ name: "m2", resolution: "violation" }, { name: "m3", resolution: "not-a-violation" }] }));
    for (const m of ["m1", "m2", "m3"]) mkdirSync(join(reviews, "c1-x", "adversarial-g-0", "output", "mutants", m), { recursive: true });
    const chain = remedyChain({ task: { id: "c1-x-v2", dir }, reviews });
    assert.deepEqual(chain.ancestors, ["c1-x"]);
    assert.deepEqual(chain.violations.map(v => [v.name, !!v.dir]), [["m1", true], ["m2", true]], "a not-a-violation mutant is not required to fail");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review summary: a session copied to another task version is listed there but counted once; unpriced sessions reported apart", () => {
  const root = tempDir();
  try {
    const rec = (price) => JSON.stringify({ role: "adversarial", reviewer: { route: "cliproxyapi/m", provider: "google", responseModels: ["m"] }, startedAt: "2026-11-07T00:00:00Z", run: { completed: 5, providerErrors: 0, forwarded: 10, tokens: { input: 100, output: 10 }, listPriceUSD: price }, access: { denialProbe: [] } });
    for (const [task, s, price] of [["cf1-a", "adversarial-m-1", 1.5], ["cf1-a-v2", "adversarial-m-1", 1.5], ["cf1-b", "adversarial-m-2", 0]]) { mkdirSync(join(root, task, s), { recursive: true }); writeFileSync(join(root, task, s, "review.json"), task === "cf1-b" ? rec(price).replace("00:00:00", "01:00:00") : rec(price)); }
    const sum = summarize(root);
    assert.equal(sum.totals.sessions, 2); assert.equal(sum.totals.duplicateListings, 1);
    assert.equal(sum.totals.forwarded, 20); assert.equal(sum.totals.listPriceUSD, 1.5);
    assert.equal(sum.totals.unpriced.sessions, 1);
    assert.equal(sum.tasks["cf1-a-v2"].sessions[0].duplicateOf, "cf1-a/adversarial-m-1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("peer experiment detection ignores shells and this test process", () => {
  assert.ok(Array.isArray(peerExperiments()));
  assert.ok(peerExperiments().every(p => !/node --test/.test(p.cmd)));
});

test("calibration @2: integrity, infrastructure and grader failures never certify difficulty; no valid unit = insufficient evidence, not hard", async () => {
  const { CENSORING_V2, buildCalibrationReport, outcomesFromLedger, unitClassesFromLedger, verifyCalibrationReport, exactInterval } = await import("../src/calibration.mjs");
  const { Ledger } = await import("../src/util.mjs");
  const { sealOf } = await import("../src/datasets.mjs");
  const root = tempDir();
  try {
    const pool = join(root, "pool"), dir = join(pool, "batches", "bc");
    const tiers = { e1: "easy", e2: "easy", e3: "easy", m1: "medium", m2: "medium", m3: "medium", h1: "hard", h2: "hard", h3: "hard" };
    for (const [id, tier] of Object.entries(tiers)) { mkdirSync(join(dir, id, "repo"), { recursive: true }); writeFileSync(join(dir, id, "repo", "i.js"), `// ${id}\n`); writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, family: `gh:f/${id}`, tier, instruction: id, provenance: "external" })); }
    writeFileSync(join(dir, "PROVENANCE.json"), JSON.stringify({ purpose: "calibration" }));
    writeFileSync(join(dir, "SEAL.json"), JSON.stringify(sealOf(dir)));
    registryOf(pool).append({ type: "batch", batch: "bc", dir: "batches/bc", tasks: Object.keys(tiers), sealDigest: sealOf(dir).digest, coverage: {}, purpose: "calibration" });
    const ledger = join(root, "runs.jsonl"), l = new Ledger(ledger);
    // kinds: S success, F hidden failure, I hidden PASS + integrity violation, X hidden fail + violation, N infra, G grader error
    const plan = { e1: "III", e2: "IIS", e3: "XIS", m1: "NNN", m2: "GGF", m3: "SFS", h1: "FFF", h2: "FFI", h3: "FXF" };
    for (const [id, kinds] of Object.entries(plan)) [...kinds].forEach((k, repeat) => l.append({ type: "result", unit_key: `${id}#${repeat}`, record: { candidate_id: "stable", harness_commit: "c0", context: "calibration", task_id: id, repeat, attempt: 1, terminal_status: k === "N" ? "model_error" : k === "G" ? "grader_error" : "completed", retryable: false, hidden_test_pass: k === "S" || k === "I", visible_test_pass: true, integrity: { violations: "IX".includes(k) ? ["edited test file"] : [] }, critical_failure_count: "IX".includes(k) ? 1 : 0, model_requests_completed: 3 } }));
    const tasks = Object.keys(tiers);
    const outcomes = outcomesFromLedger(ledger, { harnessId: "stable", context: "calibration", repeats: 3, tasks, censoring: CENSORING_V2 });
    assert.deepEqual(outcomes.e1, [], "hidden pass 1.0 but integrity violations: no cognitive evidence");
    assert.deepEqual(outcomes.e3, [1], "mixed: only the clean unit counts");
    assert.deepEqual(outcomes.m1, [], "infrastructure only: no evidence");
    assert.deepEqual(outcomes.m2, [0], "grader errors censored, the agent failure counts");
    assert.deepEqual(outcomes.h2, [0, 0]);
    const measuredWith = { kind: "runner-ledger", ledger, harnessId: "stable", harnessCommit: "c0", context: "calibration", repeats: 3 };
    const report = buildCalibrationReport({ batchDir: dir, outcomes, feature: "declared-tier", hardMaxRate: 0.5, minTasksPerLevel: 3, measuredWith, censoring: CENSORING_V2, minValidUnitsPerTask: 2, unitClasses: unitClassesFromLedger(ledger, { harnessId: "stable", context: "calibration", repeats: 3, tasks }) });
    assert.deepEqual(report.rule.hardLevels, ["hard"], "only the level with >= 3 sufficient tasks of genuine failures");
    assert.equal(report.levels.easy.tasks, 0); assert.equal(report.levels.easy.insufficientTasks, 3);
    assert.equal(report.levels.easy.meanRate, null);
    assert.equal(report.taskEvidence.e1.evidence, "insufficient");
    assert.deepEqual(report.taskEvidence.h1.ci95, exactInterval(0, 3));
    assert.ok(report.taskEvidence.h1.ci95[1] > 0.7, "0/3 does not show a task is truly hard");
    assert.deepEqual(verifyCalibrationReport(report), []);
    // The same ledger under @1 (integrity counted as failure) would make "easy" hard: refused as difficulty evidence.
    const v1out = outcomesFromLedger(ledger, { harnessId: "stable", context: "calibration", repeats: 3, tasks: tasks.filter(t => t !== "m1"), censoring: "infra-excluded@1" });
    assert.deepEqual(v1out.e1, [0, 0, 0]);
    assert.throws(() => buildCalibrationReport({ batchDir: dir, outcomes, feature: "declared-tier", hardMaxRate: 0.5, minTasksPerLevel: 3, measuredWith, censoring: CENSORING_V2 }), /minValidUnitsPerTask/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("withdrawCase: an eligible unbatched case leaves eligibility with code, reason and verified evidence; never a sealed or non-eligible case", () => {
  const root = tempDir();
  try {
    const pool = makePool(root);
    const ev = join(root, "evidence.json"); writeFileSync(ev, "{}\n");
    const evidence = { document: ev, sha256: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356" };
    assert.throws(() => withdrawCase({ pool, caseId: "c1-h", code: "x", reason: "r", evidence: { document: ev, sha256: "0".repeat(64) } }), /missing or changed/);
    assert.throws(() => withdrawCase({ pool, caseId: "c1-x-v2", code: "x", reason: "r", evidence }), /calibration-only, not eligible/);
    assert.ok(sealableCases(pool, poolState(pool)).some(r => r.caseId === "c1-h"));
    withdrawCase({ pool, caseId: "c1-h", code: "sibling-answer-leak", reason: "carries a sibling's reference file", evidence });
    const st = poolState(pool);
    assert.equal(st.cases.get("c1-h").status, "withdrawn");
    assert.ok(!sealableCases(pool, st).some(r => r.caseId === "c1-h"), "never sealable again");
    assert.ok(existsSync(join(pool, "cases", "c1-h", "task.json")), "kept as provenance");
    assert.throws(() => withdrawCase({ pool, caseId: "c1-h", code: "x", reason: "r", evidence }), /withdrawn, not eligible/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sibling isolation: leaks are detected by content; an isolable task gets a version whose start lacks the sibling answer and whose minimal solution passes", async () => {
  const { leaksInto, isolate } = await import("../studies/confirmatory-1/sibling.mjs");
  const root = tempDir();
  try {
    const mk = (id, files) => { const d = join(root, "src", id); for (const [p, c] of Object.entries(files)) { mkdirSync(join(d, p, ".."), { recursive: true }); writeFileSync(join(d, p), c); } writeFileSync(join(d, "task.json"), JSON.stringify({ id, instruction: id, review: { crossProvider: { x: 1 } }, exposure: {} })); return d; };
    const pkg = JSON.stringify({ type: "module", scripts: { test: "node --test" } });
    const visible = 'import { test } from "node:test"; import assert from "node:assert/strict"; import { a } from "../src/a.js"; test("v", () => assert.equal(typeof a, "function"));\n';
    // Y fixes a.js (returns 2). X fixes b.js (returns 3) and its start already contains Y's fixed a.js.
    const y = mk("t-y", { "repo/package.json": pkg, "repo/src/a.js": "export const a = () => 1;\n", "repo/src/b.js": "export const b = () => 0;\n", "repo/test/v.test.js": visible, "reference/src/a.js": "export const a = () => 2;\n", "hidden/test/y.hidden.test.js": "" });
    const x = mk("t-x", { "repo/package.json": pkg, "repo/src/a.js": "export const a = () => 2;\n", "repo/src/b.js": "export const b = () => 0;\n", "repo/test/v.test.js": visible, "reference/src/b.js": "export const b = () => 3;\n", "hidden/test/x.hidden.test.js": 'import { test } from "node:test"; import assert from "node:assert/strict"; import { b } from "../src/b.js"; test("h", () => assert.equal(b(), 3));\n' });
    assert.deepEqual(leaksInto(x, [x, y]).map(l => [l.file, l.sibling]), [["src/a.js", "t-y"]]);
    assert.deepEqual(leaksInto(y, [x, y]), []);
    const r = isolate({ xDir: x, siblingDirs: [y], out: join(root, "out"), scratch: join(root, "scratch"), contentDigest: () => "d" });
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.equal(readFileSync(join(r.dir, "repo", "src", "a.js"), "utf8"), "export const a = () => 1;\n", "sibling answer reverted to its unsolved start");
    const m = JSON.parse(readFileSync(join(r.dir, "task.json"), "utf8"));
    assert.equal(m.id, "t-x-v2"); assert.equal(m.remedy.kind, "sibling-isolation"); assert.equal(m.review.crossProvider, undefined, "cross-provider evidence never carries over to changed content");
    assert.deepEqual(leaksInto(r.dir, [r.dir, y]), []);
    assert.match(isolate({ xDir: x, siblingDirs: [y], out: join(root, "out"), scratch: join(root, "scratch"), contentDigest: () => "d" }).problems.join(" "), /never rebuilt in place/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("attachCrossProvider: refuses without a triage of this task, with an open review, or with adjudicated violations still accepted", async () => {
  const { attachCrossProvider } = await import("../studies/confirmatory-1/remedy.mjs");
  const root = tempDir();
  try {
    const dir = join(root, "t", "c1-a"), reviews = join(root, "reviews");
    mkdirSync(dir, { recursive: true }); mkdirSync(join(reviews, "c1-a"), { recursive: true });
    writeFileSync(join(dir, "task.json"), JSON.stringify({ id: "c1-a", instruction: "i" }));
    assert.match(attachCrossProvider({ dir, reviews }).problems.join(" "), /no triage of this task/);
    writeFileSync(join(reviews, "c1-a", "triage.json"), JSON.stringify({ task: "c1-b", classes: ["ok"] }));
    assert.match(attachCrossProvider({ dir, reviews }).problems.join(" "), /no triage of this task/, "a triage of other content is not evidence");
    writeFileSync(join(reviews, "c1-a", "triage.json"), JSON.stringify({ task: "c1-a", classes: ["incomplete"] }));
    assert.match(attachCrossProvider({ dir, reviews }).problems.join(" "), /incomplete/);
    writeFileSync(join(reviews, "c1-a", "triage.json"), JSON.stringify({ task: "c1-a", classes: ["test-gap"], mutants: [{ name: "m", hiddenAccepts: true }] }));
    assert.match(attachCrossProvider({ dir, reviews }).problems.join(" "), /not adjudicated/);
    mkdirSync(join(reviews, "c1-a", "adjudicate-adversarial-x-1", "output"), { recursive: true });
    writeFileSync(join(reviews, "c1-a", "adjudicate-adversarial-x-1", "output", "adjudication.json"), JSON.stringify({ mutants: [{ name: "m", resolution: "violation" }] }));
    assert.match(attachCrossProvider({ dir, reviews }).problems.join(" "), /needs a tests remedy version/);
    assert.equal(JSON.parse(readFileSync(join(dir, "task.json"), "utf8")).review, undefined, "nothing attached on refusal");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retireBatch: only a never-reserved, never-used holdout batch; restaged tasks must reproduce their decided digest; the batch is never offered again", async () => {
  const { holdoutLedger } = await import("../src/datasets.mjs");
  const root = tempDir();
  try {
    const pool = makePool(root);
    for (const id of ["c1-p", "c1-q", "c1-r", "c1-s"]) {
      const d = join(pool, "cases", id); mkdirSync(join(d, "repo"), { recursive: true });
      writeFileSync(join(d, "task.json"), JSON.stringify({ id, family: `fam/${id}`, tier: "easy", instruction: "i", provenance: "external" })); writeFileSync(join(d, "repo", "a.js"), `// ${id}\n`);
      registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family: `fam/${id}`, tier: "easy", contentDigest: caseDigest(d) });
    }
    const sealed = sealBatch({ pool, cfg: { batch: { seed: "s", maxTasks: 5, maxPerFamily: 2, maxOwnerShare: 1 } }, minima: { minTasks: 1, minFamilies: 1, requireHard: false, hardBasis: [] } });
    assert.ok(sealed.batch, JSON.stringify(sealed));
    const ev = join(root, "why.json"); writeFileSync(ev, "{}\n");
    const evidence = { document: ev, sha256: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356" };
    const ids = poolState(pool).batches.get(sealed.batch).tasks;
    assert.throws(() => retireBatch({ pool, batch: sealed.batch, code: "x", reason: "r", evidence, restage: ["nope"] }), /not in/);
    // A reserved batch is refused; so is a used one.
    registryOf(pool).append({ type: "reserve", batch: sealed.batch, stateDir: "/s", sealDigest: sealed.seal });
    assert.throws(() => retireBatch({ pool, batch: sealed.batch, code: "x", reason: "r", evidence }), /reserved/);
    const pool2 = makePool(join(root, "two"));
    for (const id of ["c2-p"]) { const d = join(pool2, "cases", id); mkdirSync(join(d, "repo"), { recursive: true }); writeFileSync(join(d, "task.json"), JSON.stringify({ id, family: "fam/z", tier: "easy", instruction: "i", provenance: "external" })); writeFileSync(join(d, "repo", "a.js"), "z\n"); registryOf(pool2).append({ type: "case", caseId: id, status: "eligible", family: "fam/z", tier: "easy", contentDigest: caseDigest(d) }); }
    const s2 = sealBatch({ pool: pool2, cfg: { batch: { seed: "s", maxTasks: 5, maxPerFamily: 2, maxOwnerShare: 1 } }, minima: { minTasks: 1, minFamilies: 1, requireHard: false, hardBasis: [] } });
    holdoutLedger(s2.dir).append({ type: "use", stateDir: "/x" });
    assert.throws(() => retireBatch({ pool: pool2, batch: s2.batch, code: "x", reason: "r", evidence }), /recorded use/);
    // A clean third batch: retired with two tasks restaged; it is never offered again and its tasks are sealable once more.
    const pool3 = makePool(join(root, "three"));
    for (const id of ["c3-p", "c3-q"]) { const d = join(pool3, "cases", id); mkdirSync(join(d, "repo"), { recursive: true }); writeFileSync(join(d, "task.json"), JSON.stringify({ id, family: `fam/${id}`, tier: "easy", instruction: "i", provenance: "external" })); writeFileSync(join(d, "repo", "a.js"), `${id}\n`); registryOf(pool3).append({ type: "case", caseId: id, status: "eligible", family: `fam/${id}`, tier: "easy", contentDigest: caseDigest(d) }); }
    const s3 = sealBatch({ pool: pool3, cfg: { batch: { seed: "s", maxTasks: 5, maxPerFamily: 2, maxOwnerShare: 1 } }, minima: { minTasks: 1, minFamilies: 1, requireHard: false, hardBasis: [] } });
    const t3 = poolState(pool3).batches.get(s3.batch).tasks;
    const r = retireBatch({ pool: pool3, batch: s3.batch, code: "lineage", reason: "contains tasks of an earlier holdout", evidence, restage: ["c3-p"] });
    assert.deepEqual(r.restaged, ["c3-p"]);
    const st3 = poolState(pool3);
    assert.equal(st3.batches.has(s3.batch), false); assert.equal(st3.retired.has(s3.batch), true);
    assert.ok(sealableCases(pool3, st3).some(c => c.caseId === "c3-p"), "restaged task sealable again");
    assert.ok(!sealableCases(pool3, st3).some(c => c.caseId === "c3-q"), "a task not restaged stays out");
    assert.ok(existsSync(join(pool3, "batches", s3.batch, "SEAL.json")), "the retired batch directory stays as provenance");
    assert.throws(() => retireBatch({ pool: pool3, batch: s3.batch, code: "x", reason: "r", evidence }), /not a live batch/);
    assert.deepEqual(st3.chain, []);
    void ids; void t3;
  } finally { rmSync(root, { recursive: true, force: true }); }
});
