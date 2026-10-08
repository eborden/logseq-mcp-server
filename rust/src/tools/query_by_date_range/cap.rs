//! `max_blocks` (#61): keeping the first blocks across the days of a result, and the
//! `blocks_truncated` warning that says where the cut fell and how to read on (`capEntries` and
//! `blocksTruncated` in `src/tools/query-by-date-range.ts`; #187).

use serde_json::Value;

use super::Entry;
use crate::block_budget::{Budget, count_blocks, take_blocks};
use crate::meta::ResultWarning;
use crate::truncation::LARGE_RESULT_NOTE;

/// Blocks kept when `max_blocks` is absent (#61).
pub const DEFAULT_DATE_RANGE_MAX_BLOCKS: u64 = 200;

/// Most blocks one call returns (#61). A larger `max_blocks` is clamped to it, and a cut at the
/// maximum is reported by a `blocks_truncated` warning whose `howToFetchAll` pages on from the day
/// the entries end at (#187). Dates narrow a result to whole days, so a day holding more blocks than
/// this can't be fetched whole by any call.
pub const MAX_DATE_RANGE_BLOCKS: usize = 1000;

/// Blocks an entry lists against the cap: nested ones too, or only top-level ones (the outline).
fn listed_blocks(blocks: &[Value], nested: bool) -> usize {
    if nested { count_blocks(blocks) } else { blocks.len() }
}

/// Where [`cap_entries`] cut, for the warning (`BlockCut`).
#[derive(Debug, Clone, PartialEq)]
pub struct BlockCut {
    pub entries: Vec<Entry>,
    /// Blocks there were before the cut, counted the way the cap counts them
    pub total: usize,
    /// Day of the last entry kept; `None` when nothing was kept
    pub ends_at: Option<i64>,
    /// The first day dropped; `None` when the last kept day was the last entry
    pub next_day: Option<i64>,
    /// The last kept day lost blocks
    pub split_day: bool,
    /// Blocks kept on the days before the last kept one: 0 means that day alone filled the cap
    pub kept_before: usize,
    /// Blocks the last kept day holds in all
    pub last_day_total: usize,
    /// A kept block lost some of its children
    pub partial_block: bool,
}

/// `capEntries`: keep the first `cap` blocks across `entries` (#61), in the order of the entries.
/// At or below the cap this returns `None` and the entries stay untouched. Days after the last
/// kept block are dropped, empty ones included; a day kept part-way keeps its first blocks.
pub fn cap_entries(entries: &[Entry], cap: usize, nested: bool) -> Option<BlockCut> {
    let total: usize = entries.iter().map(|entry| listed_blocks(&entry.blocks, nested)).sum();
    if total <= cap {
        return None;
    }

    let mut budget = Budget::new(cap);
    let mut kept: Vec<Entry> = Vec::new();
    let mut first_dropped: Option<&Entry> = None;
    let mut split_day = false;
    let mut kept_before = 0;
    let mut last_day_total = 0;
    for entry in entries {
        if budget.room == 0 {
            first_dropped = Some(entry);
            break;
        }
        let before = budget.room;
        let blocks = if nested {
            take_blocks(&entry.blocks, &mut budget)
        } else {
            let blocks: Vec<Value> = entry.blocks.iter().take(budget.room).cloned().collect();
            budget.room -= blocks.len();
            blocks
        };
        kept.push(Entry { blocks, ..entry.clone() });
        kept_before = cap - before;
        last_day_total = listed_blocks(&entry.blocks, nested);
        split_day = before - budget.room < last_day_total;
    }
    let ends_at = kept.last().map(|last| last.date);
    Some(BlockCut {
        entries: kept,
        total,
        ends_at,
        next_day: first_dropped.map(|entry| entry.date),
        split_day,
        kept_before,
        last_day_total,
        partial_block: budget.partial,
    })
}

/// What [`blocks_truncated`] needs besides the cut.
pub struct TruncationOptions {
    /// The cap counts nested blocks (full and slim output), not only top-level ones (the outline)
    pub nested: bool,
    /// `last_n` order: newest first, so the way on is older days
    pub newest_first: bool,
    pub start: i64,
    pub end: i64,
    /// The `max_blocks` the caller asked for, before it was clamped
    pub requested: u64,
}

