//! What the date-range tool reads from LogSeq: the journal pages and the blocks its queries pull
//! (`responses.nullablePageRows` and `responses.nullableBlockRows` in `src/response-schemas.ts`).
//! Each page and block is checked against the TypeScript schema and returned as the JSON LogSeq
//! sent, since a full result carries it as it came.
//!
//! Both answers are `null` or a list of rows, one cell each, and a `null` cell is skipped
//! (`filter(row => row != null)`). A `null` answer is not an empty one (BR-0011): the tool says
//! LogSeq gave no answer.

use serde_json::{Map, Value};

use crate::wire::{DATALOG_METHOD, Part, Reader, ResponseError, to_error};

/// Rows of one cell each, the cell `null` or an object that `check` accepts.
fn rows(answer: &Value, check: impl Fn(&mut Reader, Option<&Value>) -> crate::wire::Parsed<()>) -> Result<Option<Vec<Map<String, Value>>>, ResponseError> {
    let mut reader = Reader::default();
    let rows = reader
        .rows(answer, 1, |r, cells| {
            r.at(Part::Index(0), |r| match cells.first() {
                Some(Value::Null) => Ok(None),
                cell => {
                    check(r, cell)?;
                    Ok(cell.and_then(Value::as_object).cloned())
                }
            })
        })
        .map_err(|issue| to_error(DATALOG_METHOD, issue))?;
    Ok(rows.map(|rows| rows.into_iter().flatten().collect()))
}

/// `responses.nullablePageRows`: the pulled journal pages, or `None` for a `null` answer.
pub fn pages(answer: &Value) -> Result<Option<Vec<Map<String, Value>>>, ResponseError> {
    rows(answer, |r, cell| r.check_pulled_page(cell))
}

/// `responses.nullableBlockRows`: the pulled blocks, or `None` for a `null` answer.
pub fn blocks(answer: &Value) -> Result<Option<Vec<Map<String, Value>>>, ResponseError> {
    rows(answer, |r, cell| r.check_block(cell))
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
        assert_eq!(pages(&json!(null)).unwrap(), None);
        assert_eq!(blocks(&json!(null)).unwrap(), None);
        assert_eq!(pages(&json!([])).unwrap(), Some(vec![]));
        let page = json!({"id": 1, "name": "jan 1st, 2025", "journal-day": 20250101});
        let kept = pages(&json!([[null], [page.clone()]])).unwrap().unwrap();
        assert_eq!(kept, vec![page.as_object().unwrap().clone()]);
    }

    #[test]
    fn a_page_is_checked_as_a_pulled_page_and_a_block_as_a_block() {
        assert_eq!(problem(pages(&json!([[{"id": "x"}]]))), "[0][0].id: Invalid input: expected number, received string");
        assert_eq!(problem(pages(&json!([[{"id": 1, "journal-day": "x"}]]))), "[0][0].journal-day: Invalid input: expected number, received string");
        assert_eq!(problem(blocks(&json!([[{"uuid": "u"}]]))), "[0][0].id: Invalid input: expected number, received undefined");
        assert_eq!(
            problem(blocks(&json!([[{"id": 1, "uuid": "u", "refs": [{"name": 3}]}]]))),
            "[0][0].refs[0].name: Invalid input: expected string, received number"
        );
        assert_eq!(problem(blocks(&json!([[{"id": 1, "uuid": "u"}, {"id": 2, "uuid": "v"}]]))), "[0]: Too big: expected array to have <1 items");
        assert_eq!(problem(pages(&json!({}))), "(response): Invalid input: expected array, received object");
    }
}
