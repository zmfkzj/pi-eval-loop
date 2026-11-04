// Task sources, family-grouped train/dev/holdout splits, exposure scanning and the sealed holdout with its durable use ledger.
//
// Task interface (extensible beyond coding: any task with a mechanical, independent grader fits):
//   { id, source, dir, repo, hidden?, customGrader?, family, tier, hard, instruction, timeoutSec, provenance }
// Tasks without a mechanical grader (rubric/LLM-judged) are NOT loaded: an LLM verdict alone never counts as success.
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { Ledger, digestOf, ensureDir, sha256, walkFiles } from "./util.mjs";
import { createRng } from "./rng.mjs";

const TIER_BY_PREFIX = { a: "easy", b: "medium", c: "medium", d: "hard", p: "hard" };
/** Families the package name alone would split: the p-series share one generator, so they stay one family. */
const FAMILY_OVERRIDES = { "p1-ticket-batch": "p-series", "p2-handler-migration": "p-series", "p3-library-features-ko": "p-series" };

/** orche's fixtures/suite (deterministic tasks only: hidden node tests or a custom mechanical grade.mjs). */
export function loadSuite(suiteDir) {
  const tasks = [];
  for (const id of readdirSync(suiteDir).sort()) {
    const dir = join(suiteDir, id);
    if (!existsSync(join(dir, "task.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
    if (manifest.grading?.rubric) continue;
    const hidden = manifest.grading?.hiddenTests && existsSync(join(dir, "hidden")) ? join(dir, "hidden") : undefined;
    const customGrader = manifest.grading?.custom && existsSync(join(dir, "grade.mjs")) ? join(dir, "grade.mjs") : undefined;
    if (!hidden && !customGrader) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "repo/package.json"), "utf8"));
    const tier = TIER_BY_PREFIX[id[0]] ?? "medium";
    tasks.push({ id, source: "suite", dir, repo: join(dir, "repo"), hidden, customGrader, family: FAMILY_OVERRIDES[id] ?? `pkg:${pkg.name}`, tier, hard: tier === "hard", instruction: manifest.instruction, timeoutSec: manifest.timeoutSec, provenance: "orche-fixtures-suite" });
  }
  return tasks;
}

/** A local dataset directory (same layout: <id>/{task.json, repo/, hidden/, reference/}; task.json names family/tier/provenance). */
export function loadLocal(datasetDir) {
  const tasks = [];
  for (const id of readdirSync(datasetDir).sort()) {
    const dir = join(datasetDir, id);
    if (!existsSync(join(dir, "task.json"))) continue;
    const m = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
    if (m.id !== id) throw new Error(`${dir}: task.json id ${m.id} != directory`);
    if (!m.family || !m.tier || !m.instruction || !m.provenance) throw new Error(`${dir}: task.json needs family, tier, instruction, provenance`);
    tasks.push({ id, source: "local", dir, repo: join(dir, "repo"), hidden: existsSync(join(dir, "hidden")) ? join(dir, "hidden") : undefined, customGrader: existsSync(join(dir, "grade.mjs")) ? join(dir, "grade.mjs") : undefined, family: m.family, tier: m.tier, hard: m.tier === "hard", instruction: m.instruction, timeoutSec: m.timeoutSec ?? 900, provenance: m.provenance });
  }
  return tasks;
}

/**
 * Deterministic family-grouped split: families are ordered by a seeded hash and dealt to train until its share of tasks is met,
 * per tier, so every tier appears in both splits when it can. No family is ever in two splits.
 */
