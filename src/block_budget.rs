//! Cutting block trees to a count of blocks, nested ones included (#162, #183). A cap in these units bounds a result however deep the
//! trees run. Shared by `explore_timeline` (`max_blocks`) and the cuts of `get_page` and
//! `get_block` (#507).
//!
//! A block is the JSON object a tree rebuilt from Datalog holds: its `children` key is an array
//! of blocks, empty for a leaf.

use serde_json::{Map, Value};

use crate::snippet::Snippet;

/// A block's children, none for a leaf or a block with no such key.
fn children_of(block: &Value) -> &[Value] {
    block.get("children").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// The number of blocks in these trees, nested ones included.
pub fn count_blocks(blocks: &[Value]) -> usize {
    blocks.iter().map(|block| 1 + count_blocks(children_of(block))).sum()
}

/// `Budget`: what is left to keep, and whether a kept block lost a child (so it needs
/// `childrenTruncated`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub room: usize,
    pub partial: bool,
}

impl Budget {
    pub fn new(room: usize) -> Budget {
        Budget { room, partial: false }
    }
}

/// The first `budget.room` blocks of these trees in document order: a block, then its
/// children, then its next sibling. What is kept is a valid tree. A kept block whose children
/// don't all fit keeps the first ones that do and gains `childrenTruncated: true`, so it isn't
/// mistaken for a leaf (slim output drops an empty `children`).
///
/// Spends `budget`, so calling it again with the same budget on the next trees continues in
/// document order: the cut falls where one call over both trees would put it.
pub fn take_blocks(blocks: &[Value], budget: &mut Budget) -> Vec<Value> {
    let mut kept = Vec::new();
    for block in blocks {
        if budget.room == 0 {
            break;
        }
        budget.room -= 1;
        let children = children_of(block);
        if children.is_empty() {
            kept.push(block.clone());
            continue;
        }
        let kept_children = take_blocks(children, budget);
        let lost_children = kept_children.len() < children.len();
        if lost_children {
            budget.partial = true;
        }
        // `{ ...block, children: keptChildren, ...(lost ? { childrenTruncated: true } : {}) }`: `children`
        // is a key the block has, so it keeps its place
        let mut cut: Map<String, Value> = block.as_object().cloned().unwrap_or_default();
        cut.insert("children".into(), Value::Array(kept_children));
        if lost_children {
            cut.insert("childrenTruncated".into(), Value::Bool(true));
        }
        kept.push(Value::Object(cut));
    }
    kept
}

/// The blocks at places `start` to `start + len - 1` of these trees in document order (a block, its children, then its
/// next sibling), as a page of a tree that is read to the end with a cursor holds them (ADR-0038, #552). With `start`
/// 0 it is [`take_blocks`] with a budget of `len`.
///
/// A page that starts inside a subtree lists the blocks it holds at the top of the result: each is the root of a piece
/// whose real parent is not on the page. Such a block carries `ancestors`, `[{ uuid, snippet }]` from the outermost to
/// its parent, naming where it sits between the trees' own level and the block; a block that sits at the top level has
/// none and no key. A block whose later children are on the next page keeps `childrenTruncated: true`, as in
/// [`take_blocks`], and a block whose earlier children were on the page before shows no mark: those children are the
/// ones that name it in their `ancestors`.
pub fn slice_blocks(blocks: &[Value], start: usize, len: usize) -> Vec<Value> {
    let mut kept = Vec::new();
    slice_into(blocks, &mut 0, start, start.saturating_add(len), &mut Vec::new(), &mut kept);
    kept
}

/// [`slice_blocks`] over `blocks`, whose first block is at place `*at`; `path` holds the blocks above them that lie
/// before the slice.
fn slice_into<'a>(blocks: &'a [Value], at: &mut usize, start: usize, end: usize, path: &mut Vec<&'a Value>, kept: &mut Vec<Value>) {
    for block in blocks {
        if *at >= end {
            return;
        }
        let size = count_blocks(std::slice::from_ref(block));
        if *at + size <= start {
            *at += size;
            continue;
        }
        if *at < start {
            // An ancestor of the first block of the slice: not on the page, but the blocks of the slice under it are
            *at += 1;
            path.push(block);
            slice_into(children_of(block), at, start, end, path, kept);
            path.pop();
            continue;
        }
        let mut budget = Budget::new(end - *at);
        let Some(piece) = take_blocks(std::slice::from_ref(block), &mut budget).pop() else { return };
        *at = end - budget.room;
        kept.push(if path.is_empty() { piece } else { with_ancestors(piece, path) });
    }
}

