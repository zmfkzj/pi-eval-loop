// Crash windows of the evidence lifecycle (2026-11-07). A child process runs the real sealBatch / retireBatch and is KILLED with
// SIGKILL at a named point (src/util.mjs fault(); no finally, the pool lock stays behind with a dead pid). A fresh process then
// recovers (recoverPool, or the next seal/retire, which recover first). Checked at every boundary: sealed, reserved and used
// batches and their records stay byte-identical; nothing is available twice; no evidence loss is silently accepted (a batch whose
// evidence cannot be verified is reported by batchEvidenceProblems); recovery converges (a second run changes nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { batchEvidenceProblems, caseDigest, poolState, recoverPool, registryOf, retireBatch, sealBatch, sealableCases } from "../src/supply.mjs";
import { holdoutLedger, verifySeal } from "../src/datasets.mjs";
import { sha256 } from "../src/util.mjs";

const SUPPLY = fileURLToPath(new URL("../src/supply.mjs", import.meta.url));
const CFG = { batch: { seed: "s", maxTasks: 3, maxPerFamily: 1, maxOwnerShare: 1 } };
const MIN = { minTasks: 1, minFamilies: 1, requireHard: false, hardBasis: [] };
const REQ = ["validation.private.json"];

function stage(pool, id) {
  const d = join(pool, "cases", id); mkdirSync(join(d, "repo"), { recursive: true });
  writeFileSync(join(d, "task.json"), JSON.stringify({ id, family: `gh:o-${id}/r`, tier: "easy", instruction: "i", provenance: "external" })); writeFileSync(join(d, "repo", "a.js"), `${id}\n`);
  writeFileSync(join(d, "validation.private.json"), JSON.stringify({ ok: true, code: "valid", id }));
  registryOf(pool).append({ type: "case", caseId: id, status: "eligible", family: `gh:o-${id}/r`, tier: "easy", contentDigest: caseDigest(d) });
}

/** A pool with one reserved+used batch (must never change) and three staged cases. */
function world(root) {
  const pool = join(root, "pool"); mkdirSync(pool, { recursive: true });
  stage(pool, "u1");
  const used = sealBatch({ pool, cfg: { batch: { ...CFG.batch, maxTasks: 1 } }, minima: MIN, now: new Date("2026-01-01T00:00:00Z") });
  registryOf(pool).append({ type: "reserve", batch: used.batch, stateDir: "/used", sealDigest: used.seal });
  holdoutLedger(used.dir).append({ type: "use", stateDir: "/used" });
  for (const id of ["c1", "c2", "c3"]) stage(pool, id);
  return { pool, used };
}
const snapshot = (pool, used) => ({ seal: readFileSync(join(used.dir, "SEAL.json"), "utf8"), uses: readFileSync(join(used.dir, "USES.jsonl"), "utf8"), recs: poolState(pool).records.filter(r => r.batch === used.batch || (r.type === "reserve")).map(r => r.hash) });

