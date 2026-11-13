// Non-human review policy (2026-11-07, model-free): cross-provider evidence is re-verified from the task directory (documents and
// digests, reviewer providers vs authors and target, response models, content digest, filesystem-enforced blind access,
// mechanical agreement, adjudication of accepted mutants); the protocol policy is enforced identically by holdout eligibility and
// readiness; and the reviewer sandbox's own mount set hides the withheld material (bubblewrap probe with positive controls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rmSync, tempDir } from "./helpers.mjs";
import { BLIND_SCOPE, CROSS_PROVIDER_SCHEMA, crossProviderProblems, privateReviewProblems, providerOfModel, reviewClass, taskContentDigest } from "../src/datasets.mjs";
import { DEFAULT_PROTOCOL, loadProtocol } from "../src/protocol.mjs";
import { hostEnvironment } from "../src/sandbox.mjs";
import { BOX, denialProbe, reviewerBinds } from "../studies/confirmatory-1/review.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

function makeTask(root, { blind = {}, adv = {}, adj, blindAdj, authorModel = "claude-opus-5-5" } = {}) {
  const dir = join(root, "t1");
  for (const p of ["repo/src", "hidden/test", "reference/src", "review/xprov"]) mkdirSync(join(dir, p), { recursive: true });
  writeFileSync(join(dir, "repo/src/a.js"), "export const a = 0;\n");
  writeFileSync(join(dir, "hidden/test/a.hidden.test.js"), "// hidden\n");
  writeFileSync(join(dir, "reference/src/a.js"), "export const a = 1;\n");
  const instruction = "Make a equal 1.";
  const digest = taskContentDigest(dir, instruction);
  const blindDigest = taskContentDigest(dir, instruction, BLIND_SCOPE);
  const probe = [{ path: join(dir, "hidden"), visible: false, checked: true }];
  const blindDoc = { startedAt: "2026-11-07T00:00:00Z", contentDigest: blindDigest, reviewer: { kind: "ai-agent", id: "rv-1", route: "cliproxyapi/grok-4.7", provider: "xai", responseModels: ["grok-4.7-build"] }, access: { enforcement: "filesystem (bubblewrap)", inputs: [{ path: "INSTRUCTION.md" }, { path: "repo/src/a.js" }], denialProbe: probe }, mechanical: { blindTests: 1, referencePasses: true, discriminates: true }, ...blind };
  const advDoc = { startedAt: "2026-11-07T00:00:00Z", contentDigest: digest, reviewer: { kind: "ai-agent", id: "rv-2", route: "cliproxyapi/gemini-3.8-flash-high", provider: "google", responseModels: ["gemini-3.8-flash-high"] }, mechanical: { referencePassesHidden: true, mutants: [] }, verdict: { verdict: "accept", findings: [] }, ...adv };
  const put = (name, obj) => { const text = JSON.stringify(obj); writeFileSync(join(dir, "review/xprov", name), text); return { document: `review/xprov/${name}`, sha256: sha(text) }; };
  const crossProvider = { schema: CROSS_PROVIDER_SCHEMA, blind: put("blind.json", blindDoc), adversarial: put("adversarial.json", advDoc), ...(adj ? { adjudication: put("adjudication.json", { contentDigest: digest, ...adj }) } : {}), ...(blindAdj ? { blindAdjudication: put("blind-adjudication.json", { contentDigest: blindDigest, ...blindAdj }) } : {}) };
  const task = { id: "t1", instruction, provenance: "private-reviewed", exposure: { authoredAt: "2026-11-06T00:00:00Z" }, authorship: { sessions: { A: { model: authorModel }, T: { model: authorModel } } }, review: { reviewers: [{ id: "R", kind: "ai-agent" }], crossProvider } };
  return { dir, task };
}

