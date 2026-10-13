//! The one Datalog query the relationship search makes: the hop of its walk. Page ids are embedded through
//! `ground_ids`, which takes only a valid [`PageId`]. (The queries of the modes that moved to `find_blocks` are in
//! `crate::tools::find_blocks`, #492.)
//!
//! The text has its whitespace collapsed; LogSeq doesn't care how a query is laid out.

use crate::edn::{PageId, Query, ground_ids};

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
