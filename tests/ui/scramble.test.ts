import { describe, expect, it } from 'vitest';
import {
  SCRAMBLE_GLYPHS,
  SCRAMBLE_MS,
  scrambleDelay,
  scrambleFrame,
  scrambleProgress,
} from '../../src/ui/scramble';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXT = 'HOW TO PLAY';

describe('scrambleFrame', () => {
  it('keeps the length and the spaces at every step', () => {
    const random = seeded(1);
    for (let p = 0; p <= 1; p += 0.05) {
      const frame = scrambleFrame(TEXT, p, random);
      expect(frame).toHaveLength(TEXT.length);
      for (let i = 0; i < TEXT.length; i++) if (TEXT[i] === ' ') expect(frame[i]).toBe(' ');
    }
  });

  it('shows only glyphs at the start and the real text at the end', () => {
    const start = scrambleFrame(TEXT, 0, seeded(2));
    for (let i = 0; i < TEXT.length; i++) {
      if (TEXT[i] !== ' ') expect(SCRAMBLE_GLYPHS).toContain(start[i]);
    }
    expect(scrambleFrame(TEXT, 1, seeded(2))).toBe(TEXT);
    expect(scrambleFrame(TEXT, 7, seeded(2))).toBe(TEXT);
  });

  it('resolves from left to right', () => {
    const random = seeded(3);
    let resolvedBefore = 0;
    for (let p = 0; p <= 1.0001; p += 0.1) {
      const frame = scrambleFrame(TEXT, p, random);
      const resolved = Math.floor(Math.min(1, p) * TEXT.length);
      expect(frame.slice(0, resolved)).toBe(TEXT.slice(0, resolved));
      expect(resolved).toBeGreaterThanOrEqual(resolvedBefore);
      resolvedBefore = resolved;
    }
  });

  it('copes with empty text, odd progress values and an empty glyph set', () => {
    expect(scrambleFrame('', 0.5, seeded(4))).toBe('');
    expect(scrambleFrame(TEXT, NaN, seeded(4))).toBe(TEXT);
    expect(scrambleFrame(TEXT, -1, seeded(4))).toHaveLength(TEXT.length);
    expect(scrambleFrame(TEXT, 0.3, seeded(4), '')).toBe(TEXT);
  });

  it('never reads past the glyph set, even for a random() of nearly 1', () => {
    const frame = scrambleFrame('ABC', 0, () => 0.9999999, '#%');
    expect(frame).toBe('%%%');
  });
});

describe('scrambleProgress', () => {
  it('runs from 0 to 1 over the duration, easing out', () => {
    expect(scrambleProgress(-10)).toBe(0);
    expect(scrambleProgress(0)).toBe(0);
    expect(scrambleProgress(SCRAMBLE_MS)).toBe(1);
    expect(scrambleProgress(SCRAMBLE_MS * 2)).toBe(1);
    const half = scrambleProgress(SCRAMBLE_MS / 2);
    expect(half).toBeGreaterThan(0.5);
    expect(half).toBeLessThan(1);
    let last = 0;
    for (let t = 0; t <= SCRAMBLE_MS; t += 10) {
      const p = scrambleProgress(t);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it('finishes at once for a zero or invalid duration', () => {
    expect(scrambleProgress(0, 0)).toBe(1);
    expect(scrambleProgress(0, NaN)).toBe(1);
  });
});

describe('scrambleDelay', () => {
  it('staggers elements, capped so a long screen still resolves quickly', () => {
    expect(scrambleDelay(0)).toBe(0);
    expect(scrambleDelay(1)).toBeGreaterThan(0);
    expect(scrambleDelay(2)).toBeGreaterThan(scrambleDelay(1));
    expect(scrambleDelay(100)).toBeLessThanOrEqual(160);
    expect(scrambleDelay(-3)).toBe(0);
  });
});
