#!/usr/bin/env node
// Non-human, cross-provider review of private tasks (confirmatory-1, 2026-11-07; docs/design.md "Non-human review").
//
// Human review is not available (operator decision 2026-11-07). This harness replaces it with checks whose independence is
// ENFORCED where it can be and recorded where it cannot:
//   blind-tests   a reviewer model of a provider other than the authors' writes acceptance tests from the instruction and the
//                 starting repository ONLY. The reviewer runs as pure Pi inside the bubblewrap sandbox the evaluator uses for task
//                 agents: its file system holds just that bundle (host /home, /tmp, /run, ... are empty tmpfs; no reference, no
//                 official tests, no authoring notes, no repository history, no credentials: the real key stays in the route
//                 proxy outside the sandbox). A denial probe in the SAME mount set records that the withheld paths are absent.
//                 Mechanical check afterwards: the reference must pass the blind tests and the starting repository must fail them.
//   adversarial   a reviewer of another non-author provider sees instruction, repository, official hidden tests and reference and
//                 judges sufficiency / test-instruction match / reference correctness / public-source suspicion, and writes
//                 plausible WRONG solutions (mutants); the grader then runs the official hidden tests on every mutant (a mutant the
//                 hidden tests accept is a test gap only when the blind tests reject it or the reviewer's stated violation holds).
// Every review records: requested route, the models named by the provider's responses (wire journal), provider of that model
// family, Pi session id, times, the input manifest (sha256 of every file the sandbox held), output manifest, the denial probe,
// usage/cost from the proxy, the reviewer's verdict and the mechanical results. The reviewer models are never the target model
// (gpt-6-luna) nor of its provider family, so holdout candidates are not shown to the evaluated model's provider.
//
//   node studies/confirmatory-1/review.mjs --task DIR [--task DIR ...] --role blind-tests|adversarial --model M --effort E --out DIR [--parallel 3]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { BRIDGE, BRIDGE_PORT, LAUNCH, MOUNTS, PLACEHOLDER_KEY, completedModelCalls, runSandboxed, startModelPath, wireEntries } from "../../src/sandbox.mjs";
import { piSettings } from "../../src/runner.mjs";
import { gradeWorkspace, testFilesOf } from "../../src/grader.mjs";
import { ensureDir, sha256, atomicWriteJson } from "../../src/util.mjs";

export const REVIEW_SCHEMA = "pi-eval-loop/task-review@1";
export const BOX = "/tmp/box";
/** Provider family of a model id (for independence: never the authors' family, never the target's). */
export function providerOf(model) {
  const m = String(model ?? "").replace(/^bts\//, "");
  if (/^claude-/.test(m)) return "anthropic";
  if (/^gpt-|^o\d/.test(m)) return "openai";
  if (/^grok-/.test(m)) return "xai";
  if (/^gemini-/.test(m)) return "google";
  return "unknown";
}
export const AUTHOR_PROVIDER = "anthropic";
export const TARGET_PROVIDER = "openai";

/** Files of a directory tree with sha256 (relative paths). */
export function manifest(root) {
  const out = [];
  const visit = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== ".git" && e.name !== "node_modules") visit(p); } else if (e.isFile()) out.push({ path: relative(root, p), sha256: sha256(readFileSync(p)), bytes: statSync(p).size }); } };
  if (existsSync(root)) visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** What a role may see: { dir: name in the workspace -> source path }. */
export function bundleOf(task, role, extra = {}) {
  const parts = { repo: join(task.dir, "repo") };
  if (role === "adversarial" || role === "adjudicate") { parts.hidden = join(task.dir, "hidden"); parts.reference = join(task.dir, "reference"); }
  else if (role !== "blind-tests") throw new Error(`unknown role ${role}`);
  if (role === "adjudicate") Object.assign(parts, extra);
  return parts;
}

