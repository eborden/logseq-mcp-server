//! The backlinks tool's LogSeq traffic against a mock LogSeq on a local port: how many calls it
//! makes, in which order, with which inputs, and what it answers. The parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the TypeScript
//! server. Every page and block here is made up (BR-0001).
//!
//! The mock is the one `get_page_outline_calls.rs` has: each test file is its own crate, and
//! sharing it would touch the outline's tests.

use std::sync::{Arc, Mutex};

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::get_backlinks::{Outcome, get_backlinks_with_meta};
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

fn page(id: i64, name: &str, original: &str, alias: &[i64]) -> Value {
    let mut page = json!({"id": id, "name": name, "original-name": original, "file": {"id": id + 5000}});
    if !alias.is_empty() {
        page["alias"] = Value::Array(alias.iter().map(|id| json!({"id": id})).collect());
    }
    page
}

/// A linking block as the Editor API sends it.
fn editor_block(id: i64, page: i64, page_name: &str) -> Value {
    json!({"id": id, "uuid": format!("00000000-0000-4000-8000-{id:012}"), "content": "links [[Atlas]]",
        "page": {"id": page, "name": page_name, "originalName": page_name.to_uppercase()}})
}

/// A linking block as the aliased Datalog query sends it: kebab-case, the page pulled.
fn pulled_block(id: i64, page: i64, page_name: &str) -> Value {
    json!([{"id": id, "uuid": format!("00000000-0000-4000-8000-{id:012}"), "content": "links [[Atlas]]", "path-refs": [{"id": 10}],
        "page": {"id": page, "name": page_name, "original-name": page_name.to_uppercase()}}])
}

fn methods(logseq: &MockLogseq) -> Vec<String> {
    logseq.seen.lock().unwrap().iter().map(|call| call["method"].as_str().unwrap().to_owned()).collect()
}

async fn run(logseq: &MockLogseq, name: &str) -> Result<Outcome, ToolError> {
    get_backlinks_with_meta(&client(logseq), name, 20, 10).await
}

fn results_text(outcome: &Outcome) -> String {
    let results = outcome.results.clone();
    serde_json::to_string(&Value::Array(results.into_iter().map(|b| b.into_value()).collect())).unwrap()
}

#[tokio::test]
async fn a_page_with_no_aliases_costs_two_calls_the_resolver_then_the_editor_call() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "atlas", "Atlas", &[]), "name"]]),
        json!([[{"id": 1, "name": "alice", "originalName": "Alice"}, [editor_block(101, 1, "alice")]]]),
    ])
    .await;
    let outcome = run(&logseq, "Atlas").await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.Editor.getPageLinkedReferences"]);
    // an exact match hands the caller's own text on
    assert_eq!(logseq.seen.lock().unwrap()[1]["args"], json!(["Atlas"]));
    assert_eq!(outcome.results.len(), 1);
    assert_eq!(outcome.meta, None, "an exact match on a page with no aliases that fits both caps has no meta");
}

#[tokio::test]
async fn a_page_with_aliases_costs_three_calls_and_reads_the_whole_group_from_one_query() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "atlas", "Atlas", &[11]), "name"]]),
        json!([[10, {"id": 10, "name": "atlas", "original-name": "Atlas"}], [10, {"id": 11, "name": "project atlas", "original-name": "Project Atlas"}]]),
        json!([pulled_block(301, 2, "bob"), pulled_block(302, 1, "alice"), pulled_block(303, 2, "bob")]),
    ])
    .await;
    let outcome = run(&logseq, "atlas").await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"; 3]);
    let seen = logseq.seen.lock().unwrap();
    assert!(seen[1]["args"][0].as_str().unwrap().contains("[(ground [10]) [?start ...]]"));
    let references = seen[2]["args"][0].as_str().unwrap();
    assert!(references.contains("[(ground [10 11]) [?p ...]]") && references.contains("(not [(ground [10 11]) [?source ...]])"));
    assert_eq!(seen[2]["args"].as_array().unwrap().len(), 1, "ids are embedded, nothing is bound");
    drop(seen);

    // most-linking page first, camelCase entities as the Editor call has them
    let text = results_text(&outcome);
    assert!(text.starts_with(r#"[[{"id":2,"name":"bob","originalName":"BOB"},[{"id":301,"#), "{text}");
    let meta = serde_json::to_string(outcome.meta.as_ref().unwrap()).unwrap();
    assert_eq!(meta, r#"{"hasMore":false,"warnings":[],"resolvedAliases":["Atlas","Project Atlas"]}"#);
}

#[tokio::test]
async fn an_alias_link_with_no_other_page_in_the_group_still_uses_the_editor_call() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "atlas", "Atlas", &[11]), "name"]]),
        json!([[10, {"id": 10, "name": "atlas", "original-name": "Atlas"}]]),
        json!([]),
    ])
    .await;
    let outcome = run(&logseq, "atlas").await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery", "logseq.Editor.getPageLinkedReferences"]);
    assert_eq!(outcome.meta, None);
}