export function splitByFamily(tasks, { seed, trainShare }) {
  const families = new Map();
  for (const t of tasks) { if (!families.has(t.family)) families.set(t.family, []); families.get(t.family).push(t); }
  const tierOf = (members) => members.some(t => t.hard) ? "hard" : members.some(t => t.tier === "medium") ? "medium" : "easy";
  const byTier = new Map();
  for (const [family, members] of families) { const tier = tierOf(members); if (!byTier.has(tier)) byTier.set(tier, []); byTier.get(tier).push({ family, members }); }
  const split = { train: [], dev: [] };
  for (const tier of [...byTier.keys()].sort()) {
    const groups = byTier.get(tier).sort((x, y) => sha256(`${seed}:${x.family}`).localeCompare(sha256(`${seed}:${y.family}`)));
    const total = groups.reduce((s, g) => s + g.members.length, 0);
    let train = 0;
    groups.forEach((g, i) => {
      // A single-family tier goes to dev (comparisons need it); otherwise train fills to its share and dev keeps at least one family.
      const devHasOne = groups.slice(0, i).some(x => !x.toTrain);
      let toTrain = groups.length > 1 && (train === 0 || train + g.members.length / 2 <= total * trainShare);
      if (i === groups.length - 1 && !devHasOne) toTrain = false;
      g.toTrain = toTrain;
      if (toTrain) train += g.members.length;
      (toTrain ? split.train : split.dev).push(...g.members.map(t => t.id));
    });
  }
  split.train.sort(); split.dev.sort();
  return split;
}

/** Disjointness checks across splits (task ids and families). */
export function validateSplits(tasksById, splits) {
  const problems = [];
  const names = Object.keys(splits);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = splits[names[i]], b = splits[names[j]];
    for (const id of a) if (b.includes(id)) problems.push(`task ${id} in ${names[i]} and ${names[j]}`);
    const fa = new Set(a.map(id => tasksById[id]?.family)), fb = new Set(b.map(id => tasksById[id]?.family));
    for (const f of fa) if (fb.has(f)) problems.push(`family ${f} in ${names[i]} and ${names[j]}`);
  }
  for (const [name, ids] of Object.entries(splits)) for (const id of ids) if (!tasksById[id]) problems.push(`unknown task ${id} in ${name}`);
  return problems;
}

/**
 * Model-free exposure scan: a task id named in earlier experiment plans, results directory names, docs, or the eval-loop's own use
 * ledgers counts as exposed (used before) and cannot be a NEW independent holdout.
 */
export function exposureScan(ids, { orcheDir, extraTexts = [] }) {
  const hits = Object.fromEntries(ids.map(id => [id, []]));
  const texts = [...extraTexts];
  const addTextFiles = (root, filter, depth = 5) => {
    if (!existsSync(root)) return;
    const visit = (dir, d) => {
      if (d > depth) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== ".git") { texts.push({ where: relative(orcheDir, path), text: entry.name }); visit(path, d + 1); } }
        else if (entry.isFile() && filter(entry.name) && statSync(path).size < 4 * 1024 * 1024) texts.push({ where: relative(orcheDir, path), text: readFileSync(path, "utf8") });
      }
    };
    visit(root, 0);
  };
  addTextFiles(join(orcheDir, "experiments"), name => /\.(json|ts|md)$/.test(name), 4);
  addTextFiles(join(orcheDir, "docs"), name => name.endsWith(".md"), 1);
  addTextFiles(join(orcheDir, "results"), () => false, 4); // directory names only (results are large)
  for (const { where, text } of texts) for (const id of ids) if (text.includes(id)) hits[id].push(where);
  return Object.fromEntries(ids.map(id => [id, { exposed: hits[id].length > 0, hits: hits[id].slice(0, 10), count: hits[id].length }]));
}

