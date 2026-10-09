//! What LogSeq answers, read into typed values at the boundary (#202). Each tool's wire types are
//! types that derive `Deserialize`, written beside the code that reads them: the resolver's in
//! `resolve/wire.rs`, a tool's in its own directory, the pages and blocks several tools carry as
//! LogSeq sent them in `entity/shape.rs`. [`parse`] reads an answer into one, through the
//! deserializer in `wire/deserializer.rs`.
//!
//! A tool never reads a `serde_json::Value` it got from LogSeq without its answer having been parsed
//! first, and an answer that isn't the shape asked for is a [`ResponseError`], never "no data"
//! (BR-0003). So:
//! - extra keys pass, since LogSeq adds them;
//! - `null` is a case of its own (BR-0011): `parse::<Option<T>>` returns `None` for a `null` answer
//!   and the tool decides what that means. In a field, `null` is not "absent": see [`Optional`];
//! - the error names the method and where the first mismatch is, in this server's words, and never a
//!   value from the answer, because an answer is the user's graph (ADR-0004).
//!
//! A type names the fields the code reads and no others. A field
//! nothing reads can hold anything, so a mistyped one doesn't fail an answer; one the code reads
//! still does, and so does one it needs and doesn't find.
//!
//! The first mismatch is the first the reader meets, which for an object is the first key LogSeq sent
//! (a missing field is found after all of them), and for a row is the first cell in order.
//!
//! An `:db/id` must be a whole number. A JSON number may be a fraction, and an id that is one would
//! fail later at `ground_ids` or carry on, depending on which page it was. LogSeq never sends one,
//! so it is refused where it is read.

use std::fmt;

use serde::Deserialize;
use serde::de::{self, DeserializeOwned, Deserializer, IgnoredAny, MapAccess, Unexpected, Visitor};
use serde_json::Value;

mod deserializer;
#[cfg(test)]
mod reading;

use self::deserializer::{Part as ReadPart, Wire};

/// The most a whole number can be, as a JavaScript number holds it: 2^53, where an f64 stops holding every
/// whole number.
const MAX_WHOLE: i64 = 9_007_199_254_740_992;

/// A whole number a JSON value holds, as an id or a `YYYYMMDD` day is: `5` and `5.0` alike (JSON text has
/// no difference between them for a JavaScript runtime), up to 2^53, where an f64 stops holding every whole
/// number, as a JavaScript number does. The one test every reader of an id and the check on the wire share,
/// so what the check accepts is never read as absent.
pub(crate) fn whole_number(value: &Value) -> Option<i64> {
    let Value::Number(number) = value else { return None };
    match number.as_i64() {
        Some(whole) => whole_i64(whole),
        None => number.as_f64().and_then(whole_f64),
    }
}

fn whole_i64(number: i64) -> Option<i64> {
    (-MAX_WHOLE..=MAX_WHOLE).contains(&number).then_some(number)
}

fn whole_f64(number: f64) -> Option<i64> {
    (number.fract() == 0.0 && number.abs() <= MAX_WHOLE as f64).then_some(number as i64)
}

/// The method a Datalog answer reports in a [`ResponseError`].
pub const DATALOG_METHOD: &str = "logseq.DB.datascriptQuery";

/// LogSeq answered, but not in a shape this server reads (`LogSeqResponseError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseError {
    pub method: String,
    /// Where the first mismatch is, as the way into the answer: `answer[0][0].id`, or `answer` for the top level.
    pub path: String,
    /// What was expected there and what kind of thing came instead ("expected a string, got a number"):
    /// kinds only, never the received value.
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

impl ResponseError {
    fn from_issue(method: &str, issue: &deserializer::Issue) -> Self {
        ResponseError { method: method.to_owned(), path: issue.path_text(), problem: issue.problem_text() }
    }
}

/// An answer read into `T`, or the response error that says where it stopped being one.
///
/// A `null` answer is an error unless `T` is an `Option`: `parse::<Option<T>>` reads `null` as `None`, and
/// the tool decides what that means (BR-0011).
pub(crate) fn parse<T: DeserializeOwned>(method: &str, answer: &Value) -> Result<T, ResponseError> {
    T::deserialize(Wire(answer)).map_err(|issue| ResponseError::from_issue(method, &issue))
}

/// `answer` must be a `T`; the `T` itself is not wanted. For an entity a tool carries as LogSeq sent it
/// (BR-0004) and reads through [`crate::entity`].
pub(crate) fn check<T: DeserializeOwned>(method: &str, answer: &Value) -> Result<(), ResponseError> {
    parse::<T>(method, answer).map(|_| ())
}

