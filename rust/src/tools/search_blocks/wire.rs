//! What the block search reads from LogSeq: the hits of its query and the pages of its context
//! lookup (`responses.searchRows`, `responses.searchHitList` and `responses.pageRows` in
//! `src/response-schemas.ts`). Each is checked against the TypeScript schema, and returned as the
//! JSON LogSeq sent, since a full result carries each entity as it came.

use serde_json::Value;

use crate::wire::{DATALOG_METHOD, Part, Reader, ResponseError, to_error};

/// `responses.searchRows`, then `searchHitList` on the rows the search keeps: `null`, or the
/// blocks whose content is text, each checked whole.
///
/// A row is `[block | null]`. A `null` cell is skipped, and so is a row whose `content` is not
/// text (a block with none has nothing to search), as `searchBlocksWithMeta` has always skipped
/// it. Only that row's `id` is checked in the first pass; the blocks kept are then checked as
/// blocks, at their index among the kept ones.
pub fn hits(answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
    let mut reader = Reader::default();
    let rows = reader
        .rows(answer, 1, |r, cells| {
            r.at(Part::Index(0), |r| match cells.first() {
                Some(Value::Null) => Ok(None),
                cell => {
                    let map = r.object(cell)?;
                    r.required_whole(map, "id")?;
                    Ok(cell.filter(|_| map.get("content").is_some_and(Value::is_string)).cloned())
                }
            })
        })
        .map_err(|issue| to_error(DATALOG_METHOD, issue))?;
    let Some(rows) = rows else { return Ok(None) };

    let searchable: Vec<Value> = rows.into_iter().flatten().collect();
    let mut reader = Reader::default();
    for (i, block) in searchable.iter().enumerate() {
        reader.at(Part::Index(i), |r| r.check_block(Some(block))).map_err(|issue| to_error(DATALOG_METHOD, issue))?;
    }
    Ok(Some(searchable))
}

/// `responses.pageRows`: `null`, or one pulled page per row. A `null` cell is an error here.
pub fn page_rows(answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
    let mut reader = Reader::default();
    reader
        .rows(answer, 1, |r, cells| {
            r.at(Part::Index(0), |r| {
                r.check_pulled_page(cells.first())?;
                Ok(cells[0].clone())
            })
        })
        .map_err(|issue| to_error(DATALOG_METHOD, issue))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn block(id: i64) -> Value {
        json!({"id": id, "uuid": format!("u{id}"), "content": "text"})
    }

    fn problem<T: std::fmt::Debug>(result: Result<T, ResponseError>) -> String {
        let error = result.unwrap_err();
        format!("{}: {}", error.path, error.problem)
    }

    #[test]
    fn null_is_its_own_case_and_a_null_cell_or_a_block_without_text_is_skipped() {
        assert_eq!(hits(&json!(null)).unwrap(), None);
        assert_eq!(hits(&json!([])).unwrap(), Some(vec![]));
        let answer = json!([[block(1)], [null], [{"id": 2, "uuid": "u2"}], [{"id": 3, "uuid": "u3", "content": 7}], [block(4)]]);
        assert_eq!(hits(&answer).unwrap(), Some(vec![block(1), block(4)]));
    }

    #[test]
    fn a_row_that_is_not_a_hit_is_an_error_naming_the_path_and_no_value() {
        assert_eq!(problem(hits(&json!({}))), "(response): Invalid input: expected array, received object");
        assert_eq!(problem(hits(&json!([[1]]))), "[0][0]: Invalid input: expected object, received number");
        assert_eq!(problem(hits(&json!([[{"content": "x"}]]))), "[0][0].id: Invalid input: expected number, received undefined");
        assert_eq!(problem(hits(&json!([[block(1), block(2)]]))), "[0]: Too big: expected array to have <1 items");
    }

    #[test]
    fn the_kept_blocks_are_checked_whole_at_their_index_among_the_kept() {
        // the second kept block (index 1) has no uuid, though the null cell before it is index 1 of the rows
        let answer = json!([[null], [block(1)], [{"id": 5, "content": "x"}]]);
        assert_eq!(problem(hits(&answer)), "[1].uuid: Invalid input: expected string, received undefined");
        let answer = json!([[{"id": 6, "uuid": "u", "content": "x", "page": {"name": 3}}]]);
        assert_eq!(problem(hits(&answer)), "[0].page.name: Invalid input: expected string, received number");
    }

    #[test]
    fn pages_come_back_as_sent_and_a_null_cell_is_an_error() {
        let page = json!({"id": 9, "name": "alice", "original-name": "Alice", "extra": true});
        assert_eq!(page_rows(&json!([[page.clone()]])).unwrap(), Some(vec![page]));
        assert_eq!(page_rows(&json!(null)).unwrap(), None);
        assert_eq!(problem(page_rows(&json!([[null]]))), "[0][0]: Invalid input: expected object, received null");
        assert_eq!(problem(page_rows(&json!([[{"id": "x"}]]))), "[0][0].id: Invalid input: expected number, received string");
    }
}
