#!/usr/bin/env node
// ctrl-confirm-4 -> autonomous lifecycle (agent_workflow confirmatory-1 / protocol-v3) evidence boundary. FAIL-CLOSED and read-only.
//
// ctrl-confirm-4 is a DIFFERENT study from protocol-v3: a fixed prompt intervention (OCR = OC + testIntegrityRule, patch bytes
// pinned by sha256) against the stable orche harness, 3 repeats, two co-primary endpoints at one-sided 0.025 each, external sealed
// tasks without a calibrated-hard stratum or a private-reviewed low-exposure set, its own resource ceilings, and no draw on the
// confirmatory-1 alpha series or request ledger. protocol-v3 confirms a lifecycle CANDIDATE with its own gates. So this module
// never adopts, never counts as a protocol-v3 holdout or confirmation, and never spends protocol-v3 alpha or requests. It only:
//   1. verifies that a ctrl-confirm-4 result is genuine (finished, audited, bound to the registered prereg/queue, analysis
//      reproducible from the hash-chained ledgers - a tampered, replayed, partial or foreign analysis is rejected);
//   2. maps every protocol-v3 gate to covered / not-covered (all not covered: requirements differ), and
//   3. derives the only admissible use: SUPPORTING_EVIDENCE that may motivate submitting the SAME intervention to the lifecycle as
//      a candidate, which must then pass every protocol-v3 gate on its own; the ctrl-confirm-4 batches become prior-used families.
// Not launch-bound (not in run.mjs experimentFiles): changing it never invalidates a running campaign's lock.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/lifecycle-bridge.mjs --state DIR --protocol <pi-eval-loop clone>/studies/confirmatory-1/protocol-v3.json
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { digestOf } from "../../src/util.mjs";
import { loadPrereg } from "./lib.mjs";

/** protocol-v3 gates (from the protocol file) and why a ctrl-confirm-4 result does not satisfy each. */
export function protocolGates(protocol, prereg) {
  const h = protocol.holdout ?? {}, a = protocol.analysisPlan ?? {};
  const gates = [
    ["holdout.repeats", `${h.repeats} repeats per task x arm`, `ctrl-confirm-4 ran ${prereg.repeats}`],
    ["holdout.hardBasis/minHardTasks", `>= ${a.minHardTasks} calibrated-hard tasks (${(h.hardBasis ?? []).join(",")})`, "ctrl-confirm-4 has no calibrated-hard stratum"],
    ["lowExposure", `>= ${a.lowExposure?.minTasks} ${(a.lowExposure?.provenance ?? []).join("/")} tasks`, "ctrl-confirm-4 tasks are external public-repository tasks only"],
    ["holdout.privateReview", `${h.privateReview} review`, "not part of ctrl-confirm-4"],
    ["analysisPlan.minEffect/alpha", `effect >= ${a.minEffect}, alpha ${a.alpha} (series ${a.series?.id}, total ${a.series?.alphaTotal})`, `ctrl-confirm-4: one-sided 0.025 per co-primary endpoint, no minimum effect, no series ledger`],
    ["analysisPlan.series", `alpha spent in ${a.series?.ledger}`, "ctrl-confirm-4 never spends the series alpha (separate registration)"],
    ["confirmation", `independent confirmation in ${a.confirmation?.pool} (alpha ${a.confirmation?.alpha}, >= ${a.confirmation?.minTasks} tasks / ${a.confirmation?.minFamilies} families)`, "ctrl-confirm-4 is not drawn from that pool"],
    ["candidate", "a lifecycle candidate (proposed by the loop) on the protocol's datasets", "ctrl-confirm-4 tests one fixed patch (OCR.diff) on a pinned orche base"],
    ["adoption.requireFamilyLevel", `family-level adoption rule: ${JSON.stringify(protocol.adoption ?? {})}`, "evaluated by the lifecycle on its own holdout only"],
  ];
  return gates.map(([gate, requirement, why]) => ({ gate, requirement, status: "not-covered", why }));
}

/**
 * Validate a ctrl-confirm-4 state's result. `recomputed` = the analysis recomputed from the ledgers (decisions only are compared).
 * @returns {{ valid: boolean, problems: string[] }}
 */
