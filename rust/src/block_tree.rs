//! Turning a Datalog pull into the shape the Editor API answers with (the Rust side of the key
//! helpers in `src/utils/block-tree.ts`): `journal-day` becomes `journalDay`, `path-refs` becomes
//! `pathRefs`. A tool that merges a pulled block into a result the Editor API also produces
//! (the aliased backlinks) camelizes it first, so both paths give one shape.
//!
//! It also puts sibling blocks in page order (`orderSiblings`): LogSeq doesn't store an order, each
//! block says which block is to its `:block/left`, so the order is the chain those links make.
//! `buildBlockTrees` stays with the tools that use it: nothing ported so far rebuilds a tree.

use std::collections::{HashMap, HashSet};

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

// PARITY(#299): drops a sibling that shares an id with one already placed, though the doc says nothing is
// dropped (suspected TS bug) — drop if Rust becomes the only server.
/// `orderSiblings`: siblings in page order, by following the `:block/left` chain.
///
/// The first sibling's `left` is the parent (or the page), which is not itself a sibling, so it
/// is the head of the chain; each following sibling's `left` is the previous one. Blocks the
/// chain can't reach (a corrupt graph, or a cycle) are appended in id order so nothing is
/// dropped. Two siblings with one `left`: the first listed follows it. Two with one id: the
/// first one the order reaches is kept.
///
/// `id` is a sibling's own id and `left` the id its `:block/left` points at, if it has one.
pub fn order_siblings<T>(siblings: Vec<T>, id: impl Fn(&T) -> i64, left: impl Fn(&T) -> Option<i64>) -> Vec<T> {
    if siblings.len() < 2 {
        return siblings;
    }
    let ids: HashSet<i64> = siblings.iter().map(&id).collect();
    let mut by_left: HashMap<i64, usize> = HashMap::new();
    let mut heads: Vec<usize> = Vec::new();
    for (i, sibling) in siblings.iter().enumerate() {
        match left(sibling) {
            Some(left) if ids.contains(&left) => {
                by_left.entry(left).or_insert(i);
            }
            _ => heads.push(i),
        }
    }
    heads.sort_by_key(|&i| id(&siblings[i])); // a stable sort, as `Array.prototype.sort` is

    let mut order: Vec<usize> = Vec::with_capacity(siblings.len());
    let mut seen: HashSet<i64> = HashSet::new();
    for head in heads {
        let mut current = Some(head);
        while let Some(i) = current.filter(|&i| !seen.contains(&id(&siblings[i]))) {
            seen.insert(id(&siblings[i]));
            order.push(i);
            current = by_left.get(&id(&siblings[i])).copied();
        }
    }
    let mut rest: Vec<usize> = (0..siblings.len()).collect();
    rest.sort_by_key(|&i| id(&siblings[i]));
    order.extend(rest.into_iter().filter(|&i| !seen.contains(&id(&siblings[i]))));

    let mut slots: Vec<Option<T>> = siblings.into_iter().map(Some).collect();
    order.into_iter().map(|i| slots[i].take().expect("each sibling is placed once")).collect()
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
        assert_eq!(camelize("a-B"), "a-B");
        assert_eq!(camelize("-a"), "A");
    }

    #[test]
    fn two_keys_that_camelize_alike_keep_the_first_place_and_the_last_value() {
        let out = camelize_keys(&object(json!({"a-b": 1, "z": 0, "aB": 2})));
        assert_eq!(crate::js::json_stringify(&Value::Object(out)), r#"{"aB":2,"z":0}"#);
        // a block spelled both ways: the camelCase twin's list wins, at the kebab-case key's place
        let block = object(json!({"properties-order": ["a-b"], "x": 1, "propertiesOrder": ["c-d"]}));
        assert_eq!(crate::js::json_stringify(&Value::Object(camelize_block(&block))), r#"{"propertiesOrder":["cD"],"x":1}"#);
    }

    #[test]
    fn properties_that_are_not_a_map_are_left_alone() {
        let block = object(json!({"properties": null, "properties-text-values": [1], "properties-order": "x-y"}));
        assert_eq!(
            crate::js::json_stringify(&Value::Object(camelize_block(&block))),
            r#"{"properties":null,"propertiesTextValues":[1],"propertiesOrder":"x-y"}"#
        );
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

    /// `(id, left)`
    type Sibling = (i64, Option<i64>);

    fn ordered(siblings: Vec<Sibling>) -> Vec<i64> {
        order_siblings(siblings, |s| s.0, |s| s.1).into_iter().map(|s| s.0).collect()
    }

    #[test]
    fn siblings_follow_the_left_chain_from_the_head() {
        // 1 hangs off the parent (10), 2 off 1, 3 off 2
        assert_eq!(ordered(vec![(3, Some(2)), (1, Some(10)), (2, Some(1))]), [1, 2, 3]);
        assert_eq!(ordered(vec![(5, None)]), [5]);
        assert_eq!(ordered(vec![]), Vec::<i64>::new());
    }

    #[test]
    fn a_broken_or_cyclic_chain_loses_no_sibling() {
        // 411 and 412 point at each other and 413 at a block that isn't there: the chain from 413
        // comes first, then the siblings no chain reached, by id
        assert_eq!(ordered(vec![(411, Some(412)), (412, Some(411)), (414, Some(413)), (413, Some(999))]), [413, 414, 411, 412]);
    }

    #[test]
    fn two_siblings_with_one_left_keep_the_first_listed_in_the_chain() {
        // 6 was listed before 7, so it follows 5; 7, which no chain reached, comes last
        assert_eq!(ordered(vec![(5, Some(4)), (6, Some(5)), (7, Some(5)), (4, Some(1))]), [4, 5, 6, 7]);
        // two heads are ordered by id
        assert_eq!(ordered(vec![(3, Some(1)), (2, Some(1))]), [2, 3]);
    }

    #[test]
    fn a_sibling_that_shares_an_id_with_a_placed_one_is_dropped() {
        // suspected TS bug, kept: nothing is dropped, the doc says, yet the second 7 is
        assert_eq!(ordered(vec![(7, Some(1)), (7, Some(1))]), [7]);
    }
}
