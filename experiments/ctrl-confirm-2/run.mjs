#!/usr/bin/env node
// ctrl-confirm-2 driver: the preregistered, randomized and interleaved arm x task x repeat queue on the sealed workspace-local
// external holdout (or, with --smoke, on already EXPOSED suite tasks), with the loop's sandboxed runner and exactly-once ledger.
// It never proposes, selects, adopts or deploys.
//
//   node pi-eval-loop/experiments/ctrl-confirm-2/run.mjs --state DIR --dataset DIR      (confirmation)
//   node pi-eval-loop/experiments/ctrl-confirm-2/run.mjs --state DIR --smoke             (plumbing/fidelity on exposed suite tasks)
//   [--max-units N]  dispatch at most N more units in this invocation (resume later with the same command)
//
// First invocation of a state: lock.json (prereg digest, evaluator + experiment file digests, harness tree digests, task digests,
// instruction digests, grading validation, environment digest, holdout seal, frozen queue). Every later invocation must match it.
// Confirmation: the holdout use is recorded in the dataset's USES.jsonl BEFORE the first unit is dispatched (max 1 use).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Evaluator, realBackend } from "../../src/evaluator.mjs";
import { holdoutLedger, loadLocal, loadSuite, taskDigest, verifySeal } from "../../src/datasets.mjs";
import { validateGrader } from "../../src/grader.mjs";
import { environmentDigest, hostEnvironment, prerequisites, stopProxies } from "../../src/sandbox.mjs";
import { UMBRELLA, evaluatorFiles, fileDigests } from "../../src/protocol.mjs";
import { atomicWriteJson, digestOf, ensureDir, sha256 } from "../../src/util.mjs";
import { retryable } from "../../src/metrics.mjs";
import { INFRA, buildHarness, buildQueue, lockMismatches } from "../ctrl-ablation/lib.mjs";
import { EXPERIMENT_DIR, loadPrereg } from "./lib.mjs";

/** Files whose bytes define this experiment beyond src/: this directory (code, prereg, variants) and the reused ctrl-ablation code. */
export function experimentFiles() {
  const own = ["lib.mjs", "run.mjs", "analyze.mjs", "fidelity.mjs", "power.mjs", "supply.mjs", "assemble.mjs", "prereg.json", "PREREGISTRATION.md", "variants/OCR.diff"].map(f => join(EXPERIMENT_DIR, f));
  const reused = ["lib.mjs", "fidelity.mjs"].map(f => join(EXPERIMENT_DIR, "..", "ctrl-ablation", f));
  return [...own, ...reused].map(f => resolve(f)).filter(existsSync).sort();
}

/** Harness identity: base commit (+mode) and the digest of the exact variant bytes (patch or appended rule). */
export function harnessIdentity(arm, prereg) {
  const content = arm.patch ? sha256(readFileSync(join(EXPERIMENT_DIR, arm.patch))) : arm.appendSystemPrompt ? sha256(prereg[arm.appendSystemPrompt]) : null;
  const base = arm.kind === "orche" ? `${prereg.harnessBase.commit}:${arm.mode}` : "pure";
  return `${base}${content ? `+${content.slice(0, 16)}` : ""}`;
}
export function harnessOf(arm, prereg, built) {
  const h = { id: arm.id, kind: arm.kind, commit: harnessIdentity(arm, prereg) };
  if (arm.kind === "orche") Object.assign(h, { dir: built.dir, mode: arm.mode });
  if (arm.appendSystemPrompt) h.appendSystemPrompt = prereg[arm.appendSystemPrompt];
  return h;
}

/** The instruction every arm receives: the task's own instruction + the fixed baseline integrity contract (identical bytes). */
export const instructionOf = (task, prereg) => `${task.instruction.replace(/\s+$/, "")}\n\n${prereg.integrityContract}`;

