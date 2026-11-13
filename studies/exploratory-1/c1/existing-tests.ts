import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Existing tests stay read-only (candidate c1, 2026-11-07). The test files a session finds when it starts are the project's
 * contract: an edit/write/ast_rewrite call that names one is refused with a pointer to a new test file. A change made another
 * way (a shell command, a directory-wide rewrite, a worker) is NOT undone by the harness: it is detected right after the tool
 * call and the model is told which file changed and to put it back itself, so whatever the workspace finally holds is the
 * model's own work. The guard writes nothing anywhere: its refusals and notes are part of the session transcript.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", "coverage", ".next", ".cache"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "testing"]);
const TEST_NAME = /^test_.*\.py$|_test\.py$|^conftest\.py$|\.(test|spec)\.[cm]?[jt]sx?$|^(test|test-[^/]+|[^/]+[-_]test)\.[cm]?[jt]s$/;
const MAX_FILES = 4000, MAX_BYTES = 2 * 1024 * 1024;

export const isExistingTestPath = (rel: string): boolean => {
  const parts = rel.split(/[\\/]/);
  return parts.slice(0, -1).some(part => TEST_DIRS.has(part)) || TEST_NAME.test(parts.at(-1) ?? "");
};

export function snapshotTests(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.size >= MAX_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path); continue; }
      if (!entry.isFile()) continue;
      const rel = relative(root, path);
      try { if (isExistingTestPath(rel) && statSync(path).size <= MAX_BYTES) out.set(rel, readFileSync(path)); } catch { /* unreadable: not guarded */ }
    }
  };
  walk(root);
  return out;
}

/** Snapshotted files whose content differs now or that are gone (relative paths). Read-only: nothing is written. */
export function changedTests(root: string, snapshot: Map<string, Buffer>): string[] {
  const changed: string[] = [];
  for (const [rel, original] of snapshot) {
    let now: Buffer | undefined;
    try { now = existsSync(join(root, rel)) ? readFileSync(join(root, rel)) : undefined; } catch { now = undefined; }
    if (!now || !now.equals(original)) changed.push(rel);
  }
  return changed;
}

const targetsOf = (toolName: string, input: Record<string, unknown>): string[] => {
  if (!["edit", "write", "ast_rewrite"].includes(toolName)) return [];
  const raw = [input.path, input.file, ...(Array.isArray(input.paths) ? input.paths : [])].filter((v): v is string => typeof v === "string" && v.length > 0);
  return raw.map(p => p.replace(/^@/, ""));
};

const newFileHint = (rel: string): string => {
  const m = rel.match(/^(.*?)([^/\\]+?)(\.(test|spec))?(\.[cm]?[jt]sx?|\.py)$/);
  return m ? `${m[1]}${m[2]}.extra${m[3] ?? ".test"}${m[5]}` : `${rel}.extra.test.js`;
};

/** Fixed phrases of the guard's messages (evidence is counted from transcripts by these). */
export const REFUSAL_MARK = "is read-only: the project's existing tests must stay byte-for-byte unchanged";
export const CHANGE_MARK = "Note: this call changed existing test file(s)";

export function installExistingTestsGuard(pi: ExtensionAPI): void {
  let root: string | undefined;
  let snapshot = new Map<string, Buffer>();
  const ensure = (cwd: string): void => {
    if (root) return;
    root = resolve(cwd);
    snapshot = snapshotTests(root);
  };
  pi.on("session_start", (_event, ctx) => { ensure(ctx.cwd); });
  pi.on("tool_call", (event, ctx) => {
    ensure(ctx.cwd);
    const hits = targetsOf(event.toolName, event.input as Record<string, unknown>)
      .map(p => relative(root!, resolve(ctx.cwd, p)))
      .filter(rel => !rel.startsWith(`..${sep}`) && snapshot.has(rel));
    if (!hits.length) return undefined;
    return { block: true, reason: `Existing test file ${hits.join(", ")} ${REFUSAL_MARK}. Put new or updated tests in a NEW test file (for example ${newFileHint(hits[0]!)}) that the existing test runner picks up, and leave ${hits.length === 1 ? "this file" : "these files"} as they are.` };
  });
  let reported = new Set<string>();
  pi.on("tool_result", (event) => {
    if (!root) return undefined;
    const changed = changedTests(root, snapshot);
    const fresh = changed.filter(rel => !reported.has(rel));
    reported = new Set(changed);
    if (!fresh.length) return undefined;
    const note = `${CHANGE_MARK} ${fresh.join(", ")}. Existing tests are read-only and must end byte-for-byte unchanged: restore ${fresh.length === 1 ? "it" : "them"} to the original content now (for example with git checkout -- <file>) and put new tests in new files.`;
    return { content: [...(event.content ?? []), { type: "text", text: note }] };
  });
}
