//! The cursor of `logseq_get_page` with `detail: "outline"` (ADR-0038, #553) through its `call`, against a mock
//! LogSeq on a local port: what a page read from a snapshot costs (no call), what a page read after the snapshot is
//! gone costs (the calls the first page made, and no more), how an outline that moved between two pages is resumed,
//! what a bad token or a cursor with another argument gets before any call, and that an outline several times the page
//! size and the budget is read to the end with every block once and in page order, in JSON and in TOON. Every page and
//! block here is made up (BR-0001).

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MockLogseq, client, methods, mock_logseq_answering, uuid};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::snapshots::{Limits, Snapshots};
use logseq_mcp_server::tools::get_page;
use serde_json::{Value, json};

const QUERY: &str = "logseq.DB.datascriptQuery";
const NEXT_PAGE: &str = "Pass nextCursor as cursor, with no other argument, to read the next page.";

/// What LogSeq holds: the top-level blocks (id, first line) of the page "Project Atlas", in page order, which a test
/// changes between two pages. `None` makes the blocks query answer `null`.
type Shared = Arc<Mutex<Option<Vec<(i64, String)>>>>;

fn pulled_page() -> Value {
    json!({"id": 100_000, "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 5010}})
}

/// `count` top-level blocks of ids 1..=count whose first lines are `length` characters long.
fn blocks(count: i64, length: usize) -> Shared {
    Arc::new(Mutex::new(Some((1..=count).map(|id| (id, format!("b{id} {}", "x".repeat(length)))).collect())))
}

/// The rows of the blocks query for the blocks held: each top-level block, left-chained, and one child under every third.
fn rows(held: &[(i64, String)]) -> Value {
    let mut rows = Vec::new();
    for (index, (id, content)) in held.iter().enumerate() {
        let left = if index == 0 { 100_000 } else { held[index - 1].0 };
        rows.push(json!([{"id": id, "uuid": uuid(*id), "content": content, "left": {"id": left}, "parent": {"id": 100_000}}]));
        if id % 3 == 0 {
            rows.push(json!([{"id": 9000 + id, "uuid": uuid(9000 + id), "content": "child", "left": {"id": id}, "parent": {"id": id}}]));
        }
    }
    Value::Array(rows)
}

async fn logseq_holding(held: &Shared) -> MockLogseq {
    let held = Arc::clone(held);
    mock_logseq_answering(move |request| {
        assert_eq!(request["method"], QUERY, "the outline makes Datalog queries only");
        let text = request["args"][0].as_str().unwrap();
        if text.contains("(or-join [?page ?b]") {
            held.lock().unwrap().as_deref().map_or(Value::Null, rows)
        } else {
            // the name "atlas" is an alias of the page, anything else is its name
            let via = if request["args"][1] == "\"atlas\"" { "alias" } else { "name" };
            json!([[pulled_page(), via]])
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

/// What a call sent: every content block's text.
async fn texts(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<Vec<String>, ToolError> {
    let result = get_page::call(&client(logseq), true, snapshots, arguments(args)).await?;
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    Ok(content.as_array().unwrap().iter().map(|block| block["text"].as_str().unwrap().to_owned()).collect())
}

/// The outline as JSON, with the budget checked: every page, tip included, is at most the budget.
async fn outline(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<Value, ToolError> {
    let sent = texts(logseq, snapshots, args).await?;
    let total: usize = sent.iter().map(|text| size(text)).sum();
    assert!(total <= BUDGET_CHARS, "a page is over the budget: {total}");
    Ok(serde_json::from_str(&sent[0]).unwrap())
}

fn first_call() -> Value {
    json!({"page": "Project Atlas", "detail": "outline"})
}

fn uuids_of(body: &Value) -> Vec<String> {
    body["blocks"].as_array().unwrap().iter().map(|block| block["uuid"].as_str().unwrap().to_owned()).collect()
}

fn cursor_of(body: &Value) -> String {
    body["nextCursor"].as_str().expect("a page that leaves blocks has a nextCursor").to_owned()
}

fn warning_codes(body: &Value) -> Vec<String> {
    body["warnings"].as_array().map_or_else(Vec::new, |warnings| warnings.iter().map(|warning| warning["code"].as_str().unwrap().to_owned()).collect())
}

fn all_uuids(count: i64) -> Vec<String> {
    (1..=count).map(uuid).collect()
}

// ---- a hit costs nothing, a miss costs the first page's calls

#[tokio::test]
async fn the_pages_after_the_first_are_read_from_the_snapshot_and_make_no_call() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();

    let first = outline(&logseq, &snapshots, first_call()).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2, "the first page makes the calls it always made: the resolver, then the blocks");
    assert_eq!((uuids_of(&first).len(), first["hasMore"].clone(), first["totals"]["blocks"].clone()), (200, json!(true), json!(450)));
    assert_eq!((first["warnings"][0]["code"].clone(), first["warnings"][0]["howToFetchAll"].clone()), (json!("outline_truncated"), json!(NEXT_PAGE)));
    assert_eq!(first["warnings"][0]["message"], "Showing 1-200 of 450 top-level blocks.");
    assert_eq!(first["blocks"][2]["childCount"], 1, "the child count is the direct children of the block");

    // the graph changes under the pages: a hit still shows the outline as the first page read it
    *held.lock().unwrap() = Some(Vec::new());
    let second = outline(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2, "the second page made no LogSeq call");
    assert_eq!(uuids_of(&second).len(), 200);
    assert_eq!(uuids_of(&second)[0], uuid(201), "it starts at the block after the last one sent");
    assert_eq!(second["warnings"][0]["message"], "Showing 201-400 of 450 top-level blocks.");
    assert_eq!(second["page"], "Project Atlas", "the frame is repeated");
}

#[tokio::test]
async fn a_page_whose_snapshot_is_gone_costs_the_calls_the_first_page_made_and_reads_the_same_blocks() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let first = outline(&logseq, &snapshots(), first_call()).await.unwrap();

    // a restarted server: no snapshot, and its own start time, so the key the cursor holds is nobody's
    let second = outline(&logseq, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "page 1's two calls again, and no more");
    assert!(!warning_codes(&second).contains(&"cursor_stale".to_owned()), "{second}");
    assert_eq!(uuids_of(&second), all_uuids(400)[200..]);
}

#[tokio::test]
async fn a_snapshot_older_than_its_age_is_a_miss_that_reads_logseq_again() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    // every snapshot is already too old when it is asked for
    let aged = Snapshots::with_limits(1_760_000_000_000, Limits { max_age: Duration::ZERO, ..Limits::STARTING });
    let first = outline(&logseq, &aged, first_call()).await.unwrap();
    let second = outline(&logseq, &aged, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4);
    assert_eq!(uuids_of(&second)[0], uuid(201));
}

#[tokio::test]
async fn an_outline_over_the_snapshot_limit_is_built_again_for_each_page_and_still_read_to_the_end() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let small = Snapshots::with_limits(1_760_000_000_000, Limits { snapshot_bytes: 10, ..Limits::STARTING });
    let mut body = outline(&logseq, &small, first_call()).await.unwrap();
    let mut all = uuids_of(&body);
    let mut pages = 1;
    while body.get("nextCursor").is_some() {
        body = outline(&logseq, &small, json!({"cursor": cursor_of(&body)})).await.unwrap();
        all.extend(uuids_of(&body));
        pages += 1;
    }
    assert_eq!(all, all_uuids(450));
    assert_eq!(methods(&logseq).len(), 2 * pages, "each page made the two calls: nothing was kept");
}

// ---- the whole outline, page after page

#[tokio::test]
async fn an_outline_several_times_the_page_size_is_read_to_the_end_with_every_block_once_and_the_last_page_has_no_cursor() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let mut body = outline(&logseq, &snapshots, first_call()).await.unwrap();
    let (mut all, mut pages) = (uuids_of(&body), 1);
    while body.get("nextCursor").is_some() {
        assert!(pages < 20, "a cursor that never ends");
        assert_eq!(body["hasMore"], true);
        body = outline(&logseq, &snapshots, json!({"cursor": cursor_of(&body)})).await.unwrap();
        assert!(!uuids_of(&body).is_empty());
        all.extend(uuids_of(&body));
        pages += 1;
    }
    assert_eq!((all, pages), (all_uuids(450), 3));
    assert_eq!((body["hasMore"].clone(), body.get("warnings").map(|w| w.as_array().unwrap().len())), (json!(false), Some(0)));
    assert_eq!(uuids_of(&body).len(), 50);
    assert_eq!(methods(&logseq).len(), 2, "the pages after the first made no call");
}

#[tokio::test]
async fn an_outline_asked_by_an_alias_keeps_the_alias_in_its_cursor_and_says_where_it_came_from_on_page_1_only() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let first = outline(&logseq, &snapshots(), json!({"page": "atlas", "detail": "outline"})).await.unwrap();
    let from = json!({"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"});
    assert_eq!((first["page"].clone(), first["resolvedFrom"].clone()), (json!("Project Atlas"), from.clone()));
    assert_eq!(decode(&cursor_of(&first), get_page::NAME).unwrap().args["page"], "atlas");
    // a miss resolves the alias again with page 1's two calls
    let second = outline(&logseq, &Snapshots::new(1), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4);
    // a page after the first does not repeat it (the maintainer's ruling on #551); its frame is still the page's name
    assert_eq!(uuids_of(&second)[0], uuid(201));
    assert!(second.get("resolvedFrom").is_none(), "{second}");
    assert_eq!(second["page"], "Project Atlas");
}

#[tokio::test]
async fn a_list_exactly_at_the_page_size_has_no_cursor_and_one_block_more_has_one() {
    for (count, cursor) in [(200, false), (201, true)] {
        let held = blocks(count, 10);
        let logseq = logseq_holding(&held).await;
        let body = outline(&logseq, &snapshots(), first_call()).await.unwrap();
        assert_eq!((body.get("nextCursor").is_some(), uuids_of(&body).len(), body["warnings"].as_array().unwrap().len()), (cursor, 200, usize::from(cursor)), "{count} blocks");
        assert_eq!(body["totals"]["blocks"], count);
    }
}

#[tokio::test]
async fn long_first_lines_cut_a_page_to_the_budget_and_the_cursor_reads_the_rest() {
    // 450 blocks with first lines at the 80-character cap: 200 of them are over 30,000 characters
    let held = blocks(450, 200);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let first = outline(&logseq, &snapshots, first_call()).await.unwrap();
    let on_first = uuids_of(&first).len();
    assert!((100..200).contains(&on_first), "{on_first}");
    assert_eq!((first["warnings"][0]["code"].clone(), first["warnings"][0]["howToFetchAll"].clone()), (json!("result_size_truncated"), json!(NEXT_PAGE)));
    assert!(first["warnings"][0]["message"].as_str().unwrap().starts_with(&format!("Showing 1-{on_first} of 450 top-level blocks: the result was cut to fit 30000 characters")));
    let (mut all, mut body) = (uuids_of(&first), first);
    while body.get("nextCursor").is_some() {
        body = outline(&logseq, &snapshots, json!({"cursor": cursor_of(&body)})).await.unwrap();
        all.extend(uuids_of(&body));
    }
    assert_eq!(all, all_uuids(450));
    assert_eq!(methods(&logseq).len(), 2);
}

#[tokio::test]
async fn an_outline_in_toon_is_read_to_the_end_by_the_cursor_in_its_meta() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let snapshots = snapshots();
    let args = json!({"page": "Project Atlas", "detail": "outline", "format": "toon"});
    let mut sent = texts(&logseq, &snapshots, args).await.unwrap();
    let (mut seen, mut pages) = (0, 0);
    loop {
        assert!(size(&sent[0]) <= BUDGET_CHARS);
        assert!(serde_json::from_str::<Value>(&sent[0]).is_err(), "TOON, not JSON");
        seen += (1..=450).filter(|id| sent[0].contains(&uuid(*id))).count();
        pages += 1;
        let Some(token) = sent[0].lines().find_map(|line| line.trim().strip_prefix("nextCursor: ")).map(|token| token.trim_matches('"').to_owned()) else { break };
        assert!(pages < 20);
        // the cursor carries the format, so the next page is TOON too
        sent = texts(&logseq, &snapshots, json!({"cursor": token})).await.unwrap();
    }
    assert_eq!((seen, pages), (450, 3));
    assert_eq!(methods(&logseq).len(), 2);
}

