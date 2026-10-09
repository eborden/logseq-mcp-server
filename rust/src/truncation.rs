//! The warnings a capped list carries (BR-0006). A tool that cuts a list builds its warning here, so every cut says
//! how many were shown, how many there were, and what to do about the rest. The words are held byte for
//! byte by the recorded results (ADR-0034).

use crate::meta::ResultWarning;

/// Said wherever a warning suggests a call whose result may be large. The server can't know the
/// host's inline limit, so it says the risk exists and doesn't name a size (#187, #196).
pub const LARGE_RESULT_NOTE: &str =
    "A result this large may be saved to a file by the host instead of shown; the server can't tell.";

/// Rough counts of items that still come back inline (`INLINE_ITEMS`): blocks (search hits,
/// property matches, mentions, a page's blocks).
pub const INLINE_BLOCKS: usize = 200;
/// Backlink references: a block plus the page it sits on.
pub const INLINE_REFERENCES: usize = 150;
/// Related pages: a page and its direction.
pub const INLINE_RELATED_PAGES: usize = 500;
/// Concept network nodes, each with its edges.
pub const INLINE_NETWORK_NODES: usize = 200;
/// Listed pages (`list_pages`), counting aliased entries at about twice a plain one.
pub const INLINE_PAGES: usize = 800;

/// `blocksInlineMax`: the `inlineMax` for a list of blocks that may come back with
/// `include_context` or unslimmed (`slim_results: false`).
pub fn blocks_inline_max(context: bool, slim: bool) -> usize {
    match (context, slim) {
        (true, false) => 65,
        (true, true) => 120,
        (false, false) => 125,
        (false, true) => INLINE_BLOCKS,
    }
}

/// `largeResultNote`: ` <LARGE_RESULT_NOTE>` when a call that returns `items` items goes past
/// `inline_max`, else nothing. No `inline_max` means the caller makes no claim.
pub fn large_result_note(items: usize, inline_max: Option<usize>) -> String {
    match inline_max {
        Some(max) if items > max => format!(" {LARGE_RESULT_NOTE}"),
        _ => String::new(),
    }
}

/// `truncationWarning`: a list cut at `shown` out of `total` items, where `param` raises the cap.
pub fn truncation_warning(
    what: &str,
    shown: usize,
    total: usize,
    param: &str,
    code: &str,
    inline_max: Option<usize>,
) -> ResultWarning {
    ResultWarning {
        code: code.to_owned(),
        message: format!("Showing {shown} of {total} {what}."),
        how_to_fetch_all: Some(format!(
            "Set {param} to {total} (or higher) to get all {total}.{}",
            large_result_note(total, inline_max)
        )),
    }
}

/// Paging for a tool that also takes an offset: `param` is the paging parameter and `next` says
/// how to fetch the next page.
pub struct Paging<'a> {
    pub param: &'a str,
    pub next: String,
}

/// `CappedTruncation`: the arguments of [`capped_truncation_warning`].
pub struct CappedTruncation<'a> {
    /// What the list holds, plural: "matching blocks"
    pub what: &'a str,
    /// Items returned
    pub shown: usize,
    /// Items there were before the cap
    pub total: usize,
    /// The tool parameter (snake_case) that sets the cap, e.g. `limit`
    pub param: &'a str,
    /// The parameter's hard maximum
    pub max: usize,
    /// How to reach items past the maximum without paging
    pub narrower: &'a str,
    /// The caller's value, named in the message when it was above `max`
    pub requested: Option<u64>,
    /// `results_truncated` unless a tool names its own
    pub code: &'a str,
    pub inline_max: Option<usize>,
    pub paging: Option<Paging<'a>>,
}

