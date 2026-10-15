//! The cursor of `logseq_explore_timeline` (ADR-0038, #554) through its `call`, against a mock LogSeq on a local port:
//! what a page read from a snapshot costs (no call), what a page read after the snapshot is gone costs (the first page's
//! calls, and no more), how a list that moved between two pages is resumed, how a day cut between two pages reads, and
//! what a bad token or a cursor with another argument gets before any call. Every page and block here is made up
//! (BR-0001).

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MockLogseq, args_of, client, methods, mock_logseq, mock_logseq_answering, uuid};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode};
use logseq_mcp_server::dates::Clock;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::snapshots::{Limits, Snapshots};
use logseq_mcp_server::tools::explore_timeline;
use serde_json::{Value, json};

/// 2025-03-12T03:30:00Z, the instant the parity harness reads as now.
const NOW: Clock = Clock::Fixed(1_741_750_200_000);
/// The same instant 30 days on: a page read again a month later.
const LATER: Clock = Clock::Fixed(1_741_750_200_000 + 30 * 86_400_000);

const DATALOG: &str = "logseq.DB.datascriptQuery";
const NEXT_PAGE: &str = "Pass nextCursor as cursor, with no other argument, to read the next page.";

/// A block of a day: its id, its parent (the page, or a block) and the sibling before it (the page, or a block), and how
/// long its text is.
#[derive(Clone)]
struct Spec {
    id: i64,
    parent: i64,
    left: i64,
    length: usize,
}

#[derive(Clone)]
struct Day {
    day: i64,
    page: i64,
    blocks: Vec<Spec>,
}

/// A day of `count` top-level blocks, numbered from `first`, each `length` characters long.
fn flat_day(day: i64, first: i64, count: i64, length: usize) -> Day {
    let page = day;
    let blocks = (0..count).map(|n| Spec { id: first + n, parent: page, left: if n == 0 { page } else { first + n - 1 }, length }).collect();
    Day { day, page, blocks }
}

/// What LogSeq holds: the journal days, which a test changes between two pages.
type Graph = Arc<Mutex<Vec<Day>>>;

fn graph(days: Vec<Day>) -> Graph {
    Arc::new(Mutex::new(days))
}

fn is_journals(request: &Value) -> bool {
    request["args"][0].as_str().is_some_and(|query| query.starts_with("[:find (pull ?page [*]) :in $ ?start ?end"))
}

fn is_blocks(request: &Value) -> bool {
    request["args"][0].as_str().is_some_and(|query| query.starts_with("[:find (pull ?block [* {:block/refs"))
}

fn page_row(day: &Day) -> Value {
    json!([{"id": day.page, "uuid": uuid(day.page), "name": format!("day {}", day.day), "original-name": format!("Day {}", day.day), "journal-day": day.day}])
}

fn block_row(day: &Day, spec: &Spec) -> Value {
    json!([{"id": spec.id, "uuid": uuid(spec.id), "content": format!("{} {}", spec.id, "x".repeat(spec.length)), "page": {"id": day.page}, "parent": {"id": spec.parent}, "left": {"id": spec.left}, "refs": [{"id": 900, "name": "project atlas", "original-name": "Project Atlas", "journal?": false}]}])
}

/// A LogSeq that answers the two queries of a period from `graph`.
async fn logseq_holding(graph: &Graph) -> MockLogseq {
    let graph = Arc::clone(graph);
    mock_logseq_answering(move |request| {
        let days = graph.lock().unwrap();
        if is_journals(request) {
            Value::Array(days.iter().map(page_row).collect())
        } else if is_blocks(request) {
            Value::Array(days.iter().flat_map(|day| day.blocks.iter().map(|spec| block_row(day, spec)).collect::<Vec<_>>()).collect())
        } else {
            panic!("a query the timeline of a period does not make: {request}");
        }
    })
    .await
}

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

