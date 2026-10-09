//! The LogSeq traffic of `logseq_get_graph_info`, `logseq_list_pages`, `logseq_search_blocks` and `logseq_query_by_property`
//! against a mock LogSeq on a local port: how many calls each makes, with which inputs. The Rust
//! side of the call counts in `CLAUDE.md` ("Current Implementation Status"); the parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the TypeScript server.
//! Every page and block here is made up (BR-0001).

use std::sync::{Arc, Mutex};

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::js;
use logseq_mcp_server::args::Scalar;
use logseq_mcp_server::tools::{get_graph_info, list_pages, query_by_property, search_blocks};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

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

fn list_args(name_contains: Option<&str>, limit: u64, offset: u64) -> list_pages::Args {
    list_pages::Args { name_contains: name_contains.map(str::to_owned), limit, offset }
}

fn block(id: i64, content: &str, page: i64) -> Value {
    json!([{"id": id, "uuid": format!("00000000-0000-4000-8000-{id:012}"), "content": content, "page": {"id": page, "name": "p", "original-name": "P"}}])
}

#[tokio::test]
async fn the_graph_info_costs_one_call_with_no_arguments() {
    let logseq = mock_logseq(vec![json!({"name": "example", "path": "/tmp/example", "url": "logseq_local_/tmp/example"})]).await;
    let graph = get_graph_info::get_graph_info(&client(&logseq)).await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.App.getCurrentGraph"]);
    assert_eq!(logseq.seen.lock().unwrap()[0]["args"], json!([]));
    assert_eq!(js::json_stringify(&graph), r#"{"name":"example","path":"/tmp/example","url":"logseq_local_/tmp/example"}"#);
}

#[tokio::test]
async fn no_graph_is_an_error_and_not_an_empty_result() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let error = get_graph_info::get_graph_info(&client(&logseq)).await.unwrap_err();
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
    for args in [list_args(None, 200, 0), list_args(Some("ali"), 1, 0), list_args(None, 1, 1), list_args(None, 0, 0)] {
        let logseq = mock_logseq(vec![pages.clone()]).await;
        list_pages::list_pages(&client(&logseq), &args).await.unwrap();
        assert_eq!(methods(&logseq), ["logseq.Editor.getAllPages"], "{args:?}");
        assert_eq!(logseq.seen.lock().unwrap()[0]["args"], json!([]));
    }
}

#[tokio::test]
async fn a_null_page_list_is_not_an_empty_one() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let result = list_pages::list_pages(&client(&logseq), &list_args(None, 200, 0)).await.unwrap();
    assert!(result.pages.is_empty());
    assert_eq!(result.warning.unwrap().code, "pages_unavailable");
}

#[tokio::test]
async fn a_search_costs_one_call_and_binds_its_text_with_in() {
    let logseq = mock_logseq(vec![json!([block(2, "an a.b match", 5), block(9, "a newer a.b match", 5)])]).await;
    let found = search_blocks::search_blocks_with_meta(&client(&logseq), "a.b (x)", None, false, true).await.unwrap().unwrap();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    let seen = logseq.seen.lock().unwrap();
    let query = seen[0]["args"][0].as_str().unwrap();
    assert!(!query.contains("a.b"), "the text is never part of the query: {query}");
    // JSON.stringify of the string (?i)a\.b \(x\), escaped once for the regex and once for EDN
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
    let found = search_blocks::search_blocks_with_meta(&client(&logseq), "x", Some(2), true, true).await.unwrap().unwrap();

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
    let found = search_blocks::search_blocks_with_meta(&client(&logseq), "x", None, true, true).await.unwrap().unwrap();
    assert_eq!(found.results.len(), 2);
    assert!(found.results.iter().all(|result| result.get("context").is_none()));
    assert_eq!(found.meta.warnings.len(), 1);
    assert_eq!(found.meta.warnings[0].code, "context_unavailable");
    assert!(found.meta.warnings[0].message.contains("the 2 result block(s)"));
    assert!(!found.meta.has_more && found.meta.warnings[0].how_to_fetch_all.is_none());

    // a real `[]` is pages not found, with no warning
    let logseq = mock_logseq(vec![json!([block(1, "text", 5)]), json!([])]).await;
    let found = search_blocks::search_blocks_with_meta(&client(&logseq), "x", None, true, true).await.unwrap().unwrap();
    assert!(found.meta.warnings.is_empty());
    assert!(found.results[0].get("context").is_none());
}

#[tokio::test]
async fn context_costs_no_call_when_no_hit_has_a_page_id() {
    let logseq = mock_logseq(vec![json!([[{"id": 1, "uuid": "u1", "content": "text"}]])]).await;
    let found = search_blocks::search_blocks_with_meta(&client(&logseq), "text", None, true, false).await.unwrap().unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    assert!(found.results[0].get("context").is_none());
}

#[tokio::test]
async fn a_null_answer_is_none_and_no_match_is_an_empty_result() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    assert!(search_blocks::search_blocks_with_meta(&client(&logseq), "x", None, false, true).await.unwrap().is_none());
    let logseq = mock_logseq(vec![json!([])]).await;
    let found = search_blocks::search_blocks_with_meta(&client(&logseq), "x", None, false, true).await.unwrap().unwrap();
    assert!(found.results.is_empty());
    assert_eq!(found.matches(), Some(0));
}

#[tokio::test]
async fn a_logseq_error_is_an_error_and_not_an_empty_result() {
    let logseq = mock_logseq(vec![json!({"error": "Query timed out"})]).await;
    let error = search_blocks::search_blocks_with_meta(&client(&logseq), "x", None, false, true).await.unwrap_err();
    assert_eq!(error.to_string(), "LogSeq API error: Query timed out");
}

#[tokio::test]
async fn a_property_search_costs_one_query_and_binds_its_key_and_value() {
    let logseq = mock_logseq(vec![json!([block(2, "a block\nstatus:: testing", 5), block(9, "another\nstatus:: testing", 5)])]).await;
    let found = query_by_property::query_by_property_with_meta(&client(&logseq), "status", &Scalar::Text("test\"ing".into()), true, 100)
        .await
        .unwrap()
        .unwrap();

    // one call, whatever the number of matches, and never a crawl of the pages
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    let seen = logseq.seen.lock().unwrap();
    let query = seen[0]["args"][0].as_str().unwrap();
    assert!(!query.contains("testing") && !query.contains("test\\\"ing"), "the value is never part of the query: {query}");
    assert_eq!(found.results.len(), 2);
    assert!(found.meta.is_none(), "nothing was cut, so there is no meta");
}

#[tokio::test]
async fn a_bad_property_key_is_refused_before_any_call_and_a_null_answer_is_none() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let error = query_by_property::query_by_property_with_meta(&client(&logseq), "bad name", &Scalar::Text("x".into()), true, 100).await.unwrap_err();
    assert!(error.to_string().contains("property_key"), "{error}");
    assert!(methods(&logseq).is_empty());
    // BR-0011: `null` is not an empty list
    assert!(query_by_property::query_by_property_with_meta(&client(&logseq), "status", &Scalar::Text("x".into()), true, 100).await.unwrap().is_none());
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
}
