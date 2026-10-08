//! The Datalog queries only the relationship search makes (`blocksOnPageReferencing`,
//! `blocksReferencingInPagesLinking`, their alias-group forms and `neighborPages` in
//! `src/datalog/queries.ts`), and the outbound pair for `referenced-by`, which the TypeScript server never had (#299). A page name is bound with `:in` (ADR-0013), lowercase by
//! construction; page ids are embedded through `ground_ids`, which takes only a valid [`PageId`].
//!
//! The text is the TypeScript text with its whitespace collapsed; LogSeq doesn't care how a query
//! is laid out and the parity harness compares it collapsed.

use crate::edn::{DatalogInput, PageId, PageName, Query, ground_ids};
use crate::errors::ToolError;

/// Blocks on one page that reference another. Matching is on `:block/refs`, so `[[Topic]]`,
/// `#topic`, `#[[multi word]]` and uuid-style refs all count, in any casing, and plain text that
/// merely contains the name does not.
pub fn blocks_on_page_referencing(page: &PageName, reference: &PageName) -> Query {
    Query {
        text: "[:find (pull ?block [*]) :in $ ?page-name ?ref-name :where [?page :block/name ?page-name] \
               [?ref :block/name ?ref-name] [?block :block/page ?page] [?block :block/refs ?ref]]"
            .to_owned(),
        inputs: vec![DatalogInput::PageName(page.clone()), DatalogInput::PageName(reference.clone())],
    }
}

/// Blocks that reference topic A, restricted to pages that also contain a block referencing topic B.
/// Both matches are on `:block/refs`, so casing and tag/link syntax do not matter.
pub fn blocks_referencing_in_pages_linking(a: &PageName, b: &PageName) -> Query {
    Query {
        text: "[:find (pull ?block [*]) :in $ ?a-name ?b-name :where [?a :block/name ?a-name] [?b :block/name ?b-name] \
               [?linker :block/refs ?b] [?linker :block/page ?page] [?block :block/page ?page] [?block :block/refs ?a]]"
            .to_owned(),
        inputs: vec![DatalogInput::PageName(a.clone()), DatalogInput::PageName(b.clone())],
    }
}

/// Blocks that reference topic A, restricted to pages that topic B's page references: the outbound
/// reading, for `referenced-by` ("blocks about A in pages referenced by B"). It is
/// [`blocks_referencing_in_pages_linking`] with the link followed the other way: a block on B's page
/// references `?page`, where the inbound query has a block on `?page` referencing B.
pub fn blocks_referencing_in_pages_referenced_by(a: &PageName, b: &PageName) -> Query {
    Query {
        text: "[:find (pull ?block [*]) :in $ ?a-name ?b-name :where [?a :block/name ?a-name] [?b :block/name ?b-name] \
               [?source :block/page ?b] [?source :block/refs ?page] [?block :block/page ?page] [?block :block/refs ?a]]"
            .to_owned(),
        inputs: vec![DatalogInput::PageName(a.clone()), DatalogInput::PageName(b.clone())],
    }
}

/// `assertNonEmptyIds`: a list with no page id can't be queried.
fn assert_non_empty(method: &str, lists: &[&[PageId]]) -> Result<(), ToolError> {
    if lists.iter().any(|list| list.is_empty()) {
        return Err(ToolError::Failed(format!("{method} needs at least one page id in each list")));
    }
    Ok(())
}

/// [`blocks_on_page_referencing`] across alias groups: blocks on any of `pages` whose `:block/refs`
/// include any of `refs`. A block that references two names of the group is one row.
pub fn blocks_on_pages_referencing_ids(pages: &[PageId], refs: &[PageId]) -> Result<Query, ToolError> {
    assert_non_empty("blocksOnPagesReferencingIds", &[pages, refs])?;
    Ok(Query {
        text: format!(
            "[:find (pull ?block [*]) :where {} {} [?block :block/page ?page] [?block :block/refs ?ref]]",
            ground_ids(pages, "?page"),
            ground_ids(refs, "?ref")
        ),
        inputs: Vec::new(),
    })
}

/// [`blocks_referencing_in_pages_linking`] across alias groups: blocks that reference any of `a`,
/// on pages where some block references any of `b`.
pub fn blocks_referencing_in_pages_linking_ids(a: &[PageId], b: &[PageId]) -> Result<Query, ToolError> {
    assert_non_empty("blocksReferencingInPagesLinkingIds", &[a, b])?;
    Ok(Query {
        text: format!(
            "[:find (pull ?block [*]) :where {} {} [?linker :block/refs ?b] [?linker :block/page ?page] \
             [?block :block/page ?page] [?block :block/refs ?a]]",
            ground_ids(a, "?a"),
            ground_ids(b, "?b")
        ),
        inputs: Vec::new(),
    })
}

/// [`blocks_referencing_in_pages_referenced_by`] across alias groups: blocks that reference any of
/// `a`, on pages that some block on any of `b` references.
pub fn blocks_referencing_in_pages_referenced_by_ids(a: &[PageId], b: &[PageId]) -> Result<Query, ToolError> {
    assert_non_empty("blocksReferencingInPagesReferencedByIds", &[a, b])?;
    Ok(Query {
        text: format!(
            "[:find (pull ?block [*]) :where {} {} [?source :block/page ?b] [?source :block/refs ?page] \
             [?block :block/page ?page] [?block :block/refs ?a]]",
            ground_ids(a, "?a"),
            ground_ids(b, "?b")
        ),
        inputs: Vec::new(),
    })
}

