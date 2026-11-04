// Adoption / rollback crash points on temporary repositories: every crash resumes to exactly one adoption whose rollback target is
// the ORIGINAL snapshot, and rollback restores refs, gitlinks and loop-owned configuration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Deployer, gitlinks } from "../src/deploy.mjs";
import { edit, makeHoldout, makeLoop, makeTasks, makeUmbrella, HOLDOUT, TRAIN_DEV, rmSync, sh, tempDir } from "./helpers.mjs";

const ref = (repo, name = "refs/heads/eval-loop/stable") => { try { return sh(repo, ["rev-parse", "--verify", "--quiet", name]); } catch { return null; } };
function candidateCommit(orche) {
  writeFileSync(join(orche, "src/skill.txt"), "good\n");
  sh(orche, ["-c", "commit.gpgsign=false", "commit", "-qam", "candidate"]);
  const c = sh(orche, ["rev-parse", "HEAD"]);
  sh(orche, ["reset", "-q", "--hard", "HEAD~1"]);
  return c;
}

for (const point of ["adopt:after-intent", "adopt:after-orche-ref", "adopt:after-umbrella-ref"]) {
  test(`crash at ${point}: resume adopts exactly once from the original snapshot; rollback restores everything`, () => {
    const root = tempDir();
    try {
      const u = makeUmbrella(root);
      const stateDir = join(root, "state");
      const config = join(root, "protocol.lock.json");
      writeFileSync(config, "{\"v\":1}\n");
      const commit = candidateCommit(u.orche);
      const before = { orche: ref(u.orche), umbrella: ref(u.umbrella), links: gitlinks(u.umbrella, "HEAD") };
      assert.deepEqual([before.orche, before.umbrella], [null, null]);
      const crashing = new Deployer({ umbrella: u.umbrella, stateDir, fault: (name) => { if (name === point) throw new Error(`crash ${name}`); } });
      assert.throws(() => crashing.adopt({ commit, candidateId: "c001", evaluation: { protocolDigest: "p" }, configFiles: [config] }), /crash/);
      const d = new Deployer({ umbrella: u.umbrella, stateDir });
      const res = d.adopt({ commit, candidateId: "c001", evaluation: { protocolDigest: "p" }, configFiles: [config] });
      assert.equal(ref(u.orche), commit);
      assert.equal(gitlinks(u.umbrella, "refs/heads/eval-loop/stable").orche, commit, "umbrella stable gitlink = adopted orche commit");
      assert.equal(sh(u.umbrella, ["rev-parse", "HEAD"]), sh(u.umbrella, ["rev-parse", "main"]), "the operating branch is untouched");
      const hist = d.history.records();
      assert.equal(hist.filter(r => r.type === "pre-adopt").length, 1, "one intent");
      assert.equal(hist.filter(r => r.type === "adopted").length, 1, "one adoption");
      assert.equal(res.previous.orche.stableRef, null, "rollback target is the original (pre-crash) snapshot");
      assert.deepEqual(d.adopt({ commit, candidateId: "c001", evaluation: { protocolDigest: "p" }, configFiles: [config] }).resumed, true, "a further call is a no-op");
      assert.equal(d.history.records().filter(r => r.type === "adopted").length, 1);
      // A loop-owned configuration file changed after adoption is restored by the rollback.
      writeFileSync(config, "{\"v\":2}\n");
      const crashRb = new Deployer({ umbrella: u.umbrella, stateDir, fault: (name) => { if (name === "rollback:after-orche-ref") throw new Error("crash rb"); } });
      assert.throws(() => crashRb.rollback({ reason: "test" }), /crash rb/);
      const rb = d.rollback({ reason: "test resume" });
      assert.deepEqual(rb.problems, []);
      assert.equal(ref(u.orche), null);
      assert.equal(ref(u.umbrella), null);
      assert.equal(readFileSync(config, "utf8"), "{\"v\":1}\n");
      assert.deepEqual(gitlinks(u.umbrella, "HEAD"), before.links);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("a concurrent change of the stable ref is never overwritten by a resumed adoption", () => {
  const root = tempDir();
  try {
    const u = makeUmbrella(root);
    const commit = candidateCommit(u.orche);
    const stateDir = join(root, "state");
    const crashing = new Deployer({ umbrella: u.umbrella, stateDir, fault: (name) => { if (name === "adopt:after-intent") throw new Error("crash"); } });
    assert.throws(() => crashing.adopt({ commit, candidateId: "c001", evaluation: { protocolDigest: "p" } }));
    sh(u.orche, ["update-ref", "refs/heads/eval-loop/stable", u.base]);
    assert.throws(() => new Deployer({ umbrella: u.umbrella, stateDir }).adopt({ commit, candidateId: "c001", evaluation: { protocolDigest: "p" } }), /concurrent change/);
    assert.equal(ref(u.orche), u.base);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const point of ["loop:after-deploy", "loop:after-archive"]) {
  test(`loop crash at ${point}: resume records one adoption and finishes; rollback returns to the pre-adoption stable`, async () => {
    const root = tempDir();
    try {
      const fixtures = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
      const entries = () => [{ hypothesis: "better verification", targetFailureClass: "requirements-generalization", edit: edit("good") }];
      let armed = true;
      const { loop } = makeLoop({ root, fixtures, entries: entries(), fault: (name) => { if (armed && name === point) { armed = false; throw new Error(`crash ${name}`); } } });
      await assert.rejects(loop.runCycle(), /crash/);
      assert.equal(loop.state.phase, "adopt");
      const { loop: resumed } = makeLoop({ root, fixtures, entries: [] });
      const state = await resumed.runCycle();
      assert.equal(state.phase, "done");
      assert.equal(state.final.verdict, "ADOPT");
      assert.equal(resumed.deployer.history.records().filter(r => r.type === "adopted").length, 1);
      assert.equal(resumed.events.records().filter(e => e.type === "adopted").length, 1);
      assert.equal(resumed.archive.get(state.selection.selected).decisions.filter(d => d.status === "adopted").length, 1);
      assert.equal(ref(fixtures.orche), state.selection.commit);
      const rb = resumed.deployer.rollback({ reason: "test" });
      assert.deepEqual(rb.problems, []);
      assert.equal(ref(fixtures.orche), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
