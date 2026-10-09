//! Calendar dates for the date-range tool (the Rust side of `src/utils/date-utils.ts` and
//! `src/utils/date-presets.ts`): the date of "now" in the host's local time zone, the date presets
//! (`last_week`, `this_month`, ...) and LogSeq's `YYYYMMDD` integer.
//!
//! The TypeScript code reads the clock through `new Date()` and uses the *local* components
//! (`getFullYear`, `getMonth`, `getDate`, `getDay`), so "today" is the calendar day in the zone of
//! the machine running the server, which is the machine running LogSeq. This module does the same:
//! [`Clock::today`] asks the C library for the local date of an instant (`localtime_r`, which
//! honours `TZ` as Node does), and every other function here is plain calendar arithmetic on a
//! [`CalendarDate`], with no zone in it. A preset therefore depends on the host's zone in exactly
//! the one place the TypeScript one does.
//!
//! Weeks run Monday to Sunday (ISO 8601). `this_week`, `this_month` and `this_year` cover the whole
//! calendar period, so they can end after today; `year_to_date` is January 1 through today.

use std::time::{SystemTime, UNIX_EPOCH};

/// A named period (`DatePreset`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
// Inlined into the tool's schema, not referenced from `$defs`: the MCP SDK client drops `$defs`.
// No doc comment, which would become a `description` of the enum beside the parameter's own.
#[schemars(inline)]
pub enum DatePreset {
    Today,
    Yesterday,
    ThisWeek,
    LastWeek,
    ThisMonth,
    LastMonth,
    ThisYear,
    YearToDate,
}

/// A day of the proleptic Gregorian calendar, with no time zone. The fields are what
/// `getFullYear()`, `getMonth() + 1` and `getDate()` give.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CalendarDate {
    pub year: i32,
    /// 1 to 12
    pub month: u32,
    /// 1 to the month's length
    pub day: u32,
}

/// The inclusive `YYYYMMDD` range a preset names (`ResolvedDateRange`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateRange {
    pub start: u32,
    pub end: u32,
}

impl CalendarDate {
    /// `formatLogseqDate`: `20250131` for January 31 2025. For a year before 1000 JavaScript's
    /// `parseInt` of the unpadded year gives the same number, so this is plain arithmetic.
    pub fn to_logseq_day(self) -> u32 {
        (self.year as u32) * 10_000 + self.month * 100 + self.day
    }

    /// The day `year`-`month`-`day` if the calendar has it, as `new Date(year, month - 1, day)` read back
    /// through `getFullYear`, `getMonth` and `getDate` is that day (a 30th of February is none).
    pub fn real(year: i32, month: u32, day: u32) -> Option<CalendarDate> {
        if !(1..=12).contains(&month) || day == 0 {
            return None;
        }
        let date = CalendarDate { year, month, day };
        (CalendarDate::from_days(date.days()) == date).then_some(date)
    }

    /// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
    fn days(self) -> i64 {
        let year = i64::from(self.year) - i64::from(self.month <= 2);
        let era = year.div_euclid(400);
        let year_of_era = year.rem_euclid(400);
        let month = i64::from(self.month);
        let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(self.day) - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        era * 146_097 + day_of_era - 719_468
    }

    /// The date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`).
    fn from_days(days: i64) -> CalendarDate {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let day_of_era = z.rem_euclid(146_097);
        let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let mp = (5 * day_of_year + 2) / 153;
        let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
        let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
        let year = (year_of_era + era * 400) as i32 + i32::from(month <= 2);
        CalendarDate { year, month, day }
    }

    /// `shiftDays`: this day moved by `delta` calendar days. Calendar arithmetic, so a daylight
    /// saving change never moves the day.
    pub fn shifted(self, delta: i64) -> CalendarDate {
        CalendarDate::from_days(self.days() + delta)
    }

    /// `getDay()`: Sunday 0 to Saturday 6.
    fn weekday(self) -> i64 {
        (self.days() + 4).rem_euclid(7) // 1970-01-01 was a Thursday
    }

