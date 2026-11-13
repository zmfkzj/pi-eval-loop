// Task sources, family-grouped train/dev/holdout splits, exposure scanning and the sealed holdout with its durable use ledger.
//
// Task interface (extensible beyond coding: any task with a mechanical, independent grader fits):
//   { id, source, dir, repo, hidden?, customGrader?, family, tier, hard, difficultyBasis?, instruction, timeoutSec, provenance }
// Tasks without a mechanical grader (rubric/LLM-judged) are NOT loaded: an LLM verdict alone never counts as success.
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { Ledger, digestOf, ensureDir, sha256, walkFiles } from "./util.mjs";
import { verifyCalibrationReport } from "./calibration.mjs";
import { createRng } from "./rng.mjs";

const TIER_BY_PREFIX = { a: "easy", b: "medium", c: "medium", d: "hard", p: "hard" };
/** Families the package name alone would split: the p-series share one generator, so they stay one family. */
const FAMILY_OVERRIDES = { "p1-ticket-batch": "p-series", "p2-handler-migration": "p-series", "p3-library-features-ko": "p-series" };

/** orche's fixtures/suite (deterministic tasks only: hidden node tests or a custom mechanical grade.mjs). */
export function loadSuite(suiteDir) {
  const tasks = [];
  for (const id of readdirSync(suiteDir).sort()) {
    const dir = join(suiteDir, id);
    if (!existsSync(join(dir, "task.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
    if (manifest.grading?.rubric) continue;
    const hidden = manifest.grading?.hiddenTests && existsSync(join(dir, "hidden")) ? join(dir, "hidden") : undefined;
    const customGrader = manifest.grading?.custom && existsSync(join(dir, "grade.mjs")) ? join(dir, "grade.mjs") : undefined;
    if (!hidden && !customGrader) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "repo/package.json"), "utf8"));
    const tier = TIER_BY_PREFIX[id[0]] ?? "medium";
    tasks.push({ id, source: "suite", dir, repo: join(dir, "repo"), hidden, customGrader, family: FAMILY_OVERRIDES[id] ?? `pkg:${pkg.name}`, tier, hard: tier === "hard", instruction: manifest.instruction, ...(Array.isArray(manifest.turns) && manifest.turns.every(t => typeof t === "string" && t.trim()) && manifest.turns.length ? { turns: manifest.turns } : {}), timeoutSec: manifest.timeoutSec, provenance: "orche-fixtures-suite" });
  }
  return tasks;
}

/**
 * Where a task.json tier comes from. A supply-built task (src/supply.mjs, `upstream.tierRule`) is "size-proxy" unless it carries a
 * "source" basis WITH the annotation it came from (`difficultySource`): no self-declared label overrides its known origin. Any task
 * claiming "source" must carry a substantive annotation (sourceAnnotated), else it is "source-unannotated" (never accepted). Any
 * other dataset: its `difficultyBasis` when set, else "declared" (the tier its curator wrote in task.json).
 */
export const difficultyBasisOf = (m) => {
  if (m.difficultyBasis === "source") return sourceAnnotated(m) ? "source" : m.upstream?.tierRule ? "size-proxy" : "source-unannotated";
  // "calibrated": the tier comes from a separate calibration set's measurement (src/calibration.mjs); the reference is verified
  // against the report at holdout eligibility (calibrationProblems).
  if (m.difficultyBasis === "calibrated") return calibrationShaped(m) ? "calibrated" : "calibrated-unverified";
  if (m.upstream?.tierRule) return "size-proxy";
  return typeof m.difficultyBasis === "string" && m.difficultyBasis ? m.difficultyBasis : "declared";
};
/**
 * A difficulty annotation that can be checked: the dataset it came from, the label/value it gives, where to find it (URL or
 * revision) and, when it names a tier, the same tier as the task.
 */
export function sourceAnnotated(m) {
  const s = m.difficultySource;
  if (!s || typeof s !== "object") return false;
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  if (!str(s.dataset) || !(str(s.label) || Number.isFinite(s.value)) || !(str(s.url) || str(s.commit))) return false;
  if (str(s.tier) && s.tier !== m.tier) return false;
  return true;
}
/** Whether a holdout task counts as hard: tier hard AND a difficulty basis the protocol accepts (protocol holdout.hardBasis). */
export const holdoutHard = (task, protocol) => Boolean(task.hard) && (protocol.holdout.hardBasis ?? []).includes(task.difficultyBasis ?? "declared");

