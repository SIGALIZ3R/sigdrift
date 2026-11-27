/**
 * Seeded random numbers for the generator. Integer operations only, so a seed gives the same sequence everywhere.
 */

/** Hashes a string into four 32-bit unsigned seeds. */
export function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** Small fast counter PRNG with a 128-bit state. Returns a generator of uniform numbers in [0, 1). */
export function sfc32(a: number, b: number, c: number, d: number): () => number {
  a |= 0;
  b |= 0;
  c |= 0;
  d |= 0;
  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** sfc32 mixes a fresh seed slowly; the first outputs are thrown away. */
const WARMUP_DRAWS = 15;

export class Rng {
  readonly seed: string;
  private readonly generate: () => number;

  constructor(seed: string) {
    this.seed = seed;
    const [a, b, c, d] = cyrb128(seed);
    this.generate = sfc32(a, b, c, d);
    for (let i = 0; i < WARMUP_DRAWS; i++) this.generate();
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.generate();
  }

  /** Uniform integer in [0, maxExclusive). Returns 0 when maxExclusive is below 1. */
  int(maxExclusive: number): number {
    const value = this.generate();
    return maxExclusive >= 1 ? Math.floor(value * maxExclusive) : 0;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.generate() * (max - min);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.generate() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list');
    return items[this.int(items.length)];
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const swapped = items[i];
      items[i] = items[j];
      items[j] = swapped;
    }
    return items;
  }

  /**
   * An independent stream named by `label`. It depends only on this generator's seed string and the label,
   * never on how many numbers were already drawn, so adding a draw in one place cannot shift another stream.
   */
  fork(label: string): Rng {
    return new Rng(this.seed + '|' + label);
  }
}
