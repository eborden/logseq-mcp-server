//! How the caller chose the range (`resolveSelection` in `src/tools/query-by-date-range.ts`).
//! Exactly one of three groups must be given: explicit dates (`start_date` with `end_date`),
//! `last_n`, or `preset`. A preset is resolved against today here, so everything after this sees
//! plain dates.

use serde_json::Value;

use crate::dates::{CalendarDate, DatePreset, resolve_date_preset};
use crate::errors::InvalidParameter;

/// The three groups of arguments that choose a range, as sent.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Selection {
    pub start_date: Option<i64>,
    pub end_date: Option<i64>,
    pub last_n: Option<u32>,
    pub preset: Option<DatePreset>,
}

/// The validated, resolved form of a [`Selection`] (`ResolvedSelection`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Resolved {
    /// An explicit range, or a preset: the journal pages in it, oldest first
    Range { start: i64, end: i64 },
    /// The `count` most recent journal pages that exist, on or before `latest`, newest first
    LastN { count: u32, latest: i64 },
}

fn invalid(param: &str, value: impl Into<String>, expected: &str, example: &str) -> InvalidParameter {
    InvalidParameter { param: param.to_owned(), value: value.into(), expected: expected.to_owned(), example: Some(example.to_owned()) }
}

/// What a date must be, as the refusal says it.
const FORMAT: &str = "Date in YYYYMMDD format (8 digits, valid year/month/day)";

/// The refusal of a date argument that is no whole number (a fraction, or beyond the largest safe
/// integer): it is not in `YYYYMMDD` format, so it is worded as a date of the wrong format is.
pub fn bad_date(param: &str, value: &Value, example: &str) -> InvalidParameter {
    invalid(param, value.to_string(), FORMAT, example)
}

