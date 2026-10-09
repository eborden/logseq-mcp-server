//! What the concept network reads from LogSeq: the rows of its connected-pages query
//! (`responses.connectedRows` in `src/response-schemas.ts`).

use serde::Deserialize;
use serde_json::Value;

use crate::wire::{DATALOG_METHOD, Id, ResponseError, parse};

/// One row of the connected-pages query:
/// `[sourceId, connectedId, name, originalName, isJournal, relType, count]`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(from = "Cells")]
pub struct ConnectedRow {
    /// The page whose links these are: a frontier page, or the group's id for a grouped query
    pub source: i64,
    pub connected: i64,
    /// `:block/name`, lowercase
    pub name: String,
    /// `:block/original-name`, `""` for a page that has none
    pub original_name: String,
    pub is_journal: bool,
    /// `outbound`: blocks on `source` that reference `connected`. `inbound`: blocks on `connected`
    /// that reference `source`.
    pub outbound: bool,
    /// How many blocks
    pub count: i64,
}

/// The cells of a row, in the order the query returns them. Every one is read.
#[derive(Deserialize)]
struct Cells(Id, Id, String, String, bool, Direction, Id);

#[derive(Deserialize)]
enum Direction {
    #[serde(rename = "outbound")]
    Outbound,
    #[serde(rename = "inbound")]
    Inbound,
}

impl From<Cells> for ConnectedRow {
    fn from(Cells(source, connected, name, original_name, is_journal, direction, count): Cells) -> Self {
        ConnectedRow {
            source: source.0,
            connected: connected.0,
            name,
            original_name,
            is_journal,
            outbound: matches!(direction, Direction::Outbound),
            count: count.0,
        }
    }
}

/// `responses.connectedRows`: the rows, or `None` for a `null` answer, which is not an empty one
/// (BR-0011).
pub fn connected_rows(answer: &Value) -> Result<Option<Vec<ConnectedRow>>, ResponseError> {
    parse(DATALOG_METHOD, answer)
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
        assert_eq!(rows[0], ConnectedRow { source: 10, connected: 20, name: "bob".into(), original_name: "Bob".into(), is_journal: false, outbound: true, count: 3 });
        assert!(!rows[1].outbound && rows[1].is_journal && rows[1].original_name.is_empty());
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
            "answer[0][5]: expected \"outbound\" or \"inbound\", got a different string"
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
