//! A tool's arguments, parsed once (ADR-0019): serde deserializes the JSON object the client sent
//! into the tool's `Args` struct, the same type its `inputSchema` is generated from, and a bad
//! argument becomes an [`InvalidParameter`] naming the parameter and the rule it broke.
//!
//! - `null` is absent, nothing is coerced (`"5"` is not `5`), and unknown keys are ignored.
//! - The arguments are checked in the order the struct declares its fields, a required one that
//!   was not sent included, so the first wrong one in that order is the one reported.
//! - The limits an argument has are the ones its schema advertises: a count is at least the schema's
//!   `minimum` (0 for an unsigned type), and a string is at most `maxLength` characters. They are
//!   written once, as `#[schemars(range(min = 1))]` or `#[schemars(length(max = N))]` on the field.
//! - Every refusal is worded in this file and nowhere else. A value of the wrong kind is worded from
//!   the parameter's own entry in the tool's schema (a string, a number, true or false, one of the
//!   words), which is why a tool's `Args` must be `JsonSchema` too.
//! - A message shows the value that was sent as JSON, whole, and nothing else.

use std::fmt;

use rmcp::model::JsonObject;
use schemars::JsonSchema;
use serde::de::value::StrDeserializer;
use serde::de::{self, DeserializeOwned, DeserializeSeed, Deserializer, IntoDeserializer, MapAccess, Unexpected, Visitor};
use serde::{Deserialize, forward_to_deserialize_any};
use serde_json::{Number, Value};

use crate::errors::InvalidParameter;
use crate::js;
use crate::tool::input_schema;

/// The largest whole number a count or a date may be: 2^53 - 1, the largest integer a JSON number
/// written by a JavaScript client holds exactly. A bigger one is refused, so a count never depends on
/// how far a float can be trusted.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// What a date must be, as the refusal of one that is no whole number says it.
pub const DATE_FORMAT: &str = "Date in YYYYMMDD format (8 digits, valid year/month/day)";

/// A string, number or boolean, as a tool that takes any of the three receives it. The tool's schema
/// is generated from this type, so it advertises the three (`anyOf`).
///
/// No doc comments here: schemars would write each into the schema as a description, and the field
/// that holds a `Scalar` has its own. `tool::input_schema` writes it in place, not as a `$ref`.
#[derive(Debug, Clone, PartialEq, JsonSchema)]
#[serde(untagged)]
pub enum Scalar {
    Text(String),
    Number(f64),
    Flag(bool),
}

impl Scalar {
    /// `String(value)`, as JavaScript writes it: a number as `Number#toString` does (`3`, not `3.0`). This is not
    /// parity code: the value is matched against a property LogSeq stored, and LogSeq is ClojureScript, so its
    /// `(str ?v)` spells a number the JavaScript way.
    pub fn to_js_string(&self) -> String {
        match self {
            Scalar::Text(text) => text.clone(),
            Scalar::Number(number) => js::number_to_string(*number),
            Scalar::Flag(flag) => flag.to_string(),
        }
    }
}

struct ScalarVisitor;

impl<'de> Visitor<'de> for ScalarVisitor {
    type Value = Scalar;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a string, a number or a boolean")
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<Scalar, E> {
        Ok(Scalar::Text(text.to_owned()))
    }

    fn visit_u64<E: de::Error>(self, number: u64) -> Result<Scalar, E> {
        Ok(Scalar::Number(number as f64))
    }

    fn visit_i64<E: de::Error>(self, number: i64) -> Result<Scalar, E> {
        Ok(Scalar::Number(number as f64))
    }

    fn visit_f64<E: de::Error>(self, number: f64) -> Result<Scalar, E> {
        Ok(Scalar::Number(number))
    }

    fn visit_bool<E: de::Error>(self, flag: bool) -> Result<Scalar, E> {
        Ok(Scalar::Flag(flag))
    }
}

impl<'de> Deserialize<'de> for Scalar {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Scalar, D::Error> {
        deserializer.deserialize_any(ScalarVisitor)
    }
}

/// Parse a tool's arguments into its `Args` type.
///
/// This is the one place a tool's arguments are read. A failure is the `InvalidParameter` the tool
/// returns before it makes any LogSeq call.
pub fn parse_args<T: DeserializeOwned + JsonSchema>(arguments: Option<&JsonObject>) -> Result<T, InvalidParameter> {
    let schema = input_schema::<T>();
    let is_sent = |name: &str| arguments.and_then(|sent| sent.get(name)).is_some_and(|value| !value.is_null());
    T::deserialize(Fields { arguments, schema: &schema }).map_err(|error| error.into_invalid_parameter(&schema, is_sent))
}

/// Why an argument was refused, before it is worded.
#[derive(Debug)]
enum Why {
    /// The wrong kind of value for the parameter: a number for a string, a word that is none of the allowed ones
    Mismatch,
    /// A limit broken, worded where it is enforced
    Refused { expected: String, example: Option<String> },
    /// A required parameter was not sent
    Missing(String),
    /// Anything else serde can say; no argument type of ours makes it
    Other(String),
}

