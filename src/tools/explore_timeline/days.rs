//! The dated mentions of a page (the pure part of the page mode): which blocks are inside the period, how they are
//! grouped by day, and the keys of the weeks and months they can be grouped into. Blocks are the `Value`s LogSeq sent.
//!
//! A block's day is its page's `journalDay` (or `journal-day`); a block with no day (not on a journal) is undated. With
//! no period it comes last, after the dated days; with a period it is left out, since it has no day in the period.
//!
//! The period keys are plain calendar arithmetic on the `YYYYMMDD` number, with no time zone in it:
//! there is no local time for a daylight-saving change to move a day into another week by (#249).

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::Entry;
use crate::entity::journal_day_of;
use crate::js;
use crate::period::Period;

/// The periods entries are grouped into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
// Inlined into the tool's schema, not referenced from `$defs`: the MCP SDK client drops `$defs`.
// No doc comment, which would become a `description` of the enum beside the parameter's own.
#[schemars(inline)]
pub enum GroupBy {
    Day,
    Week,
    Month,
}

/// The block's day, `None` when it has none or it is 0.
pub fn day_of(block: &Value) -> Option<i64> {
    journal_day_of(block.get("page")).filter(|day| *day != 0)
}

/// The blocks once each, by `id`: a later block with the same id is dropped, so a block on the page
/// that also links it stays the tree's block, with its children, and not the Datalog pull of it.
pub fn unique_by_id(blocks: Vec<Value>) -> Vec<Value> {
    let mut seen: HashSet<i64> = HashSet::new();
    // the `Block` shape (`entity/shape.rs`) made the id a whole number
    blocks.into_iter().filter(|block| seen.insert(block.get("id").and_then(crate::wire::whole_number).unwrap_or_default())).collect()
}

/// The blocks inside the period. With no period every block stays. With one, a block stays when its day is in it,
/// and a block with no day is left out: it has no day to be in the period (`explore_timeline` says so in its description).
pub fn in_period(blocks: Vec<Value>, period: Option<Period>) -> Vec<Value> {
    let Some(Period { start, end }) = period else { return blocks };
    blocks.into_iter().filter(|block| day_of(block).is_some_and(|day| start <= day && day <= end)).collect()
}

/// The mentions as entries, oldest day first, the undated ones last. A day keeps its blocks in the order they were
/// found, and its entry names the page of the first of them (one journal page per day).
pub fn entries_by_day(blocks: Vec<Value>) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut at: HashMap<Option<i64>, usize> = HashMap::new();
    for block in blocks {
        let date = day_of(&block);
        let index = *at.entry(date).or_insert_with(|| {
            let page = if date.is_some() { block.get("page").cloned().unwrap_or(Value::Null) } else { Value::Null };
            entries.push(Entry { date, page, blocks: Vec::new() });
            entries.len() - 1
        });
        entries[index].blocks.push(block);
    }
    // A stable sort, with the undated entry (there is one at most) last
    entries.sort_by(|a, b| match (a.date, b.date) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    });
    entries
}

/// `parseInt(text)` for the digits of a date: a leading sign and digits, `None` (NaN) for no digits.
fn parse_int(text: &str) -> Option<i64> {
    let text = js::trim(text);
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
    let value: i64 = digits.parse().ok()?;
    Some(if negative { -value } else { value })
}

/// `Date.UTC(year, month - 1, day)` as a count of days since 1970-01-01: a year from 0 to 99 is 19xx, and
/// a month or day past its range rolls over into the next period.
fn utc_days(year: i64, month: i64, day: i64) -> i64 {
    let year = if (0..=99).contains(&year) { 1900 + year } else { year };
    let month0 = month - 1;
    let (year, month) = (year + month0.div_euclid(12), month0.rem_euclid(12) + 1);
    // days from civil (Howard Hinnant's algorithm), for the first of the month
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let year_of_era = shifted - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468 + (day - 1)
}

