/**
 * Everything SigDRIFT keeps in localStorage. Keys are prefixed "sigdrift:":
 *   sigdrift:settings                 Settings
 *   sigdrift:run:<trackId>            RunRecords for a weekly run ("2026-W48") or a level ("L1".."L5")
 *   sigdrift:endless:<difficulty>     EndlessRecords
 *   sigdrift:endlessDifficulty        last difficulty picked
 *   sigdrift:howToSeen                the HOW TO PLAY cards were shown once
 *   sigdrift:completedLevels          ids of levels ever finished (unlocks cars; survives physics changes)
 *   sigdrift:car                      the car picked in the garage
 * Keys from earlier versions ("sigdrift:best:*", "sigdrift:endlessBest:*") are simply never read.
 * Everything loaded is validated; records from another PHYSICS_VERSION are dropped (and replaced on the next save).
 */
import { DEFAULT_CAR, carsUnlockedBy, isCarId } from '../sim/cars';
import type { CarId } from '../sim/cars';
import { PHYSICS_VERSION } from '../types';
import type { Difficulty, EndlessRecord, EndlessRecords, RunRecord, RunRecords, Settings } from '../types';

const KEY_PREFIX = 'sigdrift:';
const SETTINGS_KEY = `${KEY_PREFIX}settings`;
const RUN_KEY_PREFIX = `${KEY_PREFIX}run:`;
const ENDLESS_KEY_PREFIX = `${KEY_PREFIX}endless:`;
const ENDLESS_DIFFICULTY_KEY = `${KEY_PREFIX}endlessDifficulty`;
const HOWTO_KEY = `${KEY_PREFIX}howToSeen`;
const COMPLETED_KEY = `${KEY_PREFIX}completedLevels`;
const CAR_KEY = `${KEY_PREFIX}car`;
/** Level ids look like "L1".."L5"; anything else in the completed list is ignored. */
const LEVEL_ID = /^L\d{1,2}$/;

/** How many scores a high score table keeps. */
export const HIGH_SCORE_SLOTS = 5;

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  quality: 'high',
  volume: 0.7,
  musicVolume: 0.7,
  assist: true,
  reducedFlash: false,
  muted: false,
});

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
export const DEFAULT_DIFFICULTY: Difficulty = 'medium';

/** What saveRunRecord did with a run. */
export interface RunSaveResult {
  /** The run is the fastest stored for this track (also true for the first ever finish). */
  newBestTime: boolean;
  /** The run beat every stored score (also true for the first scoring run). */
  newHighScore: boolean;
  /** Its place in the top five, 1..5, or null when it did not make the table. */
  rank: number | null;
  /** Present (true) only when storage could not be written: nothing was saved, whatever the score. */
  failed?: true;
}

