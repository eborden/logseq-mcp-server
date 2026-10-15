//! A property key, and what it means to match a property by value: shared by the tools that filter by property
//! (`logseq_find_blocks` over blocks, `logseq_find_pages` over pages, #490, #491), so both say the same thing.
//!
//! The rules (the descriptions of `logseq_find_blocks` and `logseq_find_pages` state them to the model):
//! - the key is the one LogSeq stores (`created-at`) or its camelCase spelling (`createdAt`, which is how the
//!   Editor API sends it), whatever the case, with `_` read as `-`;
//! - the value is an exact string, and a number or boolean is the text JavaScript writes for it (`3`, `true`);
//! - a multi-value property (a set) matches when any one of its values equals the value.

use crate::args::Scalar;
use crate::errors::InvalidParameter;
use crate::js;
use crate::wire::{Properties, PropertyValue};

/// A property name LogSeq stores a key under: letters and digits, `-` and `_`, starting with a
/// letter or digit, written in kebab-case and lowercase. It can only be made by [`PropertyKey::parse`],
/// which normalizes the key, so a query can't be built from a name that was never checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyKey(String);

impl PropertyKey {
    /// The property key: `createdAt`, `created_at` and `created-at` are the key LogSeq
    /// stores as `created-at`. A name with any other character is an `InvalidParameter` for `param` (the
    /// parameter the caller sent it in), raised before any LogSeq call.
    pub fn parse(name: &str, param: &str) -> Result<Self, InvalidParameter> {
        // `/^[a-z0-9][a-z0-9_-]*$/i`: ASCII only, whatever the case
        let valid = name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !valid {
            return Err(InvalidParameter {
                param: param.to_owned(),
                value: name.to_owned(),
                expected: "a property name made of letters, digits, \"-\" and \"_\", starting with a letter or digit".to_owned(),
                example: Some("status".to_owned()),
            });
        }
        Ok(PropertyKey(stored_spelling(name)))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether `key`, a property name as the Editor API spells it (camelCase), is this key. Both ways of
    /// spelling the key LogSeq stores are tried, since LogSeq's camelCase of a name with a digit
    /// part (`due-2-go`) is not the reverse of ours.
    pub(crate) fn names(&self, key: &str) -> bool {
        key == self.camel() || stored_spelling(key) == self.0
    }

    /// The key as the Editor API writes it: the parts after a `-` start with a capital (`created-by` is `createdBy`).
    fn camel(&self) -> String {
        let mut out = String::with_capacity(self.0.len());
        for (index, part) in self.0.split('-').enumerate() {
            let mut letters = part.chars();
            match (index, letters.next()) {
                (0, Some(first)) => out.push(first),
                (_, Some(first)) => out.push(first.to_ascii_uppercase()),
                (_, None) => {}
            }
            out.push_str(letters.as_str());
        }
        out
    }
}

/// The property filter, checked: a key LogSeq can store and the value as the text it is matched by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyFilter {
    pub key: PropertyKey,
    pub value: String,
}

/// `property` and `value` go together. Both or neither is a filter; one alone is refused before any LogSeq call,
/// naming the one that is missing. A key LogSeq can't store is refused the same way (the arguments are checked in the
/// order the schema lists them, so a bad `property` is reported before a missing `value`).
pub fn property_filter(property: Option<&str>, value: Option<&Scalar>) -> Result<Option<PropertyFilter>, InvalidParameter> {
    match (property, value) {
        (None, None) => Ok(None),
        (Some(property), Some(value)) => Ok(Some(PropertyFilter { key: PropertyKey::parse(property, "property")?, value: value.to_js_string() })),
        (Some(property), None) => {
            PropertyKey::parse(property, "property")?;
            Err(InvalidParameter {
                param: "value".to_owned(),
                value: "missing".to_owned(),
                expected: "the value to match (property and value go together)".to_owned(),
                example: Some("value: \"active\"".to_owned()),
            })
        }
        (None, Some(_)) => Err(InvalidParameter {
            param: "property".to_owned(),
            value: "missing".to_owned(),
            expected: "the property to match value against (property and value go together)".to_owned(),
            example: Some("property: \"status\"".to_owned()),
        }),
    }
}

/// The key as LogSeq stores it: kebab-case, lowercase, `_` as `-`.
fn stored_spelling(name: &str) -> String {
    kebab_case(name).replace('_', "-").to_ascii_lowercase()
}

/// `.replace(/([a-z0-9])([A-Z])/g, '$1-$2')`: a hyphen between a lowercase letter or digit and a
/// capital. Matches don't overlap, so the capital that ends one match can't start the next:
/// `aBC` becomes `a-BC`, not `a-B-C`.
fn kebab_case(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::with_capacity(name.len() + 4);
    let mut at = 0;
    while at < chars.len() {
        if at + 1 < chars.len() && (chars[at].is_ascii_lowercase() || chars[at].is_ascii_digit()) && chars[at + 1].is_ascii_uppercase() {
            out.push(chars[at]);
            out.push('-');
            out.push(chars[at + 1]);
            at += 2;
        } else {
            out.push(chars[at]);
            at += 1;
        }
    }
    out
}

