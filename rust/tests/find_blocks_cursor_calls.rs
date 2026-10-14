//! The cursor of `logseq_find_blocks` (ADR-0038) through its `call`, against a mock LogSeq on a local port: what a page
//! read from a snapshot costs (no call), what a page read after the snapshot is gone costs (the first page's calls,
//! and no more), how a list that moved between two pages is resumed, and what a bad token or a cursor with another
//! argument gets before any call. Every page and block here is made up (BR-0001).

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MockLogseq, client, methods, mock_logseq, mock_logseq_answering, uuid};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode};
use logseq_mcp_server::dates::Clock;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::snapshots::{Limits, Snapshots};
use logseq_mcp_server::tools::find_blocks;
use serde_json::{Value, json};

/// 2025-03-12T03:30:00Z, the instant the parity harness reads as now.
const NOW: Clock = Clock::Fixed(1_741_750_200_000);

const DATALOG: &str = "logseq.DB.datascriptQuery";
const NEXT_PAGE: &str = "Pass nextCursor as cursor, with no other argument, to read the next page.";

/// The search the finder runs with no page named.
fn is_search(request: &Value) -> bool {
    request["args"][0].as_str().is_some_and(|query| query.starts_with("[:find (pull ?b [* {:block/page"))
}

/// A hit as a row of the search, on page 6 for the ids above 150 and page 5 for the others.
fn hit_row(id: i64, length: usize) -> Value {
    let page = if id > 150 { 6 } else { 5 };
    json!([{"id": id, "uuid": uuid(id), "content": format!("mentions the importer {}", "x".repeat(length)), "page": {"id": page, "name": format!("page {page}"), "original-name": format!("Page {page}")}}])
}

/// What LogSeq holds: the ids of the matching blocks, which a test changes between two pages.
type Graph = Arc<Mutex<Vec<(i64, usize)>>>;

fn graph(ids: impl IntoIterator<Item = i64>, length: usize) -> Graph {
    Arc::new(Mutex::new(ids.into_iter().map(|id| (id, length)).collect()))
}

/// A LogSeq that answers the search with the blocks of `graph`, and a page lookup with both pages.
async fn logseq_holding(graph: &Graph) -> MockLogseq {
    let graph = Arc::clone(graph);
    mock_logseq_answering(move |request| {
        if is_search(request) {
            Value::Array(graph.lock().unwrap().iter().map(|(id, length)| hit_row(*id, *length)).collect())
        } else {
            json!([[{"id": 5, "name": "page 5", "original-name": "Page 5"}], [{"id": 6, "name": "page 6", "original-name": "Page 6"}]])
        }
    })
    .await
}

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

