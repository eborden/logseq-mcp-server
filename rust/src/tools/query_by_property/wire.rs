//! What the property search reads from LogSeq: its query's rows (`responses.nullableBlockRows` in
//! `src/response-schemas.ts`). Each block is checked against the TypeScript schema and returned as
//! the JSON LogSeq sent, since a full result carries it as it came.

use serde_json::{Map, Value};

use crate::wire::{DATALOG_METHOD, Part, Reader, ResponseError, to_error};

/// `responses.nullableBlockRows`: `null`, or one row per match, `[block | null]`. A `null` cell is
/// skipped (`filter(pulled => pulled != null)`), and every block is checked whole.
pub fn blocks(answer: &Value) -> Result<Option<Vec<Map<String, Value>>>, ResponseError> {
    let mut reader = Reader::default();
    let rows = reader
        .rows(answer, 1, |r, cells| {
            r.at(Part::Index(0), |r| match cells.first() {
                Some(Value::Null) => Ok(None),
                cell => {
                    r.check_block(cell)?;
                    Ok(cell.and_then(Value::as_object).cloned())
                }
            })
        })
        .map_err(|issue| to_error(DATALOG_METHOD, issue))?;
    Ok(rows.map(|rows| rows.into_iter().flatten().collect()))
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
        assert_eq!(problem(blocks(&json!({}))), "(response): Invalid input: expected array, received object");
        assert_eq!(problem(blocks(&json!([7]))), "[0]: Invalid input: expected tuple, received number");
        assert_eq!(problem(blocks(&json!([[1]]))), "[0][0]: Invalid input: expected object, received number");
        assert_eq!(problem(blocks(&json!([[{"uuid": "u"}]]))), "[0][0].id: Invalid input: expected number, received undefined");
        assert_eq!(problem(blocks(&json!([[{"id": 1}]]))), "[0][0].uuid: Invalid input: expected string, received undefined");
        assert_eq!(problem(blocks(&json!([[{"id": 1, "uuid": "u", "page": {"id": "x"}}]]))), "[0][0].page.id: Invalid input: expected number, received string");
        assert_eq!(problem(blocks(&json!([[{"id": 1, "uuid": "u"}, {"id": 2, "uuid": "v"}]]))), "[0]: Too big: expected array to have <1 items");
    }
}
