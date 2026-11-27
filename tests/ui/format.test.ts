import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDelta,
  formatDistance,
  formatMultiplier,
  formatRank,
  formatScore,
  formatTime,
} from '../../src/ui/format';

describe('formatTime', () => {
  it('formats ticks at 120 Hz as m:ss.mmm', () => {
    expect(formatTime(0)).toBe('0:00.000');
    expect(formatTime(879)).toBe('0:07.325');
    expect(formatTime(120)).toBe('0:01.000');
    expect(formatTime(60 * 120)).toBe('1:00.000');
    expect(formatTime(83 * 120 + 57)).toBe('1:23.475');
  });

  it('rounds a tick to the nearest millisecond', () => {
    expect(formatTime(1)).toBe('0:00.008');
    expect(formatTime(2)).toBe('0:00.017');
    expect(formatTime(119)).toBe('0:00.992');
  });

  it('keeps counting minutes past an hour', () => {
    expect(formatTime(75 * 60 * 120 + 30)).toBe('75:00.250');
  });

  it('reads negative and non-finite input as zero', () => {
    expect(formatTime(-50)).toBe('0:00.000');
    expect(formatTime(NaN)).toBe('0:00.000');
    expect(formatTime(Infinity)).toBe('0:00.000');
  });
});

describe('formatDelta', () => {
  it('always carries a sign', () => {
    expect(formatDelta(60)).toBe('+0.500');
    expect(formatDelta(-144)).toBe('-1.200');
    expect(formatDelta(0)).toBe('+0.000');
  });

  it('shows whole seconds without a minutes part', () => {
    expect(formatDelta(61 * 120 + 30)).toBe('+61.250');
    expect(formatDelta(-(61 * 120 + 30))).toBe('-61.250');
  });

  it('rounds to the nearest millisecond', () => {
    expect(formatDelta(1)).toBe('+0.008');
    expect(formatDelta(-2)).toBe('-0.017');
  });

  it('does not show a negative zero', () => {
    expect(formatDelta(-0)).toBe('+0.000');
    expect(formatDelta(NaN)).toBe('+0.000');
  });
});

describe('formatScore', () => {
  it('rounds to an integer', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(12.4)).toBe('12');
    expect(formatScore(12.5)).toBe('13');
    expect(formatScore(999.6)).toBe('1,000');
  });

  it('groups thousands', () => {
    expect(formatScore(999)).toBe('999');
    expect(formatScore(1000)).toBe('1,000');
    expect(formatScore(12345)).toBe('12,345');
    expect(formatScore(1234567)).toBe('1,234,567');
  });

  it('handles negative and non-finite input', () => {
    expect(formatScore(-1234.2)).toBe('-1,234');
    expect(formatScore(-0.2)).toBe('0');
    expect(formatScore(NaN)).toBe('0');
    expect(formatScore(Infinity)).toBe('0');
  });
});

describe('formatDistance', () => {
  it('shows whole metres below a kilometre', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(7)).toBe('7 m');
    expect(formatDistance(842)).toBe('842 m');
    expect(formatDistance(999)).toBe('999 m');
  });

  it('shows kilometres to two decimals from a kilometre up', () => {
    expect(formatDistance(1000)).toBe('1.00 km');
    expect(formatDistance(2410)).toBe('2.41 km');
    expect(formatDistance(12345)).toBe('12.34 km');
    expect(formatDistance(100000)).toBe('100.00 km');
  });

  it('never shows a distance that has not been reached yet', () => {
    expect(formatDistance(841.99)).toBe('841 m');
    expect(formatDistance(999.99)).toBe('999 m');
    expect(formatDistance(2419.99)).toBe('2.41 km');
    expect(formatDistance(1009.99)).toBe('1.00 km');
  });

  it('is exact on every 10 m step, whatever the float division does', () => {
    for (let metres = 1000; metres <= 30000; metres += 10) {
      const expected = `${Math.floor(metres / 1000)}.${String((metres % 1000) / 10).padStart(2, '0')} km`;
      expect(formatDistance(metres)).toBe(expected);
    }
  });

  it('reads negative and non-finite input as zero', () => {
    expect(formatDistance(-5)).toBe('0 m');
    expect(formatDistance(-0)).toBe('0 m');
    expect(formatDistance(NaN)).toBe('0 m');
    expect(formatDistance(Infinity)).toBe('0 m');
  });
});

describe('formatMultiplier', () => {
  it('shows one decimal, rounded down, with an x', () => {
    expect(formatMultiplier(1)).toBe('x1.0');
    expect(formatMultiplier(3.4)).toBe('x3.4');
    expect(formatMultiplier(3.49)).toBe('x3.4');
    expect(formatMultiplier(10)).toBe('x10.0');
    expect(formatMultiplier(2.3)).toBe('x2.3');
  });

  it('reads anything below 1 or not a number as x1.0', () => {
    expect(formatMultiplier(0)).toBe('x1.0');
    expect(formatMultiplier(-4)).toBe('x1.0');
    expect(formatMultiplier(NaN)).toBe('x1.0');
    expect(formatMultiplier(Infinity)).toBe('x1.0');
  });
});

describe('formatDate', () => {
  it('keeps the calendar date of an ISO date-time', () => {
    expect(formatDate('2026-11-27T12:34:56.000Z')).toBe('2026-11-27');
    expect(formatDate('2026-01-02')).toBe('2026-01-02');
  });

  it('shows a date-time stamp on the player’s own calendar day', () => {
    // Half past midnight local time is the previous day in UTC east of Greenwich.
    expect(formatDate(new Date(2026, 10, 28, 0, 30).toISOString())).toBe('2026-11-28');
    expect(formatDate(new Date(2026, 10, 27, 23, 50).toISOString())).toBe('2026-11-27');
  });

  it('is empty for anything else', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate('yesterday')).toBe('');
    expect(formatDate(5 as unknown as string)).toBe('');
  });
});

describe('formatRank', () => {
  it('adds English ordinal suffixes', () => {
    expect([1, 2, 3, 4, 5, 11, 12, 13, 21, 22, 23, 101].map(formatRank)).toEqual([
      '1st', '2nd', '3rd', '4th', '5th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st',
    ]);
  });
});
