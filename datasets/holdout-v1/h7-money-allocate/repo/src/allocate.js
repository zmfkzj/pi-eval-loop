export function allocate(totalCents, ratios) {
  const sum = ratios.reduce((a, b) => a + b, 0);
  return ratios.map(r => Math.round(totalCents * r / sum));
}
