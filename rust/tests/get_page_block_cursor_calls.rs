//! The cursor of `logseq_get_page` with `detail: "full"` and of `logseq_get_block` with `include_children` (ADR-0038,
//! #552) through their `call`, against a mock LogSeq on a local port: what a page read from a snapshot costs (no call),
//! what a page read after the snapshot is gone costs (the calls the first page made, and no more), how a tree that
//! moved between two pages is resumed, what a bad token or a cursor with another argument gets before any call, and that a
//! tree several times the budget is read to the end with every block once and in document order, in JSON and in
//! Markdown. Every page and block here is made up (BR-0001).

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MockLogseq, client, methods, mock_logseq, mock_logseq_answering, uuid};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::snapshots::{Limits, Snapshots};
use logseq_mcp_server::tools::{get_block, get_page};
use serde_json::{Value, json};

const PAGE: &str = "logseq.Editor.getPage";
const TREE: &str = "logseq.Editor.getPageBlocksTree";
const BLOCK: &str = "logseq.Editor.getBlock";
const QUERY: &str = "logseq.DB.datascriptQuery";
const NEXT_PAGE: &str = "Pass nextCursor as cursor, with no other argument, to read the next page.";

/// What LogSeq holds: the blocks of the page "Project Atlas", and the block "root" (with its tree), which a test changes
/// between two pages.
#[derive(Clone)]
struct World {
    page_tree: Vec<Value>,
    block: Value,
}

type Shared = Arc<Mutex<World>>;

fn node(id: i64, length: usize, children: Vec<Value>) -> Value {
    json!({"id": id, "uuid": uuid(id), "content": format!("block {id} {}", "x".repeat(length)), "page": {"id": 10}, "children": children})
}

fn editor_page() -> Value {
    json!({"id": 10, "uuid": uuid(10), "name": "project atlas", "originalName": "Project Atlas", "journal?": false, "file": {"id": 5010}})
}

fn world(page_tree: Vec<Value>, block: Value) -> Shared {
    Arc::new(Mutex::new(World { page_tree, block }))
}

/// The page's blocks only: 90 top-level blocks of `length` characters.
fn flat_page(count: i64, length: usize) -> Shared {
    world((1..=count).map(|id| node(id, length, vec![])).collect(), node(1, 10, vec![]))
}

/// The block 1 with `count` children of `length` characters, the first of which has 3 children of its own, the second a
/// child with a child.
fn block_with_children(count: i64, length: usize) -> Value {
    let children = (1..=count)
        .map(|n| match n {
            1 => node(100 + n, length, (1..=3).map(|m| node(1000 + m, length, vec![])).collect()),
            2 => node(100 + n, length, vec![node(2000, length, vec![node(2001, length, vec![])])]),
            _ => node(100 + n, length, vec![]),
        })
        .collect();
    node(1, 30, children)
}

async fn logseq_holding(world: &Shared) -> MockLogseq {
    let world = Arc::clone(world);
    mock_logseq_answering(move |request| match request["method"].as_str().unwrap() {
        PAGE => editor_page(),
        TREE => json!(world.lock().unwrap().page_tree),
        BLOCK => world.lock().unwrap().block.clone(),
        other => panic!("a call nobody expected: {other}"),
    })
    .await
}

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

fn snapshots() -> Snapshots {
    Snapshots::new(1_760_000_000_000)
}

/// What a call sent: every content block's text.
async fn texts(logseq: &MockLogseq, snapshots: &Snapshots, tool: &str, args: Value) -> Result<Vec<String>, ToolError> {
    let result = match tool {
        "page" => get_page::call(&client(logseq), true, snapshots, arguments(args)).await?,
        _ => get_block::call(&client(logseq), true, snapshots, arguments(args)).await?,
    };
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    Ok(content.as_array().unwrap().iter().map(|block| block["text"].as_str().unwrap().to_owned()).collect())
}

/// The first content block as JSON, with the budget checked: every page is at most the budget, but for one block that
/// is over it alone.
async fn call(logseq: &MockLogseq, snapshots: &Snapshots, tool: &str, args: Value) -> Result<Value, ToolError> {
    let sent = texts(logseq, snapshots, tool, args).await?;
    let body: Value = serde_json::from_str(&sent[0]).unwrap();
    let alone = blocks_of(&body).len() <= 1;
    let total: usize = sent.iter().map(|text| size(text)).sum();
    assert!(total <= BUDGET_CHARS || alone, "a page is over the budget: {total}");
    Ok(body)
}

