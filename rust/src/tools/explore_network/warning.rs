//! The `network_truncated` warning (#132): what the rules of the walk left out. `max_fanout` limits the new pages one page
//! may add, and the walk itself stops at `MAX_NODES_LIMIT` pages. The result is read to the end with the cursor (ADR-0038),
//! so the size of the result is no part of this warning: it says what the walk left out, and the one parameter that
//! follows more of it, `max_fanout`, offered beside the cursor and not measured against the character budget (a larger
//! walk is read in pages). `hasMore` is the cursor's alone, so a raise never makes it true.
//! Each claim is made only when the walk showed it: a rule is named only if it dropped pages, and a way to narrow the walk
//! only if it would.

use super::selection::HUB_LINKS;
use crate::meta::ResultWarning;

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
/// link is not. With `offer` (the pages walking through them brings at least), `expand_journals` is the way to do it,
/// and the caller has made sure that doing so brings that many pages; without it the warning says only how to see one
/// page's links. The offer is not measured against the character budget: a larger walk is read in pages with the cursor
/// (ADR-0038). `expand_journals` also walks through journal pages, so the caller offers it only when none were left as leaves.
pub fn hub_pages_not_expanded(hubs: &[HubPage], offer: Option<usize>) -> ResultWarning {
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
        how_to_fetch_all: offer.map(|at_least| {
            let pages = if at_least == 1 { "1 page".to_owned() } else { format!("{at_least} pages") };
            format!("Set expand_journals to true to walk through {them} too. That adds at least {pages} and can flood the network.")
        }),
    }
}


/// The most pages the walk holds, root included, and the most `max_nodes` (the page size) a caller may set.
pub const MAX_NODES_LIMIT: usize = 500;
/// The most the handler lets a caller set `max_fanout` to.
pub const MAX_FANOUT_LIMIT: usize = 100;

/// What the walk showed about the pages its rules left out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TruncationFacts {
    pub kept: usize,
    /// A lower bound: pages dropped at the depths that were walked
    pub dropped: usize,
    pub dropped_by_fanout: usize,
    /// Pages dropped because the walk had reached its limit
    pub dropped_by_budget: usize,
    /// The most pages the walk holds
    pub walk_limit: usize,
    pub max_fanout: usize,
    /// The first depth at which a page was dropped
    pub first_drop_depth: i64,
    pub expand_journals: bool,
    /// A journal page was expanded at a depth before the first drop
    pub expanded_journal: bool,
}

/// The code of the warning for pages the rules of the walk left out.
pub const CODE: &str = "network_truncated";

