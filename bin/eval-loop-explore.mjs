#!/usr/bin/env node
// Recurring exploration-only cycles (src/explore-cycle.mjs). Same machine contract as bin/eval-loop.mjs for the modes the
// recurring orchestration uses (agent_workflow `evaluation: "exploration-only"`), plus the supply refresh of bin/eval-loop-supply.mjs:
//   eval-loop-explore --status --summary --state DIR                         status@1 (read-only)
//   eval-loop-explore --preflight --state DIR --protocol CONFIG                preflight@1 (model-free; exit 0 ok, 2 not ready)
//   eval-loop-explore --resume [--require-state] --state DIR --protocol CONFIG [--strategy S]   one cycle; outcome@1, EXIT codes
//   eval-loop-explore refresh --protocol CONFIG [--max-cases-per-repo N] [--max-batches N]       supply-refresh@1 (exit 0/2/3)
// CONFIG is a pi-eval-loop/exploration@1 file (README "Recurring exploration-only route"). Never adopts or schedules anything.
import { parseArgs } from "node:util";
import { EXIT } from "../src/contract.mjs";
import { explorePreflight, exploreStatus, refreshExploration, runExploreCycle } from "../src/explore-cycle.mjs";

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const argv = process.argv.slice(2);
const sub = argv[0] === "refresh" ? "refresh" : null;
let values;
try {
  ({ values } = parseArgs({ args: sub ? argv.slice(1) : argv, options: { status: { type: "boolean" }, summary: { type: "boolean" }, preflight: { type: "boolean" }, resume: { type: "boolean" }, "require-state": { type: "boolean" }, state: { type: "string" }, protocol: { type: "string" }, strategy: { type: "string" }, "max-cases-per-repo": { type: "string" }, "max-batches": { type: "string" } } }));
} catch (error) { process.stderr.write(`${error.message}\n`); process.exit(EXIT.usage); }

let code = EXIT.usage;
if (sub === "refresh") {
  if (!values.protocol) { process.stderr.write("refresh needs --protocol CONFIG\n"); process.exit(EXIT.usage); }
  const r = await refreshExploration(values.protocol, { maxCasesPerRepo: Number(values["max-cases-per-repo"] ?? 2), maxBatches: Number(values["max-batches"] ?? 1) });
  emit(r.out); code = r.code;
} else if (values.status) {
  if (!values.state) { process.stderr.write("--status needs --state DIR\n"); process.exit(EXIT.usage); }
  const s = exploreStatus(values.state);
  if (!values.summary) process.stdout.write(`${JSON.stringify(s, null, 1)}\n`);
  emit(s); code = s.condition === "state_error" ? EXIT.state_error : 0;
} else if (values.preflight) {
  if (!values.state || !values.protocol) { process.stderr.write("--preflight needs --state DIR --protocol CONFIG\n"); process.exit(EXIT.usage); }
  const r = await explorePreflight(values.protocol, values.state);
  emit(r); code = r.ok ? 0 : EXIT.blocked;
} else if (values.resume) {
  if (!values.state || !values.protocol) { process.stderr.write("--resume needs --state DIR --protocol CONFIG\n"); process.exit(EXIT.usage); }
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => { emit({ schema: "pi-eval-loop/outcome@1", outcome: "interrupted", exitCode: EXIT.interrupted, stateDir: values.state, at: new Date().toISOString() }); process.exit(EXIT.interrupted); });
  try { const o = await runExploreCycle(values.protocol, values.state, { requireState: Boolean(values["require-state"]) }); emit(o); code = o.exitCode; }
  catch (error) { process.stderr.write(`[eval-loop-explore] error: ${error?.stack ?? error}\n`); emit({ schema: "pi-eval-loop/outcome@1", outcome: "error", exitCode: EXIT.error, stateDir: values.state, error: { name: error?.name ?? "Error" }, at: new Date().toISOString() }); code = EXIT.error; }
} else process.stderr.write("usage: eval-loop-explore --status --summary | --preflight | --resume [--require-state] --state DIR --protocol CONFIG; refresh --protocol CONFIG\n");
process.exit(code);
