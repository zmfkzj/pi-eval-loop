// agent_workflow's eval-loop wrapper contract (2026-11-13, model-free). The wrapper owns proposal orchestration, reflection,
// waits/terminal codes and resume; the engine owes it: the imported exports below with their shapes, discovery of the
// wrapper's minimal archive output by the screening archive source, and proposal reservations in the SAME RequestBudget
// ledger that never count against the screening route caps and whose abandoned worst case is never released.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { harnessCopy, proposeReal } from "../src/proposer.mjs";
import { HARNESS_RUNTIME, hostEnvironment } from "../src/sandbox.mjs";
import { RETAINED_ROUTES, RequestBudget } from "../src/request-budget.mjs";
import { ROUTE, archiveCandidates, candidateView, registryRecords, routeUsage, syncCandidates } from "../src/screening.mjs";
import { runtimeDigest } from "../src/exploration.mjs";

const BUDGET_MODULE = fileURLToPath(new URL("../src/request-budget.mjs", import.meta.url));

test("wrapper contract: proposeReal, harnessCopy, hostEnvironment and HARNESS_RUNTIME keep the shapes the wrapper imports", () => {
  assert.deepEqual([...HARNESS_RUNTIME], ["src", "prompts", "package.json", "tsconfig.json"]);
  assert.equal(typeof proposeReal, "function");
  const params = /^async function proposeReal\(\{([^}]*)\}\)/.exec(proposeReal.toString())?.[1].split(",").map(s => s.trim());
  assert.deepEqual(params, ["worktree", "evidenceDir", "protocol", "env", "parentId", "targetClass", "blockedClasses", "logDir"]);

  const root = tempDir();
  try {
    const wt = join(root, "wt");
    for (const d of ["src", "prompts", "test", "fixtures", ".git"]) mkdirSync(join(wt, d), { recursive: true });
    writeFileSync(join(wt, "src", "a.ts"), "a\n"); writeFileSync(join(wt, "prompts", "p.md"), "p\n"); writeFileSync(join(wt, "package.json"), "{}\n");
    writeFileSync(join(wt, "test", "t.test.ts"), "t\n"); writeFileSync(join(wt, "fixtures", "hidden.js"), "h\n"); writeFileSync(join(wt, ".git", "HEAD"), "x\n");
    const dest = join(root, "copy");
    assert.equal(harnessCopy(wt, dest), dest, "returns the destination");
    assert.equal(readFileSync(join(dest, "src", "a.ts"), "utf8"), "a\n");
    assert.ok(existsSync(join(dest, "prompts", "p.md")) && existsSync(join(dest, "package.json")));
    assert.ok(!existsSync(join(dest, "tsconfig.json")), "a missing runtime part is skipped, not created");
    for (const hidden of ["test", "fixtures", ".git"]) assert.ok(!existsSync(join(dest, hidden)), `${hidden} is not copied`);
  } finally { rmSync(root, { recursive: true, force: true }); }

  const keys = ["EVAL_LOOP_PI_CLI", "EVAL_LOOP_PROVIDER", "EVAL_LOOP_AGENT_DIR", "EVAL_LOOP_UPSTREAM"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, { EVAL_LOOP_PI_CLI: "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", EVAL_LOOP_PROVIDER: "/opt/provider", EVAL_LOOP_AGENT_DIR: "/opt/agent", EVAL_LOOP_UPSTREAM: "http://127.0.0.1:9" });
    const env = hostEnvironment();
    for (const k of ["node", "nodeDir", "piCli", "piModules", "provider", "agentDir", "upstream", "bwrap", "orche"]) assert.ok(k in env, `release field ${k}`);
    assert.deepEqual({ piCli: env.piCli, piModules: env.piModules, provider: env.provider, agentDir: env.agentDir, upstream: env.upstream },
      { piCli: "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", piModules: "/opt/pi/node_modules", provider: "/opt/provider", agentDir: "/opt/agent", upstream: "http://127.0.0.1:9" });
    assert.equal(env.node, process.execPath);
    // Canonical additions default to identity (no frozen runtime): the in-box view equals the host view.
    assert.deepEqual({ boxNodeDir: env.boxNodeDir, boxPiModules: env.boxPiModules, catalogDir: env.catalogDir }, { boxNodeDir: env.nodeDir, boxPiModules: env.piModules, catalogDir: "/opt/agent" });
  } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
});

