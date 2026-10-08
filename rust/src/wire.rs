//! What LogSeq answers, parsed into typed values at the boundary (the Rust side of
//! `src/response-schemas.ts` and `src/utils/parse-response.ts`, #202). This is the reader every
//! tool's wire types are written with; the types themselves live beside the code that reads them:
//! the resolver's in `resolve/wire.rs`, a tool's in its own directory.
//!
//! A tool never reads a `serde_json::Value` it got from LogSeq. Each answer a tool makes is
//! parsed here into a type that holds only the fields the tool reads, and an answer that isn't
//! that shape is a [`ResponseError`], never "no data" (BR-0003). As in TypeScript:
//! - extra keys pass, since LogSeq adds them, and a field the tool doesn't read is still checked
//!   when the schema names it, so a mistyped one fails here and not three tools later;
//! - `null` is a case of its own (BR-0011): the parsers return `None` for a `null` answer and
//!   the tool decides what that means;
//! - the error names the method and where the first mismatch is, in zod's words, and never a value
//!   from the answer, because an answer is the user's graph (ADR-0004).
//!
//! The first mismatch is the first in the schema's field order, depth first, which is the order
//! each parser reads its fields in. Each parser lists them in the TypeScript schema's order.
//!
//! One deliberate difference: an `:db/id` must be a whole number. zod's `z.number()` takes a
//! fraction, and the TypeScript tools then fail at `groundIds` or carry on, depending on which
//! page it was. LogSeq never sends one, so the Rust side refuses it where it reads it.

use std::fmt;

use serde_json::{Map, Value};

/// The method a Datalog answer reports in a [`ResponseError`].
pub const DATALOG_METHOD: &str = "logseq.DB.datascriptQuery";

/// LogSeq answered, but not in a shape this server reads (`LogSeqResponseError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseError {
    pub method: String,
    /// Where the first mismatch is, e.g. `[0][0].id`, or `(response)` for the top level.
    pub path: String,
    /// What was expected there, in zod's words: types only, never the received value.
    pub problem: String,
}

impl fmt::Display for ResponseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "LogSeq answered {} in a shape this server can't read: {}: {}\n\n\
             Steps to fix:\n\
             1. Check which LogSeq version is running. This server is tested against LogSeq 0.10.x, and a different version may name or type fields differently\n\
             2. If the version is right, report this on the project's GitHub issues with the method name and the path above (leave out page names and block text)",
            self.method, self.path, self.problem
        )
    }
}

impl std::error::Error for ResponseError {}

#[derive(Debug, Clone)]
pub(crate) enum Part {
    Index(usize),
    Key(&'static str),
}

/// The first thing wrong with an answer.
#[derive(Debug)]
pub(crate) struct Issue {
    path: Vec<Part>,
    problem: String,
}

pub(crate) type Parsed<T> = Result<T, Issue>;

/// A reader that knows where in the answer it is, so an issue can say.
#[derive(Default)]
pub(crate) struct Reader {
    path: Vec<Part>,
}

impl Reader {
    pub(crate) fn issue(&self, problem: impl Into<String>) -> Issue {
        Issue { path: self.path.clone(), problem: problem.into() }
    }

    pub(crate) fn at<T>(&mut self, part: Part, read: impl FnOnce(&mut Reader) -> Parsed<T>) -> Parsed<T> {
        self.path.push(part);
        let result = read(self);
        self.path.pop();
        result
    }

    // PARITY(#299): zod's wording for a wrong type (`Invalid input: expected X, received Y`) in the error
    // message — drop if Rust becomes the only server.
    pub(crate) fn mismatch(&self, expected: &str, found: Option<&Value>) -> Issue {
        self.issue(format!("Invalid input: expected {expected}, received {}", kind(found)))
    }

