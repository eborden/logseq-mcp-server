//! `max_blocks` (#61): keeping the first blocks across the days of a result, and the
//! `blocks_truncated` warning that says where the cut fell and how to read on (#187), and the character budget
//! (#485) that cuts the same way, in blocks, until the text fits.
//!
//! A raise of `max_blocks` is offered only when the raised result is inside the character budget, with a tenth of it
//! kept back (#485, BR-0006): a call that returns the same blocks cut by the budget is no way to fetch the rest. A cut
//! that no parameter reads on says so in its message and has no `howToFetchAll`, so `hasMore` is false.
//!
//! Entries are days, oldest first (or newest first for `last_n` with no page), and with a page and no period the
//! mentions on non-journal pages come last in an entry of their own, which no date reaches.

use serde_json::Value;

use super::Entry;
use crate::block_budget::{Budget, count_blocks, take_blocks};
use crate::budget::{BUDGET_CHARS, Fit, fit, size};
use crate::meta::ResultWarning;
use crate::truncation::{SizeCut, size_truncation_warning};

/// Blocks kept when `max_blocks` is absent (#61).
pub const DEFAULT_MAX_BLOCKS: u64 = 200;

/// Most blocks one call returns (#61). A larger `max_blocks` is clamped to it, and a cut at the
/// maximum is reported by a `blocks_truncated` warning whose `howToFetchAll` pages on from the day
/// the entries end at (#187). Dates narrow a result to whole days, so a day holding more blocks than
/// this can't be fetched whole by any call.
pub const MAX_BLOCKS: usize = 1000;

/// How a day is read in pieces when no call reads it whole.
const IN_PIECES: &str = "logseq_find_blocks (start_date and end_date set to that day, with limit and offset)";

/// Said when a call that reads on by dates leaves out the mentions on non-journal pages, which have no day.
const UNDATED_NOTE: &str = " Setting dates leaves out the mentions on non-journal pages.";

/// How the blocks with no day are read: the page's own blocks by `page`, the blocks that link to it by `links_to`.
const NO_DAY_WAY: &str = "logseq_find_blocks with page (its own blocks) or links_to (the blocks that link to it), with limit and offset";

/// Blocks an entry lists against the cap: nested ones too, or only top-level ones (the outline).
fn listed_blocks(blocks: &[Value], nested: bool) -> usize {
    if nested { count_blocks(blocks) } else { blocks.len() }
}

/// Where in the entries something is: no entry, a day, or the entry of blocks with no day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    Nowhere,
    Day(i64),
    Undated,
}

impl Place {
    fn of(entry: &Entry) -> Place {
        entry.date.map_or(Place::Undated, Place::Day)
    }
}

/// Where [`cap_entries`] cut, for the warning (`BlockCut`).
#[derive(Debug, Clone, PartialEq)]
pub struct BlockCut {
    pub entries: Vec<Entry>,
    /// Blocks there were before the cut, counted the way the cap counts them
    pub total: usize,
    /// The last entry kept; `Nowhere` when nothing was kept
    pub last: Place,
    /// The first entry dropped; `Nowhere` when the last kept entry was the last entry
    pub next: Place,
    /// The last kept entry lost blocks
    pub split: bool,
    /// Blocks kept on the entries before the last kept one: 0 means that entry alone filled the cap
    pub kept_before: usize,
    /// Blocks the last kept entry holds in all
    pub last_total: usize,
    /// A kept block lost some of its children
    pub partial_block: bool,
}

/// Keeps the first `cap` blocks across `entries` (#61), in the order of the entries.
/// At or below the cap this returns `None` and the entries stay untouched. Entries after the last
/// kept block are dropped, empty ones included; an entry kept part-way keeps its first blocks.
pub fn cap_entries(entries: &[Entry], cap: usize, nested: bool) -> Option<BlockCut> {
    let total: usize = entries.iter().map(|entry| listed_blocks(&entry.blocks, nested)).sum();
    if total <= cap {
        return None;
    }

    let mut budget = Budget::new(cap);
    let mut kept: Vec<Entry> = Vec::new();
    let mut first_dropped: Option<&Entry> = None;
    let mut split = false;
    let mut kept_before = 0;
    let mut last_total = 0;
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
        last_total = listed_blocks(&entry.blocks, nested);
        split = before - budget.room < last_total;
    }
    let last = kept.last().map_or(Place::Nowhere, Place::of);
    Some(BlockCut {
        entries: kept,
        total,
        last,
        next: first_dropped.map_or(Place::Nowhere, Place::of),
        split,
        kept_before,
        last_total,
        partial_block: budget.partial,
    })
}

/// What [`blocks_truncated`] and the size cut need besides the cut.
pub struct TruncationOptions {
    /// The cap counts nested blocks (full and slim output), not only top-level ones (the outline)
    pub nested: bool,
    /// `last_n` order: newest first, so the way on is older days
    pub newest_first: bool,
    pub start: i64,
    pub end: i64,
    /// The `max_blocks` the caller asked for, before it was clamped
    pub requested: u64,
    /// A `page` was given, so a call that reads on names it again
    pub with_page: bool,
    /// The result holds mentions on non-journal pages, which a period leaves out
    pub has_undated: bool,
}

