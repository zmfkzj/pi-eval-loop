// The pre-registered evaluation protocol: defaults, overrides, validation and the lock that freezes it (with the digests of every
// evaluator file and dataset) before the first evaluation. A changed protocol or evaluator is a NEW protocol version in a new state
// directory; results of different protocol versions are never compared as if they were one condition.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, digestOf, readJson, sha256, walkFiles } from "./util.mjs";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The umbrella checkout (orche, cliproxyapi). EVAL_LOOP_UMBRELLA lets a frozen copy of this package evaluate the live umbrella. */
export const UMBRELLA = process.env.EVAL_LOOP_UMBRELLA ? resolve(process.env.EVAL_LOOP_UMBRELLA) : resolve(PACKAGE_DIR, "..");

export const DEFAULT_PROTOCOL = Object.freeze({
  // protocol-2: any task-agent integrity violation / leak / route violation / crash of a candidate is critical regardless of the
  // baseline; exact development points; class-exhaustion and candidate backstops sized as safety limits (see docs/design.md §1).
  version: "pi-eval-loop/protocol-2",
  seed: "pi-eval-loop-2026-11-04",
  // The harness being optimized: pi-orche in this mode. Every compared harness runs on this ONE agent route (model and effort).
  target: { harness: "orche", mode: "single" },
  route: { provider: "cliproxyapi", model: "gpt-6-luna", effort: "medium" },
  // The optimizer (candidate generator) is a separate agent outside the compared harnesses; its route does not touch the comparison.
  proposer: { kind: "pi", route: { provider: "cliproxyapi", model: "gpt-6.1-sol", effort: "high" }, maxRequests: 120, wallMs: 30 * 60_000, allowedPaths: ["src/", "prompts/"], maxChangedFiles: 4, maxDiffLines: 200 },
  unit: { wallMs: 20 * 60_000, maxRequests: 150, graderMs: 120_000 },
  bootstrap: { draws: 10_000 },
  // Holdout: only externally curated, unexposed, sealed tasks can back an adoption. The bundled holdout-v1 is implementer-authored
  // (written by the agent that built this loop): it is measured once, but an adoption on it stays BLOCKED unless an operator adds
  // its provenance to acceptedProvenance in a NEW protocol version (recorded in the lock and the report).
  // Screening on a train mini-batch (parent vs candidate, matched repeats). Support threshold .80 is an empirical default, not a guarantee.
  screening: { tasks: 6, minRepeats: 3, maxRepeats: 9, step: 3, support: 0.80, band: 0.10, level: "execution" },
  development: { repeats: 3, level: "task", support: 0.80 },
  holdout: { repeats: 3, maxUses: 1, minTasks: 6, minFamilies: 4, requireIndependent: true, acceptedProvenance: ["external"] },
  gate: { eps: { overall: 0.03, hard: 0.05, consistency: 0.05 }, minGain: { overall: 0, hard: 0, consistency: 0 } },
  adoption: { support: 0.95, level: "task", eps: { hard: 0.02, consistency: 0.02 }, minGain: { overall: 0 }, familyRegression: 0.15, familyRegressionSupport: 0.80, requireHardStratum: true, requireChecks: true },
  baselines: { pure: true, stable: true, targetMode: true, multiAttempt: { k: 3 } },
  // Search stop: 10 consecutive candidates without meaningful progress (the user's default). Safety stops only: a failure class is
  // exhausted after as many failed targeted proposals as the no-progress patience (10; identical patches/hypotheses are refused
  // anyway); a runaway backstop of 200 candidates per cycle (disk: <= ~90 MB per fully evaluated candidate); a 72 h hang watchdog;
  // consecutive infrastructure failures. None of them is a cost or time objective.
  watchdog: { noProgressCandidates: 10, maxCandidatesPerCycle: 200, maxCycleWallMs: 72 * 3600_000, maxConsecutiveInfra: 5, maxInfraRate: 0.10, maxFailuresPerClass: 10, maxChildFailuresPerParent: 5, daemonPollMs: 10 * 60_000, hypothesisSimilarity: 0.8 },
  infra: { maxRetries: 1 },
  parallelism: 3,
  // datasets.holdout = null selects an exploration-only protocol (no holdout loaded, graded or consumed; deployment BLOCKED).
  datasets: { source: "suite", trainShare: 0.45, holdout: "datasets/holdout-v1" },
  deploy: { mode: "refs", branch: "eval-loop/stable" },
});

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
export function merge(base, override) {
  if (!isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!(key in base) && !["backend", "faux", "notes", "paths"].includes(key)) throw new Error(`protocol: unknown key ${key}`);
    out[key] = isObject(base[key]) && isObject(value) ? merge(base[key], value) : value;
  }
  return out;
}

