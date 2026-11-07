import { fail } from "../money.mjs";
const pos = v => Number.isSafeInteger(v) && v > 0;
export function postEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) throw fail("LEDGER_INPUT", "entries");
  for (const e of entries) {
    if (!e || typeof e.account !== "string" || !e.account) throw fail("LEDGER_INPUT", "account");
    const d = e.debitCents !== undefined, c = e.creditCents !== undefined;
    if (d === c || (d && !pos(e.debitCents)) || (c && !pos(e.creditCents))) throw fail("LEDGER_INPUT", "side");
  }
  let debit = 0n, credit = 0n; const bal = new Map();
  for (const e of entries) { const v = BigInt(e.debitCents ?? 0) - BigInt(e.creditCents ?? 0); debit += BigInt(e.debitCents ?? 0); credit += BigInt(e.creditCents ?? 0); bal.set(e.account, (bal.get(e.account) ?? 0n) + v); }
  if (debit !== credit) throw fail("LEDGER_UNBALANCED", "debits differ from credits");
  const out = {};
  for (const k of [...bal.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = Number(bal.get(k));
  return out;
}
