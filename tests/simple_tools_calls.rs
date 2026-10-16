//! The LogSeq traffic of `logseq_get_graph`, `logseq_find_pages` and `logseq_find_blocks`
//! against a mock LogSeq on a local port: how many calls each makes, with which inputs. The call
//! counts are those in `docs/performance.md` ("Current Implementation Status"); the parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the recorded results.
//! Every page and block here is made up (BR-0001).

use std::sync::{Arc, Mutex};

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use logseq_mcp_server::cursor::{Anchor, Cursor, Position, SnapshotKey, encode};
use logseq_mcp_server::dates::Clock;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::args::Scalar;
use logseq_mcp_server::snapshots::Snapshots;
use logseq_mcp_server::tools::find_blocks::Filters;
use logseq_mcp_server::tools::{find_blocks, find_pages, get_graph};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 2025-03-12T12:00:00Z: Wednesday the 12th in every zone from UTC-12 to UTC+11, since `Clock::today` reads the local date
/// (`localtime_r`, which honours `TZ`) and these in-process tests pin no zone. The parity harness pins its own.
const NOW: Clock = Clock::Fixed(1_741_780_800_000);

/// A LogSeq that answers each request with the next canned body, and records the requests.
struct MockLogseq {
    api_url: String,
    seen: Arc<Mutex<Vec<Value>>>,
}

async fn mock_logseq(answers: Vec<Value>) -> MockLogseq {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);
    tokio::spawn(async move {
        for answer in answers {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let body = loop {
                let mut chunk = [0u8; 8192];
                let n = socket.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ").map(str::to_owned))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if body.len() >= length {
                        break body.to_owned();
                    }
                }
            };
            recorded.lock().unwrap().push(serde_json::from_str(&body).unwrap());
            let reply = answer.to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    MockLogseq { api_url, seen }
}

fn client(logseq: &MockLogseq) -> LogseqClient {
    LogseqClient::new(&Config { api_url: logseq.api_url.clone(), auth_token: "t".into(), timeout_ms: Some(5000), tips: None })
}

fn methods(logseq: &MockLogseq) -> Vec<String> {
    logseq.seen.lock().unwrap().iter().map(|call| call["method"].as_str().unwrap().to_owned()).collect()
}

fn find_args(text: Option<&str>, limit: u64) -> find_pages::Args {
    find_pages::Args { text: text.map(str::to_owned), names: None, property: None, value: None, limit, format: None, cursor: None }
}

/// The filters of a search for `text` alone.
fn text(text: &str) -> Filters {
    Filters::parse(Some(text), None, None).unwrap()
}

/// The filters of a search for a property alone.
fn property(key: &str, value: &str) -> Filters {
    Filters::parse(None, Some(key), Some(&Scalar::Text(value.to_owned()))).unwrap()
}

fn block(id: i64, content: &str, page: i64) -> Value {
    json!([{"id": id, "uuid": format!("00000000-0000-4000-8000-{id:012}"), "content": content, "page": {"id": page, "name": "p", "original-name": "P"}}])
}

#[tokio::test]
async fn the_graph_info_costs_one_call_with_no_arguments() {
    let logseq = mock_logseq(vec![json!({"name": "example", "path": "/tmp/example", "url": "logseq_local_/tmp/example"})]).await;
    let graph = get_graph::get_graph(&client(&logseq)).await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.App.getCurrentGraph"]);
    assert_eq!(logseq.seen.lock().unwrap()[0]["args"], json!([]));
    assert_eq!(graph.to_string(), r#"{"name":"example","path":"/tmp/example","url":"logseq_local_/tmp/example"}"#);
}

#[tokio::test]
async fn no_graph_is_an_error_and_not_an_empty_result() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let error = get_graph::get_graph(&client(&logseq)).await.unwrap_err();
    assert!(matches!(&error, ToolError::Failed(message) if message == "Failed to retrieve graph information"), "{error}");
}

