// Pi entry of pi-eval-loop: `/eval-loop status|report|doctor|help` inside a Pi session. The optimization loop itself is a headless
// program (bin/eval-loop.mjs: --once/--resume/--daemon/--report/...); it never runs inside the interactive session, so the command
// only reads its state, writes reports and checks prerequisites by running that CLI as a child process (Node builtins only).
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const COMMAND = "eval-loop";
export const SUBCOMMANDS = [
  { value: "status", label: "status", description: "Phase, counters, selection and adoption of the loop state" },
  { value: "report", label: "report", description: "Write and show report.md / report.json of the loop state" },
  { value: "doctor", label: "doctor", description: "Check the loop's prerequisites (bwrap, Pi, provider, orche, credentials, upstream)" },
  { value: "help", label: "help", description: "Usage of /eval-loop and the headless CLI" },
];
const CLI = fileURLToPath(new URL("../bin/eval-loop.mjs", import.meta.url));
export const USAGE = [
  "/eval-loop status|report|doctor [--state <dir>] — inspect the quality-first harness optimization loop.",
  "Run the loop headless from the umbrella root: npm run eval:loop -- --once | --resume | --daemon | --ablation; npm run eval:report.",
].join("\n");

export function parseArgs(args) {
  const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = words[0] ?? "help";
  if (!SUBCOMMANDS.some(s => s.value === sub)) return { kind: "error", message: `unknown subcommand "${sub}".\n${USAGE}` };
  const rest = words.slice(1);
  if (rest.length && !(rest.length === 2 && rest[0] === "--state")) return { kind: "error", message: `unexpected arguments "${rest.join(" ")}".\n${USAGE}` };
  return { kind: sub, state: rest[1] };
}

export function completeArgs(prefix) {
  const text = String(prefix ?? "");
  if (/\s/.test(text.trim()) || text.endsWith(" ")) return null;
  const items = SUBCOMMANDS.filter(s => s.value.startsWith(text.trim()));
  return items.length ? items : null;
}

/** Run the CLI (no shell); resolves { code, out }. */
export function runCli(args, { timeoutMs = 120_000, node = process.execPath } = {}) {
  return new Promise(resolve => {
    execFile(node, [CLI, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim() });
    });
  });
}

export function createEvalLoopExtension({ run = runCli } = {}) {
  return function evalLoopExtension(pi) {
    pi.registerCommand(COMMAND, {
      description: "Quality-first harness optimization loop: /eval-loop status|report|doctor|help",
      getArgumentCompletions: completeArgs,
      handler: async (args, ctx) => {
        const parsed = parseArgs(args);
        if (parsed.kind === "error") return ctx.ui.notify(parsed.message, "warning");
        if (parsed.kind === "help") return ctx.ui.notify(USAGE, "info");
        const flag = { status: "--status", report: "--report", doctor: "--doctor" }[parsed.kind];
        ctx.ui.setStatus?.(COMMAND, `${parsed.kind}…`);
        try {
          const { code, out } = await run([flag, ...(parsed.state ? ["--state", parsed.state] : [])]);
          ctx.ui.notify(`${out.slice(-6000) || "(no output)"}${code ? `\n(exit ${code})` : ""}`, code ? "warning" : "info");
        } finally { ctx.ui.setStatus?.(COMMAND, undefined); }
      },
    });
  };
}

export default createEvalLoopExtension();