export function validateResult({ analysis, lock, final, prereg, recomputed }) {
  const problems = [];
  if (!final) problems.push("no FINAL.json: the campaign has not finished (RUNNING or paused results are never evidence)");
  if (!analysis) problems.push("no analysis.json");
  if (!lock) problems.push("no lock.json");
  if (problems.length) return { valid: false, problems };
  const pd = digestOf(prereg);
  if (lock.preregDigest !== pd) problems.push("lock is bound to another preregistration");
  if (analysis.preregDigest !== pd) problems.push("analysis is bound to another preregistration");
  if (analysis.queueDigest !== lock.queueDigest) problems.push("analysis belongs to another queue/state (replayed or foreign)");
  if (lock.smoke) problems.push("smoke state (exposed tasks; excluded from analysis)");
  if (!analysis.audit?.ok) problems.push(`audit failed (open reservations ${analysis.audit?.openReservations}, uses ${JSON.stringify(analysis.audit?.holdoutUses ?? null)}, within ceilings ${analysis.audit?.withinCeilings})`);
  if (!analysis.complete) problems.push(`incomplete design (${analysis.missing?.length ?? "?"} scheduled units missing)`);
  if (!recomputed) problems.push("analysis could not be recomputed from the ledgers");
  else {
    const pick = (x) => JSON.stringify({ H1: x.primary?.H1?.decision?.verdict, H2: x.primary?.H2?.decision?.verdict ?? null, verdict: x.verdict?.verdict, complete: x.complete, units: x.units });
    if (pick(recomputed) !== pick(analysis)) problems.push("analysis.json differs from the analysis recomputed from the hash-chained ledgers (tampered or stale)");
  }
  return { valid: problems.length === 0, problems };
}

/** Fail-closed assessment. mayAdopt / countsAsProtocolV3 are false under every input. */
export function assess({ analysis, lock, final, prereg, recomputed, protocol, candidatePatchSha256 = null }) {
  const v = validateResult({ analysis, lock, final, prereg, recomputed });
  const gates = protocolGates(protocol, prereg);
  const h1 = v.valid ? analysis.primary.H1.decision.verdict : null;
  const sameIntervention = candidatePatchSha256 === null ? null : candidatePatchSha256 === prereg.identity.ocrPatchSha256;
  let decision, next;
  if (!v.valid) { decision = "REJECTED_EVIDENCE"; next = "nothing may be derived; fix or finish the ctrl-confirm-4 campaign first"; }
  else if (h1 === "CONFIRMED" && analysis.verdict?.verdict === "ADOPTION_CANDIDATE") { decision = "SUPPORTING_EVIDENCE_ONLY"; next = "the OCR intervention may be submitted to the lifecycle as a candidate; it must pass every protocol-v3 gate independently (own holdout, calibrated-hard and low-exposure sets, series alpha, independent confirmation)"; }
  else { decision = "NO_SUPPORT"; next = `H1 ${h1}, verdict ${analysis.verdict?.verdict}: no basis to submit the intervention; the lifecycle is unaffected`; }
  return {
    schema: "ctrl-confirm-4/lifecycle-bridge@1", decision, mayAdopt: false, countsAsProtocolV3Holdout: false, countsAsProtocolV3Confirmation: false, spendsSeriesAlpha: false, drawsConfirmatory1Requests: false,
    evidence: { valid: v.valid, problems: v.problems, H1: h1, H2: v.valid ? analysis.primary.H2?.decision?.verdict ?? null : null, adoptionVerdict: v.valid ? analysis.verdict?.verdict : null, preregDigest: digestOf(prereg) },
    sameIntervention, gates, coveredGates: gates.filter(g => g.status === "covered").length,
    priorUseExclusions: prereg.holdout.batches.map(b => ({ batch: b.path, sealDigest: b.sealDigest, rule: "families of this batch are prior-used for protocol-v3 (priorFamilyReuse: forbid)" })),
    next,
  };
}

/** Recompute the frozen analysis from a state's ledgers without writing anything. */
export async function recomputeFromState(stateDir, prereg) {
  const { analyze, finalRecords } = await import("./analyze.mjs");
  const { loadLocal } = await import("../../src/datasets.mjs");
  const { UMBRELLA } = await import("../../src/protocol.mjs");
  const queue = JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8"));
  const tasks = [...new Set(queue.map(u => u.task))].sort();
  const familyOf = {};
  for (const b of prereg.holdout.batches) for (const t of loadLocal(resolve(UMBRELLA, "results", b.path))) familyOf[t.id] = t.family;
  return analyze(finalRecords(stateDir), prereg, { tasks, familyOf });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, protocol: { type: "string" }, prereg: { type: "string" }, "candidate-patch-sha256": { type: "string" } } });
  const stateDir = resolve(values.state ?? ""), prereg = loadPrereg(values.prereg);
  const read = (f) => (existsSync(join(stateDir, f)) ? JSON.parse(readFileSync(join(stateDir, f), "utf8")) : null);
  const final = read("FINAL.json"), analysis = read("analysis.json"), lock = read("lock.json");
  let recomputed = null;
  if (final && analysis && lock) { try { recomputed = await recomputeFromState(stateDir, prereg); } catch (e) { recomputed = null; process.stderr.write(`recompute failed: ${e}\n`); } }
  const protocol = JSON.parse(readFileSync(resolve(values.protocol ?? ""), "utf8"));
  process.stdout.write(`${JSON.stringify(assess({ analysis, lock, final, prereg, recomputed, protocol, candidatePatchSha256: values["candidate-patch-sha256"] ?? null }), null, 1)}\n`);
}
