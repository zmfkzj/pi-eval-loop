// Physical isolation, probed from INSIDE a real bubblewrap sandbox built with exactly the task agent's mounts (agentBinds) and the
// proposer's harness copy: hidden tests, references, the sealed holdout, credentials, the umbrella and its git history, other state
// and the network must be unreachable, also through planted symlinks. Skipped (and reported as skipped) without bwrap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { agentBinds } from "../src/runner.mjs";
import { BOX } from "../src/runner.mjs";
import { harnessCopy } from "../src/proposer.mjs";
import { hostEnvironment, MOUNTS, runSandboxed } from "../src/sandbox.mjs";
import { PACKAGE_DIR, UMBRELLA } from "../src/protocol.mjs";
import { rmSync, tempDir } from "./helpers.mjs";

// Under an isolated HOME (the umbrella's compat gate) the global Pi install is absent: its mount is then left out; every other
// mount is the real one, so the isolation properties below are still probed. Credentials are looked up in the account's real
// home (passwd), not $HOME.
const env = hostEnvironment();
const noPi = !existsSync(env.piModules);
const present = (binds) => binds.filter(b => existsSync(b.from));
const homedir = () => userInfo().homedir;
const bwrapWorks = (() => { try { execFileSync(env.bwrap, ["--ro-bind", "/", "/", "--unshare-net", "--unshare-pid", "--tmpfs", "/home", "true"], { stdio: "ignore", timeout: 10_000 }); return true; } catch { return false; } })();
const orcheReady = existsSync(join(env.orche, "src/extension/index.ts")) && existsSync(join(env.orche, "fixtures/suite"));

const SECRET_PATHS = [
  join(UMBRELLA, ".git"), join(UMBRELLA, "orche/fixtures/suite"), join(UMBRELLA, "orche/.git"), join(PACKAGE_DIR, "datasets/holdout-v1/SEAL.json"),
  join(PACKAGE_DIR, "datasets/holdout-v1/h1-interval-merge/hidden"), join(PACKAGE_DIR, "datasets/holdout-v1/h1-interval-merge/reference"), join(PACKAGE_DIR, "src/grader.mjs"),
  join(homedir(), ".pi/agent/auth.json"), join(homedir(), ".pi/agent/cliproxyapi.json"), join(homedir(), ".ssh"), "/var/tmp/pi-arthur",
];

const PROBE = `
const fs = require("fs"), net = require("net"), cp = require("child_process");
const out = { visible: {}, readable: {}, net: {}, git: null, outsideLinks: [] };
const paths = JSON.parse(process.env.EL_PROBE_PATHS);
for (const p of paths) { out.visible[p] = fs.existsSync(p); try { fs.readFileSync(p); out.readable[p] = true; } catch { out.readable[p] = false; } }
try { out.git = cp.execFileSync("git", ["-C", process.env.EL_PROBE_HARNESS, "log", "--oneline", "-1"], { stdio: ["ignore", "pipe", "pipe"] }).toString(); } catch { out.git = null; }
for (const root of JSON.parse(process.env.EL_PROBE_LINK_ROOTS)) {
  let names = []; try { names = fs.readdirSync(root); } catch {}
  for (const n of names) { const p = root + "/" + n; try { if (fs.lstatSync(p).isSymbolicLink()) { const real = fs.realpathSync(p); if (real.startsWith(process.env.EL_PROBE_UMBRELLA)) out.outsideLinks.push(p + " -> " + real); } } catch {} }
}
const tryConnect = (host, port) => new Promise(r => { const s = net.connect({ host, port, timeout: 2000 }); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); s.on("timeout", () => { s.destroy(); r(false); }); });
(async () => { out.net.upstream = await tryConnect("127.0.0.1", 8317); out.net.external = await tryConnect("1.1.1.1", 443); console.log(JSON.stringify(out)); })();
`;