/// The block with `ancestors` set, before its `children` when it has them, else last.
fn with_ancestors(block: Value, path: &[&Value]) -> Value {
    let Value::Object(fields) = block else { return block };
    let ancestors: Vec<Value> = path
        .iter()
        .map(|ancestor| {
            let mut named = Map::new();
            if let Some(uuid) = ancestor.get("uuid").filter(|uuid| uuid.is_string()) {
                named.insert("uuid".into(), uuid.clone());
            }
            named.insert("snippet".into(), Value::String(Snippet::of(ancestor.get("content").and_then(Value::as_str)).as_str().to_owned()));
            Value::Object(named)
        })
        .collect();
    let mut placed = Map::new();
    for (key, value) in fields {
        if key == "children" {
            placed.insert("ancestors".into(), Value::Array(ancestors.clone()));
        }
        placed.insert(key, value);
    }
    if !placed.contains_key("ancestors") {
        placed.insert("ancestors".into(), Value::Array(ancestors));
    }
    Value::Object(placed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tree() -> Vec<Value> {
        vec![
            json!({"id": 1, "children": [{"id": 2, "children": []}, {"id": 3, "children": [{"id": 4, "children": []}]}]}),
            json!({"id": 5, "children": []}),
        ]
    }

    fn ids(blocks: &[Value]) -> Vec<i64> {
        blocks.iter().flat_map(|block| std::iter::once(block["id"].as_i64().unwrap()).chain(ids(children_of(block)))).collect()
    }

    #[test]
    fn blocks_are_counted_with_the_ones_nested_in_them() {
        assert_eq!(count_blocks(&tree()), 5);
        assert_eq!(count_blocks(&[]), 0);
        // a block with no `children` key is a leaf
        assert_eq!(count_blocks(&[json!({"id": 1})]), 1);
    }

    #[test]
    fn the_first_blocks_in_document_order_are_kept_and_a_cut_parent_says_so() {
        let mut budget = Budget::new(3);
        let kept = take_blocks(&tree(), &mut budget);
        assert_eq!(ids(&kept), [1, 2, 3]);
        assert_eq!((budget.room, budget.partial), (0, true));
        let parent = &kept[0];
        assert_eq!(parent["children"][1]["children"], json!([]));
        assert_eq!(parent["children"][1]["childrenTruncated"], json!(true));
        // the key keeps its place: `children`, then the flag
        assert_eq!(serde_json::to_string(&parent["children"][1]).unwrap(), r#"{"id":3,"children":[],"childrenTruncated":true}"#);
    }

    #[test]
    fn a_budget_that_fits_everything_changes_nothing() {
        let mut budget = Budget::new(10);
        assert_eq!(take_blocks(&tree(), &mut budget), tree());
        assert_eq!((budget.room, budget.partial), (5, false));
    }

    #[test]
    fn a_second_call_continues_where_the_first_stopped() {
        let mut budget = Budget::new(2);
        let first = take_blocks(&tree()[..1], &mut budget);
        let second = take_blocks(&tree()[1..], &mut budget);
        assert_eq!(ids(&first), [1, 2]);
        assert!(second.is_empty());
    }

    /// Four levels: a(b, c(d, e(f)), g), h. In document order a b c d e f g h, at places 0 to 7.
    fn named() -> Vec<Value> {
        let block = |name: &str, children: Vec<Value>| json!({"id": name, "uuid": format!("u-{name}"), "content": format!("{name} first line\nsecond line"), "children": children});
        vec![
            block("a", vec![block("b", vec![]), block("c", vec![block("d", vec![]), block("e", vec![block("f", vec![])])]), block("g", vec![])]),
            block("h", vec![]),
        ]
    }

    fn names(blocks: &[Value]) -> Vec<String> {
        blocks.iter().flat_map(|block| std::iter::once(block["id"].as_str().unwrap().to_owned()).chain(names(children_of(block)))).collect()
    }

    fn ancestors_of(block: &Value) -> Vec<String> {
        block.get("ancestors").and_then(Value::as_array).map_or_else(Vec::new, |list| list.iter().map(|ancestor| ancestor["snippet"].as_str().unwrap().to_owned()).collect())
    }

    #[test]
    fn a_slice_from_the_start_is_what_take_blocks_keeps() {
        for len in 0..=9 {
            assert_eq!(slice_blocks(&named(), 0, len), take_blocks(&named(), &mut Budget::new(len)), "{len}");
        }
        assert_eq!(slice_blocks(&tree(), 0, 3), take_blocks(&tree(), &mut Budget::new(3)));
    }

    #[test]
    fn a_slice_that_starts_inside_a_subtree_lists_its_blocks_at_the_top_with_their_ancestors() {
        // places 3 to 6: d e f g, then h is the next page. d and e sit under a > c, and g under a
        let kept = slice_blocks(&named(), 3, 4);
        assert_eq!(kept.iter().map(|block| block["id"].as_str().unwrap()).collect::<Vec<_>>(), ["d", "e", "g"]);
        assert_eq!(names(&kept), ["d", "e", "f", "g"]);
        assert_eq!(ancestors_of(&kept[0]), ["a first line", "c first line"]);
        assert_eq!(ancestors_of(&kept[1]), ["a first line", "c first line"]);
        assert_eq!(ancestors_of(&kept[2]), ["a first line"]);
        // f is nested in e as it is, with no ancestors of its own
        assert!(kept[1]["children"][0].get("ancestors").is_none());
        // a block on the top level has none, and no key
        let last = slice_blocks(&named(), 7, 5);
        assert_eq!(names(&last), ["h"]);
        assert!(last[0].get("ancestors").is_none());
    }

    #[test]
    fn an_ancestor_is_named_by_its_uuid_and_the_first_line_of_its_content() {
        let kept = slice_blocks(&named(), 4, 1);
        assert_eq!(kept[0]["ancestors"], json!([{"uuid": "u-a", "snippet": "a first line"}, {"uuid": "u-c", "snippet": "c first line"}]));
        // before `children`, after the keys the block had
        let keys: Vec<&String> = kept[0].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "uuid", "content", "ancestors", "children", "childrenTruncated"]);
        // a block with no `children` key gets it last, and an ancestor with no uuid is named by its snippet alone
        let bare = vec![json!({"content": "top", "children": [{"id": "x"}, {"id": "y"}]})];
        let kept = slice_blocks(&bare, 2, 1);
        assert_eq!(serde_json::to_string(&kept[0]).unwrap(), r#"{"id":"y","ancestors":[{"snippet":"top"}]}"#);
    }

    #[test]
    fn a_block_whose_later_children_are_on_the_next_page_says_so_and_one_whose_earlier_children_were_not() {
        // places 1 to 3: b c d. c keeps d and loses e, so c is marked; its parent a is not on the page at all
        let kept = slice_blocks(&named(), 1, 3);
        assert_eq!(names(&kept), ["b", "c", "d"]);
        assert!(kept[0].get("childrenTruncated").is_none());
        assert_eq!(kept[1]["childrenTruncated"], json!(true));
        assert_eq!(ancestors_of(&kept[1]), ["a first line"]);
        // the next page starts at e: its ancestors name c, and nothing is marked
        let next = slice_blocks(&named(), 4, 2);
        assert_eq!(names(&next), ["e", "f"]);
        assert_eq!(ancestors_of(&next[0]), ["a first line", "c first line"]);
        assert!(next[0].get("childrenTruncated").is_none());
    }

    #[test]
    fn reading_slice_after_slice_gives_every_block_once_in_document_order() {
        for len in 1..=9 {
            let mut seen = Vec::new();
            let mut start = 0;
            while start < 8 {
                let kept = slice_blocks(&named(), start, len);
                let count = count_blocks(&kept);
                assert_eq!(count, len.min(8 - start), "the page holds what was asked for: from {start} by {len}");
                seen.extend(names(&kept));
                start += count;
            }
            assert_eq!(seen, ["a", "b", "c", "d", "e", "f", "g", "h"], "slices of {len}");
        }
    }

    #[test]
    fn a_slice_past_the_end_or_of_no_length_is_empty() {
        assert!(slice_blocks(&named(), 8, 3).is_empty());
        assert!(slice_blocks(&named(), 99, 3).is_empty());
        assert!(slice_blocks(&named(), 3, 0).is_empty());
        assert!(slice_blocks(&[], 0, 3).is_empty());
        // a length that would overflow the end of the range is the rest of the list
        assert_eq!(names(&slice_blocks(&named(), 6, usize::MAX)), ["g", "h"]);
    }

    #[test]
    fn an_empty_budget_keeps_nothing() {
        let mut budget = Budget::new(0);
        assert!(take_blocks(&tree(), &mut budget).is_empty());
        assert!(!budget.partial);
    }
}
