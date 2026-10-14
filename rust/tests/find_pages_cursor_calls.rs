//! The cursor of `logseq_find_pages` (ADR-0038, #551) through its `call`, against a mock LogSeq on a local port: what a page
//! read from a snapshot costs (no call), what a page read after the snapshot is gone costs (the one `getAllPages` call
//! the first page made, and no more), how a list that moved between two pages is resumed, what a bad token or a cursor
//! with another argument gets before any call, and that a list several times the budget is read to the end with every
//! page once, in JSON and in TOON. Every page and name here is made up (BR-0001).

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MockLogseq, client, methods, mock_logseq, mock_logseq_answering};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::snapshots::{Limits, Snapshots};
use logseq_mcp_server::tools::find_pages;
use serde_json::{Value, json};

const ALL_PAGES: &str = "logseq.Editor.getAllPages";
const NEXT_PAGE: &str = "Pass nextCursor as cursor, with no other argument, to read the next page.";

/// What LogSeq holds: the names of the pages, which a test changes between two pages.
type Graph = Arc<Mutex<Vec<String>>>;

/// `count` pages named by their number and `length` more characters.
fn graph(count: usize, length: usize) -> Graph {
    Arc::new(Mutex::new((0..count).map(|n| name_of(n, length)).collect()))
}

fn name_of(n: usize, length: usize) -> String {
    format!("Page {n:04} {}", "p".repeat(length))
}

/// What `getAllPages` answers for these names: each a page with a file, plus a journal that is no page of this tool.
fn answer(names: &[String]) -> Value {
    let mut pages: Vec<Value> = names
        .iter()
        .enumerate()
        .map(|(at, name)| json!({"id": at + 1, "name": name.to_lowercase(), "originalName": name, "journal?": false, "file": {"id": 9000 + at}}))
        .collect();
    pages.push(json!({"id": 999_999, "name": "jan 1st, 2025", "originalName": "Jan 1st, 2025", "journal?": true, "file": {"id": 1}}));
    Value::Array(pages)
}

async fn logseq_holding(graph: &Graph) -> MockLogseq {
    let graph = Arc::clone(graph);
    mock_logseq_answering(move |_| answer(&graph.lock().unwrap())).await
}

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

fn snapshots() -> Snapshots {
    Snapshots::new(1_760_000_000_000)
}