export function promptOf(role) {
  const common = "Work only inside the current directory. Do not modify repo/ (copy it to scratch directories under $TMPDIR when you need to run code). Node.js is available (`node --test`). When you are done, stop.";
  if (role === "blind-tests") return [
    "You are an independent test author reviewing a programming task for an evaluation benchmark.",
    "In this directory: INSTRUCTION.md is the task given to a coding agent; repo/ is the starting repository. You do NOT have the reference solution or the official tests, by design.",
    "1. Write acceptance tests that check exactly the behaviour INSTRUCTION.md requires: everything it states, nothing it does not state (do not test unspecified details such as exact error message text unless the instruction fixes them). Use node:test and node:assert. Place them under out/tests/ mirroring repository paths (out/tests/ is copied onto the repository root before running), e.g. out/tests/test/<topic>.blind.test.js, importing the code by paths relative to that location.",
    "2. Check them: copy repo/ to a scratch directory, copy out/tests/. over it and run `node --test <your test files>`. On the starting repository the tests about the requested change must FAIL (they test the change); tests of behaviour the instruction says must be preserved may pass.",
    "3. Write out/assessment.json: {\"instructionSufficient\": true|false, \"ambiguities\": [\"...\"], \"underspecified\": [\"...\"], \"publicSourceSuspected\": null | \"which project/tutorial and why\", \"notes\": \"...\"}.",
    common,
  ].join("\n");
  if (role === "adjudicate") return [
    "You are the adjudicator of a disagreement between independent reviewers of a programming task for an evaluation benchmark. Decide strictly from INSTRUCTION.md: the instruction is the specification; neither the reference nor any test is authoritative where it goes beyond the instruction.",
    "In this directory: INSTRUCTION.md, repo/ (starting repository), hidden/ (official hidden tests), reference/ (reference solution files), blind/ (tests written by an independent reviewer who saw only INSTRUCTION.md and repo/), mutants/ (plausible wrong solutions by an adversarial reviewer, each with WHY.md), review/ (the adversarial reviewer's verdict.json and the mechanical cross-check crosscheck.json: which mutants the official hidden tests accept, which the blind tests reject, which blind tests the reference fails).",
    "For EACH mutant the official hidden tests accept: is it a real violation of a requirement stated in INSTRUCTION.md (quote it), or not a violation (the instruction leaves it open)? Run tests yourself where useful (copy repo/ to a scratch dir under $TMPDIR, overlay the files, `node --test ...`).",
    "For EACH blind test the reference fails: reference-defect (the reference violates the instruction), blind-test-error (the blind test asserts something the instruction does not say), or ambiguity (the instruction allows both).",
    "For EACH blocker/major finding of the adversarial reviewer: defect or not-a-defect, with a reason.",
    "If you confirm a test gap (a real violation the official tests accept), write the smallest additional test(s) that reject that mutant while the reference passes, as files under out/remedy-tests/ mirroring repository paths (e.g. out/remedy-tests/test/<topic>.remedy.test.js, node:test), testing ONLY what the instruction states; verify both outcomes.",
    "Write out/adjudication.json: {\"verdict\": \"accept\"|\"revise\"|\"reject\" (accept only if no confirmed defect remains in the CURRENT task), \"mutants\": [{\"name\": \"...\", \"resolution\": \"violation\"|\"not-a-violation\", \"reason\": \"...\"}], \"blindFailures\": [{\"test\": \"...\", \"resolution\": \"reference-defect\"|\"blind-test-error\"|\"ambiguity\", \"reason\": \"...\"}], \"findings\": [{\"item\": \"...\", \"resolution\": \"defect\"|\"not-a-defect\", \"reason\": \"...\"}], \"remedy\": \"none\" | \"tests\" | \"instruction\" | \"reference\" | \"withdraw\"}.",
    common,
  ].join("\n");
  return [
    "You are an adversarial reviewer of a programming task for an evaluation benchmark. Be skeptical; your job is to find real defects, not to approve.",
    "In this directory: INSTRUCTION.md (the task given to a coding agent), repo/ (starting repository), hidden/ (the official hidden tests, copied onto the repository root when grading), reference/ (the reference solution's files, copied onto the repository root).",
    "Check: (a) instruction-sufficient: a competent engineer can implement it without guessing; (b) tests-match-instruction: the hidden tests require nothing the instruction does not state and do check what it states; (c) reference-passes-hidden: run it (copy repo/ to a scratch dir, overlay reference/ then hidden/, run `node --test` on the hidden test files); (d) no-public-source-copy: does this look copied from a known public project, tutorial or benchmark?",
    "Then write up to 3 plausible WRONG solutions (mutants): implementations a careless agent might produce that violate a requirement stated in INSTRUCTION.md but that you suspect the hidden tests still accept. Each as files under out/mutants/<short-name>/ with repository-relative paths (overlaid on repo/ like reference/), plus out/mutants/<short-name>/WHY.md naming the violated requirement (quote the instruction). Run the hidden tests on each mutant and report the result honestly.",
    "Write out/verdict.json: {\"verdict\": \"accept\"|\"revise\"|\"reject\", \"checked\": {\"instruction-sufficient\": {\"ok\": bool, \"evidence\": \"...\"}, \"tests-match-instruction\": {...}, \"reference-passes-hidden\": {...}, \"no-public-source-copy\": {...}}, \"findings\": [{\"severity\": \"blocker\"|\"major\"|\"minor\", \"item\": \"...\", \"detail\": \"...\"}], \"mutants\": [{\"name\": \"...\", \"violates\": \"...\", \"hiddenTestsAccepted\": bool}]}.",
    common,
  ].join("\n");
}

