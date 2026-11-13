#!/usr/bin/env node
// Triage of cross-provider reviews (confirmatory-1, 2026-11-07; model-free): per task, the latest COMPLETE blind and adversarial
// review, cross-checked mechanically - every mutant the official hidden tests accept is also run against the independent blind
// tests (a mutant accepted by the official tests but rejected by the blind ones corroborates a test gap). Writes
// <reviews>/<task>/triage.json and prints a non-secret summary (ids, counts, classes; no task content).
//
// Classes (pre-declared; the adjudication decides only what stays open):
//   ok                      blind tests pass on the reference (twice) and fail on the start; no mutant accepted; verdict accept
//   test-gap                a mutant accepted by the official hidden tests (corroborated when the blind tests reject it)
//   reference-vs-blind      the reference fails the independent blind tests (reference defect, spec ambiguity or blind error)
//   blind-not-discriminating the starting repository passes the blind tests
//   reviewer-finding        adversarial verdict revise/reject with blocker/major findings
//   incomplete              a role has no complete review (provider failure); never treated as passing
//
//   node studies/confirmatory-1/triage.mjs --reviews DIR --task DIR [--task DIR ...]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { atomicWriteJson, ensureDir } from "../../src/util.mjs";
import { gradeOverlay } from "./review.mjs";

/** Latest complete review of a role: a session with completed model calls and its main output present. */
export function latestComplete(dir, role) {
  if (!existsSync(dir)) return null;
  const want = role === "blind-tests" ? (d) => existsSync(join(d, "output", "tests")) : (d) => existsSync(join(d, "output", "verdict.json"));
  const runs = readdirSync(dir).filter(n => n.startsWith(`${role}-`)).sort().reverse().map(n => join(dir, n));
  for (const d of runs) {
    try { const r = JSON.parse(readFileSync(join(d, "review.json"), "utf8")); if (r.run.completed > 2 && r.run.providerErrors === 0 && want(d) && existsSync(join(d, "mechanical.json"))) return d; } catch { /* incomplete */ }
  }
  return null;
}

/**
 * @param {{ task: any, reviews: string, env: any, scratchRoot: string, blindFrom?: { id: string, task: any } | null, priorMutants?: string[] }} o
 * blindFrom: a corrected version whose instruction and starting repository are byte-identical to `blindFrom.task` reuses that
 * version's latest complete blind-test session (no new model call); its mechanical checks are RE-RUN against this version's
 * reference and starting repository. priorMutants: mutant directories of earlier versions; each must now be rejected by this
 * version's hidden tests (remedy check), else class "remedy-incomplete".
 */
export async function triageTask({ task, reviews, env, scratchRoot, blindFrom = null, priorMutants = [] }) {
  const dir = join(reviews, task.id);
  let blindDir = latestComplete(dir, "blind-tests");
  const advDir = latestComplete(dir, "adversarial");
  const classes = new Set();
  const out = { task: task.id, blind: null, adversarial: null, mutants: [], classes: [] };
  if (!blindDir && blindFrom) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const ti = JSON.parse(readFileSync(join(task.dir, "task.json"), "utf8")), oi = JSON.parse(readFileSync(join(blindFrom.task.dir, "task.json"), "utf8"));
    const { sealOf } = await import("../../src/datasets.mjs");
    const repoSame = sealOf(join(task.dir, "repo")).digest === sealOf(join(blindFrom.task.dir, "repo")).digest;
    const reused = latestComplete(join(reviews, blindFrom.id), "blind-tests");
    if (same(ti.instruction, oi.instruction) && repoSame && reused) {
      blindDir = reused;
      const s = (n) => join(scratchRoot, `tri-${task.id}-blind-${n}`);
      const tests = join(reused, "output", "tests");
      const original = await gradeOverlay({ task, parts: [], tests, scratch: s("o"), env });
      const r1 = await gradeOverlay({ task, parts: [join(task.dir, "reference")], tests, scratch: s("r1"), env });
      const r2 = await gradeOverlay({ task, parts: [join(task.dir, "reference")], tests, scratch: s("r2"), env });
      out.blind = { dir: reused, reusedFrom: blindFrom.id, recomputed: true, tests: r1.tests, referencePasses: r1.pass && r2.pass, discriminates: !original.pass, referenceFailing: r1.failing, originalFailed: original.failed };
    } else out.blindReuseRefused = !reused ? `no complete blind review of ${blindFrom.id}` : "instruction or starting repository differs from the reviewed version";
  }
  if (!blindDir) classes.add("incomplete");
  else if (out.blind) {
    if (!out.blind.referencePasses) classes.add("reference-vs-blind");
    if (!out.blind.discriminates) classes.add("blind-not-discriminating");
  } else {
    const m = JSON.parse(readFileSync(join(blindDir, "mechanical.json"), "utf8"));
    out.blind = { dir: blindDir, tests: m.reference?.tests ?? 0, referencePasses: m.referencePasses, discriminates: m.discriminates, referenceFailing: m.reference?.failing ?? [], originalFailed: m.original?.failed ?? null };
    if (!m.referencePasses) classes.add("reference-vs-blind");
    if (!m.discriminates) classes.add("blind-not-discriminating");
  }
  if (priorMutants.length) {
    out.remedyCheck = [];
    for (const mdir of priorMutants) {
      const g = await gradeOverlay({ task, parts: [mdir], tests: join(task.dir, "hidden"), scratch: join(scratchRoot, `tri-${task.id}-prior-${out.remedyCheck.length}`), env });
      out.remedyCheck.push({ mutant: mdir.split("/").slice(-4).join("/"), hiddenAccepts: g.pass });
    }
    if (out.remedyCheck.some(r => r.hiddenAccepts)) classes.add("remedy-incomplete");
  }
  if (!advDir) classes.add("incomplete");
  else {
    const m = JSON.parse(readFileSync(join(advDir, "mechanical.json"), "utf8"));
    const v = m.verdict ?? {};
    out.adversarial = { dir: advDir, verdict: v.verdict ?? null, referencePassesHidden: m.referencePassesHidden, findings: (v.findings ?? []).map(f => ({ severity: f.severity, item: f.item })) };
    if (v.verdict !== "accept" && (v.findings ?? []).some(f => ["blocker", "major"].includes(f.severity))) classes.add("reviewer-finding");
    for (const u of m.mutants ?? []) {
      const row = { name: u.name, hiddenAccepts: u.hiddenAccepts, blindRejects: null };
      if (u.hiddenAccepts) {
        classes.add("test-gap");
        if (blindDir) { const g = await gradeOverlay({ task, parts: [join(advDir, "output", "mutants", u.name)], tests: join(blindDir, "output", "tests"), scratch: join(scratchRoot, `tri-${task.id}-${u.name}`), env }); row.blindRejects = !g.pass; row.blindFailing = g.failing.slice(0, 5); }
      }
      out.mutants.push(row);
    }
    if (!m.referencePassesHidden) classes.add("reference-fails-hidden");
  }
  out.classes = classes.size ? [...classes].sort() : ["ok"];
  atomicWriteJson(join(dir, "triage.json"), out);
  return out;
}

