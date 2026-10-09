//! What `logseq.Editor.getBlock` answers (`responses.block` in `src/response-schemas.ts`): a
//! block, or `null` when there is none. The block is returned as LogSeq sent it, since the
//! result carries it whole (BR-0004).

use serde_json::Value;

use crate::entity::shape::Block;
use crate::wire::{ResponseError, parse};

/// The method the answer comes from, as a response error names it.
pub const METHOD: &str = "logseq.Editor.getBlock";

/// `null`, or the block, checked.
pub fn block(answer: &Value) -> Result<Option<Value>, ResponseError> {
    Ok(parse::<Option<Block>>(METHOD, answer)?.map(|_| answer.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn null_is_no_block_and_a_block_comes_back_as_sent() {
        assert_eq!(block(&json!(null)).unwrap(), None);
        let sent = json!({"id": 1, "uuid": "u", "content": "x", "children": [["uuid", "c"]], "extra": 1});
        assert_eq!(block(&sent).unwrap(), Some(sent));
    }

    #[test]
    fn something_that_is_not_a_block_is_an_error_naming_the_method_and_path() {
        let error = block(&json!({"id": 1})).unwrap_err();
        assert_eq!((error.method.as_str(), error.path.as_str(), error.problem.as_str()), ("logseq.Editor.getBlock", "answer.uuid", "required, but missing"));
        let error = block(&json!([])).unwrap_err();
        assert_eq!((error.path.as_str(), error.problem.as_str()), ("answer", "expected an object, got a list"));
    }

    #[test]
    fn a_field_the_code_reads_must_be_what_it_reads() {
        let path = |extra: Value| {
            let mut sent = json!({"id": 1, "uuid": "u"});
            sent.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            block(&sent).unwrap_err().path
        };
        assert_eq!(path(json!({"content": 5})), "answer.content");
        assert_eq!(path(json!({"page": {"id": "x"}})), "answer.page.id");
        assert_eq!(path(json!({"parent": null})), "answer.parent");
        assert_eq!(path(json!({"properties": []})), "answer.properties");
        assert_eq!(path(json!({"refs": {}})), "answer.refs");
        assert_eq!(path(json!({"refs": [{"name": 1}]})), "answer.refs[0].name");
    }
}
