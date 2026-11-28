import { describe, expect, it } from 'vitest';
import { hashString } from '../../src/core/hash';
import { LEVELS, WEEKLY_OPTIONS, generateLevelFor, getLevelDef } from '../../src/gen/levels';
import { buildLevel } from '../../src/gen/trackGen';
import { validateLevel } from '../../src/gen/validate';
import type { Level, TrackOptions } from '../../src/types';
import { GEN_VERSION } from '../../src/types';
import { levelStats } from './levelStats';
import type { LevelStats } from './levelStats';

const levels: Level[] = LEVELS.map(generateLevelFor);
const stats: LevelStats[] = levels.map(levelStats);

/** One rough number for how demanding a level is to drive cleanly. */
function hazard(s: LevelStats): number {
  return s.maxHeight / 8 + s.crossings + s.openShare * 8 + s.bumpsPerKm / 2 + s.turning / 1000 + (10 - s.narrowest) / 2;
}

const round = (_: string, v: unknown): unknown => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

describe('level definitions', () => {
  it('are five, L1..L5, in rising difficulty, with names, blurbs and fixed seeds', () => {
    expect(LEVELS.map((def) => def.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    expect(LEVELS.map((def) => def.difficulty)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(LEVELS.map((def) => def.name)).size).toBe(5);
    for (const def of LEVELS) {
      expect(def.name.length).toBeGreaterThan(3);
      expect(def.blurb.length).toBeGreaterThan(10);
      expect(def.blurb.length).toBeLessThanOrEqual(90);
      expect(def.seed).toContain(`gen-v${GEN_VERSION}`);
      expect(def.seed).toContain(def.id);
    }
    expect(new Set(LEVELS.map((def) => def.seed)).size).toBe(5);
  });

  it('are found by id', () => {
    expect(getLevelDef('L3')).toBe(LEVELS[2]);
    expect(getLevelDef('L6')).toBeNull();
    expect(getLevelDef('2026-W48')).toBeNull();
  });

  it('use option values inside their documented ranges', () => {
    const check = (o: TrackOptions): void => {
      expect(o.cells[0]).toBeLessThanOrEqual(o.cells[1]);
      expect(o.halfWidth[0]).toBeGreaterThanOrEqual(7.5);
      expect(o.halfWidth[0]).toBeLessThanOrEqual(o.halfWidth[1]);
      for (const share of [o.elevation, o.openEdges, o.twist, o.plazas]) {
        expect(share).toBeGreaterThanOrEqual(0);
        expect(share).toBeLessThanOrEqual(1);
      }
      expect(o.crossings).toBeGreaterThanOrEqual(0);
      expect(o.crossings).toBeLessThanOrEqual(4);
    };
    check(WEEKLY_OPTIONS);
    for (const def of LEVELS) check(def.options);
  });
});

describe('generated levels', () => {
  it('are deterministic', () => {
    for (const def of LEVELS) expect(generateLevelFor(def)).toEqual(levels[LEVELS.indexOf(def)]);
  });

  it('match their pinned layouts', () => {
    // If one changes on purpose after a release, bump GEN_VERSION in src/types.ts (which changes every seed).
    const hashes = Object.fromEntries(levels.map((level) => [level.id, hashString(JSON.stringify(level))]));
    expect(hashes).toEqual(GOLDEN_LEVELS);
  });

  it('validate, carry their id and use their own seed', () => {
    levels.forEach((level, i) => {
      expect(validateLevel(level).errors, level.id).toEqual([]);
      expect(level.id).toBe(LEVELS[i].id);
      expect(level.seed).toBe(LEVELS[i].seed);
    });
  });

  it('each have their own character, and get harder one by one', () => {
    const [l1, l2, l3, l4, l5] = stats;
    console.info(`levels: ${JSON.stringify(Object.fromEntries(stats.map((s, i) => [LEVELS[i].id, s])), round)}`);
    console.info(`levels hazard: ${stats.map((s) => hazard(s).toFixed(2)).join(' < ')}`);
    // L1: a gentle flowing intro, nearly flat, barriers everywhere, nothing over or under.
    expect(l1.maxHeight).toBeLessThan(3);
    expect(l1.crossings).toBe(0);
    expect(l1.openLength).toBe(0);
    expect(l1.bumpsPerKm).toBe(0);
    expect(l1.meanHalfWidth).toBe(Math.max(...stats.map((s) => s.meanHalfWidth)));
    // L2: technical: the most turning per metre, plazas and the most pillars.
    const twistiness = stats.map((s) => s.turning / s.length);
    expect(twistiness[1]).toBe(Math.max(...twistiness));
    expect(l2.pillarsPerKm).toBe(Math.max(...stats.map((s) => s.pillarsPerKm)));
    expect(l2.plazaPoints).toBeGreaterThan(0);
    expect(l2.crossings).toBe(0);
    // L3: big climbs and drops.
    expect(l3.maxHeight).toBeGreaterThanOrEqual(18);
    expect(l3.climb).toBeGreaterThan(Math.max(l1.climb, l2.climb) * 2);
    expect(l3.crossings).toBeGreaterThanOrEqual(1);
    // L4: the interchange: the most crossings.
    expect(l4.crossings).toBeGreaterThanOrEqual(3);
    expect(l4.crossings).toBe(Math.max(...stats.map((s) => s.crossings)));
    // L5: the skyway: the most open edge, the most bumps, the narrowest road, a long way up.
    expect(l5.openShare).toBe(Math.max(...stats.map((s) => s.openShare)));
    expect(l5.openLength).toBe(Math.max(...stats.map((s) => s.openLength)));
    expect(l5.bumpsPerKm).toBe(Math.max(...stats.map((s) => s.bumpsPerKm)));
    expect(l5.raisedShare).toBeGreaterThan(0.6);
    // Rising difficulty.
    const scores = stats.map(hazard);
    for (let i = 1; i < scores.length; i++) expect(scores[i], LEVELS[i].id).toBeGreaterThan(scores[i - 1]);
  });
});

describe('options shape the levels', () => {
  const SAMPLES = 30;

  it('give each setting its own statistics', { timeout: 120_000 }, () => {
    const sets: [string, TrackOptions][] = [['weekly', WEEKLY_OPTIONS], ...LEVELS.map((def) => [def.id, def.options] as [string, TrackOptions])];
    const means: Record<string, Record<string, number>> = {};
    for (const [name, options] of sets) {
      const sum: Record<string, number> = {};
      for (let i = 0; i < SAMPLES; i++) {
        const level = buildLevel(`options-${name}-${i}`, name, options);
        expect(validateLevel(level).errors, `${name} ${i}`).toEqual([]);
        const s = levelStats(level);
        for (const [key, value] of Object.entries(s)) sum[key] = (sum[key] ?? 0) + value / SAMPLES;
      }
      means[name] = sum;
    }
    console.info(`options (mean of ${SAMPLES}): ${JSON.stringify(means, round)}`);
    // Elevation drives height, crossings drive crossings, open edges drive open edge, bumps drive bumps.
    expect(means.L1.maxHeight).toBeLessThan(3);
    expect(means.L3.maxHeight).toBeGreaterThan(means.weekly.maxHeight + 4);
    expect(means.L1.crossings).toBe(0);
    expect(means.L2.crossings).toBe(0);
    expect(means.weekly.crossings).toBeGreaterThan(0.6);
    expect(means.L4.crossings).toBeGreaterThan(means.weekly.crossings + 0.5);
    expect(means.L1.openLength).toBe(0);
    expect(means.L5.openShare).toBeGreaterThan(means.weekly.openShare * 1.8);
    expect(means.L5.bumpsPerKm).toBeGreaterThan(means.weekly.bumpsPerKm * 2);
    expect(means.L1.bumpsPerKm).toBe(0);
    expect(means.L2.turning / means.L2.length).toBeGreaterThan(means.L1.turning / means.L1.length);
  });
});

/** Pinned layouts for GEN_VERSION 2. */
const GOLDEN_LEVELS: Record<string, string> = {
  L1: '310c7780',
  L2: '136b8576',
  L3: '4b28ffb3',
  L4: '44b0531e',
  L5: '3c697b95',
};
