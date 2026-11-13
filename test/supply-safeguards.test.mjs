// protocol-4 supply safeguards (synthetic, local, model-free): cross-family lexical near-duplicates and repository lineage,
// concentration and prior-family checks at the eligibility boundary (not only at sealing), separate calibration sets, the
// low-exposure (private-reviewed) intake and its review record, and verified calibrated difficulty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rmSync, tempDir } from "./helpers.mjs";
import { calibrationProblems, datasetPurpose, difficultyBasisOf, holdoutStatus, loadLocal, reviewProblems, sealOf } from "../src/datasets.mjs";
import { batchEligibility, codeShingles, collect, crossFamilyOverlap, intakePrivate, jaccard, knownCorpus, lineageOf, mergeSupply, poolState, priorHoldoutFamilies, registryOf, sealBatch } from "../src/supply.mjs";
import { CENSORING_V2, buildCalibrationReport, outcomesFromLedger, verifyCalibrationReport } from "../src/calibration.mjs";
import { DEFAULT_PROTOCOL } from "../src/protocol.mjs";
import { Ledger, sha256 } from "../src/util.mjs";
import { main as supplyMain } from "../src/supply-cli.mjs";

const MIT = "MIT License\n\nCopyright (c) 2024 Upstream Dev\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...\n";
const gitc = (dir, args, env = {}) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "d@e", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "d@e", ...env } }).toString().trim();
const CFG = mergeSupply({ since: "2026-01-01T00:00:00Z", validation: { repeats: 1, timeoutMs: 60_000 }, batch: { maxTasks: 12, maxPerFamily: 2, seed: "test" } });
const okValidate = async () => ({ ok: true, code: "valid", expected: { hiddenTests: 1 }, detail: {} });
function fakeOrche(root) { const o = join(root, "orche"); mkdirSync(join(o, "experiments/x"), { recursive: true }); writeFileSync(join(o, "experiments/x/plan.md"), "notes\n"); return o; }

/** A ~25-line library whose identifiers are renamed by `prefix` (a lexical copy under other names). */
const LIB = (prefix) => `export function ${prefix}Tokenize(input) {\n  const out = [];\n  let i = 0;\n  while (i < input.length) {\n    const ch = input[i];\n    if (ch === " " || ch === "\\n") { i++; continue; }\n    if (/[0-9]/.test(ch)) {\n      let j = i;\n      while (j < input.length && /[0-9.]/.test(input[j])) j++;\n      out.push({ kind: "num", value: Number(input.slice(i, j)) });\n      i = j;\n      continue;\n    }\n    if ("+-*/()".includes(ch)) { out.push({ kind: "op", value: ch }); i++; continue; }\n    throw new SyntaxError("unexpected " + ch + " at " + i);\n  }\n  return out;\n}\nexport function ${prefix}Evaluate(tokens) {\n  let pos = 0;\n  const peek = () => tokens[pos];\n  const next = () => tokens[pos++];\n  function expr() { let v = term(); while (peek() && (peek().value === "+" || peek().value === "-")) { const op = next().value; const r = term(); v = op === "+" ? v + r : v - r; } return v; }\n  function term() { let v = factor(); while (peek() && (peek().value === "*" || peek().value === "/")) { const op = next().value; const r = factor(); v = op === "*" ? v * r : v / r; } return v; }\n  function factor() { const t = next(); if (!t) throw new SyntaxError("end"); if (t.kind === "num") return t.value; if (t.value === "(") { const v = expr(); next(); return v; } if (t.value === "-") return -factor(); throw new SyntaxError("bad " + t.value); }\n  return expr();\n}\n`;
const TEST = (prefix, extra = "") => `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${prefix}Tokenize, ${prefix}Evaluate } from "../index.js";\ntest("evaluates", () => assert.equal(${prefix}Evaluate(${prefix}Tokenize("1 + 2 * 3")), 7));\n${extra}`;

