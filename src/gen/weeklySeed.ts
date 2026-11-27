/**
 * The weekly level is named by its ISO-8601 week in UTC, so every player on Earth gets the same level at the same
 * moment. Only explicit timestamps are used here: the caller supplies "now".
 */

import { GEN_VERSION } from '../types';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const WEEK_ID_PATTERN = /^(\d{4})-W(\d{2})$/;
/** Date.UTC treats years below 100 as 19xx, so week ids that early are rejected instead of silently shifted. */
const MIN_YEAR = 1000;

export interface IsoWeek {
  year: number;
  week: number;
}

/** 0 for Monday .. 6 for Sunday. */
function isoWeekday(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

/** The ISO week-year is the calendar year of the week's Thursday. */
export function isoWeekOf(date: Date): IsoWeek {
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (Number.isNaN(dayStart)) throw new RangeError('isoWeekOf: invalid date');
  const thursday = dayStart + (3 - isoWeekday(date)) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / WEEK_MS);
  return { year, week };
}

export function weekId(year: number, week: number): string {
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

/** 28 December always falls in the last ISO week of its year. */
export function weeksInIsoYear(year: number): number {
  return isoWeekOf(new Date(Date.UTC(year, 11, 28))).week;
}

/** Null for anything that is not a real week, including W53 of a 52-week year. */
export function parseWeekId(id: string): IsoWeek | null {
  const match = WEEK_ID_PATTERN.exec(id);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (year < MIN_YEAR || week < 1 || week > weeksInIsoYear(year)) return null;
  return { year, week };
}

export function currentWeekId(now: Date): string {
  const { year, week } = isoWeekOf(now);
  return weekId(year, week);
}

/** UTC midnight of the Monday that starts the week. 4 January is always in week 1. */
function mondayOf(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  return jan4 - isoWeekday(new Date(jan4)) * DAY_MS + (week - 1) * WEEK_MS;
}

export function shiftWeek(id: string, delta: number): string {
  const parsed = parseWeekId(id);
  if (!parsed) throw new RangeError(`shiftWeek: "${id}" is not a week id`);
  const shifted = isoWeekOf(new Date(mondayOf(parsed.year, parsed.week) + delta * WEEK_MS));
  return weekId(shifted.year, shifted.week);
}

/** The `count` weeks before `id`, most recent first. */
export function previousWeekIds(id: string, count: number): string[] {
  const ids: string[] = [];
  for (let back = 1; back <= count; back++) ids.push(shiftWeek(id, -back));
  return ids;
}

export function seedForWeek(id: string, genVersion: number = GEN_VERSION): string {
  return `sigdrift|gen-v${genVersion}|${id}`;
}
