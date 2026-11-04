// Headless CLI of pi-eval-loop (bin/eval-loop.mjs). Never asks questions and never waits for input.
// Lock-taking modes (--once/--resume/--daemon/--rollback/--verify-stable/--ablation) end with ONE line of JSON on stdout
// (contract.mjs OUTCOME_SCHEMA; in --daemon one line per finished cycle, the last line is the invocation's outcome) and the exit
// code of contract.mjs EXIT. Logs go to stderr. Read-only modes (--status [--summary], --report, --doctor, --selftest) take no lock.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ablationParent, EXIT, inspectAblation, inspectState, outcomeRecord, statusSummary } from "./contract.mjs";
import { HaltedError } from "./loop.mjs";
import { acquireLock, LockBusyError, readJson, sleep } from "./util.mjs";

export const RUN_MODES = ["once", "resume", "daemon", "rollback", "verify-stable", "ablation"];
export const READ_MODES = ["status", "report", "doctor", "selftest"];
export const USAGE = [
  "usage: eval-loop --once|--resume|--daemon [--max-cycles N]|--rollback [--reason R]|--verify-stable --tasks DIR|--ablation",
  "                 [--state DIR] [--protocol FILE] [--strategy pareto|greedy] [--require-state]",
  "       eval-loop --status [--summary]|--report|--doctor|--selftest [--state DIR]",
].join("\n");

const OPTIONS = /** @type {const} */ ({
  once: { type: "boolean" }, resume: { type: "boolean" }, daemon: { type: "boolean" }, report: { type: "boolean" }, status: { type: "boolean" }, summary: { type: "boolean" },
  doctor: { type: "boolean" }, rollback: { type: "boolean" }, reason: { type: "string" }, "verify-stable": { type: "boolean" }, tasks: { type: "string" }, selftest: { type: "boolean" },
  ablation: { type: "boolean" }, state: { type: "string" }, protocol: { type: "string" }, strategy: { type: "string" }, "max-cycles": { type: "string" },
  "require-state": { type: "boolean" }, help: { type: "boolean", short: "h" },
});

const print = (x) => process.stdout.write(`${typeof x === "string" ? x : JSON.stringify(x, null, 2)}\n`);
/** The machine-readable outcome line (single-line JSON). */
export const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

/**
 * Read-only check of a state directory before any loop object exists (run again under the lock).
 * fresh: a new loop may start, unless --require-state (or a mode that needs an existing loop). missing/corrupt: never touched.
 * @returns {{ stop?: any, info?: any }} stop = the outcome record to end with
 */
export function preflight(stateDir, { mode, requireState = false }) {
  const parent = ablationParent(stateDir);
  // Recovery of the deployed refs works on any state, including halted ones (documented); a trajectory's rollback takes the
  // ablation's lock (see lockDirOf).
  if (mode === "rollback") return {};
  // A trajectory of an ablation is driven only through --ablation on its parent (one lock for all three trajectories).
  if (parent) return { stop: outcomeRecord("usage", { stateDir, detail: `${stateDir} is a trajectory of the ablation ${parent}: run --ablation --state ${parent}` }) };
  const info = /** @type {any} */ (mode === "ablation" ? inspectAblation(stateDir) : inspectState(stateDir));
  if (info.health === "missing" || info.health === "corrupt") return { stop: outcomeRecord("state_error", { stateDir, health: info.health, detail: info.detail }) };
  if (info.health === "fresh" && (requireState || mode === "verify-stable")) return { stop: outcomeRecord("state_error", { stateDir, health: "fresh", detail: requireState ? "no loop state and --require-state: refusing to initialize a new loop" : "--verify-stable needs an existing loop state" }) };
  const halted = mode === "ablation" ? info.halted?.reason : info.state?.halted;
  if (halted) return { stop: outcomeRecord("halted", { stateDir, state: info.state, detail: mode === "ablation" ? `trajectory ${info.halted.arm} is halted` : undefined }) };
  return { info };
}

/**
 * One supervised step of a loop: a blocked state resumes at its recorded phase; a finished cycle restarts only on a substantive
 * change (tasks, harness code, environment, protocol inputs); otherwise the in-flight cycle runs to its end.
 * @param {import("./loop.mjs").Loop} loop
 * @returns {Promise<{ kind: "idle" | "cycle_done" | "blocked" | "halted" | "interrupted" | "incomplete", note?: string }>}
 */
export async function driveOnce(loop) {
  if (loop.haltedNow()) return { kind: "halted" };
  const s = loop.state;
  const finished = s.phase === "done" && Boolean(s.cycleFingerprint);
  if (finished || (s.phase === "blocked" && s.blocked?.resumePhase === "done")) {
    if (!(await loop.prepare())) return { kind: loop.state.halted ? "halted" : "blocked" };
    if (loop.state.phase === "done" && loop.state.cycleFingerprint) {
      if (loop.fingerprint() === loop.state.cycleFingerprint) return { kind: "idle", note: "cycle complete; no change in tasks, harness, environment or protocol since it finished" };
      loop.nextCycle();
    }
  }
  const state = await loop.runCycle();
  if (state.halted) return { kind: "halted" };
  if (state.phase === "blocked") return { kind: "blocked" };
  if (loop.stopping) return { kind: "interrupted" };
  return { kind: state.phase === "done" ? "cycle_done" : "incomplete" };
}