test("cross-provider evidence: verified from documents; providers, response models, content, access and mechanical results are all required", () => {
  const root = tempDir();
  try {
    const ok = makeTask(root);
    assert.deepEqual(crossProviderProblems(ok.task, { dir: ok.dir }), []);
    assert.equal(reviewClass(ok.task), "cross-provider-reviewed");
    assert.equal(providerOfModel("bts/claude-opus-5-5"), "anthropic"); assert.equal(providerOfModel("gpt-6-luna"), "openai");
    const cases = [
      [{ blind: { reviewer: { kind: "ai-agent", id: "x", route: "cliproxyapi/claude-sonnet-5", provider: "anthropic", responseModels: ["claude-sonnet-5"] } } }, /author's provider/],
      [{ blind: { reviewer: { kind: "ai-agent", id: "x", route: "cliproxyapi/gpt-6.1-sol", provider: "openai", responseModels: ["gpt-6.1-sol"] } } }, /target model's provider/],
      [{ blind: { reviewer: { kind: "ai-agent", id: "x", route: "cliproxyapi/grok-4.7", provider: "xai", responseModels: ["gpt-6.1-sol"] } } }, /do not all belong to xai/],
      [{ blind: { reviewer: { kind: "human", id: "x", route: "cliproxyapi/grok-4.7", provider: "xai", responseModels: ["grok-4.7"] } } }, /never presented as a person/],
      [{ adv: { reviewer: { kind: "ai-agent", id: "y", route: "cliproxyapi/grok-4.6", provider: "xai", responseModels: ["grok-4.6"] } } }, /already reviewed this task in another role/],
      [{ blind: { access: { enforcement: "instruction not to read", inputs: [], denialProbe: [{ path: "x", visible: false, checked: true }] } } }, /not filesystem-enforced/],
      [{ blind: { access: { enforcement: "filesystem", inputs: [{ path: "hidden/test/a.js" }], denialProbe: [{ path: "x", visible: false, checked: true }] } } }, /holds withheld material/],
      [{ blind: { access: { enforcement: "filesystem", inputs: [], denialProbe: [{ path: "x", visible: true, checked: true }] } } }, /withheld path was visible/],
      [{ blind: { mechanical: { blindTests: 3, referencePasses: false, discriminates: true } } }, /reference does not pass the independent blind tests/],
      [{ adv: { mechanical: { referencePassesHidden: true, mutants: [{ name: "m1", hiddenAccepts: true }] } } }, /mutant m1 passes the official hidden tests and is not adjudicated/],
      [{ adv: { verdict: { verdict: "revise", findings: [{ severity: "major" }] } } }, /verdict revise without an adjudication/],
      [{ adv: { verdict: { verdict: "revise", findings: [{ severity: "major" }] } }, adj: { adjudicator: { kind: "ai-agent", route: "cliproxyapi/claude-opus-5-5" }, verdict: "accept", findings: [{}] } }, /adjudicator must be of a non-author provider/],
    ];
    for (const [opts, re] of cases) {
      const r = tempDir(); try { const t = makeTask(r, opts); assert.match(crossProviderProblems(t.task, { dir: t.dir }).join(" | "), re, JSON.stringify(opts).slice(0, 120)); } finally { rmSync(r, { recursive: true, force: true }); }
    }
    // An adjudicated accepted mutant ("not-a-violation" with a reason) and an accepting non-author adjudication pass.
    const r2 = tempDir();
    try {
      const t = makeTask(r2, { adv: { mechanical: { referencePassesHidden: true, mutants: [{ name: "m1", hiddenAccepts: true }] }, verdict: { verdict: "revise", findings: [{ severity: "major" }] } }, adj: { adjudicator: { kind: "ai-agent", route: "cliproxyapi/grok-4.6" }, verdict: "accept", findings: [{ answer: "the instruction allows it" }], mutants: [{ name: "m1", resolution: "not-a-violation", reason: "the instruction does not fix the order" }] } });
      assert.deepEqual(crossProviderProblems(t.task, { dir: t.dir }), []);
    } finally { rmSync(r2, { recursive: true, force: true }); }
    // A blind test the reference fails is set aside only by a third-provider adjudication as blind-test-error/ambiguity.
    const failingBlind = { mechanical: { blindTests: 1, referencePasses: false, discriminates: true, referenceFailing: ["t1 > exact message"] } };
    const r4 = tempDir();
    try {
      const t0 = makeTask(r4, { blind: failingBlind });
      assert.match(crossProviderProblems(t0.task, { dir: t0.dir }).join(" "), /no adjudication by a third provider/);
    } finally { rmSync(r4, { recursive: true, force: true }); }
    for (const [blindAdj, ok] of [
      [{ adjudicator: { kind: "ai-agent", route: "cliproxyapi/gemini-3-flash" }, blindFailures: [{ test: "t1 > exact message", resolution: "blind-test-error", reason: "the instruction fixes no message" }] }, true],
      [{ adjudicator: { kind: "ai-agent", route: "cliproxyapi/gemini-3-flash" }, blindFailures: [{ test: "t1 > exact message", resolution: "reference-defect", reason: "violates the rule" }] }, false],
      [{ adjudicator: { kind: "ai-agent", route: "cliproxyapi/grok-4.6" }, blindFailures: [{ test: "t1 > exact message", resolution: "blind-test-error", reason: "x" }] }, false],
    ]) {
      const r5 = tempDir();
      try { const t = makeTask(r5, { blind: failingBlind, blindAdj }); assert.equal(crossProviderProblems(t.task, { dir: t.dir }).length === 0, ok, JSON.stringify(blindAdj).slice(0, 160)); } finally { rmSync(r5, { recursive: true, force: true }); }
    }
    // A changed task is no longer covered by its reviews: new hidden tests void the adversarial review (the blind evidence, which
    // depends only on instruction, repository and reference, stays); a changed reference voids both.
    writeFileSync(join(ok.dir, "hidden/test/a.hidden.test.js"), "// hidden, extended later\n");
    const afterHidden = crossProviderProblems(ok.task, { dir: ok.dir }).join(" | ");
    assert.match(afterHidden, /adversarial: reviewed other task content/); assert.doesNotMatch(afterHidden, /blind: reviewed other/);
    writeFileSync(join(ok.dir, "reference/src/a.js"), "export const a = 2 - 1;\n");
    assert.match(crossProviderProblems(ok.task, { dir: ok.dir }).join(" | "), /blind: reviewed other task content/);
    // An edited document is detected.
    const r3 = tempDir();
    try { const t = makeTask(r3); writeFileSync(join(t.dir, "review/xprov/blind.json"), "{}"); assert.match(crossProviderProblems(t.task, { dir: t.dir }).join(" "), /blind: document does not match its sha256/); } finally { rmSync(r3, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("privateReview policy: human / cross-provider / ai-allowed are applied identically; protocol validation knows the values", () => {
  const root = tempDir();
  try {
    const { dir, task } = makeTask(root);
    assert.match(privateReviewProblems(task, "human", { dir }).join(" "), /AI-agent review is not human review/);
    assert.deepEqual(privateReviewProblems(task, "cross-provider", { dir }), []);
    assert.match(privateReviewProblems({ ...task, review: { reviewers: task.review.reviewers } }, "cross-provider", { dir }).join(" "), /no cross-provider review evidence/);
    assert.deepEqual(privateReviewProblems(task, "ai-allowed", { dir }), []);
    assert.deepEqual(privateReviewProblems({ ...task, provenance: "external" }, "human", { dir }), [], "only private tasks need a private review");
    const p = join(root, "p.json"); writeFileSync(p, JSON.stringify({ holdout: { privateReview: "cross-provider" } }));
    assert.equal(loadProtocol(p).holdout.privateReview, "cross-provider");
    assert.equal(DEFAULT_PROTOCOL.holdout.privateReview, "human", "the default stays human review");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const env = hostEnvironment();
const bwrapWorks = (() => { try { execFileSync(env.bwrap, ["--ro-bind", "/", "/", "--unshare-net", "--unshare-pid", "--tmpfs", "/home", "true"], { stdio: "ignore", timeout: 10_000 }); return true; } catch { return false; } })();

test("reviewer sandbox: its exact mount set shows the bundle and hides the task's hidden tests, reference, private storage and credentials", { skip: !bwrapWorks ? "bwrap with namespaces unavailable" : false, timeout: 60_000 }, async () => {
  const root = tempDir();
  try {
    const box = join(root, "box"), task = join(root, "task");
    for (const d of [join(box, "ws/repo"), join(task, "hidden"), join(task, "reference"), join(root, "home/.pi/agent")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(box, "ws/INSTRUCTION.md"), "x\n"); writeFileSync(join(task, "hidden/h.test.js"), "secret\n"); writeFileSync(join(root, "home/.pi/agent/cliproxyapi.json"), "{\"apiKey\":\"k\"}");
    const launch = join(root, "launch.sh"); writeFileSync(launch, "#!/bin/sh\n"); const socket = join(root, "sock"); writeFileSync(socket, "");
    const binds = reviewerBinds({ env, box, launch, socket });
    const withheld = [join(task, "hidden"), join(task, "reference"), join(root, "home/.pi/agent/cliproxyapi.json"), "/home/arthur/.pi/agent/cliproxyapi.json", "/home/arthur/Code/agent_workflow/runs"];
    const probe = await denialProbe({ binds, sandboxEnv: { PATH: "/usr/bin:/bin" }, cwd: `${BOX}/ws`, withheld, visibleControl: [`${BOX}/ws/INSTRUCTION.md`, `${BOX}/ws/repo`] });
    assert.equal(probe.length, withheld.length);
    assert.ok(probe.every(p => p.checked), "positive controls visible: the probe ran in the reviewer's mount set");
    assert.deepEqual(probe.filter(p => p.visible).map(p => p.path), [], "no withheld path is visible");
    const blindControls = await denialProbe({ binds, sandboxEnv: { PATH: "/usr/bin:/bin" }, cwd: `${BOX}/ws`, withheld: [join(task, "hidden")], visibleControl: ["/nonexistent-control"] });
    assert.equal(blindControls[0].checked, false, "a probe whose positive control fails proves nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