impl TruncationOptions {
    /// What a call that reads on starts with: the page again, when there is one.
    fn same_page(&self) -> &'static str {
        if self.with_page { "the same page, " } else { "" }
    }

    /// The dates that read on from `day`: the same end of the range, or for `last_n` (newest first) the same start.
    fn from(&self, day: i64) -> String {
        if self.newest_first {
            format!("start_date {}, end_date {day}", self.start)
        } else {
            format!("start_date {day}, the same end_date ({})", self.end)
        }
    }

    /// How to narrow a result no call returns whole.
    fn narrow(&self) -> &'static str {
        "Narrow the period, or read the blocks with logseq_find_blocks (with limit and offset)."
    }
}

/// What a raise of `max_blocks` would return, so the warning offers one only when it fits the character budget.
/// `all` are the entries before the count cap; `fits` says whether a result with some of them is inside the budget.
pub struct Raises<'a> {
    pub all: &'a [Entry],
    pub nested: bool,
    pub fits: &'a dyn Fn(&[Entry]) -> bool,
}

impl Raises<'_> {
    /// Whether the call with `max_blocks` raised to `blocks`, the same period, fits.
    fn all_at(&self, blocks: usize) -> bool {
        match cap_entries(self.all, blocks, self.nested) {
            None => (self.fits)(self.all),
            Some(cut) => (self.fits)(&cut.entries),
        }
    }

    /// Whether the call for one day alone, with `max_blocks` at `blocks`, fits.
    fn day_at(&self, day: i64, blocks: usize) -> bool {
        let Some(entry) = self.all.iter().find(|entry| entry.date == Some(day)) else { return false };
        let one = [entry.clone()];
        match cap_entries(&one, blocks, self.nested) {
            None => (self.fits)(&one),
            Some(cut) => (self.fits)(&cut.entries),
        }
    }
}