/// The results and the meta of a call.
async fn call(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<(Vec<Value>, Value), ToolError> {
    let result = find_blocks::call(&client(logseq), true, NOW, snapshots, arguments(args)).await?;
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    let (results, meta) = (content[0]["text"].as_str().unwrap(), content[1]["text"].as_str().unwrap());
    assert!(size(results) + size(meta) <= BUDGET_CHARS || serde_json::from_str::<Vec<Value>>(results).unwrap().len() == 1, "a page is over the budget");
    Ok((serde_json::from_str(results).unwrap(), serde_json::from_str::<Value>(meta).unwrap()["meta"].clone()))
}

fn uuids(results: &[Value]) -> Vec<String> {
    results.iter().map(|hit| hit["uuid"].as_str().unwrap().to_owned()).collect()
}

fn cursor_of(meta: &Value) -> String {
    meta["nextCursor"].as_str().expect("a page that leaves hits has a nextCursor").to_owned()
}

fn snapshots() -> Snapshots {
    Snapshots::new(1_760_000_000_000)
}

/// The searches a mock saw.
fn searches(logseq: &MockLogseq) -> usize {
    logseq.seen.lock().unwrap().iter().filter(|request| is_search(request)).count()
}

// ---- a hit: the later pages cost nothing

#[tokio::test]
async fn the_pages_after_the_first_are_read_from_the_snapshot_and_make_no_call() {
    let held = graph(1..=250, 100);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();

    let (first, meta) = call(&logseq, &snapshots, json!({"text": "importer"})).await.unwrap();
    assert_eq!(first.len(), 100);
    assert_eq!((meta["hasMore"].clone(), meta["totals"]["matches"].clone()), (json!(true), json!(250)));
    assert_eq!(meta["warnings"][0]["code"], "results_truncated");
    assert_eq!(methods(&logseq), [DATALOG], "the first page is the one search");

    // the graph changes under the pages: a hit page still shows the list as the first page read it
    held.lock().unwrap().clear();
    let (second, meta) = call(&logseq, &snapshots, json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!(second.len(), 100);
    assert_eq!(meta["warnings"][0]["message"], "Showing 101-200 of 250 matching blocks.");
    assert_eq!(meta["warnings"][0]["howToFetchAll"], NEXT_PAGE);
    assert_eq!(meta["hasMore"], true);

    let (third, meta) = call(&logseq, &snapshots, json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!(third.len(), 50);
    // the last page is complete: no cursor, no warning, hasMore false
    assert_eq!((meta["hasMore"].clone(), meta["warnings"].clone()), (json!(false), json!([])));
    assert!(meta.get("nextCursor").is_none());
    assert_eq!(meta["totals"]["matches"], 250);

    assert_eq!(methods(&logseq), [DATALOG], "pages 2 and 3 made no LogSeq call");
    let all: Vec<String> = [first, second, third].iter().flat_map(|page| uuids(page)).collect();
    assert_eq!(all, (1..=250).rev().map(uuid).collect::<Vec<_>>(), "every hit once, newest first");
}

#[tokio::test]
async fn context_is_read_for_the_hits_of_the_page_it_is_sent_with_and_no_other() {
    let held = graph(1..=250, 100);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let (first, meta) = call(&logseq, &snapshots, json!({"text": "importer", "limit": 100, "include_context": true})).await.unwrap();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG], "the search and one page lookup");
    // the first page holds ids 250 to 151, all on page 6
    assert!(first.iter().all(|hit| hit["context"]["page"]["originalName"] == "Page 6"));
    assert_eq!(logseq.seen.lock().unwrap()[1]["args"][0], "[:find (pull ?p [*]) :where [(ground [6]) [?p ...]] [?p :block/name]]");

    // the second holds 150 to 51, all on page 5: one more call, for those hits' page, and no search
    let (second, meta) = call(&logseq, &snapshots, json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, DATALOG]);
    assert_eq!(searches(&logseq), 1);
    assert_eq!(logseq.seen.lock().unwrap()[2]["args"][0], "[:find (pull ?p [*]) :where [(ground [5]) [?p ...]] [?p :block/name]]");
    assert!(second.iter().all(|hit| hit["context"]["page"]["originalName"] == "Page 5"));

    // the third holds ids 50 to 1, also page 5, and the last page has no cursor
    let (third, meta) = call(&logseq, &snapshots, json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!((methods(&logseq).len(), third.len(), meta.get("nextCursor").is_none()), (4, 50, true));
}

// ---- a miss: the first page's calls, and no more

#[tokio::test]
async fn a_page_whose_snapshot_is_gone_costs_the_calls_the_first_page_made() {
    let held = graph(1..=250, 100);
    let logseq = logseq_holding(&held).await;
    let (first, meta) = call(&logseq, &snapshots(), json!({"text": "importer", "include_context": true})).await.unwrap();
    let first_page_calls = methods(&logseq).len();
    assert_eq!(first_page_calls, 2);

    // a restarted server: no snapshot, and its own start time, so the key the cursor holds is nobody's
    let (second, meta) = call(&logseq, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), first_page_calls * 2, "the search and the page lookup again, and no more");
    assert_eq!(second.len(), 100);
    assert!(meta["warnings"].as_array().unwrap().iter().all(|warning| warning["code"] != "cursor_stale"), "the list did not move: {meta}");
    assert_eq!(uuids(&second)[0], uuid(150));
    assert!(uuids(&first).iter().all(|uuid| !uuids(&second).contains(uuid)));
}

