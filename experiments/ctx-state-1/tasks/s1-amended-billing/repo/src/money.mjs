// Shared integer-cents helpers.

/** Integer nearest to numerator/denominator (both safe integers, denominator > 0). TODO: ties. */
export function roundDiv(numerator, denominator) {
  return Math.trunc(numerator / denominator);
}
