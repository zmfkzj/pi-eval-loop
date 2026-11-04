import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.js";

test("even splits", () => {
  assert.deepEqual(allocate(100, [1, 1]), [50, 50]);
  assert.deepEqual(allocate(300, [1, 2]), [100, 200]);
});
