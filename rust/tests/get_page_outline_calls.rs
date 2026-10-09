//! The page outline's LogSeq traffic against a mock LogSeq on a local port: how many calls it
//! makes, in which order, with which inputs, and what it answers. The Rust side of
//! `src/index.outline.test.ts`'s call counts; the parity harness (`parity.rs`) checks the
//! same calls and the result bytes against the TypeScript server. Every page and block here is
//! made up (BR-0001).

use std::sync::{Arc, Mutex};

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::get_page_outline::get_page_outline;
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

fn page(id: i64, name: &str, original: &str, file: bool) -> Value {
    let mut page = json!({"id": id, "name": name, "original-name": original});
    if file {
        page["file"] = json!({"id": id + 5000});
    }
    page
}

fn block(id: i64, parent: i64, left: i64, content: &str) -> Value {
    json!([{"id": id, "uuid": format!("00000000-0000-4000-8000-{id:012}"), "content": content, "left": {"id": left}, "parent": {"id": parent}}])
}

fn methods(logseq: &MockLogseq) -> Vec<String> {
    logseq.seen.lock().unwrap().iter().map(|call| call["method"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn an_exact_name_costs_two_calls_the_resolver_then_the_blocks() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", true), "name"]]),
        json!([block(102, 10, 101, "Second"), block(101, 10, 10, "First"), block(201, 101, 101, "Child")]),
    ])
    .await;
    let outline = get_page_outline(&client(&logseq), "Project Atlas").await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery"]);
    let seen = logseq.seen.lock().unwrap();
    // the name is bound as a lowercase EDN string, never embedded in the query text
    assert_eq!(seen[0]["args"][1], "\"project atlas\"");
    assert!(!seen[0]["args"][0].as_str().unwrap().contains("project atlas"));
    // the page's id is the one thing embedded
    assert!(seen[1]["args"][0].as_str().unwrap().contains("[(ground [10]) [?page ...]]"));
    assert_eq!(seen[1]["args"].as_array().unwrap().len(), 1);
    assert_eq!(
        serde_json::to_string(&outline).unwrap(),
        concat!(
            r#"{"page":"Project Atlas","blocks":["#,
            r#"{"uuid":"00000000-0000-4000-8000-000000000101","snippet":"First","childCount":1},"#,
            r#"{"uuid":"00000000-0000-4000-8000-000000000102","snippet":"Second","childCount":0}],"#,
            r#""hasMore":false,"warnings":[],"totals":{"blocks":2}}"#
        )
    );
}

#[tokio::test]
async fn an_alias_costs_two_calls_and_says_where_the_page_came_from() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", true), "alias"]]),
        json!([block(101, 10, 10, "First")]),
    ])
    .await;
    let outline = get_page_outline(&client(&logseq), "atlas").await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
    let text = serde_json::to_string(&outline).unwrap();
    assert!(text.starts_with(
        r#"{"page":"Project Atlas","resolvedFrom":{"name":"atlas","matchedBy":"alias","resolvedTo":"Project Atlas"},"blocks":["#
    ));
}

#[tokio::test]
async fn a_namespace_leaf_adds_the_leaf_query() {
    let logseq = mock_logseq(vec![
        json!([]),
        json!([[page(60, "project atlas/retro", "Project Atlas/Retro", true)]]),
        json!([block(601, 60, 60, "What went well")]),
    ])
    .await;
    let outline = get_page_outline(&client(&logseq), "Retro").await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
    assert_eq!(logseq.seen.lock().unwrap()[1]["args"][1], "\"/retro\"");
    assert_eq!(outline.resolved_from.unwrap().matched_by, "namespace-leaf");
}

#[tokio::test]
async fn a_missing_page_adds_the_suggestion_lookup_and_fails_with_the_closest_names() {
    let logseq = mock_logseq(vec![
        json!([]),
        json!([]),
        json!([{"id": 1, "name": "alice", "originalName": "Alice"}, {"id": 2, "name": "bob", "originalName": "Bob"}]),
    ])
    .await;
    let error = get_page_outline(&client(&logseq), "Alce").await.unwrap_err();
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery", "logseq.Editor.getAllPages"]);
    assert!(
        error.to_string().starts_with("No page \"Alce\". Closest: Alice."),
        "{error}"
    );
}

