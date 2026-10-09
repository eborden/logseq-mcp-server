//! The timeline of a concept's mentions (the pure part of `src/tools/get-concept-evolution.ts`):
//! which blocks pass the date bounds, how they are grouped by day, cut at `max_entries` and grouped
//! by period, and the words of the cut. Blocks are the `Value`s LogSeq sent, and an entry names
//! them by their place in the list of mentions, so the same block is never copied twice.
//!
//! A block's day is its page's `journalDay` (or `journal-day`); a block with no day (not on a
//! journal) is undated, passes every date filter, and comes last.
//!
//! The period keys are plain calendar arithmetic on the `YYYYMMDD` number, with no time zone in it:
//! the TypeScript code computes them from UTC midnights so a daylight-saving change can't move a
//! day into another week (#249), and this has no local time to be moved by.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::entity::journal_day_of;
use crate::js;
use crate::meta::ResultWarning;
use crate::truncation::{CappedTruncation, INLINE_BLOCKS, capped_truncation_warning};

/// Most mentions one call returns (#61). A larger `max_entries` is clamped to it, and a cut at the
/// maximum is reported by an `entries_truncated` warning with no `howToFetchAll`. The dates reach
/// later dated mentions only: mentions on non-journal pages pass every date filter, so no date range
/// narrows them.
pub const MAX_ENTRIES: u64 = 500;

/// The periods `group_by` names, in the order the schema lists them (`GROUP_BY_PERIODS`).
pub const GROUP_BY_VALUES: &[&str] = &["day", "week", "month"];

/// The periods mentions are grouped into.
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

impl GroupBy {
    pub fn from_word(word: &str) -> Option<GroupBy> {
        Some(match word {
            "day" => GroupBy::Day,
            "week" => GroupBy::Week,
            "month" => GroupBy::Month,
            _ => return None,
        })
    }
}

/// One day's mentions: the day (`None` for the blocks with no journal day) and which blocks.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub date: Option<i64>,
    /// Places in the list of mentions, in the order the blocks were found
    pub blocks: Vec<usize>,
}

/// `journalDayOf(block.page) || undefined`: the block's day, `None` when it has none or it is 0.
pub fn day_of(block: &Value) -> Option<i64> {
    journal_day_of(block.get("page")).filter(|day| *day != 0)
}

/// The blocks once each, by `id`: a later block with the same id is dropped, so a block on the page
/// that also links it stays the tree's block, with its children, and not the Datalog pull of it.
pub fn unique_by_id(blocks: Vec<Value>) -> Vec<Value> {
    let mut seen: HashSet<i64> = HashSet::new();
    // `check_block` made the id a whole number
    blocks.into_iter().filter(|block| seen.insert(block.get("id").and_then(crate::wire::whole_number).unwrap_or_default())).collect()
}

/// The blocks inside the date bounds. A block with no day is kept; a bound that is 0 or absent is no
/// bound (`startDate && blockDate < startDate`).
pub fn filter_by_dates(blocks: Vec<Value>, start_date: Option<i64>, end_date: Option<i64>) -> Vec<Value> {
    let bound = |date: Option<i64>| date.filter(|date| *date != 0);
    let (start, end) = (bound(start_date), bound(end_date));
    blocks
        .into_iter()
        .filter(|block| {
            let Some(day) = day_of(block) else { return true };
            !(start.is_some_and(|start| day < start) || end.is_some_and(|end| day > end))
        })
        .collect()
}

