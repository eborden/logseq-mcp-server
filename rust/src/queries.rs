//! The Datalog queries the page outline makes (the Rust side of the builders in
//! `src/datalog/queries.ts`). Every string is bound with `:in` (ADR-0013) and only the page's
//! `:db/id` is embedded, through [`ground_ids`], which takes a [`PageId`] and not a number.
//!
//! The text is the TypeScript text with its whitespace collapsed; LogSeq doesn't care how a query
//! is laid out and the parity harness compares it collapsed.

use crate::edn::{DatalogInput, JournalDay, PageId, PageName, ground_ids};

/// A query and the inputs bound to its `:in` variables, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    pub text: String,
    pub inputs: Vec<DatalogInput>,
}

/// The resolver's first query, which covers three routes at once. Each row is `[page, via]`:
/// - `"name"`: the page whose `:block/name` is the name;
/// - `"alias"`: a page whose `:block/alias` points at the page named so (the one named so is the
///   alias target, which LogSeq creates as a bare stub);
/// - `"journal-date"` (only with a `journal_day`): the journal page for that day.
///   `[?page :block/name]` is required, or blocks LogSeq created in the app on a journal page
///   match as pages, since they carry `:block/journal-day` too (#140).
pub fn resolve_page(name: &PageName, journal_day: Option<JournalDay>) -> Query {
    let name_input = DatalogInput::PageName(name.clone());
    match journal_day {
        None => Query {
            text: "[:find (pull ?page [*]) ?via :in $ ?n :where (or-join [?n ?page ?via] \
                   (and [?page :block/name ?n] [(ground \"name\") ?via]) \
                   (and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground \"alias\") ?via]))]"
                .to_owned(),
            inputs: vec![name_input],
        },
        Some(day) => Query {
            text: "[:find (pull ?page [*]) ?via :in $ ?n ?day :where (or-join [?n ?day ?page ?via] \
                   (and [?page :block/name ?n] [(ground \"name\") ?via]) \
                   (and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground \"alias\") ?via]) \
                   (and [?page :block/name] [?page :block/journal-day ?day] [(ground \"journal-date\") ?via]))]"
                .to_owned(),
            inputs: vec![name_input, DatalogInput::JournalDay(day)],
        },
    }
}

/// Namespace pages whose last segment is `leaf` (`projects/atlas` for `atlas`).
/// `ends-with?` works in LogSeq's Datalog.
pub fn namespace_leaf_pages(leaf: &PageName) -> Query {
    Query {
        text: "[:find (pull ?page [*]) :in $ ?suffix :where [?page :block/name ?n] [?page :block/namespace] \
               [(clojure.string/ends-with? ?n ?suffix)]]"
            .to_owned(),
        inputs: vec![DatalogInput::LeafSuffix(leaf.clone())],
    }
}

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
    fn the_resolver_binds_the_lowercased_name_and_the_day() {
        let plain = resolve_page(&PageName::new("Project Atlas"), None);
        assert_eq!(plain.inputs, vec![DatalogInput::PageName(PageName::new("project atlas"))]);
        assert!(plain.text.contains(":in $ ?n :where"));
        assert!(!plain.text.contains("project"), "no string is embedded in the text");
        let dated = resolve_page(&PageName::new("2025-01-01"), Some(JournalDay::parse(20250101_u32).unwrap()));
        assert_eq!(dated.inputs[1].to_edn(), "20250101");
        assert!(dated.text.contains(":in $ ?n ?day"));
    }

    #[test]
    fn the_leaf_suffix_is_bound_not_embedded() {
        let query = namespace_leaf_pages(&PageName::new("Retro"));
        assert_eq!(query.inputs[0].to_edn(), "\"/retro\"");
        assert!(!query.text.contains("retro"));
    }

    #[test]
    fn the_outline_embeds_only_the_page_id() {
        let query = page_outline_blocks(PageId::new(10).unwrap());
        assert!(query.inputs.is_empty());
        assert!(query.text.contains(":where [(ground [10]) [?page ...]] [?page :block/name] (or-join [?page ?b]"));
    }
}
