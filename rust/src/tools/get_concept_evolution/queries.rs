//! The Datalog queries only `get_concept_evolution` makes (`getBlocksReferencingPage` and
//! `getBlocksReferencingPages` in `src/datalog/queries.ts`). A page name is bound with `:in`
//! (ADR-0013); the ids of an alias group are embedded through [`ground_ids`], which takes
//! [`PageId`]s and not numbers.

use crate::edn::{DatalogInput, PageId, PageName, Query, ground_ids};

/// What the mentions query pulls of each block: its page whole, so a mention says where it is.
const PULL: &str =
    "(pull ?block [:db/id :block/uuid :block/content :block/marker :block/properties :block/format {:block/page [*]}])";

/// Every block that references the page named `name` (`[[Topic]]`, `#topic`, `#[[multi word]]` and
/// uuid-style refs all count, in any casing; plain text that merely contains the name does not).
pub fn blocks_referencing_page(name: &PageName) -> Query {
    Query {
        text: format!("[:find {PULL} :in $ ?page-name :where [?page :block/name ?page-name] [?block :block/refs ?page]]"),
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
        format!("[:find {PULL} :where {ref_branch}]")
    } else {
        format!(
            "[:find {PULL} :where (or-join [?block] (and {ref_branch}) (and {} [?block :block/page ?own]))]",
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
    fn a_page_s_mentions_are_asked_for_by_its_lowercased_name_bound_with_in() {
        let query = blocks_referencing_page(&PageName::new("Project Atlas"));
        assert_eq!(query.inputs, vec![DatalogInput::PageName(PageName::new("project atlas"))]);
        assert_eq!(query.inputs[0].to_edn(), "\"project atlas\"");
        assert!(!query.text.contains("atlas"), "no string is embedded in the text");
        assert!(query.text.ends_with(":in $ ?page-name :where [?page :block/name ?page-name] [?block :block/refs ?page]]"));
    }

    #[test]
    fn a_group_s_mentions_embed_only_ids_and_add_the_other_pages_own_blocks() {
        let query = blocks_referencing_pages(&[id(10), id(11)], &[id(11)]);
        assert!(query.inputs.is_empty());
        assert_eq!(
            query.text,
            "[:find (pull ?block [:db/id :block/uuid :block/content :block/marker :block/properties :block/format {:block/page [*]}]) \
             :where (or-join [?block] (and [(ground [10 11]) [?ref ...]] [?block :block/refs ?ref]) \
             (and [(ground [11]) [?own ...]] [?block :block/page ?own]))]"
        );
    }

    #[test]
    fn with_no_other_pages_it_is_the_references_alone() {
        let query = blocks_referencing_pages(&[id(10)], &[]);
        assert!(query.text.ends_with(":where [(ground [10]) [?ref ...]] [?block :block/refs ?ref]]"));
        assert!(!query.text.contains("or-join"));
    }
}
