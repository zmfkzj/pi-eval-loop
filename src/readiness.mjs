// Readiness of a confirmatory study's prerequisites (protocol-4; preparation only). Model-free and read-only: it never runs a
// model, reserves, seals, consumes or writes anything. Each condition is reported as
//   fulfilled   the evidence the engine needs exists and verifies;
//   provisional the artifact exists but its own evidence says it is not adequate (e.g. a registered plan whose simulated power at
//               the target effect is below the required power);
//   blocked     a required artifact or measurement is missing, fails verification, or an external decision/input is required.
// Conditions: analysis-plan, series-budget, private-review, calibration, main-holdout, confirmation-holdout, cross-pool-overlap.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { planCompleteness, planPath, seriesFits } from "./design.mjs";
import { datasetPurpose, loadLocal, privateReviewProblems, providerOfModel, reviewClass, reviewProblems, verifySeal } from "./datasets.mjs";
import { verifyCalibrationReport } from "./calibration.mjs";
import { batchEligibility, crossFamilyOverlap, DEFAULT_SUPPLY, firstEligibleBatch, knownCorpus, poolState, poolPath } from "./supply.mjs";
import { PACKAGE_DIR } from "./protocol.mjs";
import { sha256 } from "./util.mjs";

export const READINESS_SCHEMA = "pi-eval-loop/readiness@1";

/** Every task directory of a pool (staged cases and sealed batches), read-only. */
function poolTasks(pool) {
  const out = [];
  const st = existsSync(join(pool, "registry.jsonl")) ? poolState(pool) : null;
  const add = (root, where) => { if (!existsSync(root)) return; for (const id of readdirSync(root)) { const tj = join(root, id, "task.json"); if (existsSync(tj)) { try { out.push({ ...JSON.parse(readFileSync(tj, "utf8")), dir: join(root, id), where }); } catch { /* unreadable */ } } } };
  add(join(pool, "cases"), "staged");
  for (const b of st?.batches.values() ?? []) add(join(pool, "batches", b.batch), `batch:${b.batch}${b.purpose ? `:${b.purpose}` : ""}`);
  return { tasks: out, st };
}

const cond = (id, status, reasons, evidence = {}) => ({ id, status, reasons, evidence });

/**
 * @param {{ protocol: any, study: any, studyPath?: string, overlapPools?: string[], orcheDir: string, stateDir?: string }} options
 *   study (studies/<name>/study.json): { plan: { targetEffect, requiredPower, power: [files], models?: [names] },
 *   calibration: { report?: path, approval?: path, plan?: { maxRequests } } }; paths relative to the study file's directory.
 */
