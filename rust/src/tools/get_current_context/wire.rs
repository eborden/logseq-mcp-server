//! What the current context reads from LogSeq: the three Editor answers and the page lookup
//! (`responses.pageOrBlock`, `responses.block`, `responses.blocks` and `responses.nullablePageRows`
//! in `src/response-schemas.ts`). Each is checked against the TypeScript schema and returned as the
//! JSON LogSeq sent, since the slim output reads fields of an entity whichever way they are spelled.
//! `null` is a case of its own (BR-0011): each parser answers `None` for it and the tool decides.

use serde_json::Value;

use crate::wire::{DATALOG_METHOD, Part, Reader, ResponseError, to_error};

pub const GET_CURRENT_PAGE: &str = "logseq.Editor.getCurrentPage";
pub const GET_CURRENT_BLOCK: &str = "logseq.Editor.getCurrentBlock";
pub const GET_SELECTED_BLOCKS: &str = "logseq.Editor.getSelectedBlocks";

/// `responses.pageOrBlock`: `null`, or an object that is a page when it has a `name` key and a
/// block when it hasn't. It is checked as the one it is, so a mismatch reports its own path
/// (`originalName`, `content`) and not a whole union's.
pub fn current_page(answer: Value) -> Result<Option<Value>, ResponseError> {
    if answer.is_null() {
        return Ok(None);
    }
    let mut reader = Reader::default();
    let checked = match &answer {
        // `value.name !== undefined`: JSON has no `undefined`, so a `null` name is a name (and not text)
        Value::Object(map) if map.contains_key("name") => reader.check_editor_page(Some(&answer)),
        Value::Object(_) => reader.check_block(Some(&answer)),
        _ => Err(reader.issue("expected an object")),
    };
    checked.map(|()| Some(answer)).map_err(|issue| to_error(GET_CURRENT_PAGE, issue))
}

/// `responses.block`: `null`, or a block.
pub fn current_block(answer: Value) -> Result<Option<Value>, ResponseError> {
    if answer.is_null() {
        return Ok(None);
    }
    Reader::default().check_block(Some(&answer)).map(|()| Some(answer)).map_err(|issue| to_error(GET_CURRENT_BLOCK, issue))
}

/// `responses.blocks`: `null`, or a list of blocks.
pub fn selected_blocks(answer: Value) -> Result<Option<Vec<Value>>, ResponseError> {
    let mut reader = Reader::default();
    let items = match answer {
        Value::Null => return Ok(None),
        Value::Array(items) => items,
        other => return Err(to_error(GET_SELECTED_BLOCKS, reader.mismatch("array", Some(&other)))),
    };
    for (i, item) in items.iter().enumerate() {
        reader.at(Part::Index(i), |r| r.check_block(Some(item))).map_err(|issue| to_error(GET_SELECTED_BLOCKS, issue))?;
    }
    Ok(Some(items))
}

/// `responses.nullablePageRows`: `null`, or one row per page, each `[page | null]`. A `null` cell is
/// `None`, which the lookup skips.
pub fn page_rows(answer: &Value) -> Result<Option<Vec<Option<Value>>>, ResponseError> {
    let mut reader = Reader::default();
    reader
        .rows(answer, 1, |r, cells| {
            r.at(Part::Index(0), |r| match cells.first() {
                Some(Value::Null) => Ok(None),
                cell => {
                    r.check_pulled_page(cell)?;
                    Ok(cell.cloned())
                }
            })
        })
        .map_err(|issue| to_error(DATALOG_METHOD, issue))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn problem<T: std::fmt::Debug>(result: Result<T, ResponseError>) -> String {
        let error = result.unwrap_err();
        format!("{}: {}: {}", error.method, error.path, error.problem)
    }

    #[test]
    fn null_is_its_own_case_for_each_answer() {
        assert_eq!(current_page(json!(null)).unwrap(), None);
        assert_eq!(current_block(json!(null)).unwrap(), None);
        assert_eq!(selected_blocks(json!(null)).unwrap(), None);
        assert_eq!(page_rows(&json!(null)).unwrap(), None);
        assert_eq!(selected_blocks(json!([])).unwrap(), Some(vec![]));
        assert_eq!(page_rows(&json!([])).unwrap(), Some(vec![]));
    }

    #[test]
    fn the_open_page_is_checked_as_a_page_when_it_has_a_name_and_as_a_block_when_it_has_none() {
        let page = json!({"id": 1, "name": "alice", "originalName": "Alice", "extra": true});
        assert_eq!(current_page(page.clone()).unwrap(), Some(page));
        let block = json!({"id": 2, "uuid": "u", "page": {"id": 1}});
        assert_eq!(current_page(block.clone()).unwrap(), Some(block));
        assert_eq!(
            problem(current_page(json!({"id": 1, "name": "a", "originalName": 3}))),
            "logseq.Editor.getCurrentPage: originalName: Invalid input: expected string, received number"
        );
        assert_eq!(
            problem(current_page(json!({"id": 1, "uuid": "u", "name": null}))),
            "logseq.Editor.getCurrentPage: name: Invalid input: expected string, received null"
        );
        assert_eq!(
            problem(current_page(json!({"id": 2, "page": {"id": 1}}))),
            "logseq.Editor.getCurrentPage: uuid: Invalid input: expected string, received undefined"
        );
    }

    #[test]
    fn an_open_page_that_is_not_an_object_is_one_error_at_the_top() {
        for answer in [json!(5), json!([]), json!("Alice"), json!(true)] {
            assert_eq!(problem(current_page(answer)), "logseq.Editor.getCurrentPage: (response): expected an object");
        }
    }

    #[test]
    fn a_block_in_the_wrong_shape_names_its_path_and_no_value() {
        assert_eq!(
            problem(current_block(json!({"id": 1, "uuid": "u", "content": 5}))),
            "logseq.Editor.getCurrentBlock: content: Invalid input: expected string, received number"
        );
        assert_eq!(
            problem(selected_blocks(json!({"id": 1}))),
            "logseq.Editor.getSelectedBlocks: (response): Invalid input: expected array, received object"
        );
        assert_eq!(
            problem(selected_blocks(json!([{"id": 1, "uuid": "u"}, {"id": 2, "uuid": "v", "page": {"id": "x"}}]))),
            "logseq.Editor.getSelectedBlocks: [1].page.id: Invalid input: expected number, received string"
        );
    }

    #[test]
    fn a_lookup_row_skips_a_null_cell_and_checks_a_page() {
        let page = json!({"id": 9, "name": "alice", "original-name": "Alice"});
        assert_eq!(page_rows(&json!([[null], [page.clone()]])).unwrap(), Some(vec![None, Some(page)]));
        assert_eq!(problem(page_rows(&json!([[]]))), "logseq.DB.datascriptQuery: [0][0]: Invalid input: expected object, received undefined");
        assert_eq!(
            problem(page_rows(&json!([[{"name": 7}]]))),
            "logseq.DB.datascriptQuery: [0][0].name: Invalid input: expected string, received number"
        );
        assert_eq!(problem(page_rows(&json!([[{}, 1]]))), "logseq.DB.datascriptQuery: [0]: Too big: expected array to have <1 items");
        assert_eq!(problem(page_rows(&json!({}))), "logseq.DB.datascriptQuery: (response): Invalid input: expected array, received object");
    }
}