/** A local dataset directory (same layout: <id>/{task.json, repo/, hidden/, reference/}; task.json names family/tier/provenance). */
export function loadLocal(datasetDir) {
  const tasks = [];
  for (const id of readdirSync(datasetDir).sort()) {
    const dir = join(datasetDir, id);
    if (!existsSync(join(dir, "task.json"))) continue;
    const m = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
    if (m.id !== id) throw new Error(`${dir}: task.json id ${m.id} != directory`);
    if (!m.family || !m.tier || !m.instruction || !m.provenance) throw new Error(`${dir}: task.json needs family, tier, instruction, provenance`);
    tasks.push({ id, source: "local", dir, repo: join(dir, "repo"), hidden: existsSync(join(dir, "hidden")) ? join(dir, "hidden") : undefined, customGrader: existsSync(join(dir, "grade.mjs")) ? join(dir, "grade.mjs") : undefined, family: m.family, tier: m.tier, hard: m.tier === "hard", difficultyBasis: difficultyBasisOf(m), instruction: m.instruction, timeoutSec: m.timeoutSec ?? 900, provenance: m.provenance,
      ...(m.difficultyCalibration ? { difficultyCalibration: m.difficultyCalibration } : {}), ...(m.review ? { review: m.review } : {}), ...(m.authorship ? { authorship: m.authorship } : {}), ...(m.exposure ? { exposure: m.exposure } : {}), ...(m.testProvenance ? { testProvenance: m.testProvenance } : {}) });
  }
  return tasks;
}

/**
 * Deterministic family-grouped split: families are ordered by a seeded hash and dealt to train until its share of tasks is met,
 * per tier, so every tier appears in both splits when it can. No family is ever in two splits.
 */
export function splitByFamily(tasks, { seed, trainShare }) {
  const families = new Map();
  for (const t of tasks) { if (!families.has(t.family)) families.set(t.family, []); families.get(t.family).push(t); }
  const tierOf = (members) => members.some(t => t.hard) ? "hard" : members.some(t => t.tier === "medium") ? "medium" : "easy";
  const byTier = new Map();
  for (const [family, members] of families) { const tier = tierOf(members); if (!byTier.has(tier)) byTier.set(tier, []); byTier.get(tier).push({ family, members }); }
  const split = { train: [], dev: [] };
  for (const tier of [...byTier.keys()].sort()) {
    const groups = byTier.get(tier).sort((x, y) => sha256(`${seed}:${x.family}`).localeCompare(sha256(`${seed}:${y.family}`)));
    const total = groups.reduce((s, g) => s + g.members.length, 0);
    let train = 0;
    groups.forEach((g, i) => {
      // A single-family tier goes to dev (comparisons need it); otherwise train fills to its share and dev keeps at least one family.
      const devHasOne = groups.slice(0, i).some(x => !x.toTrain);
      let toTrain = groups.length > 1 && (train === 0 || train + g.members.length / 2 <= total * trainShare);
      if (i === groups.length - 1 && !devHasOne) toTrain = false;
      g.toTrain = toTrain;
      if (toTrain) train += g.members.length;
      (toTrain ? split.train : split.dev).push(...g.members.map(t => t.id));
    });
  }
  split.train.sort(); split.dev.sort();
  return split;
}

/** Disjointness checks across splits (task ids and families). */
export function validateSplits(tasksById, splits) {
  const problems = [];
  const names = Object.keys(splits);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = splits[names[i]], b = splits[names[j]];
    for (const id of a) if (b.includes(id)) problems.push(`task ${id} in ${names[i]} and ${names[j]}`);
    const fa = new Set(a.map(id => tasksById[id]?.family)), fb = new Set(b.map(id => tasksById[id]?.family));
    for (const f of fa) if (fb.has(f)) problems.push(`family ${f} in ${names[i]} and ${names[j]}`);
  }
  for (const [name, ids] of Object.entries(splits)) for (const id of ids) if (!tasksById[id]) problems.push(`unknown task ${id} in ${name}`);
  return problems;
}

/**
 * Model-free exposure scan: a task id named in earlier experiment plans, results directory names, docs, or the eval-loop's own use
 * ledgers counts as exposed (used before) and cannot be a NEW independent holdout.
 */
export function exposureScan(ids, { orcheDir, extraTexts = [] }) {
  const hits = Object.fromEntries(ids.map(id => [id, []]));
  const texts = [...extraTexts];
  const addTextFiles = (root, filter, depth = 5) => {
    if (!existsSync(root)) return;
    const visit = (dir, d) => {
      if (d > depth) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== ".git") { texts.push({ where: relative(orcheDir, path), text: entry.name }); visit(path, d + 1); } }
        else if (entry.isFile() && filter(entry.name) && statSync(path).size < 4 * 1024 * 1024) texts.push({ where: relative(orcheDir, path), text: readFileSync(path, "utf8") });
      }
    };
    visit(root, 0);
  };
  addTextFiles(join(orcheDir, "experiments"), name => /\.(json|ts|md)$/.test(name), 4);
  addTextFiles(join(orcheDir, "docs"), name => name.endsWith(".md"), 1);
  addTextFiles(join(orcheDir, "results"), () => false, 4); // directory names only (results are large)
  for (const { where, text } of texts) for (const id of ids) if (text.includes(id)) hits[id].push(where);
  return Object.fromEntries(ids.map(id => [id, { exposed: hits[id].length > 0, hits: hits[id].slice(0, 10), count: hits[id].length }]));
}

