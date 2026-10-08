import { describe, it, expect } from 'vitest';
import { formatMs2, percentile, summarizeLatency } from '../../scripts/measure-latency/stats.js';

/** The arithmetic behind scripts/measure-latency.ts. */
describe('percentile', () => {
  it('is the median at 50, whatever the order', () => {
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
  });

  it('interpolates between the two nearest ranks', () => {
    // 30 values 1..30: rank 0.9 * 29 = 26.1, between 27 and 28
    const values = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(percentile(values, 90)).toBeCloseTo(27.1, 10);
  });

  it('is the smallest at 0 and the largest at 100', () => {
    expect(percentile([5, 9, 1], 0)).toBe(1);
    expect(percentile([5, 9, 1], 100)).toBe(9);
  });

  it('is the one value of a list of one', () => {
    expect(percentile([7], 90)).toBe(7);
  });

  it('does not reorder the caller list', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });

  it('refuses an empty list and a percentile out of range rather than report NaN', () => {
    expect(() => percentile([], 50)).toThrow('cannot take a percentile of no values');
    expect(() => percentile([1], 101)).toThrow('between 0 and 100');
    expect(() => percentile([1], Number.NaN)).toThrow('between 0 and 100');
  });
});

describe('summarizeLatency', () => {
  it('reports the count, median, p90, min and max', () => {
    expect(summarizeLatency([10, 20, 30, 40, 50])).toEqual({ n: 5, median: 30, p90: 46, min: 10, max: 50 });
  });

  it('formats milliseconds with two decimals', () => {
    expect(formatMs2(1.5)).toBe('1.50');
  });
});
