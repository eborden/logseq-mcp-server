//! Turning a Datalog pull into the shape the Editor API answers with (the Rust side of the key
//! helpers in `src/utils/block-tree.ts`): `journal-day` becomes `journalDay`, `path-refs` becomes
//! `pathRefs`. A tool that merges a pulled block into a result the Editor API also produces
//! (the aliased backlinks) camelizes it first, so both paths give one shape.
//!
//! It also puts sibling blocks in page order (`orderSiblings`): LogSeq doesn't store an order, each
//! block says which block is to its `:block/left`, so the order is the chain those links make.
//!
//! [`build_block_trees`] rebuilds `getPageBlocksTree`-shaped trees from the flat blocks a Datalog
//! query pulls, for a tool that reads blocks of many pages in one query (`query_by_date_range`).

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

/// `orderSiblings`: siblings in page order, by following the `:block/left` chain.
///
/// The first sibling's `left` is the parent (or the page), which is not itself a sibling, so it
/// is the head of the chain; each following sibling's `left` is the previous one. Blocks the
/// chain can't reach (a corrupt graph, or a cycle) are appended in id order so nothing is
/// dropped. Two siblings with one `left`: the first listed follows it. Two with one id are both
/// kept, each in the place the chain (or, failing that, the order of ids) gives it.
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
    let mut placed = vec![false; siblings.len()];
    for head in heads {
        let mut current = Some(head);
        while let Some(i) = current.filter(|&i| !placed[i]) {
            placed[i] = true;
            order.push(i);
            current = by_left.get(&id(&siblings[i])).copied();
        }
    }
    let mut rest: Vec<usize> = (0..siblings.len()).collect();
    rest.sort_by_key(|&i| id(&siblings[i]));
    order.extend(rest.into_iter().filter(|&i| !placed[i]));

    let mut slots: Vec<Option<T>> = siblings.into_iter().map(Some).collect();
    order.into_iter().map(|i| slots[i].take().expect("each sibling is placed once")).collect()
}

/// A number a JSON value holds, as the whole number an entity id is.
fn number_id(value: Option<&Value>) -> Option<i64> {
    value.and_then(crate::wire::whole_number)
}

/// `node.<key>?.id` of a block's `parent`, `page` or `left`: the `id` the reference carries.
fn reference_id(block: &Map<String, Value>, key: &str) -> Option<i64> {
    number_id(block.get(key).and_then(|reference| reference.get("id")))
}

/// `buildBlockTrees`: `getPageBlocksTree`-shaped trees from flat Datalog blocks, by page id.
///
/// Mirrors the Editor API's output: camelCase keys, a `children` array on every block (empty for a
/// leaf) and a 1-based `level`, after the keys the pull gave (`children` first, since it is made
/// with the node, then `level`). Siblings are in the order of the `:block/left` chain. A block whose
/// parent is not among `blocks` and is not a page in `page_ids` is treated as a root, so it is not
/// lost, under the page its `page` names, else its parent; a block with neither is dropped.
///
/// Every page in `page_ids` has an entry, `[]` for a page with no blocks. A block whose own `id`
/// is missing counts as id 0; every block the pull gives has one (`blockSchema`).
pub fn build_block_trees(blocks: Vec<Map<String, Value>>, page_ids: &[i64]) -> HashMap<i64, Vec<Value>> {
    build_block_trees_ordered(blocks, page_ids).into_iter().collect()
}

