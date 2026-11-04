import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

const failing = (times, value = "ok") => { let n = 0; return async (attempt) => { n++; if (n <= times) throw new Error(`fail ${attempt}`); return value; }; };

test("delays follow capped exponential backoff", async () => {
  const sleeps = [];
  assert.equal(await retry(failing(4), { retries: 5, baseMs: 100, factor: 3, maxMs: 1000, sleep: async ms => { sleeps.push(ms); } }), "ok");
  assert.deepEqual(sleeps, [100, 300, 900, 1000]);
});
test("at most retries + 1 calls; the original error is rethrown", async () => {
  const sleeps = []; let calls = 0;
  const boom = new Error("boom");
  await assert.rejects(retry(async () => { calls++; throw boom; }, { retries: 2, baseMs: 10, sleep: async ms => { sleeps.push(ms); } }), error => error === boom);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});
test("retries: 0 means a single call", async () => {
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error("x"); }, { retries: 0, sleep: async () => { throw new Error("must not sleep"); } }));
  assert.equal(calls, 1);
});
test("shouldRetry false stops immediately with the same error", async () => {
  const sleeps = []; const seen = [];
  const fatal = new TypeError("fatal");
  await assert.rejects(retry(async (attempt) => { if (attempt === 1) throw new Error("transient"); throw fatal; }, { retries: 5, baseMs: 1, sleep: async ms => { sleeps.push(ms); }, shouldRetry: (error, attempt) => { seen.push(attempt); return error.message === "transient"; } }), error => error === fatal);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(sleeps, [1]);
});
test("attempt numbers start at 1", async () => {
  const attempts = [];
  await retry(async (attempt) => { attempts.push(attempt); if (attempt < 3) throw new Error("again"); return attempt; }, { sleep: async () => {} });
  assert.deepEqual(attempts, [1, 2, 3]);
});
