import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import evalLoopExtension, { COMMAND, completeArgs, createEvalLoopExtension, parseArgs, runCli } from "../extension/index.js";
import { rmSync, tempDir } from "./helpers.mjs";

const fakePi = () => { const commands = new Map(); return { commands, registerCommand: (name, spec) => commands.set(name, spec) }; };
const fakeCtx = () => { const notes = []; return { notes, ui: { notify: (text, level) => notes.push({ text, level }), setStatus() {} } }; };

test("extension registers /eval-loop with argument completion and strict parsing", () => {
  const pi = fakePi();
  evalLoopExtension(pi);
  assert.deepEqual([...pi.commands.keys()], [COMMAND]);
  assert.equal(typeof pi.commands.get(COMMAND).getArgumentCompletions, "function");
  assert.deepEqual(completeArgs("st").map(i => i.value), ["status"]);
  assert.equal(completeArgs("status x"), null);
  assert.deepEqual(parseArgs("status --state /x"), { kind: "status", state: "/x" });
  assert.equal(parseArgs("once").kind, "error", "the loop itself never runs inside the interactive session");
  assert.equal(parseArgs("status extra").kind, "error");
});

test("/eval-loop status runs the real CLI on a state directory and reports its phase", async () => {
  const root = tempDir();
  try {
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "state.json"), JSON.stringify({ phase: "search", cycle: 2 }));
    const pi = fakePi(), ctx = fakeCtx();
    createEvalLoopExtension({ run: (args) => runCli(args) })(pi);
    await pi.commands.get(COMMAND).handler(`status --state ${state}`, ctx);
    assert.equal(ctx.notes.length, 1);
    assert.match(ctx.notes[0].text, /"phase": "search"/);
    assert.equal(ctx.notes[0].level, "info");
    await pi.commands.get(COMMAND).handler("bogus", ctx);
    assert.equal(ctx.notes[1].level, "warning");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
