// The pre-registered evaluation protocol: defaults, overrides, validation and the lock that freezes it (with the digests of every
// evaluator file and dataset) before the first evaluation. A changed protocol or evaluator is a NEW protocol version in a new state
// directory; results of different protocol versions are never compared as if they were one condition.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, digestOf, readJson, sha256, walkFiles } from "./util.mjs";
import { planShapeProblems } from "./design.mjs";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The umbrella checkout (orche, cliproxyapi). EVAL_LOOP_UMBRELLA lets a frozen copy of this package evaluate the live umbrella. */
export const UMBRELLA = process.env.EVAL_LOOP_UMBRELLA ? resolve(process.env.EVAL_LOOP_UMBRELLA) : resolve(PACKAGE_DIR, "..");

export const DEFAULT_PROTOCOL = Object.freeze({
  // protocol-2: any task-agent integrity violation / leak / route violation / crash of a candidate is critical regardless of the
  // baseline; exact development points; class-exhaustion and candidate backstops sized as safety limits (see docs/design.md §1).
  // protocol-3 (same gates, thresholds and decision rules): gate-blocking failure classes are targeted first, harness checks run
  // before screening, a candidate's remaining units are not dispatched once a critical problem decides its rejection, and a
  // recorded outcome is reused only for an identical unit key that now includes the environment digest (see `efficiency`).
  // protocol-4 (2026-11-06; every protocol-3 gate, threshold and decision rule is kept and stays necessary): the holdout pass runs
  // its arms in a randomized, interleaved schedule frozen before the first run (holdout.execution); adoption additionally needs
  // the family-clustered support (adoption.requireFamilyLevel); holdout eligibility is re-checked at preflight AND at the moment
  // of use for account concentration (holdout.maxOwnerShare) and, when forbidden, reuse of families of earlier holdouts; every
  // decision carries an evidence label from the pre-registered analysis plan (analysisPlan; src/design.mjs, docs/design.md
  // "Prospective analysis plan").
  version: "pi-eval-loop/protocol-4",
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
  // hardBasis: where a holdout task's "hard" tier may come from to count for the hard stratum (adoption.requireHardStratum):
  // "declared" (the dataset's own task.json tier, set by whoever curated the dataset), "curator" (an independent curator's label),
  // "source" (a difficulty annotation of the upstream dataset). "size-proxy" (a tier inferred from the size of the upstream fix by
  // the supply, src/supply.mjs) is never accepted: patch size does not establish difficulty. A task whose hard tier has no
  // accepted basis is not hard for the holdout (stratum, coverage, gate).
  // execution: "interleaved" (protocol-4) = blocks (task, repeat) with one unit per arm, block order and arm order inside a block
  // drawn from the seed and the frozen selection, one shared queue; "sequential" = protocol-3 arm-by-arm time blocks.
  // maxOwnerShare: no account (owner part of a gh:owner/repo family) may hold more than this share of the holdout tasks;
  // priorFamilyReuse "forbid": no family of an earlier used/reserved holdout of the pool or package datasets may reappear.
  // privateReview (2026-11-06): "human" = a low-exposure (private-reviewed) task needs at least one human reviewer to be eligible;
  // "ai-allowed" = AI-agent-only review is accepted (an explicit operator decision, visible in the lock; still labelled).
  // "cross-provider" (2026-11-07, operator decision "no human review"): verified non-human evidence instead of a human reviewer -
  // blind tests by a non-author, non-target provider under filesystem-enforced isolation, an adversarial review by a third
  // provider with mutants run against the official tests, adjudication of every accepted mutant (datasets.crossProviderProblems).
  holdout: { repeats: 3, maxUses: 1, minTasks: 6, minFamilies: 4, requireIndependent: true, acceptedProvenance: ["external"], hardBasis: ["declared", "curator", "source"], execution: "interleaved", maxOwnerShare: 0.5, priorFamilyReuse: "allow", privateReview: "human" },
  gate: { eps: { overall: 0.03, hard: 0.05, consistency: 0.05 }, minGain: { overall: 0, hard: 0, consistency: 0 } },
  adoption: { support: 0.95, level: "task", eps: { hard: 0.02, consistency: 0.02 }, minGain: { overall: 0 }, familyRegression: 0.15, familyRegressionSupport: 0.80, requireHardStratum: true, requireChecks: true, requireFamilyLevel: true },
  // Pre-registered analysis plan (src/design.mjs). mode "exploratory" (default): the adoption gate above decides as before and
  // every result is labelled exploratory (no confirmatory or generalized-improvement claim). mode "confirmatory": the same gate
  // AND the confirmatory checks; every null below must then be filled by the operator with a written rationale (nothing here is
  // a recommended sample size, effect size or error budget), else the experiment is BLOCKED before the search.
  analysisPlan: {
    mode: "exploratory", registeredAt: null, rationale: null, minEffect: null, alpha: null, minTasks: null, minFamilies: null, minHardTasks: null, permutationDraws: 20_000,
    series: { id: null, ledger: null, alphaTotal: null },
    lowExposure: { required: null, minTasks: null, provenance: ["private-reviewed"] },
    confirmation: { required: null, pool: null, alpha: null, minTasks: null, minFamilies: null },
  },
  baselines: { pure: true, stable: true, targetMode: true, multiAttempt: { k: 3 } },
  // Search stop: 10 consecutive candidates without meaningful progress (the user's default). Safety stops only: a failure class is
  // exhausted after as many failed targeted proposals as the no-progress patience (10; identical patches/hypotheses are refused
  // anyway); a runaway backstop of 200 candidates per cycle (disk: <= ~90 MB per fully evaluated candidate); a 72 h hang watchdog;
  // consecutive infrastructure failures. None of them is a cost or time objective.
  watchdog: { noProgressCandidates: 10, maxCandidatesPerCycle: 200, maxCycleWallMs: 72 * 3600_000, maxConsecutiveInfra: 5, maxInfraRate: 0.10, maxFailuresPerClass: 10, maxChildFailuresPerParent: 5, daemonPollMs: 10 * 60_000, hypothesisSimilarity: 0.8 },
  infra: { maxRetries: 1 },
  parallelism: 3,
  // Avoiding work that cannot change a decision (protocol-3). None of these is a budget: there is no token, cost or money limit,
  // by the operator's choice; the safety limits above stay. stopOnCritical: a candidate whose recorded runs already show a critical
  // problem (the gate rejects it whatever the statistics) gets no further screening or development units dispatched, and its
  // screening runs before the parent's (the parent is only needed for the statistics). precheck: the candidate's harness checks
  // before any model run ("test" applies the adoption rule compareChecks against stable: a candidate failing it could never be
  // adopted). gateBlockingFirst: target recurring gate-blocking failure classes (analysis.mjs GATE_BLOCKING) before the others.
  efficiency: { stopOnCritical: true, precheck: ["typecheck", "test"], gateBlockingFirst: true },
  // datasets.holdout = null selects an exploration-only protocol (no holdout loaded, graded or consumed; deployment BLOCKED).
  // datasets.holdoutPool (with holdout: null): a supply pool (src/supply.mjs). A fresh experiment reserves one sealed, unused,
  // eligible batch there for its state directory before anything else runs; the resolved batch path becomes datasets.holdout and
  // is locked with the protocol (one batch per experiment; a later cycle never swaps it). No eligible batch: BLOCKED.
  datasets: { source: "suite", trainShare: 0.45, holdout: "datasets/holdout-v1", holdoutPool: null },
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
  if (p.datasets.holdoutPool !== null && p.datasets.holdoutPool !== undefined) {
    if (typeof p.datasets.holdoutPool !== "string" || !p.datasets.holdoutPool) problems.push("datasets.holdoutPool must be a path or null");
    else if (p.datasets.holdout !== null) problems.push("datasets.holdoutPool needs datasets.holdout: null (the reserved batch becomes the holdout)");
  }
  if (!Array.isArray(p.holdout.hardBasis) || p.holdout.hardBasis.some(b => typeof b !== "string")) problems.push("holdout.hardBasis must be a list of difficulty bases");
  else if (p.holdout.hardBasis.includes("size-proxy")) problems.push("holdout.hardBasis must not accept size-proxy: patch size does not establish task difficulty");
  if (!["human", "cross-provider", "ai-allowed"].includes(p.holdout.privateReview)) problems.push("holdout.privateReview must be human|cross-provider|ai-allowed");
  const e = p.efficiency ?? {};
  if (typeof e.stopOnCritical !== "boolean" || typeof e.gateBlockingFirst !== "boolean") problems.push("efficiency.stopOnCritical and efficiency.gateBlockingFirst must be booleans");
  if (!Array.isArray(e.precheck) || !e.precheck.includes("typecheck") || e.precheck.some(x => !(["typecheck", "test"].includes(x)))) problems.push("efficiency.precheck must list typecheck and optionally test");
  problems.push(...planShapeProblems(p));
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
 * Refusal to touch a damaged experiment directory: a lost state, or a protocol lock that is missing, unreadable, malformed or
 * contradicts the state's recorded binding. Thrown before anything is written or run; the CLI reports it as `state_error`.
 */
export class StateIntegrityError extends Error {
  /** @param {string} message @param {{ health?: string, integrity?: string }} [info] */
  constructor(message, { health = "corrupt", integrity } = {}) { super(message); this.code = "ESTATEINTEGRITY"; this.health = health; this.integrity = integrity; }
}

export const LOCK_FILE = "protocol.lock.json";
const HEX64 = /^[0-9a-f]{64}$/;

/** Structural problems of a parsed protocol lock (empty = well-formed and internally consistent). */
export function lockShapeProblems(lock) {
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) return ["not a JSON object"];
  const problems = [];
  if (!lock.protocol || typeof lock.protocol !== "object" || Array.isArray(lock.protocol)) problems.push("protocol is not an object");
  if (typeof lock.protocolDigest !== "string" || !HEX64.test(lock.protocolDigest)) problems.push("protocolDigest is not a sha256 digest");
  else if (problems.length === 0 && digestOf(lock.protocol) !== lock.protocolDigest) problems.push("protocolDigest does not match the locked protocol");
  const ev = lock.evaluator;
  if (!ev || typeof ev !== "object" || Array.isArray(ev) || Object.keys(ev).length === 0) problems.push("evaluator is not a non-empty map of file digests");
  else if (!Object.values(ev).every(d => typeof d === "string" && HEX64.test(d))) problems.push("evaluator holds a value that is not a sha256 digest");
  if (lock.datasetDigest !== undefined && (typeof lock.datasetDigest !== "string" || !HEX64.test(lock.datasetDigest))) problems.push("datasetDigest is not a sha256 digest");
  if (typeof lock.lockedAt !== "string" || !lock.lockedAt) problems.push("lockedAt missing");
  return problems;
}

/**
 * The binding a state records for its lock: the protocol digest and the digest of the WHOLE lock (protocol, evaluator file
 * digests, dataset digest, lock time), so replacing the evaluator map or the dataset digest under the same protocol is detected.
 */
export const bindingOf = (lock) => ({ protocolDigest: lock.protocolDigest, lockDigest: digestOf(lock) });
export const isBinding = (b) => Boolean(b) && typeof b === "object" && !Array.isArray(b) && typeof b.protocolDigest === "string" && HEX64.test(b.protocolDigest) && typeof b.lockDigest === "string" && HEX64.test(b.lockDigest);

/**
 * Read the lock of a state directory: { present: false } when absent, else the parsed lock. An unreadable, invalid or malformed
 * lock throws StateIntegrityError (never "absent": a damaged lock is not a missing one).
 */
export function readLock(stateDir) {
  const path = join(stateDir, LOCK_FILE);
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return { present: false };
    throw new StateIntegrityError(`${LOCK_FILE} unreadable (${error.code})`, { integrity: "protocol_lock_corrupt" });
  }
  let lock;
  try { lock = JSON.parse(raw); } catch { throw new StateIntegrityError(`${LOCK_FILE} is not valid JSON`, { integrity: "protocol_lock_corrupt" }); }
  const problems = lockShapeProblems(lock);
  if (problems.length) throw new StateIntegrityError(`${LOCK_FILE} is malformed: ${problems.join("; ")}`, { integrity: problems.some(p => p.startsWith("protocolDigest does not match")) ? "protocol_lock_mismatch" : "protocol_lock_corrupt" });
  return { present: true, lock };
}

