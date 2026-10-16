//! What a list too big to keep as a snapshot costs (ADR-0038, #580): a later page of a list within the per-snapshot
//! limit is read from memory and makes no LogSeq call; a later page of a list over it makes the first page's calls
//! again and resumes after the last hit sent, so the list is still read to the end with no gap and no repeat. Both
//! tools that were measured on a real graph, `find_blocks` and `explore_timeline`, through their `call`, against a
//! mock LogSeq on a local port.
//!
//! The size of the lists comes from `src/snapshots.rs`, never from a number here: each test finds the longest list
//! whose declared weight is within `MAX_SNAPSHOT_BYTES` (by asking the tool what a snapshot of it weighs,
//! `Snapshots::total_bytes`), and reads that list and one block longer. A change to the limit or to
//! `VALUE_RESIDENT_FACTOR` moves the lists and not the meaning of the test. Every page and block here is made up
//! (BR-0001).

mod common;

use std::future::Future;

use common::{MockLogseq, client, methods, mock_logseq_answering, uuid};
use logseq_mcp_server::dates::Clock;
use logseq_mcp_server::snapshots::{Limits, MAX_SNAPSHOT_BYTES, MAX_TOTAL_BYTES, Snapshots};
use logseq_mcp_server::tools::{explore_timeline, find_blocks};
use serde_json::{Value, json};

/// 2025-03-12T03:30:00Z, the instant the parity harness reads as now.
const NOW: Clock = Clock::Fixed(1_741_750_200_000);

const DATALOG: &str = "logseq.DB.datascriptQuery";

/// How long the text of each block is: long enough that a list at the limit is a few hundred blocks.
const TEXT_LENGTH: usize = 2000;
/// A block id has this many digits for every block of a list, so each block weighs the same.
const FIRST_ID: i64 = 10_000;
/// More pages than any list here has: a loop that reaches it has not read the list to its end.
const MOST_PAGES: usize = 500;

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

fn snapshots() -> Snapshots {
    Snapshots::new(1_760_000_000_000)
}

/// A cache that keeps any list, to ask what a list weighs.
fn unbounded() -> Snapshots {
    Snapshots::with_limits(1_760_000_000_000, Limits { snapshot_bytes: usize::MAX, total_bytes: usize::MAX, ..Limits::STARTING })
}

/// The largest `n` whose list weighs at most `MAX_SNAPSHOT_BYTES`, given the weight of the list of `n`.
async fn largest_within_limit<F, Fut>(weight_of: F) -> usize
where
    F: Fn(usize) -> Fut,
    Fut: Future<Output = usize>,
{
    const PROBE: usize = 100;
    let per_block = weight_of(PROBE).await / PROBE;
    assert!(per_block > 0, "a list of blocks weighs something");
    let mut n = MAX_SNAPSHOT_BYTES / per_block;
    while weight_of(n).await > MAX_SNAPSHOT_BYTES {
        n -= 1;
    }
    while weight_of(n + 1).await <= MAX_SNAPSHOT_BYTES {
        n += 1;
    }
    assert!(n > 20, "the list at the limit is many pages long: {n}");
    n
}

// ---- find_blocks

fn is_search(request: &Value) -> bool {
    request["args"][0].as_str().is_some_and(|query| query.starts_with("[:find (pull ?b [* {:block/page"))
}

/// A LogSeq that holds `count` matching blocks, ids `FIRST_ID` up.
async fn logseq_with_hits(count: usize) -> MockLogseq {
    mock_logseq_answering(move |request| {
        assert!(is_search(request), "a call a search with no context does not make: {request}");
        Value::Array(
            (0..count as i64)
                .map(|n| {
                    let id = FIRST_ID + n;
                    json!([{"id": id, "uuid": uuid(id), "content": format!("mentions the importer {}", "x".repeat(TEXT_LENGTH)), "page": {"id": 5, "name": "page 5", "original-name": "Page 5"}}])
                })
                .collect(),
        )
    })
    .await
}

