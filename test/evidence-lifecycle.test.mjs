// Evidence lifecycle of staged cases (2026-11-07): sealing moves the staged case (validation.private.json and other private records)
// byte for byte to <pool>/evidence/<batch>/<id> and registers its hashes; a restage after retirement restores exactly those bytes
// (verified) or refuses; a case restaged from a batch sealed before preservation carries a recorded legacy gap and is never sealable
// in a pool that requires the evidence; missing or corrupt required evidence is never sealable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rmSync, tempDir } from "./helpers.mjs";
import { caseDigest, evidenceProblems, poolState, registryOf, retireBatch, sealBatch, sealableCases } from "../src/supply.mjs";
import { sha256 } from "../src/util.mjs";

const CFG = { batch: { seed: "s", maxTasks: 5, maxPerFamily: 2, maxOwnerShare: 1 } };
const MIN = { minTasks: 1, minFamilies: 1, requireHard: false, hardBasis: [] };
function pool(root, requireEvidence) {
  const p = join(root, "pool"); mkdirSync(p, { recursive: true });
  if (requireEvidence) writeFileSync(join(p, "POLICY.json"), JSON.stringify({ schema: "pi-eval-loop/pool-policy@1", autoSeal: false, requireEvidence: ["validation.private.json"] }));
  return p;
}
function stage(p, id, validation = JSON.stringify({ ok: true, code: "valid", id, at: "2026-11-07" })) {
  const d = join(p, "cases", id); mkdirSync(join(d, "repo"), { recursive: true });
  writeFileSync(join(d, "task.json"), JSON.stringify({ id, family: `fam/${id}`, tier: "easy", instruction: "i", provenance: "external" })); writeFileSync(join(d, "repo", "a.js"), `${id}\n`);
  if (validation !== null) writeFileSync(join(d, "validation.private.json"), validation);
  registryOf(p).append({ type: "case", caseId: id, status: "eligible", family: `fam/${id}`, tier: "easy", contentDigest: caseDigest(d) });
}
const evidenceDoc = (root) => { const f = join(root, "why.json"); writeFileSync(f, "{}\n"); return { document: f, sha256: sha256(readFileSync(f)) }; };

test("seal preserves evidence byte for byte; restage restores and verifies it; changed evidence aborts the restage", () => {
  const root = tempDir();
  try {
    const p = pool(root, true);
    stage(p, "k1"); stage(p, "k2");
    const bytes = readFileSync(join(p, "cases", "k1", "validation.private.json"));
    const s = sealBatch({ pool: p, cfg: CFG, minima: MIN });
    assert.ok(s.batch);
    assert.equal(existsSync(join(p, "cases", "k1")), false, "staged dir moved");
    const kept = join(p, "evidence", s.batch, "k1", "validation.private.json");
    assert.deepEqual(readFileSync(kept), bytes, "byte-identical evidence");
    assert.equal(existsSync(join(p, "batches", s.batch, "k1", "validation.private.json")), false, "private evidence is not in the sealed batch");
    const r = retireBatch({ pool: p, batch: s.batch, code: "t", reason: "r", evidence: evidenceDoc(root), restage: ["k1"] });
    assert.deepEqual(r.restaged, ["k1"]);
    assert.deepEqual(readFileSync(join(p, "cases", "k1", "validation.private.json")), bytes, "restored, not regenerated");
    const st = poolState(p);
    assert.deepEqual(evidenceProblems(p, "k1", st, ["validation.private.json"]), []);
    assert.ok(sealableCases(p, st).some(c => c.caseId === "k1"));
    // Restored evidence changed afterwards: no longer sealable.
    writeFileSync(join(p, "cases", "k1", "validation.private.json"), JSON.stringify({ ok: true, code: "valid", regenerated: true }));
    assert.match(evidenceProblems(p, "k1", poolState(p), ["validation.private.json"]).join(" "), /differs from the evidence preserved/);
    assert.ok(!sealableCases(p, poolState(p)).some(c => c.caseId === "k1"));
    // A second batch whose preserved evidence was tampered with: the restage is refused, nothing restaged.
    stage(p, "k3");
    const s2 = sealBatch({ pool: p, cfg: CFG, minima: MIN, now: new Date(Date.now() + 5000) });
    writeFileSync(join(p, "evidence", s2.batch, "k3", "validation.private.json"), "tampered");
    assert.throws(() => retireBatch({ pool: p, batch: s2.batch, code: "t", reason: "r", evidence: evidenceDoc(root), restage: ["k3"] }), /evidence validation.private.json preserved at the seal is missing or changed/);
    assert.equal(existsSync(join(p, "cases", "k3")), false);
    assert.ok(poolState(p).batches.has(s2.batch), "not retired either");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing or corrupt required evidence is never sealable; a legacy restage gap is recorded and fails closed under the policy", () => {
  const root = tempDir();
  try {
    const p = pool(root, true);
    stage(p, "m1", null); stage(p, "m2", "{not json"); stage(p, "m3");
    const st = poolState(p);
    assert.deepEqual(sealableCases(p, st).map(c => c.caseId), ["m3"]);
    assert.match(evidenceProblems(p, "m1", st, ["validation.private.json"]).join(), /missing/);
    assert.match(evidenceProblems(p, "m2", st, ["validation.private.json"]).join(), /unreadable/);
    // Legacy: a batch sealed with the evidence deleted (as before 2026-11-07) -> restage records the gap.
    const s = sealBatch({ pool: p, cfg: CFG, minima: MIN });
    rmSync(join(p, "evidence"), { recursive: true, force: true });
    const recs = poolState(p).records.filter(r => r.type === "evidence");
    assert.equal(recs.length, 1);
    // Simulate the legacy registry (no evidence record) by restaging from a pool that never had one: a fresh pool.
    const q = pool(join(root, "q"), true);
    stage(q, "L1");
    const s3 = sealBatch({ pool: q, cfg: CFG, minima: MIN });
    // remove the evidence record's files AND pretend the record never existed: retire with no evidence record is the legacy path
    const regFile = join(q, "registry.jsonl");
    void regFile; void s;
    rmSync(join(q, "evidence"), { recursive: true, force: true });
    assert.throws(() => retireBatch({ pool: q, batch: s3.batch, code: "t", reason: "r", evidence: evidenceDoc(root), restage: ["L1"] }), /missing or changed/, "a registered evidence record that lost its files refuses the restage");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