// ---- an outline that moved between the pages

#[tokio::test]
async fn an_outline_that_gained_an_earlier_block_resumes_after_the_last_block_sent_with_no_repeat_and_says_so() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let first = outline(&logseq, &snapshots(), first_call()).await.unwrap();
    // a new block at the top: every position moved by one
    held.lock().unwrap().as_mut().unwrap().insert(0, (500, "new".into()));
    let second = outline(&logseq, &Snapshots::new(1), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(uuids_of(&second)[0], uuid(201), "the page resumes by block, not by position: block 200 is not sent again");
    assert_eq!(warning_codes(&second)[0], "cursor_stale");
    assert!(second["warnings"][0]["message"].as_str().unwrap().contains("resumes right after it, so none is repeated"));
}

#[tokio::test]
async fn an_outline_that_lost_the_last_block_sent_resumes_at_the_position_and_says_so() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let first = outline(&logseq, &snapshots(), first_call()).await.unwrap();
    held.lock().unwrap().as_mut().unwrap().retain(|(id, _)| *id != 200);
    let second = outline(&logseq, &Snapshots::new(1), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(warning_codes(&second)[0], "cursor_stale");
    assert!(second["warnings"][0]["message"].as_str().unwrap().contains("is gone"));
    assert!(!uuids_of(&second).is_empty());
}

