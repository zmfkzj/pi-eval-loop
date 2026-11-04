// Adoption and rollback on LOCAL refs only. A stable snapshot records the umbrella commit, every submodule gitlink and checkout
// HEAD, the configuration digests the evaluation used and the evaluation evidence. Adoption moves the local branch
// `eval-loop/stable` in orche to the adopted commit and writes a matching umbrella commit (same tree, orche gitlink replaced) on
// the umbrella's `eval-loop/stable` branch with git plumbing - no checkout, no working-tree change, no push, no production branch.
// Rollback restores both refs to a recorded snapshot and verifies the result.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./worktree.mjs";
import { Ledger, digestOf, sha256 } from "./util.mjs";

const refOf = (repo, ref) => { try { return git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim(); } catch { return null; } };

/** Submodule paths and recorded gitlinks of an umbrella commit. */
export function gitlinks(umbrella, commit = "HEAD") {
  const out = {};
  for (const line of git(umbrella, ["ls-tree", "-r", commit]).split("\n")) { const m = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(line); if (m) out[m[2]] = m[1]; }
  return out;
}

/** Snapshot of the current stable state (what a rollback restores). */
export function snapshot({ umbrella, orchePath = "orche", branch, configFiles = [], evaluation = null }) {
  const orche = join(umbrella, orchePath);
  const umbrellaStable = refOf(umbrella, `refs/heads/${branch}`);
  const orcheStable = refOf(orche, `refs/heads/${branch}`);
  const base = umbrellaStable ?? refOf(umbrella, "HEAD");
  const links = gitlinks(umbrella, base);
  const checkouts = {};
  for (const path of Object.keys(gitlinks(umbrella, "HEAD"))) { try { checkouts[path] = git(join(umbrella, path), ["rev-parse", "HEAD"]).trim(); } catch { checkouts[path] = null; } }
  const configs = Object.fromEntries(configFiles.map(file => [file, existsSync(file) ? sha256(readFileSync(file)) : null]));
  return { at: new Date().toISOString(), branch, umbrella: { head: refOf(umbrella, "HEAD"), stable: umbrellaStable, base, gitlinks: links }, orche: { stableRef: orcheStable, effective: orcheStable ?? links[orchePath] ?? null }, checkouts, configs, evaluation, digest: digestOf({ links, orcheStable, umbrellaStable, configs }), checkoutsNote: "checkout HEADs are recorded, never moved by eval-loop" };
}

