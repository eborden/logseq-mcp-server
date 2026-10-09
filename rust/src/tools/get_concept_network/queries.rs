//! The Datalog queries only `get_concept_network` makes. The frontier's ids are embedded, bound
//! straight to the entity variable (constraint 6): [`PageId`] makes sure each is a real id, and no
//! string is part of either query.

use crate::edn::{PageId, Query, ground_ids};

/// The pages linked to or from every page of `frontier`, in both directions, one row per page pair
/// and direction: `[source, connected, name, original-name, journal?, "outbound" | "inbound",
/// count]`. When two frontier pages link to each other the same links come back once from each
/// side, so the caller sets (never adds) a pair's count.
///
/// The text keeps two `;;` comments. A comment runs to the end of its line,
/// so each is followed by a real newline and can't swallow the clauses after it.
pub fn connected_pages(frontier: &[PageId]) -> Query {
    assert!(!frontier.is_empty(), "connectedPages needs at least one frontier id");
    Query {
        text: format!(
            "[:find ?source ?connected ?name ?original-name ?journal ?rel-type (count ?block) \
             :where {} \
             [?source :block/name] \
             (or-join [?source ?connected ?block ?rel-type] \
             ;; Outbound: blocks on the source page that reference other pages\n\
             (and [?block :block/page ?source] [?block :block/refs ?connected] [(ground \"outbound\") ?rel-type]) \
             ;; Inbound: blocks on other pages that reference the source\n\
             (and [?block :block/refs ?source] [?block :block/page ?connected] [(ground \"inbound\") ?rel-type])) \
             [?connected :block/name ?name] \
             [(not= ?source ?connected)] \
             [(get-else $ ?connected :block/original-name \"\") ?original-name] \
             [(get-else $ ?connected :block/journal? false) ?journal]]",
            ground_ids(frontier, "?source")
        ),
        inputs: Vec::new(),
    }
}

/// Like [`connected_pages`] for a frontier in which several pages stand for one: each `(id, group)`
/// pair folds the page `id` into the page `group` (an alias group is folded into its first page).
/// Rows have the same shape with the group's id as the source, and each count is the number of
/// distinct blocks across the whole group, so a block that links two names of the group counts once.
pub fn connected_pages_grouped(pairs: &[(PageId, PageId)]) -> Query {
    assert!(!pairs.is_empty(), "connectedPagesGrouped needs at least one frontier id");
    let pairs: Vec<String> = pairs.iter().map(|(id, group)| format!("[{} {}]", id.get(), group.get())).collect();
    Query {
        text: format!(
            "[:find ?group ?connected ?name ?original-name ?journal ?rel-type (count-distinct ?block) \
             :where [(ground [{}]) [[?source ?group] ...]] \
             [?source :block/name] \
             (or-join [?source ?connected ?block ?rel-type] \
             (and [?block :block/page ?source] [?block :block/refs ?connected] [(ground \"outbound\") ?rel-type]) \
             (and [?block :block/refs ?source] [?block :block/page ?connected] [(ground \"inbound\") ?rel-type])) \
             [?connected :block/name ?name] \
             [(not= ?group ?connected)] \
             [(get-else $ ?connected :block/original-name \"\") ?original-name] \
             [(get-else $ ?connected :block/journal? false) ?journal]]",
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

    #[test]
    fn the_frontier_is_bound_straight_to_the_source_and_nothing_is_an_input() {
        let query = connected_pages(&[id(10), id(11)]);
        assert!(query.inputs.is_empty());
        assert!(query.text.contains(":where [(ground [10 11]) [?source ...]] [?source :block/name]"));
        assert!(query.text.contains("(or-join [?source ?connected ?block ?rel-type]"));
    }

    #[test]
    fn each_comment_of_the_query_ends_at_a_newline_so_it_cannot_swallow_the_clauses_after_it() {
        let query = connected_pages(&[id(10)]);
        assert_eq!(query.text.matches(";;").count(), 2);
        assert!(query.text.contains(";; Outbound: blocks on the source page that reference other pages\n(and "));
        assert!(query.text.contains(";; Inbound: blocks on other pages that reference the source\n(and "));
        // a comment that ends its line leaves every clause after it on a line of its own
        let after_last_comment = query.text.rsplit(";;").next().unwrap();
        assert!(after_last_comment.starts_with(" Inbound"));
        assert!(after_last_comment.contains("\n(and [?block :block/refs ?source]"));
    }

    #[test]
    fn a_group_folds_its_members_into_one_source_and_counts_distinct_blocks() {
        let query = connected_pages_grouped(&[(id(10), id(10)), (id(11), id(10))]);
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
}
