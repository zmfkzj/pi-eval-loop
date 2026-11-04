// Seeded, reproducible randomness (xoshiro128**, seeded from sha256 of a string) and Dirichlet(1,...,1) draws.
import { createHash } from "node:crypto";

export function createRng(seed) {
  const bytes = createHash("sha256").update(String(seed)).digest();
  let a = bytes.readUInt32LE(0), b = bytes.readUInt32LE(4), c = bytes.readUInt32LE(8), d = bytes.readUInt32LE(12);
  if ((a | b | c | d) === 0) a = 1;
  const next = () => {
    const result = Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11);
    return result / 4294967296;
  };
  const rng = {
    next,
    /** Standard exponential (Gamma(1)); 1 - U avoids log(0). */
    exp: () => -Math.log(1 - next()),
    /** Dirichlet(1_n) weights (Rubin's Bayesian bootstrap). */
    dirichlet(n) {
      const w = new Array(n); let sum = 0;
      for (let i = 0; i < n; i++) { w[i] = rng.exp(); sum += w[i]; }
      for (let i = 0; i < n; i++) w[i] /= sum;
      return w;
    },
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)],
    shuffle(items) { const out = [...items]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; },
  };
  return rng;
}
const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
