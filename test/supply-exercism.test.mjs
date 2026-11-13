// Exercism source of the holdout supply (src/supply-exercism.mjs). Everything is synthetic and local: the "track", "docs" and
// "benchmark" repositories are temporary git repositories and `expect` is a small stand-in package, so none of these tasks is an
// eligible holdout. No network, no model. The sandbox test runs only where bubblewrap exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rmSync, tempDir } from "./helpers.mjs";
import { batchEligibility, mergeSupply, poolState, registryOf, sealBatch, selectBatch, validateCase } from "../src/supply.mjs";
import { BRIDGE, collectExercism, exerciseSourceKey, specUnsupported, tierOfDifficulty, vendorManifest, verifyRubric } from "../src/supply-exercism.mjs";
import { difficultyBasisOf, holdoutHard, loadLocal, verifySeal } from "../src/datasets.mjs";
import { DEFAULT_PROTOCOL } from "../src/protocol.mjs";

const MIT = "MIT License\n\nCopyright (c) 2021 Exercism\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...\n";
const RUBRIC = "# config.json\n\n- `difficulty`: a number from 1 (easiest) to 10 (hardest). The website interprets the difficulty as follows:\n  - 1,2,3: easy\n  - 4,5,6,7: medium\n  - 8,9,10: hard\n";
const SPEC = `import { beforeEach, describe, expect, test, xtest } from '@jest/globals';
import { Acc } from './alpha';

describe('Acc', () => {
  let acc;
  beforeEach(() => {
    acc = new Acc();
  });
  test('starts at zero', () => {
    expect(acc.total).toEqual(0);
  });
  describe('adding', () => {
    xtest('adds values', () => {
      acc.add(2);
      acc.add(3);
      expect(acc.total).toEqual(5);
    });
    xtest('rejects negative values', () => {
      expect(() => acc.add(-1)).toThrow('negative');
    });
  });
});
`;
const STUB = "export class Acc {\n  constructor() {\n    throw new Error('Remove this line and implement the function');\n  }\n}\n";
const PROOF = "import { ZERO } from '../alpha-helper';\n\nexport class Acc {\n  constructor() {\n    this.total = ZERO;\n  }\n  add(n) {\n    if (n < 0) throw new Error('negative');\n    this.total += n;\n  }\n}\n";
const HELPER = "export const ZERO = 0;\n";