/// What serde's `Error` becomes here: the reason, and which argument and what it held.
#[derive(Debug)]
pub struct ArgError {
    why: Why,
    /// The parameter and its value as sent: the value as JSON, and what kind of value it is
    at: Option<(&'static str, String, &'static str)>,
}

impl ArgError {
    fn new(why: Why) -> Self {
        ArgError { why, at: None }
    }

    fn refused(expected: impl Into<String>, example: Option<&str>) -> Self {
        ArgError::new(Why::Refused { expected: expected.into(), example: example.map(str::to_owned) })
    }

    fn at(mut self, param: &'static str, value: &Value) -> Self {
        self.at = Some((param, value.to_string(), kind_of(value)));
        self
    }

    /// The error a model reads. `schema` is the tool's input schema: the words for a wrong kind of
    /// value come from the parameter's own entry in it, and its `required` and the order of its
    /// `properties` say which required argument that was not sent comes before the wrong one.
    /// `is_sent` says whether an argument came with a value.
    fn into_invalid_parameter(self, schema: &JsonObject, is_sent: impl Fn(&str) -> bool) -> InvalidParameter {
        let properties = schema.get("properties").and_then(Value::as_object);
        let property = |param: &str| Kind::of(properties.and_then(|properties| properties.get(param)));
        let (mut why, mut at) = (self.why, self.at);
        // The arguments are checked in declaration order, a missing required one included: one before
        // the wrong one is the one reported
        if let (Some((param, ..)), Some(properties)) = (&at, properties) {
            let required: Vec<&str> = schema.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
            let earlier = properties.keys().take_while(|name| name.as_str() != *param).find(|name| required.contains(&name.as_str()) && !is_sent(name));
            if let Some(name) = earlier {
                (why, at) = (Why::Missing(name.clone()), None);
            }
        }
        match (why, at) {
            (Why::Mismatch, Some((param, value, kind))) => {
                let property = property(param);
                InvalidParameter {
                    param: param.to_owned(),
                    value,
                    expected: property.expected(Some(kind)),
                    example: Some(format!("{param}: {}", property.example())),
                }
            }
            (Why::Refused { expected, example }, Some((param, value, _))) => InvalidParameter {
                param: param.to_owned(),
                value,
                expected,
                example: example.map(|example| format!("{param}: {example}")),
            },
            (Why::Missing(param), _) => {
                let property = property(&param);
                let expected = match property {
                    Kind::Choice(_) => property.expected(None),
                    _ => format!("{} (required)", property.expected(None)),
                };
                InvalidParameter { value: "missing".to_owned(), expected, example: Some(format!("{param}: {}", property.example())), param }
            }
            (Why::Other(text), at) => InvalidParameter {
                param: at.as_ref().map_or("arguments", |(param, ..)| param).to_owned(),
                value: at.map_or_else(|| "invalid".to_owned(), |(_, value, _)| value),
                expected: text,
                example: None,
            },
            // A mismatch or a refusal is always raised for an argument that was sent
            (why, None) => InvalidParameter { param: "arguments".to_owned(), value: "invalid".to_owned(), expected: format!("{why:?}"), example: None },
        }
    }
}

impl fmt::Display for ArgError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid arguments: {:?}", self.why)
    }
}

impl std::error::Error for ArgError {}

impl de::Error for ArgError {
    fn custom<T: fmt::Display>(message: T) -> Self {
        ArgError::new(Why::Other(message.to_string()))
    }

    fn invalid_type(_unexpected: Unexpected<'_>, _expected: &dyn de::Expected) -> Self {
        ArgError::new(Why::Mismatch)
    }

    fn invalid_value(_unexpected: Unexpected<'_>, _expected: &dyn de::Expected) -> Self {
        ArgError::new(Why::Mismatch)
    }

    fn unknown_variant(_variant: &str, _expected: &'static [&'static str]) -> Self {
        ArgError::new(Why::Mismatch)
    }

    fn missing_field(field: &'static str) -> Self {
        ArgError::new(Why::Missing(field.to_owned()))
    }
}

/// What a parameter takes, read from its entry in the tool's input schema, for the words of a refusal.
enum Kind {
    Text,
    Number,
    Flag,
    /// A string, number or boolean
    Scalar,
    /// One of these words
    Choice(Vec<String>),
}