/// The pages one reference hop away from a set of pages, in both directions (pages they reference
/// and pages that reference them). One query covers a whole BFS frontier.
pub fn neighbor_pages(pages: &[PageId]) -> Query {
    Query {
        text: format!(
            "[:find ?neighbor :where {} (or-join [?p ?neighbor] \
             (and [?block :block/page ?p] [?block :block/refs ?neighbor] [?neighbor :block/name]) \
             (and [?block :block/refs ?p] [?block :block/page ?neighbor] [?neighbor :block/name]))]",
            ground_ids(pages, "?p")
        ),
        inputs: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(ids: &[i64]) -> Vec<PageId> {
        ids.iter().map(|&id| PageId::new(id).unwrap()).collect()
    }

    #[test]
    fn page_names_are_bound_lowercase_and_never_embedded() {
        let query = blocks_on_page_referencing(&PageName::new("Project Atlas"), &PageName::new("Bob"));
        assert_eq!(query.inputs[0].to_edn(), "\"project atlas\"");
        assert_eq!(query.inputs[1].to_edn(), "\"bob\"");
        assert!(!query.text.contains("atlas") && !query.text.contains("bob"));
        let linking = blocks_referencing_in_pages_linking(&PageName::new("A \"x\""), &PageName::new("B"));
        assert_eq!(linking.inputs[0].to_edn(), r#""a \"x\"""#);
        assert!(linking.text.starts_with("[:find (pull ?block [*]) :in $ ?a-name ?b-name :where"));
    }

    #[test]
    fn the_group_forms_embed_only_ids() {
        let query = blocks_on_pages_referencing_ids(&ids(&[1, 2]), &ids(&[3])).unwrap();
        assert!(query.inputs.is_empty());
        assert_eq!(
            query.text,
            "[:find (pull ?block [*]) :where [(ground [1 2]) [?page ...]] [(ground [3]) [?ref ...]] \
             [?block :block/page ?page] [?block :block/refs ?ref]]"
        );
        let linking = blocks_referencing_in_pages_linking_ids(&ids(&[4]), &ids(&[5, 6])).unwrap();
        assert!(linking.text.contains(":where [(ground [4]) [?a ...]] [(ground [5 6]) [?b ...]] [?linker :block/refs ?b]"));
    }

    #[test]
    fn the_outbound_query_follows_the_link_from_topic_bs_page_and_binds_names_with_in() {
        let query = blocks_referencing_in_pages_referenced_by(&PageName::new("Project Atlas"), &PageName::new("Bob"));
        assert_eq!(query.inputs[0].to_edn(), "\"project atlas\"");
        assert_eq!(query.inputs[1].to_edn(), "\"bob\"");
        assert!(!query.text.contains("atlas") && !query.text.contains("bob"));
        assert_eq!(
            query.text,
            "[:find (pull ?block [*]) :in $ ?a-name ?b-name :where [?a :block/name ?a-name] [?b :block/name ?b-name] \
             [?source :block/page ?b] [?source :block/refs ?page] [?block :block/page ?page] [?block :block/refs ?a]]"
        );
        // Not the inbound reading: no block on the linked page references B
        assert_ne!(query.text, blocks_referencing_in_pages_linking(&PageName::new("Project Atlas"), &PageName::new("Bob")).text);
    }

    #[test]
    fn the_outbound_group_form_embeds_only_ids() {
        let query = blocks_referencing_in_pages_referenced_by_ids(&ids(&[4]), &ids(&[5, 6])).unwrap();
        assert!(query.inputs.is_empty());
        assert_eq!(
            query.text,
            "[:find (pull ?block [*]) :where [(ground [4]) [?a ...]] [(ground [5 6]) [?b ...]] [?source :block/page ?b] \
             [?source :block/refs ?page] [?block :block/page ?page] [?block :block/refs ?a]]"
        );
        let error = blocks_referencing_in_pages_referenced_by_ids(&[], &ids(&[3])).unwrap_err();
        assert_eq!(error.to_string(), "blocksReferencingInPagesReferencedByIds needs at least one page id in each list");
    }

    #[test]
    fn an_empty_id_list_is_refused_before_any_call() {
        let error = blocks_on_pages_referencing_ids(&[], &ids(&[3])).unwrap_err();
        assert_eq!(error.to_string(), "blocksOnPagesReferencingIds needs at least one page id in each list");
        let error = blocks_referencing_in_pages_linking_ids(&ids(&[3]), &[]).unwrap_err();
        assert_eq!(error.to_string(), "blocksReferencingInPagesLinkingIds needs at least one page id in each list");
    }

    #[test]
    fn the_neighbour_query_covers_both_directions_of_a_frontier() {
        let query = neighbor_pages(&ids(&[7, 8]));
        assert!(query.inputs.is_empty());
        assert_eq!(
            query.text,
            "[:find ?neighbor :where [(ground [7 8]) [?p ...]] (or-join [?p ?neighbor] \
             (and [?block :block/page ?p] [?block :block/refs ?neighbor] [?neighbor :block/name]) \
             (and [?block :block/refs ?p] [?block :block/page ?neighbor] [?neighbor :block/name]))]"
        );
    }
}
