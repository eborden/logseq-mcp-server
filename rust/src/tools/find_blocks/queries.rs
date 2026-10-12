//! The one Datalog query the block finder makes. Every string (the search text as a regex, the property key and its
//! value) is bound with `:in` (ADR-0013), so nothing the caller sent is part of the query text. The page lookup the
//! finder also makes is shared: `crate::pages_by_ids`.

use crate::edn::{DatalogInput, Query};
use crate::escape::escape_regex;
use crate::property::PropertyFilter;

/// What the blocks must satisfy, each filter present only when it was given. They AND together in one query.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Match<'a> {
    pub text: Option<&'a str>,
    pub property: Option<&'a PropertyFilter>,
}

/// Blocks matching every filter given, each with its page's id, name and original name nested.
///
/// - `text`: LogSeq runs `re-pattern` / `re-find` over the block's content, case-insensitively, with the text's
///   metacharacters escaped so it matches as it is written.
/// - `property`: `(keyword ?key)` turns the key into the keyword `:block/properties` is indexed by (a string key, or a
///   string input read as EDN, matches nothing, constraint 1). `?v` is a scalar or a set, and LogSeq has no `string?`
///   or `coll?`, so one `or-join` covers both: `(str ?v)` equals the value, or the set contains it. `[?b :block/page]`
///   keeps blocks only, since a page carries its own `:block/properties` too.
///
/// The clauses run in the order written, so the one that narrows most comes first: with both filters the property
/// clause leads, since few blocks have the property and every block has content. A single filter reads as it always
/// did, so its recorded query is the same text.
pub fn find_blocks(wanted: &Match<'_>) -> Query {
    let mut inputs = Vec::new();
    let mut declared = String::from("$");
    let mut clauses = Vec::new();
    if let Some(filter) = wanted.property {
        declared.push_str(" ?key ?value");
        inputs.push(DatalogInput::Str(filter.key.as_str().to_owned()));
        inputs.push(DatalogInput::Str(filter.value.clone()));
        clauses.push(
            "[?b :block/properties ?props] \
             [?b :block/page] \
             [(keyword ?key) ?kw] \
             [(get ?props ?kw) ?v] \
             (or-join [?v ?value] \
             (and [(str ?v) ?s] [(= ?s ?value)]) \
             [(contains? ?v ?value)])",
        );
    }
    if let Some(text) = wanted.text {
        declared.push_str(" ?pattern");
        inputs.push(DatalogInput::Str(format!("(?i){}", escape_regex(text))));
        clauses.push("[?b :block/content ?c] [(re-pattern ?pattern) ?re] [(re-find ?re ?c)]");
    }
    Query {
        text: format!("[:find (pull ?b [* {{:block/page [:db/id :block/name :block/original-name]}}]) :in {declared} :where {}]", clauses.join(" ")),
        inputs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::property::PropertyKey;

    fn property(key: &str, value: &str) -> PropertyFilter {
        PropertyFilter { key: PropertyKey::parse(key, "property").unwrap(), value: value.to_owned() }
    }

    #[test]
    fn the_text_is_escaped_and_bound_as_a_case_insensitive_pattern() {
        let query = find_blocks(&Match { text: Some("a.b (c)"), property: None });
        assert_eq!(query.inputs, [DatalogInput::Str(r"(?i)a\.b \(c\)".to_owned())]);
        assert!(!query.text.contains("a.b"), "the text is never part of the query");
        assert!(query.text.contains(":in $ ?pattern :where [?b :block/content ?c]"));
    }

    #[test]
    fn the_text_alone_is_the_query_it_always_was() {
        assert_eq!(
            find_blocks(&Match { text: Some("x"), property: None }).text,
            "[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}]) :in $ ?pattern :where \
             [?b :block/content ?c] [(re-pattern ?pattern) ?re] [(re-find ?re ?c)]]"
        );
    }

    #[test]
    fn the_key_and_the_value_are_bound_and_never_part_of_the_text() {
        let filter = property("createdAt", "a \"b\"");
        let query = find_blocks(&Match { text: None, property: Some(&filter) });
        assert_eq!(query.inputs, [DatalogInput::Str("created-at".into()), DatalogInput::Str("a \"b\"".into())]);
        assert!(!query.text.contains("created") && !query.text.contains('"'));
        assert!(query.text.contains(":in $ ?key ?value :where [?b :block/properties ?props] [?b :block/page] [(keyword ?key) ?kw] [(get ?props ?kw) ?v]"));
        assert!(query.text.ends_with("(or-join [?v ?value] (and [(str ?v) ?s] [(= ?s ?value)]) [(contains? ?v ?value)])]"));
    }

    #[test]
    fn both_filters_in_one_query_with_the_property_first_and_the_inputs_in_the_order_declared() {
        let filter = property("status", "doing");
        let query = find_blocks(&Match { text: Some("x"), property: Some(&filter) });
        assert!(query.text.contains(":in $ ?key ?value ?pattern :where [?b :block/properties ?props]"), "{}", query.text);
        assert!(query.text.ends_with("[?b :block/content ?c] [(re-pattern ?pattern) ?re] [(re-find ?re ?c)]]"));
        assert_eq!(query.inputs, [DatalogInput::Str("status".into()), DatalogInput::Str("doing".into()), DatalogInput::Str("(?i)x".into())]);
    }
}