impl Kind {
    fn of(property: Option<&Value>) -> Kind {
        let Some(property) = property else { return Kind::Text };
        if let Some(words) = property.get("enum").and_then(Value::as_array) {
            return Kind::Choice(words.iter().filter_map(Value::as_str).map(str::to_owned).collect());
        }
        // `type` is a name or, for an optional parameter, a list with `null` in it; a union has no `type` of its own
        let mut types: Vec<&str> = match property.get("type") {
            Some(Value::String(name)) => vec![name],
            Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).collect(),
            _ => property
                .get("anyOf")
                .and_then(Value::as_array)
                .map(|branches| branches.iter().filter_map(|branch| branch.get("type").and_then(Value::as_str)).collect())
                .unwrap_or_default(),
        };
        types.retain(|name| *name != "null");
        match types.as_slice() {
            ["integer"] | ["number"] => Kind::Number,
            ["boolean"] => Kind::Flag,
            [_, _, ..] => Kind::Scalar,
            _ => Kind::Text,
        }
    }

    /// What the parameter takes. `got` says what was sent instead: `a string, not a number`.
    fn expected(&self, got: Option<&str>) -> String {
        let (what, says_not) = match self {
            Kind::Text => ("a string".to_owned(), true),
            Kind::Number => ("a number".to_owned(), true),
            Kind::Flag => ("true or false".to_owned(), true),
            Kind::Scalar => ("a string, a number or a boolean".to_owned(), true),
            Kind::Choice(words) => (format!("one of {}", words.iter().map(|word| Value::from(word.as_str()).to_string()).collect::<Vec<_>>().join(", ")), false),
        };
        match got {
            Some(kind) if says_not => format!("{what}, not {kind}"),
            _ => what,
        }
    }

    /// A value that fits, as `Example:` writes it after the parameter's name.
    fn example(&self) -> String {
        match self {
            Kind::Text | Kind::Scalar => "\"...\"".to_owned(),
            Kind::Number => "5".to_owned(),
            Kind::Flag => "true".to_owned(),
            Kind::Choice(words) => words.last().map_or_else(String::new, |word| Value::from(word.as_str()).to_string()),
        }
    }
}

/// What a value is, in the words of the `Expected:` line.
fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
        Value::Number(_) => "a number",
        Value::Bool(_) => "a boolean",
        Value::String(_) => "a string",
        Value::Null => "a null",
    }
}

/// The limits one argument's schema entry sets.
#[derive(Clone, Copy, Default)]
struct Limits {
    /// A count is at least this (`minimum`; 0 for an unsigned type)
    min: u64,
    /// A string is at most this many characters (`maxLength`)
    max_chars: Option<usize>,
}

impl Limits {
    fn of(property: Option<&Value>) -> Limits {
        let number = |key: &str| property.and_then(|property| property.get(key)).and_then(|limit| limit.as_u64().or_else(|| limit.as_f64().map(|limit| limit as u64)));
        Limits { min: number("minimum").unwrap_or(0), max_chars: number("maxLength").map(|limit| limit as usize) }
    }
}

/// The object the client sent, as a struct's deserializer. Fields are offered in the order the
/// struct declares them, and only those that were sent and are not `null`. `schema` is the tool's
/// input schema, which sets each argument's limits.
struct Fields<'a> {
    arguments: Option<&'a JsonObject>,
    schema: &'a JsonObject,
}

impl<'de> Deserializer<'de> for Fields<'de> {
    type Error = ArgError;

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, ArgError> {
        let properties = self.schema.get("properties").and_then(Value::as_object);
        let sent: Vec<(&'static str, &'de Value, Limits)> = fields
            .iter()
            .filter_map(|field| {
                let value = self.arguments?.get(*field).filter(|value| !value.is_null())?;
                Some((*field, value, Limits::of(properties.and_then(|properties| properties.get(*field)))))
            })
            .collect();
        visitor.visit_map(Sent { items: sent.into_iter(), current: None })
    }

    fn deserialize_any<V: Visitor<'de>>(self, _visitor: V) -> Result<V::Value, ArgError> {
        Err(ArgError::new(Why::Other("a tool's arguments are a struct".to_owned())))
    }

    forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf option unit unit_struct
        newtype_struct seq tuple tuple_struct map enum identifier ignored_any
    }
}

struct Sent<'de> {
    items: std::vec::IntoIter<(&'static str, &'de Value, Limits)>,
    current: Option<(&'static str, &'de Value, Limits)>,
}

impl<'de> MapAccess<'de> for Sent<'de> {
    type Error = ArgError;

    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>, ArgError> {
        let Some(next) = self.items.next() else { return Ok(None) };
        let name = next.0;
        self.current = Some(next);
        let key: StrDeserializer<'static, ArgError> = name.into_deserializer();
        seed.deserialize(key).map(Some)
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, ArgError> {
        let (name, value, limits) = self.current.take().expect("a value follows its key");
        seed.deserialize(Argument { value, limits }).map_err(|error| error.at(name, value))
    }
}

/// One argument's JSON value as a deserializer. A string, a boolean and a number are handed to the
/// visitor as what they are; an array or an object is the wrong kind for every argument we take.
///
/// A count (`u8` to `u64`) is a whole number from the schema's minimum up to [`MAX_SAFE_INTEGER`]. A
/// signed integer (`i8` to `i64`) is a date (`YYYYMMDD`), the one signed number a tool takes. A string
/// is at most the schema's `maxLength` characters.
struct Argument<'de> {
    value: &'de Value,
    limits: Limits,
}

impl<'de> Argument<'de> {
    /// The whole number a JSON number holds, within 2^53 - 1 either way, or `None`.
    fn whole(number: &Number) -> Option<i64> {
        let n = number.as_f64().expect("a JSON number is finite");
        (n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64).then_some(n as i64)
    }