/// The result of a call, parsed, with the check that it is a page: at most the budget, or one block.
async fn call_with(clock: Clock, logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<Value, ToolError> {
    let result = explore_timeline::call(&client(logseq), true, clock, snapshots, arguments(args)).await?;
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    let text = content[0]["text"].as_str().unwrap();
    let value: Value = serde_json::from_str(text).unwrap();
    assert!(size(text) <= BUDGET_CHARS || block_count(&value) == 1, "a page is over the budget: {} characters", size(text));
    Ok(value)
}

async fn call(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<Value, ToolError> {
    call_with(NOW, logseq, snapshots, args).await
}

fn block_count(page: &Value) -> usize {
    page["entries"].as_array().unwrap().iter().map(|entry| entry["blocks"].as_array().map_or(0, Vec::len)).sum()
}

/// The uuids of the blocks of a page, in order, nested ones too.
fn uuids(page: &Value) -> Vec<String> {
    fn walk(blocks: &[Value], out: &mut Vec<String>) {
        for block in blocks {
            out.push(block["uuid"].as_str().unwrap().to_owned());
            walk(block["children"].as_array().map_or(&[][..], Vec::as_slice), out);
        }
    }
    let mut out = Vec::new();
    for entry in page["entries"].as_array().unwrap() {
        walk(entry["blocks"].as_array().map_or(&[][..], Vec::as_slice), &mut out);
    }
    out
}

fn dates(page: &Value) -> Vec<i64> {
    page["entries"].as_array().unwrap().iter().map(|entry| entry["date"].as_i64().unwrap_or(0)).collect()
}

fn cursor_of(page: &Value) -> String {
    page["nextCursor"].as_str().expect("a page that leaves blocks has a nextCursor").to_owned()
}

fn snapshots() -> Snapshots {
    Snapshots::new(1_760_000_000_000)
}

fn codes(page: &Value) -> Vec<&str> {
    page["warnings"].as_array().map(|warnings| warnings.iter().map(|warning| warning["code"].as_str().unwrap()).collect()).unwrap_or_default()
}

fn period() -> Value {
    json!({"start_date": 20250101, "end_date": 20250131})
}

fn with(mut base: Value, extra: Value) -> Value {
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    base
}

/// Four days of 60 small blocks, and the ids of every block in the order the tool lists them.
fn four_days() -> (Graph, Vec<String>) {
    let days: Vec<Day> = (0..4).map(|n| flat_day(20250101 + n, 1000 * (n + 1), 60, 10)).collect();
    let all = days.iter().flat_map(|day| day.blocks.iter().map(|spec| uuid(spec.id))).collect();
    (graph(days), all)
}

// ---- a hit: the later pages cost nothing

#[tokio::test]
async fn the_pages_after_the_first_are_read_from_the_snapshot_and_make_no_call() {
    let (held, all) = four_days();
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();

    let first = call(&logseq, &snapshots, with(period(), json!({"max_blocks": 100}))).await.unwrap();
    assert_eq!(block_count(&first), 100);
    assert_eq!((first["hasMore"].clone(), first["totals"].clone()), (json!(true), json!({"blocks": 240, "days": 4})));
    assert_eq!(first["warnings"][0]["code"], "blocks_truncated");
    assert_eq!(first["warnings"][0]["message"].as_str().unwrap().split(". ").next().unwrap(), "Showing 1-100 of 240 blocks (nested ones counted; oldest day first)");
    assert_eq!(first["warnings"][0]["howToFetchAll"], NEXT_PAGE);
    assert_eq!((first["summary"]["totalDays"].clone(), first["summary"]["totalBlocks"].clone()), (json!(4), json!(240)));
    assert_eq!(first["dateRange"], json!({"start": 20250101, "end": 20250131}));
    assert_eq!(methods(&logseq), [DATALOG, DATALOG], "the first page is the two queries of a period");
    // the keys of BR-0013: hasMore, then nextCursor, then the warnings
    let keys: Vec<&String> = first.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["dateRange", "hasMore", "nextCursor", "warnings", "totals", "summary", "entries"]);

    // the graph changes under the pages: a hit page still shows the list as the first page read it
    held.lock().unwrap().clear();
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(block_count(&second), 100);
    assert_eq!(second["hasMore"], true);
    assert!(second.get("summary").is_none(), "a page after the first has no summary");
    assert_eq!(second["dateRange"], first["dateRange"]);
    // the second day is cut between the pages: it is on both with the same date
    assert_eq!(dates(&first), [20250101, 20250102]);
    assert_eq!(dates(&second), [20250102, 20250103, 20250104]);

    let third = call(&logseq, &snapshots, json!({"cursor": cursor_of(&second)})).await.unwrap();
    assert_eq!(block_count(&third), 40);
    // the last page is complete: no cursor, no warning, no hasMore (false), and no totals
    assert_eq!((third.get("hasMore").cloned(), third.get("nextCursor").cloned(), third.get("totals").cloned(), third.get("warnings").cloned()), (None, None, None, None));
    assert_eq!(dates(&third), [20250104], "and the fourth between the second and the third");

    assert_eq!(methods(&logseq).len(), 2, "pages 2 and 3 made no LogSeq call");
    let read: Vec<String> = [first, second, third].iter().flat_map(uuids).collect();
    assert_eq!(read, all, "every block once, in order");
}

#[tokio::test]
async fn a_list_several_times_the_budget_is_read_to_the_end_by_the_budget_alone() {
    // 3 days of 100 blocks of about 400 characters: three times the budget, with a page size that never bites
    let days: Vec<Day> = (0..3).map(|n| flat_day(20250101 + n, 1000 * (n + 1), 100, 400)).collect();
    let all: Vec<String> = days.iter().flat_map(|day| day.blocks.iter().map(|spec| uuid(spec.id))).collect();
    let held = graph(days);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();

    let mut page = call(&logseq, &snapshots, with(period(), json!({"max_blocks": 1000}))).await.unwrap();
    let mut read = uuids(&page);
    let mut pages = 1;
    assert_eq!(page["warnings"][0]["code"], "result_size_truncated");
    while page.get("nextCursor").is_some() {
        assert_eq!(page["hasMore"], true);
        assert_eq!(page["warnings"].as_array().unwrap().last().unwrap()["howToFetchAll"], NEXT_PAGE);
        page = call(&logseq, &snapshots, json!({"cursor": cursor_of(&page)})).await.unwrap();
        read.extend(uuids(&page));
        pages += 1;
    }
    assert!(pages >= 3, "{pages} pages");
    assert_eq!(read, all, "every block once, none missing and none repeated");
    assert_eq!((page.get("hasMore").cloned(), page.get("warnings").cloned()), (None, None), "the last page says nothing");
    assert_eq!(methods(&logseq).len(), 2, "one read, however many pages");
}

// ---- a miss: the first page's calls, and no more

#[tokio::test]
async fn a_page_whose_snapshot_is_gone_costs_the_calls_the_first_page_made() {
    let (held, all) = four_days();
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), with(period(), json!({"max_blocks": 100}))).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);

    // a restarted server: no snapshot, and its own start time, so the key the cursor holds is nobody's
    let second = call(&logseq, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "the two queries again, and no more");
    assert_eq!(uuids(&second), all[100..200]);
    assert!(!codes(&second).contains(&"cursor_stale"), "the list did not move: {second}");
    assert!(second.get("summary").is_none());
    // the same arguments as the first page: the dates and the page size are in the token
    assert_eq!(args_of(&logseq, 2)[1..], args_of(&logseq, 0)[1..]);
}

