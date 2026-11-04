#!/usr/bin/env node
// Headless CLI of pi-eval-loop. Never asks questions; missing prerequisites end in a recorded BLOCKED state (exit 2).
//   eval-loop --once | --resume | --daemon | --report | --status | --doctor | --rollback [--reason R]
//             | --verify-stable --tasks <sealed dataset dir> | --selftest | --ablation
//   options: --state <dir> (default pi-eval-loop/state/default)  --protocol <override.json>  --strategy pareto|greedy
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { realLoop, DEFAULT_STATE } from "../src/app.mjs";
import { writeReport } from "../src/report.mjs";
import { acquireLock, readJson } from "../src/util.mjs";
import { prerequisites, hostEnvironment } from "../src/sandbox.mjs";
import { loadLocal } from "../src/datasets.mjs";

const { values } = parseArgs({ options: {
  once: { type: "boolean" }, resume: { type: "boolean" }, daemon: { type: "boolean" }, report: { type: "boolean" }, status: { type: "boolean" }, doctor: { type: "boolean" },
  rollback: { type: "boolean" }, reason: { type: "string" }, "verify-stable": { type: "boolean" }, tasks: { type: "string" }, selftest: { type: "boolean" }, ablation: { type: "boolean" },
  state: { type: "string" }, protocol: { type: "string" }, strategy: { type: "string" }, "max-cycles": { type: "string" }, help: { type: "boolean", short: "h" },
} });
const stateDir = resolve(values.state ?? DEFAULT_STATE);
const out = (x) => process.stdout.write(`${typeof x === "string" ? x : JSON.stringify(x, null, 2)}\n`);

if (values.help || !Object.keys(values).some(k => ["once", "resume", "daemon", "report", "status", "doctor", "rollback", "verify-stable", "selftest", "ablation"].includes(k))) {
  out("usage: eval-loop --once|--resume|--daemon|--report|--status|--doctor|--rollback|--verify-stable --tasks DIR|--selftest|--ablation [--state DIR] [--protocol FILE] [--strategy pareto|greedy]");
  process.exit(values.help ? 0 : 64);
}

if (values.report) { const r = writeReport(stateDir); out(r.markdown); out(`report: ${r.path}`); process.exit(0); }
if (values.status) { out(readJson(`${stateDir}/state.json`, { phase: "none", note: `no state in ${stateDir}` })); process.exit(0); }
if (values.doctor) { const p = await prerequisites(hostEnvironment()); out(p); process.exit(p.every(x => x.ok) ? 0 : 2); }
if (values.selftest) { const { selftest } = await import("../src/selftest.mjs"); const r = await selftest({ log: line => process.stderr.write(`[selftest] ${line}\n`) }); out(r.summary); process.exit(r.ok ? 0 : 1); }

const lock = acquireLock(`${stateDir}/.lock`);
const pids = new Set();
let loop;
const cleanup = () => { for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } } lock.release(); };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {
  if (loop) { loop.stopping = true; try { loop.state.interrupted = { at: new Date().toISOString(), signal }; loop.save(); } catch { /* best effort */ } }
  cleanup(); try { writeReport(stateDir); } catch { /* best effort */ }
  process.exit(130);
});
process.on("exit", () => lock.release());

try {
  if (values.rollback) {
    loop = realLoop({ stateDir, protocolPath: values.protocol });
    const result = loop.deployer.rollback({ reason: values.reason ?? "manual rollback (CLI)" });
    out(result); process.exit(result.problems.length ? 1 : 0);
  }
  if (values["verify-stable"]) {
    if (!values.tasks || !existsSync(values.tasks)) { out("--verify-stable needs --tasks <sealed dataset dir>"); process.exit(64); }
    loop = realLoop({ stateDir, protocolPath: values.protocol, pids });
    if (!(await loop.prepare())) { out(loop.state.blocked); process.exit(2); }
    out(await loop.verifyStable({ tasks: loadLocal(resolve(values.tasks)) })); process.exit(0);
  }
  if (values.ablation) { const { runAblation } = await import("../src/ablation.mjs"); const r = await runAblation({ stateDir, protocolPath: values.protocol, pids }); out(r.summary); process.exit(r.ok ? 0 : 2); }

  if (values.resume && !existsSync(`${stateDir}/state.json`)) { out(`--resume: no state in ${stateDir}; starting a new loop (same as --once)`); }
  const maxCycles = values.daemon ? Number(values["max-cycles"] ?? Infinity) : 1;
  const strategy = values.strategy ?? "pareto";
  if (strategy !== "pareto" && strategy !== "greedy") { out(`--strategy must be pareto or greedy (got ${strategy})`); process.exit(2); }
  loop = realLoop({ stateDir, protocolPath: values.protocol, strategy, pids });
  for (let cycle = 0; cycle < maxCycles && !loop.stopping; cycle++) {
    if (loop.state.phase === "done") {
      // A finished cycle restarts only on a substantive change (tasks, harness code, environment, protocol inputs).
      if (!(await loop.prepare())) break;
      if (loop.fingerprint() === loop.state.cycleFingerprint) {
        if (!values.daemon) { out({ phase: "done", note: "cycle complete; no change in tasks, harness or environment since it finished", final: loop.state.final }); break; }
        await new Promise(ok => setTimeout(ok, loop.protocol.watchdog.daemonPollMs));
        cycle--; continue;
      }
      loop.nextCycle();
    }
    const state = await loop.runCycle();
    writeReport(stateDir);
    if (state.phase === "blocked") { out({ phase: "blocked", blocked: state.blocked }); process.exitCode = 2; break; }
    out({ phase: state.phase, cycle: state.cycle, searchStop: state.searchStop, final: state.final && { verdict: state.final.verdict, candidate: state.final.candidate, reasons: state.final.reasons } });
    if (!values.daemon) break;
  }
} finally { cleanup(); }
