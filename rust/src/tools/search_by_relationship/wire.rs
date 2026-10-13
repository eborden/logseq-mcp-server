//! What the relationship search reads from LogSeq: the page ids of a hop and a page's block tree. Blocks are checked against their wire types and kept as the JSON
//! LogSeq sent, since a result carries them as they came (BR-0004).
//!
//! `null` is a case of its own (BR-0011): each parser returns `None` for it and the tool decides
//! what that means.

use serde_json::Value;

use crate::entity::shape::Block;
use crate::wire::{DATALOG_METHOD, Id, ResponseError, parse, sent_list};

/// The method whose answer [`blocks`] reads.
pub const BLOCKS_METHOD: &str = "logseq.Editor.getPageBlocksTree";

/// The answer: `[id]` per row, or `None` for a `null` answer.
///
/// An id must be a whole number here: the next hop binds it into a query.
pub fn id_rows(answer: &Value) -> Result<Option<Vec<i64>>, ResponseError> {
    Ok(parse::<Option<Vec<(Id,)>>>(DATALOG_METHOD, answer)?.map(|rows| rows.into_iter().map(|(id,)| id.0).collect()))
}

/// The top-level blocks of a page tree, or `None` for a `null` answer. Each is
/// checked as a block and returned as sent, children included.
pub fn blocks(answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
    sent_list::<Block>(BLOCKS_METHOD, answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn problem<T: std::fmt::Debug>(result: Result<T, ResponseError>) -> String {
        let error = result.unwrap_err();
        format!("{}: {}", error.path, error.problem)
    }

    #[test]
    fn null_is_its_own_case() {
        assert_eq!(id_rows(&json!(null)).unwrap(), None);
        assert_eq!(blocks(&json!(null)).unwrap(), None);
        assert_eq!(blocks(&json!([])).unwrap(), Some(vec![]));
    }

    #[test]
    fn a_block_is_checked_as_a_block() {
        assert_eq!(problem(blocks(&json!([{"uuid": "u"}]))), "answer[0].id: required, but missing");
        assert_eq!(problem(blocks(&json!([{"id": 1, "uuid": "u"}, {"id": 2}]))), "answer[1].uuid: required, but missing");
        assert_eq!(problem(blocks(&json!({}))), "answer: expected a list, got an object");
        assert_eq!(blocks(&json!({})).unwrap_err().method, BLOCKS_METHOD);
    }

    #[test]
    fn page_ids_are_whole_numbers() {
        assert_eq!(id_rows(&json!([[3], [4]])).unwrap().unwrap(), vec![3, 4]);
        assert_eq!(id_rows(&json!([[5.0]])).unwrap().unwrap(), vec![5]);
        assert_eq!(problem(id_rows(&json!([["3"]]))), "answer[0][0]: expected a whole number, got a string");
        assert_eq!(problem(id_rows(&json!([[]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(id_rows(&json!([[2.5]]))), "answer[0][0]: expected a whole number, got a number with a fraction");
    }

    #[test]
    fn a_tree_keeps_its_children_as_sent() {
        let sent = json!([{"id": 1, "uuid": "u", "children": [{"id": 2, "uuid": "v", "children": []}]}]);
        assert_eq!(blocks(&sent).unwrap().unwrap(), sent.as_array().unwrap().clone());
    }
}