#[tokio::test]
async fn an_alias_name_hands_the_resolved_page_s_lowercase_name_on() {
    let logseq = mock_logseq(vec![json!([[page(10, "project atlas", "Project Atlas", &[]), "alias"]]), json!([])]).await;
    let outcome = run(&logseq, "Atlas").await.unwrap();
    assert_eq!(logseq.seen.lock().unwrap()[1]["args"], json!(["project atlas"]));
    let meta = serde_json::to_string(outcome.meta.as_ref().unwrap()).unwrap();
    assert_eq!(meta, r#"{"hasMore":false,"warnings":[],"resolvedFrom":{"name":"Atlas","matchedBy":"alias","resolvedTo":"Project Atlas"}}"#);
}

#[tokio::test]
async fn the_cut_costs_no_call_and_counts_everything_that_was_there() {
    let sources: Vec<Value> = (1..=25)
        .map(|i| json!([{"id": i, "name": format!("p{i:02}")}, [editor_block(1000 + i, i, &format!("p{i:02}"))]]))
        .collect();
    let logseq = mock_logseq(vec![json!([[page(10, "atlas", "Atlas", &[]), "name"]]), Value::Array(sources)]).await;
    let outcome = run(&logseq, "atlas").await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
    assert_eq!(outcome.results.len(), 20);
    let meta = outcome.meta.unwrap();
    assert_eq!(meta["totals"], json!({"pages": 25, "blocks": 25}));
    assert_eq!(meta["warnings"][0]["code"], "pages_truncated");
}

/// What every `null` answer to the references becomes (BR-0011, #318): an empty list and a warning, never the bare text `null`.
fn assert_backlinks_unavailable(outcome: &Outcome, extra_meta: &str) {
    assert!(outcome.results.is_empty());
    let meta = serde_json::to_string(outcome.meta.as_ref().expect("a warning needs a meta")).unwrap();
    assert!(meta.starts_with(r#"{"hasMore":false,"warnings":[{"code":"backlinks_unavailable","message":"LogSeq returned no answer when looking up the pages that link to \"Atlas\" "#), "{meta}");
    assert!(meta.ends_with(&format!(r#"Retry in a moment, or call logseq_get_graph_info to check which graph is open."}}]{extra_meta}}}"#)), "{meta}");
    assert!(!meta.contains("howToFetchAll") && !meta.contains("totals"), "{meta}");
}

#[tokio::test]
async fn a_null_answer_is_an_empty_list_and_a_warning_and_an_unreadable_one_is_an_error() {
    let logseq = mock_logseq(vec![json!([[page(10, "atlas", "Atlas", &[]), "name"]]), Value::Null]).await;
    let outcome = run(&logseq, "atlas").await.unwrap();
    assert_backlinks_unavailable(&outcome, "");
    assert_eq!(methods(&logseq).len(), 2);

    let logseq = mock_logseq(vec![json!([[page(10, "atlas", "Atlas", &[]), "name"]]), json!([[null, [{"uuid": "u"}]]])]).await;
    let error = run(&logseq, "atlas").await.unwrap_err();
    assert!(matches!(error, ToolError::Response(_)), "{error}");
    assert!(error.to_string().contains("logseq.Editor.getPageLinkedReferences in a shape this server can't read: answer[0][1][0].id"));
}

#[tokio::test]
async fn a_null_answer_to_the_aliased_query_is_the_same_empty_list_and_warning_with_the_names_the_group_has() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "atlas", "Atlas", &[11]), "name"]]),
        json!([[10, {"id": 10, "name": "atlas", "original-name": "Atlas"}], [10, {"id": 11, "name": "project atlas", "original-name": "Project Atlas"}]]),
        Value::Null,
    ])
    .await;
    let outcome = run(&logseq, "atlas").await.unwrap();
    assert_backlinks_unavailable(&outcome, r#","resolvedAliases":["Atlas","Project Atlas"]"#);
    assert_eq!(methods(&logseq).len(), 3);
}

#[tokio::test]
async fn a_null_answer_to_the_alias_lookup_warns_and_the_editor_call_reads_the_page_alone() {
    let logseq = mock_logseq(vec![json!([[page(10, "atlas", "Atlas", &[11]), "name"]]), Value::Null, json!([])]).await;
    let outcome = run(&logseq, "atlas").await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery", "logseq.Editor.getPageLinkedReferences"]);
    let meta = serde_json::to_string(outcome.meta.as_ref().unwrap()).unwrap();
    assert_eq!(
        meta,
        concat!(
            r#"{"hasMore":false,"warnings":[{"code":"alias_lookup_unavailable","message":"LogSeq returned no answer when looking up the aliases of \"Atlas\" "#,
            r#"(possibly no graph open or a re-index in progress), so references written under its other names may be missing. "#,
            r#"This does not mean it has no aliases. Retry in a moment, or call logseq_get_graph_info to check which graph is open."}]}"#
        )
    );
}

#[tokio::test]
async fn an_error_from_logseq_is_an_error_and_not_an_empty_result() {
    let logseq = mock_logseq(vec![json!([[page(10, "atlas", "Atlas", &[11]), "name"]]), json!({"error": "Query timed out"})]).await;
    let error = run(&logseq, "atlas").await.unwrap_err();
    assert_eq!(error.to_string(), "LogSeq API error: Query timed out");
}

#[tokio::test]
async fn a_missing_page_adds_the_suggestion_lookup_and_an_ambiguous_one_stops_after_the_resolver() {
    let logseq = mock_logseq(vec![json!([]), json!([]), json!([{"id": 1, "name": "alice", "originalName": "Alice"}])]).await;
    let error = run(&logseq, "Alce").await.unwrap_err();
    assert!(matches!(error, ToolError::PageNotFound(_)));
    assert_eq!(methods(&logseq).len(), 3);

    let logseq = mock_logseq(vec![json!([
        [page(40, "alice", "Alice", &[]), "alias"],
        [page(41, "alice notes", "Alice Notes", &[]), "alias"]
    ])])
    .await;
    assert!(matches!(run(&logseq, "al").await.unwrap_err(), ToolError::AmbiguousPage(_)));
    assert_eq!(methods(&logseq).len(), 1);
}
