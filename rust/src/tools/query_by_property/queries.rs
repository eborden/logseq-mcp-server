//! The one Datalog query the property search makes. Both the key and the value are bound with `:in` (ADR-0013), so
//! nothing the caller sent is part of the query text.

use crate::edn::{DatalogInput, Query};
use crate::errors::InvalidParameter;

/// A property name LogSeq stores a key under: letters and digits, `-` and `_`, starting with a
/// letter or digit, written in kebab-case and lowercase. It can only be made by [`PropertyKey::parse`],
/// which is `normalizePropertyKey`, so a query can't be built from a name that was never checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyKey(String);

impl PropertyKey {
    /// `normalizePropertyKey`: `createdAt`, `created_at` and `created-at` are the key LogSeq
    /// stores as `created-at`. A name with any other character is an `InvalidParameter`, raised
    /// before any LogSeq call.
    pub fn parse(name: &str) -> Result<Self, InvalidParameter> {
        // `/^[a-z0-9][a-z0-9_-]*$/i`: ASCII only, whatever the case
        let valid = name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !valid {
            return Err(InvalidParameter {
                param: "property_key".to_owned(),
                value: name.to_owned(),
                expected: "a property name made of letters, digits, \"-\" and \"_\", starting with a letter or digit".to_owned(),
                example: Some("status".to_owned()),
            });
        }
        Ok(PropertyKey(kebab_case(name).replace('_', "-").to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
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

/// Blocks whose property `key` matches `value`, each with its page's id, name and original name
/// nested. `(keyword ?key)` turns the key into the keyword `:block/properties` is indexed by (a
/// string key, or a string input read as EDN, matches nothing, constraint 1). `?v` is a scalar or
/// a set, and LogSeq has no `string?` or `coll?`, so one `or-join` covers both: `(str ?v)` equals
/// the value, or the set contains it. `[?b :block/page]` keeps blocks only, since a page carries
/// its own `:block/properties` too.
pub fn blocks_by_property(key: &PropertyKey, value: &str) -> Query {
    Query {
        text: "[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}]) \
               :in $ ?key ?value \
               :where \
               [?b :block/properties ?props] \
               [?b :block/page] \
               [(keyword ?key) ?kw] \
               [(get ?props ?kw) ?v] \
               (or-join [?v ?value] \
               (and [(str ?v) ?s] [(= ?s ?value)]) \
               [(contains? ?v ?value)])]"
            .to_owned(),
        inputs: vec![DatalogInput::Str(key.as_str().to_owned()), DatalogInput::Str(value.to_owned())],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(name: &str) -> String {
        PropertyKey::parse(name).unwrap().as_str().to_owned()
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
    fn a_name_with_other_characters_is_refused_with_the_name_as_sent() {
        for name in ["", "-a", "_a", "a b", "a:b", "a.b", "a\n", "\u{e9}t\u{e9}", "a\u{212a}", "[x]"] {
            let error = PropertyKey::parse(name).unwrap_err();
            assert_eq!(
                error.to_string(),
                format!(
                    "Invalid parameter 'property_key': {name}\n\nExpected: a property name made of letters, digits, \"-\" and \"_\", starting with a letter or digit\nExample: status"
                ),
                "{name:?}"
            );
        }
    }

    #[test]
    fn the_key_and_the_value_are_bound_and_never_part_of_the_text() {
        let query = blocks_by_property(&PropertyKey::parse("createdAt").unwrap(), "a \"b\"");
        assert_eq!(query.inputs, [DatalogInput::Str("created-at".into()), DatalogInput::Str("a \"b\"".into())]);
        assert!(!query.text.contains("created") && !query.text.contains('"'));
        assert!(query.text.contains(":in $ ?key ?value :where [?b :block/properties ?props] [?b :block/page] [(keyword ?key) ?kw] [(get ?props ?kw) ?v]"));
        assert!(query.text.ends_with("(or-join [?v ?value] (and [(str ?v) ?s] [(= ?s ?value)]) [(contains? ?v ?value)])]"));
    }
}
