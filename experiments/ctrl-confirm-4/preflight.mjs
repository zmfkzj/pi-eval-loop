#!/usr/bin/env node
// ctrl-confirm-4 preflight (model-free; NEVER records a holdout use, never dispatches a unit, never writes a state directory):
// frozen identities, sealed batches (seal re-verified, 0 uses before and after, EXACTLY the preregistered batches), prerequisites
// of the sandbox, the route's environment digest, harness patch applicability, budget vs plan at the preregistered N, the gate
// record's binding, and the route's authorization (A2: one authenticated GET /v1/models; no inference request is ever sent).
// Every network request it makes is listed in `networkProbes` (inference requests: 0). Output: a JSON report.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/preflight.mjs --batch DIR [--batch DIR ...] --gate FILE --out FILE
import http from "node:http";
import https from "node:https";
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

/** Supplied batch directories vs the preregistered batches: same set (path suffix + seal digest), none missing, none extra. */
export function batchMatch(prereg, supplied) {
  const want = prereg.holdout.batches;
  const problems = [];
  if (!supplied.length) problems.push("no --batch given");
  for (const w of want) if (!supplied.some(s => s.dir.endsWith(`/${w.path}`) && s.sealDigest === w.sealDigest)) problems.push(`preregistered batch ${w.path} (seal ${w.sealDigest.slice(0, 12)}) not supplied or seal differs`);
  for (const s of supplied) if (!want.some(w => s.dir.endsWith(`/${w.path}`))) problems.push(`extra batch ${s.dir}`);
  return { ok: problems.length === 0, problems };
}

/** Authenticated model listing (no inference, not billed): status, and whether the pinned route model is listed. Key never output. */
export function modelListing(upstream, key, model, timeoutMs = 10_000) {
  return new Promise(done => {
    const url = new URL("/v1/models", upstream), lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: "GET", timeout: timeoutMs, headers: key ? { authorization: `Bearer ${key}` } : {} }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", c => { if (body.length < 4e6) body += c; });
      res.on("end", () => { let ids = []; try { ids = (JSON.parse(body).data ?? []).map(m => m.id); } catch { /* not JSON */ } done({ request: "GET /v1/models", authenticated: Boolean(key), inference: false, status: res.statusCode, modelListed: ids.includes(model), models: ids.length }); });
    });
    req.on("timeout", () => { req.destroy(); done({ request: "GET /v1/models", authenticated: Boolean(key), inference: false, status: null, error: "timeout" }); });
    req.on("error", e => done({ request: "GET /v1/models", authenticated: Boolean(key), inference: false, status: null, error: e.code ?? String(e) }));
    req.end();
  });
}

async function main() {
  const { values } = parseArgs({ options: { batch: { type: "string", multiple: true }, gate: { type: "string" }, out: { type: "string" }, scratch: { type: "string" } } });
  const prereg = loadPrereg();
  const checks = {};
  checks.identity = { integrityContract: sha256(prereg.integrityContract) === prereg.identity.integrityContractSha256, testIntegrityRule: sha256(prereg.testIntegrityRule) === prereg.identity.testIntegrityRuleSha256, ocrPatch: sha256(readFileSync(join(EXPERIMENT_DIR, "..", "ctrl-confirm-2/variants/OCR.diff"))) === prereg.identity.ocrPatchSha256 };
  const usesBefore = {};
  checks.batches = (values.batch ?? []).map(d => { const dir = resolve(d); const s = verifySeal(dir); const uses = holdoutLedger(dir).records().length; usesBefore[dir] = uses; return { dir, sealOk: s.ok, sealDigest: s.seal?.digest ?? null, uses }; });
  checks.batchMatch = batchMatch(prereg, checks.batches);
  const env = hostEnvironment();
  checks.prerequisites = (await prerequisites(env)).map(p => ({ name: p.name, ok: p.ok }));
  let key = ""; try { key = String(JSON.parse(readFileSync(join(env.agentDir, "cliproxyapi.json"), "utf8")).apiKey ?? ""); } catch { /* absent */ }
  const listing = await modelListing(env.upstream, key, prereg.route.model);
  checks.routeAuthorization = { ok: listing.status === 200 && listing.modelListed === true, ...listing };
  checks.networkProbes = [{ request: "GET /v1/models (prerequisites upstream reachability, unauthenticated)", inference: false }, { request: "GET /v1/models (authenticated listing)", inference: false, status: listing.status }];
  checks.inferenceRequests = 0;
  checks.environmentDigest = environmentDigest(env, prereg.route).digest;
  const scratch = mkdtempSync(join(resolve(values.scratch ?? join(UMBRELLA, "results")), "ctrl-confirm-4-preflight-"));
  try {
    checks.harness = prereg.arms.filter(a => a.kind === "orche").map(a => { const b = buildHarness(a, prereg, { stateDir: scratch, orcheDir: join(UMBRELLA, "orche"), experimentDir: EXPERIMENT_DIR }); return { arm: a.id, treeDigest: b.digest }; });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  checks.files = { evaluator: Object.keys(fileDigests(evaluatorFiles())).length, experiment: experimentFiles().length, digest: digestOf(fileDigests([...evaluatorFiles(), ...experimentFiles()])) };
  checks.planAtPreregisteredN = { n: prereg.holdout.taskIds.length, ...planned(prereg, prereg.holdout.taskIds.length) };
  checks.budget = prereg.budget;
  checks.launchRefusal = values.gate ? launchRefusal(prereg, resolve(values.gate)) : "no gate file given";
  checks.usesUnchanged = (values.batch ?? []).every(d => holdoutLedger(resolve(d)).records().length === usesBefore[resolve(d)]);
  const ok = Object.values(checks.identity).every(Boolean) && checks.batches.length > 0 && checks.batches.every(b => b.sealOk && b.uses === 0) && checks.batchMatch.ok && checks.prerequisites.every(p => p.ok) && checks.routeAuthorization.ok && checks.usesUnchanged;
  const report = { at: new Date().toISOString(), preregDigest: digestOf(prereg), infrastructureReady: ok, launchAllowed: ok && checks.launchRefusal === null, checks };
  const text = `${JSON.stringify(report, null, 1)}\n`;
  if (values.out) writeFileSync(values.out, text);
  process.stdout.write(`${JSON.stringify({ infrastructureReady: report.infrastructureReady, launchAllowed: report.launchAllowed, launchRefusal: checks.launchRefusal, batchMatch: checks.batchMatch.ok, routeAuthorization: checks.routeAuthorization.ok })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