/// The items of a list answer, as LogSeq sent them. Meant for an answer that has just been read as a list,
/// which is what makes the empty case a list with nothing in it and never a stand-in for another kind of
/// answer.
pub(crate) fn items(answer: &Value) -> &[Value] {
    answer.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// A list answer whose every item must be a `T`, kept as LogSeq sent it (BR-0004). `null` is `None`, which is
/// not an empty list (BR-0011).
pub(crate) fn sent_list<T: DeserializeOwned>(method: &str, answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
    Ok(parse::<Option<Vec<T>>>(method, answer)?.map(|_| items(answer).to_vec()))
}

/// Rows of one cell each, the cell a `T` or `null`: `[block | null]` per row. A `null` cell is `None`; any
/// other is the object as LogSeq sent it. The whole answer `null` is `None` too, one level out.
pub(crate) fn sent_cells<T: DeserializeOwned>(method: &str, answer: &Value) -> Result<Option<Vec<Option<Value>>>, ResponseError> {
    let Some(rows) = parse::<Option<Vec<(Option<T>,)>>>(method, answer)? else { return Ok(None) };
    debug_assert_eq!(rows.len(), items(answer).len());
    Ok(Some(rows.iter().zip(items(answer)).map(|((cell,), row)| cell.as_ref().and_then(|_| row.get(0)).cloned()).collect()))
}

/// Rows of one cell each, the cell a `T` (a `null` cell is an error): the cells as LogSeq sent them.
pub(crate) fn sent_required_cells<T: DeserializeOwned>(method: &str, answer: &Value) -> Result<Option<Vec<Value>>, ResponseError> {
    let Some(rows) = parse::<Option<Vec<(T,)>>>(method, answer)? else { return Ok(None) };
    debug_assert_eq!(rows.len(), items(answer).len());
    Ok(Some(items(answer).iter().filter_map(|row| row.get(0)).cloned().collect()))
}

/// `value` must be a `T`; it sits at `answer[at[0]][at[1]]...`, which is where an error says it is. For a
/// cell that is checked after the row it is in has been read.
pub(crate) fn check_at<T: DeserializeOwned>(method: &str, value: &Value, at: &[usize]) -> Result<(), ResponseError> {
    T::deserialize(Wire(value)).map(|_| ()).map_err(|issue| {
        let issue = at.iter().rev().fold(issue, |issue, index| issue.at(ReadPart::Index(*index)));
        ResponseError::from_issue(method, &issue)
    })
}

/// A whole number: a `:db/id`, or a count. `5` and `5.0` alike, up to 2^53 (see [`whole_number`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Id(pub i64);

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Id, D::Error> {
        deserializer.deserialize_any(IdVisitor)
    }
}

/// What reads an [`Id`]: also what a type that takes an id or something else reads the id with.
pub(crate) struct IdVisitor;

impl IdVisitor {
    fn too_large<E: de::Error>(unexpected: Unexpected<'_>) -> E {
        E::invalid_value(unexpected, &"a whole number no larger than 2^53")
    }
}

impl Visitor<'_> for IdVisitor {
    type Value = Id;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a whole number")
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Id, E> {
        i64::try_from(value).ok().and_then(whole_i64).map(Id).ok_or_else(|| Self::too_large(Unexpected::Unsigned(value)))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Id, E> {
        whole_i64(value).map(Id).ok_or_else(|| Self::too_large(Unexpected::Signed(value)))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Id, E> {
        match whole_f64(value) {
            Some(whole) => Ok(Id(whole)),
            None if value.fract() != 0.0 => Err(E::invalid_value(Unexpected::Float(value), &"a whole number")),
            None => Err(Self::too_large(Unexpected::Float(value))),
        }
    }
}

/// Any JSON number: a creation time, a journal day LogSeq may or may not give.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Number(pub f64);

impl<'de> Deserialize<'de> for Number {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Number, D::Error> {
        deserializer.deserialize_any(NumberVisitor)
    }
}

struct NumberVisitor;

impl Visitor<'_> for NumberVisitor {
    type Value = Number;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a number")
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Number, E> {
        Ok(Number(value as f64))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Number, E> {
        Ok(Number(value as f64))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Number, E> {
        Ok(Number(value))
    }
}

/// A JSON object whose keys and values are the user's own (`properties`): only that it is an object is
/// read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Object;

impl<'de> Deserialize<'de> for Object {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Object, D::Error> {
        deserializer.deserialize_map(ObjectVisitor)
    }
}

struct ObjectVisitor;

impl<'de> Visitor<'de> for ObjectVisitor {
    type Value = Object;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Object, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(Object)
    }
}

/// A field LogSeq may leave out. Present, it must be a `T`: `null` is a mismatch, not "absent" (a plain
/// `Option` field would read it as absent, and a field the code reads would then fail silently, BR-0003).
/// Write it with `#[serde(default)]`, so that leaving the field out is `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Optional<T>(Option<T>);

impl<T> Default for Optional<T> {
    fn default() -> Self {
        Optional(None)
    }
}

impl<T> Optional<T> {
    pub(crate) fn into_option(self) -> Option<T> {
        self.0
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Optional<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(|value| Optional(Some(value)))
    }
}

/// A bare reference to an entity: the ids it carries, in either spelling. Each is a whole number when
/// present (`5.0` too), and neither need be there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(from = "RawRef")]
pub struct EntityRef {
    pub id: Option<i64>,
    pub db_id: Option<i64>,
}

#[derive(Deserialize)]
struct RawRef {
    #[serde(default)]
    id: Optional<Id>,
    #[serde(default, rename = "db/id")]
    db_id: Optional<Id>,
}

impl From<RawRef> for EntityRef {
    fn from(raw: RawRef) -> Self {
        EntityRef { id: raw.id.into_option().map(|id| id.0), db_id: raw.db_id.into_option().map(|id| id.0) }
    }
}

/// The `id`, else `db/id` when `id` is absent. An `id` of 0 is an id.
pub(crate) fn entity_id(id: Option<i64>, db_id: Option<i64>) -> Option<i64> {
    id.or(db_id)
}

impl EntityRef {
    pub fn entity_id(&self) -> Option<i64> {
        entity_id(self.id, self.db_id)
    }
}
