import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.js";

test("simple rows", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,2,3\n"), [["a", "b", "c"], ["1", "2", "3"]]);
  assert.deepEqual(parseCsv(""), []);
});
