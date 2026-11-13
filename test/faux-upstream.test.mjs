// The faux upstream's per-unit draw must not depend on the per-run unit key suffix of the session id (2026-11-07: the selftest's
// screening outcome changed between runs because the key hashes the run-specific registration time).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rmSync, tempDir } from "./helpers.mjs";
import { startFauxUpstream } from "../src/faux-upstream.mjs";

test("faux upstream: the solve draw is a function of the unit identity, not the run-specific key suffix", async () => {
  const root = tempDir();
  const dir = join(root, "t1");
  mkdirSync(join(dir, "reference"), { recursive: true });
  writeFileSync(join(dir, "reference", "a.js"), "export const a = 1;\n");
  const instruction = "Implement the a module exactly as specified in the task description.";
  const faux = await startFauxUpstream({ tasks: [{ id: "t1", dir, instruction, policy: { solve: 0.5 } }], model: "m", seed: "s" });
  const solves = async (session) => {
    const r = await fetch(`${faux.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt_cache_key: session, input: [{ role: "user", content: instruction }] }) });
    return (await r.text()).includes("\"function_call\"");
  };
  try {
    const draws = [];
    for (let rep = 0; rep < 24; rep++) {
      const a = await solves(`el-stable-t1-train-r${rep}-a1-2bf632da-0`);
      const b = await solves(`el-stable-t1-train-r${rep}-a1-80cfe39c-0`);
      assert.equal(a, b, `repeat ${rep}: same unit, different run key -> same draw`);
      draws.push(a);
    }
    assert.ok(draws.includes(true) && draws.includes(false), "different repeats still draw independently");
  } finally { await faux.stop(); rmSync(root, { recursive: true, force: true }); }
});