#[tokio::test]
async fn a_snapshot_older_than_its_age_is_a_miss_that_reads_logseq_again() {
    let held = graph(1..=250, 100);
    let logseq = logseq_holding(&held).await;
    // every snapshot is already too old when it is asked for
    let aged = Snapshots::with_limits(1_760_000_000_000, Limits { max_age: Duration::ZERO, ..Limits::STARTING });
    let (_, meta) = call(&logseq, &aged, json!({"text": "importer"})).await.unwrap();
    let (second, _) = call(&logseq, &aged, json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!((searches(&logseq), second.len()), (2, 100), "the second page read LogSeq again, with the first page's one call");
}

#[tokio::test]
async fn a_miss_that_builds_a_snapshot_serves_the_next_page_from_it() {
    let held = graph(1..=250, 100);
    let logseq = logseq_holding(&held).await;
    let (_, meta) = call(&logseq, &snapshots(), json!({"text": "importer"})).await.unwrap();
    // the second page is a miss in a new server, which keeps what it read; the third is a hit there
    let restarted = Snapshots::new(1_760_000_999_999);
    let (_, meta) = call(&logseq, &restarted, json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!(searches(&logseq), 2);
    let (third, _) = call(&logseq, &restarted, json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!(searches(&logseq), 2, "the page after a rebuild is read from the rebuilt snapshot");
    assert_eq!(uuids(&third)[0], uuid(50));
}

#[tokio::test]
async fn naming_a_page_costs_its_resolver_again_on_a_miss_and_nothing_on_a_hit() {
    let resolver = |request: &Value| request["args"][0].as_str().is_some_and(|query| query.contains(":in $ ?n :where (or-join [?n ?page ?via]"));
    let logseq = mock_logseq_answering(move |request| {
        if resolver(request) {
            json!([[{"id": 10, "name": "atlas", "original-name": "Atlas", "file": {"id": 5010}}, "name"]])
        } else {
            Value::Array((1..=250).map(|id| hit_row(id, 100)).collect())
        }
    })
    .await;
    let snapshots = snapshots();
    let (_, meta) = call(&logseq, &snapshots, json!({"page": "Atlas"})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2, "the resolver, then the search");
    let (_, meta) = call(&logseq, &snapshots, json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2, "a hit resolves nothing");
    // a miss resolves the page again, as the first page did
    let (_, _) = call(&logseq, &Snapshots::new(3), json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4);
}

// ---- a list that moved between the pages

/// The first page of a search of 100 hits, limit 30: ids 100 down to 71, with a cursor to the hit of id 70.
async fn first_page_of_100(logseq: &MockLogseq) -> String {
    let (first, meta) = call(logseq, &snapshots(), json!({"text": "importer", "limit": 30})).await.unwrap();
    assert_eq!((first.len(), uuids(&first)[29].clone()), (30, uuid(71)));
    cursor_of(&meta)
}

fn warning_codes(meta: &Value) -> Vec<String> {
    meta["warnings"].as_array().unwrap().iter().map(|warning| warning["code"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn a_list_that_gained_a_newer_hit_resumes_after_the_last_hit_sent_with_no_repeat_and_says_so() {
    let held = graph((1..=100).rev(), 100);
    let logseq = logseq_holding(&held).await;
    let cursor = first_page_of_100(&logseq).await;

    // a block newer than every other matches now: every position moved by one
    held.lock().unwrap().insert(0, (101, 100));
    let (second, meta) = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    assert_eq!(uuids(&second)[0], uuid(70), "the page resumes by block id, not by position: 71 is not sent again");
    assert_eq!(warning_codes(&meta)[0], "cursor_stale");
    assert!(meta["warnings"][0]["message"].as_str().unwrap().contains("resumes right after it, so none is repeated"));
    assert_eq!(meta["totals"]["matches"], 101);
}

#[tokio::test]
async fn a_list_that_lost_a_hit_it_had_shown_or_the_anchor_itself_loses_none_of_the_rest() {
    for removed in [90, 71] {
        let held = graph((1..=100).rev(), 100);
        let logseq = logseq_holding(&held).await;
        let cursor = first_page_of_100(&logseq).await;
        held.lock().unwrap().retain(|(id, _)| *id != removed);
        let (second, meta) = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
        assert_eq!(uuids(&second)[0], uuid(70), "removed {removed}: the first hit after the last one sent");
        assert_eq!(second.len(), 30);
        assert_eq!(warning_codes(&meta)[0], "cursor_stale", "removed {removed}");
    }
}

#[tokio::test]
async fn a_list_that_shrank_below_the_position_is_an_empty_page_and_not_an_error() {
    let held = graph((1..=100).rev(), 100);
    let logseq = logseq_holding(&held).await;
    let cursor = first_page_of_100(&logseq).await;
    *held.lock().unwrap() = vec![(100, 100), (99, 100)];
    let (second, meta) = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    assert!(second.is_empty());
    assert_eq!(warning_codes(&meta), ["cursor_stale"]);
    assert!(meta.get("nextCursor").is_none());
    assert_eq!(meta["totals"]["matches"], 2);
}

// ---- the whole list, page after page

async fn read_to_the_end(logseq: &MockLogseq, snapshots: impl Fn() -> Snapshots, args: Value) -> (Vec<String>, usize) {
    let (mut all, mut pages) = (Vec::new(), 0);
    let (results, mut meta) = call(logseq, &snapshots(), args).await.unwrap();
    all.extend(uuids(&results));
    pages += 1;
    while meta.get("nextCursor").is_some() {
        assert!(pages < 100, "a cursor that never ends");
        assert_eq!(meta["hasMore"], true);
        let (results, next) = call(logseq, &snapshots(), json!({"cursor": cursor_of(&meta)})).await.unwrap();
        assert!(!results.is_empty(), "a page with a cursor to read on after it holds a hit");
        all.extend(uuids(&results));
        meta = next;
        pages += 1;
    }
    assert_eq!(meta["hasMore"], false);
    (all, pages)
}

#[tokio::test]
async fn a_list_several_times_the_budget_is_read_to_the_end_with_every_hit_once_through_the_snapshot() {
    // 300 hits of ~650 characters: ~195,000 characters, so the 30,000-character budget makes several pages
    let held = graph(1..=300, 600);
    let logseq = logseq_holding(&held).await;
    let shared = Snapshots::new(1_760_000_000_000);
    let (all, pages) = read_to_the_end(&logseq, || Snapshots::new(1_760_000_000_000), json!({"text": "importer", "limit": 500})).await;
    // one Snapshots per page above is a miss every time; the shared one is the hit path
    assert_eq!(all, (1..=300).rev().map(uuid).collect::<Vec<_>>());
    assert!(pages > 4, "{pages}");
    assert_eq!(searches(&logseq), pages, "a miss costs the first page's one search, once a page");

    let hit_logseq = logseq_holding(&held).await;
    let (first, mut meta) = call(&hit_logseq, &shared, json!({"text": "importer", "limit": 500})).await.unwrap();
    let mut seen = uuids(&first);
    let mut hit_pages = 1;
    while meta.get("nextCursor").is_some() {
        let (results, next) = call(&hit_logseq, &shared, json!({"cursor": cursor_of(&meta)})).await.unwrap();
        seen.extend(uuids(&results));
        meta = next;
        hit_pages += 1;
    }
    assert_eq!(seen, all, "a hit page and a miss page read the same list");
    assert_eq!(hit_pages, pages);
    assert_eq!(methods(&hit_logseq), [DATALOG], "the pages after the first made no call");
}

#[tokio::test]
async fn a_hit_over_the_budget_is_returned_alone_and_the_cursor_moves_past_it() {
    // the newest hit is 40,000 characters; the two after it are small
    let held: Graph = Arc::new(Mutex::new(vec![(3, 40_000), (2, 10), (1, 10)]));
    let logseq = logseq_holding(&held).await;
    let shared = snapshots();
    let (first, meta) = call(&logseq, &shared, json!({"text": "importer"})).await.unwrap();
    assert_eq!(uuids(&first), [uuid(3)]);
    assert_eq!(meta["warnings"][0]["code"], "result_size_truncated");
    assert!(meta["warnings"][0]["message"].as_str().unwrap().contains("Even those are over that size"));
    let (second, meta) = call(&logseq, &shared, json!({"cursor": cursor_of(&meta)})).await.unwrap();
    assert_eq!(uuids(&second), [uuid(2), uuid(1)]);
    assert!(meta.get("nextCursor").is_none() && meta["hasMore"] == false);
}

#[tokio::test]
async fn a_list_exactly_at_the_limit_has_no_cursor_and_one_more_hit_has_one() {
    for (hits, cursor) in [(100, false), (101, true)] {
        let held = graph(1..=hits, 20);
        let logseq = logseq_holding(&held).await;
        let (results, meta) = call(&logseq, &snapshots(), json!({"text": "importer", "limit": 100})).await.unwrap();
        assert_eq!(results.len(), 100);
        assert_eq!(meta.get("nextCursor").is_some(), cursor, "{hits} matches");
        assert_eq!(meta["hasMore"], cursor);
        assert_eq!(meta["warnings"].as_array().unwrap().len(), usize::from(cursor));
    }
}

#[tokio::test]
async fn nothing_to_find_and_a_limit_of_zero_have_no_cursor() {
    let empty = graph([], 20);
    let logseq = logseq_holding(&empty).await;
    let (results, meta) = call(&logseq, &snapshots(), json!({"text": "importer"})).await.unwrap();
    assert!(results.is_empty() && meta.get("nextCursor").is_none());
    assert_eq!(meta["hasMore"], false);

    let held = graph(1..=5, 20);
    let logseq = logseq_holding(&held).await;
    let (results, meta) = call(&logseq, &snapshots(), json!({"text": "importer", "limit": 0})).await.unwrap();
    assert!(results.is_empty());
    assert_eq!(meta["hasMore"], false);
    assert!(meta.get("nextCursor").is_none(), "a cursor that does not move would read nothing on");
    assert_eq!(meta["warnings"][0]["code"], "results_truncated");
}

// ---- what a token may be

#[tokio::test]
async fn a_token_that_is_not_one_of_this_tools_is_refused_before_any_call() {
    let held = graph(1..=5, 20);
    let logseq = logseq_holding(&held).await;
    let args = json!({"text": "x", "limit": 100, "include_context": false, "slim_results": true});
    let cursor = |change: &dyn Fn(&mut Cursor)| {
        let mut cursor = Cursor::new(find_blocks::NAME, args.as_object().cloned().unwrap(), Position::Index { at: 1 }, Anchor::Id(5), SnapshotKey { started: 1, n: 1 });
        change(&mut cursor);
        encode(&cursor)
    };
    let tokens = [
        ("not base64", "this is not a cursor".to_owned()),
        ("base64 of text", "bm90IGEgY3Vyc29y".to_owned()),
        ("an empty one", String::new()),
        ("another tool's", cursor(&|cursor| cursor.tool = "logseq_find_pages".to_owned())),
        ("an unknown version", cursor(&|cursor| cursor.v = 2)),
        ("sections position", cursor(&|cursor| cursor.position = Position::Sections { blocks: 1, references: 0, related: 0 })),
        ("a text anchor", cursor(&|cursor| cursor.anchor = Anchor::Text("a".into()))),
        ("arguments no search takes", cursor(&|cursor| cursor.args = json!({"limit": "many"}).as_object().cloned().unwrap())),
        ("arguments with no filter", cursor(&|cursor| cursor.args = json!({"limit": 5}).as_object().cloned().unwrap())),
    ];
    for (what, token) in tokens {
        let error = call(&logseq, &snapshots(), json!({"cursor": token})).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == "cursor"), "{what}: {error}");
        assert!(error.to_string().starts_with("Invalid parameter 'cursor': "), "{what}: {error}");
    }
    assert!(methods(&logseq).is_empty(), "a bad token costs no LogSeq call");
    // a cursor of this tool is read: the same call, but well formed, reads a page
    let good = cursor(&|_| {});
    assert!(call(&logseq, &snapshots(), json!({"cursor": good})).await.is_ok());
}

#[tokio::test]
async fn a_cursor_with_any_other_argument_is_refused_before_any_call_and_names_it() {
    let held = graph(1..=5, 20);
    let logseq = logseq_holding(&held).await;
    let (_, meta) = call(&logseq, &snapshots(), json!({"text": "importer", "limit": 2})).await.unwrap();
    let cursor = cursor_of(&meta);
    let calls = methods(&logseq).len();
    for (param, value) in [
        ("text", json!("importer")),
        ("page", json!("Atlas")),
        ("links_to", json!(["Alice"])),
        ("property", json!("status")),
        ("value", json!("doing")),
        ("start_date", json!(20250101)),
        ("end_date", json!(20250107)),
        ("last_n", json!(7)),
        ("preset", json!("today")),
        ("limit", json!(100)),
        ("include_context", json!(false)),
        ("slim_results", json!(true)),
    ] {
        let mut args = json!({"cursor": cursor});
        args[param] = value;
        let error = call(&logseq, &snapshots(), args).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == param), "{param}: {error}");
        assert!(error.to_string().contains("left out when cursor is given"), "{param}: {error}");
    }
    assert_eq!(methods(&logseq).len(), calls, "a refusal costs no call");
    // a null is no argument, and an unknown field is ignored, as everywhere
    assert!(call(&logseq, &snapshots(), json!({"cursor": cursor, "text": null, "offset": 3})).await.is_ok());
}

#[tokio::test]
async fn a_snapshot_is_never_served_to_a_token_that_holds_other_arguments() {
    let held = graph(1..=250, 100);
    let logseq = logseq_holding(&held).await;
    let shared = snapshots();
    let (_, meta) = call(&logseq, &shared, json!({"text": "importer"})).await.unwrap();
    // the same snapshot key, with the search changed in the token: it is a miss, never the other list
    let mut cursor = decode(&cursor_of(&meta), find_blocks::NAME).unwrap();
    cursor.args.insert("text".into(), json!("another"));
    let (_, _) = call(&logseq, &shared, json!({"cursor": encode(&cursor)})).await.unwrap();
    assert_eq!(searches(&logseq), 2, "the other search read LogSeq");
}

#[tokio::test]
async fn the_snapshot_key_of_another_process_is_a_miss_and_a_page_is_still_read() {
    let held = graph(1..=250, 100);
    let logseq = logseq_holding(&held).await;
    let (_, meta) = call(&logseq, &snapshots(), json!({"text": "importer"})).await.unwrap();
    let mut cursor = decode(&cursor_of(&meta), find_blocks::NAME).unwrap();
    cursor.snapshot = SnapshotKey { started: 5, n: 1 };
    let (second, _) = call(&logseq, &snapshots(), json!({"cursor": encode(&cursor)})).await.unwrap();
    assert_eq!((searches(&logseq), second.len()), (2, 100));
}

// ---- errors

#[tokio::test]
async fn a_logseq_error_on_a_miss_is_an_error_and_not_an_empty_page() {
    // nothing answers: the call fails, as the first page would
    let logseq = mock_logseq(vec![]).await;
    let cursor = encode(&Cursor::new(
        find_blocks::NAME,
        json!({"text": "importer", "limit": 100, "include_context": false, "slim_results": true}).as_object().cloned().unwrap(),
        Position::Index { at: 100 },
        Anchor::Id(151),
        SnapshotKey { started: 1, n: 1 },
    ));
    let error = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn a_null_answer_on_a_miss_is_the_unavailable_warning_with_no_cursor() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let cursor = encode(&Cursor::new(
        find_blocks::NAME,
        json!({"text": "importer", "limit": 100, "include_context": false, "slim_results": true}).as_object().cloned().unwrap(),
        Position::Index { at: 100 },
        Anchor::Id(151),
        SnapshotKey { started: 1, n: 1 },
    ));
    let (results, meta) = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    assert!(results.is_empty());
    assert_eq!(warning_codes(&meta), ["search_unavailable"]);
    assert_eq!((meta["hasMore"].clone(), meta.get("nextCursor").is_none()), (json!(false), true));
}