#[tokio::test]
async fn a_snapshot_older_than_its_age_is_a_miss_that_reads_logseq_again() {
    let (held, all) = four_days();
    let logseq = logseq_holding(&held).await;
    // every snapshot is already too old when it is asked for
    let aged = Snapshots::with_limits(1_760_000_000_000, Limits { max_age: Duration::ZERO, ..Limits::STARTING });
    let first = call(&logseq, &aged, with(period(), json!({"max_blocks": 100}))).await.unwrap();
    let second = call(&logseq, &aged, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!((methods(&logseq).len(), uuids(&second)), (4, all[100..200].to_vec()));
}

#[tokio::test]
async fn a_miss_that_builds_a_snapshot_serves_the_next_page_from_it() {
    let (held, all) = four_days();
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), with(period(), json!({"max_blocks": 100}))).await.unwrap();
    // the second page is a miss in a new server, which keeps what it read; the third is a hit there
    let restarted = Snapshots::new(1_760_000_999_999);
    let second = call(&logseq, &restarted, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4);
    let third = call(&logseq, &restarted, json!({"cursor": cursor_of(&second)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "the page after a rebuild is read from the rebuilt snapshot");
    assert_eq!(uuids(&third), all[200..]);
}

#[tokio::test]
async fn a_cursor_of_another_set_of_arguments_is_not_served_from_a_snapshot_it_was_not_built_from() {
    let (held, _) = four_days();
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let first = call(&logseq, &snapshots, with(period(), json!({"max_blocks": 100}))).await.unwrap();
    // a token made for other arguments names the same snapshot key: the snapshot is not served to it
    let mut cursor = decode(&cursor_of(&first), explore_timeline::NAME).unwrap();
    cursor.args.insert("max_blocks".into(), json!(50));
    let second = call(&logseq, &snapshots, json!({"cursor": encode(&cursor)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "a miss: the arguments are not the ones the snapshot was built from");
    assert_eq!(block_count(&second), 50);
}

// ---- a list that moved between two pages

#[tokio::test]
async fn a_block_added_before_the_position_resumes_after_the_last_one_sent_and_says_so() {
    let (held, all) = four_days();
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), with(period(), json!({"max_blocks": 100}))).await.unwrap();
    // a new block at the top of the first day pushes everything one place on
    held.lock().unwrap()[0].blocks.insert(0, Spec { id: 5, parent: 20250101, left: 20250101, length: 10 });
    held.lock().unwrap()[0].blocks[1].left = 5;
    let second = call(&logseq, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(codes(&second)[0], "cursor_stale");
    assert!(second["warnings"][0]["message"].as_str().unwrap().contains("resumes right after it, so none is repeated"));
    assert_eq!(uuids(&second)[0], all[100], "the first block after the last one sent, none repeated");
}

#[tokio::test]
async fn a_last_block_that_is_gone_resumes_at_the_position_and_says_it_may_be_missing_or_repeated() {
    let (held, _) = four_days();
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), with(period(), json!({"max_blocks": 100}))).await.unwrap();
    // the last block the first page sent (the 100th, the 40th of the second day) is deleted
    {
        let mut days = held.lock().unwrap();
        let gone = days[1].blocks.remove(39);
        days[1].blocks[39].left = gone.left;
    }
    let second = call(&logseq, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(codes(&second)[0], "cursor_stale");
    assert!(second["warnings"][0]["message"].as_str().unwrap().contains("is gone"), "{}", second["warnings"][0]);
}

// ---- the edges of a page

#[tokio::test]
async fn a_list_exactly_at_the_page_size_has_no_cursor_and_one_more_block_has() {
    let held = graph(vec![flat_day(20250101, 1000, 200, 10)]);
    let logseq = logseq_holding(&held).await;
    let whole = call(&logseq, &snapshots(), period()).await.unwrap();
    assert_eq!(block_count(&whole), 200);
    assert_eq!((whole.get("nextCursor").cloned(), whole.get("warnings").cloned(), whole.get("hasMore").cloned()), (None, None, None), "{whole}");

    let held = graph(vec![flat_day(20250101, 1000, 201, 10)]);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let first = call(&logseq, &snapshots, period()).await.unwrap();
    assert_eq!(block_count(&first), 200);
    let last = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(uuids(&last), [uuid(1200)]);
    assert!(last.get("nextCursor").is_none());
}

#[tokio::test]
async fn a_page_size_of_zero_shows_nothing_has_no_cursor_and_offers_the_raise_alone() {
    let (held, _) = four_days();
    let logseq = logseq_holding(&held).await;
    let page = call(&logseq, &snapshots(), with(period(), json!({"max_blocks": 0}))).await.unwrap();
    assert_eq!(block_count(&page), 0);
    assert!(page.get("nextCursor").is_none(), "a cursor that does not move reads nothing on");
    // the raise is a way to fetch, but it is no cursor, so hasMore stays false
    assert_eq!(page["hasMore"], false);
    assert_eq!(page["warnings"][0]["howToFetchAll"], "Set max_blocks above 0 to read blocks.");
    assert_eq!(page["summary"]["totalBlocks"], 240);
}

#[tokio::test]
async fn a_block_over_the_budget_is_returned_alone_and_the_cursor_moves_past_it() {
    let mut day = flat_day(20250101, 1000, 3, 10);
    day.blocks[0].length = 40_000;
    let held = graph(vec![day]);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let first = call(&logseq, &snapshots, period()).await.unwrap();
    assert_eq!(uuids(&first), [uuid(1000)]);
    assert_eq!(first["warnings"][0]["code"], "result_size_truncated");
    assert!(first["warnings"][0]["message"].as_str().unwrap().contains("an entry is never cut inside its text"));
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(uuids(&second), [uuid(1001), uuid(1002)]);
    assert!(second.get("nextCursor").is_none());
}

#[tokio::test]
async fn a_page_that_starts_under_a_block_names_it_in_ancestors_and_a_cut_block_says_so() {
    // a day with one parent holding 5 children, then a sibling: places 0 (parent), 1 to 5 (children), 6 (sibling)
    let page = 20250101;
    let mut blocks = vec![Spec { id: 1, parent: page, left: page, length: 10 }];
    blocks.extend((0..5).map(|n| Spec { id: 10 + n, parent: 1, left: if n == 0 { 1 } else { 9 + n }, length: 10 }));
    blocks.push(Spec { id: 2, parent: page, left: 1, length: 10 });
    let held = graph(vec![Day { day: page, page, blocks }]);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let first = call(&logseq, &snapshots, with(period(), json!({"max_blocks": 3}))).await.unwrap();
    assert_eq!(uuids(&first), [uuid(1), uuid(10), uuid(11)]);
    assert_eq!(first["entries"][0]["blocks"][0]["childrenTruncated"], true);
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    // the next page starts with the children that were left out, each under the parent it sat under
    assert_eq!(uuids(&second), [uuid(12), uuid(13), uuid(14)]);
    let top = &second["entries"][0]["blocks"];
    assert_eq!(top[0]["ancestors"][0]["uuid"], uuid(1));
    assert!(top[0]["ancestors"][0]["snippet"].as_str().unwrap().starts_with("1 "));
    assert_eq!(top.as_array().unwrap().len(), 3);
    let third = call(&logseq, &snapshots, json!({"cursor": cursor_of(&second)})).await.unwrap();
    assert_eq!(uuids(&third), [uuid(2)]);
    assert!(third["entries"][0]["blocks"][0].get("ancestors").is_none(), "a block at the top level names no ancestor");
}

#[tokio::test]
async fn an_empty_period_has_no_cursor_and_the_days_with_no_block_are_each_on_one_page() {
    let held = graph(vec![flat_day(20250101, 1000, 0, 10), flat_day(20250102, 2000, 3, 10), flat_day(20250103, 3000, 0, 10)]);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let first = call(&logseq, &snapshots, with(period(), json!({"max_blocks": 2}))).await.unwrap();
    assert_eq!(dates(&first), [20250101, 20250102]);
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(dates(&second), [20250102, 20250103], "the empty day after the last block is on the last page");

    let empty = graph(vec![]);
    let logseq = logseq_holding(&empty).await;
    let none = call(&logseq, &snapshots, period()).await.unwrap();
    assert_eq!((none["entries"].clone(), none.get("nextCursor").cloned()), (json!([]), None));
}

#[tokio::test]
async fn the_outline_pages_by_top_level_blocks_and_a_cursor_keeps_the_arguments_it_was_made_with() {
    let (held, all) = four_days();
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let first = call(&logseq, &snapshots, with(period(), json!({"max_blocks": 100, "include_content": false}))).await.unwrap();
    assert_eq!(first["entries"][0]["blockCount"], 60);
    assert_eq!(first["entries"][1]["blockCount"], 40);
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    // the token holds include_content: false, so the page is an outline too, and the day cut between them is on both
    assert_eq!(second["entries"][0]["date"], 20250102);
    assert_eq!(second["entries"][0]["blockCount"], 20);
    assert_eq!(all.len(), 240);
}

#[tokio::test]
async fn resolve_refs_runs_over_the_blocks_of_the_page_sent_and_no_others() {
    let day = flat_day(20250101, 1000, 4, 10);
    let held = graph(vec![day]);
    let target = uuid(777);
    let graph_for_answers = Arc::clone(&held);
    let logseq = mock_logseq_answering(move |request| {
        let days = graph_for_answers.lock().unwrap();
        if is_journals(request) {
            Value::Array(days.iter().map(page_row).collect())
        } else if is_blocks(request) {
            // every block holds a ref to the same target
            Value::Array(
                days.iter()
                    .flat_map(|day| {
                        day.blocks
                            .iter()
                            .map(|spec| {
                                let mut row = block_row(day, spec);
                                row[0]["content"] = json!(format!("see (({})) {}", uuid(777), spec.id));
                                row
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect()
            )
        } else {
            json!([[{"id": 777, "uuid": uuid(777), "content": "the target", "page": {"id": 5}}]])
        }
    })
    .await;
    let snapshots = snapshots();
    let first = call(&logseq, &snapshots, with(period(), json!({"max_blocks": 2, "resolve_refs": true}))).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3, "the two queries, and one level of refs for the two blocks of the page");
    assert!(first["entries"][0]["blocks"][0]["resolvedContent"].as_str().unwrap().contains("the target"), "{first}");
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "a hit: one level of refs for the two blocks of this page, no query for the list");
    assert!(second["entries"][0]["blocks"][1]["resolvedContent"].as_str().unwrap().contains("the target"));
    assert_eq!(target, uuid(777));
}

// ---- a period given as last_n or a preset is stored as dates

#[tokio::test]
async fn a_last_n_period_is_stored_as_dates_so_a_page_read_a_month_later_reads_the_same_days_newest_first() {
    let days: Vec<Day> = [20250312, 20250311, 20250310].iter().enumerate().map(|(n, day)| flat_day(*day, 1000 * (n as i64 + 1), 30, 10)).collect();
    let logseq = logseq_holding(&graph(days)).await;
    let first = call_with(NOW, &logseq, &snapshots(), json!({"last_n": 3, "max_blocks": 40})).await.unwrap();
    assert_eq!(dates(&first), [20250312, 20250311], "newest day first");
    let token = decode(&cursor_of(&first), explore_timeline::NAME).unwrap();
    assert!(token.args.get("last_n").is_none() && token.args.get("preset").is_none(), "{:?}", token.args);
    // the three days ending today, whatever time zone the test runs in
    let (start, end) = (token.args["start_date"].as_i64().unwrap(), token.args["end_date"].as_i64().unwrap());
    assert_eq!(end - start, 2);
    assert_eq!(args_of(&logseq, 0)[1..], [json!(start.to_string()), json!(end.to_string())]);

    // a restarted server a month later: the same window, in the same order
    let second = call_with(LATER, &logseq, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(args_of(&logseq, 2)[1..], args_of(&logseq, 0)[1..], "the days the first page asked for");
    assert_eq!(dates(&second), [20250311, 20250310]);
    assert_eq!(uuids(&second)[0], uuid(2010), "the 41st block: 30 of the first day and 10 of the second were sent");
}

#[tokio::test]
async fn a_page_with_mentions_costs_its_resolver_and_reads_again_on_a_miss_and_nothing_on_a_hit() {
    let root = json!([[{"id": 10, "uuid": uuid(10), "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 5010}}, "name"]]);
    let tree = json!([{"id": 101, "uuid": uuid(101), "content": "On the page", "page": {"id": 10}}]);
    let page = json!({"id": 10, "name": "project atlas", "originalName": "Project Atlas"});
    let mention = |id: i64, day: i64| json!([{"id": id, "uuid": uuid(id), "content": "Mentions [[Project Atlas]]", "page": {"id": 30 + id, "name": format!("day {day}"), "original-name": format!("Day {day}"), "journal-day": day}}]);
    let mentions = json!([mention(201, 20250301), mention(202, 20250302), mention(203, 20250303)]);
    let again = vec![root.clone(), tree.clone(), page.clone(), mentions.clone()];
    let logseq = mock_logseq(again.iter().cloned().chain(again.iter().cloned()).collect()).await;
    let snapshots = snapshots();
    // 4 blocks: the page's own, then three days; a page of 2 holds the first two entries in the order of the list
    let first = call(&logseq, &snapshots, json!({"page": "Project Atlas", "max_blocks": 2})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4);
    assert_eq!(first["page"], "Project Atlas");
    assert_eq!(dates(&first), [20250301, 20250302]);
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "a hit makes no call, not even the resolver");
    assert_eq!(second["page"], "Project Atlas", "the frame is kept small and on every page");
    assert_eq!(dates(&second), [20250303, 0], "the day, then the blocks with no day");
    // the same page, read after the snapshot is gone: the four calls of the first page again
    let third = call(&logseq, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 8);
    assert_eq!(uuids(&third), uuids(&second));
}

// ---- refusals, before any call

#[tokio::test]
async fn a_cursor_with_any_other_argument_is_refused_before_any_call() {
    let logseq = mock_logseq(vec![]).await;
    for other in [("page", json!("x")), ("start_date", json!(20250101)), ("last_n", json!(3)), ("max_blocks", json!(5)), ("group_by", json!("week")), ("resolve_refs", json!(true))] {
        let error = call(&logseq, &snapshots(), json!({"cursor": "abc", other.0: other.1})).await.unwrap_err();
        let ToolError::InvalidParameter(error) = error else { panic!("{error}") };
        assert_eq!(error.param, other.0);
        assert!(error.expected.starts_with("left out when cursor is given"), "{error}");
    }
    assert!(methods(&logseq).is_empty());
}

#[tokio::test]
async fn a_token_that_is_not_a_cursor_of_this_tool_is_refused_before_any_call() {
    let logseq = mock_logseq(vec![]).await;
    let key = SnapshotKey { started: 1, n: 1 };
    let made = |tool: &str, args: Value, position: Position| encode(&Cursor::new(tool, args.as_object().cloned().unwrap(), position, Anchor::Text("u".into()), key));
    let ok_args = json!({"start_date": 20250101, "end_date": 20250131});
    let at = Position::Index { at: 3 };
    let tokens = [
        ("not a token!".to_owned(), "not base64url text"),
        (made("logseq_find_blocks", ok_args.clone(), at.clone()), "made by another tool"),
        (made(explore_timeline::NAME, ok_args.clone(), Position::Sections { blocks: 1, references: 1, related: 1 }), "not one block"),
        (made(explore_timeline::NAME, json!({"last_n": 3}), at.clone()), "not a timeline this tool reads"),
        (made(explore_timeline::NAME, json!({"preset": "today"}), at.clone()), "not a timeline this tool reads"),
        (made(explore_timeline::NAME, json!({"max_blocks": 5}), at.clone()), "not a timeline this tool reads"),
        (made(explore_timeline::NAME, json!({"start_date": "x", "end_date": 1}), at.clone()), "not a timeline this tool reads"),
        (made(explore_timeline::NAME, json!({"start_date": 20250101}), at.clone()), "not a timeline this tool reads"),
        (made(explore_timeline::NAME, json!({"start_date": 20250131, "end_date": 20250101}), at.clone()), "not a timeline this tool reads"),
        (made(explore_timeline::NAME, json!({"page": "  "}), at.clone()), "not a timeline this tool reads"),
        (made(explore_timeline::NAME, json!({"page": "a", "cursor": "again"}), at.clone()), "not a timeline this tool reads"),
        (made(explore_timeline::NAME, json!({"start_date": 20250101, "end_date": 20250131, "newest_first": "yes"}), at.clone()), "not a timeline this tool reads"),
        (made(explore_timeline::NAME, json!({"start_date": 20250101, "end_date": 20250131, "newest_first": 1}), at), "not a timeline this tool reads"),
    ];
    for (token, reason) in tokens {
        let error = call(&logseq, &snapshots(), json!({"cursor": token})).await.unwrap_err();
        let ToolError::InvalidParameter(error) = error else { panic!("{error}") };
        assert!(error.param == "cursor" && error.expected.contains(reason), "{reason}: {error}");
    }
    // an unknown version
    let mut payload = serde_json::to_value(Cursor::new(explore_timeline::NAME, ok_args.as_object().cloned().unwrap(), Position::Index { at: 0 }, Anchor::Id(1), key)).unwrap();
    payload["v"] = json!(2);
    use base64::Engine;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string());
    let error = call(&logseq, &snapshots(), json!({"cursor": token})).await.unwrap_err();
    assert!(error.to_string().contains("version this server doesn't read"), "{error}");
    assert!(methods(&logseq).is_empty());
}

#[tokio::test]
async fn an_infrastructure_error_on_a_miss_is_the_error_of_the_call_and_never_an_empty_page() {
    let (held, _) = four_days();
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), with(period(), json!({"max_blocks": 100}))).await.unwrap();
    // a LogSeq that answers nothing: the rebuild fails, and the failure is the answer
    let down = mock_logseq(vec![]).await;
    let error = call(&down, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&first)})).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn a_week_cut_between_two_pages_has_the_same_period_on_both_and_every_block_once() {
    // 2025-01-06 and 2025-01-07 are in one week, 2025-01-15 in a later one: pages of 70 cut the first week
    let days = vec![flat_day(20250106, 1000, 60, 10), flat_day(20250107, 2000, 60, 10), flat_day(20250115, 3000, 20, 10)];
    let all: Vec<String> = days.iter().flat_map(|day| day.blocks.iter().map(|spec| uuid(spec.id))).collect();
    let logseq = logseq_holding(&graph(days)).await;
    let snapshots = snapshots();
    let first = call(&logseq, &snapshots, with(period(), json!({"max_blocks": 70, "group_by": "week"}))).await.unwrap();
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    let periods = |page: &Value| page["entries"].as_array().unwrap().iter().map(|entry| entry["period"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(periods(&first), ["2025-W01"]);
    assert_eq!(periods(&second), ["2025-W01", "2025-W03"], "the week cut between the pages is on both");
    assert!(second.get("nextCursor").is_none(), "70 and 70 of 140 blocks: the second page is the last");
    let mut read = uuids(&first);
    read.extend(uuids(&second));
    assert_eq!(read, all, "every block once");
    assert_eq!(methods(&logseq).len(), 2, "the week grouping costs no call");
    // the same for a month
    let month = call(&logseq, &snapshots, with(period(), json!({"max_blocks": 70, "group_by": "month"}))).await.unwrap();
    let next = call(&logseq, &snapshots, json!({"cursor": cursor_of(&month)})).await.unwrap();
    assert_eq!((month["entries"][0]["period"].clone(), next["entries"][0]["period"].clone()), (json!("202501"), json!("202501")));
}

#[tokio::test]
async fn a_page_after_the_first_carries_no_tip_block() {
    let (held, _) = four_days();
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let blocks = |result: &rmcp::model::CallToolResult| serde_json::to_value(result).unwrap()["content"].as_array().unwrap().len();
    // every block links one page, so the roll-up has a top concept and the first page a tip
    let first = explore_timeline::call(&client(&logseq), true, NOW, &snapshots, arguments(with(period(), json!({"max_blocks": 100})))).await.unwrap();
    assert_eq!(blocks(&first), 2, "the first page has its tip");
    let text = serde_json::to_value(&first).unwrap()["content"][0]["text"].as_str().unwrap().to_owned();
    let cursor = serde_json::from_str::<Value>(&text).unwrap()["nextCursor"].as_str().unwrap().to_owned();
    let second = explore_timeline::call(&client(&logseq), true, NOW, &snapshots, arguments(json!({"cursor": cursor}))).await.unwrap();
    assert_eq!(blocks(&second), 1, "one content block: the result, with no tip");
}
