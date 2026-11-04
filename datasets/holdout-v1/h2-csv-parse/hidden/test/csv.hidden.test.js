import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.js";

test("quoted fields with commas and doubled quotes", () => {
  assert.deepEqual(parseCsv('name,quote\n"Doe, Jane","She said ""hi"""\n'), [["name", "quote"], ["Doe, Jane", 'She said "hi"']]);
});
test("line breaks inside quotes and CRLF rows", () => {
  assert.deepEqual(parseCsv('a,b\r\n"line1\nline2",x\r\n"c\r\nd",y'), [["a", "b"], ["line1\nline2", "x"], ["c\r\nd", "y"]]);
});
test("empty fields and empty rows are kept, final break adds no row", () => {
  assert.deepEqual(parseCsv("a,,b\n\n,\n"), [["a", "", "b"], [""], ["", ""]]);
  assert.deepEqual(parseCsv('""\n'), [[""]]);
  assert.deepEqual(parseCsv("x"), [["x"]]);
});
test("malformed quoting throws SyntaxError", () => {
  assert.throws(() => parseCsv('"open'), SyntaxError);
  assert.throws(() => parseCsv('a"b,c'), SyntaxError);
  assert.throws(() => parseCsv('"a"b,c'), SyntaxError);
});
