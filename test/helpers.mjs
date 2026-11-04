// Test fixtures: a temporary umbrella repository with an `orche` gitlink and checkout, synthetic tasks, a sealed holdout, and a
// simulated backend whose success probability depends on the candidate worktree's src/skill.txt.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROTOCOL, merge } from "../src/protocol.mjs";
import { sealOf } from "../src/datasets.mjs";
import { simulatedBackend } from "../src/evaluator.mjs";
import { Loop } from "../src/loop.mjs";
import { scriptedProposer } from "../src/proposer.mjs";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@l", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@l" };
export const sh = (cwd, args) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

export function tempDir(prefix = "el-test-") { return mkdtempSync(join(process.env.EL_TEST_TMP ?? tmpdir(), prefix)); }

/** Umbrella repo with an orche gitlink and a real orche checkout at <umbrella>/orche. */
export function makeUmbrella(root) {
  const orche = join(root, "orche-origin");
  mkdirSync(join(orche, "src"), { recursive: true });
  writeFileSync(join(orche, "src/skill.txt"), "base\n");
  writeFileSync(join(orche, "src/prompt.ts"), "export const PROMPT = \"work carefully\";\n");
  writeFileSync(join(orche, ".gitignore"), "node_modules/\n");
  sh(orche, ["init", "-q", "-b", "master"]); sh(orche, ["add", "-A"]); sh(orche, ["-c", "commit.gpgsign=false", "commit", "-qm", "orche base"]);
  const umbrella = join(root, "umbrella");
  mkdirSync(umbrella);
  sh(umbrella, ["init", "-q", "-b", "main"]);
  writeFileSync(join(umbrella, "README.md"), "umbrella\n");
  sh(umbrella, ["clone", "-q", orche, "orche"]);
  mkdirSync(join(umbrella, "orche/node_modules"), { recursive: true });
  const sha = sh(join(umbrella, "orche"), ["rev-parse", "HEAD"]);
  sh(umbrella, ["add", "README.md"]);
  sh(umbrella, ["update-index", "--add", "--cacheinfo", `160000,${sha},orche`]);
  sh(umbrella, ["-c", "commit.gpgsign=false", "commit", "-qm", "umbrella base"]);
  return { umbrella, orche: join(umbrella, "orche"), base: sha };
}

/** Synthetic task directories (repo/ only; the simulated backend never runs them). */
export function makeTasks(root, specs) {
  return specs.map(([id, family, tier]) => {
    const dir = join(root, "tasks", id);
    mkdirSync(join(dir, "repo/src"), { recursive: true });
    writeFileSync(join(dir, "repo/src/index.js"), `export const id = ${JSON.stringify(id)};\n`);
    return { id, source: "test", dir, repo: join(dir, "repo"), hidden: undefined, family, tier, hard: tier === "hard", instruction: `Solve ${id}`, timeoutSec: 60, provenance: "external" };
  });
}

export function makeHoldout(root, specs) {
  const dir = join(root, "holdout");
  const tasks = specs.map(([id, family, tier]) => {
    const tdir = join(dir, id);
    mkdirSync(join(tdir, "repo/src"), { recursive: true });
    writeFileSync(join(tdir, "repo/src/index.js"), `export const id = ${JSON.stringify(id)};\n`);
    writeFileSync(join(tdir, "task.json"), JSON.stringify({ id, family, tier, instruction: `Solve ${id}`, provenance: "external" }));
    return { id, source: "local", dir: tdir, repo: join(tdir, "repo"), family, tier, hard: tier === "hard", instruction: `Solve ${id}`, timeoutSec: 60, provenance: "external" };
  });
  writeFileSync(join(dir, "SEAL.json"), JSON.stringify({ createdAt: "test", ...sealOf(dir) }));
  return { dir, tasks };
}

export const TRAIN_DEV = [["t1", "fa", "easy"], ["t2", "fa", "hard"], ["t3", "fb", "medium"], ["t4", "fb", "hard"], ["t5", "fc", "easy"], ["t6", "fc", "hard"], ["t7", "fd", "medium"], ["t8", "fd", "hard"], ["t9", "fe", "easy"], ["t10", "fe", "hard"]];
export const HOLDOUT = [["h1", "ha", "easy"], ["h2", "hb", "hard"], ["h3", "hc", "medium"], ["h4", "hd", "hard"], ["h5", "he", "easy"], ["h6", "hf", "hard"]];

/** p by harness: stable/pure 0.35, multi 0.45, candidate worktrees by src/skill.txt: good 0.95, bad 0.1, crash -> harness crash. */
export function skillOf(harness) {
  if (harness.kind === "pure") return { p: 0.35 };
  if (harness.kind === "multi") return { p: 0.45 };
  const text = existsSync(join(harness.dir ?? "", "src/skill.txt")) ? readFileSync(join(harness.dir, "src/skill.txt"), "utf8").trim() : "base";
  if (text.includes("crash")) return { p: 0, crash: true };
  if (text.includes("good")) return { p: 0.95 };
  if (text.includes("bad")) return { p: 0.1 };
  if (text.includes("same")) return { p: 0.35 };
  return { p: 0.35 };
}

export function testProtocol(overrides = {}) {
  return merge(merge(structuredClone(DEFAULT_PROTOCOL), {
    bootstrap: { draws: 2000 }, parallelism: 2, screening: { tasks: 4 }, holdout: { minTasks: 6, minFamilies: 4, acceptedProvenance: ["external"] },
    watchdog: { noProgressCandidates: 3, maxCandidatesPerCycle: 6 }, baselines: { multiAttempt: { k: 2 } },
  }), overrides);
}

export const edit = (text) => (dir) => writeFileSync(join(dir, "src/skill.txt"), `${text}\n`);

export function makeLoop({ root, protocol = testProtocol(), entries, skill = skillOf, strategy = "pareto", prerequisites, checks, backend, stateName = "state", fixtures, fault }) {
  const fx = fixtures ?? (() => { const u = makeUmbrella(root); const tasks = makeTasks(root, TRAIN_DEV); const holdout = makeHoldout(root, HOLDOUT); return { ...u, tasks, holdout }; })();
  const loop = new Loop({
    stateDir: join(root, stateName), protocol, strategy, umbrella: fx.umbrella, orche: fx.orche, envDigest: "test-env", log: () => {},
    backend: backend ?? simulatedBackend({ skill: (h, t) => skill(h, t), seed: "test" }),
    proposer: scriptedProposer(entries ?? []), prerequisites: prerequisites ?? (async () => [{ name: "sim", ok: true }]),
    checks: checks ?? (async () => passingChecks()),
    datasets: { tasks: fx.tasks, holdoutDir: fx.holdout.dir, holdoutTasks: fx.holdout.tasks }, fault,
  });
  return { loop, fx };
}
export { rmSync };

/** A check result as runChecks reports it for a clean orche suite (typecheck plus a vitest summary). */
export const passingChecks = (summary = "      Tests  10 passed (10)") => ({ pass: true, results: { typecheck: { pass: true, exit: 0 }, test: { pass: true, exit: 0, failing: [], tail: `\n${summary}\n` } } });
