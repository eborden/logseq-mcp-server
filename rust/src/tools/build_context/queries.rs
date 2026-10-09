//! The Datalog queries only `build_context` makes. The page name is bound with `:in` (ADR-0013); the ids of an alias
//! group are embedded through [`ground_ids`], which takes [`PageId`]s and not numbers.

use crate::edn::{DatalogInput, PageId, PageName, Query, ground_ids};

/// Every block of the page named `name`, flat, each pulled whole. The name is lowercased by
/// [`PageName`], so any casing finds the page (constraint 5).
pub fn get_page_blocks(name: &PageName) -> Query {
    Query {
        text: "[:find (pull ?block [*]) :in $ ?page-name :where [?page :block/name ?page-name] [?block :block/page ?page]]".to_owned(),
        inputs: vec![DatalogInput::PageName(name.clone())],
    }
}

/// Every block of every page in an alias group, flat, each pulled whole. The ids are bound straight
/// to the page variable, as constraint 6 asks.
pub fn get_blocks_on_pages(pages: &[PageId]) -> Query {
    assert!(!pages.is_empty(), "getBlocksOnPages needs at least one page id");
    Query { text: format!("[:find (pull ?block [*]) :where {} [?block :block/page ?page]]", ground_ids(pages, "?page")), inputs: Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_s_blocks_are_asked_for_by_its_lowercased_name_bound_with_in() {
        let query = get_page_blocks(&PageName::new("Project Atlas"));
        assert_eq!(query.inputs, vec![DatalogInput::PageName(PageName::new("project atlas"))]);
        assert_eq!(query.inputs[0].to_edn(), "\"project atlas\"");
        assert!(!query.text.contains("atlas"), "no string is embedded in the text");
    }

    #[test]
    fn a_group_s_blocks_are_asked_for_by_page_id_with_nothing_bound() {
        let query = get_blocks_on_pages(&[PageId::new(10).unwrap(), PageId::new(11).unwrap()]);
        assert!(query.inputs.is_empty());
        assert_eq!(
            query.text,
            "[:find (pull ?block [*]) :where [(ground [10 11]) [?page ...]] [?block :block/page ?page]]"
        );
    }
}