#[tokio::test]
async fn the_page_list_costs_one_call_whatever_the_filter_the_window_or_the_aliases() {
    let pages = json!([
        {"id": 1, "name": "alice", "originalName": "Alice", "file": {"id": 9}, "alias": [{"id": 2}, {"id": 3}]},
        {"id": 2, "name": "al", "originalName": "Al", "alias": [{"id": 1}]},
        {"id": 3, "name": "ali", "originalName": "Ali", "alias": [{"id": 1}]},
        {"id": 4, "name": "bob", "originalName": "Bob", "file": {"id": 10}}
    ]);
    for args in [find_args(None, 200), find_args(Some("ali"), 1), find_args(None, 0)] {
        let logseq = mock_logseq(vec![pages.clone()]).await;
        find_pages::find_pages(&client(&logseq), &args).await.unwrap();
        assert_eq!(methods(&logseq), ["logseq.Editor.getAllPages"], "{args:?}");
        assert_eq!(logseq.seen.lock().unwrap()[0]["args"], json!([]));
    }
}

#[tokio::test]
async fn a_null_page_list_is_not_an_empty_one() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let result = find_pages::find_pages(&client(&logseq), &find_args(None, 200)).await.unwrap();
    assert!(result.pages.is_empty());
    assert_eq!(result.warnings[0].code, "pages_unavailable");
}

#[tokio::test]
async fn a_search_costs_one_call_and_binds_its_text_with_in() {
    let logseq = mock_logseq(vec![json!([block(2, "an a.b match", 5), block(9, "a newer a.b match", 5)])]).await;
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &text("a.b (x)"), 100, false, true).await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    let seen = logseq.seen.lock().unwrap();
    let query = seen[0]["args"][0].as_str().unwrap();
    assert!(!query.contains("a.b"), "the text is never part of the query: {query}");
    // the JSON text of the string (?i)a\.b \(x\), escaped once for the regex and once for EDN
    assert_eq!(seen[0]["args"][1], r#""(?i)a\\.b \\(x\\)""#);
    assert_eq!(seen[0]["args"].as_array().unwrap().len(), 2);
    // newest first
    assert_eq!(found.results[0]["content"], "a newer a.b match");
    assert_eq!(found.meta.totals["matches"], 2);
}

#[tokio::test]
async fn context_costs_one_more_call_for_the_pages_of_the_hits_kept_only() {
    let page = |id: i64| json!([{"id": id, "name": format!("page {id}"), "original-name": format!("Page {id}")}]);
    let logseq = mock_logseq(vec![
        json!([block(1, "old", 7), block(3, "new", 5), block(2, "middle", 5)]),
        json!([page(5)]),
    ])
    .await;
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &text("x"), 2, true, true).await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery"]);
    let seen = logseq.seen.lock().unwrap();
    // the two newest hits sit on page 5; the cut hit's page (7) is not asked for, and each page is asked once
    assert_eq!(seen[1]["args"], json!(["[:find (pull ?p [*]) :where [(ground [5]) [?p ...]] [?p :block/name]]"]));
    assert_eq!(found.results.len(), 2);
    assert!(found.results[0]["context"]["page"]["originalName"] == "Page 5");
    assert_eq!(found.meta.warnings[0].code, "results_truncated");
}

// BR-0011 (#326): a `null` answer to the context lookup is not blocks with no context
#[tokio::test]
async fn a_null_context_lookup_is_a_warning_and_an_empty_one_is_not() {
    let logseq = mock_logseq(vec![json!([block(1, "text", 5), block(2, "more", 5)]), json!(null)]).await;
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &text("x"), 100, true, true).await.unwrap();
    assert_eq!(found.results.len(), 2);
    assert!(found.results.iter().all(|result| result.get("context").is_none()));
    assert_eq!(found.meta.warnings.len(), 1);
    assert_eq!(found.meta.warnings[0].code, "context_unavailable");
    assert!(found.meta.warnings[0].message.contains("the 2 result block(s)"));
    assert!(!found.meta.has_more && found.meta.warnings[0].how_to_fetch_all.is_none());

    // a real `[]` is pages not found, with no warning
    let logseq = mock_logseq(vec![json!([block(1, "text", 5)]), json!([])]).await;
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &text("x"), 100, true, true).await.unwrap();
    assert!(found.meta.warnings.is_empty());
    assert!(found.results[0].get("context").is_none());
}

