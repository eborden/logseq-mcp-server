//! The Datalog queries only the timeline makes. The day bounds and a page name are bound with `:in`, as typed
//! [`DayBound`]s and [`PageName`]s, so no value is part of the query text (ADR-0013); the ids of an alias group are
//! embedded through [`ground_ids`], which takes [`PageId`]s and not numbers.
//!
//! `[?page :block/name]` is required in every journal query: blocks LogSeq creates in the app on a journal
//! page carry `:block/journal-day` too (a scheduled or deadline date does not, #140), and without
//! it they match as pages.

use crate::edn::{DatalogInput, DayBound, PageId, PageName, Query, ground_ids};

/// The journal pages whose day falls in a range, inclusive, as full pulls.
pub fn journal_pages_in_range(start: i64, end: i64) -> Query {
    let (start, end) = (DayBound::new(start), DayBound::new(end));
    Query {
        text: "[:find (pull ?page [*]) :in $ ?start ?end :where [?page :block/name] [?page :block/journal-day ?day] \
               [(>= ?day ?start)] [(<= ?day ?end)]]"
            .to_owned(),
        inputs: vec![DatalogInput::DayBound(start), DatalogInput::DayBound(end)],
    }
}

/// Every block on the journal pages in a range, flat (the caller rebuilds the tree from
/// `:block/parent` and `:block/left`). Each block's `refs` come back as the referenced pages' own
/// maps (`id`, `name`, `original-name`, `journal?`, `journal-day` when set) instead of bare `{id}`,
/// so the roll-up of top concepts needs no further call. A ref to a block has no `name`.
pub fn journal_blocks_in_range(start: i64, end: i64) -> Query {
    let (start, end) = (DayBound::new(start), DayBound::new(end));
    Query {
        text: "[:find (pull ?block [* {:block/refs [:db/id :block/name :block/original-name :block/journal? :block/journal-day]}]) \
               :in $ ?start ?end :where [?page :block/name] [?page :block/journal-day ?day] \
               [(>= ?day ?start)] [(<= ?day ?end)] [?block :block/page ?page]]"
            .to_owned(),
        inputs: vec![DatalogInput::DayBound(start), DatalogInput::DayBound(end)],
    }
}

/// What the mentions query pulls of each block: its page whole, so a mention says where it is, and each ref as the
/// referenced page's own map (the same fields as the journal blocks), so the roll-up of top concepts needs no further
/// call.
const MENTION_PULL: &str = "(pull ?block [:db/id :block/uuid :block/content :block/marker :block/properties :block/format {:block/page [*]} \
     {:block/refs [:db/id :block/name :block/original-name :block/journal? :block/journal-day]}])";

/// Every block that references the page named `name` (`[[Topic]]`, `#topic`, `#[[multi word]]` and
/// uuid-style refs all count, in any casing; plain text that merely contains the name does not).
pub fn blocks_referencing_page(name: &PageName) -> Query {
    Query {
        text: format!("[:find {MENTION_PULL} :in $ ?page-name :where [?page :block/name ?page-name] [?block :block/refs ?page]]"),
        inputs: vec![DatalogInput::PageName(name.clone())],
    }
}

/// Every block that references any page of an alias group, plus every block on `own_pages` (the
/// group's other pages; the page asked about comes from its own block tree). Matching is on
/// `:block/refs`, and a block that matches twice (it references two names of the group) is one row.
pub fn blocks_referencing_pages(ref_pages: &[PageId], own_pages: &[PageId]) -> Query {
    assert!(!ref_pages.is_empty(), "getBlocksReferencingPages needs at least one page id");
    let ref_branch = format!("{} [?block :block/refs ?ref]", ground_ids(ref_pages, "?ref"));
    let text = if own_pages.is_empty() {
        format!("[:find {MENTION_PULL} :where {ref_branch}]")
    } else {
        format!(
            "[:find {MENTION_PULL} :where (or-join [?block] (and {ref_branch}) (and {} [?block :block/page ?own]))]",
            ground_ids(own_pages, "?own")
        )
    };
    Query { text, inputs: Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: i64) -> PageId {
        PageId::new(n).unwrap()
    }

    #[test]
    fn the_range_queries_bind_both_bounds_and_embed_no_value() {
        for query in [journal_pages_in_range(20250101, 20250107), journal_blocks_in_range(20250101, 20250107)] {
            assert!(query.text.contains(":in $ ?start ?end :where [?page :block/name] [?page :block/journal-day ?day]"));
            assert!(!query.text.contains("2025"));
            let inputs: Vec<String> = query.inputs.iter().map(DatalogInput::to_edn).collect();
            assert_eq!(inputs, ["20250101", "20250107"]);
        }
    }

    #[test]
    fn a_day_that_is_no_real_date_is_still_a_bound() {
        // the tool accepts day 31 of any month, so the query has to carry it
        let inputs: Vec<String> = journal_pages_in_range(20250231, 20250231).inputs.iter().map(DatalogInput::to_edn).collect();
        assert_eq!(inputs, ["20250231", "20250231"]);
    }

    #[test]
    fn a_page_s_mentions_are_asked_for_by_its_lowercased_name_bound_with_in() {
        let query = blocks_referencing_page(&PageName::new("Project Atlas"));
        assert_eq!(query.inputs, vec![DatalogInput::PageName(PageName::new("project atlas"))]);
        assert_eq!(query.inputs[0].to_edn(), "\"project atlas\"");
        assert!(!query.text.contains("atlas"), "no string is embedded in the text");
        assert!(query.text.ends_with(":in $ ?page-name :where [?page :block/name ?page-name] [?block :block/refs ?page]]"));
    }

    #[test]
    fn a_mention_is_pulled_with_its_page_whole_and_each_ref_as_a_page_map() {
        let query = blocks_referencing_page(&PageName::new("x"));
        assert!(query.text.starts_with(
            "[:find (pull ?block [:db/id :block/uuid :block/content :block/marker :block/properties :block/format {:block/page [*]} \
             {:block/refs [:db/id :block/name :block/original-name :block/journal? :block/journal-day]}])"
        ));
    }

    #[test]
    fn a_group_s_mentions_embed_only_ids_and_add_the_other_pages_own_blocks() {
        let query = blocks_referencing_pages(&[id(10), id(11)], &[id(11)]);
        assert!(query.inputs.is_empty());
        assert!(query.text.ends_with(
            ":where (or-join [?block] (and [(ground [10 11]) [?ref ...]] [?block :block/refs ?ref]) \
             (and [(ground [11]) [?own ...]] [?block :block/page ?own]))]"
        ));
    }

    #[test]
    fn with_no_other_pages_it_is_the_references_alone() {
        let query = blocks_referencing_pages(&[id(10)], &[]);
        assert!(query.text.ends_with(":where [(ground [10]) [?ref ...]] [?block :block/refs ?ref]]"));
        assert!(!query.text.contains("or-join"));
    }
}