/// The body of a call: the list, and its second content block (the tips), if any.
async fn call(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<Value, ToolError> {
    let text = call_text(logseq, snapshots, args).await?;
    Ok(serde_json::from_str(&text).unwrap())
}

async fn call_text(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<String, ToolError> {
    let result = find_pages::call(&client(logseq), true, snapshots, arguments(args)).await?;
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    let sent: usize = content.as_array().unwrap().iter().map(|block| size(block["text"].as_str().unwrap())).sum();
    let first = content[0]["text"].as_str().unwrap().to_owned();
    // a page that is over the budget is one page, returned whole (BR-0007)
    let alone = serde_json::from_str::<Value>(&first).is_ok_and(|body| body["pages"].as_array().is_some_and(|pages| pages.len() <= 1));
    assert!(sent <= BUDGET_CHARS || alone, "a page is over the budget: {sent}");
    Ok(first)
}

fn names(body: &Value) -> Vec<String> {
    body["pages"].as_array().unwrap().iter().map(|page| page["name"].as_str().unwrap().to_owned()).collect()
}

fn cursor_of(body: &Value) -> String {
    body["nextCursor"].as_str().expect("a page that leaves pages has a nextCursor").to_owned()
}

fn warning_codes(body: &Value) -> Vec<String> {
    body["warnings"].as_array().map_or_else(Vec::new, |warnings| warnings.iter().map(|warning| warning["code"].as_str().unwrap().to_owned()).collect())
}

// ---- a hit: the later pages cost nothing

#[tokio::test]
async fn the_pages_after_the_first_are_read_from_the_snapshot_and_make_no_call() {
    let held = graph(450, 10);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();

    let first = call(&logseq, &snapshots, json!({})).await.unwrap();
    assert_eq!(names(&first).len(), 200);
    assert_eq!((first["hasMore"].clone(), first["total"].clone()), (json!(true), json!(450)));
    assert_eq!(first["warnings"][0]["code"], "pages_truncated");
    assert_eq!(first["warnings"][0]["message"], "Showing 1-200 of 450 pages.");
    assert_eq!(methods(&logseq), [ALL_PAGES], "the first page is the one call");

    // the graph changes under the pages: a hit page still shows the list as the first page read it
    held.lock().unwrap().clear();
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(names(&second).len(), 200);
    assert_eq!(second["warnings"][0]["message"], "Showing 201-400 of 450 pages.");
    assert_eq!(second["warnings"][0]["howToFetchAll"], NEXT_PAGE, "a cursor call can't change the limit, so no raise");
    assert_eq!(second["hasMore"], true);

    let third = call(&logseq, &snapshots, json!({"cursor": cursor_of(&second)})).await.unwrap();
    assert_eq!(names(&third).len(), 50);
    // the last page is complete: no cursor, no warning, no hasMore
    for key in ["hasMore", "nextCursor", "warnings"] {
        assert!(third.get(key).is_none(), "{key}: {third}");
    }
    assert_eq!(third["total"], 450);

    assert_eq!(methods(&logseq), [ALL_PAGES], "pages 2 and 3 made no LogSeq call");
    let all: Vec<String> = [first, second, third].iter().flat_map(names).collect();
    assert_eq!(all, (0..450).map(|n| name_of(n, 10)).collect::<Vec<_>>(), "every page once, in name order");
}

// ---- a miss: the first page's calls, and no more

#[tokio::test]
async fn a_page_whose_snapshot_is_gone_costs_the_one_call_the_first_page_made() {
    let held = graph(450, 10);
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), json!({})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);

    // a restarted server: no snapshot, and its own start time, so the key the cursor holds is nobody's
    let second = call(&logseq, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq), [ALL_PAGES, ALL_PAGES], "page 1's call again, and no more");
    assert_eq!(names(&second).len(), 200);
    assert_eq!(names(&second)[0], name_of(200, 10));
    assert!(!warning_codes(&second).contains(&"cursor_stale".to_owned()), "the list did not move: {second}");
    assert!(names(&first).iter().all(|name| !names(&second).contains(name)));
}