/** Seal of a dataset directory: sha256 of every file (committed before any search; verified before every holdout use). */
export function sealOf(datasetDir) {
  const files = {};
  const symlinks = [];
  for (const f of walkFiles(datasetDir, { skip: [] })) {
    if (["SEAL.json", "USES.jsonl"].includes(f.path)) continue;
    if (f.symlink !== undefined) { symlinks.push(`${f.path} -> ${f.symlink}`); continue; }
    files[f.path] = sha256(readFileSync(join(datasetDir, f.path)));
  }
  return { files, digest: digestOf(files), symlinks };
}
export function verifySeal(datasetDir) {
  const sealPath = join(datasetDir, "SEAL.json");
  if (!existsSync(sealPath)) return { ok: false, why: "no SEAL.json" };
  const seal = JSON.parse(readFileSync(sealPath, "utf8"));
  const now = sealOf(datasetDir);
  // A sealed dataset holds regular files only: a symlink could redirect a grader to unsealed material.
  if (now.symlinks.length) return { ok: false, why: `symlink(s) in the sealed dataset: ${now.symlinks.slice(0, 5).join(", ")}`, seal };
  if (now.digest !== seal.digest) {
    const changed = Object.keys({ ...seal.files, ...now.files }).filter(path => seal.files[path] !== now.files[path]);
    return { ok: false, why: `dataset changed since sealing: ${changed.slice(0, 5).join(", ")}`, seal };
  }
  return { ok: true, seal };
}

/** Holdout use ledger (next to the dataset, so every state directory sees the same consumption). */
export const holdoutLedger = (datasetDir, path) => new Ledger(path ?? join(datasetDir, "USES.jsonl"));

/**
 * Is this holdout still independent? Sealed, accepted provenance, not exposed by earlier experiments, and used fewer than maxUses
 * times (a use is recorded BEFORE its first run starts, so a crash still consumes it).
 */
export function holdoutStatus(tasks, datasetDir, protocol, { orcheDir, ledgerPath } = {}) {
  const reasons = [];
  const seal = verifySeal(datasetDir);
  if (!seal.ok) reasons.push(seal.why);
  const badProvenance = tasks.filter(t => !protocol.holdout.acceptedProvenance.includes(t.provenance));
  if (badProvenance.length) reasons.push(`provenance not accepted for independent claims: ${badProvenance.map(t => `${t.id}=${t.provenance}`).join(", ")}`);
  const exposure = exposureScan(tasks.map(t => t.id), { orcheDir });
  const exposed = Object.entries(exposure).filter(([, e]) => e.exposed).map(([id]) => id);
  if (exposed.length) reasons.push(`exposed in earlier experiments: ${exposed.join(", ")}`);
  const uses = holdoutLedger(datasetDir, ledgerPath).records();
  const chain = holdoutLedger(datasetDir, ledgerPath).verify();
  if (chain.length) reasons.push(`holdout use ledger tampered: ${chain.join("; ")}`);
  if (uses.length >= protocol.holdout.maxUses) reasons.push(`holdout already used ${uses.length} time(s) (max ${protocol.holdout.maxUses}): no longer independent`);
  return { independent: reasons.length === 0, why: reasons.join("; ") || "sealed, unexposed, unused", uses: uses.length, exposure, seal: seal.seal?.digest };
}

/** A fresh workspace with only the visible repository, committed once as the starting state (fixed identity and date). */
export function stageWorkspace(task, dir) {
  ensureDir(dir);
  cpSync(task.repo, dir, { recursive: true, filter: path => !path.endsWith("/.git") });
  const env = { ...process.env, GIT_AUTHOR_NAME: "eval-loop", GIT_AUTHOR_EMAIL: "eval-loop@localhost", GIT_COMMITTER_NAME: "eval-loop", GIT_COMMITTER_EMAIL: "eval-loop@localhost", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  const git = (args) => execFileSync("git", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet"]); git(["add", "-A", "--force"]); git(["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Starting state"]);
  return dir;
}

export const taskDigest = (task) => digestOf({ id: task.id, files: walkFiles(task.dir).map(f => f.symlink ?? sha256(readFileSync(join(task.dir, f.path)))) });

/** Screening mini-batch: seeded sample of train tasks, at least one hard task when the train split has one. */
export function screeningBatch(trainIds, tasksById, size, seed) {
  const rng = createRng(seed);
  const shuffled = rng.shuffle([...trainIds].sort());
  const batch = shuffled.slice(0, Math.min(size, shuffled.length));
  if (!batch.some(id => tasksById[id].hard)) { const hard = shuffled.find(id => tasksById[id].hard); if (hard) batch[batch.length - 1] = hard; }
  return batch.sort();
}
