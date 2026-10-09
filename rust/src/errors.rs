//! What can stop a tool, as one type (the Rust side of `src/errors.ts`). The server turns each
//! into the TypeScript server's result: an [`AmbiguousPage`] into a structured result, anything
//! else into `{"error": message}` with `isError`. The messages match `src/errors.ts` word for word.
//!
//! None of them shows a value from the user's graph beyond the page name they asked for
//! (ADR-0004), and none includes the token (ADR-0003).

use std::fmt;

use serde::Serialize;

use crate::client::LogseqError;
use crate::edn::InvalidValue;
use crate::js;
use crate::wire::ResponseError;

#[derive(Debug)]
pub enum ToolError {
    /// The connection to LogSeq, or LogSeq's own error.
    Logseq(LogseqError),
    /// LogSeq answered in a shape this server doesn't read (#202).
    Response(ResponseError),
    /// A tool argument is not what the tool takes (`InvalidParameterError`).
    InvalidParameter(InvalidParameter),
    /// No page by that name, alias, date or namespace leaf.
    PageNotFound(PageNotFound),
    /// Several pages match and none is an exact name.
    AmbiguousPage(AmbiguousPage),
    /// A value that a query can't carry (a `:db/id` that isn't one).
    InvalidValue(InvalidValue),
    /// A page the resolver found has no `:db/id` (`groundIds` throws on `undefined`).
    PageWithoutId,
    /// A plain `Error` a tool throws with a fixed message, e.g. `Failed to retrieve graph information`.
    Failed(String),
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ToolError::Logseq(error) => error.fmt(f),
            ToolError::Response(error) => error.fmt(f),
            ToolError::InvalidParameter(error) => error.fmt(f),
            ToolError::PageNotFound(error) => error.fmt(f),
            ToolError::AmbiguousPage(error) => error.fmt(f),
            ToolError::InvalidValue(error) => error.fmt(f),
            ToolError::Failed(message) => f.write_str(message),
            // PARITY(#299): `undefined`, the JavaScript word for a missing id, in `groundIds`' message — drop
            // if Rust becomes the only server.
            ToolError::PageWithoutId => f.write_str("Invalid entity id: undefined (expected an integer)"),
        }
    }
}

impl std::error::Error for ToolError {}

impl From<LogseqError> for ToolError {
    fn from(error: LogseqError) -> Self {
        ToolError::Logseq(error)
    }
}

impl From<ResponseError> for ToolError {
    fn from(error: ResponseError) -> Self {
        ToolError::Response(error)
    }
}

impl From<InvalidParameter> for ToolError {
    fn from(error: InvalidParameter) -> Self {
        ToolError::InvalidParameter(error)
    }
}

impl From<InvalidValue> for ToolError {
    fn from(error: InvalidValue) -> Self {
        ToolError::InvalidValue(error)
    }
}

/// `InvalidParameterError`: the parameter, what was sent, what was expected and an example.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidParameter {
    /// The parameter's name
    pub param: String,
    /// What was sent, already written (`missing`, or JSON)
    pub value: String,
    pub expected: String,
    pub example: Option<String>,
}

impl fmt::Display for InvalidParameter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Invalid parameter '{}': {}\n\nExpected: {}", self.param, self.value, self.expected)?;
        if let Some(example) = self.example.as_deref().filter(|example| !example.is_empty()) {
            write!(f, "\nExample: {example}")?;
        }
        Ok(())
    }
}

/// `PageNotFoundError`: guidance with the closest names, then the tools to find the page with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageNotFound {
    pub page_name: String,
    pub suggestions: Vec<String>,
}

impl fmt::Display for PageNotFound {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let closest = if self.suggestions.is_empty() {
            String::new()
        } else {
            format!(" Closest: {}.", self.suggestions.join(", "))
        };
        write!(
            f,
            "No page {}.{closest} Try logseq_search_blocks to find it by content, or logseq_list_pages (name_contains) to browse names.",
            json_string(&self.page_name)
        )
    }
}

/// How a name matched a page, for `matchedBy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchedBy {
    Name,
    Alias,
    JournalDate,
    NamespaceLeaf,
}

impl MatchedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchedBy::Name => "name",
            MatchedBy::Alias => "alias",
            MatchedBy::JournalDate => "journal-date",
            MatchedBy::NamespaceLeaf => "namespace-leaf",
        }
    }
}

/// One page a name could refer to (`PageCandidate`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Candidate {
    /// Lowercased `:block/name`, safe to pass back to any page-taking tool
    pub name: String,
    #[serde(rename = "originalName")]
    pub original_name: String,
    #[serde(rename = "matchedBy")]
    pub matched_by: MatchedBy,
    /// Why this page matched, in words
    pub reason: String,
}

/// Most candidates listed for an ambiguous name; the rest are only counted.
pub const MAX_CANDIDATES: usize = 10;

