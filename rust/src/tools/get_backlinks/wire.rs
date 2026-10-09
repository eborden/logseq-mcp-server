//! What the backlinks tool reads from LogSeq: the Editor API's linked references
//! (`responses.linkedReferences`) and the blocks of the aliased Datalog query
//! (`responses.nullableBlockRows`).
//!
//! Both are checked against the TypeScript schemas and then kept as the values LogSeq sent: the
//! tool's output carries each entity as it came (BR-0004), so a typed copy would only be thrown
//! away. The schema checks are `entity.rs`'s.

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use crate::entity::shape::{Block, PageLike};
use crate::tool::result_value;
use crate::wire::{DATALOG_METHOD, ResponseError, parse, sent_cells};

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
        result_value(&self)
    }
}

/// `[page, blocks]`: a tuple is an array of two, the page first (BR-0013 keeps an entity as LogSeq sent it).
impl Serialize for Backlink {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        (&self.page, &self.blocks).serialize(serializer)
    }
}

/// `responses.linkedReferences`: `[page | null, blocks]` per source page, or `null`.
pub fn linked_references(answer: Value) -> Result<Option<Vec<Backlink>>, ResponseError> {
    if parse::<Option<Vec<(Option<PageLike>, Vec<Block>)>>>(LINKED_REFERENCES_METHOD, &answer)?.is_none() {
        return Ok(None);
    }
    // The rows were read as `[page | null, blocks]`, so each is a list of those two cells. Said again here, as an
    // error and not a panic, so that a change to the cells above can't go unmatched by this.
    let backlinks: Result<Vec<Backlink>, ResponseError> = crate::wire::items(&answer)
        .iter()
        .map(|row| match row.as_array().map(Vec::as_slice) {
            Some([page, Value::Array(blocks)]) => Ok(Backlink { page: page.clone(), blocks: blocks.clone() }),
            _ => Err(ResponseError {
                method: LINKED_REFERENCES_METHOD.to_owned(),
                path: "answer".to_owned(),
                problem: "a row is not the page and the blocks that were read".to_owned(),
            }),
        })
        .collect();
    backlinks.map(Some)
}

/// `responses.nullableBlockRows`: `[block | null]` per row, or `null`. A `null` cell is `None`,
/// which the tool skips.
pub fn block_rows(answer: Value) -> Result<Option<Vec<Option<Map<String, Value>>>>, ResponseError> {
    let cells = sent_cells::<Block>(DATALOG_METHOD, &answer)?;
    Ok(cells.map(|cells| cells.into_iter().map(|cell| cell.and_then(|block| if let Value::Object(block) = block { Some(block) } else { None })).collect()))
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
        assert_eq!(problem(linked_references(json!({}))), format!("{method} answer: expected a list, got an object"));
        assert_eq!(problem(linked_references(json!([1]))), format!("{method} answer[0]: expected a row, got a number"));
        assert_eq!(problem(linked_references(json!([[null]]))), format!("{method} answer[0]: the row has fewer cells than this server reads"));
        assert_eq!(problem(linked_references(json!([[]]))), format!("{method} answer[0]: the row has fewer cells than this server reads"));
        assert_eq!(problem(linked_references(json!([[{"id": "a"}, []]]))), format!("{method} answer[0][0].id: expected a whole number, got a string"));
        assert_eq!(problem(linked_references(json!([[null, [{"uuid": "u"}]]]))), format!("{method} answer[0][1][0].id: required, but missing"));
        assert_eq!(
            problem(linked_references(json!([[null, [{"id": 1, "uuid": "u", "page": {"name": 5}}]]]))),
            format!("{method} answer[0][1][0].page.name: expected a string, got a number")
        );
        assert_eq!(
            problem(linked_references(json!([[null, [{"id": 1, "uuid": "u", "refs": {}}]]]))),
            format!("{method} answer[0][1][0].refs: expected a list, got an object")
        );
        assert_eq!(problem(linked_references(json!([[null, [], 3]]))), format!("{method} answer[0]: the row has more cells than this server reads"));
        assert_eq!(problem(linked_references(json!([[null, {}]]))), format!("{method} answer[0][1]: expected a list, got an object"));
    }

    #[test]
    fn a_source_page_field_nothing_reads_may_hold_anything() {
        let answer = json!([[{"id": 1, "uuid": 5, "namespace": [], "createdAt": "x", "created-at": null, "file": 3, "alias": "x"}, []]]);
        assert_eq!(linked_references(answer).unwrap().unwrap().len(), 1);
    }

    #[test]
    fn block_rows_skip_a_null_cell_and_check_the_rest() {
        let rows = block_rows(json!([[null], [{"id": 1, "uuid": "u"}]])).unwrap().unwrap();
        assert_eq!(rows[0], None);
        assert_eq!(rows[1].as_ref().unwrap()["uuid"], "u");
        assert_eq!(
            problem(block_rows(json!([[{"id": 1}]]))),
            format!("{DATALOG_METHOD} answer[0][0].uuid: required, but missing")
        );
    }
}
