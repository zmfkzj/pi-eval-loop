// Independent grader. Candidate code is only ever executed inside a fresh bubblewrap sandbox (no network, host hidden, cleared
// environment); hidden tests are copied into a disposable grading copy, never into the agent's workspace. Pass/fail comes from
// the test runner's exit code plus TAP counts read from the controller's pipe, and the hidden count must equal the count the
// reference solution produced when the grader was validated (a candidate that exits early or skips tests cannot pass).
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ensureDir } from "./util.mjs";
import { runSandboxed } from "./sandbox.mjs";

export const GRADE = "/tmp/grade";
const COPY_SKIP = /(^|\/)(\.git|node_modules)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/;

export function testFilesOf(root) {
  const out = [];
  const visit = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) { if (!["node_modules", ".git"].includes(e.name)) visit(p); } else if (e.isFile() && TEST_FILE.test(e.name)) out.push(relative(root, p)); } };
  if (existsSync(root)) visit(root);
  return out.sort();
}

/** TAP summary of `node --test --test-reporter=tap`: the LAST summary lines (forged earlier lines do not count). */
export function parseTap(text) {
  const last = (name) => { const all = [...text.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm"))]; return all.length ? Number(all.at(-1)[1]) : undefined; };
  const failing = [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1].trim());
  return { tests: last("tests"), passed: last("pass"), failed: last("fail"), cancelled: last("cancelled"), skipped: last("skipped"), todo: last("todo"), failing };
}

async function sandboxNode(env, gradeRoot, cwdInside, args, { timeoutMs, extraBinds = [] }) {
  const tmp = ensureDir(join(gradeRoot, "tmp"));
  const binds = [{ from: env.nodeDir }, { from: gradeRoot, to: GRADE, rw: true }, ...extraBinds];
  const run = await runSandboxed({ binds, env: { PATH: `${env.nodeDir}/bin:/usr/bin:/bin`, HOME: `${GRADE}/tmp`, TMPDIR: `${GRADE}/tmp`, LANG: "C.UTF-8", TZ: "UTC", NODE_OPTIONS: "" }, cwd: cwdInside, command: [env.node, ...args] }, { guardMs: timeoutMs, keep: 4 * 1024 * 1024 });
  void tmp;
  return run;
}

function copyInto(from, to) { cpSync(from, to, { recursive: true, filter: path => !COPY_SKIP.test(path) }); }

/**
 * Grade a final workspace. Returns { visible, hidden, custom, correctness, error? } where each part has { pass, ...counts }.
 * `expected` = { hiddenTests } from validateGrader; `baselineFailing` = visible test names failing in the original repository.
 */
export async function gradeWorkspace({ task, workspace, scratch, env, timeoutMs = 120_000, expected = {}, baselineFailing = [] }) {
  const root = ensureDir(scratch);
  rmSync(root, { recursive: true, force: true }); ensureDir(root);
  const result = { visible: null, hidden: null, custom: null, correctness: 0 };
  try {
    // Visible suite of the workspace as the agent left it.
    copyInto(workspace, join(root, "V"));
    const vRun = await sandboxNode(env, root, `${GRADE}/V`, ["--test", "--test-reporter=tap"], { timeoutMs });
    const vTap = parseTap(vRun.text);
    const regressions = vTap.failing.filter(name => !baselineFailing.includes(name));
    result.visible = { pass: vRun.code === 0 && !vRun.guardFired && (vTap.failed ?? 1) === 0, exit: vRun.code, timeout: vRun.guardFired, ...vTap, regressions };
    if (task.hidden) {
      copyInto(workspace, join(root, "H"));
      cpSync(task.hidden, join(root, "H"), { recursive: true, force: true });
      const files = testFilesOf(task.hidden);
      const hRun = await sandboxNode(env, root, `${GRADE}/H`, ["--test", "--test-reporter=tap", ...files], { timeoutMs });
      const hTap = parseTap(hRun.text);
      const countOk = expected.hiddenTests === undefined || hTap.tests === expected.hiddenTests;
      result.hidden = { pass: hRun.code === 0 && !hRun.guardFired && (hTap.failed ?? 1) === 0 && (hTap.passed ?? 0) > 0 && (hTap.cancelled ?? 0) === 0 && countOk, exit: hRun.code, timeout: hRun.guardFired, files, expectedTests: expected.hiddenTests, countOk, ...hTap };
      result.correctness = hTap.tests ? Math.max(0, Math.min(1, (hTap.passed ?? 0) / Math.max(hTap.tests, expected.hiddenTests ?? 0))) : 0;
    }
    if (task.customGrader) {
      copyInto(workspace, join(root, "C"));
      const cRun = await sandboxNode(env, root, GRADE, ["/opt/grader/task/grade.mjs", `${GRADE}/C`], { timeoutMs, extraBinds: [{ from: task.dir, to: "/opt/grader/task" }] });
      let verdict; for (const line of cRun.text.trim().split("\n").reverse()) { try { verdict = JSON.parse(line); break; } catch { /* not the verdict */ } }
      result.custom = { pass: cRun.code === 0 && !cRun.guardFired && verdict?.passed === true, exit: cRun.code, timeout: cRun.guardFired, verdict };
      if (!task.hidden) result.correctness = result.custom.pass ? 1 : 0;
      else result.correctness = (result.correctness + (result.custom.pass ? 1 : 0)) / 2;
    }
    result.hiddenPass = [result.hidden, result.custom].filter(Boolean).every(part => part.pass);
    return result;
  } catch (error) {
    return { ...result, error: String(error?.stack ?? error).slice(0, 2000), hiddenPass: false };
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Grader validation (before any evaluation): the ORIGINAL repository must fail the hidden grading and the reference solution must
 * pass it; records the reference hidden test count and the original's failing visible tests.
 */
export async function validateGrader({ task, scratch, env }) {
  const original = ensureDir(join(scratch, "original"));
  copyInto(task.repo, original);
  const base = await gradeWorkspace({ task, workspace: original, scratch: join(scratch, "g1"), env });
  const ref = ensureDir(join(scratch, "reference"));
  copyInto(task.repo, ref);
  if (existsSync(join(task.dir, "reference"))) cpSync(join(task.dir, "reference"), ref, { recursive: true, force: true });
  const good = await gradeWorkspace({ task, workspace: ref, scratch: join(scratch, "g2"), env });
  rmSync(scratch, { recursive: true, force: true });
  const problems = [];
  if (base.error || good.error) problems.push(`grader error: ${base.error ?? good.error}`);
  if (base.hiddenPass) problems.push("the original repository already passes the hidden grading");
  if (!good.hiddenPass) problems.push(`the reference solution does not pass the hidden grading (${JSON.stringify({ hidden: good.hidden && { pass: good.hidden.pass, failed: good.hidden.failed, failing: good.hidden.failing?.slice(0, 3) }, custom: good.custom?.verdict })})`);
  return { ok: problems.length === 0, problems, expected: { hiddenTests: good.hidden?.tests }, baselineFailing: base.visible?.failing ?? [], referenceVisiblePass: good.visible?.pass, originalHidden: base.hidden && { pass: base.hidden.pass, failing: base.hidden.failing.length } };
}

export const dirSize = (p) => { let n = 0; const visit = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const q = join(d, e.name); if (e.isDirectory()) visit(q); else n += statSync(q).size; } }; if (existsSync(p)) visit(p); return n; };
