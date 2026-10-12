//! The one Datalog query the property search makes. Both the key and the value are bound with `:in` (ADR-0013), so
//! nothing the caller sent is part of the query text.

use crate::edn::{DatalogInput, Query};
use crate::property::PropertyKey;

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

    #[test]
    fn the_key_and_the_value_are_bound_and_never_part_of_the_text() {
        let query = blocks_by_property(&PropertyKey::parse("createdAt", "property_key").unwrap(), "a \"b\"");
        assert_eq!(query.inputs, [DatalogInput::Str("created-at".into()), DatalogInput::Str("a \"b\"".into())]);
        assert!(!query.text.contains("created") && !query.text.contains('"'));
        assert!(query.text.contains(":in $ ?key ?value :where [?b :block/properties ?props] [?b :block/page] [(keyword ?key) ?kw] [(get ?props ?kw) ?v]"));
        assert!(query.text.ends_with("(or-join [?v ?value] (and [(str ?v) ?s] [(= ?s ?value)]) [(contains? ?v ?value)])]"));
    }
}