/// `cappedTruncationWarning`: a list cut at `shown` of `total` items, where `param` can't go above
/// `max` (#61). The suggested value never points past the maximum:
/// - `total <= max`: raise `param` to `total`. With paging, the next page comes first and the raise
///   is the alternative.
/// - `shown < max < total`: raise `param` to `max` for more; `hasMore` stays true.
/// - `shown >= max`: the maximum was reached. With no paging no parameter fetches the rest, so
///   there is no `howToFetchAll` and `hasMore` is false; the warning is the signal (BR-0006). With
///   paging, the next page is the `howToFetchAll`.
pub fn capped_truncation_warning(c: CappedTruncation<'_>) -> ResultWarning {
    let CappedTruncation { what, shown, total, param, max, narrower, requested, code, inline_max, paging } = c;
    let paged_hint = paging.as_ref().map(|p| format!(" Page through the rest with {}.", p.param)).unwrap_or_default();
    if total <= max {
        let Some(paging) = paging else { return truncation_warning(what, shown, total, param, code, inline_max) };
        return ResultWarning {
            code: code.to_owned(),
            message: format!("Showing {shown} of {total} {what}.{paged_hint}"),
            how_to_fetch_all: Some(format!(
                "{} Or set {param} to {total} (or higher) to get all {total} in one call.{}",
                paging.next,
                large_result_note(total, inline_max)
            )),
        };
    }
    if shown < max {
        let note = large_result_note(max, inline_max);
        let how = match paging {
            Some(paging) => format!(
                "{} Or set {param} to {max} (the maximum) to get {max} of {total} in one call.{note}",
                paging.next
            ),
            None => format!("Set {param} to {max} (the maximum) to get {max} of {total}.{note} {narrower}"),
        };
        return ResultWarning {
            code: code.to_owned(),
            message: format!("Showing {shown} of {total} {what}.{paged_hint}"),
            how_to_fetch_all: Some(how),
        };
    }
    let clamped = requested.filter(|&r| r > max as u64).map(|r| format!(" ({r} was asked for)")).unwrap_or_default();
    let capped = format!("Showing {shown} of {total} {what}: {param} is capped at its maximum of {max}{clamped}");
    match paging {
        Some(paging) => {
            ResultWarning { code: code.to_owned(), message: format!("{capped}.{paged_hint}"), how_to_fetch_all: Some(paging.next) }
        }
        None => ResultWarning {
            code: code.to_owned(),
            message: format!("{capped}, so the rest can't be fetched in one call. {narrower}"),
            how_to_fetch_all: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> CappedTruncation<'static> {
        CappedTruncation {
            what: "matching blocks",
            shown: 2,
            total: 5,
            param: "limit",
            max: 500,
            narrower: "Narrow the query to see the rest.",
            requested: Some(2),
            code: "results_truncated",
            inline_max: Some(200),
            paging: None,
        }
    }

    #[test]
    fn inline_estimates_follow_context_and_slimness() {
        assert_eq!(
            [blocks_inline_max(false, true), blocks_inline_max(true, true), blocks_inline_max(false, false), blocks_inline_max(true, false)],
            [200, 120, 125, 65]
        );
    }

    #[test]
    fn a_cut_below_the_maximum_says_how_to_raise_the_cap() {
        let warning = capped_truncation_warning(base());
        assert_eq!(warning.message, "Showing 2 of 5 matching blocks.");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set limit to 5 (or higher) to get all 5."));
    }

    #[test]
    fn a_large_raise_adds_the_note() {
        let warning = capped_truncation_warning(CappedTruncation { total: 300, ..base() });
        assert_eq!(
            warning.how_to_fetch_all,
            Some(format!("Set limit to 300 (or higher) to get all 300. {LARGE_RESULT_NOTE}"))
        );
    }

    #[test]
    fn more_than_the_maximum_points_at_the_maximum_and_a_narrower_search() {
        let warning = capped_truncation_warning(CappedTruncation { total: 900, ..base() });
        assert_eq!(
            warning.how_to_fetch_all,
            Some(format!(
                "Set limit to 500 (the maximum) to get 500 of 900. {LARGE_RESULT_NOTE} Narrow the query to see the rest."
            ))
        );
    }

    #[test]
    fn at_the_maximum_there_is_no_way_to_fetch_the_rest() {
        let warning = capped_truncation_warning(CappedTruncation { shown: 500, total: 900, requested: Some(700), ..base() });
        assert_eq!(
            warning.message,
            "Showing 500 of 900 matching blocks: limit is capped at its maximum of 500 (700 was asked for), so the rest can't be fetched in one call. Narrow the query to see the rest."
        );
        assert_eq!(warning.how_to_fetch_all, None);
        let exact = capped_truncation_warning(CappedTruncation { shown: 500, total: 900, requested: Some(500), ..base() });
        assert!(!exact.message.contains("was asked for"));
    }

    #[test]
    fn paging_leads_and_stays_available_at_the_maximum() {
        let paging = || Some(Paging { param: "offset", next: "Set offset to 2 for the next page.".to_owned() });
        let low = capped_truncation_warning(CappedTruncation { paging: paging(), ..base() });
        assert_eq!(low.message, "Showing 2 of 5 matching blocks. Page through the rest with offset.");
        assert_eq!(
            low.how_to_fetch_all.as_deref(),
            Some("Set offset to 2 for the next page. Or set limit to 5 (or higher) to get all 5 in one call.")
        );
        let middle = capped_truncation_warning(CappedTruncation { total: 900, paging: paging(), ..base() });
        assert_eq!(
            middle.how_to_fetch_all,
            Some(format!(
                "Set offset to 2 for the next page. Or set limit to 500 (the maximum) to get 500 of 900 in one call. {LARGE_RESULT_NOTE}"
            ))
        );
        let top = capped_truncation_warning(CappedTruncation { shown: 500, total: 900, paging: paging(), ..base() });
        assert_eq!(top.message, "Showing 500 of 900 matching blocks: limit is capped at its maximum of 500. Page through the rest with offset.");
        assert_eq!(top.how_to_fetch_all.as_deref(), Some("Set offset to 2 for the next page."));
    }
}