#[tokio::test]
async fn context_costs_no_call_when_no_hit_has_a_page_id() {
    let logseq = mock_logseq(vec![json!([[{"id": 1, "uuid": "u1", "content": "text"}]])]).await;
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &text("text"), 100, true, false).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    assert!(found.results[0].get("context").is_none());
}

// BR-0011 (#415): a `null` answer to the search is `[]` and a warning, and no match is `[]` and none
#[tokio::test]
async fn a_null_answer_is_an_unavailable_warning_and_no_match_is_an_empty_result_without_one() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &text("x"), 100, false, true).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    assert!(found.results.is_empty());
    assert!(found.is_unavailable());
    assert_eq!(found.matches(), None, "no total is known, so none is claimed");
    assert_eq!(found.meta.warnings.len(), 1);
    assert_eq!(found.meta.warnings[0].code, "search_unavailable");
    assert!(found.meta.warnings[0].message.contains(r#"blocks that contain "x""#));
    assert!(!found.meta.has_more && found.meta.warnings[0].how_to_fetch_all.is_none());

    let logseq = mock_logseq(vec![json!([])]).await;
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &text("x"), 100, false, true).await.unwrap();
    assert!(found.results.is_empty());
    assert!(!found.is_unavailable());
    assert!(found.meta.warnings.is_empty());
    assert_eq!(found.matches(), Some(0));
}

// BR-0011, BR-0013 (#415): the text of both content blocks, in key order, and no tip for a search that was not answered
#[tokio::test]
async fn a_null_answer_to_the_search_is_written_as_an_empty_list_and_a_warning_with_no_tip() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let result = find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), json!({"text": "x\"y"}).as_object().cloned()).await.unwrap();
    let content = serde_json::to_value(&result).unwrap()["content"].clone();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"], "one call, as for any search");
    assert_eq!(content.as_array().unwrap().len(), 2);
    assert_eq!(content[0]["text"], "[]");
    assert_eq!(
        content[1]["text"],
        r#"{"meta":{"hasMore":false,"warnings":[{"code":"search_unavailable","message":"LogSeq returned no answer when looking up blocks that contain \"x\\\"y\" (possibly no graph open or a re-index in progress), so the empty list may not mean nothing matches. Retry in a moment, or call logseq_get_graph to check which graph is open."}],"totals":{}}}"#
    );

    // a real `[]` has no warning, and gets its usual "No match" tip
    let logseq = mock_logseq(vec![json!([])]).await;
    let result = find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), json!({"text": "x"}).as_object().cloned()).await.unwrap();
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    assert_eq!(content[0]["text"], "[]");
    assert_eq!(
        content[1]["text"],
        r#"{"meta":{"hasMore":false,"warnings":[],"totals":{"matches":0},"tips":["No match. Search is literal (no synonyms): try a shorter or different word, or logseq_find_pages {\"text\":\"x\"}."]}}"#
    );
}

#[tokio::test]
async fn a_logseq_error_is_an_error_and_not_an_empty_result() {
    let logseq = mock_logseq(vec![json!({"error": "Query timed out"})]).await;
    let error = find_blocks::find_blocks_with_meta(&client(&logseq), &text("x"), 100, false, true).await.unwrap_err();
    assert_eq!(error.to_string(), "LogSeq API error: Query timed out");
}

