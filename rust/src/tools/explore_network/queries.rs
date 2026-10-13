//! The Datalog queries only `explore_network` makes. The frontier's ids are embedded, bound
//! straight to the entity variable (constraint 6): [`PageId`] makes sure each is a real id, and no
//! string is part of either query.

use crate::edn::{PageId, Query, ground_ids};

/// What a depth's query asks for beyond the pairs it always returns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Extras {
    /// One more row per pair, `"degree"`: how many pages the connected page links (the roll-up rule, #498). The counts
    /// become `count-distinct`, since the extra join repeats a block.
    pub degree: bool,
    /// One more cell per row: the text of one linking block of the pair (`min` of the blocks' content), `""` on a
    /// `"degree"` row (#498)
    pub snippets: bool,
}

/// The start of a query: the cells of a row, the count, and the snippet when it is asked for.
fn find(extras: Extras, source: &str, count: &str) -> String {
    let snippet = if extras.snippets { " (min ?content)" } else { "" };
    format!("[:find {source} ?connected ?name ?original-name ?journal ?rel-type ({count} ?block){snippet} ")
}

/// The two branches that make the `"degree"` rows: for each pair, the pages the connected page links, as `?block` (a
/// row's `?block` is a page here, so its distinct count is the number of pages). A page that links nothing makes no
/// row, which reads as 0 (an `or-join` with `ground nil` would drop the row, constraint 3). Only pages count: a
/// `((uuid))` ref is a block, and a page's link to itself is no link out. Both directions of the pair are covered, as
/// they are for the links.
const DEGREE_BRANCHES: &str = " \
     (and [?b1 :block/page ?source] [?b1 :block/refs ?connected] [?o :block/page ?connected] [?o :block/refs ?block] \
     [?block :block/name] [(not= ?block ?connected)] [(ground \"degree\") ?rel-type]) \
     (and [?b1 :block/refs ?source] [?b1 :block/page ?connected] [?o :block/page ?connected] [?o :block/refs ?block] \
     [?block :block/name] [(not= ?block ?connected)] [(ground \"degree\") ?rel-type])";

/// The block's text, for the snippet. A page (the `?block` of a `"degree"` row) has none, and reads as `""`.
const SNIPPET_CLAUSE: &str = " [(get-else $ ?block :block/content \"\") ?content]";

/// The pages linked to or from every page of `frontier`, in both directions, one row per page pair
/// and direction: `[source, connected, name, original-name, journal?, "outbound" | "inbound",
/// count]`. When two frontier pages link to each other the same links come back once from each
/// side, so the caller sets (never adds) a pair's count. With [`Extras`] there is a `"degree"` row per pair, and a
/// snippet cell on every row.
///
/// The text keeps two `;;` comments. A comment runs to the end of its line,
/// so each is followed by a real newline and can't swallow the clauses after it.
pub fn connected_pages(frontier: &[PageId], extras: Extras) -> Query {
    assert!(!frontier.is_empty(), "connectedPages needs at least one frontier id");
    let count = if extras.degree { "count-distinct" } else { "count" };
    let degree = if extras.degree { DEGREE_BRANCHES } else { "" };
    let snippet = if extras.snippets { SNIPPET_CLAUSE } else { "" };
    Query {
        text: format!(
            "{}:where {} \
             [?source :block/name] \
             (or-join [?source ?connected ?block ?rel-type] \
             ;; Outbound: blocks on the source page that reference other pages\n\
             (and [?block :block/page ?source] [?block :block/refs ?connected] [(ground \"outbound\") ?rel-type]) \
             ;; Inbound: blocks on other pages that reference the source\n\
             (and [?block :block/refs ?source] [?block :block/page ?connected] [(ground \"inbound\") ?rel-type]){degree}) \
             [?connected :block/name ?name] \
             [(not= ?source ?connected)] \
             [(get-else $ ?connected :block/original-name \"\") ?original-name] \
             [(get-else $ ?connected :block/journal? false) ?journal]{snippet}]",
            find(extras, "?source", count),
            ground_ids(frontier, "?source")
        ),
        inputs: Vec::new(),
    }
}

