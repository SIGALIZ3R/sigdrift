import { PHYSICS_VERSION } from '../types';
import type { BestRecord, Difficulty, EndlessBest, Settings } from '../types';

const KEY_PREFIX = 'sigdrift:';
const SETTINGS_KEY = `${KEY_PREFIX}settings`;
const BEST_KEY_PREFIX = `${KEY_PREFIX}best:`;
const ENDLESS_BEST_KEY_PREFIX = `${KEY_PREFIX}endlessBest:`;
const ENDLESS_DIFFICULTY_KEY = `${KEY_PREFIX}endlessDifficulty`;

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  quality: 'high',
  volume: 0.7,
  assist: true,
  reducedFlash: false,
  muted: false,
});

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
export const DEFAULT_DIFFICULTY: Difficulty = 'medium';

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDifficulty(value: unknown): value is Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard';
}

/** Storage can be missing or throw (private mode, blocked cookies, quota): every access goes through here. */
function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function parseSettings(raw: unknown, fallback: Settings): Settings {
  const fields = isFields(raw) ? raw : {};
  const { quality, volume, assist, reducedFlash, muted } = fields;
  return {
    quality: quality === 'low' || quality === 'high' ? quality : fallback.quality,
    volume:
      typeof volume === 'number' && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : fallback.volume,
    assist: typeof assist === 'boolean' ? assist : fallback.assist,
    reducedFlash: typeof reducedFlash === 'boolean' ? reducedFlash : fallback.reducedFlash,
    muted: typeof muted === 'boolean' ? muted : fallback.muted,
  };
}

function parseBest(raw: unknown): BestRecord | null {
  if (!isFields(raw)) return null;
  const { ticks, driftScore, physicsVersion } = raw;
  if (typeof ticks !== 'number' || !Number.isInteger(ticks) || ticks <= 0) return null;
  if (typeof driftScore !== 'number' || !Number.isFinite(driftScore)) return null;
  if (typeof physicsVersion !== 'number' || !Number.isFinite(physicsVersion)) return null;
  return { ticks, driftScore, physicsVersion };
}

function parseEndlessBest(raw: unknown): EndlessBest | null {
  if (!isFields(raw)) return null;
  const { distance, driftScore, physicsVersion } = raw;
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance <= 0) return null;
  if (typeof driftScore !== 'number' || !Number.isFinite(driftScore)) return null;
  if (typeof physicsVersion !== 'number' || !Number.isFinite(physicsVersion)) return null;
  return { distance, driftScore, physicsVersion };
}

/** Stored settings with every missing or malformed field replaced by its default. Always a fresh object. */
export function loadSettings(): Settings {
  // Until the player chooses, follow the system's reduced-motion preference.
  const fallback: Settings = { ...DEFAULT_SETTINGS, reducedFlash: prefersReducedMotion() };
  return parseSettings(readJson(SETTINGS_KEY), fallback);
}

export function saveSettings(s: Settings): void {
  writeJson(SETTINGS_KEY, parseSettings(s, DEFAULT_SETTINGS));
}

/** Best run for a level, or null when none is stored or it was set under different physics. */
export function loadBest(levelId: string): BestRecord | null {
  const best = parseBest(readJson(BEST_KEY_PREFIX + levelId));
  return best !== null && best.physicsVersion === PHYSICS_VERSION ? best : null;
}

/**
 * Stores `rec` if it beats the stored time (or none exists). Returns whether it was stored.
 * A record from another physics version is refused: it could never be read back or compared.
 */
export function saveBest(levelId: string, rec: BestRecord): boolean {
  const candidate = parseBest(rec);
  if (candidate === null || candidate.physicsVersion !== PHYSICS_VERSION) return false;
  const current = loadBest(levelId);
  if (current !== null && current.ticks <= candidate.ticks) return false;
  return writeJson(BEST_KEY_PREFIX + levelId, candidate);
}

/** Longest endless run on a difficulty, or null when none is stored or it was set under different physics. */
export function loadEndlessBest(difficulty: Difficulty): EndlessBest | null {
  if (!isDifficulty(difficulty)) return null;
  const best = parseEndlessBest(readJson(ENDLESS_BEST_KEY_PREFIX + difficulty));
  return best !== null && best.physicsVersion === PHYSICS_VERSION ? best : null;
}

/**
 * Stores `rec` if it went further than the stored run (or none exists). Returns whether it was stored.
 * Like saveBest, a record from another physics version is refused.
 */
export function saveEndlessBest(difficulty: Difficulty, rec: EndlessBest): boolean {
  if (!isDifficulty(difficulty)) return false;
  const candidate = parseEndlessBest(rec);
  if (candidate === null || candidate.physicsVersion !== PHYSICS_VERSION) return false;
  const current = loadEndlessBest(difficulty);
  if (current !== null && current.distance >= candidate.distance) return false;
  return writeJson(ENDLESS_BEST_KEY_PREFIX + difficulty, candidate);
}

/** The difficulty last picked on the title screen. */
export function loadEndlessDifficulty(): Difficulty {
  const stored = readJson(ENDLESS_DIFFICULTY_KEY);
  return isDifficulty(stored) ? stored : DEFAULT_DIFFICULTY;
}

export function saveEndlessDifficulty(difficulty: Difficulty): void {
  if (isDifficulty(difficulty)) writeJson(ENDLESS_DIFFICULTY_KEY, difficulty);
}