/// The `blocks_truncated` warning (#187). The message says what was kept and
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
///    cap, when that result fits the character budget, then paging; a day that can't be fetched whole (over the
///    maximum, or over the budget) is paged past, or read in pieces with `logseq_find_blocks`
///  - the mentions on non-journal pages (no day): no date reaches them, so only a raise of `max_blocks` can, and it is
///    offered only when it fits
///  - nothing kept (a cap of 0): there is no day to page from, so raise the cap, when that fits
///
/// A raise of `max_blocks` is offered only where the raised result fits, so no call returns the same blocks cut again.
pub fn blocks_truncated(cut: &BlockCut, shown: usize, options: &TruncationOptions, raises: &Raises) -> ResultWarning {
    let BlockCut { last, next, split, kept_before, last_total, total, .. } = *cut;
    let (nested, newest_first, requested) = (options.nested, options.newest_first, options.requested);
    let max = MAX_BLOCKS;
    let at_max = shown >= max;
    let direction = if newest_first { "older" } else { "later" };
    let page = options.same_page();
    let call_again = |day: i64| format!("Call again with {page}{} and the same max_blocks", options.from(day));
    let undated_note = if options.has_undated { UNDATED_NOTE } else { "" };

    // Facts go in the message. The way forward goes in howToFetchAll, or in the message when
    // nothing can be fetched (no howToFetchAll, so hasMore is false).
    let mut facts: Vec<String> = Vec::new();
    let how_to_fetch_all: Option<String>;
    match (last, split) {
        (Place::Nowhere, _) => {
            // Nothing kept: raise the cap to everything, or to the maximum, when that fits
            how_to_fetch_all = raise_all(raises, total, shown, max, &mut facts, options);
        }
        (Place::Undated, _) => {
            // Cut among the mentions on non-journal pages: no date reaches the rest
            facts.push("The rest are mentions on non-journal pages, which no dates reach.".to_owned());
            how_to_fetch_all = raise_all(raises, total, shown, max, &mut facts, options);
        }
        (Place::Day(_), false) => match next {
            Place::Day(day) => {
                how_to_fetch_all = Some(format!("{} to read the {direction} days.{undated_note}", call_again(day)));
            }
            Place::Undated | Place::Nowhere => {
                // Everything dated was kept: the rest are mentions on non-journal pages
                facts.push("The rest are mentions on non-journal pages, which no dates reach.".to_owned());
                how_to_fetch_all = raise_all(raises, total, shown, max, &mut facts, options);
            }
        },
        (Place::Day(day), true) => {
            if last_total <= shown && raises.day_at(day, last_total) {
                // Cut inside a day that fits the cap and the budget alone (so earlier days were kept): a call from it reads that day whole
                how_to_fetch_all = Some(match next {
                    Place::Day(_) => format!("{} to read the {direction} days (day {day} repeats its kept blocks).", call_again(day)),
                    _ => format!("{} to read the rest of day {day} (it repeats its kept blocks).{undated_note}", call_again(day)),
                });
            } else if last_total <= max && raises.day_at(day, last_total) {
                // The day alone fills the cap but fits the maximum and the budget: a call from it at this cap reads only
                // its first `shown` blocks
                facts.push(if kept_before > 0 {
                    format!("Day {day} holds {last_total} blocks, more than {shown}, so a query from it at this max_blocks reads only its first {shown}.")
                } else {
                    format!("Day {day} alone holds {last_total} blocks, more than {shown}, so a query from it returns the same blocks at this max_blocks.")
                });
                let then = match next {
                    Place::Day(next_day) => format!(" Then continue with {page}{} and max_blocks {shown}.", options.from(next_day)),
                    _ => String::new(),
                };
                how_to_fetch_all = Some(format!("To read it whole, call again with {page}start_date {day}, end_date {day} and max_blocks {last_total}.{then}"));
            } else {
                // No call reads the day whole: past the maximum, or past the budget
                facts.push(if last_total > max {
                    if kept_before > 0 {
                        format!("A day is the narrowest date range, so day {day}, with {last_total} blocks, can't be fetched whole.")
                    } else {
                        format!("Day {day} holds {last_total} blocks, more than the maximum of {max}, so no call can return it whole.")
                    }
                } else {
                    format!("Day {day} holds {last_total} blocks, more than fit in {BUDGET_CHARS} characters, so no call can return it whole.")
                });
                how_to_fetch_all = if let Place::Day(next_day) = next {
                    Some(format!("{} for the rest of the range, or read day {day} in pieces with {IN_PIECES}.", call_again(next_day)))
                } else if last_total > max && !at_max && raises.day_at(day, max) {
                    Some(format!(
                        "Set max_blocks to {max} (the maximum) with {page}start_date {day} and end_date {day} to read {max} of its \
                         {last_total} blocks, or read it in pieces with {IN_PIECES}."
                    ))
                } else {
                    // Nothing is left to fetch: no howToFetchAll, so hasMore is false
                    facts.push(format!("Read it in pieces with {IN_PIECES}."));
                    None
                };
            }
        }
    }

    let unit = if nested { "nested ones counted" } else { "top-level only" };
    let order = if newest_first { "newest day first" } else { "oldest day first" };
    let ends = match last {
        Place::Day(day) => format!("; the entries end at {day}"),
        Place::Undated => "; the entries end among the mentions on non-journal pages".to_owned(),
        Place::Nowhere => String::new(),
    };
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

/// A raise of `max_blocks` to everything there is, or to the maximum, when the raised result fits the budget; when it
/// doesn't, a fact says so and there is no `howToFetchAll`. At the maximum already (`shown` is `max`) a raise is the call
/// just made, so none is offered: the blocks with no day can only be read with `find_blocks`.
fn raise_all(raises: &Raises, total: usize, shown: usize, max: usize, facts: &mut Vec<String>, options: &TruncationOptions) -> Option<String> {
    if shown >= max {
        facts.push(format!("No call reads the rest in one go: read them with {NO_DAY_WAY}."));
        return None;
    }
    let target = total.min(max);
    if !raises.all_at(target) {
        facts.push(format!("No call returns them inside {BUDGET_CHARS} characters. {}", options.narrow()));
        return None;
    }
    Some(if total <= max {
        format!("Set max_blocks to {total} (or higher) to get all {total}.")
    } else {
        format!("Set max_blocks to {max} (the maximum) to get {max} of {total}. {}", options.narrow())
    })
}

/// The `result_size_truncated` warning for a result cut to `kept` blocks of the `cut.total` it held (#485). Like
/// [`blocks_truncated`] it names the day to read on from, since a call from a day reads whole days after the cut;
/// unlike it, no `max_blocks` raise is offered, because the budget is in characters and a larger cap only brings
/// the same cut back. A day that alone fills the budget can't be read whole by any call, so then the way on is
/// the days after it, or `logseq_find_blocks` to read it in pieces. The mentions on non-journal pages have no day, so
/// no date reads on to them.
fn size_truncated(cut: &BlockCut, kept: usize, oversize: bool, options: &TruncationOptions) -> ResultWarning {
    let direction = if options.newest_first { "older" } else { "later" };
    let page = options.same_page();
    let undated_note = if options.has_undated { UNDATED_NOTE } else { "" };
    let (advice, how_to_fetch_all) = match (cut.last, cut.next) {
        // Cut between days: the days after it are whole days a call can read
        (Place::Day(_), Place::Day(next)) if !cut.split => (
            "No parameter raises this limit.".to_owned(),
            Some(format!("Call again with {page}{} to read the {direction} days.{undated_note}", options.from(next))),
        ),
        // Cut inside a day after earlier days: a call from it repeats its kept blocks and reads the rest of it
        (Place::Day(day), _) if cut.split && cut.kept_before > 0 => (
            "No parameter raises this limit.".to_owned(),
            Some(format!("Call again with {page}{} to read on (day {day} repeats its kept blocks).{undated_note}", options.from(day))),
        ),
        // The first day alone fills the budget: a call from it would cut it the same way
        (Place::Day(day), Place::Day(next)) => (
            format!("Day {day} alone fills this limit, so no call reads it whole: read it in pieces with {IN_PIECES}."),
            Some(format!("Call again with {page}{} to read the {direction} days.{undated_note}", options.from(next))),
        ),
        (Place::Day(day), _) if cut.split => (
            format!("Day {day} alone fills this limit, so no call reads it whole: read it in pieces with {IN_PIECES}."),
            None,
        ),
        // The rest are mentions on non-journal pages, which no date reaches
        (Place::Day(_) | Place::Undated, _) => (
            "The rest are mentions on non-journal pages, which no dates reach. No parameter raises this limit: read them with logseq_find_blocks \
             (links_to the page, with limit and offset)."
                .to_owned(),
            None,
        ),
        // Nothing kept can't happen (a cut keeps a block), but say nothing false if it does
        (Place::Nowhere, _) => (options.narrow().to_owned(), None),
    };
    size_truncation_warning(SizeCut { what: "blocks", kept, total: cut.total, oversize, advice: &advice, how_to_fetch_all })
}

/// The text of the result, as it is when it fits the character budget (#485), else with the first blocks that do:
/// `write` makes the text for some entries, the warnings and the `totals` (blocks, days), and the cut is the one
/// `max_blocks` makes, so it falls where a smaller `max_blocks` would put it. `entries` are the ones the count cap
/// kept, resolved refs and all, and `totals` are the count cap's, or made here when only the budget cut.
///
/// When the budget cuts a result the count cap had already cut, the `howToFetchAll` of the count cap's warning goes:
/// it names a call from where that cut fell, which skips what the budget dropped, and the size warning names the call
/// that reads on from the cut as it is.
pub fn write_within_budget(
    entries: &[Entry],
    warnings: &[ResultWarning],
    totals: Option<(usize, usize)>,
    options: &TruncationOptions,
    write: impl Fn(&[Entry], &[ResultWarning], Option<(usize, usize)>) -> String,
) -> String {
    let nested = options.nested;
    let total: usize = entries.iter().map(|entry| listed_blocks(&entry.blocks, nested)).sum();
    let text_for = |kept: usize, oversize: bool| match cap_entries(entries, kept, nested) {
        None => write(entries, warnings, totals),
        Some(cut) => {
            let mut warned: Vec<ResultWarning> = warnings.to_vec();
            for warning in warned.iter_mut().filter(|warning| warning.code == "blocks_truncated") {
                warning.how_to_fetch_all = None;
            }
            warned.push(size_truncated(&cut, kept, oversize, options));
            write(&cut.entries, &warned, totals.or(Some((total, day_count(entries)))))
        }
    };
    match fit(total, 1, |kept| size(&text_for(kept, false))) {
        Fit::Whole => write(entries, warnings, totals),
        Fit::Cut { kept, oversize } => text_for(kept, oversize),
    }
}

/// The days among entries: the entries with a date.
pub fn day_count(entries: &[Entry]) -> usize {
    entries.iter().filter(|entry| entry.date.is_some()).count()
}

/// A raise is offered only when its result is inside the budget with a tenth of it kept back, since the raised call
/// resolves the refs of the blocks it adds and carries its own meta, which the measure leaves out.
pub fn fits_with_margin(characters: usize) -> bool {
    characters * 10 <= BUDGET_CHARS * 9
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
        Entry { date: Some(date), page: Default::default(), blocks }
    }

    fn undated(blocks: Vec<Value>) -> Entry {
        Entry { date: None, page: Default::default(), blocks }
    }

    fn options(nested: bool) -> TruncationOptions {
        TruncationOptions { nested, newest_first: false, start: 20250101, end: 20250110, requested: 5, with_page: false, has_undated: false }
    }

    /// Raises that always fit, or never do.
    fn fits_always(_: &[Entry]) -> bool {
        true
    }

    fn fits_never(_: &[Entry]) -> bool {
        false
    }

    fn truncated(entries: &[Entry], cap: usize, options: &TruncationOptions) -> ResultWarning {
        truncated_with(entries, cap, options, &fits_always)
    }

    fn truncated_with(entries: &[Entry], cap: usize, options: &TruncationOptions, fits: &dyn Fn(&[Entry]) -> bool) -> ResultWarning {
        let cut = cap_entries(entries, cap, options.nested).unwrap();
        blocks_truncated(&cut, cap, options, &Raises { all: entries, nested: options.nested, fits })
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
        assert_eq!((cut.total, cut.last, cut.next, cut.split, cut.kept_before, cut.last_total), (3, Place::Day(20250101), Place::Day(20250102), false, 0, 2));
        assert_eq!(cut.entries.len(), 1);
        let warning = truncated(&entries, 2, &options(true));
        assert_eq!(warning.message, "Showing 2 of 3 blocks (nested ones counted; oldest day first; the entries end at 20250101).");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Call again with start_date 20250102, the same end_date (20250110) and the same max_blocks to read the later days.")
        );
    }

    #[test]
    fn a_call_that_reads_on_names_the_page_again_when_there_is_one() {
        let entries = [entry(20250101, vec![block(1, 0)]), entry(20250102, vec![block(2, 0)])];
        let warning = truncated(&entries, 1, &TruncationOptions { with_page: true, ..options(true) });
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Call again with the same page, start_date 20250102, the same end_date (20250110) and the same max_blocks to read the later days.")
        );
        // with mentions on non-journal pages in the result, setting dates leaves them out, and the advice says so
        let warning = truncated(&entries, 1, &TruncationOptions { with_page: true, has_undated: true, ..options(true) });
        assert!(warning.how_to_fetch_all.unwrap().ends_with(" Setting dates leaves out the mentions on non-journal pages."));
    }

    #[test]
    fn a_cut_inside_a_later_day_that_fits_says_the_day_repeats_its_kept_blocks() {
        let entries = [entry(20250101, vec![block(1, 0)]), entry(20250102, vec![block(2, 0), block(3, 0)]), entry(20250103, vec![block(4, 0)])];
        let cut = cap_entries(&entries, 2, true).unwrap();
        assert_eq!((cut.last, cut.next, cut.split, cut.kept_before), (Place::Day(20250102), Place::Day(20250103), true, 1));
        let warning = truncated(&entries, 2, &options(true));
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Call again with start_date 20250102, the same end_date (20250110) and the same max_blocks to read the later days (day 20250102 repeats its kept blocks).")
        );
        // with no day after it, the call reads the rest of that day
        let entries = [entry(20250101, vec![block(1, 0)]), entry(20250102, vec![block(2, 0), block(3, 0)])];
        assert!(truncated(&entries, 2, &options(true)).how_to_fetch_all.unwrap().contains("to read the rest of day 20250102 (it repeats its kept blocks)"));
    }

    #[test]
    fn a_partial_block_is_said_so_and_a_cap_of_zero_keeps_nothing() {
        let entries = [entry(20250101, vec![block(1, 3)])];
        let cut = cap_entries(&entries, 2, true).unwrap();
        assert!(cut.partial_block);
        assert!(truncated(&entries, 2, &options(true)).message.contains("; a kept block shows fewer children than it has (childrenTruncated)"));
        let cut = cap_entries(&entries, 0, true).unwrap();
        assert_eq!((cut.entries.len(), cut.last, cut.next), (0, Place::Nowhere, Place::Day(20250101)));
        let warning = truncated(&entries, 0, &options(true));
        assert_eq!(warning.message, "Showing 0 of 4 blocks (nested ones counted; oldest day first).");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_blocks to 4 (or higher) to get all 4."));
    }

    #[test]
    fn a_raise_is_offered_only_when_the_raised_result_fits_the_budget() {
        let entries = [entry(20250101, vec![block(1, 3)])];
        // nothing kept: the raise to everything does not fit, so the message says so and there is no way to fetch it
        let warning = truncated_with(&entries, 0, &options(true), &fits_never);
        assert_eq!(warning.how_to_fetch_all, None);
        assert_eq!(
            warning.message,
            "Showing 0 of 4 blocks (nested ones counted; oldest day first). No call returns them inside 30000 characters. \
             Narrow the period, or read the blocks with logseq_find_blocks (with limit and offset)."
        );
        // the same for the whole day at a higher cap
        let entries = [entry(20250101, vec![block(1, 5)]), entry(20250102, vec![block(2, 0)])];
        let warning = truncated_with(&entries, 3, &options(true), &fits_never);
        assert!(warning.message.contains("Day 20250101 holds 6 blocks, more than fit in 30000 characters, so no call can return it whole."), "{}", warning.message);
        // a later day exists, so the way on is that day, and the day itself is read in pieces
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some(
                "Call again with start_date 20250102, the same end_date (20250110) and the same max_blocks for the rest of the range, \
                 or read day 20250101 in pieces with logseq_find_blocks (start_date and end_date set to that day, with limit and offset)."
            )
        );
        // with no day after it, nothing reads it whole: no way to fetch, and the pieces are in the message
        let alone = [entry(20250101, vec![block(1, 5)])];
        let warning = truncated_with(&alone, 3, &options(true), &fits_never);
        assert_eq!(warning.how_to_fetch_all, None);
        assert!(warning.message.ends_with("Read it in pieces with logseq_find_blocks (start_date and end_date set to that day, with limit and offset)."), "{}", warning.message);
    }

    #[test]
    fn a_day_alone_filling_the_cap_is_read_whole_at_a_higher_cap() {
        let entries = [entry(20250101, vec![block(1, 5)]), entry(20250102, vec![block(2, 0)])];
        let warning = truncated(&entries, 3, &options(true));
        assert_eq!(
            warning.message,
            "Showing 3 of 7 blocks (nested ones counted; oldest day first; the entries end at 20250101; a kept block shows fewer children than it has (childrenTruncated)). \
             Day 20250101 alone holds 6 blocks, more than 3, so a query from it returns the same blocks at this max_blocks."
        );
        assert_eq!(
            warning.how_to_fetch_all.unwrap(),
            "To read it whole, call again with start_date 20250101, end_date 20250101 and max_blocks 6. \
             Then continue with start_date 20250102, the same end_date (20250110) and max_blocks 3."
        );
    }

    #[test]
    fn a_later_day_over_what_is_left_of_the_cap_is_read_from_its_own_start_then_on() {
        // 1, 5 and 1 top-level blocks, a cap of 3: the second day is cut after earlier days were kept
        let rows = |first: i64, n: i64| (first..first + n).map(|id| block(id, 0)).collect::<Vec<_>>();
        let entries = [entry(20250101, rows(1, 1)), entry(20250102, rows(10, 5)), entry(20250103, rows(20, 1))];
        let warning = truncated(&entries, 3, &options(false));
        assert_eq!(
            warning.message,
            "Showing 3 of 7 blocks (top-level only; oldest day first; the entries end at 20250102). \
             Day 20250102 holds 5 blocks, more than 3, so a query from it at this max_blocks reads only its first 3."
        );
        assert_eq!(
            warning.how_to_fetch_all.unwrap(),
            "To read it whole, call again with start_date 20250102, end_date 20250102 and max_blocks 5. \
             Then continue with start_date 20250103, the same end_date (20250110) and max_blocks 3."
        );
    }

    #[test]
    fn newest_first_pages_on_to_older_days() {
        let entries = [entry(20250109, vec![block(1, 0)]), entry(20250108, vec![block(2, 0)])];
        let warning = truncated(&entries, 1, &TruncationOptions { newest_first: true, ..options(true) });
        assert_eq!(warning.message, "Showing 1 of 2 blocks (nested ones counted; newest day first; the entries end at 20250109).");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Call again with start_date 20250101, end_date 20250108 and the same max_blocks to read the older days.")
        );
    }

    fn big_day(n: usize) -> Entry {
        entry(20250101, (0..n as i64).map(|i| block(i + 1, 0)).collect())
    }

    #[test]
    fn a_day_over_the_maximum_cannot_be_read_whole() {
        let warning = truncated(&[big_day(1200)], 200, &options(true));
        assert_eq!(
            warning.message,
            "Showing 200 of 1200 blocks (nested ones counted; oldest day first; the entries end at 20250101). \
             Day 20250101 holds 1200 blocks, more than the maximum of 1000, so no call can return it whole."
        );
        assert_eq!(
            warning.how_to_fetch_all.unwrap(),
            "Set max_blocks to 1000 (the maximum) with start_date 20250101 and end_date 20250101 to read 1000 of its 1200 blocks, \
             or read it in pieces with logseq_find_blocks (start_date and end_date set to that day, with limit and offset)."
        );
        // the raise to the maximum is not offered when a day of 1000 blocks would not fit the budget
        let warning = truncated_with(&[big_day(1200)], 200, &options(true), &fits_never);
        assert_eq!(warning.how_to_fetch_all, None);
        assert!(warning.message.ends_with("Read it in pieces with logseq_find_blocks (start_date and end_date set to that day, with limit and offset)."), "{}", warning.message);
        // at the maximum with no later day there is nothing to fetch
        let warning = truncated(&[big_day(1200)], 1000, &TruncationOptions { requested: 5000, ..options(true) });
        assert!(warning.how_to_fetch_all.is_none());
        assert_eq!(
            warning.message,
            "Showing 1000 of 1200 blocks (nested ones counted; oldest day first; the entries end at 20250101): max_blocks is capped at its maximum of 1000 \
             (5000 was asked for), so the rest can't be fetched in one call. Day 20250101 holds 1200 blocks, more than the maximum of 1000, so no call can return it whole. \
             Read it in pieces with logseq_find_blocks (start_date and end_date set to that day, with limit and offset)."
        );
        // with a later day, page past it
        let entries = [big_day(1200), entry(20250102, vec![block(1, 0)])];
        let warning = truncated(&entries, 1000, &options(true));
        assert_eq!(
            warning.how_to_fetch_all.unwrap(),
            "Call again with start_date 20250102, the same end_date (20250110) and the same max_blocks for the rest of the range, \
             or read day 20250101 in pieces with logseq_find_blocks (start_date and end_date set to that day, with limit and offset)."
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
        assert!(truncated(&entries, 1, &options(false)).message.contains("(top-level only;"));
    }

    #[test]
    fn a_cap_of_zero_over_more_than_the_maximum_says_to_narrow() {
        let warning = truncated(&[big_day(1001)], 0, &options(true));
        assert_eq!(
            warning.how_to_fetch_all.unwrap(),
            "Set max_blocks to 1000 (the maximum) to get 1000 of 1001. Narrow the period, or read the blocks with logseq_find_blocks (with limit and offset)."
        );
    }

    #[test]
    fn mentions_on_non_journal_pages_come_last_and_no_date_reaches_them() {
        let entries = [entry(20250101, vec![block(1, 0)]), entry(20250102, vec![block(2, 0)]), undated(vec![block(3, 0), block(4, 0)])];
        // cut between the last day and the undated entry
        let cut = cap_entries(&entries, 2, true).unwrap();
        assert_eq!((cut.last, cut.next, cut.split), (Place::Day(20250102), Place::Undated, false));
        let warning = truncated(&entries, 2, &options(true));
        assert_eq!(
            warning.message,
            "Showing 2 of 4 blocks (nested ones counted; oldest day first; the entries end at 20250102). \
             The rest are mentions on non-journal pages, which no dates reach."
        );
        // the only way to fetch them is a raise, and it is offered because it fits
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_blocks to 4 (or higher) to get all 4."));
        // and not when it does not: then nothing fetches them
        let warning = truncated_with(&entries, 2, &options(true), &fits_never);
        assert_eq!(warning.how_to_fetch_all, None);
        assert!(warning.message.contains("No call returns them inside 30000 characters."), "{}", warning.message);
        // cut inside the undated entry
        let cut = cap_entries(&entries, 3, true).unwrap();
        assert_eq!((cut.last, cut.next, cut.split, cut.kept_before), (Place::Undated, Place::Nowhere, true, 2));
        let warning = truncated(&entries, 3, &options(true));
        assert!(warning.message.contains("the entries end among the mentions on non-journal pages"), "{}", warning.message);
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_blocks to 4 (or higher) to get all 4."));
        // a cut inside the last day with only the undated entry after it reads the rest of the day, and says what dates leave out
        let entries = [entry(20250101, vec![block(1, 0)]), entry(20250102, vec![block(2, 0), block(3, 0)]), undated(vec![block(4, 0)])];
        let warning = truncated(&entries, 2, &TruncationOptions { with_page: true, has_undated: true, ..options(true) });
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some(
                "Call again with the same page, start_date 20250102, the same end_date (20250110) and the same max_blocks to read the rest of day 20250102 \
                 (it repeats its kept blocks). Setting dates leaves out the mentions on non-journal pages."
            )
        );
    }

    #[test]
    fn a_raise_is_never_the_call_just_made_so_at_the_maximum_the_blocks_with_no_day_are_read_with_find_blocks() {
        let blocks = |first: i64, n: i64| (first..first + n).map(|id| block(id, 0)).collect::<Vec<_>>();
        let read_with = "No call reads the rest in one go: read them with logseq_find_blocks with page (its own blocks) or links_to (the blocks that link to it), with limit and offset.";
        // the cut falls among the blocks with no day, at the maximum
        let among = [entry(20250101, blocks(1, 1)), undated(blocks(10, 1100))];
        let warning = truncated(&among, 1000, &options(true));
        assert_eq!(warning.how_to_fetch_all, None, "{}", warning.message);
        assert!(warning.message.ends_with(read_with), "{}", warning.message);
        // the cut falls right after the last day, with only blocks with no day left
        let after = [entry(20250101, blocks(1, 1000)), undated(blocks(2000, 5))];
        let warning = truncated(&after, 1000, &options(true));
        assert_eq!(warning.how_to_fetch_all, None, "{}", warning.message);
        assert!(warning.message.ends_with(read_with), "{}", warning.message);
        // below the maximum the raise is still offered
        let below = [entry(20250101, blocks(1, 500)), undated(blocks(2000, 505))];
        let warning = truncated(&below, 999, &options(true));
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_blocks to 1000 (the maximum) to get 1000 of 1005. Narrow the period, or read the blocks with logseq_find_blocks (with limit and offset)."));
    }

    #[test]
    fn a_cut_inside_a_day_that_fits_the_cap_names_a_call_from_it_only_when_the_day_alone_fits_the_budget() {
        // day 1 holds one block, day 2 three of them (a cap of 3 cuts inside it, and it fits the cap), day 3 one
        let entries = [entry(20250101, vec![block(1, 0)]), entry(20250102, vec![block(2, 0), block(3, 0), block(4, 0)]), entry(20250103, vec![block(5, 0)])];
        let fits = truncated(&entries, 3, &options(true));
        assert!(fits.how_to_fetch_all.unwrap().contains("(day 20250102 repeats its kept blocks)"));
        // the day's blocks are large: a call from it would come back cut at fewer blocks than this result holds, so it is not named
        let large = |entries: &[Entry]| entries.iter().all(|entry| entry.date != Some(20250102) || entry.blocks.len() < 3);
        let too_large = truncated_with(&entries, 3, &options(true), &large);
        assert_eq!(
            too_large.how_to_fetch_all.as_deref(),
            Some(
                "Call again with start_date 20250103, the same end_date (20250110) and the same max_blocks for the rest of the range, \
                 or read day 20250102 in pieces with logseq_find_blocks (start_date and end_date set to that day, with limit and offset)."
            )
        );
        assert!(too_large.message.contains("Day 20250102 holds 3 blocks, more than fit in 30000 characters, so no call can return it whole."), "{}", too_large.message);
        // with no day after it, nothing reads the day whole and no call is named
        let last = truncated_with(&entries[..2], 3, &options(true), &large);
        assert_eq!(last.how_to_fetch_all, None);
        assert!(last.message.ends_with("Read it in pieces with logseq_find_blocks (start_date and end_date set to that day, with limit and offset)."), "{}", last.message);
    }

    #[test]
    fn a_raise_with_a_margin_is_the_budget_less_a_tenth() {
        assert!(fits_with_margin(27_000));
        assert!(!fits_with_margin(27_001));
        assert!(!fits_with_margin(30_000));
    }

    /// A top-level block of `length` characters, with `children` leaves under it
    fn text_block(id: i64, length: usize) -> Value {
        json!({"id": id, "content": "x".repeat(length), "children": []})
    }

    /// The result as a test writes it: its entries' blocks and the warnings, so the text is as long as they are.
    fn write(entries: &[Entry], warnings: &[ResultWarning], totals: Option<(usize, usize)>) -> String {
        let blocks: Vec<&Vec<Value>> = entries.iter().map(|entry| &entry.blocks).collect();
        json!({"entries": blocks, "warnings": warnings, "totals": totals}).to_string()
    }

    fn fitted(entries: &[Entry], warnings: &[ResultWarning], totals: Option<(usize, usize)>, nested: bool) -> String {
        write_within_budget(entries, warnings, totals, &options(nested), write)
    }

    #[test]
    fn a_result_that_fits_the_budget_is_written_as_it_is() {
        let entries = [entry(20250101, vec![text_block(1, 100)]), entry(20250102, vec![text_block(2, 100)])];
        assert_eq!(fitted(&entries, &[], None, true), write(&entries, &[], None));
    }

    #[test]
    fn a_result_over_the_budget_is_cut_between_days_and_says_where_to_read_on() {
        // 20 days of 2 blocks of 1,000 characters: 40,000 characters of text
        let entries: Vec<Entry> = (1..=20).map(|day| entry(20250100 + day, vec![text_block(day * 10, 1000), text_block(day * 10 + 1, 1000)])).collect();
        let text = fitted(&entries, &[], None, true);
        assert!(size(&text) <= crate::budget::BUDGET_CHARS, "{}", size(&text));
        let value: Value = serde_json::from_str(&text).unwrap();
        let kept: usize = value["entries"].as_array().unwrap().iter().map(|day| day.as_array().unwrap().len()).sum();
        assert!(kept > 20 && kept < 40, "{kept}");
        let warning = &value["warnings"][0];
        assert_eq!(warning["code"], "result_size_truncated");
        assert!(warning["message"].as_str().unwrap().starts_with(&format!("Showing {kept} of 40 blocks")), "{warning}");
        // the day the cut fell in repeats its kept blocks when it was split, else the next day is the one to read from
        assert!(warning["howToFetchAll"].as_str().unwrap().starts_with("Call again with start_date 202501"), "{warning}");
        // totals are (blocks, days) before the cut
        assert_eq!(value["totals"], json!([40, 20]));
        // it is the most that fits: one more block would be over
        let cut = cap_entries(&entries, kept + 1, true).unwrap();
        let warned = [size_truncated(&cut, kept + 1, false, &options(true))];
        assert!(size(&write(&cut.entries, &warned, Some((40, 20)))) > crate::budget::BUDGET_CHARS);
    }

    #[test]
    fn the_count_caps_totals_and_warnings_stay_when_the_budget_cuts_further_but_its_way_on_goes() {
        let entries: Vec<Entry> = (1..=20).map(|day| entry(20250100 + day, vec![text_block(day, 3000)])).collect();
        let earlier = ResultWarning { code: "blocks_truncated".to_owned(), message: "earlier".to_owned(), how_to_fetch_all: Some("from a later day".to_owned()) };
        let value: Value = serde_json::from_str(&fitted(&entries, &[earlier], Some((500, 90)), true)).unwrap();
        assert_eq!(value["warnings"][0]["code"], "blocks_truncated");
        assert_eq!(value["warnings"][0]["message"], "earlier");
        // its call would skip what the budget dropped, so it no longer names one
        assert!(value["warnings"][0].get("howToFetchAll").is_none(), "{}", value["warnings"][0]);
        assert_eq!(value["warnings"][1]["code"], "result_size_truncated");
        assert!(value["warnings"][1]["howToFetchAll"].is_string());
        assert_eq!(value["totals"], json!([500, 90]));
    }

    #[test]
    fn a_first_day_over_the_budget_is_kept_with_its_first_block_and_the_days_after_it_are_offered() {
        let entries = [entry(20250101, vec![text_block(1, 40_000), text_block(2, 10)]), entry(20250102, vec![text_block(3, 10)])];
        let value: Value = serde_json::from_str(&fitted(&entries, &[], None, true)).unwrap();
        assert_eq!(value["entries"].as_array().unwrap().len(), 1);
        assert_eq!(value["entries"][0].as_array().unwrap().len(), 1);
        let warning = &value["warnings"][0];
        assert!(warning["message"].as_str().unwrap().contains("an entry is never cut inside its text"), "{warning}");
        assert!(warning["message"].as_str().unwrap().contains("Day 20250101 alone fills this limit"), "{warning}");
        assert!(warning["message"].as_str().unwrap().contains("read it in pieces with logseq_find_blocks"), "{warning}");
        assert_eq!(warning["howToFetchAll"], "Call again with start_date 20250102, the same end_date (20250110) to read the later days.");
    }

    #[test]
    fn newest_first_reads_on_with_older_days_and_a_lone_oversized_block_is_not_cut() {
        let entries = [entry(20250105, vec![text_block(1, 20_000)]), entry(20250104, vec![text_block(2, 20_000)])];
        let newest = TruncationOptions { newest_first: true, ..options(true) };
        let value: Value = serde_json::from_str(&write_within_budget(&entries, &[], None, &newest, write)).unwrap();
        assert_eq!(value["warnings"][0]["howToFetchAll"], "Call again with start_date 20250101, end_date 20250104 to read the older days.");
        let lone = [entry(20250105, vec![text_block(1, 40_000)])];
        assert_eq!(fitted(&lone, &[], None, true), write(&lone, &[], None));
    }

    #[test]
    fn the_mentions_on_non_journal_pages_are_cut_first_and_no_date_reads_on_to_them() {
        let entries = [entry(20250101, vec![text_block(1, 100)]), undated((2..80).map(|id| text_block(id, 600)).collect())];
        let value: Value = serde_json::from_str(&fitted(&entries, &[], None, true)).unwrap();
        let warning = &value["warnings"][0];
        assert_eq!(warning["code"], "result_size_truncated");
        assert!(warning["message"].as_str().unwrap().contains("The rest are mentions on non-journal pages, which no dates reach."), "{warning}");
        assert!(warning.get("howToFetchAll").is_none(), "{warning}");
    }

    #[test]
    fn the_outline_is_cut_by_top_level_blocks() {
        let entries = [entry(20250101, (0..400).map(|id| text_block(id, 100)).collect())];
        let value: Value = serde_json::from_str(&fitted(&entries, &[], None, false)).unwrap();
        let kept = value["entries"][0].as_array().unwrap().len();
        assert!(kept > 100 && kept < 400, "{kept}");
        assert!(value["warnings"][0]["message"].as_str().unwrap().starts_with(&format!("Showing {kept} of 400 blocks")));
    }
}