#[tokio::test]
async fn a_snapshot_older_than_its_age_is_a_miss_that_reads_logseq_again() {
    let held = graph(450, 10);
    let logseq = logseq_holding(&held).await;
    // every snapshot is already too old when it is asked for
    let aged = Snapshots::with_limits(1_760_000_000_000, Limits { max_age: Duration::ZERO, ..Limits::STARTING });
    let first = call(&logseq, &aged, json!({})).await.unwrap();
    let second = call(&logseq, &aged, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!((methods(&logseq).len(), names(&second).len()), (2, 200), "the second page read LogSeq again, with the first page's one call");
}

#[tokio::test]
async fn a_miss_that_builds_a_snapshot_serves_the_next_page_from_it() {
    let held = graph(450, 10);
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), json!({})).await.unwrap();
    // the second page is a miss in a new server, which keeps what it read; the third is a hit there
    let restarted = Snapshots::new(1_760_000_999_999);
    let second = call(&logseq, &restarted, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
    let third = call(&logseq, &restarted, json!({"cursor": cursor_of(&second)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2, "the page after a rebuild is read from the rebuilt snapshot");
    assert_eq!(names(&third)[0], name_of(400, 10));
}

#[tokio::test]
async fn a_list_over_the_snapshot_limit_is_built_again_for_each_page_and_still_read_to_the_end() {
    let held = graph(450, 10);
    let logseq = logseq_holding(&held).await;
    let small = Snapshots::with_limits(1_760_000_000_000, Limits { snapshot_bytes: 10, ..Limits::STARTING });
    let mut body = call(&logseq, &small, json!({})).await.unwrap();
    let mut all = names(&body);
    while body.get("nextCursor").is_some() {
        body = call(&logseq, &small, json!({"cursor": cursor_of(&body)})).await.unwrap();
        all.extend(names(&body));
    }
    assert_eq!(all, (0..450).map(|n| name_of(n, 10)).collect::<Vec<_>>());
    assert_eq!(methods(&logseq).len(), 3, "each of the three pages made the one call: nothing was kept");
}

// ---- a list that moved between the pages

/// The first page of a list of 100 pages, limit 30: pages 0 to 29, with a cursor to page 30.
async fn first_page_of_100(logseq: &MockLogseq) -> String {
    let first = call(logseq, &snapshots(), json!({"limit": 30})).await.unwrap();
    assert_eq!((names(&first).len(), names(&first)[29].clone()), (30, name_of(29, 10)));
    cursor_of(&first)
}

#[tokio::test]
async fn a_list_that_gained_an_earlier_page_resumes_after_the_last_page_sent_with_no_repeat_and_says_so() {
    let held = graph(100, 10);
    let logseq = logseq_holding(&held).await;
    let cursor = first_page_of_100(&logseq).await;

    // a page that sorts first matches now: every position moved by one
    held.lock().unwrap().insert(0, "A new page".to_owned());
    let second = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    assert_eq!(names(&second)[0], name_of(30, 10), "the page resumes by name, not by position: page 29 is not sent again");
    assert_eq!(warning_codes(&second)[0], "cursor_stale");
    assert!(second["warnings"][0]["message"].as_str().unwrap().contains("resumes right after it, so none is repeated"));
    assert_eq!(second["total"], 101);
}

#[tokio::test]
async fn a_list_that_lost_a_page_it_had_shown_or_the_anchor_itself_loses_none_of_the_rest() {
    for removed in [10, 29] {
        let held = graph(100, 10);
        let logseq = logseq_holding(&held).await;
        let cursor = first_page_of_100(&logseq).await;
        held.lock().unwrap().retain(|name| *name != name_of(removed, 10));
        let second = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
        assert_eq!(names(&second)[0], name_of(30, 10), "removed {removed}: the first page after the last one sent");
        assert_eq!(names(&second).len(), 30);
        assert_eq!(warning_codes(&second)[0], "cursor_stale", "removed {removed}");
    }
}

#[tokio::test]
async fn a_list_that_shrank_below_the_position_is_an_empty_page_and_not_an_error() {
    let held = graph(100, 10);
    let logseq = logseq_holding(&held).await;
    let cursor = first_page_of_100(&logseq).await;
    *held.lock().unwrap() = vec![name_of(0, 10), name_of(1, 10)];
    let second = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    assert_eq!(second["pages"], json!([]));
    assert_eq!(warning_codes(&second), ["cursor_stale"]);
    assert!(second.get("nextCursor").is_none());
    assert_eq!(second["total"], 2);
}

// ---- the whole list, page after page

async fn read_to_the_end(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> (Vec<String>, usize) {
    let (mut all, mut pages) = (Vec::new(), 0);
    let mut body = call(logseq, snapshots, args).await.unwrap();
    all.extend(names(&body));
    pages += 1;
    while body.get("nextCursor").is_some() {
        assert!(pages < 100, "a cursor that never ends");
        assert_eq!(body["hasMore"], true);
        body = call(logseq, snapshots, json!({"cursor": cursor_of(&body)})).await.unwrap();
        assert!(!names(&body).is_empty(), "a page with a cursor to read on after it holds a page");
        all.extend(names(&body));
        pages += 1;
    }
    assert!(body.get("hasMore").is_none() || body["hasMore"] == false);
    (all, pages)
}

#[tokio::test]
async fn a_list_several_times_the_budget_is_read_to_the_end_with_every_page_once_through_the_snapshot_or_without_it() {
    // 1,000 pages of ~80 characters: ~100,000 characters, so the 30,000-character budget makes several pages
    let held = graph(1000, 70);
    let expected: Vec<String> = (0..1000).map(|n| name_of(n, 70)).collect();

    let hit_logseq = logseq_holding(&held).await;
    let (all, pages) = read_to_the_end(&hit_logseq, &snapshots(), json!({"limit": 1000})).await;
    assert_eq!(all, expected);
    assert!(pages >= 4, "{pages}");
    assert_eq!(methods(&hit_logseq), [ALL_PAGES], "the pages after the first made no call");

    // a miss on every page: a new server each time, so each page makes the one call and reads the same list
    let miss_logseq = logseq_holding(&held).await;
    let mut body = call(&miss_logseq, &snapshots(), json!({"limit": 1000})).await.unwrap();
    let mut seen = names(&body);
    let mut miss_pages = 1;
    while body.get("nextCursor").is_some() {
        body = call(&miss_logseq, &Snapshots::new(2 + miss_pages as u64), json!({"cursor": cursor_of(&body)})).await.unwrap();
        seen.extend(names(&body));
        miss_pages += 1;
    }
    assert_eq!(seen, expected, "a hit page and a miss page read the same list");
    assert_eq!((miss_pages, methods(&miss_logseq).len()), (pages, pages), "a miss costs the first page's one call, once a page");
}

#[tokio::test]
async fn a_page_over_the_budget_is_returned_alone_and_the_cursor_moves_past_it() {
    // the first page in name order is 40,000 characters long; the two after it are small
    let held: Graph = Arc::new(Mutex::new(vec![format!("A{}", "x".repeat(40_000)), "B".to_owned(), "C".to_owned()]));
    let logseq = logseq_holding(&held).await;
    let shared = snapshots();
    let first = call(&logseq, &shared, json!({})).await.unwrap();
    assert_eq!(names(&first).len(), 1);
    assert_eq!(first["warnings"][0]["code"], "result_size_truncated");
    assert!(first["warnings"][0]["message"].as_str().unwrap().contains("Even those are over that size"));
    let second = call(&logseq, &shared, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(names(&second), ["B", "C"]);
    assert!(second.get("nextCursor").is_none() && second.get("hasMore").is_none());
}

#[tokio::test]
async fn a_list_exactly_at_the_limit_has_no_cursor_and_one_more_page_has_one() {
    for (count, cursor) in [(50, false), (51, true)] {
        let held = graph(count, 10);
        let logseq = logseq_holding(&held).await;
        let body = call(&logseq, &snapshots(), json!({"limit": 50})).await.unwrap();
        assert_eq!(names(&body).len(), 50);
        assert_eq!(body.get("nextCursor").is_some(), cursor, "{count} pages");
        assert_eq!(body["warnings"].as_array().map_or(0, Vec::len), usize::from(cursor));
    }
}

#[tokio::test]
async fn nothing_to_find_and_a_limit_of_zero_have_no_cursor() {
    let empty = graph(0, 10);
    let logseq = logseq_holding(&empty).await;
    let body = call(&logseq, &snapshots(), json!({})).await.unwrap();
    assert_eq!(body, json!({"total": 0, "pages": []}));

    let held = graph(5, 10);
    let logseq = logseq_holding(&held).await;
    let body = call(&logseq, &snapshots(), json!({"limit": 0})).await.unwrap();
    assert_eq!(body["pages"], json!([]));
    assert_eq!(body["hasMore"], false);
    assert!(body.get("nextCursor").is_none(), "a cursor that does not move would read nothing on");
    assert_eq!(warning_codes(&body), ["pages_truncated"]);
}

// ---- the filters ride in the token

#[tokio::test]
async fn the_filters_of_page_1_are_in_the_token_and_a_miss_applies_them_again() {
    let held: Graph = Arc::new(Mutex::new((0..30).flat_map(|n| [format!("Atlas {n:02}"), format!("Borealis {n:02}")]).collect()));
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), json!({"text": "atlas", "limit": 10})).await.unwrap();
    assert_eq!((names(&first).len(), first["total"].clone()), (10, json!(30)));
    let second = call(&logseq, &Snapshots::new(77), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(names(&second)[0], "Atlas 10");
    assert!(names(&second).iter().all(|name| name.starts_with("Atlas")));
    assert_eq!(second["total"], 30);
}

#[tokio::test]
async fn a_names_request_that_is_paged_answers_every_name_on_page_1_never_cut_and_none_after() {
    let held = graph(10, 10);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let all: Vec<String> = (0..10).map(|n| name_of(n, 10)).collect();
    let first = call(&logseq, &snapshots, json!({"names": all, "limit": 4})).await.unwrap();
    assert_eq!(first["names"].as_array().unwrap().len(), 10, "every name answered on page 1");
    assert_eq!((names(&first).len(), first["total"].clone()), (4, json!(10)));
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert!(second.get("names").is_none(), "the names describe the request, which page 1 said");
    assert_eq!((names(&second).len(), second["total"].clone()), (4, json!(10)));
    // the same from a miss
    let third = call(&logseq, &Snapshots::new(5), json!({"cursor": cursor_of(&second)})).await.unwrap();
    assert!(third.get("names").is_none());
    assert_eq!(names(&third).len(), 2);
}

// ---- TOON

#[tokio::test]
async fn a_toon_list_carries_next_cursor_in_its_meta_and_is_read_to_the_end_the_same_way() {
    let held = graph(450, 10);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let mut text = call_text(&logseq, &snapshots, json!({"format": "toon"})).await.unwrap();
    assert!(text.contains("hasMore: true") && text.contains("nextCursor: "), "{text}");
    let mut pages = 1;
    let mut seen = text.matches("Page 0").count();
    loop {
        let Some(token) = text.lines().find_map(|line| line.trim().strip_prefix("nextCursor: ")).map(str::to_owned) else { break };
        // the cursor is written as it is, and the page that follows it is TOON too: the format is in the token
        text = call_text(&logseq, &snapshots, json!({"cursor": token.trim_matches('"')})).await.unwrap();
        assert!(!text.starts_with('{'), "a toon read stays toon: {text}");
        seen += text.matches("Page 0").count();
        pages += 1;
        assert!(pages < 10);
    }
    assert_eq!((pages, seen), (3, 450));
    assert!(!text.contains("hasMore"), "{text}");
    assert_eq!(methods(&logseq), [ALL_PAGES]);
}

// ---- what a token may be

fn good_args() -> Value {
    json!({"text": "page", "limit": 200})
}

fn token(change: &dyn Fn(&mut Cursor)) -> String {
    let mut cursor = Cursor::new(find_pages::NAME, good_args().as_object().cloned().unwrap(), Position::Index { at: 1 }, Anchor::Text("page 0000".into()), SnapshotKey { started: 1, n: 1 });
    change(&mut cursor);
    encode(&cursor)
}

#[tokio::test]
async fn a_token_that_is_not_one_of_this_tools_is_refused_before_any_call() {
    let held = graph(5, 10);
    let logseq = logseq_holding(&held).await;
    let tokens = [
        ("not base64", "this is not a cursor".to_owned()),
        ("base64 of text", "bm90IGEgY3Vyc29y".to_owned()),
        ("an empty one", String::new()),
        ("another tool's", token(&|cursor| cursor.tool = "logseq_find_blocks".to_owned())),
        ("an unknown version", token(&|cursor| cursor.v = 2)),
        ("sections position", token(&|cursor| cursor.position = Position::Sections { blocks: 1, references: 0, related: 0 })),
        ("a number anchor", token(&|cursor| cursor.anchor = Anchor::Id(5))),
        ("arguments no search takes", token(&|cursor| cursor.args = json!({"limit": "many"}).as_object().cloned().unwrap())),
        ("a property with no value", token(&|cursor| cursor.args = json!({"property": "status"}).as_object().cloned().unwrap())),
        ("arguments that hold a cursor", token(&|cursor| cursor.args = json!({"text": "x", "cursor": "abc"}).as_object().cloned().unwrap())),
    ];
    for (what, bad) in tokens {
        let error = call(&logseq, &snapshots(), json!({"cursor": bad})).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == "cursor"), "{what}: {error}");
        assert!(error.to_string().starts_with("Invalid parameter 'cursor': "), "{what}: {error}");
    }
    assert!(methods(&logseq).is_empty(), "a bad token costs no LogSeq call");
    // a cursor of this tool is read: the same call, but well formed, reads a page
    assert!(call(&logseq, &snapshots(), json!({"cursor": token(&|_| {})})).await.is_ok());
}

#[tokio::test]
async fn a_token_made_by_another_tool_is_refused_by_name() {
    let held = graph(5, 10);
    let logseq = logseq_holding(&held).await;
    let error = call(&logseq, &snapshots(), json!({"cursor": token(&|cursor| cursor.tool = "logseq_find_blocks".to_owned())})).await.unwrap_err();
    assert!(error.to_string().contains("made by another tool"), "{error}");
    assert!(error.to_string().contains("a result of logseq_find_pages"), "{error}");
}

#[tokio::test]
async fn a_cursor_with_any_other_argument_is_refused_before_any_call_and_names_it() {
    let held = graph(5, 10);
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), json!({"limit": 2})).await.unwrap();
    let cursor = cursor_of(&first);
    let calls = methods(&logseq).len();
    for (param, value) in [("text", json!("page")), ("names", json!(["Page 0000"])), ("property", json!("status")), ("value", json!("doing")), ("limit", json!(2)), ("format", json!("json"))] {
        let mut args = json!({"cursor": cursor});
        args[param] = value;
        let error = call(&logseq, &snapshots(), args).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == param), "{param}: {error}");
        assert!(error.to_string().contains("left out when cursor is given"), "{param}: {error}");
    }
    assert_eq!(methods(&logseq).len(), calls, "a refusal costs no call");
    // a null is no argument, and an unknown field (the v1 offset) is ignored, as everywhere
    assert!(call(&logseq, &snapshots(), json!({"cursor": cursor, "text": null, "offset": 3})).await.is_ok());
}

