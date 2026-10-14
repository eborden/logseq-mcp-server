//! Paging a list a tool built (ADR-0038): what every tool that reads a cut list to the end shares, so each is a small
//! change on top of it.
//!
//! - [`page_of`] is the slice a page holds, from where the cursor says. It sits on [`budget::fit`] (whose signature
//!   is unchanged): the tool gives it the page size and a `size_of(k)` that renders the page with its first `k` entries,
//!   the warning and the cursor's own length included, so a page is never over the character budget.
//! - [`paged_warning`] words the warning of a cut page, for a cut by the page size and a cut by the budget, with the
//!   codes the tools already use.
//! - [`serve`] is the read-through: the list a call reads is the snapshot an earlier call kept (a hit, no LogSeq call)
//!   or is built again with the calls the first page made (a miss). [`resume_at`] then checks the anchor, and
//!   [`stale_warning`] says so when the list moved between pages (BR-0006: a gap or a repeat is never silent).
//! - [`refuse_with_cursor`] refuses a call that passes a `cursor` and anything else, before any LogSeq call.

use std::any::Any;
use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use rmcp::model::JsonObject;
use schemars::JsonSchema;
use serde_json::{Map, Value};

use crate::budget::{BUDGET_CHARS, Fit, SIZE_TRUNCATED_CODE, fit};
use crate::cursor::SnapshotKey;
use crate::errors::InvalidParameter;
use crate::meta::ResultWarning;
use crate::snapshots::Snapshots;
use crate::tool::input_schema;

/// What a warning's `howToFetchAll` leads with when a cursor reads on. The tool's own raise of a cap may follow it.
pub const NEXT_PAGE: &str = "Pass nextCursor as cursor, with no other argument, to read the next page.";

/// The code of the warning for a page that resumed where the list had moved.
pub const STALE_CODE: &str = "cursor_stale";

/// Why a page ends before the list does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cut {
    /// The page size (`limit`, `max_blocks`, ...) was reached
    Count,
    /// The budget was. `oversize` is true when even the first entries, the least a page keeps, are over it: they are
    /// returned whole (BR-0007), and the cursor moves past them.
    Size { oversize: bool },
}

/// The slice of a list one page holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Page {
    /// The index of the first entry
    pub start: usize,
    /// How many entries, from `start`
    pub kept: usize,
    /// Why the page ends before the list does, or `None` when it reaches the last entry
    pub cut: Option<Cut>,
}

impl Page {
    /// The index of the first entry of the next page, when a cursor can read on. None for the last page, and for a
    /// page of no entry: a cursor that does not move would read nothing on.
    pub fn next(&self) -> Option<usize> {
        (self.cut.is_some() && self.kept > 0).then_some(self.start + self.kept)
    }
}

/// The page of a list of `len` entries that starts at `start`: at most `page_size` entries, and the most of those that
/// fit the character budget, never fewer than one (an entry is never cut inside its text, BR-0007).
///
/// `size_of(k)` is the length of the result with the first `k` entries of the page, including its warning and
/// `nextCursor` for a `k` that leaves entries behind (`start + k < len`): the same contract as [`fit`], and the
/// cursor's own length counts against the 30,000 characters.
pub fn page_of(len: usize, start: usize, page_size: usize, size_of: impl Fn(usize) -> usize) -> Page {
    let total = page_size.min(len.saturating_sub(start));
    match fit(total, 1, size_of) {
        Fit::Whole => Page { start, kept: total, cut: (start + total < len).then_some(Cut::Count) },
        Fit::Cut { kept, oversize } => Page { start, kept, cut: Some(Cut::Size { oversize }) },
    }
}

/// The arguments of [`paged_warning`].
pub struct PagedCut<'a> {
    /// The code of a cut by the page size (`results_truncated`, `blocks_truncated`, ...). A cut by the budget is
    /// `result_size_truncated` whatever the tool
    pub count_code: &'a str,
    pub cut: Cut,
    /// What the list holds, plural: "matching blocks"
    pub what: &'a str,
    /// The index of the first entry shown
    pub start: usize,
    /// How many entries were shown
    pub kept: usize,
    /// How many entries the list has
    pub total: usize,
    /// What else the caller can do: narrow, or make the entries smaller. Said after the cut
    pub advice: &'a str,
    /// A raise of the page size, offered beside the cursor, as a phrase that starts with a verb and ends with a
    /// full stop: "set limit to 240 for a larger page." The model chooses between it and the cursor
    pub raise: Option<String>,
    /// A cursor reads on, so `howToFetchAll` leads with it
    pub has_next: bool,
}