test("wrapper contract: the screening archive source registers the wrapper's minimal proposal (status selected, no decisions) as pending", () => {
  const root = tempDir();
  try {
    const stable = join(root, "stable"); mkdirSync(join(stable, "src"), { recursive: true });
    writeFileSync(join(stable, "src", "x.ts"), "export const s = 1;\n"); writeFileSync(join(stable, "package.json"), "{}\n");
    const S = "stable-commit-1";
    // <archiveRoot>/<baseline>/<id>/{candidate.json,patch.diff}: exactly the fields the wrapper writes.
    const arch = join(root, "proposals", "base-1");
    const id = "p-20261113-0001";
    mkdirSync(join(arch, id), { recursive: true });
    writeFileSync(join(arch, id, "candidate.json"), JSON.stringify({ id, status: "selected", parent: "stable", base: S, createdAt: "2026-11-13T01:00:00.000Z", hypothesis: { text: "tighten the worker prompt" } }));
    writeFileSync(join(arch, id, "patch.diff"), "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-export const s = 1;\n+export const s = 2;\n");

    const { list, problems } = archiveCandidates({ kind: "archive", dir: arch }, S);
    assert.deepEqual(problems, []);
    assert.equal(list.length, 1);
    assert.deepEqual({ id: list[0].id, status: list[0].status, chain: list[0].chain, problem: list[0].problem, createdAt: list[0].createdAt, hypothesis: list[0].hypothesis },
      { id: `base-1/${id}`, status: "selected", chain: [id], problem: null, createdAt: "2026-11-13T01:00:00.000Z", hypothesis: "tighten the worker prompt" });

    const cfg = { file: join(root, "screening.json"), stable: { dir: stable, commit: S, runtimeDigest: runtimeDigest(stable) }, pool: join(root, "pool"),
      screening: { registry: join(root, "series", "registry.jsonl"), workDir: join(root, "series", "work"), candidates: { sources: [{ kind: "archive", dir: arch }], maxCandidates: 4 }, caps: { dev: 1, holdout: 1, perCandidate: 1, perCycle: 1, cumulative: 1 } } };
    const { added } = syncCandidates(cfg);
    assert.equal(added.length, 1);
    assert.equal(added[0].archiveStatus, "selected");
    const view = candidateView(registryRecords(cfg), cfg);
    assert.deepEqual(view.map(c => ({ id: c.id, status: c.status })), [{ id: `base-1/${id}`, status: "pending" }], "registered for smoke/dev; never pre-decided");
    assert.equal(readFileSync(join(view[0].dir, "src", "x.ts"), "utf8"), "export const s = 2;\n", "materialized: stable tree + patch");
    assert.equal(syncCandidates(cfg).added.length, 0, "registered once");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("wrapper contract: proposal reservations share the ledger ceiling, stay out of the screening caps, settle at the forwarded count, and an abandoned one keeps its worst case", async () => {
  const root = tempDir();
  try {
    const path = join(root, "confirmatory-1.jsonl");
    const b = new RequestBudget({ path, limit: 4500, scope: "confirmatory-1" });
    assert.deepEqual([...RETAINED_ROUTES], ["proposal"]);
    // A settled proposal: the worst case is reserved first, then settled at the proxy's forwarded count.
    const p1 = await b.reserve(120, { route: "proposal", proposal: "p-1" });
    assert.equal(b.status().remaining, 4380, "the worst case leaves the shared ceiling at reservation");
    assert.equal(routeUsage(b.verified()).route, 0, "not a screening-route charge");
    await b.settle(p1, 37, { forwarded: 37 });
    const s = await b.reserve(200, { route: ROUTE });
    assert.equal(routeUsage(b.verified()).route, 200, "only the screening reservation counts against the route caps");
    await b.settle(s, 10);
    assert.equal(b.status().charged, 47);
    // A refused reservation (past the ceiling) is null: the wrapper ends with proposal-budget-exhausted, nothing runs.
    assert.equal(await b.reserve(4500 - 47 + 1, { route: "proposal" }), null);

    // Two reservations whose owner dies unsettled: reconciliation releases the engine-owned one to its attempt floor but settles the
    // abandoned proposal at its full worst case (closed, so it no longer blocks a later holdout's "no open reservation" check).
    const child = `import { RequestBudget } from ${JSON.stringify(BUDGET_MODULE)};
const b = new RequestBudget({ path: ${JSON.stringify(path)}, limit: 4500, scope: "confirmatory-1" });
await b.reserve(120, { route: "proposal", proposal: "p-2" });
await b.reserve(50, { route: "screening" });`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(b.status().charged, 47 + 120 + 50);
    const reconciled = await b.reconcileDead({ by: "test" });
    assert.deepEqual(reconciled.map(x => x.used).sort((x, y) => x - y), [0, 120], "screening released to its floor; proposal kept at its worst case");
    assert.equal(b.status().charged, 47 + 120, "the abandoned proposal stays charged in full");
    assert.equal(b.status().openReservations, 0);
    assert.deepEqual(b.verified().filter(x => x.type === "settle" && x.detail?.retained).map(x => x.used), [120]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
