import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals } from "../src/intervals.js";

test("disjoint sorted intervals stay as they are", () => {
  assert.deepEqual(mergeIntervals([[1, 2], [4, 6], [8, 9]]), [[1, 2], [4, 6], [8, 9]]);
});