/// `AmbiguousPageError`. The server returns it as a result, not as a failure: the candidates tell
/// the caller which exact name to repeat the call with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmbiguousPage {
    pub page_name: String,
    pub candidates: Vec<Candidate>,
    /// Matching pages in total; more than `candidates.len()` when the list was capped
    pub total_candidates: usize,
}

impl AmbiguousPage {
    /// Says that the list was cut at its maximum, that the rest can't be fetched in one call, and
    /// how to narrow the search. Set only when the list was cut, so a cut list is never silent.
    pub fn truncation_note(&self) -> Option<String> {
        (self.total_candidates > self.candidates.len()).then(|| {
            format!(
                "Showing {} of {}, the most this lists; the rest can't be fetched in one call. \
                 To narrow it down, call logseq_list_pages with name_contains set to part of the page name you mean, \
                 or use its full namespaced name.",
                self.candidates.len(),
                self.total_candidates
            )
        })
    }
}

impl fmt::Display for AmbiguousPage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let listed: Vec<String> =
            self.candidates.iter().map(|c| format!("{} ({})", json_string(&c.original_name), c.reason)).collect();
        let more = match self.total_candidates.checked_sub(self.candidates.len()) {
            Some(rest) if rest > 0 => format!(" and {rest} more"),
            _ => String::new(),
        };
        write!(
            f,
            "{} matches {} pages: {}{more}. ",
            json_string(&self.page_name),
            self.total_candidates,
            listed.join("; ")
        )?;
        if let Some(note) = self.truncation_note() {
            write!(f, "{note} ")?;
        }
        f.write_str("Repeat the call with the exact name of one of them.")
    }
}

/// `JSON.stringify(text)`.
fn json_string(text: &str) -> String {
    js::json_stringify(&serde_json::Value::String(text.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(name: &str, original: &str, reason: &str) -> Candidate {
        Candidate { name: name.into(), original_name: original.into(), matched_by: MatchedBy::Alias, reason: reason.into() }
    }

    #[test]
    fn a_missing_page_names_the_closest_pages_and_the_tools_to_find_it() {
        let error = PageNotFound { page_name: "Alce \"x\"".into(), suggestions: vec!["Alice".into(), "Alice Notes".into()] };
        assert_eq!(
            error.to_string(),
            "No page \"Alce \\\"x\\\"\". Closest: Alice, Alice Notes. Try logseq_search_blocks to find it by content, \
             or logseq_list_pages (name_contains) to browse names."
        );
        let none = PageNotFound { page_name: "zzz".into(), suggestions: vec![] };
        assert_eq!(
            none.to_string(),
            "No page \"zzz\". Try logseq_search_blocks to find it by content, or logseq_list_pages (name_contains) to browse names."
        );
    }

    #[test]
    fn an_ambiguous_name_lists_its_candidates() {
        let error = AmbiguousPage {
            page_name: "al".into(),
            candidates: vec![candidate("alice", "Alice", "declares alias \"al\""), candidate("alice notes", "Alice Notes", "declares alias \"al\"")],
            total_candidates: 2,
        };
        assert_eq!(
            error.to_string(),
            "\"al\" matches 2 pages: \"Alice\" (declares alias \"al\"); \"Alice Notes\" (declares alias \"al\"). \
             Repeat the call with the exact name of one of them."
        );
        assert_eq!(error.truncation_note(), None);
    }

    #[test]
    fn a_cut_candidate_list_says_so() {
        let error = AmbiguousPage {
            page_name: "x".into(),
            candidates: vec![candidate("a", "A", "r")],
            total_candidates: 12,
        };
        assert_eq!(
            error.to_string(),
            "\"x\" matches 12 pages: \"A\" (r) and 11 more. Showing 1 of 12, the most this lists; the rest can't be fetched in one call. \
             To narrow it down, call logseq_list_pages with name_contains set to part of the page name you mean, or use its full namespaced name. \
             Repeat the call with the exact name of one of them."
        );
    }

    #[test]
    fn an_invalid_parameter_has_an_optional_example() {
        let error = InvalidParameter {
            param: "page_name".into(),
            value: "42".into(),
            expected: "a string, not a number".into(),
            example: Some("page_name: \"...\"".into()),
        };
        assert_eq!(error.to_string(), "Invalid parameter 'page_name': 42\n\nExpected: a string, not a number\nExample: page_name: \"...\"");
        let bare = InvalidParameter { example: None, ..error };
        assert_eq!(bare.to_string(), "Invalid parameter 'page_name': 42\n\nExpected: a string, not a number");
    }

    #[test]
    fn a_page_without_an_id_is_the_error_group_ids_throws() {
        assert_eq!(ToolError::PageWithoutId.to_string(), "Invalid entity id: undefined (expected an integer)");
    }
}
