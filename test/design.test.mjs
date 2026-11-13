// protocol-4 evaluation design (src/design.mjs): frozen interleaved schedules, the randomization test and its resolution, the
// confirmatory plan (nothing invented, missing evidence blocks), confirmatory checks ANDed onto the unchanged adoption gate, and
// the shared series error budget (locked, idempotent, never refunded).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { confirmatoryChecks, evidenceLabel, executionOrder, interleavedSchedule, leaveOneFamilyOut, planCompleteness, randomizationTest, scheduleProblems, seriesFits, seriesStatus, spendAlpha } from "../src/design.mjs";
import { adoptionDecision } from "../src/gate.mjs";
import { compare } from "../src/stats.mjs";
import { createRng } from "../src/rng.mjs";
import { DEFAULT_PROTOCOL, merge, validateProtocol } from "../src/protocol.mjs";
import { sha256 } from "../src/util.mjs";
import { rmSync, tempDir } from "./helpers.mjs";

const P = structuredClone(DEFAULT_PROTOCOL);
const t = (task, a, b, extra = {}) => ({ task, family: extra.family ?? task, hard: !!extra.hard, provenance: extra.provenance ?? "external", a, b });

test("interleaved schedule: deterministic, one unit per arm in every (task, repeat) block, randomized block and arm order, edits detected", () => {
  const args = { arms: ["stable", "c001"], tasks: ["h3", "h1", "h2", "h4"], repeats: 3, split: "holdout", seed: "s:frozen-1", bind: { frozenDigest: "f" } };
  const a = interleavedSchedule(args), b = interleavedSchedule({ ...args, arms: ["c001", "stable"], tasks: ["h1", "h2", "h3", "h4"] });
  assert.equal(a.digest, b.digest, "input order does not matter");
  assert.deepEqual(a, b);
  assert.notEqual(interleavedSchedule({ ...args, seed: "s:frozen-2" }).digest, a.digest);
  assert.notEqual(interleavedSchedule({ ...args, bind: { frozenDigest: "g" } }).digest, a.digest, "bound to the frozen selection");
  assert.equal(a.units.length, 4 * 3 * 2);
  const blocks = new Map();
  for (const u of a.units) { if (!blocks.has(u.block)) blocks.set(u.block, []); blocks.get(u.block).push(u); }
  assert.equal(blocks.size, 12);
  for (const units of blocks.values()) {
    assert.deepEqual(units.map(u => u.arm).sort(), ["c001", "stable"]);
    assert.equal(new Set(units.map(u => `${u.task}#${u.repeat}`)).size, 1, "a block is one (task, repeat)");
    assert.deepEqual(units.map(u => u.slot), [0, 1]);
  }
  const firsts = [...blocks.values()].map(units => units[0].arm);
  assert.ok(firsts.includes("stable") && firsts.includes("c001"), "the arm order varies between blocks");
  const order = [...blocks.values()].map(units => `${units[0].task}#${units[0].repeat}`);
  assert.notDeepEqual(order, [...order].sort(), "blocks are not in task order");
  assert.deepEqual(a.units.map(u => u.index), a.units.map((_, i) => i));
  assert.deepEqual(scheduleProblems(a, a), []);
  const edited = structuredClone(a); [edited.units[0], edited.units[1]] = [edited.units[1], edited.units[0]];
  assert.ok(scheduleProblems(edited, a).length > 0);
  assert.throws(() => interleavedSchedule({ ...args, arms: ["x", "x"] }), /distinct/);
  // Dispatch audit: first attempts in planned order follow the plan; a retry is listed apart; an inversion is counted.
  const key = (u) => `${u.arm}|${u.task}|${u.repeat}`;
  const ledger = [...a.units.slice(0, 5).map(u => ({ type: "dispatch", attempt: 1, unit_key: key(u) })), { type: "dispatch", attempt: 2, unit_key: key(a.units[1]) }];
  const ok = executionOrder(ledger, a, key);
  assert.equal(ok.followsPlan, true); assert.equal(ok.dispatched, 5); assert.equal(ok.retries.length, 1);
  const swapped = executionOrder([ledger[1], ledger[0]], a, key);
  assert.equal(swapped.followsPlan, false); assert.equal(swapped.inversions, 1);
});

