//! The Datalog query only the block search makes (`searchBlocks` in `src/datalog/queries.ts`). The
//! search text is bound with `:in` as a regex (ADR-0013). The page lookup it also makes is shared:
//! `crate::pages_by_ids`.

use crate::edn::{DatalogInput, Query};
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
}
