//! The blocks of a timeline as a list a cursor reads to the end (ADR-0038, #554): the places in it, the slice a page
//! holds, and the words of the warning of a cut page.
//!
//! The entries of the list are the blocks across the days, in the order the tool lists them (days oldest first, or
//! newest first for `last_n` with no page, the blocks with no day last), a block and then its children, nested ones
//! counted (only top-level ones with `include_content: false`). The place of a page is its index in that order, and
//! `max_blocks` is the page size. A page is also cut to the character budget, by `crate::paging::page_of`, and a day
//! that falls across two pages is on both with the same `date`; the blocks of a page that start under a block of the
//! page before name it in `ancestors` (`crate::block_budget::slice_blocks`).

use serde_json::Value;

use super::Entry;
use crate::block_budget::{count_blocks, slice_blocks};
use crate::cursor::Anchor;

/// Blocks kept when `max_blocks` is absent (#61).
pub const DEFAULT_MAX_BLOCKS: u64 = 200;

/// Most blocks one page holds (#61). A larger `max_blocks` is clamped to it: the cursor reads on from there.
pub const MAX_BLOCKS: usize = 1000;

/// Blocks an entry lists: nested ones too, or only top-level ones (the outline).
fn listed_blocks(blocks: &[Value], nested: bool) -> usize {
    if nested { count_blocks(blocks) } else { blocks.len() }
}

/// How many blocks the entries list in all.
#[cfg(test)]
pub fn total_blocks(entries: &[Entry], nested: bool) -> usize {
    entries.iter().map(|entry| listed_blocks(&entry.blocks, nested)).sum()
}

/// The days among entries: the entries with a date.
pub fn day_count(entries: &[Entry]) -> usize {
    entries.iter().filter(|entry| entry.date.is_some()).count()
}

/// What names a block in its list: its uuid, else its numeric id.
fn key_of(block: &Value) -> Anchor {
    match (block.get("uuid").and_then(Value::as_str), block.get("id").and_then(Value::as_i64)) {
        (Some(uuid), _) => Anchor::Text(uuid.to_owned()),
        (None, Some(id)) => Anchor::Id(id),
        (None, None) => Anchor::Text(String::new()),
    }
}

fn push_keys(blocks: &[Value], nested: bool, keys: &mut Vec<Anchor>) {
    for block in blocks {
        keys.push(key_of(block));
        if nested {
            push_keys(block.get("children").and_then(Value::as_array).map_or(&[], Vec::as_slice), nested, keys);
        }
    }
}

/// The key of each block of the list, in its order: what a cursor names the last block it sent by.
pub fn keys_of(entries: &[Entry], nested: bool) -> Vec<Anchor> {
    let mut keys = Vec::new();
    for entry in entries {
        push_keys(&entry.blocks, nested, &mut keys);
    }
    keys
}

/// The entries of the page that holds the blocks at places `start` to `start + len - 1` of a list of `total` blocks:
/// each entry that has some of them, with only those blocks (`ancestors` on the ones that start under a block of an
/// earlier page). A day with no block is on the page its place falls on: from `start` up to its end, and the last
/// ones too when the page reaches the last block, so no day is dropped or shown twice.
pub fn slice_entries(entries: &[Entry], start: usize, len: usize, total: usize, nested: bool) -> Vec<Entry> {
    let end = start.saturating_add(len);
    let mut kept = Vec::new();
    let mut at = 0;
    for entry in entries {
        let listed = listed_blocks(&entry.blocks, nested);
        let reached = if listed == 0 {
            at >= start && (at < end || end >= total)
        } else {
            at + listed > start && at < end
        };
        if reached {
            let blocks = if listed == 0 {
                Vec::new()
            } else {
                let from = start.saturating_sub(at);
                let count = end.min(at + listed) - start.max(at);
                if nested { slice_blocks(&entry.blocks, from, count) } else { entry.blocks[from..from + count].to_vec() }
            };
            kept.push(Entry { blocks, ..entry.clone() });
        }
        at += listed;
    }
    kept
}

/// What the warning of a cut page says about the list.
pub struct Words {
    /// The cap counts nested blocks (full and slim output), not only top-level ones (the outline)
    pub nested: bool,
    /// `last_n` order: newest day first
    pub newest_first: bool,
    /// The `max_blocks` the caller asked for, before it was clamped
    pub requested: u64,
}

