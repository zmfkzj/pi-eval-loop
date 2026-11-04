import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.js";

test("remainders go to the largest fractions, ties to the earlier index", () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(5, [3, 7]), [2, 3]);
  assert.deepEqual(allocate(10, [3, 7]), [3, 7]);
  assert.deepEqual(allocate(1, [1, 1]), [1, 0]);
  assert.deepEqual(allocate(10, [1, 1, 1, 1, 1, 1, 1]), [2, 2, 2, 1, 1, 1, 1]);
});
test("parts always add up", () => {
  for (const [total, ratios] of [[999, [0.3, 0.3, 0.4]], [12345, [1, 2, 3, 4, 5]], [7, [0.1, 0.2]]]) {
    assert.equal(allocate(total, ratios).reduce((a, b) => a + b, 0), total);
  }
});
test("negative totals and zero ratios", () => {
  assert.deepEqual(allocate(-100, [1, 1, 1]), [-34, -33, -33]);
  assert.deepEqual(allocate(10, [0, 1, 0]), [0, 10, 0]);
});
test("invalid input throws RangeError", () => {
  assert.throws(() => allocate(10.5, [1]), RangeError);
  assert.throws(() => allocate(10, []), RangeError);
  assert.throws(() => allocate(10, [0, 0]), RangeError);
  assert.throws(() => allocate(10, [1, -1]), RangeError);
  assert.throws(() => allocate(10, [1, Infinity]), RangeError);
});