/**
 * Verify the lock of a state directory against the current protocol, evaluator bytes and dataset digest. Returns
 * { lock, problems, created }: any difference is a problem (the caller stops: a changed evaluation is a new protocol version).
 * A missing lock is created ONLY with create: true, which the controller passes for a proven fresh initialization (see
 * contract.mjs inspectProtocol); otherwise it is a StateIntegrityError and nothing is written. A damaged lock always throws.
 * @param {string} stateDir @param {any} protocol @param {{ datasetDigest?: string, orcheDir?: string, create?: boolean }} [options]
 */
export function lockProtocol(stateDir, protocol, { datasetDigest, orcheDir, create = false } = {}) {
  const path = join(stateDir, LOCK_FILE);
  const current = { protocol, protocolDigest: digestOf(protocol), evaluator: fileDigests(evaluatorFiles(orcheDir)), datasetDigest };
  const read = readLock(stateDir);
  if (!read.present) {
    if (!create) throw new StateIntegrityError(`${LOCK_FILE} is missing and this is not a fresh initialization: refusing to lock the current protocol/evaluator over existing state`, { integrity: "protocol_lock_missing" });
    const lock = { ...current, lockedAt: new Date().toISOString() };
    atomicWriteJson(path, lock);
    return { lock, problems: [], created: true };
  }
  const lock = read.lock;
  const problems = [];
  if (lock.protocolDigest !== current.protocolDigest) problems.push("protocol differs from the locked protocol");
  if (datasetDigest && lock.datasetDigest !== datasetDigest) problems.push("dataset split/manifest differs from the locked one");
  for (const [file, digest] of Object.entries(lock.evaluator)) if (current.evaluator[file] !== digest) problems.push(`evaluator file changed: ${file}`);
  for (const file of Object.keys(current.evaluator)) if (!(file in lock.evaluator)) problems.push(`evaluator file added: ${file}`);
  return { lock, problems, created: false };
}