#[tokio::test]
async fn a_snapshot_is_never_served_to_a_token_that_holds_other_arguments() {
    let held = graph(450, 10);
    let logseq = logseq_holding(&held).await;
    let shared = snapshots();
    let first = call(&logseq, &shared, json!({})).await.unwrap();
    // the same snapshot key, with the search changed in the token: it is a miss, never the other list
    let mut cursor = decode(&cursor_of(&first), find_pages::NAME).unwrap();
    cursor.args.insert("text".into(), json!("another"));
    let _ = call(&logseq, &shared, json!({"cursor": encode(&cursor)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2, "the other search read LogSeq");
}

#[tokio::test]
async fn the_snapshot_key_of_another_process_is_a_miss_and_a_page_is_still_read() {
    let held = graph(450, 10);
    let logseq = logseq_holding(&held).await;
    let first = call(&logseq, &snapshots(), json!({})).await.unwrap();
    let mut cursor = decode(&cursor_of(&first), find_pages::NAME).unwrap();
    cursor.snapshot = SnapshotKey { started: 5, n: 1 };
    let second = call(&logseq, &snapshots(), json!({"cursor": encode(&cursor)})).await.unwrap();
    assert_eq!((methods(&logseq).len(), names(&second).len()), (2, 200));
}

#[tokio::test]
async fn a_token_that_holds_a_position_past_the_end_is_an_empty_last_page_and_never_a_panic() {
    let held = graph(5, 10);
    let logseq = logseq_holding(&held).await;
    let cursor = token(&|cursor| cursor.position = Position::Index { at: usize::MAX });
    let body = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    // the anchor is by name, so the page resumes where the name says, whatever the position
    assert_eq!(warning_codes(&body), ["cursor_stale"]);
    assert!(names(&body).len() <= 5);
    assert!(body.get("nextCursor").is_none());
}

// ---- errors

#[tokio::test]
async fn a_logseq_error_on_a_miss_is_an_error_and_not_an_empty_page() {
    // nothing answers: the call fails, as the first page would
    let logseq = mock_logseq(vec![]).await;
    let error = call(&logseq, &snapshots(), json!({"cursor": token(&|_| {})})).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn a_null_answer_on_a_miss_is_the_unavailable_warning_with_no_cursor_and_no_stale_warning() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let body = call(&logseq, &snapshots(), json!({"cursor": token(&|_| {})})).await.unwrap();
    assert_eq!(body["pages"], json!([]));
    assert_eq!(warning_codes(&body), ["pages_unavailable"]);
    assert_eq!((body["hasMore"].clone(), body.get("nextCursor").is_none(), body["total"].clone()), (json!(false), true, json!(0)));
}
