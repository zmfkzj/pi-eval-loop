#!/usr/bin/env node
// Fixed candidate c1 of the exploratory route (2026-11-07; README.md). Model-free, no git commit anywhere.
//
// c1 = the stable orche export (e831a6b2, an archive export, not a worktree) + c1.diff:
//   - ctrl-confirm-2's OCR rule (existing tests read-only, new tests in new files) appended to every orche-created session
//     (byte-identical to experiments/ctrl-confirm-2/variants/OCR.diff of the umbrella) and now also given to the main session;
//   - src/extension/existing-tests.ts: an edit/write/ast_rewrite call naming an existing test file is refused with a pointer to a
//     new test file; a change made another way is detected after the call and the model is told to put the file back itself.
//     The harness never rewrites the workspace: the evaluator's strict check sees exactly what the model left.
// The candidate was chosen from development evidence (ctrl-confirm-2: OCR strict violations 33/279 vs OC 125/279; calibration:
// 7/30 stable units changed an existing test file's import line), not from any fresh holdout outcome.
//
//   node studies/exploratory-1/build-candidate.mjs --stable DIR --out DIR      (DIR must not exist)
//   node studies/exploratory-1/build-candidate.mjs --verify DIR --stable DIR   (re-derives and compares)
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";

export const STABLE_COMMIT = "e831a6b2bc19f0c707b55505db33a11b2c9d4d4a";
export const DIFF = new URL("./c1.diff", import.meta.url).pathname;
export { RUNTIME, runtimeDigest } from "../../src/exploration.mjs";
import { runtimeDigest } from "../../src/exploration.mjs";
const SKIP = new Set([".codegraph", "node_modules", ".git"]);


export const diffDigest = () => createHash("sha256").update(readFileSync(DIFF)).digest("hex");

/** Identity of c1 (bound into every plan and record). */
export function candidateIdentity(dir) {
  return { id: "c1", kind: "orche", base: STABLE_COMMIT, diffSha256: diffDigest(), runtimeDigest: runtimeDigest(dir), commit: `${STABLE_COMMIT}+c1:${diffDigest().slice(0, 16)}` };
}

export function buildCandidate({ stable, out }) {
  if (existsSync(out)) throw new Error(`${out} exists (a candidate tree is never rebuilt in place)`);
  cpSync(stable, out, { recursive: true, filter: (src) => !SKIP.has(src.split("/").pop()) });
  // GIT_CEILING_DIRECTORIES: never discover an enclosing repository (git apply would silently skip paths outside its cwd).
  try { execFileSync("git", ["apply", "-p1", "--verbose", DIFF], { cwd: out, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CEILING_DIRECTORIES: resolve(out, "..") } }); }
  catch (error) { rmSync(out, { recursive: true, force: true }); throw new Error(`c1.diff does not apply to ${stable}: ${String(error.stderr ?? error.message).slice(0, 300)}`); }
  const added = [...readFileSync(DIFF, "utf8").matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]);
  const missing = added.filter(f => !existsSync(join(out, f)));
  if (missing.length) { rmSync(out, { recursive: true, force: true }); throw new Error(`c1.diff not applied: ${missing.join(", ")} missing`); }
  return candidateIdentity(out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { stable: { type: "string" }, out: { type: "string" }, verify: { type: "string" } } });
  if (values.verify) {
    const tmp = `${resolve(values.verify)}.verify-tmp`;
    rmSync(tmp, { recursive: true, force: true });
    const fresh = buildCandidate({ stable: resolve(values.stable), out: tmp });
    const have = candidateIdentity(resolve(values.verify));
    rmSync(tmp, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ same: fresh.runtimeDigest === have.runtimeDigest, fresh, have })}\n`);
    process.exit(fresh.runtimeDigest === have.runtimeDigest ? 0 : 2);
  }
  process.stdout.write(`${JSON.stringify(buildCandidate({ stable: resolve(values.stable), out: resolve(values.out) }))}\n`);
}
