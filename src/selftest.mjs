// Credential-free end-to-end self-test of the REAL pipeline: sandboxed Pi (pure, orche worktrees), endpoint gate, pinned-route
// proxy, sandboxed grader, integrity checks, worktree candidates, screening/development/holdout gates, adoption on local refs of a
// temporary umbrella, rollback. The model is the faux upstream: its runs are marked simulated and prove plumbing, not performance.
// Nothing is written to the user's repositories: orche is a temporary shared clone and the umbrella a temporary repository.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_PROTOCOL, merge, UMBRELLA } from "./protocol.mjs";
import { environmentDigest, hostEnvironment, prerequisites } from "./sandbox.mjs";
import { loadLocal, loadSuite, sealOf } from "./datasets.mjs";
import { realBackend } from "./evaluator.mjs";
import { validateGrader } from "./grader.mjs";
import { runChecks } from "./checks.mjs";
import { Loop } from "./loop.mjs";
import { scriptedProposer } from "./proposer.mjs";
import { SKILL_MARKER, startFauxUpstream } from "./faux-upstream.mjs";
import { writeReport } from "./report.mjs";
import { gitlinks } from "./deploy.mjs";

const TRAIN_DEV = ["a1-rounding", "a2-discount-codes", "b1-static-traversal", "b2-patch-endpoint", "c1-timezone", "c2-since-flag-ko", "d3-money-migration-ko", "d7-config-reload"];
const HOLDOUT = ["a6-typo-message", "b3-pagination", "c4-malformed-lines", "c6-csv-export", "p1-ticket-batch", "p3-library-features-ko"];
const git = (cwd, args) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "selftest", GIT_AUTHOR_EMAIL: "s@l", GIT_COMMITTER_NAME: "selftest", GIT_COMMITTER_EMAIL: "s@l" }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

/** Add the faux skill marker as one more guideline of orche's edit tool (a real one-line src change the faux model reacts to). */
export function markerEdit(dir) {
  const file = join(dir, "src/tools/edit.ts");
  const text = readFileSync(file, "utf8");
  const anchor = '"Always read a file before editing it; copy anchors verbatim from read output.",';
  if (!text.includes(anchor)) throw new Error("selftest: edit tool guideline not found in src/tools/edit.ts");
  writeFileSync(file, text.replace(anchor, `${anchor}\n      ${JSON.stringify(SKILL_MARKER)},`));
}

