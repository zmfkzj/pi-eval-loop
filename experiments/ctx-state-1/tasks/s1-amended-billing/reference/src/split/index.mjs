import { fail } from "../money.mjs";
export function splitAmount(totalCents, weights) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || !Array.isArray(weights) || !weights.length || !weights.every(w => Number.isSafeInteger(w) && w >= 0)) throw fail("SPLIT_INPUT", "invalid split");
  const sum = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (sum === 0n) throw fail("SPLIT_INPUT", "weights sum to zero");
  const t = BigInt(totalCents);
  const parts = weights.map((w, i) => ({ i, q: (t * BigInt(w)) / sum, r: (t * BigInt(w)) % sum }));
  let left = t - parts.reduce((s, p) => s + p.q, 0n);
  for (const p of [...parts].sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))) { if (left === 0n) break; p.q += 1n; left -= 1n; }
  return parts.map(p => Number(p.q));
}
