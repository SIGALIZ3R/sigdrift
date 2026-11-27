import { describe, expect, it } from 'vitest';
import {
  currentWeekId,
  isoWeekOf,
  parseWeekId,
  previousWeekIds,
  seedForWeek,
  shiftWeek,
  weekId,
  weeksInIsoYear,
} from '../../src/gen/weeklySeed';
import { GEN_VERSION } from '../../src/types';

function utc(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

describe('isoWeekOf', () => {
  it.each([
    ['2026-11-27', 2026, 48],
    ['2026-01-01', 2026, 1],
    ['2024-02-29', 2024, 9],
    // The week belongs to the year that holds its Thursday.
    ['2018-12-31', 2019, 1],
    ['2024-12-30', 2025, 1],
    ['2008-12-29', 2009, 1],
    ['2023-01-01', 2022, 52],
    // 53-week years.
    ['2027-01-01', 2026, 53],
    ['2026-12-28', 2026, 53],
    ['2027-01-03', 2026, 53],
    ['2027-01-04', 2027, 1],
    ['2020-12-31', 2020, 53],
    ['2021-01-03', 2020, 53],
    ['2021-01-04', 2021, 1],
    ['2016-01-03', 2015, 53],
    ['2010-01-03', 2009, 53],
  ])('%s is %i-W%i', (date, year, week) => {
    expect(isoWeekOf(utc(date))).toEqual({ year, week });
  });

  it('changes week at Monday 00:00 UTC, whatever the local time zone', () => {
    expect(isoWeekOf(new Date('2026-11-29T23:59:59.999Z'))).toEqual({ year: 2026, week: 48 });
    expect(isoWeekOf(new Date('2026-11-30T00:00:00.000Z'))).toEqual({ year: 2026, week: 49 });
    // The same instant written with an offset is still Sunday in UTC.
    expect(isoWeekOf(new Date('2026-11-30T05:00:00+09:00'))).toEqual({ year: 2026, week: 48 });
  });

  it('rejects an invalid date', () => {
    expect(() => isoWeekOf(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('weeksInIsoYear', () => {
  it('finds exactly the 53-week years between 2000 and 2040', () => {
    const long: number[] = [];
    for (let year = 2000; year <= 2040; year++) {
      const weeks = weeksInIsoYear(year);
      expect([52, 53]).toContain(weeks);
      if (weeks === 53) long.push(year);
    }
    expect(long).toEqual([2004, 2009, 2015, 2020, 2026, 2032, 2037]);
  });
});

describe('week ids', () => {
  it('formats with a zero-padded week', () => {
    expect(weekId(2026, 48)).toBe('2026-W48');
    expect(weekId(2027, 1)).toBe('2027-W01');
  });

  it('parses what it formats', () => {
    expect(parseWeekId('2026-W48')).toEqual({ year: 2026, week: 48 });
    expect(parseWeekId('2027-W01')).toEqual({ year: 2027, week: 1 });
    expect(parseWeekId('2026-W53')).toEqual({ year: 2026, week: 53 });
  });

  it.each(['2026-W00', '2025-W53', '2026-W54', '2026-W5', '2026W48', '2026-w48', ' 2026-W48', '2026-W48 ', '', 'week'])(
    'rejects %j',
    (id) => {
      expect(parseWeekId(id)).toBeNull();
    },
  );

  it('names the current week from an explicit clock', () => {
    expect(currentWeekId(new Date('2026-11-27T12:00:00Z'))).toBe('2026-W48');
    expect(currentWeekId(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
  });
});

describe('shiftWeek', () => {
  it('crosses year boundaries in both directions', () => {
    expect(shiftWeek('2026-W48', 1)).toBe('2026-W49');
    expect(shiftWeek('2026-W53', 1)).toBe('2027-W01');
    expect(shiftWeek('2027-W01', -1)).toBe('2026-W53');
    expect(shiftWeek('2025-W52', 1)).toBe('2026-W01');
    expect(shiftWeek('2026-W01', -1)).toBe('2025-W52');
    expect(shiftWeek('2026-W48', 52)).toBe('2027-W47');
    expect(shiftWeek('2026-W48', 0)).toBe('2026-W48');
  });

  it('round-trips over several years', () => {
    for (let delta = -400; delta <= 400; delta += 7) {
      const there = shiftWeek('2026-W48', delta);
      expect(parseWeekId(there)).not.toBeNull();
      expect(shiftWeek(there, -delta)).toBe('2026-W48');
    }
  });

  it('visits every week exactly once when stepping forwards', () => {
    let id = '2024-W01';
    const seen = new Set<string>([id]);
    for (let step = 0; step < 520; step++) {
      const next = shiftWeek(id, 1);
      const a = parseWeekId(id)!;
      const b = parseWeekId(next)!;
      const sameYear = b.year === a.year && b.week === a.week + 1;
      const newYear = b.year === a.year + 1 && b.week === 1 && a.week === weeksInIsoYear(a.year);
      expect(sameYear || newYear).toBe(true);
      seen.add(next);
      id = next;
    }
    expect(seen.size).toBe(521);
  });

  it('refuses something that is not a week id', () => {
    expect(() => shiftWeek('2025-W53', 1)).toThrow(RangeError);
  });
});

describe('previousWeekIds', () => {
  it('lists earlier weeks, most recent first, without the given week', () => {
    expect(previousWeekIds('2027-W02', 4)).toEqual(['2027-W01', '2026-W53', '2026-W52', '2026-W51']);
    expect(previousWeekIds('2026-W48', 0)).toEqual([]);
  });
});

describe('seedForWeek', () => {
  it('builds the seed from the generator version and the week', () => {
    expect(seedForWeek('2026-W48')).toBe(`sigdrift|gen-v${GEN_VERSION}|2026-W48`);
    expect(seedForWeek('2026-W48', 7)).toBe('sigdrift|gen-v7|2026-W48');
  });
});