/// [`build_block_trees`] in the order the TypeScript `Map` holds its entries: the pages of
/// `page_ids` first, in that order, then every other page in the order its first top-level block
/// came. A caller that writes the pages one after the other (the context Markdown) needs it.
pub fn build_block_trees_ordered(blocks: Vec<Map<String, Value>>, page_ids: &[i64]) -> Vec<(i64, Vec<Value>)> {
    let mut nodes: Vec<Option<Map<String, Value>>> = blocks
        .iter()
        .map(|block| {
            let mut node = camelize_block(block);
            node.insert("children".to_owned(), Value::Array(Vec::new()));
            Some(node)
        })
        .collect();
    let ids: Vec<i64> = nodes.iter().map(|node| number_id(node.as_ref().and_then(|node| node.get("id"))).unwrap_or(0)).collect();
    let node_ids: HashSet<i64> = ids.iter().copied().collect();
    let lefts: Vec<Option<i64>> = nodes.iter().map(|node| node.as_ref().and_then(|node| reference_id(node, "left"))).collect();

    let mut children_of: HashMap<i64, Vec<usize>> = HashMap::new();
    let mut roots_of: HashMap<i64, Vec<usize>> = HashMap::new();
    let mut page_order: Vec<i64> = Vec::new();
    for &id in page_ids {
        if roots_of.insert(id, Vec::new()).is_none() {
            page_order.push(id);
        }
    }
    for (i, node) in nodes.iter().enumerate() {
        let node = node.as_ref().expect("no node is taken yet");
        let parent_id = reference_id(node, "parent");
        match parent_id {
            Some(parent) if node_ids.contains(&parent) && parent != ids[i] => children_of.entry(parent).or_default().push(i),
            _ => {
                // `node.page?.id ?? parentId`
                let Some(page_id) = reference_id(node, "page").or(parent_id) else { continue };
                if !roots_of.contains_key(&page_id) {
                    page_order.push(page_id);
                }
                roots_of.entry(page_id).or_default().push(i);
            }
        }
    }

    // `attach`: each node is in exactly one sibling list, so each is taken once
    fn attach(
        siblings: Vec<usize>,
        level: u64,
        nodes: &mut Vec<Option<Map<String, Value>>>,
        ids: &[i64],
        lefts: &[Option<i64>],
        children_of: &mut HashMap<i64, Vec<usize>>,
    ) -> Vec<Value> {
        let ordered = order_siblings(siblings, |&i| ids[i], |&i| lefts[i]);
        ordered
            .into_iter()
            .map(|i| {
                let below = children_of.remove(&ids[i]).unwrap_or_default();
                let children = attach(below, level + 1, nodes, ids, lefts, children_of);
                let mut node = nodes[i].take().expect("a node is attached once");
                node.insert("level".to_owned(), Value::from(level));
                node.insert("children".to_owned(), Value::Array(children));
                Value::Object(node)
            })
            .collect()
    }

    page_order
        .into_iter()
        .map(|page_id| {
            let roots = roots_of.remove(&page_id).expect("every page in the order has roots");
            (page_id, attach(roots, 1, &mut nodes, &ids, &lefts, &mut children_of))
        })
        .collect()
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
    fn a_sibling_that_shares_an_id_with_a_placed_one_is_kept() {
        // nothing is dropped: both 7s come back, the second after the first
        assert_eq!(ordered(vec![(7, Some(1)), (7, Some(1))]), [7, 7]);
        // a duplicate met again along a chain is kept, and the chain stops at the first block it has placed
        assert_eq!(ordered(vec![(7, Some(1)), (8, Some(7)), (7, Some(8))]), [7, 8, 7]);
    }

    fn flat(blocks: Vec<Value>) -> Vec<Map<String, Value>> {
        blocks.into_iter().map(|block| block.as_object().cloned().unwrap()).collect()
    }

    fn block(id: i64, page: i64, parent: i64, left: i64) -> Value {
        json!({"id": id, "uuid": format!("u{id}"), "content": format!("b{id}"), "page": {"id": page}, "parent": {"id": parent}, "left": {"id": left}, "path-refs": []})
    }

    #[test]
    fn the_pages_come_in_the_order_the_pages_asked_for_then_each_other_page_by_its_first_root() {
        // 41's block is a child, so page 40 is first met at its root 42, after page 30's root
        let blocks = flat(vec![block(41, 40, 42, 42), block(31, 30, 30, 30), block(42, 40, 40, 40), block(11, 10, 10, 10)]);
        let pages: Vec<i64> = build_block_trees_ordered(blocks, &[10, 20, 10]).into_iter().map(|(page, _)| page).collect();
        assert_eq!(pages, [10, 20, 30, 40]);
    }

    #[test]
    fn blocks_become_a_tree_per_page_in_the_order_of_the_left_chain() {
        let trees = build_block_trees(
            flat(vec![block(3, 10, 10, 2), block(21, 10, 2, 2), block(2, 10, 10, 1), block(1, 10, 10, 10), block(50, 20, 20, 20)]),
            &[10, 20, 30],
        );
        let uuids = |blocks: &[Value]| blocks.iter().map(|b| b["uuid"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        // 1's left is the page, which is no sibling, so it heads the chain; 2 follows 1, 3 follows 2
        assert_eq!(uuids(&trees[&10]), ["u1", "u2", "u3"]);
        assert_eq!(uuids(trees[&10][1]["children"].as_array().unwrap()), ["u21"]);
        assert_eq!(uuids(&trees[&20]), ["u50"]);
        // a page asked for with no blocks has an empty tree
        assert_eq!(trees[&30], Vec::<Value>::new());
    }

    #[test]
    fn a_block_has_children_then_level_after_the_keys_of_the_pull_and_camelized_keys() {
        let trees = build_block_trees(flat(vec![block(1, 10, 10, 10), block(2, 10, 1, 1)]), &[10]);
        assert_eq!(
            serde_json::to_string(&trees[&10][0]).unwrap(),
            r#"{"id":1,"uuid":"u1","content":"b1","page":{"id":10},"parent":{"id":10},"left":{"id":10},"pathRefs":[],"children":[{"id":2,"uuid":"u2","content":"b2","page":{"id":10},"parent":{"id":1},"left":{"id":1},"pathRefs":[],"children":[],"level":2}],"level":1}"#
        );
    }

    #[test]
    fn a_block_whose_parent_is_not_among_the_blocks_is_a_root_and_one_with_no_page_is_dropped() {
        // 7's parent (99) was not pulled: it is a root under its page
        let trees = build_block_trees(flat(vec![block(7, 10, 99, 99)]), &[10]);
        assert_eq!(trees[&10].len(), 1);
        // no page: the parent id names the page; no page and no parent: nothing to attach it to
        let no_page = json!({"id": 8, "uuid": "u8", "parent": {"id": 10}});
        let nothing = json!({"id": 9, "uuid": "u9"});
        let trees = build_block_trees(flat(vec![no_page, nothing]), &[10]);
        assert_eq!(trees[&10].len(), 1);
        assert_eq!(trees.len(), 1);
    }

    #[test]
    fn a_block_that_is_its_own_parent_or_in_a_cycle_does_not_loop() {
        let trees = build_block_trees(flat(vec![block(1, 10, 1, 1)]), &[10]);
        assert_eq!(trees[&10].len(), 1);
        // 2 and 3 are each other's parent: neither is a root, so both are lost, as in TypeScript
        let trees = build_block_trees(flat(vec![block(2, 10, 3, 3), block(3, 10, 2, 2)]), &[10]);
        assert!(trees[&10].is_empty());
    }
}