#[tokio::test]
async fn an_iso_date_that_misses_makes_no_leaf_query_and_no_suggestions() {
    let logseq = mock_logseq(vec![json!([])]).await;
    let error = get_page_outline(&client(&logseq), "2025-01-01").await.unwrap_err();
    assert!(matches!(error, ToolError::PageNotFound(_)));
    assert_eq!(methods(&logseq).len(), 1);
    assert_eq!(logseq.seen.lock().unwrap()[0]["args"][2], "20250101");
}

#[tokio::test]
async fn an_error_from_logseq_is_an_error_and_not_an_empty_outline() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "bob", "Bob", true), "name"]]),
        json!({"error": "Query timed out"}),
    ])
    .await;
    let error = get_page_outline(&client(&logseq), "bob").await.unwrap_err();
    assert_eq!(error.to_string(), "LogSeq API error: Query timed out");
}

// BR-0011, #300: a `null` answer to the blocks query is the empty list plus `outline_unavailable`, not an outline
// that says the page has no blocks. `hasMore` stays false and there is no `howToFetchAll`. A real `[]` has no warning.
#[tokio::test]
async fn a_null_answer_is_an_empty_outline_with_an_outline_unavailable_warning() {
    let logseq = mock_logseq(vec![json!([[page(10, "bob", "Bob", true), "name"]]), Value::Null]).await;
    let outline = get_page_outline(&client(&logseq), "bob").await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
    let value = serde_json::to_value(&outline).unwrap();
    assert_eq!(value["blocks"], json!([]));
    assert_eq!(value["hasMore"], json!(false));
    assert_eq!(value["totals"], json!({"blocks": 0}));
    let warnings = value["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1, "{value}");
    assert_eq!(warnings[0]["code"], "outline_unavailable");
    let message = warnings[0]["message"].as_str().unwrap();
    assert!(message.contains("when looking up the blocks of this page"), "{message}");
    assert!(message.contains("so the empty outline may not mean the page has no blocks"), "{message}");
    assert!(warnings[0].get("howToFetchAll").is_none(), "{value}");
}

#[tokio::test]
async fn a_real_empty_answer_is_an_empty_outline_with_no_warning() {
    let logseq = mock_logseq(vec![json!([[page(10, "bob", "Bob", true), "name"]]), json!([])]).await;
    let value = serde_json::to_value(get_page_outline(&client(&logseq), "bob").await.unwrap()).unwrap();
    assert_eq!(value["blocks"], json!([]));
    assert_eq!(value["warnings"], json!([]));
    assert_eq!(value["hasMore"], json!(false));
}

#[tokio::test]
async fn an_unreadable_answer_is_an_error() {
    let logseq = mock_logseq(vec![json!([[page(10, "bob", "Bob", true), "name"]]), json!([[{"uuid": "u"}]])]).await;
    let error = get_page_outline(&client(&logseq), "bob").await.unwrap_err();
    assert!(matches!(error, ToolError::Response(_)), "{error}");
    assert!(error.to_string().contains("[0][0]: a block needs an id"));
}

const RESOLVER_UNAVAILABLE: &str = "LogSeq returned no answer when looking up the page \"bob\" (possibly no graph open or a re-index in progress), so it can't tell whether the page exists. Retry in a moment, or call logseq_get_graph_info to check which graph is open.";

// BR-0011, #301: a `null` answer from the resolver is an error that stops at once. It is not "no rows", so
// it makes no leaf query and no suggestion lookup, and it never says the page is missing.
#[tokio::test]
async fn a_null_answer_from_the_resolver_is_an_error_with_no_further_call() {
    let logseq = mock_logseq(vec![Value::Null]).await;
    let error = get_page_outline(&client(&logseq), "bob").await.unwrap_err();
    assert!(matches!(error, ToolError::Failed(_)), "{error}");
    assert_eq!(error.to_string(), RESOLVER_UNAVAILABLE);
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
}

#[tokio::test]
async fn a_null_answer_to_the_leaf_query_is_the_same_error_and_makes_no_suggestion_lookup() {
    let logseq = mock_logseq(vec![json!([]), Value::Null]).await;
    let error = get_page_outline(&client(&logseq), "bob").await.unwrap_err();
    assert!(matches!(error, ToolError::Failed(_)), "{error}");
    assert_eq!(error.to_string(), RESOLVER_UNAVAILABLE);
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery"]);
}

#[tokio::test]
async fn an_ambiguous_name_stops_after_the_resolver() {
    let logseq = mock_logseq(vec![json!([
        [page(40, "alice", "Alice", true), "alias"],
        [page(41, "alice notes", "Alice Notes", true), "alias"]
    ])])
    .await;
    let error = get_page_outline(&client(&logseq), "al").await.unwrap_err();
    let ToolError::AmbiguousPage(ambiguous) = error else { panic!("expected an ambiguous name") };
    assert_eq!(ambiguous.total_candidates, 2);
    assert_eq!(methods(&logseq).len(), 1);
}

#[tokio::test]
async fn a_year_before_1000_is_a_name_not_a_date_and_costs_three_calls_where_typescript_makes_one() {
    // Different from the TypeScript server on purpose (see `resolve`): it takes "0999-12-31" for a
    // date, makes one call and gives no suggestions. Here it is a plain name, so the leaf query and
    // the suggestion lookup follow, and the error lists the closest names.
    let logseq = mock_logseq(vec![
        json!([]),
        json!([]),
        json!([{"id": 1, "name": "alice", "originalName": "Alice"}]),
    ])
    .await;
    let error = get_page_outline(&client(&logseq), "0999-12-31").await.unwrap_err();
    assert!(matches!(error, ToolError::PageNotFound(_)));
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery", "logseq.Editor.getAllPages"]);
    assert_eq!(logseq.seen.lock().unwrap()[0]["args"].as_array().unwrap().len(), 2, "no journal day is bound");
}

// BR-0003: an infrastructure error is an error wherever the miss path meets it, never "page not found".
// A mock that has sent its last answer drops its listener, so the next call is a refused connection.

fn is_not_running(error: &ToolError) -> bool {
    matches!(error, ToolError::Logseq(logseq) if logseq.is_infrastructure()) && error.to_string().starts_with("Cannot connect to LogSeq at ")
}

#[tokio::test]
async fn a_refused_connection_at_the_namespace_leaf_query_is_the_error_and_not_a_missing_page() {
    let logseq = mock_logseq(vec![json!([])]).await;
    let error = get_page_outline(&client(&logseq), "Retro").await.unwrap_err();
    assert!(is_not_running(&error), "{error}");
    // the resolver query went out, and nothing after the refused one
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
}

#[tokio::test]
async fn a_logseq_error_at_the_namespace_leaf_query_is_the_error_and_not_a_missing_page() {
    let logseq = mock_logseq(vec![json!([]), json!({"error": "Query timed out"})]).await;
    let error = get_page_outline(&client(&logseq), "Retro").await.unwrap_err();
    assert_eq!(error.to_string(), "LogSeq API error: Query timed out");
    // no suggestion lookup after a failed leaf query
    assert_eq!(methods(&logseq).len(), 2);
}

#[tokio::test]
async fn a_refused_connection_at_the_suggestion_lookup_is_the_error_and_not_a_missing_page() {
    let logseq = mock_logseq(vec![json!([]), json!([])]).await;
    let error = get_page_outline(&client(&logseq), "Alce").await.unwrap_err();
    assert!(is_not_running(&error), "{error}");
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery"]);
}

#[tokio::test]
async fn a_logseq_error_at_the_suggestion_lookup_is_a_missing_page_with_no_suggestions() {
    // The one place an error is allowed to be empty: suggestions are best effort (`suggest_pages`), and the
    // page is missing either way. Infrastructure errors, above, are not swallowed.
    let logseq = mock_logseq(vec![json!([]), json!([]), json!({"error": "getAllPages failed"})]).await;
    let error = get_page_outline(&client(&logseq), "Alce").await.unwrap_err();
    let ToolError::PageNotFound(missing) = error else { panic!("expected a missing page, got {error}") };
    assert!(missing.suggestions.is_empty());
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery", "logseq.Editor.getAllPages"]);
}

#[tokio::test]
async fn an_unreadable_page_list_at_the_suggestion_lookup_is_a_response_error_and_not_no_suggestions() {
    let logseq = mock_logseq(vec![json!([]), json!([]), json!("not a page list")]).await;
    let error = get_page_outline(&client(&logseq), "Alce").await.unwrap_err();
    assert!(matches!(error, ToolError::Response(_)), "{error}");
}
