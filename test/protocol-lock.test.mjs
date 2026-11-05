// Protocol-lock integrity (simulated backend and real CLI subprocesses; no model, no holdout use): a state directory is bound to
// the lock it was created with. A missing, unreadable, malformed or contradicting protocol.lock.json is never re-created or
// replaced for the current evaluator: every entry point (prepare/runCycle/driveOnce, the same Loop object again, verify-stable,
// ablation, --once/--resume/--daemon with or without --require-state, --status [--summary]) refuses with state_error before any
// prerequisite check, grader validation, model call, holdout use or write. Only a provably pre-lock state (fresh, or crashed or
// blocked before the lock step) may create the lock; an older state without a binding is bound to its EXISTING lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync as rm, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureLock, makeHoldout, makeLoop, makeTasks, makeUmbrella, HOLDOUT, TRAIN_DEV, rmSync, tempDir, testProtocol, writeBoundState } from "./helpers.mjs";
import { driveOnce } from "../src/cli.mjs";
import { inspectAblation, inspectState, statusSummary } from "../src/contract.mjs";
import { runAblation } from "../src/ablation.mjs";
import { HaltedError } from "../src/loop.mjs";
import { bindingOf, lockProtocol, StateIntegrityError } from "../src/protocol.mjs";
import { writeReport } from "../src/report.mjs";
import { digestOf, Ledger } from "../src/util.mjs";

const CLI = fileURLToPath(new URL("../bin/eval-loop.mjs", import.meta.url));
const HOLDOUT_USES = fileURLToPath(new URL("../datasets/holdout-v1/USES.jsonl", import.meta.url));
const VALID = { phase: "search", cycle: 1, strategy: "pareto", counters: { candidates: 1, noProgress: 0, consecutiveInfra: 0 }, startedAt: "2026-01-01T00:00:00Z" };
const PRISTINE = { phase: "prepare", cycle: 1, strategy: "pareto", counters: { candidates: 0, noProgress: 0, consecutiveInfra: 0 }, startedAt: "2026-01-01T00:00:00Z" };

/** Names and content hashes of every file below dir (shows that nothing was written). */
function snapshot(dir) {
  const out = {};
  const walk = (d, rel = "") => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name), r = join(rel, e.name); if (e.isDirectory()) { out[`${r}/`] = "dir"; walk(p, r); } else out[r] = createHash("sha256").update(readFileSync(p)).digest("hex"); } };
  if (existsSync(dir)) walk(dir);
  return out;
}
const hashOf = (path) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
const stateOf = (dir) => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
const lockPath = (dir) => join(dir, "protocol.lock.json");

/** A loop whose prerequisites, grader validation, backend and proposer count their calls. @param {string} root @param {any} fx @param {{ protocol?: any, stateName?: string }} [options] */
function counted(root, fx, { protocol, stateName } = {}) {
  const calls = { prerequisites: 0, grader: 0, runs: 0, proposals: 0 };
  const { loop, fx: fixtures } = makeLoop({ root, fixtures: fx, protocol, stateName, entries: [], prerequisites: async () => { calls.prerequisites++; return [{ name: "sim", ok: true }]; } });
  const backend = loop.backend;
  loop.backend = { simulated: true, run: async (input) => { calls.runs++; return backend.run(input); } };
  loop.validateGrader = async () => { calls.grader++; return { ok: true, expected: {}, baselineFailing: [] }; };
  const proposer = loop.proposer;
  loop.proposer = { kind: "scripted", propose: async (input) => { calls.proposals++; return proposer.propose(input); } };
  return { loop, fx: fixtures, calls };
}
const zero = { prerequisites: 0, grader: 0, runs: 0, proposals: 0 };

/** A real loop state after baselines (bound, lock on disk, runs recorded); returns the fixtures and the state directory. */
async function progressed(root) {
  const { loop, fx } = makeLoop({ root, entries: [] });
  loop.stopBefore = "search";
  await loop.runCycle();
  assert.equal(loop.state.phase, "search");
  return { fx, dir: loop.stateDir, loop };
}