/// The ISO 8601 week of a `YYYYMMDD` date as `YYYY-WW`: weeks run Monday to Sunday, week 1 holds the
/// year's first Thursday, and the year is the ISO week-year (20241230 is `2025-W01`). `None` for a date
/// whose month or day digits are missing (fewer than seven digits): it has no week. A 7- or 9-digit date
/// does get one, from the characters at the same places (LogSeq's journal days always have eight digits).
pub fn week_identifier(date: i64) -> Option<String> {
    let text: Vec<char> = date.to_string().chars().collect();
    // `substring(from, to)`
    let part = |from: usize, to: usize| -> String { text.iter().skip(from).take(to - from).collect() };
    let (y, month, day) = (parse_int(&part(0, 4))?, parse_int(&part(4, 6))?, parse_int(&part(6, 8))?);
    let days = utc_days(y, month, day);
    // 1970-01-01 was a Thursday; the Thursday of this date's Monday-to-Sunday week decides the week-year
    let thursday = days - (days + 3).rem_euclid(7) + 3;
    let (week_year, _, _) = civil_from_days(thursday);
    let week = (thursday - utc_days(week_year, 1, 1)).div_euclid(7) + 1;
    Some(format!("{week_year:0>4}-W{week:0>2}"))
}

/// The inverse of `utc_days`: `(year, month, day)` of a count of days since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// The month of a date as `YYYYMM`.
pub fn month_identifier(date: i64) -> String {
    date.to_string().chars().take(6).collect()
}

