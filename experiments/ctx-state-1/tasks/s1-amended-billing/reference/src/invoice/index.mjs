import { fail, roundDivBig } from "../money.mjs";
const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
export function invoiceTotal(lines, options) {
  const taxBp = options?.taxBp;
  if (!Array.isArray(lines) || !lines.length || !isInt(taxBp, 0, 100000)) throw fail("INVOICE_INPUT", "invalid invoice");
  for (const l of lines) if (!l || !isInt(l.qty, 1, Number.MAX_SAFE_INTEGER) || !isInt(l.unitCents, 0, Number.MAX_SAFE_INTEGER) || !isInt(l.discountBp ?? 0, 0, 10000)) throw fail("INVOICE_INPUT", "invalid line");
  let subtotal = 0n, discount = 0n;
  for (const l of lines) { const gross = BigInt(l.qty) * BigInt(l.unitCents); subtotal += gross; discount += roundDivBig(gross * BigInt(l.discountBp ?? 0), 10000n); }
  const tax = roundDivBig((subtotal - discount) * BigInt(taxBp), 10000n);
  return { subtotal: Number(subtotal), discount: Number(discount), tax: Number(tax), total: Number(subtotal - discount + tax) };
}