/** Directory whose .lock a mode takes: the ablation's own directory for its trajectories (excludes a concurrent --ablation). */
export const lockDirOf = (stateDir) => ablationParent(stateDir) ?? stateDir;

/**
 * Signal and exit cleanup of a lock-taking invocation: SIGINT/SIGTERM/SIGHUP record lastInterruption (history only), kill the
 * registered sandbox process groups and route proxies, write the report, print the interrupted outcome, release the lock, exit 130.
 * An exception or rejection outside the main promise chain ends with the error outcome (exit 1) after the same cleanup.
 * @param {{ stateDir: string, getLoop: () => any, pids: Set<number>, lock: { release(): void }, stopProxies?: () => void, report?: () => void }} options
 */
export function installCleanup({ stateDir, getLoop, pids, lock, stopProxies = () => {}, report = () => {} }) {
  const kill = () => { for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } } pids.clear(); stopProxies(); };
  let signalled = false;
  const stateOf = () => { try { return getLoop()?.state; } catch { return undefined; } };
  const onSignal = (signal) => {
    if (signalled) return;
    signalled = true;
    const loop = getLoop();
    if (loop) { loop.stopping = true; try { loop.state.lastInterruption = { at: new Date().toISOString(), signal, phase: loop.state.phase }; loop.save(); } catch { /* best effort */ } }
    kill();
    if (loop) { try { report(); } catch { /* best effort */ } }
    emit(outcomeRecord("interrupted", { stateDir, state: stateOf(), signal }));
    lock.release();
    process.exit(EXIT.interrupted);
  };
  const onFatal = (error) => {
    if (signalled) return;
    signalled = true;
    kill();
    process.stderr.write(`[eval-loop] fatal: ${error?.stack ?? error}\n`);
    emit(outcomeRecord("error", { stateDir, state: stateOf(), error: { name: error?.name ?? "Error", code: error?.code ?? null } }));
    lock.release();
    process.exit(EXIT.error);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, onSignal);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  process.on("exit", () => { kill(); lock.release(); });
  return { kill };
}

