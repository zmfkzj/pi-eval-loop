#!/usr/bin/env node
// Sibling-answer leaks between tasks of one project family (confirmatory-1, 2026-11-07; model-free; prints ids/paths/counts only).
//
// Sibling tasks are often derived from one starting project. If task X's starting repository contains a file exactly as sibling
// Y's REFERENCE has it (and Y's own starting repository has it differently), X's repository carries Y's solution. A unit's
// sandbox only holds its own repository (runner.mjs piAttempt: fresh box per attempt), but that boundary is NOT the safety
// argument: every run of X sends Y's answer to the target model's provider, and X's content reaches every reviewer provider.
// So a leak is removed by construction where possible:
//   isolate  version X so the leaked files are reverted to Y's starting (unsolved) version; X's own reference files that overlap
//            are rebuilt as a 3-way merge (Y's base + X's own change), i.e. the minimal solution of X alone. The version is
//            accepted only when (1) the reverted start passes its visible tests, (2) fails X's hidden tests, and (3) the minimal
//            solution passes X's hidden tests twice and the visible tests. Otherwise X depends on Y's fix and is NOT isolable:
//            it must not be eligible together with Y (recorded as ineligible).
// Content changes, so every cross-provider review of the earlier content no longer binds (datasets.crossProviderProblems):
// blind and adversarial reviews are redone on the version.
//
//   node studies/confirmatory-1/sibling.mjs scan --task DIR [--task DIR ...]
//   node studies/confirmatory-1/sibling.mjs isolate --task DIR --sibling DIR [--sibling DIR ...] --out DIR --scratch DIR [--supersede]
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";

const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);
const files = (d) => (existsSync(d) ? readdirSync(d, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => relative(d, join(e.parentPath ?? e.path, e.name))).sort() : []);
const idOf = (dir) => JSON.parse(readFileSync(join(dir, "task.json"), "utf8")).id;

/** Files of x/repo that equal a sibling's reference version where that sibling's own start differs: [{ file, sibling, siblingDir }]. */
export function leaksInto(xDir, siblingDirs) {
  const out = [];
  for (const y of siblingDirs) {
    if (resolve(y) === resolve(xDir)) continue;
    for (const f of files(join(y, "reference"))) {
      const ref = sha(join(y, "reference", f));
      if (ref && sha(join(xDir, "repo", f)) === ref && sha(join(y, "repo", f)) !== ref) out.push({ file: f, sibling: idOf(y), siblingDir: y });
    }
  }
  return out;
}

/** Leak matrix over a set of task directories (grouped by family by the caller). */
export function scan(dirs) {
  return dirs.map(x => ({ task: idOf(x), leaks: leaksInto(x, dirs).map(l => ({ file: l.file, sibling: l.sibling })) }));
}

/** node --test pass/fail counts in `cwd` (tap). */
export function runTests(cwd, tests = []) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...tests], { cwd, encoding: "utf8", timeout: 300_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: "UTC", LANG: "C.UTF-8" } });
  const num = (k) => { const m = [...String(r.stdout).matchAll(new RegExp(`^# ${k} (\\d+)$`, "gm"))].pop(); return m ? Number(m[1]) : null; };
  return { pass: num("pass"), fail: num("fail") };
}

const hiddenFiles = (dir) => files(join(dir, "hidden")).filter(f => /\.test\.[cm]?js$/.test(f));

/**
 * Build the isolated version of x (see header). Returns { ok, id, dir, reverted, merged, checks, problems }. Never edits x.
 * @param {{ xDir: string, siblingDirs: string[], out: string, scratch: string, supersede?: boolean, contentDigest: (dir: string, instruction: string) => string }} o
 */