test("randomization test: ties, one block, exact resolution 2^-d, unmatched/missing blocks, Monte Carlo p never zero, null calibration", () => {
  const ties = randomizationTest([t("a", [1, 1, 1], [1, 1, 1]), t("b", [0, 0, 0], [0, 0, 0])]);
  assert.equal(ties.valid, true); assert.equal(ties.p, 1); assert.equal(ties.discordantBlocks, 0);
  const one = randomizationTest([t("a", [0, 1, 1], [1, 1, 1])]);
  assert.equal(one.p, 0.5); assert.equal(one.minAttainableP, 0.5);
  // The first real holdout's pattern: three discordant blocks, all favouring the candidate -> p = 1/8 (no more than that).
  const three = randomizationTest([t("x", [0, 1, 1], [1, 1, 1]), t("y", [0, 1, 1], [1, 1, 1]), t("z", [0, 0, 0], [1, 0, 0]), t("w", [0, 0, 0], [0, 0, 0])]);
  assert.equal(three.exact, true); assert.equal(three.p, 0.125); assert.equal(three.minAttainableP, 0.125);
  // Unequal family sizes and task weights: repeats are averaged within their task, tasks count once.
  const unequal = randomizationTest([t("a", [0], [1]), t("b", [0, 0, 0, 0], [1, 0, 0, 0])]);
  assert.equal(unequal.valid, true); assert.ok(unequal.p >= unequal.minAttainableP);
  assert.equal(randomizationTest([t("a", [0, 1], [1])]).valid, false);
  assert.equal(randomizationTest([t("a", [0, NaN], [1, 1])]).valid, false);
  assert.equal(randomizationTest([]).valid, false);
  const many = Array.from({ length: 24 }, (_, i) => t(`m${i}`, [0], [1]));
  const mc = randomizationTest(many, { draws: 2000, seed: "mc" });
  assert.equal(mc.exact, false); assert.ok(mc.p > 0 && mc.p >= 1 / 2001, `Monte Carlo p ${mc.p}`);
  // Calibration under the sharp null (arm labels exchangeable): rejections at alpha stay at or below alpha (+ simulation error).
  const rng = createRng("null-calibration");
  let rejections = 0; const runs = 400, alpha = 0.05;
  for (let s = 0; s < runs; s++) {
    const tasks = Array.from({ length: 8 }, (_, i) => { const p = rng.next(); const a = [], b = []; for (let r = 0; r < 3; r++) { a.push(rng.next() < p ? 1 : 0); b.push(rng.next() < p ? 1 : 0); } return t(`n${i}`, a, b, { family: `f${i % 3}` }); });
    if (randomizationTest(tasks, { draws: 2000, seed: `n${s}` }).p <= alpha) rejections++;
  }
  assert.ok(rejections / runs <= alpha + 3 * Math.sqrt(alpha * (1 - alpha) / runs), `null rejection rate ${rejections / runs}`);
});

test("leave-one-family-out is a sensitivity check: one family cannot carry the gain; a single family cannot be checked", () => {
  assert.equal(leaveOneFamilyOut([t("a", [0], [1], { family: "f" })]).ok, false);
  assert.match(leaveOneFamilyOut([t("a", [0], [1], { family: "f" })]).why, /1 family/);
  const carried = [t("a", [0, 0], [1, 1], { family: "big" }), t("b", [0, 0], [1, 1], { family: "big" }), t("c", [1, 1], [1, 1], { family: "x" }), t("d", [1, 0], [0, 1], { family: "y" })];
  const r = leaveOneFamilyOut(carried);
  assert.equal(r.ok, false); assert.ok(r.byFamily.big <= 0);
});

function fullPlan(root, overrides = {}) {
  mkdirSync(root, { recursive: true });
  const doc = join(root, "rationale.md");
  writeFileSync(doc, "# Sample size and effect size rationale (operator-written)\n");
  return merge(merge(structuredClone(DEFAULT_PROTOCOL), {
    holdout: { priorFamilyReuse: "forbid" },
    analysisPlan: { mode: "confirmatory", registeredAt: "2026-11-06T00:00:00Z", rationale: { document: doc, sha256: sha256("# Sample size and effect size rationale (operator-written)\n") }, minEffect: 0.1, alpha: 0.01, minTasks: 8, minFamilies: 4, minHardTasks: 2,
      series: { id: "s1", ledger: join(root, "series.jsonl"), alphaTotal: 0.05 }, lowExposure: { required: false }, confirmation: { required: false } },
  }), overrides);
}

