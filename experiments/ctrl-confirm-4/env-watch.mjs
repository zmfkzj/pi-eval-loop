#!/usr/bin/env node
// ctrl-confirm-4 runtime-environment watchdog (not launch-bound; added 2026-11-08 after the launch, see records/ctrl-confirm-4/A2/POST-LAUNCH.md).
// Every attempt spawns pi, the provider extension, the route proxy and the orche harness's node_modules FROM DISK, but the runner
// checks the environment only at (re)start. A host maintenance job reinstalled the umbrella's node_modules on 2026-11-08 04:06Z
// (before this campaign's lock at 04:33:59Z). This watchdog makes a later change fail closed instead of silently mixing runtimes:
//   --baseline   record the current runtime identity (must equal the lock's environment and file digests) -> env-baseline.json
//   (default)    compare with the baseline; on any difference append ENV-DRIFT to env-watch.jsonl and stop the runner unit
//                (in-flight attempts become orphans that a resume reconciles). Resume only after the runtime is restored.
// It never edits the ledgers, the lock or the queue. Exit 0 always (a timer runs it); it stops its own timer when FINAL.json exists.
//
//   node pi-eval-loop/experiments/ctrl-confirm-4/env-watch.mjs --state pi-eval-loop/state/ctrl-confirm-4 [--baseline] [--unit ctrl-confirm-4]
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { environmentDigest, hostEnvironment } from "../../src/sandbox.mjs";
import { evaluatorFiles, fileDigests } from "../../src/protocol.mjs";
import { digestOf, sha256, walkFiles } from "../../src/util.mjs";
import { experimentFiles } from "./run.mjs";
import { loadPrereg } from "./lib.mjs";

const fileHash = (p) => { try { return sha256(readFileSync(p)); } catch { return null; } };
const treeHash = (dir) => { try { return digestOf(Object.fromEntries(walkFiles(dir).filter(f => f.symlink === undefined).map(f => [f.path, sha256(readFileSync(join(dir, f.path)))]))); } catch { return null; } };

/** Runtime identity of the components every attempt loads from disk (no secrets). */
export function runtimeIdentity(prereg, env = hostEnvironment()) {
  return {
    envDigest: environmentDigest(env, prereg.route).digest,
    filesDigest: digestOf(fileDigests([...evaluatorFiles(), ...experimentFiles()])),
    orcheNodeModules: fileHash(join(env.orche, "node_modules/.package-lock.json")),
    providerTree: treeHash(env.provider),
    piCli: fileHash(env.piCli),
    piPackage: fileHash(resolve(env.piCli, "../../../package.json")),
  };
}

export const differences = (a, b) => Object.keys({ ...a, ...b }).filter(k => a[k] !== b[k]);

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { state: { type: "string" }, baseline: { type: "boolean", default: false }, unit: { type: "string", default: "ctrl-confirm-4" }, timer: { type: "string", default: "ctrl-confirm-4-envwatch.timer" } } });
  const stateDir = resolve(values.state ?? "pi-eval-loop/state/ctrl-confirm-4"), prereg = loadPrereg();
  const lock = JSON.parse(readFileSync(join(stateDir, "lock.json"), "utf8"));
  const now = runtimeIdentity(prereg), at = new Date().toISOString();
  const basePath = join(stateDir, "env-baseline.json"), log = join(stateDir, "env-watch.jsonl");
  if (values.baseline) {
    const bound = { envDigest: lock.envDigest, filesDigest: digestOf(lock.files) };
    const bad = differences(bound, { envDigest: now.envDigest, filesDigest: now.filesDigest });
    if (bad.length) { process.stderr.write(`REFUSED: the current runtime already differs from the lock (${bad.join(", ")})\n`); process.exit(2); }
    writeFileSync(basePath, `${JSON.stringify({ at, lockedAt: lock.lockedAt, identity: now }, null, 1)}\n`);
    process.stdout.write(`${JSON.stringify({ baseline: at })}\n`);
  } else {
    if (existsSync(join(stateDir, "FINAL.json"))) { try { execFileSync("systemctl", ["--user", "stop", values.timer]); } catch { /* not a timer run */ } process.exit(0); }
    const base = JSON.parse(readFileSync(basePath, "utf8")).identity;
    const diff = differences(base, now);
    if (diff.length) {
      appendFileSync(log, `${JSON.stringify({ at, type: "ENV-DRIFT", changed: diff, baseline: Object.fromEntries(diff.map(k => [k, base[k]])), now: Object.fromEntries(diff.map(k => [k, now[k]])), action: `systemctl --user stop ${values.unit}` })}\n`);
      try { execFileSync("systemctl", ["--user", "stop", values.unit]); } catch (e) { appendFileSync(log, `${JSON.stringify({ at, type: "stop-failed", error: String(e).slice(0, 200) })}\n`); }
      process.stderr.write(`ENV-DRIFT (${diff.join(", ")}): runner stopped\n`);
    } else appendFileSync(log, `${JSON.stringify({ at, type: "ok" })}\n`);
  }
}