/** Local refs of the umbrella and orche checkouts (adoption/rollback move eval-loop/stable refs; a refusal moves nothing). */
const refsOf = (fx) => [fx.umbrella, fx.orche].map(repo => spawnSync("git", ["-C", repo, "for-each-ref", "--format=%(refname) %(objectname)"], { encoding: "utf8" }).stdout).join("\n");

/** Every Loop entry point refuses with StateIntegrityError (integrity code), and nothing is called or written. */
async function refusesEverywhere(root, fx, dir, integrity, { protocol = testProtocol({ seed: "a-different-protocol" }) } = {}) {
  const before = snapshot(dir), uses = hashOf(join(fx.holdout.dir, "USES.jsonl")), refs = refsOf(fx);
  for (const entry of [(l) => driveOnce(l), (l) => l.runCycle(), (l) => l.prepare()]) {
    const { loop, calls } = counted(root, fx, { protocol });
    await assert.rejects(() => entry(loop), (error) => error instanceof StateIntegrityError && error.integrity === integrity, `${entry}`);
    assert.deepEqual(calls, zero, `${entry}: no prerequisite, grader, model or proposer call`);
    assert.deepEqual(snapshot(dir), before, `${entry}: state directory byte-identical (no re-lock, no state/journal write)`);
  }
  assert.equal(hashOf(join(fx.holdout.dir, "USES.jsonl")), uses, "holdout not consumed");
  assert.equal(refsOf(fx), refs, "no ref moved");
  const info = inspectState(dir);
  assert.equal(info.health, "corrupt");
  assert.equal(info.integrity, integrity);
  const s = /** @type {any} */ (statusSummary(dir));
  assert.equal(s.condition, "state_error");
  assert.equal(s.integrity, integrity);
}

