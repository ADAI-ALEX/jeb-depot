/**
 * Deterministic PRNG: sfc32 seeded through splitmix32. Every random choice in the simulation and in the
 * sampling policy draws from one of these, seeded from (level, seed), so runs reproduce exactly.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) >>> 0;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  int(lo: number, hiInclusive: number): number {
    return lo + Math.floor(this.next() * (hiInclusive - lo + 1));
  }

  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error("pick from empty list");
    return xs[Math.floor(this.next() * xs.length)] as T;
  }

  /** Index drawn from unnormalised weights. */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
    if (total <= 0) return 0;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i] ?? 0);
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
    }
    return xs;
  }
}

/** Stable 32-bit hash for deriving sub-seeds ("level-2/seed-7/traffic"). */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261 >>> 0;
  for (const ch of parts.join("/")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
