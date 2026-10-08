//! The LogSeq traffic of `logseq_get_current_context` against a mock LogSeq on a local port: how
//! many calls it makes, with which inputs. The Rust side of the call count in `CLAUDE.md` ("Current
//! Implementation Status"); the parity harness (`parity.rs`) checks the same calls and the
//! result bytes against the TypeScript server. Every page and block here is made up (BR-0001).
//!
//! The three Editor calls are made at once, so they reach LogSeq in no fixed order: this mock answers
//! by method, not by arrival.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::js;
use logseq_mcp_server::tools::get_current_context;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const GET_CURRENT_PAGE: &str = "logseq.Editor.getCurrentPage";
const GET_CURRENT_BLOCK: &str = "logseq.Editor.getCurrentBlock";
const GET_SELECTED_BLOCKS: &str = "logseq.Editor.getSelectedBlocks";
const DATASCRIPT_QUERY: &str = "logseq.DB.datascriptQuery";

/// A LogSeq that answers each request with the canned body for its method, and records the requests.
struct MockLogseq {
    api_url: String,
    seen: Arc<Mutex<Vec<Value>>>,
}

async fn mock_logseq(answers: &[(&str, Value)]) -> MockLogseq {
    let answers: HashMap<String, Value> = answers.iter().map(|(method, answer)| ((*method).to_owned(), answer.clone())).collect();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let answers = answers.clone();
            let recorded = Arc::clone(&recorded);
            tokio::spawn(async move {
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
                let request: Value = serde_json::from_str(&body).unwrap();
                let reply = answers.get(request["method"].as_str().unwrap()).cloned().unwrap_or_else(|| json!({"error": "no answer"})).to_string();
                recorded.lock().unwrap().push(request);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
        }
    });
    MockLogseq { api_url, seen }
}

fn client(logseq: &MockLogseq) -> LogseqClient {
    LogseqClient::new(&Config { api_url: logseq.api_url.clone(), auth_token: "t".into(), timeout_ms: Some(5000.0), tips: None })
}

/// The methods called, sorted: the Editor calls arrive in no fixed order.
fn methods(logseq: &MockLogseq) -> Vec<String> {
    let mut methods: Vec<String> = logseq.seen.lock().unwrap().iter().map(|call| call["method"].as_str().unwrap().to_owned()).collect();
    methods.sort();
    methods
}

fn block(id: i64, content: &str, page: i64) -> Value {
    json!({"id": id, "uuid": format!("00000000-0000-4000-8000-{id:012}"), "content": content, "page": {"id": page}})
}

fn open_page(id: i64, name: &str) -> Value {
    json!({"id": id, "name": name.to_lowercase(), "originalName": name})
}

#[tokio::test]
async fn nothing_open_costs_the_three_editor_calls_with_no_arguments() {
    let logseq = mock_logseq(&[(GET_CURRENT_PAGE, json!(null)), (GET_CURRENT_BLOCK, json!(null)), (GET_SELECTED_BLOCKS, json!(null))]).await;
    let context = get_current_context::get_current_context(&client(&logseq)).await.unwrap();

    assert_eq!(methods(&logseq), [GET_CURRENT_BLOCK, GET_CURRENT_PAGE, GET_SELECTED_BLOCKS]);
    assert!(logseq.seen.lock().unwrap().iter().all(|call| call["args"] == json!([])));
    assert_eq!(
        js::json_stringify(&context.into_value()),
        r#"{"page":null,"message":"No page is open in LogSeq (for example the All Pages view is showing)."}"#
    );
}

#[tokio::test]
async fn blocks_on_the_open_page_need_no_lookup() {
    let logseq = mock_logseq(&[
        (GET_CURRENT_PAGE, open_page(10, "Project Atlas")),
        (GET_CURRENT_BLOCK, block(512, "on atlas", 10)),
        (GET_SELECTED_BLOCKS, json!([block(513, "also on atlas", 10)])),
    ])
    .await;
    get_current_context::get_current_context(&client(&logseq)).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
}

#[tokio::test]
async fn blocks_on_other_pages_cost_one_lookup_whatever_their_number() {
    let logseq = mock_logseq(&[
        (GET_CURRENT_PAGE, open_page(10, "Project Atlas")),
        (GET_CURRENT_BLOCK, block(512, "on atlas", 10)),
        (GET_SELECTED_BLOCKS, json!([block(105, "on bob", 20), block(106, "on bob too", 20), block(107, "on alice", 30)])),
        (DATASCRIPT_QUERY, json!([[{"id": 20, "name": "bob", "original-name": "Bob"}], [{"id": 30, "name": "alice", "original-name": "Alice"}]])),
    ])
    .await;
    let context = get_current_context::get_current_context(&client(&logseq)).await.unwrap();

    assert_eq!(methods(&logseq), [DATASCRIPT_QUERY, GET_CURRENT_BLOCK, GET_CURRENT_PAGE, GET_SELECTED_BLOCKS]);
    let calls = logseq.seen.lock().unwrap();
    let lookup = calls.iter().find(|call| call["method"] == DATASCRIPT_QUERY).unwrap();
    // the ids are embedded as typed numbers, once each, and nothing is bound with `:in`
    assert_eq!(lookup["args"], json!(["[:find (pull ?p [*]) :where [(ground [20 30]) [?p ...]] [?p :block/name]]"]));
    let names: Vec<&str> = context.selected_blocks.as_ref().unwrap().iter().map(|block| block["pageName"].as_str().unwrap()).collect();
    assert_eq!(names, ["Bob", "Bob", "Alice"]);
}

