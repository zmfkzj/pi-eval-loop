#!/usr/bin/env node
// ctrl-confirm-2 operational integrity audit (post-run, BEFORE the preregistered analysis is opened). Not part of the locked
// experiment code and not an analysis: it reads only identities, digests, ledger structure, terminal statuses and resources,
// never success/validity fields, and writes integrity-audit.json. It does not change any state file.
//   node pi-eval-loop/records/ctrl-confirm-2/confirmation/integrity-audit.mjs --state DIR --dataset DIR [--out FILE]
// Checks: state lock == records lock copy; queue digest/size/slots; locked file digests; orche harness tree digests; holdout use
// ledger (chain, exactly one use by this state); run ledger chain; dispatch <-> result matching (one result per attempt, no result
// without dispatch, one unit key per slot); attempt eligibility (a redraw only after an infra-only result, <= maxRetries);
// outstanding work (unsettled units under run.mjs semantics); route/effort/protocol/environment identity of every record;
// infrastructure rate vs prereg maxInfraRate; critical statuses; all-attempt resource accounting (incl. reconciled orphans).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "../../..");
const { Ledger, digestOf, treeDigest } = await import(join(PKG, "src/util.mjs"));
const { holdoutLedger, verifySeal } = await import(join(PKG, "src/datasets.mjs"));
const { retryable } = await import(join(PKG, "src/metrics.mjs"));
const { INFRA } = await import(join(PKG, "experiments/ctrl-ablation/lib.mjs"));
const { loadPrereg } = await import(join(PKG, "experiments/ctrl-confirm-2/lib.mjs"));

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sum = (xs) => xs.reduce((s, x) => s + (x ?? 0), 0);