function gitc(dir, args, env = {}) { return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "M", GIT_AUTHOR_EMAIL: "m@example.org", GIT_COMMITTER_NAME: "M", GIT_COMMITTER_EMAIL: "m@example.org", ...env } }).toString().trim(); }
function repo(root, slug, files) {
  const dir = join(root, "up", slug.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  gitc(dir, ["init", "-q", "-b", "main"]);
  commit(dir, files, "initial");
  return { slug, url: dir, dir };
}
function commit(dir, files, message) {
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), t); }
  gitc(dir, ["add", "-A"]); gitc(dir, ["commit", "-q", "-m", message]);
}
const exercise = (slug, { spec = SPEC, stub = STUB, proof = PROOF, extra = {} } = {}) => ({
  [`exercises/practice/${slug}/.meta/config.json`]: JSON.stringify({ authors: ["someone"], files: { solution: ["alpha.js"], test: ["alpha.spec.js"], example: [".meta/proof.ci.js"] } }),
  [`exercises/practice/${slug}/.meta/proof.ci.js`]: proof,
  [`exercises/practice/${slug}/.docs/instructions.md`]: `# Instructions\n\nKeep a running total (${slug}).\n`,
  [`exercises/practice/${slug}/alpha.js`]: stub,
  [`exercises/practice/${slug}/alpha-helper.js`]: HELPER,
  [`exercises/practice/${slug}/alpha.spec.js`]: spec,
  [`exercises/practice/${slug}/package.json`]: JSON.stringify({ name: `@exercism/javascript-${slug}`, private: true, license: "MIT", devDependencies: { jest: "^30" } }),
  [`exercises/practice/${slug}/LICENSE`]: MIT,
  ...extra,
});
const PRACTICE = [{ slug: "alpha", uuid: "u-alpha", difficulty: 8 }, { slug: "beta", uuid: "u-beta", difficulty: 9 }, { slug: "gamma", uuid: "u-gamma", difficulty: 10 }, { slug: "delta", uuid: "u-delta", difficulty: 5 }, { slug: "eps", uuid: "u-eps", difficulty: 9, status: "deprecated" }];
function fixture(root, { rubric = RUBRIC, alpha = {} } = {}) {
  const track = repo(root, "exercism/javascript", {
    "package.json": JSON.stringify({ name: "@exercism/javascript", private: true, license: "MIT" }), LICENSE: MIT,
    "config.json": JSON.stringify({ exercises: { practice: PRACTICE } }),
    ...exercise("alpha", alpha), ...exercise("beta"), ...exercise("gamma", { spec: SPEC.replace("xtest('adds values'", "test.each([[1]])('adds values'") }), ...exercise("delta"),
  });
  const docs = repo(root, "exercism/docs", { "building/tracks/config-json.md": rubric });
  const bench = repo(root, "aider-ai/polyglot-benchmark", { "javascript/exercises/practice/beta/.keep": "" });
  return { track, docs, bench, repos: { track, docs, exclusions: [bench] } };
}
/** Stand-in for the vendored `expect`: a CJS package with the matchers the synthetic spec uses. */
function fakeVendor(root, { license = "MIT" } = {}) {
  const dir = join(root, "vendor");
  const nm = join(dir, "node_modules");
  mkdirSync(join(nm, "expect"), { recursive: true }); mkdirSync(join(nm, "dep-a"), { recursive: true });
  writeFileSync(join(nm, "expect/package.json"), JSON.stringify({ name: "expect", version: "30.3.0", license: "MIT", main: "index.js" }));
  writeFileSync(join(nm, "expect/index.js"), "const assert = require('node:assert/strict');\nexports.expect = (a) => ({ toEqual: (e) => assert.deepStrictEqual(a, e), toThrow: (m) => assert.throws(a, { message: m }) });\n");
  writeFileSync(join(nm, "dep-a/package.json"), JSON.stringify({ name: "dep-a", version: "1.0.0", license }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/expect": { version: "30.3.0", integrity: "sha512-x" }, "node_modules/dep-a": { version: "1.0.0", integrity: "sha512-y" } } }));
  return dir;
}
const CFG = mergeSupply({ validation: { repeats: 1, timeoutMs: 60_000 }, batch: { maxTasks: 12, maxPerFamily: 2, maxPerOwner: 4, seed: "test" } });
function fakeOrche(root, mentions = []) { const o = join(root, "orche"); mkdirSync(join(o, "experiments/x"), { recursive: true }); writeFileSync(join(o, "experiments/x/plan.md"), `notes: ${mentions.join(", ")}\n`); return o; }
const okValidate = (seen = []) => async (dir, opts) => { seen.push(opts); return { ok: true, code: "valid", expected: { hiddenTests: 3 }, detail: {} }; };

test("exercism: maintainer difficulty 8-10 -> source-backed hard; benchmark-listed and unsupported specs rejected; nothing invented", async () => {
  const root = tempDir();
  try {
    const f = fixture(root);
    const vendorDir = fakeVendor(root);
    const vendor = { dir: vendorDir, manifest: vendorManifest(vendorDir, "30.3.0", CFG.licenses) };
    const pool = join(root, "pool"), pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    const seen = [];
    const s = await collectExercism({ pool, cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(seen), repos: f.repos, vendor });
    assert.equal(s.candidates, 3, "hard only: alpha 8, beta 9, gamma 10 (delta medium and the deprecated exercise are not candidates)");
    assert.deepEqual(s.eligible.map(e => e.id), ["x-exercism-javascript-alpha"]);
    assert.deepEqual(s.caseRejects, { "listed-in-public-benchmark": 1, "unsupported-jest-feature": 1 });
    assert.deepEqual(seen, [{ visibleSuite: "none" }], "only the adapter's own case uses the empty-visible-suite mode");
    const dir = join(pool, "cases", "x-exercism-javascript-alpha");
    const t = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
    const rev = gitc(f.track.dir, ["rev-parse", "HEAD"]), docsRev = gitc(f.docs.dir, ["rev-parse", "HEAD"]);
    // Difficulty: the maintainers' value and the documented rubric, both pinned to their revisions; accepted as "source".
    assert.equal(t.tier, "hard"); assert.equal(t.difficultyBasis, "source");
    assert.equal(t.difficultySource.value, 8); assert.equal(t.difficultySource.commit, rev); assert.equal(t.difficultySource.uuid, "u-alpha");
    assert.equal(t.difficultySource.rubric.commit, docsRev); assert.equal(t.difficultySource.rubric.hardLine, "- 8,9,10: hard");
    assert.equal(difficultyBasisOf(t), "source");
    assert.equal(holdoutHard({ hard: true, difficultyBasis: difficultyBasisOf(t) }, DEFAULT_PROTOCOL), true);
    // Adaptation: the student's directory without .meta; the spec byte-identical; the maintainers' proof as the reference.
    assert.equal(existsSync(join(dir, "repo/.meta")), false);
    assert.equal(readFileSync(join(dir, "repo/alpha.js"), "utf8"), STUB);
    assert.equal(readFileSync(join(dir, "repo/alpha.spec.js"), "utf8"), SPEC, "tests stay visible as on Exercism");
    assert.equal(readFileSync(join(dir, "hidden/alpha.upstream-spec.js"), "utf8"), SPEC);
    assert.equal(readFileSync(join(dir, "hidden/alpha.holdout.test.mjs"), "utf8"), BRIDGE("alpha.upstream-spec.js"));
    assert.equal(readFileSync(join(dir, "reference/alpha.js"), "utf8"), PROOF.replace("from '../", "from './"));
    assert.deepEqual(t.upstream.adaptation.referenceRewrite.files, ["alpha.js"]);
    assert.ok(existsSync(join(dir, "hidden/.holdout-harness/node_modules/expect/index.js")));
    assert.equal(existsSync(join(dir, "hidden/.holdout-harness/node_modules/.bin")), false);
    assert.equal(JSON.parse(readFileSync(join(dir, "hidden/.holdout-harness/VENDOR.json"), "utf8")).packages.find(p => p.name === "dep-a").integrity, "sha512-y");
    assert.match(t.instruction, /Keep a running total \(alpha\)\./);
    assert.equal(t.provenance, "external"); assert.equal(t.family, "gh:exercism/javascript"); assert.equal(t.upstream.license.spdx, "MIT");
    assert.deepEqual(t.upstream.exclusions.map(x => x.name), ["aider-polyglot-benchmark"]);
    // The registry holds codes and keys only (no spec or solution text); the chain is intact.
    const reg = readFileSync(join(pool, "registry.jsonl"), "utf8");
    assert.doesNotMatch(reg + JSON.stringify(s), /toEqual|this\.total|running total/);
    assert.deepEqual(poolState(pool).chain, []);
    // Taken once per pool across track revisions (a later revision does not bring the same exercise back) ...
    commit(f.track.dir, { "exercises/practice/alpha/.docs/instructions.md": "# Instructions\n\nchanged\n" }, "docs");
    const again = await collectExercism({ pool, cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(), repos: f.repos, vendor });
    assert.equal(again.eligible.length, 0); assert.equal(again.caseRejects["exercise-seen-in-supply"], 3);
    // ... but sharing one repository revision does not make the exercises duplicates of each other.
    assert.equal(registryOf(pool).records().filter(r => r.type === "case" && r.sourceKey === exerciseSourceKey("exercism/javascript", "alpha")).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exercism: exposure checks apply (named in earlier experiments); no rubric -> no source tiers; vendor licenses are checked", async () => {
  const root = tempDir();
  try {
    const f = fixture(root);
    const vendorDir = fakeVendor(root);
    const vendor = { dir: vendorDir, manifest: vendorManifest(vendorDir, "30.3.0", CFG.licenses) };
    const pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    const named = await collectExercism({ pool: join(root, "p1"), cfg: CFG, orcheDir: fakeOrche(root, ["exercism/javascript/exercises/practice/alpha"]), packageDir: pkgDir, validate: okValidate(), repos: f.repos, vendor });
    assert.equal(named.eligible.length, 0); assert.equal(named.caseRejects["named-in-earlier-experiments"], 1);
    const g = fixture(join(root, "g"), { rubric: "# config.json\n\n- `difficulty`: 1 to 10\n" });
    await assert.rejects(collectExercism({ pool: join(root, "p2"), cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(), repos: g.repos, vendor }), /rubric: no "easy" mapping/);
    assert.throws(() => vendorManifest(fakeVendor(join(root, "gpl"), { license: "GPL-3.0" }), "30.3.0", CFG.licenses), /dep-a@1\.0\.0: license GPL-3\.0 not accepted/);
    assert.throws(() => vendorManifest(vendorDir, "30.2.0", CFG.licenses), /vendored expect is 30\.3\.0/);
    assert.equal(verifyRubric({ dir: f.docs.dir, headSha: gitc(f.docs.dir, ["rev-parse", "HEAD"]) }, { slug: "exercism/docs", path: "building/tracks/config-json.md" }).mapping.hard, "8,9,10");
    assert.deepEqual([1, 3, 4, 7, 8, 10, 0, 11].map(tierOfDifficulty), ["easy", "easy", "medium", "medium", "hard", "hard", null, null]);
    assert.equal(specUnsupported(SPEC), null);
    for (const bad of ["jest.useFakeTimers();", "test.only('x', () => {});", "expect.assertions(1);", "expect(x).toMatchSnapshot();", "describe.each([1])('x', () => {});"]) assert.equal(specUnsupported(`${SPEC}\n${bad}\n`), "unsupported-jest-feature", bad);
    assert.equal(specUnsupported(SPEC.replace("'./alpha'", "'lodash'")), "unsupported-spec-import");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("difficulty: a source basis needs a substantive annotation; a pool with one exercism hard case seals an eligible batch; sealing reserves nothing", async () => {
  const root = tempDir();
  try {
    assert.equal(difficultyBasisOf({ tier: "hard", difficultyBasis: "source" }), "source-unannotated");
    assert.equal(difficultyBasisOf({ tier: "hard", difficultyBasis: "source", difficultySource: {} }), "source-unannotated");
    assert.equal(difficultyBasisOf({ tier: "hard", difficultyBasis: "source", difficultySource: { dataset: "d", value: 8, commit: "abc", tier: "medium" } }), "source-unannotated", "annotation tier must match");
    assert.equal(difficultyBasisOf({ tier: "hard", difficultyBasis: "source", difficultySource: { dataset: "d", value: 8, commit: "abc", tier: "hard" } }), "source");
    assert.equal(holdoutHard({ hard: true, difficultyBasis: "source-unannotated" }, DEFAULT_PROTOCOL), false);
    // Selection: the exercism hard case leads, the owner cap still binds the dominant account.
    const pool = [...["a", "b", "c", "d", "e"].map((x, i) => ({ caseId: `s${x}`, family: `gh:sindre/${x}`, tier: i === 4 ? "hard" : "easy", difficultyBasis: "size-proxy" })), { caseId: "x1", family: "gh:exercism/javascript", tier: "hard", difficultyBasis: "source" }, { caseId: "x2", family: "gh:exercism/javascript", tier: "hard", difficultyBasis: "source" }];
    const hb = { minTasks: 6, minFamilies: 4, requireHard: true, hardBasis: DEFAULT_PROTOCOL.holdout.hardBasis };
    const loose = mergeSupply({ ...CFG, batch: { ...CFG.batch, maxOwnerShare: 1 } });
    const sel = selectBatch(pool, loose, hb);
    assert.equal(sel.ok, true, sel.why);
    assert.equal(sel.coverage.tasks, 6); assert.equal(sel.coverage.hard, 2); assert.equal(sel.coverage.owners, 2); assert.ok(sel.coverage.families >= 4);
    assert.equal(sel.ids.filter(id => id.startsWith("s")).length, 4, "maxPerOwner 4");
    // The 2026-11-05 composition (4/6 from one account) no longer seals under the default share cap; two more accounts do.
    assert.equal(selectBatch(pool, CFG, hb).ok, false);
    const wider = selectBatch([...pool, { caseId: "o1", family: "gh:other1/a", tier: "easy" }, { caseId: "o2", family: "gh:other2/b", tier: "easy" }], CFG, hb);
    assert.equal(wider.ok, true, wider.why); assert.ok(wider.coverage.maxOwnerShare <= 0.5); assert.ok(wider.coverage.hard >= 1);
    // Seal through the supported lifecycle: collect the exercism case into a pool that already holds a sealed batch.
    const f = fixture(root);
    const vendorDir = fakeVendor(root);
    const vendor = { dir: vendorDir, manifest: vendorManifest(vendorDir, "30.3.0", CFG.licenses) };
    const pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    const p = join(root, "pool");
    await collectExercism({ pool: p, cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(), repos: f.repos, vendor });
    const minima = { minTasks: 1, minFamilies: 1, requireHard: true, hardBasis: DEFAULT_PROTOCOL.holdout.hardBasis };
    const first = sealBatch({ pool: p, cfg: loose, minima }); // a one-task test batch cannot meet a share cap below 1
    assert.equal(first.coverage.hard, 1);
    // A one-task test batch is one account by construction: the protocol-4 eligibility share cap is lifted for this check only.
    const protocol = structuredClone(DEFAULT_PROTOCOL); protocol.holdout.minTasks = 1; protocol.holdout.minFamilies = 1; protocol.holdout.maxOwnerShare = 1;
    const e = batchEligibility(first.dir, protocol, { orcheDir: fakeOrche(root) });
    assert.equal(e.ok, true, e.reasons.join("; ")); assert.deepEqual(e.coverage, { tasks: 1, families: 1, hard: 1, hardUnverified: 0, owners: 1, maxOwnerShare: 1 });
    // Under the default protocol-4 cap the same batch is ineligible at the eligibility boundary (not only at sealing).
    const capped = structuredClone(protocol); capped.holdout.maxOwnerShare = 0.5;
    assert.match(batchEligibility(first.dir, capped, { orcheDir: fakeOrche(root) }).reasons.join(" "), /account concentration: exercism holds 1\/1/);
    assert.equal(loadLocal(first.dir)[0].difficultyBasis, "source");
    const prov = JSON.parse(readFileSync(join(first.dir, "PROVENANCE.json"), "utf8"));
    assert.equal(prov.tasks[0].difficultySource.value, 8);
    assert.ok(prov.limitations.some(l => /Exercism exercises/.test(l)));
    assert.equal(verifySeal(first.dir).ok, true, "the vendored harness (node_modules included) is inside the seal");
    // Nothing reserved or used by sealing.
    assert.equal(registryOf(p).records().filter(r => r.type === "reserve").length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real grading sandbox: the unchanged spec runs under node:test; stub fails executed tests, proof passes; the empty-visible mode keeps every other check", { skip: !existsSync("/usr/bin/bwrap") && "no bubblewrap" }, async () => {
  const root = tempDir();
  try {
    const { hostEnvironment } = await import("../src/sandbox.mjs");
    const { gradeWorkspace, validateGrader } = await import("../src/grader.mjs");
    const env = hostEnvironment();
    const vendorDir = fakeVendor(root);
    const vendor = { dir: vendorDir, manifest: vendorManifest(vendorDir, "30.3.0", CFG.licenses) };
    const pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    let n = 0;
    const real = (opts) => (dir, o = {}) => validateCase(dir, { env, scratch: join(root, "scratch", String(n++)), repeats: 2, timeoutMs: 60_000, gradeWorkspace, ...o, ...opts });
    const build = async (name, alpha, opts = {}) => {
      const f = fixture(join(root, name), { alpha });
      const pool = join(root, `pool-${name}`);
      const s = await collectExercism({ pool, cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: real(opts), repos: f.repos, vendor });
      const caseDir = join(pool, "cases", "x-exercism-javascript-alpha");
      return { s, v: existsSync(join(caseDir, "validation.private.json")) ? JSON.parse(readFileSync(join(caseDir, "validation.private.json"), "utf8")) : null, caseDir };
    };
    const good = await build("good", {});
    assert.equal(good.v.ok, true, good.v.code);
    assert.deepEqual(good.v.expected, { hiddenTests: 3 }, "xtest-activated cases run too");
    assert.ok(good.v.detail.original.every(o => o.visible.tests === 0 && o.visible.pass && o.hidden.tests === 3 && o.hidden.failed === 3));
    assert.ok(good.v.detail.reference.every(r => r.hidden.pass && r.hidden.failed === 0 && r.visible.pass));
    // The engine's own grader validation agrees (reference passes hidden + visible, original fails).
    const [t] = loadLocal(join(root, "pool-good", "cases"));
    const vg = await validateGrader({ task: t, scratch: join(root, "vg"), env });
    assert.equal(vg.ok, true, vg.problems.join("; ")); assert.equal(vg.expected.hiddenTests, 3); assert.equal(vg.referenceVisiblePass, true);
    // A wrong reference fails; a stub that breaks loading fails on load, not on executed tests; a real visible suite is not ignored.
    assert.equal((await build("wrongref", { proof: PROOF.replace("this.total += n;", "this.total -= n;") })).s.caseRejects["reference-fails-hidden"], 1);
    assert.equal((await build("loadfail", { stub: "throw new Error('broken module');\n" })).s.caseRejects["original-hidden-tests-not-executed"], 1);
    const extraTest = { "exercises/practice/alpha/extra.test.js": "import { test } from 'node:test';\ntest('x', () => {});\n" };
    assert.equal((await build("visible", { extra: extraTest })).s.caseRejects["visible-suite-not-empty-or-not-passing"], 1);
    // The default (commit sources) still demands a non-empty passing visible suite.
    assert.equal((await build("required", {}, { visibleSuite: "required" })).s.caseRejects["original-visible-suite-not-passing-offline"], 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------------------ TypeScript track (2026-11-06)
const SPEC_TS = `import { beforeEach, describe, expect, test, xtest } from '@jest/globals'
import type { MatcherFunction } from 'expect'
import { Acc } from './alpha.ts'

describe('Acc', () => {
  let acc: Acc
  beforeEach(() => {
    acc = new Acc()
  })
  test('starts at zero', () => {
    expect(acc.total).toEqual(0)
  })
  xtest('adds values', () => {
    acc.add(2)
    acc.add(3)
    expect(acc.total).toEqual(5)
  })
  xtest('rejects negative values', () => {
    expect(() => acc.add(-1)).toThrow('negative')
  })
})
`;
const STUB_TS = "export class Acc {\n  total: number\n  constructor() {\n    throw new Error('Remove this line and implement the function')\n  }\n  add(n: number): void {\n    throw new Error('Remove this line and implement the function')\n  }\n}\n";
const PROOF_TS = "import { ZERO } from '../alpha-helper.ts'\n\nexport class Acc {\n  total: number\n  constructor() {\n    this.total = ZERO\n  }\n  add(n: number): void {\n    if (n < 0) throw new Error('negative')\n    this.total += n\n  }\n}\n";
const tsExercise = (slug, { spec = SPEC_TS, stub = STUB_TS, proof = PROOF_TS } = {}) => ({
  [`exercises/practice/${slug}/.meta/config.json`]: JSON.stringify({ authors: ["someone"], files: { solution: ["alpha.ts"], test: ["alpha.test.ts"], example: [".meta/proof.ci.ts"] } }),
  [`exercises/practice/${slug}/.meta/proof.ci.ts`]: proof,
  [`exercises/practice/${slug}/.docs/instructions.md`]: `# Instructions\n\nKeep a running total in TypeScript (${slug}).\n`,
  [`exercises/practice/${slug}/alpha.ts`]: stub,
  [`exercises/practice/${slug}/alpha-helper.ts`]: "export const ZERO: number = 0\n",
  [`exercises/practice/${slug}/alpha.test.ts`]: spec,
  [`exercises/practice/${slug}/test-runner.mjs`]: "#!/usr/bin/env node\nimport { execSync } from 'node:child_process'\nexecSync('corepack yarn jest', { stdio: 'inherit' })\n",
  [`exercises/practice/${slug}/tsconfig.json`]: "{}\n",
  [`exercises/practice/${slug}/package.json`]: JSON.stringify({ name: `@exercism/typescript-${slug}`, private: true, type: "module", devDependencies: { jest: "^29" } }),
});
function tsTrack(root, { practice = PRACTICE } = {}) {
  return repo(root, "exercism/typescript", {
    "package.json": JSON.stringify({ name: "@exercism/typescript-track", private: true, license: "MIT" }), LICENSE: MIT,
    "config.json": JSON.stringify({ exercises: { practice } }),
    ...tsExercise("alpha"), ...tsExercise("beta"), ...tsExercise("gamma"), ...tsExercise("delta"),
  });
}
const TS = "exercism/typescript";

test("exercism typescript: spec and proof unchanged, visible spec renamed, CLI runner left out, track LICENSE copied; separate family, same account", async () => {
  const root = tempDir();
  try {
    const f = fixture(root);
    const ts = tsTrack(root);
    const vendorDir = fakeVendor(root);
    const vendor = { dir: vendorDir, manifest: vendorManifest(vendorDir, "30.3.0", CFG.licenses) };
    const pool = join(root, "pool"), pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    const s = await collectExercism({ pool, cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(), repos: { ...f.repos, track: ts }, vendor, track: TS });
    // beta is listed for javascript (TypeScript ports are judged by the JavaScript list); alpha and gamma are eligible.
    assert.deepEqual(s.eligible.map(e => e.id), ["x-exercism-typescript-alpha", "x-exercism-typescript-gamma"]);
    assert.deepEqual(s.caseRejects, { "listed-in-public-benchmark": 1 });
    const dir = join(pool, "cases", "x-exercism-typescript-alpha");
    const t = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
    assert.equal(t.family, "gh:exercism/typescript"); assert.equal(t.tier, "hard"); assert.equal(t.difficultyBasis, "source"); assert.equal(difficultyBasisOf(t), "source");
    assert.equal(existsSync(join(dir, "repo/alpha.test.ts")), false, "Node would start *.test.ts by default");
    assert.equal(readFileSync(join(dir, "repo/alpha.upstream-spec.ts"), "utf8"), SPEC_TS, "the student still sees the unchanged spec");
    assert.equal(readFileSync(join(dir, "hidden/alpha.upstream-spec.ts"), "utf8"), SPEC_TS);
    assert.equal(readFileSync(join(dir, "hidden/alpha.holdout.test.mjs"), "utf8"), BRIDGE("alpha.upstream-spec.ts"));
    assert.equal(existsSync(join(dir, "repo/test-runner.mjs")), false);
    assert.equal(readFileSync(join(dir, "repo/LICENSE"), "utf8"), MIT);
    assert.equal(readFileSync(join(dir, "reference/alpha.ts"), "utf8"), PROOF_TS.replace("from '../", "from './"));
    assert.equal(readFileSync(join(dir, "repo/alpha.ts"), "utf8"), STUB_TS);
    assert.equal(t.upstream.license.file, "LICENSE"); assert.equal(t.upstream.license.spdx, "MIT");
    assert.match(t.upstream.adaptation.repo, /alpha\.test\.ts -> alpha\.upstream-spec\.ts/); assert.match(t.upstream.adaptation.repo, /test-runner\.mjs left out/); assert.match(t.upstream.adaptation.repo, /LICENSE = the track's root LICENSE/);
    assert.match(t.instruction, /alpha\.test\.ts is in this directory as alpha\.upstream-spec\.ts/);
    assert.equal(t.upstream.problem, "alpha");
    const rec = registryOf(pool).records().find(r => r.caseId === "x-exercism-typescript-alpha");
    assert.equal(rec.problem, "alpha"); assert.equal(rec.sourceKey, exerciseSourceKey(TS, "alpha"));
    // Unknown tracks are refused rather than guessed.
    await assert.rejects(collectExercism({ pool, cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(), repos: { ...f.repos, track: ts }, vendor, track: "exercism/python" }), /not configured/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exercism cross-track: an accepted problem is taken once per pool (both directions, legacy records too); a rejected attempt does not take it", async () => {
  const root = tempDir();
  try {
    const f = fixture(root);
    const ts = tsTrack(root);
    const vendorDir = fakeVendor(root);
    const vendor = { dir: vendorDir, manifest: vendorManifest(vendorDir, "30.3.0", CFG.licenses) };
    const pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    const run = (pool, track) => collectExercism({ pool, cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(), repos: { ...f.repos, ...(track === TS ? { track: ts } : {}) }, vendor, track });
    // JS first: alpha eligible, beta listed, gamma rejected (unsupported jest feature in the JS spec).
    const p1 = join(root, "p1");
    const js = await run(p1, "exercism/javascript");
    assert.deepEqual(js.eligible.map(e => e.id), ["x-exercism-javascript-alpha"]);
    const t1 = await run(p1, TS);
    assert.deepEqual(t1.eligible.map(e => e.id), ["x-exercism-typescript-gamma"], "gamma's JS attempt was rejected: the TS port may still be built");
    assert.equal(t1.caseRejects["problem-taken-in-supply"], 1, "alpha was accepted from JS");
    // ... and the problem stays taken after it is sealed (the batch keeps its eligible case records).
    const sealed = sealBatch({ pool: p1, cfg: mergeSupply({ ...CFG, batch: { ...CFG.batch, maxOwnerShare: 1 } }), minima: { minTasks: 1, minFamilies: 1, requireHard: true, hardBasis: DEFAULT_PROTOCOL.holdout.hardBasis } });
    assert.ok(sealed.batch);
    const { takenProblems } = await import("../src/supply-exercism.mjs");
    assert.deepEqual([...takenProblems(registryOf(p1).records())].sort(), ["alpha", "gamma"]);
    // TS first: the JS port of alpha is the duplicate.
    const p2 = join(root, "p2");
    await run(p2, TS);
    const j2 = await run(p2, "exercism/javascript");
    assert.equal(j2.caseRejects["problem-taken-in-supply"], 2, "alpha and gamma were accepted from TS"); assert.equal(j2.eligible.length, 0);
    // Legacy registry records (2026-11-05: sourceKey only, no problem field) are recognized.
    const p3 = join(root, "p3");
    mkdirSync(p3, { recursive: true });
    registryOf(p3).append({ type: "case", caseId: "x-exercism-javascript-alpha", status: "eligible", code: "valid", source: "exercism", repo: "exercism/javascript", revision: "r", sourceKey: exerciseSourceKey("exercism/javascript", "alpha"), family: "gh:exercism/javascript", tier: "hard", difficultyBasis: "source", contentDigest: "d" });
    const t3 = await run(p3, TS);
    assert.equal(t3.caseRejects["problem-taken-in-supply"], 1);
    assert.equal(t3.eligible.some(e => e.id.endsWith("-alpha")), false);
    // Repeated collection adds nothing new.
    const again = await run(p1, TS);
    assert.equal(again.eligible.length, 0); assert.equal(again.caseRejects["exercise-seen-in-supply"], 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exercism exposure: other-language benchmark listings are recorded (default) or exclude (any-language); the track language list is mandatory", async () => {
  const root = tempDir();
  try {
    const f = fixture(root);
    commit(f.bench.dir, { "cpp/exercises/practice/alpha/.keep": "", "go/exercises/practice/alpha/.keep": "" }, "more languages");
    const vendorDir = fakeVendor(root);
    const vendor = { dir: vendorDir, manifest: vendorManifest(vendorDir, "30.3.0", CFG.licenses) };
    const pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    const d = await collectExercism({ pool: join(root, "p1"), cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(), repos: f.repos, vendor });
    assert.deepEqual(d.eligible.map(e => e.id), ["x-exercism-javascript-alpha"]);
    const t = JSON.parse(readFileSync(join(root, "p1", "cases", "x-exercism-javascript-alpha", "task.json"), "utf8"));
    assert.deepEqual(t.upstream.benchmarkListings.map(l => l.language), ["cpp", "go"]);
    assert.ok(t.upstream.limitations.some(l => /listed in a public benchmark for another language/.test(l)));
    assert.deepEqual(registryOf(join(root, "p1")).records().find(r => r.caseId === "x-exercism-javascript-alpha").listedLanguages, ["cpp", "go"]);
    assert.deepEqual(d.exclusions[0].listed, { cpp: 1, go: 1, java: 0, javascript: 1, python: 0, rust: 0 });
    const strict = mergeSupply({ ...CFG, exercism: { ...CFG.exercism, excludeScope: "any-language" } });
    const s = await collectExercism({ pool: join(root, "p2"), cfg: strict, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(), repos: f.repos, vendor });
    assert.equal(s.eligible.length, 0); assert.equal(s.caseRejects["listed-in-public-benchmark"], 2);
    assert.deepEqual(registryOf(join(root, "p2")).records().find(r => r.caseId === "x-exercism-javascript-alpha").listedLanguages, ["cpp", "go"]);
    // Without the track language's own list nothing is collected (never "nothing excluded").
    const g = fixture(join(root, "g"));
    gitc(g.bench.dir, ["rm", "-q", "javascript/exercises/practice/beta/.keep"]); gitc(g.bench.dir, ["commit", "-q", "-m", "drop"]);
    await assert.rejects(collectExercism({ pool: join(root, "p3"), cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(), repos: g.repos, vendor }), /exclusion list aider-polyglot-benchmark: nothing at aider-ai\/polyglot-benchmark\/javascript\/exercises\/practice/);
    await assert.rejects(collectExercism({ pool: join(root, "p4"), cfg: mergeSupply({ ...CFG, exercism: { ...CFG.exercism, excludeScope: "everything" } }), orcheDir: fakeOrche(root), packageDir: pkgDir, validate: okValidate(), repos: f.repos, vendor }), /unknown excludeScope/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real grading sandbox (typescript): the unchanged .ts spec runs under node:test with type stripping; stub fails executed tests, proof passes, visible suite empty", { skip: !existsSync("/usr/bin/bwrap") && "no bubblewrap" }, async () => {
  const root = tempDir();
  try {
    const { hostEnvironment } = await import("../src/sandbox.mjs");
    const { gradeWorkspace, validateGrader } = await import("../src/grader.mjs");
    const env = hostEnvironment();
    const f = fixture(root);
    const ts = tsTrack(root, { practice: [{ slug: "alpha", uuid: "u-a", difficulty: 9 }] });
    const vendorDir = fakeVendor(root);
    const vendor = { dir: vendorDir, manifest: vendorManifest(vendorDir, "30.3.0", CFG.licenses) };
    const pkgDir = join(root, "pkg"); mkdirSync(join(pkgDir, "datasets"), { recursive: true });
    let n = 0;
    const validate = (dir, o = {}) => validateCase(dir, { env, scratch: join(root, "scratch", String(n++)), repeats: 2, timeoutMs: 60_000, gradeWorkspace, ...o });
    const pool = join(root, "pool");
    const s = await collectExercism({ pool, cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate, repos: { ...f.repos, track: ts }, vendor, track: TS });
    const v = JSON.parse(readFileSync(join(pool, "cases", "x-exercism-typescript-alpha", "validation.private.json"), "utf8"));
    assert.equal(v.ok, true, `${v.code} ${JSON.stringify(v.detail)}`);
    assert.deepEqual(s.eligible.map(e => e.id), ["x-exercism-typescript-alpha"]);
    assert.deepEqual(v.expected, { hiddenTests: 3 });
    assert.ok(v.detail.original.every(o => o.visible.tests === 0 && o.visible.pass && o.hidden.tests === 3 && o.hidden.failed === 3));
    assert.ok(v.detail.reference.every(r => r.hidden.pass && r.hidden.failed === 0 && r.visible.pass));
    const [t] = loadLocal(join(pool, "cases"));
    const vg = await validateGrader({ task: t, scratch: join(root, "vg"), env });
    assert.equal(vg.ok, true, vg.problems.join("; ")); assert.equal(vg.expected.hiddenTests, 3); assert.equal(vg.referenceVisiblePass, true);
    // A proof that needs more than type stripping (a parameter property) fails validation instead of being approximated.
    const ts2 = tsTrack(join(root, "b"), { practice: [{ slug: "alpha", uuid: "u-a", difficulty: 9 }] });
    commit(ts2.dir, { "exercises/practice/alpha/.meta/proof.ci.ts": "export class Acc {\n  total: number = 0\n  constructor(private readonly start: number = 0) {}\n  add(n: number): void {\n    if (n < 0) throw new Error('negative')\n    this.total += n\n  }\n}\n" }, "param property");
    const s2 = await collectExercism({ pool: join(root, "pool2"), cfg: CFG, orcheDir: fakeOrche(root), packageDir: pkgDir, validate, repos: { ...f.repos, track: ts2 }, vendor, track: TS });
    assert.equal(s2.eligible.length, 0); assert.equal(s2.caseRejects["reference-fails-hidden"], 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refresh (CLI, scratch pool): both sources -> sealed batch -> available; a repeat adds nothing and leaves the batch intact; a reserved batch is never offered again (exit 2 = keep waiting, no model)", async () => {
  const root = tempDir();
  try {
    const { main } = await import("../src/supply-cli.mjs");
    const { reserveBatch, poolStatus } = await import("../src/supply.mjs");
    const { sha256 } = await import("../src/util.mjs");
    const f = fixture(root);
    const ts = tsTrack(root);
    const vendorDir = fakeVendor(root);
    const vendor = { dir: vendorDir, manifest: vendorManifest(vendorDir, "30.3.0", CFG.licenses) };
    // Four one-commit upstream libraries of four accounts (commit source).
    const libs = ["o1", "o2", "o3", "o4"].map(o => {
      const r = repo(root, `${o}/pad`, { "package.json": JSON.stringify({ name: `${o}-pad`, version: "1.0.0", license: "MIT", type: "module", scripts: { test: "node --test" } }), LICENSE: MIT, "index.js": `// ${o}\nexport const pad = (s, n) => String(s).padStart(n);\n`, "pad.test.js": `// ${o}\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { pad } from "./index.js";\ntest("pads", () => assert.equal(pad(1, 3), "  1"));\n` });
      commit(r.dir, { "index.js": `// ${o}\nexport const pad = (s, n, fill = " ") => String(s).padStart(n, fill);\n`, "pad.test.js": `// ${o}\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { pad } from "./index.js";\ntest("pads", () => assert.equal(pad(1, 3), "  1"));\ntest("fills", () => assert.equal(pad(1, 3, "0"), "001"));\n` }, "Support a custom fill character when padding values");
      return { slug: r.slug, url: r.dir, npm: { name: `${o}-pad` } };
    });
    const proto = join(root, "protocol.json");
    writeFileSync(proto, JSON.stringify({ holdout: { minTasks: 3, minFamilies: 3 }, datasets: { holdout: null, holdoutPool: join(root, "pool") } }));
    const pool = join(root, "pool");
    const orcheDir = fakeOrche(root);
    const collectors = { orcheDir, repos: libs, validate: async (dir, o) => okValidate()(dir, o), exercism: { "exercism/javascript": { repos: f.repos, vendor }, [TS]: { repos: { ...f.repos, track: ts }, vendor } } };
    const capture = async (argv) => { const out = []; const w = process.stdout.write; process.stdout.write = (s) => { out.push(String(s)); return true; }; try { const code = await main(argv, { collectors }); return { code, json: JSON.parse(out.join("")) }; } finally { process.stdout.write = w; } };
    const r1 = await capture(["refresh", "--pool", pool, "--protocol", proto]);
    assert.equal(r1.code, 0, JSON.stringify(r1.json));
    assert.equal(r1.json.sources.commits.eligible, 4);
    assert.deepEqual(r1.json.sources.exercism.map(t => t.eligible), [1, 1], "JS alpha; TS gamma (TS alpha is the same problem; beta listed)");
    assert.equal(r1.json.sealed.length, 1); assert.equal(r1.json.available.ok, true);
    const b = r1.json.sealed[0];
    assert.equal(b.coverage.tasks, 6); assert.equal(b.coverage.owners, 5); assert.ok(b.coverage.maxOwnerShare <= 0.5); assert.equal(b.coverage.hard, 2);
    assert.match(r1.json.sealBlocked.why, /insufficient eligible supply/);
    const batchDir = join(pool, "batches", b.batch);
    const digest = (dir) => sha256(readFileSync(join(dir, "SEAL.json")));
    const before = digest(batchDir);
    // Repeat: no new cases, no new batch, the sealed batch unchanged; still available (unreserved, unused).
    const r2 = await capture(["refresh", "--pool", pool, "--protocol", proto]);
    assert.equal(r2.code, 0); assert.equal(r2.json.sealed.length, 0); assert.equal(r2.json.sources.commits.eligible, 0); assert.deepEqual(r2.json.sources.exercism.map(t => t.eligible), [0, 0]);
    assert.equal(digest(batchDir), before);
    // Unattended form: no --pool, the protocol's datasets.holdoutPool is the pool (the one the engine reserves from).
    const r2b = await capture(["refresh", "--protocol", proto, "--skip-commits"]);
    assert.equal(r2b.code, 0); assert.equal(r2b.json.sealed.length, 0); assert.equal(r2b.json.available.batch, b.batch);
    assert.equal(await main(["refresh"], { collectors }), 64, "no pool and no protocol pool: usage error, nothing collected");
    const recs = registryOf(pool).records();
    const ids = recs.filter(r => r.type === "case").map(r => r.caseId);
    assert.equal(new Set(ids).size, ids.length, "no case decided twice");
    assert.equal(recs.filter(r => r.type === "batch").length, 1);
    // Reserve it (what eval-loop --init does): refresh never offers it again and exits 2 (the waiting loop keeps waiting).
    const protocol = structuredClone(DEFAULT_PROTOCOL); protocol.holdout.minTasks = 3; protocol.holdout.minFamilies = 3;
    assert.equal(reserveBatch(pool, join(root, "exp1"), protocol, { orcheDir }).batch, b.batch);
    const r3 = await capture(["refresh", "--pool", pool, "--protocol", proto, "--skip-commits"]);
    assert.equal(r3.code, 2); assert.equal(r3.json.available.ok, false); assert.match(r3.json.available.reasons.join(" "), /reserved by another experiment/);
    assert.equal(digest(batchDir), before, "the reserved batch is untouched");
    assert.equal(registryOf(pool).records().filter(r => r.type === "reserve").length, 1, "refresh reserves nothing");
    const st = poolStatus(pool, protocol, { orcheDir, cfg: CFG });
    assert.equal(st.registryIntact, true); assert.equal(st.outlook.nextBatch.ok, false);
    // A concurrent refresh is refused (exit 3), never interleaved.
    const { acquireLock } = await import("../src/util.mjs");
    const held = acquireLock(join(pool, ".refresh.lock"));
    try { assert.equal((await capture(["refresh", "--pool", pool, "--protocol", proto])).code, 3); } finally { held.release(); }
    // Reports carry no hidden test or solution text.
    const { readdirSync } = await import("node:fs");
    const reports = readdirSync(join(pool, "reports")).map(n => readFileSync(join(pool, "reports", n), "utf8")).join("\n");
    assert.doesNotMatch(reports, /toEqual|this\.total|padStart/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