#[tokio::test]
async fn a_property_search_costs_one_query_and_binds_its_key_and_value() {
    let logseq = mock_logseq(vec![json!([block(2, "a block\nstatus:: testing", 5), block(9, "another\nstatus:: testing", 5)])]).await;
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &property("status", "test\"ing"), 100, false, true).await.unwrap();

    // one call, whatever the number of matches, and never a crawl of the pages
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    let seen = logseq.seen.lock().unwrap();
    let query = seen[0]["args"][0].as_str().unwrap();
    assert!(!query.contains("testing") && !query.contains("test\\\"ing"), "the value is never part of the query: {query}");
    // the key, then the value, each as an EDN string
    assert_eq!(seen[0]["args"][1], r#""status""#);
    assert_eq!(seen[0]["args"][2], r#""test\"ing""#);
    assert_eq!(seen[0]["args"].as_array().unwrap().len(), 3);
    assert_eq!(found.results.len(), 2);
    // newest first, as for a text search
    assert_eq!(found.results[0]["content"], "another\nstatus:: testing");
    assert!(found.meta.warnings.is_empty());
    assert_eq!(found.matches(), Some(2));
}

#[tokio::test]
async fn every_filter_costs_the_one_call_and_all_of_them_are_bound_in_the_order_the_query_declares_them() {
    let logseq = mock_logseq(vec![json!([block(2, "a match", 5)])]).await;
    let filters = Filters::parse(Some("a.b"), Some("createdAt"), Some(&Scalar::Number(3.0))).unwrap();
    find_blocks::find_blocks_with_meta(&client(&logseq), &filters, 100, false, true).await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    let seen = logseq.seen.lock().unwrap();
    let query = seen[0]["args"][0].as_str().unwrap();
    assert!(query.contains(":in $ ?key ?value ?pattern :where"), "{query}");
    assert!(!query.contains("a.b") && !query.contains("created"), "no value is part of the query: {query}");
    assert_eq!(seen[0]["args"].as_array().unwrap()[1..], [json!(r#""created-at""#), json!(r#""3""#), json!(r#""(?i)a\\.b""#)]);
}

// BR-0011 (#415): a `null` answer to the query is `[]` and a warning, and no match is `[]` and none
#[tokio::test]
async fn a_bad_property_key_is_refused_before_any_call_and_a_null_answer_is_an_unavailable_warning() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let error = Filters::parse(None, Some("bad name"), Some(&Scalar::Text("x".into()))).unwrap_err();
    assert!(error.to_string().starts_with("Invalid parameter 'property': bad name"), "{error}");
    assert!(methods(&logseq).is_empty());
    // BR-0011: `null` is not an empty list
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &property("status", "x"), 100, false, true).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    assert!(found.results.is_empty());
    assert!(found.is_unavailable());
    assert_eq!(found.meta.warnings.len(), 1);
    assert_eq!(found.meta.warnings[0].code, "search_unavailable");
    assert!(found.meta.warnings[0].message.contains(r#"blocks that have the property "status""#));
    assert!(!found.meta.has_more && found.meta.warnings[0].how_to_fetch_all.is_none());
    assert!(found.meta.totals.is_empty(), "no total is known, so none is claimed");

    // a real `[]` is no match, with no warning
    let logseq = mock_logseq(vec![json!([])]).await;
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &property("status", "x"), 100, false, true).await.unwrap();
    assert!(found.results.is_empty());
    assert!(!found.is_unavailable() && found.meta.warnings.is_empty());
    assert_eq!(found.matches(), Some(0));
}

// BR-0011, BR-0013 (#415): the text of both content blocks, in key order, and no tip
#[tokio::test]
async fn a_null_answer_to_a_property_search_is_written_as_an_empty_list_and_a_warning() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let arguments = json!({"property": "status", "value": "doing"}).as_object().cloned();
    let result = find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), arguments.clone()).await.unwrap();
    let content = serde_json::to_value(&result).unwrap()["content"].clone();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"], "one call, as for any search");
    assert_eq!(content.as_array().unwrap().len(), 2);
    assert_eq!(content[0]["text"], "[]");
    assert_eq!(
        content[1]["text"],
        r#"{"meta":{"hasMore":false,"warnings":[{"code":"search_unavailable","message":"LogSeq returned no answer when looking up blocks that have the property \"status\" (possibly no graph open or a re-index in progress), so the empty list may not mean nothing matches. Retry in a moment, or call logseq_get_graph to check which graph is open."}],"totals":{}}}"#
    );

    // a real `[]` has no warning, and a tip that says how a property matches
    let logseq = mock_logseq(vec![json!([])]).await;
    let result = find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), arguments).await.unwrap();
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    assert_eq!(content[0]["text"], "[]");
    assert_eq!(
        content[1]["text"],
        r#"{"meta":{"hasMore":false,"warnings":[],"totals":{"matches":0},"tips":["No match. A property value must equal the stored text: loosen a filter."]}}"#
    );
}

