//! What the block search reads from LogSeq: the hits of its query and the pages of its context
//! lookup. Each is checked against its wire type, and returned as the
//! JSON LogSeq sent, since a full result carries each entity as it came.

use serde::Deserialize;
use serde_json::Value;

use crate::entity::shape::{Block, PulledPage};
use crate::wire::{DATALOG_METHOD, Id, ResponseError, check_at, sent_cells, sent_required_cells};

/// What the search asks of a row before it knows whether the block has text to search.
#[derive(Deserialize)]
#[allow(dead_code)]
struct Hit {
    id: Id,
}

/// The finder's rows, then the rows it keeps: `null`, or the blocks, each checked whole.
///
/// A row is `[block | null]`. A `null` cell is skipped. With `needs_text` (the search had a text filter), so is a row
/// whose `content` is not text (a block with none has nothing to search), as the search has always skipped it.
/// Only that row's `id` is checked in the first pass; the blocks kept are then checked as blocks, in the row they
/// came from.
pub fn hits(answer: &Value, needs_text: bool) -> Result<Option<Vec<Value>>, ResponseError> {
    let Some(cells) = sent_cells::<Hit>(DATALOG_METHOD, answer)? else { return Ok(None) };
    let mut kept = Vec::new();
    for (row, cell) in cells.into_iter().enumerate() {
        let Some(block) = cell.filter(|block| !needs_text || block.get("content").is_some_and(Value::is_string)) else { continue };
        check_at::<Block>(DATALOG_METHOD, &block, &[row, 0])?;
        kept.push(block);
    }
    Ok(Some(kept))
}

/// The answer: `null`, or one pulled page per row. A `null` cell is an error here.
pub fn page_rows(answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
    sent_required_cells::<PulledPage>(DATALOG_METHOD, answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The rows of a search with a text filter.
    fn text_hits(answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
        hits(answer, true)
    }

    fn block(id: i64) -> Value {
        json!({"id": id, "uuid": format!("u{id}"), "content": "text"})
    }

    fn problem<T: std::fmt::Debug>(result: Result<T, ResponseError>) -> String {
        let error = result.unwrap_err();
        format!("{}: {}", error.path, error.problem)
    }

    #[test]
    fn null_is_its_own_case_and_a_null_cell_or_a_block_without_text_is_skipped() {
        assert_eq!(text_hits(&json!(null)).unwrap(), None);
        assert_eq!(text_hits(&json!([])).unwrap(), Some(vec![]));
        let answer = json!([[block(1)], [null], [{"id": 2, "uuid": "u2"}], [{"id": 3, "uuid": "u3", "content": 7}], [block(4)]]);
        assert_eq!(text_hits(&answer).unwrap(), Some(vec![block(1), block(4)]));
    }

    #[test]
    fn a_row_that_is_not_a_hit_is_an_error_naming_the_path_and_no_value() {
        assert_eq!(problem(text_hits(&json!({}))), "answer: expected a list, got an object");
        assert_eq!(problem(text_hits(&json!([[1]]))), "answer[0][0]: expected an object, got a number");
        assert_eq!(problem(text_hits(&json!([[{"content": "x"}]]))), "answer[0][0].id: required, but missing");
        assert_eq!(problem(text_hits(&json!([[block(1), block(2)]]))), "answer[0]: the row has more cells than this server reads");
    }

    #[test]
    fn without_a_text_filter_a_block_with_no_text_is_a_hit_like_any_other() {
        // a property or a period matches a block whatever its content, so only the text search skips it
        let bare = json!({"id": 7, "uuid": "u7"});
        let answer = json!([[bare.clone()], [null], [block(3)]]);
        assert_eq!(hits(&answer, false).unwrap(), Some(vec![bare, block(3)]));
        assert_eq!(hits(&json!(null), false).unwrap(), None);
        // and each is still checked whole, content included
        assert_eq!(problem(hits(&json!([[{"id": 7}]]), false)), "answer[0][0].uuid: required, but missing");
        assert_eq!(problem(hits(&json!([[{"id": 7, "uuid": "u", "content": 7}]]), false)), "answer[0][0].content: expected a string, got a number");
    }

    #[test]
    fn the_kept_blocks_are_checked_whole_in_the_row_they_came_from() {
        // the row after the null cell has no uuid: it is row 2 of the answer
        let answer = json!([[null], [block(1)], [{"id": 5, "content": "x"}]]);
        assert_eq!(problem(text_hits(&answer)), "answer[2][0].uuid: required, but missing");
        let answer = json!([[{"id": 6, "uuid": "u", "content": "x", "page": {"name": 3}}]]);
        assert_eq!(problem(text_hits(&answer)), "answer[0][0].page.name: expected a string, got a number");
        // a block with no text is skipped before it is checked whole
        assert_eq!(text_hits(&json!([[{"id": 7}]])).unwrap(), Some(vec![]));
    }

    #[test]
    fn pages_come_back_as_sent_and_a_null_cell_is_an_error() {
        let page = json!({"id": 9, "name": "alice", "original-name": "Alice", "extra": true});
        assert_eq!(page_rows(&json!([[page.clone()]])).unwrap(), Some(vec![page]));
        assert_eq!(page_rows(&json!(null)).unwrap(), None);
        assert_eq!(problem(page_rows(&json!([[null]]))), "answer[0][0]: expected an object, got null");
        assert_eq!(problem(page_rows(&json!([[{"id": "x"}]]))), "answer[0][0].id: expected a whole number, got a string");
    }
}
