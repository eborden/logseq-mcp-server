//! A block tree read to the end with the cursor (ADR-0038, #552): what `get_page` with `detail: "full"` and
//! `get_block` with `include_children` share. The tree was read once, with the calls the tool has always made, and is
//! cut here into pages of whole blocks in document order, each at most the character budget (`crate::budget`).
//!
//! - [`Tree`] is what a snapshot keeps: the page or the block as it was read (`resolve_refs` applied), and the key of
//!   each block in document order, so a cursor can check the last block it sent is where it was.
//! - [`read`] is the whole read of one call: the tree (from the snapshot a cursor names, or built again with the
//!   first page's calls), where the page starts, how many blocks fit, the warnings and the `nextCursor`, and the
//!   result as the tool writes its text.
//!
//! The entries are the blocks in document order (a block, its children, then its next sibling), nested ones counted,
//! so the position of a page is its index in that order. For `get_block` the block itself is entry 0.
//!
//! A page that starts inside a subtree lists its blocks at the top of `children`, each with the `ancestors` it sits
//! under (`crate::block_budget::slice_blocks`). A page of a block that does not start at the block sends
//! `{ uuid, continued: true, children }`, so a long block is not repeated. A page of a page repeats the page entity,
//! which is small, without `resolvedFrom`: how the request was read is said on the first page only.
//!
//! A page is never cut inside a block (BR-0007): a block that is over the budget by itself is returned alone and the
//! cursor moves past it.

use std::future::Future;
use std::time::Instant;

use serde_json::{Map, Value};

use crate::block_budget::slice_blocks;
use crate::budget::size;
use crate::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode, invalid};
use crate::errors::InvalidParameter;
use crate::meta::ResultWarning;
use crate::paging::{Cut, PagedCut, Stale, page_of, paged_warning, resume_at, serve, stale_warning};
use crate::snapshots::{Snapshots, resident_weight};

/// What the tree is the tree of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Root {
    /// A page: its blocks are the entries, and each page repeats the page entity
    Page,
    /// A block: it is entry 0, and its descendants follow
    Block,
}

/// One tree, as it was read. The snapshot of a call that cut it.
pub struct Tree {
    root: Root,
    /// The result of the read without `hasMore` and `warnings`: the page or the block, `children` in its place
    base: Map<String, Value>,
    /// What the read warned of (`resolve_refs`, a tree LogSeq did not answer): every page repeats it
    warnings: Vec<Value>,
    /// The result as the read made it carried `hasMore` and `warnings`, so each page does
    meta: bool,
    /// The key of each entry, in document order
    keys: Vec<Anchor>,
}

impl Tree {
    /// A tree from the result of a read: the page with its blocks as `children`, or the block with its own.
    pub fn new(root: Root, result: Value) -> Tree {
        let Value::Object(mut base) = result else { return Tree { root, base: Map::new(), warnings: Vec::new(), meta: false, keys: Vec::new() } };
        let has_more = base.remove("hasMore");
        let warnings = match base.remove("warnings") {
            Some(Value::Array(warnings)) => warnings,
            _ => Vec::new(),
        };
        let meta = has_more.is_some() || !warnings.is_empty();
        let mut tree = Tree { root, base, warnings, meta, keys: Vec::new() };
        let mut keys = Vec::new();
        if root == Root::Block {
            keys.push(key_of(&tree.base));
        }
        keys_of(tree.children(), &mut keys);
        tree.keys = keys;
        tree
    }

    /// The blocks of the page, or the children of the block
    fn children(&self) -> &[Value] {
        self.base.get("children").and_then(Value::as_array).map_or(&[], Vec::as_slice)
    }

    /// How many entries there are.
    pub fn total(&self) -> usize {
        self.keys.len()
    }

    /// What the snapshot weighs for the cache's bounds: the length of the JSON of the tree, scaled to the memory it takes
    /// ([`resident_weight`]). A tree whose weight is over the cache's per-snapshot limit is not kept, and its later
    /// pages are built again with the first page's calls.
    pub fn weight(&self) -> usize {
        resident_weight(serde_json::to_string(&self.base).map_or(0, |text| text.len()))
    }

