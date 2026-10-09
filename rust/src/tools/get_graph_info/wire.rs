//! What `logseq.App.getCurrentGraph` answers.

use serde_json::Value;

use crate::wire::{Object, ResponseError, parse};

/// The method the answer comes from, as a response error names it.
pub const METHOD: &str = "logseq.App.getCurrentGraph";

/// `null`, or the graph LogSeq reports. The tool hands it on as it came (its `url`, `name` and `path`, and any other
/// key, in LogSeq's order) and reads none of its fields, so none is checked: only that it is an object.
pub fn graph_info(answer: &Value) -> Result<Option<&Value>, ResponseError> {
    Ok(parse::<Option<Object>>(METHOD, answer)?.map(|_| answer))
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
    fn a_field_nothing_reads_may_hold_anything() {
        for answer in [json!({"name": 3}), json!({"url": null, "path": [1], "name": {"a": 1}})] {
            assert_eq!(graph_info(&answer).unwrap(), Some(&answer), "{answer}");
        }
    }

    #[test]
    fn an_answer_that_is_not_an_object_is_an_error_naming_the_method_and_no_value() {
        assert_eq!(problem(json!([])), "logseq.App.getCurrentGraph: answer: expected an object, got a list");
        assert_eq!(problem(json!("secret")), "logseq.App.getCurrentGraph: answer: expected an object, got a string");
        assert_eq!(problem(json!(7)), "logseq.App.getCurrentGraph: answer: expected an object, got a number");
    }
}