export function isolate({ xDir, siblingDirs, out, scratch, supersede = false, contentDigest }) {
  const m = JSON.parse(readFileSync(join(xDir, "task.json"), "utf8"));
  const leaks = leaksInto(xDir, siblingDirs);
  if (!leaks.length) return { ok: true, id: m.id, unchanged: true, problems: [] };
  const version = (Number.isInteger(m.version) ? m.version : 1) + 1;
  const id = `${m.id.replace(/-v\d+$/, "")}-v${version}`;
  const vdir = join(out, id);
  if (existsSync(vdir)) return { ok: false, id, problems: [`${vdir} exists (a version is never rebuilt in place)`] };
  const work = join(scratch, `iso-${id}`);
  rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
  mkdirSync(vdir, { recursive: true, mode: 0o700 });
  for (const part of ["repo", "hidden", "reference", "review"]) if (existsSync(join(xDir, part))) cpSync(join(xDir, part), join(vdir, part), { recursive: true });
  const ownRef = new Set(files(join(xDir, "reference")));
  const reverted = [], merged = [], problems = [];
  for (const l of leaks) {
    const base = join(l.siblingDir, "repo", l.file);
    if (ownRef.has(l.file)) {
      // Minimal solution of x alone on the reverted file: base(Y start) + (x reference - x start), by a clean 3-way merge.
      const tmp = join(work, l.file.replace(/\//g, "_"));
      copyFileSync(join(xDir, "reference", l.file), tmp);
      const r = spawnSync("git", ["merge-file", "-p", tmp, join(xDir, "repo", l.file), base], { encoding: "utf8" });
      if (r.status !== 0) { problems.push(`${l.file}: x's own change does not merge cleanly onto ${l.sibling}'s start (${r.status} conflicts)`); continue; }
      writeFileSync(join(vdir, "reference", l.file), r.stdout);
      merged.push({ file: l.file, sibling: l.sibling, sha256: sha(join(vdir, "reference", l.file)) });
    }
    copyFileSync(base, join(vdir, "repo", l.file));
    reverted.push({ file: l.file, sibling: l.sibling, removedSha256: sha(join(xDir, "repo", l.file)), baseSha256: sha(base) });
  }
  const hidden = hiddenFiles(vdir).map(f => join("test", relative("test", f)));
  const stage = (name, parts) => { const d = join(work, name); cpSync(join(vdir, "repo"), d, { recursive: true }); for (const p of parts) cpSync(join(vdir, p), d, { recursive: true }); return d; };
  const checks = {};
  if (!problems.length) {
    checks.startVisible = runTests(stage("start", []));
    const s = stage("start-hidden", ["hidden"]);
    checks.startHidden = runTests(s, hidden);
    const sol = stage("solution", ["reference", "hidden"]);
    checks.solutionHidden1 = runTests(sol, hidden);
    checks.solutionHidden2 = runTests(sol, hidden);
    checks.solutionAll = runTests(sol);
    if (!(checks.startVisible.fail === 0 && checks.startVisible.pass > 0)) problems.push("reverted start fails its visible tests");
    if (!(checks.startHidden.fail > 0)) problems.push("reverted start passes the hidden tests");
    if (!(checks.solutionHidden1.fail === 0 && checks.solutionHidden2.fail === 0 && checks.solutionHidden1.pass > 0)) problems.push(`minimal solution fails ${checks.solutionHidden1.fail} hidden test(s): x depends on a sibling's fix (not isolable)`);
    if (!(checks.solutionAll.fail === 0)) problems.push("minimal solution fails the visible tests");
  }
  rmSync(work, { recursive: true, force: true });
  if (problems.length) { rmSync(vdir, { recursive: true, force: true }); return { ok: false, id, reverted, merged, checks, problems }; }
  const { crossProvider: _dropped, ...review } = m.review ?? {};
  const next = {
    ...m, id, version, [supersede ? "supersedes" : "derivedFrom"]: { id: m.id, contentDigest: contentDigest(xDir, m.instruction) },
    remedy: { kind: "sibling-isolation", at: new Date().toISOString(), reverted, mergedReference: merged, checks, note: "starting files that carried a sibling's reference version are reverted to that sibling's unsolved start; instruction and hidden tests unchanged" },
    expected: undefined,
    exposure: { ...m.exposure, knownExposure: [...(m.exposure?.knownExposure ?? []).filter(e => !/sibling tasks of one project/.test(e)), `earlier version ${m.id} carried sibling reference files (${[...new Set(reverted.map(r => r.sibling))].join(", ")}): that content reached the authoring and reviewer providers; removed in this version`] },
    review: { ...review, carriedFrom: { id: m.id, reason: "agent reviews (instruction, tests, reference) carried: this version changes only sibling files of the starting repository and the merged minimal reference; cross-provider review is redone on the new content" } },
  };
  writeFileSync(join(vdir, "task.json"), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, id, dir: vdir, reverted, merged, checks, problems: [] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: { task: { type: "string", multiple: true }, sibling: { type: "string", multiple: true }, out: { type: "string" }, scratch: { type: "string" }, supersede: { type: "boolean", default: false } } });
  const tasks = (values.task ?? []).map(t => resolve(t));
  if (mode === "scan") process.stdout.write(`${JSON.stringify(scan(tasks), null, 1)}\n`);
  else if (mode === "isolate") {
    const { taskContentDigest } = await import("../../src/datasets.mjs");
    const rows = tasks.map(x => { const r = isolate({ xDir: x, siblingDirs: (values.sibling ?? []).map(s => resolve(s)), out: resolve(values.out), scratch: resolve(values.scratch), supersede: values.supersede, contentDigest: taskContentDigest }); return { task: idOf(x), ok: r.ok, version: r.unchanged ? null : r.id, reverted: r.reverted?.map(v => `${v.file}<-${v.sibling}`), merged: r.merged?.map(v => v.file), checks: r.checks, problems: r.problems }; });
    process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
    process.exit(rows.every(r => r.ok) ? 0 : 2);
  } else { process.stderr.write("usage: sibling.mjs scan|isolate ...\n"); process.exit(64); }
}