async fn page(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<Value, ToolError> {
    call(logseq, snapshots, "page", args).await
}

async fn block(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<Value, ToolError> {
    call(logseq, snapshots, "block", args).await
}

/// Every block of a result in document order, nested ones included: the block itself first for a `get_block` result that is
/// not a continuation.
fn blocks_of(body: &Value) -> Vec<Value> {
    fn walk(blocks: &[Value], out: &mut Vec<Value>) {
        for block in blocks {
            out.push(block.clone());
            walk(block["children"].as_array().map_or(&[][..], Vec::as_slice), out);
        }
    }
    let mut out = Vec::new();
    if body.get("content").is_some() {
        walk(std::slice::from_ref(body), &mut out);
    } else {
        walk(body["children"].as_array().map_or(&[][..], Vec::as_slice), &mut out);
    }
    out
}

fn uuids_of(body: &Value) -> Vec<String> {
    blocks_of(body).iter().map(|block| block["uuid"].as_str().unwrap().to_owned()).collect()
}

/// The uuids of a tree in document order.
fn document_order(blocks: &[Value]) -> Vec<String> {
    blocks.iter().flat_map(|block| std::iter::once(block["uuid"].as_str().unwrap().to_owned()).chain(document_order(block["children"].as_array().map_or(&[][..], Vec::as_slice)))).collect()
}

fn cursor_of(body: &Value) -> String {
    body["nextCursor"].as_str().expect("a page that leaves blocks has a nextCursor").to_owned()
}

fn warning_codes(body: &Value) -> Vec<String> {
    body["warnings"].as_array().map_or_else(Vec::new, |warnings| warnings.iter().map(|warning| warning["code"].as_str().unwrap().to_owned()).collect())
}

/// For each block of a tree, its real ancestors' uuids, outermost first, below `root` (the page, or the block read).
fn chains(blocks: &[Value], above: &[String], out: &mut Vec<(String, Vec<String>, usize)>) {
    for block in blocks {
        let uuid = block["uuid"].as_str().unwrap().to_owned();
        let children = block["children"].as_array().map_or(&[][..], Vec::as_slice);
        out.push((uuid.clone(), above.to_vec(), children.len()));
        let mut below = above.to_vec();
        below.push(uuid);
        chains(children, &below, out);
    }
}

/// Checks what a page of a tree says of where it sits against the source it was cut from: each top-level block of a page
/// that starts inside a tree names the blocks it sits under (below the frame: `skip` is 1 when the frame is the block
/// read, which heads every chain), no other block names any, and a block carries `childrenTruncated` exactly when it has
/// fewer children than the source's.
fn check_page(body: &Value, source: &[Value], skip: usize) {
    let mut truth = Vec::new();
    chains(source, &[], &mut truth);
    // the first page of a block is the block itself, which holds the rest as it always did
    let pieces: &[Value] = if body.get("content").is_some() { &[] } else { body["children"].as_array().map_or(&[][..], Vec::as_slice) };
    for block in blocks_of(body) {
        let (_, chain, children) = truth.iter().find(|(id, _, _)| *id == block["uuid"].as_str().unwrap()).cloned().unwrap();
        let kept = block["children"].as_array().map_or(0, Vec::len);
        assert_eq!(block.get("childrenTruncated") == Some(&json!(true)), kept < children, "childrenTruncated on {} (kept {kept} of {children})", block["uuid"]);
        let named: Vec<String> = block.get("ancestors").and_then(Value::as_array).map_or_else(Vec::new, |list| list.iter().map(|ancestor| ancestor["uuid"].as_str().unwrap().to_owned()).collect());
        if pieces.iter().any(|piece| piece["uuid"] == block["uuid"]) {
            assert_eq!(named, chain[skip.min(chain.len())..], "ancestors of {}", block["uuid"]);
            assert!(block.get("ancestors").is_none() || !named.is_empty(), "an empty ancestors is left out");
        } else {
            assert!(block.get("ancestors").is_none(), "{} is not the top of a piece and names no ancestors", block["uuid"]);
        }
    }
}

// ---- a page: a hit costs nothing, a miss costs the first page's calls

#[tokio::test]
async fn the_pages_after_the_first_are_read_from_the_snapshot_and_make_no_call() {
    let held = flat_page(90, 1000);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();

    let first = page(&logseq, &snapshots, json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    assert_eq!(methods(&logseq), [PAGE, TREE], "the first page makes the calls it always made");
    assert_eq!((first["hasMore"].clone(), first["warnings"][0]["code"].clone()), (json!(true), json!("result_size_truncated")));
    assert_eq!(first["warnings"][0]["howToFetchAll"], NEXT_PAGE);
    assert_eq!(first["originalName"], "Project Atlas");
    let on_first = uuids_of(&first).len();
    assert!((20..40).contains(&on_first), "{on_first}");
    let message = first["warnings"][0]["message"].as_str().unwrap();
    assert!(message.starts_with(&format!("Showing 1-{on_first} of 90 blocks of the page (nested ones counted, in page order)")), "{message}");

    // the graph changes under the pages: a hit still shows the tree as the first page read it
    held.lock().unwrap().page_tree.clear();
    let second = page(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq), [PAGE, TREE], "the second page made no LogSeq call");
    let on_second = uuids_of(&second).len();
    assert_eq!(uuids_of(&second)[0], uuid(1 + on_first as i64), "it starts at the block after the last one sent");
    assert!(second["warnings"][0]["message"].as_str().unwrap().starts_with(&format!("Showing {}-{} of 90 blocks", on_first + 1, on_first + on_second)));
    assert_eq!(second["originalName"], "Project Atlas", "the frame is repeated");
    assert!(second.get("resolvedFrom").is_none());
}

#[tokio::test]
async fn a_page_whose_snapshot_is_gone_costs_the_calls_the_first_page_made_and_reads_the_same_blocks() {
    let held = flat_page(90, 1000);
    let logseq = logseq_holding(&held).await;
    let first = page(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);

    // a restarted server: no snapshot, and its own start time, so the key the cursor holds is nobody's
    let second = page(&logseq, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq), [PAGE, TREE, PAGE, TREE], "page 1's calls again, and no more");
    assert!(!warning_codes(&second).contains(&"cursor_stale".to_owned()), "the tree did not move: {second}");
    let hit_logseq = logseq_holding(&held).await;
    let hit_snapshots = snapshots();
    let hit_first = page(&hit_logseq, &hit_snapshots, json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    let hit_second = page(&hit_logseq, &hit_snapshots, json!({"cursor": cursor_of(&hit_first)})).await.unwrap();
    assert_eq!(uuids_of(&second), uuids_of(&hit_second), "a miss and a hit page hold the same blocks");
}

#[tokio::test]
async fn a_snapshot_older_than_its_age_is_a_miss_that_reads_logseq_again() {
    let held = flat_page(90, 1000);
    let logseq = logseq_holding(&held).await;
    // every snapshot is already too old when it is asked for
    let aged = Snapshots::with_limits(1_760_000_000_000, Limits { max_age: Duration::ZERO, ..Limits::STARTING });
    let first = page(&logseq, &aged, json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    page(&logseq, &aged, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "the second page read LogSeq again, with the first page's two calls");
}

#[tokio::test]
async fn a_tree_over_the_snapshot_limit_is_built_again_for_each_page_and_still_read_to_the_end() {
    let held = flat_page(90, 1000);
    let logseq = logseq_holding(&held).await;
    let small = Snapshots::with_limits(1_760_000_000_000, Limits { snapshot_bytes: 10, ..Limits::STARTING });
    let mut body = page(&logseq, &small, json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    let mut all = uuids_of(&body);
    let mut pages = 1;
    while body.get("nextCursor").is_some() {
        body = page(&logseq, &small, json!({"cursor": cursor_of(&body)})).await.unwrap();
        all.extend(uuids_of(&body));
        pages += 1;
    }
    assert_eq!(all, document_order(&held.lock().unwrap().page_tree));
    assert_eq!(methods(&logseq).len(), 2 * pages, "each page made the two calls: nothing was kept");
}

// ---- the whole tree, page after page

/// Reads a page to the end and checks each page against the source: what it names as ancestors, where it marks lost children.
async fn read_page_to_the_end(logseq: &MockLogseq, snapshots: &Snapshots, args: Value, source: &[Value]) -> (Vec<String>, usize) {
    let mut body = page(logseq, snapshots, args).await.unwrap();
    let (mut all, mut pages) = (uuids_of(&body), 1);
    check_page(&body, source, 0);
    while body.get("nextCursor").is_some() {
        assert!(pages < 100, "a cursor that never ends");
        assert_eq!(body["hasMore"], true);
        body = page(logseq, snapshots, json!({"cursor": cursor_of(&body)})).await.unwrap();
        assert!(!uuids_of(&body).is_empty(), "a page with a cursor to read on after it holds a block");
        check_page(&body, source, 0);
        all.extend(uuids_of(&body));
        pages += 1;
    }
    assert!(body.get("hasMore").is_none() || body["hasMore"] == false);
    (all, pages)
}

#[tokio::test]
async fn a_page_several_times_the_budget_is_read_to_the_end_with_every_block_once_in_document_order() {
    let held = flat_page(90, 1000);
    let source = held.lock().unwrap().page_tree.clone();
    let logseq = logseq_holding(&held).await;
    let (all, pages) = read_page_to_the_end(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"}), &source).await;
    assert_eq!(all, document_order(&source));
    assert!(pages >= 3, "{pages}");
    assert_eq!(methods(&logseq), [PAGE, TREE], "the pages after the first made no call");
}

#[tokio::test]
async fn a_page_with_a_block_of_sixty_children_is_read_to_the_end_with_the_children_naming_the_block_they_sit_under() {
    // one top-level block with 60 children of ~1,000 characters, three of them with children of their own, then three more blocks
    let big = block_with_children(60, 1000);
    let mut tree = vec![big];
    tree.extend((3..=5).map(|id| node(id, 1000, vec![])));
    let held = world(tree.clone(), node(1, 10, vec![]));
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();

    let first = page(&logseq, &snapshots, json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    assert_eq!(first["children"].as_array().unwrap().len(), 1, "page 1 holds the block and its first children");
    assert_eq!(first["children"][0]["childrenTruncated"], true);
    let second = page(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    let top = second["children"].as_array().unwrap();
    assert!(top.len() > 5, "the children that did not fit are at the top of the next page: {}", top.len());
    assert!(top.iter().take(5).all(|child| child["ancestors"].as_array().is_some_and(|names| names.len() == 1 && names[0]["uuid"] == uuid(1))), "each names the block it sits under");
    assert!(top[0]["ancestors"][0]["snippet"].as_str().unwrap().starts_with("block 1 "));

    let (all, pages) = read_page_to_the_end(&logseq, &Snapshots::new(1_760_000_000_000), json!({"page": "Project Atlas", "detail": "full"}), &tree).await;
    assert_eq!(all, document_order(&tree));
    assert!(pages >= 3, "{pages}");
}

#[tokio::test]
async fn a_page_that_starts_inside_a_grandchild_names_both_the_block_and_the_child() {
    // one block whose first child has 3 grandchildren of 12,000 characters: a page ends between them
    let tree = vec![node(1, 10, vec![node(2, 10, (1..=4).map(|n| node(10 + n, 12_000, vec![])).collect())])];
    let held = world(tree.clone(), node(1, 10, vec![]));
    let logseq = logseq_holding(&held).await;
    let first = page(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    let second = page(&logseq, &snapshots(), json!({"cursor": cursor_of(&first)})).await.unwrap();
    // read from a miss here: the snapshot lives in another Snapshots, and the page is the same
    let names: Vec<&str> = second["children"][0]["ancestors"].as_array().unwrap().iter().map(|ancestor| ancestor["uuid"].as_str().unwrap()).collect();
    assert_eq!(names, [uuid(1), uuid(2)]);
    check_page(&second, &tree, 0);
}

#[tokio::test]
async fn a_page_in_markdown_is_read_to_the_end_with_every_bullet_once_and_says_what_a_slice_sits_under() {
    let big = block_with_children(60, 1000);
    let tree = vec![big];
    let held = world(tree.clone(), node(1, 10, vec![]));
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let args = json!({"page": "Project Atlas", "detail": "full", "format": "markdown"});
    let mut text = texts(&logseq, &snapshots, "page", args).await.unwrap().remove(0);
    let (mut bullets, mut pages) = (bullets_of(&text), 1);
    assert!(text.contains("result_size_truncated: Showing 1-"), "{}", &text[text.len().saturating_sub(900)..]);
    let mut unders = 0;
    loop {
        assert!(size(&text) <= BUDGET_CHARS, "{}", size(&text));
        unders += text.lines().filter(|line| line.starts_with("[under: block 1 ")).count();
        let Some(token) = text.lines().find_map(|line| line.strip_prefix("nextCursor: ")).map(str::to_owned) else { break };
        text = texts(&logseq, &snapshots, "page", json!({"cursor": token})).await.unwrap().remove(0);
        assert!(text.starts_with("# Project Atlas\n"), "the frame is repeated: {}", &text[..40]);
        bullets.extend(bullets_of(&text));
        pages += 1;
    }
    assert!(pages >= 3, "{pages}");
    let expected: Vec<String> = document_order(&tree).iter().map(|id| format!("block {}", id.rsplit('-').next().unwrap().trim_start_matches('0'))).collect();
    assert_eq!(bullets, expected, "every block once, in document order");
    // each later page that starts under the block says so once for its run of siblings
    assert_eq!(unders, pages - 1);
    assert_eq!(methods(&logseq), [PAGE, TREE]);
}

/// The text of each bullet that starts a block in a Markdown page: "block 17".
fn bullets_of(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.trim_start_matches('\t').strip_prefix("- block "))
        .map(|rest| format!("block {}", rest.split(' ').next().unwrap()))
        .collect()
}

#[tokio::test]
async fn a_block_over_the_budget_is_returned_alone_and_the_cursor_moves_past_it() {
    let tree = vec![node(1, 40_000, vec![]), node(2, 10, vec![]), node(3, 10, vec![])];
    let held = world(tree, node(1, 10, vec![]));
    let logseq = logseq_holding(&held).await;
    let shared = snapshots();
    let first = page(&logseq, &shared, json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    assert_eq!(uuids_of(&first), [uuid(1)]);
    assert!(first["warnings"][0]["message"].as_str().unwrap().contains("Even those are over that size"));
    let second = page(&logseq, &shared, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(uuids_of(&second), [uuid(2), uuid(3)]);
    assert!(second.get("nextCursor").is_none() && second.get("hasMore").is_none() && second.get("warnings").is_none());
}

#[tokio::test]
async fn a_page_exactly_at_the_budget_has_no_cursor_and_one_character_more_has_one() {
    let base = flat_page(4, 100);
    let logseq = logseq_holding(&base).await;
    let measured = texts(&logseq, &snapshots(), "page", json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    // the tips block counts too: pad the last block so the page and its tips are exactly the budget
    let total: usize = measured.iter().map(|text| size(text)).sum();
    for (extra, cursor) in [(BUDGET_CHARS - total, false), (BUDGET_CHARS - total + 1, true)] {
        let held = flat_page(4, 100);
        held.lock().unwrap().page_tree[3]["content"] = json!(format!("block 4 {}", "x".repeat(100 + extra)));
        let logseq = logseq_holding(&held).await;
        let body = page(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
        assert_eq!(body.get("nextCursor").is_some(), cursor, "{extra} more characters");
        assert_eq!(uuids_of(&body).len(), if cursor { 3 } else { 4 });
    }
}

#[tokio::test]
async fn a_page_with_no_blocks_or_a_null_tree_has_no_cursor_and_says_what_it_always_said() {
    let empty = world(vec![], node(1, 10, vec![]));
    let logseq = logseq_holding(&empty).await;
    let body = page(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    assert_eq!(body, editor_page());

    let logseq = mock_logseq_answering(|request| if request["method"] == PAGE { editor_page() } else { json!(null) }).await;
    let body = page(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    assert_eq!(warning_codes(&body), ["page_blocks_unavailable"]);
    assert!(body.get("nextCursor").is_none() && body["hasMore"] == false && body.get("children").is_none());
}

// ---- a tree that moved between the pages

#[tokio::test]
async fn a_tree_that_gained_an_earlier_block_resumes_after_the_last_block_sent_with_no_repeat_and_says_so() {
    let held = flat_page(90, 1000);
    let logseq = logseq_holding(&held).await;
    let first = page(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    let sent = uuids_of(&first);
    let last = sent.last().unwrap().clone();

    // a new block at the top: every position moved by one
    held.lock().unwrap().page_tree.insert(0, node(500, 10, vec![]));
    let second = page(&logseq, &Snapshots::new(1), json!({"cursor": cursor_of(&first)})).await.unwrap();
    let next = uuids_of(&second);
    assert_eq!(next[0], uuid(1 + sent.len() as i64), "the page resumes by block, not by position: {last} is not sent again");
    assert!(!next.contains(&last));
    assert_eq!(warning_codes(&second)[0], "cursor_stale");
    assert!(second["warnings"][0]["message"].as_str().unwrap().contains("resumes right after it, so none is repeated"));
}

#[tokio::test]
async fn a_tree_that_lost_the_last_block_sent_resumes_at_the_position_and_says_so() {
    let held = flat_page(90, 1000);
    let logseq = logseq_holding(&held).await;
    let first = page(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    let sent = uuids_of(&first);
    let last = sent.last().unwrap().clone();
    held.lock().unwrap().page_tree.retain(|block| block["uuid"] != json!(last));
    let second = page(&logseq, &Snapshots::new(1), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(warning_codes(&second)[0], "cursor_stale");
    assert!(second["warnings"][0]["message"].as_str().unwrap().contains("is gone"));
    assert!(!uuids_of(&second).is_empty());
}

#[tokio::test]
async fn a_tree_that_shrank_below_the_position_is_an_empty_page_and_not_an_error() {
    let held = flat_page(90, 1000);
    let logseq = logseq_holding(&held).await;
    let first = page(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    held.lock().unwrap().page_tree.truncate(2);
    let second = page(&logseq, &Snapshots::new(1), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(second["children"], json!([]));
    assert_eq!(warning_codes(&second), ["cursor_stale"]);
    assert!(second.get("nextCursor").is_none());
}

// ---- resolve_refs: the tree is resolved before the cut, and a later page costs nothing

#[tokio::test]
async fn resolve_refs_costs_page_1s_calls_on_page_1_and_none_on_a_hit() {
    let target = json!([{"id": 900, "uuid": uuid(900), "content": "Bob owns the importer", "left": {"id": 100}, "parent": {"id": 100}, "page": {"id": 100, "name": "project atlas", "original-name": "Project Atlas"}}]);
    let held = flat_page(90, 1000);
    // the first block holds a ref: one more query
    held.lock().unwrap().page_tree[0]["content"] = json!(format!("see (({}))", uuid(900)));
    let seen = target.clone();
    let world = Arc::clone(&held);
    let logseq = mock_logseq_answering(move |request| match request["method"].as_str().unwrap() {
        PAGE => editor_page(),
        TREE => json!(world.lock().unwrap().page_tree),
        QUERY => json!([seen]),
        other => panic!("{other}"),
    })
    .await;
    let snapshots = snapshots();
    let args = json!({"page": "Project Atlas", "detail": "full", "resolve_refs": true});
    let first = page(&logseq, &snapshots, args).await.unwrap();
    assert_eq!(methods(&logseq), [PAGE, TREE, QUERY], "page 1 costs what it cost");
    assert_eq!(first["children"][0]["resolvedContent"], "see Bob owns the importer");
    let second = page(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3, "a later page costs none");
    // a miss costs page 1's three calls again, and the page reads the same
    let third = page(&logseq, &Snapshots::new(7), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 6);
    assert_eq!(uuids_of(&second), uuids_of(&third));
    // `hasMore` and `warnings` are there on a page of a read that resolved refs, as they were
    assert!(second.get("hasMore").is_some() && second.get("warnings").is_some());
}

// ---- a block with children

#[tokio::test]
async fn a_block_of_sixty_children_is_read_to_the_end_with_a_frame_that_does_not_repeat_its_body() {
    let source = block_with_children(60, 1000);
    let held = world(vec![], source.clone());
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let args = json!({"uuid": uuid(1), "include_children": true});

    let first = block(&logseq, &snapshots, args.clone()).await.unwrap();
    assert_eq!(methods(&logseq), [BLOCK], "the first page makes the call it always made");
    assert_eq!(first["uuid"], uuid(1));
    assert_eq!(first["childrenTruncated"], true);
    assert_eq!((first["hasMore"].clone(), first["warnings"][0]["howToFetchAll"].clone()), (json!(true), json!(NEXT_PAGE)));
    let kept = first["children"].as_array().unwrap().len();
    assert!((15..40).contains(&kept), "{kept}");
    check_page(&first, std::slice::from_ref(&source), 1);

    // the second page is the frame and the children after the ones sent, directly under it
    let second = block(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1, "a hit makes no call");
    assert_eq!(second["uuid"], uuid(1));
    assert_eq!(second["continued"], true);
    assert!(second.get("content").is_none(), "the body of the block is not repeated");
    assert_eq!(second["children"][0]["uuid"], source["children"][kept]["uuid"]);
    assert!(second["children"][0].get("ancestors").is_none(), "its parent is the block read");
    assert_eq!(second.as_object().unwrap().keys().take(3).collect::<Vec<_>>(), ["uuid", "continued", "children"]);

    let (mut body, mut pages) = (first.clone(), 1);
    let mut seen = uuids_of(&first);
    while body.get("nextCursor").is_some() {
        body = block(&logseq, &snapshots, json!({"cursor": cursor_of(&body)})).await.unwrap();
        check_page(&body, std::slice::from_ref(&source), 1);
        seen.extend(uuids_of(&body));
        pages += 1;
        assert!(pages < 50);
    }
    assert_eq!(seen, document_order(std::slice::from_ref(&source)), "every block once, in document order");
    assert!(pages >= 3, "{pages}");
    assert_eq!(methods(&logseq).len(), 1, "no page after the first made a call");
}

#[tokio::test]
async fn a_block_page_that_starts_below_a_child_names_it_and_a_miss_reads_the_same_page() {
    // the block's one child holds 4 grandchildren of 12,000 characters: a page starts between them
    let source = node(1, 10, vec![node(2, 10, (1..=4).map(|n| node(10 + n, 12_000, vec![])).collect())]);
    let held = world(vec![], source.clone());
    let logseq = logseq_holding(&held).await;
    let first = block(&logseq, &snapshots(), json!({"uuid": uuid(1), "include_children": true})).await.unwrap();
    let second = block(&logseq, &Snapshots::new(9), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq), [BLOCK, BLOCK], "a miss makes the first page's one call");
    let top = &second["children"][0];
    assert_eq!(top["ancestors"].as_array().unwrap().len(), 1);
    assert_eq!(top["ancestors"][0]["uuid"], uuid(2), "the block read is the frame, so only the child is named");
    check_page(&second, std::slice::from_ref(&source), 1);
}

#[tokio::test]
async fn a_block_in_markdown_continues_under_its_heading_and_is_read_to_the_end() {
    let source = block_with_children(60, 1000);
    let held = world(vec![], source.clone());
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let mut text = texts(&logseq, &snapshots, "block", json!({"uuid": uuid(1), "include_children": true, "format": "markdown"})).await.unwrap().remove(0);
    assert!(text.starts_with(&format!("# Block (({}))\n", uuid(1))), "{}", &text[..60]);
    let (mut bullets, mut pages) = (bullets_of(&text), 1);
    while let Some(token) = text.lines().find_map(|line| line.strip_prefix("nextCursor: ")).map(str::to_owned) {
        text = texts(&logseq, &snapshots, "block", json!({"cursor": token})).await.unwrap().remove(0);
        assert!(text.starts_with(&format!("# Block (({})) (continued)\n", uuid(1))), "{}", &text[..70]);
        assert!(size(&text) <= BUDGET_CHARS);
        bullets.extend(bullets_of(&text));
        pages += 1;
    }
    let expected: Vec<String> = document_order(std::slice::from_ref(&source)).iter().map(|id| format!("block {}", id.rsplit('-').next().unwrap().trim_start_matches('0'))).collect();
    assert_eq!(bullets, expected);
    assert!(pages >= 3, "{pages}");
}

#[tokio::test]
async fn a_block_whose_child_is_over_the_budget_reads_the_block_alone_then_the_child_alone_then_the_rest() {
    let source = node(1, 10, vec![node(2, 40_000, vec![]), node(3, 10, vec![])]);
    let held = world(vec![], source);
    let logseq = logseq_holding(&held).await;
    let shared = snapshots();
    // the block itself is entry 0, and the child that is over the budget is entry 1: the block is the page, alone
    let first = block(&logseq, &shared, json!({"uuid": uuid(1), "include_children": true})).await.unwrap();
    assert_eq!(uuids_of(&first), [uuid(1)]);
    assert_eq!(first["childrenTruncated"], true);
    let second = block(&logseq, &shared, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(uuids_of(&second), [uuid(2)]);
    let third = block(&logseq, &shared, json!({"cursor": cursor_of(&second)})).await.unwrap();
    assert_eq!(uuids_of(&third), [uuid(3)]);
    assert!(third.get("nextCursor").is_none());
}

#[tokio::test]
async fn a_block_under_the_budget_and_one_without_its_children_are_as_they_were() {
    let held = world(vec![], block_with_children(5, 100));
    let logseq = logseq_holding(&held).await;
    let body = block(&logseq, &snapshots(), json!({"uuid": uuid(1), "include_children": true})).await.unwrap();
    assert_eq!(body, held.lock().unwrap().block);
    // without include_children: the one entity, whatever its size, and never a cursor
    let mut huge = node(1, 10, vec![]);
    huge["content"] = json!("x".repeat(40_000));
    huge["children"] = json!([["uuid", uuid(501)], ["uuid", uuid(502)]]);
    let held = world(vec![], huge.clone());
    let logseq = logseq_holding(&held).await;
    let sent = texts(&logseq, &snapshots(), "block", json!({"uuid": uuid(1)})).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&sent[0]).unwrap(), huge);
}

#[tokio::test]
async fn a_block_read_with_resolve_refs_costs_page_1s_calls_and_a_hit_none() {
    let mut source = block_with_children(60, 1000);
    source["content"] = json!(format!("see (({}))", uuid(900)));
    let target = json!([{"id": 900, "uuid": uuid(900), "content": "Bob owns the importer", "left": {"id": 100}, "parent": {"id": 100}, "page": {"id": 100, "name": "project atlas", "original-name": "Project Atlas"}}]);
    let block_answer = source.clone();
    let logseq = mock_logseq_answering(move |request| match request["method"].as_str().unwrap() {
        BLOCK => block_answer.clone(),
        QUERY => json!([target]),
        other => panic!("{other}"),
    })
    .await;
    let snapshots = snapshots();
    let first = block(&logseq, &snapshots, json!({"uuid": uuid(1), "include_children": true, "resolve_refs": true})).await.unwrap();
    assert_eq!(methods(&logseq), [BLOCK, QUERY]);
    assert_eq!(first["resolvedContent"], "see Bob owns the importer");
    let second = block(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2, "a later page costs none");
    assert_eq!(second["continued"], true);
    assert!(second.get("resolvedContent").is_none(), "the body of the block is not repeated, resolved or not");
}

// ---- what a token may be, and a call with a cursor takes no other argument

fn token(tool: &str, args: Value, change: &dyn Fn(&mut Cursor)) -> String {
    let mut cursor = Cursor::new(tool, args.as_object().cloned().unwrap(), Position::Index { at: 1 }, Anchor::Text(uuid(1)), SnapshotKey { started: 1, n: 1 });
    change(&mut cursor);
    encode(&cursor)
}

fn page_token(change: &dyn Fn(&mut Cursor)) -> String {
    token(get_page::NAME, json!({"page": "Project Atlas", "detail": "full"}), change)
}

fn block_token(change: &dyn Fn(&mut Cursor)) -> String {
    token(get_block::NAME, json!({"uuid": uuid(1), "include_children": true}), change)
}

#[tokio::test]
async fn a_token_that_is_not_one_of_this_tools_is_refused_before_any_call() {
    let held = flat_page(5, 10);
    let logseq = logseq_holding(&held).await;
    let tokens = [
        ("not base64", "this is not a cursor".to_owned()),
        ("an empty one", String::new()),
        ("another tool's", page_token(&|cursor| cursor.tool = "logseq_find_pages".to_owned())),
        ("a block's", block_token(&|_| {})),
        ("an unknown version", page_token(&|cursor| cursor.v = 2)),
        ("sections position", page_token(&|cursor| cursor.position = Position::Sections { blocks: 1, references: 0, related: 0 })),
        ("a page that is no full read", token(get_page::NAME, json!({"page": "Project Atlas"}), &|_| {})),
        ("an outline", token(get_page::NAME, json!({"page": "Project Atlas", "detail": "outline"}), &|_| {})),
        ("no page", token(get_page::NAME, json!({"detail": "full"}), &|_| {})),
        ("a format the page does not take", token(get_page::NAME, json!({"page": "a", "detail": "full", "format": "toon"}), &|_| {})),
        ("arguments that hold a cursor", token(get_page::NAME, json!({"page": "a", "detail": "full", "cursor": "abc"}), &|_| {})),
        ("arguments no page takes", token(get_page::NAME, json!({"page": 5, "detail": "full"}), &|_| {})),
    ];
    for (what, bad) in tokens {
        let error = page(&logseq, &snapshots(), json!({"cursor": bad})).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == "cursor"), "{what}: {error}");
        assert!(error.to_string().starts_with("Invalid parameter 'cursor': "), "{what}: {error}");
    }
    let blocks = [
        ("a page's", page_token(&|_| {})),
        ("no children", token(get_block::NAME, json!({"uuid": uuid(1)}), &|_| {})),
        ("no uuid", token(get_block::NAME, json!({"include_children": true}), &|_| {})),
        ("sections position", block_token(&|cursor| cursor.position = Position::Sections { blocks: 0, references: 0, related: 0 })),
    ];
    for (what, bad) in blocks {
        let error = block(&logseq, &snapshots(), json!({"cursor": bad})).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == "cursor"), "{what}: {error}");
    }
    assert!(methods(&logseq).is_empty(), "a bad token costs no LogSeq call");
    // a token of this tool, well formed, reads a page
    assert!(page(&logseq, &snapshots(), json!({"cursor": page_token(&|_| {})})).await.is_ok());
}

#[tokio::test]
async fn a_cursor_with_any_other_argument_is_refused_before_any_call_and_names_it() {
    let held = flat_page(90, 1000);
    let logseq = logseq_holding(&held).await;
    let first = page(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    let cursor = cursor_of(&first);
    let calls = methods(&logseq).len();
    for (param, value) in [("page", json!("Project Atlas")), ("detail", json!("full")), ("resolve_refs", json!(false)), ("format", json!("json"))] {
        let mut args = json!({"cursor": cursor});
        args[param] = value;
        let error = page(&logseq, &snapshots(), args).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == param), "{param}: {error}");
        assert!(error.to_string().contains("left out when cursor is given"), "{param}: {error}");
    }
    assert_eq!(methods(&logseq).len(), calls, "a refusal costs no call");
    // a null is no argument, and an unknown field (the v1 include_children) is ignored, as everywhere
    assert!(page(&logseq, &snapshots(), json!({"cursor": cursor, "page": null, "include_children": true})).await.is_ok());

    let held = world(vec![], block_with_children(60, 1000));
    let logseq = logseq_holding(&held).await;
    let first = block(&logseq, &snapshots(), json!({"uuid": uuid(1), "include_children": true})).await.unwrap();
    for (param, value) in [("uuid", json!(uuid(1))), ("include_children", json!(true)), ("resolve_refs", json!(false)), ("format", json!("json"))] {
        let mut args = json!({"cursor": cursor_of(&first)});
        args[param] = value;
        let error = block(&logseq, &snapshots(), args).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == param), "{param}: {error}");
    }
    assert_eq!(methods(&logseq).len(), 1);
}

#[tokio::test]
async fn an_alias_of_the_name_beside_a_cursor_is_refused_as_the_name_would_be_and_an_alias_alone_works() {
    // BR-0008: the aliases are folded first, so `{ cursor, name }` is `{ cursor, page }`
    let held = flat_page(90, 1000);
    let logseq = logseq_holding(&held).await;
    let first = page(&logseq, &snapshots(), json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    for alias in ["name", "page_name"] {
        let error = page(&logseq, &snapshots(), json!({"cursor": cursor_of(&first), alias: "Project Atlas"})).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == "page"), "{alias}: {error}");
    }
    let held = world(vec![], block_with_children(60, 1000));
    let logseq = logseq_holding(&held).await;
    let first = block(&logseq, &snapshots(), json!({"uuid": uuid(1), "include_children": true})).await.unwrap();
    let error = block(&logseq, &snapshots(), json!({"cursor": cursor_of(&first), "block_uuid": uuid(1)})).await.unwrap_err();
    assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == "uuid"), "{error}");
    assert_eq!(methods(&logseq).len(), 1, "no call for a refusal");

    // an alias alone is a name: it passes a validating client now that `page` and `uuid` are optional
    let held = flat_page(3, 10);
    let logseq = logseq_holding(&held).await;
    for alias in ["name", "page_name"] {
        let body = page(&logseq, &snapshots(), json!({alias: "Project Atlas", "detail": "full"})).await.unwrap();
        assert_eq!(body["originalName"], "Project Atlas", "{alias}");
    }
    let held = world(vec![], block_with_children(2, 10));
    let logseq = logseq_holding(&held).await;
    let body = block(&logseq, &snapshots(), json!({"block_uuid": uuid(1), "include_children": true})).await.unwrap();
    assert_eq!(body["uuid"], uuid(1));
}

#[tokio::test]
async fn a_call_with_neither_the_name_nor_a_cursor_is_refused_before_any_call() {
    let held = flat_page(3, 10);
    let logseq = logseq_holding(&held).await;
    for args in [json!({}), json!({"detail": "full"}), json!({"page": null, "resolve_refs": true})] {
        let error = page(&logseq, &snapshots(), args.clone()).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == "page" && invalid.value == "missing"), "{args}: {error}");
    }
    for args in [json!({}), json!({"include_children": true})] {
        let error = block(&logseq, &snapshots(), args.clone()).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == "uuid" && invalid.value == "missing"), "{args}: {error}");
    }
    assert!(methods(&logseq).is_empty());
}

#[tokio::test]
async fn a_snapshot_is_never_served_to_a_token_that_holds_other_arguments_or_another_process() {
    let held = flat_page(90, 1000);
    let logseq = logseq_holding(&held).await;
    let shared = snapshots();
    let first = page(&logseq, &shared, json!({"page": "Project Atlas", "detail": "full"})).await.unwrap();
    // the same snapshot key, with the arguments changed in the token: a miss, never the other tree
    let mut cursor = decode(&cursor_of(&first), get_page::NAME).unwrap();
    cursor.args.insert("resolve_refs".into(), json!(true));
    let _ = page(&logseq, &shared, json!({"cursor": encode(&cursor)})).await.unwrap();
    assert!(methods(&logseq).len() >= 4, "the other read went to LogSeq: {:?}", methods(&logseq));
    // the key of another process
    let calls = methods(&logseq).len();
    let mut cursor = decode(&cursor_of(&first), get_page::NAME).unwrap();
    cursor.snapshot = SnapshotKey { started: 5, n: 1 };
    let second = page(&logseq, &shared, json!({"cursor": encode(&cursor)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), calls + 2);
    assert!(!uuids_of(&second).is_empty());
}

#[tokio::test]
async fn a_token_that_holds_a_position_past_the_end_is_an_empty_last_page_and_never_a_panic() {
    let held = flat_page(5, 10);
    let logseq = logseq_holding(&held).await;
    let cursor = page_token(&|cursor| cursor.position = Position::Index { at: usize::MAX });
    let body = page(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    assert_eq!(warning_codes(&body), ["cursor_stale"]);
    assert!(body.get("nextCursor").is_none());
}

// ---- errors

#[tokio::test]
async fn a_logseq_error_on_a_miss_is_an_error_and_not_an_empty_page() {
    // nothing answers: the call fails, as the first page would
    let logseq = mock_logseq(vec![]).await;
    let error = page(&logseq, &snapshots(), json!({"cursor": page_token(&|_| {})})).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
    let logseq = mock_logseq(vec![]).await;
    let error = block(&logseq, &snapshots(), json!({"cursor": block_token(&|_| {})})).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn a_block_that_is_gone_on_a_miss_is_the_not_found_error_of_the_first_page() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let error = block(&logseq, &snapshots(), json!({"cursor": block_token(&|_| {})})).await.unwrap_err();
    assert!(error.to_string().starts_with("Block not found"), "{error}");
}
