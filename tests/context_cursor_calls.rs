//! The cursor of `logseq_explore_context` (ADR-0038, #555) through its `call`, against a mock LogSeq on a local port: what
//! a page read from a snapshot costs (no call, `resolve_refs` aside), what a page read after the snapshot is gone costs
//! (the three calls the first page made, and no more), how a list that moved between two pages is resumed, what a bad
//! token or a cursor with another argument gets before any call, and that a page with more blocks, references and
//! related pages than one page holds is read to the end with each list exactly once. Every page and block here is made
//! up (BR-0001).

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MockLogseq, client, methods, mock_logseq, mock_logseq_answering, uuid};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::cursor::{Anchor, Cursor, Position, SectionAnchors, decode, encode};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::snapshots::{Limits, Snapshots};
use logseq_mcp_server::tools::explore_context;
use serde_json::{Value, json};

const DATALOG: &str = "logseq.DB.datascriptQuery";
const LINKED_REFERENCES: &str = "logseq.Editor.getPageLinkedReferences";
const NEXT_PAGE: &str = "Pass nextCursor as cursor, with no other argument, to read the next page.";

/// What LogSeq holds about "Project Atlas": its blocks (ids from 1000) and the blocks that link it, on source pages
/// (ids from 2000), each with its own block ids (from 3000). A test changes it between two pages.
#[derive(Clone)]
struct Graph {
    blocks: usize,
    /// The id of the first block, and the ids that are not there
    first_block: i64,
    removed_blocks: Vec<i64>,
    block_length: usize,
    /// How many source pages link the page, and how many blocks each has
    sources: usize,
    per_source: usize,
    reference_length: usize,
    /// A source page of 3 blocks, named to rank first and listed by LogSeq last
    extra_source: bool,
    /// Source pages (by number) that are not there
    removed_sources: Vec<i64>,
}

type Held = Arc<Mutex<Graph>>;

fn held(blocks: usize, sources: usize, per_source: usize) -> Held {
    Arc::new(Mutex::new(Graph { blocks, first_block: 1000, removed_blocks: Vec::new(), block_length: 250, sources, per_source, reference_length: 120, extra_source: false, removed_sources: Vec::new() }))
}