/// "29-56", "5", or "0": the entries a page shows, counted from 1.
fn range(start: usize, kept: usize) -> String {
    match kept {
        0 => "0".to_owned(),
        1 => (start + 1).to_string(),
        _ => format!("{}-{}", start + 1, start + kept),
    }
}

/// A phrase as a sentence: its first letter in capitals.
fn sentence(phrase: &str) -> String {
    let mut chars = phrase.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

/// The warning of a page that ends before its list does. `howToFetchAll` leads with the cursor when there is one, then
/// the raise of the page size when the tool offers one. A cut by the budget says that no parameter raises it.
pub fn paged_warning(cut: PagedCut<'_>) -> ResultWarning {
    let PagedCut { count_code, cut, what, start, kept, total, advice, raise, has_next } = cut;
    let head = format!("Showing {} of {total} {what}", range(start, kept));
    let (code, message) = match cut {
        Cut::Count => (count_code, if advice.is_empty() { format!("{head}.") } else { format!("{head}. {advice}") }),
        Cut::Size { oversize } => {
            let alone = if oversize { " Even those are over that size, whether from the entry or from the result around it: an entry is never cut inside its text." } else { "" };
            (
                SIZE_TRUNCATED_CODE,
                format!("{head}: the result was cut to fit {BUDGET_CHARS} characters, since a larger one may be saved to a file by the host instead of shown.{alone} {advice}"),
            )
        }
    };
    let how_to_fetch_all = match (has_next, raise) {
        (true, Some(raise)) => Some(format!("{NEXT_PAGE} Or {raise}")),
        (true, None) => Some(NEXT_PAGE.to_owned()),
        (false, Some(raise)) => Some(sentence(&raise)),
        (false, None) => None,
    };
    ResultWarning { code: code.to_owned(), message, how_to_fetch_all }
}

/// A list a call reads from.
pub struct Served<T> {
    pub list: Arc<T>,
    /// The key the next cursor carries: the snapshot a hit was read from, or a new one for a list built by this call
    pub key: SnapshotKey,
    /// The list is a snapshot an earlier call kept, so this call made no LogSeq call to read it
    pub hit: bool,
}

impl<T: Any + Send + Sync> Served<T> {
    /// Keep a list this call built, so the pages after it can be read from memory. Does nothing for a hit (it is
    /// kept already), and nothing when the list is over the cache's limits (the next page is built again). A tool
    /// calls it when its page leaves entries behind: a list that fits one page needs no snapshot. `bytes` is what
    /// the tool says the list weighs.
    pub fn keep(&self, snapshots: &Snapshots, args: &Map<String, Value>, bytes: usize, now: Instant) {
        if !self.hit {
            snapshots.insert(self.key, args, bytes, Arc::clone(&self.list), now);
        }
    }
}

/// The list of this call: the snapshot a cursor names when it is still kept and was built from exactly `args`
/// (a hit), else what `build` makes (a miss, or a first call). `build` makes the calls the first page made, and no
/// more. The key of a miss is reserved here, before the page is measured, because the token that carries it counts
/// against the budget.
pub async fn serve<T, E, Fut>(
    snapshots: &Snapshots,
    resume: Option<&SnapshotKey>,
    args: &Map<String, Value>,
    now: Instant,
    build: impl FnOnce() -> Fut,
) -> Result<Served<T>, E>
where
    T: Any + Send + Sync,
    Fut: Future<Output = Result<T, E>>,
{
    if let Some(key) = resume {
        if let Some(list) = snapshots.get::<T>(key, args, now) {
            return Ok(Served { list, key: *key, hit: true });
        }
    }
    let list = Arc::new(build().await?);
    Ok(Served { list, key: snapshots.reserve(), hit: false })
}

/// What the anchor check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resumed {
    /// The index of the first entry of the page
    pub start: usize,
    /// The list is not as it was between the pages
    pub stale: Option<Stale>,
}

/// How a list moved between two pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stale {
    /// The last entry sent is in the list, but not just before the position: the page resumes right after it
    Moved,
    /// The last entry sent is gone: the page starts at the position, clamped to the list
    Gone,
}

