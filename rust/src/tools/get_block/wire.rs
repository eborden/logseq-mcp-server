//! What `logseq.Editor.getBlock` answers (`responses.block` in `src/response-schemas.ts`): a
//! block, or `null` when there is none. The block is returned as LogSeq sent it, since the
//! result carries it whole (BR-0004).

use serde_json::Value;

use crate::wire::{Reader, ResponseError, to_error};

/// The method the answer comes from, as a response error names it.
pub const METHOD: &str = "logseq.Editor.getBlock";

/// `null`, or the block, checked.
pub fn block(answer: &Value) -> Result<Option<Value>, ResponseError> {
    if answer.is_null() {
        return Ok(None);
    }
    Reader::default().check_block(Some(answer)).map_err(|issue| to_error(METHOD, issue))?;
    Ok(Some(answer.clone()))
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
        assert_eq!((error.method.as_str(), error.path.as_str()), ("logseq.Editor.getBlock", "uuid"));
        let error = block(&json!([])).unwrap_err();
        assert_eq!(error.path, "(response)");
    }
}
