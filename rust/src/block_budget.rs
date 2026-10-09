//! Cutting block trees to a count of blocks, nested ones included (#162, #183). A cap in these units bounds a result however deep the
//! trees run. Shared by `query_by_date_range` (`max_blocks`) and `search_by_relationship` (`limit`,
//! for `connected-within`).
//!
//! A block is the JSON object a tree rebuilt from Datalog holds: its `children` key is an array
//! of blocks, empty for a leaf.

use serde_json::{Map, Value};

/// `block.children ?? []`: a block's children, none for a leaf or a block with no such key.
fn children_of(block: &Value) -> &[Value] {
    block.get("children").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `countBlocks`: the number of blocks in these trees, nested ones included.
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

/// `takeBlocks`: the first `budget.room` blocks of these trees in document order: a block, then its
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

    #[test]
    fn an_empty_budget_keeps_nothing() {
        let mut budget = Budget::new(0);
        assert!(take_blocks(&tree(), &mut budget).is_empty());
        assert!(!budget.partial);
    }
}
