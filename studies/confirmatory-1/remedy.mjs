#!/usr/bin/env node
// Versioned remedies and cross-provider evidence assembly (confirmatory-1, 2026-11-07; model-free).
//
// A reviewed task is NEVER edited in place (sealed calibration tasks are not touched at all; their review stays external). For a
// staged holdout candidate a NEW version `<id>-v2` is built in an intake directory:
//   carry      triage ok, or every dispute adjudicated away: same content + the evidence documents;
//   tests      a confirmed test gap (adjudicated violation accepted by the official tests): the independent blind tests (written
//              without the reference by a non-author provider) are ADDED to the hidden tests when they reject every confirmed
//              violation and the reference passes them; otherwise the adjudicator's remedy tests when they do; the adversarial
//              review must then be REDONE on the new content (its old document names the old digest and no longer verifies);
//   withdraw   a reference or instruction defect (no patching of the authors' work by reviewers): no new version.
// task.json of the version records version, supersedes {id, contentDigest}, the remedy, the added test files and their author,
// the extra exposure (reviewer providers received the content), and review.crossProvider with documents under review/xprov/.
//
//   node studies/confirmatory-1/remedy.mjs build --reviews DIR --task DIR --out DIR [--route-target openai]
//   node studies/confirmatory-1/remedy.mjs finalize --reviews DIR --version DIR      (after the v2 adversarial review)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BLIND_SCOPE, CROSS_PROVIDER_SCHEMA, crossProviderProblems, loadLocal, taskContentDigest } from "../../src/datasets.mjs";
import { sha256 } from "../../src/util.mjs";
import { latestComplete } from "./triage.mjs";
import { gradeOverlay } from "./review.mjs";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
/** Latest adjudication of a scope with an adjudication.json. */
export function latestAdjudication(dir, scope) {
  if (!existsSync(dir)) return null;
  for (const n of readdirSync(dir).filter(x => x.startsWith(`adjudicate-${scope}-`)).sort().reverse()) { const p = join(dir, n, "output", "adjudication.json"); if (existsSync(p)) { try { readJson(p); return join(dir, n); } catch { /* invalid */ } } }
  return null;
}

/** The evidence document of a review directory, bound to the content it reviewed (`reviewedDir` = the task directory it saw). */
export function evidenceDocument(reviewDir, reviewedDir, instruction, scope) {
  const review = readJson(join(reviewDir, "review.json"));
  const mechanical = existsSync(join(reviewDir, "mechanical.json")) ? readJson(join(reviewDir, "mechanical.json")) : {};
  const digest = taskContentDigest(reviewedDir, instruction, scope === "blind" ? BLIND_SCOPE : undefined);
  const mech = scope === "blind" ? { blindTests: mechanical.blindTests, referencePasses: mechanical.referencePasses, discriminates: mechanical.discriminates, referenceFailing: mechanical.reference?.failing ?? [], originalFailed: mechanical.original?.failed ?? null, referenceRepeat: mechanical.referenceRepeat } : { referencePassesHidden: mechanical.referencePassesHidden, mutants: (mechanical.mutants ?? []).map(u => ({ name: u.name, hiddenAccepts: u.hiddenAccepts })) };
  const outputs = Object.fromEntries((review.outputs ?? []).map(o => [o.path, o.sha256]));
  return { schema: "pi-eval-loop/cross-provider-document@1", scope, contentDigest: digest, startedAt: review.startedAt, endedAt: review.endedAt, reviewer: review.reviewer, access: review.access, run: review.run, outputs, mechanical: mech, verdict: scope === "adversarial" ? mechanical.verdict ?? null : undefined, source: reviewDir };
}

function adjudicationDocument(adjDir, reviewedDir, instruction, scope) {
  const review = readJson(join(adjDir, "review.json"));
  const a = readJson(join(adjDir, "output", "adjudication.json"));
  return { schema: "pi-eval-loop/cross-provider-adjudication@1", scope, contentDigest: taskContentDigest(reviewedDir, instruction, scope === "blind" ? BLIND_SCOPE : undefined), adjudicator: { kind: "ai-agent", id: review.reviewer.id, route: review.reviewer.route, provider: review.reviewer.provider, responseModels: review.reviewer.responseModels }, startedAt: review.startedAt, verdict: a.verdict, mutants: a.mutants ?? [], blindFailures: a.blindFailures ?? [], findings: a.findings ?? [], remedy: a.remedy ?? null, access: review.access, source: adjDir };
}

