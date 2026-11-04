// Candidate isolation in git: every harness candidate is its own worktree of the orche repository on its own local branch
// (eval-loop/candidates/<id>), created from its parent's commit. Nothing is ever written to orche's own checkout, its current
// branch, or any remote. node_modules is an empty directory in the worktree; the sandbox binds orche's installed dependencies over
// it read-only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const IDENTITY = { GIT_AUTHOR_NAME: "pi-eval-loop", GIT_AUTHOR_EMAIL: "pi-eval-loop@localhost", GIT_COMMITTER_NAME: "pi-eval-loop", GIT_COMMITTER_EMAIL: "pi-eval-loop@localhost" };
export const git = (cwd, args, extraEnv = {}) => execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).toString();
export const head = (repo) => git(repo, ["rev-parse", "HEAD"]).trim();
export const isClean = (repo) => git(repo, ["status", "--porcelain", "--untracked-files=no"]).trim() === "";
export const branchOf = (id, namespace) => namespace ? `eval-loop/candidates/${namespace}/${id}` : `eval-loop/candidates/${id}`;

/** Create (or reuse, after a crash) the worktree of candidate `id` at `dir` from `base` commit. */
export function createWorktree(repo, id, base, dir, namespace) {
  const branch = branchOf(id, namespace);
  if (existsSync(join(dir, ".git"))) return { dir, branch, reused: true };
  rmSync(dir, { recursive: true, force: true });
  git(repo, ["worktree", "prune"]);
  const exists = git(repo, ["branch", "--list", branch]).trim() !== "";
  if (exists) git(repo, ["worktree", "add", "--quiet", dir, branch]);
  else git(repo, ["worktree", "add", "--quiet", "-b", branch, dir, base]);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  return { dir, branch, reused: false };
}

/** A detached worktree of an existing commit (the stable baseline and other read-only harness snapshots). */
export function snapshotWorktree(repo, commit, dir) {
  if (existsSync(join(dir, ".git"))) {
    if (head(dir) === commit) return { dir, reused: true };
    rmSync(dir, { recursive: true, force: true });
  }
  git(repo, ["worktree", "prune"]);
  git(repo, ["worktree", "add", "--quiet", "--detach", dir, commit]);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  return { dir, reused: false };
}

/** Changed paths and the diff of a worktree against `base` (working tree, untracked files included, node_modules excluded). */
export function changes(dir, base) {
  git(dir, ["add", "-A", "--", "."]);
  const files = git(dir, ["diff", "--cached", "--name-only", base]).split("\n").filter(Boolean);
  const patch = git(dir, ["diff", "--cached", "--no-color", base]);
  return { files, patch };
}

/** Commit the staged candidate change (fixed identity, no hooks, no signing). */
export function commit(dir, message) {
  git(dir, ["add", "-A", "--", "."]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message]);
  return head(dir);
}

export function removeWorktree(repo, dir) {
  try { git(repo, ["worktree", "remove", "--force", dir]); } catch { rmSync(dir, { recursive: true, force: true }); try { git(repo, ["worktree", "prune"]); } catch { /* ignore */ } }
}

/** Apply a unified patch in a worktree (scripted proposers and combinations). */
export function applyPatch(dir, patchFile) { git(dir, ["apply", "--whitespace=nowarn", patchFile]); }