function crash(fault, script) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as s from ${JSON.stringify(SUPPLY)};\n${script}`], { encoding: "utf8", env: { ...process.env, EVAL_LOOP_FAULT: fault } });
  assert.equal(r.signal, "SIGKILL", `expected the child to be killed at ${fault}: status ${r.status} ${r.stderr.slice(0, 400)}`);
}
const sealScript = (pool) => `s.sealBatch({ pool: ${JSON.stringify(pool)}, cfg: ${JSON.stringify(CFG)}, minima: ${JSON.stringify(MIN)}, now: new Date("2026-02-01T00:00:00Z"), requireEvidence: ${JSON.stringify(REQ)} });`;

for (const fault of ["seal:after-batch-rename", "seal:after-batch-record", "seal:after-evidence-record", "seal:after-evidence-move"]) {
  test(`crash at ${fault}: recovery converges, nothing available twice, used batch untouched, evidence verified`, () => {
    const root = tempDir();
    try {
      const { pool, used } = world(root);
      const before = snapshot(pool, used);
      crash(fault, sealScript(pool));
      // Before recovery: never twice available (staged and in a live batch).
      const st0 = poolState(pool);
      for (const id of ["c1", "c2", "c3"]) assert.ok(!(st0.batched.has(id) && sealableCases(pool, st0).some(c => c.caseId === id)), `${id} both batched and sealable`);
      const rec = recoverPool(pool); // reclaims the dead child's lock
      const st = poolState(pool);
      assert.deepEqual(st.chain, []);
      const live = [...st.batches.values()].filter(b => b.batch !== used.batch);
      if (fault === "seal:after-batch-rename") {
        assert.equal(live.length, 0, "an unregistered batch is never a batch");
        assert.deepEqual(rec.orphans.length, 1, "the orphan directory is moved aside");
        assert.equal(sealableCases(pool, st, { requireEvidence: REQ }).length, 3, "the staged cases stay sealable (once)");
        const again = sealBatch({ pool, cfg: CFG, minima: MIN, now: new Date("2026-02-01T00:00:00Z"), requireEvidence: REQ });
        assert.ok(again.batch, "a later seal (same name) succeeds");
        assert.deepEqual(batchEvidenceProblems(pool, again.batch, REQ), []);
      } else {
        assert.equal(live.length, 1);
        const b = live[0];
        assert.ok(verifySeal(join(pool, "batches", b.batch)).ok);
        assert.deepEqual(batchEvidenceProblems(pool, b.batch, REQ), [], "every task's evidence archived and hash-verified after recovery");
        for (const id of b.tasks) { assert.equal(existsSync(join(pool, "cases", id)), false); assert.equal(sealableCases(pool, st).some(c => c.caseId === id), false); }
        assert.equal(st.records.filter(r => r.type === "evidence" && r.batch === b.batch).length, b.tasks.length, "exactly one evidence record per task");
      }
      const rec2 = recoverPool(pool);
      assert.deepEqual(rec2, { archived: [], moved: [], restaged: [], withdrawn: [], orphans: [] }, "recovery converges");
      assert.deepEqual(snapshot(pool, used), before, "the reserved+used batch, its seal, uses and records are unchanged");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("crash between an evidence record and its move, then the staged evidence changes: recovery does not move it and the batch is reported (no silent acceptance, no endless retry)", () => {
  const root = tempDir();
  try {
    const { pool } = world(root);
    crash("seal:after-evidence-record", sealScript(pool));
    const b = [...poolState(pool).batches.values()].find(x => x.tasks.length === 3);
    const ev = poolState(pool).records.find(r => r.type === "evidence" && r.batch === b.batch);
    writeFileSync(join(pool, "cases", ev.caseId, "validation.private.json"), JSON.stringify({ ok: true, code: "valid", forged: true }));
    const r1 = recoverPool(pool);
    assert.ok(!r1.moved.includes(ev.caseId));
    assert.match(batchEvidenceProblems(pool, b.batch, REQ).join(" "), new RegExp(`${ev.caseId}: evidence validation.private.json missing`));
    assert.equal(sealableCases(pool, poolState(pool)).some(c => c.caseId === ev.caseId), false, "the changed case is not offered again either (batched)");
    const r2 = recoverPool(pool);
    assert.deepEqual(r2, { archived: [], moved: [], restaged: [], withdrawn: [], orphans: [] }, "stable: nothing retried");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const fault of ["retire:after-retire-record", "retire:after-restage-rename"]) {
  test(`crash at ${fault}: restage completes from verified bytes exactly once; used batch untouched`, () => {
    const root = tempDir();
    try {
      const { pool, used } = world(root);
      const s = sealBatch({ pool, cfg: CFG, minima: MIN, now: new Date("2026-03-01T00:00:00Z"), requireEvidence: REQ });
      const bytes = Object.fromEntries(s && poolState(pool).batches.get(s.batch).tasks.map(id => [id, readFileSync(join(pool, "evidence", s.batch, id, "validation.private.json"))]));
      const doc = join(root, "why.json"); writeFileSync(doc, "{}\n");
      const before = snapshot(pool, used);
      crash(fault, `s.retireBatch({ pool: ${JSON.stringify(pool)}, batch: ${JSON.stringify(s.batch)}, code: "t", reason: "r", evidence: { document: ${JSON.stringify(doc)}, sha256: ${JSON.stringify(sha256(readFileSync(doc)))} }, restage: ["c1", "c2", "c3"] });`);
      const st0 = poolState(pool);
      assert.equal(st0.batches.has(s.batch), false, "the retirement record is durable");
      const rec = recoverPool(pool);
      assert.deepEqual([...rec.restaged].sort().length + rec.withdrawn.length, 3 - (fault === "retire:after-restage-rename" ? 0 : 0));
      const st = poolState(pool);
      const restagedRecs = st.records.filter(r => r.type === "case" && r.code === "restaged" && r.fromBatch === s.batch);
      assert.equal(restagedRecs.length, 3, "exactly one restaged record per task");
      for (const id of ["c1", "c2", "c3"]) assert.deepEqual(readFileSync(join(pool, "cases", id, "validation.private.json")), bytes[id], `${id}: the preserved bytes, not regenerated`);
      assert.equal(sealableCases(pool, st, { requireEvidence: REQ }).length, 3, "each restaged case sealable exactly once");
      assert.deepEqual(recoverPool(pool), { archived: [], moved: [], restaged: [], withdrawn: [], orphans: [] }, "recovery converges");
      assert.deepEqual(snapshot(pool, used), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("crash after the retirement record with the preserved evidence lost: the tasks are withdrawn (restage-interrupted), never offered or retried", () => {
  const root = tempDir();
  try {
    const { pool } = world(root);
    const s = sealBatch({ pool, cfg: CFG, minima: MIN, now: new Date("2026-03-01T00:00:00Z"), requireEvidence: REQ });
    const doc = join(root, "why.json"); writeFileSync(doc, "{}\n");
    crash("retire:after-retire-record", `s.retireBatch({ pool: ${JSON.stringify(pool)}, batch: ${JSON.stringify(s.batch)}, code: "t", reason: "r", evidence: { document: ${JSON.stringify(doc)}, sha256: ${JSON.stringify(sha256(readFileSync(doc)))} }, restage: ["c1", "c2", "c3"] });`);
    // The crash left the restage copies in tmp/; they and the archive are lost (disk loss).
    rmSync(join(pool, "tmp"), { recursive: true, force: true });
    rmSync(join(pool, "evidence", s.batch, "c2"), { recursive: true, force: true });
    const rec = recoverPool(pool);
    assert.deepEqual(rec.withdrawn, ["c2"]);
    assert.deepEqual([...rec.restaged].sort(), ["c1", "c3"]);
    const st = poolState(pool);
    assert.equal(st.cases.get("c2").status, "withdrawn");
    assert.equal(st.cases.get("c2").code, "restage-interrupted");
    assert.equal(sealableCases(pool, st).some(c => c.caseId === "c2"), false);
    assert.deepEqual(recoverPool(pool), { archived: [], moved: [], restaged: [], withdrawn: [], orphans: [] });
    void readdirSync; void retireBatch;
  } finally { rmSync(root, { recursive: true, force: true }); }
});
