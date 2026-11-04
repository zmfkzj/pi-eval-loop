import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals } from "../src/intervals.js";

test("touching intervals merge", () => {
  assert.deepEqual(mergeIntervals([[1, 3], [3, 5]]), [[1, 5]]);
  assert.deepEqual(mergeIntervals([[0, 0], [0, 2], [5, 5]]), [[0, 2], [5, 5]]);
});
test("unsorted input is sorted and merged", () => {
  assert.deepEqual(mergeIntervals([[8, 10], [1, 4], [2, 6], [15, 18], [9, 12]]), [[1, 6], [8, 12], [15, 18]]);
  assert.deepEqual(mergeIntervals([]), []);
});
test("input is not mutated", () => {
  const input = [[5, 7], [1, 3], [2, 6]];
  const copy = JSON.parse(JSON.stringify(input));
  const out = mergeIntervals(input);
  assert.deepEqual(input, copy);
  assert.notEqual(out, input);
  out[0][1] = 99;
  assert.deepEqual(input, copy);
});
test("contained intervals and negatives", () => {
  assert.deepEqual(mergeIntervals([[-5, 10], [-3, -1], [0, 2]]), [[-5, 10]]);
});
test("invalid intervals throw RangeError", () => {
  assert.throws(() => mergeIntervals([[3, 1]]), RangeError);
  assert.throws(() => mergeIntervals([[1, Infinity]]), RangeError);
  assert.throws(() => mergeIntervals([[NaN, 2]]), RangeError);
});
