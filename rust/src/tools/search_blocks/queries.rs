//! The two Datalog queries the block search makes (`searchBlocks` and `getPagesByIds` in
//! `src/datalog/queries.ts`). The search text is bound with `:in` as a regex (ADR-0013); only page
//! `:db/id`s are embedded, through [`ground_ids`], which takes [`PageId`]s and not numbers.

use crate::edn::{DatalogInput, PageId, Query, ground_ids};
use crate::escape::escape_regex;

/// Blocks whose content contains `text`, case-insensitively and literally: LogSeq runs
/// `re-pattern` / `re-find` over every block, with the text's metacharacters escaped so it matches
/// as it is written. Each block comes back with its page's id, name and original name nested.
pub fn search_blocks(text: &str) -> Query {
    Query {
        text: "[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}]) \
               :in $ ?pattern \
               :where \
               [?b :block/content ?c] \
               [(re-pattern ?pattern) ?re] \
               [(re-find ?re ?c)]]"
            .to_owned(),
        inputs: vec![DatalogInput::Str(format!("(?i){}", escape_regex(text)))],
    }
}

/// The full page entities for some ids, in one query.
pub fn pages_by_ids(ids: &[PageId]) -> Query {
    Query {
        text: format!("[:find (pull ?p [*]) :where {} [?p :block/name]]", ground_ids(ids, "?p")),
        inputs: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_is_escaped_and_bound_as_a_case_insensitive_pattern() {
        let query = search_blocks("a.b (c)");
        assert_eq!(query.inputs, [DatalogInput::Str(r"(?i)a\.b \(c\)".to_owned())]);
        assert!(!query.text.contains("a.b"), "the text is never part of the query");
        assert!(query.text.contains(":in $ ?pattern :where [?b :block/content ?c]"));
    }

    #[test]
    fn pages_are_pulled_by_id_with_nothing_bound() {
        let query = pages_by_ids(&[PageId::new(7).unwrap(), PageId::new(9).unwrap()]);
        assert_eq!(query.text, "[:find (pull ?p [*]) :where [(ground [7 9]) [?p ...]] [?p :block/name]]");
        assert!(query.inputs.is_empty());
    }
}