/** Seal of a dataset directory: sha256 of every file (committed before any search; verified before every holdout use). */
export function sealOf(datasetDir) {
  const files = {};
  const symlinks = [];
  for (const f of walkFiles(datasetDir, { skip: [] })) {
    if (["SEAL.json", "USES.jsonl"].includes(f.path)) continue;
    if (f.symlink !== undefined) { symlinks.push(`${f.path} -> ${f.symlink}`); continue; }
    files[f.path] = sha256(readFileSync(join(datasetDir, f.path)));
  }
  return { files, digest: digestOf(files), symlinks };
}
export function verifySeal(datasetDir) {
  const sealPath = join(datasetDir, "SEAL.json");
  if (!existsSync(sealPath)) return { ok: false, why: "no SEAL.json" };
  const seal = JSON.parse(readFileSync(sealPath, "utf8"));
  const now = sealOf(datasetDir);
  // A sealed dataset holds regular files only: a symlink could redirect a grader to unsealed material.
  if (now.symlinks.length) return { ok: false, why: `symlink(s) in the sealed dataset: ${now.symlinks.slice(0, 5).join(", ")}`, seal };
  if (now.digest !== seal.digest) {
    const changed = Object.keys({ ...seal.files, ...now.files }).filter(path => seal.files[path] !== now.files[path]);
    return { ok: false, why: `dataset changed since sealing: ${changed.slice(0, 5).join(", ")}`, seal };
  }
  return { ok: true, seal };
}

/** Holdout use ledger (next to the dataset, so every state directory sees the same consumption). */
export const holdoutLedger = (datasetDir, path) => new Ledger(path ?? join(datasetDir, "USES.jsonl"));

/**
 * Account of a family: the owner of a `gh:owner/repo` family; for a newly authored task (`private:owner/name`) the accountable
 * authoring source named before the slash (tasks of one author or one model provider are one account, however many projects or
 * sessions they span); any other family is its own account.
 */