#[tokio::test]
async fn an_outline_that_shrank_below_the_position_is_an_empty_page_and_not_an_error() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let first = outline(&logseq, &snapshots(), first_call()).await.unwrap();
    held.lock().unwrap().as_mut().unwrap().truncate(2);
    let second = outline(&logseq, &Snapshots::new(1), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(second["blocks"], json!([]));
    assert_eq!(warning_codes(&second), ["cursor_stale"]);
    assert!(second.get("nextCursor").is_none());
}

// ---- what a token may be, and a call with a cursor takes no other argument

fn token(args: Value, change: &dyn Fn(&mut Cursor)) -> String {
    let mut cursor = Cursor::new(get_page::NAME, args.as_object().cloned().unwrap(), Position::Index { at: 1 }, Anchor::Text(uuid(1)), SnapshotKey { started: 1, n: 1 });
    change(&mut cursor);
    encode(&cursor)
}

fn outline_token(change: &dyn Fn(&mut Cursor)) -> String {
    token(first_call(), change)
}

#[tokio::test]
async fn a_token_that_is_not_an_outline_cursor_is_refused_before_any_call() {
    let held = blocks(5, 10);
    let logseq = logseq_holding(&held).await;
    let tokens = [
        ("not base64", "this is not a cursor".to_owned()),
        ("another tool's", outline_token(&|cursor| cursor.tool = "logseq_find_pages".to_owned())),
        ("an unknown version", outline_token(&|cursor| cursor.v = 2)),
        ("sections position", outline_token(&|cursor| cursor.position = Position::Sections { blocks: 1, references: 0, related: 0 })),
        ("a block id as the last block", outline_token(&|cursor| cursor.anchor = Anchor::Id(4))),
        ("a markdown outline", token(json!({"page": "Project Atlas", "detail": "outline", "format": "markdown"}), &|_| {})),
        ("resolve_refs on an outline", token(json!({"page": "Project Atlas", "detail": "outline", "resolve_refs": true}), &|_| {})),
        ("no page", token(json!({"detail": "outline"}), &|_| {})),
        ("arguments that hold a cursor", token(json!({"page": "a", "detail": "outline", "cursor": "abc"}), &|_| {})),
    ];
    for (what, bad) in tokens {
        let error = outline(&logseq, &snapshots(), json!({"cursor": bad})).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == "cursor"), "{what}: {error}");
    }
    assert!(methods(&logseq).is_empty(), "a bad token costs no LogSeq call");
    // a token of this tool, well formed, reads the outline: here the last page of 5 blocks, from the second
    let body = outline(&logseq, &snapshots(), json!({"cursor": outline_token(&|_| {})})).await.unwrap();
    assert_eq!(uuids_of(&body), all_uuids(5)[1..]);
}

