import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLevel, generateLevelFromSeed } from '../../src/gen/trackGen';
import type { ValidationResult } from '../../src/types';

/** How many validations to fail before letting the real validator answer. */
const forced = vi.hoisted(() => ({ failures: 0 }));

vi.mock('../../src/gen/validate', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/gen/validate')>();
  return {
    ...real,
    validateLevel: (level: Parameters<typeof real.validateLevel>[0]): ValidationResult => {
      if (forced.failures > 0) {
        forced.failures--;
        return { ok: false, errors: ['forced failure'] };
      }
      return real.validateLevel(level);
    },
  };
});

describe('retry on a failed validation', () => {
  beforeEach(() => {
    forced.failures = 0;
  });

  it('keeps the plain seed when the first attempt is valid', () => {
    expect(generateLevelFromSeed('retry-test', 'x').seed).toBe('retry-test');
  });

  it('extends the seed and records the one that was used', () => {
    forced.failures = 1;
    const once = generateLevelFromSeed('retry-test', 'x');
    expect(once.seed).toBe('retry-test|retry1');
    expect(once).toEqual(buildLevel('retry-test|retry1', 'x'));

    forced.failures = 3;
    expect(generateLevelFromSeed('retry-test', 'x').seed).toBe('retry-test|retry3');
  });

  it('gives up with the last failure once every retry is spent', () => {
    forced.failures = 51;
    expect(() => generateLevelFromSeed('retry-test', 'x')).toThrow(/after 50 retries: forced failure/);
    expect(forced.failures).toBe(0);
  });
});