    /// `mondayOf`: the Monday of the ISO week this day is in.
    pub fn monday(self) -> CalendarDate {
        self.shifted(-((self.weekday() + 6) % 7))
    }

    /// The first day of this month, `delta` months on (`new Date(year, month + delta, 1)`).
    pub fn first_of_month(self, delta: i32) -> CalendarDate {
        let months = self.year * 12 + (self.month as i32 - 1) + delta;
        CalendarDate { year: months.div_euclid(12), month: months.rem_euclid(12) as u32 + 1, day: 1 }
    }

    /// The day before the first of the month `delta` months on (`new Date(year, month + delta, 0)`).
    pub fn last_of_month_before(self, delta: i32) -> CalendarDate {
        self.first_of_month(delta).shifted(-1)
    }
}

/// `resolveDatePreset`: a preset as an inclusive `YYYYMMDD` range, against `today`.
pub fn resolve_date_preset(preset: DatePreset, today: CalendarDate) -> DateRange {
    let range = |start: CalendarDate, end: CalendarDate| DateRange { start: start.to_logseq_day(), end: end.to_logseq_day() };
    let january_first = CalendarDate { year: today.year, month: 1, day: 1 };
    match preset {
        DatePreset::Today => range(today, today),
        DatePreset::Yesterday => {
            let yesterday = today.shifted(-1);
            range(yesterday, yesterday)
        }
        DatePreset::ThisWeek => {
            let monday = today.monday();
            range(monday, monday.shifted(6))
        }
        DatePreset::LastWeek => {
            let monday = today.monday();
            range(monday.shifted(-7), monday.shifted(-1))
        }
        DatePreset::ThisMonth => range(today.first_of_month(0), today.last_of_month_before(1)),
        DatePreset::LastMonth => range(today.first_of_month(-1), today.last_of_month_before(0)),
        DatePreset::ThisYear => range(january_first, CalendarDate { year: today.year, month: 12, day: 31 }),
        DatePreset::YearToDate => range(january_first, today),
    }
}

/// Where the tools read the current moment from. The system clock, or one fixed instant for the
/// parity harness, so a case whose result depends on "today" is the same on every day
/// (`LOGSEQ_MCP_NOW`, `crate::env`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Clock {
    #[default]
    System,
    /// Milliseconds since 1970-01-01 UTC, as `Date.now()` counts them
    Fixed(i64),
}

impl Clock {
    /// Milliseconds since 1970-01-01 UTC.
    fn now_ms(self) -> i64 {
        match self {
            Clock::Fixed(ms) => ms,
            Clock::System => match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(since) => since.as_millis() as i64,
                Err(before) => -(before.duration().as_millis() as i64),
            },
        }
    }

    /// The calendar day of now in the host's local time zone: what `new Date()`'s local
    /// components say (`formatLogseqDate(now)`, `startOfDay(now)`).
    pub fn today(self) -> CalendarDate {
        local_date(self.now_ms())
    }
}

/// The local calendar date of an instant, in the zone `TZ` (or the system) names.
#[cfg(unix)]
fn local_date(epoch_ms: i64) -> CalendarDate {
    let seconds = epoch_ms.div_euclid(1000) as libc::time_t;
    // SAFETY: `localtime_r` writes a `tm` through the second pointer, which is valid for it, and
    // reads the first, a plain integer. It keeps no pointer to either.
    let local = unsafe {
        let mut broken_down: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&seconds, &mut broken_down).is_null() {
            return utc_date(epoch_ms);
        }
        broken_down
    };
    CalendarDate { year: local.tm_year + 1900, month: (local.tm_mon + 1) as u32, day: local.tm_mday as u32 }
}

// A known difference from the TypeScript server (listed in #299): where there is no `localtime_r` (not a
// unix host), "today" is the UTC day, and the TypeScript server reads the local one everywhere. A real
// local-time implementation would replace this, not remove it.
#[cfg(not(unix))]
fn local_date(epoch_ms: i64) -> CalendarDate {
    utc_date(epoch_ms)
}

