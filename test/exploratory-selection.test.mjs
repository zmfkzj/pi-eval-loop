// exploratory-1 (2026-11-07): the study pool's sealing boundary. Collectors and the generic `seal` never seal a pool whose
// POLICY.json says autoSeal false; studies/exploratory-1/select-supply.mjs applies every cross-pool exclusion (registries,
// holdout datasets, live pool batches incl. reserved/used, retired-unrestaged tasks, screening tasks, Exercism problem
// equivalence across tracks) before it seals, fails closed on unreadable sources, and keeps its hashed rule document immutable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rmSync, tempDir } from "./helpers.mjs";
import { caseDigest, poolPolicy, poolState, registryOf, retireBatch, sealBatch, sealableCases } from "../src/supply.mjs";
import { main as supplyMain } from "../src/supply-cli.mjs";
import { Ledger, sha256 } from "../src/util.mjs";
import { exercismProblem, forbiddenSet, lineageHits, selectAndSeal } from "../studies/exploratory-1/select-supply.mjs";

const SRC_HARD = (id) => ({ dataset: "fixture config.json", label: "hard", tier: "hard", url: `https://example.invalid/${id}` });

function addCase(pool, id, family, { tier = "medium", basis, extra = {} } = {}) {
  const d = join(pool, "cases", id);
  mkdirSync(join(d, "repo"), { recursive: true }); mkdirSync(join(d, "hidden"), { recursive: true }); mkdirSync(join(d, "reference"), { recursive: true });
  const m = { id, family, tier, instruction: "do it", provenance: "external", ...(basis === "source" ? { difficultyBasis: "source", difficultySource: SRC_HARD(id) } : {}), ...extra };
  writeFileSync(join(d, "task.json"), JSON.stringify(m)); writeFileSync(join(d, "repo", "a.js"), `// ${id}\n`);
  registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family, tier, difficultyBasis: basis === "source" ? "source" : "declared", contentDigest: caseDigest(d) });
}

function fixture(root) {
  const pool = join(root, "pool");
  mkdirSync(pool, { recursive: true });
  // Earlier sources: a supply registry (family gh:old/repo, exercism JS "change"), a holdout dataset (family ds/fam, exercism
  // "bowling"), a screening task (family scr/fam, exercism "clock").
  const reg = join(root, "old-registry.jsonl");
  { const l = new Ledger(reg); l.append({ type: "case", caseId: "x-old-repo-1", family: "gh:old/repo", status: "eligible" }); l.append({ type: "case", caseId: "x-exercism-javascript-change", family: "gh:exercism/javascript", status: "eligible" }); }
  const ds = join(root, "dataset");
  for (const [id, fam] of [["x-exercism-javascript-bowling", "gh:exercism/javascript"], ["ds-1", "ds/fam"]]) { mkdirSync(join(ds, id, "repo"), { recursive: true }); writeFileSync(join(ds, id, "task.json"), JSON.stringify({ id, family: fam, tier: "easy", instruction: "i", provenance: "external" })); }
  const scr = join(root, "screen");
  for (const [id, fam] of [["x-exercism-typescript-clock", "gh:exercism/typescript-dev"], ["scr-1", "scr/fam"]]) { mkdirSync(join(scr, id, "repo"), { recursive: true }); writeFileSync(join(scr, id, "task.json"), JSON.stringify({ id, family: fam, tier: "easy", instruction: "i", provenance: "external" })); }
  const screenPlan = { tasks: [{ id: "x-exercism-typescript-clock", dataset: scr }, { id: "scr-1", dataset: scr }] };
  // A used/reserved batch of the pool (family used/fam, exercism "grains").
  addCase(pool, "used-1", "used/fam"); addCase(pool, "x-exercism-typescript-grains", "gh:exercism/typescript");
  const u = sealBatch({ pool, cfg: { batch: { seed: "s", maxTasks: 5, maxPerFamily: 2, maxOwnerShare: 1 } }, minima: { minTasks: 1, minFamilies: 1, requireHard: false, hardBasis: [] } });
  registryOf(pool).append({ type: "reserve", batch: u.batch, stateDir: "/used", sealDigest: u.seal });
  // A batch retired with one task restaged (ret-keep) and one not (ret-drop).
  addCase(pool, "ret-keep", "ret/keep"); addCase(pool, "ret-drop", "ret/drop");
  const r = sealBatch({ pool, cfg: { batch: { seed: "s", maxTasks: 5, maxPerFamily: 2, maxOwnerShare: 1 } }, minima: { minTasks: 1, minFamilies: 1, requireHard: false, hardBasis: [] } });
  const ev = join(root, "retire.json"); writeFileSync(ev, "{}\n");
  retireBatch({ pool, batch: r.batch, code: "lineage", reason: "fixture", evidence: { document: ev, sha256: sha256(readFileSync(ev)) }, restage: ["ret-keep"] });
  // Candidates: forbidden by each source, then clean ones (6 tasks, 4+ families, one source-hard, owners spread).
  addCase(pool, "x-old-repo-2", "gh:old/repo");                                   // registry family
  addCase(pool, "x-exercism-typescript-change", "gh:exercism/typescript");        // registry problem (other track)
  addCase(pool, "x-exercism-typescript-bowling", "gh:exercism/typescript");       // dataset problem (other track)
  addCase(pool, "x-exercism-javascript-clock", "gh:exercism/javascript2");        // screening problem (other track)
  addCase(pool, "x-exercism-javascript-grains", "gh:exercism/javascript2");       // problem of a reserved pool batch
  addCase(pool, "ds-2", "ds/fam"); addCase(pool, "scr-2", "scr/fam"); addCase(pool, "used-2", "used/fam");
  addCase(pool, "ret-drop-2", "ret/drop");                                        // family of a retired, unrestaged task
  for (const [id, fam, o] of [["k-1", "gh:a/one", { tier: "hard", basis: "source" }], ["k-2", "gh:b/two", {}], ["k-3", "gh:c/three", {}], ["k-4", "gh:d/four", {}], ["k-5", "gh:e/five", {}]]) addCase(pool, id, fam, o);
  return { pool, screenPlan, sources: { registries: [reg], datasets: [ds] } };
}

