//! The `network_truncated` warning (#132). Below the maxima it says what it always did. A cap that is
//! already at its maximum (`max_nodes` 500, `max_fanout` 100) is never offered for raising, and a
//! suggested `max_nodes` never goes past 500. When nothing is left to raise there is no
//! `howToFetchAll`, so `hasMore` is false and the warning says the maximum was reached (BR-0006).
//! Each claim is made only when the walk showed it: a cap is named only if it dropped pages, and a
//! way to narrow the walk only if it would.
//!
//! A raise is also offered only when the raised result would fit the character budget (#485, #494): a call that
//! returns the same pages cut to 30,000 characters is no way to fetch the rest. The tool measures the result it has and
//! tells this warning how many pages fit ([`network_truncated_warning`]'s `fits`), and when the result is cut to the
//! budget after all, the warning is the one of [`network_truncated_then_cut_by_size`], with no advice to raise.

use super::selection::HUB_LINKS;
use crate::meta::ResultWarning;
use crate::truncation::{INLINE_NETWORK_NODES, large_result_note};

/// A roll-up page the walk showed and did not walk through (#498).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubPage {
    pub id: i64,
    pub name: String,
    /// The pages it links
    pub links: i64,
}

/// The code of the `hub_pages_not_expanded` warning.
pub const HUB_CODE: &str = "hub_pages_not_expanded";

/// The `hub_pages_not_expanded` warning (#498, BR-0006): the pages of `hubs` are in the result as leaves, so what they
/// link is not. With `offer`, `expand_journals` is the way to walk through them, and the caller has made sure that
/// doing so brings more pages and that the result would still fit the character budget; without it the warning says only
/// how to see one page's links.
pub fn hub_pages_not_expanded(hubs: &[HubPage], offer: bool) -> ResultWarning {
    const LISTED: usize = 5;
    let listed: Vec<String> = hubs.iter().take(LISTED).map(|hub| format!("{} ({} pages)", hub.name, hub.links)).collect();
    let more = hubs.len().saturating_sub(LISTED);
    let list = if more == 0 { listed.join(", ") } else { format!("{}, and {more} more", listed.join(", ")) };
    let (message, them) = if hubs.len() == 1 {
        (
            format!(
                "1 page links more than {HUB_LINKS} pages, like a roll-up, so it is shown but its links are not followed: {list}. \
                 To see its links, start from it."
            ),
            "it",
        )
    } else {
        (
            format!(
                "{} pages link more than {HUB_LINKS} pages each, like roll-ups, so they are shown but their links are not followed: {list}. \
                 To see the links of one, start from it.",
                hubs.len()
            ),
            "them",
        )
    };
    ResultWarning {
        code: HUB_CODE.to_owned(),
        message,
        how_to_fetch_all: offer.then(|| format!("Set expand_journals to true to walk through {them} too. It can flood the network.")),
    }
}

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

/// A way to raise a cap, with the pages a call that raised it alone would hold at least.
struct Raise {
    text: String,
    pages: usize,
    /// It is `max_nodes` that is raised
    nodes: bool,
}

/// What a raise that would not fit the budget is told instead: nothing to fetch, and how to narrow the walk.
const NO_ROOM: &str = "A larger cap would only return a result cut to the size limit, so there is nothing to raise. To narrow the walk instead, lower max_depth or start from a more specific page.";

/// The warning when the pages are cut again to fit the character budget: the caps dropped pages, then the size limit
/// cut what was kept, and a raise of either would end in the same cut.
pub fn network_truncated_then_cut_by_size(f: TruncationFacts) -> ResultWarning {
    warning(
        format!("At least {} more connected pages were dropped by max_nodes or max_fanout before the result was cut to its size limit.", f.dropped),
        None,
    )
}

