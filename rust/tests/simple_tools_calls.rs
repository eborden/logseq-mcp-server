//! The LogSeq traffic of `logseq_get_graph`, `logseq_find_pages` and `logseq_find_blocks`
//! against a mock LogSeq on a local port: how many calls each makes, with which inputs. The call
//! counts are those in `CLAUDE.md` ("Current Implementation Status"); the parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the recorded results.
//! Every page and block here is made up (BR-0001).

use std::sync::{Arc, Mutex};

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use logseq_mcp_server::dates::Clock;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::args::Scalar;
use logseq_mcp_server::tools::find_blocks::Filters;
use logseq_mcp_server::tools::{find_blocks, find_pages, get_graph};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 2025-03-12T03:30:00Z, the instant the parity harness reads as now: Tuesday 2025-03-11 in New York, where it also
/// pins the zone.
const NOW: Clock = Clock::Fixed(1_741_750_200_000);

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

fn find_args(text: Option<&str>, limit: u64, offset: u64) -> find_pages::Args {
    find_pages::Args { text: text.map(str::to_owned), names: None, property: None, value: None, limit, offset, format: None }
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
    for args in [find_args(None, 200, 0), find_args(Some("ali"), 1, 0), find_args(None, 1, 1), find_args(None, 0, 0)] {
        let logseq = mock_logseq(vec![pages.clone()]).await;
        find_pages::find_pages(&client(&logseq), &args).await.unwrap();
        assert_eq!(methods(&logseq), ["logseq.Editor.getAllPages"], "{args:?}");
        assert_eq!(logseq.seen.lock().unwrap()[0]["args"], json!([]));
    }
}

#[tokio::test]
async fn a_null_page_list_is_not_an_empty_one() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let result = find_pages::find_pages(&client(&logseq), &find_args(None, 200, 0)).await.unwrap();
    assert!(result.pages.is_empty());
    assert_eq!(result.warning.unwrap().code, "pages_unavailable");
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
    let result = find_blocks::call(&client(&logseq), true, NOW, json!({"text": "x\"y"}).as_object().cloned()).await.unwrap();
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
    let result = find_blocks::call(&client(&logseq), true, NOW, json!({"text": "x"}).as_object().cloned()).await.unwrap();
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
    let result = find_blocks::call(&client(&logseq), true, NOW, arguments.clone()).await.unwrap();
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
    let result = find_blocks::call(&client(&logseq), true, NOW, arguments).await.unwrap();
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
        (json!({"text": "x", "last_n": 7}), ("20250305", "20250311")),
    ] {
        let logseq = mock_logseq(vec![json!([block(4, "a match on a journal", 5)])]).await;
        let result = find_blocks::call(&client(&logseq), true, NOW, arguments.as_object().cloned()).await.unwrap();
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
    find_blocks::call(&client(&logseq), true, NOW, json!({"last_n": 1}).as_object().cloned()).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    // today is the 11th in New York, though it is already the 12th in UTC
    assert_eq!(logseq.seen.lock().unwrap()[0]["args"].as_array().unwrap()[1..], [json!("20250311"), json!("20250311")]);

    for (arguments, said) in [
        (json!({"text": "x", "last_n": 3, "preset": "today"}), "Invalid parameter 'date selection': last_n and preset"),
        (json!({"text": "x", "start_date": 20250101}), "Invalid parameter 'end_date': missing"),
        (json!({"text": "x", "start_date": 20250107, "end_date": 20250101}), "Invalid parameter 'date_range': 20250107 to 20250101"),
        (json!({"text": "x", "start_date": 20250231, "end_date": 20250301}), "Invalid parameter 'start_date': 20250231"),
    ] {
        let logseq = mock_logseq(vec![json!([])]).await;
        let error = find_blocks::call(&client(&logseq), true, NOW, arguments.as_object().cloned()).await.unwrap_err();
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
    let result = find_blocks::call(&client(&logseq), true, NOW, json!({"preset": "yesterday"}).as_object().cloned()).await.unwrap();
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    assert_eq!(content[0]["text"], "[]");
    let meta: Value = serde_json::from_str(content[1]["text"].as_str().unwrap()).unwrap();
    assert_eq!(meta["meta"]["warnings"][0]["code"], "search_unavailable");
    assert!(
        meta["meta"]["warnings"][0]["message"].as_str().unwrap().starts_with("LogSeq returned no answer when looking up blocks that sit on journal pages from 20250310 to 20250310 ("),
        "{meta}"
    );
}

#[tokio::test]
async fn a_call_with_no_filter_is_refused_before_any_call_whatever_else_it_carries() {
    for arguments in [json!({}), json!({"text": ""}), json!({"limit": 5, "include_context": true}), json!({"text": null, "property": null})] {
        let logseq = mock_logseq(vec![json!([])]).await;
        let error = find_blocks::call(&client(&logseq), true, NOW, arguments.as_object().cloned()).await.unwrap_err();
        assert!(matches!(error, ToolError::InvalidParameter(_)), "{arguments}: {error}");
        assert!(error.to_string().starts_with("Invalid parameter 'filters': none given"), "{error}");
        assert!(methods(&logseq).is_empty(), "{arguments}");
    }
    // a value with no property, or the reverse, is refused too, and names the one that is missing
    let logseq = mock_logseq(vec![json!([])]).await;
    let error = find_blocks::call(&client(&logseq), true, NOW, json!({"text": "x", "value": "doing"}).as_object().cloned()).await.unwrap_err();
    assert!(error.to_string().starts_with("Invalid parameter 'property': missing"), "{error}");
    assert!(methods(&logseq).is_empty());
}
