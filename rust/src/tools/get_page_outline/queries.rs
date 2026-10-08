//! The one Datalog query only the page outline makes (`pageOutlineBlocks` in
//! `src/datalog/queries.ts`). Only the page's `:db/id` is embedded, through [`ground_ids`], which
//! takes a [`PageId`] and not a number.

use crate::edn::{PageId, Query, ground_ids};

/// A page's outline in one query: its top-level blocks and the direct children of those blocks.
/// The caller counts the children per parent, so the outline needs no query per block. A row is
/// a top-level block when its `parent` is the page, and a child otherwise. Only the fields the
/// outline reads are pulled; the page is bound by id, so no name is embedded.
pub fn page_outline_blocks(page: PageId) -> Query {
    Query {
        text: format!(
            "[:find (pull ?b [:db/id :block/uuid :block/content :block/left :block/parent]) :where {} \
             [?page :block/name] (or-join [?page ?b] \
             (and [?b :block/parent ?page] [?b :block/page ?page]) \
             (and [?top :block/parent ?page] [?b :block/parent ?top]))]",
            ground_ids(&[page], "?page")
        ),
        inputs: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_outline_embeds_only_the_page_id() {
        let query = page_outline_blocks(PageId::new(10).unwrap());
        assert!(query.inputs.is_empty());
        assert!(query.text.contains(":where [(ground [10]) [?page ...]] [?page :block/name] (or-join [?page ?b]"));
    }
}
