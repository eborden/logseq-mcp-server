import { formatLogseqDate } from './date-utils.js';

/**
 * Natural-language date presets for `query_by_date_range`.
 *
 * Every function here is pure: the current moment is always passed in as `now`,
 * so tests never depend on the clock.
 *
 * Conventions:
 * - Local time. "Today" is the calendar day of `now` in the server process's time
 *   zone, which is the machine running the LogSeq desktop app, so it matches the
 *   day LogSeq itself would call today.
 * - Weeks run Monday to Sunday (ISO 8601). `this_week` is the Monday-to-Sunday
 *   week containing `now`; `last_week` is the one before it.
 * - `this_week`, `this_month` and `this_year` cover the whole calendar period, so
 *   they can end after today (days with no journal page simply have no entry).
 *   `year_to_date` is January 1 through today.
 */

export const DATE_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_year',
  'year_to_date',
] as const;

export type DatePreset = (typeof DATE_PRESETS)[number];

export interface ResolvedDateRange {
  /** First day, inclusive (YYYYMMDD) */
  start: number;
  /** Last day, inclusive (YYYYMMDD) */
  end: number;
}

export function isDatePreset(value: unknown): value is DatePreset {
  return typeof value === 'string' && (DATE_PRESETS as readonly string[]).includes(value);
}

/** Midnight at the start of `now`'s local day. Built from components so DST never shifts the day. */
function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** `day` shifted by `delta` calendar days (local components, so DST-safe). */
function shiftDays(day: Date, delta: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + delta);
}

/** Monday of the ISO week containing `day`. */
function mondayOf(day: Date): Date {
  const daysSinceMonday = (day.getDay() + 6) % 7; // getDay(): Sunday 0 ... Saturday 6
  return shiftDays(day, -daysSinceMonday);
}

function range(start: Date, end: Date): ResolvedDateRange {
  return { start: formatLogseqDate(start), end: formatLogseqDate(end) };
}

/**
 * Turn a preset into an inclusive YYYYMMDD range.
 * @param preset - One of {@link DATE_PRESETS}
 * @param now - The current moment (local time is used)
 * @throws Error if `preset` is not a known preset (callers validate first)
 */
export function resolveDatePreset(preset: DatePreset, now: Date): ResolvedDateRange {
  const today = startOfDay(now);
  const year = today.getFullYear();
  const month = today.getMonth();

  switch (preset) {
    case 'today':
      return range(today, today);
    case 'yesterday': {
      const yesterday = shiftDays(today, -1);
      return range(yesterday, yesterday);
    }
    case 'this_week': {
      const monday = mondayOf(today);
      return range(monday, shiftDays(monday, 6));
    }
    case 'last_week': {
      const monday = mondayOf(today);
      return range(shiftDays(monday, -7), shiftDays(monday, -1));
    }
    case 'this_month':
      return range(new Date(year, month, 1), new Date(year, month + 1, 0));
    case 'last_month':
      return range(new Date(year, month - 1, 1), new Date(year, month, 0));
    case 'this_year':
      return range(new Date(year, 0, 1), new Date(year, 11, 31));
    case 'year_to_date':
      return range(new Date(year, 0, 1), today);
    default:
      throw new Error(`Unknown date preset: ${String(preset)}`);
  }
}
