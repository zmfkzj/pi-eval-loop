#!/usr/bin/env node
// ctx-state-1 driver: one preregistered stage (baseline, pilot or main; each its own prereg file and state directory) of the
// long-task state-preservation ablation. The ctrl-ablation-1 campaign machinery (frozen interleaved queue, the loop's sandboxed
// runner and exactly-once evaluator ledger, lock, safety pauses); arms are explicit orche runtime settings on a pinned commit.
//
//   node pi-eval-loop/experiments/ctx-state-1/run.mjs --prereg FILE --state DIR [--max-units N]
//
// The first invocation of a state directory writes lock.json; every later invocation must match it exactly. Never adopts anything.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { realBackend } from "../../src/evaluator.mjs";
import { loadSuite, taskDigest } from "../../src/datasets.mjs";
import { validateGrader } from "../../src/grader.mjs";
import { environmentDigest, hostEnvironment, prerequisites, stopProxies } from "../../src/sandbox.mjs";
import { UMBRELLA, evaluatorFiles, fileDigests } from "../../src/protocol.mjs";
import { atomicWriteJson, digestOf, ensureDir } from "../../src/util.mjs";
import { runCampaign } from "../ctrl-ablation/run.mjs";
import { buildHarness, buildQueue, experimentFiles, harnessOf, loadPrereg, lockMismatches } from "./lib.mjs";

export async function prepare({ stateDir, prereg, orcheDir = join(UMBRELLA, "orche"), env = hostEnvironment(), validate = validateGrader, envDigest = undefined }) {
  const tasks = loadSuite(join(orcheDir, "fixtures/suite")).filter(t => prereg.tasks.ids.includes(t.id));
  if (tasks.length !== prereg.tasks.ids.length) throw new Error(`tasks: expected ${prereg.tasks.ids.length}, found ${tasks.length}`);
  const tasksById = Object.fromEntries(tasks.map(t => [t.id, t]));
  const harness = {}, harnessDigests = {};
  for (const arm of prereg.arms) {
    const built = buildHarness(arm, prereg, { stateDir, orcheDir });
    harness[arm.id] = harnessOf(arm, prereg, built);
    harnessDigests[arm.id] = { identity: harness[arm.id].commit, tree: built.digest, orcheConfig: arm.orcheConfig ?? null };
  }
  const gradingPath = join(stateDir, "grading.json");
  const grading = existsSync(gradingPath) ? JSON.parse(readFileSync(gradingPath, "utf8")) : {};
  for (const t of tasks) if (!grading[t.id]) { grading[t.id] = await validate({ task: t, scratch: join(stateDir, "tmp", `grading-${t.id}`), env }); atomicWriteJson(gradingPath, grading); }
  const bad = tasks.filter(t => !grading[t.id].ok);
  if (bad.length) throw new Error(`grader validation failed: ${bad.map(t => `${t.id}: ${grading[t.id].problems.join("; ")}`).join(" | ")}`);
  const queue = buildQueue({ arms: prereg.arms.map(a => a.id), tasks: tasks.map(t => t.id), repeats: prereg.repeats, seed: prereg.seed });
  const lock = {
    experiment: prereg.id, stage: prereg.stage, smoke: false, preregDigest: digestOf(prereg), envDigest: envDigest ?? environmentDigest(env, prereg.route).digest, queueDigest: digestOf(queue),
    files: fileDigests([...evaluatorFiles(orcheDir), ...experimentFiles()]), harness: harnessDigests,
    tasks: Object.fromEntries(tasks.map(t => [t.id, taskDigest(t)])), grading: Object.fromEntries(tasks.map(t => [t.id, { expected: grading[t.id].expected, baselineFailing: grading[t.id].baselineFailing }])),
  };
  return { tasksById, harness, grading, queue, lock };
}

export function lockState(stateDir, lock, queue) {
  const path = join(stateDir, "lock.json");
  if (!existsSync(path)) { writeFileSync(join(stateDir, "queue.json"), JSON.stringify(queue, null, 1)); atomicWriteJson(path, { ...lock, lockedAt: new Date().toISOString() }); return JSON.parse(readFileSync(path, "utf8")); }
  const recorded = JSON.parse(readFileSync(path, "utf8"));
  const problems = lockMismatches(recorded, lock);
  if (problems.length) throw new Error(`lock mismatch (a changed experiment needs a new state directory): ${problems.join("; ")}`);
  return recorded;
}

async function main() {
  const { values } = parseArgs({ options: { state: { type: "string" }, prereg: { type: "string" }, "max-units": { type: "string" } } });
  if (!values.state || !values.prereg) { process.stderr.write("usage: run.mjs --prereg FILE --state DIR [--max-units N]\n"); process.exit(64); }
  const stateDir = resolve(values.state);
  ensureDir(stateDir);
  const prereg = loadPrereg(resolve(values.prereg));
  const env = hostEnvironment();
  const missing = (await prerequisites(env)).filter(p => !p.ok);
  if (missing.length) { process.stderr.write(`BLOCKED: missing prerequisites ${missing.map(m => m.name).join(", ")}\n`); process.exit(2); }
  const prepared = await prepare({ stateDir, prereg, env });
  lockState(stateDir, prepared.lock, prepared.queue);
  const onSignal = (signal) => { stopProxies("SIGTERM"); process.stderr.write(`interrupted by ${signal}\n`); process.exit(130); };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, onSignal);
  const summary = await runCampaign({ stateDir, prereg, prepared, backend: realBackend(env), maxUnits: values["max-units"] ? Number(values["max-units"]) : Infinity });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { stopProxies("SIGTERM"); process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
