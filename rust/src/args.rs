//! Reading a tool's arguments one by one, in the order its schema lists them, as `parseArgs`
//! reads them (`src/utils/parse-args.ts`): `null` is absent, nothing is coerced, and the first
//! argument that is wrong is the one reported, in the words of the TypeScript server
//! (`InvalidParameterError`).
//!
//! A tool reads every argument through [`Arguments`] before it makes a LogSeq call, so a bad
//! argument fails first, and the schema (`input_schema`, generated from the tool's argument type)
//! and these readers are held together by the parity cases.

use rmcp::model::JsonObject;
use serde_json::Value;

use crate::errors::InvalidParameter;
use crate::js;

/// The largest whole number a JavaScript number holds exactly, and so the largest `z.int()` takes.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

// A string, number or boolean, as a tool that takes any of the three receives it. The tool's schema
// is generated from this type, so it advertises the three (`anyOf`).
//
// No doc comments here: schemars would write each into the schema as a description, and the field
// that holds a `Scalar` has its own. `tool::input_schema` writes it in place, not as a `$ref`.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum Scalar {
    Text(String),
    Number(f64),
    Flag(bool),
}

impl Scalar {
    /// `String(value)`, as JavaScript writes it: a number as `Number#toString` does (`3`, not `3.0`).
    pub fn to_js_string(&self) -> String {
        match self {
            Scalar::Text(text) => text.clone(),
            Scalar::Number(number) => js::number_to_string(*number),
            Scalar::Flag(flag) => flag.to_string(),
        }
    }
}

/// A tool's arguments as sent: unknown keys are ignored and `null` counts as absent.
pub struct Arguments<'a> {
    args: Option<&'a JsonObject>,
}

impl<'a> Arguments<'a> {
    pub fn new(args: Option<&'a JsonObject>) -> Self {
        Arguments { args }
    }

