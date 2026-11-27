import { describe, expect, it } from 'vitest';
import { Rng, cyrb128, sfc32 } from '../../src/core/rng';

const SEED = 'sigdrift-golden';

function draw(rng: Rng, count: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(rng.next());
  return values;
}

// The golden values below come from the published reference versions of cyrb128 and sfc32, run separately.
describe('cyrb128', () => {
  it('matches the pinned hashes', () => {
    expect(cyrb128(SEED)).toEqual([1406482252, 2546604884, 4061899694, 3012825937]);
    expect(cyrb128('')).toEqual([41608494, 3485963809, 1435736333, 1262568316]);
  });

  it('returns unsigned 32-bit integers', () => {
    for (const part of cyrb128('2026-W48')) {
      expect(Number.isInteger(part)).toBe(true);
      expect(part).toBeGreaterThanOrEqual(0);
      expect(part).toBeLessThan(4294967296);
    }
  });

  it('changes when one character changes', () => {
    expect(cyrb128('2026-W48')).not.toEqual(cyrb128('2026-W49'));
  });
});

describe('sfc32', () => {
  it('matches the pinned sequence', () => {
    const generate = sfc32(1, 2, 3, 4);
    expect([generate(), generate(), generate()]).toEqual([
      1.6298145055770874e-9, 7.916241884231567e-9, 0.01318361610174179,
    ]);
  });

  it('treats seeds as 32-bit integers', () => {
    const a = sfc32(4294967295, 2147483648, 7, 9);
    const b = sfc32(-1, -2147483648, 7, 9);
    for (let i = 0; i < 20; i++) expect(a()).toBe(b());
  });
});

describe('Rng', () => {
  it('produces the pinned sequence for a fixed seed', () => {
    expect(draw(new Rng(SEED), 6)).toEqual([
      0.8632249354850501, 0.27092371322214603, 0.8615448519121855, 0.4322351817972958, 0.6776986666955054,
      0.1864402845967561,
    ]);
  });

  it('is sfc32 seeded by cyrb128 with 15 outputs discarded', () => {
    const [a, b, c, d] = cyrb128(SEED);
    const generate = sfc32(a, b, c, d);
    for (let i = 0; i < 15; i++) generate();
    const rng = new Rng(SEED);
    for (let i = 0; i < 50; i++) expect(rng.next()).toBe(generate());
  });

  it('repeats exactly for the same seed and differs for another', () => {
    expect(draw(new Rng('a'), 100)).toEqual(draw(new Rng('a'), 100));
    expect(draw(new Rng('a'), 8)).not.toEqual(draw(new Rng('b'), 8));
  });

  it('next stays in [0, 1)', () => {
    const rng = new Rng('bounds');
    for (let i = 0; i < 20000; i++) {
      const value = rng.next();
      expect(value >= 0 && value < 1).toBe(true);
    }
  });

  it('int stays in [0, max) and reaches every value', () => {
    const rng = new Rng('int');
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const value = rng.int(7);
      expect(Number.isInteger(value) && value >= 0 && value < 7).toBe(true);
      seen.add(value);
    }
    expect(seen.size).toBe(7);
    expect(rng.int(1)).toBe(0);
    expect(rng.int(0)).toBe(0);
  });

  it('range stays in [min, max)', () => {
    const rng = new Rng('range');
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < 20000; i++) {
      const value = rng.range(-3, 5);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    expect(low).toBeGreaterThanOrEqual(-3);
    expect(high).toBeLessThan(5);
    expect(low).toBeLessThan(-2.9);
    expect(high).toBeGreaterThan(4.9);
  });

  it('is roughly uniform', () => {
    const rng = new Rng('uniform');
    const samples = 100000;
    const buckets = new Array<number>(10).fill(0);
    let sum = 0;
    for (let i = 0; i < samples; i++) {
      const value = rng.next();
      sum += value;
      buckets[Math.floor(value * 10)]++;
    }
    expect(Math.abs(sum / samples - 0.5)).toBeLessThan(0.01);
    // Each bucket expects 10000 with a standard deviation of ~95; 5% is more than five sigma.
    for (const count of buckets) expect(Math.abs(count - samples / 10)).toBeLessThan(500);
  });

  it('chance follows its probability', () => {
    const rng = new Rng('chance');
    let hits = 0;
    for (let i = 0; i < 20000; i++) if (rng.chance(0.3)) hits++;
    expect(Math.abs(hits / 20000 - 0.3)).toBeLessThan(0.02);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
  });

  it('pick returns members and rejects an empty list', () => {
    const rng = new Rng('pick');
    const items = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(rng.pick(items));
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
    expect(() => rng.pick([])).toThrow();
  });

  it('shuffle permutes in place and is deterministic', () => {
    const original = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const items = original.slice();
    const returned = new Rng('shuffle').shuffle(items);
    expect(returned).toBe(items);
    expect(items.slice().sort((a, b) => a - b)).toEqual(original);
    expect(items).not.toEqual(original);
    expect(new Rng('shuffle').shuffle(original.slice())).toEqual(items);
  });

  it('shuffle puts every item in every position sometimes', () => {
    const rng = new Rng('shuffle-spread');
    const firstCounts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) firstCounts[rng.shuffle([0, 1, 2, 3])[0]]++;
    for (const count of firstCounts) expect(Math.abs(count - 1000)).toBeLessThan(150);
  });
});

describe('Rng.fork', () => {
  it('matches the pinned child sequence', () => {
    expect(draw(new Rng(SEED).fork('props'), 3)).toEqual([
      0.6423037082422525, 0.2016763538122177, 0.7158499092329293,
    ]);
  });

  it('equals a fresh Rng seeded with seed|label', () => {
    expect(draw(new Rng('week').fork('track'), 20)).toEqual(draw(new Rng('week|track'), 20));
  });

  it('does not depend on how many numbers the parent has drawn', () => {
    const fresh = new Rng('week');
    const used = new Rng('week');
    draw(used, 137);
    expect(draw(used.fork('decor'), 20)).toEqual(draw(fresh.fork('decor'), 20));
  });

  it('does not advance the parent', () => {
    const plain = new Rng('week');
    const forking = new Rng('week');
    forking.fork('x');
    forking.fork('y');
    expect(draw(forking, 10)).toEqual(draw(plain, 10));
  });

  it('gives different streams for different labels, and nests', () => {
    const parent = new Rng('week');
    expect(draw(parent.fork('a'), 8)).not.toEqual(draw(parent.fork('b'), 8));
    expect(draw(parent.fork('a'), 8)).not.toEqual(draw(parent, 8));
    expect(draw(parent.fork('a').fork('b'), 8)).toEqual(draw(new Rng('week|a|b'), 8));
  });
});