export function validateProtocol(p) {
  const problems = [];
  const prob = (value, name) => { if (!(typeof value === "number" && value > 0 && value < 1)) problems.push(`${name} must be in (0,1)`); };
  prob(p.screening.support, "screening.support"); prob(p.adoption.support, "adoption.support"); prob(p.development.support, "development.support");
  if (p.adoption.support < p.screening.support) problems.push("adoption.support must be at least screening.support (deployment is stricter than exploration)");
  if (p.screening.minRepeats < 3) problems.push("screening.minRepeats must be >= 3");
  if (p.screening.maxRepeats < p.screening.minRepeats) problems.push("screening.maxRepeats < minRepeats");
  if (!(p.gate.eps.overall >= 0 && p.gate.eps.overall <= 0.03)) problems.push("gate.eps.overall must be within [0, 0.03] (exploratory overall loss allowance <= 3 percentage points)");
  if (!(p.bootstrap.draws >= 1000)) problems.push("bootstrap.draws must be >= 1000");
  if (p.watchdog.noProgressCandidates < 1) problems.push("watchdog.noProgressCandidates must be >= 1");
  for (const key of ["cost", "tokens", "wallTimeObjective"]) if (key in (p.gate ?? {})) problems.push(`gate.${key}: cost/time are never quality objectives`);
  if (!["refs", "dry"].includes(p.deploy.mode)) problems.push("deploy.mode must be refs|dry");
  return problems;
}

export function loadProtocol(overridePath) {
  const override = overridePath ? JSON.parse(readFileSync(overridePath, "utf8")) : {};
  const protocol = merge(structuredClone(DEFAULT_PROTOCOL), override);
  const problems = validateProtocol(protocol);
  if (problems.length) throw new Error(`invalid protocol:\n- ${problems.join("\n- ")}`);
  return protocol;
}

/** Evaluator files whose bytes define the evaluation (controller, grader, imported orche experiment modules). */
export function evaluatorFiles(orcheDir = join(UMBRELLA, "orche")) {
  const own = walkFiles(join(PACKAGE_DIR, "src")).filter(f => f.symlink === undefined).map(f => join(PACKAGE_DIR, "src", f.path));
  const reused = ["experiments/witness-replay/proxy.mjs", "experiments/witness-replay/bridge.mjs", "experiments/witness-replay/sandbox.ts", "experiments/ultra-ab/protocol.ts"].map(p => join(orcheDir, p));
  return [...own, ...reused];
}
export const fileDigests = (files, root = UMBRELLA) => Object.fromEntries(files.filter(existsSync).map(file => [file.startsWith(root) ? file.slice(root.length + 1) : file, sha256(readFileSync(file))]));

/**
 * Lock the protocol in a state directory (first call) or verify it (later calls). Returns { lock, problems }: any difference in the
 * protocol, evaluator bytes or dataset digest is a problem (the caller halts: a changed evaluation is a new protocol version).
 */
export function lockProtocol(stateDir, protocol, { datasetDigest, orcheDir } = {}) {
  const path = join(stateDir, "protocol.lock.json");
  const current = { protocol, protocolDigest: digestOf(protocol), evaluator: fileDigests(evaluatorFiles(orcheDir)), datasetDigest };
  if (!existsSync(path)) {
    const lock = { ...current, lockedAt: new Date().toISOString() };
    atomicWriteJson(path, lock);
    return { lock, problems: [], created: true };
  }
  const lock = readJson(path);
  const problems = [];
  if (lock.protocolDigest !== current.protocolDigest) problems.push("protocol differs from the locked protocol");
  if (datasetDigest && lock.datasetDigest !== datasetDigest) problems.push("dataset split/manifest differs from the locked one");
  for (const [file, digest] of Object.entries(lock.evaluator)) if (current.evaluator[file] !== digest) problems.push(`evaluator file changed: ${file}`);
  for (const file of Object.keys(current.evaluator)) if (!(file in lock.evaluator)) problems.push(`evaluator file added: ${file}`);
  return { lock, problems, created: false };
}