/// Where a page reads from (ADR-0038): `position` if the entry just before it is the anchor, else where the anchor
/// says. `is_anchor(i)` says whether entry `i` is the last one sent, and `after_anchor` is the index just after the
/// anchor's place in the list, if it has one: a sorted list names it by the anchor's key, even when the entry itself is
/// gone, and any other list by the anchor's index, or `None` when the anchor is gone. A start past the end of the
/// list is clamped to it, so a position is never trusted unchecked.
pub fn resume_at(len: usize, position: usize, is_anchor: impl Fn(usize) -> bool, after_anchor: impl FnOnce() -> Option<usize>) -> Resumed {
    if (1..=len).contains(&position) && is_anchor(position - 1) {
        return Resumed { start: position, stale: None };
    }
    match after_anchor() {
        Some(start) => Resumed { start: start.min(len), stale: Some(Stale::Moved) },
        None => Resumed { start: position.min(len), stale: Some(Stale::Gone) },
    }
}

/// The `cursor_stale` warning (BR-0006): the list changed between the pages, and what the page did about it.
/// `what` is what the list holds, plural, as in [`PagedCut`].
pub fn stale_warning(stale: Stale, what: &str) -> ResultWarning {
    let message = match stale {
        Stale::Moved => format!(
            "The {what} changed since the page before was read: the last one it showed is no longer where it was. This page resumes right after it, so none is repeated, but any that came before it since are not shown. Call again without the cursor for a fresh list."
        ),
        Stale::Gone => format!(
            "The {what} changed since the page before was read: the last one it showed is gone. This page starts at the same place in the list as the cursor said, so one may be missing or repeated. Call again without the cursor for a fresh list."
        ),
    };
    ResultWarning::new(STALE_CODE, message)
}