#[tokio::test]
async fn a_cursor_with_any_other_argument_is_refused_before_any_call_and_names_it() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let first = outline(&logseq, &snapshots(), first_call()).await.unwrap();
    let cursor = cursor_of(&first);
    let calls = methods(&logseq).len();
    for (param, value) in [("page", json!("Project Atlas")), ("detail", json!("outline")), ("format", json!("toon")), ("resolve_refs", json!(false))] {
        let mut args = json!({"cursor": cursor});
        args[param] = value;
        let error = outline(&logseq, &snapshots(), args).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == param), "{param}: {error}");
        assert!(error.to_string().contains("left out when cursor is given"), "{param}: {error}");
    }
    assert_eq!(methods(&logseq).len(), calls, "a refusal costs no call");
}

#[tokio::test]
async fn a_snapshot_is_never_served_to_a_token_that_holds_other_arguments() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let shared = snapshots();
    let first = outline(&logseq, &shared, first_call()).await.unwrap();
    // the same snapshot key, with the arguments changed in the token: a miss, never the other outline
    let mut cursor = decode(&cursor_of(&first), get_page::NAME).unwrap();
    cursor.args.insert("format".into(), json!("toon"));
    let _ = texts(&logseq, &shared, json!({"cursor": encode(&cursor)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "the other read went to LogSeq");
}

#[tokio::test]
async fn a_token_that_holds_a_position_past_the_end_is_an_empty_last_page_and_never_a_panic() {
    let held = blocks(5, 10);
    let logseq = logseq_holding(&held).await;
    // the last block sent is no block of the page either, so the position is all there is, and it is clamped
    let cursor = outline_token(&|cursor| {
        cursor.position = Position::Index { at: usize::MAX };
        cursor.anchor = Anchor::Text("gone".into());
    });
    let body = outline(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    assert_eq!(warning_codes(&body), ["cursor_stale"]);
    assert_eq!((body["blocks"].clone(), body.get("nextCursor").is_none()), (json!([]), true));
}

// ---- empty, null and errors

#[tokio::test]
async fn an_empty_outline_has_no_cursor_and_a_null_answer_says_it_was_unavailable() {
    let held = blocks(0, 10);
    let logseq = logseq_holding(&held).await;
    let body = outline(&logseq, &snapshots(), first_call()).await.unwrap();
    assert_eq!(body, json!({"page": "Project Atlas", "blocks": [], "hasMore": false, "warnings": [], "totals": {"blocks": 0}}));

    *held.lock().unwrap() = None;
    let body = outline(&logseq, &snapshots(), first_call()).await.unwrap();
    assert_eq!((warning_codes(&body), body["hasMore"].clone(), body.get("nextCursor").is_none()), (vec!["outline_unavailable".to_owned()], json!(false), true));
}

#[tokio::test]
async fn a_logseq_error_on_a_miss_is_an_error_and_not_an_empty_page() {
    // nothing listens on this port
    let dead = logseq_mcp_server::client::LogseqClient::new(&logseq_mcp_server::config::Config {
        api_url: "http://127.0.0.1:9".into(),
        auth_token: "t".into(),
        timeout_ms: Some(2000),
        tips: None,
    });
    let args = json!({"cursor": outline_token(&|_| {})});
    let error = get_page::call(&dead, true, &snapshots(), arguments(args)).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn the_tip_block_rides_with_every_page_and_counts_against_the_budget() {
    let held = blocks(450, 10);
    let logseq = logseq_holding(&held).await;
    let sent = texts(&logseq, &snapshots(), first_call()).await.unwrap();
    assert_eq!(sent.len(), 2);
    assert!(sent[1].contains("logseq_get_block"), "{}", sent[1]);
}
