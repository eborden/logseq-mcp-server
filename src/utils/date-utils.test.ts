import { describe, it, expect } from 'vitest';
import {
  parseLogseqDate,
  formatLogseqDate,
  addDays,
  getDateRange,
  isWeekend,
  getWeekNumber
} from './date-utils.js';

describe('Date Utils', () => {
  describe('parseLogseqDate', () => {
    it('should parse LogSeq date format', () => {
      const result = parseLogseqDate(20251120);
      expect(result).toBeInstanceOf(Date);
      expect(result.getFullYear()).toBe(2025);
      expect(result.getMonth()).toBe(10); // November (0-indexed)
      expect(result.getDate()).toBe(20);
    });

    it('should handle dates at year boundaries', () => {
      const result = parseLogseqDate(20250101);
      expect(result.getFullYear()).toBe(2025);
      expect(result.getMonth()).toBe(0); // January
      expect(result.getDate()).toBe(1);
    });

    it('should handle dates with leading zeros', () => {
      const result = parseLogseqDate(20250305);
      expect(result.getMonth()).toBe(2); // March
      expect(result.getDate()).toBe(5);
    });
  });

  describe('formatLogseqDate', () => {
    it('should format date to LogSeq format', () => {
      const date = new Date(2025, 10, 20); // Nov 20, 2025
      const result = formatLogseqDate(date);
      expect(result).toBe(20251120);
    });

    it('should pad single-digit months and days', () => {
      const date = new Date(2025, 0, 5); // Jan 5, 2025
      const result = formatLogseqDate(date);
      expect(result).toBe(20250105);
    });

    it('should handle end of year dates', () => {
      const date = new Date(2025, 11, 31); // Dec 31, 2025
      const result = formatLogseqDate(date);
      expect(result).toBe(20251231);
    });
  });

  describe('addDays', () => {
    it('should add days to LogSeq date', () => {
      const result = addDays(20251120, 3);
      expect(result).toBe(20251123);
    });

    it('should subtract days when negative', () => {
      const result = addDays(20251120, -5);
      expect(result).toBe(20251115);
    });

    it('should handle month boundaries', () => {
      const result = addDays(20251130, 2);
      expect(result).toBe(20251202);
    });

    it('should handle year boundaries', () => {
      const result = addDays(20251231, 1);
      expect(result).toBe(20260101);
    });

    it('should handle leap year transitions', () => {
      const result = addDays(20240228, 1);
      expect(result).toBe(20240229);
    });
  });

  describe('getDateRange', () => {
    it('should generate date range', () => {
      const result = getDateRange(20251118, 20251120);
      expect(result).toEqual([20251118, 20251119, 20251120]);
    });

    it('should handle single day range', () => {
      const result = getDateRange(20251120, 20251120);
      expect(result).toEqual([20251120]);
    });

    it('should handle month boundaries', () => {
      const result = getDateRange(20251130, 20251202);
      expect(result).toEqual([20251130, 20251201, 20251202]);
    });

    it('should handle year boundaries', () => {
      const result = getDateRange(20251230, 20260102);
      expect(result).toEqual([20251230, 20251231, 20260101, 20260102]);
    });

    it('should return empty array for invalid range', () => {
      const result = getDateRange(20251120, 20251118);
      expect(result).toEqual([]);
    });
  });

  describe('isWeekend', () => {
    it('should detect Saturday', () => {
      expect(isWeekend(20251122)).toBe(true); // Saturday Nov 22, 2025
    });

    it('should detect Sunday', () => {
      expect(isWeekend(20251123)).toBe(true); // Sunday Nov 23, 2025
    });

    it('should detect weekdays', () => {
      expect(isWeekend(20251120)).toBe(false); // Thursday
      expect(isWeekend(20251121)).toBe(false); // Friday
      expect(isWeekend(20251124)).toBe(false); // Monday
    });
  });

  describe('getWeekNumber', () => {
    it('should get week number for date', () => {
      // Week 1 of 2025
      const result = getWeekNumber(20250105);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(53);
    });

    it('should get week number for mid-year', () => {
      // Mid-year should have reasonable week number
      const result = getWeekNumber(20250701);
      expect(result).toBeGreaterThan(20);
      expect(result).toBeLessThan(35);
    });

    it('should get week number for end of year', () => {
      // End of year
      const result = getWeekNumber(20251231);
      expect(result).toBeGreaterThan(50);
      expect(result).toBeLessThanOrEqual(53);
    });

    it('should handle consecutive days in same week', () => {
      const week1 = getWeekNumber(20251120);
      const week2 = getWeekNumber(20251121);
      expect(week1).toBe(week2);
    });
  });
});
