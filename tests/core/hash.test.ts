import { describe, expect, it } from 'vitest';
import { hashNumbers, hashString } from '../../src/core/hash';

// Pinned so that an accidental change to the hash (which would orphan stored replay hashes) fails a test.
const PINNED_EMPTY = 'ab3e7c0bebb6c228';
const PINNED_123 = '675154f69f907947';
const PINNED_WEEK = 'bd2f8407';

/** The next representable double above a positive finite value. */
function nextUp(value: number): number {
  const bits = new BigUint64Array(1);
  const float = new Float64Array(bits.buffer);
  float[0] = value;
  bits[0] += 1n;
  return float[0];
}

describe('hashNumbers', () => {
  it('returns 16 lowercase hex chars', () => {
    for (const values of [[], [0], [1, 2, 3], [Math.PI, -1e300, 5e-324]]) {
      expect(hashNumbers(values)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('is stable for the same input', () => {
    const values = [12.5, -3.25, 0.1 + 0.2, 1e-9];
    expect(hashNumbers(values)).toBe(hashNumbers(values.slice()));
  });

  it('keeps its pinned values', () => {
    expect(hashNumbers([])).toBe(PINNED_EMPTY);
    expect(hashNumbers([1, 2, 3])).toBe(PINNED_123);
  });

  it('tells -0 from 0', () => {
    expect(hashNumbers([0])).not.toBe(hashNumbers([-0]));
    expect(hashNumbers([1, 0, 2])).not.toBe(hashNumbers([1, -0, 2]));
  });

  it('changes on a 1-ulp difference anywhere in the list', () => {
    const base = [103.25, 0.1, 1e-12, 88000.5, 1, 2.5e7];
    const baseHash = hashNumbers(base);
    for (let i = 0; i < base.length; i++) {
      const nudged = base.slice();
      nudged[i] = nextUp(base[i]);
      expect(nudged[i]).not.toBe(base[i]);
      expect(hashNumbers(nudged)).not.toBe(baseHash);
    }
  });

  it('changes both 32-bit halves on a 1-ulp difference', () => {
    const a = hashNumbers([0.3]);
    const b = hashNumbers([nextUp(0.3)]);
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8));
    expect(a.slice(8)).not.toBe(b.slice(8));
  });

  it('depends on order and length', () => {
    expect(hashNumbers([1, 2])).not.toBe(hashNumbers([2, 1]));
    expect(hashNumbers([])).not.toBe(hashNumbers([0]));
    expect(hashNumbers([0])).not.toBe(hashNumbers([0, 0]));
  });

  it('does not collide across many nearby states', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(hashNumbers([i * 0.001, -i, i % 7]));
    expect(seen.size).toBe(20000);
  });
});

describe('hashString', () => {
  it('returns 8 lowercase hex chars', () => {
    for (const s of ['', 'a', '2026-W48', 'neon \u{1F3CE} drift']) expect(hashString(s)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable and keeps its pinned value', () => {
    expect(hashString('2026-W48')).toBe(hashString('2026-' + 'W48'));
    expect(hashString('2026-W48')).toBe(PINNED_WEEK);
  });

  it('changes with any character, including beyond Latin-1', () => {
    expect(hashString('2026-W48')).not.toBe(hashString('2026-W49'));
    expect(hashString('ab')).not.toBe(hashString('ba'));
    expect(hashString('Ł')).not.toBe(hashString('A'));
    expect(hashString('')).not.toBe(hashString('\u0000'));
  });

  it('does not collide across many short strings', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(hashString('seed-' + i));
    expect(seen.size).toBe(20000);
  });
});
