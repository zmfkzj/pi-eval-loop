import { fail, roundDivBig } from "../money.mjs";
export function convert(cents, rateMicros) {
  if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(rateMicros) || rateMicros <= 0) throw fail("FX_INPUT", "invalid conversion");
  const out = roundDivBig(BigInt(cents) * BigInt(rateMicros), 1000000n);
  if (out > BigInt(Number.MAX_SAFE_INTEGER) || out < BigInt(Number.MIN_SAFE_INTEGER)) throw fail("FX_RANGE", "result out of range");
  return Number(out);
}