/** The reviewer sandbox's complete mount set (exported so the isolation test probes exactly this set). */
export const reviewerBinds = ({ env, box, launch, socket }) => [{ from: env.nodeDir }, { from: env.piModules }, { from: box, to: BOX, rw: true }, { from: env.provider, to: MOUNTS.provider }, { from: BRIDGE, to: MOUNTS.bridge }, { from: launch, to: MOUNTS.launch }, { from: socket, to: MOUNTS.socket, rw: true }];

/** Run a shell probe with the reviewer's exact mount set and report which withheld paths are visible (must be none). */
export async function denialProbe({ binds, sandboxEnv, cwd, withheld, visibleControl = [] }) {
  // Positive controls (paths that MUST be visible) show the probe itself works: a probe that sees nothing proves nothing.
  const all = [...withheld, ...visibleControl];
  const script = all.map((p, i) => `if [ -e '${p.replace(/'/g, "")}' ]; then echo "VISIBLE ${i}"; else echo "absent ${i}"; fi`).join("; ");
  const run = await runSandboxed({ binds, env: sandboxEnv, cwd, command: ["/bin/sh", "-c", script] }, { guardMs: 30_000, keep: 64 * 1024 });
  const lines = run.text.trim().split("\n");
  const seen = (i) => lines.includes(`VISIBLE ${i}`), checked = (i) => seen(i) || lines.includes(`absent ${i}`);
  const controlsOk = visibleControl.every((_, j) => seen(withheld.length + j));
  return withheld.map((path, i) => ({ path, visible: seen(i), checked: checked(i) && controlsOk }));
}

/**
 * One review session. Returns the review record (also written to <out>/review.json) with outputs copied to <out>/output.
 * @param {{ task: any, role: string, route: { provider: string, model: string, effort: string }, out: string, env: any, maxRequests?: number, wallMs?: number, withheld?: string[], scratchRoot?: string }} options
 */
