// Global request budget (2026-11-07, model-free): durable reservation before dispatch, fail-closed accounting (corrupt, edited
// or truncated ledger, changed ceiling, unwritable storage, unreadable meter), competing processes at the boundary, a dispatcher
// killed after its reservation, settlement from the wire journal (nested agent requests), the evaluator's admission hook
// (refusal halts without a record; every retry attempt is reserved), the gateway watchdog and the calibration unit classes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { BudgetError, RequestBudget, budgetTotals } from "../src/request-budget.mjs";
import { Evaluator, simulatedBackend } from "../src/evaluator.mjs";
import { DEFAULT_PROTOCOL, merge } from "../src/protocol.mjs";
import { makeRecord } from "../src/metrics.mjs";
import { CENSORING, outcomesFromLedger, unitClass, unitClassesFromLedger } from "../src/calibration.mjs";
import { attemptAdmission, knownDefectProblems, pressureVerdict } from "../studies/confirmatory-1/calibrate.mjs";
import { gatewayAttemptBound, gatewayIsolationProblems } from "../src/request-budget.mjs";

const BUDGET_MODULE = fileURLToPath(new URL("../src/request-budget.mjs", import.meta.url));

test("budget: reserve before dispatch, settle after; unsettled reservations count in full; the ceiling is fixed by the ledger", async () => {
  const root = tempDir();
  try {
    const path = join(root, "b.jsonl");
    const b = new RequestBudget({ path, limit: 400, scope: "s" });
    const t1 = await b.reserve(150, { unit: 1 }); const t2 = await b.reserve(150, { unit: 2 });
    assert.ok(t1 && t2);
    assert.equal(await b.reserve(150), null, "a third worst case would exceed 400");
    assert.match(b.refusal, /request ceiling 400: charged 300/);
    await b.settle(t1, 12);
    assert.deepEqual({ charged: b.status().charged, open: b.status().openReservations, remaining: b.status().remaining }, { charged: 162, open: 1, remaining: 238 });
    const t3 = await b.reserve(150); assert.ok(t3);
    await assert.rejects(b.settle(t1, 3), /already settled/);
    await assert.rejects(b.settle({ id: "r-nope" }, 3), /unknown reservation/);
    // A later process can neither raise the ceiling nor reuse the ledger for another scope.
    assert.throws(() => new RequestBudget({ path, limit: 4500, scope: "s" }).status(), /created with limit 400/);
    assert.throws(() => new RequestBudget({ path, limit: 400, scope: "other" }).status(), /scope differs/);
    assert.throws(() => new RequestBudget({ path, limit: 0, scope: "s" }), /positive integer/);
    // An overrun (more used than reserved: a cap breach) is charged at what was used and makes the ledger inconsistent.
    const totals = budgetTotals([{ type: "init", limit: 10 }, { type: "reserve", id: "a", amount: 5 }, { type: "settle", id: "a", used: 7 }]);
    assert.equal(totals.charged, 7); assert.match(totals.problems.join(" "), /exceeds its reserved worst case/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("budget: fail closed on a truncated, edited or unwritable ledger and on an unreadable required meter", async () => {
  const root = tempDir();
  try {
    const path = join(root, "b.jsonl");
    const b = new RequestBudget({ path, limit: 1000, scope: "s" });
    await b.reserve(150);
    const good = readFileSync(path, "utf8");
    appendFileSync(path, '{"type":"settle","id":"r-');
    await assert.rejects(b.reserve(150), (e) => e instanceof BudgetError && /unreadable/.test(e.message), "a torn tail is never ignored");
    writeFileSync(path, good.replace('"amount":150', '"amount":1'));
    await assert.rejects(b.reserve(150), /chain broken/, "an edited reservation is detected");
    writeFileSync(path, good);
    const meterFails = new RequestBudget({ path, limit: 1000, scope: "s", meters: [{ name: "gw", read: () => { throw new Error("db locked"); } }] });
    await assert.rejects(meterFails.reserve(150), /required meter gw unreadable/);
    const meterHigh = new RequestBudget({ path, limit: 1000, scope: "s", meters: [{ name: "gw", read: () => 601 }], meterMargin: 100 });
    assert.equal(await meterHigh.reserve(150), null, "601 seen by the gateway + 150 open + 150 > 1000 - 100");
    assert.match(meterHigh.refusal, /meters gw=601/);
    const ro = join(root, "ro"); mkdirSync(ro);
    const roBudget = new RequestBudget({ path: join(ro, "b.jsonl"), limit: 1000, scope: "s" });
    await roBudget.reserve(150);
    chmodSync(ro, 0o500);
    try { await assert.rejects(roBudget.reserve(150), BudgetError, "no reservation can be recorded: refuse"); } finally { chmodSync(ro, 0o700); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Run a child process that reserves `amount` once and prints the ticket (or null); optionally exits without settling. */
function child(path, limit, amount, { settle } = {}) {
  const code = `const { RequestBudget } = await import(${JSON.stringify(BUDGET_MODULE)});
    const b = new RequestBudget({ path: ${JSON.stringify(path)}, limit: ${limit}, scope: "s" });
    const t = await b.reserve(${amount});
    ${settle !== undefined ? `if (t) await b.settle(t, ${settle});` : ""}
    process.stdout.write(JSON.stringify(t)); process.exit(0);`;
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
    c.on("exit", (status) => status === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
}

test("budget: competing processes at the boundary never over-admit; a dispatcher killed after reserving stays charged in full", async () => {
  const root = tempDir();
  try {
    const path = join(root, "b.jsonl");
    const results = await Promise.all(Array.from({ length: 8 }, () => child(path, 600, 150)));
    assert.equal(results.filter(Boolean).length, 4, "exactly 600 / 150 reservations are admitted across 8 racing processes");
    const b = new RequestBudget({ path, limit: 600, scope: "s" });
    assert.deepEqual({ charged: b.status().charged, open: b.status().openReservations }, { charged: 600, open: 4 }, "processes that exited without settling stay charged");
    const path2 = join(root, "b2.jsonl");
    assert.ok(await child(path2, 300, 150, { settle: 9 }));
    assert.ok(await child(path2, 300, 150));
    const b2 = new RequestBudget({ path: path2, limit: 300, scope: "s" });
    assert.equal(b2.status().charged, 159);
    assert.equal(await b2.reserve(150), null, "after a restart the unsettled reservation still counts: 159 + 150 > 300");
    assert.ok(await b2.reserve(141));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const tasksById = { a: { id: "a", family: "f1", tier: "easy" }, b: { id: "b", family: "f2", tier: "hard" } };
const protocol = merge(structuredClone(DEFAULT_PROTOCOL), { parallelism: 1 });

test("evaluator admission: every attempt (incl. infrastructure retries) is reserved before dispatch; a refusal halts without a record", async () => {
  const root = tempDir();
  try {
    const budget = new RequestBudget({ path: join(root, "b.jsonl"), limit: 4500, scope: "s" });
    const admission = { reserve: (a, m) => budget.reserve(a, m), settle: (t, u, d) => budget.settle(t, u, d), get refusal() { return budget.refusal; } };
    const backend = simulatedBackend({ skill: (h, t) => ({ p: 0.5, infra: t.id === "a" }) });
    const ev = new Evaluator({ stateDir: join(root, "s1"), protocol, protocolDigest: "p", tasksById, grading: {}, backend, admission });
    const out = await ev.evaluate({ id: "stable", kind: "orche" }, [{ task: "a", split: "c", repeat: 0 }, { task: "b", split: "c", repeat: 0 }], "ctx");
    assert.equal(out.filter(Boolean).length, 2);
    const recs = budget.verified();
    assert.equal(recs.filter(r => r.type === "reserve").length, 3, "task a: first attempt (infra) + one retry; task b: one attempt");
    assert.equal(budget.status().charged, 0 + 5 + 5, "the infra attempt forwarded nothing; the others 5 each");
    const dispatches = ev.ledger.records().filter(r => r.type === "dispatch");
    assert.ok(dispatches.every(d => recs.some(r => r.type === "reserve" && r.id === d.reservation)), "every dispatch names its reservation");
    // Refusal: a full budget halts before any dispatch record.
    const full = new RequestBudget({ path: join(root, "full.jsonl"), limit: 100, scope: "s" });
    const ev2 = new Evaluator({ stateDir: join(root, "s2"), protocol, protocolDigest: "p", tasksById, grading: {}, backend, admission: { reserve: (a, m) => full.reserve(a, m), settle: (t, u) => full.settle(t, u), get refusal() { return full.refusal; } } });
    const out2 = await ev2.evaluate({ id: "stable", kind: "orche" }, [{ task: "b", split: "c", repeat: 0 }], "ctx");
    assert.equal(out2[0], undefined); assert.match(ev2.halted, /request ceiling 100/);
    assert.equal(ev2.ledger.records().length, 0, "no dispatch, no record: the unit is censored, not a failure");
    // Accounting failure (throws) also halts.
    const ev3 = new Evaluator({ stateDir: join(root, "s3"), protocol, protocolDigest: "p", tasksById, grading: {}, backend, admission: { reserve: async () => { throw new BudgetError("ledger gone", "X"); }, settle: async () => {} } });
    await ev3.evaluate({ id: "stable", kind: "orche" }, [{ task: "b", split: "c", repeat: 0 }], "ctx");
    assert.match(ev3.halted, /request accounting unavailable: ledger gone/); assert.equal(ev3.ledger.records().length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("evaluator admission: settlement takes the larger of the record's forwarded count and the wire journal's POST starts (nested agents)", async () => {
  const root = tempDir();
  try {
    const budget = new RequestBudget({ path: join(root, "b.jsonl"), limit: 4500, scope: "s" });
    const backend = {
      simulated: true,
      async run({ controlDir, unitKey, runId, attempt, task, repeat, split, context }) {
        // Two nested sessions behind one proxy: 7 POSTs started; the record (as if a controller lost one totals file) says 3.
        mkdirSync(join(controlDir, "model"), { recursive: true });
        writeFileSync(join(controlDir, "model", "wire.jsonl"), Array.from({ length: 7 }, (_, i) => JSON.stringify({ phase: "start", method: "POST", id: i })).join("\n") + "\n");
        return makeRecord({ run_id: runId, unit_key: unitKey, attempt, candidate_id: "stable", harness_kind: "orche", task_id: task.id, split, family: task.family, repeat, context, terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, model_requests: 3, model_requests_completed: 3, started_at: new Date().toISOString(), simulated: true });
      },
    };
    const ev = new Evaluator({ stateDir: join(root, "s"), protocol, protocolDigest: "p", tasksById, grading: {}, backend, admission: { reserve: (a, m) => budget.reserve(a, m), settle: (t, u, d) => budget.settle(t, u, d) } });
    await ev.evaluate({ id: "stable", kind: "orche" }, [{ task: "a", split: "c", repeat: 0 }], "ctx");
    const settle = budget.verified().find(r => r.type === "settle");
    assert.equal(settle.used, 7); assert.equal(settle.detail.forwarded, 3); assert.equal(settle.detail.wirePostStarts, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("calibration peer protection and unit classes: rate-limit pressure halts, infrastructure is never difficulty", () => {
  assert.equal(pressureVerdict({ failures: 0 }).action, "none");
  assert.equal(pressureVerdict({ failures: 1 }).action, "halt");
  const base = { run_id: "r", unit_key: "k", candidate_id: "stable", harness_kind: "orche", task_id: "a", split: "calibration", family: "f", context: "ctx", started_at: "2026-11-07T00:00:00Z" };
  const rec = (f) => makeRecord({ ...base, ...f });
  assert.equal(unitClass(rec({ terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true })), "success");
  assert.equal(unitClass(rec({ terminal_status: "completed", hidden_test_pass: false })), "failure");
  assert.equal(unitClass(rec({ terminal_status: "timeout" })), "failure");
  assert.equal(unitClass(rec({ terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true, critical_failure_count: 1, integrity: { violations: ["edited hidden test"], suspicious: [], leakHits: [] } })), "integrity");
  for (const s of ["model_error", "aborted", "grader_error", "infra_error", "model_unavailable"]) assert.equal(unitClass(rec({ terminal_status: s, model_requests_completed: 3 })), "infrastructure", s);
  assert.equal(unitClass(rec({ terminal_status: "harness_crash" })), "harness-fault");
  const root = tempDir();
  try {
    const ev = new Evaluator({ stateDir: root, protocol, protocolDigest: "p", tasksById, grading: {}, backend: simulatedBackend({ skill: () => ({ p: 1 }) }) });
    const put = (task, repeat, f) => ev.ledger.append({ type: "result", unit_key: `${task}${repeat}`, record: rec({ task_id: task, repeat, attempt: 1, ...f }) });
    put("a", 0, { terminal_status: "completed", hidden_test_pass: true, visible_test_pass: true });
    put("a", 1, { terminal_status: "model_error", model_requests_completed: 4 });
    put("a", 2, { terminal_status: "completed", hidden_test_pass: false });
    put("b", 0, { terminal_status: "aborted", model_requests_completed: 2 });
    const ledger = join(root, "runs.jsonl");
    const opts = { harnessId: "stable", context: "ctx", repeats: 3, tasks: ["a"] };
    assert.deepEqual(outcomesFromLedger(ledger, { ...opts, censoring: CENSORING }), { a: [1, 0] }, "the model_error repeat carries no difficulty evidence");
    assert.deepEqual(outcomesFromLedger(ledger, opts), { a: [1, 0, 0] }, "legacy rule (no censoring) unchanged");
    assert.throws(() => outcomesFromLedger(ledger, { ...opts, tasks: ["b"], repeats: 1, censoring: CENSORING }), /no difficulty evidence/);
    const classes = unitClassesFromLedger(ledger, { ...opts, tasks: ["a", "b"] });
    assert.deepEqual(classes.counts, { success: 1, failure: 1, integrity: 0, infrastructure: 2, "harness-fault": 0, censored: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gateway attempt bound: (request-retry + 1) rounds x eligible credentials; anything unknowable refuses", () => {
  const root = tempDir();
  try {
    const auth = join(root, "oauth"); mkdirSync(auth);
    const cfg = (extra = "") => { const p = join(root, "config.yaml"); writeFileSync(p, `routing:\n    force-model-prefix: true\n    retry:\n# request-retry: 9 (comment)\n        request-retry: 3\n        max-retry-credentials: 0\n${extra}oauth:\n    auth-dir: ./oauth\n`); return p; };
    writeFileSync(join(auth, "codex-a.json"), JSON.stringify({ type: "codex" }));
    writeFileSync(join(auth, "codex-b.json"), JSON.stringify({ type: "codex", prefix: "bts" }));
    writeFileSync(join(auth, "codex-c.json"), JSON.stringify({ type: "codex", disabled: true }));
    writeFileSync(join(auth, "claude-d.json"), JSON.stringify({ type: "claude" }));
    assert.equal(gatewayAttemptBound({ config: cfg(), model: "gpt-6-luna" }).perRequest, 4, "1 eligible credential x 4 rounds");
    writeFileSync(join(auth, "codex-e.json"), JSON.stringify({ type: "codex", "request-retry": 5 }));
    const b = gatewayAttemptBound({ config: cfg(), model: "gpt-6-luna" });
    assert.deepEqual([b.credentials, b.rounds, b.perRequest], [2, 6, 12], "a per-credential override raises the rounds");
    assert.throws(() => gatewayAttemptBound({ config: cfg("home:\n    enabled: true\n"), model: "gpt-6-luna" }), /Home mode/);
    assert.throws(() => gatewayAttemptBound({ config: cfg("codex-api-key:\n  - api-key: x\n"), model: "gpt-6-luna" }), /API-key/);
    assert.throws(() => gatewayAttemptBound({ config: cfg("        request-retry: 1\n"), model: "gpt-6-luna" }), /found 2 times/);
    assert.throws(() => gatewayAttemptBound({ config: cfg(), model: "claude-opus" }), /only codex-served/);
    writeFileSync(join(auth, "codex-f.json"), "{");
    assert.throws(() => gatewayAttemptBound({ config: cfg(), model: "gpt-6-luna" }), /unreadable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("attempt admission: reserves cap x K, settles forwarded x K (never lower); a changed bound halts and is charged at the larger K", async () => {
  const root = tempDir();
  try {
    const budget = new RequestBudget({ path: join(root, "b.jsonl"), limit: 4500, scope: "s" });
    let K = 4;
    const adm = attemptAdmission(budget, () => ({ perRequest: K }));
    const t = await adm.reserve(150, { unit: 1 });
    assert.equal(budget.verified().find(r => r.type === "reserve").amount, 600);
    await adm.settle(t, 20, {});
    assert.equal(budget.status().charged, 80, "20 forwarded requests x 4 attempts");
    const t2 = await adm.reserve(150, {}); K = 8;
    await assert.rejects(adm.settle(t2, 10, {}), /changed from 4 to 8/);
    assert.equal(budget.status().charged, 160, "charged at the larger bound");
    // The ceiling holds in attempts: 4500 / 600 = 7 concurrent reservations at most.
    const tight = new RequestBudget({ path: join(root, "t.jsonl"), limit: 4500, scope: "s" });
    const a2 = attemptAdmission(tight, () => ({ perRequest: 4 }));
    let n = 0; while (await a2.reserve(150, {})) n++;
    assert.equal(n, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("calibration fails closed on known grader defects and on a shared gateway", () => {
  const root = tempDir();
  try {
    const put = (id, classes) => { mkdirSync(join(root, id), { recursive: true }); writeFileSync(join(root, id, "triage.json"), JSON.stringify({ classes })); };
    put("ok1", ["ok"]); put("gap", ["test-gap"]); put("inc", ["incomplete"]);
    const plan = (exclusions) => ({ allTasks: ["ok1", "gap", "inc", "none"], tasks: [], rule: { exclusions } });
    const p = knownDefectProblems({ reviews: root, plan: plan([]) }).join(" | ");
    assert.match(p, /gap: known grader defect \(test-gap\) not excluded/); assert.match(p, /inc: review incomplete/); assert.match(p, /none: no cross-provider triage/);
    assert.deepEqual(knownDefectProblems({ reviews: root, plan: plan(["gap", "inc", "none"].map(task => ({ task }))) }), [], "excluded tasks are not measured, so they cannot bias the calibration");
    const proc = { exeSha256: "a".repeat(64), config: "/srv/live/config.yaml" };
    assert.match(gatewayIsolationProblems({ process: proc, verifiedExeSha256: "a".repeat(64), privateRoot: "/priv", configPath: "/srv/live/config.yaml" }).join(" "), /shared live instance/);
    assert.match(gatewayIsolationProblems({ process: proc, verifiedExeSha256: "b".repeat(64), privateRoot: "/priv", configPath: "/srv/live/config.yaml" }).join(" "), /not the build whose retry contract was verified/);
    assert.deepEqual(gatewayIsolationProblems({ process: { ...proc, config: "/priv/gateway/config.yaml" }, verifiedExeSha256: "a".repeat(64), privateRoot: "/priv", configPath: "/priv/gateway/config.yaml" }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outbound attempts: admitted only within the charged total; settlement floor keeps charged >= attempts; anchor detects truncation/removal", async () => {
  const root = tempDir();
  try {
    const path = join(root, "b.jsonl");
    const b = new RequestBudget({ path, limit: 10, scope: "s" });
    assert.equal(await b.admitAttempt(), null, "no ledger, no reservation: nothing leaves");
    const t = await b.reserve(4, { unit: 1 });
    for (let i = 0; i < 4; i++) assert.ok(await b.admitAttempt({ i }));
    assert.equal(await b.admitAttempt(), null, "a fifth attempt exceeds the open reservation");
    assert.match(b.refusal, /4 attempts already cover the charged total 4/);
    const s = await b.settle(t, 1);
    assert.deepEqual({ used: s.used, floor: s.floor }, { used: 4, floor: 4 }, "the settlement is raised to the actual attempts");
    assert.deepEqual({ charged: b.status().charged, attempts: b.status().attempts }, { charged: 4, attempts: 4 });
    assert.equal(await b.admitAttempt(), null, "no open reservation: refused");
    // Concurrent processes at the boundary: room for exactly 3 attempts.
    const t2 = await b.reserve(3);
    const got = await Promise.all(Array.from({ length: 8 }, () => new RequestBudget({ path, limit: 10, scope: "s" }).admitAttempt()));
    assert.equal(got.filter(Boolean).length, 3);
    await b.settle(t2, 0);
    assert.equal(b.status().charged, 7);
    // Truncation or removal after the fact refuses everything.
    const good = readFileSync(path, "utf8");
    writeFileSync(path, good.split("\n").filter(Boolean).slice(0, -1).join("\n") + "\n");
    await assert.rejects(b.admitAttempt(), /shorter than or differs from its anchor/);
    rmSync(path);
    assert.throws(() => b.status(), /anchor/);
    writeFileSync(path, good);
    assert.equal(b.status().attempts, 7);
    rmSync(`${path}.anchor.json`);
    assert.throws(() => b.status(), /has no anchor/);
    // budgetTotals flags attempts beyond the charged total.
    assert.match(budgetTotals([{ type: "init", limit: 5 }, { type: "attempt" }]).problems.join(" "), /exceed the charged total/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gated attempt admission: reserves cap x factor, settles the forwarded count (raised to the attempt floor); a failing runtime check halts after settling", async () => {
  const root = tempDir();
  try {
    const budget = new RequestBudget({ path: join(root, "b.jsonl"), limit: 1000, scope: "s" });
    let ok = true;
    const a = attemptAdmission(budget, () => { if (!ok) throw new Error("runtime gone"); return { perRequest: 2, gated: true }; });
    const t = await a.reserve(150, { unit: "u" });
    assert.equal(t.amount, 300); assert.equal(t.gated, true);
    for (let i = 0; i < 7; i++) await budget.admitAttempt();
    await a.settle(t, 5, {});
    assert.equal(budget.status().charged, 7, "forwarded 5 but 7 actual attempts: charged 7");
    const t2 = await a.reserve(150, {});
    ok = false;
    await assert.rejects(a.settle(t2, 2, {}), /runtime check failed/);
    assert.equal(budget.status().charged, 9, "settled at 2 before halting");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
