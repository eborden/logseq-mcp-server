//! The warnings a capped list carries (BR-0006). A tool that cuts a list builds its warning here, so every cut says
//! how many were shown, how many there were, and what to do about the rest. The words are held byte for
//! byte by the recorded results (ADR-0034).

use crate::budget::{BUDGET_CHARS, SIZE_TRUNCATED_CODE};
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
/// Listed pages (`find_pages`), counting aliased entries at about twice a plain one.
pub const INLINE_PAGES: usize = 800;

/// The inline maximum for a list of blocks that may come back with
/// `include_context` or unslimmed (`slim_results: false`).
pub fn blocks_inline_max(context: bool, slim: bool) -> usize {
    match (context, slim) {
        (true, false) => 65,
        (true, true) => 120,
        (false, false) => 125,
        (false, true) => INLINE_BLOCKS,
    }
}

/// The note ` <LARGE_RESULT_NOTE>` when a call that returns `items` items goes past
/// `inline_max`, else nothing. No `inline_max` means the caller makes no claim.
pub fn large_result_note(items: usize, inline_max: Option<usize>) -> String {
    match inline_max {
        Some(max) if items > max => format!(" {LARGE_RESULT_NOTE}"),
        _ => String::new(),
    }
}

/// `SizeCut`: the arguments of [`size_truncation_warning`].
pub struct SizeCut<'a> {
    /// What the list holds, plural: "pages"
    pub what: &'a str,
    /// Entries kept
    pub kept: usize,
    /// Entries there were before the cut
    pub total: usize,
    /// The first entries kept are over the budget, on their own or with the result around them, and were returned whole (BR-0007)
    pub oversize: bool,
    /// What the caller can do to see less, or other, material: a parameter to lower, a tool to call
    pub advice: &'a str,
    /// A way to get the rest, only when a parameter can fetch it (BR-0006). Its presence makes `hasMore` true.
    pub how_to_fetch_all: Option<String>,
}

/// The `result_size_truncated` warning (#485): the result was cut to fit [`BUDGET_CHARS`] characters, after
/// the count caps had been applied. No parameter raises the budget, so `how_to_fetch_all` is there only when a
/// call can read on from where the cut fell (a date, a page of results), and `hasMore` is false otherwise.
pub fn size_truncation_warning(cut: SizeCut<'_>) -> ResultWarning {
    let SizeCut { what, kept, total, oversize, advice, how_to_fetch_all } = cut;
    let alone = if oversize { " Even those are over that size, whether from the entry or from the result around it: an entry is never cut inside its text." } else { "" };
    ResultWarning {
        code: SIZE_TRUNCATED_CODE.to_owned(),
        message: format!(
            "Showing {kept} of {total} {what}: the result was cut to fit {BUDGET_CHARS} characters, since a larger one may be saved to a file by the host instead of shown.{alone} {advice}"
        ),
        how_to_fetch_all,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_size_cut_names_the_budget_and_has_more_only_when_a_call_reads_on() {
        let cut = SizeCut { what: "pages", kept: 40, total: 90, oversize: false, advice: "Lower max_depth.", how_to_fetch_all: None };
        let warning = size_truncation_warning(cut);
        assert_eq!(warning.code, "result_size_truncated");
        assert_eq!(
            warning.message,
            "Showing 40 of 90 pages: the result was cut to fit 30000 characters, since a larger one may be saved to a file by the host instead of shown. Lower max_depth."
        );
        assert_eq!(warning.how_to_fetch_all, None);
        let alone = size_truncation_warning(SizeCut {
            what: "pages",
            kept: 1,
            total: 2,
            oversize: true,
            advice: "Read it with logseq_get_block.",
            how_to_fetch_all: Some("Call again with start_date 20250102.".to_owned()),
        });
        assert!(alone.message.contains("Even those are over that size, whether from the entry or from the result around it: an entry is never cut inside its text. Read it"), "{}", alone.message);
        assert_eq!(alone.how_to_fetch_all.as_deref(), Some("Call again with start_date 20250102."));
    }

    #[test]
    fn inline_estimates_follow_context_and_slimness() {
        assert_eq!(
            [blocks_inline_max(false, true), blocks_inline_max(true, true), blocks_inline_max(false, false), blocks_inline_max(true, false)],
            [200, 120, 125, 65]
        );
    }
}
