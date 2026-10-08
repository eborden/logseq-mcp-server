// The arithmetic behind scripts/measure-latency.ts, kept apart from the script so a unit test can
// reach it (the script runs `main()` when it is loaded).

/**
 * The `p`th percentile (0 to 100) of a non-empty list, by linear interpolation between the two
 * nearest ranks (the "inclusive" method most spreadsheets use). p = 50 is the median.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('cannot take a percentile of no values');
  if (!(p >= 0 && p <= 100)) throw new Error(`a percentile is between 0 and 100, got ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export interface LatencySummary {
  n: number;
  median: number;
  p90: number;
  min: number;
  max: number;
}

export function summarizeLatency(values: readonly number[]): LatencySummary {
  return { n: values.length, median: percentile(values, 50), p90: percentile(values, 90), min: percentile(values, 0), max: percentile(values, 100) };
}

/** Milliseconds with two decimals: a stub-backed call takes a few milliseconds, so one decimal hides the spread. */
export const formatMs2 = (ms: number): string => ms.toFixed(2);