/// The `network_truncated` warning. `fits` is how many pages are estimated to fit the character budget, when the result
/// is known to fit it as it is (`None` leaves the advice as it always was): a raise that would bring more pages than that
/// is not offered.
pub fn network_truncated_warning(f: TruncationFacts, fits: Option<usize>) -> ResultWarning {
    let base = format!("Kept {} pages; at least {} more connected pages were dropped.", f.kept, f.dropped);
    let suggested_nodes = f.kept + f.dropped;
    let too_big = |pages: usize| fits.is_some_and(|fits| pages > fits);

    // No cap at its maximum, and the suggested max_nodes is in range: unchanged
    if suggested_nodes <= MAX_NODES_LIMIT && f.max_fanout < MAX_FANOUT_LIMIT {
        if too_big(suggested_nodes) {
            return warning(format!("{base} {NO_ROOM}"), None);
        }
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
    // would only change which pages are kept. Each raise comes with the pages a call with it alone would hold at least.
    let mut raise: Vec<Raise> = Vec::new();
    if nodes_bit && !nodes_at_max {
        // Pages the fanout cap dropped are not the budget's to hold, so count only the budget's
        let holds_all = f.kept + f.dropped_by_budget;
        raise.push(Raise {
            text: if holds_all <= MAX_NODES_LIMIT {
                format!("max_nodes to {holds_all} (max {MAX_NODES_LIMIT})")
            } else {
                format!("max_nodes to {MAX_NODES_LIMIT} (the maximum)")
            },
            pages: holds_all.min(MAX_NODES_LIMIT),
            nodes: true,
        });
    }
    if fanout_bit && !fanout_at_max && !nodes_at_max {
        raise.push(Raise { text: format!("max_fanout higher (max {MAX_FANOUT_LIMIT})"), pages: f.kept + f.dropped_by_fanout, nodes: false });
    }

    let reached_clause = reached.join(" and ");
    let with_reached = |base: String| if reached_clause.is_empty() { base } else { format!("{base} {reached_clause}.") };
    if !raise.is_empty() {
        // A raise that would not fit the budget on its own is not offered. Two that fit alone are offered together only
        // when they fit together, else as one or the other.
        let fitting: Vec<&Raise> = raise.iter().filter(|raise| !too_big(raise.pages)).collect();
        if fitting.is_empty() {
            return warning(format!("{} {NO_ROOM}", with_reached(base)), None);
        }
        let together = f.kept + fitting.iter().map(|raise| raise.pages - f.kept).sum::<usize>();
        let joiner = if too_big(together) { " or " } else { " and/or " };
        let text = fitting.iter().map(|raise| raise.text.as_str()).collect::<Vec<_>>().join(joiner);
        // the large-result note is about the node budget's raise, when it is one of those offered
        let raised_nodes = fitting.iter().find(|raise| raise.nodes).map_or(0, |raise| raise.pages);
        return warning(with_reached(base), Some(format!("Set {text}.{}", large_result_note(raised_nodes, Some(INLINE_NETWORK_NODES)))));
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
        let warning = network_truncated_warning(facts(), None);
        assert_eq!(warning.code, "network_truncated");
        assert_eq!(warning.message, "Kept 50 pages; at least 10 more connected pages were dropped.");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Set max_nodes to 60 (max 500) and/or max_fanout higher (max 100), or set expand_journals to walk through journal pages.")
        );
    }

    #[test]
    fn a_suggestion_of_more_than_200_pages_adds_the_large_result_note() {
        let warning = network_truncated_warning(TruncationFacts { kept: 100, dropped: 150, max_nodes: 100, ..facts() }, None);
        assert!(warning.how_to_fetch_all.unwrap().ends_with(&format!("walk through journal pages. {LARGE_RESULT_NOTE}")));
    }

    #[test]
    fn a_suggestion_past_500_points_at_the_maximum_and_names_only_the_cap_that_bit() {
        let warning = network_truncated_warning(TruncationFacts { kept: 100, dropped: 600, dropped_by_budget: 600, max_nodes: 100, ..facts() }, None);
        assert_eq!(warning.message, "Kept 100 pages; at least 600 more connected pages were dropped.");
        assert_eq!(warning.how_to_fetch_all, Some(format!("Set max_nodes to 500 (the maximum). {LARGE_RESULT_NOTE}")));
    }

    #[test]
    fn only_the_fanout_cap_biting_is_raised_alone() {
        let warning = network_truncated_warning(TruncationFacts { kept: 300, dropped: 300, dropped_by_fanout: 300, dropped_by_budget: 0, max_nodes: 300, ..facts() }, None);
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
        }, None);
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
        }, None);
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
        }, None);
        assert_eq!(warning.message, "Kept 50 pages; at least 30 more connected pages were dropped. max_fanout reached its maximum of 100.");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_nodes to 60 (max 500)."));
    }

    #[test]
    fn a_raise_that_would_not_fit_the_budget_is_not_offered_and_the_warning_says_how_to_narrow() {
        // 50 kept, 10 dropped: 60 pages are wanted, and only 55 are estimated to fit
        let warning = network_truncated_warning(facts(), Some(55));
        assert_eq!(warning.how_to_fetch_all, None);
        assert_eq!(
            warning.message,
            "Kept 50 pages; at least 10 more connected pages were dropped. A larger cap would only return a result cut to the size limit, \
             so there is nothing to raise. To narrow the walk instead, lower max_depth or start from a more specific page."
        );
        // 60 fit: the raise is offered as it always was
        assert_eq!(network_truncated_warning(facts(), Some(60)), network_truncated_warning(facts(), None));
    }

    #[test]
    fn only_the_raise_that_would_be_offered_is_measured() {
        // the fanout cap alone bit: 300 kept and 300 more, so 600 would have to fit
        let fanout = TruncationFacts { kept: 300, dropped: 300, dropped_by_fanout: 300, dropped_by_budget: 0, max_nodes: 300, ..facts() };
        assert_eq!(network_truncated_warning(fanout, Some(600)).how_to_fetch_all.as_deref(), Some("Set max_fanout higher (max 100)."));
        assert_eq!(network_truncated_warning(fanout, Some(599)).how_to_fetch_all, None);
        // with the fanout cap at its maximum the node budget is the only raise, and only its pages count: 20 fanout drops don't
        let nodes = TruncationFacts { kept: 50, dropped: 30, dropped_by_fanout: 20, dropped_by_budget: 10, max_nodes: 50, max_fanout: 100, ..facts() };
        assert_eq!(network_truncated_warning(nodes, Some(60)).how_to_fetch_all.as_deref(), Some("Set max_nodes to 60 (max 500)."));
        let none = network_truncated_warning(nodes, Some(59));
        assert_eq!(none.how_to_fetch_all, None);
        assert_eq!(
            none.message,
            "Kept 50 pages; at least 30 more connected pages were dropped. max_fanout reached its maximum of 100. A larger cap would only return a result cut to the size limit, \
             so there is nothing to raise. To narrow the walk instead, lower max_depth or start from a more specific page."
        );
    }

    #[test]
    fn two_raises_are_offered_together_alone_or_one_of_them_by_what_fits() {
        // 50 kept; raising max_nodes brings 50 more, raising max_fanout 500 more
        let both = TruncationFacts { kept: 50, dropped: 550, dropped_by_fanout: 500, dropped_by_budget: 50, max_nodes: 50, ..facts() };
        let offered = |fits| network_truncated_warning(both, Some(fits)).how_to_fetch_all;
        assert_eq!(offered(600).as_deref(), Some("Set max_nodes to 100 (max 500) and/or max_fanout higher (max 100)."));
        // each fits alone and the two do not fit together
        assert_eq!(offered(560).as_deref(), Some("Set max_nodes to 100 (max 500) or max_fanout higher (max 100)."));
        // only the node budget's raise fits
        assert_eq!(offered(120).as_deref(), Some("Set max_nodes to 100 (max 500)."));
        // none does
        assert_eq!(offered(99), None);
    }

    fn hub(id: i64, name: &str, links: i64) -> HubPage {
        HubPage { id, name: name.to_owned(), links }
    }

    #[test]
    fn one_roll_up_is_named_with_its_links_and_the_way_to_walk_through_it() {
        let warning = hub_pages_not_expanded(&[hub(1, "Rollup", 41)], true);
        assert_eq!(warning.code, "hub_pages_not_expanded");
        assert_eq!(
            warning.message,
            "1 page links more than 30 pages, like a roll-up, so it is shown but its links are not followed: Rollup (41 pages). To see its links, start from it."
        );
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set expand_journals to true to walk through it too. It can flood the network."));
    }

    #[test]
    fn several_roll_ups_are_listed_up_to_five_and_counted_after_that() {
        let hubs: Vec<HubPage> = (1..=7).map(|n| hub(n, &format!("Rollup {n}"), 30 + n)).collect();
        let warning = hub_pages_not_expanded(&hubs, true);
        assert_eq!(
            warning.message,
            "7 pages link more than 30 pages each, like roll-ups, so they are shown but their links are not followed: \
             Rollup 1 (31 pages), Rollup 2 (32 pages), Rollup 3 (33 pages), Rollup 4 (34 pages), Rollup 5 (35 pages), and 2 more. \
             To see the links of one, start from it."
        );
        assert!(warning.how_to_fetch_all.unwrap().starts_with("Set expand_journals to true to walk through them too."));
        let two = hub_pages_not_expanded(&hubs[..2], false);
        assert!(two.message.ends_with("Rollup 1 (31 pages), Rollup 2 (32 pages). To see the links of one, start from it."), "{}", two.message);
    }

    #[test]
    fn without_an_offer_there_is_nothing_to_fetch() {
        assert_eq!(hub_pages_not_expanded(&[hub(1, "Rollup", 41)], false).how_to_fetch_all, None);
    }

    #[test]
    fn a_walk_cut_to_the_size_limit_after_the_caps_says_both_and_offers_nothing() {
        let warning = network_truncated_then_cut_by_size(TruncationFacts { dropped: 25, ..facts() });
        assert_eq!(warning.code, "network_truncated");
        assert_eq!(warning.message, "At least 25 more connected pages were dropped by max_nodes or max_fanout before the result was cut to its size limit.");
        assert_eq!(warning.how_to_fetch_all, None);
    }
}