fn utc_date(epoch_ms: i64) -> CalendarDate {
    CalendarDate::from_days(epoch_ms.div_euclid(86_400_000))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(year: i32, month: u32, day: u32) -> CalendarDate {
        CalendarDate { year, month, day }
    }

    fn range(preset: DatePreset, today: CalendarDate) -> (u32, u32) {
        let range = resolve_date_preset(preset, today);
        (range.start, range.end)
    }

    #[test]
    fn a_day_is_written_as_the_logseq_integer() {
        assert_eq!(date(2025, 1, 31).to_logseq_day(), 20250131);
        assert_eq!(date(2025, 12, 1).to_logseq_day(), 20251201);
    }

    #[test]
    fn days_since_the_epoch_round_trip_across_leap_years_and_centuries() {
        for (y, m, d) in [(1970, 1, 1), (2000, 2, 29), (2024, 2, 29), (2100, 3, 1), (1900, 3, 1), (2025, 12, 31)] {
            let day = date(y, m, d);
            assert_eq!(CalendarDate::from_days(day.days()), day);
        }
        assert_eq!(date(1970, 1, 1).days(), 0);
        assert_eq!(date(2025, 3, 1).shifted(-1), date(2025, 2, 28));
        assert_eq!(date(2024, 3, 1).shifted(-1), date(2024, 2, 29));
        assert_eq!(date(2100, 3, 1).shifted(-1), date(2100, 2, 28));
        assert_eq!(date(2025, 12, 31).shifted(1), date(2026, 1, 1));
        assert_eq!(date(2025, 1, 1).shifted(-1), date(2024, 12, 31));
    }

    #[test]
    fn the_weekday_counts_from_sunday_as_get_day_does() {
        assert_eq!(date(1970, 1, 1).weekday(), 4); // Thursday
        assert_eq!(date(2025, 3, 9).weekday(), 0); // a Sunday
        assert_eq!(date(2025, 3, 10).weekday(), 1);
        assert_eq!(date(2025, 3, 15).weekday(), 6);
    }

    #[test]
    fn today_and_yesterday_are_one_day() {
        assert_eq!(range(DatePreset::Today, date(2025, 3, 12)), (20250312, 20250312));
        assert_eq!(range(DatePreset::Yesterday, date(2025, 3, 12)), (20250311, 20250311));
        assert_eq!(range(DatePreset::Yesterday, date(2025, 1, 1)), (20241231, 20241231));
    }

    #[test]
    fn weeks_run_monday_to_sunday() {
        // 2025-03-12 is a Wednesday
        assert_eq!(range(DatePreset::ThisWeek, date(2025, 3, 12)), (20250310, 20250316));
        assert_eq!(range(DatePreset::LastWeek, date(2025, 3, 12)), (20250303, 20250309));
        // a Sunday belongs to the week that began on the Monday before it
        assert_eq!(range(DatePreset::ThisWeek, date(2025, 3, 16)), (20250310, 20250316));
        assert_eq!(range(DatePreset::ThisWeek, date(2025, 3, 10)), (20250310, 20250316));
        // across a month and a year
        assert_eq!(range(DatePreset::LastWeek, date(2025, 1, 2)), (20241223, 20241229));
        assert_eq!(range(DatePreset::ThisWeek, date(2024, 12, 31)), (20241230, 20250105));
    }

    #[test]
    fn months_cover_the_whole_calendar_month() {
        assert_eq!(range(DatePreset::ThisMonth, date(2025, 3, 12)), (20250301, 20250331));
        assert_eq!(range(DatePreset::ThisMonth, date(2024, 2, 10)), (20240201, 20240229));
        assert_eq!(range(DatePreset::ThisMonth, date(2025, 12, 5)), (20251201, 20251231));
        assert_eq!(range(DatePreset::LastMonth, date(2025, 3, 12)), (20250201, 20250228));
        // January's last month is December of the year before
        assert_eq!(range(DatePreset::LastMonth, date(2025, 1, 15)), (20241201, 20241231));
        assert_eq!(range(DatePreset::LastMonth, date(2024, 3, 31)), (20240201, 20240229));
    }

    #[test]
    fn years_run_from_january_to_december_or_to_today() {
        assert_eq!(range(DatePreset::ThisYear, date(2025, 3, 12)), (20250101, 20251231));
        assert_eq!(range(DatePreset::YearToDate, date(2025, 3, 12)), (20250101, 20250312));
        assert_eq!(range(DatePreset::YearToDate, date(2025, 1, 1)), (20250101, 20250101));
    }

    /// The edges `resolveDatePreset` can get wrong: a day that borrows from the month before, a leap day, the last day
    /// of a year, and the last day of a 30-day month reached from a 31-day one.
    #[test]
    fn presets_hold_at_month_and_year_edges_and_on_a_leap_day() {
        // yesterday borrows from the month before, and from February's leap day
        assert_eq!(range(DatePreset::Yesterday, date(2025, 3, 1)), (20250228, 20250228));
        assert_eq!(range(DatePreset::Yesterday, date(2024, 3, 1)), (20240229, 20240229));
        assert_eq!(range(DatePreset::Yesterday, date(2025, 5, 1)), (20250430, 20250430));
        // a leap day is in its month and its year
        assert_eq!(range(DatePreset::Today, date(2024, 2, 29)), (20240229, 20240229));
        assert_eq!(range(DatePreset::ThisMonth, date(2024, 2, 29)), (20240201, 20240229));
        assert_eq!(range(DatePreset::YearToDate, date(2024, 2, 29)), (20240101, 20240229));
        // the last day of the year
        assert_eq!(range(DatePreset::Yesterday, date(2025, 12, 31)), (20251230, 20251230));
        assert_eq!(range(DatePreset::ThisYear, date(2025, 12, 31)), (20250101, 20251231));
        assert_eq!(range(DatePreset::YearToDate, date(2025, 12, 31)), (20250101, 20251231));
        assert_eq!(range(DatePreset::ThisMonth, date(2025, 12, 31)), (20251201, 20251231));
        assert_eq!(range(DatePreset::LastMonth, date(2025, 12, 31)), (20251101, 20251130));
        assert_eq!(range(DatePreset::YearToDate, date(2024, 12, 31)), (20240101, 20241231));
        // the last day of a 30-day month, and a 31-day month's last day looking back at a 30-day one
        assert_eq!(range(DatePreset::ThisMonth, date(2025, 4, 30)), (20250401, 20250430));
        assert_eq!(range(DatePreset::LastMonth, date(2025, 4, 30)), (20250301, 20250331));
        assert_eq!(range(DatePreset::LastMonth, date(2025, 5, 31)), (20250401, 20250430));
        assert_eq!(range(DatePreset::ThisMonth, date(2025, 5, 31)), (20250501, 20250531));
        // the week that crosses a leap day: 2024-03-01 is a Friday
        assert_eq!(range(DatePreset::ThisWeek, date(2024, 3, 1)), (20240226, 20240303));
        assert_eq!(range(DatePreset::LastWeek, date(2024, 3, 1)), (20240219, 20240225));
    }

    #[test]
    fn a_preset_is_known_by_the_words_the_schema_lists() {
        let preset = |word: &str| serde_json::from_value::<DatePreset>(serde_json::json!(word)).ok();
        let words = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_year", "year_to_date"];
        let known: Vec<_> = words.iter().map(|word| preset(word).unwrap_or_else(|| panic!("{word}"))).collect();
        assert_eq!(known.len(), 8);
        assert_eq!(preset("next_week"), None);
        assert_eq!(preset("Today"), None);
    }

    #[test]
    fn a_fixed_clock_reads_the_same_instant_every_time() {
        // 2025-03-12T03:30:00Z. Whatever the host's zone, the local date is the 11th, 12th or 13th
        let clock = Clock::Fixed(1_741_750_200_000);
        let day = clock.today();
        assert_eq!((day.year, day.month), (2025, 3));
        assert!((11..=13).contains(&day.day), "{day:?}");
        assert_eq!(clock.today(), day);
        assert_eq!(utc_date(1_741_750_200_000), date(2025, 3, 12));
        assert_eq!(utc_date(-1), date(1969, 12, 31));
    }
}