// PARITY(#299): checks the day against 31 whatever the month, so `20250231` passes and the query asks for
// it as a bound (suspected TS bug: it is no date) — drop if Rust becomes the only server.
/// `isValidDateFormat`: a whole number of 8 digits (year 1900 to 2100, month 1 to 12, day 1 to 31).
/// A day is checked against 31 whatever the month, so `20250231` passes.
fn is_valid_date_format(date: i64) -> bool {
    if !(10_000_000..=99_999_999).contains(&date) {
        return false;
    }
    let (year, month, day) = (date / 10_000, date / 100 % 100, date % 100);
    (1900..=2100).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// The one validation path for choosing a range.
///
/// Fails with an [`InvalidParameter`] for none, for more than one, and for bad values. `today` is
/// the local calendar day, which `last_n` and the presets are relative to.
pub fn resolve_selection(selection: Selection, today: CalendarDate) -> Result<Resolved, InvalidParameter> {
    let Selection { start_date, end_date, last_n, preset } = selection;

    let mut given: Vec<&str> = Vec::new();
    if start_date.is_some() || end_date.is_some() {
        given.push("start_date/end_date");
    }
    if last_n.is_some() {
        given.push("last_n");
    }
    if preset.is_some() {
        given.push("preset");
    }

    if given.is_empty() {
        return Err(invalid(
            "date selection",
            "none given",
            "Exactly one of: start_date with end_date, last_n, or preset",
            "last_n: 7, or preset: \"last_week\", or start_date: 20251115 with end_date: 20251120",
        ));
    }
    if given.len() > 1 {
        return Err(invalid(
            "date selection",
            given.join(" and "),
            "Exactly one of: start_date with end_date, last_n, or preset (not several together)",
            "last_n: 7",
        ));
    }

    // `last_n >= 1` and the preset's words are the argument schema's, checked before this
    if let Some(count) = last_n {
        return Ok(Resolved::LastN { count, latest: i64::from(today.to_logseq_day()) });
    }
    if let Some(preset) = preset {
        let range = resolve_date_preset(preset, today);
        return Ok(Resolved::Range { start: i64::from(range.start), end: i64::from(range.end) });
    }

    let (Some(start), Some(end)) = (start_date, end_date) else {
        let missing = if start_date.is_some() { "end_date" } else { "start_date" };
        return Err(invalid(
            missing,
            "missing",
            "Both start_date and end_date when choosing an explicit range",
            "start_date: 20251115, end_date: 20251120",
        ));
    };
    if !is_valid_date_format(start) {
        return Err(invalid("start_date", start.to_string(), FORMAT, "20251115 for November 15, 2025"));
    }
    if !is_valid_date_format(end) {
        return Err(invalid("end_date", end.to_string(), FORMAT, "20251120 for November 20, 2025"));
    }
    if start > end {
        return Err(invalid(
            "date_range",
            format!("{start} to {end}"),
            "start_date must be before or equal to end_date",
            "start_date: 20251115, end_date: 20251120",
        ));
    }
    Ok(Resolved::Range { start, end })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: CalendarDate = CalendarDate { year: 2025, month: 3, day: 12 };

    fn pick(selection: Selection) -> Result<Resolved, String> {
        resolve_selection(selection, TODAY).map_err(|error| error.to_string())
    }

    fn explicit(start: i64, end: i64) -> Selection {
        Selection { start_date: Some(start), end_date: Some(end), ..Selection::default() }
    }

    #[test]
    fn explicit_dates_a_count_and_a_preset_each_choose_a_range() {
        assert_eq!(pick(explicit(20250101, 20250107)), Ok(Resolved::Range { start: 20250101, end: 20250107 }));
        assert_eq!(pick(explicit(20250101, 20250101)), Ok(Resolved::Range { start: 20250101, end: 20250101 }));
        assert_eq!(
            pick(Selection { last_n: Some(3), ..Selection::default() }),
            Ok(Resolved::LastN { count: 3, latest: 20250312 })
        );
        assert_eq!(
            pick(Selection { preset: Some(DatePreset::LastWeek), ..Selection::default() }),
            Ok(Resolved::Range { start: 20250303, end: 20250309 })
        );
    }

    #[test]
    fn none_or_several_groups_is_refused_and_says_which() {
        assert_eq!(
            pick(Selection::default()).unwrap_err(),
            "Invalid parameter 'date selection': none given\n\nExpected: Exactly one of: start_date with end_date, last_n, or preset\n\
             Example: last_n: 7, or preset: \"last_week\", or start_date: 20251115 with end_date: 20251120"
        );
        let all = Selection { start_date: Some(1), end_date: None, last_n: Some(2), preset: Some(DatePreset::Today) };
        assert_eq!(
            pick(all).unwrap_err(),
            "Invalid parameter 'date selection': start_date/end_date and last_n and preset\n\nExpected: Exactly one of: start_date with end_date, \
             last_n, or preset (not several together)\nExample: last_n: 7"
        );
        let two = Selection { end_date: Some(20250101), preset: Some(DatePreset::Today), ..Selection::default() };
        assert!(pick(two).unwrap_err().contains("start_date/end_date and preset"));
    }

    #[test]
    fn one_date_without_the_other_names_the_missing_one() {
        let only_start = pick(Selection { start_date: Some(20250101), ..Selection::default() }).unwrap_err();
        assert!(only_start.starts_with("Invalid parameter 'end_date': missing\n\nExpected: Both start_date and end_date"), "{only_start}");
        let only_end = pick(Selection { end_date: Some(20250101), ..Selection::default() }).unwrap_err();
        assert!(only_end.starts_with("Invalid parameter 'start_date': missing"), "{only_end}");
    }

    #[test]
    fn a_date_is_eight_digits_with_a_year_a_month_and_a_day_in_range() {
        for good in [19000101, 21001231, 20250231, 20251115] {
            assert!(is_valid_date_format(good), "{good}");
        }
        for bad in [2025011, 202501011, 18991231, 21010101, 20250001, 20251301, 20250100, 20250132, -2025011, 0] {
            assert!(!is_valid_date_format(bad), "{bad}");
        }
    }

    #[test]
    fn a_bad_date_is_named_with_the_value_as_javascript_writes_it() {
        assert_eq!(
            pick(explicit(2025010, 20250102)).unwrap_err(),
            "Invalid parameter 'start_date': 2025010\n\nExpected: Date in YYYYMMDD format (8 digits, valid year/month/day)\nExample: 20251115 for November 15, 2025"
        );
        assert_eq!(
            pick(explicit(20250101, 2025)).unwrap_err(),
            "Invalid parameter 'end_date': 2025\n\nExpected: Date in YYYYMMDD format (8 digits, valid year/month/day)\nExample: 20251120 for November 20, 2025"
        );
        // the start is checked before the end
        assert!(pick(explicit(1, 2)).unwrap_err().starts_with("Invalid parameter 'start_date': 1\n"));
    }

    #[test]
    fn a_range_that_runs_backwards_is_refused() {
        assert_eq!(
            pick(explicit(20250107, 20250101)).unwrap_err(),
            "Invalid parameter 'date_range': 20250107 to 20250101\n\nExpected: start_date must be before or equal to end_date\n\
             Example: start_date: 20251115, end_date: 20251120"
        );
    }
}
