//! `ResultMeta`: how a result says it was cut or partial (BR-0006), and the structured result an
//! ambiguous page name returns.
//!
//! Key order is part of the output (ADR-0009): `hasMore`, `warnings`, then `totals`.

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::errors::{AmbiguousPage, Candidate};
use crate::tool::result_value;

/// A warning: the result was cut or is partial, and what to do about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResultWarning {
    pub code: String,
    pub message: String,
    /// A way to get the rest. Its presence is what makes `hasMore` true.
    #[serde(rename = "howToFetchAll", skip_serializing_if = "Option::is_none")]
    pub how_to_fetch_all: Option<String>,
}

impl ResultWarning {
    pub fn new(code: &str, message: String) -> Self {
        ResultWarning { code: code.to_owned(), message, how_to_fetch_all: None }
    }
}

/// `buildResultMeta`: `hasMore` is derived from the warnings, true when any of them offers a way
/// to fetch the rest, so it can't be set without one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResultMeta {
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    pub warnings: Vec<ResultWarning>,
    /// Counts of what there was in total, by name
    pub totals: Map<String, Value>,
}

impl ResultMeta {
    pub fn new(warnings: Vec<ResultWarning>, totals: &[(&str, usize)]) -> Self {
        ResultMeta {
            has_more: warnings.iter().any(|warning| warning.how_to_fetch_all.is_some()),
            warnings,
            totals: totals.iter().map(|(name, count)| ((*name).to_owned(), json!(count))).collect(),
        }
    }
}

/// What the MCP layer returns for an ambiguous name: a result, not an error. `totals.candidates`
/// is the real count, and a list cut at the maximum adds a `candidates_truncated` warning saying
/// the maximum was reached, that the rest can't be fetched in one call, and how to narrow the
/// search. `hasMore` stays false, because no parameter can be raised to get the rest.
pub fn ambiguous_page_result(error: &AmbiguousPage) -> String {
    let mut warnings = vec![ResultWarning::new("ambiguous_page", error.to_string())];
    if let Some(note) = error.truncation_note() {
        warnings.push(ResultWarning::new("candidates_truncated", note));
    }
    let candidates: Vec<Value> = error.candidates.iter().map(candidate).collect();
    let meta = ResultMeta::new(warnings, &[("candidates", error.total_candidates)]);
    let mut result = Map::new();
    result.insert("ambiguous".into(), json!(true));
    result.insert("pageName".into(), json!(error.page_name));
    result.insert("candidates".into(), Value::Array(candidates));
    result.insert("totalCandidates".into(), json!(error.total_candidates));
    result.insert("hasMore".into(), json!(meta.has_more));
    result.insert("warnings".into(), serde_json::to_value(&meta.warnings).expect("warnings serialize"));
    result.insert("totals".into(), Value::Object(meta.totals));
    Value::Object(result).to_string()
}

/// One candidate page as the results show it (`PageCandidate`): `name`, `originalName`, `matchedBy`,
/// `reason`.
pub fn candidate(candidate: &Candidate) -> Value {
    result_value(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::MatchedBy;

    #[test]
    fn has_more_follows_the_warnings_and_cannot_be_set_alone() {
        let plain = ResultMeta::new(vec![ResultWarning::new("a", "m".into())], &[("blocks", 4)]);
        assert!(!plain.has_more);
        let with_fetch = ResultMeta::new(
            vec![ResultWarning { how_to_fetch_all: Some("Set limit".into()), ..ResultWarning::new("b", "m".into()) }],
            &[],
        );
        assert!(with_fetch.has_more);
        assert_eq!(
            serde_json::to_string(&plain).unwrap(),
            r#"{"hasMore":false,"warnings":[{"code":"a","message":"m"}],"totals":{"blocks":4}}"#
        );
    }

    #[test]
    fn an_ambiguous_result_is_a_result_with_the_candidates_and_a_warning() {
        let error = AmbiguousPage {
            page_name: "al".into(),
            candidates: vec![Candidate {
                name: "alice".into(),
                original_name: "Alice".into(),
                matched_by: MatchedBy::Alias,
                reason: "declares alias \"al\"".into(),
            }],
            total_candidates: 1,
        };
        let text = ambiguous_page_result(&error);
        assert!(text.starts_with(
            r#"{"ambiguous":true,"pageName":"al","candidates":[{"name":"alice","originalName":"Alice","matchedBy":"alias","reason":"declares alias \"al\""}],"totalCandidates":1,"hasMore":false,"warnings":[{"code":"ambiguous_page","message":"#
        ));
        assert!(text.ends_with(r#""totals":{"candidates":1}}"#));
    }

    #[test]
    fn a_cut_list_adds_a_second_warning_and_still_has_no_more_to_fetch() {
        let error = AmbiguousPage { page_name: "x".into(), candidates: vec![], total_candidates: 12 };
        let value: Value = serde_json::from_str(&ambiguous_page_result(&error)).unwrap();
        assert_eq!(value["warnings"][1]["code"], "candidates_truncated");
        assert_eq!(value["hasMore"], false);
        assert_eq!(value["totals"]["candidates"], 12);
    }
}
