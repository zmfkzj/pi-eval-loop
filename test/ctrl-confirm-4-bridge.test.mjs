// ctrl-confirm-4 -> lifecycle evidence boundary: fail-closed under every input (model-free, no state written).
import { test } from "node:test";
import assert from "node:assert/strict";
import { digestOf } from "../src/util.mjs";
import { assess, protocolGates, validateResult } from "../experiments/ctrl-confirm-4/lifecycle-bridge.mjs";

const prereg = { id: "cc4", repeats: 3, identity: { ocrPatchSha256: "patchsha" }, holdout: { batches: [{ path: "h3/b3", sealDigest: "s3" }, { path: "h4/b4", sealDigest: "s4" }] } };
const protocol = { holdout: { repeats: 5, minTasks: 144, minFamilies: 48, hardBasis: ["calibrated"], privateReview: "cross-provider" }, adoption: { requireFamilyLevel: true }, analysisPlan: { minEffect: 0.05, alpha: 0.0125, minHardTasks: 48, series: { id: "s", ledger: "/l", alphaTotal: 0.05 }, lowExposure: { required: true, minTasks: 72, provenance: ["private-reviewed"] }, confirmation: { required: true, pool: "/p", alpha: 0.0125, minTasks: 144, minFamilies: 48 } } };
const pd = digestOf(prereg);
const lock = { preregDigest: pd, queueDigest: "q1", smoke: false };
const analysisOf = (h1 = "CONFIRMED", verdict = "ADOPTION_CANDIDATE", over = {}) => ({ preregDigest: pd, queueDigest: "q1", complete: true, units: 6300, missing: [], audit: { ok: true, openReservations: 0, withinCeilings: true, holdoutUses: [] }, primary: { H1: { decision: { verdict: h1 } }, H2: { decision: { verdict: "NOT_TESTED" } } }, verdict: { verdict }, ...over });
const final = { reason: "queue settled" };

test("a genuine CONFIRMED + ADOPTION_CANDIDATE result is supporting evidence only: never adoption, never a protocol-v3 holdout/confirmation, no alpha or request draw", () => {
  const a = analysisOf();
  const r = assess({ analysis: a, lock, final, prereg, recomputed: a, protocol, candidatePatchSha256: "patchsha" });
  assert.equal(r.decision, "SUPPORTING_EVIDENCE_ONLY");
  assert.equal(r.mayAdopt, false); assert.equal(r.countsAsProtocolV3Holdout, false); assert.equal(r.countsAsProtocolV3Confirmation, false);
  assert.equal(r.spendsSeriesAlpha, false); assert.equal(r.drawsConfirmatory1Requests, false);
  assert.equal(r.coveredGates, 0, "no protocol-v3 gate is covered by a different study");
  assert.equal(r.sameIntervention, true);
  assert.deepEqual(r.priorUseExclusions.map(x => x.sealDigest), ["s3", "s4"], "the consumed batches become prior-used families for the lifecycle");
});

test("every protocol-v3 gate is listed and not covered", () => {
  const g = protocolGates(protocol, prereg);
  assert.ok(g.length >= 9); assert.ok(g.every(x => x.status === "not-covered"));
  for (const k of ["holdout.repeats", "lowExposure", "confirmation", "analysisPlan.series", "candidate"]) assert.ok(g.some(x => x.gate === k), k);
});

test("unfinished, tampered, replayed, foreign, smoke, unaudited or incomplete results are rejected", () => {
  const a = analysisOf();
  const cases = [
    [{ analysis: a, lock, final: null, prereg, recomputed: a }, /not finished/],
    [{ analysis: null, lock, final, prereg, recomputed: a }, /no analysis/],
    [{ analysis: a, lock, final, prereg, recomputed: analysisOf("INCONCLUSIVE", "KEEP_STABLE") }, /tampered or stale/],
    [{ analysis: { ...a, queueDigest: "other" }, lock, final, prereg, recomputed: a }, /replayed or foreign/],
    [{ analysis: a, lock: { ...lock, preregDigest: "x" }, final, prereg, recomputed: a }, /another preregistration/],
    [{ analysis: a, lock: { ...lock, smoke: true }, final, prereg, recomputed: a }, /smoke/],
    [{ analysis: analysisOf("CONFIRMED", "ADOPTION_CANDIDATE", { audit: { ok: false } }), lock, final, prereg, recomputed: a }, /audit failed/],
    [{ analysis: analysisOf("CONFIRMED", "ADOPTION_CANDIDATE", { complete: false, missing: [1] }), lock, final, prereg, recomputed: analysisOf("CONFIRMED", "ADOPTION_CANDIDATE", { complete: false }) }, /incomplete/],
    [{ analysis: a, lock, final, prereg, recomputed: null }, /could not be recomputed/],
  ];
  for (const [input, re] of cases) {
    const v = validateResult(input);
    assert.equal(v.valid, false); assert.ok(v.problems.some(p => re.test(p)), `${re}: ${v.problems.join(" | ")}`);
    const r = assess({ ...input, protocol });
    assert.equal(r.decision, "REJECTED_EVIDENCE"); assert.equal(r.mayAdopt, false);
  }
});

test("non-confirmed outcomes give no support; a different patch is reported as a different intervention", () => {
  for (const [h1, v] of [["INCONCLUSIVE", "KEEP_STABLE"], ["NOT_CONFIRMED_HARM_INDICATED", "KEEP_STABLE"], ["CONFIRMED", "KEEP_STABLE"]]) {
    const a = analysisOf(h1, v);
    const r = assess({ analysis: a, lock, final, prereg, recomputed: a, protocol, candidatePatchSha256: "otherpatch" });
    assert.equal(r.decision, "NO_SUPPORT"); assert.equal(r.mayAdopt, false); assert.equal(r.sameIntervention, false);
  }
});
