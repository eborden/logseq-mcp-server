//! A pulled block spelled as the Editor API spells it (`camelizeKeys` and `camelizeBlock` in
//! `src/utils/block-tree.ts`): `path-refs` becomes `pathRefs`, and the property names inside
//! `properties` and `propertiesTextValues` follow. The page nested in a block is camelized
//! the same way (`id`, `name`, `originalName`).

use serde_json::{Map, Value};

/// `key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())`: a hyphen before a lowercase letter goes,
/// and the letter becomes a capital. Matches don't overlap, so `a--b` becomes `a-B` and a key
/// without such a hyphen (`journal?`, `db/id`, `a-1`) stays as it is.
pub fn camelize(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut chars = key.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '-' {
            if let Some(&next) = chars.peek() {
                if next.is_ascii_lowercase() {
                    out.push(next.to_ascii_uppercase());
                    chars.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// `camelizeKeys`: a shallow copy with camelCase keys. Two keys that camelize to one leave one
/// entry, at the first one's place and with the last one's value, as assigning to a JavaScript
/// object does.
pub fn camelize_keys(entity: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in entity {
        out.insert(camelize(key), value.clone());
    }
    out
}

/// `camelizeBlock`: the block's keys, plus the property names in `properties` and
/// `propertiesTextValues` (Datalog has `logseq.order-list-type`, the Editor API
/// `logseq.orderListType`) and the names listed in `propertiesOrder`.
pub fn camelize_block(block: &Map<String, Value>) -> Map<String, Value> {
    let mut out = camelize_keys(block);
    for key in ["properties", "propertiesTextValues"] {
        if let Some(Value::Object(properties)) = out.get(key) {
            let camelized = camelize_keys(properties);
            out.insert(key.to_owned(), Value::Object(camelized));
        }
    }
    if let Some(Value::Array(names)) = out.get("propertiesOrder") {
        let camelized = names
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
    use crate::js;
    use serde_json::json;

    #[test]
    fn a_hyphen_before_a_lowercase_letter_becomes_a_capital() {
        assert_eq!(camelize("path-refs"), "pathRefs");
        assert_eq!(camelize("properties-text-values"), "propertiesTextValues");
        assert_eq!(camelize("logseq.order-list-type"), "logseq.orderListType");
        assert_eq!(camelize("journal?"), "journal?");
        assert_eq!(camelize("db/id"), "db/id");
        assert_eq!(camelize("a-1"), "a-1");
        assert_eq!(camelize("a-B"), "a-B");
        assert_eq!(camelize("a--b"), "a-B");
        assert_eq!(camelize("-a"), "A");
        assert_eq!(camelize("a-"), "a-");
        assert_eq!(camelize("a-b-c"), "aBC");
    }

    #[test]
    fn a_block_is_camelized_at_its_top_level_and_in_its_property_names() {
        let pulled = json!({
            "id": 1, "uuid": "u", "path-refs": [{"id": 2}], "properties-order": ["a-b"],
            "properties": {"created-at": "x", "nested-key": {"keep-me": 1}},
            "properties-text-values": {"created-at": "x"},
            "propertiesOrder": ["created-at", 7, "x_y"],
        });
        let block = camelize_block(pulled.as_object().unwrap());
        assert_eq!(
            js::json_stringify(&Value::Object(block)),
            r#"{"id":1,"uuid":"u","pathRefs":[{"id":2}],"propertiesOrder":["createdAt",7,"x_y"],"properties":{"createdAt":"x","nestedKey":{"keep-me":1}},"propertiesTextValues":{"createdAt":"x"}}"#
        );
    }

    #[test]
    fn two_keys_that_camelize_alike_keep_the_first_place_and_the_last_value() {
        let pulled = json!({"a-b": 1, "z": 0, "aB": 2});
        assert_eq!(js::json_stringify(&Value::Object(camelize_keys(pulled.as_object().unwrap()))), r#"{"aB":2,"z":0}"#);
    }

    #[test]
    fn properties_that_are_not_a_map_are_left_alone() {
        let pulled = json!({"properties": null, "properties-text-values": [1]});
        let block = camelize_block(pulled.as_object().unwrap());
        assert_eq!(js::json_stringify(&Value::Object(block)), r#"{"properties":null,"propertiesTextValues":[1]}"#);
    }
}
