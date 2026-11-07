import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { roundDiv } from "../src/money.mjs";
import { invoiceTotal } from "../src/invoice/index.mjs";
import { splitAmount } from "../src/split/index.mjs";
import { convert } from "../src/fx/index.mjs";
import { postEntries } from "../src/ledger/index.mjs";
import * as meta from "../src/meta.mjs";

const code = (fn, expected) => assert.throws(fn, e => e instanceof Error && e.code === expected && String(e.message).startsWith(expected));

test("roundDiv: amended tie rule half to even", () => {
  assert.equal(roundDiv(5, 2), 2); assert.equal(roundDiv(7, 2), 4); assert.equal(roundDiv(-5, 2), -2); assert.equal(roundDiv(-7, 2), -4);
  assert.equal(roundDiv(1, 2), 0); assert.equal(roundDiv(3, 2), 2); assert.ok(Object.is(roundDiv(-1, 2) + 0, 0));
});
test("roundDiv: non-ties round to nearest", () => {
  assert.equal(roundDiv(7, 3), 2); assert.equal(roundDiv(8, 3), 3); assert.equal(roundDiv(-8, 3), -3); assert.equal(roundDiv(10, 5), 2); assert.equal(roundDiv(0, 7), 0);
});
test("roundDiv: exact for large safe integers", () => {
  assert.equal(roundDiv(Number.MAX_SAFE_INTEGER, 2), 4503599627370496);
  assert.equal(roundDiv(Number.MAX_SAFE_INTEGER - 2, 2), 4503599627370494);
  assert.equal(roundDiv(9007199254740990, 9007199254740991), 1);
});
test("roundDiv: invalid input", () => {
  for (const args of [[1, 0], [1, -2], [1.5, 2], [1, 2.5], ["1", 2], [2 ** 53, 3]]) code(() => roundDiv(...args), "MONEY_INPUT");
});
test("invoice: totals with half-even tax and discount ties", () => {
  assert.deepEqual(invoiceTotal([{ qty: 1, unitCents: 25 }], { taxBp: 1000 }), { subtotal: 25, discount: 0, tax: 2, total: 27 });
  assert.deepEqual(invoiceTotal([{ qty: 1, unitCents: 35 }], { taxBp: 1000 }), { subtotal: 35, discount: 0, tax: 4, total: 39 });
  assert.deepEqual(invoiceTotal([{ qty: 1, unitCents: 50, discountBp: 500 }, { qty: 3, unitCents: 70, discountBp: 500 }], { taxBp: 0 }), { subtotal: 260, discount: 2 + 10, tax: 0, total: 248 });
  assert.deepEqual(invoiceTotal([{ qty: 2, unitCents: 1999, discountBp: 1250 }, { qty: 1, unitCents: 0 }], { taxBp: 825 }), { subtotal: 3998, discount: 500, tax: 289, total: 3787 });
});
test("invoice: exact keys and large values", () => {
  const r = invoiceTotal([{ qty: 1000000, unitCents: 1000000000 }], { taxBp: 10000 });
  assert.deepEqual(Object.keys(r).sort(), ["discount", "subtotal", "tax", "total"]);
  assert.deepEqual(r, { subtotal: 1e15, discount: 0, tax: 1e15, total: 2e15 });
});
test("invoice: validation", () => {
  const bad = [[[], { taxBp: 0 }], [[{ qty: 0, unitCents: 1 }], { taxBp: 0 }], [[{ qty: 1, unitCents: -1 }], { taxBp: 0 }], [[{ qty: 1, unitCents: 1, discountBp: 10001 }], { taxBp: 0 }], [[{ qty: 1, unitCents: 1 }], { taxBp: 100001 }], [[{ qty: 1, unitCents: 1 }], {}], [[{ qty: 1.5, unitCents: 1 }], { taxBp: 0 }], ["x", { taxBp: 0 }]];
  for (const [lines, opts] of bad) code(() => invoiceTotal(lines, opts), "INVOICE_INPUT");
});
test("split: largest remainder, ties to lower index, exact sum (not roundDiv)", () => {
  assert.deepEqual(splitAmount(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(splitAmount(5, [1, 1]), [3, 2]);
  assert.deepEqual(splitAmount(10, [1, 0, 3]), [3, 0, 7]);
  assert.deepEqual(splitAmount(7, [2, 2, 2, 2]), [2, 2, 2, 1]);
  assert.deepEqual(splitAmount(0, [3, 4]), [0, 0]);
  assert.deepEqual(splitAmount(1, [1, 3]), [0, 1]);
  const big = splitAmount(Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER, 1, 1]);
  assert.equal(big.reduce((s, x) => s + BigInt(x), 0n), BigInt(Number.MAX_SAFE_INTEGER));
});
test("split: validation", () => {
  for (const [t, w] of [[-1, [1]], [1.5, [1]], [1, []], [1, [0, 0]], [1, [-1, 2]], [1, [1.5]], [1, "ab"]]) code(() => splitAmount(t, w), "SPLIT_INPUT");
});
test("fx: half-even ties, negatives, exactness", () => {
  assert.equal(convert(5, 500000), 2); assert.equal(convert(7, 500000), 4); assert.equal(convert(-5, 500000), -2); assert.equal(convert(-7, 500000), -4);
  assert.equal(convert(12345, 1085000), 13394); assert.equal(convert(100, 1000000), 100);
  assert.equal(convert(Number.MAX_SAFE_INTEGER, 1000000), Number.MAX_SAFE_INTEGER);
  assert.equal(convert(Number.MAX_SAFE_INTEGER, 500000), 4503599627370496);
});
test("fx: validation and range", () => {
  for (const [c, r] of [[1.5, 1], [1, 0], [1, -1], [1, 1.5], ["1", 1]]) code(() => convert(c, r), "FX_INPUT");
  code(() => convert(Number.MAX_SAFE_INTEGER, 2000000), "FX_RANGE");
  code(() => convert(-Number.MAX_SAFE_INTEGER, 2000000), "FX_RANGE");
});
test("ledger: balances sorted by code unit, zero accounts kept", () => {
  const out = postEntries([{ account: "cash", debitCents: 500 }, { account: "Revenue", creditCents: 300 }, { account: "tax", creditCents: 200 }, { account: "cash", creditCents: 100 }, { account: "suspense", debitCents: 100 }, { account: "suspense", creditCents: 100 }, { account: "Revenue", debitCents: 100 }]);
  assert.deepEqual(Object.keys(out), ["Revenue", "cash", "suspense", "tax"]);
  assert.deepEqual(out, { Revenue: -200, cash: 400, suspense: 0, tax: -200 });
});
test("ledger: unbalanced and invalid", () => {
  code(() => postEntries([{ account: "a", debitCents: 2 }, { account: "b", creditCents: 1 }]), "LEDGER_UNBALANCED");
  for (const e of [[], [{ account: "", debitCents: 1 }], [{ account: "a" }], [{ account: "a", debitCents: 1, creditCents: 1 }], [{ account: "a", debitCents: 0 }], [{ account: "a", creditCents: 1.5 }], [{ account: 3, debitCents: 1 }]]) code(() => postEntries(e), "LEDGER_INPUT");
  code(() => postEntries([{ account: "a", debitCents: 1 }, { account: "b" }]), "LEDGER_INPUT");
});
test("batch id: the single issued id, exported verbatim; issued exactly once", () => {
  const lines = readFileSync(".batch/issued", "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "issue-batch must have run exactly once");
  assert.equal(typeof meta.BATCH_ID, "string");
  assert.match(meta.BATCH_ID, /^B-[0-9a-f]{12}$/);
  assert.equal(createHash("sha256").update(meta.BATCH_ID).digest("hex"), lines[0]);
});
