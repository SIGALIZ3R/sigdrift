/** Garage storage: completed levels, car unlocks and the picked car (storage.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHYSICS_VERSION } from '../../src/types';
import {
  loadCar,
  loadCompletedLevels,
  loadSettings,
  markLevelCompleted,
  saveCar,
  saveRunRecord,
  unlockedCarIds,
} from '../../src/ui/storage';

class FakeStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
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

describe('completed levels', () => {
  it('starts empty, with only the stock car', () => {
    expect(loadCompletedLevels()).toEqual([]);
    expect(unlockedCarIds()).toEqual(['phantom']);
    expect(loadCar()).toBe('phantom');
  });

  it('unlocks the Viper when level 3 is finished, once', () => {
    expect(markLevelCompleted('L1')).toEqual([]);
    expect(markLevelCompleted('L2')).toEqual([]);
    expect(markLevelCompleted('L3')).toEqual(['viper']);
    expect(markLevelCompleted('L3')).toEqual([]);
    expect(unlockedCarIds()).toEqual(['phantom', 'viper']);
  });

  it('unlocks the Brute when level 5 is finished, whatever came before', () => {
    expect(markLevelCompleted('L5')).toEqual(['brute']);
    expect(unlockedCarIds()).toEqual(['phantom', 'brute']);
    markLevelCompleted('L3');
    expect(unlockedCarIds()).toEqual(['phantom', 'viper', 'brute']);
  });

  it('counts a level with a stored best time as finished (players from before the garage)', () => {
    saveRunRecord('L3', { ticks: 9000, score: 10, date: '2026-11-28T00:00:00Z', physicsVersion: PHYSICS_VERSION });
    expect(loadCompletedLevels()).toEqual(['L3']);
    expect(unlockedCarIds()).toContain('viper');
  });

  it('keeps unlocks after a physics change throws the records away', () => {
    markLevelCompleted('L3');
    storage.items.set('sigdrift:run:L3', JSON.stringify({ bestTime: { ticks: 1, score: 1, date: 'x', physicsVersion: -1 } }));
    expect(unlockedCarIds()).toContain('viper');
  });

  it('ignores weekly ids and junk in the stored list', () => {
    expect(markLevelCompleted('2026-W48')).toEqual([]);
    storage.items.set('sigdrift:completedLevels', JSON.stringify(['L3', 42, null, '<script>', 'L99x']));
    expect(loadCompletedLevels()).toEqual(['L3']);
    storage.items.set('sigdrift:completedLevels', '{not json');
    expect(loadCompletedLevels()).toEqual([]);
  });

  it('reports nothing unlocked when storage cannot be written', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    });
    expect(markLevelCompleted('L3')).toEqual([]);
  });
});

describe('picked car', () => {
  it('remembers an unlocked pick', () => {
    markLevelCompleted('L3');
    saveCar('viper');
    expect(loadCar()).toBe('viper');
  });

  it('falls back to the stock car for a locked pick (edited storage cannot skip the unlock)', () => {
    storage.items.set('sigdrift:car', JSON.stringify('brute'));
    expect(loadCar()).toBe('phantom');
  });

  it('ignores unknown ids', () => {
    saveCar('tank' as never);
    expect(storage.items.has('sigdrift:car')).toBe(false);
    storage.items.set('sigdrift:car', JSON.stringify('tank'));
    expect(loadCar()).toBe('phantom');
  });
});

describe('music volume setting', () => {
  it('defaults to 0.7 and keeps a stored value, clamped', () => {
    expect(loadSettings().musicVolume).toBe(0.7);
    storage.items.set('sigdrift:settings', JSON.stringify({ musicVolume: 0.2 }));
    expect(loadSettings().musicVolume).toBe(0.2);
    storage.items.set('sigdrift:settings', JSON.stringify({ musicVolume: 3 }));
    expect(loadSettings().musicVolume).toBe(1);
    storage.items.set('sigdrift:settings', JSON.stringify({ musicVolume: 'loud' }));
    expect(loadSettings().musicVolume).toBe(0.7);
  });
});