    /// The first `kept` entries from place `start`, as the page or the block that holds them, without the completeness
    /// keys. `first` is whether this is the first page of the read: only it says how a page name was resolved.
    fn slice(&self, start: usize, kept: usize, first: bool) -> Map<String, Value> {
        // The keys other than `children` are copied (the tree under it is not), and `children` takes the sliced blocks in
        // its place, or last when the tree had none
        let rebuilt = |drop: &str, mut children: Option<Vec<Value>>, only_if_there: bool| {
            let mut result = Map::new();
            let mut placed = false;
            for (key, value) in &self.base {
                if key == "children" {
                    if let Some(pieces) = children.take() {
                        result.insert(key.clone(), Value::Array(pieces));
                        placed = true;
                    }
                } else if key != drop {
                    result.insert(key.clone(), value.clone());
                }
            }
            if !placed && !only_if_there {
                if let Some(pieces) = children.take() {
                    result.insert("children".into(), Value::Array(pieces));
                }
            }
            result
        };
        match self.root {
            Root::Page => {
                let pieces = slice_blocks(self.children(), start, kept);
                // A page that has no `children` key had no blocks, or none LogSeq answered: it stays so. One that has
                // it keeps it, empty when the tree shrank below the position, which says the page was read
                let has = self.base.contains_key("children");
                rebuilt(if first { "" } else { "resolvedFrom" }, (!pieces.is_empty() || has).then_some(pieces), false)
            }
            Root::Block if start == 0 => {
                let own = self.children();
                let pieces = slice_blocks(own, 0, kept.saturating_sub(1));
                let lost = pieces.len() < own.len();
                let mut result = rebuilt("", Some(pieces), true);
                if lost {
                    result.insert("childrenTruncated".into(), Value::Bool(true));
                }
                result
            }
            Root::Block => {
                let pieces = slice_blocks(self.children(), start - 1, kept);
                let mut result = Map::new();
                if let Some(uuid) = self.base.get("uuid") {
                    result.insert("uuid".into(), uuid.clone());
                }
                result.insert("continued".into(), Value::Bool(true));
                result.insert("children".into(), Value::Array(pieces));
                result
            }
        }
    }
}

/// What names a block in its tree: its uuid, else its numeric id.
fn key_of(block: &Map<String, Value>) -> Anchor {
    match (block.get("uuid").and_then(Value::as_str), block.get("id").and_then(Value::as_i64)) {
        (Some(uuid), _) => Anchor::Text(uuid.to_owned()),
        (None, Some(id)) => Anchor::Id(id),
        (None, None) => Anchor::Text(String::new()),
    }
}

fn keys_of(blocks: &[Value], keys: &mut Vec<Anchor>) {
    for block in blocks {
        keys.push(block.as_object().map_or(Anchor::Text(String::new()), key_of));
        keys_of(block.get("children").and_then(Value::as_array).map_or(&[], Vec::as_slice), keys);
    }
}

/// What a cursor says about where to read on, decoded and checked against the tool that reads it.
pub struct Resume {
    pub cursor: Cursor,
    /// The place of the first entry of the next page, in the tree as the first call read it
    at: usize,
    /// The token as sent, for a refusal
    token: String,
}

impl Resume {
    pub fn read(token: &str, tool: &str) -> Result<Resume, InvalidParameter> {
        let cursor = decode(token, tool)?;
        let Position::Index { at } = cursor.position else {
            return Err(invalid(token, tool, "this is not a cursor of this tool: its position is not one block"));
        };
        Ok(Resume { cursor, at, token: token.to_owned() })
    }

    /// The place of the first entry of the next page, in the list as the first call read it.
    pub fn at(&self) -> usize {
        self.at
    }

    /// A token whose arguments are not a read of a tree: the same refusal as one that doesn't parse.
    pub fn refuse(&self, tool: &str, reason: &str) -> InvalidParameter {
        invalid(&self.token, tool, reason)
    }
}

/// What a read needs to know about the tool and the format it writes.
pub struct Spec {
    pub tool: &'static str,
    pub root: Root,
    /// The text is Markdown, which marks no block that lost children, so its advice names none
    pub markdown: bool,
}

