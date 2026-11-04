// The committed real-run records (raw ledgers) agree with the figures stated in docs/results-*.md and records/*/STATUS.md.
// These are checks of the reporting, not new measurements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { auditRecords } from "../scripts/audit-records.mjs";

const dir = (name) => fileURLToPath(new URL(`../records/${name}`, import.meta.url));
const cell = (audit, candidate, split) => audit.cells.find(c => c.candidate === candidate && c.split === split);

test("records abc-real-1: exact rates, multi3 opportunities, consumed holdout, BLOCKED", { skip: !existsSync(dir("abc-real-1")) && "records not present" }, () => {
  const a = auditRecords(dir("abc-real-1"));
  assert.equal(a.distinctAttempts, 522);
  assert.equal(a.simulatedAttempts, 0);
  assert.deepEqual(a.route, ["cliproxyapi/gpt-6-luna|medium"]);
  assert.equal(a.environmentDigests.length, 1);
  for (const [cand, split, s, n, pct] of [["stable", "dev", 37, 48, 77.0833], ["pure", "dev", 43, 48, 89.5833], ["multi3", "dev", 46, 48, 95.8333], ["B-c001", "dev", 37, 48, 77.0833], ["C-c001", "dev", 38, 48, 79.1667], ["stable", "holdout", 15, 21, 71.4286], ["C-c001", "holdout", 13, 21, 61.9048]]) {
    const c = cell(a, cand, split);
    assert.deepEqual([c.successes, c.units, c.percent], [s, n, pct], `${cand}/${split}`);
  }
  const m = cell(a, "multi3", "dev");
  assert.deepEqual([m.allowedAttemptsPerUnit, m.attempts, m.actualAttemptsPerUnit], [3, 48, 1], "multi3 allowed 3 but used 1 attempt per unit");
  assert.ok(m.requestsVsStable < 0.5, "multi3 used under half of stable's requests: not equal-compute");
  assert.deepEqual([cell(a, "C-c001", "holdout").integrityViolationRuns, cell(a, "stable", "holdout").integrityViolationRuns], [8, 4]);
  assert.equal(a.holdoutAttempts, 42);
  assert.equal(a.ablation.holdoutUses, 1);
  assert.equal(a.ablation.verdict, "BLOCKED");
  assert.equal(a.ablation.adopt, false);
  for (const t of ["B", "C"]) {
    assert.match(a.trajectories[t].searchStop, /candidate cap of 4/, "the truncating cap is visible in the raw state");
    assert.equal(a.trajectories[t].candidates.filter(c => c.status !== "screening").length, 3, "3 evaluated candidates per arm");
  }
});

test("records explore-real-2: no holdout, distinct attempts, stop reasons, 20 rejected candidates, BLOCKED", { skip: !existsSync(dir("explore-real-2")) && "records not present" }, () => {
  const a = auditRecords(dir("explore-real-2"));
  assert.equal(a.protocolVersion, "pi-eval-loop/protocol-2");
  assert.equal(a.distinctAttempts, 570);
  assert.deepEqual(a.perLedgerResultRecords, { A: 210, B: 390, C: 390 }, "B/C ledgers carry the shared baseline: per-ledger sums double-count");
  assert.equal(a.simulatedAttempts, 0);
  assert.equal(a.holdoutAttempts, 0);
  assert.deepEqual(a.splits, ["dev", "train"]);
  assert.deepEqual(a.route, ["cliproxyapi/gpt-6-luna|medium"]);
  for (const [cand, split, s, n, pct] of [["stable", "dev", 39, 48, 81.25], ["pure", "dev", 42, 48, 87.5], ["multi3", "dev", 44, 48, 91.6667], ["stable", "train", 20, 33, 60.6061], ["pure", "train", 22, 33, 66.6667]]) {
    const c = cell(a, cand, split);
    assert.deepEqual([c.successes, c.units, c.percent], [s, n, pct], `${cand}/${split}`);
  }
  const m = cell(a, "multi3", "dev");
  assert.deepEqual([m.allowedAttemptsPerUnit, m.attempts], [3, 49]);
  assert.ok(m.requestsVsStable > 0.49 && m.requestsVsStable < 0.52 && m.inputTokensVsStable < 0.2, "multi3 is not equal-compute");
  for (const t of ["B", "C"]) {
    const tr = a.trajectories[t];
    assert.equal(tr.searchStop, "no meaningful progress in 10 consecutive candidates");
    assert.equal(tr.candidates.length, 10);
    assert.ok(tr.candidates.every(c => c.status === "rejected" && /critical: integrity/.test(c.lastDecision)), JSON.stringify(tr.candidates));
    assert.ok(tr.candidates.every(c => c.target === "requirements-generalization"), "no candidate targeted the integrity class");
    assert.equal(tr.selection, null);
    assert.equal(tr.verdict, "BLOCKED");
  }
  assert.deepEqual(a.ablation, { explorationOnly: true, holdoutUses: 0, verdict: "BLOCKED", adopt: false, finals: { A: "stable", B: "stable", C: "stable" } });
});