/// One page of `find_blocks`: its hits' uuids and its meta.
async fn find_page(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> (Vec<String>, Value) {
    let result = find_blocks::call(&client(logseq), true, NOW, snapshots, arguments(args)).await.unwrap();
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    let hits: Vec<Value> = serde_json::from_str(content[0]["text"].as_str().unwrap()).unwrap();
    let meta = serde_json::from_str::<Value>(content[1]["text"].as_str().unwrap()).unwrap()["meta"].clone();
    (hits.iter().map(|hit| hit["uuid"].as_str().unwrap().to_owned()).collect(), meta)
}

/// What a snapshot of the list of `count` hits weighs: the one a first page keeps in a cache that keeps anything.
async fn find_weight(count: usize) -> usize {
    let logseq = logseq_with_hits(count).await;
    let cache = unbounded();
    let (_, meta) = find_page(&logseq, &cache, json!({"text": "importer", "limit": 500})).await;
    assert!(meta["nextCursor"].is_string(), "a list this long is cut into pages: {count}");
    cache.total_bytes()
}

/// Read the list of `count` hits to its end by cursor. Returns the uuids read, the searches made, the snapshots kept after the first page and the number of pages.
async fn read_find_to_the_end(count: usize) -> (Vec<String>, usize, usize, usize) {
    let logseq = logseq_with_hits(count).await;
    let cache = snapshots();
    let (mut read, mut meta) = find_page(&logseq, &cache, json!({"text": "importer", "limit": 500})).await;
    assert_eq!(methods(&logseq), [DATALOG], "the first page is the one search");
    let kept = cache.len();
    let mut pages = 1;
    while let Some(cursor) = meta["nextCursor"].as_str() {
        assert!(pages < MOST_PAGES, "the list was not read to its end");
        let (page, next) = find_page(&logseq, &cache, json!({"cursor": cursor})).await;
        assert!(!page.is_empty(), "a page with nothing in it, meta {next}");
        assert!(next["warnings"].as_array().unwrap().iter().all(|warning| warning["code"] != "cursor_stale"), "the list did not move: {next}");
        read.extend(page);
        meta = next;
        pages += 1;
    }
    let calls = methods(&logseq).len();
    (read, calls, kept, pages)
}

#[tokio::test]
async fn find_blocks_a_list_within_the_limit_is_kept_and_its_pages_make_no_call() {
    let n = largest_within_limit(find_weight).await;
    assert!(find_weight(n).await <= MAX_SNAPSHOT_BYTES && find_weight(n + 1).await > MAX_SNAPSHOT_BYTES);

    let (read, calls, kept, pages) = read_find_to_the_end(n).await;
    assert_eq!(kept, 1, "the list at the limit is kept");
    assert!(pages > 2, "the list is more than one later page long");
    assert_eq!(calls, 1, "every page after the first was read from the snapshot: no call");
    assert_eq!(read, (0..n as i64).rev().map(|n| uuid(FIRST_ID + n)).collect::<Vec<_>>(), "every hit once, newest first");
}

#[tokio::test]
async fn find_blocks_a_list_over_the_limit_is_not_kept_so_each_page_makes_the_first_pages_call_and_the_list_is_still_read_to_the_end() {
    let n = largest_within_limit(find_weight).await + 1;

    let (read, calls, kept, pages) = read_find_to_the_end(n).await;
    assert_eq!(kept, 0, "the list over the limit is not kept");
    assert!(pages > 2, "the list is more than one later page long");
    assert_eq!(calls, pages, "every page made the one search the first page made, and no more");
    assert_eq!(read, (0..n as i64).rev().map(|n| uuid(FIRST_ID + n)).collect::<Vec<_>>(), "no gap and no repeat across the rebuilt pages");
}

// ---- explore_timeline

fn is_journals(request: &Value) -> bool {
    request["args"][0].as_str().is_some_and(|query| query.starts_with("[:find (pull ?page [*]) :in $ ?start ?end"))
}

fn is_blocks(request: &Value) -> bool {
    request["args"][0].as_str().is_some_and(|query| query.starts_with("[:find (pull ?block [* {:block/refs"))
}

/// A LogSeq that holds one journal day of `count` top-level blocks, ids `FIRST_ID` up.
async fn logseq_with_day(count: usize) -> MockLogseq {
    let page = 20250101;
    mock_logseq_answering(move |request| {
        if is_journals(request) {
            json!([[{"id": page, "uuid": uuid(page), "name": "day 20250101", "original-name": "Day 20250101", "journal-day": 20250101}]])
        } else if is_blocks(request) {
            Value::Array(
                (0..count as i64)
                    .map(|n| {
                        let id = FIRST_ID + n;
                        let left = if n == 0 { page } else { id - 1 };
                        json!([{"id": id, "uuid": uuid(id), "content": format!("{id} {}", "x".repeat(TEXT_LENGTH)), "page": {"id": page}, "parent": {"id": page}, "left": {"id": left}, "refs": [{"id": 900, "name": "project atlas", "original-name": "Project Atlas", "journal?": false}]}])
                    })
                    .collect(),
            )
        } else {
            panic!("a query the timeline of a period does not make: {request}");
        }
    })
    .await
}

async fn timeline_page(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> (Vec<String>, Value) {
    let result = explore_timeline::call(&client(logseq), true, NOW, snapshots, arguments(args)).await.unwrap();
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    let page: Value = serde_json::from_str(content[0]["text"].as_str().unwrap()).unwrap();
    let uuids = page["entries"].as_array().unwrap().iter().flat_map(|entry| entry["blocks"].as_array().cloned().unwrap_or_default()).map(|block| block["uuid"].as_str().unwrap().to_owned()).collect();
    (uuids, page)
}

fn period() -> Value {
    json!({"start_date": 20250101, "end_date": 20250101})
}

async fn timeline_weight(count: usize) -> usize {
    let logseq = logseq_with_day(count).await;
    let cache = unbounded();
    let (_, page) = timeline_page(&logseq, &cache, period()).await;
    assert!(page["nextCursor"].is_string(), "a list this long is cut into pages: {count}");
    cache.total_bytes()
}

/// Read the day of `count` blocks to its end by cursor: the uuids read, the LogSeq calls made, the snapshots kept
/// after the first page and the number of pages.
async fn read_timeline_to_the_end(count: usize) -> (Vec<String>, usize, usize, usize) {
    let logseq = logseq_with_day(count).await;
    let cache = snapshots();
    let (mut read, mut page) = timeline_page(&logseq, &cache, period()).await;
    assert_eq!(methods(&logseq), [DATALOG, DATALOG], "the first page is the two queries of a period");
    let kept = cache.len();
    let mut pages = 1;
    while let Some(cursor) = page["nextCursor"].as_str() {
        assert!(pages < MOST_PAGES, "the list was not read to its end");
        let (blocks, next) = timeline_page(&logseq, &cache, json!({"cursor": cursor})).await;
        assert!(!blocks.is_empty(), "a page with nothing in it: {next}");
        assert!(next["warnings"].as_array().is_none_or(|warnings| warnings.iter().all(|warning| warning["code"] != "cursor_stale")), "the list did not move: {next}");
        read.extend(blocks);
        page = next;
        pages += 1;
    }
    (read, methods(&logseq).len(), kept, pages)
}

#[tokio::test]
async fn explore_timeline_a_list_within_the_limit_is_kept_and_its_pages_make_no_call() {
    let n = largest_within_limit(timeline_weight).await;
    assert!(timeline_weight(n).await <= MAX_SNAPSHOT_BYTES && timeline_weight(n + 1).await > MAX_SNAPSHOT_BYTES);

    let (read, calls, kept, pages) = read_timeline_to_the_end(n).await;
    assert_eq!(kept, 1, "the list at the limit is kept");
    assert!(pages > 2, "the list is more than one later page long");
    assert_eq!(calls, 2, "every page after the first was read from the snapshot: no call");
    assert_eq!(read, (0..n as i64).map(|n| uuid(FIRST_ID + n)).collect::<Vec<_>>(), "every block once, in order");
}

#[tokio::test]
async fn explore_timeline_a_list_over_the_limit_is_not_kept_so_each_page_makes_the_first_pages_calls_and_the_list_is_still_read_to_the_end() {
    let n = largest_within_limit(timeline_weight).await + 1;

    let (read, calls, kept, pages) = read_timeline_to_the_end(n).await;
    assert_eq!(kept, 0, "the list over the limit is not kept");
    assert!(pages > 2, "the list is more than one later page long");
    assert_eq!(calls, 2 * pages, "every page made the two queries the first page made, and no more");
    assert_eq!(read, (0..n as i64).map(|n| uuid(FIRST_ID + n)).collect::<Vec<_>>(), "no gap and no repeat across the rebuilt pages");
}

#[test]
fn the_limits_the_lists_are_sized_by_are_the_ones_the_server_starts_with() {
    let starting = Limits::STARTING;
    assert_eq!(starting.snapshot_bytes, MAX_SNAPSHOT_BYTES);
    assert!(MAX_SNAPSHOT_BYTES <= MAX_TOTAL_BYTES, "a list within the per-snapshot limit can always be kept");
}