/** Tasks of this state: smoke = exposed suite tasks; confirmation = the sealed holdout named by the preregistration. */
export function loadTasks({ prereg, smoke, dataset, orcheDir }) {
  if (smoke) {
    const tasks = loadSuite(join(orcheDir, "fixtures/suite")).filter(t => prereg.smoke.tasks.includes(t.id));
    if (tasks.length !== prereg.smoke.tasks.length) throw new Error("smoke tasks missing");
    return { tasks, seal: null };
  }
  if (!dataset) throw new Error("confirmation needs --dataset (the sealed holdout)");
  const seal = verifySeal(dataset);
  if (!seal.ok) throw new Error(`holdout seal: ${seal.why}`);
  if (seal.seal.digest !== prereg.holdout.sealDigest) throw new Error(`holdout seal ${seal.seal.digest} is not the preregistered ${prereg.holdout.sealDigest}`);
  const tasks = loadLocal(dataset);
  const ids = tasks.map(t => t.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...prereg.holdout.taskIds].sort())) throw new Error("holdout tasks differ from the preregistered list");
  const bad = tasks.filter(t => t.provenance !== "external" || !t.hidden);
  if (bad.length) throw new Error(`holdout tasks without external provenance or hidden tests: ${bad.map(t => t.id).join(", ")}`);
  return { tasks, seal: seal.seal.digest };
}

export async function prepare({ stateDir, prereg, smoke = false, dataset, orcheDir = join(UMBRELLA, "orche"), env = hostEnvironment(), validate = validateGrader, envDigest = undefined }) {
  const { tasks, seal } = loadTasks({ prereg, smoke, dataset, orcheDir });
  const tasksById = Object.fromEntries(tasks.map(t => [t.id, { ...t, instruction: instructionOf(t, prereg) }]));
  const harness = {}, harnessDigests = {};
  for (const arm of prereg.arms) {
    const built = arm.kind === "orche" ? buildHarness(arm, prereg, { stateDir, orcheDir, experimentDir: EXPERIMENT_DIR }) : undefined;
    harness[arm.id] = harnessOf(arm, prereg, built);
    harnessDigests[arm.id] = { identity: harness[arm.id].commit, tree: built?.digest ?? null };
  }
  const gradingPath = join(stateDir, "grading.json");
  const grading = existsSync(gradingPath) ? JSON.parse(readFileSync(gradingPath, "utf8")) : {};
  for (const t of tasks) if (!grading[t.id]) { grading[t.id] = await validate({ task: t, scratch: join(stateDir, "tmp", `grading-${t.id}`), env }); atomicWriteJson(gradingPath, grading); }
  const bad = tasks.filter(t => !grading[t.id].ok);
  if (bad.length) throw new Error(`grader validation failed: ${bad.map(t => `${t.id}: ${grading[t.id].problems.join("; ")}`).join(" | ")}`);
  const queue = buildQueue({ arms: prereg.arms.map(a => a.id), tasks: tasks.map(t => t.id), repeats: smoke ? prereg.smoke.repeats : prereg.repeats, seed: `${prereg.seed}${smoke ? ":smoke" : ""}` });
  const lock = {
    experiment: prereg.id, smoke, preregDigest: digestOf(prereg), envDigest: envDigest ?? environmentDigest(env, prereg.route).digest, queueDigest: digestOf(queue),
    files: fileDigests([...evaluatorFiles(orcheDir), ...experimentFiles()]), harness: harnessDigests,
    tasks: Object.fromEntries(tasks.map(t => [t.id, taskDigest(t)])), instructions: Object.fromEntries(tasks.map(t => [t.id, sha256(tasksById[t.id].instruction)])),
    grading: Object.fromEntries(tasks.map(t => [t.id, { expected: grading[t.id].expected, baselineFailing: grading[t.id].baselineFailing }])),
    holdoutSeal: seal,
  };
  return { tasksById, harness, grading, queue, lock };
}