/** Run the CLI; resolves with the exit code (the bin exits with it). @param {string[]} argv */
export async function main(argv) {
  /** @type {Record<string, any>} */ let values;
  try { ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true })); } catch (error) { process.stderr.write(`${error.message}\n${USAGE}\n`); emit(outcomeRecord("usage", { stateDir: null, detail: error.message })); return EXIT.usage; }
  const modes = Object.keys(values).filter(k => [...RUN_MODES, ...READ_MODES].includes(k) && values[k]);
  if (values.help) { print(USAGE); return 0; }
  if (!modes.length) { print(USAGE); return EXIT.usage; }
  const stateDir = resolve(values.state ?? (await import("./app.mjs")).DEFAULT_STATE);

  // ---- read-only modes (no lock, no state change)
  if (values.report) { const { writeReport } = await import("./report.mjs"); const r = writeReport(stateDir); print(r.markdown); print(`report: ${r.path}`); return 0; }
  if (values.status) {
    if (values.summary) { const s = /** @type {any} */ (statusSummary(stateDir)); emit(s); return s.condition === "state_error" ? EXIT.state_error : 0; }
    // Human view: the full state file as recorded (unchanged format); --summary is the stable machine view.
    let state;
    try { state = readJson(join(stateDir, "state.json"), null); } catch (error) { emit(outcomeRecord("state_error", { stateDir, health: "corrupt", detail: `state.json unreadable (${error.code ?? error.name})` })); return EXIT.state_error; }
    print(state ?? { phase: "none", note: `no state in ${stateDir}` });
    return 0;
  }
  if (values.doctor) { const { prerequisites, hostEnvironment } = await import("./sandbox.mjs"); const p = await prerequisites(hostEnvironment()); print(p); return p.every(x => x.ok) ? 0 : EXIT.blocked; }
  if (values.selftest) { const { selftest } = await import("./selftest.mjs"); const r = await selftest({ log: line => process.stderr.write(`[selftest] ${line}\n`) }); print(r.summary); return r.ok ? 0 : 1; }

  // ---- lock-taking modes
  const mode = values.rollback ? "rollback" : values["verify-stable"] ? "verify-stable" : values.ablation ? "ablation" : values.daemon ? "daemon" : values.once ? "once" : "resume";
  const usage = (detail) => { process.stderr.write(`${detail}\n${USAGE}\n`); emit(outcomeRecord("usage", { stateDir, detail })); return EXIT.usage; };
  const strategy = values.strategy ?? "pareto";
  if (strategy !== "pareto" && strategy !== "greedy") return usage(`--strategy must be pareto or greedy (got ${strategy})`);
  const maxCycles = mode === "daemon" ? Number(values["max-cycles"] ?? Infinity) : 1;
  if (!(maxCycles >= 1)) return usage(`--max-cycles must be a positive number (got ${values["max-cycles"]})`);
  if (mode === "verify-stable" && (!values.tasks || !existsSync(values.tasks))) return usage("--verify-stable needs --tasks <sealed dataset dir>");
  const requireState = Boolean(values["require-state"]);

  // Signal handling is installed first, so every interruption ends with the outcome line and exit 130 (and releases a held lock).
  const pids = new Set();
  /** @type {any} */ let loop;
  /** @type {{ release(): void } | undefined} */ let lock;
  let stopProxiesFn = () => {}, reportFn = () => {};
  const cleanup = installCleanup({ stateDir, getLoop: () => loop, pids, lock: { release: () => lock?.release() }, stopProxies: () => stopProxiesFn(), report: () => reportFn() });
  const stateOf = () => { try { return loop?.state; } catch { return undefined; } };
  try {
    // Refuse before the lock creates anything (a missing or required state is never initialized), then again under the lock.
    const early = preflight(stateDir, { mode, requireState });
    if (early.stop) { emit(early.stop); return early.stop.exitCode; }
    try { lock = acquireLock(join(lockDirOf(stateDir), ".lock")); } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      emit(outcomeRecord("busy", { stateDir, lock: { state: error.verdict.state, why: error.verdict.why, owner: error.owner ?? null } }));
      return EXIT.busy;
    }
    const held = /** @type {any} */ (lock);
    if (held.stale) process.stderr.write(`[eval-loop] recovered stale lock: ${held.recovered.map(r => r.why).join("; ")}\n`);
    const { stopProxies } = await import("./sandbox.mjs");
    const { writeReport } = await import("./report.mjs");
    stopProxiesFn = () => stopProxies();
    reportFn = () => { if (loop) writeReport(mode === "ablation" ? join(stateDir, "A") : stateDir); };
    const owned = preflight(stateDir, { mode, requireState });
    if (owned.stop) { emit(owned.stop); return owned.stop.exitCode; }
    const fresh = owned.info?.health === "fresh";
    const { realLoop } = await import("./app.mjs");

    if (mode === "rollback") {
      loop = realLoop({ stateDir, protocolPath: values.protocol });
      const result = loop.deployer.rollback({ reason: values.reason ?? "manual rollback (CLI)" });
      print(result);
      const kind = result.problems.length ? "error" : "ok";
      emit(outcomeRecord(kind, { stateDir, mode, problems: result.problems.length }));
      return EXIT[kind];
    }
    if (mode === "verify-stable") {
      const { loadLocal } = await import("./datasets.mjs");
      loop = realLoop({ stateDir, protocolPath: values.protocol, pids });
      if (!(await loop.prepare())) { emit(outcomeRecord("blocked", { stateDir, state: loop.state, mode })); return EXIT.blocked; }
      const result = await loop.verifyStable({ tasks: loadLocal(resolve(/** @type {string} */ (values.tasks))) });
      print(result);
      emit(outcomeRecord("ok", { stateDir, state: loop.state, mode, verdict: result.verdict }));
      return 0;
    }
    if (mode === "ablation") {
      const { runAblation } = await import("./ablation.mjs");
      const r = await runAblation({ stateDir, protocolPath: values.protocol, pids });
      print(r.summary);
      const kind = /** @type {keyof typeof EXIT} */ (r.outcome in EXIT ? r.outcome : r.ok ? "ok" : "incomplete");
      emit(outcomeRecord(kind, { stateDir, mode, detail: r.ok ? undefined : r.summary?.phase }));
      return EXIT[kind];
    }

    loop = realLoop({ stateDir, protocolPath: values.protocol, strategy, pids });
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      const result = await driveOnce(loop);
      if (result.kind === "idle" && mode === "daemon") { await sleep(loop.protocol.watchdog.daemonPollMs); cycle--; continue; }
      if (result.kind !== "idle") { try { writeReport(stateDir); } catch (error) { process.stderr.write(`[eval-loop] report: ${error.message}\n`); } }
      emit(outcomeRecord(result.kind, { stateDir, state: loop.state, mode, note: result.note, initialized: fresh && cycle === 0 ? true : undefined }));
      if (mode !== "daemon" || result.kind !== "cycle_done") return EXIT[result.kind];
    }
    return 0;
  } catch (error) {
    if (error instanceof HaltedError) { emit(outcomeRecord("halted", { stateDir, state: stateOf(), mode })); return EXIT.halted; }
    process.stderr.write(`[eval-loop] error: ${error?.stack ?? error}\n`);
    emit(outcomeRecord("error", { stateDir, state: stateOf(), mode, error: { name: error?.name ?? "Error", code: error?.code ?? null } }));
    return EXIT.error;
  } finally { cleanup.kill(); lock?.release(); }
}