test("confirmatory plan: exploratory needs nothing; every confirmatory value must be pre-registered (no defaults invented); edits after registration block", () => {
  const root = tempDir();
  try {
    assert.deepEqual(planCompleteness(P, { base: root }), []);
    assert.equal(P.analysisPlan.mode, "exploratory");
    for (const k of ["minEffect", "alpha", "minTasks", "minFamilies", "minHardTasks", "registeredAt", "rationale"]) assert.equal(P.analysisPlan[k], null, `${k} has no default`);
    const bare = merge(structuredClone(P), { analysisPlan: { mode: "confirmatory" } });
    assert.deepEqual(validateProtocol(bare), [], "an incomplete plan is a valid protocol that blocks at preflight");
    const missing = planCompleteness(bare, { base: root }).join("\n");
    for (const re of [/registeredAt/, /rationale/, /minEffect/, /alpha/, /minTasks/, /minFamilies/, /minHardTasks/, /series/, /priorFamilyReuse/, /lowExposure.required/, /confirmation.required/]) assert.match(missing, re);
    const full = fullPlan(root);
    assert.deepEqual(validateProtocol(full), []);
    assert.deepEqual(planCompleteness(full, { base: root }), []);
    appendFileSync(join(root, "rationale.md"), "edited later\n");
    assert.match(planCompleteness(full, { base: root }).join(" "), /changed since registration/);
    writeFileSync(join(root, "rationale.md"), "# Sample size and effect size rationale (operator-written)\n");
    assert.match(planCompleteness(fullPlan(root, { holdout: { execution: "sequential" } }), { base: root }).join(" "), /interleaved/);
    assert.match(planCompleteness(fullPlan(root, { analysisPlan: { alpha: 0.04, confirmation: { required: true, pool: "/p", alpha: 0.02, minTasks: 6, minFamilies: 4 } } }), { base: root }).join(" "), /exceeds series.alphaTotal/);
    assert.match(planCompleteness(fullPlan(root, { analysisPlan: { lowExposure: { required: true, minTasks: 2 } } }), { base: root }).join(" "), /acceptedProvenance must include/);
    assert.ok(validateProtocol(merge(structuredClone(P), { analysisPlan: { lowExposure: { provenance: ["external"] } } })).some(x => /never low exposure/.test(x)));
    assert.ok(validateProtocol(merge(structuredClone(P), { holdout: { execution: "random" } })).some(x => /holdout.execution/.test(x)));
    assert.equal(evidenceLabel(P, { adopt: true }).class, "exploratory");
    assert.equal(evidenceLabel(P, { adopt: true }).confirmatoryClaim, false);
    assert.equal(evidenceLabel(full, { adopt: true, confirmatory: { ok: true } }).confirmatoryClaim, true);
    assert.equal(evidenceLabel(full, { adopt: true, confirmatory: { ok: true } }).generalizedClaim, false, "a generalized claim needs the independent confirmation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("confirmatory checks: answered/unanswerable/failed, and they are ANDed onto the unchanged gate (original BLOCKED/KEEP_STABLE/INCONCLUSIVE rules win)", () => {
  const root = tempDir();
  try {
    const full = fullPlan(root);
    const plan = { ...full.analysisPlan, draws: 2000, permutationDraws: 2000, seed: "c" };
    const strong = Array.from({ length: 12 }, (_, i) => t(`h${i}`, [0, 0, 0], [1, 1, 1], { hard: i < 4, family: `f${i % 6}` }));
    const ok = confirmatoryChecks(strong, plan);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.ok(ok.results.randomization.p <= plan.alpha);
    const small = confirmatoryChecks(strong.slice(0, 3), plan);
    assert.equal(small.ok, false); assert.ok(small.inconclusive.some(x => /pre-registered 8/.test(x)));
    const few = confirmatoryChecks([...strong.slice(0, 2), ...Array.from({ length: 8 }, (_, i) => t(`z${i}`, [1, 1, 1], [1, 1, 1], { hard: true, family: `g${i % 4}` }))], plan);
    assert.ok(few.inconclusive.some(x => /cannot reach alpha/.test(x)), JSON.stringify(few.inconclusive));
    // Many discordant blocks in both directions (the test can reach alpha) but no net effect: answered, not supported.
    const weak = confirmatoryChecks(Array.from({ length: 12 }, (_, i) => t(`w${i}`, i % 2 ? [1, 0, 1] : [0, 1, 1], i % 2 ? [0, 1, 1] : [1, 0, 1], { hard: i < 4, family: `f${i % 6}` })), plan);
    assert.equal(weak.inconclusive.length, 0, JSON.stringify(weak.inconclusive));
    assert.equal(weak.ok, false); assert.ok(weak.failed.length > 0, JSON.stringify(weak));
    const lowPlan = { ...plan, lowExposure: { required: true, minTasks: 2, provenance: ["private-reviewed"] } };
    assert.ok(confirmatoryChecks(strong, lowPlan).inconclusive.some(x => /low-exposure stratum 0/.test(x)));
    // The gate: original rules first; the confirmatory result can never rescue them.
    const cmp = compare(strong, { draws: 2000, seed: "g", level: "task", event: "adoption", eps: full.adoption.eps, minGain: full.adoption.minGain, lossThreshold: 0, familyLossThreshold: full.adoption.familyRegression });
    const familyCmp = compare(strong, { draws: 2000, seed: "g", level: "family", event: "adoption", eps: full.adoption.eps, minGain: full.adoption.minGain, lossThreshold: 0 });
    const ev = { holdoutIndependent: true, critical: [], checksPassed: true, routeOk: true, incomplete: [], infraRate: 0, familyCmp, confirmatory: ok };
    assert.equal(adoptionDecision(cmp, full, ev).verdict, "ADOPT");
    assert.ok(adoptionDecision(cmp, full, ev).reasons.some(r => /confirmatory: randomization test/.test(r)));
    for (const bad of [{ critical: ["integrity"] }, { checksPassed: false }, { routeOk: false }, { incomplete: ["u"] }, { holdoutIndependent: false, holdoutWhy: "used" }]) assert.equal(adoptionDecision(cmp, full, { ...ev, ...bad }).verdict, "BLOCKED", JSON.stringify(bad));
    assert.equal(adoptionDecision({ ...cmp, hardTasks: 0 }, full, ev).verdict, "INCONCLUSIVE", "size-proxy-only hard stratum stays INCONCLUSIVE");
    assert.equal(adoptionDecision({ ...cmp, support: 0.9 }, full, ev).verdict, "KEEP_STABLE", "the protocol-3 support threshold stays necessary");
    assert.equal(adoptionDecision(cmp, full, { ...ev, confirmatory: undefined }).verdict, "BLOCKED", "missing confirmatory evidence blocks");
    assert.equal(adoptionDecision(cmp, full, { ...ev, confirmatory: small }).verdict, "INCONCLUSIVE");
    assert.equal(adoptionDecision(cmp, full, { ...ev, confirmatory: weak }).verdict, "KEEP_STABLE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const execFileP = promisify(execFile);
const DESIGN = fileURLToPath(new URL("../src/design.mjs", import.meta.url));

test("series budget: shared across experiments, idempotent per frozen binding, never overspent (concurrent processes), damaged ledgers refuse", async () => {
  const root = tempDir();
  try {
    const ledger = join(root, "series", "s1.jsonl");
    const base = { series: "s1", alphaTotal: 0.05, alpha: 0.02 };
    const a = spendAlpha(ledger, { ...base, stateDir: "/x/a", purpose: "holdout", bind: { f: 1 } });
    assert.equal(a.recovered, false);
    assert.equal(spendAlpha(ledger, { ...base, stateDir: "/x/a", purpose: "holdout", bind: { f: 1 } }).recovered, true, "a resumed experiment gets its spend back");
    assert.match(spendAlpha(ledger, { ...base, stateDir: "/x/a", purpose: "holdout", bind: { f: 2 } }).refused, /another frozen binding/);
    assert.equal(seriesFits(ledger, { ...base, stateDir: "/x/b" }).ok, true);
    spendAlpha(ledger, { ...base, stateDir: "/x/b", purpose: "holdout", bind: {} });
    assert.equal(seriesFits(ledger, { ...base, stateDir: "/x/c" }).ok, false);
    assert.match(spendAlpha(ledger, { ...base, stateDir: "/x/c", purpose: "holdout", bind: {} }).refused, /exhausted/);
    assert.ok(Math.abs(seriesStatus(ledger, "s1").spent - 0.04) < 1e-12);
    // Concurrent claims from separate processes: 6 claims of 0.02 on a 0.05 budget -> exactly 2 succeed.
    const shared = join(root, "series", "s2.jsonl");
    const script = `import { spendAlpha } from ${JSON.stringify(DESIGN)}; const r = spendAlpha(process.argv[1], { series: "s2", alphaTotal: 0.05, alpha: 0.02, stateDir: process.argv[2], purpose: "holdout", bind: {} }); process.stdout.write(r.refused ? "refused" : "spent");`;
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => execFileP(process.execPath, ["--input-type=module", "-e", script, shared, `/x/p${i}`]).then(r => r.stdout)));
    assert.equal(outs.filter(o => o === "spent").length, 2, outs.join(","));
    assert.equal(seriesStatus(shared, "s2").ok, true);
    // A damaged ledger refuses (never treated as an empty series).
    appendFileSync(ledger, "{not json\n");
    assert.match(spendAlpha(ledger, { ...base, stateDir: "/x/d", purpose: "holdout", bind: {} }).refused, /unusable/);
    const tampered = join(root, "series", "s3.jsonl");
    spendAlpha(tampered, { ...base, series: "s3", stateDir: "/x/a", purpose: "holdout", bind: {} });
    writeFileSync(tampered, (await import("node:fs")).readFileSync(tampered, "utf8").replace("0.02", "0.001"));
    assert.equal(seriesStatus(tampered, "s3").ok, false);
    assert.equal(seriesFits(tampered, { ...base, series: "s3", stateDir: "/x/z" }).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