export async function reviewSession({ task, role, route, out, env, maxRequests = 80, wallMs = 25 * 60_000, withheld = [], scratchRoot = "/tmp", extra = {}, allowProviders = null }) {
  const provider = providerOf(route.model);
  if (allowProviders && !allowProviders.includes(provider)) throw new Error(`reviewer model ${route.model} (${provider}) not allowed here`);
  if (provider === AUTHOR_PROVIDER || provider === TARGET_PROVIDER || provider === "unknown") throw new Error(`reviewer model ${route.model} (${provider}) must be of a provider other than the authors' (${AUTHOR_PROVIDER}) and the target's (${TARGET_PROVIDER})`);
  ensureDir(out);
  const control = ensureDir(join(scratchRoot, `rv-${randomBytes(4).toString("hex")}`));
  const box = ensureDir(join(control, "box"));
  const ws = join(box, "ws"), agent = join(box, "agent"), sessions = join(box, "sessions"), home = join(box, "home"), tmp = join(box, "tmp");
  for (const d of [ws, agent, sessions, home, tmp, join(ws, "out")]) ensureDir(d);
  writeFileSync(join(ws, "INSTRUCTION.md"), `${task.instruction}\n`);
  for (const [name, from] of Object.entries(bundleOf(task, role, extra))) if (existsSync(from)) cpSync(from, join(ws, name), { recursive: true, filter: p => !/\/(\.git|node_modules)$/.test(p) });
  const inputs = manifest(ws);
  for (const name of ["cliproxyapi-models.json", "models.json"]) if (existsSync(join(env.agentDir, name))) copyFileSync(join(env.agentDir, name), join(agent, name));
  const bridgeUrl = `http://127.0.0.1:${BRIDGE_PORT}`;
  writeFileSync(join(agent, "cliproxyapi.json"), JSON.stringify({ apiKey: PLACEHOLDER_KEY, baseUrl: bridgeUrl, providerId: "cliproxyapi", providerName: "CLIProxyAPI" }), { mode: 0o600 });
  writeFileSync(join(agent, "settings.json"), JSON.stringify(piSettings(route), null, 2));
  const launch = join(control, "launch.sh"); writeFileSync(launch, LAUNCH, { mode: 0o555 });
  const model = await startModelPath({ dir: join(control, "model"), route, maxRequests, upstream: env.upstream, agentDir: env.agentDir });
  const inside = (p) => p.replace(box, BOX);
  const binds = reviewerBinds({ env, box, launch, socket: model.socket });
  const sessionId = `rv-${role}-${task.id}-${randomBytes(3).toString("hex")}`;
  const sandboxEnv = {
    PATH: `${env.nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: inside(home), TMPDIR: inside(tmp), LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb", TZ: "UTC",
    PI_CODING_AGENT_DIR: inside(agent), PI_CODING_AGENT_SESSION_DIR: inside(sessions), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1",
    CLIPROXYAPI_BASE_URL: bridgeUrl, CLIPROXYAPI_API_KEY: PLACEHOLDER_KEY, CLIPROXYAPI_FAST: "0", EL_NODE: env.node, EL_BRIDGE_READY: `${inside(tmp)}/.bridge-ready`,
  };
  const probe = await denialProbe({ binds, sandboxEnv, cwd: inside(ws), withheld: [task.dir, join(task.dir, "hidden"), join(task.dir, "reference"), join(task.dir, "review"), join(env.agentDir, "cliproxyapi.json"), ...withheld], visibleControl: [`${BOX}/ws/INSTRUCTION.md`, `${BOX}/ws/repo`] });
  const piArgs = [env.piCli, "--mode", "json", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve", "--no-context-files", "--offline", "-e", `${MOUNTS.provider}/extensions/index.ts`,
    "--model", `${route.provider}/${route.model}`, "--thinking", route.effort, "--session-dir", inside(sessions), "--session-id", sessionId, "--", promptOf(role)];
  const startedAt = new Date().toISOString();
  let run;
  try { run = await runSandboxed({ binds, env: sandboxEnv, cwd: inside(ws), command: ["/bin/sh", MOUNTS.launch, env.node, ...piArgs] }, { guardMs: wallMs, stdout: join(out, "events.jsonl"), stderr: join(out, "stderr.txt"), keep: 64 * 1024 }); }
  finally { await model.stop(); }
  const wire = wireEntries(model.wireLog);
  const totals = model.totals();
  cpSync(model.wireLog, join(out, "wire.jsonl"));
  rmSync(join(out, "output"), { recursive: true, force: true });
  cpSync(join(ws, "out"), join(out, "output"), { recursive: true });
  const sessionText = readdirSync(sessions, { recursive: true }).filter(f => String(f).endsWith(".jsonl")).map(f => readFileSync(join(sessions, String(f)), "utf8")).join("\n");
  writeFileSync(join(out, "session.jsonl"), sessionText);
  const outputs = manifest(join(out, "output"));
  const responseModels = [...new Set(wire.flatMap(e => [e.respModel, e.finalModel]).filter(Boolean))];
  rmSync(control, { recursive: true, force: true });
  const record = {
    schema: REVIEW_SCHEMA, task: task.id, role, startedAt, endedAt: new Date().toISOString(),
    reviewer: { kind: "ai-agent", id: sessionId, harness: "pure pi in bubblewrap (no extensions/skills)", route: `${route.provider}/${route.model}`, effort: route.effort, provider: providerOf(route.model), responseModels, gateway: "local CLIProxyAPI (cliproxyapi provider)" },
    access: { enforcement: "filesystem (bubblewrap mount set; host roots /home,/tmp,/var/tmp,/run,/opt,/mnt,/media,/srv,/root are empty tmpfs)", visible: Object.keys(bundleOf(task, role, extra)).concat(["INSTRUCTION.md", "out/"]), inputs, denialProbe: probe },
    run: { exit: run.code, guardFired: run.guardFired, ms: run.ms, forwarded: totals.forwarded ?? 0, completed: completedModelCalls(wire), refused: totals.refused ?? {}, providerErrors: totals.providerErrors ?? 0, tokens: { input: totals.input ?? 0, cached: totals.cached ?? 0, output: totals.output ?? 0 }, listPriceUSD: totals.costUSD ?? null },
    outputs,
  };
  atomicWriteJson(join(out, "review.json"), record);
  return record;
}

/** Overlay `parts` (directories copied in order onto a copy of the starting repo) and run `tests` (a test tree) with the grader. */
export async function gradeOverlay({ task, parts, tests, scratch, env, timeoutMs = 120_000 }) {
  const ws = ensureDir(join(scratch, "ws"));
  cpSync(task.repo, ws, { recursive: true, filter: p => !/\/(\.git|node_modules)$/.test(p) });
  for (const p of parts) if (p && existsSync(p)) cpSync(p, ws, { recursive: true, force: true, filter: q => !/WHY\.md$/.test(q) });
  const g = await gradeWorkspace({ task: { hidden: tests }, workspace: ws, scratch: join(scratch, "g"), env, timeoutMs });
  rmSync(scratch, { recursive: true, force: true });
  return { pass: g.hiddenPass === true, tests: g.hidden?.tests ?? 0, passed: g.hidden?.passed ?? 0, failed: g.hidden?.failed ?? 0, failing: (g.hidden?.failing ?? []).slice(0, 20), error: g.error ? String(g.error).slice(0, 300) : undefined };
}

/** Mechanical checks of a finished review (model-free). */
export async function mechanicalChecks({ task, role, out, env, scratchRoot = "/tmp" }) {
  const output = join(out, "output");
  const scratch = (n) => join(scratchRoot, `rvg-${randomBytes(4).toString("hex")}-${n}`);
  if (role === "blind-tests") {
    const tests = join(output, "tests");
    const files = testFilesOf(tests);
    if (!files.length) return { blindTests: 0, note: "no blind tests written" };
    const original = await gradeOverlay({ task, parts: [], tests, scratch: scratch("o"), env });
    const reference = await gradeOverlay({ task, parts: [join(task.dir, "reference")], tests, scratch: scratch("r"), env });
    const reference2 = await gradeOverlay({ task, parts: [join(task.dir, "reference")], tests, scratch: scratch("r2"), env });
    return { blindTests: files.length, original, reference, referenceRepeat: { pass: reference2.pass, failed: reference2.failed }, discriminates: !original.pass, referencePasses: reference.pass && reference2.pass };
  }
  const mutantsDir = join(output, "mutants");
  const mutants = [];
  for (const name of existsSync(mutantsDir) ? readdirSync(mutantsDir).sort() : []) {
    const dir = join(mutantsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const hidden = await gradeOverlay({ task, parts: [dir], tests: join(task.dir, "hidden"), scratch: scratch(`m-${name}`), env });
    mutants.push({ name, why: existsSync(join(dir, "WHY.md")) ? readFileSync(join(dir, "WHY.md"), "utf8").slice(0, 1500) : null, hiddenAccepts: hidden.pass, hidden });
  }
  const ref = await gradeOverlay({ task, parts: [join(task.dir, "reference")], tests: join(task.dir, "hidden"), scratch: scratch("ref"), env });
  let verdict = null; try { verdict = JSON.parse(readFileSync(join(output, "verdict.json"), "utf8")); } catch { /* missing or invalid */ }
  return { referencePassesHidden: ref.pass, reference: ref, mutants, verdict };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { task: { type: "string", multiple: true }, role: { type: "string" }, model: { type: "string" }, effort: { type: "string", default: "high" }, out: { type: "string" }, parallel: { type: "string", default: "3" }, "max-requests": { type: "string", default: "80" }, scratch: { type: "string" }, withhold: { type: "string", multiple: true, default: [] } } });
  const { hostEnvironment } = await import("../../src/sandbox.mjs");
  const { loadLocal } = await import("../../src/datasets.mjs");
  const env = hostEnvironment();
  const tasks = (values.task ?? []).map(d => { const dir = resolve(d); const parent = resolve(dir, ".."); const t = loadLocal(parent).find(x => x.dir === dir); if (!t) throw new Error(`not a task: ${dir}`); return t; });
  const route = { provider: "cliproxyapi", model: values.model, effort: values.effort };
  let next = 0; const results = [];
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      const out = join(resolve(values.out), task.id, `${values.role}-${values.model}-${new Date().toISOString().replace(/[:.]/g, "")}`);
      try {
        const scratchRoot = ensureDir(resolve(values.scratch ?? join(resolve(values.out), "..", "scratch")));
        const rec = await reviewSession({ task, role: values.role, route, out, env, maxRequests: Number(values["max-requests"]), withheld: values.withhold, scratchRoot });
        const mech = await mechanicalChecks({ task, role: values.role, out, env, scratchRoot });
        atomicWriteJson(join(out, "mechanical.json"), mech);
        results.push({ task: task.id, out, forwarded: rec.run.forwarded, exit: rec.run.exit, models: rec.reviewer.responseModels, probeVisible: rec.access.denialProbe.filter(p => p.visible).length });
        process.stderr.write(`[review] ${task.id} ${values.role} done (${rec.run.forwarded} requests)\n`);
      } catch (error) { results.push({ task: task.id, error: String(error?.message ?? error).slice(0, 300) }); process.stderr.write(`[review] ${task.id} failed: ${String(error?.message ?? error).slice(0, 200)}\n`); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, worker));
  process.stdout.write(`${JSON.stringify(results)}\n`);
}