/// A call with a `cursor` takes no other argument: they are in the token. Refuses the first other parameter of the
/// tool that the call sent, in the order of its schema (`A` is the type the tool's arguments parse into), before any
/// LogSeq call. `null` counts as absent, as everywhere. The arguments are read as they were sent, since a default and
/// a value that was asked for look the same once parsed. A field the tool doesn't know is ignored, as in every tool.
pub fn refuse_with_cursor<A: JsonSchema>(arguments: Option<&JsonObject>) -> Result<(), InvalidParameter> {
    let schema = input_schema::<A>();
    let others = schema.get("properties").and_then(Value::as_object).into_iter().flat_map(|properties| properties.keys()).filter(|name| *name != "cursor");
    for param in others {
        let Some(value) = arguments.and_then(|arguments| arguments.get(param)).filter(|value| !value.is_null()) else { continue };
        return Err(InvalidParameter {
            param: param.clone(),
            value: value.to_string(),
            expected: format!("left out when cursor is given: the cursor holds the arguments of the call that made it, so {param} can't change"),
            example: Some("cursor: \"<nextCursor>\"".to_owned()),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    use crate::snapshots::Limits;
    use std::time::Duration;

    // ---- page_of

    /// A result of `k` entries of `each` characters with `frame` characters around them, and a warning and cursor of
    /// 300 characters when entries are left behind in a list of `len`.
    fn sized(start: usize, len: usize, each: usize, frame: usize) -> impl Fn(usize) -> usize {
        move |k| frame + k * each + if start + k < len { 300 } else { 0 }
    }

    #[test]
    fn a_page_that_reaches_the_end_has_no_cut_and_no_next() {
        let page = page_of(5, 0, 100, sized(0, 5, 10, 50));
        assert_eq!(page, Page { start: 0, kept: 5, cut: None });
        assert_eq!(page.next(), None);
        // and from the middle
        let page = page_of(5, 3, 100, sized(3, 5, 10, 50));
        assert_eq!(page, Page { start: 3, kept: 2, cut: None });
    }

    #[test]
    fn a_page_size_cut_leaves_a_cursor_to_the_next_entry() {
        let page = page_of(250, 100, 100, sized(100, 250, 10, 50));
        assert_eq!(page, Page { start: 100, kept: 100, cut: Some(Cut::Count) });
        assert_eq!(page.next(), Some(200));
        // exactly as many entries as the page size is no cut
        assert_eq!(page_of(100, 0, 100, sized(0, 100, 10, 50)), Page { start: 0, kept: 100, cut: None });
        // one more is
        assert_eq!(page_of(101, 0, 100, sized(0, 101, 10, 50)).cut, Some(Cut::Count));
    }

    #[test]
    fn a_budget_cut_keeps_the_most_entries_that_fit_with_the_warning_and_the_cursor() {
        // 400 entries of 200 characters: k * 200 + 350 <= 30000 gives 148
        let size_of = sized(0, 400, 200, 50);
        let page = page_of(400, 0, 400, &size_of);
        assert_eq!(page, Page { start: 0, kept: 148, cut: Some(Cut::Size { oversize: false }) });
        assert!(size_of(148) <= BUDGET_CHARS && size_of(149) > BUDGET_CHARS);
        assert_eq!(page.next(), Some(148));
    }

    #[test]
    fn an_entry_over_the_budget_is_returned_alone_and_the_cursor_moves_past_it() {
        let size_of = |k: usize| 40_000 * k;
        let page = page_of(5, 0, 5, size_of);
        assert_eq!(page, Page { start: 0, kept: 1, cut: Some(Cut::Size { oversize: true }) });
        assert_eq!(page.next(), Some(1));
        // the last entry on its own over the budget is the whole of the last page
        assert_eq!(page_of(5, 4, 5, |_| 40_000), Page { start: 4, kept: 1, cut: None });
    }

    #[test]
    fn a_page_of_no_entry_has_no_cursor_to_offer() {
        let page = page_of(5, 0, 0, sized(0, 5, 10, 50));
        assert_eq!(page, Page { start: 0, kept: 0, cut: Some(Cut::Count) });
        assert_eq!(page.next(), None, "a cursor that does not move reads nothing on");
        assert_eq!(page_of(0, 0, 100, |_| 10), Page { start: 0, kept: 0, cut: None });
        // a start at or past the end is an empty last page
        assert_eq!(page_of(5, 5, 100, |_| 10), Page { start: 5, kept: 0, cut: None });
        assert_eq!(page_of(5, 9, 100, |_| 10), Page { start: 9, kept: 0, cut: None });
    }

    #[test]
    fn reading_page_after_page_covers_a_list_several_times_the_budget_once() {
        // 1000 entries of 150 characters, read from the start until no page has a next
        let len = 1000;
        let mut start = 0;
        let mut seen = Vec::new();
        let mut pages = 0;
        loop {
            let size_of = sized(start, len, 150, 80);
            let page = page_of(len, start, 500, &size_of);
            assert!(size_of(page.kept) <= BUDGET_CHARS);
            seen.extend(start..start + page.kept);
            pages += 1;
            match page.next() {
                Some(next) => start = next,
                None => break,
            }
        }
        assert_eq!(seen, (0..len).collect::<Vec<_>>(), "every entry once, in order");
        assert!(pages > 4, "{pages} pages");
    }

    // ---- paged_warning

    fn cut(kind: Cut) -> PagedCut<'static> {
        PagedCut { count_code: "results_truncated", cut: kind, what: "matching blocks", start: 28, kept: 28, total: 90, advice: "", raise: None, has_next: true }
    }

    #[test]
    fn a_count_cut_says_where_the_page_is_and_leads_with_the_cursor() {
        let warning = paged_warning(cut(Cut::Count));
        assert_eq!(warning.code, "results_truncated");
        assert_eq!(warning.message, "Showing 29-56 of 90 matching blocks.");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Pass nextCursor as cursor, with no other argument, to read the next page."));
        let with_raise = paged_warning(PagedCut { raise: Some("set limit to 90.".into()), advice: "Narrow the filters.", ..cut(Cut::Count) });
        assert_eq!(with_raise.message, "Showing 29-56 of 90 matching blocks. Narrow the filters.");
        assert_eq!(
            with_raise.how_to_fetch_all.as_deref(),
            Some("Pass nextCursor as cursor, with no other argument, to read the next page. Or set limit to 90.")
        );
    }

    #[test]
    fn a_size_cut_keeps_its_code_and_says_the_budget_and_whether_the_entries_were_over_it() {
        let warning = paged_warning(PagedCut { advice: "Narrow the filters.", ..cut(Cut::Size { oversize: false }) });
        assert_eq!(warning.code, "result_size_truncated");
        assert_eq!(
            warning.message,
            "Showing 29-56 of 90 matching blocks: the result was cut to fit 30000 characters, since a larger one may be saved to a file by the host instead of shown. Narrow the filters."
        );
        let alone = paged_warning(PagedCut { start: 0, kept: 1, advice: "Read it with logseq_get_block.", ..cut(Cut::Size { oversize: true }) });
        assert!(alone.message.starts_with("Showing 1 of 90 matching blocks: the result was cut"), "{}", alone.message);
        assert!(alone.message.contains("Even those are over that size, whether from the entry or from the result around it: an entry is never cut inside its text. Read it"), "{}", alone.message);
    }

    #[test]
    fn a_page_with_no_cursor_offers_only_the_raise_and_a_page_of_nothing_is_a_zero() {
        // a limit of 0: nothing is shown, no cursor can read on, and the raise is the one way
        let warning = paged_warning(PagedCut { start: 0, kept: 0, has_next: false, raise: Some("set limit to 5.".into()), ..cut(Cut::Count) });
        assert_eq!(warning.message, "Showing 0 of 90 matching blocks.");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set limit to 5."));
        assert_eq!(paged_warning(PagedCut { has_next: false, ..cut(Cut::Count) }).how_to_fetch_all, None);
    }

    // ---- the read-through

    const STARTED: u64 = 1_760_000_000_000;

    fn args(text: &str) -> Map<String, Value> {
        json!({"text": text}).as_object().cloned().unwrap()
    }

    #[tokio::test]
    async fn a_first_call_builds_a_miss_calls_it_again_and_a_hit_never_builds() {
        let (snapshots, now) = (Snapshots::new(STARTED), Instant::now());
        let built = std::cell::Cell::new(0);
        let build = || async {
            built.set(built.get() + 1);
            Ok::<_, String>(vec![1, 2, 3])
        };
        // a first call: built, with a new key, not a hit; kept only when the tool asks
        let first = serve::<Vec<i32>, _, _>(&snapshots, None, &args("x"), now, build).await.unwrap();
        assert!(!first.hit);
        assert_eq!((built.get(), snapshots.len()), (1, 0));
        first.keep(&snapshots, &args("x"), 24, now);
        assert_eq!(snapshots.len(), 1);
        // the next call with its key is a hit: no build, the same list, the same key
        let hit = serve::<Vec<i32>, _, _>(&snapshots, Some(&first.key), &args("x"), now, build).await.unwrap();
        assert!(hit.hit);
        assert_eq!((built.get(), *hit.list == vec![1, 2, 3], hit.key), (1, true, first.key));
        // keeping a hit changes nothing
        hit.keep(&snapshots, &args("x"), 24, now);
        assert_eq!(snapshots.len(), 1);
        // other arguments, an old snapshot and a key nobody holds are misses, each with a new key
        let other = serve::<Vec<i32>, _, _>(&snapshots, Some(&first.key), &args("y"), now, build).await.unwrap();
        let aged = serve::<Vec<i32>, _, _>(&snapshots, Some(&first.key), &args("x"), now + Duration::from_secs(60), build).await.unwrap();
        let unknown = serve::<Vec<i32>, _, _>(&snapshots, Some(&SnapshotKey { started: STARTED, n: 99 }), &args("x"), now, build).await.unwrap();
        assert_eq!((other.hit, aged.hit, unknown.hit, built.get()), (false, false, false, 4));
        assert!(other.key != first.key && aged.key != first.key && unknown.key != other.key);
    }

    #[tokio::test]
    async fn a_build_that_fails_is_the_error_of_the_call_and_keeps_nothing() {
        let snapshots = Snapshots::new(STARTED);
        let result = serve::<Vec<i32>, String, _>(&snapshots, None, &args("x"), Instant::now(), || async { Err("LogSeq is down".to_owned()) }).await;
        assert_eq!(result.err().as_deref(), Some("LogSeq is down"));
        assert!(snapshots.is_empty());
    }

    #[test]
    fn a_list_over_the_snapshot_limit_is_built_again_for_the_next_page() {
        let snapshots = Snapshots::with_limits(STARTED, Limits { snapshot_bytes: 10, ..Limits::STARTING });
        let now = Instant::now();
        let served = Served { list: Arc::new(vec![1, 2, 3]), key: snapshots.reserve(), hit: false };
        served.keep(&snapshots, &args("x"), 11, now);
        assert!(snapshots.get::<Vec<i32>>(&served.key, &args("x"), now).is_none());
    }

    // ---- the anchor check

    #[test]
    fn a_list_that_did_not_move_resumes_at_the_position() {
        let ids = [90, 80, 70, 60, 50];
        let resumed = resume_at(ids.len(), 3, |i| ids[i] == 70, || unreachable!("the anchor is where it was"));
        assert_eq!(resumed, Resumed { start: 3, stale: None });
        // the end of the list: the last page was the one before
        assert_eq!(resume_at(ids.len(), 5, |i| ids[i] == 50, || unreachable!()), Resumed { start: 5, stale: None });
    }

    #[test]
    fn a_list_that_gained_a_newer_entry_resumes_by_key_after_the_anchor_and_says_so() {
        // page 1 showed 90, 80, 70 (anchor 70, position 3); then 95 was added in front of them
        let ids = [95, 90, 80, 70, 60, 50];
        let after = || Some(ids.iter().position(|id| *id < 70).unwrap());
        let resumed = resume_at(ids.len(), 3, |i| ids[i] == 70, after);
        assert_eq!(resumed, Resumed { start: 4, stale: Some(Stale::Moved) });
        assert_eq!(&ids[resumed.start..], &[60, 50], "nothing is repeated");
    }

    #[test]
    fn a_deleted_anchor_falls_back_to_the_position_and_a_shorter_list_clamps_it() {
        // the anchor 70 is gone, and an entry before it too: position 3 would skip one
        let ids = [90, 80, 60, 50];
        let resumed = resume_at(ids.len(), 3, |i| ids[i] == 70, || None);
        assert_eq!(resumed, Resumed { start: 3, stale: Some(Stale::Gone) });
        // a list that shrank below the position: the start is the end, never past it
        assert_eq!(resume_at(2, 9, |_| false, || None), Resumed { start: 2, stale: Some(Stale::Gone) });
        assert_eq!(resume_at(2, 9, |_| false, || Some(7)), Resumed { start: 2, stale: Some(Stale::Moved) });
        // a position of 0 can't have an entry before it, so the anchor was not checked, and is looked for
        assert_eq!(resume_at(3, 0, |_| true, || Some(1)), Resumed { start: 1, stale: Some(Stale::Moved) });
    }

    #[test]
    fn a_stale_warning_says_what_the_page_did() {
        let moved = stale_warning(Stale::Moved, "matching blocks");
        assert_eq!(moved.code, "cursor_stale");
        assert!(moved.message.contains("resumes right after it, so none is repeated"), "{}", moved.message);
        let gone = stale_warning(Stale::Gone, "matching blocks");
        assert!(gone.message.contains("is gone") && gone.message.contains("one may be missing or repeated"), "{}", gone.message);
        assert_eq!((moved.how_to_fetch_all, gone.how_to_fetch_all), (None, None));
    }

    // ---- a call with a cursor takes no other argument

    #[derive(Deserialize, JsonSchema)]
    #[allow(dead_code)]
    struct SampleArgs {
        text: Option<String>,
        #[serde(default)]
        limit: u64,
        #[serde(default)]
        include_context: bool,
        #[schemars(with = "Option<crate::tool::CursorSchema>")]
        cursor: Option<String>,
    }

    fn arguments(value: Value) -> Option<JsonObject> {
        value.as_object().cloned()
    }

    #[test]
    fn a_cursor_alone_is_allowed_and_null_and_unknown_fields_are_not_arguments() {
        assert!(refuse_with_cursor::<SampleArgs>(arguments(json!({"cursor": "abc"})).as_ref()).is_ok());
        assert!(refuse_with_cursor::<SampleArgs>(None).is_ok());
        assert!(refuse_with_cursor::<SampleArgs>(arguments(json!({"cursor": "abc", "text": null, "limit": null, "extra": 1})).as_ref()).is_ok());
    }

    #[test]
    fn any_other_argument_is_refused_by_name_and_the_first_in_schema_order_leads() {
        for (other, sent) in [("text", json!("x")), ("limit", json!(100)), ("include_context", json!(false))] {
            let error = refuse_with_cursor::<SampleArgs>(arguments(json!({"cursor": "abc", other: sent.clone()})).as_ref()).unwrap_err();
            assert_eq!((error.param.as_str(), error.value.as_str()), (other, sent.to_string().as_str()));
            assert!(error.expected.starts_with("left out when cursor is given"), "{error}");
        }
        // a value that is the default is still an argument that was sent
        assert_eq!(refuse_with_cursor::<SampleArgs>(arguments(json!({"cursor": "abc", "limit": 0})).as_ref()).unwrap_err().param, "limit");
        // in schema order, not the order sent
        let error = refuse_with_cursor::<SampleArgs>(arguments(json!({"include_context": true, "limit": 5, "cursor": "abc"})).as_ref()).unwrap_err();
        assert_eq!(error.param, "limit");
    }
}
