//! What the backlinks tool reads from LogSeq: the Editor API's linked references
//! (`responses.linkedReferences`) and the blocks of the aliased Datalog query
//! (`responses.nullableBlockRows`).
//!
//! Both are checked against the TypeScript schemas and then kept as the values LogSeq sent: the
//! tool's output carries each entity as it came (BR-0004), so a typed copy would only be thrown
//! away. The schema checks are `entity.rs`'s.

use serde_json::{Map, Value};

use crate::wire::{DATALOG_METHOD, Part, Reader, ResponseError, to_error};

/// The method whose answer [`linked_references`] reads.
pub const LINKED_REFERENCES_METHOD: &str = "logseq.Editor.getPageLinkedReferences";

/// One source page and the blocks on it that link the target: `[page, blocks]`. The page is
/// `Value::Null` when LogSeq sent none, and the blocks then name it.
#[derive(Debug, Clone, PartialEq)]
pub struct Backlink {
    pub page: Value,
    pub blocks: Vec<Value>,
}

impl Backlink {
    /// The page of the first block (`blocks[0]?.page`), which names the source when `page` is null.
    pub fn block_page(&self) -> Option<&Map<String, Value>> {
        self.blocks.first()?.get("page")?.as_object()
    }

    /// The tuple as the Editor API sends it.
    pub fn into_value(self) -> Value {
        Value::Array(vec![self.page, Value::Array(self.blocks)])
    }
}

/// `responses.linkedReferences`: `[page | null, blocks]` per source page, or `null`.
pub fn linked_references(answer: Value) -> Result<Option<Vec<Backlink>>, ResponseError> {
    let mut reader = Reader::default();
    let checked = reader
        .rows(&answer, 2, |r, cells| {
            r.at(Part::Index(0), |r| match cells.first() {
                Some(Value::Null) => Ok(()),
                other => r.check_page_like(other),
            })?;
            r.at(Part::Index(1), |r| match cells.get(1) {
                Some(Value::Array(blocks)) => {
                    for (i, block) in blocks.iter().enumerate() {
                        r.at(Part::Index(i), |r| r.check_block(Some(block)))?;
                    }
                    Ok(())
                }
                other => Err(r.mismatch("array", other)),
            })
        })
        .map_err(|issue| to_error(LINKED_REFERENCES_METHOD, issue))?;
    if checked.is_none() {
        return Ok(None);
    }
    let Value::Array(rows) = answer else { unreachable!("rows() only accepts an array or null") };
    Ok(Some(
        rows.into_iter()
            .map(|row| {
                let Value::Array(mut cells) = row else { unreachable!("rows() only accepts arrays") };
                let blocks = match cells.pop() {
                    Some(Value::Array(blocks)) => blocks,
                    _ => unreachable!("the blocks cell was checked to be an array"),
                };
                Backlink { page: cells.pop().unwrap_or(Value::Null), blocks }
            })
            .collect(),
    ))
}

/// `responses.nullableBlockRows`: `[block | null]` per row, or `null`. A `null` cell is `None`,
/// which the tool skips.
pub fn block_rows(answer: Value) -> Result<Option<Vec<Option<Map<String, Value>>>>, ResponseError> {
    let mut reader = Reader::default();
    let checked = reader
        .rows(&answer, 1, |r, cells| {
            r.at(Part::Index(0), |r| match cells.first() {
                Some(Value::Null) => Ok(()),
                other => r.check_block(other),
            })
        })
        .map_err(|issue| to_error(DATALOG_METHOD, issue))?;
    if checked.is_none() {
        return Ok(None);
    }
    let Value::Array(rows) = answer else { unreachable!("rows() only accepts an array or null") };
    Ok(Some(
        rows.into_iter()
            .map(|row| {
                let Value::Array(mut cells) = row else { unreachable!("rows() only accepts arrays") };
                match cells.pop() {
                    Some(Value::Object(block)) => Some(block),
                    _ => None,
                }
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn problem<T: std::fmt::Debug>(result: Result<T, ResponseError>) -> String {
        let error = result.unwrap_err();
        format!("{} {}: {}", error.method, error.path, error.problem)
    }

    #[test]
    fn a_null_answer_is_not_an_empty_one() {
        assert_eq!(linked_references(Value::Null).unwrap(), None);
        assert_eq!(linked_references(json!([])).unwrap(), Some(vec![]));
        assert_eq!(block_rows(Value::Null).unwrap(), None);
        assert_eq!(block_rows(json!([])).unwrap(), Some(vec![]));
    }

    #[test]
    fn a_source_page_is_a_page_or_null_with_its_blocks_kept_as_sent() {
        let answer = json!([
            [{"id": 1, "name": "alice", "originalName": "Alice", "extra": true}, [{"id": 10, "uuid": "u10", "page": {"id": 1}, "x": 1}]],
            [null, [{"id": 11, "uuid": "u11", "page": {"id": 2, "name": "bob"}}]]
        ]);
        let rows = linked_references(answer.clone()).unwrap().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].clone().into_value(), answer[0]);
        assert_eq!(rows[1].page, Value::Null);
        assert_eq!(rows[1].block_page().unwrap()["name"], "bob");
    }

    #[test]
    fn a_wrong_shape_names_the_method_and_the_path() {
        let method = LINKED_REFERENCES_METHOD;
        assert_eq!(problem(linked_references(json!({}))), format!("{method} (response): Invalid input: expected array, received object"));
        assert_eq!(problem(linked_references(json!([1]))), format!("{method} [0]: Invalid input: expected tuple, received number"));
        assert_eq!(problem(linked_references(json!([[null]]))), format!("{method} [0][1]: Invalid input: expected array, received undefined"));
        assert_eq!(
            problem(linked_references(json!([[{"id": "a"}, []]]))),
            format!("{method} [0][0].id: Invalid input: expected number, received string")
        );
        assert_eq!(
            problem(linked_references(json!([[null, [{"uuid": "u"}]]]))),
            format!("{method} [0][1][0].id: Invalid input: expected number, received undefined")
        );
        assert_eq!(
            problem(linked_references(json!([[null, [{"id": 1, "uuid": "u", "page": {"name": 5}}]]]))),
            format!("{method} [0][1][0].page.name: Invalid input: expected string, received number")
        );
        assert_eq!(
            problem(linked_references(json!([[null, [{"id": 1, "uuid": "u", "refs": {}}]]]))),
            format!("{method} [0][1][0].refs: Invalid input: expected array, received object")
        );
        assert_eq!(
            problem(linked_references(json!([[null, [], 3]]))),
            format!("{method} [0]: Too big: expected array to have <2 items")
        );
    }

    #[test]
    fn block_rows_skip_a_null_cell_and_check_the_rest() {
        let rows = block_rows(json!([[null], [{"id": 1, "uuid": "u"}]])).unwrap().unwrap();
        assert_eq!(rows[0], None);
        assert_eq!(rows[1].as_ref().unwrap()["uuid"], "u");
        assert_eq!(
            problem(block_rows(json!([[{"id": 1}]]))),
            format!("{DATALOG_METHOD} [0][0].uuid: Invalid input: expected string, received undefined")
        );
    }
}