export interface EndlessSaveResult {
  newBestDistance: boolean;
  newHighScore: boolean;
  rank: number | null;
  /** See RunSaveResult.failed. */
  failed?: true;
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isDifficulty(value: unknown): value is Difficulty {
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

// ---- Settings -------------------------------------------------------------------------------------------------

/** A finite number clamped to 0..1, or the fallback. */
function unit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function parseSettings(raw: unknown, fallback: Settings): Settings {
  const fields = isFields(raw) ? raw : {};
  const { quality, volume, musicVolume, assist, reducedFlash, muted } = fields;
  return {
    quality: quality === 'low' || quality === 'high' ? quality : fallback.quality,
    volume: unit(volume, fallback.volume),
    musicVolume: unit(musicVolume, fallback.musicVolume),
    assist: typeof assist === 'boolean' ? assist : fallback.assist,
    reducedFlash: typeof reducedFlash === 'boolean' ? reducedFlash : fallback.reducedFlash,
    muted: typeof muted === 'boolean' ? muted : fallback.muted,
  };
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

// ---- Record validation ----------------------------------------------------------------------------------------

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseRunRecord(raw: unknown): RunRecord | null {
  if (!isFields(raw)) return null;
  const { ticks, score, date, physicsVersion } = raw;
  if (!isCount(ticks) || ticks <= 0) return null;
  if (!isAmount(score)) return null;
  if (typeof date !== 'string' || date.length > 64) return null;
  if (physicsVersion !== PHYSICS_VERSION) return null;
  return { ticks, score, date, physicsVersion };
}

function parseEndlessRecord(raw: unknown): EndlessRecord | null {
  if (!isFields(raw)) return null;
  const { distance, score, ticks, date, physicsVersion } = raw;
  if (!isAmount(distance)) return null;
  if (!isAmount(score)) return null;
  if (!isCount(ticks)) return null;
  if (typeof date !== 'string' || date.length > 64) return null;
  if (physicsVersion !== PHYSICS_VERSION) return null;
  return { distance, score, ticks, date, physicsVersion };
}

/** Valid entries only, highest score first (stable for equal scores), at most HIGH_SCORE_SLOTS. */
function parseTable<T extends { score: number }>(raw: unknown, parse: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const table: T[] = [];
  for (const entry of raw) {
    const parsed = parse(entry);
    if (parsed) table.push(parsed);
  }
  table.sort((a, b) => b.score - a.score);
  return table.slice(0, HIGH_SCORE_SLOTS);
}

/**
 * Where a score lands in a table sorted highest first: after every entry it does not beat (an equal score set
 * earlier keeps its place). Returns the 0-based index, which may be >= HIGH_SCORE_SLOTS.
 */
export function insertionIndex(table: readonly { score: number }[], score: number): number {
  let index = 0;
  while (index < table.length && table[index].score >= score) index++;
  return index;
}

function insert<T extends { score: number }>(table: readonly T[], entry: T): { table: T[]; rank: number | null } {
  const index = insertionIndex(table, entry.score);
  if (index >= HIGH_SCORE_SLOTS) return { table: table.slice(0, HIGH_SCORE_SLOTS), rank: null };
  const next = table.slice();
  next.splice(index, 0, entry);
  return { table: next.slice(0, HIGH_SCORE_SLOTS), rank: index + 1 };
}

function beatsTop(table: readonly { score: number }[], score: number): boolean {
  if (score <= 0) return false;
  return table.length === 0 || score > table[0].score;
}

// ---- Weekly runs and levels -----------------------------------------------------------------------------------

function runKey(trackId: string): string {
  return RUN_KEY_PREFIX + trackId;
}

/** The stored fastest time and top five for a weekly run or level. Always fresh objects; never throws. */
export function loadRunRecords(trackId: string): RunRecords {
  const raw = readJson(runKey(trackId));
  if (!isFields(raw)) return { bestTime: null, highScores: [] };
  return { bestTime: parseRunRecord(raw.bestTime), highScores: parseTable(raw.highScores, parseRunRecord) };
}

/**
 * Records a finished run: it becomes the best time when it is faster than the stored one (or none exists), and goes
 * into the top five when its score is high enough. An invalid record (or one from other physics) changes nothing.
 */
export function saveRunRecord(trackId: string, rec: RunRecord): RunSaveResult {
  const candidate = parseRunRecord(rec);
  if (!candidate) return { newBestTime: false, newHighScore: false, rank: null };
  const current = loadRunRecords(trackId);
  const newBestTime = current.bestTime === null || candidate.ticks < current.bestTime.ticks;
  const newHighScore = beatsTop(current.highScores, candidate.score);
  const placed = insert(current.highScores, candidate);
  const next: RunRecords = { bestTime: newBestTime ? candidate : current.bestTime, highScores: placed.table };
  if (!writeJson(runKey(trackId), next)) return { newBestTime: false, newHighScore: false, rank: null, failed: true };
  return { newBestTime, newHighScore, rank: placed.rank };
}

/** How many of the given tracks have a finished run stored. */
export function countCompleted(trackIds: readonly string[]): number {
  let count = 0;
  for (const id of trackIds) if (loadRunRecords(id).bestTime !== null) count++;
  return count;
}

// ---- Endless --------------------------------------------------------------------------------------------------

function emptyEndless(): EndlessRecords {
  return { bestDistance: null, highScores: [] };
}

/** The stored furthest run and top five for a difficulty. Always fresh objects; never throws. */
export function loadEndlessRecords(difficulty: Difficulty): EndlessRecords {
  if (!isDifficulty(difficulty)) return emptyEndless();
  const raw = readJson(ENDLESS_KEY_PREFIX + difficulty);
  if (!isFields(raw)) return emptyEndless();
  return {
    bestDistance: parseEndlessRecord(raw.bestDistance),
    highScores: parseTable(raw.highScores, parseEndlessRecord),
  };
}

/** Like saveRunRecord, with "further" in place of "faster". A zero distance never counts as a best distance. */
export function saveEndlessRecord(difficulty: Difficulty, rec: EndlessRecord): EndlessSaveResult {
  const none: EndlessSaveResult = { newBestDistance: false, newHighScore: false, rank: null };
  if (!isDifficulty(difficulty)) return none;
  const candidate = parseEndlessRecord(rec);
  if (!candidate) return none;
  const current = loadEndlessRecords(difficulty);
  const newBestDistance =
    candidate.distance > 0 && (current.bestDistance === null || candidate.distance > current.bestDistance.distance);
  const newHighScore = beatsTop(current.highScores, candidate.score);
  const placed = insert(current.highScores, candidate);
  const next: EndlessRecords = {
    bestDistance: newBestDistance ? candidate : current.bestDistance,
    highScores: placed.table,
  };
  if (!writeJson(ENDLESS_KEY_PREFIX + difficulty, next)) return { ...none, failed: true };
  return { newBestDistance, newHighScore, rank: placed.rank };
}

/** The furthest endless run on any difficulty, or null. */
export function bestEndlessOverall(): { difficulty: Difficulty; record: EndlessRecord } | null {
  let best: { difficulty: Difficulty; record: EndlessRecord } | null = null;
  for (const difficulty of DIFFICULTIES) {
    const record = loadEndlessRecords(difficulty).bestDistance;
    if (record && (!best || record.distance > best.record.distance)) best = { difficulty, record };
  }
  return best;
}

/** The difficulty last picked. */
export function loadEndlessDifficulty(): Difficulty {
  const stored = readJson(ENDLESS_DIFFICULTY_KEY);
  return isDifficulty(stored) ? stored : DEFAULT_DIFFICULTY;
}

export function saveEndlessDifficulty(difficulty: Difficulty): void {
  if (isDifficulty(difficulty)) writeJson(ENDLESS_DIFFICULTY_KEY, difficulty);
}

// ---- First-time help ------------------------------------------------------------------------------------------

/** Whether the HOW TO PLAY cards have been shown (they open by themselves the first time PLAY is pressed). */
export function loadHowToSeen(): boolean {
  return readJson(HOWTO_KEY) === true;
}

export function saveHowToSeen(seen = true): void {
  writeJson(HOWTO_KEY, seen);
}

// ---- Garage ---------------------------------------------------------------------------------------------------

/**
 * Every level ever finished: the ones marked by markLevelCompleted plus any with a stored time. Kept apart from the
 * records so that a physics change, which drops the records, never locks a car again.
 */
export function loadCompletedLevels(): string[] {
  const raw = readJson(COMPLETED_KEY);
  const ids = new Set<string>();
  if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string' && LEVEL_ID.test(id)) ids.add(id);
  for (let n = 1; n <= 5; n++) if (loadRunRecords(`L${n}`).bestTime !== null) ids.add(`L${n}`);
  return [...ids].sort();
}

/** Notes that `levelId` was finished. Returns the cars this finish unlocked (usually none). */
export function markLevelCompleted(levelId: string): CarId[] {
  if (!LEVEL_ID.test(levelId)) return [];
  const before = loadCompletedLevels();
  if (before.includes(levelId)) return [];
  const after = [...before, levelId].sort();
  if (!writeJson(COMPLETED_KEY, after)) return [];
  const had = new Set(carsUnlockedBy(before));
  return carsUnlockedBy(after).filter((id) => !had.has(id));
}

/** The cars the player may drive, in garage order. */
export function unlockedCarIds(): CarId[] {
  return carsUnlockedBy(loadCompletedLevels());
}

/** The car picked in the garage, or the stock car when none was picked or the pick is not unlocked. */
export function loadCar(): CarId {
  const stored = readJson(CAR_KEY);
  return isCarId(stored) && unlockedCarIds().includes(stored) ? stored : DEFAULT_CAR;
}

export function saveCar(id: CarId): void {
  if (isCarId(id)) writeJson(CAR_KEY, id);
}
