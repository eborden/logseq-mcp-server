//! The period filter of `find_blocks` (#491): the blocks on the journal pages of a span of days. The span is chosen
//! the way `query_by_date_range` and `explore_timeline` choose theirs, by exactly one of `start_date` with `end_date`,
//! `last_n` or `preset`, and the choosing (the one-of rule, the date format, the presets) is that tool's, reused as it
//! is (`selection.rs`).
//!
//! One difference, because this filter is one query and the answer to "which journals exist" would be a second call:
//! `last_n` is the last N calendar days ending today, whether or not each has a journal, where
//! `query_by_date_range`'s is the N most recent journals that exist. A reader who keeps a journal every day sees no
//! difference.

use crate::dates::CalendarDate;
use crate::errors::InvalidParameter;
use crate::tools::query_by_date_range::selection::{Resolved, Selection, resolve_selection};

/// The days a search is limited to, as `YYYYMMDD`, both ends included. A real range: `start` is not after `end`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Period {
    pub start: i64,
    pub end: i64,
}

/// The earliest day an explicit date may name (`selection.rs` holds dates to 1900 and later), so `last_n` reaches no
/// further back than a date could.
const EARLIEST_DAY: i64 = 19_000_101;

/// The most days `last_n` counts back: about 164 years, past 1900 for any real today, so a count too large for a
/// date only ends at the earliest day instead of overflowing the calendar.
const MAX_LAST_N_DAYS: i64 = 60_000;

/// The period the caller chose, or `None` when none of `start_date`, `end_date`, `last_n` and `preset` was given.
/// More than one of the three ways, or half of a date range, or a bad date, is an [`InvalidParameter`]
/// (`resolve_selection`'s words). `today` is the local calendar day.
pub fn resolve_period(selection: Selection, today: CalendarDate) -> Result<Option<Period>, InvalidParameter> {
    if selection == Selection::default() {
        return Ok(None);
    }
    Ok(Some(match resolve_selection(selection, today)? {
        Resolved::Range { start, end } => Period { start, end },
        Resolved::LastN { count, latest } => {
            let days = i64::from(count).min(MAX_LAST_N_DAYS);
            let first = i64::from(today.shifted(1 - days).to_logseq_day());
            Period { start: first.max(EARLIEST_DAY), end: latest }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dates::DatePreset;

    const TODAY: CalendarDate = CalendarDate { year: 2025, month: 3, day: 12 };

    fn period(selection: Selection) -> Result<Option<Period>, String> {
        resolve_period(selection, TODAY).map_err(|error| error.to_string())
    }

    fn span(start: i64, end: i64) -> Result<Option<Period>, String> {
        Ok(Some(Period { start, end }))
    }

    #[test]
    fn no_choice_is_no_period() {
        assert_eq!(period(Selection::default()), Ok(None));
    }

    #[test]
    fn explicit_dates_and_a_preset_are_the_range_query_by_date_range_reads() {
        assert_eq!(period(Selection { start_date: Some(20250101), end_date: Some(20250107), ..Selection::default() }), span(20250101, 20250107));
        assert_eq!(period(Selection { preset: Some(DatePreset::LastWeek), ..Selection::default() }), span(20250303, 20250309));
        assert_eq!(period(Selection { preset: Some(DatePreset::Today), ..Selection::default() }), span(20250312, 20250312));
    }

    #[test]
    fn last_n_is_the_last_n_calendar_days_ending_today_so_one_is_today_alone() {
        let last = |count: u32| period(Selection { last_n: Some(count), ..Selection::default() });
        assert_eq!(last(1), span(20250312, 20250312));
        assert_eq!(last(7), span(20250306, 20250312));
        // across a month and a leap day
        assert_eq!(last(14), span(20250227, 20250312));
        assert_eq!(last(400), span(20240207, 20250312));
    }

    #[test]
    fn a_count_too_large_for_a_date_ends_at_the_earliest_day_a_date_may_name() {
        let last = |count: u32| period(Selection { last_n: Some(count), ..Selection::default() });
        assert_eq!(last(60_000), span(EARLIEST_DAY, 20250312));
        assert_eq!(last(u32::MAX), span(EARLIEST_DAY, 20250312));
        assert_eq!(last(40_000), span(19150907, 20250312));
    }

    #[test]
    fn a_selection_that_reads_no_way_is_refused_in_the_words_of_the_date_range_tool() {
        let none = period(Selection { start_date: Some(20250101), preset: Some(DatePreset::Today), ..Selection::default() }).unwrap_err();
        assert!(none.contains("start_date/end_date and preset"), "{none}");
        let half = period(Selection { start_date: Some(20250101), ..Selection::default() }).unwrap_err();
        assert!(half.starts_with("Invalid parameter 'end_date': missing"), "{half}");
        let backwards = period(Selection { start_date: Some(20250107), end_date: Some(20250101), ..Selection::default() }).unwrap_err();
        assert!(backwards.starts_with("Invalid parameter 'date_range': 20250107 to 20250101"), "{backwards}");
        let bad = period(Selection { start_date: Some(20250231), end_date: Some(20250301), ..Selection::default() }).unwrap_err();
        assert!(bad.starts_with("Invalid parameter 'start_date': 20250231"), "{bad}");
    }
}