/// Whether a stored property value matches `wanted`, as the Datalog of `find_blocks` decides it: a scalar when its
/// text is `wanted` (a number as JavaScript writes it), a set when one of its strings is.
pub(crate) fn value_matches(value: &PropertyValue, wanted: &str) -> bool {
    match value {
        PropertyValue::Text(text) => text == wanted,
        PropertyValue::Number(number) => js::number_to_string(*number) == wanted,
        PropertyValue::Flag(flag) => flag.to_string() == wanted,
        PropertyValue::Set(items) => items.iter().any(|item| item == wanted),
        PropertyValue::Other => false,
    }
}

/// Whether `properties`, those of one page as the Editor API sends them, hold `key` with a value that matches `wanted`.
pub(crate) fn has_property(properties: &Properties, key: &PropertyKey, wanted: &str) -> bool {
    properties.0.iter().any(|(name, value)| key.names(name) && value_matches(value, wanted))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(name: &str) -> String {
        PropertyKey::parse(name, "property_key").unwrap().as_str().to_owned()
    }

    #[test]
    fn a_key_is_written_as_logseq_stores_it() {
        assert_eq!(key("status"), "status");
        assert_eq!(key("created-at"), "created-at");
        assert_eq!(key("createdAt"), "created-at");
        assert_eq!(key("created_at"), "created-at");
        assert_eq!(key("Status"), "status");
        assert_eq!(key("x1Y"), "x1-y");
        assert_eq!(key("7"), "7");
        // matches don't overlap: the capital that ends one hyphen doesn't start the next
        assert_eq!(key("aBC"), "a-bc");
        assert_eq!(key("aBcD"), "a-bc-d");
        assert_eq!(key("ABC"), "abc");
        assert_eq!(key("a_Bc"), "a-bc");
    }

    #[test]
    fn a_name_with_other_characters_is_refused_with_the_name_as_sent_and_the_parameter_it_came_in() {
        for name in ["", "-a", "_a", "a b", "a:b", "a.b", "a\n", "\u{e9}t\u{e9}", "a\u{212a}", "[x]"] {
            for param in ["property_key", "property"] {
                let error = PropertyKey::parse(name, param).unwrap_err();
                assert_eq!(
                    error.to_string(),
                    format!(
                        "Invalid parameter '{param}': {name}\n\nExpected: a property name made of letters, digits, \"-\" and \"_\", starting with a letter or digit\nExample: status"
                    ),
                    "{name:?}"
                );
            }
        }
    }

    #[test]
    fn the_editor_spelling_of_a_key_is_camel_case_and_either_spelling_names_it() {
        let named = |asked: &str, stored: &str| PropertyKey::parse(asked, "property").unwrap().names(stored);
        assert!(named("created-by", "createdBy"));
        assert!(named("createdBy", "createdBy"));
        assert!(named("CREATED_BY", "createdBy"));
        assert!(named("status", "status"));
        assert!(named("Status", "status"));
        // LogSeq spells a digit part its own way, and a key is found whichever way it is asked for
        assert!(named("due-2-go", "due2Go"));
        assert!(named("due2Go", "due2Go"));
        // a different key is not the key, and nothing is matched loosely
        assert!(!named("created-by", "createdAt"));
        assert!(!named("createdby", "createdBy"));
        assert!(!named("status", "statuses"));
        assert!(!named("status", ""));
    }

    #[test]
    fn a_value_matches_as_the_property_query_matches_it() {
        let text = |text: &str| PropertyValue::Text(text.to_owned());
        let set = |items: &[&str]| PropertyValue::Set(items.iter().map(|item| (*item).to_owned()).collect());
        assert!(value_matches(&text("active"), "active"));
        assert!(!value_matches(&text("active"), "Active"), "exact, case included");
        assert!(!value_matches(&text("active"), "act"));
        assert!(value_matches(&PropertyValue::Number(3.0), "3"));
        assert!(value_matches(&PropertyValue::Number(0.75), "0.75"));
        assert!(!value_matches(&PropertyValue::Number(3.0), "3.0"));
        assert!(value_matches(&PropertyValue::Flag(true), "true"));
        assert!(value_matches(&PropertyValue::Flag(false), "false"));
        assert!(!value_matches(&PropertyValue::Flag(true), "false"));
        // a set matches on any one of its strings, and a text never matches by being part of one
        assert!(value_matches(&set(&["Alice", "Bob"]), "Bob"));
        assert!(!value_matches(&set(&["Alice", "Bob"]), "Alice, Bob"));
        assert!(!value_matches(&set(&[]), ""));
        assert!(!value_matches(&PropertyValue::Other, "null"));
        assert!(!value_matches(&PropertyValue::Other, ""));
    }

    #[test]
    fn a_page_has_a_property_when_one_of_its_keys_names_it_and_the_value_matches() {
        let properties = Properties(vec![
            ("type".to_owned(), PropertyValue::Text("project".to_owned())),
            ("createdBy".to_owned(), PropertyValue::Set(vec!["Alice".to_owned()])),
        ]);
        let key = |name: &str| PropertyKey::parse(name, "property").unwrap();
        assert!(has_property(&properties, &key("type"), "project"));
        assert!(has_property(&properties, &key("created-by"), "Alice"));
        assert!(!has_property(&properties, &key("created-by"), "Bob"));
        assert!(!has_property(&properties, &key("status"), "project"));
        assert!(!has_property(&Properties::default(), &key("type"), "project"));
    }
}