impl Spec {
    /// What the list holds, as a warning says it.
    fn what(&self) -> &'static str {
        match self.root {
            Root::Page => "blocks of the page (nested ones counted, in page order)",
            Root::Block => "blocks (the block and its descendants, in document order)",
        }
    }

    /// What a reader can do about a result cut for its size: what the next page starts with, and how to read less. The
    /// cursor reads on (the warning's `howToFetchAll` names it).
    fn advice(&self) -> String {
        let (left_out, continues) = match (self.root, self.markdown) {
            (Root::Page, false) => (
                "The last blocks are left out, and a block marked childrenTruncated lost some of its children.",
                "The next page starts with them: its blocks that sit under another block name it in ancestors.",
            ),
            (Root::Page, true) => (
                "The last blocks are left out, and the last blocks kept may have lost some of their children.",
                "The next page continues from there: a block that sits under another block has an [under: ...] line naming it.",
            ),
            (Root::Block, false) => (
                "The last blocks are left out, and a block marked childrenTruncated lost some of its children.",
                "The next page starts with them, directly under the block (continued: true): a block that sits under another block names it in ancestors.",
            ),
            (Root::Block, true) => (
                "The last blocks are left out, and the last blocks kept may have lost some of their children.",
                "The next page continues from there: a block that sits under another block has an [under: ...] line naming it.",
            ),
        };
        let read_less = match self.root {
            Root::Page => "To read less, list the top-level blocks with detail \"outline\" and read one with logseq_get_block and include_children.",
            Root::Block => "To read less, read a block below this one with logseq_get_block and include_children, or find blocks by their text with logseq_find_blocks.",
        };
        format!("{left_out} {continues} {read_less}")
    }
}

/// One page of the tree, and everything its warnings, cursor and result are made from.
struct View<'a> {
    spec: &'a Spec,
    tree: &'a Tree,
    /// The place of the first entry of this page
    start: usize,
    /// Whether this is the first page of the read, which says how the request was read
    first: bool,
    stale: Option<Stale>,
    /// What the next page's cursor carries: the arguments as they were stored, and the snapshot
    args: &'a Map<String, Value>,
    key: SnapshotKey,
}

impl View<'_> {
    /// How the page ends when it holds the first `kept` entries it could: not at all when it reaches the last
    /// entry, by the budget otherwise (a tree has no page size).
    fn cut_at(&self, kept: usize) -> Option<Cut> {
        (self.start + kept < self.tree.total()).then_some(Cut::Size { oversize: false })
    }

    fn next_cursor(&self, kept: usize, cut: Option<Cut>) -> Option<String> {
        if cut.is_none() || kept == 0 {
            return None;
        }
        let anchor = self.tree.keys[self.start + kept - 1].clone();
        Some(encode(&Cursor::new(self.spec.tool, self.args.clone(), Position::Index { at: self.start + kept }, anchor, self.key)))
    }

    /// The result holding the first `kept` entries of this page, ending as `cut` says: the page or the block, then
    /// `hasMore`, `nextCursor` and `warnings` when any of them applies.
    fn result(&self, kept: usize, cut: Option<Cut>) -> Value {
        let next = self.next_cursor(kept, cut);
        let mut warnings: Vec<ResultWarning> = self.stale.map(|stale| stale_warning(stale, "blocks")).into_iter().collect();
        if let Some(cut) = cut {
            warnings.push(paged_warning(PagedCut {
                count_code: "blocks_truncated",
                cut,
                what: self.spec.what(),
                start: self.start,
                kept,
                total: self.tree.total(),
                advice: &self.spec.advice(),
                raise: None,
                has_next: next.is_some(),
            }));
        }
        let mut result = self.tree.slice(self.start, kept, self.first);
        let mut all = self.tree.warnings.clone();
        all.extend(warnings.iter().map(|warning| serde_json::to_value(warning).expect("a warning serializes")));
        // A warning the read made may offer a way of its own to fetch what it left out (a ref past the depth limit):
        // that keeps `hasMore` as it was before the cursor. Nothing the cursor says offers a way without `nextCursor`.
        let offers = self.tree.warnings.iter().any(|warning| warning.get("howToFetchAll").is_some());
        if self.tree.meta || !all.is_empty() || next.is_some() {
            result.insert("hasMore".into(), Value::Bool(next.is_some() || offers));
            if let Some(next) = next {
                result.insert("nextCursor".into(), Value::String(next));
            }
            result.insert("warnings".into(), Value::Array(all));
        }
        Value::Object(result)
    }
}