    /// A value that must be an object (`z.object`).
    pub(crate) fn object<'v>(&self, value: Option<&'v Value>) -> Parsed<&'v Map<String, Value>> {
        match value {
            Some(Value::Object(map)) => Ok(map),
            other => Err(self.mismatch("object", other)),
        }
    }

    /// A field that may be absent and, when present, must be a number (`z.number().optional()`).
    pub(crate) fn number(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<Option<f64>> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(None),
            Some(value) => r.number_value(value).map(Some),
        })
    }

    pub(crate) fn number_value(&self, value: &Value) -> Parsed<f64> {
        match value {
            Value::Number(n) => Ok(n.as_f64().expect("a JSON number is finite")),
            other => Err(self.mismatch("number", Some(other))),
        }
    }

    /// A field that may be absent and, when present, must be a whole number: a `:db/id`.
    pub(crate) fn id(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<Option<i64>> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(None),
            Some(value) => {
                let n = r.number_value(value)?;
                // 2^53 is where an f64 stops holding every whole number, as a JavaScript number does
                if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
                    Ok(Some(n as i64))
                } else {
                    Err(r.mismatch("int", Some(value)))
                }
            }
        })
    }

    pub(crate) fn string(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<Option<String>> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(None),
            Some(value) => r.string_value(value).map(Some),
        })
    }

    pub(crate) fn string_value(&self, value: &Value) -> Parsed<String> {
        match value {
            Value::String(s) => Ok(s.clone()),
            other => Err(self.mismatch("string", Some(other))),
        }
    }

    pub(crate) fn required_string(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<String> {
        self.at(Part::Key(key), |r| match map.get(key) {
            Some(value) => r.string_value(value),
            None => Err(r.mismatch("string", None)),
        })
    }

    pub(crate) fn boolean(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<Option<bool>> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(other) => Err(r.mismatch("boolean", Some(other))),
        })
    }

    /// A field that may be absent and must be a map when present (`propertiesSchema`: the keys
    /// are the user's own and the values anything, so only the map is checked).
    pub(crate) fn map_field(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<()> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None | Some(Value::Object(_)) => Ok(()),
            Some(_) => Err(r.issue("expected an object")),
        })
    }

    /// `{ id?, "db/id"? }`: a bare reference to a page or a block (`entityRefSchema`).
    pub(crate) fn entity_ref(&mut self, value: Option<&Value>) -> Parsed<EntityRef> {
        let map = self.object(value)?;
        Ok(EntityRef { id: self.id(map, "id")?, db_id: self.id(map, "db/id")? })
    }

    pub(crate) fn optional_entity_ref(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<Option<EntityRef>> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(None),
            some => r.entity_ref(some).map(Some),
        })
    }

    /// An optional array of references; how many it holds (0 when absent).
    pub(crate) fn entity_refs(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<usize> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(0),
            Some(Value::Array(items)) => {
                for (i, item) in items.iter().enumerate() {
                    r.at(Part::Index(i), |r| r.entity_ref(Some(item)))?;
                }
                Ok(items.len())
            }
            Some(other) => Err(r.mismatch("array", Some(other))),
        })
    }

    /// An answer that is `null` or a list of rows, each row a tuple of `width` cells (`rows(...)`
    /// in TypeScript), none of them optional. See [`Reader::rows_with_optional_tail`].
    pub(crate) fn rows<T>(
        &mut self,
        answer: &Value,
        width: usize,
        read_row: impl Fn(&mut Reader, &[Value]) -> Parsed<T>,
    ) -> Parsed<Option<Vec<T>>> {
        self.rows_with_optional_tail(answer, width, 0, read_row)
    }

    /// `rows`, for a tuple whose last `optional_tail` cells are `.optional()` (`z.string().optional()`).
    /// zod 4 doesn't count `z.unknown()` as optional in a tuple, so such a cell is not in the tail.
    ///
    /// The length is checked before any cell is read, as zod 4's tuple does:
    /// - longer than `width` is `Too big`;
    /// - shorter than `width` minus the optional tail minus one is `Too small`, whatever the cells
    ///   would have said;
    /// - anything between is read with its missing cells as `undefined`, which each cell's own
    ///   parser accepts or not.
    pub(crate) fn rows_with_optional_tail<T>(
        &mut self,
        answer: &Value,
        width: usize,
        optional_tail: usize,
        read_row: impl Fn(&mut Reader, &[Value]) -> Parsed<T>,
    ) -> Parsed<Option<Vec<T>>> {
        let items = match answer {
            Value::Null => return Ok(None),
            Value::Array(items) => items,
            other => return Err(self.mismatch("array", Some(other))),
        };
        debug_assert!(optional_tail <= width, "a tuple of {width} cells can't end in {optional_tail} optional ones");
        let shortest = width.saturating_sub(optional_tail).saturating_sub(1);
        let mut rows = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            rows.push(self.at(Part::Index(i), |r| match item {
                Value::Array(cells) if cells.len() > width => {
                    // PARITY(#299): zod's wording, which says `<N items` where N is the most allowed (zod's own
                    // off-by-one, passed through by the TS server, so not a TS bug) — drop if Rust becomes the
                    // only server.
                    Err(r.issue(format!("Too big: expected array to have <{width} items")))
                }
                Value::Array(cells) if cells.len() < shortest => {
                    // PARITY(#299): zod's wording, which says `>N items` where N is the width, though a row one
                    // cell short of that still passes the length check (zod's own off-by-one, passed through by
                    // the TS server, so not a TS bug) — drop if Rust becomes the only server.
                    Err(r.issue(format!("Too small: expected array to have >{width} items")))
                }
                Value::Array(cells) => read_row(r, cells),
                other => Err(r.mismatch("tuple", Some(other))),
            })?);
        }
        Ok(Some(rows))
    }
}

