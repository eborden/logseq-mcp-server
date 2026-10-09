//! What the date-range tool reads from LogSeq: the journal pages and the blocks its queries pull.
//! Each page and block is checked against its wire type and returned as the JSON LogSeq
//! sent, since a full result carries it as it came.
//!
//! Both answers are `null` or a list of rows, one cell each, and a `null` cell is skipped
//! (the row is dropped). A `null` answer is not an empty one (BR-0011): the tool says
//! LogSeq gave no answer.

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::entity::shape::{Block, PulledPage};
use crate::wire::{DATALOG_METHOD, ResponseError, sent_cells};

/// Rows of one cell each, the cell `null` or an object that is a `T`; the objects kept, as sent.
fn rows<T: DeserializeOwned>(answer: &Value) -> Result<Option<Vec<Map<String, Value>>>, ResponseError> {
    let cells = sent_cells::<T>(DATALOG_METHOD, answer)?;
    Ok(cells.map(|cells| cells.into_iter().flatten().filter_map(|cell| if let Value::Object(map) = cell { Some(map) } else { None }).collect()))
}

/// The pulled journal pages, or `None` for a `null` answer.
pub fn pages(answer: &Value) -> Result<Option<Vec<Map<String, Value>>>, ResponseError> {
    rows::<PulledPage>(answer)
}

/// The pulled blocks, or `None` for a `null` answer.
pub fn blocks(answer: &Value) -> Result<Option<Vec<Map<String, Value>>>, ResponseError> {
    rows::<Block>(answer)
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
        assert_eq!(problem(pages(&json!([[{"id": "x"}]]))), "answer[0][0].id: expected a whole number, got a string");
        assert_eq!(problem(pages(&json!([[{"id": 1, "journal-day": "x"}]]))), "answer[0][0].journal-day: expected a number, got a string");
        assert_eq!(problem(blocks(&json!([[{"uuid": "u"}]]))), "answer[0][0].id: required, but missing");
        assert_eq!(
            problem(blocks(&json!([[{"id": 1, "uuid": "u", "refs": [{"name": 3}]}]]))),
            "answer[0][0].refs[0].name: expected a string, got a number"
        );
        assert_eq!(problem(blocks(&json!([[{"id": 1, "uuid": "u"}, {"id": 2, "uuid": "v"}]]))), "answer[0]: the row has more cells than this server reads");
        assert_eq!(problem(pages(&json!({}))), "answer: expected a list, got an object");
    }

    #[test]
    fn a_page_field_nothing_reads_may_hold_anything() {
        let page = json!({"id": 1, "name": "jan 1st, 2025", "uuid": 5, "namespace": 7, "created-at": "x", "updated-at": [], "properties-text-values": null});
        assert_eq!(pages(&json!([[page.clone()]])).unwrap(), Some(vec![page.as_object().unwrap().clone()]));
    }
}
