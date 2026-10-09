//! What the current context reads from LogSeq: the three Editor answers and the page lookup
//! Each is checked against its wire type and returned as the
//! JSON LogSeq sent, since the slim output reads fields of an entity whichever way they are spelled.
//! `null` is a case of its own (BR-0011): each parser answers `None` for it and the tool decides.

use serde_json::Value;

use crate::entity::shape::{Block, EditorPage, PulledPage};
use crate::wire::{DATALOG_METHOD, Object, ResponseError, check, parse, sent_cells, sent_list};

pub const GET_CURRENT_PAGE: &str = "logseq.Editor.getCurrentPage";
pub const GET_CURRENT_BLOCK: &str = "logseq.Editor.getCurrentBlock";
pub const GET_SELECTED_BLOCKS: &str = "logseq.Editor.getSelectedBlocks";

/// `responses.pageOrBlock`: `null`, or an object that is a page when it has a `name` key and a
/// block when it hasn't. It is checked as the one it is, so a mismatch reports its own path
/// (`originalName`, `content`) and not a whole union's.
pub fn current_page(answer: Value) -> Result<Option<Value>, ResponseError> {
    let Some(Object) = parse::<Option<Object>>(GET_CURRENT_PAGE, &answer)? else { return Ok(None) };
    // `value.name !== undefined`: JSON has no `undefined`, so a `null` name is a name (and not text)
    match answer.get("name") {
        Some(_) => check::<EditorPage>(GET_CURRENT_PAGE, &answer)?,
        None => check::<Block>(GET_CURRENT_PAGE, &answer)?,
    }
    Ok(Some(answer))
}

/// `responses.block`: `null`, or a block.
pub fn current_block(answer: Value) -> Result<Option<Value>, ResponseError> {
    Ok(parse::<Option<Block>>(GET_CURRENT_BLOCK, &answer)?.map(|_| answer))
}

/// `responses.blocks`: `null`, or a list of blocks.
pub fn selected_blocks(answer: Value) -> Result<Option<Vec<Value>>, ResponseError> {
    sent_list::<Block>(GET_SELECTED_BLOCKS, &answer)
}

/// `responses.nullablePageRows`: `null`, or one row per page, each `[page | null]`. A `null` cell is
/// `None`, which the lookup skips.
pub fn page_rows(answer: &Value) -> Result<Option<Vec<Option<Value>>>, ResponseError> {
    sent_cells::<PulledPage>(DATALOG_METHOD, answer)
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
            "logseq.Editor.getCurrentPage: answer.originalName: expected a string, got a number"
        );
        assert_eq!(
            problem(current_page(json!({"id": 1, "uuid": "u", "name": null}))),
            "logseq.Editor.getCurrentPage: answer.name: expected a string, got null"
        );
        assert_eq!(problem(current_page(json!({"id": 2, "page": {"id": 1}}))), "logseq.Editor.getCurrentPage: answer.uuid: required, but missing");
    }

    #[test]
    fn an_open_page_that_is_not_an_object_is_one_error_at_the_top() {
        for (answer, found) in [(json!(5), "a number"), (json!([]), "a list"), (json!("Alice"), "a string"), (json!(true), "a boolean")] {
            assert_eq!(problem(current_page(answer)), format!("logseq.Editor.getCurrentPage: answer: expected an object, got {found}"));
        }
    }

    #[test]
    fn a_block_in_the_wrong_shape_names_its_path_and_no_value() {
        assert_eq!(
            problem(current_block(json!({"id": 1, "uuid": "u", "content": 5}))),
            "logseq.Editor.getCurrentBlock: answer.content: expected a string, got a number"
        );
        assert_eq!(
            problem(selected_blocks(json!({"id": 1}))),
            "logseq.Editor.getSelectedBlocks: answer: expected a list, got an object"
        );
        assert_eq!(
            problem(selected_blocks(json!([{"id": 1, "uuid": "u"}, {"id": 2, "uuid": "v", "page": {"id": "x"}}]))),
            "logseq.Editor.getSelectedBlocks: answer[1].page.id: expected a whole number, got a string"
        );
    }

    #[test]
    fn a_lookup_row_skips_a_null_cell_and_checks_a_page() {
        let page = json!({"id": 9, "name": "alice", "original-name": "Alice"});
        assert_eq!(page_rows(&json!([[null], [page.clone()]])).unwrap(), Some(vec![None, Some(page)]));
        assert_eq!(problem(page_rows(&json!([[]]))), "logseq.DB.datascriptQuery: answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(page_rows(&json!([[{"name": 7}]]))), "logseq.DB.datascriptQuery: answer[0][0].name: expected a string, got a number");
        assert_eq!(problem(page_rows(&json!([[{}, 1]]))), "logseq.DB.datascriptQuery: answer[0]: the row has more cells than this server reads");
        assert_eq!(problem(page_rows(&json!({}))), "logseq.DB.datascriptQuery: answer: expected a list, got an object");
    }

    #[test]
    fn a_page_field_nothing_reads_may_hold_anything() {
        let page = json!({"id": 9, "name": "alice", "uuid": 3, "created-at": "x", "updated-at": null, "properties-text-values": [1]});
        assert_eq!(page_rows(&json!([[page.clone()]])).unwrap(), Some(vec![Some(page)]));
    }
}