// #491: the period is one more clause of the one query, so it costs no call and binds its two bounds as typed numbers
#[tokio::test]
async fn a_period_costs_no_call_of_its_own_and_binds_its_days_with_in() {
    for (arguments, bounds) in [
        (json!({"text": "x", "start_date": 20250101, "end_date": 20250107}), ("20250101", "20250107")),
        (json!({"text": "x", "preset": "last_week"}), ("20250303", "20250309")),
        (json!({"text": "x", "last_n": 7}), ("20250306", "20250312")),
    ] {
        let logseq = mock_logseq(vec![json!([block(4, "a match on a journal", 5)])]).await;
        let result = find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), arguments.as_object().cloned()).await.unwrap();
        let content = serde_json::to_value(&result).unwrap()["content"].clone();

        assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"], "{arguments}");
        let seen = logseq.seen.lock().unwrap();
        let query = seen[0]["args"][0].as_str().unwrap();
        assert!(query.contains(":in $ ?start ?end ?pattern :where [?page :block/name] [?page :block/journal-day ?day]"), "{query}");
        assert!(query.contains("[?b :block/page ?page] [?b :block/content ?c]"), "{query}");
        assert_eq!(seen[0]["args"].as_array().unwrap()[1..3], [json!(bounds.0), json!(bounds.1)], "{arguments}");
        assert_eq!(content[0]["text"].as_str().unwrap().matches("\"uuid\"").count(), 1);
    }
}

#[tokio::test]
async fn a_period_alone_is_a_filter_and_two_ways_of_choosing_one_are_refused_before_any_call() {
    let logseq = mock_logseq(vec![json!([block(4, "a block", 5)])]).await;
    find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), json!({"last_n": 1}).as_object().cloned()).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    // today is the 12th, in any zone
    assert_eq!(logseq.seen.lock().unwrap()[0]["args"].as_array().unwrap()[1..], [json!("20250312"), json!("20250312")]);

    for (arguments, said) in [
        (json!({"text": "x", "last_n": 3, "preset": "today"}), "Invalid parameter 'date selection': last_n and preset"),
        (json!({"text": "x", "start_date": 20250101}), "Invalid parameter 'end_date': missing"),
        (json!({"text": "x", "start_date": 20250107, "end_date": 20250101}), "Invalid parameter 'date_range': 20250107 to 20250101"),
        (json!({"text": "x", "start_date": 20250231, "end_date": 20250301}), "Invalid parameter 'start_date': 20250231"),
    ] {
        let logseq = mock_logseq(vec![json!([])]).await;
        let error = find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), arguments.as_object().cloned()).await.unwrap_err();
        assert!(matches!(error, ToolError::InvalidParameter(_)), "{arguments}: {error}");
        assert!(error.to_string().starts_with(said), "{arguments}: {error}");
        assert!(methods(&logseq).is_empty(), "{arguments}");
    }
}

#[tokio::test]
async fn a_null_answer_to_a_search_with_a_period_says_which_days_were_asked_for() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let filters = Filters::parse(Some("x"), None, None).unwrap();
    let found = find_blocks::find_blocks_with_meta(&client(&logseq), &filters, 100, false, true).await.unwrap();
    assert!(found.is_unavailable());

    let logseq = mock_logseq(vec![json!(null)]).await;
    let result = find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), json!({"preset": "yesterday"}).as_object().cloned()).await.unwrap();
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    assert_eq!(content[0]["text"], "[]");
    let meta: Value = serde_json::from_str(content[1]["text"].as_str().unwrap()).unwrap();
    assert_eq!(meta["meta"]["warnings"][0]["code"], "search_unavailable");
    assert!(
        meta["meta"]["warnings"][0]["message"].as_str().unwrap().starts_with("LogSeq returned no answer when looking up blocks that sit on journal pages from 20250311 to 20250311 ("),
        "{meta}"
    );
}

