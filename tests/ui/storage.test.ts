import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHYSICS_VERSION } from '../../src/types';
import type { Difficulty, EndlessRecord, RunRecord, Settings } from '../../src/types';
import {
  DEFAULT_DIFFICULTY,
  DEFAULT_SETTINGS,
  DIFFICULTIES,
  HIGH_SCORE_SLOTS,
  bestEndlessOverall,
  countCompleted,
  insertionIndex,
  loadEndlessDifficulty,
  loadEndlessRecords,
  loadHowToSeen,
  loadRunRecords,
  loadSettings,
  saveEndlessDifficulty,
  saveEndlessRecord,
  saveHowToSeen,
  saveRunRecord,
  saveSettings,
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

const brokenStorage = {
  getItem(): string | null {
    throw new Error('storage disabled');
  },
  setItem(): void {
    throw new Error('quota exceeded');
  },
};

const SETTINGS_KEY = 'sigdrift:settings';
const TRACK = '2026-W48';
const RUN_KEY = `sigdrift:run:${TRACK}`;
const ENDLESS_KEY = 'sigdrift:endless:hard';
const DIFFICULTY_KEY = 'sigdrift:endlessDifficulty';
const DATE = '2026-11-27T12:00:00.000Z';

function run(ticks: number, score = 100, date = DATE): RunRecord {
  return { ticks, score, date, physicsVersion: PHYSICS_VERSION };
}

function endless(distance: number, score = 100, ticks = 1200): EndlessRecord {
  return { distance, score, ticks, date: DATE, physicsVersion: PHYSICS_VERSION };
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
    const settings: Settings = { quality: 'low', volume: 0.25, assist: false, reducedFlash: true, muted: true };
    saveSettings(settings);
    expect(loadSettings()).toEqual(settings);
    expect([...storage.items.keys()]).toEqual([SETTINGS_KEY]);
  });

  it('starts with sound on, including for settings saved before there was a mute switch', () => {
    expect(DEFAULT_SETTINGS.muted).toBe(false);
    storage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'low', volume: 0.25, assist: false, reducedFlash: true }));
    expect(loadSettings()).toEqual({ quality: 'low', volume: 0.25, assist: false, reducedFlash: true, muted: false });
  });

  it('remembers mute without touching the volume', () => {
    saveSettings({ ...DEFAULT_SETTINGS, volume: 0.4, muted: true });
    expect(loadSettings()).toMatchObject({ volume: 0.4, muted: true });
    saveSettings({ ...loadSettings(), muted: false });
    expect(loadSettings()).toMatchObject({ volume: 0.4, muted: false });
  });

  it('only accepts a boolean for muted', () => {
    for (const muted of ['true', 1, 0, null, {}, []]) {
      storage.setItem(SETTINGS_KEY, JSON.stringify({ muted }));
      expect(loadSettings().muted).toBe(false);
    }
    saveSettings({ ...DEFAULT_SETTINGS, muted: 'yes' } as unknown as Settings);
    expect(loadSettings().muted).toBe(false);
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

describe('run records', () => {
  it('is empty when nothing is stored', () => {
    expect(loadRunRecords(TRACK)).toEqual({ bestTime: null, highScores: [] });
  });

  it('stores the first run as best time, high score and rank 1 under a prefixed per-track key', () => {
    expect(saveRunRecord(TRACK, run(900, 500))).toEqual({ newBestTime: true, newHighScore: true, rank: 1 });
    expect(loadRunRecords(TRACK)).toEqual({ bestTime: run(900, 500), highScores: [run(900, 500)] });
    expect([...storage.items.keys()]).toEqual([RUN_KEY]);
  });

  it('keeps tracks apart', () => {
    saveRunRecord('L1', run(900));
    expect(loadRunRecords('L2')).toEqual({ bestTime: null, highScores: [] });
    expect(loadRunRecords('L1').bestTime).toEqual(run(900));
  });

  it('replaces the best time only with a strictly faster run', () => {
    saveRunRecord(TRACK, run(900, 10));
    expect(saveRunRecord(TRACK, run(900, 5)).newBestTime).toBe(false);
    expect(saveRunRecord(TRACK, run(950, 5)).newBestTime).toBe(false);
    expect(loadRunRecords(TRACK).bestTime).toEqual(run(900, 10));
    expect(saveRunRecord(TRACK, run(880, 5)).newBestTime).toBe(true);
    expect(loadRunRecords(TRACK).bestTime).toEqual(run(880, 5));
  });

  it('keeps the top five scores, highest first, and reports each new entry\'s rank', () => {
    expect(saveRunRecord(TRACK, run(1000, 300)).rank).toBe(1);
    expect(saveRunRecord(TRACK, run(1000, 500)).rank).toBe(1);
    expect(saveRunRecord(TRACK, run(1000, 100)).rank).toBe(3);
    expect(saveRunRecord(TRACK, run(1000, 400)).rank).toBe(2);
    expect(saveRunRecord(TRACK, run(1000, 200)).rank).toBe(4);
    expect(loadRunRecords(TRACK).highScores.map((r) => r.score)).toEqual([500, 400, 300, 200, 100]);
    // A sixth that beats the lowest pushes it out ...
    expect(saveRunRecord(TRACK, run(1000, 150)).rank).toBe(5);
    expect(loadRunRecords(TRACK).highScores.map((r) => r.score)).toEqual([500, 400, 300, 200, 150]);
    // ... and one that does not, does not make the table.
    expect(saveRunRecord(TRACK, run(1000, 120))).toEqual({ newBestTime: false, newHighScore: false, rank: null });
    expect(loadRunRecords(TRACK).highScores).toHaveLength(HIGH_SCORE_SLOTS);
  });

  it('places an equal score after the one set earlier', () => {
    saveRunRecord(TRACK, run(1000, 300, '2026-11-01T00:00:00Z'));
    expect(saveRunRecord(TRACK, run(1000, 300, '2026-11-02T00:00:00Z')).rank).toBe(2);
    expect(loadRunRecords(TRACK).highScores.map((r) => r.date)).toEqual(['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z']);
  });

  it('flags a new high score only when the top score is beaten', () => {
    saveRunRecord(TRACK, run(1000, 300));
    expect(saveRunRecord(TRACK, run(1000, 300)).newHighScore).toBe(false);
    expect(saveRunRecord(TRACK, run(1000, 200)).newHighScore).toBe(false);
    expect(saveRunRecord(TRACK, run(1000, 301)).newHighScore).toBe(true);
  });

  it('never calls a zero score a high score, but still ranks it', () => {
    expect(saveRunRecord(TRACK, run(1000, 0))).toEqual({ newBestTime: true, newHighScore: false, rank: 1 });
  });

  it('ignores records from another physics version and lets new ones replace them', () => {
    const old = { ticks: 500, score: 9999, date: DATE, physicsVersion: PHYSICS_VERSION - 1 };
    storage.setItem(RUN_KEY, JSON.stringify({ bestTime: old, highScores: [old, run(800, 50)] }));
    expect(loadRunRecords(TRACK)).toEqual({ bestTime: null, highScores: [run(800, 50)] });
    expect(saveRunRecord(TRACK, run(900, 60))).toEqual({ newBestTime: true, newHighScore: true, rank: 1 });
    const stored = JSON.parse(storage.getItem(RUN_KEY) ?? '{}');
    expect(stored.bestTime).toEqual(run(900, 60));
    expect(stored.highScores).toEqual([run(900, 60), run(800, 50)]);
  });

  it('refuses to store a record from another physics version or with bad fields', () => {
    const none = { newBestTime: false, newHighScore: false, rank: null };
    expect(saveRunRecord(TRACK, { ...run(900), physicsVersion: PHYSICS_VERSION + 1 })).toEqual(none);
    expect(saveRunRecord(TRACK, run(0))).toEqual(none);
    expect(saveRunRecord(TRACK, run(10.5))).toEqual(none);
    expect(saveRunRecord(TRACK, run(900, -1))).toEqual(none);
    expect(saveRunRecord(TRACK, run(900, NaN))).toEqual(none);
    expect(saveRunRecord(TRACK, { ...run(900), date: 5 } as unknown as RunRecord)).toEqual(none);
    expect(storage.items.size).toBe(0);
  });

  it('survives corrupted data', () => {
    for (const raw of ['{not json', 'null', '[1,2]', '"text"', '42', '{"bestTime":7,"highScores":"x"}']) {
      storage.setItem(RUN_KEY, raw);
      expect(loadRunRecords(TRACK)).toEqual({ bestTime: null, highScores: [] });
    }
    storage.setItem(RUN_KEY, JSON.stringify({ bestTime: run(900), highScores: [null, 3, { score: 5 }, run(700, 40), run(800, 90)] }));
    expect(loadRunRecords(TRACK)).toEqual({ bestTime: run(900), highScores: [run(800, 90), run(700, 40)] });
  });

  it('sorts and trims a stored table that is out of order or too long', () => {
    const table = [10, 70, 30, 90, 50, 20, 80].map((score) => run(1000, score));
    storage.setItem(RUN_KEY, JSON.stringify({ bestTime: null, highScores: table }));
    expect(loadRunRecords(TRACK).highScores.map((r) => r.score)).toEqual([90, 80, 70, 50, 30]);
  });

  it('drops fields that are not part of a record', () => {
    saveRunRecord(TRACK, { ...run(900), extra: 'x' } as RunRecord);
    expect(loadRunRecords(TRACK).bestTime).toEqual(run(900));
  });

  it('reports nothing saved when storage throws or is missing', () => {
    vi.stubGlobal('localStorage', brokenStorage);
    expect(loadRunRecords(TRACK)).toEqual({ bestTime: null, highScores: [] });
    expect(saveRunRecord(TRACK, run(900))).toStrictEqual({ newBestTime: false, newHighScore: false, rank: null, failed: true });
    vi.stubGlobal('localStorage', undefined);
    expect(saveRunRecord(TRACK, run(900)).rank).toBeNull();
    expect(saveRunRecord(TRACK, run(900)).failed).toBe(true);
  });

  it('ignores keys from earlier versions', () => {
    storage.setItem(`sigdrift:best:${TRACK}`, JSON.stringify({ ticks: 900, driftScore: 5, physicsVersion: PHYSICS_VERSION }));
    expect(loadRunRecords(TRACK)).toEqual({ bestTime: null, highScores: [] });
  });

  it('counts completed tracks', () => {
    saveRunRecord('L1', run(900));
    saveRunRecord('L3', run(900));
    expect(countCompleted(['L1', 'L2', 'L3', 'L4', 'L5'])).toBe(2);
  });
});

describe('insertionIndex', () => {
  it('finds the slot after every score it does not beat', () => {
    const table = [{ score: 50 }, { score: 30 }, { score: 30 }, { score: 10 }];
    expect(insertionIndex(table, 60)).toBe(0);
    expect(insertionIndex(table, 50)).toBe(1);
    expect(insertionIndex(table, 30)).toBe(3);
    expect(insertionIndex(table, 5)).toBe(4);
    expect(insertionIndex([], 0)).toBe(0);
  });
});

describe('endless records', () => {
  it('is empty when nothing is stored', () => {
    expect(loadEndlessRecords('hard')).toEqual({ bestDistance: null, highScores: [] });
  });

  it('stores the first run under a prefixed per-difficulty key', () => {
    expect(saveEndlessRecord('hard', endless(842, 300))).toEqual({ newBestDistance: true, newHighScore: true, rank: 1 });
    expect(loadEndlessRecords('hard')).toEqual({ bestDistance: endless(842, 300), highScores: [endless(842, 300)] });
    expect([...storage.items.keys()]).toEqual([ENDLESS_KEY]);
  });

  it('keeps each difficulty apart', () => {
    saveEndlessRecord('easy', endless(100));
    expect(loadEndlessRecords('hard').bestDistance).toBeNull();
    expect(loadEndlessRecords('easy').bestDistance).toEqual(endless(100));
  });

  it('replaces the best distance only with a strictly longer one, and ranks scores independently', () => {
    saveEndlessRecord('hard', endless(800, 100));
    expect(saveEndlessRecord('hard', endless(800, 900))).toEqual({ newBestDistance: false, newHighScore: true, rank: 1 });
    expect(saveEndlessRecord('hard', endless(1200, 50))).toEqual({ newBestDistance: true, newHighScore: false, rank: 3 });
    expect(loadEndlessRecords('hard').bestDistance).toEqual(endless(1200, 50));
  });

  it('does not count a zero distance as a best distance', () => {
    expect(saveEndlessRecord('hard', endless(0, 0)).newBestDistance).toBe(false);
    expect(loadEndlessRecords('hard').bestDistance).toBeNull();
  });

  it('ignores other physics versions, corrupted data and unknown difficulties', () => {
    const old = { ...endless(5000, 9999), physicsVersion: PHYSICS_VERSION - 1 };
    storage.setItem(ENDLESS_KEY, JSON.stringify({ bestDistance: old, highScores: [old] }));
    expect(loadEndlessRecords('hard')).toEqual({ bestDistance: null, highScores: [] });
    storage.setItem(ENDLESS_KEY, '{oops');
    expect(loadEndlessRecords('hard')).toEqual({ bestDistance: null, highScores: [] });
    expect(loadEndlessRecords('insane' as Difficulty)).toEqual({ bestDistance: null, highScores: [] });
    expect(saveEndlessRecord('insane' as Difficulty, endless(100)).rank).toBeNull();
    expect(saveEndlessRecord('hard', { ...endless(100), ticks: -1 }).rank).toBeNull();
    expect(saveEndlessRecord('hard', { ...endless(100), distance: Infinity }).rank).toBeNull();
  });

  it('finds the furthest run over all difficulties', () => {
    expect(bestEndlessOverall()).toBeNull();
    saveEndlessRecord('easy', endless(500));
    saveEndlessRecord('hard', endless(900));
    saveEndlessRecord('medium', endless(700));
    expect(bestEndlessOverall()).toEqual({ difficulty: 'hard', record: endless(900) });
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', brokenStorage);
    expect(loadEndlessRecords('hard')).toEqual({ bestDistance: null, highScores: [] });
    expect(saveEndlessRecord('hard', endless(100))).toStrictEqual({ newBestDistance: false, newHighScore: false, rank: null, failed: true });
  });
});

describe('how to play flag', () => {
  it('starts unseen and remembers once seen', () => {
    expect(loadHowToSeen()).toBe(false);
    saveHowToSeen();
    expect(loadHowToSeen()).toBe(true);
    expect(storage.getItem('sigdrift:howToSeen')).toBe('true');
    saveHowToSeen(false);
    expect(loadHowToSeen()).toBe(false);
  });

  it('accepts only a stored true', () => {
    for (const raw of ['1', '"true"', '{x', 'null']) {
      storage.setItem('sigdrift:howToSeen', raw);
      expect(loadHowToSeen()).toBe(false);
    }
  });
});

describe('endless difficulty', () => {
  it('defaults to medium', () => {
    expect(DEFAULT_DIFFICULTY).toBe('medium');
    expect(loadEndlessDifficulty()).toBe('medium');
  });

  it('remembers the last pick under its own key', () => {
    for (const difficulty of DIFFICULTIES) {
      saveEndlessDifficulty(difficulty);
      expect(loadEndlessDifficulty()).toBe(difficulty);
    }
    expect([...storage.items.keys()]).toEqual([DIFFICULTY_KEY]);
  });

  it('falls back to the default for anything it does not recognise', () => {
    for (const raw of ['"insane"', 'hard', '{not json', 'null', '2', '{"difficulty":"hard"}']) {
      storage.setItem(DIFFICULTY_KEY, raw);
      expect(loadEndlessDifficulty()).toBe(DEFAULT_DIFFICULTY);
    }
    saveEndlessDifficulty('hard');
    saveEndlessDifficulty('insane' as Difficulty);
    expect(loadEndlessDifficulty()).toBe('hard');
  });

  it('survives storage that throws or is missing', () => {
    vi.stubGlobal('localStorage', brokenStorage);
    expect(loadEndlessDifficulty()).toBe(DEFAULT_DIFFICULTY);
    expect(() => saveEndlessDifficulty('hard')).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(loadEndlessDifficulty()).toBe(DEFAULT_DIFFICULTY);
    expect(() => saveEndlessDifficulty('hard')).not.toThrow();
  });
});
