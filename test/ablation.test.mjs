import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { edit, makeHoldout, makeLoop, makeTasks, makeUmbrella, HOLDOUT, TRAIN_DEV, rmSync, sh, tempDir } from "./helpers.mjs";
import { runAblation } from "../src/ablation.mjs";
import { Ledger } from "../src/util.mjs";

test("A/B/C: shared baseline, separate B (greedy) and C (pareto) trajectories with equal budgets, one joint holdout use, C gated", async () => {
  const root = tempDir();
  try {
    const fixtures = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
    const scripts = {
      // Each trajectory gets its own proposer instance with the same scripted proposals (equal opportunity).
      B: () => [{ hypothesis: "first idea", targetFailureClass: "requirements-generalization", edit: edit("good") }, { hypothesis: "second idea", targetFailureClass: "requirements-generalization", edit: edit("bad") }],
      C: () => [{ hypothesis: "first idea", targetFailureClass: "requirements-generalization", edit: edit("good") }, { hypothesis: "second idea", targetFailureClass: "requirements-generalization", edit: edit("bad") }],
    };
    const loopFactory = async ({ stateDir, strategy }) => {
      const name = stateDir.split("/").at(-1);
      return makeLoop({ root, fixtures, stateName: join("abc", name), strategy, entries: scripts[name] ? scripts[name]() : [] }).loop;
    };
    const result = await runAblation({ stateDir: join(root, "abc"), loopFactory });
    assert.equal(result.ok, true, JSON.stringify(result.summary));
    const saved = JSON.parse(readFileSync(join(root, "abc/ablation.json"), "utf8"));
    assert.equal(saved.arms.A.id, "stable");
    assert.equal(saved.arms.B.id, "B-c001");
    assert.equal(saved.arms.C.id, "C-c001");
    assert.equal(saved.conditions.B.candidatesProposed, saved.conditions.C.candidatesProposed);
    assert.ok(saved.conditions.C.optimizationRuns > 0);
    assert.equal(new Ledger(join(fixtures.holdout.dir, "USES.jsonl")).records().length, 1, "one joint holdout use");
    assert.ok(saved.comparisons["C vs A (loop effect, Pareto)"].support > 0.95);
    assert.equal(saved.adoption.verdict, "ADOPT");
    assert.equal(sh(fixtures.orche, ["rev-parse", "refs/heads/eval-loop/stable"]), saved.arms.C.commit);
    assert.ok(existsSync(join(root, "abc/ablation.md")));
    // Resuming the finished ablation does not consume the holdout again.
    await runAblation({ stateDir: join(root, "abc"), loopFactory });
    assert.equal(new Ledger(join(fixtures.holdout.dir, "USES.jsonl")).records().length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
