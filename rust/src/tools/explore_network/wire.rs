//! What the concept network reads from LogSeq: the rows of its connected-pages query.

use serde::Deserialize;
use serde_json::Value;

use crate::wire::{DATALOG_METHOD, Id, ResponseError, parse};

/// What a row says about its pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
    /// Blocks on `source` that reference `connected`
    Outbound,
    /// Blocks on `connected` that reference `source`
    Inbound,
    /// Not a link: how many pages `connected` links (#498). Only a query that asks for it answers with one
    Degree,
}

/// One row of the connected-pages query:
/// `[sourceId, connectedId, name, originalName, isJournal, relType, count]`, and a snippet after the count when the
/// query asked for one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectedRow {
    /// The page whose links these are: a frontier page, or the group's id for a grouped query
    pub source: i64,
    pub connected: i64,
    /// `:block/name`, lowercase
    pub name: String,
    /// `:block/original-name`, `""` for a page that has none
    pub original_name: String,
    pub is_journal: bool,
    pub link: Link,
    /// How many blocks, or on a `degree` row how many pages
    pub count: i64,
    /// The text of one block of the pair, when the query asked for it. `""` on a `degree` row
    pub snippet: Option<String>,
}

/// The cells of a row, in the order the query returns them. Every one is read.
#[derive(Deserialize)]
struct Cells(Id, Id, String, String, bool, Direction, Id);

/// The cells of a row of the query that asks for snippets.
#[derive(Deserialize)]
struct SnippetCells(Id, Id, String, String, bool, Direction, Id, String);

#[derive(Deserialize)]
enum Direction {
    #[serde(rename = "outbound")]
    Outbound,
    #[serde(rename = "inbound")]
    Inbound,
    #[serde(rename = "degree")]
    Degree,
}

impl From<Direction> for Link {
    fn from(direction: Direction) -> Link {
        match direction {
            Direction::Outbound => Link::Outbound,
            Direction::Inbound => Link::Inbound,
            Direction::Degree => Link::Degree,
        }
    }
}

/// A row without a snippet, as the plain query answers it.
#[derive(Deserialize)]
#[serde(from = "Cells")]
struct Plain(ConnectedRow);

/// A row with a snippet.
#[derive(Deserialize)]
#[serde(from = "SnippetCells")]
struct Snippeted(ConnectedRow);

impl From<Cells> for Plain {
    fn from(Cells(source, connected, name, original_name, is_journal, direction, count): Cells) -> Self {
        Plain(ConnectedRow {
            source: source.0,
            connected: connected.0,
            name,
            original_name,
            is_journal,
            link: direction.into(),
            count: count.0,
            snippet: None,
        })
    }
}

impl From<SnippetCells> for Snippeted {
    fn from(SnippetCells(source, connected, name, original_name, is_journal, direction, count, snippet): SnippetCells) -> Self {
        Snippeted(ConnectedRow {
            source: source.0,
            connected: connected.0,
            name,
            original_name,
            is_journal,
            link: direction.into(),
            count: count.0,
            snippet: Some(snippet),
        })
    }
}

/// The rows, or `None` for a `null` answer, which is not an empty one
/// (BR-0011).
pub fn connected_rows(answer: &Value) -> Result<Option<Vec<ConnectedRow>>, ResponseError> {
    Ok(parse::<Option<Vec<Plain>>>(DATALOG_METHOD, answer)?.map(|rows| rows.into_iter().map(|row| row.0).collect()))
}

