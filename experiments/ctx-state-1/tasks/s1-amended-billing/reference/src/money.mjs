const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
export function roundDiv(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) throw fail("MONEY_INPUT", "safe integers, denominator > 0");
  return Number(roundDivBig(BigInt(numerator), BigInt(denominator)));
}
export function roundDivBig(n, d) {
  const neg = n < 0n; const a = neg ? -n : n;
  let q = a / d; const r = a % d;
  if (r * 2n > d || (r * 2n === d && q % 2n === 1n)) q += 1n;
  return neg ? -q : q;
}
export { fail };
