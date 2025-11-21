/**
 * Date utility functions for LogSeq temporal operations
 */

/**
 * Parse LogSeq date format (YYYYMMDD) to Date object
 * @param logseqDate - Date in YYYYMMDD format
 * @returns Date object
 */
export function parseLogseqDate(logseqDate: number): Date {
  const str = logseqDate.toString();
  const year = parseInt(str.substring(0, 4));
  const month = parseInt(str.substring(4, 6)) - 1; // 0-indexed
  const day = parseInt(str.substring(6, 8));

  return new Date(year, month, day);
}

/**
 * Format Date object to LogSeq date format (YYYYMMDD)
 * @param date - Date object
 * @returns Date in YYYYMMDD format
 */
export function formatLogseqDate(date: Date): number {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  return parseInt(`${year}${month}${day}`);
}

/**
 * Add days to a LogSeq date
 * @param logseqDate - Date in YYYYMMDD format
 * @param days - Number of days to add (can be negative)
 * @returns New date in YYYYMMDD format
 */
export function addDays(logseqDate: number, days: number): number {
  const date = parseLogseqDate(logseqDate);
  date.setDate(date.getDate() + days);
  return formatLogseqDate(date);
}

/**
 * Generate array of dates in a range
 * @param startDate - Start date in YYYYMMDD format
 * @param endDate - End date in YYYYMMDD format
 * @returns Array of dates in YYYYMMDD format
 */
export function getDateRange(startDate: number, endDate: number): number[] {
  if (startDate > endDate) {
    return [];
  }

  const dates: number[] = [];
  let current = startDate;

  while (current <= endDate) {
    dates.push(current);
    current = addDays(current, 1);
  }

  return dates;
}

/**
 * Check if a date is a weekend
 * @param logseqDate - Date in YYYYMMDD format
 * @returns true if Saturday or Sunday
 */
export function isWeekend(logseqDate: number): boolean {
  const date = parseLogseqDate(logseqDate);
  const dayOfWeek = date.getDay();
  return dayOfWeek === 0 || dayOfWeek === 6; // Sunday or Saturday
}

/**
 * Get week number for a date
 * @param logseqDate - Date in YYYYMMDD format
 * @returns Week number (1-53)
 */
export function getWeekNumber(logseqDate: number): number {
  const date = parseLogseqDate(logseqDate);
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const dayOfYear = Math.floor(
    (date.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)
  );

  return Math.ceil((dayOfYear + startOfYear.getDay() + 1) / 7);
}