export function audit({ stateDir, dataset, prereg = loadPrereg() }) {
  const problems = [], notes = [];
  const fail = (m) => problems.push(m);
  const lockPath = join(stateDir, "lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const copy = join(HERE, "lock.json");
  const lockCopyIdentical = existsSync(copy) && sha(copy) === sha(lockPath);
  if (!lockCopyIdentical) fail("state lock.json differs from records/ctrl-confirm-2/confirmation/lock.json");
  if (lock.preregDigest !== digestOf(prereg)) fail("prereg digest differs from lock");

  const queue = JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8"));
  if (digestOf(queue) !== lock.queueDigest) fail("queue digest differs from lock");
  const slotOf = (arm, task, repeat) => `${arm}|${task}|${repeat}`;
  const slots = new Set(queue.map(u => slotOf(u.arm, u.task, u.repeat)));
  const scheduled = prereg.arms.length * prereg.holdout.taskIds.length * prereg.repeats;
  if (queue.length !== scheduled || slots.size !== queue.length) fail(`queue has ${queue.length} units / ${slots.size} slots, scheduled ${scheduled}`);

  const fileProblems = [];
  for (const [p, d] of Object.entries(lock.files)) { if (!existsSync(p)) fileProblems.push(`missing ${p}`); else if (sha(p) !== d) fileProblems.push(`changed ${p}`); }
  fileProblems.forEach(fail);

  const harness = {};
  for (const [arm, h] of Object.entries(lock.harness)) {
    if (!h.tree) { harness[arm] = { identity: h.identity, tree: null, ok: true }; continue; }
    const dir = join(stateDir, "harness", arm);
    const tree = existsSync(dir) ? treeDigest(dir, { skip: [".built", "node_modules"] }) : null;
    harness[arm] = { identity: h.identity, tree, ok: tree === h.tree };
    if (tree !== h.tree) fail(`harness ${arm} tree digest differs from lock`);
  }

  const seal = verifySeal(dataset);
  if (!seal.ok || seal.seal.digest !== lock.holdoutSeal) fail("holdout seal invalid or differs from lock");
  const uses = holdoutLedger(dataset);
  const usesChain = uses.verify();
  const useRecords = uses.records();
  if (usesChain.length) fail(`holdout USES chain: ${usesChain.join("; ")}`);
  if (useRecords.length !== 1 || useRecords[0].stateDir !== resolve(stateDir) || useRecords[0].preregDigest !== lock.preregDigest) fail(`holdout uses: ${useRecords.length} (expected exactly 1 by this state)`);

  const ledger = new Ledger(join(stateDir, "runs.jsonl"));
  const chain = ledger.verify();
  if (chain.length) fail(`run ledger chain: ${chain.join("; ")}`);
  const entries = ledger.records();
  const dispatches = entries.filter(e => e.type === "dispatch"), results = entries.filter(e => e.type === "result");
  const byKey = new Map();
  const unit = (k) => byKey.get(k) ?? byKey.set(k, { d: [], r: [] }).get(k);
  for (const d of dispatches) unit(d.unit_key).d.push(d);
  for (const r of results) unit(r.unit_key).r.push(r);
  const slotKeys = new Map();
  let orphanDispatches = 0;
  for (const [k, u] of byKey) {
    const atts = u.d.map(d => d.attempt);
    if (new Set(atts).size !== atts.length) fail(`unit ${k.slice(0, 12)}: duplicate dispatch attempt`);
    atts.forEach((a, i) => { if (a !== i + 1) fail(`unit ${k.slice(0, 12)}: attempt numbering ${atts.join(",")}`); });
    for (const d of u.d) { const n = u.r.filter(r => r.record.attempt === d.attempt).length; if (n === 0) orphanDispatches++; if (n > 1) fail(`unit ${k.slice(0, 12)} a${d.attempt}: ${n} results`); }
    for (const r of u.r) if (!u.d.some(d => d.attempt === r.record.attempt)) fail(`unit ${k.slice(0, 12)}: result without dispatch`);
    // a redraw only after an infra-only result of the previous attempt, at most maxRetries redraws
    for (const d of u.d.filter(d => d.attempt > 1)) {
      const prev = u.r.find(r => r.record.attempt === d.attempt - 1)?.record;
      if (!prev || !retryable(prev)) fail(`unit ${k.slice(0, 12)} a${d.attempt}: redraw without a retryable previous result`);
    }
    if (u.d.length > prereg.infra.maxRetries + 1) fail(`unit ${k.slice(0, 12)}: ${u.d.length} attempts`);
    const any = u.d[0] ?? u.r[0]?.record;
    const arm = u.d[0]?.harness.id ?? u.r[0].record.candidate_id, task = u.d[0]?.task ?? u.r[0].record.task_id, repeat = u.d[0]?.repeat ?? u.r[0].record.repeat;
    const s = slotOf(arm, task, repeat);
    if (!slots.has(s)) fail(`unit ${k.slice(0, 12)} not in the frozen queue (${s})`);
    if (slotKeys.has(s)) fail(`slot ${s} has two unit keys`); else slotKeys.set(s, k);
    if (!any) fail(`unit ${k.slice(0, 12)} empty`);
  }
  if (orphanDispatches) fail(`${orphanDispatches} dispatch(es) without result (attempt still running or unreconciled)`);

  const route = `${prereg.route.provider}/${prereg.route.model}`;
  const all = results.map(r => r.record);
  const identityBad = all.filter(r => r.model_route !== route || r.thinking_effort !== prereg.route.effort || r.protocol_digest !== lock.preregDigest || (r.environment_digest ?? null) !== lock.envDigest || r.split !== "confirmation" || r.simulated);
  if (identityBad.length) fail(`${identityBad.length} records with a different route/effort/protocol/environment/split or simulated`);

  const finals = new Map(); for (const r of results) finals.set(r.unit_key, r.record);
  let unsettled = 0, missing = 0;
  for (const s of slots) {
    const k = slotKeys.get(s); const u = k && byKey.get(k);
    const last = u?.r.at(-1)?.record;
    if (!last) { missing++; unsettled++; continue; }
    if (u.r.length < u.d.length || (retryable(last) && u.d.length <= prereg.infra.maxRetries)) unsettled++;
  }
  const finalRecords = [...finals.values()];
  const infraFinal = finalRecords.filter(r => INFRA.has(r.terminal_status)).length;
  const infraRate = infraFinal / scheduled;
  const terminalFinal = finalRecords.reduce((m, r) => ({ ...m, [r.terminal_status]: (m[r.terminal_status] ?? 0) + 1 }), {});
  const terminalAll = all.reduce((m, r) => ({ ...m, [r.terminal_status]: (m[r.terminal_status] ?? 0) + 1 }), {});
  const critical = all.filter(r => ["route_violation", "harness_crash"].includes(r.terminal_status)).length;
  const reconciled = results.filter(r => r.reconciled);
  const leakUnits = finalRecords.filter(r => (r.integrity?.leakHits ?? []).length > 0).length;
  if (critical) notes.push(`${critical} critical terminal statuses (route_violation/harness_crash)`);
  if (infraRate > prereg.budget.maxInfraRate) notes.push(`infrastructure rate ${infraRate} > ${prereg.budget.maxInfraRate}: infrastructure-compromised, cannot confirm (PREREGISTRATION §9)`);

  const res = (rs) => ({ attempts: rs.length, requests: sum(rs.map(r => r.model_requests)), requestsCompleted: sum(rs.map(r => r.model_requests_completed)), inputTokens: sum(rs.map(r => r.input_tokens)), outputTokens: sum(rs.map(r => r.output_tokens)), cacheTokens: sum(rs.map(r => r.cache_tokens)), cacheWriteTokens: sum(rs.map(r => r.cache_write_tokens)), unitWallHours: sum(rs.map(r => r.wall_time)) / 3600_000 });
  const perArm = Object.fromEntries(prereg.arms.map(a => [a.id, res(all.filter(r => r.candidate_id === a.id))]));
  const campaign = JSON.parse(readFileSync(join(stateDir, "campaign.json"), "utf8"));
  const times = all.map(r => r.ended_at ?? r.started_at).filter(Boolean).sort();
  return {
    at: new Date().toISOString(), stateDir: resolve(stateDir), dataset: resolve(dataset), ok: problems.length === 0, problems, notes,
    lock: { preregDigest: lock.preregDigest, queueDigest: lock.queueDigest, envDigest: lock.envDigest, holdoutSeal: lock.holdoutSeal, lockedAt: lock.lockedAt, lockCopyIdentical, files: Object.keys(lock.files).length, fileProblems: fileProblems.length, harness },
    holdoutUses: useRecords.map(u => ({ experiment: u.experiment, stateDir: u.stateDir, at: u.at })),
    ledger: { entries: entries.length, dispatches: dispatches.length, results: results.length, reconciledResults: reconciled.length, orphanDispatches, units: byKey.size, redraws: dispatches.filter(d => d.attempt > 1).length },
    design: { scheduled, withResult: scheduled - missing, missing, unsettled, complete: missing === 0 && unsettled === 0 },
    terminal: { final: terminalFinal, allAttempts: terminalAll },
    infrastructure: { finalInfraUnits: infraFinal, rate: infraRate, maxInfraRate: prereg.budget.maxInfraRate, compromised: infraRate > prereg.budget.maxInfraRate },
    integrityCritical: { criticalStatuses: critical, leakUnitsAllArms: leakUnits },
    resourcesAllAttempts: { total: res(all), perArm, reconciledOrphans: { ...res(reconciled.map(r => r.record)), note: "Evaluator.reconcile records requests from the wire journal only: tokens, unit wall time and evidence_dir are not recorded for these attempts" } },
    campaign: { startedAt: campaign.startedAt, wallCeilingAt: new Date(Date.parse(campaign.startedAt) + prereg.budget.maxCampaignWallHours * 3600_000).toISOString(), firstResultAt: campaign.firstResultAt, updatedAt: campaign.updatedAt, lastRecordTime: times.at(-1) ?? null, requestsCheckpoint: campaign.requests, requestCeiling: prereg.budget.maxRequestsTotal, paused: campaign.paused, invocations: campaign.invocations ?? [] },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, dataset: { type: "string" }, out: { type: "string" } } });
  const out = audit({ stateDir: resolve(values.state), dataset: resolve(values.dataset) });
  const text = `${JSON.stringify(out, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, text);
  process.stdout.write(text);
  process.exit(out.ok ? 0 : 1);
}
