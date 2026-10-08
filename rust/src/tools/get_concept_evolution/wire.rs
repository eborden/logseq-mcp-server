//! What the concept timeline reads from LogSeq: the blocks that mention the page (`responses.blockRows`
//! in `src/response-schemas.ts`), and, through `get_page`'s own readers, the page's block tree and the
//! page itself (`responses.blocks` and `responses.editorPage`). Every block is checked against the
//! TypeScript schema and returned as the JSON LogSeq sent, since the result carries it as it came.

use serde_json::Value;

use crate::wire::{DATALOG_METHOD, Part, Reader, ResponseError, to_error};

/// `responses.blockRows`: `[block]` per row, or `None` for a `null` answer, which is not an empty
/// one (BR-0011). Unlike the nullable rows other tools read, a `null` cell is an error here.
pub fn block_rows(answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
    let mut reader = Reader::default();
    reader
        .rows(answer, 1, |r, cells| {
            r.at(Part::Index(0), |r| r.check_block(cells.first()))?;
            Ok(cells[0].clone())
        })
        .map_err(|issue| to_error(DATALOG_METHOD, issue))
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
        assert_eq!(problem(block_rows(&json!([[null]]))), "[0][0]: Invalid input: expected object, received null");
        assert_eq!(problem(block_rows(&json!([[{"id": 1}]]))), "[0][0].uuid: Invalid input: expected string, received undefined");
        assert_eq!(problem(block_rows(&json!([[]]))), "[0][0]: Invalid input: expected object, received undefined");
        assert_eq!(problem(block_rows(&json!({}))), "(response): Invalid input: expected array, received object");
    }
}