export async function selftest({ log = () => {}, keep = false, root } = {}) {
  const env0 = hostEnvironment();
  const prereq = (await prerequisites(env0)).filter(p => ["bwrap", "bwrap-namespaces", "pi-cli", "provider", "orche", "git"].includes(p.name));
  if (prereq.some(p => !p.ok)) return { ok: false, summary: { verdict: "BLOCKED", missing: prereq.filter(p => !p.ok) } };
  root ??= mkdtempSync(join(tmpdir(), "el-selftest-"));
  const started = Date.now();
  // Temporary umbrella with a shared clone of orche (its own refs; objects borrowed read-only).
  const umbrella = join(root, "umbrella");
  mkdirSync(umbrella, { recursive: true });
  git(umbrella, ["init", "-q", "-b", "main"]);
  git(umbrella, ["clone", "-q", "--shared", join(UMBRELLA, "orche"), "orche"]);
  const orche = join(umbrella, "orche");
  mkdirSync(join(orche, "node_modules"), { recursive: true });
  writeFileSync(join(umbrella, "README.md"), "selftest umbrella\n");
  git(umbrella, ["add", "README.md"]);
  git(umbrella, ["update-index", "--add", "--cacheinfo", `160000,${git(orche, ["rev-parse", "HEAD"])},orche`]);
  git(umbrella, ["-c", "commit.gpgsign=false", "commit", "-qm", "selftest umbrella"]);
  // Datasets: suite tasks for train/dev, renamed copies (new ids and families) sealed as the holdout.
  const suite = loadSuite(join(UMBRELLA, "orche/fixtures/suite"));
  const tasks = suite.filter(t => TRAIN_DEV.includes(t.id));
  const holdoutDir = join(root, "holdout");
  for (const id of HOLDOUT) {
    const t = suite.find(x => x.id === id);
    const dest = join(holdoutDir, `st-${id}`);
    cpSync(t.dir, dest, { recursive: true });
    writeFileSync(join(dest, "task.json"), JSON.stringify({ id: `st-${id}`, family: `selftest-${id}`, tier: t.tier, instruction: t.instruction, provenance: "selftest-copy" }));
  }
  writeFileSync(join(holdoutDir, "SEAL.json"), JSON.stringify({ selftest: true, ...sealOf(holdoutDir) }));
  const holdoutTasks = loadLocal(holdoutDir);
  const faux = await startFauxUpstream({ tasks: [...tasks, ...holdoutTasks].map(t => ({ ...t, policy: { solve: 0.3, solveWithMarker: 0.95 } })), model: DEFAULT_PROTOCOL.route.model, seed: "selftest" });
  const env = { ...env0, upstream: faux.url, keyOverride: "selftest-faux-key" };
  const protocol = merge(structuredClone(DEFAULT_PROTOCOL), {
    seed: "pi-eval-loop-selftest", target: { mode: "direct" }, parallelism: 4, unit: { wallMs: 120_000, graderMs: 60_000 },
    screening: { tasks: 4 }, holdout: { acceptedProvenance: ["selftest-copy"] }, baselines: { multiAttempt: { k: 2 } },
    watchdog: { noProgressCandidates: 2, maxCandidatesPerCycle: 4 },
  });
  const backend = realBackend(env);
  const run = backend.run;
  backend.simulated = true;
  backend.run = async (input) => { const r = await run(input); r.simulated = true; return r; };
  const proposer = scriptedProposer([
    { hypothesis: "Tell the agent to re-read every requirement before finishing", targetFailureClass: "termination-premature", edit: markerEdit },
    { hypothesis: "Edit the test suite to make it pass", targetFailureClass: "termination-premature", edit: (dir) => writeFileSync(join(dir, "test/extension/eval-loop-selftest.test.ts"), "// must be refused: protected path\n") },
    { hypothesis: "Add a harmless comment", targetFailureClass: "termination-premature", edit: (dir) => { const f = join(dir, "src/extension/mode.ts"); writeFileSync(f, `${readFileSync(f, "utf8")}\n// selftest neutral change\n`); } },
  ]);
  const stateDir = join(root, "state");
  const loop = new Loop({
    stateDir, protocol, umbrella, orche, env, envDigest: environmentDigest(env, protocol.route).digest, backend, proposer, log,
    prerequisites: async () => prereq,
    validateGrader: async (task) => { const scratch = mkdtempSync(join(tmpdir(), "el-v-")); try { return await validateGrader({ task, scratch, env }); } finally { rmSync(scratch, { recursive: true, force: true }); } },
    checks: (worktree, which, logDir) => runChecks({ worktree, env, which, logDir }),
    datasets: { tasks, holdoutDir, holdoutTasks },
  });
  let state;
  try { state = await loop.runCycle(); } finally { await faux.stop(); }
  const report = writeReport(stateDir);
  const candidates = loop.archive.all().filter(c => c.origin === "proposer").map(c => ({ id: c.id, status: c.status, hypothesis: c.hypothesis?.text, screening: c.screening?.support, reason: c.decisions.at(-1)?.reason?.slice(0, 200) }));
  const adoptedRef = (() => { try { return git(orche, ["rev-parse", "refs/heads/eval-loop/stable"]); } catch { return null; } })();
  const umbrellaLink = adoptedRef ? gitlinks(umbrella, "refs/heads/eval-loop/stable").orche : null;
  let rollback = null;
  if (adoptedRef) rollback = loop.deployer.rollback({ reason: "selftest rollback check" }).problems;
  const summary = { verdict: state.final?.verdict, phase: state.phase, selected: state.selection?.selected, candidates, adoptedRef, umbrellaGitlinkMatches: adoptedRef ? umbrellaLink === adoptedRef : null, rollbackProblems: rollback, runs: loop.records().length, ledgerIntact: loop.evaluator.ledger.verify().length === 0, report: report.path, seconds: Math.round((Date.now() - started) / 1000), root };
  const ok = state.final?.verdict === "ADOPT" && summary.umbrellaGitlinkMatches === true && Array.isArray(rollback) && rollback.length === 0 && candidates.some(c => c.status === "rejected_patch") && summary.ledgerIntact;
  if (!keep && ok) rmSync(root, { recursive: true, force: true });
  return { ok, summary, state };
}
export { existsSync };
