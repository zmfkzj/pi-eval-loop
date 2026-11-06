// ctrl-ablation-1: pure helpers of the controlled ablation driver (queue, harness identity, lock, statistics). No model calls here.
// The driver (run.mjs) and the analysis (analyze.mjs) import these; test/ctrl-ablation.test.mjs covers them.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRng } from "../../src/rng.mjs";
import { digestOf, ensureDir, sha256, treeDigest } from "../../src/util.mjs";
import { successOf } from "../../src/metrics.mjs";

export const EXPERIMENT_DIR = dirname(fileURLToPath(import.meta.url));
export const loadPrereg = (path = join(EXPERIMENT_DIR, "prereg.json")) => JSON.parse(readFileSync(path, "utf8"));

/**
 * The frozen run order: blocks (task, repeat) in seeded random order, every block holding one unit per arm in its own seeded
 * random order. Workers consume the flat list front to back, so arms interleave in time.
 */
export function buildQueue({ arms, tasks, repeats, seed }) {
  const rng = createRng(`${seed}:queue`);
  const blocks = [];
  for (const task of [...tasks].sort()) for (let repeat = 0; repeat < repeats; repeat++) blocks.push({ task, repeat });
  return rng.shuffle(blocks).flatMap(block => rng.shuffle([...arms].sort()).map(arm => ({ arm, task: block.task, repeat: block.repeat })));
}

/** Harness identity bound into every unit key: base commit plus the digest of the exact variant bytes (patch or prompt). */
export function harnessIdentity(arm, prereg, experimentDir = EXPERIMENT_DIR) {
  const content = arm.patch ? sha256(readFileSync(join(experimentDir, arm.patch))) : arm.appendSystemPrompt ? sha256(prereg[arm.appendSystemPrompt]) : null;
  const base = arm.kind === "orche" ? prereg.harnessBase.commit : "pure";
  return `${base}${arm.kind === "orche" ? `:${arm.mode}` : ""}${content ? `+${content.slice(0, 16)}` : ""}`;
}

/** Export the base commit of orche into `dir` and apply the arm's patch (no commit, no change to the orche checkout). */
export function buildHarness(arm, prereg, { stateDir, orcheDir, experimentDir = EXPERIMENT_DIR }) {
  const dir = join(stateDir, "harness", arm.id);
  if (!existsSync(join(dir, ".built"))) {
    rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    const tar = execFileSync("git", ["-C", orcheDir, "archive", prereg.harnessBase.commit, ...prereg.harnessBase.paths], { maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", dir], { input: tar });
    if (arm.patch) {
      // Outside any repository discovery: inside a checkout (the state directory lives in pi-eval-loop) `git apply` silently skips
      // paths outside the repository root. The reverse check then proves every hunk is in place.
      const git = (args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) } });
      git(["apply", "-p1", "--whitespace=nowarn", join(experimentDir, arm.patch)]);
      git(["apply", "-p1", "--reverse", "--check", join(experimentDir, arm.patch)]);
    }
    execFileSync("touch", [join(dir, ".built")]);
  }
  return { dir, digest: treeDigest(dir, { skip: [".built", "node_modules"] }) };
}

/** The harness object the evaluator/runner receives. */
export function harnessOf(arm, prereg, built) {
  const h = { id: arm.id, kind: arm.kind, commit: harnessIdentity(arm, prereg) };
  if (arm.kind === "orche") Object.assign(h, { dir: built.dir, mode: arm.mode });
  if (arm.appendSystemPrompt) h.appendSystemPrompt = prereg[arm.appendSystemPrompt];
  return h;
}

/** Files whose bytes define this experiment beyond the loop evaluator (driver, analysis, preregistration, variants). */
export function experimentFiles(experimentDir = EXPERIMENT_DIR) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (!/\.md$/.test(e.name) || e.name === "PREREGISTRATION.md") out.push(p); } };
  walk(experimentDir);
  return out.sort();
}

/** Compare a recorded lock with the current one; returns human-readable mismatches (empty = identical). */
export function lockMismatches(recorded, current) {
  const problems = [];
  for (const key of ["preregDigest", "envDigest", "queueDigest"]) if (recorded[key] !== current[key]) problems.push(`${key} changed`);
  for (const group of ["files", "harness", "tasks", "grading"]) {
    const a = recorded[group] ?? {}, b = current[group] ?? {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) problems.push(`${group}.${k} changed`);
  }
  return problems;
}

// ---------------------------------------------------------------- outcomes and statistics