test("R1 regression: a bound state whose protocol.lock.json is missing is never re-locked (any protocol, any entry point)", async () => {
  const root = tempDir();
  try {
    const { fx, dir, loop } = await progressed(root);
    const binding = stateOf(dir).protocolLock;
    assert.deepEqual(binding, bindingOf(JSON.parse(readFileSync(lockPath(dir), "utf8"))), "fresh initialization bound the state to its lock");
    assert.equal(/** @type {any} */ (statusSummary(dir)).protocolDigest, binding.protocolDigest);
    rm(lockPath(dir));
    await refusesEverywhere(root, fx, dir, "protocol_lock_missing");
    await refusesEverywhere(root, fx, dir, "protocol_lock_missing", { protocol: testProtocol() });
    // The same Loop object (already prepared, cached state) refuses as well.
    const before = snapshot(dir);
    await assert.rejects(() => driveOnce(loop), StateIntegrityError);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(existsSync(lockPath(dir)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a corrupt, malformed or internally inconsistent lock is a state_error, never replaced", async () => {
  const root = tempDir();
  try {
    const { fx, dir } = await progressed(root);
    const good = JSON.parse(readFileSync(lockPath(dir), "utf8"));
    const cases = [
      ["{ not json", "protocol_lock_corrupt"], ["[]", "protocol_lock_corrupt"], ["{}", "protocol_lock_corrupt"], ["null", "protocol_lock_corrupt"],
      [JSON.stringify({ ...good, evaluator: {} }), "protocol_lock_corrupt"], [JSON.stringify({ ...good, evaluator: null }), "protocol_lock_corrupt"],
      [JSON.stringify({ ...good, protocolDigest: "0".repeat(64) }), "protocol_lock_mismatch"],
      [JSON.stringify({ ...good, protocol: { ...good.protocol, seed: "other" } }), "protocol_lock_mismatch"],
    ];
    for (const [text, integrity] of cases) {
      writeFileSync(lockPath(dir), text);
      await refusesEverywhere(root, fx, dir, integrity);
      assert.equal(readFileSync(lockPath(dir), "utf8"), text);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * Rewrite events.jsonl as an older controller wrote it (protocol-locked events without lockDigest, no protocol-bound events),
 * optionally transformed, with a valid hash chain; and drop the state's binding.
 * @param {string} dir @param {(records: any[]) => any[]} [transform]
 */
function legacyJournal(dir, transform = (r) => r) {
  const path = join(dir, "events.jsonl");
  const records = readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(e => e.type !== "protocol-bound").map(({ hash, prev, seq, lockDigest, ...e }) => e);
  let prev = "genesis";
  const lines = transform(records).map((e, seq) => { const body = { ...e, seq, prev }; const hash = digestOf(body); prev = hash; return JSON.stringify({ ...body, hash }); });
  writeFileSync(path, `${lines.join("\n")}\n`);
  assert.deepEqual(new Ledger(path).verify(), []);
  const { protocolLock, ...state } = stateOf(dir);
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

test("contradictory digests: a replaced evaluator map or dataset digest under the same protocol, a lock for another protocol, a malformed binding", async () => {
  const root = tempDir();
  try {
    const { fx, dir } = await progressed(root);
    const good = JSON.parse(readFileSync(lockPath(dir), "utf8"));
    const someFile = Object.keys(good.evaluator)[0];
    const other = testProtocol({ seed: "other" });
    for (const replaced of [
      { ...good, evaluator: { ...good.evaluator, [someFile]: "f".repeat(64) } },
      { ...good, datasetDigest: "e".repeat(64) },
      { ...good, lockedAt: "2030-01-01T00:00:00Z" },
      { ...good, protocol: other, protocolDigest: digestOf(other) },
    ]) {
      writeFileSync(lockPath(dir), JSON.stringify(replaced));
      assert.equal(replaced.protocolDigest === good.protocolDigest || replaced.protocol === other, true);
      await refusesEverywhere(root, fx, dir, "protocol_lock_mismatch");
    }
    writeFileSync(lockPath(dir), `${JSON.stringify(good, null, 2)}\n`);
    const s = stateOf(dir);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...s, protocolLock: { protocolDigest: "x" } }));
    await refusesEverywhere(root, fx, dir, "protocol_lock_corrupt");
    // An older state (no binding) whose journal recorded another protocol-locked digest than the lock on disk.
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...s, protocolLock: undefined }));
    writeFileSync(lockPath(dir), JSON.stringify({ ...good, protocol: other, protocolDigest: digestOf(other) }));
    await refusesEverywhere(root, fx, dir, "protocol_lock_mismatch");
    // Binding removed from state.json and the lock rewritten for the current evaluator under the same protocol: the journal's
    // lock digest still names the original lock, so the state is not taken for an older unbound one.
    rm(lockPath(dir));
    lockProtocol(dir, good.protocol, { orcheDir: fx.orche, create: true, datasetDigest: good.datasetDigest });
    assert.notDeepEqual(bindingOf(JSON.parse(readFileSync(lockPath(dir), "utf8"))), s.protocolLock);
    await refusesEverywhere(root, fx, dir, "protocol_lock_mismatch");
    writeFileSync(lockPath(dir), `${JSON.stringify(good, null, 2)}\n`);
    await refusesEverywhere(root, fx, dir, "protocol_lock_mismatch");
    // An older journal (no lock digests) that shows two protocol-locked events: the lock was re-created once already.
    legacyJournal(dir, (records) => [...records, { ...records.find(e => e.type === "protocol-locked") }]);
    await refusesEverywhere(root, fx, dir, "protocol_lock_mismatch");
    // Deleting the protocol-locked line (without recomputing the hash chain) breaks the journal: refused, never re-bound.
    legacyJournal(dir);
    const journal = join(dir, "events.jsonl");
    writeFileSync(journal, readFileSync(journal, "utf8").split("\n").filter(line => !line.includes("\"protocol-locked\"")).join("\n"));
    rm(lockPath(dir));
    lockProtocol(dir, good.protocol, { orcheDir: fx.orche, create: true, datasetDigest: good.datasetDigest });
    await refusesEverywhere(root, fx, dir, "protocol_records_corrupt");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an older state without a binding: a missing lock is refused; an intact lock is bound as recorded (never to the current evaluator)", async () => {
  const root = tempDir();
  try {
    const { fx, dir } = await progressed(root);
    const { protocolLock } = stateOf(dir);
    const lockText = readFileSync(lockPath(dir), "utf8");
    legacyJournal(dir);
    rm(lockPath(dir));
    await refusesEverywhere(root, fx, dir, "protocol_lock_missing");
    // Intact lock, but the evaluator now differs (the lock records a different digest for one file): bound to the RECORDED lock,
    // BLOCKED (no re-lock), lock bytes unchanged, nothing evaluated.
    const recorded = JSON.parse(lockText);
    const file = Object.keys(recorded.evaluator)[0];
    const olderLock = `${JSON.stringify({ ...recorded, evaluator: { ...recorded.evaluator, [file]: "c".repeat(64) } }, null, 2)}\n`;
    writeFileSync(lockPath(dir), olderLock);
    assert.equal(/** @type {any} */ (statusSummary(dir)).protocolDigest, recorded.protocolDigest, "the summary shows the verified lock's digest");
    const { loop, calls } = counted(root, fx);
    assert.equal((await driveOnce(loop)).kind, "blocked");
    assert.equal(readFileSync(lockPath(dir), "utf8"), olderLock);
    const after = stateOf(dir);
    assert.deepEqual(after.protocolLock, bindingOf(JSON.parse(olderLock)), "bound to the lock on disk, not to the current evaluator");
    assert.match(after.blocked.reason, /changed since the lock/);
    assert.equal(after.blocked.retryable, false);
    assert.deepEqual({ ...calls, prerequisites: 0 }, zero, "blocked before grader validation, model or proposer");
    assert.equal(calls.prerequisites, 0, "the evaluator identity is checked before the prerequisites");
    assert.ok(loop.events.records().some(e => e.type === "protocol-bound"));
    // Restored lock bytes: the binding no longer matches the restored (original) lock -> mismatch, never re-bound.
    writeFileSync(lockPath(dir), lockText);
    await refusesEverywhere(root, fx, dir, "protocol_lock_mismatch");
    // A legacy state bound to its intact lock resumes normally.
    legacyJournal(dir);
    const resumed = counted(root, fx).loop;
    resumed.stopBefore = "select";
    await resumed.runCycle();
    assert.deepEqual(stateOf(dir).protocolLock, protocolLock);
    assert.equal(readFileSync(lockPath(dir), "utf8"), lockText);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("early-init crash points: a provably pre-lock state creates its lock once; a lock written before the binding is bound as is", async () => {
  const root = tempDir();
  try {
    const fx = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
    const fresh = (name, files) => { const dir = join(root, name); mkdirSync(dir, { recursive: true }); for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text); return dir; };
    const blockedPrelock = { ...PRISTINE, phase: "blocked", blocked: { reason: "missing prerequisites", retryable: true, resumePhase: "prepare", missing: [{ name: "x" }] } };
    for (const [name, files] of /** @type {Array<[string, Record<string, string>]>} */ ([
      ["state-only", { "state.json": JSON.stringify(PRISTINE) }],
      ["after-grading", { "state.json": JSON.stringify(PRISTINE), "grading.json": "{}\n" }],
      ["lock-tmp-left", { "state.json": JSON.stringify(PRISTINE), "protocol.lock.json.tmp-1-ab": "{" }],
      ["blocked-before-lock", { "state.json": JSON.stringify(blockedPrelock) }],
    ])) {
      const dir = fresh(name, files);
      assert.equal(inspectState(dir).protocol.status, "unlocked", name);
      const { loop } = counted(root, fx, { stateName: name });
      loop.stopBefore = "baselines";
      await loop.runCycle();
      const lock = JSON.parse(readFileSync(lockPath(dir), "utf8"));
      assert.deepEqual(stateOf(dir).protocolLock, bindingOf(lock), name);
      assert.equal(loop.events.records().filter(e => e.type === "protocol-locked").length, 1, name);
    }
    // Missing lock after a blocked prepare (CLI wrote a report without a protocol digest): still pre-lock, created on recovery.
    {
      const gate = { ok: false };
      const { loop } = makeLoop({ root, fixtures: fx, stateName: "blocked-run", entries: [], prerequisites: async () => [{ name: "credentials", ok: gate.ok }] });
      assert.equal(await loop.prepare(), false);
      writeReport(loop.stateDir);
      assert.equal(existsSync(lockPath(loop.stateDir)), false);
      assert.equal(inspectState(loop.stateDir).protocol.status, "unlocked");
      gate.ok = true;
      const again = makeLoop({ root, fixtures: fx, stateName: "blocked-run", entries: [] }).loop;
      assert.equal(await again.prepare(), true);
      assert.deepEqual(stateOf(again.stateDir).protocolLock, bindingOf(JSON.parse(readFileSync(lockPath(again.stateDir), "utf8"))));
    }
    // Crash after the lock was written, before the binding was saved: the resume binds to that lock file (bytes unchanged).
    {
      const dir = fresh("lock-before-binding", {});
      const { loop } = makeLoop({ root, fixtures: fx, stateName: "lock-before-binding", entries: [] });
      const save = loop.save.bind(loop);
      loop.save = () => { if (existsSync(lockPath(dir))) throw Object.assign(new Error("simulated crash after the lock write"), { code: "ECRASH" }); save(); };
      await assert.rejects(() => loop.prepare(), { code: "ECRASH" });
      const text = readFileSync(lockPath(dir), "utf8");
      assert.equal(stateOf(dir).protocolLock, undefined, "crashed before the binding was saved");
      assert.equal(inspectState(dir).protocol.status, "bound");
      const again = makeLoop({ root, fixtures: fx, stateName: "lock-before-binding", entries: [] }).loop;
      assert.equal(await again.prepare(), true);
      assert.equal(readFileSync(lockPath(dir), "utf8"), text);
      assert.deepEqual(stateOf(dir).protocolLock, bindingOf(JSON.parse(text)));
      assert.ok(again.events.records().some(e => e.type === "protocol-bound"));
    }
    // lockProtocol itself never creates a lock unless asked to (verification is the default).
    {
      const dir = fresh("unit", {});
      assert.throws(() => lockProtocol(dir, testProtocol(), { orcheDir: fx.orche }), (e) => e instanceof StateIntegrityError && e.integrity === "protocol_lock_missing");
      assert.deepEqual(readdirSync(dir), []);
    }
    // A crash during the very first state.json write leaves only its temporary file: still a fresh directory.
    {
      const dir = fresh("first-write", { "state.json.tmp-1-ab": "{" });
      assert.equal(inspectState(dir).health, "fresh");
      const { loop } = makeLoop({ root, fixtures: fx, stateName: "first-write", entries: [] });
      assert.equal(await loop.prepare(), true);
      assert.deepEqual(stateOf(dir).protocolLock, bindingOf(JSON.parse(readFileSync(lockPath(dir), "utf8"))));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a pre-lock-looking state with any lock-dependent trace is damaged, not fresh", async () => {
  const root = tempDir();
  try {
    const fx = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
    const event = (type, extra = {}) => `${JSON.stringify({ type, ...extra, seq: 0, prev: "genesis", hash: "h" })}\n`;
    const variants = {
      datasets: { "datasets.json": "{}\n" }, runs: { "runs.jsonl": "{}\n" }, candidates: { "candidates/c001/analysis.json": "{}\n" }, worktrees: { "worktrees/stable/x": "x" },
      lockedEvent: { "events.jsonl": event("protocol-locked", { protocolDigest: "a".repeat(64) }) }, phaseEvent: { "events.jsonl": event("phase", { phase: "baselines" }) },
      badEvents: { "events.jsonl": "{ not json\n" }, report: { "report.json": JSON.stringify({ protocolDigest: "a".repeat(64) }) }, selection: { "selection.json": "{}\n" },
    };
    const states = { stable: { ...PRISTINE, stable: { id: "stable", commit: "c" } }, cycle2: { ...PRISTINE, cycle: 2, history: [] }, search: { ...PRISTINE, phase: "search" }, resumeSearch: { ...PRISTINE, phase: "blocked", blocked: { reason: "x", resumePhase: "search" } },
      lockBlocked: { ...PRISTINE, phase: "blocked", blocked: { reason: "protocol/evaluator/dataset changed since the lock: start a new protocol version in a new state directory", resumePhase: "prepare", problems: ["evaluator file changed: x"] } } };
    const cases = /** @type {Array<[string, any, Record<string, string>]>} */ ([...Object.entries(variants).map(([name, files]) => [name, PRISTINE, files]), ...Object.entries(states).map(([name, state]) => [name, state, {}])]);
    for (const [name, state, files] of cases) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify(state));
      for (const [f, text] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), text); }
      const info = inspectState(dir);
      assert.equal(info.integrity, "protocol_lock_missing", `${name}: ${info.detail}`);
      // The Loop constructor creates the (empty) candidates directory, which is not a record; the snapshot follows it.
      const { loop, calls } = counted(root, fx, { stateName: name });
      const before = snapshot(dir);
      await assert.rejects(() => driveOnce(loop), StateIntegrityError, name);
      assert.deepEqual(calls, zero, name);
      assert.deepEqual(snapshot(dir), before, name);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("existing evidence without state.json: the Loop API refuses before writing (never initializes over records)", async () => {
  const root = tempDir();
  try {
    const fx = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
    const dir = join(root, "lost");
    mkdirSync(dir);
    writeFileSync(join(dir, "runs.jsonl"), "{}\n");
    writeFileSync(join(dir, "protocol.lock.json"), JSON.stringify(fixtureLock().lock));
    const before = snapshot(dir);
    const { loop, calls } = counted(root, fx, { stateName: "lost" });
    await assert.rejects(() => driveOnce(loop), (e) => e instanceof StateIntegrityError && e.health === "missing");
    assert.deepEqual(calls, zero);
    assert.deepEqual(snapshot(dir), { ...before, "candidates/": "dir" }, "only the empty candidates directory of the Loop constructor (not a record)");
    assert.equal(inspectState(dir).health, "missing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("halted takes precedence over a damaged binding; the binding carries over to the next cycle", async () => {
  const root = tempDir();
  try {
    const { fx, dir } = await progressed(root);
    const s = stateOf(dir);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...s, halted: "trust boundary breach: x", haltedAt: "t" }));
    rm(lockPath(dir));
    assert.equal(inspectState(dir).health, "present");
    assert.equal(/** @type {any} */ (statusSummary(dir)).condition, "halted");
    const before = snapshot(dir);
    const { loop, calls } = counted(root, fx);
    assert.equal((await driveOnce(loop)).kind, "halted");
    await assert.rejects(() => loop.prepare(), HaltedError);
    assert.deepEqual(calls, zero);
    assert.deepEqual(snapshot(dir), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const root2 = tempDir();
  try {
    const { loop } = makeLoop({ root: root2, entries: [] });
    assert.equal((await driveOnce(loop)).kind, "cycle_done");
    const binding = loop.state.protocolLock;
    loop.nextCycle();
    assert.deepEqual(stateOf(loop.stateDir).protocolLock, binding);
    assert.equal(stateOf(loop.stateDir).cycle, 2);
    assert.equal(await loop.prepare(), true, "cycle 2 resumes under the same lock");
    rm(lockPath(loop.stateDir));
    assert.equal(inspectState(loop.stateDir).integrity, "protocol_lock_missing", "a later cycle never counts as pre-lock");
  } finally { rmSync(root2, { recursive: true, force: true }); }
});

test("ablation: every trajectory is checked before A prepares; B/C share A's binding; halted wins over a damaged trajectory", async () => {
  const root = tempDir();
  try {
    const fx = { ...makeUmbrella(root), tasks: makeTasks(root, TRAIN_DEV), holdout: makeHoldout(root, HOLDOUT) };
    const abc = join(root, "abc");
    let built = 0;
    const loopFactory = async ({ stateDir, strategy }) => { built++; return makeLoop({ root, fixtures: fx, stateName: join("abc", stateDir.split("/").at(-1)), strategy, entries: [] }).loop; };
    const r = await runAblation({ stateDir: abc, loopFactory });
    assert.equal(r.outcome, "ok", JSON.stringify(r));
    const A = stateOf(join(abc, "A")).protocolLock;
    for (const arm of ["B", "C"]) {
      assert.deepEqual(stateOf(join(abc, arm)).protocolLock, A, `${arm} bound to A's lock`);
      assert.equal(readFileSync(lockPath(join(abc, arm)), "utf8"), readFileSync(lockPath(join(abc, "A")), "utf8"));
    }
    const all = () => snapshot(abc);
    const refuse = async (integrity) => {
      const before = all(); built = 0;
      const again = await runAblation({ stateDir: abc, loopFactory });
      assert.equal(again.outcome, "state_error", JSON.stringify(again));
      assert.equal(again.summary.integrity, integrity);
      assert.equal(built, 0, "no trajectory constructed");
      assert.deepEqual(all(), before);
      assert.equal(/** @type {any} */ (statusSummary(abc)).condition, "state_error");
    };
    const cText = readFileSync(lockPath(join(abc, "C")), "utf8");
    rm(lockPath(join(abc, "C")));
    await refuse("protocol_lock_missing");
    // Each trajectory internally consistent, but C bound to another lock than A/B.
    const other = fixtureLock(testProtocol({ seed: "other" }));
    const c = stateOf(join(abc, "C"));
    writeFileSync(lockPath(join(abc, "C")), JSON.stringify(other.lock));
    writeFileSync(join(abc, "C", "state.json"), JSON.stringify({ ...c, protocolLock: other.binding }));
    assert.equal(inspectState(join(abc, "C")).health, "present");
    await refuse("protocol_lock_mismatch");
    writeFileSync(lockPath(join(abc, "C")), cText);
    writeFileSync(join(abc, "C", "state.json"), JSON.stringify(c));
    // A halted A with a damaged C: halted.
    const a = stateOf(join(abc, "A"));
    writeFileSync(join(abc, "A", "state.json"), JSON.stringify({ ...a, halted: "trust boundary breach: y" }));
    rm(lockPath(join(abc, "C")));
    assert.equal(inspectAblation(abc).halted.arm, "A");
    assert.equal((await runAblation({ stateDir: abc, loopFactory })).outcome, "halted");
    // An interrupted seed (shared files copied, no state.json) is a lost trajectory, never re-seeded.
    const seeded = join(root, "seed");
    mkdirSync(join(seeded, "A"), { recursive: true });
    writeBoundState(join(seeded, "A"), { ...VALID, phase: "baselines" });
    mkdirSync(join(seeded, "B"));
    writeFileSync(lockPath(join(seeded, "B")), readFileSync(lockPath(join(seeded, "A"))));
    assert.equal(inspectAblation(seeded).health, "missing");
    // A trajectory whose lock vanishes after the preflight (a race) is refused by its own prepare: runAblation returns state_error.
    const race = join(root, "race");
    const vanishing = async ({ stateDir, strategy }) => {
      const name = stateDir.split("/").at(-1);
      if (name !== "A") rm(lockPath(stateDir));
      return makeLoop({ root, fixtures: fx, stateName: join("race", name), strategy, entries: [] }).loop;
    };
    const raced = await runAblation({ stateDir: race, loopFactory: vanishing });
    assert.equal(raced.outcome, "state_error", JSON.stringify(raced));
    assert.equal(raced.summary.integrity, "protocol_lock_missing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function cli(root, args) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: home, EVAL_LOOP_AGENT_DIR: join(home, "agent") } });
  const lines = r.stdout.trim().split("\n");
  let outcome; try { outcome = JSON.parse(lines.at(-1) ?? ""); } catch { outcome = undefined; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outcome };
}

test("CLI: missing/corrupt/contradicting lock -> state_error (exit 4, integrity code) for every run mode and both status views; nothing written", () => {
  const root = tempDir();
  try {
    const dir = join(root, "s");
    writeBoundState(dir, VALID);
    const ok = cli(root, ["--status", "--summary", "--state", dir]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(ok.outcome.protocolDigest, fixtureLock().binding.protocolDigest, "the summary carries the verified protocol digest");
    const good = readFileSync(lockPath(dir), "utf8");
    assert.equal(cli(root, ["--status", "--state", dir]).status, 0, "plain --status on an intact state");
    // Plain --status reports a lost state like --summary (exit 4).
    const lost = join(root, "lost");
    mkdirSync(lost);
    writeFileSync(join(lost, "runs.jsonl"), "{}\n");
    const lostStatus = cli(root, ["--status", "--state", lost]);
    assert.equal(lostStatus.status, 4, lostStatus.stdout);
    assert.equal(lostStatus.outcome.health, "missing");
    const abc = join(root, "abc");
    writeBoundState(join(abc, "A"), VALID);
    const other = fixtureLock(testProtocol({ seed: "other" })).lock;
    for (const [label, damage, integrity] of /** @type {Array<[string, () => void, string]>} */ ([
      ["missing", () => rm(lockPath(dir)), "protocol_lock_missing"],
      ["corrupt", () => writeFileSync(lockPath(dir), "{ not json"), "protocol_lock_corrupt"],
      ["replaced", () => writeFileSync(lockPath(dir), JSON.stringify(other)), "protocol_lock_mismatch"],
    ])) {
      damage();
      const before = snapshot(dir), uses = hashOf(HOLDOUT_USES);
      for (const args of [["--resume"], ["--resume", "--require-state"], ["--once"], ["--once", "--require-state"], ["--daemon", "--max-cycles", "1"], ["--verify-stable", "--tasks", root]]) {
        const r = cli(root, [...args, "--state", dir]);
        assert.equal(r.status, 4, `${label} ${args.join(" ")}: ${r.stdout}${r.stderr}`);
        assert.equal(r.outcome.schema, "pi-eval-loop/outcome@1");
        assert.equal(r.outcome.outcome, "state_error");
        assert.equal(r.outcome.health, "corrupt");
        assert.equal(r.outcome.integrity, integrity, `${label} ${args.join(" ")}`);
        assert.deepEqual(snapshot(dir), before, `${label} ${args.join(" ")}: unchanged, no lock created`);
      }
      const s = cli(root, ["--status", "--summary", "--state", dir]);
      assert.equal(s.status, 4);
      assert.equal(s.outcome.condition, "state_error");
      assert.equal(s.outcome.integrity, integrity);
      const plain = cli(root, ["--status", "--state", dir]);
      assert.equal(plain.status, 4, "plain --status reports the damaged binding too");
      assert.equal(plain.outcome.integrity, integrity);
      assert.deepEqual(snapshot(dir), before);
      assert.equal(hashOf(HOLDOUT_USES), uses);
      // The same damage in trajectory A of an ablation.
      if (label === "missing") rm(lockPath(join(abc, "A"))); else writeFileSync(lockPath(join(abc, "A")), label === "corrupt" ? "{ not json" : JSON.stringify(other));
      const beforeAbc = snapshot(abc);
      const a = cli(root, ["--ablation", "--state", abc]);
      assert.equal(a.status, 4, a.stdout + a.stderr);
      assert.equal(a.outcome.integrity, integrity);
      for (const args of [["--status", "--summary"], ["--status"]]) {
        const v = cli(root, [...args, "--state", abc]);
        assert.equal(v.status, 4, `ablation ${args.join(" ")}: ${v.stdout}`);
        assert.equal(v.outcome.integrity, integrity);
      }
      assert.deepEqual(snapshot(abc), beforeAbc);
      writeFileSync(lockPath(join(abc, "A")), good);
      writeFileSync(lockPath(dir), good);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
