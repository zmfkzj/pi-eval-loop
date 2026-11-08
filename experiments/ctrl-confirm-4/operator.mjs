#!/usr/bin/env node
// ctrl-confirm-4 operator actions (not launch-bound). Never dispatches, never edits outcomes, never changes ceilings or the queue.
//   drain  --state DIR                 ask the live runner to stop dispatching (SIGUSR1): in-flight attempts finish and are recorded,
//                                      then it exits HELD (operator pause). The supported graceful pause.
//   hold   --state DIR --reason TEXT    record an operator hold in a STOPPED state (takes the single-runner lock).
//   resume --state DIR --reason TEXT    record the operator resume of a held pause in a STOPPED state, so the service command (which
//                                      never carries --operator-resume, to keep automatic restarts from releasing holds) continues.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RunnerLock } from "./resources.mjs";
import { resourceManagerOf } from "./run.mjs";
import { loadPrereg } from "./lib.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { state: { type: "string" }, reason: { type: "string" } } });
const stateDir = resolve(values.state ?? "pi-eval-loop/state/ctrl-confirm-4");
if (cmd === "drain") {
  const lock = JSON.parse(readFileSync(join(stateDir, "runner.lock"), "utf8"));
  process.kill(lock.pid, "SIGUSR1");
  process.stdout.write(`${JSON.stringify({ drain: "requested", pid: lock.pid })}\n`);
} else if (cmd === "hold" || cmd === "resume") {
  if (!values.reason) { process.stderr.write("--reason is required\n"); process.exit(64); }
  const lock = RunnerLock.acquire(stateDir); // refuses while a runner is alive
  try {
    const rm = resourceManagerOf(stateDir, loadPrereg());
    const p = rm.state().pause;
    if (cmd === "hold") { if (p) throw new Error(`already paused: ${JSON.stringify(p)}`); rm.pause(`operator hold: ${values.reason}`, "operator"); }
    else { if (!p) throw new Error("not paused"); if (p.kind === "cap") throw new Error("a ceiling pause is final and is never resumed"); rm.resume(`operator resume of the ${p.kind} pause at ${p.at}: ${values.reason}`); }
    process.stdout.write(`${JSON.stringify({ [cmd]: "recorded", pause: rm.state().pause })}\n`);
  } finally { lock.release(); }
} else { process.stderr.write("usage: operator.mjs drain|hold|resume --state DIR [--reason TEXT]\n"); process.exit(64); }
