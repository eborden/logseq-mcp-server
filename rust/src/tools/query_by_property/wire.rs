//! What the property search reads from LogSeq: its query's rows. Each block is checked against its wire type and returned as
//! the JSON LogSeq sent, since a full result carries it as it came.

use serde_json::{Map, Value};

use crate::entity::shape::Block;
use crate::wire::{DATALOG_METHOD, ResponseError, sent_cells};

/// The answer: `null`, or one row per match, `[block | null]`. A `null` cell is
/// skipped, and every block is checked whole.
pub fn blocks(answer: &Value) -> Result<Option<Vec<Map<String, Value>>>, ResponseError> {
    let cells = sent_cells::<Block>(DATALOG_METHOD, answer)?;
    Ok(cells.map(|cells| cells.into_iter().flatten().filter_map(|cell| if let Value::Object(map) = cell { Some(map) } else { None }).collect()))
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
    fn null_is_its_own_case_and_a_null_cell_is_skipped() {
        assert_eq!(blocks(&json!(null)).unwrap(), None);
        assert_eq!(blocks(&json!([])).unwrap(), Some(vec![]));
        let block = json!({"id": 1, "uuid": "u1", "properties": {"a": "b"}});
        let kept = blocks(&json!([[null], [block.clone()], [null]])).unwrap().unwrap();
        assert_eq!(kept, vec![block.as_object().unwrap().clone()]);
    }

    #[test]
    fn a_row_that_is_not_a_block_is_an_error_naming_the_path_and_no_value() {
        assert_eq!(problem(blocks(&json!({}))), "answer: expected a list, got an object");
        assert_eq!(problem(blocks(&json!([7]))), "answer[0]: expected a row, got a number");
        assert_eq!(problem(blocks(&json!([[1]]))), "answer[0][0]: expected an object, got a number");
        assert_eq!(problem(blocks(&json!([[{"uuid": "u"}]]))), "answer[0][0].id: required, but missing");
        assert_eq!(problem(blocks(&json!([[{"id": 1}]]))), "answer[0][0].uuid: required, but missing");
        assert_eq!(problem(blocks(&json!([[{"id": 1, "uuid": "u", "page": {"id": "x"}}]]))), "answer[0][0].page.id: expected a whole number, got a string");
        assert_eq!(problem(blocks(&json!([[{"id": 1, "uuid": "u", "properties": []}]]))), "answer[0][0].properties: expected an object, got a list");
        assert_eq!(problem(blocks(&json!([[{"id": 1, "uuid": "u"}, {"id": 2, "uuid": "v"}]]))), "answer[0]: the row has more cells than this server reads");
    }
}
