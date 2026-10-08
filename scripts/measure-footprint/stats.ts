// The arithmetic behind scripts/measure-footprint.ts (#126), kept apart from the script so a
// unit test can reach it (the script runs `main()` when it is loaded).

export interface Summary {
  n: number;
  median: number;
  min: number;
  max: number;
}

/** Median, minimum and maximum of a non-empty list; the median of an even count is the mean of the middle two. */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) throw new Error('cannot summarize no values');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: sorted.length, median, min: sorted[0], max: sorted[sorted.length - 1] };
}

/** `ps -o rss=` prints the resident set in kilobytes; returns bytes. */
export function parsePsRssBytes(output: string): number {
  const kb = Number(output.trim());
  if (!Number.isInteger(kb) || kb <= 0) throw new Error(`could not read a resident size from ps output ${JSON.stringify(output.trim())}`);
  return kb * 1024;
}

/** Binary megabytes, one decimal place: 1 MB is 1024 * 1024 bytes. */
export const formatMb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const formatMs = (ms: number): string => `${ms.toFixed(1)} ms`;

/** `median (min - max)` of a summary, with the given unit formatter. */
export function formatSummary(summary: Summary, format: (n: number) => string): string {
  return `${format(summary.median)} (${format(summary.min)} - ${format(summary.max)})`;
}
