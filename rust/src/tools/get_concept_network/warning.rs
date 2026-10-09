//! The `network_truncated` warning (#132). Below the maxima it says what it always did. A cap that is
//! already at its maximum (`max_nodes` 500, `max_fanout` 100) is never offered for raising, and a
//! suggested `max_nodes` never goes past 500. When nothing is left to raise there is no
//! `howToFetchAll`, so `hasMore` is false and the warning says the maximum was reached (BR-0006).
//! Each claim is made only when the walk showed it: a cap is named only if it dropped pages, and a
//! way to narrow the walk only if it would.

use crate::meta::ResultWarning;
use crate::truncation::{INLINE_NETWORK_NODES, large_result_note};

/// The most the handler lets a caller set `max_nodes` to.
pub const MAX_NODES_LIMIT: usize = 500;
/// The most the handler lets a caller set `max_fanout` to.
pub const MAX_FANOUT_LIMIT: usize = 100;

/// What the walk showed about the cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TruncationFacts {
    pub kept: usize,
    /// A lower bound: pages dropped at the depths that were walked
    pub dropped: usize,
    pub dropped_by_fanout: usize,
    pub dropped_by_budget: usize,
    pub max_nodes: usize,
    pub max_fanout: usize,
    /// The first depth at which a page was dropped
    pub first_drop_depth: i64,
    pub expand_journals: bool,
    /// A journal page was expanded at a depth before the first drop
    pub expanded_journal: bool,
}

const CODE: &str = "network_truncated";

fn warning(message: String, how_to_fetch_all: Option<String>) -> ResultWarning {
    ResultWarning { code: CODE.to_owned(), message, how_to_fetch_all }
}