/// The key of the period a day falls in, for a grouping. `None` for a day with no week, which is
/// grouped with the undated blocks: in no period.
pub fn period_key(group_by: GroupBy, date: i64) -> Option<String> {
    match group_by {
        GroupBy::Day => Some(date.to_string()),
        GroupBy::Week => week_identifier(date),
        GroupBy::Month => Some(month_identifier(date)),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn block(id: i64, day: Option<i64>) -> Value {
        match day {
            Some(day) => json!({"id": id, "uuid": format!("u{id}"), "page": {"id": 1000 + id, "journalDay": day}}),
            None => json!({"id": id, "uuid": format!("u{id}"), "page": {"id": 1000 + id}}),
        }
    }

    fn ids(blocks: &[Value]) -> Vec<i64> {
        blocks.iter().map(|b| b["id"].as_i64().unwrap()).collect()
    }

    #[test]
    fn blocks_with_float_valued_whole_ids_are_told_apart() {
        let (a, b) = (json!({"id": 5.0, "uuid": "a"}), json!({"id": 6.0, "uuid": "b"}));
        assert_eq!(unique_by_id(vec![a.clone(), b.clone()]), [a, b]);
    }

    #[test]
    fn a_later_block_with_the_same_id_is_dropped_and_the_first_one_stays() {
        let first = json!({"id": 1, "uuid": "tree"});
        let second = json!({"id": 2, "uuid": "other"});
        let again = json!({"id": 1, "uuid": "pull"});
        assert_eq!(unique_by_id(vec![first.clone(), second.clone(), again]), [first, second]);
    }

    #[test]
    fn no_period_keeps_every_block_and_a_period_keeps_the_days_in_it_and_leaves_out_the_undated() {
        let blocks = vec![block(1, Some(20250101)), block(2, Some(20250201)), block(3, None), block(4, Some(0))];
        assert_eq!(ids(&in_period(blocks.clone(), None)), [1, 2, 3, 4]);
        // both ends are in the period
        assert_eq!(ids(&in_period(blocks.clone(), Some(Period { start: 20250101, end: 20250201 }))), [1, 2]);
        assert_eq!(ids(&in_period(blocks.clone(), Some(Period { start: 20250115, end: 20250131 }))), Vec::<i64>::new());
        assert_eq!(ids(&in_period(blocks.clone(), Some(Period { start: 20250102, end: 20250201 }))), [2]);
        // a day of 0 is no day: block 4 is undated
        assert_eq!(day_of(&blocks[3]), None);
    }

    #[test]
    fn the_entries_are_oldest_first_with_the_undated_last_and_a_day_keeps_its_blocks_in_order() {
        let blocks = vec![block(1, None), block(2, Some(20250201)), block(3, Some(20250101)), block(4, Some(20250201)), block(5, None)];
        let entries = entries_by_day(blocks);
        let shape: Vec<(Option<i64>, Vec<i64>)> = entries.iter().map(|e| (e.date, ids(&e.blocks))).collect();
        assert_eq!(shape, [(Some(20250101), vec![3]), (Some(20250201), vec![2, 4]), (None, vec![1, 5])]);
        // a day names its page, the undated entry none
        assert_eq!(entries[0].page, json!({"id": 1003, "journalDay": 20250101}));
        assert_eq!(entries[2].page, Value::Null);
    }

    #[test]
    fn weeks_run_monday_to_sunday_and_the_year_is_the_iso_week_year() {
        // #660: 2024-12-30 is a Monday, 2025-12-29 a Monday, 2021-01-03 a Sunday
        let weeks = [
            (20241229, "2024-W52"), (20241230, "2025-W01"), (20250101, "2025-W01"), (20250105, "2025-W01"),
            (20250106, "2025-W02"), (20251228, "2025-W52"), (20251229, "2026-W01"), (20251231, "2026-W01"),
            (20260101, "2026-W01"), (20260104, "2026-W01"), (20260105, "2026-W02"), (20210103, "2020-W53"),
            (20201231, "2020-W53"), (20240229, "2024-W09"),
        ];
        for (date, week) in weeks {
            assert_eq!(week_identifier(date).as_deref(), Some(week), "{date}");
        }
    }

    #[test]
    fn a_run_of_seven_days_from_a_monday_shares_a_week_and_the_next_monday_starts_another() {
        // 2024-01-01 is a Monday
        let start = utc_days(2024, 1, 1);
        let key = |days: i64| {
            let (y, m, d) = civil_from_days(days);
            week_identifier(y * 10_000 + m * 100 + d).unwrap()
        };
        for week in 0..156 {
            let monday = start + week * 7;
            for offset in 1..7 {
                assert_eq!(key(monday + offset), key(monday), "day {offset} of week {week}");
            }
            assert_ne!(key(monday + 7), key(monday));
        }
    }

    #[test]
    fn a_week_is_the_same_on_the_days_around_a_daylight_saving_change() {
        // #249: 2025-03-09 is the day the clocks go forward in New York, 2025-04-06 in Sydney they go back
        assert_eq!(week_identifier(20250308).as_deref(), Some("2025-W10"));
        assert_eq!(week_identifier(20250309).as_deref(), Some("2025-W10"));
        assert_eq!(week_identifier(20250310).as_deref(), Some("2025-W11"));
        assert_eq!(week_identifier(20250312).as_deref(), Some("2025-W11"));
        assert_eq!(week_identifier(20250408).as_deref(), Some("2025-W15"));
        assert_eq!(week_identifier(20250409).as_deref(), Some("2025-W15"));
        assert_eq!(week_identifier(20250101).as_deref(), Some("2025-W01"));
        assert_eq!(week_identifier(20251231).as_deref(), Some("2026-W01"));
    }

    #[test]
    fn a_day_or_a_month_is_the_digits_of_the_date_and_a_date_with_no_week_has_no_key() {
        assert_eq!(period_key(GroupBy::Day, 20250102).as_deref(), Some("20250102"));
        assert_eq!(period_key(GroupBy::Month, 20250102).as_deref(), Some("202501"));
        assert_eq!(period_key(GroupBy::Week, 20250102).as_deref(), Some("2025-W01"));
        assert_eq!(week_identifier(2025), None);
        assert_eq!(week_identifier(202501), None);
        assert_eq!(period_key(GroupBy::Week, 202501), None);
        // only a week is missing: the day and the month are still the digits
        assert_eq!(period_key(GroupBy::Day, 202501).as_deref(), Some("202501"));
        // a seventh digit is a day of one digit, and a ninth is never read
        assert_eq!(week_identifier(2025011).as_deref(), Some("2025-W01"));
        assert_eq!(week_identifier(202501011).as_deref(), Some("2025-W01"));
        // a month past 12 or a day past the month's end rolls over
        assert_eq!(week_identifier(20251301).as_deref(), Some("2026-W01"));
        assert_eq!(week_identifier(20250230), week_identifier(20250302));
    }
}