/** Write an umbrella commit equal to `parent`'s tree with the gitlink at `path` set to `commit` (no working tree, no index change). */
export function umbrellaCommit(umbrella, parent, path, commit, message) {
  const dir = mkdtempSync(join(tmpdir(), "el-index-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    git(umbrella, ["read-tree", parent], env);
    git(umbrella, ["update-index", "--cacheinfo", `160000,${commit},${path}`], env);
    const tree = git(umbrella, ["write-tree"], env).trim();
    return git(umbrella, ["commit-tree", tree, "-p", parent, "-m", message], env).trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const ZERO = "0".repeat(40);

export class Deployer {
  /** fault(name): test hook called at every crash point of adoption/rollback (throwing there simulates a crash). */
  constructor({ umbrella, stateDir, branch = "eval-loop/stable", orchePath = "orche", mode = "refs", fault }) {
    Object.assign(this, { umbrella, branch, orchePath, mode, fault });
    this.history = new Ledger(join(stateDir, "stable-history.jsonl"));
    this.snapshots = join(stateDir, "snapshots");
  }
  get orche() { return join(this.umbrella, this.orchePath); }
  current(configFiles) { return snapshot({ umbrella: this.umbrella, orchePath: this.orchePath, branch: this.branch, configFiles }); }
  /** Keep the bytes of the loop-owned configuration files of a snapshot so a rollback can restore them. */
  keepConfigs(snap) {
    for (const [file, digest] of Object.entries(snap.configs ?? {})) if (digest && existsSync(file)) { mkdirSync(this.snapshots, { recursive: true }); copyFileSync(file, join(this.snapshots, digest)); }
    return snap;
  }
  /** Move refs/heads/<branch> of `repo` to `want`, but only from `old` (compare-and-swap); a no-op when already there. */
  moveRef(repo, want, old) {
    const cur = refOf(repo, `refs/heads/${this.branch}`);
    if (cur === want) return false;
    if ((cur ?? null) !== (old ?? null)) throw new Error(`${repo}: ${this.branch} is ${cur ?? "absent"}, expected ${old ?? "absent"} (concurrent change; refusing to overwrite)`);
    git(repo, ["update-ref", `refs/heads/${this.branch}`, want, old ?? ZERO]);
    return true;
  }

  /**
   * Adopt `commit` (an orche commit that exists locally), exactly once and crash-safe: the intent (previous snapshot and the
   * planned umbrella commit) is journaled BEFORE any ref moves; a resumed adoption reuses that intent (it never re-snapshots a
   * half-changed state as the rollback target) and moves each ref only from its recorded old value.
   */
  adopt({ commit, candidateId, evaluation, configFiles = [] }) {
    const adoptionId = digestOf({ commit, candidateId, protocol: evaluation?.protocolDigest ?? null, branch: this.branch });
    const recs = this.history.records();
    const done = recs.find(r => r.type === "adopted" && r.adoptionId === adoptionId);
    let intent = recs.find(r => r.type === "pre-adopt" && r.adoptionId === adoptionId);
    if (done && intent) return { previous: intent.snapshot, next: done.snapshot, resumed: true };
    if (!intent) {
      const previous = this.keepConfigs(this.current(configFiles));
      if (this.mode !== "dry" && !refOf(this.orche, commit)) throw new Error(`orche commit ${commit} not found locally`);
      const umbrellaNext = this.mode === "dry" ? null : umbrellaCommit(this.umbrella, previous.umbrella.base, this.orchePath, commit, `eval-loop: adopt ${candidateId} (orche ${commit.slice(0, 12)})\n\nAdopted by pi-eval-loop after the holdout adoption gate. Evaluation: ${evaluation?.reportPath ?? "see state"}.`);
      intent = this.history.append({ type: "pre-adopt", adoptionId, candidateId, commit, umbrellaCommit: umbrellaNext, snapshot: previous });
    }
    this.fault?.("adopt:after-intent");
    const previous = intent.snapshot;
    if (this.mode === "dry") { const rec = this.history.append({ type: "adopted", adoptionId, candidateId, commit, dry: true, snapshot: previous }); return { previous, next: rec.snapshot, dry: true }; }
    this.moveRef(this.orche, commit, previous.orche.stableRef);
    this.fault?.("adopt:after-orche-ref");
    this.moveRef(this.umbrella, intent.umbrellaCommit, previous.umbrella.stable);
    this.fault?.("adopt:after-umbrella-ref");
    const next = this.current(configFiles);
    next.evaluation = evaluation;
    this.history.append({ type: "adopted", adoptionId, candidateId, commit, umbrellaCommit: intent.umbrellaCommit, snapshot: next });
    return { previous, next };
  }

  /** The snapshot before the latest adoption (the rollback target), or undefined. */
  previousStable() { return this.history.records().filter(r => r.type === "pre-adopt").at(-1)?.snapshot; }

  /**
   * Restore `target` (default: the snapshot before the latest adoption): both stable refs, and every loop-owned configuration file
   * whose bytes were kept; then verify refs, effective orche commit, every submodule gitlink and the configuration digests.
   * Idempotent: a crash during rollback is repaired by running it again.
   */
  rollback({ reason, target } = {}) {
    target ??= this.previousStable();
    if (!target) throw new Error("no recorded stable snapshot to roll back to");
    const before = this.current(Object.keys(target.configs ?? {}));
    const restore = (repo, ref, value) => { if (value) git(repo, ["update-ref", `refs/heads/${ref}`, value]); else if (refOf(repo, `refs/heads/${ref}`)) git(repo, ["update-ref", "-d", `refs/heads/${ref}`]); };
    if (this.mode !== "dry") {
      restore(this.orche, this.branch, target.orche.stableRef);
      this.fault?.("rollback:after-orche-ref");
      restore(this.umbrella, this.branch, target.umbrella.stable);
      for (const [file, digest] of Object.entries(target.configs ?? {})) {
        const kept = digest && join(this.snapshots, digest);
        const now = existsSync(file) ? sha256(readFileSync(file)) : null;
        if (now !== digest && kept && existsSync(kept)) copyFileSync(kept, file);
      }
    }
    const after = this.current(Object.keys(target.configs ?? {}));
    const problems = [];
    if (this.mode !== "dry") {
      if ((after.umbrella.stable ?? null) !== (target.umbrella.stable ?? null)) problems.push("umbrella stable ref not restored");
      if ((after.orche.stableRef ?? null) !== (target.orche.stableRef ?? null)) problems.push("orche stable ref not restored");
      if (after.orche.effective !== target.orche.effective) problems.push("effective stable orche commit differs");
      for (const [file, digest] of Object.entries(target.configs ?? {})) if ((after.configs?.[file] ?? null) !== digest) problems.push(`configuration ${file} differs from the stable snapshot and no kept copy could restore it`);
      const linksAfter = gitlinks(this.umbrella, after.umbrella.base);
      for (const [path, sha] of Object.entries(target.umbrella.gitlinks)) if (linksAfter[path] !== sha) problems.push(`gitlink ${path} differs after rollback`);
      for (const path of Object.keys(linksAfter)) if (!(path in target.umbrella.gitlinks)) problems.push(`gitlink ${path} added after rollback`);
    }
    this.history.append({ type: "rolled-back", reason, from: before, to: target, problems });
    return { before, after, problems };
  }
}
