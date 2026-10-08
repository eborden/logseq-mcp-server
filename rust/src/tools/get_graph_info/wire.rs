//! What `logseq.App.getCurrentGraph` answers (`graphInfoSchema` in `src/response-schemas.ts`).

use serde_json::Value;

use crate::wire::{Reader, ResponseError, to_error};

/// The method the answer comes from, as a response error names it.
pub const METHOD: &str = "logseq.App.getCurrentGraph";

/// `responses.graphInfo`: `null`, or an object whose `url`, `name` and `path` are text when
/// present. The answer is returned as it came: other keys pass, and key order is LogSeq's.
pub fn graph_info(answer: &Value) -> Result<Option<&Value>, ResponseError> {
    if answer.is_null() {
        return Ok(None);
    }
    let mut reader = Reader::default();
    let checked = (|| {
        let map = reader.object(Some(answer))?;
        reader.string(map, "url")?;
        reader.string(map, "name")?;
        reader.string(map, "path")?;
        Ok(())
    })();
    checked.map(|()| Some(answer)).map_err(|issue| to_error(METHOD, issue))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn problem(answer: Value) -> String {
        let error = graph_info(&answer).unwrap_err();
        format!("{}: {}: {}", error.method, error.path, error.problem)
    }

    #[test]
    fn null_is_its_own_case_and_an_object_passes_as_it_came() {
        assert_eq!(graph_info(&json!(null)).unwrap(), None);
        let answer = json!({"path": "/g", "extra": 1});
        assert_eq!(graph_info(&answer).unwrap(), Some(&answer));
        assert!(graph_info(&json!({})).unwrap().is_some());
    }

    #[test]
    fn a_wrong_shape_is_an_error_naming_the_path_and_no_value() {
        assert_eq!(problem(json!([])), "logseq.App.getCurrentGraph: (response): Invalid input: expected object, received array");
        assert_eq!(problem(json!({"name": 3})), "logseq.App.getCurrentGraph: name: Invalid input: expected string, received number");
        assert_eq!(problem(json!({"path": null})), "logseq.App.getCurrentGraph: path: Invalid input: expected string, received null");
    }
}