/** Functional success: valid success without the integrity condition (completed, hidden pass, visible not failed). */
export const functionalOf = (r) => r.terminal_status === "completed" && r.hidden_test_pass === true && r.visible_test_pass !== false;
export const integrityFailOf = (r) => (r.integrity?.violations?.length ?? 0) > 0 || (r.integrity?.leakHits?.length ?? 0) > 0;
export const validOf = (r) => successOf(r);
export const INFRA = new Set(["infra_error", "model_unavailable"]);

/** Unbiased within-task variance estimate of a Bernoulli rate from k successes in r repeats (0 when r < 2). */
export const inconsistency = (k, r) => r < 2 ? 0 : (k * (r - k)) / (r * (r - 1));

/** Per arm and task: lists of 0/1 outcomes of `metric` in repeat order. */
export function tableOf(records, metric) {
  const t = {};
  for (const r of records) ((t[r.candidate_id] ??= {})[r.task_id] ??= []).push(metric(r) ? 1 : 0);
  return t;
}

export const mean = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;

/** Arm summary over its tasks: successes, units, rate, inconsistency, 3/3, mixed, 0/3. */
export function armSummary(byTask) {
  const tasks = Object.keys(byTask).sort();
  const ks = tasks.map(t => byTask[t].reduce((s, x) => s + x, 0)), rs = tasks.map(t => byTask[t].length);
  return {
    successes: ks.reduce((s, x) => s + x, 0), units: rs.reduce((s, x) => s + x, 0), rate: mean(tasks.map((_, i) => ks[i] / rs[i])),
    inconsistency: mean(tasks.map((_, i) => inconsistency(ks[i], rs[i]))),
    all: ks.filter((k, i) => k === rs[i]).length, mixed: ks.filter((k, i) => k > 0 && k < rs[i]).length, none: ks.filter(k => k === 0).length, tasks: tasks.length,
  };
}

/**
 * Paired task-level contrast of arm `a` minus arm `b` on the tasks both have: dRate (mean of per-task rate differences), dI (mean
 * of per-task inconsistency differences), task-cluster bootstrap 95% intervals, and a within-task label-swap randomization p value
 * of dRate (two-sided; swapping labels flips the sign of a task's difference when both arms have the same repeat count).
 */
export function contrast(tableA, tableB, { draws = 10000, perms = 20000, seed = "contrast" } = {}) {
  const tasks = Object.keys(tableA).filter(t => tableB[t]).sort();
  const rate = (xs) => mean(xs);
  const dR = tasks.map(t => rate(tableA[t]) - rate(tableB[t]));
  const dI = tasks.map(t => inconsistency(sum(tableA[t]), tableA[t].length) - inconsistency(sum(tableB[t]), tableB[t].length));
  const rng = createRng(`${seed}:boot`);
  const bootR = [], bootI = [];
  for (let d = 0; d < draws; d++) {
    let sR = 0, sI = 0;
    for (let i = 0; i < tasks.length; i++) { const j = rng.int(tasks.length); sR += dR[j]; sI += dI[j]; }
    bootR.push(sR / tasks.length); bootI.push(sI / tasks.length);
  }
  const q = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))]; };
  const obs = Math.abs(mean(dR));
  const prng = createRng(`${seed}:perm`);
  let hits = 0;
  for (let p = 0; p < perms; p++) {
    let s = 0;
    for (const d of dR) s += prng.next() < 0.5 ? -d : d;
    if (Math.abs(s / dR.length) >= obs - 1e-12) hits++;
  }
  return {
    tasks: tasks.length, dRate: mean(dR), dRateCI: [q(bootR, 0.025), q(bootR, 0.975)], dI: mean(dI), dICI: [q(bootI, 0.025), q(bootI, 0.975)],
    p: (hits + 1) / (perms + 1), better: dR.filter(x => x > 0).length, worse: dR.filter(x => x < 0).length,
  };
}
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** Holm adjustment of a map name -> p value. */
export function holm(ps) {
  const entries = Object.entries(ps).sort((a, b) => a[1] - b[1]);
  const out = {}; let running = 0;
  entries.forEach(([name, p], i) => { running = Math.max(running, Math.min(1, (entries.length - i) * p)); out[name] = running; });
  return out;
}

/** The preregistered single viability rule (§9). */
export function viable(c, integrity, { minGain = 0.037 } = {}) {
  return c.dRate >= minGain && c.dRateCI[0] > 0 && c.dI <= 0 && integrity.candidate <= integrity.stable && integrity.criticalOther === 0;
}

export const resolveFrom = (base, p) => resolve(base, p);
