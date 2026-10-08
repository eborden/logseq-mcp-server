//! The Datalog queries of the page resolver (the Rust side of `resolvePage` and
//! `namespaceLeafPages` in `src/datalog/queries.ts`). Every string is bound with `:in`
//! (ADR-0013), so no page name is part of the query text.
//!
//! The text is the TypeScript text with its whitespace collapsed; LogSeq doesn't care how a query
//! is laid out and the parity harness compares it collapsed.

use crate::edn::{DatalogInput, JournalDay, PageId, PageName, Query, ground_ids};

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

/// The name and alias routes of [`resolve_page`] for many names at once (`linkTargets`, #146), as
/// `[page, via, name]` rows: `via` is `"name"` for the page with that `:block/name`, `"alias"` for a page
/// whose `:block/alias` points at it. The name rides along so each row can be matched to the term it
/// answers. The names go in as one string collection (`:in $ [?n ...]`), never as query text, and are
/// lowercase by construction. `:block/file` is pulled so a file-less stub can be told from a written page.
pub fn link_targets(names: &[PageName]) -> Query {
    assert!(!names.is_empty(), "linkTargets needs at least one page name");
    Query {
        text: "[:find (pull ?page [:db/id :block/name :block/original-name :block/file]) ?via ?n :in $ [?n ...] :where \
               (or-join [?n ?page ?via] \
               (and [?page :block/name ?n] [(ground \"name\") ?via]) \
               (and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground \"alias\") ?via]))]"
            .to_owned(),
        inputs: vec![DatalogInput::PageNames(names.to_vec())],
    }
}

/// One alias link between two pages, followed in either direction (`aliasHop`).
fn alias_hop(from: &str, to: &str) -> String {
    format!("(or-join [{from} {to}] [{from} :block/alias {to}] [{to} :block/alias {from}])")
}

/// Every page within two alias links (`ALIAS_MAX_HOPS`) of `start`, in either direction
/// (`aliasClosure`). `start` itself comes back too (a link and its mirror form a cycle), so the
/// caller de-duplicates. The two hops are unrolled because rules can't be passed, and a third
/// hop turns a 7-page group into a ~0.4s query.
fn alias_closure(start: &str, member: &str) -> String {
    format!(
        "(or-join [{start} {member}] {} (and {} {}))",
        alias_hop(start, member),
        alias_hop(start, "?alias-mid"),
        alias_hop("?alias-mid", member)
    )
}

/// The alias groups of several pages in one query (`aliasSets`): rows are `[startId, member]`,
/// one per page in the start page's group, the start page itself included whenever it has an
/// alias at all. A page with no aliases has no rows. The ids are embedded through [`ground_ids`].
pub fn alias_sets(starts: &[PageId]) -> Query {
    assert!(!starts.is_empty(), "aliasSets needs at least one page id");
    Query {
        text: format!(
            "[:find ?start (pull ?m [:db/id :block/name :block/original-name]) :where {} {}]",
            ground_ids(starts, "?start"),
            alias_closure("?start", "?m")
        ),
        inputs: Vec::new(),
    }
}

/// The alias group of a page known only by name (`aliasSetByName`): rows are `[startPage, member]`
/// with both sides pulled, one per page in the group, the start page included whenever it has an
/// alias at all. No rows when no page has the name or the page has no aliases, so a name that is not
/// a page costs nothing and changes nothing. The name is bound, lowercase by construction.
pub fn alias_set_by_name(name: &PageName) -> Query {
    Query {
        text: format!(
            "[:find (pull ?s [:db/id :block/name :block/original-name]) (pull ?m [:db/id :block/name :block/original-name]) \
             :in $ ?page-name :where [?s :block/name ?page-name] {}]",
            alias_closure("?s", "?m")
        ),
        inputs: vec![DatalogInput::PageName(name.clone())],
    }
}

