import { describe, it, expect } from 'vitest';
import { DATE_PRESETS, isDatePreset, resolveDatePreset, DatePreset } from './date-presets.js';

/** Local-time `now` at midday (month is 1-based here for readability). */
const at = (y: number, m: number, d: number, hour = 12) => new Date(y, m - 1, d, hour, 30);

const resolve = (preset: DatePreset, now: Date) => resolveDatePreset(preset, now);

describe('isDatePreset', () => {
  it.each(DATE_PRESETS)('accepts %s', (preset) => {
    expect(isDatePreset(preset)).toBe(true);
  });

  it.each(['', 'Today', 'last week', 'tomorrow', 7, null, undefined])('rejects %s', (bad) => {
    expect(isDatePreset(bad)).toBe(false);
  });
});

describe('resolveDatePreset', () => {
  // 2025-01-15 is a Wednesday.
  const midWeek = at(2025, 1, 15);

  it('resolves every preset on an ordinary mid-week day', () => {
    expect(resolve('today', midWeek)).toEqual({ start: 20250115, end: 20250115 });
    expect(resolve('yesterday', midWeek)).toEqual({ start: 20250114, end: 20250114 });
    expect(resolve('this_week', midWeek)).toEqual({ start: 20250113, end: 20250119 });
    expect(resolve('last_week', midWeek)).toEqual({ start: 20250106, end: 20250112 });
    expect(resolve('this_month', midWeek)).toEqual({ start: 20250101, end: 20250131 });
    expect(resolve('last_month', midWeek)).toEqual({ start: 20241201, end: 20241231 });
    expect(resolve('this_year', midWeek)).toEqual({ start: 20250101, end: 20251231 });
    expect(resolve('year_to_date', midWeek)).toEqual({ start: 20250101, end: 20250115 });
  });

  it('ignores the time of day', () => {
    expect(resolve('today', at(2025, 1, 15, 0))).toEqual({ start: 20250115, end: 20250115 });
    expect(resolve('today', new Date(2025, 0, 15, 23, 59, 59))).toEqual({ start: 20250115, end: 20250115 });
  });

  describe('week boundaries (weeks start on Monday)', () => {
    it('treats Monday as the first day of this_week', () => {
      // 2025-01-13 is a Monday
      expect(resolve('this_week', at(2025, 1, 13))).toEqual({ start: 20250113, end: 20250119 });
      expect(resolve('last_week', at(2025, 1, 13))).toEqual({ start: 20250106, end: 20250112 });
    });

    it('treats Sunday as the last day of this_week', () => {
      // 2025-01-19 is a Sunday
      expect(resolve('this_week', at(2025, 1, 19))).toEqual({ start: 20250113, end: 20250119 });
      expect(resolve('last_week', at(2025, 1, 19))).toEqual({ start: 20250106, end: 20250112 });
    });

    it('moves to the next week the day after Sunday', () => {
      // 2025-01-20 is the following Monday
      expect(resolve('this_week', at(2025, 1, 20))).toEqual({ start: 20250120, end: 20250126 });
      expect(resolve('last_week', at(2025, 1, 20))).toEqual({ start: 20250113, end: 20250119 });
    });

    it('crosses a month boundary', () => {
      // 2025-03-01 is a Saturday; its week began on Monday 2025-02-24
      expect(resolve('this_week', at(2025, 3, 1))).toEqual({ start: 20250224, end: 20250302 });
      expect(resolve('last_week', at(2025, 3, 1))).toEqual({ start: 20250217, end: 20250223 });
    });

    it('crosses a year boundary', () => {
      // 2025-01-01 is a Wednesday; its week began on Monday 2024-12-30
      expect(resolve('this_week', at(2025, 1, 1))).toEqual({ start: 20241230, end: 20250105 });
      expect(resolve('last_week', at(2025, 1, 1))).toEqual({ start: 20241223, end: 20241229 });
    });

    it('handles a week that ends in a different year than it started', () => {
      // 2024-12-31 is a Tuesday
      expect(resolve('this_week', at(2024, 12, 31))).toEqual({ start: 20241230, end: 20250105 });
    });
  });

  describe('day boundaries', () => {
    it('yesterday crosses a month boundary', () => {
      expect(resolve('yesterday', at(2025, 3, 1))).toEqual({ start: 20250228, end: 20250228 });
    });

    it('yesterday crosses a year boundary', () => {
      expect(resolve('yesterday', at(2025, 1, 1))).toEqual({ start: 20241231, end: 20241231 });
    });

    it('yesterday on a leap day boundary', () => {
      expect(resolve('yesterday', at(2024, 3, 1))).toEqual({ start: 20240229, end: 20240229 });
    });
  });

  describe('month boundaries', () => {
    it('this_month on the first day', () => {
      expect(resolve('this_month', at(2025, 5, 1))).toEqual({ start: 20250501, end: 20250531 });
    });

    it('this_month on the last day of a 30-day month', () => {
      expect(resolve('this_month', at(2025, 4, 30))).toEqual({ start: 20250401, end: 20250430 });
    });

    it('this_month in a non-leap February', () => {
      expect(resolve('this_month', at(2025, 2, 10))).toEqual({ start: 20250201, end: 20250228 });
    });

    it('this_month in a leap-year February', () => {
      expect(resolve('this_month', at(2024, 2, 10))).toEqual({ start: 20240201, end: 20240229 });
    });

    it('last_month from March is the end of February', () => {
      expect(resolve('last_month', at(2025, 3, 15))).toEqual({ start: 20250201, end: 20250228 });
      expect(resolve('last_month', at(2024, 3, 15))).toEqual({ start: 20240201, end: 20240229 });
    });

    it('last_month from January is December of the previous year', () => {
      expect(resolve('last_month', at(2025, 1, 31))).toEqual({ start: 20241201, end: 20241231 });
    });

    it('last_month from a 31-day month into a 30-day month', () => {
      expect(resolve('last_month', at(2025, 5, 31))).toEqual({ start: 20250401, end: 20250430 });
    });
  });

  describe('year boundaries', () => {
    it('this_year and year_to_date on January 1', () => {
      expect(resolve('this_year', at(2025, 1, 1))).toEqual({ start: 20250101, end: 20251231 });
      expect(resolve('year_to_date', at(2025, 1, 1))).toEqual({ start: 20250101, end: 20250101 });
    });

    it('this_year and year_to_date on December 31', () => {
      expect(resolve('this_year', at(2025, 12, 31))).toEqual({ start: 20250101, end: 20251231 });
      expect(resolve('year_to_date', at(2025, 12, 31))).toEqual({ start: 20250101, end: 20251231 });
    });

    it('year_to_date ends today, not at the end of the year', () => {
      expect(resolve('year_to_date', at(2025, 7, 4))).toEqual({ start: 20250101, end: 20250704 });
    });
  });

  it('always returns start <= end', () => {
    for (let dayOffset = 0; dayOffset < 800; dayOffset += 3) {
      const now = new Date(2024, 0, 1 + dayOffset, 12);
      for (const preset of DATE_PRESETS) {
        const { start, end } = resolve(preset, now);
        expect(start).toBeLessThanOrEqual(end);
      }
    }
  });

  it('throws on an unknown preset', () => {
    expect(() => resolveDatePreset('someday' as DatePreset, midWeek)).toThrow(/Unknown date preset/);
  });
});