impl Words {
    /// What the list holds, as a warning says it.
    pub fn what(&self) -> String {
        let unit = if self.nested { "nested ones counted" } else { "top-level only" };
        let order = if self.newest_first { "newest day first" } else { "oldest day first" };
        format!("blocks ({unit}; {order})")
    }

    /// What a reader can do besides reading on: how a page that cuts a day or a block looks, and how to read less. The
    /// cursor reads on (the warning's `howToFetchAll` names it).
    pub fn advice(&self, size_cut: bool) -> String {
        let continues = if self.nested {
            "A day cut between two pages is on both with the same date, a block marked childrenTruncated lost children that the next page starts with, and a block that starts a page under another block names it in ancestors."
        } else {
            "A day cut between two pages is on both with the same date."
        };
        let limit = if size_cut {
            ""
        } else if self.requested > MAX_BLOCKS as u64 {
            "max_blocks is the page size, capped at its maximum of 1000, so the rest is on the next page."
        } else {
            "max_blocks is the page size (at most 1000)."
        };
        if limit.is_empty() {
            format!("{continues} To read less, narrow the period.")
        } else {
            format!("{continues} {limit} To read less, narrow the period.")
        }
    }

    /// The way on of a page that holds no block and so has no cursor (a `max_blocks` of 0): the page size is the only one.
    pub fn raise(&self) -> String {
        "set max_blocks above 0 to read blocks.".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A top-level block with `children` leaves under it
    fn block(id: i64, children: usize) -> Value {
        let kids: Vec<Value> = (0..children).map(|c| json!({"id": id * 100 + c as i64, "uuid": format!("u-{}", id * 100 + c as i64), "children": []})).collect();
        json!({"id": id, "uuid": format!("u-{id}"), "content": format!("block {id}"), "children": kids})
    }

    fn entry(date: i64, blocks: Vec<Value>) -> Entry {
        Entry { date: Some(date), page: Default::default(), blocks }
    }

    fn undated(blocks: Vec<Value>) -> Entry {
        Entry { date: None, page: Default::default(), blocks }
    }

    fn ids(entry: &Entry) -> Vec<i64> {
        fn walk(blocks: &[Value], out: &mut Vec<i64>) {
            for block in blocks {
                out.push(block["id"].as_i64().unwrap());
                walk(block["children"].as_array().map_or(&[][..], Vec::as_slice), out);
            }
        }
        let mut out = Vec::new();
        walk(&entry.blocks, &mut out);
        out
    }

    fn pages(entries: &[Entry], size: usize, nested: bool) -> Vec<Vec<(Option<i64>, Vec<i64>)>> {
        let total = total_blocks(entries, nested);
        let mut out = Vec::new();
        let mut start = 0;
        loop {
            let len = size.min(total - start);
            out.push(slice_entries(entries, start, len, total, nested).iter().map(|entry| (entry.date, ids(entry))).collect());
            start += len;
            if start >= total {
                return out;
            }
        }
    }

    #[test]
    fn blocks_are_counted_across_the_days_nested_or_top_level() {
        let entries = [entry(20250101, vec![block(1, 2), block(2, 0)]), entry(20250102, vec![]), undated(vec![block(3, 1)])];
        assert_eq!(total_blocks(&entries, true), 3 + 1 + 2);
        assert_eq!(total_blocks(&entries, false), 3);
        assert_eq!(day_count(&entries), 2);
        assert_eq!(keys_of(&entries, false), [Anchor::Text("u-1".into()), Anchor::Text("u-2".into()), Anchor::Text("u-3".into())]);
        assert_eq!(keys_of(&entries, true).len(), 6);
        assert_eq!(keys_of(&entries, true)[1], Anchor::Text("u-100".into()));
        // a block with no uuid is named by its id
        assert_eq!(keys_of(&[entry(1, vec![json!({"id": 7})])], true), [Anchor::Id(7)]);
    }

    #[test]
    fn the_pages_of_a_list_hold_every_block_once_and_a_split_day_is_on_both_pages() {
        let entries = [entry(20250101, vec![block(1, 1), block(2, 0)]), entry(20250102, vec![block(3, 0), block(4, 0)])];
        // blocks: 1 100 2 | 3 4 (places 0..5)
        assert_eq!(
            pages(&entries, 2, true),
            [
                vec![(Some(20250101), vec![1, 100])],
                vec![(Some(20250101), vec![2]), (Some(20250102), vec![3])],
                vec![(Some(20250102), vec![4])],
            ]
        );
        // the first block of the second page sits at the top level of the day: no ancestors. The page after a parent does
        let page = slice_entries(&entries, 1, 2, 5, true);
        assert_eq!(page[0].blocks[0]["id"], 100);
        assert_eq!(page[0].blocks[0]["ancestors"], json!([{"uuid": "u-1", "snippet": "block 1"}]));
        assert_eq!(page[0].blocks[1]["id"], 2);
        assert!(page[0].blocks[1].get("ancestors").is_none());
    }

    #[test]
    fn a_day_with_no_block_is_on_the_page_it_falls_on_and_the_last_ones_on_the_last_page() {
        let entries = [entry(20250101, vec![]), entry(20250102, vec![block(1, 0), block(2, 0)]), entry(20250103, vec![]), entry(20250104, vec![block(3, 0)]), entry(20250105, vec![])];
        let days = |page: &[(Option<i64>, Vec<i64>)]| page.iter().map(|(date, _)| date.unwrap()).collect::<Vec<_>>();
        let result = pages(&entries, 2, true);
        assert_eq!(days(&result[0]), [20250101, 20250102]);
        assert_eq!(days(&result[1]), [20250103, 20250104, 20250105]);
        // every day once
        let all: Vec<i64> = result.iter().flat_map(|page| days(page)).collect();
        assert_eq!(all, [20250101, 20250102, 20250103, 20250104, 20250105]);
        // a page of no block keeps no day, unless it is the last
        assert!(slice_entries(&entries, 0, 0, 3, true).is_empty());
        assert_eq!(slice_entries(&[entry(1, vec![])], 0, 0, 0, true).len(), 1);
    }

    #[test]
    fn the_outline_pages_by_top_level_blocks_and_keeps_their_children_whole() {
        let entries = [entry(20250101, vec![block(1, 3), block(2, 0), block(3, 0)])];
        let page = slice_entries(&entries, 1, 1, 3, false);
        assert_eq!(ids(&page[0]), [2]);
        let first = slice_entries(&entries, 0, 1, 3, false);
        assert_eq!(ids(&first[0]), [1, 100, 101, 102]);
        assert!(first[0].blocks[0].get("ancestors").is_none());
    }

    #[test]
    fn a_prefix_of_a_page_is_the_page_cut_like_take_blocks_does() {
        let entries = [entry(20250101, vec![block(1, 3), block(2, 0)])];
        let page = slice_entries(&entries, 2, 3, 5, true);
        // places 2, 3, 4: the second and third child of block 1, then block 2
        assert_eq!(ids(&page[0]), [101, 102, 2]);
        let prefix = slice_entries(&page, 0, 2, 3, true);
        assert_eq!(ids(&prefix[0]), [101, 102]);
        assert_eq!(prefix[0].blocks[0]["ancestors"], json!([{"uuid": "u-1", "snippet": "block 1"}]));
    }

    #[test]
    fn the_words_of_a_cut_say_the_unit_the_order_and_what_a_split_looks_like() {
        let words = Words { nested: true, newest_first: false, requested: 200 };
        assert_eq!(words.what(), "blocks (nested ones counted; oldest day first)");
        let newest = Words { nested: false, newest_first: true, requested: 200 };
        assert_eq!(newest.what(), "blocks (top-level only; newest day first)");
        assert!(words.advice(false).contains("names it in ancestors") && words.advice(false).contains("childrenTruncated"));
        assert!(!newest.advice(false).contains("ancestors") && !newest.advice(false).contains("childrenTruncated"));
        assert!(!words.advice(true).contains("No parameter raises") && !words.advice(true).contains("max_blocks is"));
        assert!(Words { requested: 5000, ..words }.advice(false).contains("capped at its maximum of 1000"));
    }
}