export function lockState(stateDir, lock, queue) {
  const path = join(stateDir, "lock.json");
  if (!existsSync(path)) { writeFileSync(join(stateDir, "queue.json"), JSON.stringify(queue, null, 1)); atomicWriteJson(path, { ...lock, lockedAt: new Date().toISOString() }); return JSON.parse(readFileSync(path, "utf8")); }
  const recorded = JSON.parse(readFileSync(path, "utf8"));
  const problems = lockMismatches(recorded, lock);
  for (const id of new Set([...Object.keys(recorded.instructions ?? {}), ...Object.keys(lock.instructions ?? {})])) if (recorded.instructions?.[id] !== lock.instructions?.[id]) problems.push(`instructions.${id} changed`);
  if ((recorded.holdoutSeal ?? null) !== (lock.holdoutSeal ?? null)) problems.push("holdoutSeal changed");
  if (problems.length) throw new Error(`lock mismatch (a changed experiment needs a new state directory): ${problems.join("; ")}`);
  return recorded;
}

/**
 * Record the single permitted use of the holdout for this state BEFORE any unit runs (idempotent for the same state; a use by any
 * other state refuses, so the batch can never back two experiments).
 */
export function recordHoldoutUse(dataset, { stateDir, experiment, preregDigest, seal }) {
  const ledger = holdoutLedger(dataset);
  const chain = ledger.verify();
  if (chain.length) throw new Error(`holdout use ledger damaged: ${chain.join("; ")}`);
  const uses = ledger.records();
  const mine = uses.find(u => u.stateDir === resolve(stateDir) && u.preregDigest === preregDigest);
  if (mine) return { reused: true, use: mine };
  if (uses.length) throw new Error(`holdout already used by ${uses.map(u => u.stateDir).join(", ")} (max 1 use)`);
  return { reused: false, use: ledger.append({ type: "use", experiment, stateDir: resolve(stateDir), preregDigest, seal }) };
}

/** Units of the frozen queue that still need a dispatch (no result, a pending dispatch, or an infra-only result with a retry left). */
export function unsettled(queue, evaluator, harness, split, maxRetries) {
  return queue.filter(u => { const s = evaluator.unitState(evaluator.keyOf(harness[u.arm], u.task, split, u.repeat)); return !s.last || s.pending.length > 0 || (retryable(s.last) && s.attempts <= maxRetries); });
}

/**
 * Run the frozen queue. Pauses (never decides) on the preregistered safety limits. The aggregate request ceiling reserves the
 * per-unit maximum for every unit in flight, so concurrent units cannot overshoot it. campaign.json is a checkpoint after every unit:
 * started/updated times, done/unsettled counts, requests, terminal-status counts (never success counts), resume command.
 */
