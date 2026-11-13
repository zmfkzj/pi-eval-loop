#!/usr/bin/env node
// ctrl-ablation-1 driver: runs the preregistered, randomized and interleaved arm x task x repeat queue with the loop's sandboxed
// runner and its exactly-once evaluator ledger. Separate from the optimization loop: it never proposes, selects or adopts.
//
//   node pi-eval-loop/experiments/ctrl-ablation/run.mjs --state DIR [--smoke] [--max-units N]
//
// The first invocation of a state directory writes lock.json (preregistration digest, every evaluator/experiment file digest, harness
// tree digests, task digests, grading validation, environment digest, frozen queue). Every later invocation must match it exactly.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Evaluator, realBackend } from "../../src/evaluator.mjs";
import { loadLocal, loadSuite, taskDigest } from "../../src/datasets.mjs";
import { validateGrader } from "../../src/grader.mjs";
import { environmentDigest, hostEnvironment, prerequisites, stopProxies } from "../../src/sandbox.mjs";
import { PACKAGE_DIR, UMBRELLA, evaluatorFiles, fileDigests } from "../../src/protocol.mjs";
import { atomicWriteJson, digestOf, ensureDir } from "../../src/util.mjs";
import { retryable } from "../../src/metrics.mjs";
import { INFRA, buildHarness, buildQueue, experimentFiles, harnessOf, loadPrereg, lockMismatches } from "./lib.mjs";

/** Everything a state needs, built from the preregistration (and, for --smoke, its smoke section). */
export async function prepare({ stateDir, prereg, smoke = false, orcheDir = join(UMBRELLA, "orche"), env = hostEnvironment(), validate = validateGrader, envDigest = undefined }) {
  const tasks = smoke ? loadLocal(join(PACKAGE_DIR, prereg.smoke.dataset)).filter(t => prereg.smoke.tasks.includes(t.id))
    : loadSuite(join(orcheDir, "fixtures/suite")).filter(t => prereg.tasks.ids.includes(t.id));
  const want = smoke ? prereg.smoke.tasks : prereg.tasks.ids;
  if (tasks.length !== want.length) throw new Error(`tasks: expected ${want.length}, found ${tasks.length}`);
  const tasksById = Object.fromEntries(tasks.map(t => [t.id, t]));
  const harness = {}, harnessDigests = {};
  for (const arm of prereg.arms) {
    const built = arm.kind === "orche" ? buildHarness(arm, prereg, { stateDir, orcheDir }) : undefined;
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
    tasks: Object.fromEntries(tasks.map(t => [t.id, taskDigest(t)])), grading: Object.fromEntries(tasks.map(t => [t.id, { expected: grading[t.id].expected, baselineFailing: grading[t.id].baselineFailing }])),
  };
  return { tasksById, harness, grading, queue, lock };
}

/** Write the lock on a fresh state, verify it otherwise. Returns the recorded lock. */
export function lockState(stateDir, lock, queue) {
  const path = join(stateDir, "lock.json");
  if (!existsSync(path)) { writeFileSync(join(stateDir, "queue.json"), JSON.stringify(queue, null, 1)); atomicWriteJson(path, { ...lock, lockedAt: new Date().toISOString() }); return JSON.parse(readFileSync(path, "utf8")); }
  const recorded = JSON.parse(readFileSync(path, "utf8"));
  const problems = lockMismatches(recorded, lock);
  if (problems.length) throw new Error(`lock mismatch (a changed experiment needs a new state directory): ${problems.join("; ")}`);
  return recorded;
}

/**
 * Run the frozen queue with `parallelism` workers. Pauses (never decides) on the preregistered safety limits. Returns a summary
 * of what ran. `backend` defaults to the real sandboxed runner; tests pass the simulated one.
 */
