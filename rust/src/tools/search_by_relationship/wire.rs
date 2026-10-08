//! What the relationship search reads from LogSeq: the blocks of its queries
//! (`responses.nullableBlockRows`), the page ids of a hop (`responses.idRows`) and a page's block
//! tree (`responses.blocks`). Blocks are checked against the TypeScript schema and kept as the JSON
//! LogSeq sent, since a result carries them as they came (BR-0004).
//!
//! `null` is a case of its own (BR-0011): each parser returns `None` for it and the tool decides
//! what that means.

use serde_json::{Map, Value};

use crate::wire::{DATALOG_METHOD, Part, Reader, ResponseError, to_error};

/// The method whose answer [`blocks`] reads.
pub const BLOCKS_METHOD: &str = "logseq.Editor.getPageBlocksTree";

/// `responses.nullableBlockRows`: `[block | null]` per row, or `None` for a `null` answer. A `null`
/// cell is skipped (`extractBlocks`).
pub fn block_rows(answer: &Value) -> Result<Option<Vec<Map<String, Value>>>, ResponseError> {
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

/// `responses.idRows`: `[id]` per row, or `None` for a `null` answer.
///
/// An id must be a whole number here. `z.number()` takes a fraction, and the TypeScript tool then
/// fails at `groundIds` on the next hop, or not at all after the last one; LogSeq never sends one
/// (see `crate::wire`).
pub fn id_rows(answer: &Value) -> Result<Option<Vec<i64>>, ResponseError> {
    let mut reader = Reader::default();
    reader
        .rows(answer, 1, |r, cells| {
            r.at(Part::Index(0), |r| match cells.first() {
                Some(value) => {
                    let n = r.number_value(value)?;
                    // 2^53 is where an f64 stops holding every whole number, as a JavaScript number does
                    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 { Ok(n as i64) } else { Err(r.mismatch("int", Some(value))) }
                }
                None => Err(r.mismatch("number", None)),
            })
        })
        .map_err(|issue| to_error(DATALOG_METHOD, issue))
}

/// `responses.blocks`: the top-level blocks of a page tree, or `None` for a `null` answer. Each is
/// checked as a block and returned as sent, children included.
pub fn blocks(answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
    let mut reader = Reader::default();
    let items = match answer {
        Value::Null => return Ok(None),
        Value::Array(items) => items,
        other => return Err(to_error(BLOCKS_METHOD, reader.mismatch("array", Some(other)))),
    };
    for (i, item) in items.iter().enumerate() {
        reader.at(Part::Index(i), |r| r.check_block(Some(item))).map_err(|issue| to_error(BLOCKS_METHOD, issue))?;
    }
    Ok(Some(items.clone()))
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
        assert_eq!(block_rows(&json!(null)).unwrap(), None);
        assert_eq!(id_rows(&json!(null)).unwrap(), None);
        assert_eq!(blocks(&json!(null)).unwrap(), None);
        assert_eq!(block_rows(&json!([])).unwrap(), Some(vec![]));
        let block = json!({"id": 1, "uuid": "u"});
        let kept = block_rows(&json!([[null], [block.clone()]])).unwrap().unwrap();
        assert_eq!(kept, vec![block.as_object().unwrap().clone()]);
    }

    #[test]
    fn a_block_is_checked_as_a_block_in_the_schemas_order() {
        assert_eq!(problem(block_rows(&json!([[{"uuid": "u"}]]))), "[0][0].id: Invalid input: expected number, received undefined");
        assert_eq!(problem(block_rows(&json!([[{"id": 1}]]))), "[0][0].uuid: Invalid input: expected string, received undefined");
        assert_eq!(problem(block_rows(&json!([[{"id": 1, "uuid": "u"}, {"id": 2, "uuid": "v"}]]))), "[0]: Too big: expected array to have <1 items");
        assert_eq!(problem(block_rows(&json!({}))), "(response): Invalid input: expected array, received object");
        assert_eq!(problem(blocks(&json!([{"id": 1, "uuid": "u"}, {"id": 2}]))), "[1].uuid: Invalid input: expected string, received undefined");
        assert_eq!(blocks(&json!({})).unwrap_err().method, BLOCKS_METHOD);
    }

    #[test]
    fn page_ids_are_whole_numbers() {
        assert_eq!(id_rows(&json!([[3], [4]])).unwrap().unwrap(), vec![3, 4]);
        assert_eq!(problem(id_rows(&json!([["3"]]))), "[0][0]: Invalid input: expected number, received string");
        assert_eq!(problem(id_rows(&json!([[]]))), "[0][0]: Invalid input: expected number, received undefined");
        assert_eq!(problem(id_rows(&json!([[2.5]]))), "[0][0]: Invalid input: expected int, received number");
    }

    #[test]
    fn a_tree_keeps_its_children_as_sent() {
        let sent = json!([{"id": 1, "uuid": "u", "children": [{"id": 2, "uuid": "v", "children": []}]}]);
        assert_eq!(blocks(&sent).unwrap().unwrap(), sent.as_array().unwrap().clone());
    }
}
