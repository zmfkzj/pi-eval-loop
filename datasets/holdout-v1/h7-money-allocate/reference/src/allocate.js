export function allocate(totalCents, ratios) {
  if (!Number.isInteger(totalCents)) throw new RangeError("total must be an integer number of cents");
  if (!ratios.length || ratios.some(r => !Number.isFinite(r) || r < 0)) throw new RangeError("ratios must be finite and non-negative");
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (sum === 0) throw new RangeError("ratios must not all be zero");
  const sign = totalCents < 0 ? -1 : 1, total = Math.abs(totalCents);
  const exact = ratios.map(r => total * r / sum);
  const parts = exact.map(Math.floor);
  let missing = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; missing > 0; k++, missing--) parts[order[k % order.length][1]]++;
  return parts.map(p => (p === 0 ? 0 : sign * p));
}