export function readiness({ protocol, study, studyPath, overlapPools = [], orcheDir, stateDir = "/nonexistent/readiness-probe" }) {
  const base = studyPath ? resolve(studyPath, "..") : PACKAGE_DIR;
  const at = (p) => (p ? (p.startsWith("/") ? p : resolve(base, p)) : null);
  const plan = protocol.analysisPlan ?? {};
  const conditions = [];

  // 1. analysis plan: complete and frozen (engine rule), then adequacy from its own simulation evidence.
  const missing = planCompleteness(protocol, { base: PACKAGE_DIR });
  if (plan.mode !== "confirmatory") conditions.push(cond("analysis-plan", "blocked", ["analysisPlan.mode is not confirmatory"]));
  else if (missing.length) conditions.push(cond("analysis-plan", "blocked", missing));
  else {
    const want = study?.plan ?? {};
    const rows = (want.power ?? []).flatMap(f => { try { return JSON.parse(readFileSync(at(f), "utf8")).results ?? []; } catch { return []; } });
    const conf = plan.confirmation ?? {};
    // Rows must simulate the FULL registered design (holdout and confirmation sizes, alphas, repeats, family size) at zero
    // candidate violations; the integrity veto is applied below as a separate survival factor (2026-11-07).
    const match = rows.filter(r => r.plan?.tasks === plan.minTasks && r.plan?.repeats === protocol.holdout.repeats && r.plan?.alpha === plan.alpha && r.scenario?.effect === want.targetEffect && (r.scenario?.v ?? r.scenario?.violation ?? 0) === 0
      // A row that does not state the confirmation design does not simulate it (2026-11-07: rows without confTasks no longer match
      // a plan that requires confirmation).
      && (r.plan?.confTasks === undefined ? !conf.required : (r.plan.confTasks === (conf.minTasks ?? plan.minTasks) && r.plan.confAlpha === (conf.alpha ?? plan.alpha) && r.plan.minEffect === plan.minEffect && (plan.minFamilies === undefined || Math.ceil(r.plan.tasks / r.plan.perFamily) === plan.minFamilies))));
    const byModel = Object.fromEntries(match.map(r => [`${r.scenario.model}${r.scenario.template ? `:${r.scenario.template}` : ""}${r.scenario.sigmaFamily !== undefined ? `:sf${r.scenario.sigmaFamily}` : ""}`, { p: r.adoptAndConfirmed.p, mcse: r.adoptAndConfirmed.mcse, reps: r.reps }]));
    // Integrity veto: any candidate run with a violation blocks adoption (critical) or confirmation. With K candidate runs and
    // n pre-holdout candidate runs without a violation, P(no violation) = (n+1)/(n+1+K) under a uniform prior on the rate.
    const K = plan.minTasks * protocol.holdout.repeats + (conf.required ? (conf.minTasks ?? plan.minTasks) * protocol.holdout.repeats : 0);
    const ci = want.candidateIntegrity;
    const survival = ci && Number.isInteger(ci.runs) && ci.violations === 0 ? (ci.runs + 1) / (ci.runs + 1 + K) : null;
    const evidence = { rationale: planPath(plan.rationale.document, PACKAGE_DIR), rationaleSha256: plan.rationale.sha256, registeredAt: plan.registeredAt, targetEffect: want.targetEffect, requiredPower: want.requiredPower, simulatedAdoptAndConfirm: byModel, candidateRuns: K, integritySurvival: survival, candidateIntegrity: ci ?? null };
    const absent = (want.requiredScenarios ?? []).filter(s => !byModel[s]);
    evidence.requiredScenarios = want.requiredScenarios ?? null;
    if (!match.length) conditions.push(cond("analysis-plan", "provisional", [`no simulation result for the registered design (N ${plan.minTasks}, r ${protocol.holdout.repeats}, alpha ${plan.alpha}) at the target effect ${want.targetEffect}: adequacy not shown`], evidence));
    else {
      const short = Object.entries(byModel).filter(([, v]) => !((v.p - 2 * v.mcse) * (survival ?? 0) >= want.requiredPower));
      const why = [];
      if (absent.length) why.push(`required simulation scenarios missing for the registered design: ${absent.join(", ")}`);
      if (survival === null) why.push(`no pre-holdout candidate integrity evidence: ${K} candidate runs must all be free of strict violations (P(no violation) = ${((1 - 0.001) ** K).toFixed(2)} even at a 0.1% per-run rate)`);
      if (short.length) why.push(`simulated adopt-and-confirm power x integrity survival (${survival === null ? "unknown" : survival.toFixed(2)}) at the target effect ${want.targetEffect} is below ${want.requiredPower} under ${short.map(([k, v]) => `${k} (${v.p.toFixed(2)} +- ${v.mcse.toFixed(2)})`).join(", ")}`);
      conditions.push(cond("analysis-plan", why.length ? "provisional" : "fulfilled", why, evidence));
    }
  }

  // 2. series error budget.
  if (plan.series?.ledger && plan.series?.id) {
    const need = (plan.alpha ?? 0) + (plan.confirmation?.required ? plan.confirmation.alpha ?? 0 : 0);
    const fits = seriesFits(planPath(plan.series.ledger, PACKAGE_DIR), { series: plan.series.id, alphaTotal: plan.series.alphaTotal, alpha: need, stateDir: resolve(stateDir) });
    conditions.push(cond("series-budget", fits.ok ? "fulfilled" : "blocked", fits.ok ? [] : [fits.why], { ledger: plan.series.ledger, alphaTotal: plan.series.alphaTotal, perExperiment: need, spent: fits.spent ?? null }));
  } else conditions.push(cond("series-budget", "blocked", ["analysisPlan.series missing"]));

  const poolDir = protocol.datasets?.holdoutPool ? poolPath(resolve(PACKAGE_DIR, protocol.datasets.holdoutPool)) : null;
  const { tasks: all, st } = poolDir && existsSync(poolDir) ? poolTasks(poolDir) : { tasks: [], st: null };

  // 3. private review: complete records, and the review the protocol's privateReview policy accepts (re-verified per task).
  const policy = protocol.holdout.privateReview ?? "human";
  const targetProvider = providerOfModel(protocol.route?.model);
  // Holdout candidates only: tasks of a calibration-purpose batch are never holdouts (sealed calibration tasks keep their review
  // outside the seal; their grader validity is handled by the calibration exclusions), so they are reported apart.
  const inCalibration = (t) => { try { return datasetPurpose(resolve(t.dir, "..")) === "calibration"; } catch { return false; } };
  const calibrationPrivate = all.filter(t => t.provenance === "private-reviewed" && inCalibration(t)).length;
  const priv = all.filter(t => t.provenance === "private-reviewed" && !inCalibration(t));
  const incomplete = priv.filter(t => reviewProblems(t, { dir: t.dir }).length).map(t => t.id);
  const unaccepted = priv.map(t => [t.id, privateReviewProblems(t, policy, { dir: t.dir, targetProvider })]).filter(([, p]) => p.length);
  const reviewers = [...new Set(priv.flatMap(t => (t.review?.reviewers ?? []).map(v => `${v.kind}:${v.model ?? v.id}`)))];
  const classes = priv.reduce((m, t) => { const c = reviewClass(t); m[c] = (m[c] ?? 0) + 1; return m; }, /** @type {Record<string, number>} */ ({}));
  const reviewReasons = [];
  if (!priv.length) reviewReasons.push("no private-reviewed tasks in the pool");
  if (incomplete.length) reviewReasons.push(`incomplete review records: ${incomplete.join(", ")}`);
  if (unaccepted.length) reviewReasons.push(`${unaccepted.length} of ${priv.length} private tasks have no review accepted under holdout.privateReview ${policy}: ${unaccepted.slice(0, 8).map(([id, p]) => `${id} (${p[0]})`).join("; ")}`);
  const acceptedIds = priv.filter(t => !unaccepted.some(([id]) => id === t.id)).map(t => t.id);
  conditions.push(cond("private-review", reviewReasons.length ? "blocked" : "fulfilled", reviewReasons, { policy, privateTasks: priv.length, calibrationPrivateTasks: calibrationPrivate, accepted: acceptedIds.length, acceptedTasks: acceptedIds, reviewClasses: classes, reviewerKinds: reviewers, limitation: policy === "cross-provider" ? "non-human review: provider diversity, filesystem-enforced blind test construction and mechanical agreement; it does not establish training non-exposure or independence of the providers' training data, and it does not make the tasks independently AUTHORED (one authoring source = one account)" : undefined }));

  // 4. calibration: a sealed calibration-purpose batch AND a verified (runner-ledger, re-derived) report of it.
  const calBatches = [...(st?.batches.values() ?? [])].filter(b => b.purpose === "calibration").map(b => ({ batch: b.batch, dir: join(poolDir, "batches", b.batch), seal: b.sealDigest }));
  const calReasons = [], calEvidence = { batches: calBatches.map(b => ({ batch: b.batch, seal: b.seal, sealIntact: verifySeal(b.dir).ok, purpose: datasetPurpose(b.dir), tasks: (() => { try { return loadLocal(b.dir).length; } catch { return null; } })() })) };
  if (!calBatches.length) calReasons.push("no sealed calibration-purpose batch in the pool");
  // One report per calibration batch (study.calibration.reports; .report = one): every one must verify; hard levels need @2 (an
  // integrity failure never certifies difficulty, calibration.verifyCalibrationReport).
  const reportPaths = [study?.calibration?.reports ?? study?.calibration?.report].flat().filter(Boolean).map(p => at(p));
  if (!reportPaths.length || reportPaths.some(p => !p || !existsSync(p))) calReasons.push("no calibration report: the stable baseline has not been measured on the calibration batch (chargeable model runs; needs an operator-approved request ceiling, studies/*/calibrate.mjs)");
  else {
    calEvidence.reports = [];
    for (const reportPath of reportPaths) {
      let report; try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { report = null; }
      const problems = report ? verifyCalibrationReport(report) : ["report unreadable"];
      calEvidence.reports.push({ path: reportPath, sha256: sha256(readFileSync(reportPath)), problems, censoring: report?.rule?.censoring ?? null, hardLevels: report?.rule?.hardLevels ?? null, levels: report?.levels ?? null });
      if (problems.length) calReasons.push(`calibration report ${reportPath.split("/").slice(-2).join("/")} not verified: ${problems.join("; ")}`);
    }
    calEvidence.report = calEvidence.reports[0];
    const hard = calEvidence.reports.flatMap(r => r.hardLevels ?? []);
    if (!calReasons.length && !hard.length) calReasons.push(`no level is calibrated hard (${calEvidence.reports.map(r => `${r.censoring}: ${JSON.stringify(Object.fromEntries(Object.entries(r.levels ?? {}).map(([k, v]) => [k, { tasks: v.tasks, meanRate: v.meanRate === null ? null : Math.round(v.meanRate * 100) / 100 }])))}`).join(" | ")}): no holdout task can carry a calibrated hard basis`);
  }
  const approvalPath = at(study?.calibration?.approval);
  calEvidence.approval = approvalPath && existsSync(approvalPath) ? { path: approvalPath } : { missing: "operator approval of an aggregate request ceiling for the calibration run" };
  const calibratedHard = all.filter(t => t.difficultyBasis === "calibrated").length;
  calEvidence.tasksWithCalibratedHardBasis = calibratedHard;
  if (!calReasons.length && !calibratedHard && (protocol.holdout.hardBasis ?? []).every(b => b === "calibrated")) calReasons.push("no holdout task carries a verified calibrated difficulty basis yet");
  conditions.push(cond("calibration", calReasons.length ? "blocked" : "fulfilled", calReasons, calEvidence));

  // 5./6. main and confirmation holdouts (read-only engine checks + the plan's own coverage).
  const covers = (c, need) => c && c.tasks >= need.minTasks && c.families >= need.minFamilies && (need.minHard ? c.hard >= need.minHard : true);
  const supply = (() => { if (!st) return null; const unbatched = [...st.cases.values()].filter(r => r.status === "eligible" && !st.batched.has(r.caseId)); return { unbatchedEligible: unbatched.length, accounts: [...new Set(unbatched.map(r => String(r.family).replace(/^gh:/, "").split("/")[0]))].length, families: new Set(unbatched.map(r => r.family)).size }; })();
  let main = null;
  if (!poolDir || !st) conditions.push(cond("main-holdout", "blocked", ["no holdout pool (datasets.holdoutPool) with a registry"]));
  else {
    const pick = firstEligibleBatch(poolDir, protocol, { orcheDir });
    if (pick.none) conditions.push(cond("main-holdout", "blocked", ["no sealed, unreserved, unused, eligible batch", ...pick.none.slice(0, 6)], { supply, need: { tasks: plan.minTasks, families: plan.minFamilies, hard: plan.minHardTasks } }));
    else if (!covers(pick.coverage, { minTasks: plan.minTasks, minFamilies: plan.minFamilies, minHard: plan.minHardTasks })) conditions.push(cond("main-holdout", "blocked", [`batch ${pick.batch} below the registered plan: ${JSON.stringify(pick.coverage)}`], { batch: pick.batch }));
    else { main = pick; conditions.push(cond("main-holdout", "fulfilled", [], { batch: pick.batch, seal: pick.sealDigest, coverage: pick.coverage })); }
  }
  const conf = plan.confirmation ?? {};
  if (!conf.required) conditions.push(cond("confirmation-holdout", "blocked", ["analysisPlan.confirmation.required is not true"]));
  else if (!main) conditions.push(cond("confirmation-holdout", "blocked", ["no main holdout batch yet: a confirmation batch must be distinct from it and family-disjoint", ...(supply ? [`unbatched eligible supply: ${JSON.stringify(supply)}`] : [])]));
  else {
    const confPool = poolPath(resolve(PACKAGE_DIR, conf.pool));
    const proto = structuredClone(protocol); proto.holdout.minTasks = Math.max(proto.holdout.minTasks, conf.minTasks); proto.holdout.minFamilies = Math.max(proto.holdout.minFamilies, conf.minFamilies);
    const pick = firstEligibleBatch(confPool, proto, { orcheDir, excludeSeals: [main.sealDigest] });
    if (pick.none) conditions.push(cond("confirmation-holdout", "blocked", ["no second sealed, unused, eligible batch", ...pick.none.slice(0, 6)]));
    else {
      const fm = new Set(loadLocal(main.dir).map(t => t.family)), shared = loadLocal(pick.dir).map(t => t.family).filter(f => fm.has(f));
      conditions.push(shared.length ? cond("confirmation-holdout", "blocked", [`confirmation batch ${pick.batch} shares families with the main batch: ${[...new Set(shared)].join(", ")}`]) : cond("confirmation-holdout", "fulfilled", [], { batch: pick.batch, seal: pick.sealDigest, coverage: pick.coverage, note: "the engine reserves it under <state>#confirmation after the main use; with one pool, which eligible batch becomes main is decided at reservation (registry order)" }));
    }
  }

  // 7. overlap of every pool task with earlier corpora (suite, package datasets, other pools such as the live supply pool).
  const corpus = knownCorpus({ orcheDir, packageDir: PACKAGE_DIR, pool: undefined, extraPools: overlapPools });
  const hits = [];
  for (const t of all) {
    const codes = [];
    if (corpus.texts.some(x => x.includes(String(t.id).toLowerCase()))) codes.push("named-in-earlier-experiments-or-pools");
    for (const sub of ["hidden", "reference"]) { const d = join(t.dir, sub); if (!existsSync(d)) continue; for (const f of readdirSync(d, { recursive: true }).map(String)) { const p = join(d, f); try { const b = readFileSync(p); if (b.length > 64 && corpus.fileHashes.has(sha256(b))) { codes.push("content-matches-earlier-task"); break; } } catch { /* directory */ } } }
    codes.push(...crossFamilyOverlap(t.dir, t.family, corpus, { dedupe: DEFAULT_SUPPLY.dedupe }));
    if (codes.length) hits.push({ id: t.id, where: t.where, codes: [...new Set(codes)] });
  }
  conditions.push(cond("cross-pool-overlap", hits.length ? "blocked" : "fulfilled", hits.length ? hits.map(h => `${h.id} (${h.where}): ${h.codes.join(", ")}`) : [], { tasksChecked: all.length, against: { overlapPools, earlierTasks: corpus.earlierTasks, coverage: corpus.coverage.map(c => ({ root: c.root, scanned: c.scanned })) }, limitation: "exact content, ids and lexical near-duplicates only; semantic resemblance is the reviewers' (recorded) judgement" }));

  const status = conditions.every(c => c.status === "fulfilled") ? "ready" : conditions.some(c => c.status === "blocked") ? "blocked" : "provisional";
  return { schema: READINESS_SCHEMA, at: new Date().toISOString(), status, protocolPool: poolDir, conditions, sideEffects: { modelCalls: 0, reservations: 0, uses: 0, writes: 0 }, note: "preparation readiness only; a final holdout run, adoption or confirmation needs separate human approval" };
}

/** Pool batches' eligibility under the protocol (helper for reports). */
export const batchReport = (pool, protocol, orcheDir) => [...poolState(pool).batches.values()].map(b => ({ batch: b.batch, purpose: b.purpose ?? "holdout", ...batchEligibility(join(pool, "batches", b.batch), protocol, { orcheDir, pool }) }));