/// Like [`connected_rows`] for the answer to a query that asked for snippets: one more cell in every row.
pub fn connected_rows_with_snippets(answer: &Value) -> Result<Option<Vec<ConnectedRow>>, ResponseError> {
    Ok(parse::<Option<Vec<Snippeted>>>(DATALOG_METHOD, answer)?.map(|rows| rows.into_iter().map(|row| row.0).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn problem<T: std::fmt::Debug>(result: Result<T, ResponseError>) -> String {
        let error = result.unwrap_err();
        format!("{}: {}", error.path, error.problem)
    }

    #[test]
    fn null_is_its_own_case_and_a_row_has_seven_cells() {
        assert_eq!(connected_rows(&json!(null)).unwrap(), None);
        assert_eq!(connected_rows(&json!([])).unwrap(), Some(vec![]));
        let rows = connected_rows(&json!([[10, 20, "bob", "Bob", false, "outbound", 3], [10, 21, "jan 1st, 2025", "", true, "inbound", 1]]))
            .unwrap()
            .unwrap();
        assert_eq!(
            rows[0],
            ConnectedRow { source: 10, connected: 20, name: "bob".into(), original_name: "Bob".into(), is_journal: false, link: Link::Outbound, count: 3, snippet: None }
        );
        assert!(rows[1].link == Link::Inbound && rows[1].is_journal && rows[1].original_name.is_empty());
    }

    #[test]
    fn a_degree_row_says_how_many_pages_a_page_links() {
        let rows = connected_rows(&json!([[10, 20, "bob", "Bob", false, "degree", 41]])).unwrap().unwrap();
        assert_eq!((rows[0].link, rows[0].count), (Link::Degree, 41));
    }

    #[test]
    fn a_query_that_asked_for_snippets_has_a_text_cell_after_the_count() {
        let rows = connected_rows_with_snippets(&json!([[10, 20, "bob", "Bob", false, "outbound", 3, "Met Bob"], [10, 20, "bob", "Bob", false, "degree", 4, ""]]))
            .unwrap()
            .unwrap();
        assert_eq!(rows[0].snippet.as_deref(), Some("Met Bob"));
        assert_eq!((rows[1].link, rows[1].snippet.as_deref()), (Link::Degree, Some("")));
        assert_eq!(connected_rows_with_snippets(&json!(null)).unwrap(), None);
        // the two readers are not interchangeable: each names the cell that is missing or extra
        assert_eq!(
            problem(connected_rows_with_snippets(&json!([[10, 20, "b", "B", false, "outbound", 1]]))),
            "answer[0]: the row has fewer cells than this server reads"
        );
        assert_eq!(
            problem(connected_rows(&json!([[10, 20, "b", "B", false, "outbound", 1, "text"]]))),
            "answer[0]: the row has more cells than this server reads"
        );
        assert_eq!(
            problem(connected_rows_with_snippets(&json!([[10, 20, "b", "B", false, "outbound", 1, 5]]))),
            "answer[0][7]: expected a string, got a number"
        );
    }

    #[test]
    fn an_id_or_a_count_may_be_written_with_a_point() {
        let rows = connected_rows(&json!([[10.0, 20.0, "b", "B", false, "inbound", 2.0]])).unwrap().unwrap();
        assert_eq!((rows[0].source, rows[0].connected, rows[0].count), (10, 20, 2));
    }

    #[test]
    fn a_wrong_cell_is_named_by_its_place_in_the_answer() {
        let method = DATALOG_METHOD;
        assert_eq!(problem(connected_rows(&json!({}))), "answer: expected a list, got an object");
        assert_eq!(problem(connected_rows(&json!([1]))), "answer[0]: expected a row, got a number");
        assert_eq!(problem(connected_rows(&json!([[10, 20]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(connected_rows(&json!([[10, 20, "b", "B", false, "outbound"]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(connected_rows(&json!([["a", 20, "b", "B", false, "outbound", 1]]))), "answer[0][0]: expected a whole number, got a string");
        assert_eq!(problem(connected_rows(&json!([[1.5, 20, "b", "B", false, "outbound", 1]]))), "answer[0][0]: expected a whole number, got a number with a fraction");
        assert_eq!(problem(connected_rows(&json!([[10, 20, "b", "B", "no", "outbound", 1]]))), "answer[0][4]: expected a boolean, got a string");
        assert_eq!(
            problem(connected_rows(&json!([[10, 20, "b", "B", false, "sideways", 1]]))),
            "answer[0][5]: expected \"outbound\" or \"inbound\" or \"degree\", got a different string"
        );
        assert_eq!(problem(connected_rows(&json!([[10, 20, "b", "B", false, "inbound", 1, 9]]))), "answer[0]: the row has more cells than this server reads");
        assert_eq!(connected_rows(&json!([[1.5, 20, "b", "B", false, "inbound", 1]])).unwrap_err().method, method);
    }

    #[test]
    fn what_is_said_never_includes_what_was_sent() {
        let error = connected_rows(&json!([[10, 20, "b", "B", false, "secret direction", 1]])).unwrap_err().to_string();
        assert!(!error.contains("secret"));
    }
}
