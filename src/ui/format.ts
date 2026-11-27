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
