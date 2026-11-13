// ONE shared total across roles (2026-11-13, model-free): gate-covered target attempts (smoke, dev, holdout, calibration,
// confirmation, deployment smoke, post-confirmation) and off-gate proposal/review requests charge the SAME ledger and its one
// limit; off-gate charges never fund outbound attempts (no screening slack, no reuse of closed or foreign reservations), an
// abandoned off-gate reservation keeps its worst case, and every failure stays fail closed. Also: the outbound gate over a mixed
// ledger and the peer-pressure meter of a non-default target model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, tempDir } from "./helpers.mjs";
import { RETAINED_ROUTES, RequestBudget, budgetTotals, gatewayPressureMeter, offGate } from "../src/request-budget.mjs";
import { startOutboundGate } from "../src/outbound-gate.mjs";
import { attemptAdmission } from "../src/admission.mjs";

const BUDGET_MODULE = fileURLToPath(new URL("../src/request-budget.mjs", import.meta.url));
const proposal = (id) => ({ route: "proposal", proposal: id });
/** The screening dev-stage slack predicate (screening.mjs): gate-covered settled charges above the outbound attempts. */
const slack = (s) => s.attempts < s.gatedCharged - s.gatedOpenAmount;

test("shared total: proposals, reviews and gate-covered attempts share ONE limit; off-gate charges never fund attempts or create screening slack", async () => {
  const root = tempDir();
  try {
    const b = new RequestBudget({ path: join(root, "total.jsonl"), limit: 300, scope: "terra total" });
    assert.deepEqual([...RETAINED_ROUTES], ["proposal", "review"]);
    // The reported failure: a settled proposal in the screening ledger, no attempt yet. Old rule: 0 < 120 - 0 -> fail closed.
    const p1 = await b.reserve(120, proposal("p-1"));
    assert.equal(await b.admitAttempt(), null, "an open proposal reservation never lets an outbound attempt leave");
    await b.settle(p1, 50);
    let s = b.status();
    assert.deepEqual({ charged: s.charged, gated: s.gatedCharged, offGate: s.offGateCharged, attempts: s.attempts }, { charged: 50, gated: 0, offGate: 50, attempts: 0 });
    assert.equal(slack(s), false, "a settled proposal is not outbound-attempt slack");
    assert.equal(await b.admitAttempt(), null, "settled proposal charges never fund an attempt");
    // A partly used proposal settles exactly its reported count (no attempt floor, never raised by gate attempts).
    const g = await b.reserve(10, { route: "screening", unit: "u1" });
    for (let i = 0; i < 10; i++) assert.ok(await b.admitAttempt({ i }));
    assert.equal(await b.admitAttempt(), null, "the 11th attempt exceeds the gate-covered charge even with 50 off-gate charged");
    const r1 = await b.reserve(80, { route: "review", task: "t1" });
    assert.equal((await b.settle(r1, 30)).used, 30, "off-gate settlement = reported count while 10 attempts exist");
    assert.equal((await b.settle(g, 3)).used, 10, "a gate-covered settlement is raised to its attempt floor");
    s = b.status();
    assert.deepEqual({ charged: s.charged, gated: s.gatedCharged, offGate: s.offGateCharged, attempts: s.attempts, remaining: s.remaining }, { charged: 90, gated: 10, offGate: 80, attempts: 10, remaining: 210 });
    assert.equal(slack(s), false);
    assert.equal(await b.admitAttempt(), null, "no gate-covered reservation open: closed reservations never fund new traffic");
    // One limit across roles: 90 charged, 210 left for every role together.
    assert.equal(await b.reserve(211, { route: "screening" }), null);
    assert.match(b.refusal, /request ceiling 300: charged 90/);
    assert.equal(await b.reserve(211, proposal("p-2")), null, "a proposal is refused by the same ceiling");
    const big = await b.reserve(200, { route: "screening" });
    assert.ok(big);
    assert.equal(await b.reserve(11, { route: "review" }), null, "the open worst case of an evaluation counts for proposals and reviews too");
    assert.ok(await b.reserve(10, proposal("p-3")));
    assert.equal(b.status().remaining, 0);
    // A settlement that cannot happen (twice / unknown) throws and the reservation stays charged in full.
    await assert.rejects(b.settle(p1, 1), /already settled/);
    await assert.rejects(b.settle({ id: "r-unknown" }, 1), /unknown reservation/);
    assert.equal(b.status().charged, 300);
    // Restart: a new process view reads the same totals.
    const again = new RequestBudget({ path: join(root, "total.jsonl"), limit: 300, scope: "terra total" }).status();
    assert.deepEqual({ charged: again.charged, gated: again.gatedCharged, attempts: again.attempts }, { charged: 300, gated: 210, attempts: 10 });
    assert.equal(offGate({ meta: { route: "proposal" } }) && !offGate({ meta: { route: "screening" } }) && !offGate({ meta: {} }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared total: abandoned (dead-owner) proposal keeps its worst case while a dead evaluation reservation settles at its attempt floor; concurrent roles never exceed the limit", async () => {
  const root = tempDir();
  try {
    const path = join(root, "total.jsonl");
    const b = new RequestBudget({ path, limit: 400, scope: "s" });
    // Two reservations owned by a process that then exits (killed cycle / killed proposer).
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const { RequestBudget } = await import(${JSON.stringify(BUDGET_MODULE)}); const b = new RequestBudget({ path: ${JSON.stringify(path)}, limit: 400, scope: "s" }); await b.reserve(120, { route: "proposal", proposal: "p-dead" }); await b.reserve(40, { route: "screening", unit: "dead" }); for (let i = 0; i < 3; i++) await b.admitAttempt();`], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const out = await b.reconcileDead({ by: "test" });
    assert.deepEqual(out.map(x => x.used).sort((x, y) => x - y), [3, 120], "evaluation: attempt floor 3; proposal: full worst case");
    const s = b.status();
    assert.deepEqual({ charged: s.charged, open: s.openReservations, attempts: s.attempts }, { charged: 123, open: 0, attempts: 3 });
    // Concurrency at the boundary: 277 left; proposals (120) and evaluations (100) from separate processes race for it.
    const views = Array.from({ length: 6 }, (_, i) => new RequestBudget({ path, limit: 400, scope: "s" }).reserve(i % 2 ? 120 : 100, i % 2 ? { route: "proposal" } : { route: "screening" }));
    const got = (await Promise.all(views)).filter(Boolean);
    const after = b.status();
    assert.ok(after.charged <= 400, `charged ${after.charged} within the one limit`);
    assert.equal(after.charged, 123 + got.reduce((n, t) => n + t.amount, 0));
    assert.ok(400 - after.charged < 100, "no further reservation of either size fits");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared total: a legacy mixed ledger whose attempts were funded by off-gate charges fails closed; gated admission over a mixed ledger keeps exact counts", async () => {
  const root = tempDir();
  try {
    // budgetTotals: attempts covered only by a proposal charge are a ledger problem (an attempt without a gate-covered reservation).
    const recs = [{ type: "init", limit: 100 }, { type: "reserve", id: "a", amount: 20, meta: { route: "proposal" } }, { type: "settle", id: "a", used: 20 }, { type: "attempt" }];
    assert.match(budgetTotals(recs).problems.join(" "), /exceed the charged total 0 of gate-covered reservations \(off-gate charges 20 never cover attempts\)/);
    // attemptAdmission (gated runtime) next to settled proposals: charged = proposals + actual attempts, no slack.
    const b = new RequestBudget({ path: join(root, "b.jsonl"), limit: 1000, scope: "s" });
    const p = await b.reserve(120, proposal("p")); await b.settle(p, 11);
    const a = attemptAdmission(b, () => ({ perRequest: 2, gated: true }));
    const t = await a.reserve(150, { unit: "u", route: "screening" });
    for (let i = 0; i < 7; i++) assert.ok(await b.admitAttempt());
    await a.settle(t, 5, {});
    const s = b.status();
    assert.deepEqual({ charged: s.charged, gated: s.gatedCharged, attempts: s.attempts }, { charged: 18, gated: 7, attempts: 7 });
    assert.equal(slack(s), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outbound gate over a mixed ledger: only gate-covered open reservations admit CONNECTs; a proposal reservation admits nothing; exhaustion answers 403", async () => {
  const root = tempDir();
  const upstream = net.createServer(s => s.end());
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  const b = new RequestBudget({ path: join(root, "b.jsonl"), limit: 50, scope: "s" });
  const gate = await startOutboundGate({ budget: b, allow: ["chatgpt.com:443"], listen: { port: 0, host: "127.0.0.1" }, route: () => ({ host: "127.0.0.1", port: upstream.address().port }) });
  const connect = () => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: gate.address.port, method: "CONNECT", path: "chatgpt.com:443" });
    req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on("error", () => resolve(-1));
    req.end();
  });
  try {
    const p = await b.reserve(20, proposal("p"));
    assert.equal(await connect(), 403, "an open proposal reservation is not outbound allowance");
    await b.settle(p, 20);
    const g = await b.reserve(2, { route: "confirmation", unit: "u" });
    assert.deepEqual([await connect(), await connect(), await connect()], [200, 200, 403]);
    await b.settle(g, 2);
    assert.equal(await connect(), 403, "settled, nothing open: refused");
    assert.deepEqual(gate.stats, { admitted: 2, refused: 3, failed: 0 });
    const s = b.status();
    assert.deepEqual({ charged: s.charged, attempts: s.attempts, gated: s.gatedCharged }, { charged: 22, attempts: 2, gated: 2 });
  } finally { await gate.close(); upstream.close(); rmSync(root, { recursive: true, force: true }); }
});

test("peer-pressure meter counts the selected non-default target model only", () => {
  const root = tempDir();
  try {
    const db = join(root, "usage.db");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const h = new DatabaseSync(db);
    h.exec("CREATE TABLE usage_events (model TEXT, timestamp_ms INTEGER, failed INTEGER, failure_status INTEGER)");
    const now = Date.now(), ins = h.prepare("INSERT INTO usage_events VALUES (?, ?, ?, ?)");
    for (const [m, f, st] of [["gpt-6.1-terra", 1, 429], ["gpt-6.1-terra", 1, 500], ["gpt-6.1-terra", 0, null], ["gpt-6-luna", 1, 429], ["gpt-6-luna", 1, 503]]) ins.run(m, now, f, st);
    h.close();
    assert.equal(gatewayPressureMeter({ db, model: "gpt-6.1-terra" }).read(now - 1000), 1);
    assert.equal(gatewayPressureMeter({ db, model: "gpt-6-luna" }).read(now - 1000), 2);
    assert.match(gatewayPressureMeter({ db, model: "gpt-6.1-terra" }).name, /gpt-6.1-terra/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review sessions charge the same ledger (route review): worst case reserved first, forwarded count settled, a failing session keeps its worst case, a refusal runs nothing", async () => {
  const { chargedReview } = await import("../studies/confirmatory-1/review.mjs");
  const root = tempDir();
  try {
    const b = new RequestBudget({ path: join(root, "b.jsonl"), limit: 200, scope: "s" });
    let ran = 0;
    const rec = await chargedReview({ budget: b, maxRequests: 80, meta: { task: "t1" } }, async () => { ran++; assert.equal(b.status().openAmount, 80, "reserved before the session"); return { run: { forwarded: 12 } }; });
    assert.equal(rec.run.forwarded, 12);
    await assert.rejects(chargedReview({ budget: b, maxRequests: 80, meta: { task: "t2" } }, async () => { ran++; throw new Error("sandbox died"); }), /sandbox died/);
    let s = b.status();
    assert.deepEqual({ charged: s.charged, offGate: s.offGateCharged, open: s.openReservations }, { charged: 92, offGate: 92, open: 0 });
    await assert.rejects(chargedReview({ budget: b, maxRequests: 109, meta: {} }, async () => { ran++; return {}; }), /review budget refused/);
    assert.equal(ran, 2, "a refused reservation runs nothing");
    assert.ok(b.verified().filter(r => r.type === "reserve").every(r => r.meta.route === "review"));
    assert.equal(await chargedReview({ budget: null, maxRequests: 80 }, async () => "uncharged"), "uncharged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