/** Write `doc` under <dir>/review/xprov/<name> and return its { document, sha256 }. */
function putDoc(dir, name, doc) { mkdirSync(join(dir, "review", "xprov"), { recursive: true }); const text = `${JSON.stringify(doc, null, 1)}\n`; writeFileSync(join(dir, "review", "xprov", name), text); return { document: `review/xprov/${name}`, sha256: sha256(text) }; }

/**
 * Decide and build the next version of a staged candidate. Returns { action, id?, dir?, reasons, needs? }.
 * @param {{ task: any, reviews: string, out: string, env: any, scratchRoot: string }} o
 */
export async function buildVersion({ task, reviews, out, env, scratchRoot }) {
  const dir = join(reviews, task.id);
  const triage = existsSync(join(dir, "triage.json")) ? readJson(join(dir, "triage.json")) : null;
  if (!triage || triage.classes.includes("incomplete")) return { action: "none", reasons: ["review incomplete"] };
  const blindDir = latestComplete(dir, "blind-tests"), advDir = latestComplete(dir, "adversarial");
  const adjB = latestAdjudication(dir, "blind"), adjA = latestAdjudication(dir, "adversarial");
  const reasons = [];
  // Blind disputes: only blind-test-error / ambiguity settle them; a reference defect withdraws the task.
  if (triage.blind.referencePasses === false) {
    if (!adjB) return { action: "none", reasons: ["blind dispute not adjudicated"] };
    const a = readJson(join(adjB, "output", "adjudication.json"));
    const res = new Map((a.blindFailures ?? []).map(b => [b.test, b.resolution]));
    if (triage.blind.referenceFailing.some(t => res.get(t) === "reference-defect")) return { action: "withdraw", reasons: ["adjudicated reference defect"] };
    if (!triage.blind.referenceFailing.every(t => ["blind-test-error", "ambiguity"].includes(res.get(t)))) return { action: "none", reasons: ["blind failures not all answered"] };
    reasons.push("blind failures adjudicated as blind-test errors/ambiguities");
  }
  if (triage.blind.discriminates === false) return { action: "withdraw", reasons: ["blind tests pass on the starting repository"] };
  let violations = [];
  if (triage.mutants.some(u => u.hiddenAccepts) || (triage.adversarial.verdict !== "accept")) {
    if (!adjA) return { action: "none", reasons: ["adversarial dispute not adjudicated"] };
    const a = readJson(join(adjA, "output", "adjudication.json"));
    if (["instruction", "reference", "withdraw"].includes(a.remedy) || (a.findings ?? []).some(f => f.resolution === "defect" && !/test/i.test(`${f.item} ${f.reason}`))) return { action: "withdraw", reasons: [`adjudicated defect needing remedy "${a.remedy}"`] };
    const res = new Map((a.mutants ?? []).map(m => [m.name, m.resolution]));
    violations = triage.mutants.filter(u => u.hiddenAccepts && res.get(u.name) !== "not-a-violation").map(u => u.name);
  }
  const prevMeta = readJson(join(task.dir, "task.json"));
  const nextVersion = (Number.isInteger(prevMeta.version) ? prevMeta.version : 1) + 1;
  const id = `${task.id.replace(/-v\d+$/, "")}-v${nextVersion}`;
  const vdir = join(out, id);
  rmSync(vdir, { recursive: true, force: true });
  for (const part of ["repo", "hidden", "reference", "review"]) if (existsSync(join(task.dir, part))) cpSync(join(task.dir, part), join(vdir, part), { recursive: true });
  const m = readJson(join(task.dir, "task.json"));
  let remedy = { kind: "carry" };
  if (violations.length) {
    // Prefer the blind tests (no reference access); else the adjudicator's remedy tests. Both must pass on the reference, fail on
    // the start, and reject every confirmed violation.
    const candidates = [["blind", join(blindDir, "output", "tests"), "blind reviewer (no reference access)"], ["adjudicator", join(adjA, "output", "remedy-tests"), "adjudicator (non-author provider, saw the reference)"]];
    let chosen = null;
    for (const [kind, tests, author] of candidates) {
      if (!existsSync(tests)) continue;
      const ref = await gradeOverlay({ task, parts: [join(task.dir, "reference")], tests, scratch: join(scratchRoot, `rem-${task.id}-ref`), env });
      if (!ref.pass) continue;
      const rejects = [];
      for (const v of violations) rejects.push(!(await gradeOverlay({ task, parts: [join(advDir, "output", "mutants", v)], tests, scratch: join(scratchRoot, `rem-${task.id}-${v}`), env })).pass);
      if (rejects.every(Boolean)) { chosen = { kind, tests, author }; break; }
    }
    if (!chosen) { rmSync(vdir, { recursive: true, force: true }); return { action: "none", reasons: [`confirmed test gap (${violations.join(", ")}) and no independent test set rejects every violation`] }; }
    const added = [];
    const copy = (from, rel = "") => { for (const e of readdirSync(join(from, rel), { withFileTypes: true })) { const r = join(rel, e.name); if (e.isDirectory()) copy(from, r); else { const to = join(vdir, "hidden", r.replace(/\.(test|spec)\.([cm]?[jt]s)$/, ".xprov.$1.$2")); mkdirSync(resolve(to, ".."), { recursive: true }); cpSync(join(from, r), to); added.push({ path: to.slice(vdir.length + 1), sha256: sha256(readFileSync(to)) }); } } };
    copy(chosen.tests);
    remedy = { kind: "tests", violations, source: chosen.kind, author: chosen.author, added };
  }
  const blindDoc = evidenceDocument(blindDir, task.dir, task.instruction, "blind");
  const crossProvider = { schema: CROSS_PROVIDER_SCHEMA, blind: putDoc(vdir, "blind.json", blindDoc) };
  if (adjB) crossProvider.blindAdjudication = putDoc(vdir, "blind-adjudication.json", adjudicationDocument(adjB, task.dir, task.instruction, "blind"));
  if (remedy.kind === "carry") {
    crossProvider.adversarial = putDoc(vdir, "adversarial.json", evidenceDocument(advDir, task.dir, task.instruction, "adversarial"));
    if (adjA) crossProvider.adjudication = putDoc(vdir, "adjudication.json", adjudicationDocument(adjA, task.dir, task.instruction, "adversarial"));
  }
  const reviewerProviders = [blindDoc.reviewer.provider, advDir ? readJson(join(advDir, "review.json")).reviewer.provider : null].filter(Boolean);
  const next = {
    // A staged pool case is superseded (intake retires it); a task that never entered the pool (e.g. rejected) is only derived from.
    ...m, id, version: nextVersion, [/\/pool\/cases\//.test(task.dir) ? "supersedes" : "derivedFrom"]: { id: task.id, contentDigest: taskContentDigest(task.dir, task.instruction) }, remedy,
    ...(remedy.kind === "tests" ? { authorship: { ...m.authorship, testAuthor: `${m.authorship.testAuthor}+${blindDoc.reviewer.id}`, sessions: { ...m.authorship.sessions } }, expected: undefined } : {}),
    exposure: { ...m.exposure, knownExposure: [...(m.exposure?.knownExposure ?? []), `cross-provider review (2026-11-07): the full task reached ${[...new Set(reviewerProviders)].join(" and ")} through the local gateway (blind reviewer: instruction and starting repository only)`] },
    review: { ...m.review, crossProvider },
  };
  writeFileSync(join(vdir, "task.json"), `${JSON.stringify(next, null, 2)}\n`);
  return { action: remedy.kind === "tests" ? "tests" : "carry", id, dir: vdir, reasons, needs: remedy.kind === "tests" ? ["adversarial review of the new content", "finalize"] : [], problems: crossProviderProblems(next, { dir: vdir }) };
}

/** After the v2 adversarial review (and adjudication if needed): add its documents to the version. */
export function finalizeVersion({ vdir, reviews }) {
  const m = readJson(join(vdir, "task.json"));
  const dir = join(reviews, m.id);
  const advDir = latestComplete(dir, "adversarial");
  if (!advDir) return { ok: false, problems: ["no complete adversarial review of the version"] };
  const adjA = latestAdjudication(dir, "adversarial");
  m.review.crossProvider.adversarial = putDoc(vdir, "adversarial.json", evidenceDocument(advDir, vdir, m.instruction, "adversarial"));
  if (adjA) m.review.crossProvider.adjudication = putDoc(vdir, "adjudication.json", adjudicationDocument(adjA, vdir, m.instruction, "adversarial"));
  writeFileSync(join(vdir, "task.json"), `${JSON.stringify(m, null, 2)}\n`);
  const problems = crossProviderProblems(m, { dir: vdir });
  return { ok: problems.length === 0, problems };
}

/**
 * Attach the cross-provider evidence of reviews of EXACTLY this content (no new version: a task reviewed as staged, e.g. a
 * sibling-isolation version or a never-intaken task): blind (+ adjudication) and adversarial (+ adjudication), each bound to the
 * content digest of `dir`. Refuses unless triage is ok or every dispute is adjudicated away ("not-a-violation", blind-test
 * error/ambiguity), i.e. the same conditions as a carry. Returns { ok, problems }.
 */
export function attachCrossProvider({ dir, reviews }) {
  const m = readJson(join(dir, "task.json"));
  const rdir = join(reviews, m.id);
  const triage = existsSync(join(rdir, "triage.json")) ? readJson(join(rdir, "triage.json")) : null;
  if (!triage || triage.task !== m.id) return { ok: false, problems: ["no triage of this task"] };
  if (triage.classes.includes("incomplete")) return { ok: false, problems: ["review incomplete"] };
  const blindDir = latestComplete(rdir, "blind-tests"), advDir = latestComplete(rdir, "adversarial");
  const adjB = latestAdjudication(rdir, "blind"), adjA = latestAdjudication(rdir, "adversarial");
  const open = triage.classes.filter(c => c !== "ok");
  if (open.some(c => ["blind-not-discriminating", "reference-fails-hidden", "remedy-incomplete"].includes(c))) return { ok: false, problems: [`triage ${open.join(", ")}`] };
  if (open.includes("reference-vs-blind")) {
    if (!adjB) return { ok: false, problems: ["blind dispute not adjudicated"] };
    const res = new Map((readJson(join(adjB, "output", "adjudication.json")).blindFailures ?? []).map(b => [b.test, b.resolution]));
    if (!triage.blind.referenceFailing.every(t => ["blind-test-error", "ambiguity"].includes(res.get(t)))) return { ok: false, problems: ["blind failures not all adjudicated as blind-test errors/ambiguities"] };
  }
  if (open.includes("test-gap") || open.includes("reviewer-finding")) {
    if (!adjA) return { ok: false, problems: ["adversarial dispute not adjudicated"] };
    const a = readJson(join(adjA, "output", "adjudication.json"));
    const res = new Map((a.mutants ?? []).map(x => [x.name, x.resolution]));
    const viol = triage.mutants.filter(u => u.hiddenAccepts && res.get(u.name) !== "not-a-violation").map(u => u.name);
    if (viol.length) return { ok: false, problems: [`adjudicated violations accepted by the hidden tests: ${viol.join(", ")} (needs a tests remedy version)`] };
  }
  const crossProvider = { schema: CROSS_PROVIDER_SCHEMA, blind: putDoc(dir, "blind.json", evidenceDocument(blindDir, dir, m.instruction, "blind")), adversarial: putDoc(dir, "adversarial.json", evidenceDocument(advDir, dir, m.instruction, "adversarial")) };
  if (adjB) crossProvider.blindAdjudication = putDoc(dir, "blind-adjudication.json", adjudicationDocument(adjB, dir, m.instruction, "blind"));
  if (adjA) crossProvider.adjudication = putDoc(dir, "adjudication.json", adjudicationDocument(adjA, dir, m.instruction, "adversarial"));
  const providers = [readJson(join(blindDir, "review.json")).reviewer.provider, readJson(join(advDir, "review.json")).reviewer.provider];
  const next = { ...m, exposure: { ...m.exposure, knownExposure: [...new Set([...(m.exposure?.knownExposure ?? []), `cross-provider review (2026-11-07): the full task reached ${[...new Set(providers)].join(" and ")} through the local gateway (blind reviewer: instruction and starting repository only)`])] }, review: { ...m.review, crossProvider } };
  writeFileSync(join(dir, "task.json"), `${JSON.stringify(next, null, 2)}\n`);
  const problems = crossProviderProblems(next, { dir });
  return { ok: problems.length === 0, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: { reviews: { type: "string" }, task: { type: "string", multiple: true }, out: { type: "string" }, version: { type: "string", multiple: true }, scratch: { type: "string" } } });
  const reviews = resolve(values.reviews);
  if (mode === "finalize") { process.stdout.write(`${JSON.stringify((values.version ?? []).map(v => ({ version: v.split("/").pop(), ...finalizeVersion({ vdir: resolve(v), reviews }) })), null, 1)}\n`); process.exit(0); }
  if (mode === "attach") { const rows = (values.task ?? []).map(t => ({ task: t.split("/").pop(), ...attachCrossProvider({ dir: resolve(t), reviews }) })); process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`); process.exit(rows.every(r => r.ok) ? 0 : 2); }
  const { hostEnvironment } = await import("../../src/sandbox.mjs");
  const env = hostEnvironment();
  const scratchRoot = resolve(values.scratch ?? join(reviews, "..", "scratch"));
  const rows = [];
  for (const d of values.task ?? []) {
    const tdir = resolve(d); const task = loadLocal(resolve(tdir, "..")).find(x => x.dir === tdir);
    const r = await buildVersion({ task, reviews, out: resolve(values.out), env, scratchRoot });
    rows.push({ task: task.id, action: r.action, version: r.id ?? null, reasons: r.reasons, needs: r.needs ?? [], problems: (r.problems ?? []).slice(0, 4) });
  }
  process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
}