/// What zod calls the type of a JSON value in "received ...".
fn kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// An issue as `LogSeqResponseError` reports it: `[0].id` for a path of `0, "id"`, and
/// `(response)` for the top level.
pub(crate) fn to_error(method: &str, issue: Issue) -> ResponseError {
    let path = if issue.path.is_empty() {
        "(response)".to_owned()
    } else {
        let joined: String = issue
            .path
            .iter()
            .map(|part| match part {
                Part::Index(i) => format!("[{i}]"),
                Part::Key(key) => format!(".{key}"),
            })
            .collect();
        joined.strip_prefix('.').map(str::to_owned).unwrap_or(joined)
    };
    ResponseError { method: method.to_owned(), path, problem: issue.problem }
}

/// A bare reference to an entity: the ids it carries, in either spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EntityRef {
    pub id: Option<i64>,
    pub db_id: Option<i64>,
}

// PARITY(#299): `entity?.id || entity?.['db/id']`, so an id of 0 falls through to `db/id` (suspected TS bug:
// `??` was meant) — drop if Rust becomes the only server.
/// `entityId`: `id`, else `db/id` when `id` is absent or zero (`entity?.id || entity?.['db/id']`).
pub(crate) fn entity_id(id: Option<i64>, db_id: Option<i64>) -> Option<i64> {
    id.filter(|id| *id != 0).or(db_id)
}

impl EntityRef {
    pub fn entity_id(&self) -> Option<i64> {
        entity_id(self.id, self.db_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_written_as_zod_errors_write_it() {
        let issue = |path: Vec<Part>| Issue { path, problem: "p".into() };
        assert_eq!(to_error("m", issue(vec![])).path, "(response)");
        assert_eq!(to_error("m", issue(vec![Part::Index(0), Part::Index(1), Part::Key("id")])).path, "[0][1].id");
        assert_eq!(to_error("m", issue(vec![Part::Key("name")])).path, "name");
        assert_eq!(to_error("m", issue(vec![Part::Index(2), Part::Key("original-name"), Part::Index(0)])).path, "[2].original-name[0]");
    }

    #[test]
    fn the_message_names_the_method_and_the_path() {
        let error = ResponseError { method: "logseq.Editor.getAllPages".into(), path: "[1].originalName".into(), problem: "p".into() };
        assert!(error.to_string().starts_with(
            "LogSeq answered logseq.Editor.getAllPages in a shape this server can't read: [1].originalName: p\n\nSteps to fix:\n1. "
        ));
    }
}