/// `blocksTruncated`: the `blocks_truncated` warning (#187). The message says what was kept and
/// where the entries end, plus any fact about a day that no date range can fix. `howToFetchAll`
/// leads with paging: a call from the day where the entries stop, with the same end of the range
/// and the same `max_blocks`, which reaches whole days after the cut and never part of one. That is
/// a real fetch-the-rest parameter, so `hasMore` stays true at the maximum too (BR-0006, paged-cap
/// amendment) whenever such a call exists.
///
/// The advice always moves the reader forward, and every branch is literally true:
///  - cut between days: page from the first day dropped
///  - cut inside a day after earlier days: page from that day, which repeats its kept blocks (if it
///    is the last day, that reads the rest of it). A day bigger than the cap is handled like the
///    first day below: it alone fills a call from it
///  - a day alone filling the cap (the first day, or a split day bigger than the cap): a query from
///    it at this cap reads only its first blocks, so the way forward is that day alone at a higher
///    cap (within the maximum), then paging; a day over the maximum can't be fetched whole, so page
///    past it (or, with no later day, offer a `search_term` and no `howToFetchAll`)
///  - nothing kept (a cap of 0): there is no day to page from, so raise the cap
///
/// A raise of `max_blocks` is suggested only there and says a result that large may not be shown by
/// the host.
pub fn blocks_truncated(cut: &BlockCut, shown: usize, options: &TruncationOptions) -> ResultWarning {
    let TruncationOptions { nested, newest_first, start, end, requested } = *options;
    let BlockCut { ends_at, next_day, split_day, kept_before, last_day_total, total, .. } = *cut;
    let max = MAX_DATE_RANGE_BLOCKS;
    let at_max = shown >= max;
    let direction = if newest_first { "older" } else { "later" };
    let day = |value: i64| value.to_string();
    // The dates that read on from `day`: the same end of the range, or for `last_n` (newest first) the same start
    let from = |value: i64| {
        if newest_first {
            format!("start_date {}, end_date {}", day(start), day(value))
        } else {
            format!("start_date {}, the same end_date ({})", day(value), day(end))
        }
    };
    let call_again = |value: i64| format!("Call again with {} and the same max_blocks", from(value));

    // Facts go in the message. The way forward goes in howToFetchAll, or in the message when
    // nothing can be fetched (no howToFetchAll, so hasMore is false).
    let mut facts: Vec<String> = Vec::new();
    let how_to_fetch_all: Option<String>;
    if let Some(ends_at) = ends_at {
        if !split_day {
            how_to_fetch_all = Some(format!("{} to read the {direction} days, or add a search_term.", call_again(next_day.unwrap_or(ends_at))));
        } else if last_day_total <= shown {
            // Cut inside a day that fits the cap (so earlier days were kept): a call from it reads that day whole
            how_to_fetch_all = Some(match next_day {
                Some(_) => format!(
                    "{} to read the {direction} days (day {} repeats its kept blocks), or add a search_term.",
                    call_again(ends_at),
                    day(ends_at)
                ),
                None => format!(
                    "{} to read the rest of day {} (it repeats its kept blocks), or add a search_term.",
                    call_again(ends_at),
                    day(ends_at)
                ),
            });
        } else if last_day_total > max {
            // The day holds more than any call returns, so no call reads it whole
            facts.push(if kept_before > 0 {
                format!("A day is the narrowest date range, so day {}, with {last_day_total} blocks, can't be fetched whole.", day(ends_at))
            } else {
                format!("Day {} holds {last_day_total} blocks, more than the maximum of {max}, so no call can return it whole.", day(ends_at))
            });
            if next_day.is_some() {
                how_to_fetch_all = Some(format!(
                    "{} for the rest of the range, or add a search_term to read day {} in pieces.",
                    call_again(next_day.expect("checked")),
                    day(ends_at)
                ));
            } else if !at_max {
                how_to_fetch_all = Some(format!(
                    "Set max_blocks to {max} (the maximum) with start_date {0} and end_date {0} to read {max} of its \
                     {last_day_total} blocks, or add a search_term to read it in pieces. {LARGE_RESULT_NOTE}",
                    day(ends_at)
                ));
            } else {
                // Nothing is left to fetch: no howToFetchAll, so hasMore is false
                facts.push("Add a search_term to narrow it.".to_owned());
                how_to_fetch_all = None;
            }
        } else {
            // The day alone fills the cap but fits the maximum: a call from it at this cap reads only its first `shown` blocks
            facts.push(if kept_before > 0 {
                format!(
                    "Day {} holds {last_day_total} blocks, more than {shown}, so a query from it at this max_blocks reads only its first {shown}.",
                    day(ends_at)
                )
            } else {
                format!(
                    "Day {} alone holds {last_day_total} blocks, more than {shown}, so a query from it returns the same blocks at this max_blocks.",
                    day(ends_at)
                )
            });
            let then = match next_day {
                Some(next) => format!(" Then continue with {} and max_blocks {shown}.", from(next)),
                None => String::new(),
            };
            how_to_fetch_all = Some(format!(
                "To read it whole, call again with start_date {0}, end_date {0} and max_blocks {last_day_total}. \
                 {LARGE_RESULT_NOTE} If it comes back saved, read the day in pieces with a search_term.{then}",
                day(ends_at)
            ));
        }
    } else {
        how_to_fetch_all = Some(if total <= max {
            format!("Set max_blocks to {total} (or higher) to get all {total}. {LARGE_RESULT_NOTE}")
        } else {
            format!(
                "Set max_blocks to {max} (the maximum) to get {max} of {total}. Narrow the dates or last_n, or add a search_term. {LARGE_RESULT_NOTE}"
            )
        });
    }

    let unit = if nested { "nested ones counted" } else { "top-level only" };
    let order = if newest_first { "newest day first" } else { "oldest day first" };
    let ends = ends_at.map(|ends_at| format!("; the entries end at {}", day(ends_at))).unwrap_or_default();
    let partial = if cut.partial_block { "; a kept block shows fewer children than it has (childrenTruncated)" } else { "" };
    let base = format!("Showing {shown} of {total} blocks ({unit}; {order}{ends}{partial})");
    let clamped = if requested > max as u64 { format!(" ({requested} was asked for)") } else { String::new() };
    let head = if at_max {
        format!("{base}: max_blocks is capped at its maximum of {max}{clamped}, so the rest can't be fetched in one call.")
    } else {
        format!("{base}.")
    };
    let message = std::iter::once(head).chain(facts).collect::<Vec<_>>().join(" ");
    ResultWarning { code: "blocks_truncated".to_owned(), message, how_to_fetch_all }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A top-level block with `children` leaves under it
    fn block(id: i64, children: usize) -> Value {
        let kids: Vec<Value> = (0..children).map(|c| json!({"id": id * 100 + c as i64, "children": []})).collect();
        json!({"id": id, "children": kids})
    }

    fn entry(date: i64, blocks: Vec<Value>) -> Entry {
        Entry { date, page: Default::default(), blocks }
    }

    fn options(nested: bool) -> TruncationOptions {
        TruncationOptions { nested, newest_first: false, start: 20250101, end: 20250110, requested: 5 }
    }

    #[test]
    fn at_or_below_the_cap_nothing_is_cut() {
        let entries = [entry(20250101, vec![block(1, 1)]), entry(20250102, vec![block(2, 0)])];
        assert!(cap_entries(&entries, 3, true).is_none());
        assert!(cap_entries(&entries, 5, true).is_none());
        // top-level only: 2 blocks
        assert!(cap_entries(&entries, 2, false).is_none());
    }

    #[test]
    fn a_cap_between_days_drops_the_later_days_and_names_the_first_one_dropped() {
        let entries = [entry(20250101, vec![block(1, 1)]), entry(20250102, vec![block(2, 0)]), entry(20250103, vec![])];
        let cut = cap_entries(&entries, 2, true).unwrap();
        assert_eq!((cut.total, cut.ends_at, cut.next_day, cut.split_day, cut.kept_before, cut.last_day_total), (3, Some(20250101), Some(20250102), false, 0, 2));
        assert_eq!(cut.entries.len(), 1);
        let warning = blocks_truncated(&cut, 2, &options(true));
        assert_eq!(
            warning.message,
            "Showing 2 of 3 blocks (nested ones counted; oldest day first; the entries end at 20250101)."
        );
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Call again with start_date 20250102, the same end_date (20250110) and the same max_blocks to read the later days, or add a search_term.")
        );
    }

    #[test]
    fn a_cut_inside_a_later_day_that_fits_says_the_day_repeats_its_kept_blocks() {
        let entries = [entry(20250101, vec![block(1, 0)]), entry(20250102, vec![block(2, 0), block(3, 0)]), entry(20250103, vec![block(4, 0)])];
        let cut = cap_entries(&entries, 2, true).unwrap();
        assert_eq!((cut.ends_at, cut.next_day, cut.split_day, cut.kept_before), (Some(20250102), Some(20250103), true, 1));
        let warning = blocks_truncated(&cut, 2, &options(true));
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Call again with start_date 20250102, the same end_date (20250110) and the same max_blocks to read the later days (day 20250102 repeats its kept blocks), or add a search_term.")
        );
        // with no day after it, the call reads the rest of that day
        let entries = [entry(20250101, vec![block(1, 0)]), entry(20250102, vec![block(2, 0), block(3, 0)])];
        let cut = cap_entries(&entries, 2, true).unwrap();
        assert!(blocks_truncated(&cut, 2, &options(true)).how_to_fetch_all.unwrap().contains("to read the rest of day 20250102 (it repeats its kept blocks)"));
    }

    #[test]
    fn a_partial_block_is_said_so_and_a_cap_of_zero_keeps_nothing() {
        let entries = [entry(20250101, vec![block(1, 3)])];
        let cut = cap_entries(&entries, 2, true).unwrap();
        assert!(cut.partial_block);
        assert!(blocks_truncated(&cut, 2, &options(true)).message.contains("; a kept block shows fewer children than it has (childrenTruncated)"));
        let cut = cap_entries(&entries, 0, true).unwrap();
        assert_eq!((cut.entries.len(), cut.ends_at, cut.next_day), (0, None, Some(20250101)));
        let warning = blocks_truncated(&cut, 0, &options(true));
        assert_eq!(warning.message, "Showing 0 of 4 blocks (nested ones counted; oldest day first).");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some(format!("Set max_blocks to 4 (or higher) to get all 4. {LARGE_RESULT_NOTE}").as_str())
        );
    }

    #[test]
    fn a_day_alone_filling_the_cap_is_read_whole_at_a_higher_cap() {
        let entries = [entry(20250101, vec![block(1, 5)]), entry(20250102, vec![block(2, 0)])];
        let cut = cap_entries(&entries, 3, true).unwrap();
        let warning = blocks_truncated(&cut, 3, &options(true));
        assert_eq!(
            warning.message,
            "Showing 3 of 7 blocks (nested ones counted; oldest day first; the entries end at 20250101; a kept block shows fewer children than it has (childrenTruncated)). \
             Day 20250101 alone holds 6 blocks, more than 3, so a query from it returns the same blocks at this max_blocks."
        );
        assert_eq!(
            warning.how_to_fetch_all.unwrap(),
            format!(
                "To read it whole, call again with start_date 20250101, end_date 20250101 and max_blocks 6. {LARGE_RESULT_NOTE} \
                 If it comes back saved, read the day in pieces with a search_term. Then continue with start_date 20250102, the same end_date (20250110) and max_blocks 3."
            )
        );
    }

    #[test]
    fn a_later_day_over_what_is_left_of_the_cap_is_read_from_its_own_start_then_on() {
        // 1, 5 and 1 top-level blocks, a cap of 3: the second day is cut after earlier days were kept
        let rows = |first: i64, n: i64| (first..first + n).map(|id| block(id, 0)).collect::<Vec<_>>();
        let entries = [entry(20250101, rows(1, 1)), entry(20250102, rows(10, 5)), entry(20250103, rows(20, 1))];
        let warning = blocks_truncated(&cap_entries(&entries, 3, false).unwrap(), 3, &options(false));
        assert_eq!(
            warning.message,
            "Showing 3 of 7 blocks (top-level only; oldest day first; the entries end at 20250102). \
             Day 20250102 holds 5 blocks, more than 3, so a query from it at this max_blocks reads only its first 3."
        );
        assert_eq!(
            warning.how_to_fetch_all.unwrap(),
            format!(
                "To read it whole, call again with start_date 20250102, end_date 20250102 and max_blocks 5. {LARGE_RESULT_NOTE} \
                 If it comes back saved, read the day in pieces with a search_term. Then continue with start_date 20250103, the same end_date (20250110) and max_blocks 3."
            )
        );
    }

    #[test]
    fn newest_first_pages_on_to_older_days() {
        let entries = [entry(20250109, vec![block(1, 0)]), entry(20250108, vec![block(2, 0)])];
        let cut = cap_entries(&entries, 1, true).unwrap();
        let warning = blocks_truncated(&cut, 1, &TruncationOptions { newest_first: true, ..options(true) });
        assert_eq!(warning.message, "Showing 1 of 2 blocks (nested ones counted; newest day first; the entries end at 20250109).");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Call again with start_date 20250101, end_date 20250108 and the same max_blocks to read the older days, or add a search_term.")
        );
    }

    fn big_day(n: usize) -> Entry {
        entry(20250101, (0..n as i64).map(|i| block(i + 1, 0)).collect())
    }

    #[test]
    fn a_day_over_the_maximum_cannot_be_read_whole() {
        let cut = cap_entries(&[big_day(1200)], 200, true).unwrap();
        let warning = blocks_truncated(&cut, 200, &options(true));
        assert_eq!(
            warning.message,
            "Showing 200 of 1200 blocks (nested ones counted; oldest day first; the entries end at 20250101). \
             Day 20250101 holds 1200 blocks, more than the maximum of 1000, so no call can return it whole."
        );
        assert_eq!(
            warning.how_to_fetch_all.unwrap(),
            format!(
                "Set max_blocks to 1000 (the maximum) with start_date 20250101 and end_date 20250101 to read 1000 of its 1200 blocks, \
                 or add a search_term to read it in pieces. {LARGE_RESULT_NOTE}"
            )
        );
        // at the maximum with no later day there is nothing to fetch
        let warning = blocks_truncated(&cap_entries(&[big_day(1200)], 1000, true).unwrap(), 1000, &TruncationOptions { requested: 5000, ..options(true) });
        assert!(warning.how_to_fetch_all.is_none());
        assert_eq!(
            warning.message,
            "Showing 1000 of 1200 blocks (nested ones counted; oldest day first; the entries end at 20250101): max_blocks is capped at its maximum of 1000 \
             (5000 was asked for), so the rest can't be fetched in one call. Day 20250101 holds 1200 blocks, more than the maximum of 1000, so no call can return it whole. \
             Add a search_term to narrow it."
        );
        // with a later day, page past it
        let entries = [big_day(1200), entry(20250102, vec![block(1, 0)])];
        let warning = blocks_truncated(&cap_entries(&entries, 1000, true).unwrap(), 1000, &options(true));
        assert_eq!(
            warning.how_to_fetch_all.unwrap(),
            "Call again with start_date 20250102, the same end_date (20250110) and the same max_blocks for the rest of the range, or add a search_term to read day 20250101 in pieces."
        );
    }

    #[test]
    fn the_outline_counts_top_level_blocks_only() {
        let entries = [entry(20250101, vec![block(1, 9), block(2, 9)])];
        assert!(cap_entries(&entries, 2, false).is_none());
        let cut = cap_entries(&entries, 1, false).unwrap();
        assert_eq!((cut.total, cut.entries[0].blocks.len()), (2, 1));
        // the kept block keeps its children: the outline counts them in `blockCount`
        assert_eq!(cut.entries[0].blocks[0], block(1, 9));
        assert!(blocks_truncated(&cut, 1, &options(false)).message.contains("(top-level only;"));
    }

    #[test]
    fn a_cap_of_zero_over_more_than_the_maximum_says_to_narrow() {
        let cut = cap_entries(&[big_day(1001)], 0, true).unwrap();
        assert_eq!(
            blocks_truncated(&cut, 0, &options(true)).how_to_fetch_all.unwrap(),
            format!("Set max_blocks to 1000 (the maximum) to get 1000 of 1001. Narrow the dates or last_n, or add a search_term. {LARGE_RESULT_NOTE}")
        );
    }
}