    /// A count: a whole number from the minimum up to the largest safe integer.
    fn count<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ArgError> {
        let Value::Number(number) = self.value else { return Err(ArgError::new(Why::Mismatch)) };
        let n = number.as_f64().expect("a JSON number is finite");
        if n.fract() != 0.0 {
            return Err(ArgError::refused("an integer, not a fraction", Some("5")));
        }
        if n > MAX_SAFE_INTEGER as f64 {
            return Err(ArgError::refused(format!("at most {MAX_SAFE_INTEGER}"), None));
        }
        let min = self.limits.min;
        if n < min as f64 {
            return Err(ArgError::refused(format!("at least {min}"), Some(&min.to_string())));
        }
        visitor.visit_u64(n as u64)
    }

    /// A date: a whole number within 2^53 - 1 either way. Whether it is a real day is the tool's to say.
    fn date<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ArgError> {
        let Value::Number(number) = self.value else { return Err(ArgError::new(Why::Mismatch)) };
        match Self::whole(number) {
            Some(n) => visitor.visit_i64(n),
            None => Err(ArgError::refused(DATE_FORMAT, Some("20251115"))),
        }
    }

    /// A string, if it is not longer than the schema's `maxLength`, counted in characters (code points, which
    /// is what `maxLength` counts).
    fn text<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ArgError> {
        match (self.value, self.limits.max_chars) {
            (Value::String(text), Some(max)) if text.chars().count() > max => Err(ArgError::refused(format!("at most {max} characters"), None)),
            _ => self.any(visitor),
        }
    }

    fn any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ArgError> {
        match self.value {
            Value::Null => visitor.visit_unit(),
            Value::Bool(flag) => visitor.visit_bool(*flag),
            Value::String(text) => visitor.visit_str(text),
            Value::Number(number) => match (number.as_u64(), number.as_i64()) {
                (Some(unsigned), _) => visitor.visit_u64(unsigned),
                (None, Some(signed)) => visitor.visit_i64(signed),
                (None, None) => visitor.visit_f64(number.as_f64().expect("a JSON number is finite")),
            },
            Value::Array(_) | Value::Object(_) => Err(ArgError::new(Why::Mismatch)),
        }
    }
}

macro_rules! counts {
    ($($method:ident)*) => {
        $(fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ArgError> { self.count(visitor) })*
    };
}

macro_rules! dates {
    ($($method:ident)*) => {
        $(fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ArgError> { self.date(visitor) })*
    };
}

macro_rules! texts {
    ($($method:ident)*) => {
        $(fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ArgError> { self.text(visitor) })*
    };
}

impl<'de> Deserializer<'de> for Argument<'de> {
    type Error = ArgError;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ArgError> {
        self.any(visitor)
    }

    counts! { deserialize_u8 deserialize_u16 deserialize_u32 deserialize_u64 }
    dates! { deserialize_i8 deserialize_i16 deserialize_i32 deserialize_i64 }
    texts! { deserialize_str deserialize_string }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ArgError> {
        if self.value.is_null() { visitor.visit_none() } else { visitor.visit_some(self) }
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, ArgError> {
        match self.value {
            Value::String(word) => visitor.visit_enum(word.as_str().into_deserializer()),
            _ => Err(ArgError::new(Why::Mismatch)),
        }
    }

    forward_to_deserialize_any! {
        bool i128 u128 f32 f64 char bytes byte_buf unit unit_struct newtype_struct seq tuple tuple_struct map
        struct identifier ignored_any
    }
}