/// The linked references of a whole alias group (`linkedReferencesOfPages`), the way
/// `logseq.Editor.getPageLinkedReferences` counts them for one page: blocks whose
/// `:block/path-refs` hold any of the pages (so children of a block that links the page count),
/// except blocks that sit on one of the pages themselves. Rows are `[block]`, with the block's
/// page pulled as `{id, name, original-name, journal-day}`, the keys the Editor call gives a
/// source page.
pub fn linked_references_of_pages(pages: &[PageId]) -> Query {
    assert!(!pages.is_empty(), "linkedReferencesOfPages needs at least one page id");
    Query {
        text: format!(
            "[:find (pull ?block [* {{:block/page [:db/id :block/name :block/original-name :block/journal-day]}}]) \
             :where {} [?block :block/path-refs ?p] [?block :block/page ?source] (not {})]",
            ground_ids(pages, "?p"),
            ground_ids(pages, "?source")
        ),
        inputs: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_alias_sets_query_embeds_only_the_ids_and_unrolls_two_hops() {
        let query = alias_sets(&[PageId::new(10).unwrap(), PageId::new(11).unwrap()]);
        assert!(query.inputs.is_empty());
        assert_eq!(
            query.text,
            "[:find ?start (pull ?m [:db/id :block/name :block/original-name]) :where [(ground [10 11]) [?start ...]] \
             (or-join [?start ?m] (or-join [?start ?m] [?start :block/alias ?m] [?m :block/alias ?start]) \
             (and (or-join [?start ?alias-mid] [?start :block/alias ?alias-mid] [?alias-mid :block/alias ?start]) \
             (or-join [?alias-mid ?m] [?alias-mid :block/alias ?m] [?m :block/alias ?alias-mid])))]"
        );
    }

    #[test]
    fn the_alias_group_by_name_binds_the_lowercased_name() {
        let query = alias_set_by_name(&PageName::new("Project Atlas"));
        assert_eq!(query.inputs, vec![DatalogInput::PageName(PageName::new("project atlas"))]);
        assert!(!query.text.contains("atlas"), "no string is embedded in the text");
        assert_eq!(
            query.text,
            "[:find (pull ?s [:db/id :block/name :block/original-name]) (pull ?m [:db/id :block/name :block/original-name]) \
             :in $ ?page-name :where [?s :block/name ?page-name] \
             (or-join [?s ?m] (or-join [?s ?m] [?s :block/alias ?m] [?m :block/alias ?s]) \
             (and (or-join [?s ?alias-mid] [?s :block/alias ?alias-mid] [?alias-mid :block/alias ?s]) \
             (or-join [?alias-mid ?m] [?alias-mid :block/alias ?m] [?m :block/alias ?alias-mid])))]"
        );
    }

    #[test]
    fn linked_references_exclude_the_group_s_own_blocks() {
        let query = linked_references_of_pages(&[PageId::new(3).unwrap(), PageId::new(4).unwrap()]);
        assert!(query.inputs.is_empty());
        assert!(query.text.contains(":where [(ground [3 4]) [?p ...]] [?block :block/path-refs ?p]"));
        assert!(query.text.ends_with("(not [(ground [3 4]) [?source ...]])]"));
    }

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
    fn the_link_targets_bind_the_names_as_one_collection() {
        let query = link_targets(&[PageName::new("Alice"), PageName::new("Project \"Atlas\"")]);
        assert_eq!(query.inputs, vec![DatalogInput::PageNames(vec![PageName::new("alice"), PageName::new("project \"atlas\"")])]);
        assert_eq!(query.inputs[0].to_edn(), r#"["alice","project \"atlas\""]"#);
        assert!(!query.text.contains("alice"), "no name is embedded in the text");
        assert!(query.text.contains(":in $ [?n ...] :where"));
    }

    #[test]
    fn the_leaf_suffix_is_bound_not_embedded() {
        let query = namespace_leaf_pages(&PageName::new("Retro"));
        assert_eq!(query.inputs[0].to_edn(), "\"/retro\"");
        assert!(!query.text.contains("retro"));
    }
}
