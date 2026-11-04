// The candidate's own relevant checks (orche typecheck and test suite), run on the candidate worktree inside the sandbox (no
// network, host hidden) with orche's installed dependencies bound read-only. A candidate that breaks them is a critical failure.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "./util.mjs";
import { runSandboxed } from "./sandbox.mjs";

export const CHECKS = {
  typecheck: ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "."],
  test: ["node_modules/vitest/vitest.mjs", "run", "--reporter=dot"],
};

export async function runChecks({ worktree, env, which = ["typecheck"], logDir, timeoutMs = 20 * 60_000 }) {
  ensureDir(logDir);
  const results = {};
  for (const name of which) {
    const home = mkdtempSync(join(tmpdir(), "el-c-"));
    // Vite/vitest write their config bundle and cache inside node_modules: give them private writable directories.
    const scratchBinds = [".vite", ".vite-temp"].filter(name => existsSync(join(env.orche, "node_modules", name))).map(name => ({ from: ensureDir(join(home, name)), to: `/tmp/check/orche/node_modules/${name}`, rw: true }));
    const run = await runSandboxed({
      binds: [{ from: env.nodeDir }, { from: worktree, to: "/tmp/check/orche", rw: true }, { from: join(env.orche, "node_modules"), to: "/tmp/check/orche/node_modules" }, ...scratchBinds, { from: home, to: "/tmp/check/home", rw: true }],
      env: { PATH: `${env.nodeDir}/bin:/usr/bin:/bin`, HOME: "/tmp/check/home", TMPDIR: "/tmp/check/home", LANG: "C.UTF-8", TZ: "UTC", CI: "1", PI_OFFLINE: "1" },
      cwd: "/tmp/check/orche", command: [env.node, ...CHECKS[name]],
    }, { guardMs: timeoutMs, keep: 256 * 1024 });
    rmSync(home, { recursive: true, force: true });
    writeFileSync(join(logDir, `${name}.log`), run.text);
    const clean = run.text.replace(/\x1b\[[0-9;]*m/g, "");
    const failing = [...new Set([...clean.matchAll(/^ FAIL {1,2}(.+)$/gm)].map(m => m[1].trim()))];
    results[name] = { pass: run.code === 0 && !run.guardFired, exit: run.code, timeout: run.guardFired, ms: run.ms, failing, tail: clean.slice(-1500) };
  }
  return { pass: Object.values(results).every(r => r.pass), results };
}

/** Vitest summary counts ("Tests  9 failed | 3006 passed | 30 skipped (3045)"); undefined when absent. */
export function vitestSummary(text) {
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, "");
  const line = [...clean.matchAll(/^\s*Tests\s+(.+\(\d+\))\s*$/gm)].at(-1)?.[1];
  if (!line) return undefined;
  const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  return { failed: count("failed"), passed: count("passed"), skipped: count("skipped"), total: Number(/\((\d+)\)/.exec(line)[1]) };
}

/**
 * Relevant-check gate for adoption, FAIL-CLOSED: the candidate's typecheck must pass; its test run must exist, finish within the
 * guard and print a parsable summary; it must run at least as many tests and pass at least as many as the stable harness in the SAME
 * sandboxed environment (an early exit or skipped tests cannot pass), and it may not fail any test that passes for stable. Tests that
 * fail for both (they need untracked local results, ripgrep or git metadata) are reported as environment failures, never hidden.
 */
export function compareChecks(stable, candidate) {
  const problems = [];
  const cand = candidate?.results ?? {}, base = stable?.results ?? {};
  if (!cand.typecheck?.pass) problems.push(cand.typecheck ? "candidate typecheck fails" : "candidate typecheck missing");
  if (!cand.test) problems.push("candidate test run missing");
  if (!base.test) problems.push("stable reference test run missing");
  const cs = cand.test && vitestSummary(cand.test.tail ?? ""), ss = base.test && vitestSummary(base.test.tail ?? "");
  if (cand.test && !cs) problems.push("candidate test run printed no parsable summary (early exit or forged output)");
  if (base.test && !ss) problems.push("stable test run printed no parsable summary");
  if (cand.test?.timeout) problems.push("candidate test run timed out");
  if (cs && ss) {
    if (cs.total < ss.total) problems.push(`candidate ran fewer tests (${cs.total} < ${ss.total})`);
    if (cs.passed < ss.passed) problems.push(`candidate passed fewer tests (${cs.passed} < ${ss.passed})`);
    if (cs.skipped > ss.skipped) problems.push(`candidate skipped more tests (${cs.skipped} > ${ss.skipped})`);
  }
  const stableFailing = new Set(base.test?.failing ?? []);
  const candFailing = cand.test?.failing ?? [];
  const introduced = candFailing.filter(name => !stableFailing.has(name));
  if (cand.test && !cand.test.pass && cs?.failed > 0 && !candFailing.length) problems.push("candidate test run failed without a parsable failure list");
  if (cand.test && cand.test.exit !== 0 && cs && cs.failed === 0) problems.push(`candidate test run exited ${cand.test.exit} with no failed test (crash or forged summary)`);
  if (introduced.length) problems.push(`tests failing only with the candidate: ${introduced.slice(0, 5).join(" | ")}`);
  return { pass: problems.length === 0, problems, introduced, environmentFailures: [...stableFailing], summary: { candidate: cs ?? null, stable: ss ?? null } };
}