/// The mentions grouped by day, oldest first, the undated ones last.
pub fn full_timeline(blocks: &[Value]) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut at: HashMap<Option<i64>, usize> = HashMap::new();
    for (place, block) in blocks.iter().enumerate() {
        let date = day_of(block);
        match at.get(&date) {
            Some(&index) => entries[index].blocks.push(place),
            None => {
                at.insert(date, entries.len());
                entries.push(Entry { date, blocks: vec![place] });
            }
        }
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

/// The first `cap` mentions in timeline order (oldest first, undated last): `cap` is `max_entries`,
/// clamped to 0..[`MAX_ENTRIES`]. At or below the cap every block is kept in its order.
pub fn cap_timeline(full: &[Entry], max_entries: u64) -> Vec<Entry> {
    let mut room = max_entries.min(MAX_ENTRIES) as usize;
    let mut kept = Vec::new();
    for entry in full {
        if room == 0 {
            break;
        }
        let taken: Vec<usize> = entry.blocks.iter().copied().take(room).collect();
        room -= taken.len();
        kept.push(Entry { date: entry.date, blocks: taken });
    }
    kept
}

/// The places of the blocks the timeline kept, in the order of the mentions (`filteredBlocks.filter(block =>
/// kept.has(block))`).
pub fn shown_places(total: usize, timeline: &[Entry]) -> Vec<usize> {
    let kept: HashSet<usize> = timeline.iter().flat_map(|entry| entry.blocks.iter().copied()).collect();
    (0..total).filter(|place| kept.contains(place)).collect()
}

fn mention_count(entries: &[Entry], dated: bool) -> usize {
    entries.iter().filter(|entry| entry.date.is_some() == dated).map(|entry| entry.blocks.len()).sum()
}

/// The `entries_truncated` warning for a timeline cut from `full` to `kept`. Says where the timeline
/// ends when it ends on a dated mention, so the caller can continue from there, and says what the dates
/// can reach: the date filter keeps every block with no journal day, so they never narrow the undated
/// mentions, which are cut first.
pub fn entries_truncated(full: &[Entry], kept: &[Entry], total: usize, shown: usize, requested: u64) -> ResultWarning {
    let ends_at = kept.last().and_then(|entry| entry.date);
    let dated_cut = mention_count(full, true) > mention_count(kept, true);
    let narrower = match (dated_cut, ends_at) {
        // One day can be split across the cut, so starting there repeats its kept blocks
        (true, Some(date)) => format!(
            "Set start_date to {} for later dated mentions (that day repeats its kept blocks). Mentions on non-journal pages ignore the dates.",
            date
        ),
        (true, None) => "Narrow start_date and end_date to see dated mentions. Mentions on non-journal pages ignore the dates.".to_owned(),
        (false, _) => "Mentions on non-journal pages ignore start_date and end_date, so narrowing the dates can't reach the rest.".to_owned(),
    };
    let ends = ends_at.map(|date| format!("; the timeline ends at {date}")).unwrap_or_default();
    capped_truncation_warning(CappedTruncation {
        what: &format!("mentions (oldest first, undated last{ends})"),
        shown,
        total,
        param: "max_entries",
        max: MAX_ENTRIES as usize,
        narrower: &narrower,
        requested: Some(requested),
        code: "entries_truncated",
        inline_max: Some(INLINE_BLOCKS),
        paging: None,
    })
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

/// `getWeekIdentifier`: the week of a `YYYYMMDD` date as `YYYY-WW`. Not ISO weeks: week 1 is the first 7
/// days of the year, whatever weekday they start on. `None` for a date whose month or day digits are
/// missing (fewer than seven digits): it has no week. A 7- or 9-digit date does get one, from the
/// characters at the same places (LogSeq's journal days always have eight digits).
pub fn week_identifier(date: i64) -> Option<String> {
    let text: Vec<char> = date.to_string().chars().collect();
    // `substring(from, to)`
    let part = |from: usize, to: usize| -> String { text.iter().skip(from).take(to - from).collect() };
    let year = part(0, 4);
    let week = match (parse_int(&year), parse_int(&part(4, 6)), parse_int(&part(6, 8))) {
        (Some(y), Some(month), Some(day)) => {
            let day_of_year = utc_days(y, month, day) - utc_days(y, 1, 1);
            Some(day_of_year.div_euclid(7) + 1)
        }
        _ => None,
    };
    Some(format!("{year}-W{:0>2}", week?))
}

/// `getMonthIdentifier`: the month of a date as `YYYYMM`.
pub fn month_identifier(date: i64) -> String {
    date.to_string().chars().take(6).collect()
}

/// The key of the period a day falls in, for a grouping. `None` for a day with no week, which is
/// grouped with the undated mentions: in no period.
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

    fn places(entries: &[Entry]) -> Vec<(Option<i64>, Vec<usize>)> {
        entries.iter().map(|e| (e.date, e.blocks.clone())).collect()
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
    fn a_block_with_no_day_passes_and_a_zero_bound_is_no_bound() {
        let blocks = vec![block(1, Some(20250101)), block(2, Some(20250201)), block(3, None), block(4, Some(0))];
        let ids = |blocks: Vec<Value>| blocks.iter().map(|b| b["id"].as_i64().unwrap()).collect::<Vec<_>>();
        assert_eq!(ids(filter_by_dates(blocks.clone(), Some(20250115), None)), [2, 3, 4]);
        assert_eq!(ids(filter_by_dates(blocks.clone(), None, Some(20250115))), [1, 3, 4]);
        assert_eq!(ids(filter_by_dates(blocks.clone(), Some(20250101), Some(20250101))), [1, 3, 4]);
        assert_eq!(ids(filter_by_dates(blocks.clone(), Some(0), Some(0))), [1, 2, 3, 4]);
        // a day of 0 is no day: block 4 is undated, as `journalDayOf(page) || undefined` has it
        assert_eq!(day_of(&blocks[3]), None);
    }

    #[test]
    fn the_timeline_is_oldest_first_with_the_undated_last_and_a_day_keeps_its_blocks_in_order() {
        let blocks = vec![block(1, None), block(2, Some(20250201)), block(3, Some(20250101)), block(4, Some(20250201)), block(5, None)];
        let timeline = full_timeline(&blocks);
        assert_eq!(places(&timeline), [(Some(20250101), vec![2]), (Some(20250201), vec![1, 3]), (None, vec![0, 4])]);
    }

    #[test]
    fn the_cap_keeps_the_first_mentions_in_timeline_order_and_may_split_a_day() {
        let blocks = vec![block(1, Some(20250101)), block(2, Some(20250101)), block(3, Some(20250102)), block(4, None)];
        let full = full_timeline(&blocks);
        assert_eq!(places(&cap_timeline(&full, 3)), [(Some(20250101), vec![0, 1]), (Some(20250102), vec![2])]);
        assert_eq!(places(&cap_timeline(&full, 1)), [(Some(20250101), vec![0])]);
        assert_eq!(cap_timeline(&full, 0), []);
        assert_eq!(cap_timeline(&full, 4), full);
        assert_eq!(cap_timeline(&full, 99_999), full);
        assert_eq!(shown_places(4, &cap_timeline(&full, 3)), [0, 1, 2]);
    }

    #[test]
    fn a_cut_names_where_the_timeline_ends_and_what_the_dates_can_reach() {
        let blocks: Vec<Value> = (1..=6).map(|i| block(i, if i <= 4 { Some(20250100 + i) } else { None })).collect();
        let full = full_timeline(&blocks);
        let kept = cap_timeline(&full, 2);
        let warning = entries_truncated(&full, &kept, 6, 2, 2);
        assert_eq!(warning.code, "entries_truncated");
        assert_eq!(warning.message, "Showing 2 of 6 mentions (oldest first, undated last; the timeline ends at 20250102).");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Set max_entries to 6 (or higher) to get all 6.")
        );
        // only undated mentions were cut: the dates can't reach them
        let kept = cap_timeline(&full, 5);
        let warning = entries_truncated(&full, &kept, 6, 5, 5);
        assert_eq!(warning.message, "Showing 5 of 6 mentions (oldest first, undated last).");
        // at the maximum: no way to fetch the rest, and the message says where to continue
        let many: Vec<Value> = (1..=600).map(|i| block(i, Some(20240101 + i))).collect();
        let full = full_timeline(&many);
        let kept = cap_timeline(&full, 700);
        let warning = entries_truncated(&full, &kept, 600, 500, 700);
        assert_eq!(warning.how_to_fetch_all, None);
        assert!(warning.message.starts_with("Showing 500 of 600 mentions (oldest first, undated last; the timeline ends at 20240601): max_entries is capped at its maximum of 500 (700 was asked for), so the rest can't be fetched in one call. Set start_date to 20240601 for later dated mentions"), "{}", warning.message);
    }

    /// A week as the TypeScript test computes it, with no date arithmetic in it: counting the days of the
    /// year, from 0, in sevens.
    fn counted_week(year: i64, month: i64, day: i64) -> String {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let lengths = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let day_of_year: i64 = lengths[..(month - 1) as usize].iter().sum::<i64>() + day - 1;
        format!("{year}-W{:02}", day_of_year / 7 + 1)
    }

    #[test]
    fn every_day_of_two_years_falls_in_the_week_that_counting_gives() {
        for year in [2024, 2025] {
            let leap = year % 4 == 0;
            let lengths = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
            for (m, length) in lengths.iter().enumerate() {
                for day in 1..=*length {
                    let date = year * 10_000 + (m as i64 + 1) * 100 + day;
                    assert_eq!(week_identifier(date), Some(counted_week(year, m as i64 + 1, day)), "{date}");
                }
            }
        }
    }

    #[test]
    fn a_week_is_the_same_on_the_days_around_a_daylight_saving_change() {
        // #249: 2025-03-09 is the day the clocks go forward in New York, 2025-04-06 in Sydney they go back
        assert_eq!(week_identifier(20250308).as_deref(), Some("2025-W10"));
        assert_eq!(week_identifier(20250309).as_deref(), Some("2025-W10"));
        assert_eq!(week_identifier(20250310).as_deref(), Some("2025-W10"));
        assert_eq!(week_identifier(20250312).as_deref(), Some("2025-W11"));
        assert_eq!(week_identifier(20250408).as_deref(), Some("2025-W14"));
        assert_eq!(week_identifier(20250409).as_deref(), Some("2025-W15"));
        assert_eq!(week_identifier(20250101).as_deref(), Some("2025-W01"));
        assert_eq!(week_identifier(20251231).as_deref(), Some("2025-W53"));
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
        // a month past 12 or a day past the month's end rolls over, as `Date.UTC` has it
        assert_eq!(week_identifier(20251301).as_deref(), Some("2025-W53"));
        assert_eq!(week_identifier(20250230), week_identifier(20250302));
    }
}