    fn sent(&self, param: &str) -> Option<&'a Value> {
        self.args.and_then(|args| args.get(param)).filter(|value| !value.is_null())
    }

    /// An optional string (`z.string().optional()`).
    pub fn optional_string(&self, param: &str) -> Result<Option<String>, InvalidParameter> {
        match self.sent(param) {
            None => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.clone())),
            Some(other) => Err(wrong(param, other, format!("a string, not {}", kind_of(other)), Some(format!("{param}: \"...\"")))),
        }
    }

    /// An optional whole number, negative or not: a `YYYYMMDD` date, which the schema calls a number
    /// (`z.number().optional()`) and the tool then reads as an integer. A fraction, or a number past
    /// the largest safe integer, is worded as [`Arguments::optional_count`] words it, with `example` (a value
    /// that fits the argument, such as a date) in place of `5` after `Example:`.
    pub fn optional_whole(&self, param: &str, example: &str) -> Result<Option<i64>, InvalidParameter> {
        self.optional_whole_or(param, |value, why| not_whole(param, value, why, example))
    }

    /// [`Arguments::optional_whole`] with the tool's own words for a number that is no whole number
    /// in the safe range: `unusable` gets the value and why it failed.
    pub fn optional_whole_or(
        &self,
        param: &str,
        unusable: impl FnOnce(&Value, NotWhole) -> InvalidParameter,
    ) -> Result<Option<i64>, InvalidParameter> {
        match self.sent(param) {
            None => Ok(None),
            Some(value @ Value::Number(number)) => whole(number).map(Some).map_err(|why| unusable(value, why)),
            Some(other) => Err(wrong(param, other, format!("a number, not {}", kind_of(other)), Some(format!("{param}: 5")))),
        }
    }

    /// A required string (`z.string()`). An empty string is a string.
    pub fn required_string(&self, param: &str) -> Result<String, InvalidParameter> {
        match self.sent(param) {
            Some(Value::String(text)) => Ok(text.clone()),
            None => Err(InvalidParameter {
                param: param.to_owned(),
                value: "missing".to_owned(),
                expected: "a string (required)".to_owned(),
                example: Some(format!("{param}: \"...\"")),
            }),
            Some(other) => Err(wrong(param, other, format!("a string, not {}", kind_of(other)), Some(format!("{param}: \"...\"")))),
        }
    }

    /// A required string of at most `max` UTF-16 code units (`z.string().max(max)`), which is what
    /// `.length` counts. A longer one is zod's own `Too big`, with the whole text as the value and no example.
    pub fn required_string_max(&self, param: &str, max: usize) -> Result<String, InvalidParameter> {
        let text = self.required_string(param)?;
        if text.encode_utf16().count() > max {
            return Err(InvalidParameter {
                param: param.to_owned(),
                value: js::json_stringify(&Value::String(text)),
                expected: format!("Too big: expected string to have <={max} characters"),
                example: None,
            });
        }
        Ok(text)
    }

    /// A required string that must be one of `values` (`z.enum([...])`). Absent or `null` is
    /// `missing`, and anything else is worded as [`Arguments::optional_enum`] words it.
    pub fn required_enum(&self, param: &str, values: &[&'static str]) -> Result<&'static str, InvalidParameter> {
        match self.optional_enum(param, values)? {
            Some(value) => Ok(value),
            None => {
                let shown: Vec<String> = values.iter().map(|value| js::json_stringify(&Value::from(*value))).collect();
                let example = values.last().map(|last| format!("{param}: {}", js::json_stringify(&Value::from(*last))));
                Err(InvalidParameter { param: param.to_owned(), value: "missing".to_owned(), expected: format!("one of {}", shown.join(", ")), example })
            }
        }
    }

    /// An optional string that must be one of `values` (`z.enum([...]).optional()`). Whatever else
    /// is sent, a number or a list as much as a wrong word, is "one of ..." with the last value
    /// as the example, as zod's `invalid_value` is.
    pub fn optional_enum(&self, param: &str, values: &[&'static str]) -> Result<Option<&'static str>, InvalidParameter> {
        let Some(sent) = self.sent(param) else { return Ok(None) };
        if let Some(value) = sent.as_str().and_then(|text| values.iter().find(|value| **value == text)) {
            return Ok(Some(value));
        }
        let shown: Vec<String> = values.iter().map(|value| js::json_stringify(&Value::from(*value))).collect();
        let example = values.last().map(|last| format!("{param}: {}", js::json_stringify(&Value::from(*last))));
        Err(wrong(param, sent, format!("one of {}", shown.join(", ")), example))
    }

    /// A boolean with a default (`z.boolean().default(..)`).
    pub fn boolean(&self, param: &str, default: bool) -> Result<bool, InvalidParameter> {
        match self.sent(param) {
            None => Ok(default),
            Some(Value::Bool(flag)) => Ok(*flag),
            Some(other) => Err(wrong(param, other, format!("true or false, not {}", kind_of(other)), Some(format!("{param}: true")))),
        }
    }

    /// A required string, number or boolean (`z.union([z.string(), z.number(), z.boolean()])`).
    pub fn required_scalar(&self, param: &str) -> Result<Scalar, InvalidParameter> {
        const KINDS: &str = "a string, a number or a boolean";
        match self.sent(param) {
            Some(Value::String(text)) => Ok(Scalar::Text(text.clone())),
            Some(Value::Number(number)) => Ok(Scalar::Number(number.as_f64().expect("a JSON number is finite"))),
            Some(Value::Bool(flag)) => Ok(Scalar::Flag(*flag)),
            None => Err(InvalidParameter {
                param: param.to_owned(),
                value: "missing".to_owned(),
                expected: format!("{KINDS} (required)"),
                example: Some(format!("{param}: \"...\"")),
            }),
            Some(other) => Err(wrong(param, other, format!("{KINDS}, not {}", kind_of(other)), Some(format!("{param}: \"...\"")))),
        }
    }

    /// An optional count (`z.int().min(min).optional()`).
    pub fn optional_count(&self, param: &str, min: u64) -> Result<Option<u64>, InvalidParameter> {
        match self.sent(param) {
            None => Ok(None),
            Some(value) => count(param, value, min).map(Some),
        }
    }

    /// A count with a default (`z.int().min(min).default(..)`).
    pub fn count_or(&self, param: &str, min: u64, default: u64) -> Result<u64, InvalidParameter> {
        Ok(self.optional_count(param, min)?.unwrap_or(default))
    }
}

/// `z.int().min(min)`: a whole number from `min` up to the largest safe integer. A value above
/// that is the tool's to clamp, since the schema names no maximum of its own.
fn count(param: &str, value: &Value, min: u64) -> Result<u64, InvalidParameter> {
    let Value::Number(number) = value else {
        // zod reports `number` as what was expected of anything that isn't one
        return Err(wrong(param, value, format!("a number, not {}", kind_of(value)), Some(format!("{param}: 5"))));
    };
    let n = whole(number).map_err(|why| not_whole(param, value, why, &format!("{param}: 5")))?;
    if n < min as i64 {
        return Err(wrong(param, value, format!("at least {min}"), Some(format!("{param}: {min}"))));
    }
    Ok(n as u64)
}

/// Why a number is not one `z.int()` takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotWhole {
    Fraction,
    TooBig,
    TooSmall,
}

/// `z.int()`: a whole number from -(2^53 - 1) to 2^53 - 1, the range a JavaScript number holds exactly.
fn whole(number: &serde_json::Number) -> Result<i64, NotWhole> {
    let n = number.as_f64().expect("a JSON number is finite");
    if n.fract() != 0.0 {
        return Err(NotWhole::Fraction);
    }
    if n > MAX_SAFE_INTEGER {
        return Err(NotWhole::TooBig);
    }
    if n < -MAX_SAFE_INTEGER {
        return Err(NotWhole::TooSmall);
    }
    Ok(n as i64)
}

/// zod's words for a number `z.int()` refuses.
fn not_whole(param: &str, value: &Value, why: NotWhole, example: &str) -> InvalidParameter {
    match why {
        NotWhole::Fraction => wrong(param, value, "an integer, not a fraction".to_owned(), Some(example.to_owned())),
        NotWhole::TooBig => wrong(param, value, "Too big: expected int to be <9007199254740991".to_owned(), None),
        NotWhole::TooSmall => wrong(param, value, "Too small: expected int to be >-9007199254740991".to_owned(), None),
    }
}

fn wrong(param: &str, value: &Value, expected: String, example: Option<String>) -> InvalidParameter {
    InvalidParameter { param: param.to_owned(), value: js::json_stringify(value), expected, example }
}

/// What a value is, in the words of the `Expected:` line (`kindOf`).
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn arguments(value: Value) -> JsonObject {
        value.as_object().cloned().unwrap()
    }

    fn message(error: InvalidParameter) -> String {
        error.to_string()
    }

    #[test]
    fn null_is_absent_and_a_default_fills_in() {
        let args = arguments(json!({"limit": null, "flag": null}));
        let read = Arguments::new(Some(&args));
        assert_eq!(read.optional_count("limit", 0).unwrap(), None);
        assert_eq!(read.count_or("limit", 0, 200).unwrap(), 200);
        assert!(read.boolean("flag", true).unwrap());
        assert_eq!(read.optional_string("name").unwrap(), None);
        assert_eq!(Arguments::new(None).count_or("limit", 0, 7).unwrap(), 7);
    }

    #[test]
    fn a_whole_number_is_read_as_an_integer_and_a_fraction_is_refused() {
        let args = arguments(json!({"a": 20250101, "b": 1.5, "c": "5", "d": true, "e": null, "f": 20250101.0, "g": -3, "h": 1e300}));
        let read = Arguments::new(Some(&args));
        assert_eq!(read.optional_whole("a", "a: 5").unwrap(), Some(20_250_101));
        assert_eq!(read.optional_whole("f", "f: 5").unwrap(), Some(20_250_101));
        assert_eq!(read.optional_whole("g", "g: 5").unwrap(), Some(-3));
        assert_eq!(read.optional_whole("e", "e: 5").unwrap(), None);
        assert_eq!(read.optional_whole("missing", "missing: 5").unwrap(), None);
        assert_eq!(
            message(read.optional_whole("b", "b: 5").unwrap_err()),
            "Invalid parameter 'b': 1.5\n\nExpected: an integer, not a fraction\nExample: b: 5"
        );
        assert_eq!(
            message(read.optional_whole("h", "h: 5").unwrap_err()),
            "Invalid parameter 'h': 1e+300\n\nExpected: Too big: expected int to be <9007199254740991"
        );
        assert_eq!(
            message(read.optional_whole("c", "c: 5").unwrap_err()),
            "Invalid parameter 'c': \"5\"\n\nExpected: a number, not a string\nExample: c: 5"
        );
        assert_eq!(
            message(read.optional_whole("d", "d: 5").unwrap_err()),
            "Invalid parameter 'd': true\n\nExpected: a number, not a boolean\nExample: d: 5"
        );
        // a tool can word the refusal itself, and still gets the value and why
        let own = read.optional_whole_or("b", |value, why| InvalidParameter {
            param: "b".to_owned(),
            value: js::json_stringify(value),
            expected: format!("{why:?}"),
            example: None,
        });
        assert_eq!(message(own.unwrap_err()), "Invalid parameter 'b': 1.5\n\nExpected: Fraction");
    }

    #[test]
    fn a_string_that_is_empty_is_still_a_string_and_a_missing_one_is_said_to_be() {
        let args = arguments(json!({"query": ""}));
        assert_eq!(Arguments::new(Some(&args)).required_string("query").unwrap(), "");
        assert_eq!(
            message(Arguments::new(None).required_string("query").unwrap_err()),
            "Invalid parameter 'query': missing\n\nExpected: a string (required)\nExample: query: \"...\""
        );
        let args = arguments(json!({"query": 5, "name_contains": ["a"]}));
        let read = Arguments::new(Some(&args));
        assert_eq!(
            message(read.required_string("query").unwrap_err()),
            "Invalid parameter 'query': 5\n\nExpected: a string, not a number\nExample: query: \"...\""
        );
        assert_eq!(
            message(read.optional_string("name_contains").unwrap_err()),
            "Invalid parameter 'name_contains': [\"a\"]\n\nExpected: a string, not an array\nExample: name_contains: \"...\""
        );
    }

    #[test]
    fn an_enum_takes_one_of_its_words_and_says_so_for_anything_else() {
        const FORMATS: &[&str] = &["json", "markdown"];
        let read = |value: Value| {
            let args = arguments(json!({"format": value}));
            Arguments::new(Some(&args)).optional_enum("format", FORMATS)
        };
        assert_eq!(read(json!("markdown")).unwrap(), Some("markdown"));
        assert_eq!(read(Value::Null).unwrap(), None);
        assert_eq!(Arguments::new(None).optional_enum("format", FORMATS).unwrap(), None);
        // each message is the one the TypeScript server's zod schema gives, whatever was sent
        for (sent, shown) in [(json!("xml"), "\"xml\""), (json!(5), "5"), (json!(true), "true"), (json!(["json"]), "[\"json\"]"), (json!({}), "{}")] {
            assert_eq!(
                message(read(sent).unwrap_err()),
                format!("Invalid parameter 'format': {shown}\n\nExpected: one of \"json\", \"markdown\"\nExample: format: \"markdown\"")
            );
        }
    }

    #[test]
    fn a_required_enum_is_missing_when_absent_and_otherwise_an_optional_one() {
        const TYPES: &[&str] = &["references", "connected-within"];
        let read = |value: Value| {
            let args = arguments(json!({"relationship_type": value}));
            Arguments::new(Some(&args)).required_enum("relationship_type", TYPES)
        };
        assert_eq!(read(json!("references")).unwrap(), "references");
        let missing = "Invalid parameter 'relationship_type': missing\n\nExpected: one of \"references\", \"connected-within\"\nExample: relationship_type: \"connected-within\"";
        assert_eq!(message(read(Value::Null).unwrap_err()), missing);
        assert_eq!(message(Arguments::new(None).required_enum("relationship_type", TYPES).unwrap_err()), missing);
        assert_eq!(
            message(read(json!("xml")).unwrap_err()),
            "Invalid parameter 'relationship_type': \"xml\"\n\nExpected: one of \"references\", \"connected-within\"\nExample: relationship_type: \"connected-within\""
        );
    }

    #[test]
    fn a_string_with_a_maximum_counts_utf16_units_and_says_too_big_with_the_whole_text() {
        let read = |text: &str| {
            let args = arguments(json!({"after": text}));
            Arguments::new(Some(&args)).required_string_max("after", 3)
        };
        assert_eq!(read("abc").unwrap(), "abc");
        // an emoji is two units: `.length` of "ab😀" is 4
        assert_eq!(
            message(read("ab\u{1F600}").unwrap_err()),
            "Invalid parameter 'after': \"ab\u{1F600}\"\n\nExpected: Too big: expected string to have <=3 characters"
        );
        assert_eq!(read("a\u{1F600}").unwrap(), "a\u{1F600}");
        assert_eq!(
            message(Arguments::new(None).required_string_max("after", 3).unwrap_err()),
            "Invalid parameter 'after': missing\n\nExpected: a string (required)\nExample: after: \"...\""
        );
    }

    #[test]
    fn a_boolean_says_true_or_false() {
        let args = arguments(json!({"slim_results": 0}));
        assert_eq!(
            message(Arguments::new(Some(&args)).boolean("slim_results", true).unwrap_err()),
            "Invalid parameter 'slim_results': 0\n\nExpected: true or false, not a number\nExample: slim_results: true"
        );
    }

    #[test]
    fn a_count_is_a_whole_number_from_its_minimum_up_to_the_largest_safe_integer() {
        let read = |value: Value| {
            let args = arguments(json!({"limit": value}));
            Arguments::new(Some(&args)).optional_count("limit", 0)
        };
        assert_eq!(read(json!(0)).unwrap(), Some(0));
        assert_eq!(read(json!(5.0)).unwrap(), Some(5));
        assert_eq!(read(json!(9007199254740991u64)).unwrap(), Some(9_007_199_254_740_991));
        let bad = |value: Value| message(read(value).unwrap_err());
        // each message is the one the TypeScript server's zod schema gives
        assert_eq!(bad(json!("5")), "Invalid parameter 'limit': \"5\"\n\nExpected: a number, not a string\nExample: limit: 5");
        assert_eq!(bad(json!(true)), "Invalid parameter 'limit': true\n\nExpected: a number, not a boolean\nExample: limit: 5");
        assert_eq!(bad(json!([1])), "Invalid parameter 'limit': [1]\n\nExpected: a number, not an array\nExample: limit: 5");
        assert_eq!(bad(json!(2.5)), "Invalid parameter 'limit': 2.5\n\nExpected: an integer, not a fraction\nExample: limit: 5");
        assert_eq!(bad(json!(-1.5)), "Invalid parameter 'limit': -1.5\n\nExpected: an integer, not a fraction\nExample: limit: 5");
        assert_eq!(bad(json!(-1)), "Invalid parameter 'limit': -1\n\nExpected: at least 0\nExample: limit: 0");
        assert_eq!(bad(json!(-9007199254740991i64)), "Invalid parameter 'limit': -9007199254740991\n\nExpected: at least 0\nExample: limit: 0");
        assert_eq!(bad(json!(9007199254740992u64)), "Invalid parameter 'limit': 9007199254740992\n\nExpected: Too big: expected int to be <9007199254740991");
        assert_eq!(bad(json!(1e300)), "Invalid parameter 'limit': 1e+300\n\nExpected: Too big: expected int to be <9007199254740991");
        assert_eq!(bad(json!(-1e300)), "Invalid parameter 'limit': -1e+300\n\nExpected: Too small: expected int to be >-9007199254740991");
    }

    #[test]
    fn a_scalar_is_a_string_a_number_or_a_boolean_and_is_written_as_javascript_writes_it() {
        let read = |value: Value| {
            let args = arguments(json!({"property_value": value}));
            Arguments::new(Some(&args)).required_scalar("property_value")
        };
        assert_eq!(read(json!("a")).unwrap(), Scalar::Text("a".into()));
        assert_eq!(read(json!("")).unwrap().to_js_string(), "");
        assert_eq!(read(json!(3)).unwrap().to_js_string(), "3");
        assert_eq!(read(json!(3.0)).unwrap().to_js_string(), "3");
        assert_eq!(read(json!(2.5)).unwrap().to_js_string(), "2.5");
        assert_eq!(read(json!(1e21)).unwrap().to_js_string(), "1e+21");
        assert_eq!(read(json!(true)).unwrap().to_js_string(), "true");
        assert_eq!(read(json!(false)).unwrap().to_js_string(), "false");
        let bad = |value: Value| message(read(value).unwrap_err());
        assert_eq!(
            bad(json!(["a"])),
            "Invalid parameter 'property_value': [\"a\"]\n\nExpected: a string, a number or a boolean, not an array\nExample: property_value: \"...\""
        );
        assert_eq!(
            bad(json!({"a": 1})),
            "Invalid parameter 'property_value': {\"a\":1}\n\nExpected: a string, a number or a boolean, not an object\nExample: property_value: \"...\""
        );
        assert_eq!(
            message(Arguments::new(None).required_scalar("property_value").unwrap_err()),
            "Invalid parameter 'property_value': missing\n\nExpected: a string, a number or a boolean (required)\nExample: property_value: \"...\""
        );
        // `null` is absent
        let args = arguments(json!({"property_value": null}));
        assert!(Arguments::new(Some(&args)).required_scalar("property_value").is_err());
    }

    #[test]
    fn a_minimum_of_one_is_named_in_the_message() {
        let args = arguments(json!({"max_nodes": 0}));
        assert_eq!(
            message(Arguments::new(Some(&args)).optional_count("max_nodes", 1).unwrap_err()),
            "Invalid parameter 'max_nodes': 0\n\nExpected: at least 1\nExample: max_nodes: 1"
        );
    }
}