fn atlas() -> Value {
    json!([[{"id": 10, "uuid": uuid(10), "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 5010}}, "name"]])
}

fn block_rows(graph: &Graph) -> Value {
    let text = "b".repeat(graph.block_length);
    json!((graph.first_block..graph.first_block + graph.blocks as i64)
        .filter(|id| !graph.removed_blocks.contains(id))
        .map(|id| json!([{"id": id, "uuid": uuid(id), "content": format!("Block {id} {text}"), "page": {"id": 10}, "parent": {"id": 10}, "left": {"id": 10}}]))
        .collect::<Vec<_>>())
}

fn linked_references(graph: &Graph) -> Value {
    let text = "r".repeat(graph.reference_length);
    // (page id, name, id of its first block): the numbered sources, then the extra one
    let extra = graph.extra_source.then(|| (1999, "aaa extra".to_owned(), 4000));
    json!((0..graph.sources as i64)
        .filter(|source| !graph.removed_sources.contains(source))
        .map(|source| (2000 + source, format!("source {source:03}"), 3000 + source * 100))
        .chain(extra)
        .map(|(page_id, name, first_block)| {
            let page = json!({"id": page_id, "name": name, "originalName": name});
            let blocks: Vec<Value> = (0..graph.per_source as i64)
                .map(|n| json!({"id": first_block + n, "uuid": uuid(first_block + n), "content": format!("Links [[Project Atlas]] {text}"), "page": {"id": page_id}}))
                .collect();
            json!([page, blocks])
        })
        .collect::<Vec<_>>())
}

/// A LogSeq that answers the three calls of a first page in turn, whatever the number of times they are made.
async fn logseq_holding(held: &Held) -> MockLogseq {
    let held = Arc::clone(held);
    let calls = AtomicUsize::new(0);
    mock_logseq_answering(move |_| {
        let graph = held.lock().unwrap().clone();
        match calls.fetch_add(1, Ordering::SeqCst) % 3 {
            0 => atlas(),
            1 => block_rows(&graph),
            _ => linked_references(&graph),
        }
    })
    .await
}

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

fn snapshots() -> Snapshots {
    Snapshots::new(1_760_000_000_000)
}

async fn call_text(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<String, ToolError> {
    let result = explore_context::call(&client(logseq), false, snapshots, arguments(args)).await?;
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    let text = content[0]["text"].as_str().unwrap().to_owned();
    // a page over the budget is one entry, returned whole (BR-0007)
    let alone = serde_json::from_str::<Value>(&text).is_ok_and(|page| ["directBlocks", "references", "relatedPages"].iter().map(|key| page[key].as_array().map_or(0, Vec::len)).sum::<usize>() <= 1);
    assert!(size(&text) <= BUDGET_CHARS || alone, "a page is over the budget: {}", size(&text));
    Ok(text)
}

async fn call(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<Value, ToolError> {
    Ok(serde_json::from_str(&call_text(logseq, snapshots, args).await?).unwrap())
}

fn ids(page: &Value, key: &str, inner: &[&str]) -> Vec<i64> {
    page[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| inner.iter().fold(entry, |value, step| &value[*step])["id"].as_i64().unwrap())
        .collect()
}

fn block_ids(page: &Value) -> Vec<i64> {
    ids(page, "directBlocks", &[])
}

fn reference_ids(page: &Value) -> Vec<i64> {
    ids(page, "references", &["block"])
}

fn related_ids(page: &Value) -> Vec<i64> {
    ids(page, "relatedPages", &["page"])
}

fn cursor_of(page: &Value) -> String {
    page["nextCursor"].as_str().expect("a page that leaves entries has a nextCursor").to_owned()
}

fn warning_codes(page: &Value) -> Vec<String> {
    page["warnings"].as_array().map_or_else(Vec::new, |warnings| warnings.iter().map(|warning| warning["code"].as_str().unwrap().to_owned()).collect())
}

/// Every page of a context, from the first call until one has no cursor.
async fn read_to_the_end(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Vec<Value> {
    let mut pages = vec![call(logseq, snapshots, args).await.unwrap()];
    while pages.last().unwrap().get("nextCursor").is_some() {
        assert!(pages.len() < 100, "a cursor that never ends");
        let page = call(logseq, snapshots, json!({"cursor": cursor_of(pages.last().unwrap())})).await.unwrap();
        pages.push(page);
    }
    pages
}

// ---- a page with more of each list than one page holds

/// 120 blocks, and 15 source pages that link it 3 times each: 45 references and 15 related pages.
fn more_than_a_page() -> Held {
    held(120, 15, 3)
}

fn all_ids(pages: &[Value]) -> [Vec<i64>; 3] {
    let mut all: [Vec<i64>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for page in pages {
        all[0].extend(block_ids(page));
        all[1].extend(reference_ids(page));
        all[2].extend(related_ids(page));
    }
    all
}

#[tokio::test]
async fn each_list_is_read_to_its_end_once_and_ends_on_its_own_page_with_no_call_after_the_first() {
    let logseq = logseq_holding(&more_than_a_page()).await;
    let pages = read_to_the_end(&logseq, &snapshots(), json!({"page": "Project Atlas"})).await;
    // page 1 made the three calls, and the other pages none
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, LINKED_REFERENCES]);
    // blocks 50 + 50 + 20, references 20 + 20 + 5, related pages 10 + 5 + 0
    assert_eq!(pages.len(), 3);
    assert_eq!(
        pages.iter().map(|page| [block_ids(page).len(), reference_ids(page).len(), related_ids(page).len()]).collect::<Vec<_>>(),
        [[50, 20, 10], [50, 20, 5], [20, 5, 0]]
    );
    let [blocks, references, related] = all_ids(&pages);
    assert_eq!(blocks, (1000..1120).collect::<Vec<_>>());
    assert_eq!(references.len(), 45);
    let mut unique = references.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), 45, "no reference twice");
    assert_eq!(related.len(), 15);
    let mut unique = related.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), 15, "no related page twice");
    // the last page has neither cursor nor hasMore, and the others have both
    let (last, others) = pages.split_last().unwrap();
    assert!(last.get("nextCursor").is_none() && last["hasMore"] == false);
    assert!(others.iter().all(|page| page["hasMore"] == true && page["nextCursor"].is_string()));
    // the warnings lead with the cursor, and only the first page offers the raise
    let first = &pages[0];
    assert_eq!(warning_codes(first), ["blocks_truncated", "references_truncated", "related_pages_truncated"]);
    assert_eq!(first["warnings"][0]["message"], "Showing 1-50 of 120 blocks.");
    assert_eq!(first["warnings"][0]["howToFetchAll"], format!("{NEXT_PAGE} Or set max_blocks to 120 (or higher) to get all 120 in one call."));
    assert_eq!(pages[1]["warnings"][0]["message"], "Showing 51-100 of 120 blocks.");
    assert_eq!(pages[1]["warnings"][0]["howToFetchAll"], NEXT_PAGE);
    assert_eq!(warning_codes(last), Vec::<String>::new());
    // each page says what the context is, and what it holds in all; how the request was read is said once
    assert!(pages.iter().all(|page| page["page"] == "Project Atlas" && page["totals"] == json!({"blocks": 120, "relatedPages": 15, "references": 45})));
    assert!(pages.iter().all(|page| page["mainPage"]["id"] == 10));
}

#[tokio::test]
async fn a_miss_makes_the_first_pages_three_calls_and_reads_the_same_pages() {
    let held = more_than_a_page();
    let logseq = logseq_holding(&held).await;
    let hit = read_to_the_end(&logseq, &snapshots(), json!({"page": "Project Atlas"})).await;
    // a server that restarted between every two pages: no snapshot, and a start time of its own, for every call
    let other = logseq_holding(&held).await;
    let mut pages = vec![call(&other, &Snapshots::new(1), json!({"page": "Project Atlas"})).await.unwrap()];
    let mut restarts = 2;
    while pages.last().unwrap().get("nextCursor").is_some() {
        let restarted = Snapshots::new(restarts);
        restarts += 1;
        pages.push(call(&other, &restarted, json!({"cursor": cursor_of(pages.last().unwrap())})).await.unwrap());
    }
    assert_eq!(pages.len(), 3);
    assert_eq!(methods(&other).len(), 9, "each of the three pages made the first page's three calls, and no more");
    assert!(methods(&other).chunks(3).all(|calls| calls == [DATALOG, DATALOG, LINKED_REFERENCES]));
    // the pages are the ones the snapshot served, with no repeat and no gap, and nothing said of a list that did not move
    assert_eq!(all_ids(&pages), all_ids(&hit));
    assert!(pages.iter().all(|page| !warning_codes(page).contains(&"cursor_stale".to_owned())));
}

#[tokio::test]
async fn a_snapshot_older_than_its_age_is_a_miss_that_reads_logseq_again() {
    let logseq = logseq_holding(&more_than_a_page()).await;
    // every snapshot is already too old when it is asked for
    let aged = Snapshots::with_limits(1_760_000_000_000, Limits { max_age: Duration::ZERO, ..Limits::STARTING });
    let first = call(&logseq, &aged, json!({"page": "Project Atlas"})).await.unwrap();
    let second = call(&logseq, &aged, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 6);
    assert_eq!(block_ids(&second)[0], 1050);
}

#[tokio::test]
async fn a_context_over_the_snapshot_limit_is_built_again_for_each_page_and_still_read_to_the_end() {
    let logseq = logseq_holding(&more_than_a_page()).await;
    let small = Snapshots::with_limits(1_760_000_000_000, Limits { snapshot_bytes: 10, ..Limits::STARTING });
    let pages = read_to_the_end(&logseq, &small, json!({"page": "Project Atlas"})).await;
    assert_eq!(pages.len(), 3);
    assert_eq!(methods(&logseq).len(), 9);
    assert_eq!(all_ids(&pages)[0], (1000..1120).collect::<Vec<_>>());
}

// ---- a context that moved between the pages

#[tokio::test]
async fn a_context_that_gained_blocks_before_the_position_resumes_after_the_last_block_sent_and_says_so() {
    let held = more_than_a_page();
    let first = call(&logseq_holding(&held).await, &snapshots(), json!({"page": "Project Atlas"})).await.unwrap();
    assert_eq!(block_ids(&first).len(), 50);
    // three blocks now sort before the ones read: the last one sent (1049) is at index 52, not 49
    let moved = Graph { first_block: 997, blocks: 123, ..held.lock().unwrap().clone() };
    let rebuilt = logseq_holding(&Arc::new(Mutex::new(moved))).await;
    let second = call(&rebuilt, &Snapshots::new(2), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&rebuilt).len(), 3, "the page's own calls, and no more");
    assert_eq!(warning_codes(&second)[0], "cursor_stale");
    assert!(second["warnings"][0]["message"].as_str().unwrap().starts_with("The blocks changed since the page before was read"));
    assert_eq!(block_ids(&second)[0], 1050, "right after the last one sent, so none is repeated");
    // the references and related pages did not move, and are not said to
    assert_eq!(warning_codes(&second).iter().filter(|code| *code == "cursor_stale").count(), 1);
}

#[tokio::test]
async fn a_context_that_lost_the_last_block_sent_resumes_at_the_position_and_says_so() {
    let held = more_than_a_page();
    let first = call(&logseq_holding(&held).await, &snapshots(), json!({"page": "Project Atlas"})).await.unwrap();
    let gone = Graph { removed_blocks: vec![1049], ..held.lock().unwrap().clone() };
    let rebuilt = logseq_holding(&Arc::new(Mutex::new(gone))).await;
    let second = call(&rebuilt, &Snapshots::new(2), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(warning_codes(&second)[0], "cursor_stale");
    assert!(second["warnings"][0]["message"].as_str().unwrap().contains("is gone"));
    // the position is the 51st block of the list now, which is the block that followed the one that went
    assert_eq!(block_ids(&second)[0], 1051);
}

/// How many `cursor_stale` warnings a page holds, and the message of the first.
fn stale_of(page: &Value) -> (usize, String) {
    let stale: Vec<&Value> = page["warnings"].as_array().unwrap().iter().filter(|warning| warning["code"] == "cursor_stale").collect();
    (stale.len(), stale.first().map_or(String::new(), |warning| warning["message"].as_str().unwrap().to_owned()))
}

#[tokio::test]
async fn a_reference_that_moved_is_said_of_the_references_alone_and_resumes_after_the_last_one_sent() {
    let held = more_than_a_page();
    let first = call(&logseq_holding(&held).await, &snapshots(), json!({"page": "Project Atlas"})).await.unwrap();
    // the last reference sent is 3601 (the second block of the seventh source page)
    assert_eq!(reference_ids(&first).last(), Some(&3601));
    // a source page that ranks first by name is listed last by LogSeq: the references shift by 3, the related pages
    // keep their positions, and the blocks do not change
    let moved = Graph { extra_source: true, ..held.lock().unwrap().clone() };
    let rebuilt = logseq_holding(&Arc::new(Mutex::new(moved))).await;
    let second = call(&rebuilt, &Snapshots::new(2), json!({"cursor": cursor_of(&first)})).await.unwrap();
    let (count, message) = stale_of(&second);
    assert_eq!(count, 1, "{second}");
    assert!(message.starts_with("The references changed since the page before was read"), "{message}");
    assert_eq!(reference_ids(&second)[0], 3602, "right after the last one sent");
}

#[tokio::test]
async fn a_related_page_that_is_gone_is_said_of_the_related_pages_alone() {
    let held = more_than_a_page();
    let first = call(&logseq_holding(&held).await, &snapshots(), json!({"page": "Project Atlas"})).await.unwrap();
    assert_eq!(related_ids(&first).last(), Some(&2009));
    // the last related page sent goes, with its blocks, which sat after the references' position
    let gone = Graph { removed_sources: vec![9], ..held.lock().unwrap().clone() };
    let rebuilt = logseq_holding(&Arc::new(Mutex::new(gone))).await;
    let second = call(&rebuilt, &Snapshots::new(2), json!({"cursor": cursor_of(&first)})).await.unwrap();
    let (count, message) = stale_of(&second);
    assert_eq!(count, 1, "{second}");
    assert!(message.starts_with("The related pages changed since the page before was read") && message.contains("is gone"), "{message}");
    assert_eq!(related_ids(&second)[0], 2011, "the page starts at the position in the list as it is now, which the page that went had before it");
}

#[tokio::test]
async fn a_chain_of_refs_past_the_depth_limit_keeps_has_more_true_with_no_cursor() {
    let block = json!([{"id": 1000, "uuid": uuid(1000), "content": format!("See (({}))", uuid(2)), "page": {"id": 10}, "parent": {"id": 10}, "left": {"id": 10}}]);
    let target = |id: i64, content: String| json!([{"id": id, "uuid": uuid(id), "content": content, "left": {"id": 10}, "parent": {"id": 10}, "page": {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}}]);
    let logseq = mock_logseq(vec![atlas(), json!([block]), json!([]), json!([target(2, format!("mid (({}))", uuid(3)))]), json!([target(3, format!("end (({}))", uuid(4)))])]).await;
    let page = call(&logseq, &snapshots(), json!({"page": "Project Atlas", "resolve_refs": true})).await.unwrap();
    assert!(page.get("nextCursor").is_none());
    assert_eq!(page["hasMore"], true, "the warning offers a way of its own");
    let warning = page["warnings"].as_array().unwrap().iter().find(|warning| warning["code"] == "refs_depth_limit").expect("the depth limit is said");
    assert!(warning["howToFetchAll"].is_string());
}

#[tokio::test]
async fn a_context_that_shrank_below_the_position_is_an_empty_page_and_not_an_error() {
    let held = more_than_a_page();
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), json!({"page": "Project Atlas"})).await.unwrap();
    let tiny = held_with(3, 1, 1);
    let rebuilt = logseq_holding(&tiny).await;
    let second = call(&rebuilt, &Snapshots::new(2), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert!(block_ids(&second).is_empty() && reference_ids(&second).is_empty() && related_ids(&second).is_empty());
    assert!(second.get("nextCursor").is_none());
    assert!(warning_codes(&second).contains(&"cursor_stale".to_owned()));
    assert_eq!(second["totals"], json!({"blocks": 3, "relatedPages": 1, "references": 1}));
}

fn held_with(blocks: usize, sources: usize, per_source: usize) -> Held {
    held(blocks, sources, per_source)
}

// ---- what the budget cuts, and the lists a page size leaves out

#[tokio::test]
async fn the_budget_drops_related_pages_then_references_then_blocks_and_every_entry_is_still_read_once() {
    // 100 blocks of 700 characters (~70,000), 30 references and 10 related pages: several pages by size
    let held = Arc::new(Mutex::new(Graph { blocks: 100, first_block: 1000, removed_blocks: Vec::new(), block_length: 700, sources: 10, per_source: 3, reference_length: 120, extra_source: false, removed_sources: Vec::new() }));
    let logseq = logseq_holding(&held).await;
    let pages = read_to_the_end(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_blocks": 100, "max_references": 100, "max_related_pages": 100})).await;
    assert!(pages.len() >= 3, "{} pages", pages.len());
    assert_eq!(methods(&logseq).len(), 3);
    let first = &pages[0];
    assert!(block_ids(first).len() < 100);
    assert!(reference_ids(first).is_empty() && related_ids(first).is_empty(), "the blocks fill the first page, and the budget drops the tail first");
    assert_eq!(warning_codes(first), ["result_size_truncated"]);
    assert_eq!(first["warnings"][0]["howToFetchAll"], NEXT_PAGE);
    let [blocks, references, related] = all_ids(&pages);
    assert_eq!(blocks, (1000..1100).collect::<Vec<_>>());
    assert_eq!(references.len(), 30);
    assert_eq!(related.len(), 10);
    assert!(pages.last().unwrap().get("nextCursor").is_none());
}

#[tokio::test]
async fn a_block_over_the_budget_is_returned_alone_and_the_cursor_moves_past_it() {
    let held = Arc::new(Mutex::new(Graph { blocks: 3, first_block: 1000, removed_blocks: Vec::new(), block_length: 40_000, sources: 0, per_source: 0, reference_length: 10, extra_source: false, removed_sources: Vec::new() }));
    let logseq = logseq_holding(&held).await;
    let pages = read_to_the_end(&logseq, &snapshots(), json!({"page": "Project Atlas"})).await;
    assert_eq!(pages.len(), 3);
    assert_eq!(pages.iter().map(|page| block_ids(page)).collect::<Vec<_>>(), [vec![1000], vec![1001], vec![1002]]);
    assert!(pages[0]["warnings"][0]["message"].as_str().unwrap().contains("an entry is never cut inside its text"));
    assert!(pages[2].get("nextCursor").is_none() && warning_codes(&pages[2]).is_empty());
}

#[tokio::test]
async fn a_list_left_out_with_a_page_size_of_zero_is_not_read_and_the_cursor_reads_the_others() {
    let logseq = logseq_holding(&more_than_a_page()).await;
    let pages = read_to_the_end(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_blocks": 0, "max_related_pages": 0})).await;
    assert_eq!(pages.len(), 3, "the 45 references are read 20 at a time");
    let [blocks, references, related] = all_ids(&pages);
    assert!(blocks.is_empty() && related.is_empty());
    assert_eq!(references.len(), 45);
    // the blocks left out are said on every page, with the raise on the first only
    assert_eq!(pages[0]["warnings"][0]["code"], "blocks_truncated");
    assert_eq!(pages[0]["warnings"][0]["howToFetchAll"], "Set max_blocks to 120 (or higher) to get all 120 in one call.");
    assert!(pages[1]["warnings"][0]["howToFetchAll"].is_null());
    // nothing to read on when the lists left out are the only ones with entries behind
    let none = call(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_blocks": 0, "max_references": 0, "max_related_pages": 0})).await.unwrap();
    assert!(none.get("nextCursor").is_none());
}

#[tokio::test]
async fn a_context_exactly_at_each_page_size_has_no_cursor_and_one_more_in_any_list_has() {
    let exact = held(50, 10, 2);
    let logseq = logseq_holding(&exact).await;
    let page = call(&logseq, &snapshots(), json!({"page": "Project Atlas"})).await.unwrap();
    assert_eq!((page.get("nextCursor"), page["hasMore"].clone(), page["warnings"].clone()), (None, json!(false), json!([])));
    for (blocks, sources) in [(51, 10), (50, 11)] {
        let logseq = logseq_holding(&held(blocks, sources, 1)).await;
        let page = call(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_references": 100})).await.unwrap();
        assert!(page["nextCursor"].is_string(), "{blocks} blocks, {sources} related pages");
    }
}

#[tokio::test]
async fn an_empty_page_is_one_page_with_no_cursor() {
    let logseq = logseq_holding(&held(0, 0, 0)).await;
    let page = call(&logseq, &snapshots(), json!({"page": "Project Atlas"})).await.unwrap();
    assert_eq!((block_ids(&page).len(), page.get("nextCursor"), page["hasMore"].clone()), (0, None, json!(false)));
}

// ---- the formats

#[tokio::test]
async fn markdown_carries_the_cursor_in_its_footer_of_every_page_but_the_last_and_a_group_of_references_may_be_cut_between_pages() {
    let logseq = logseq_holding(&held(5, 4, 12)).await;
    let snapshots = snapshots();
    let mut pages = vec![call_text(&logseq, &snapshots, json!({"page": "Project Atlas", "format": "markdown", "max_references": 20})).await.unwrap()];
    let cursor_line = |text: &str| text.lines().find_map(|line| line.strip_prefix("nextCursor: ")).map(str::to_owned);
    while let Some(cursor) = cursor_line(pages.last().unwrap()) {
        assert!(pages.len() < 10, "a cursor that never ends");
        // the footer says there is more, and its token is one this tool made
        assert!(pages.last().unwrap().contains("hasMore: true"));
        assert_eq!(decode(&cursor, "logseq_explore_context").unwrap().tool, "logseq_explore_context");
        pages.push(call_text(&logseq, &snapshots, json!({"cursor": cursor})).await.unwrap());
    }
    assert_eq!(pages.len(), 3, "48 references, 20 at a time");
    assert_eq!(methods(&logseq).len(), 3, "the later pages are read from the snapshot");
    // the last page has neither line
    let last = pages.last().unwrap();
    assert!(!last.contains("hasMore: true") && !last.contains("nextCursor: "), "{last}");
    // the 12 blocks of the second source page are 8 on the first page and 4 on the second: its header is on both
    let header = "[[source 001]]";
    assert!(pages[0].matches(header).count() >= 1 && pages[1].matches(header).count() >= 1, "{}", pages[1]);
}

#[tokio::test]
async fn compact_pages_hold_snippets_and_are_read_on_with_the_same_cursor() {
    let logseq = logseq_holding(&more_than_a_page()).await;
    let pages = read_to_the_end(&logseq, &snapshots(), json!({"page": "Project Atlas", "compact": true})).await;
    assert_eq!(pages.len(), 3);
    assert!(pages[0]["directBlocks"][0].get("snippet").is_some());
    assert_eq!(all_ids_compact(&pages), 120);
}

fn all_ids_compact(pages: &[Value]) -> usize {
    pages.iter().map(|page| page["directBlocks"].as_array().unwrap().len()).sum()
}

// ---- resolve_refs runs for the page being sent, from LogSeq or from the snapshot

fn target(id: i64, content: &str) -> Value {
    json!([{"id": id, "uuid": uuid(id), "content": content, "left": {"id": 10}, "parent": {"id": 10}, "page": {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}}])
}

#[tokio::test]
async fn resolve_refs_runs_for_the_blocks_of_the_page_sent_and_a_snapshot_page_costs_only_that() {
    // 51 blocks: the first has a ref, and so does the 51st, which is on the second page
    let mut blocks: Vec<Value> = (0..51i64).map(|n| json!([{"id": 1000 + n, "uuid": uuid(1000 + n), "content": format!("Block {n}"), "page": {"id": 10}, "parent": {"id": 10}, "left": {"id": 10}}])).collect();
    blocks[0][0]["content"] = json!(format!("See (({}))", uuid(2)));
    blocks[50][0]["content"] = json!(format!("Also (({}))", uuid(3)));
    let logseq = mock_logseq(vec![atlas(), json!(blocks), json!([]), json!([target(2, "the first target")]), json!([target(3, "the second target")])]).await;
    let snapshots = snapshots();
    let first = call(&logseq, &snapshots, json!({"page": "Project Atlas", "resolve_refs": true})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "the first page's calls, with one query for the refs it holds");
    assert_eq!(first["directBlocks"][0]["resolvedContent"], "See the first target");
    assert_eq!(block_ids(&first).len(), 50);
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    // one query, for the ref of the one block this page holds, and no read of the page again
    assert_eq!(methods(&logseq).len(), 5);
    assert_eq!(block_ids(&second), [1050]);
    assert_eq!(second["directBlocks"][0]["resolvedContent"], "Also the second target");
    assert!(second.get("nextCursor").is_none());
}

// ---- what is refused before any call

#[tokio::test]
async fn a_cursor_with_any_other_argument_or_a_bad_token_is_refused_before_any_call() {
    let logseq = mock_logseq(vec![]).await;
    let good = encode(&Cursor::new(
        "logseq_explore_context",
        json!({"page": "Project Atlas"}).as_object().cloned().unwrap(),
        Position::Sections { blocks: 50, references: 0, related: 0 },
        Anchor::Sections(SectionAnchors { blocks: Some(1049), references: None, related: None }),
        logseq_mcp_server::cursor::SnapshotKey { started: 1, n: 1 },
    ));
    for args in [
        json!({"cursor": good, "page": "Project Atlas"}),
        json!({"cursor": good, "name": "Project Atlas"}),
        json!({"cursor": good, "max_blocks": 3}),
        json!({"cursor": good, "compact": true}),
        json!({"cursor": "not a token!"}),
        json!({"cursor": "e30"}),
        json!({"max_blocks": 3}),
        json!({}),
    ] {
        let error = explore_context::call(&client(&logseq), false, &snapshots(), arguments(args.clone())).await.unwrap_err();
        assert!(matches!(error, ToolError::InvalidParameter(_)), "{args}: {error}");
    }
    // another tool's token, and one with a position that is not three lists
    let other = encode(&Cursor::new("logseq_find_blocks", Default::default(), Position::Index { at: 1 }, Anchor::Id(1), logseq_mcp_server::cursor::SnapshotKey { started: 1, n: 1 }));
    let index = encode(&Cursor::new("logseq_explore_context", json!({"page": "a"}).as_object().cloned().unwrap(), Position::Index { at: 1 }, Anchor::Id(1), logseq_mcp_server::cursor::SnapshotKey { started: 1, n: 1 }));
    for token in [other, index] {
        let error = explore_context::call(&client(&logseq), false, &snapshots(), arguments(json!({"cursor": token}))).await.unwrap_err();
        assert!(matches!(error, ToolError::InvalidParameter(_)), "{error}");
    }
    assert!(methods(&logseq).is_empty(), "nothing was refused after a call");
    // the token a first page made carries each list's position and the last entry sent, and nothing else of the context
    let held = more_than_a_page();
    let live = logseq_holding(&held).await;
    let first = call(&live, &snapshots(), json!({"page": "Project Atlas"})).await.unwrap();
    let cursor = decode(&cursor_of(&first), "logseq_explore_context").unwrap();
    assert_eq!(cursor.position, Position::Sections { blocks: 50, references: 20, related: 10 });
    assert!(matches!(cursor.anchor, Anchor::Sections(SectionAnchors { blocks: Some(1049), references: Some(_), related: Some(_) })));
}

#[tokio::test]
async fn an_infrastructure_error_on_a_page_that_has_to_read_logseq_again_reaches_the_caller() {
    let logseq = logseq_holding(&more_than_a_page()).await;
    let first = call(&logseq, &snapshots(), json!({"page": "Project Atlas"})).await.unwrap();
    // LogSeq is gone and the snapshot with it: the error is the caller's, not an empty page
    let gone = mock_logseq(vec![]).await;
    let error = explore_context::call(&client(&gone), false, &Snapshots::new(2), arguments(json!({"cursor": cursor_of(&first)}))).await.unwrap_err();
    assert!(!matches!(error, ToolError::InvalidParameter(_)), "{error}");
}
