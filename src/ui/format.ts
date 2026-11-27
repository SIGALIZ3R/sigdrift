import { SIM_HZ } from '../types';

const MS_PER_TICK = 1000 / SIM_HZ;

function toMillis(ticks: number): number {
  return Number.isFinite(ticks) ? Math.round(Math.abs(ticks) * MS_PER_TICK) : 0;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Sim ticks to "m:ss.mmm", e.g. "0:07.325". Negative input reads as zero. */
export function formatTime(ticks: number): string {
  const ms = ticks > 0 ? toMillis(ticks) : 0;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor(ms / 1000) % 60;
  return `${minutes}:${pad(seconds, 2)}.${pad(ms % 1000, 3)}`;
}

/** Signed difference in sim ticks to seconds, e.g. "+0.512" or "-1.204". */
export function formatDelta(ticks: number): string {
  const ms = toMillis(ticks);
  const sign = ticks < 0 && ms > 0 ? '-' : '+';
  return `${sign}${Math.floor(ms / 1000)}.${pad(ms % 1000, 3)}`;
}

/** Rounded integer with thousands separators, independent of the browser locale. */
export function formatScore(n: number): string {
  const rounded = Number.isFinite(n) ? Math.round(n) : 0;
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+$)/g, ',');
  return rounded < 0 ? `-${digits}` : digits;
}

const METRES_PER_KM = 1000;

/**
 * A distance along the road: whole metres up to a kilometre ("842 m"), then kilometres to 10 m ("2.41 km").
 * Always rounded down, so a distance is never shown before it has been reached. Negative input reads as zero.
 */
export function formatDistance(m: number): string {
  const metres = Number.isFinite(m) && m > 0 ? m : 0;
  if (metres < METRES_PER_KM) return `${Math.floor(metres)} m`;
  return `${(Math.floor(metres / 10) / 100).toFixed(2)} km`;
}

/** A score multiplier to one decimal, e.g. "x3.4". Anything below 1 (or not a number) reads "x1.0". */
export function formatMultiplier(m: number): string {
  const tenths = Number.isFinite(m) && m > 1 ? Math.floor(m * 10 + 1e-6) : 10;
  return `x${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** The calendar date of an ISO date-time, "2026-11-27", or "" when it is not one. */
export function formatDate(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(T.*)?/.exec(typeof iso === 'string' ? iso : '');
  if (!match) return '';
  // A full date-time (records are stamped with toISOString, in UTC) shows the player's own calendar day: a run set
  // just after midnight must not be listed as yesterday's.
  if (match[2]) {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) {
      const pad = (n: number): string => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }
  }
  return match[1];
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th" ... (11-13 -> "th"). */
export function formatRank(rank: number): string {
  const n = Math.max(0, Math.floor(Number.isFinite(rank) ? rank : 0));
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}
