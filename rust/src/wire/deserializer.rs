//! A `serde::Deserializer` over a `serde_json::Value`, written for one job: reading what LogSeq
//! answers into types that derive `Deserialize`, and saying where an answer stopped being one when
//! it did not.
//!
//! `serde_json` can already read a `Value` into a type. Its error names the path of nothing, and
//! it quotes the value it choked on (`invalid type: string "..."`), which would put the user's
//! graph in an error message (ADR-0004). So this module carries its own error ([`Issue`]):
//! - every [`Part`] of the way in is recorded as the error comes back up through the lists and
//!   objects, so the issue knows its path;
//! - serde reports a value it can't use as an `Unexpected`; only the *kind* of that value is
//!   kept (a string, a number, a list), never the value, and the wording is this server's own.
//!
//! Three rules a type can rely on:
//! - an object's keys the type does not name are never read, not even to be type-checked, so a
//!   field the code doesn't use can't fail the answer (and LogSeq may add keys);
//! - a `null` is `None` only where the type asks for an `Option`; anywhere else it is a mismatch
//!   (see [`super::Optional`] for a field that may be left out but not be `null`);
//! - a row (a tuple) has exactly the cells its type reads, or the longest of them when the type
//!   says some are optional: more cells than that is an error, as fewer is.

use std::fmt;

use serde::de::{self, DeserializeSeed, Deserializer, Expected, IntoDeserializer, MapAccess, SeqAccess, Unexpected, Visitor};
use serde::forward_to_deserialize_any;
use serde_json::Value;

/// One step of the way into an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Part {
    /// The nth item of a list (a row, or a cell of a row)
    Index(usize),
    /// A field of an object. Only ever a field the reading type names, never one LogSeq chose.
    Key(String),
}

/// What is wrong, in words that never include a value from the answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Problem {
    /// A value of another kind than the one wanted
    WrongType { expected: String, found: &'static str },
    /// The right kind, but not a value this server can use (a fraction for an id, a name it doesn't know)
    BadValue { expected: String, found: &'static str },
    /// A field the code needs is not there
    Missing,
    TooFewCells,
    TooManyCells,
    /// Anything a type said itself, in a fixed text
    Other(String),
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Problem::WrongType { expected, found } | Problem::BadValue { expected, found } => write!(f, "expected {expected}, got {found}"),
            Problem::Missing => f.write_str("required, but missing"),
            Problem::TooFewCells => f.write_str("the row has fewer cells than this server reads"),
            Problem::TooManyCells => f.write_str("the row has more cells than this server reads"),
            Problem::Other(text) => f.write_str(text),
        }
    }
}

/// The first thing wrong with an answer: where, and what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Issue {
    path: Vec<Part>,
    problem: Problem,
}

impl Issue {
    fn new(problem: Problem) -> Self {
        Issue { path: Vec::new(), problem }
    }

    /// The issue seen from one level further out: `part` is where the value that failed sits.
    pub(crate) fn at(mut self, part: Part) -> Self {
        self.path.insert(0, part);
        self
    }

    /// `value` is not the `expected` kind of thing.
    pub(crate) fn wrong_type(expected: &str, value: &Value) -> Self {
        Issue::new(Problem::WrongType { expected: expected.to_owned(), found: kind(value) })
    }

    /// A problem a type words itself. The text must never include anything from the answer.
    pub(crate) fn other(text: &str) -> Self {
        Issue::new(Problem::Other(text.to_owned()))
    }

    /// Where the problem is, as the way into the answer: `answer[0][1].page.name`.
    pub(crate) fn path_text(&self) -> String {
        let mut text = String::from("answer");
        for part in &self.path {
            match part {
                Part::Index(i) => text.push_str(&format!("[{i}]")),
                Part::Key(key) => {
                    text.push('.');
                    text.push_str(key);
                }
            }
        }
        text
    }

    pub(crate) fn problem_text(&self) -> String {
        self.problem.to_string()
    }
}