/// The `network_truncated` warning. The offer of a higher `max_fanout` is in `howToFetchAll`, beside the cursor of a result
/// that is paged: it is a different walk, not a later page, so it never decides `hasMore`. It does not claim the larger
/// result fits the character budget, which the cursor takes care of.
pub fn network_truncated_warning(f: TruncationFacts) -> ResultWarning {
    let fanout_bit = f.dropped_by_fanout > 0;
    let budget_bit = f.dropped_by_budget > 0;
    let fanout_at_max = f.max_fanout >= MAX_FANOUT_LIMIT;
    let mut message = format!("The walk holds {} pages; at least {} more connected pages were dropped.", f.kept, f.dropped);
    if fanout_bit {
        let at_max = if fanout_at_max { ", its maximum" } else { "" };
        message.push_str(&format!(" max_fanout limits the new pages one page may add ({}{at_max}).", f.max_fanout));
    }
    if budget_bit {
        message.push_str(&format!(" The walk stops at {} pages.", f.walk_limit));
    }
    let raises_fanout = fanout_bit && !fanout_at_max;
    if !raises_fanout || budget_bit {
        // What no parameter reaches, and what narrows the walk instead
        let mut narrow: Vec<&str> = Vec::new();
        if f.first_drop_depth >= 2 {
            narrow.push("lower max_depth");
        }
        if f.expand_journals && f.expanded_journal {
            narrow.push("set expand_journals to false so journal pages stay leaves");
        }
        if !raises_fanout {
            message.push_str(" No parameter fetches the rest.");
        }
        if !narrow.is_empty() {
            message.push_str(&format!(" To narrow the walk instead, {}.", narrow.join(" or ")));
        }
    }
    let how_to_fetch_all = raises_fanout.then(|| {
        format!("Set max_fanout higher (max {MAX_FANOUT_LIMIT}) to follow more pages from each page. The walk gets larger, and the cursor reads a larger one in pages.")
    });
    ResultWarning { code: CODE.to_owned(), message, how_to_fetch_all }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> TruncationFacts {
        TruncationFacts {
            kept: 120,
            dropped: 10,
            dropped_by_fanout: 10,
            dropped_by_budget: 0,
            walk_limit: 500,
            max_fanout: 15,
            first_drop_depth: 1,
            expand_journals: false,
            expanded_journal: false,
        }
    }

    #[test]
    fn a_fanout_that_bit_below_its_maximum_offers_a_higher_one_without_claiming_it_fits() {
        let warning = network_truncated_warning(facts());
        assert_eq!(warning.code, "network_truncated");
        assert_eq!(
            warning.message,
            "The walk holds 120 pages; at least 10 more connected pages were dropped. max_fanout limits the new pages one page may add (15)."
        );
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Set max_fanout higher (max 100) to follow more pages from each page. The walk gets larger, and the cursor reads a larger one in pages.")
        );
    }

    #[test]
    fn a_fanout_at_its_maximum_offers_nothing_and_says_how_to_narrow() {
        let warning = network_truncated_warning(TruncationFacts { max_fanout: 100, first_drop_depth: 2, expand_journals: true, expanded_journal: true, ..facts() });
        assert_eq!(warning.how_to_fetch_all, None);
        assert_eq!(
            warning.message,
            "The walk holds 120 pages; at least 10 more connected pages were dropped. max_fanout limits the new pages one page may add (100, its maximum). \
             No parameter fetches the rest. To narrow the walk instead, lower max_depth or set expand_journals to false so journal pages stay leaves."
        );
    }

    #[test]
    fn a_drop_at_depth_one_cannot_be_narrowed_by_depth() {
        let warning = network_truncated_warning(TruncationFacts { max_fanout: 100, ..facts() });
        assert!(!warning.message.contains("max_depth"), "{}", warning.message);
        assert!(warning.message.ends_with("No parameter fetches the rest."), "{}", warning.message);
    }

    #[test]
    fn a_walk_that_reached_its_limit_says_so_and_no_parameter_raises_it() {
        let warning = network_truncated_warning(TruncationFacts { kept: 500, dropped: 20, dropped_by_fanout: 0, dropped_by_budget: 20, first_drop_depth: 2, ..facts() });
        assert_eq!(warning.how_to_fetch_all, None);
        assert_eq!(
            warning.message,
            "The walk holds 500 pages; at least 20 more connected pages were dropped. The walk stops at 500 pages. No parameter fetches the rest. \
             To narrow the walk instead, lower max_depth."
        );
    }

    #[test]
    fn both_rules_biting_name_both_and_still_offer_the_fanout_raise_with_the_way_to_narrow() {
        let warning = network_truncated_warning(TruncationFacts { kept: 500, dropped: 30, dropped_by_fanout: 10, dropped_by_budget: 20, first_drop_depth: 2, ..facts() });
        assert!(warning.message.contains("max_fanout limits the new pages one page may add (15). The walk stops at 500 pages."), "{}", warning.message);
        assert!(warning.message.ends_with("To narrow the walk instead, lower max_depth."), "{}", warning.message);
        assert!(!warning.message.contains("No parameter fetches the rest"), "{}", warning.message);
        assert!(warning.how_to_fetch_all.is_some());
    }

    #[test]
    fn a_walk_of_the_librarys_smaller_limit_names_that_limit() {
        let warning = network_truncated_warning(TruncationFacts { kept: 4, dropped: 2, dropped_by_fanout: 0, dropped_by_budget: 2, walk_limit: 4, ..facts() });
        assert!(warning.message.contains("The walk stops at 4 pages."), "{}", warning.message);
    }

    fn hub(id: i64, name: &str, links: i64) -> HubPage {
        HubPage { id, name: name.to_owned(), links }
    }

    #[test]
    fn one_roll_up_is_named_with_its_links_and_the_way_to_walk_through_it() {
        let warning = hub_pages_not_expanded(&[hub(1, "Rollup", 41)], Some(15));
        assert_eq!(warning.code, "hub_pages_not_expanded");
        assert_eq!(
            warning.message,
            "1 page links more than 30 pages, like a roll-up, so it is shown but its links are not followed: Rollup (41 pages). To see its links, start from it."
        );
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set expand_journals to true to walk through it too. That adds at least 15 pages and can flood the network."));
        // one page is not "1 pages"
        let one = hub_pages_not_expanded(&[hub(1, "Rollup", 41)], Some(1));
        assert!(one.how_to_fetch_all.unwrap().contains("adds at least 1 page and"));
    }

    #[test]
    fn several_roll_ups_are_listed_up_to_five_and_counted_after_that() {
        let hubs: Vec<HubPage> = (1..=7).map(|n| hub(n, &format!("Rollup {n}"), 30 + n)).collect();
        let warning = hub_pages_not_expanded(&hubs, Some(2));
        assert_eq!(
            warning.message,
            "7 pages link more than 30 pages each, like roll-ups, so they are shown but their links are not followed: \
             Rollup 1 (31 pages), Rollup 2 (32 pages), Rollup 3 (33 pages), Rollup 4 (34 pages), Rollup 5 (35 pages), and 2 more. \
             To see the links of one, start from it."
        );
        assert!(warning.how_to_fetch_all.unwrap().starts_with("Set expand_journals to true to walk through them too."));
        let two = hub_pages_not_expanded(&hubs[..2], None);
        assert!(two.message.ends_with("Rollup 1 (31 pages), Rollup 2 (32 pages). To see the links of one, start from it."), "{}", two.message);
    }

    #[test]
    fn without_an_offer_there_is_nothing_to_fetch() {
        assert_eq!(hub_pages_not_expanded(&[hub(1, "Rollup", 41)], None).how_to_fetch_all, None);
    }
}