/// `networkTruncatedWarning`.
pub fn network_truncated_warning(f: TruncationFacts) -> ResultWarning {
    let base = format!("Kept {} pages; at least {} more connected pages were dropped.", f.kept, f.dropped);
    let suggested_nodes = f.kept + f.dropped;

    // No cap at its maximum, and the suggested max_nodes is in range: unchanged
    if suggested_nodes <= MAX_NODES_LIMIT && f.max_fanout < MAX_FANOUT_LIMIT {
        return warning(
            base,
            Some(format!(
                "Set max_nodes to {suggested_nodes} (max {MAX_NODES_LIMIT}) and/or max_fanout higher (max {MAX_FANOUT_LIMIT}), \
                 or set expand_journals to walk through journal pages.{}",
                large_result_note(suggested_nodes, Some(INLINE_NETWORK_NODES))
            )),
        );
    }

    let nodes_bit = f.dropped_by_budget > 0;
    let fanout_bit = f.dropped_by_fanout > 0;
    let nodes_at_max = nodes_bit && f.max_nodes >= MAX_NODES_LIMIT;
    let fanout_at_max = fanout_bit && f.max_fanout >= MAX_FANOUT_LIMIT;

    let mut reached: Vec<String> = Vec::new();
    if nodes_at_max {
        reached.push(format!("max_nodes reached its maximum of {MAX_NODES_LIMIT}"));
    }
    if fanout_at_max {
        reached.push(format!("max_fanout reached its maximum of {MAX_FANOUT_LIMIT}"));
    }

    // With the node budget full at its maximum, no other parameter adds a page; a larger fanout
    // would only change which pages are kept.
    let mut raise: Vec<String> = Vec::new();
    let mut raised_nodes = 0;
    if nodes_bit && !nodes_at_max {
        // Pages the fanout cap dropped are not the budget's to hold, so count only the budget's
        let holds_all = f.kept + f.dropped_by_budget;
        raised_nodes = holds_all.min(MAX_NODES_LIMIT);
        raise.push(if holds_all <= MAX_NODES_LIMIT {
            format!("max_nodes to {holds_all} (max {MAX_NODES_LIMIT})")
        } else {
            format!("max_nodes to {MAX_NODES_LIMIT} (the maximum)")
        });
    }
    if fanout_bit && !fanout_at_max && !nodes_at_max {
        raise.push(format!("max_fanout higher (max {MAX_FANOUT_LIMIT})"));
    }

    let reached_clause = reached.join(" and ");
    if !raise.is_empty() {
        return warning(
            if reached_clause.is_empty() { base } else { format!("{base} {reached_clause}.") },
            Some(format!("Set {}.{}", raise.join(" and/or "), large_result_note(raised_nodes, Some(INLINE_NETWORK_NODES)))),
        );
    }

    let mut narrow: Vec<&str> = Vec::new();
    // Lowering max_depth changes nothing when the first drop is at depth 1
    if f.first_drop_depth >= 2 {
        narrow.push("lower max_depth");
    }
    if f.expand_journals && f.expanded_journal {
        narrow.push("set expand_journals to false so journal pages stay leaves");
    }
    let narrow_text = if narrow.is_empty() { String::new() } else { format!(" To narrow the walk instead, {}.", narrow.join(" or ")) };
    // A cut with nothing to raise has a cap at its maximum, so `reached_clause` is never empty here
    warning(format!("{base} {reached_clause}, so the rest can't be fetched in one call.{narrow_text}"), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::truncation::LARGE_RESULT_NOTE;

    fn facts() -> TruncationFacts {
        TruncationFacts {
            kept: 50,
            dropped: 10,
            dropped_by_fanout: 0,
            dropped_by_budget: 10,
            max_nodes: 50,
            max_fanout: 15,
            first_drop_depth: 1,
            expand_journals: false,
            expanded_journal: false,
        }
    }

    #[test]
    fn below_the_maxima_it_says_what_it_always_did() {
        let warning = network_truncated_warning(facts());
        assert_eq!(warning.code, "network_truncated");
        assert_eq!(warning.message, "Kept 50 pages; at least 10 more connected pages were dropped.");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Set max_nodes to 60 (max 500) and/or max_fanout higher (max 100), or set expand_journals to walk through journal pages.")
        );
    }

    #[test]
    fn a_suggestion_of_more_than_200_pages_adds_the_large_result_note() {
        let warning = network_truncated_warning(TruncationFacts { kept: 100, dropped: 150, max_nodes: 100, ..facts() });
        assert!(warning.how_to_fetch_all.unwrap().ends_with(&format!("walk through journal pages. {LARGE_RESULT_NOTE}")));
    }

    #[test]
    fn a_suggestion_past_500_points_at_the_maximum_and_names_only_the_cap_that_bit() {
        let warning = network_truncated_warning(TruncationFacts { kept: 100, dropped: 600, dropped_by_budget: 600, max_nodes: 100, ..facts() });
        assert_eq!(warning.message, "Kept 100 pages; at least 600 more connected pages were dropped.");
        assert_eq!(warning.how_to_fetch_all, Some(format!("Set max_nodes to 500 (the maximum). {LARGE_RESULT_NOTE}")));
    }

    #[test]
    fn only_the_fanout_cap_biting_is_raised_alone() {
        let warning = network_truncated_warning(TruncationFacts { kept: 300, dropped: 300, dropped_by_fanout: 300, dropped_by_budget: 0, max_nodes: 300, ..facts() });
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_fanout higher (max 100)."));
    }

    #[test]
    fn the_node_cap_at_its_maximum_offers_nothing_to_raise_and_says_how_to_narrow() {
        let warning = network_truncated_warning(TruncationFacts {
            kept: 500,
            dropped: 20,
            dropped_by_budget: 20,
            max_nodes: 500,
            first_drop_depth: 2,
            expand_journals: true,
            expanded_journal: true,
            ..facts()
        });
        assert_eq!(warning.how_to_fetch_all, None);
        assert_eq!(
            warning.message,
            "Kept 500 pages; at least 20 more connected pages were dropped. max_nodes reached its maximum of 500, so the rest can't be fetched in one call. \
             To narrow the walk instead, lower max_depth or set expand_journals to false so journal pages stay leaves."
        );
    }

    #[test]
    fn both_caps_at_their_maxima_are_named_together_and_a_drop_at_depth_one_cannot_be_narrowed_by_depth() {
        let warning = network_truncated_warning(TruncationFacts {
            kept: 500,
            dropped: 40,
            dropped_by_fanout: 20,
            dropped_by_budget: 20,
            max_nodes: 500,
            max_fanout: 100,
            ..facts()
        });
        assert_eq!(
            warning.message,
            "Kept 500 pages; at least 40 more connected pages were dropped. max_nodes reached its maximum of 500 and max_fanout reached its maximum of 100, \
             so the rest can't be fetched in one call."
        );
    }

    #[test]
    fn a_fanout_at_its_maximum_still_lets_the_node_budget_be_raised_and_says_so() {
        let warning = network_truncated_warning(TruncationFacts {
            kept: 50,
            dropped: 30,
            dropped_by_fanout: 20,
            dropped_by_budget: 10,
            max_nodes: 50,
            max_fanout: 100,
            ..facts()
        });
        assert_eq!(warning.message, "Kept 50 pages; at least 30 more connected pages were dropped. max_fanout reached its maximum of 100.");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_nodes to 60 (max 500)."));
    }
}
