#!/usr/bin/env node
// Assemble role-separated private task material into intake-ready task directories (model-free; prints ids and counts only).
//
//   node studies/confirmatory-1/assemble.mjs --root <private storage> --roles <roles.json> [--publication-check <json>]
//
// <root> layout (docs: <root>/AUTHORING-GUIDE.md): authoring/<A>/<id>/{task.draft.json, repo/, reference/, AUTHOR-NOTES.md},
// tests/<T>/<id>/{hidden/, TEST-NOTES.md}, reviews/<R>/<id>/{REVIEW.md, review.json}, IDENTITY-*.json per role directory.
// roles.json: { owner, sets: [{ author: "A1", tests: "T3", reviewer: "R1" }] }. Output: <root>/assembled/<id>/{task.json, repo/,
// hidden/, reference/, review/{REVIEW.md, review.json, AUTHOR-NOTES.md, TEST-NOTES.md}}. Nothing is invented: every author, test
// author and reviewer field is copied from the identity and review files the role sessions wrote; a reviewer's verdict and
// checked items are copied as written (a "revise" verdict or an unchecked item makes intake reject the task). The only addition
// is the operator's publication-check attestation (--publication-check), which states its method and is attributed to its author.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const identity = (dir) => { const f = readdirSync(dir).find(n => /^IDENTITY-.*\.json$/.test(n)); return f ? json(join(dir, f)) : null; };

export function assemble({ root, roles, publicationCheck }) {
  const out = [];
  for (const set of roles.sets) {
    const aDir = join(root, "authoring", set.author), tDir = join(root, "tests", set.tests), rDir = join(root, "reviews", set.reviewer);
    const [ai, ti, ri] = [identity(aDir), identity(tDir), identity(rDir)];
    if (!ai || !ti || !ri) throw new Error(`assemble: missing identity file in ${set.author}/${set.tests}/${set.reviewer}`);
    for (const id of readdirSync(aDir).filter(n => n.startsWith("cf1-")).sort()) {
      const draft = json(join(aDir, id, "task.draft.json"));
      const rv = json(join(rDir, id, "review.json"));
      const dst = join(root, "assembled", id);
      rmSync(dst, { recursive: true, force: true });
      mkdirSync(join(dst, "review"), { recursive: true, mode: 0o700 });
      cpSync(join(aDir, id, "repo"), join(dst, "repo"), { recursive: true });
      cpSync(join(aDir, id, "reference"), join(dst, "reference"), { recursive: true });
      cpSync(join(tDir, id, "hidden"), join(dst, "hidden"), { recursive: true });
      for (const [from, name] of [[join(rDir, id, "REVIEW.md"), "REVIEW.md"], [join(rDir, id, "review.json"), "review.json"], [join(aDir, id, "AUTHOR-NOTES.md"), "AUTHOR-NOTES.md"], [join(tDir, id, "TEST-NOTES.md"), "TEST-NOTES.md"]]) if (existsSync(from)) cpSync(from, join(dst, "review", name));
      const doc = readFileSync(join(dst, "review", "REVIEW.md"));
      const reviewer = { id: set.reviewer, kind: rv.kind, model: rv.model ?? ri.PI_MODEL, provider: rv.provider ?? ri.PI_PROVIDER, session: rv.session ?? ri.PI_SESSION_ID, at: rv.at, verdict: rv.verdict, checked: rv.checked ?? [], readAccess: ri.readAccess ?? null };
      const attestations = publicationCheck ? [publicationCheck] : [];
      const checked = [...new Set([...reviewer.checked, ...attestations.map(a => a.item)])].sort();
      const task = {
        id, title: draft.title, family: `private:${roles.owner}/${draft.project}`, tier: draft.tier, kind: draft.kind, instruction: draft.instruction, timeoutSec: 900,
        provenance: "private-reviewed", difficultyBasis: "declared", testProvenance: "independent-author",
        authorship: {
          problemAuthor: set.author, referenceAuthor: set.author, testAuthor: set.tests,
          kinds: { problemAuthor: "ai-agent", referenceAuthor: "ai-agent", testAuthor: "ai-agent" },
          sessions: { [set.author]: { session: ai.PI_SESSION_ID, model: ai.PI_MODEL, provider: ai.PI_PROVIDER, at: [ai.startedAt, ai.finishedAt] }, [set.tests]: { session: ti.PI_SESSION_ID, model: ti.PI_MODEL, provider: ti.PI_PROVIDER, at: [ti.startedAt, ti.finishedAt], readAccess: ti.readAccess ?? null } },
          informationAccess: { testAuthor: "instruction + starting repo only (handoff copy); no reference (self-reported readAccess; same-user file system, not enforced)", reviewer: "everything of the assigned tasks" },
        },
        exposure: { published: false, authoredAt: ai.startedAt, tier: "low", knownExposure: [`authored, tested and reviewed through the model provider ${ai.PI_PROVIDER}/${ai.PI_MODEL} (the provider received the full content)`, "local agent session transcripts under ~/.pi/agent/orche/records (mode 0700; read by the weekly session-review job)", "sibling tasks of one project share or derive from one starting repository"] },
        review: { reviewers: [reviewer], checked, attestations, document: "review/REVIEW.md", documentSha256: sha(doc), independence: "AI-agent roles in separate fresh sessions of ONE model from ONE provider; separate sessions are not independent people, and AI review is not human review" },
      };
      writeFileSync(join(dst, "task.json"), `${JSON.stringify(task, null, 1)}\n`, { mode: 0o600 });
      out.push({ id, family: task.family, tier: task.tier, verdict: rv.verdict, checkedByReviewer: reviewer.checked.length });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { root: { type: "string" }, roles: { type: "string" }, "publication-check": { type: "string" } } });
  if (!values.root || !values.roles) { process.stderr.write("usage: assemble.mjs --root DIR --roles roles.json [--publication-check attestation.json]\n"); process.exit(64); }
  const rows = assemble({ root: values.root, roles: json(values.roles), publicationCheck: values["publication-check"] ? json(values["publication-check"]) : undefined });
  for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);
}
