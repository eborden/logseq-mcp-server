//! What the concept timeline reads from LogSeq: the blocks that mention the page, and,
//! through `get_page`'s own readers, the page's block tree and the page itself. Every block is
//! checked against its wire type and returned as the JSON LogSeq sent, since the result carries it as it came.

use serde_json::Value;

use crate::entity::shape::Block;
use crate::wire::{DATALOG_METHOD, ResponseError, sent_required_cells};

/// The answer: `[block]` per row, or `None` for a `null` answer, which is not an empty
/// one (BR-0011). Unlike the nullable rows other tools read, a `null` cell is an error here.
pub fn block_rows(answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
    sent_required_cells::<Block>(DATALOG_METHOD, answer)
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
    fn null_is_its_own_case_and_a_block_comes_back_as_sent() {
        assert_eq!(block_rows(&json!(null)).unwrap(), None);
        assert_eq!(block_rows(&json!([])).unwrap(), Some(vec![]));
        let sent = json!({"id": 1, "uuid": "u", "content": "x", "page": {"id": 2, "journal-day": 20250101}, "extra": [1]});
        assert_eq!(block_rows(&json!([[sent.clone()]])).unwrap(), Some(vec![sent]));
    }

    #[test]
    fn a_null_cell_or_a_block_without_a_uuid_is_an_error_naming_the_path() {
        assert_eq!(problem(block_rows(&json!([[null]]))), "answer[0][0]: expected an object, got null");
        assert_eq!(problem(block_rows(&json!([[{"id": 1}]]))), "answer[0][0].uuid: required, but missing");
        assert_eq!(problem(block_rows(&json!([[{"id": 1, "uuid": 5}]]))), "answer[0][0].uuid: expected a string, got a number");
        assert_eq!(problem(block_rows(&json!([[]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(block_rows(&json!({}))), "answer: expected a list, got an object");
    }
}
