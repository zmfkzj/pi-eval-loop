// Wiring of the loop for the CLI and the Pi extension: real backend, prerequisites, grader validation, proposer and checks.
import { join } from "node:path";
import { Loop } from "./loop.mjs";
import { loadProtocol, PACKAGE_DIR } from "./protocol.mjs";
import { environmentDigest, hostEnvironment, prerequisites } from "./sandbox.mjs";
import { realBackend } from "./evaluator.mjs";
import { validateGrader } from "./grader.mjs";
import { proposeReal } from "./proposer.mjs";
import { runChecks } from "./checks.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export const DEFAULT_STATE = join(PACKAGE_DIR, "state", "default");

/** A Loop on the real backend. `pids` collects sandbox process-group ids for cleanup on signals. */
export function realLoop({ stateDir = DEFAULT_STATE, protocolPath, strategy = "pareto", env = hostEnvironment(), pids = new Set(), log, protocol } = {}) {
  protocol ??= loadProtocol(protocolPath);
  const backend = realBackend(env);
  const run = backend.run;
  backend.run = (input) => run({ ...input, signalPids: pids });
  return new Loop({
    stateDir, protocol, strategy, env, envDigest: environmentDigest(env, protocol.route).digest, backend, log,
    prerequisites: () => prerequisites(env),
    validateGrader: async (task) => { const scratch = mkdtempSync(join(tmpdir(), "el-v-")); try { return await validateGrader({ task, scratch, env }); } finally { rmSync(scratch, { recursive: true, force: true }); } },
    proposer: { kind: "pi", propose: (input) => proposeReal(input) },
    checks: (worktree, which, logDir) => runChecks({ worktree, env, which, logDir }),
  });
}
