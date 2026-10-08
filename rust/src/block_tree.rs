//! Turning a Datalog pull into the shape the Editor API answers with (the Rust side of the key
//! helpers in `src/utils/block-tree.ts`): `journal-day` becomes `journalDay`, `path-refs` becomes
//! `pathRefs`. A tool that merges a pulled block into a result the Editor API also produces
//! (the aliased backlinks) camelizes it first, so both paths give one shape.
//!
//! `orderSiblings` and `buildBlockTrees` stay with the tools that use them for now: the outline
//! orders its own siblings (`tools/get_page_outline`), and nothing else has been ported that
//! rebuilds a tree.

use serde_json::{Map, Value};

/// `key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())`: a dash before a lowercase ASCII letter
/// goes, and the letter is capitalised. Matches don't overlap, scanning left to right, so
/// `a--b` is `a-B` and `a-b-c` is `aBC`.
pub fn camelize(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut chars = key.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, chars.peek()) {
            ('-', Some(next)) if next.is_ascii_lowercase() => {
                out.push(next.to_ascii_uppercase());
                chars.next();
            }
            _ => out.push(c),
        }
    }
    out
}

/// `camelizeKeys`: the top-level keys of a pulled entity, camelized. Nested values are untouched.
/// Two keys that camelize to one name keep the first's place and the last's value, as assigning
/// to a JavaScript object does.
pub fn camelize_keys(entity: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::with_capacity(entity.len());
    for (key, value) in entity {
        out.insert(camelize(key), value.clone());
    }
    out
}

/// `camelizeBlock`: a pulled block the way the Editor API gives it: its top-level keys, plus the
/// property names inside `properties` and `propertiesTextValues` and the names listed in
/// `propertiesOrder` (Datalog has `logseq.order-list-type`, the Editor API `logseq.orderListType`).
pub fn camelize_block(block: &Map<String, Value>) -> Map<String, Value> {
    let mut out = camelize_keys(block);
    for key in ["properties", "propertiesTextValues"] {
        if let Some(Value::Object(properties)) = out.get(key) {
            let camelized = camelize_keys(properties);
            out.insert(key.to_owned(), Value::Object(camelized));
        }
    }
    if let Some(Value::Array(order)) = out.get("propertiesOrder") {
        let camelized = order
            .iter()
            .map(|name| match name {
                Value::String(name) => Value::String(camelize(name)),
                other => other.clone(),
            })
            .collect();
        out.insert("propertiesOrder".to_owned(), Value::Array(camelized));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_dash_before_a_lowercase_letter_is_a_capital() {
        assert_eq!(camelize("journal-day"), "journalDay");
        assert_eq!(camelize("path-refs"), "pathRefs");
        assert_eq!(camelize("a-b-c"), "aBC");
        assert_eq!(camelize("a--b"), "a-B");
        assert_eq!(camelize("journal?"), "journal?");
        assert_eq!(camelize("x-1"), "x-1");
        assert_eq!(camelize("trailing-"), "trailing-");
        assert_eq!(camelize("db/id"), "db/id");
    }

    #[test]
    fn only_the_top_level_keys_of_a_pull_change() {
        let out = camelize_keys(&object(json!({"original-name": "A", "meta": {"some-key": 1}})));
        assert_eq!(Value::Object(out), json!({"originalName": "A", "meta": {"some-key": 1}}));
    }

    #[test]
    fn a_block_camelizes_its_property_names_and_their_order() {
        let block = object(json!({
            "id": 1,
            "path-refs": [{"id": 2}],
            "properties": {"logseq.order-list-type": "number", "plain": 1},
            "properties-text-values": {"my-key": "v"},
            "properties-order": ["logseq.order-list-type", 7]
        }));
        let out = Value::Object(camelize_block(&block));
        assert_eq!(
            out,
            json!({
                "id": 1,
                "pathRefs": [{"id": 2}],
                "properties": {"logseq.orderListType": "number", "plain": 1},
                "propertiesTextValues": {"myKey": "v"},
                "propertiesOrder": ["logseq.orderListType", 7]
            })
        );
        // the key order is the pull's
        assert_eq!(out.as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "pathRefs", "properties", "propertiesTextValues", "propertiesOrder"]);
    }
}