test("exercismProblem: the canonical problem across tracks; other ids are not exercises", () => {
  assert.equal(exercismProblem("x-exercism-typescript-knapsack"), "knapsack");
  assert.equal(exercismProblem("x-exercism-javascript-all-your-base"), "all-your-base");
  assert.equal(exercismProblem("x-fastify-forwarded-90ece3bf26"), null);
});

test("select-supply: every exclusion source withdraws its siblings before the seal; the rule document stays immutable; the batch holds only clean cases", () => {
  const root = tempDir();
  try {
    const { pool, screenPlan, sources } = fixture(root);
    const forbidden = forbiddenSet({ pool, screenPlan, sources });
    const { hits } = lineageHits(pool, forbidden);
    const withdrawn = hits.map(h => h.caseId).sort();
    assert.deepEqual(withdrawn, ["ds-2", "ret-drop-2", "scr-2", "used-2", "x-exercism-javascript-clock", "x-exercism-javascript-grains", "x-exercism-typescript-bowling", "x-exercism-typescript-change", "x-old-repo-2"]);
    assert.ok(!withdrawn.includes("ret-keep"), "a restaged task is not forbidden by its retired batch");
    const out = join(root, "rule.json");
    const r = selectAndSeal({ pool, screenPlan, out, sources });
    assert.equal(r.withdrawn.length, 9);
    assert.equal(sha256(readFileSync(out)), r.ruleSha256, "the hashed rule document is never rewritten");
    const result = JSON.parse(readFileSync(r.result, "utf8"));
    assert.equal(result.rule.sha256, r.ruleSha256);
    assert.ok(r.sealed.batch, JSON.stringify(r.sealed));
    const st = poolState(pool);
    const tasks = st.batches.get(r.sealed.batch).tasks;
    for (const id of tasks) assert.ok(!withdrawn.includes(id), `${id} sealed despite lineage`);
    assert.ok(tasks.includes("k-1"), "the source-hard case is in the batch");
    for (const h of hits) assert.equal(st.cases.get(h.caseId).status, "withdrawn");
    assert.throws(() => selectAndSeal({ pool, screenPlan, out, sources }), /immutable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("select-supply fails closed: a missing registry, a malformed line or an unreadable dataset aborts before any withdrawal or seal", () => {
  const root = tempDir();
  try {
    const { pool, screenPlan, sources } = fixture(root);
    const before = readFileSync(join(pool, "registry.jsonl"), "utf8");
    assert.throws(() => selectAndSeal({ pool, screenPlan, out: join(root, "a.json"), sources: { ...sources, registries: [join(root, "missing.jsonl")] } }), /lineage source missing/);
    const bad = join(root, "bad.jsonl"); writeFileSync(bad, "{\"caseId\":\"x\"}\nnot json\n");
    assert.throws(() => selectAndSeal({ pool, screenPlan, out: join(root, "b.json"), sources: { ...sources, registries: [bad] } }), /malformed|unverifiable|chain broken/);
    assert.throws(() => selectAndSeal({ pool, screenPlan, out: join(root, "c.json"), sources: { ...sources, datasets: [join(root, "nope")] } }), /lineage source (unreadable|empty)/);
    assert.equal(readFileSync(join(pool, "registry.jsonl"), "utf8"), before, "nothing withdrawn or sealed");
    for (const f of ["a.json", "b.json", "c.json"]) assert.equal(existsSync(join(root, f)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pool policy: collect never seals and the generic seal refuses on an autoSeal-false pool; a malformed policy fails closed", async () => {
  const root = tempDir();
  const err = process.stderr.write, out = process.stdout.write;
  try {
    const pool = join(root, "pool"); mkdirSync(pool, { recursive: true });
    for (const [id, fam, o] of [["k-1", "gh:a/one", { tier: "hard", basis: "source" }], ["k-2", "gh:b/two", {}], ["k-3", "gh:c/three", {}], ["k-4", "gh:d/four", {}], ["k-5", "gh:e/five", {}], ["k-6", "gh:f/six", {}]]) addCase(pool, id, fam, o);
    writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false, sealVia: "studies/exploratory-1/select-supply.mjs" }));
    assert.equal(poolPolicy(pool).autoSeal, false);
    process.stderr.write = () => true; process.stdout.write = () => true;
    assert.equal(await supplyMain(["seal", "--pool", pool]), 64);
    const code = await supplyMain(["collect", "--pool", pool], { collectors: { repos: [], validate: async () => ({ ok: false }), fetchJson: async () => ({ objects: [] }) } });
    process.stderr.write = err; process.stdout.write = out;
    assert.ok([0, 2].includes(code));
    assert.equal(poolState(pool).batches.size, 0, "no batch sealed by collect");
    assert.equal(sealableCases(pool, poolState(pool)).length, 6);
    writeFileSync(join(pool, "POLICY.json"), "{ broken");
    assert.throws(() => poolPolicy(pool), /unreadable/);
    writeFileSync(join(pool, "POLICY.json"), JSON.stringify({ autoSeal: "no" }));
    assert.throws(() => poolPolicy(pool), /malformed|unverifiable|chain broken/);
    void chmodSync;
  } finally { process.stderr.write = err; process.stdout.write = out; rmSync(root, { recursive: true, force: true }); }
});

test("lineage: a rewritten registry chain and a task id taken by an earlier registry are both refused/excluded", () => {
  const root = tempDir();
  try {
    const { pool, screenPlan, sources } = fixture(root);
    const lines = readFileSync(sources.registries[0], "utf8").split("\n");
    const tampered = join(root, "tampered.jsonl"); writeFileSync(tampered, lines.map((l, i) => i === 0 ? l.replace("gh:old/repo", "gh:other/repo") : l).join("\n"));
    assert.throws(() => forbiddenSet({ pool, screenPlan, sources: { ...sources, registries: [tampered] } }), /chain broken|unverifiable/);
    addCase(pool, "x-old-repo-1", "gh:fresh/new-family"); // same task id as an earlier registry, new family name
    const { hits } = lineageHits(pool, forbiddenSet({ pool, screenPlan, sources }));
    assert.ok(hits.some(h => h.caseId === "x-old-repo-1" && h.key === "task:x-old-repo-1"));
    assert.throws(() => forbiddenSet({ pool, screenPlan: { tasks: [] }, sources }), /screening tasks/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