/**
 * Remedy chain of a corrected version (model-free): ancestor ids (derivedFrom, root = id without -vN) and the mutant directories
 * of every adjudicated violation in the ancestors' reviews (adjudication resolution "violation") plus the version's own
 * remedy.violations. Returns { ancestors, violations: [{ name, dir | null }] }.
 */
export function remedyChain({ task, reviews }) {
  const tj = JSON.parse(readFileSync(join(task.dir, "task.json"), "utf8"));
  const root = task.id.replace(/-v\d+$/, "");
  const ancestors = [...new Set([tj.derivedFrom?.id, root].filter(id => id && id !== task.id))];
  const names = new Set(tj.remedy?.violations ?? []);
  for (const a of ancestors) {
    const rd = join(reviews, a);
    if (!existsSync(rd)) continue;
    for (const s of readdirSync(rd).filter(n => n.startsWith("adjudicate-"))) {
      const p = join(rd, s, "output", "adjudication.json");
      if (!existsSync(p)) continue;
      try { for (const m of JSON.parse(readFileSync(p, "utf8")).mutants ?? []) if (m.resolution === "violation") names.add(m.name); } catch { /* unreadable adjudication: no names */ }
    }
  }
  const find = (name) => { for (const a of ancestors) { const rd = join(reviews, a); if (!existsSync(rd)) continue; for (const s of readdirSync(rd).sort()) { const d = join(rd, s, "output", "mutants", name); if (existsSync(d)) return d; } } return null; };
  return { ancestors, root, violations: [...names].sort().map(name => ({ name, dir: find(name) })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { reviews: { type: "string" }, task: { type: "string", multiple: true }, scratch: { type: "string" }, "orig-batch": { type: "string" } } });
  const { hostEnvironment } = await import("../../src/sandbox.mjs");
  const { loadLocal } = await import("../../src/datasets.mjs");
  const env = hostEnvironment();
  const reviews = resolve(values.reviews);
  const scratchRoot = ensureDir(resolve(values.scratch ?? join(reviews, "..", "scratch")));
  const originals = values["orig-batch"] ? loadLocal(resolve(values["orig-batch"])) : [];
  const rows = [];
  for (const d of values.task ?? []) {
    const dir = resolve(d); const task = loadLocal(resolve(dir, "..")).find(x => x.dir === dir);
    let blindFrom = null, priorMutants = [], chain = null;
    if (/-v\d+$/.test(task.id) && originals.length) {
      chain = remedyChain({ task, reviews });
      const orig = originals.find(t => t.id === chain.root);
      if (orig) blindFrom = { id: orig.id, task: orig };
      priorMutants = chain.violations.filter(v => v.dir).map(v => v.dir);
    }
    const t = await triageTask({ task, reviews, env, scratchRoot, blindFrom, priorMutants });
    if (chain) { t.remedyChain = { ancestors: chain.ancestors, violations: chain.violations.map(v => ({ name: v.name, found: !!v.dir })) }; if (chain.violations.some(v => !v.dir)) { t.classes = [...new Set([...t.classes.filter(c => c !== "ok"), "remedy-incomplete"])].sort(); } atomicWriteJson(join(reviews, task.id, "triage.json"), t); }
    rows.push({ task: t.task, classes: t.classes, blind: t.blind && { tests: t.blind.tests, referencePasses: t.blind.referencePasses, discriminates: t.blind.discriminates, reusedFrom: t.blind.reusedFrom }, verdict: t.adversarial?.verdict ?? null, mutants: t.mutants.length, acceptedByHidden: t.mutants.filter(u => u.hiddenAccepts).length, corroboratedByBlind: t.mutants.filter(u => u.blindRejects).length, remedyCheck: t.remedyCheck?.map(r => `${r.mutant.split("/").pop()}:${r.hiddenAccepts ? "ACCEPTED" : "rejected"}`), remedyChain: t.remedyChain });
  }
  process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
}