impl fmt::Display for Issue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path_text(), self.problem)
    }
}

impl std::error::Error for Issue {}

/// What kind of thing a JSON value is, in the words an error uses.
fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// The kind of what a visitor was handed and refused. Only the kind: the value stays out.
fn unexpected_kind(unexpected: &Unexpected<'_>) -> &'static str {
    match unexpected {
        Unexpected::Bool(_) => "a boolean",
        Unexpected::Unsigned(_) | Unexpected::Signed(_) | Unexpected::Float(_) => "a number",
        Unexpected::Char(_) | Unexpected::Str(_) => "a string",
        Unexpected::Unit | Unexpected::Option => "null",
        Unexpected::Seq => "a list",
        Unexpected::Map => "an object",
        _ => "another kind of value",
    }
}

/// What is wrong with a value of the right kind that a visitor refused.
fn refused_kind(unexpected: &Unexpected<'_>) -> &'static str {
    match unexpected {
        Unexpected::Float(number) if number.fract() != 0.0 => "a number with a fraction",
        Unexpected::Unsigned(_) | Unexpected::Signed(_) | Unexpected::Float(_) => "a number out of range",
        Unexpected::Str(_) => "a different string",
        other => unexpected_kind(other),
    }
}

/// serde's own wording for what it wanted, in this server's.
fn wanted(expected: &dyn Expected) -> String {
    match expected.to_string().as_str() {
        "a sequence" => "a list".to_owned(),
        "a map" => "an object".to_owned(),
        other => other.to_owned(),
    }
}

impl de::Error for Issue {
    fn custom<T: fmt::Display>(message: T) -> Self {
        Issue::new(Problem::Other(message.to_string()))
    }

    fn invalid_type(unexpected: Unexpected<'_>, expected: &dyn Expected) -> Self {
        Issue::new(Problem::WrongType { expected: wanted(expected), found: unexpected_kind(&unexpected) })
    }

    fn invalid_value(unexpected: Unexpected<'_>, expected: &dyn Expected) -> Self {
        Issue::new(Problem::BadValue { expected: wanted(expected), found: refused_kind(&unexpected) })
    }

    fn invalid_length(_length: usize, _expected: &dyn Expected) -> Self {
        Issue::new(Problem::TooFewCells)
    }

    fn unknown_variant(_variant: &str, expected: &'static [&'static str]) -> Self {
        let names: Vec<String> = expected.iter().map(|name| format!("\"{name}\"")).collect();
        Issue::new(Problem::BadValue { expected: names.join(" or "), found: "a different string" })
    }

    fn unknown_field(_field: &str, _expected: &'static [&'static str]) -> Self {
        Issue::other("a field this server doesn't know")
    }

    fn missing_field(field: &'static str) -> Self {
        Issue { path: vec![Part::Key(field.to_owned())], problem: Problem::Missing }
    }

    fn duplicate_field(field: &'static str) -> Self {
        Issue { path: vec![Part::Key(field.to_owned())], problem: Problem::Other("given twice".to_owned()) }
    }
}

/// The deserializer: a borrowed value, read as whatever the type asks for.
#[derive(Clone, Copy)]
pub(crate) struct Wire<'v>(pub(crate) &'v Value);