export async function runCampaign({ stateDir, prereg, prepared, backend, log = (l) => process.stderr.write(`${l}\n`), maxUnits = Infinity, now = Date.now }) {
  const { tasksById, harness, grading, queue, lock } = prepared;
  const protocol = { route: prereg.route, unit: prereg.unit, infra: prereg.infra, parallelism: prereg.parallelism, capture: prereg.capture, integrity: prereg.integrity };
  // Operator log shows only terminal statuses (no success marks) during the run.
  const evaluator = new Evaluator({ stateDir, protocol, protocolDigest: lock.preregDigest, envDigest: lock.envDigest, tasksById, grading, backend, log: (l) => log(l.replace(/ PASS$/, "")) });
  const split = lock.smoke ? "smoke" : "discovery";
  const pending = queue.map(u => ({ ...u, split, key: evaluator.keyOf(harness[u.arm], u.task, split, u.repeat) })).filter(u => { const s = evaluator.unitState(u.key); return !s.last || s.pending.length > 0 || (retryable(s.last) && s.attempts <= prereg.infra.maxRetries); });
  const campaign = readCampaign(stateDir);
  campaign.startedAt ??= new Date(now()).toISOString();
  writeCampaign(stateDir, campaign);
  let next = 0, ran = 0, consecutiveInfra = 0, paused = null;
  const requestsSoFar = () => evaluator.records().reduce((s, r) => s + (r.model_requests ?? 0), 0);
  const check = () => {
    if (paused) return false;
    if (ran >= maxUnits) paused = "max-units";
    else if (consecutiveInfra >= prereg.budget.maxConsecutiveInfra) paused = `${consecutiveInfra} consecutive infrastructure failures`;
    else if (requestsSoFar() >= prereg.budget.maxRequestsTotal) paused = `aggregate request ceiling ${prereg.budget.maxRequestsTotal} reached`;
    else if (now() - Date.parse(campaign.startedAt) > prereg.budget.maxCampaignWallHours * 3600_000) paused = `campaign wall ceiling ${prereg.budget.maxCampaignWallHours} h reached`;
    return !paused;
  };
  const worker = async () => {
    while (next < pending.length && check()) {
      const u = pending[next++];
      ran++;
      const record = await evaluator.runOne(harness[u.arm], u, `${prereg.id}:${split}`);
      if (record.terminal_status === "route_violation") paused = `route violation in ${record.run_id}`;
      consecutiveInfra = INFRA.has(record.terminal_status) ? consecutiveInfra + 1 : 0;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(prereg.parallelism, pending.length)) }, worker));
  const remaining = queue.filter(u => !evaluator.unitState(evaluator.keyOf(harness[u.arm], u.task, split, u.repeat)).last).length;
  const summary = { ran, remaining, total: queue.length, paused, requests: requestsSoFar(), at: new Date(now()).toISOString() };
  campaign.invocations = [...(campaign.invocations ?? []), summary];
  writeCampaign(stateDir, campaign);
  return summary;
}
const readCampaign = (dir) => existsSync(join(dir, "campaign.json")) ? JSON.parse(readFileSync(join(dir, "campaign.json"), "utf8")) : {};
const writeCampaign = (dir, c) => atomicWriteJson(join(dir, "campaign.json"), c);

async function main() {
  const { values } = parseArgs({ options: { state: { type: "string" }, smoke: { type: "boolean", default: false }, "max-units": { type: "string" }, prereg: { type: "string" } } });
  if (!values.state) { process.stderr.write("usage: run.mjs --state DIR [--smoke] [--max-units N]\n"); process.exit(64); }
  const stateDir = resolve(values.state);
  ensureDir(stateDir);
  const prereg = loadPrereg(values.prereg);
  const env = hostEnvironment();
  const missing = (await prerequisites(env)).filter(p => !p.ok);
  if (missing.length) { process.stderr.write(`BLOCKED: missing prerequisites ${missing.map(m => m.name).join(", ")}\n`); process.exit(2); }
  const prepared = await prepare({ stateDir, prereg, smoke: values.smoke, env });
  lockState(stateDir, prepared.lock, prepared.queue);
  const onSignal = (signal) => { stopProxies("SIGTERM"); process.stderr.write(`interrupted by ${signal}\n`); process.exit(130); };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, onSignal);
  const summary = await runCampaign({ stateDir, prereg, prepared, backend: realBackend(env), maxUnits: values["max-units"] ? Number(values["max-units"]) : Infinity });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { stopProxies("SIGTERM"); process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
