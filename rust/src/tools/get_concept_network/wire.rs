//! What the concept network reads from LogSeq: the rows of its connected-pages query
//! (`responses.connectedRows` in `src/response-schemas.ts`).

use serde_json::Value;

use crate::wire::{DATALOG_METHOD, Part, Parsed, Reader, ResponseError, to_error};

/// One row of the connected-pages query:
/// `[sourceId, connectedId, name, originalName, isJournal, relType, count]`.
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
    /// `outbound`: blocks on `source` that reference `connected`. `inbound`: blocks on `connected`
    /// that reference `source`.
    pub outbound: bool,
    /// How many blocks
    pub count: i64,
}

impl Reader {
    /// A cell that is a whole number: an id or a count (`z.number()`). One difference from
    /// TypeScript, which takes a fraction and fails later at `groundIds`: LogSeq never sends one,
    /// so it is refused where it is read (see `crate::wire`).
    fn whole_cell(&mut self, cell: Option<&Value>) -> Parsed<i64> {
        match cell {
            Some(value) => {
                let n = self.number_value(value)?;
                if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 { Ok(n as i64) } else { Err(self.mismatch("int", Some(value))) }
            }
            None => Err(self.mismatch("number", None)),
        }
    }

    fn string_cell(&mut self, cell: Option<&Value>) -> Parsed<String> {
        match cell {
            Some(value) => self.string_value(value),
            None => Err(self.mismatch("string", None)),
        }
    }

    fn connected_row(&mut self, cells: &[Value]) -> Parsed<ConnectedRow> {
        let source = self.at(Part::Index(0), |r| r.whole_cell(cells.first()))?;
        let connected = self.at(Part::Index(1), |r| r.whole_cell(cells.get(1)))?;
        let name = self.at(Part::Index(2), |r| r.string_cell(cells.get(2)))?;
        let original_name = self.at(Part::Index(3), |r| r.string_cell(cells.get(3)))?;
        let is_journal = self.at(Part::Index(4), |r| match cells.get(4) {
            Some(Value::Bool(flag)) => Ok(*flag),
            other => Err(r.mismatch("boolean", other)),
        })?;
        let outbound = self.at(Part::Index(5), |r| match cells.get(5).and_then(Value::as_str) {
            Some("outbound") => Ok(true),
            Some("inbound") => Ok(false),
            // PARITY(#299): zod's wording for a value outside an enum — drop if Rust becomes the only server.
            _ => Err(r.issue("Invalid option: expected one of \"outbound\"|\"inbound\"")),
        })?;
        let count = self.at(Part::Index(6), |r| r.whole_cell(cells.get(6)))?;
        Ok(ConnectedRow { source, connected, name, original_name, is_journal, outbound, count })
    }
}

/// `responses.connectedRows`: the rows, or `None` for a `null` answer, which is not an empty one
/// (BR-0011).
pub fn connected_rows(answer: &Value) -> Result<Option<Vec<ConnectedRow>>, ResponseError> {
    let mut reader = Reader::default();
    reader.rows(answer, 7, |r, cells| r.connected_row(cells)).map_err(|issue| to_error(DATALOG_METHOD, issue))
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
    fn a_wrong_cell_names_its_path_in_zod_s_words() {
        let method = DATALOG_METHOD;
        assert_eq!(problem(connected_rows(&json!({}))), "(response): Invalid input: expected array, received object");
        assert_eq!(problem(connected_rows(&json!([1]))), "[0]: Invalid input: expected tuple, received number");
        assert_eq!(problem(connected_rows(&json!([[10, 20]]))), "[0][2]: Invalid input: expected string, received undefined");
        assert_eq!(problem(connected_rows(&json!([["a", 20, "b", "B", false, "outbound", 1]]))), "[0][0]: Invalid input: expected number, received string");
        assert_eq!(problem(connected_rows(&json!([[10, 20, "b", "B", "no", "outbound", 1]]))), "[0][4]: Invalid input: expected boolean, received string");
        assert_eq!(
            problem(connected_rows(&json!([[10, 20, "b", "B", false, "sideways", 1]]))),
            "[0][5]: Invalid option: expected one of \"outbound\"|\"inbound\""
        );
        assert_eq!(problem(connected_rows(&json!([[10, 20, "b", "B", false, "inbound", 1, 9]]))), "[0]: Too big: expected array to have <7 items");
        assert_eq!(connected_rows(&json!([[1.5, 20, "b", "B", false, "inbound", 1]])).unwrap_err().method, method);
    }
}