export const ownerOfFamily = (family) => { const f = String(family ?? ""); return f.startsWith("gh:") ? f.slice(3).split("/")[0].toLowerCase() : /^private:[^/]+\//.test(f) ? `private:${f.slice(8).split("/")[0].toLowerCase()}` : f; };
/** Family form of a newly authored task: `private:<accountable author or source>/<project>`. */
export const PRIVATE_FAMILY = /^private:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

/** Purpose a sealed dataset declares in PROVENANCE.json ("holdout" when absent: every dataset before purposes existed). */
export function datasetPurpose(datasetDir) {
  try { return JSON.parse(readFileSync(join(datasetDir, "PROVENANCE.json"), "utf8")).purpose ?? "holdout"; } catch { return "holdout"; }
}

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const isoTime = (v) => nonEmpty(v) && !Number.isNaN(Date.parse(v));
/** Items an independent review of a newly authored, unpublished task must have checked (task.json review.checked). */
export const REVIEW_CHECKS = ["instruction-sufficient", "tests-match-instruction", "reference-passes-hidden", "not-published", "no-public-source-copy"];
/** Kinds of authors and reviewers a review record must declare (an AI agent's review is never presented as a human review). */
export const ACTOR_KINDS = ["human", "ai-agent"];

/**
 * Problems of the review record of a low-exposure task (provenance "private-reviewed"; empty = structurally complete). This checks
 * the RECORD: that the authors of problem, tests and reference and the reviewers are named with their kind (human | ai-agent),
 * that tests were written by someone other than the reference solution's author (independent test provenance), that no reviewer
 * authored any part, that the task is declared unpublished and the review happened after authoring with every required item
 * checked, that the family names its accountable author (`private:<owner>/<project>`), and that the review is backed by a
 * document whose sha256 is recorded. With `dir` (the task directory: intake and every eligibility check pass it) the document
 * must exist under `<dir>/review/` and match its sha256. It cannot verify that the people are real, independent or truthful;
 * that stays an attestation by the operator (docs/design.md "Low-exposure tier").
 * @param {any} task @param {{ dir?: string }} [options]
 */
export function reviewProblems(task, { dir } = {}) {
  const problems = [];
  const a = task.authorship ?? {}, r = task.review ?? {}, x = task.exposure ?? {};
  for (const k of ["problemAuthor", "testAuthor", "referenceAuthor"]) {
    if (!nonEmpty(a[k])) problems.push(`authorship.${k} missing`);
    if (!ACTOR_KINDS.includes(a.kinds?.[k])) problems.push(`authorship.kinds.${k} must be one of ${ACTOR_KINDS.join("|")}`);
  }
  if (nonEmpty(a.testAuthor) && a.testAuthor === a.referenceAuthor) problems.push("tests and reference were written by the same author (no independent test provenance)");
  if (task.testProvenance !== "independent-author") problems.push("testProvenance must be \"independent-author\"");
  if (!PRIVATE_FAMILY.test(String(task.family ?? ""))) problems.push("family must be private:<accountable author>/<project> (one account per author or source)");
  if (x.published !== false) problems.push("exposure.published must be false (declared unpublished)");
  if (!isoTime(x.authoredAt)) problems.push("exposure.authoredAt (ISO time) missing");
  const reviewers = Array.isArray(r.reviewers) ? r.reviewers : [];
  if (!reviewers.length) problems.push("review.reviewers missing");
  const authors = new Set([a.problemAuthor, a.testAuthor, a.referenceAuthor].filter(nonEmpty));
  for (const v of reviewers) {
    if (!nonEmpty(v?.id)) { problems.push("a reviewer without id"); continue; }
    if (authors.has(v.id)) problems.push(`reviewer ${v.id} is also an author`);
    if (!ACTOR_KINDS.includes(v.kind)) problems.push(`reviewer ${v.id}: kind must be one of ${ACTOR_KINDS.join("|")}`);
    if (!isoTime(v.at)) problems.push(`reviewer ${v.id}: review time missing`);
    else if (isoTime(x.authoredAt) && Date.parse(v.at) < Date.parse(x.authoredAt)) problems.push(`reviewer ${v.id}: reviewed before the task was authored`);
    if (v.verdict !== "accept") problems.push(`reviewer ${v.id}: verdict ${v.verdict ?? "missing"} (only an accepting review counts)`);
  }
  // Every required item must be attributable: checked by a named reviewer, or covered by an attestation of a named non-author
  // (for example the operator's publication check) that states how it was established.
  const attested = new Set();
  for (const at of Array.isArray(r.attestations) ? r.attestations : []) {
    if (!REVIEW_CHECKS.includes(at?.item)) { problems.push(`attestation of unknown item ${at?.item}`); continue; }
    if (!nonEmpty(at.by) || authors.has(at.by) || !ACTOR_KINDS.includes(at.kind) || !isoTime(at.at) || !nonEmpty(at.method)) { problems.push(`attestation of ${at.item}: needs by (not an author), kind, at and method`); continue; }
    attested.add(at.item);
  }
  const checked = new Set(Array.isArray(r.checked) ? r.checked : []);
  const unchecked = REVIEW_CHECKS.filter(c => !checked.has(c));
  if (unchecked.length) problems.push(`review.checked lacks ${unchecked.join(", ")}`);
  const byReviewer = new Set(reviewers.flatMap(v => (Array.isArray(v?.checked) ? v.checked : [])));
  const unattributed = REVIEW_CHECKS.filter(c => !byReviewer.has(c) && !attested.has(c));
  if (unattributed.length) problems.push(`review items not attributable to a reviewer's own checks or an attestation: ${unattributed.join(", ")}`);
  if (!nonEmpty(r.document) || !/^[0-9a-f]{64}$/.test(r.documentSha256 ?? "")) problems.push("review.document and review.documentSha256 (the signed review record) missing");
  else if (dir !== undefined) {
    const doc = String(r.document);
    if (!doc.startsWith("review/") || doc.split("/").includes("..")) problems.push("review.document must be a file under the task's review/ directory");
    else if (!existsSync(join(dir, doc)) || !statSync(join(dir, doc)).isFile()) problems.push(`review.document not found in the task: ${doc}`);
    else if (sha256(readFileSync(join(dir, doc))) !== r.documentSha256) problems.push("review.document does not match review.documentSha256");
  }
  return problems;
}

/**
 * "human-reviewed" when at least one reviewer is a human; "cross-provider-reviewed" when the record carries cross-provider review
 * evidence (review.crossProvider; whether it VERIFIES is crossProviderProblems with the task directory); else "ai-reviewed-only".
 * No label is evidence by itself: eligibility always re-verifies.
 */
export const reviewClass = (task) => ((task.review?.reviewers ?? []).some(v => v?.kind === "human") ? "human-reviewed" : task.review?.crossProvider ? "cross-provider-reviewed" : "ai-reviewed-only");

/** Provider family of a model id as named by the gateway (bts/ aliases stripped). */
export function providerOfModel(model) {
  const m = String(model ?? "").replace(/^bts\//, "");
  if (/^claude-/.test(m)) return "anthropic";
  if (/^(gpt-|o\d)/.test(m)) return "openai";
  if (/^grok-/.test(m)) return "xai";
  if (/^gemini-/.test(m)) return "google";
  return "unknown";
}

/**
 * Digest of what a task IS (instruction, starting repository, hidden tests, reference): a review applies to this content only.
 * The blind role's evidence depends only on instruction, starting repository and reference (BLIND_SCOPE): a new version that
 * changes only the hidden tests keeps it, while the adversarial review and adjudication must be redone.
 */
export const BLIND_SCOPE = ["repo", "reference"];
export function taskContentDigest(dir, instruction, parts = ["repo", "hidden", "reference"]) {
  const part = (name) => { const root = join(dir, name); return existsSync(root) ? walkFiles(root).map(f => [f.path, f.symlink ?? sha256(readFileSync(join(root, f.path)))]) : []; };
  return digestOf({ instruction, ...Object.fromEntries(parts.map(name => [name, part(name)])) });
}

export const CROSS_PROVIDER_SCHEMA = "pi-eval-loop/cross-provider-review@1";
/**
 * Problems of the cross-provider (non-human) review evidence of a private task (holdout.privateReview "cross-provider", 2026-11-07;
 * docs/design.md "Non-human review"). Needs the task directory: every piece is a document under review/ whose sha256 is recorded
 * in task.json review.crossProvider and is re-read here.
 *   - content: the evidence names the task content digest it reviewed; it must equal the current content (a review never carries
 *     over to a changed task, and relabelling is not evidence);
 *   - blind: an AI reviewer of a provider that is neither an author's nor the target's, with response models of that provider
 *     only, wrote tests from instruction + starting repository under FILESYSTEM-enforced isolation (a denial probe in the same
 *     mount set shows every withheld path absent; the input manifest holds no hidden/, reference/ or review/ file); the reference
 *     passed them twice and the starting repository failed them;
 *   - adversarial: a reviewer of a third provider (not an author's, not the target's, not the blind reviewer's) judged the full
 *     task, the reference passed the official hidden tests, and EVERY mutant the official hidden tests accept is resolved by an
 *     adjudication document ("not-a-violation" with a reason; any other resolution keeps the task ineligible);
 *   - verdict: the adversarial reviewer accepted, or an adjudication of a non-author provider accepted with every finding of
 *     severity blocker/major answered.
 * It cannot establish that a model provider is independent of another in training data or that content never reached training
 * data; it establishes role separation, enforced information access, provider diversity and mechanical agreement.
 * @param {any} task @param {{ dir: string, targetProvider?: string }} options
 */
export function crossProviderProblems(task, { dir, targetProvider = "openai" }) {
  const x = task.review?.crossProvider;
  if (!x) return ["no cross-provider review evidence (review.crossProvider)"];
  if (x.schema !== CROSS_PROVIDER_SCHEMA) return [`review.crossProvider.schema must be ${CROSS_PROVIDER_SCHEMA}`];
  const problems = [];
  const doc = (ref, name) => {
    if (!ref || !nonEmpty(ref.document) || !/^[0-9a-f]{64}$/.test(ref.sha256 ?? "")) { problems.push(`${name}: document and sha256 missing`); return null; }
    const p = String(ref.document);
    if (!p.startsWith("review/") || p.split("/").includes("..")) { problems.push(`${name}: document must be under review/`); return null; }
    if (!existsSync(join(dir, p))) { problems.push(`${name}: document not found (${p})`); return null; }
    const bytes = readFileSync(join(dir, p));
    if (sha256(bytes) !== ref.sha256) { problems.push(`${name}: document does not match its sha256`); return null; }
    try { return JSON.parse(String(bytes)); } catch { problems.push(`${name}: document is not JSON`); return null; }
  };
  const authors = new Set(Object.values(task.authorship?.sessions ?? {}).map(s => providerOfModel(s?.model)));
  if (!authors.size || authors.has("unknown")) problems.push("authorship.sessions must name every author's model (author providers unknown)");
  const current = taskContentDigest(dir, task.instruction);
  const currentBlind = taskContentDigest(dir, task.instruction, BLIND_SCOPE);
  const reviewerOk = (r, name, also = new Set(), digest = current) => {
    const v = r?.reviewer ?? {};
    const prov = providerOfModel(String(v.route ?? "").split("/").pop());
    if (v.kind !== "ai-agent") problems.push(`${name}: reviewer kind must be ai-agent (a model is never presented as a person)`);
    if (prov === "unknown" || prov !== v.provider) problems.push(`${name}: reviewer provider unknown or inconsistent with its route`);
    if (authors.has(prov)) problems.push(`${name}: reviewer provider ${prov} is an author's provider`);
    if (prov === targetProvider) problems.push(`${name}: reviewer provider ${prov} is the target model's provider`);
    if (also.has(prov)) problems.push(`${name}: reviewer provider ${prov} already reviewed this task in another role`);
    const models = Array.isArray(v.responseModels) ? v.responseModels : [];
    if (!models.length || models.some(m => providerOfModel(m) !== prov)) problems.push(`${name}: response models ${JSON.stringify(models)} do not all belong to ${prov} (no evidence the reviewer actually ran on that provider)`);
    if (!nonEmpty(v.id) || !isoTime(r?.startedAt)) problems.push(`${name}: session id and time missing`);
    else if (isoTime(task.exposure?.authoredAt) && Date.parse(r.startedAt) < Date.parse(task.exposure.authoredAt)) problems.push(`${name}: reviewed before the task was authored`);
    if (r?.contentDigest !== digest) problems.push(`${name}: reviewed other task content (digest differs from the current task)`);
    return prov;
  };
  const blind = doc(x.blind, "blind");
  let blindProv = null;
  if (blind) {
    blindProv = reviewerOk(blind, "blind", new Set(), currentBlind);
    const a = blind.access ?? {};
    if (!String(a.enforcement ?? "").startsWith("filesystem")) problems.push("blind: information access not filesystem-enforced");
    const probe = Array.isArray(a.denialProbe) ? a.denialProbe : [];
    if (!probe.length || probe.some(p => !p.checked || p.visible)) problems.push("blind: denial probe missing, incomplete, or a withheld path was visible");
    if (!Array.isArray(a.inputs) || a.inputs.some(f => /^(hidden|reference|review)\//.test(String(f.path)))) problems.push("blind: input manifest missing or holds withheld material");
    const m = blind.mechanical ?? {};
    if (!(m.blindTests > 0)) problems.push("blind: no blind tests");
    if (m.referencePasses !== true) {
      // Only an adjudication by a provider that wrote neither the blind tests nor the task may set a failing blind test aside, and
      // only as "blind-test-error" or "ambiguity" with a reason; a "reference-defect" (or anything unanswered) keeps it failing.
      const adjBlind = x.blindAdjudication ? doc(x.blindAdjudication, "blind adjudication") : null;
      const failing = Array.isArray(m.referenceFailing) ? m.referenceFailing : [];
      const p = providerOfModel(String(adjBlind?.adjudicator?.route ?? "").split("/").pop());
      const answered = new Map((adjBlind?.blindFailures ?? []).map(b => [b.test, b]));
      const settled = adjBlind && adjBlind.contentDigest === currentBlind && !authors.has(p) && p !== "unknown" && p !== blindProv && failing.length > 0 && failing.every(t => ["blind-test-error", "ambiguity"].includes(answered.get(t)?.resolution) && nonEmpty(answered.get(t)?.reason));
      if (!settled) problems.push("blind: the reference does not pass the independent blind tests (no adjudication by a third provider sets every failing test aside)");
    }
    if (m.discriminates !== true) problems.push("blind: the starting repository passes the blind tests (they do not test the change)");
  }
  const adv = doc(x.adversarial, "adversarial");
  const adj = x.adjudication ? doc(x.adjudication, "adjudication") : null;
  if (adv) {
    reviewerOk(adv, "adversarial", new Set([blindProv].filter(Boolean)));
    const m = adv.mechanical ?? {};
    if (m.referencePassesHidden !== true) problems.push("adversarial: the reference does not pass the official hidden tests");
    const accepted = (m.mutants ?? []).filter(u => u.hiddenAccepts);
    const resolved = new Map((adj?.mutants ?? []).map(u => [u.name, u]));
    for (const u of accepted) { const r = resolved.get(u.name); if (!r || r.resolution !== "not-a-violation" || !nonEmpty(r.reason)) problems.push(`adversarial: mutant ${u.name} passes the official hidden tests and is not adjudicated as not-a-violation`); }
    const verdict = adv.verdict?.verdict;
    if (verdict !== "accept") {
      if (!adj) problems.push(`adversarial: verdict ${verdict ?? "missing"} without an adjudication`);
      else {
        const p = providerOfModel(String(adj.adjudicator?.route ?? "").split("/").pop());
        if (adj.adjudicator?.kind !== "ai-agent" && adj.adjudicator?.kind !== "human") problems.push("adjudication: adjudicator kind missing");
        if (adj.adjudicator?.kind === "ai-agent" && (authors.has(p) || p === "unknown")) problems.push("adjudication: adjudicator must be of a non-author provider");
        if (adj.verdict !== "accept") problems.push(`adjudication verdict ${adj.verdict ?? "missing"}`);
        if (adj.contentDigest !== current) problems.push("adjudication: other task content");
        const serious = (adv.verdict?.findings ?? []).filter(f => ["blocker", "major"].includes(f?.severity)).length;
        if ((adj.findings ?? []).length < serious) problems.push("adjudication: not every blocker/major finding is answered");
      }
    }
  }
  return problems;
}

/** Is a private task's review acceptable under the protocol's privateReview policy? Returns problems (empty = acceptable). */
export function privateReviewProblems(task, policy, { dir, targetProvider } = {}) {
  if (task.provenance !== "private-reviewed") return [];
  if (reviewClass(task) === "human-reviewed") return [];
  if (policy === "ai-allowed") return [];
  if (policy === "cross-provider") return dir ? crossProviderProblems(task, { dir, targetProvider }) : ["cross-provider evidence needs the task directory"];
  return ["no human reviewer (holdout.privateReview human): AI-agent review is not human review"];
}

/** A calibrated difficulty reference with every field it needs (verified against the report by calibrationProblems). */
export const calibrationShaped = (m) => { const c = m.difficultyCalibration; return Boolean(c) && nonEmpty(c.report) && /^[0-9a-f]{64}$/.test(c.reportSha256 ?? "") && nonEmpty(c.level); };

/**
 * Problems of a "calibrated" difficulty basis: the report exists with the recorded sha256, was measured on a calibration-purpose
 * set, that set shares no task id and no family with this task, and the report's rule makes this task's level hard.
 */
export function calibrationProblems(task, datasetDir) {
  const c = task.difficultyCalibration;
  if (!c) return ["no difficultyCalibration"];
  const path = c.report.startsWith("/") ? c.report : join(datasetDir, c.report);
  let bytes, report;
  try { bytes = readFileSync(path); report = JSON.parse(String(bytes)); } catch { return [`calibration report unreadable: ${c.report}`]; }
  const problems = [];
  if (sha256(bytes) !== c.reportSha256) problems.push("calibration report changed (sha256 differs)");
  if (report.purpose !== "calibration") problems.push("calibration report was not measured on a calibration-purpose set");
  if ((report.tasks ?? []).includes(task.id)) problems.push("task was itself in the calibration set (pre-run)");
  if ((report.families ?? []).includes(task.family)) problems.push("task's family was in the calibration set");
  if (!(report.rule?.hardLevels ?? []).includes(c.level)) problems.push(`calibration rule does not make level ${c.level} hard`);
  // The report's own claims are not evidence: its outcomes must be re-derived from the runner ledger it names (real, unsimulated
  // runs of the recorded harness on the sealed calibration batch) and its hard levels from its pre-registered rule.
  problems.push(...verifyCalibrationReport(report).map(p => `calibration report not verified: ${p}`));
  return problems;
}

/**
 * Is this holdout still independent? Sealed, a holdout-purpose dataset, accepted provenance (low-exposure provenance only with a
 * complete review record), verified calibrated difficulty references, not exposed by earlier experiments, used fewer than
 * maxUses times (a use is recorded BEFORE its first run starts, so a crash still consumes it), and (protocol-4, re-checked at
 * preflight, pool eligibility AND the moment of use) within the account-concentration cap and, when protocol.holdout
 * .priorFamilyReuse is "forbid", without a family of an earlier holdout (`priorFamilies`; unknown = fail closed).
 * "Unexposed" means not named in earlier experiments' texts; it never establishes absence from model training data.
 * @param {any[]} tasks @param {string} datasetDir @param {any} protocol @param {{ orcheDir?: string, ledgerPath?: string, priorFamilies?: Set<string> }} [options]
 */
export function holdoutStatus(tasks, datasetDir, protocol, { orcheDir, ledgerPath, priorFamilies } = {}) {
  const reasons = [];
  const h = protocol.holdout;
  const seal = verifySeal(datasetDir);
  if (!seal.ok) reasons.push(seal.why);
  const purpose = datasetPurpose(datasetDir);
  if (purpose !== "holdout") reasons.push(`dataset purpose is ${purpose}: never a holdout (calibration sets are measured and so exposed)`);
  const badProvenance = tasks.filter(t => !h.acceptedProvenance.includes(t.provenance));
  if (badProvenance.length) reasons.push(`provenance not accepted for independent claims: ${badProvenance.map(t => `${t.id}=${t.provenance}`).join(", ")}`);
  const unreviewed = tasks.filter(t => t.provenance === "private-reviewed").map(t => [t.id, reviewProblems(t, { dir: t.dir ?? join(datasetDir, t.id) })]).filter(([, p]) => p.length);
  if (unreviewed.length) reasons.push(`low-exposure provenance without a complete review record: ${unreviewed.map(([id, p]) => `${id} (${p.slice(0, 2).join("; ")})`).join(", ")}`);
  // AI-agent review is not human review. holdout.privateReview "human" (default) needs a human reviewer; "cross-provider" accepts
  // verified cross-provider evidence (crossProviderProblems, re-read from the task directory); "ai-allowed" accepts any recorded
  // AI review (an explicit operator decision; weakest).
  const targetProvider = providerOfModel(protocol.route?.model);
  const notReviewed = tasks.filter(t => t.provenance === "private-reviewed").map(t => [t.id, privateReviewProblems(t, h.privateReview ?? "human", { dir: t.dir ?? join(datasetDir, t.id), targetProvider })]).filter(([, p]) => p.length);
  if (notReviewed.length) reasons.push(`low-exposure tasks without an accepted review (holdout.privateReview ${h.privateReview ?? "human"}): ${notReviewed.map(([id, p]) => `${id} (${p[0]})`).join(", ")}`);
  const badCalibration = tasks.filter(t => t.difficultyBasis === "calibrated").map(t => [t.id, calibrationProblems(t, datasetDir)]).filter(([, p]) => p.length);
  if (badCalibration.length) reasons.push(`calibrated difficulty not verifiable: ${badCalibration.map(([id, p]) => `${id} (${p[0]})`).join(", ")}`);
  const exposure = exposureScan(tasks.map(t => t.id), { orcheDir });
  const exposed = Object.entries(exposure).filter(([, e]) => e.exposed).map(([id]) => id);
  if (exposed.length) reasons.push(`exposed in earlier experiments: ${exposed.join(", ")}`);
  const uses = holdoutLedger(datasetDir, ledgerPath).records();
  const chain = holdoutLedger(datasetDir, ledgerPath).verify();
  if (chain.length) reasons.push(`holdout use ledger tampered: ${chain.join("; ")}`);
  if (uses.length >= h.maxUses) reasons.push(`holdout already used ${uses.length} time(s) (max ${h.maxUses}): no longer independent`);
  const concentration = concentrationOf(tasks);
  if (h.maxOwnerShare !== null && h.maxOwnerShare !== undefined && tasks.length && concentration.maxOwnerShare > h.maxOwnerShare + 1e-9) reasons.push(`account concentration: ${concentration.topOwner} holds ${concentration.maxOwnerTasks}/${tasks.length} tasks (max share ${h.maxOwnerShare})`);
  if (h.priorFamilyReuse === "forbid") {
    if (!priorFamilies) reasons.push("families of earlier holdouts unknown: reuse cannot be excluded (priorFamilyReuse forbid)");
    else { const reused = [...new Set(tasks.map(t => t.family))].filter(f => priorFamilies.has(f)); if (reused.length) reasons.push(`families of earlier holdouts reused: ${reused.join(", ")}`); }
  }
  return { independent: reasons.length === 0, why: reasons.join("; ") || "sealed, unexposed, unused", uses: uses.length, exposure, seal: seal.seal?.digest, concentration, purpose, exposureNote: "unexposed = not named in earlier experiments; absence from model training data is not established" };
}

/** Account concentration of a task list. */
export function concentrationOf(tasks) {
  const counts = {};
  for (const t of tasks) { const o = ownerOfFamily(t.family); counts[o] = (counts[o] ?? 0) + 1; }
  const [topOwner, maxOwnerTasks] = Object.entries(counts).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0] ?? [null, 0];
  return { owners: Object.keys(counts).length, topOwner, maxOwnerTasks, maxOwnerShare: tasks.length ? Math.round((maxOwnerTasks / tasks.length) * 1000) / 1000 : 0 };
}

/** A fresh workspace with only the visible repository, committed once as the starting state (fixed identity and date). */
export function stageWorkspace(task, dir) {
  ensureDir(dir);
  cpSync(task.repo, dir, { recursive: true, filter: path => !path.endsWith("/.git") });
  const env = { ...process.env, GIT_AUTHOR_NAME: "eval-loop", GIT_AUTHOR_EMAIL: "eval-loop@localhost", GIT_COMMITTER_NAME: "eval-loop", GIT_COMMITTER_EMAIL: "eval-loop@localhost", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  const git = (args) => execFileSync("git", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet"]); git(["add", "-A", "--force"]); git(["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Starting state"]);
  return dir;
}

export const taskDigest = (task) => digestOf({ id: task.id, files: walkFiles(task.dir).map(f => f.symlink ?? sha256(readFileSync(join(task.dir, f.path)))) });

/** Screening mini-batch: seeded sample of train tasks, at least one hard task when the train split has one. */
export function screeningBatch(trainIds, tasksById, size, seed) {
  const rng = createRng(seed);
  const shuffled = rng.shuffle([...trainIds].sort());
  const batch = shuffled.slice(0, Math.min(size, shuffled.length));
  if (!batch.some(id => tasksById[id].hard)) { const hard = shuffled.find(id => tasksById[id].hard); if (hard) batch[batch.length - 1] = hard; }
  return batch.sort();
}