/// What a tool's own tests parse its arguments with.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use serde_json::json;

    /// `parse_args` on a JSON object, an error as the message a model reads.
    pub(crate) fn parse<T: DeserializeOwned + JsonSchema>(arguments: Value) -> Result<T, String> {
        parse_args::<T>(arguments.as_object()).map_err(|error| error.to_string())
    }

    /// The message a refused call gets. Panics if the arguments are accepted.
    pub(crate) fn refusal<T: DeserializeOwned + JsonSchema>(arguments: Value) -> String {
        match parse::<T>(arguments.clone()) {
            Ok(_) => panic!("{arguments} was accepted"),
            Err(message) => message,
        }
    }

    /// What a parameter takes, for [`sweep`].
    #[derive(Clone, Copy)]
    pub(crate) enum Takes {
        Text,
        /// A whole number, from this minimum
        Count(u64),
        Flag,
        /// One of these words
        Words(&'static [&'static str]),
        /// A `YYYYMMDD` number
        Date,
        Scalar,
    }

    fn message(param: &str, shown: &str, expected: &str, example: Option<&str>) -> String {
        match example {
            Some(example) => format!("Invalid parameter '{param}': {shown}\n\nExpected: {expected}\nExample: {param}: {example}"),
            None => format!("Invalid parameter '{param}': {shown}\n\nExpected: {expected}"),
        }
    }

    fn listed(words: &[&str]) -> String {
        format!("one of {}", words.iter().map(|word| Value::from(*word).to_string()).collect::<Vec<_>>().join(", "))
    }

    /// Every kind of value a parameter must refuse, with the message it gets, and a few it must take;
    /// then its absence and `null`, refused with `missing` if the parameter is `required` and taken
    /// if not. `base` is a valid call without `param`, which each value is added to.
    pub(crate) fn sweep<T: DeserializeOwned + JsonSchema>(base: Value, param: &str, takes: Takes, required: bool) {
        let call = |value: Option<Value>| {
            let mut arguments = base.clone();
            if let Some(value) = value {
                arguments[param] = value;
            }
            arguments
        };
        let wrong_kinds = [json!(5), json!(true), json!(["a"]), json!({"a": 1}), json!("5")];
        // (what is sent, the message it gets)
        let mut refused: Vec<(Value, String)> = Vec::new();
        let mut taken: Vec<Value> = Vec::new();
        let mut refuse_kinds = |is_right: fn(&Value) -> bool, expected: &dyn Fn(&str) -> String, example: &str| {
            for value in wrong_kinds.iter().filter(|value| !is_right(value)) {
                refused.push((value.clone(), message(param, &value.to_string(), &expected(kind_of(value)), Some(example))));
            }
        };
        let missing = match takes {
            Takes::Text => {
                refuse_kinds(Value::is_string, &|kind| format!("a string, not {kind}"), "\"...\"");
                taken.extend([json!(""), json!("Alice")]);
                message(param, "missing", "a string (required)", Some("\"...\""))
            }
            Takes::Scalar => {
                refuse_kinds(
                    |value| !(value.is_array() || value.is_object()),
                    &|kind| format!("a string, a number or a boolean, not {kind}"),
                    "\"...\"",
                );
                taken.extend([json!(""), json!("a"), json!(3), json!(2.5), json!(true)]);
                message(param, "missing", "a string, a number or a boolean (required)", Some("\"...\""))
            }
            Takes::Flag => {
                refuse_kinds(Value::is_boolean, &|kind| format!("true or false, not {kind}"), "true");
                taken.extend([json!(true), json!(false)]);
                message(param, "missing", "true or false (required)", Some("true"))
            }
            Takes::Words(words) => {
                let example = Value::from(*words.last().expect("a word")).to_string();
                for value in wrong_kinds.iter().chain([&json!("nope"), &json!("")]) {
                    refused.push((value.clone(), message(param, &value.to_string(), &listed(words), Some(&example))));
                }
                taken.extend(words.iter().map(|word| json!(word)));
                message(param, "missing", &listed(words), Some(&example))
            }
            Takes::Count(min) => {
                refuse_kinds(Value::is_number, &|kind| format!("a number, not {kind}"), "5");
                for fraction in [json!(2.5), json!(-0.5)] {
                    refused.push((fraction.clone(), message(param, &fraction.to_string(), "an integer, not a fraction", Some("5"))));
                }
                for below in std::iter::once(json!(-1)).chain((min > 0).then(|| json!(min - 1))) {
                    refused.push((below.clone(), message(param, &below.to_string(), &format!("at least {min}"), Some(&min.to_string()))));
                }
                refused.push((json!(9_007_199_254_740_992u64), message(param, "9007199254740992", "at most 9007199254740991", None)));
                taken.extend([json!(min), json!(min + 1), json!(9_007_199_254_740_991u64), json!(min as f64)]);
                message(param, "missing", "a number (required)", Some("5"))
            }
            Takes::Date => {
                refuse_kinds(Value::is_number, &|kind| format!("a number, not {kind}"), "5");
                let format = "Date in YYYYMMDD format (8 digits, valid year/month/day)";
                refused.push((json!(20251115.5), message(param, "20251115.5", format, Some("20251115"))));
                refused.push((json!(9_007_199_254_740_992u64), message(param, "9007199254740992", format, Some("20251115"))));
                refused.push((json!(-9_007_199_254_740_992i64), message(param, "-9007199254740992", format, Some("20251115"))));
                taken.extend([json!(20251115), json!(20251115.0), json!(0), json!(-3)]);
                message(param, "missing", "a number (required)", Some("5"))
            }
        };
        for (value, expected) in refused {
            assert_eq!(refusal::<T>(call(Some(value.clone()))), expected, "{param} = {value}");
        }
        for value in taken {
            if let Err(error) = parse::<T>(call(Some(value.clone()))) {
                panic!("{param} = {value} was refused: {error}");
            }
        }
        for absent in [None, Some(Value::Null)] {
            let outcome = parse::<T>(call(absent.clone()));
            if required {
                assert_eq!(outcome.err().as_deref(), Some(missing.as_str()), "{param} sent as {absent:?}");
            } else if let Err(error) = outcome {
                panic!("{param} is optional, but sending it as {absent:?} was refused: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One field of each kind a tool takes, in the order a tool declares them: required first.
    #[derive(Debug, Deserialize, JsonSchema, PartialEq)]
    #[allow(dead_code)]
    struct Sample {
        name: String,
        #[schemars(length(max = 3))]
        short: String,
        kind: Kind2,
        value: Scalar,
        limit: Option<u64>,
        #[serde(default = "five")]
        depth: u64,
        #[serde(default = "one")]
        #[schemars(range(min = 1))]
        nodes: u64,
        #[schemars(range(min = 1))]
        last: Option<u64>,
        #[schemars(with = "Option<f64>")]
        day: Option<i64>,
        #[serde(default)]
        flag: bool,
        format: Option<Kind2>,
        note: Option<String>,
    }

    fn five() -> u64 {
        5
    }

    fn one() -> u64 {
        1
    }

    #[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq)]
    #[serde(rename_all = "kebab-case")]
    #[schemars(inline)]
    enum Kind2 {
        Plain,
        Markdown,
    }

    fn arguments(value: Value) -> Option<JsonObject> {
        value.as_object().cloned()
    }

    /// The arguments a call must always have, plus `extra`.
    fn sample(extra: Value) -> Result<Sample, String> {
        let mut sent = json!({"name": "Alice", "short": "abc", "kind": "plain", "value": 1});
        sent.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        parse_args::<Sample>(arguments(sent).as_ref()).map_err(|error| error.to_string())
    }

    fn message(param: &str, value: &str, expected: &str, example: Option<&str>) -> String {
        match example {
            Some(example) => format!("Invalid parameter '{param}': {value}\n\nExpected: {expected}\nExample: {param}: {example}"),
            None => format!("Invalid parameter '{param}': {value}\n\nExpected: {expected}"),
        }
    }

    #[test]
    fn what_was_sent_is_parsed_into_the_struct_and_defaults_fill_in() {
        let parsed = sample(json!({})).unwrap();
        assert_eq!(
            parsed,
            Sample {
                name: "Alice".into(),
                short: "abc".into(),
                kind: Kind2::Plain,
                value: Scalar::Number(1.0),
                limit: None,
                depth: 5,
                nodes: 1,
                last: None,
                day: None,
                flag: false,
                format: None,
                note: None,
            }
        );
        let parsed = sample(json!({"limit": 0, "depth": 9007199254740991u64, "nodes": 1, "last": 7, "day": 20250101, "flag": true, "format": "markdown", "note": "", "extra": [1]})).unwrap();
        assert_eq!((parsed.limit, parsed.depth, parsed.nodes, parsed.last, parsed.day), (Some(0), 9_007_199_254_740_991, 1, Some(7), Some(20_250_101)));
        assert_eq!((parsed.flag, parsed.format, parsed.note.as_deref()), (true, Some(Kind2::Markdown), Some("")));
        // a whole number written with a fraction part is still whole, and a negative date is a date
        let parsed = sample(json!({"limit": 5.0, "day": -3})).unwrap();
        assert_eq!((parsed.limit, parsed.day), (Some(5), Some(-3)));
    }

    #[test]
    fn null_is_absent_and_a_default_fills_in() {
        let parsed = sample(json!({"limit": null, "depth": null, "nodes": null, "flag": null, "format": null, "note": null, "day": null, "last": null})).unwrap();
        assert_eq!((parsed.limit, parsed.depth, parsed.flag, parsed.format, parsed.note), (None, 5, false, None, None));
        // a required argument sent as null is missing
        assert_eq!(
            parse_args::<Sample>(arguments(json!({"name": null})).as_ref()).unwrap_err().to_string(),
            message("name", "missing", "a string (required)", Some("\"...\""))
        );
        assert_eq!(
            parse_args::<Sample>(None).unwrap_err().to_string(),
            message("name", "missing", "a string (required)", Some("\"...\""))
        );
    }

    #[test]
    fn a_wrong_kind_of_value_says_what_the_parameter_takes_and_what_was_sent() {
        let bad = |extra: Value| sample(extra).unwrap_err();
        assert_eq!(bad(json!({"name": 5})), message("name", "5", "a string, not a number", Some("\"...\"")));
        assert_eq!(bad(json!({"note": ["a"]})), message("note", "[\"a\"]", "a string, not an array", Some("\"...\"")));
        assert_eq!(bad(json!({"note": {"a": 1}})), message("note", "{\"a\":1}", "a string, not an object", Some("\"...\"")));
        assert_eq!(bad(json!({"flag": "yes"})), message("flag", "\"yes\"", "true or false, not a string", Some("true")));
        assert_eq!(bad(json!({"flag": 0})), message("flag", "0", "true or false, not a number", Some("true")));
        for (sent, shown, kind) in [(json!("5"), "\"5\"", "a string"), (json!(true), "true", "a boolean"), (json!([1]), "[1]", "an array"), (json!({}), "{}", "an object")] {
            assert_eq!(bad(json!({"limit": sent.clone()})), message("limit", shown, &format!("a number, not {kind}"), Some("5")));
            assert_eq!(bad(json!({"day": sent.clone()})), message("day", shown, &format!("a number, not {kind}"), Some("5")));
            assert_eq!(bad(json!({"nodes": sent.clone()})), message("nodes", shown, &format!("a number, not {kind}"), Some("5")));
            assert_eq!(bad(json!({"last": sent})), message("last", shown, &format!("a number, not {kind}"), Some("5")));
        }
    }

    #[test]
    fn an_enum_takes_one_of_its_words_and_says_so_for_anything_else() {
        for (sent, shown) in [(json!("xml"), "\"xml\""), (json!(5), "5"), (json!(true), "true"), (json!(["plain"]), "[\"plain\"]"), (json!({}), "{}")] {
            let expected = "one of \"plain\", \"markdown\"";
            assert_eq!(sample(json!({"format": sent.clone()})).unwrap_err(), message("format", shown, expected, Some("\"markdown\"")));
            assert_eq!(sample(json!({"kind": sent})).unwrap_err(), message("kind", shown, expected, Some("\"markdown\"")));
        }
        assert_eq!(sample(json!({"format": "Plain"})).unwrap_err(), message("format", "\"Plain\"", "one of \"plain\", \"markdown\"", Some("\"markdown\"")));
        assert_eq!(sample(json!({"kind": "markdown"})).unwrap().kind, Kind2::Markdown);
    }

    #[test]
    fn a_scalar_is_a_string_a_number_or_a_boolean_and_is_written_as_javascript_writes_it() {
        let value = |sent: Value| sample(json!({"value": sent})).map(|parsed| parsed.value);
        assert_eq!(value(json!("a")).unwrap(), Scalar::Text("a".into()));
        assert_eq!(value(json!("")).unwrap().to_js_string(), "");
        assert_eq!(value(json!(3)).unwrap().to_js_string(), "3");
        assert_eq!(value(json!(3.0)).unwrap().to_js_string(), "3");
        assert_eq!(value(json!(-3)).unwrap().to_js_string(), "-3");
        assert_eq!(value(json!(2.5)).unwrap().to_js_string(), "2.5");
        assert_eq!(value(json!(1e21)).unwrap().to_js_string(), "1e+21");
        assert_eq!(value(json!(true)).unwrap().to_js_string(), "true");
        assert_eq!(value(json!(false)).unwrap().to_js_string(), "false");
        assert_eq!(
            value(json!(["a"])).unwrap_err(),
            message("value", "[\"a\"]", "a string, a number or a boolean, not an array", Some("\"...\""))
        );
        assert_eq!(
            value(json!({"a": 1})).unwrap_err(),
            message("value", "{\"a\":1}", "a string, a number or a boolean, not an object", Some("\"...\""))
        );
        let missing = parse_args::<Sample>(arguments(json!({"name": "a", "short": "b", "kind": "plain"})).as_ref()).unwrap_err();
        assert_eq!(missing.to_string(), message("value", "missing", "a string, a number or a boolean (required)", Some("\"...\"")));
    }

    #[test]
    fn a_required_argument_is_missing_when_not_sent_and_an_enum_says_which_words() {
        let missing = |sent: Value| parse_args::<Sample>(arguments(sent).as_ref()).unwrap_err().to_string();
        assert_eq!(missing(json!({})), message("name", "missing", "a string (required)", Some("\"...\"")));
        assert_eq!(missing(json!({"name": "a", "short": "b"})), message("kind", "missing", "one of \"plain\", \"markdown\"", Some("\"markdown\"")));
        // arguments are checked in declaration order: a required one that was not sent is reported
        // before a wrong one declared after it, and after a wrong one declared before it
        assert_eq!(missing(json!({"name": "a", "limit": "x"})), message("short", "missing", "a string (required)", Some("\"...\"")));
        assert_eq!(missing(json!({"name": 5})), message("name", "5", "a string, not a number", Some("\"...\"")));
        assert_eq!(
            missing(json!({"name": "a", "short": "b", "kind": "plain", "value": 1, "limit": "x"})),
            message("limit", "\"x\"", "a number, not a string", Some("5"))
        );
    }

    #[test]
    fn the_first_wrong_argument_in_declaration_order_is_the_one_reported() {
        assert_eq!(
            sample(json!({"note": 1, "limit": "x", "name": 5})).unwrap_err(),
            message("name", "5", "a string, not a number", Some("\"...\""))
        );
        assert_eq!(
            sample(json!({"flag": 1, "limit": "x"})).unwrap_err(),
            message("limit", "\"x\"", "a number, not a string", Some("5"))
        );
    }

    #[test]
    fn a_count_is_a_whole_number_from_its_minimum_up_to_the_largest_safe_integer() {
        let bad = |extra: Value| sample(extra).unwrap_err();
        assert_eq!(sample(json!({"limit": 0})).unwrap().limit, Some(0));
        assert_eq!(sample(json!({"limit": 9007199254740991u64})).unwrap().limit, Some(9_007_199_254_740_991));
        assert_eq!(bad(json!({"limit": 2.5})), message("limit", "2.5", "an integer, not a fraction", Some("5")));
        assert_eq!(bad(json!({"limit": -1.5})), message("limit", "-1.5", "an integer, not a fraction", Some("5")));
        assert_eq!(bad(json!({"limit": -1})), message("limit", "-1", "at least 0", Some("0")));
        assert_eq!(bad(json!({"limit": -9007199254740991i64})), message("limit", "-9007199254740991", "at least 0", Some("0")));
        assert_eq!(bad(json!({"limit": 9007199254740992u64})), message("limit", "9007199254740992", "at most 9007199254740991", None));
        assert_eq!(bad(json!({"limit": 1e300})), message("limit", "1e+300", "at most 9007199254740991", None));
        assert_eq!(bad(json!({"limit": -1e300})), message("limit", "-1e+300", "at least 0", Some("0")));
        assert_eq!(bad(json!({"depth": 18446744073709551615u64})), message("depth", "18446744073709551615", "at most 9007199254740991", None));
    }

    #[test]
    fn a_minimum_above_zero_is_named_in_the_message() {
        let bad = |extra: Value| sample(extra).unwrap_err();
        assert_eq!(sample(json!({"nodes": 1})).unwrap().nodes, 1);
        assert_eq!(bad(json!({"nodes": 0})), message("nodes", "0", "at least 1", Some("1")));
        assert_eq!(bad(json!({"nodes": -5})), message("nodes", "-5", "at least 1", Some("1")));
        assert_eq!(bad(json!({"nodes": 1.5})), message("nodes", "1.5", "an integer, not a fraction", Some("5")));
        assert_eq!(bad(json!({"nodes": 1e300})), message("nodes", "1e+300", "at most 9007199254740991", None));
        assert_eq!(bad(json!({"last": 0})), message("last", "0", "at least 1", Some("1")));
        assert_eq!(bad(json!({"last": -1})), message("last", "-1", "at least 1", Some("1")));
        assert_eq!(sample(json!({"last": 1})).unwrap().last, Some(1));
    }

    #[test]
    fn a_date_is_a_whole_number_within_the_safe_range_and_may_be_negative() {
        let bad = |extra: Value| sample(extra).unwrap_err();
        let format = "Date in YYYYMMDD format (8 digits, valid year/month/day)";
        assert_eq!(bad(json!({"day": 1.5})), message("day", "1.5", format, Some("20251115")));
        assert_eq!(bad(json!({"day": 1e300})), message("day", "1e+300", format, Some("20251115")));
        assert_eq!(bad(json!({"day": -1e300})), message("day", "-1e+300", format, Some("20251115")));
        assert_eq!(bad(json!({"day": 9007199254740992u64})), message("day", "9007199254740992", format, Some("20251115")));
        assert_eq!(sample(json!({"day": 9007199254740991u64})).unwrap().day, Some(9_007_199_254_740_991));
        assert_eq!(sample(json!({"day": -9007199254740991i64})).unwrap().day, Some(-9_007_199_254_740_991));
    }

    #[test]
    fn a_text_with_a_maximum_counts_characters_and_says_so_with_the_whole_text() {
        assert_eq!(sample(json!({"short": ""})).unwrap().short, "");
        // an emoji is one character, not two UTF-16 units
        assert_eq!(sample(json!({"short": "ab\u{1F600}"})).unwrap().short, "ab\u{1F600}");
        assert_eq!(sample(json!({"short": "abc\u{1F600}"})).unwrap_err(), message("short", "\"abc\u{1F600}\"", "at most 3 characters", None));
        assert_eq!(sample(json!({"short": 5})).unwrap_err(), message("short", "5", "a string, not a number", Some("\"...\"")));
    }

    #[test]
    fn a_kind_is_read_from_the_schema_entry_whatever_the_parameter_is_called() {
        // `format` and `title` are parameters here, not schema keywords
        #[derive(Debug, Deserialize, JsonSchema)]
        #[allow(dead_code)]
        struct Named {
            format: Option<String>,
            title: bool,
        }
        assert_eq!(
            parse_args::<Named>(arguments(json!({"title": true, "format": 1})).as_ref()).unwrap_err().to_string(),
            message("format", "1", "a string, not a number", Some("\"...\""))
        );
        assert_eq!(
            parse_args::<Named>(arguments(json!({"title": "x"})).as_ref()).unwrap_err().to_string(),
            message("title", "\"x\"", "true or false, not a string", Some("true"))
        );
    }

    #[test]
    fn a_wrong_value_is_shown_as_json_and_a_number_as_serde_writes_it() {
        for (sent, shown, kind) in [
            (json!(42), "42", "a number"),
            (json!(true), "true", "a boolean"),
            (json!(["a"]), "[\"a\"]", "an array"),
            (json!({"b": 1, "1": 2}), "{\"b\":1,\"1\":2}", "an object"),
            // a number is written as serde writes it, not as JavaScript does (`100000000000000000000`)
            (json!(1e20), "1e+20", "a number"),
            (json!(1e21), "1e+21", "a number"),
        ] {
            assert_eq!(sample(json!({"name": sent})).unwrap_err(), message("name", shown, &format!("a string, not {kind}"), Some("\"...\"")));
        }
    }

    #[test]
    fn a_struct_with_no_fields_takes_anything() {
        #[derive(Debug, Deserialize, JsonSchema)]
        struct Nothing {}
        assert!(parse_args::<Nothing>(None).is_ok());
        assert!(parse_args::<Nothing>(arguments(json!({"a": 1})).as_ref()).is_ok());
    }
}