/// One call's read of a tree: the tree from the snapshot a cursor names (no LogSeq call) or from `build`, which makes
/// the calls the first page made and no more (a first call, or a cursor whose snapshot is gone); where the page
/// starts, with `cursor_stale` when the tree moved between pages; the most blocks that fit the budget, never fewer
/// than one; and the result, written by `texts` (the page or block as text, then its tips). A tree that fits one page
/// needs no snapshot.
///
/// `args` is the arguments as the cursor carries them: the snapshot is served only to a call whose arguments equal
/// them. `texts` is the text the call sends for a result, which the budget measures.
pub async fn read<E, Fut>(
    snapshots: &Snapshots,
    resume: Option<&Resume>,
    args: &Map<String, Value>,
    spec: &Spec,
    now: Instant,
    build: impl FnOnce() -> Fut,
    texts: impl Fn(&Value) -> Vec<String>,
) -> Result<Vec<String>, E>
where
    Fut: Future<Output = Result<Tree, E>>,
{
    let served = serve(snapshots, resume.map(|resume| &resume.cursor.snapshot), args, now, build).await?;
    let tree = &*served.list;
    let total = tree.total();
    let (start, stale) = match resume {
        None => (0, None),
        Some(resume) => {
            let anchor = &resume.cursor.anchor;
            let resumed = resume_at(total, resume.at, |at| &tree.keys[at] == anchor, || tree.keys.iter().position(|key| key == anchor).map(|at| at + 1));
            (resumed.start, resumed.stale)
        }
    };
    let view = View { spec, tree, start, first: resume.is_none(), stale, args, key: served.key };
    let sent = |kept: usize| texts(&view.result(kept, view.cut_at(kept))).iter().map(|text| size(text)).sum::<usize>();
    let page = page_of(total, start, usize::MAX, sent);
    // A tree that fits one page needs no snapshot, and a hit is kept already (its weight is not worked out again)
    if page.next().is_some() && !served.hit {
        served.keep(snapshots, args, tree.weight(), now);
    }
    Ok(texts(&view.result(page.kept, page.cut)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOOL: &str = "logseq_get_page";

    fn block(id: &str, children: Vec<Value>) -> Value {
        json!({"id": id, "uuid": format!("u-{id}"), "content": format!("{id} first line"), "children": children})
    }

    /// a(b, c(d)), e
    fn blocks() -> Vec<Value> {
        vec![block("a", vec![block("b", vec![]), block("c", vec![block("d", vec![])])]), block("e", vec![])]
    }

    fn page_result() -> Value {
        json!({"id": 1, "originalName": "Atlas", "resolvedFrom": {"name": "atlas", "matchedBy": "alias", "resolvedTo": "Atlas"}, "children": blocks()})
    }

    const KEY: SnapshotKey = SnapshotKey { started: 1, n: 1 };

    fn view<'a>(spec: &'a Spec, tree: &'a Tree, args: &'a Map<String, Value>, start: usize, first: bool) -> View<'a> {
        View { spec, tree, start, first, stale: None, args, key: KEY }
    }

    fn page_spec() -> Spec {
        Spec { tool: TOOL, root: Root::Page, markdown: false }
    }

    fn names(result: &Value) -> Vec<String> {
        fn walk(blocks: &[Value], out: &mut Vec<String>) {
            for block in blocks {
                out.push(block["id"].as_str().unwrap().to_owned());
                walk(block["children"].as_array().map_or(&[][..], Vec::as_slice), out);
            }
        }
        let mut out = Vec::new();
        walk(result["children"].as_array().map_or(&[][..], Vec::as_slice), &mut out);
        out
    }

    #[test]
    fn a_tree_read_whole_is_the_result_it_was_made_from_byte_for_byte() {
        let (spec, args) = (page_spec(), Map::new());
        for original in [
            page_result(),
            // with the keys a read that resolved refs adds
            json!({"id": 1, "originalName": "Atlas", "children": blocks(), "hasMore": false, "warnings": []}),
            json!({"id": 1, "originalName": "Atlas", "children": blocks(), "hasMore": true, "warnings": [{"code": "refs_depth_limit", "message": "m", "howToFetchAll": "Fetch each ref"}]}),
            // no blocks: no `children` key, and a warning
            json!({"id": 1, "originalName": "Atlas", "hasMore": false, "warnings": [{"code": "page_blocks_unavailable", "message": "m"}]}),
            json!({"id": 1, "originalName": "Atlas"}),
        ] {
            let tree = Tree::new(Root::Page, original.clone());
            let page = view(&spec, &tree, &args, 0, true).result(tree.total(), None);
            assert_eq!(page.to_string(), original.to_string());
        }
        // a block with keys after `children` keeps them there
        let block_spec = Spec { tool: "logseq_get_block", root: Root::Block, markdown: false };
        let original = json!({"id": 5, "uuid": "u5", "children": blocks(), "page": {"id": 1}, "hasMore": false, "warnings": []});
        let tree = Tree::new(Root::Block, original.clone());
        assert_eq!(tree.total(), 1 + 5);
        assert_eq!(view(&block_spec, &tree, &args, 0, true).result(tree.total(), None).to_string(), original.to_string());
    }

    #[test]
    fn the_entries_are_the_blocks_in_document_order_and_a_block_read_counts_itself_first() {
        let tree = Tree::new(Root::Page, page_result());
        assert_eq!(tree.total(), 5);
        let expected: Vec<Anchor> = ["u-a", "u-b", "u-c", "u-d", "u-e"].iter().map(|uuid| Anchor::Text((*uuid).to_owned())).collect();
        assert_eq!(tree.keys, expected);
        let read = Tree::new(Root::Block, block("r", blocks()));
        assert_eq!(read.total(), 6);
        assert_eq!(read.keys[0], Anchor::Text("u-r".into()));
        // a block with no uuid is named by its id, and one with neither by nothing
        let odd = Tree::new(Root::Page, json!({"children": [{"id": 7}, {"content": "x"}, "not a block"]}));
        assert_eq!(odd.keys, [Anchor::Id(7), Anchor::Text(String::new()), Anchor::Text(String::new())]);
    }

    #[test]
    fn a_cut_page_says_how_far_it_read_and_where_the_next_one_starts() {
        let tree = Tree::new(Root::Page, page_result());
        let args = json!({"page": "Atlas", "detail": "full"}).as_object().cloned().unwrap();
        let spec = page_spec();
        // the first 3 of 5 entries: a, b, c (c lost its child d)
        let result = view(&spec, &tree, &args, 0, true).result(3, Some(Cut::Size { oversize: false }));
        assert_eq!(names(&result), ["a", "b", "c"]);
        assert_eq!(result["children"][0]["children"][1]["childrenTruncated"], json!(true));
        let keys: Vec<&String> = result.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "originalName", "resolvedFrom", "children", "hasMore", "nextCursor", "warnings"]);
        assert_eq!(result["hasMore"], json!(true));
        let message = result["warnings"][0]["message"].as_str().unwrap();
        assert!(message.starts_with("Showing 1-3 of 5 blocks of the page (nested ones counted, in page order): the result was cut to fit 30000 characters"), "{message}");
        assert_eq!(result["warnings"][0]["howToFetchAll"], crate::paging::NEXT_PAGE);
        // the cursor is of this tool, holds the arguments and the snapshot, and names the last block sent
        let cursor = decode(result["nextCursor"].as_str().unwrap(), TOOL).unwrap();
        assert_eq!((cursor.position, cursor.anchor, cursor.snapshot, &cursor.args), (Position::Index { at: 3 }, Anchor::Text("u-c".into()), KEY, &args));
    }

    #[test]
    fn a_later_page_repeats_the_frame_without_the_resolution_of_the_name_and_a_last_page_has_no_meta() {
        let tree = Tree::new(Root::Page, page_result());
        let args = Map::new();
        let spec = page_spec();
        let result = view(&spec, &tree, &args, 3, false).result(2, None);
        assert_eq!(names(&result), ["d", "e"]);
        // d sits under a > c, and e at the top
        assert_eq!(result["children"][0]["ancestors"], json!([{"uuid": "u-a", "snippet": "a first line"}, {"uuid": "u-c", "snippet": "c first line"}]));
        assert!(result["children"][1].get("ancestors").is_none());
        let keys: Vec<&String> = result.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "originalName", "children"], "no resolvedFrom, and no hasMore, nextCursor or warnings");
        // a page past the end holds an empty `children`, which says it was read
        let empty = view(&spec, &tree, &args, 5, false).result(0, None);
        assert_eq!(empty["children"], json!([]));
    }

    #[test]
    fn a_later_page_of_a_block_is_its_uuid_and_the_blocks_below_it_and_the_first_is_the_block_with_its_first_children() {
        let spec = Spec { tool: "logseq_get_block", root: Root::Block, markdown: false };
        let tree = Tree::new(Root::Block, block("r", blocks()));
        let args = Map::new();
        // entries: r a b c d e
        let first = view(&spec, &tree, &args, 0, true).result(3, Some(Cut::Size { oversize: false }));
        assert_eq!(first["uuid"], "u-r");
        assert_eq!(first["content"], "r first line");
        assert_eq!(first["childrenTruncated"], json!(true));
        assert_eq!(names(&first), ["a", "b"]);
        let second = view(&spec, &tree, &args, 3, true).result(3, None);
        assert_eq!(
            second.to_string(),
            r#"{"uuid":"u-r","continued":true,"children":[{"id":"c","uuid":"u-c","content":"c first line","ancestors":[{"uuid":"u-a","snippet":"a first line"}],"children":[{"id":"d","uuid":"u-d","content":"d first line","children":[]}]},{"id":"e","uuid":"u-e","content":"e first line","children":[]}]}"#
        );
    }

    #[test]
    fn a_warning_the_read_made_stays_on_every_page_and_keeps_has_more_as_it_was() {
        let spec = page_spec();
        let args = Map::new();
        let read = json!({"id": 1, "children": blocks(), "hasMore": true, "warnings": [{"code": "refs_depth_limit", "message": "m", "howToFetchAll": "Fetch each ref"}, {"code": "refs_unavailable", "message": "n"}]});
        let tree = Tree::new(Root::Page, read);
        // the last page, with no cursor: the read's warnings are there and hasMore is what the read made it
        let last = view(&spec, &tree, &args, 3, false).result(2, None);
        assert_eq!(last["hasMore"], json!(true));
        let codes: Vec<&str> = last["warnings"].as_array().unwrap().iter().map(|warning| warning["code"].as_str().unwrap()).collect();
        assert_eq!(codes, ["refs_depth_limit", "refs_unavailable"]);
        // a cut page adds its warning after them, and a stale one comes before the cut
        let mut cut = view(&spec, &tree, &args, 0, true);
        cut.stale = Some(Stale::Moved);
        let result = cut.result(2, Some(Cut::Size { oversize: false }));
        let codes: Vec<&str> = result["warnings"].as_array().unwrap().iter().map(|warning| warning["code"].as_str().unwrap()).collect();
        assert_eq!(codes, ["refs_depth_limit", "refs_unavailable", "cursor_stale", "result_size_truncated"]);
        // with no cursor and no offer of its own, hasMore is false
        let quiet = Tree::new(Root::Page, json!({"id": 1, "children": blocks(), "hasMore": false, "warnings": [{"code": "x", "message": "m"}]}));
        assert_eq!(view(&spec, &quiet, &args, 0, true).result(5, None)["hasMore"], json!(false));
    }

    #[test]
    fn the_advice_says_what_the_next_page_starts_with_in_the_format_it_is_written_in() {
        let advice = |root, markdown| Spec { tool: TOOL, root, markdown }.advice();
        assert!(advice(Root::Page, false).contains("childrenTruncated") && advice(Root::Page, false).contains("ancestors"));
        assert!(advice(Root::Page, true).contains("[under: ...]") && !advice(Root::Page, true).contains("childrenTruncated"));
        assert!(advice(Root::Block, false).contains("continued: true"));
        assert!(advice(Root::Page, false).contains("detail \"outline\"") && advice(Root::Block, true).contains("logseq_get_block"));
        for text in [advice(Root::Page, false), advice(Root::Page, true), advice(Root::Block, false), advice(Root::Block, true)] {
            assert!(!text.contains("No parameter raises"), "{text}");
        }
    }

    #[test]
    fn a_weight_is_the_json_length_scaled_to_memory() {
        let tree = Tree::new(Root::Page, page_result());
        let json_len = serde_json::to_string(&tree.base).unwrap().len();
        assert_eq!(tree.weight(), crate::snapshots::VALUE_RESIDENT_FACTOR * json_len);
    }
}