#[tokio::test]
async fn a_block_with_no_page_costs_no_lookup() {
    let logseq = mock_logseq(&[
        (GET_CURRENT_PAGE, json!(null)),
        (GET_CURRENT_BLOCK, json!({"id": 5, "uuid": "00000000-0000-4000-8000-000000000005", "content": "orphan"})),
        (GET_SELECTED_BLOCKS, json!([])),
    ])
    .await;
    let context = get_current_context::get_current_context(&client(&logseq)).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
    assert!(context.page.is_none() && context.message.is_some());
}

#[tokio::test]
async fn a_zoomed_block_names_its_page_through_one_lookup() {
    let logseq = mock_logseq(&[
        (GET_CURRENT_PAGE, json!({"id": 512, "uuid": "00000000-0000-4000-8000-000000000512", "content": "zoomed", "page": {"id": 10}})),
        (GET_CURRENT_BLOCK, json!(null)),
        (GET_SELECTED_BLOCKS, json!(null)),
        (DATASCRIPT_QUERY, json!([[{"id": 10, "name": "project atlas", "original-name": "Project Atlas"}]])),
    ])
    .await;
    let context = get_current_context::get_current_context(&client(&logseq)).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4);
    assert_eq!(js::json_stringify(&context.into_value()), r#"{"page":{"name":"project atlas","originalName":"Project Atlas"},"focusedBlock":{"uuid":"00000000-0000-4000-8000-000000000512","content":"zoomed","pageName":"Project Atlas"}}"#);
}

#[tokio::test]
async fn infrastructure_and_shape_errors_are_errors_and_not_an_empty_context() {
    let logseq = mock_logseq(&[
        (GET_CURRENT_PAGE, json!(null)),
        (GET_CURRENT_BLOCK, json!(null)),
        (GET_SELECTED_BLOCKS, json!({"error": "MethodNotExist: logseq.Editor.getSelectedBlocks"})),
    ])
    .await;
    let error = get_current_context::get_current_context(&client(&logseq)).await.unwrap_err();
    assert!(matches!(&error, ToolError::Logseq(_)), "{error}");
    // `Promise.all` lets the other fetches finish after one fails, so TypeScript always makes all three calls
    assert_eq!(methods(&logseq), [GET_CURRENT_BLOCK, GET_CURRENT_PAGE, GET_SELECTED_BLOCKS]);

    let logseq = mock_logseq(&[(GET_CURRENT_PAGE, json!(null)), (GET_CURRENT_BLOCK, json!(null)), (GET_SELECTED_BLOCKS, json!({"id": 1}))]).await;
    let error = get_current_context::get_current_context(&client(&logseq)).await.unwrap_err();
    assert!(matches!(&error, ToolError::Response(response) if response.method == GET_SELECTED_BLOCKS), "{error}");
    assert_eq!(methods(&logseq).len(), 3);
}

#[tokio::test]
async fn with_two_answers_wrong_the_error_is_the_first_in_a_fixed_order() {
    // TypeScript reports whichever arrives first; Rust reports the page, then the block, then the selection
    let logseq = mock_logseq(&[(GET_CURRENT_PAGE, json!(5)), (GET_CURRENT_BLOCK, json!({"id": 1})), (GET_SELECTED_BLOCKS, json!({"id": 1}))]).await;
    let error = get_current_context::get_current_context(&client(&logseq)).await.unwrap_err();
    assert!(matches!(&error, ToolError::Response(response) if response.method == GET_CURRENT_PAGE), "{error}");
    assert_eq!(methods(&logseq).len(), 3);
}

// A deliberate difference from TypeScript, which embeds any integer in the `ground` clause and gets no row: a
// page id that is not positive can't be a `:db/id`, so `PageId` refuses it before any query is made.
#[tokio::test]
async fn a_non_positive_page_id_is_an_error_and_makes_no_lookup() {
    let logseq = mock_logseq(&[
        (GET_CURRENT_PAGE, json!(null)),
        (GET_CURRENT_BLOCK, json!({"id": 5, "uuid": "00000000-0000-4000-8000-000000000005", "content": "on page -1", "page": {"id": -1}})),
        (GET_SELECTED_BLOCKS, json!(null)),
        (DATASCRIPT_QUERY, json!([])),
    ])
    .await;
    let error = get_current_context::get_current_context(&client(&logseq)).await.unwrap_err();

    assert!(matches!(&error, ToolError::InvalidValue(_)), "{error}");
    assert_eq!(methods(&logseq), [GET_CURRENT_BLOCK, GET_CURRENT_PAGE, GET_SELECTED_BLOCKS], "no lookup is made");
}

#[tokio::test]
async fn a_page_id_of_zero_with_no_db_id_names_no_page_and_makes_no_lookup() {
    let logseq = mock_logseq(&[
        (GET_CURRENT_PAGE, json!(null)),
        (GET_CURRENT_BLOCK, json!({"id": 5, "uuid": "00000000-0000-4000-8000-000000000005", "content": "on page 0", "page": {"id": 0}})),
        (GET_SELECTED_BLOCKS, json!(null)),
        (DATASCRIPT_QUERY, json!([])),
    ])
    .await;
    let context = get_current_context::get_current_context(&client(&logseq)).await.unwrap();

    assert_eq!(methods(&logseq), [GET_CURRENT_BLOCK, GET_CURRENT_PAGE, GET_SELECTED_BLOCKS], "no lookup is made");
    assert!(context.page.is_none());
    assert!(context.focused_block.as_ref().unwrap().get("pageName").is_none());
}