/// A cursor for a search of `text` (default limit and slim results) whose next page starts at hit `at`, after the block
/// with id `anchor`. Its snapshot is one no server holds, so a call with it reads LogSeq again, as after a restart.
fn cursor_for(text: &str, at: usize, anchor: i64) -> String {
    let args = json!({"text": text, "limit": 100, "include_context": false, "slim_results": true}).as_object().cloned().unwrap();
    encode(&Cursor::new(find_blocks::NAME, args, Position::Index { at }, Anchor::Id(anchor), SnapshotKey { started: 1, n: 99 }))
}

// ADR-0038: a cursor at the end of the list is an empty last page, which reads LogSeq again once like any first page
#[tokio::test]
async fn a_cursor_at_the_end_of_the_list_is_an_empty_page_that_counts_the_matches_and_is_no_miss() {
    let logseq = mock_logseq(vec![json!([block(1, "a match", 5), block(2, "another match", 5)])]).await;
    // the two hits were sent, the last one (the older, block 1) ends the page
    let arguments = json!({"cursor": cursor_for("match", 2, 1)}).as_object().cloned();
    let result = find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), arguments).await.unwrap();
    let content = serde_json::to_value(&result).unwrap()["content"].clone();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    assert_eq!(content[0]["text"], "[]");
    // no warning (nothing was cut, and the list did not move), the real total, and no "No match" tip: matches exist
    assert_eq!(content[1]["text"], r#"{"meta":{"hasMore":false,"warnings":[],"totals":{"matches":2}}}"#);
}

// `offset` went with the cursor (ADR-0038): the library function reads the first page, and says how to raise `limit`
#[tokio::test]
async fn the_library_search_reads_the_newest_hits_first_and_a_cut_offers_the_raise_alone() {
    let hits = || json!([block(1, "oldest", 5), block(4, "newest", 5), block(3, "newer", 5), block(2, "older", 5)]);
    let logseq = mock_logseq(vec![hits()]).await;
    let first = find_blocks::find_blocks_with_meta(&client(&logseq), &text("e"), 2, false, true).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    assert_eq!(first.results.iter().map(|hit| hit["content"].as_str().unwrap()).collect::<Vec<_>>(), ["newest", "newer"]);
    assert_eq!(first.matches(), Some(4));
    // no snapshot is kept, so no cursor: `hasMore` is false and the raise is the way to more
    assert!(!first.meta.has_more && first.meta.next_cursor.is_none());
    assert_eq!(first.meta.warnings[0].message, "Showing 1-2 of 4 matching blocks.");
    assert_eq!(first.meta.warnings[0].how_to_fetch_all.as_deref(), Some("Set limit to 4 for a larger page (a result holds at most 30000 characters)."));

    // with `limit` 0 nothing is shown, and the warning says so
    let logseq = mock_logseq(vec![hits()]).await;
    let none = find_blocks::find_blocks_with_meta(&client(&logseq), &text("e"), 0, false, true).await.unwrap();
    assert!(none.results.is_empty());
    assert_eq!(none.meta.warnings[0].message, "Showing 0 of 4 matching blocks. limit is 0, so no hit is returned.");
}

#[tokio::test]
async fn a_call_with_no_filter_is_refused_before_any_call_whatever_else_it_carries() {
    for arguments in [json!({}), json!({"text": ""}), json!({"limit": 5, "include_context": true}), json!({"text": null, "property": null})] {
        let logseq = mock_logseq(vec![json!([])]).await;
        let error = find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), arguments.as_object().cloned()).await.unwrap_err();
        assert!(matches!(error, ToolError::InvalidParameter(_)), "{arguments}: {error}");
        assert!(error.to_string().starts_with("Invalid parameter 'filters': none given"), "{error}");
        assert!(methods(&logseq).is_empty(), "{arguments}");
    }
    // a value with no property, or the reverse, is refused too, and names the one that is missing
    let logseq = mock_logseq(vec![json!([])]).await;
    let error = find_blocks::call(&client(&logseq), true, NOW, &Snapshots::new(1), json!({"text": "x", "value": "doing"}).as_object().cloned()).await.unwrap_err();
    assert!(error.to_string().starts_with("Invalid parameter 'property': missing"), "{error}");
    assert!(methods(&logseq).is_empty());
}