export async function runCampaign({ stateDir, prereg, prepared, backend, log = (l) => process.stderr.write(`${l}\n`), maxUnits = Infinity, now = Date.now, resume = "" }) {
  const { tasksById, harness, grading, queue, lock } = prepared;
  const protocol = { route: prereg.route, unit: prereg.unit, infra: prereg.infra, parallelism: prereg.parallelism, capture: prereg.capture, integrity: prereg.integrity };
  const split = lock.smoke ? "smoke" : "confirmation";
  const evaluator = new Evaluator({ stateDir, protocol, protocolDigest: lock.preregDigest, envDigest: lock.envDigest, tasksById, grading, backend, log: (l) => log(l.replace(/ PASS$/, "")) });
  const pending = unsettled(queue, evaluator, harness, split, prereg.infra.maxRetries).map(u => ({ ...u, split, key: evaluator.keyOf(harness[u.arm], u.task, split, u.repeat) }));
  const campaign = existsSync(join(stateDir, "campaign.json")) ? JSON.parse(readFileSync(join(stateDir, "campaign.json"), "utf8")) : {};
  campaign.startedAt ??= new Date(now()).toISOString();
  const requestsSoFar = () => evaluator.records().reduce((s, r) => s + (r.model_requests ?? 0), 0);
  let next = 0, ran = 0, inFlight = 0, consecutiveInfra = 0, paused = null;
  const checkpoint = () => {
    const records = evaluator.records();
    const left = unsettled(queue, evaluator, harness, split, prereg.infra.maxRetries).length;
    Object.assign(campaign, { experiment: prereg.id, split, preregDigest: lock.preregDigest, queueDigest: lock.queueDigest, total: queue.length, done: queue.length - left, unsettled: left, inFlight, requests: requestsSoFar(), terminal: records.reduce((m, r) => ({ ...m, [r.terminal_status]: (m[r.terminal_status] ?? 0) + 1 }), {}), firstResultAt: records[0]?.started_at ?? null, updatedAt: new Date(now()).toISOString(), paused, resume });
    atomicWriteJson(join(stateDir, "campaign.json"), campaign);
  };
  checkpoint();
  const check = () => {
    if (paused) return false;
    if (ran >= maxUnits) paused = "max-units";
    else if (consecutiveInfra >= prereg.budget.maxConsecutiveInfra) paused = `${consecutiveInfra} consecutive infrastructure failures`;
    else if (requestsSoFar() + (inFlight + 1) * prereg.unit.maxRequests > prereg.budget.maxRequestsTotal) paused = `aggregate request ceiling ${prereg.budget.maxRequestsTotal} (incl. in-flight reserve) reached`;
    else if (now() - Date.parse(campaign.startedAt) > prereg.budget.maxCampaignWallHours * 3600_000) paused = `campaign wall ceiling ${prereg.budget.maxCampaignWallHours} h reached`;
    return !paused;
  };
  const worker = async () => {
    while (next < pending.length && check()) {
      const u = pending[next++];
      ran++; inFlight++;
      let record;
      try { record = await evaluator.runOne(harness[u.arm], u, `${prereg.id}:${split}`); } finally { inFlight--; }
      if (record.terminal_status === "route_violation") paused = `route violation in ${record.run_id}`;
      consecutiveInfra = INFRA.has(record.terminal_status) ? consecutiveInfra + 1 : 0;
      checkpoint();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(prereg.parallelism, pending.length)) }, worker));
  checkpoint();
  const summary = { ran, total: queue.length, done: campaign.done, unsettled: campaign.unsettled, paused, requests: campaign.requests, at: new Date(now()).toISOString() };
  campaign.invocations = [...(campaign.invocations ?? []), summary];
  atomicWriteJson(join(stateDir, "campaign.json"), campaign);
  return summary;
}

async function main() {
  const { values } = parseArgs({ options: { state: { type: "string" }, smoke: { type: "boolean", default: false }, dataset: { type: "string" }, "max-units": { type: "string" }, prereg: { type: "string" } } });
  if (!values.state) { process.stderr.write("usage: run.mjs --state DIR (--dataset DIR | --smoke) [--max-units N]\n"); process.exit(64); }
  const stateDir = ensureDir(resolve(values.state));
  const prereg = loadPrereg(values.prereg);
  const env = hostEnvironment();
  const missing = (await prerequisites(env)).filter(p => !p.ok);
  if (missing.length) { process.stderr.write(`BLOCKED: missing prerequisites ${missing.map(m => m.name).join(", ")}\n`); process.exit(2); }
  const dataset = values.dataset ? resolve(values.dataset) : undefined;
  const prepared = await prepare({ stateDir, prereg, smoke: values.smoke, dataset, env });
  const lock = lockState(stateDir, prepared.lock, prepared.queue);
  if (!values.smoke) {
    const u = recordHoldoutUse(dataset, { stateDir, experiment: prereg.id, preregDigest: lock.preregDigest, seal: lock.holdoutSeal });
    process.stderr.write(`holdout use ${u.reused ? "already recorded" : "recorded"} at ${u.use.at}\n`);
  }
  const onSignal = (signal) => { stopProxies("SIGTERM"); process.stderr.write(`interrupted by ${signal}\n`); process.exit(130); };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, onSignal);
  const resume = `node pi-eval-loop/experiments/ctrl-confirm-2/run.mjs --state ${stateDir}${values.smoke ? " --smoke" : ` --dataset ${dataset}`}`;
  const summary = await runCampaign({ stateDir, prereg, prepared: { ...prepared, lock }, backend: realBackend(env), maxUnits: values["max-units"] ? Number(values["max-units"]) : Infinity, resume });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { stopProxies("SIGTERM"); process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