/// Like [`connected_pages`] for a frontier in which several pages stand for one: each `(id, group)`
/// pair folds the page `id` into the page `group` (an alias group is folded into its first page).
/// Rows have the same shape with the group's id as the source, and each count is the number of
/// distinct blocks across the whole group, so a block that links two names of the group counts once.
pub fn connected_pages_grouped(pairs: &[(PageId, PageId)], extras: Extras) -> Query {
    assert!(!pairs.is_empty(), "connectedPagesGrouped needs at least one frontier id");
    let pairs: Vec<String> = pairs.iter().map(|(id, group)| format!("[{} {}]", id.get(), group.get())).collect();
    let degree = if extras.degree { DEGREE_BRANCHES } else { "" };
    let snippet = if extras.snippets { SNIPPET_CLAUSE } else { "" };
    Query {
        text: format!(
            "{}:where [(ground [{}]) [[?source ?group] ...]] \
             [?source :block/name] \
             (or-join [?source ?connected ?block ?rel-type] \
             (and [?block :block/page ?source] [?block :block/refs ?connected] [(ground \"outbound\") ?rel-type]) \
             (and [?block :block/refs ?source] [?block :block/page ?connected] [(ground \"inbound\") ?rel-type]){degree}) \
             [?connected :block/name ?name] \
             [(not= ?group ?connected)] \
             [(get-else $ ?connected :block/original-name \"\") ?original-name] \
             [(get-else $ ?connected :block/journal? false) ?journal]{snippet}]",
            find(extras, "?group", "count-distinct"),
            pairs.join(" ")
        ),
        inputs: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: i64) -> PageId {
        PageId::new(n).unwrap()
    }

    const PLAIN: Extras = Extras { degree: false, snippets: false };
    const DEGREE: Extras = Extras { degree: true, snippets: false };
    const BOTH: Extras = Extras { degree: true, snippets: true };

    #[test]
    fn the_frontier_is_bound_straight_to_the_source_and_nothing_is_an_input() {
        let query = connected_pages(&[id(10), id(11)], PLAIN);
        assert!(query.inputs.is_empty());
        assert!(query.text.contains(":where [(ground [10 11]) [?source ...]] [?source :block/name]"));
        assert!(query.text.contains("(or-join [?source ?connected ?block ?rel-type]"));
    }

    #[test]
    fn each_comment_of_the_query_ends_at_a_newline_so_it_cannot_swallow_the_clauses_after_it() {
        for extras in [PLAIN, DEGREE, BOTH] {
            let query = connected_pages(&[id(10)], extras);
            assert_eq!(query.text.matches(";;").count(), 2);
            assert!(query.text.contains(";; Outbound: blocks on the source page that reference other pages\n(and "));
            assert!(query.text.contains(";; Inbound: blocks on other pages that reference the source\n(and "));
            // a comment that ends its line leaves every clause after it on a line of its own
            let after_last_comment = query.text.rsplit(";;").next().unwrap();
            assert!(after_last_comment.starts_with(" Inbound"));
            assert!(after_last_comment.contains("\n(and [?block :block/refs ?source]"));
        }
    }

    #[test]
    fn the_plain_query_is_the_one_the_path_and_the_recorded_calls_have() {
        let query = connected_pages(&[id(10)], PLAIN);
        assert!(query.text.starts_with("[:find ?source ?connected ?name ?original-name ?journal ?rel-type (count ?block) :where "));
        assert!(!query.text.contains("degree") && !query.text.contains("content"));
        assert!(query.text.ends_with("[(get-else $ ?connected :block/journal? false) ?journal]]"));
    }

    #[test]
    fn the_degree_branches_join_the_or_join_and_the_counts_become_distinct() {
        let query = connected_pages(&[id(10)], DEGREE);
        assert!(query.text.starts_with("[:find ?source ?connected ?name ?original-name ?journal ?rel-type (count-distinct ?block) :where "));
        assert_eq!(query.text.matches("[(ground \"degree\") ?rel-type]").count(), 2);
        // both branches count pages (a block ref is no link out, nor a page's link to itself) and sit inside the or-join
        assert_eq!(query.text.matches("[?block :block/name] [(not= ?block ?connected)]").count(), 2);
        assert!(query.text.contains("[(ground \"inbound\") ?rel-type]) (and [?b1 :block/page ?source]"));
        assert!(query.text.contains("[(ground \"degree\") ?rel-type])) [?connected :block/name ?name]"));
        assert!(query.inputs.is_empty());
    }

    #[test]
    fn a_snippet_is_one_more_cell_taken_from_the_linking_block() {
        let query = connected_pages(&[id(10)], BOTH);
        assert!(query.text.contains("(count-distinct ?block) (min ?content) :where "));
        assert!(query.text.ends_with("[(get-else $ ?connected :block/journal? false) ?journal] [(get-else $ ?block :block/content \"\") ?content]]"));
    }

    #[test]
    fn a_group_folds_its_members_into_one_source_and_counts_distinct_blocks() {
        let query = connected_pages_grouped(&[(id(10), id(10)), (id(11), id(10))], PLAIN);
        assert!(query.inputs.is_empty());
        assert_eq!(
            query.text,
            "[:find ?group ?connected ?name ?original-name ?journal ?rel-type (count-distinct ?block) \
             :where [(ground [[10 10] [11 10]]) [[?source ?group] ...]] [?source :block/name] \
             (or-join [?source ?connected ?block ?rel-type] \
             (and [?block :block/page ?source] [?block :block/refs ?connected] [(ground \"outbound\") ?rel-type]) \
             (and [?block :block/refs ?source] [?block :block/page ?connected] [(ground \"inbound\") ?rel-type])) \
             [?connected :block/name ?name] [(not= ?group ?connected)] \
             [(get-else $ ?connected :block/original-name \"\") ?original-name] \
             [(get-else $ ?connected :block/journal? false) ?journal]]"
        );
    }

    #[test]
    fn a_group_takes_the_degree_rows_and_the_snippet_the_same_way() {
        let query = connected_pages_grouped(&[(id(10), id(10))], BOTH);
        assert!(query.text.starts_with("[:find ?group ?connected ?name ?original-name ?journal ?rel-type (count-distinct ?block) (min ?content) :where "));
        assert_eq!(query.text.matches("[(ground \"degree\") ?rel-type]").count(), 2);
        assert!(query.text.ends_with("?journal] [(get-else $ ?block :block/content \"\") ?content]]"));
    }
}