function repo(root, slug, prefix, { fromDir } = {}) {
  const dir = join(root, "upstream", slug.replace("/", "__"));
  if (fromDir) gitc(root, ["clone", "-q", fromDir, dir]);
  else { mkdirSync(dir, { recursive: true }); gitc(dir, ["init", "-q", "-b", "main"]); }
  const name = slug.split("/")[1];
  const commit = (files, message, date) => { for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), t); } gitc(dir, ["add", "-A"]); gitc(dir, ["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }); return gitc(dir, ["rev-parse", "HEAD"]); };
  if (!fromDir) commit({ "package.json": JSON.stringify({ name, version: "1.0.0", license: "MIT", type: "module", scripts: { test: "node --test" } }), LICENSE: MIT, "index.js": `// ${slug}\nexport const v = 0;\n`, "test/a.test.js": "import { test } from \"node:test\";\n" }, "Initial import", "2025-01-01T00:00:00Z");
  else commit({ "package.json": JSON.stringify({ name, version: "1.0.0", license: "MIT", type: "module", scripts: { test: "node --test" } }) }, "Rename the forked package for its new home", "2025-06-01T00:00:00Z");
  const sha = commit({ "index.js": `// ${slug}\n${LIB(prefix)}`, "test/a.test.js": TEST(prefix, `// ${slug}\n`) }, "Add an arithmetic expression tokenizer and evaluator", fromDir ? "2026-05-01T00:00:00Z" : "2026-04-01T00:00:00Z");
  return { slug, url: dir, npm: { name }, sha, dir };
}

test("supply: a renamed lexical copy in another family and a fork (shared root commit) are rejected; same-family overlap is left to the family rules", async () => {
  const root = tempDir();
  try {
    assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
    const a = repo(root, "alpha/calc", "calc");
    const copy = repo(root, "beta/arith", "arith"); // same code, every identifier renamed
    const pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    const pool = join(root, "pool");
    const s1 = await collect({ pool, cfg: CFG, repos: [a, copy], orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate });
    assert.equal(s1.eligible.length, 1, JSON.stringify(s1));
    assert.equal(s1.caseRejects["near-duplicate-of-other-family-task"], 1);
    // Lineage: the accepted case records its repository root commit (complete history); the registry holds commit ids only.
    const eligible = [...poolState(pool).cases.values()].find(r => r.status === "eligible");
    assert.equal(eligible.rootCommits.length, 1);
    assert.equal(lineageOf(join(pool, "cache", "repos", "alpha__calc.git"), a.sha).complete, true);
    // A fork of alpha/calc under another account, with its own new code: shares the root commit -> rejected as lineage overlap.
    const fork = repo(root, "gamma/calc-fork", "forked", { fromDir: a.dir });
    const s2 = await collect({ pool, cfg: CFG, repos: [fork], orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate });
    assert.equal(s2.eligible.length, 0, JSON.stringify(s2));
    const rec = registryOf(pool).records().filter(r => r.type === "case" && r.repo === "gamma/calc-fork").at(-1);
    assert.ok(rec.overlap.includes("lineage-shared-with-other-repository"), JSON.stringify(rec));
    // A shallow clone's roots are cut-off points: lineage unknown, never "independent".
    const shallow = join(root, "shallow");
    gitc(root, ["clone", "-q", "--depth", "1", `file://${a.dir}`, shallow]);
    assert.equal(lineageOf(shallow, "HEAD").complete, false);
    // Same family is not compared lexically (the family rules govern it).
    const corpus = knownCorpus({ orcheDir: fakeOrche(root), packageDir: pkgDir, pool });
    const caseDir = join(pool, "cases", eligible.caseId);
    assert.deepEqual(crossFamilyOverlap(caseDir, eligible.family, corpus), []);
    assert.ok(codeShingles(caseDir).size >= CFG.dedupe.minShingles);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Sealed batch directory in a pool with its registry record; tasks = [[id, family, tier, extra?]]. */
function batch(pool, name, tasks, { purpose } = {}) {
  const dir = join(pool, "batches", name);
  for (const [id, family, tier, extra = {}] of tasks) {
    mkdirSync(join(dir, id, "repo"), { recursive: true });
    writeFileSync(join(dir, id, "repo", "index.js"), `export const id = "${id}";\n`);
    writeFileSync(join(dir, id, "task.json"), JSON.stringify({ id, family, tier, instruction: `Solve ${id}`, provenance: "external", ...extra }));
    if (extra.review?.document?.startsWith("review/")) { mkdirSync(join(dir, id, "review"), { recursive: true }); writeFileSync(join(dir, id, extra.review.document), REVIEW_DOC); }
  }
  if (purpose) writeFileSync(join(dir, "PROVENANCE.json"), JSON.stringify({ purpose }));
  const seal = sealOf(dir);
  writeFileSync(join(dir, "SEAL.json"), JSON.stringify({ ...seal }));
  registryOf(pool).append({ type: "batch", batch: name, dir: `batches/${name}`, tasks: tasks.map(t => t[0]), sealDigest: seal.digest, coverage: {}, ...(purpose ? { purpose } : {}) });
  return dir;
}
const six = (p, fams) => fams.map((f, i) => [`${p}${i}`, f, i === 0 ? "hard" : "easy"]);

test("eligibility boundary: account concentration and prior-family reuse are re-checked for pool and direct holdouts (a batch is never its own prior); calibration sets are never holdouts", () => {
  const root = tempDir();
  try {
    const pool = join(root, "pool");
    const protocol = structuredClone(DEFAULT_PROTOCOL);
    protocol.holdout.priorFamilyReuse = "forbid";
    const orche = fakeOrche(root);
    const used = batch(pool, "b1", six("u", ["gh:a/x", "gh:b/x", "gh:c/x", "gh:d/x", "gh:e/x", "gh:f/x"]));
    new Ledger(join(used, "USES.jsonl")).append({ type: "use", stateDir: "/earlier" });
    const overlapping = batch(pool, "b2", six("o", ["gh:a/x", "gh:g/x", "gh:h/x", "gh:i/x", "gh:j/x", "gh:k/x"]));
    const fresh = batch(pool, "b3", six("f", ["gh:l/x", "gh:m/x", "gh:n/x", "gh:o/x", "gh:p/x", "gh:q/x"]));
    const concentrated = batch(pool, "b4", six("c", ["gh:z/1", "gh:z/2", "gh:z/3", "gh:z/4", "gh:r/x", "gh:s/x"]));
    const calib = batch(pool, "b5", six("k", ["gh:t/x", "gh:u/x", "gh:v/x", "gh:w/x", "gh:y/x", "gh:aa/x"]), { purpose: "calibration" });
    assert.equal(datasetPurpose(calib), "calibration"); assert.equal(datasetPurpose(fresh), "holdout");
    assert.match(batchEligibility(overlapping, protocol, { orcheDir: orche, pool }).reasons.join(" "), /families of earlier holdouts reused: gh:a\/x/);
    const ok = batchEligibility(fresh, protocol, { orcheDir: orche, pool });
    assert.equal(ok.ok, true, ok.reasons.join("; "));
    assert.match(batchEligibility(concentrated, protocol, { orcheDir: orche, pool }).reasons.join(" "), /account concentration: z holds 4\/6/);
    assert.match(batchEligibility(calib, protocol, { orcheDir: orche, pool }).reasons.join(" "), /purpose is calibration/);
    // The used batch is not its own prior (only its use makes it ineligible); calibration families count as prior.
    const priorOfUsed = priorHoldoutFamilies({ pool, exclude: used, packageDir: join(root, "nopkg") });
    assert.equal(priorOfUsed.has("gh:a/x"), false); assert.equal(priorOfUsed.has("gh:t/x"), true);
    // Direct dataset (no pool): unknown prior families fail closed under "forbid".
    const tasks = loadLocal(fresh);
    assert.match(holdoutStatus(tasks, fresh, protocol, { orcheDir: orche }).why, /families of earlier holdouts unknown/);
    assert.equal(holdoutStatus(tasks, fresh, structuredClone(DEFAULT_PROTOCOL), { orcheDir: orche }).independent, true, "allow (default) does not need prior families");
    assert.match(holdoutStatus(tasks, fresh, protocol, { orcheDir: orche }).exposureNote, /not established/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const ALL_CHECKS = ["instruction-sufficient", "tests-match-instruction", "reference-passes-hidden", "not-published", "no-public-source-copy"];
const REVIEW_DOC = "Review of the task: instruction, hidden tests and reference checked.\n";
const review = (over = {}) => ({
  provenance: "private-reviewed", testProvenance: "independent-author",
  authorship: { problemAuthor: "author-1", testAuthor: "tester-1", referenceAuthor: "author-1", kinds: { problemAuthor: "human", testAuthor: "human", referenceAuthor: "human" } },
  exposure: { published: false, authoredAt: "2026-10-01T00:00:00Z", tier: "low" },
  review: { reviewers: [{ id: "reviewer-1", kind: "human", at: "2026-10-05T00:00:00Z", verdict: "accept", checked: ALL_CHECKS }], checked: ["instruction-sufficient", "tests-match-instruction", "reference-passes-hidden", "not-published", "no-public-source-copy"], document: "review/r1.md", documentSha256: sha256(REVIEW_DOC) },
  ...over,
});

test("low-exposure tier: only complete review records with independent test provenance are taken in; public tasks are never relabelled; missing evidence keeps them out of a holdout", async () => {
  const root = tempDir();
  try {
    assert.deepEqual(reviewProblems({ ...review(), family: "private:op/x" }), []);
    assert.match(reviewProblems(review()).join(" "), /family must be private:<accountable author>/);
    assert.match(reviewProblems(review({ authorship: { problemAuthor: "a", testAuthor: "a", referenceAuthor: "a" } })).join(" "), /same author/);
    assert.match(reviewProblems(review({ review: { ...review().review, reviewers: [{ id: "author-1", kind: "human", at: "2026-10-05T00:00:00Z", verdict: "accept", checked: ALL_CHECKS }] } })).join(" "), /also an author/);
    assert.match(reviewProblems(review({ exposure: { published: true, authoredAt: "2026-10-01T00:00:00Z" } })).join(" "), /unpublished/);
    assert.match(reviewProblems(review({ review: { ...review().review, checked: ["instruction-sufficient"] } })).join(" "), /lacks/);
    assert.match(reviewProblems(review({ review: { ...review().review, reviewers: [{ id: "r", kind: "human", at: "2026-09-01T00:00:00Z", verdict: "accept", checked: ALL_CHECKS }] } })).join(" "), /before the task was authored/);
    const src = join(root, "authored");
    const mk = (id, fields) => { const d = join(src, id), v = id.replace(/-/g, "_"); for (const p of ["repo", "hidden", "reference"]) mkdirSync(join(d, p), { recursive: true }); writeFileSync(join(d, "repo", "index.js"), `export const ${v} = 0;\n`); writeFileSync(join(d, "hidden", "a.test.js"), `// ${id}\n`); writeFileSync(join(d, "reference", "index.js"), `export const ${v} = 1;\n`); mkdirSync(join(d, "review"), { recursive: true }); writeFileSync(join(d, "review", "r1.md"), REVIEW_DOC); writeFileSync(join(d, "task.json"), JSON.stringify({ id, family: `private:op/${id}`, tier: "hard", instruction: `Implement ${id}`, ...fields })); };
    mk("p-good", review());
    mk("p-same-author", review({ authorship: { problemAuthor: "a", testAuthor: "a", referenceAuthor: "a" } }));
    mk("p-public", review({ upstream: { repository: "https://github.com/x/y" } }));
    mk("p-external", review({ provenance: "external" }));
    const pool = join(root, "pool");
    const s = await intakePrivate({ pool, src, orcheDir: fakeOrche(root), packageDir: join(root, "pkg"), validate: okValidate });
    assert.deepEqual(s.eligible.map(e => e.id), ["p-good"]);
    assert.equal(s.rejected["review-record-incomplete"], 1); assert.equal(s.rejected["public-source-task-cannot-be-private"], 1); assert.equal(s.rejected["provenance-not-private-reviewed"], 1);
    const rec = [...poolState(pool).cases.values()].find(r => r.caseId === "p-good");
    assert.equal(rec.source, "private-reviewed"); assert.equal(rec.status, "eligible");
    // In a holdout: accepted only when the protocol accepts the provenance AND the review record is complete.
    const protocol = structuredClone(DEFAULT_PROTOCOL); protocol.holdout.acceptedProvenance = ["external", "private-reviewed"];
    const bdir = batch(join(root, "dspool"), "bp", [["p1", "private:o/p1", "hard", review()], ["p2", "private:o/p2", "easy", review({ review: { ...review().review, document: "" } })]]);
    const st = holdoutStatus(loadLocal(bdir), bdir, protocol, { orcheDir: fakeOrche(root) });
    assert.equal(st.independent, false); assert.match(st.why, /p2 \(review.document/);
    assert.match(holdoutStatus(loadLocal(bdir), bdir, structuredClone(DEFAULT_PROTOCOL), { orcheDir: fakeOrche(root) }).why, /provenance not accepted/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A runner ledger (evaluator runs.jsonl shape) of real-looking results of `harness` for `outcomes` (task -> 0/1 per repeat). */
export function calibrationLedger(path, outcomes, { harness = "stable", commit = "c0ffee", context = "calibration", simulated = false } = {}) {
  const l = new Ledger(path);
  for (const [task, xs] of Object.entries(outcomes)) xs.forEach((x, repeat) => l.append({ type: "result", unit_key: `${task}#${repeat}`, record: { candidate_id: harness, harness_commit: commit, context, task_id: task, repeat, attempt: 1, terminal_status: "completed", hidden_test_pass: x === 1, visible_test_pass: true, integrity: { violations: [] }, critical_failure_count: 0, model_requests_completed: 3, simulated } }));
  return path;
}

test("difficulty calibration: measured on a separate calibration set only; a calibrated basis is verified (sha256, disjoint tasks and families, rule, re-derived from the runner ledger) or blocks", () => {
  const root = tempDir();
  try {
    const pool = join(root, "pool");
    const calib = batch(pool, "bc", [["c1", "gh:c/1", "hard", { difficultySource: { value: 9 } }], ["c2", "gh:c/2", "hard", { difficultySource: { value: 9 } }], ["c3", "gh:c/3", "easy", { difficultySource: { value: 3 } }], ["c4", "gh:c/4", "easy", { difficultySource: { value: 3 } }]], { purpose: "calibration" });
    const feature = "source-difficulty-value";
    const outcomes = { c1: [0, 0, 1], c2: [0, 0, 0], c3: [1, 1, 1], c4: [1, 0, 1] };
    const ledger = calibrationLedger(join(root, "runs.jsonl"), outcomes);
    const measuredWith = { kind: "runner-ledger", ledger, harnessId: "stable", harnessCommit: "c0ffee", context: "calibration", repeats: 3 };
    assert.deepEqual(outcomesFromLedger(ledger, { harnessId: "stable", context: "calibration", repeats: 3, tasks: ["c1", "c2", "c3", "c4"] }), outcomes);
    const report = buildCalibrationReport({ batchDir: calib, outcomes, feature, hardMaxRate: 0.4, minTasksPerLevel: 2, measuredWith, censoring: CENSORING_V2, minValidUnitsPerTask: 2 });
    assert.deepEqual(report.rule.hardLevels, ["9"]);
    assert.deepEqual(verifyCalibrationReport(report), []);
    // A report that does not censor integrity failures cannot certify a hard level (2026-11-07).
    const v1 = buildCalibrationReport({ batchDir: calib, outcomes, feature, hardMaxRate: 0.4, minTasksPerLevel: 2, measuredWith });
    assert.match(verifyCalibrationReport(v1).join(" "), /integrity failures never certify difficulty/);
    assert.throws(() => buildCalibrationReport({ batchDir: calib, outcomes: { c1: [0] }, feature, hardMaxRate: 0.4, minTasksPerLevel: 2, measuredWith }), /no measured outcomes/);
    assert.throws(() => buildCalibrationReport({ batchDir: calib, outcomes: { ...outcomes, c1: [0.5, 0, 1] }, feature, hardMaxRate: 0.4, minTasksPerLevel: 2, measuredWith }), /0\/1/);
    assert.throws(() => buildCalibrationReport({ batchDir: calib, outcomes, feature, hardMaxRate: 0.4, minTasksPerLevel: 2, measuredWith: { note: "x" } }), /measuredWith.kind/);
    const holdoutBatch = batch(pool, "bh", [["h1", "gh:h/1", "hard"]]);
    assert.throws(() => buildCalibrationReport({ batchDir: holdoutBatch, outcomes: { h1: [0] }, feature, hardMaxRate: 0.4, minTasksPerLevel: 1, measuredWith }), /not a calibration-purpose set/);
    const reportPath = join(root, "calibration.json");
    writeFileSync(reportPath, JSON.stringify(report));
    const sha = sha256(readFileSync(reportPath));
    const task = (id, family, level, s = sha, path = reportPath) => ({ id, family, difficultyBasis: "calibrated", difficultyCalibration: { report: path, reportSha256: s, level } });
    assert.deepEqual(calibrationProblems(task("n1", "gh:n/1", "9"), root), []);
    assert.match(calibrationProblems(task("c1", "gh:n/1", "9"), root).join(" "), /itself in the calibration set/);
    assert.match(calibrationProblems(task("n2", "gh:c/1", "9"), root).join(" "), /family was in the calibration set/);
    assert.match(calibrationProblems(task("n3", "gh:n/3", "3"), root).join(" "), /does not make level 3 hard/);
    assert.match(calibrationProblems(task("n4", "gh:n/4", "9", "b".repeat(64)), root).join(" "), /changed/);
    // Fail-open gaps closed: a hand-supplied (fixture) report, a forged hard level, simulated records, a changed ledger.
    const fixture = buildCalibrationReport({ batchDir: calib, outcomes, feature, hardMaxRate: 0.4, minTasksPerLevel: 2, measuredWith: { kind: "fixture", note: "hand-typed" } });
    const write = (name, r) => { const p = join(root, name); writeFileSync(p, JSON.stringify(r)); return [p, sha256(readFileSync(p))]; };
    { const [p, s] = write("fixture.json", fixture); assert.match(calibrationProblems(task("n5", "gh:n/5", "9", s, p), root).join(" "), /not from a runner ledger/); }
    { const [p, s] = write("forged.json", { ...report, rule: { ...report.rule, hardLevels: ["3", "9"] } }); assert.match(calibrationProblems(task("n6", "gh:n/6", "3", s, p), root).join(" "), /hard levels do not follow/); }
    { const [p, s] = write("forged-levels.json", { ...report, levels: { ...report.levels, 3: { tasks: 2, meanRate: 0.1 } } }); assert.match(calibrationProblems(task("n6b", "gh:n/6", "9", s, p), root).join(" "), /levels differ/); }
    const simLedger = calibrationLedger(join(root, "sim.jsonl"), outcomes, { simulated: true });
    { const [p, s] = write("sim.json", { ...report, measuredWith: { ...measuredWith, ledger: simLedger, ledgerSha256: sha256(readFileSync(simLedger)) } }); assert.match(calibrationProblems(task("n7", "gh:n/7", "9", s, p), root).join(" "), /simulated record/); }
    const other = calibrationLedger(join(root, "other.jsonl"), { ...outcomes, c3: [0, 0, 0] });
    { const [p, s] = write("swapped.json", { ...report, measuredWith: { ...measuredWith, ledger: other, ledgerSha256: sha256(readFileSync(other)) } }); assert.match(calibrationProblems(task("n8", "gh:n/8", "9", s, p), root).join(" "), /outcomes differ/); }
    writeFileSync(ledger, `${readFileSync(ledger, "utf8")}\n`);
    assert.match(verifyCalibrationReport(report).join(" "), /ledger changed/);
    assert.equal(difficultyBasisOf({ tier: "hard", difficultyBasis: "calibrated" }), "calibrated-unverified");
    assert.equal(difficultyBasisOf({ tier: "hard", difficultyBasis: "calibrated", difficultyCalibration: { report: "r.json", reportSha256: sha, level: "9" } }), "calibrated");
    // A holdout task claiming a calibration it cannot back blocks the holdout (fail closed).
    const bad = batch(join(root, "p2"), "bx", [["x1", "gh:x/1", "hard", { difficultyBasis: "calibrated", difficultyCalibration: { report: reportPath, reportSha256: sha, level: "3" } }]]);
    const protocol = structuredClone(DEFAULT_PROTOCOL); protocol.holdout.hardBasis = ["calibrated"]; protocol.holdout.minTasks = 1; protocol.holdout.minFamilies = 1; protocol.holdout.maxOwnerShare = 1;
    assert.match(holdoutStatus(loadLocal(bad), bad, protocol, { orcheDir: fakeOrche(root) }).why, /calibrated difficulty not verifiable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("supply CLI: intake-private and --purpose are wired; misuse is a usage error; a calibration batch seals without a hard stratum", async () => {
  const root = tempDir();
  try {
    const write = process.stderr.write;
    process.stderr.write = () => true;
    try {
      assert.equal(await supplyMain(["intake-private", "--pool", join(root, "pool")]), 64);
      assert.equal(await supplyMain(["status", "--pool", join(root, "pool"), "--purpose", "calibration"]), 64);
      assert.equal(await supplyMain(["seal", "--pool", join(root, "pool"), "--purpose", "practice"]), 64);
    } finally { process.stderr.write = write; }
    const pool = join(root, "pool2");
    const pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    const a = repo(root, "alpha/calc", "calc");
    await collect({ pool, cfg: CFG, repos: [a], orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate });
    const sealed = sealBatch({ pool, cfg: mergeSupply({ ...CFG, batch: { ...CFG.batch, maxOwnerShare: 1 } }), minima: { minTasks: 1, minFamilies: 1, requireHard: false, hardBasis: [] }, purpose: "calibration" }); // a one-task set is one account
    assert.ok(sealed.batch, JSON.stringify(sealed));
    assert.equal(datasetPurpose(sealed.dir), "calibration");
    assert.equal(registryOf(pool).records().find(r => r.type === "batch").purpose, "calibration");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
