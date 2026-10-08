//! Values bound to a Datalog query's `:in` variables (ADR-0013).
//!
//! LogSeq reads every input after the query string as EDN, so a bare string is read as a symbol
//! and matches nothing. Each input is sent as its JSON text: a JSON string literal is a valid EDN
//! string literal, a JSON array of strings a valid EDN vector, and quotes, backslashes and control
//! characters come out escaped. The text is byte for byte what `JSON.stringify` gives for the same
//! value in `src/client.ts`, which the parity harness (#124) compares.
//!
//! [`DatalogInput`] has only the shapes the query builders bind: a string, an integer (a
//! `YYYYMMDD` journal day) and a list of strings (`:in $ [?n ...]`). Floats, maps and nested lists
//! can't be built, so a value whose EDN reading differs from its JSON one never reaches LogSeq.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatalogInput {
    Str(String),
    Int(i64),
    StrList(Vec<String>),
}

impl DatalogInput {
    /// The EDN text LogSeq receives for this input.
    pub fn to_edn(&self) -> String {
        let value = match self {
            DatalogInput::Str(s) => Value::from(s.as_str()),
            DatalogInput::Int(n) => Value::from(*n),
            DatalogInput::StrList(items) => Value::from(items.clone()),
        };
        // Serializing a Value made of strings and integers can't fail.
        serde_json::to_string(&value).expect("a string, integer or string list serializes")
    }
}

impl From<&str> for DatalogInput {
    fn from(value: &str) -> Self {
        DatalogInput::Str(value.to_owned())
    }
}

impl From<String> for DatalogInput {
    fn from(value: String) -> Self {
        DatalogInput::Str(value)
    }
}

impl From<i64> for DatalogInput {
    fn from(value: i64) -> Self {
        DatalogInput::Int(value)
    }
}

impl From<Vec<String>> for DatalogInput {
    fn from(value: Vec<String>) -> Self {
        DatalogInput::StrList(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edn(input: impl Into<DatalogInput>) -> String {
        input.into().to_edn()
    }

    #[test]
    fn a_string_is_quoted_so_it_is_not_read_as_a_symbol() {
        assert_eq!(edn("my page"), r#""my page""#);
        assert_eq!(edn(""), r#""""#);
    }

    #[test]
    fn quotes_backslashes_and_control_characters_are_escaped_as_json_stringify_does() {
        // Expected values are JSON.stringify's output for the same strings.
        assert_eq!(edn(r#"foo "bar"#), r#""foo \"bar""#);
        assert_eq!(edn(r"a\b"), r#""a\\b""#);
        assert_eq!(edn("line\nnext\ttab\r"), r#""line\nnext\ttab\r""#);
        assert_eq!(edn("\u{8}\u{c}"), r#""\b\f""#);
        assert_eq!(edn("\u{1}\u{1f}"), r#""\u0001\u001f""#);
        // JSON.stringify leaves DEL, non-ASCII and the line separators as they are.
        assert_eq!(edn("\u{7f}é\u{2028}🙂"), "\"\u{7f}é\u{2028}🙂\"");
        // A regex pattern for re-pattern keeps its backslashes doubled once.
        assert_eq!(edn(r"(?i)a\.b"), r#""(?i)a\\.b""#);
    }

    #[test]
    fn an_edn_looking_string_stays_a_string() {
        assert_eq!(edn("] [?x :block/name"), r#""] [?x :block/name""#);
        assert_eq!(edn("#uuid \"x\""), r##""#uuid \"x\"""##);
    }

    #[test]
    fn an_integer_is_bare() {
        assert_eq!(edn(20250101_i64), "20250101");
        assert_eq!(edn(-3_i64), "-3");
    }

    #[test]
    fn a_string_list_is_a_vector_of_quoted_strings() {
        assert_eq!(edn(vec!["alice".to_owned(), "project \"atlas\"".to_owned()]), r#"["alice","project \"atlas\""]"#);
        assert_eq!(edn(Vec::<String>::new()), "[]");
    }
}