async function probe(binds, extraPaths, harnessInside) {
  const paths = [...SECRET_PATHS, ...extraPaths];
  const run = await runSandboxed({
    binds: present(binds), cwd: "/", command: [env.node, "-e", PROBE],
    env: { PATH: `${env.nodeDir}/bin:/usr/bin:/bin`, HOME: `${BOX}/home`, EL_PROBE_PATHS: JSON.stringify(paths), EL_PROBE_HARNESS: harnessInside, EL_PROBE_UMBRELLA: UMBRELLA, EL_PROBE_LINK_ROOTS: JSON.stringify([...(noPi ? [] : [env.piModules]), join(env.nodeDir, "lib/node_modules"), `${harnessInside}/node_modules`]) },
  }, { guardMs: 60_000 });
  const line = run.text.trim().split("\n").filter(l => l.startsWith("{")).at(-1);
  assert.ok(line, `probe produced no result: ${run.text.slice(-500)}`);
  return JSON.parse(line);
}

test("task-agent sandbox: only the harness runtime is visible; hidden/reference/holdout/credentials/git/network are not", { skip: !bwrapWorks ? "bwrap with namespaces unavailable" : !orcheReady ? "orche checkout missing" : false, timeout: 120_000 }, async () => {
  const root = tempDir();
  try {
    const box = join(root, "box"); mkdirSync(join(box, "ws"), { recursive: true });
    // Planted symlinks into protected material (an agent could create these in its workspace).
    symlinkSync(join(homedir(), ".pi/agent/auth.json"), join(box, "ws/auth-link"));
    symlinkSync(join(PACKAGE_DIR, "datasets/holdout-v1"), join(box, "ws/holdout-link"));
    symlinkSync(join(UMBRELLA, "orche/fixtures/suite"), join(box, "ws/suite-link"));
    const launch = join(root, "launch.sh"); writeFileSync(launch, "#!/bin/sh\n");
    const socket = join(root, "model.sock"); writeFileSync(socket, "");
    const binds = agentBinds({ env, box, launch, socket, harness: { kind: "orche", dir: env.orche } });
    const H = MOUNTS.harness;
    const inside = [`${H}/src/extension/index.ts`, `${H}/fixtures`, `${H}/experiments`, `${H}/test`, `${H}/.git`, `${H}/docs`, `${BOX}/ws/auth-link`, `${BOX}/ws/holdout-link/SEAL.json`, `${BOX}/ws/suite-link`];
    const r = await probe(binds, inside, H);
    assert.equal(r.visible[`${H}/src/extension/index.ts`], true, "the extension runtime is mounted");
    for (const p of [...SECRET_PATHS, ...inside.slice(1)]) assert.equal(r.readable[p] || r.visible[p], false, `${p} must be unreachable`);
    assert.equal(r.git, null, "no git history of the harness inside");
    assert.deepEqual(r.outsideLinks, [], "no dependency symlink resolves into the umbrella");
    assert.equal(r.net.upstream, false, "the model upstream is reachable only through the gated socket");
    assert.equal(r.net.external, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("proposer sandbox: the harness copy has no fixtures, tests, experiments or .git; protected material stays unreachable", { skip: !bwrapWorks ? "bwrap with namespaces unavailable" : !orcheReady ? "orche checkout missing" : false, timeout: 120_000 }, async () => {
  const root = tempDir();
  try {
    const copy = harnessCopy(env.orche, join(root, "harness"));
    const W = "/tmp/work/harness";
    const binds = [{ from: env.nodeDir }, { from: env.piModules }, { from: copy, to: W, rw: true }, { from: join(env.orche, "node_modules"), to: `${W}/node_modules` }];
    const inside = [`${W}/src/extension/index.ts`, `${W}/fixtures`, `${W}/experiments`, `${W}/test`, `${W}/.git`, `${W}/fixtures/suite/a1-rounding/reference`];
    const r = await probe(binds, inside, W);
    assert.equal(r.visible[`${W}/src/extension/index.ts`], true);
    for (const p of [...SECRET_PATHS, ...inside.slice(1)]) assert.equal(r.readable[p] || r.visible[p], false, `${p} must be unreachable`);
    assert.equal(r.git, null);
    assert.equal(r.net.upstream, false);
    assert.equal(r.net.external, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
