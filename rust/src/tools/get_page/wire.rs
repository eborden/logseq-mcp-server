//! What `logseq.Editor.getPage` and `getPageBlocksTree` answer. The page and its blocks are returned as
//! LogSeq sent them, since the result carries them whole (BR-0004).

use serde_json::Value;

use crate::entity::shape::{Block, EditorPage};
use crate::wire::{ResponseError, parse, sent_list};

/// The method the page comes from, as a response error names it.
pub const PAGE_METHOD: &str = "logseq.Editor.getPage";
/// The method the blocks come from, as a response error names it.
pub const BLOCKS_METHOD: &str = "logseq.Editor.getPageBlocksTree";

/// `null`, or the page, checked as an Editor API page (camelCase keys).
pub fn page(answer: &Value) -> Result<Option<Value>, ResponseError> {
    Ok(parse::<Option<EditorPage>>(PAGE_METHOD, answer)?.map(|_| answer.clone()))
}

/// `null`, or the page's top-level blocks, each checked as a block.
pub fn blocks(answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
    sent_list::<Block>(BLOCKS_METHOD, answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn null_is_no_page_and_a_page_comes_back_as_sent() {
        assert_eq!(page(&json!(null)).unwrap(), None);
        let sent = json!({"id": 1, "name": "alice", "originalName": "Alice", "file": {"id": 5}, "extra": [1]});
        assert_eq!(page(&sent).unwrap(), Some(sent));
    }

    #[test]
    fn something_that_is_not_a_page_is_an_error_naming_the_method_and_path() {
        let error = page(&json!({"id": 1})).unwrap_err();
        assert_eq!((error.method.as_str(), error.path.as_str()), ("logseq.Editor.getPage", "answer.name"));
        // a pulled page's keys are not an Editor API page's: it needs `name` and `id`, which a pull also has
        assert!(page(&json!({"id": 1, "name": "a", "original-name": "A"})).is_ok());
    }

    #[test]
    fn a_field_nothing_reads_may_hold_anything() {
        // the uuid, namespace and times of a page are carried to the result and read by no code
        let sent = json!({"id": 1, "name": "a", "uuid": 5, "namespace": "x", "createdAt": "never", "updatedAt": null});
        assert_eq!(page(&sent).unwrap(), Some(sent));
        // the ones that are read are checked
        assert_eq!(page(&json!({"id": 1, "name": "a", "originalName": 4})).unwrap_err().path, "answer.originalName");
        assert_eq!(page(&json!({"id": 1, "name": "a", "file": null})).unwrap_err().path, "answer.file");
        assert_eq!(page(&json!({"id": 1, "name": "a", "alias": [{"id": "x"}]})).unwrap_err().path, "answer.alias[0].id");
        assert_eq!(page(&json!({"id": 1, "name": "a", "journal?": 1})).unwrap_err().path, "answer.journal?");
    }

    #[test]
    fn blocks_are_null_or_a_list_of_whole_blocks() {
        assert_eq!(blocks(&json!(null)).unwrap(), None);
        assert_eq!(blocks(&json!([])).unwrap(), Some(vec![]));
        let sent = json!([{"id": 1, "uuid": "u", "children": [{"id": 2, "uuid": "v"}]}]);
        assert_eq!(blocks(&sent).unwrap().unwrap().len(), 1);
        let error = blocks(&json!([{"id": 1, "uuid": "u"}, {"id": 2}])).unwrap_err();
        assert_eq!((error.method.as_str(), error.path.as_str()), ("logseq.Editor.getPageBlocksTree", "answer[1].uuid"));
        assert_eq!(blocks(&json!({})).unwrap_err().path, "answer");
    }
}
