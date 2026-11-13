#!/usr/bin/env node
// ctrl-confirm-4 preflight (model-free; NEVER records a holdout use, never dispatches a unit, never writes a state directory):
// frozen identities, sealed batches (seal re-verified, 0 uses before and after), prerequisites of the sandbox, the route's
// environment digest, harness patch applicability, budget vs plan, and the gate record's binding. Output: a JSON report.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/preflight.mjs --batch DIR [--batch DIR ...] --gate FILE --out FILE
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { holdoutLedger, verifySeal } from "../../src/datasets.mjs";
import { environmentDigest, hostEnvironment, prerequisites } from "../../src/sandbox.mjs";
import { UMBRELLA, evaluatorFiles, fileDigests } from "../../src/protocol.mjs";
import { digestOf, sha256 } from "../../src/util.mjs";
import { buildHarness } from "../ctrl-ablation/lib.mjs";
import { EXPERIMENT_DIR, loadPrereg } from "./lib.mjs";
import { experimentFiles, launchRefusal } from "./run.mjs";
import { planned } from "./gate.mjs";

async function main() {
  const { values } = parseArgs({ options: { batch: { type: "string", multiple: true }, gate: { type: "string" }, out: { type: "string" }, scratch: { type: "string" } } });
  const prereg = loadPrereg();
  const checks = {};
  checks.identity = { integrityContract: sha256(prereg.integrityContract) === prereg.identity.integrityContractSha256, testIntegrityRule: sha256(prereg.testIntegrityRule) === prereg.identity.testIntegrityRuleSha256, ocrPatch: sha256(readFileSync(join(EXPERIMENT_DIR, "..", "ctrl-confirm-2/variants/OCR.diff"))) === prereg.identity.ocrPatchSha256 };
  const usesBefore = {};
  checks.batches = (values.batch ?? []).map(d => { const dir = resolve(d); const s = verifySeal(dir); const uses = holdoutLedger(dir).records().length; usesBefore[dir] = uses; return { dir, sealOk: s.ok, sealDigest: s.seal?.digest ?? null, uses }; });
  const env = hostEnvironment();
  checks.prerequisites = (await prerequisites(env)).map(p => ({ name: p.name, ok: p.ok }));
  checks.environmentDigest = environmentDigest(env, prereg.route).digest;
  const scratch = mkdtempSync(join(resolve(values.scratch ?? join(UMBRELLA, "results")), "ctrl-confirm-4-preflight-"));
  try {
    checks.harness = prereg.arms.filter(a => a.kind === "orche").map(a => { const b = buildHarness(a, prereg, { stateDir: scratch, orcheDir: join(UMBRELLA, "orche"), experimentDir: EXPERIMENT_DIR }); return { arm: a.id, treeDigest: b.digest }; });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  checks.files = { evaluator: Object.keys(fileDigests(evaluatorFiles())).length, experiment: experimentFiles().length, digest: digestOf(fileDigests([...evaluatorFiles(), ...experimentFiles()])) };
  checks.planAtN800 = planned(prereg, 800);
  checks.budget = prereg.budget;
  checks.launchRefusal = values.gate ? launchRefusal(prereg, resolve(values.gate)) : "no gate file given";
  checks.usesUnchanged = (values.batch ?? []).every(d => holdoutLedger(resolve(d)).records().length === usesBefore[resolve(d)]);
  const ok = Object.values(checks.identity).every(Boolean) && checks.batches.every(b => b.sealOk && b.uses === 0) && checks.prerequisites.every(p => p.ok) && checks.usesUnchanged;
  const report = { at: new Date().toISOString(), preregDigest: digestOf(prereg), infrastructureReady: ok, launchAllowed: ok && checks.launchRefusal === null, checks };
  const text = `${JSON.stringify(report, null, 1)}\n`;
  if (values.out) writeFileSync(values.out, text);
  process.stdout.write(`${JSON.stringify({ infrastructureReady: report.infrastructureReady, launchAllowed: report.launchAllowed, launchRefusal: checks.launchRefusal })}\n`);
}

main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
