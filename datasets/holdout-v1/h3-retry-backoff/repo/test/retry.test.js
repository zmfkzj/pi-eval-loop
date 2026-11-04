import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

test("resolves with the value of a successful first call", async () => {
  const sleeps = [];
  assert.equal(await retry(async () => 42, { sleep: async ms => { sleeps.push(ms); } }), 42);
  assert.deepEqual(sleeps, []);
});