impl<'de> Deserializer<'de> for Wire<'de> {
    type Error = Issue;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Issue> {
        match self.0 {
            Value::Null => visitor.visit_unit(),
            Value::Bool(flag) => visitor.visit_bool(*flag),
            Value::Number(number) => {
                if let Some(unsigned) = number.as_u64() {
                    visitor.visit_u64(unsigned)
                } else if let Some(signed) = number.as_i64() {
                    visitor.visit_i64(signed)
                } else if let Some(float) = number.as_f64() {
                    visitor.visit_f64(float)
                } else {
                    Err(Issue::other("a number this server can't hold"))
                }
            }
            Value::String(text) => visitor.visit_borrowed_str(text),
            Value::Array(items) => visitor.visit_seq(Items { items: items.iter(), next: 0 }),
            Value::Object(map) => visitor.visit_map(Fields { entries: map.iter(), pending: None }),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Issue> {
        match self.0 {
            Value::Null => visitor.visit_none(),
            _ => visitor.visit_some(self),
        }
    }

    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Issue> {
        match self.0 {
            Value::Array(items) => visitor.visit_seq(Items { items: items.iter(), next: 0 }),
            other => Err(Issue::wrong_type("a list", other)),
        }
    }

    fn deserialize_tuple<V: Visitor<'de>>(self, _length: usize, visitor: V) -> Result<V::Value, Issue> {
        match self.0 {
            Value::Array(items) => {
                let mut cells = Items { items: items.iter(), next: 0 };
                let row = visitor.visit_seq(&mut cells)?;
                // a type reads the cells it names; one more is a row of another shape
                if cells.items.len() > 0 { Err(Issue::new(Problem::TooManyCells)) } else { Ok(row) }
            }
            other => Err(Issue::wrong_type("a row", other)),
        }
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(self, _name: &'static str, length: usize, visitor: V) -> Result<V::Value, Issue> {
        self.deserialize_tuple(length, visitor)
    }

    fn deserialize_map<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Issue> {
        match self.0 {
            Value::Object(map) => visitor.visit_map(Fields { entries: map.iter(), pending: None }),
            other => Err(Issue::wrong_type("an object", other)),
        }
    }

    fn deserialize_struct<V: Visitor<'de>>(self, _name: &'static str, _fields: &'static [&'static str], visitor: V) -> Result<V::Value, Issue> {
        self.deserialize_map(visitor)
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, _name: &'static str, visitor: V) -> Result<V::Value, Issue> {
        visitor.visit_newtype_struct(self)
    }

    /// An enum of unit variants, named by a string (`"outbound"`).
    fn deserialize_enum<V: Visitor<'de>>(self, _name: &'static str, _variants: &'static [&'static str], visitor: V) -> Result<V::Value, Issue> {
        match self.0 {
            Value::String(name) => visitor.visit_enum(name.as_str().into_deserializer()),
            other => Err(Issue::wrong_type("a string", other)),
        }
    }

    /// A key the type doesn't name: skipped without a look, whatever it holds.
    fn deserialize_ignored_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Issue> {
        visitor.visit_unit()
    }

    forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf unit unit_struct identifier
    }
}

/// The items of a list, handed out in order. The index of each rides on its error.
struct Items<'v> {
    items: std::slice::Iter<'v, Value>,
    next: usize,
}

impl<'de> SeqAccess<'de> for Items<'de> {
    type Error = Issue;

    fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, Issue> {
        let Some(item) = self.items.next() else { return Ok(None) };
        let at = self.next;
        self.next += 1;
        seed.deserialize(Wire(item)).map(Some).map_err(|issue| issue.at(Part::Index(at)))
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.items.len())
    }
}

/// The entries of an object, in the order LogSeq sent them. The key of each rides on its error.
struct Fields<'v> {
    entries: serde_json::map::Iter<'v>,
    pending: Option<(&'v String, &'v Value)>,
}

impl<'de> MapAccess<'de> for Fields<'de> {
    type Error = Issue;

    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>, Issue> {
        let Some((key, value)) = self.entries.next() else { return Ok(None) };
        self.pending = Some((key, value));
        seed.deserialize(Key(key)).map(Some)
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, Issue> {
        let Some((key, value)) = self.pending.take() else { return Err(Issue::other("a value with no key")) };
        seed.deserialize(Wire(value)).map_err(|issue| issue.at(Part::Key(key.clone())))
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.entries.len())
    }
}

/// A key, read as the name of a field.
struct Key<'v>(&'v str);

impl<'de> Deserializer<'de> for Key<'de> {
    type Error = Issue;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Issue> {
        visitor.visit_borrowed_str(self.0)
    }

    forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf option unit unit_struct newtype_struct seq tuple
        tuple_struct map struct enum identifier ignored_any
    }
}
