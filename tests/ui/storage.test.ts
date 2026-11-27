import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHYSICS_VERSION } from '../../src/types';
import type { BestRecord, Settings } from '../../src/types';
import { DEFAULT_SETTINGS, loadBest, loadSettings, saveBest, saveSettings } from '../../src/ui/storage';

class FakeStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
}

const brokenStorage = {
  getItem(): string | null {
    throw new Error('storage disabled');
  },
  setItem(): void {
    throw new Error('quota exceeded');
  },
};

const SETTINGS_KEY = 'sigdrift:settings';
const LEVEL = '2026-W48';
const BEST_KEY = `sigdrift:best:${LEVEL}`;

function record(ticks: number, driftScore = 100): BestRecord {
  return { ticks, driftScore, physicsVersion: PHYSICS_VERSION };
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('matchMedia', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns a fresh object each time', () => {
    const first = loadSettings();
    first.volume = 0;
    expect(loadSettings().volume).toBe(DEFAULT_SETTINGS.volume);
    expect(first).not.toBe(DEFAULT_SETTINGS);
  });

  it('round-trips saved settings', () => {
    const settings: Settings = { quality: 'low', volume: 0.25, assist: false, reducedFlash: true };
    saveSettings(settings);
    expect(loadSettings()).toEqual(settings);
    expect([...storage.items.keys()]).toEqual([SETTINGS_KEY]);
  });

  it('replaces malformed fields with defaults and keeps the valid ones', () => {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'ultra', volume: 'loud', assist: false, extra: 1 }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, assist: false });
  });

  it('clamps the volume to 0..1', () => {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ volume: 7 }));
    expect(loadSettings().volume).toBe(1);
    storage.setItem(SETTINGS_KEY, JSON.stringify({ volume: -3 }));
    expect(loadSettings().volume).toBe(0);
  });

  it('survives corrupt JSON and non-object values', () => {
    for (const raw of ['{not json', 'null', '[1,2]', '"text"', '42']) {
      storage.setItem(SETTINGS_KEY, raw);
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('follows the reduced-motion preference until the player has chosen', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(loadSettings().reducedFlash).toBe(true);
    saveSettings({ ...DEFAULT_SETTINGS, reducedFlash: false });
    expect(loadSettings().reducedFlash).toBe(false);
  });

  it('falls back to defaults when storage throws or is missing', () => {
    vi.stubGlobal('localStorage', brokenStorage);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
  });
});

describe('best records', () => {
  it('returns null when nothing is stored', () => {
    expect(loadBest(LEVEL)).toBeNull();
  });

  it('stores the first record under a prefixed per-level key', () => {
    expect(saveBest(LEVEL, record(9000))).toBe(true);
    expect(loadBest(LEVEL)).toEqual(record(9000));
    expect([...storage.items.keys()]).toEqual([BEST_KEY]);
    expect(loadBest('2026-W47')).toBeNull();
  });

  it('only replaces a record with a strictly faster time', () => {
    saveBest(LEVEL, record(9000, 100));
    expect(saveBest(LEVEL, record(9000, 999))).toBe(false);
    expect(saveBest(LEVEL, record(9500, 999))).toBe(false);
    expect(loadBest(LEVEL)).toEqual(record(9000, 100));
    expect(saveBest(LEVEL, record(8999, 5))).toBe(true);
    expect(loadBest(LEVEL)).toEqual(record(8999, 5));
  });

  it('ignores a record stored under another physics version and lets a new one replace it', () => {
    storage.setItem(BEST_KEY, JSON.stringify({ ...record(100), physicsVersion: PHYSICS_VERSION + 1 }));
    expect(loadBest(LEVEL)).toBeNull();
    expect(saveBest(LEVEL, record(9000))).toBe(true);
    expect(loadBest(LEVEL)).toEqual(record(9000));
  });

  it('refuses to store a record from another physics version', () => {
    saveBest(LEVEL, record(9000));
    expect(saveBest(LEVEL, { ...record(10), physicsVersion: PHYSICS_VERSION + 1 })).toBe(false);
    expect(loadBest(LEVEL)).toEqual(record(9000));
  });

  it('rejects malformed stored data', () => {
    const malformed = [
      '{not json',
      'null',
      '[]',
      JSON.stringify({ ticks: '9000', driftScore: 1, physicsVersion: PHYSICS_VERSION }),
      JSON.stringify({ ticks: -5, driftScore: 1, physicsVersion: PHYSICS_VERSION }),
      JSON.stringify({ ticks: 12.5, driftScore: 1, physicsVersion: PHYSICS_VERSION }),
      JSON.stringify({ ticks: 9000, physicsVersion: PHYSICS_VERSION }),
      JSON.stringify({ ticks: 9000, driftScore: 1 }),
    ];
    for (const raw of malformed) {
      storage.setItem(BEST_KEY, raw);
      expect(loadBest(LEVEL)).toBeNull();
    }
  });

  it('refuses to store an invalid record', () => {
    expect(saveBest(LEVEL, record(0))).toBe(false);
    expect(saveBest(LEVEL, record(NaN))).toBe(false);
    expect(saveBest(LEVEL, record(9000, Infinity))).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  it('drops fields that are not part of a record', () => {
    saveBest(LEVEL, { ...record(9000), note: 'x' } as BestRecord);
    expect(JSON.parse(storage.getItem(BEST_KEY) ?? '')).toEqual(record(9000));
  });

  it('reports failure when storage throws or is missing', () => {
    vi.stubGlobal('localStorage', brokenStorage);
    expect(loadBest(LEVEL)).toBeNull();
    expect(saveBest(LEVEL, record(9000))).toBe(false);
    vi.stubGlobal('localStorage', undefined);
    expect(loadBest(LEVEL)).toBeNull();
    expect(saveBest(LEVEL, record(9000))).toBe(false);
  });
});
