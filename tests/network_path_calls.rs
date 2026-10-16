//! The LogSeq traffic of `logseq_explore_network` with `to` against a mock LogSeq on a local port: how many calls
//! the path makes, in which order, with which inputs, and what it answers. The call counts are those in `docs/performance.md`
//! ("Current Implementation Status"); the parity harness (`parity.rs`) checks the same calls and the result bytes
//! against the recorded results. Every page here is made up (BR-0001).
//!
//! The two pages are resolved together, so the order their first two requests arrive in is not fixed. This mock
//! answers by what a request asks, not by its place in the line.

use std::sync::{Arc, Mutex};

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::explore_network::{MAX_FRONTIER, explore_path};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct MockLogseq {
    api_url: String,
    seen: Arc<Mutex<Vec<Value>>>,
}

/// A LogSeq that answers each request with `answer(request)`, and records the requests. It stops with the test.
async fn mock_logseq(answer: impl Fn(&Value) -> Value + Send + 'static) -> MockLogseq {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
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
            let request: Value = serde_json::from_str(&body).unwrap();
            let reply = answer(&request).to_string();
            recorded.lock().unwrap().push(request);
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    MockLogseq { api_url, seen }
}

fn client(logseq: &MockLogseq) -> LogseqClient {
    LogseqClient::new(&Config { api_url: logseq.api_url.clone(), auth_token: "t".into(), timeout_ms: Some(5000), tips: None })
}

fn page(id: i64, name: &str, alias: &[i64]) -> Value {
    let mut page = json!({"id": id, "name": name.to_lowercase(), "original-name": name, "file": {"id": id + 5000}});
    if !alias.is_empty() {
        page["alias"] = Value::Array(alias.iter().map(|id| json!({"id": id})).collect());
    }
    page
}

/// A connected-pages row: `[source, connected, name, originalName, isJournal, relType, count]`.
fn row(source: i64, connected: i64, name: &str, rel: &str, count: i64) -> Value {
    json!([source, connected, name.to_lowercase(), name, false, rel, count])
}

/// The query text of a request, or the method of one that is not a query.
fn text_of(request: &Value) -> String {
    let args = request["args"].as_array().unwrap();
    match request["method"].as_str().unwrap() {
        "logseq.DB.datascriptQuery" => args[0].as_str().unwrap().to_owned(),
        method => method.to_owned(),
    }
}

/// `Some(name)` when the request is the resolver's first query for that name.
fn resolver_name(request: &Value) -> Option<String> {
    text_of(request).contains(":in $ ?n :where (or-join [?n ?page ?via]").then(|| {
        let input = request["args"][1].as_str().unwrap();
        serde_json::from_str::<String>(input).unwrap()
    })
}

/// The first-query answer for a name: the page it names, else nothing.
fn resolve(name: &str, pages: &[Value]) -> Value {
    Value::Array(pages.iter().filter(|page| page["name"] == name).map(|page| json!([page, "name"])).collect())
}

/// What a call asked, in order: a query's text or a method's name.
fn asked(logseq: &MockLogseq) -> Vec<String> {
    logseq.seen.lock().unwrap().iter().map(text_of).collect()
}

fn count_matching(logseq: &MockLogseq, needle: &str) -> usize {
    asked(logseq).iter().filter(|text| text.contains(needle)).count()
}

fn atlas_and_bob() -> Vec<Value> {
    vec![page(10, "Atlas", &[]), page(20, "Bob", &[])]
}

const RETRY: &str = "Retry in a moment, or call logseq_get_graph to check which graph is open.";

#[tokio::test]
async fn the_same_name_twice_is_resolved_once_and_is_one_page() {
    let pages = vec![page(10, "Atlas", &[])];
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!([]),
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", " ATLAS ", 2, 2).await.unwrap();

    // one resolver for both pages, and no walk: they are one page
    assert_eq!(logseq.seen.lock().unwrap().len(), 1);
    assert_eq!(answer.warnings[0].code, "same_page");
    assert!(answer.nodes.is_empty() && answer.edges.is_empty());
}

#[tokio::test]
async fn a_page_with_aliases_adds_one_query_for_both_pages_and_the_first_hop_covers_every_name() {
    let pages = vec![page(10, "Atlas", &[11]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.starts_with("[:find ?start") {
            json!([[10, {"id": 10, "name": "atlas", "original-name": "Atlas"}], [10, {"id": 11, "name": "project atlas", "original-name": "Project Atlas"}]])
        } else {
            // the hop from every name of the first page reaches Bob
            json!([row(10, 20, "Bob", "outbound", 2)])
        }
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 2, 2).await.unwrap();

    // two resolvers, one alias lookup for both pages, one grouped hop over the group
    assert_eq!(logseq.seen.lock().unwrap().len(), 4);
    assert_eq!(count_matching(&logseq, "[(ground [10]) [?start ...]]"), 1);
    assert_eq!(count_matching(&logseq, "[(ground [[10 10] [11 10]]) [[?source ?group] ...]]"), 1);
    assert_eq!(answer.resolved_aliases, Some(json!({"page": ["Atlas", "Project Atlas"]})));
    assert_eq!(answer.nodes.iter().map(|node| node.id).collect::<Vec<_>>(), [10, 20]);
}

#[tokio::test]
async fn a_path_costs_the_resolvers_and_one_query_per_hop_and_reads_no_page() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?source ...]]") {
            json!([row(10, 30, "Team X", "outbound", 1), row(10, 31, "Team Y", "outbound", 3)])
        } else if text.contains("[(ground [30 31]) [?source ...]]") {
            json!([row(31, 20, "Bob", "outbound", 2), row(30, 32, "Team Z", "outbound", 1)])
        } else {
            panic!("unexpected request {text}")
        }
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 2, 2).await.unwrap();

    // 2 resolvers, hop 1, hop 2 (finds Bob), and no page tree or any other read
    let asked = asked(&logseq);
    assert_eq!(asked.len(), 4);
    assert!(asked.iter().all(|text| text.starts_with('[')), "{asked:?}");
    assert_eq!(answer.hops(), Some(2));
    assert_eq!(answer.nodes.iter().map(|node| node.name.as_str()).collect::<Vec<_>>(), ["Atlas", "Team Y", "Bob"]);
    assert_eq!(answer.edges.iter().map(|edge| (edge.from, edge.to, edge.outbound, edge.inbound)).collect::<Vec<_>>(), [(10, 31, 3, 0), (31, 20, 2, 0)]);
    assert!(answer.warnings.is_empty());
}

#[tokio::test]
async fn a_walk_that_finds_nothing_stops_after_max_depth_hops_and_says_how_far_it_went() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?source ...]]") {
            json!([row(10, 30, "Team X", "outbound", 1)])
        } else if text.contains("[(ground [30]) [?source ...]]") {
            json!([row(30, 31, "Team Y", "outbound", 1)])
        } else {
            panic!("unexpected request {text}")
        }
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 2, 2).await.unwrap();

    // 2 resolvers and 2 hops, no third though Team Y has pages to expand
    assert_eq!(asked(&logseq).len(), 4);
    assert!(answer.nodes.is_empty() && answer.hops().is_none());
    assert_eq!(answer.warnings.len(), 1);
    assert_eq!(answer.warnings[0].code, "no_path_within");
    assert_eq!(answer.warnings[0].message, "No path from \"Atlas\" to \"Bob\" within 2 hops.");
    assert_eq!(answer.warnings[0].how_to_fetch_all.as_deref(), Some("Set max_depth to 3 to look one hop further (max 3)."));
    assert!(answer.has_more());
}

#[tokio::test]
async fn a_walk_that_runs_out_of_pages_ends_early_and_offers_nothing_more() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!([]),
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 3, 3).await.unwrap();

    // 2 resolvers and the first hop, which reaches nothing, so there is no second hop
    assert_eq!(logseq.seen.lock().unwrap().len(), 3);
    assert_eq!(answer.warnings[0].code, "no_path_within");
    assert!(answer.warnings[0].message.contains("every page linked within 1 hop was reached"), "{}", answer.warnings[0].message);
    assert!(!answer.has_more());
}

#[tokio::test]
async fn a_depth_of_zero_walks_no_hop() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => panic!("unexpected request {}", text_of(request)),
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 0, 0).await.unwrap();

    assert_eq!(logseq.seen.lock().unwrap().len(), 2);
    assert_eq!(answer.warnings[0].message, "No path from \"Atlas\" to \"Bob\" within 0 hops.");
    assert_eq!(answer.warnings[0].how_to_fetch_all.as_deref(), Some("Set max_depth to 1 to look one hop further (max 3)."));
}

#[tokio::test]
async fn two_names_of_one_page_make_no_hop_and_say_so() {
    // "Atlas" is the page, "Project Atlas" is its alias: both resolve to page 10
    let pages = vec![page(10, "Atlas", &[11])];
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            if name == "project atlas" { json!([[pages[0].clone(), "alias"]]) } else { resolve(&name, &pages) }
        } else if text.starts_with("[:find ?start") {
            json!([[10, {"id": 10, "name": "atlas", "original-name": "Atlas"}], [10, {"id": 11, "name": "project atlas", "original-name": "Project Atlas"}]])
        } else {
            panic!("unexpected request {text}")
        }
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Project Atlas", 2, 2).await.unwrap();

    // 2 resolvers and the alias lookup, and no hop
    assert_eq!(logseq.seen.lock().unwrap().len(), 3);
    assert_eq!(answer.warnings.len(), 1);
    assert_eq!(answer.warnings[0].code, "same_page");
    assert_eq!(answer.resolved_from, Some(json!({"to": {"name": "Project Atlas", "matchedBy": "alias", "resolvedTo": "Atlas"}})));
}

#[tokio::test]
async fn a_hop_past_five_hundred_pages_expands_the_lowest_ids_and_warns_if_nothing_is_found() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?source ...]]") {
            // 600 linked pages, highest first
            Value::Array((1000..1600).rev().map(|id| row(10, id, &format!("Page {id}"), "outbound", 1)).collect())
        } else {
            json!([])
        }
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 2, 2).await.unwrap();

    let asked = asked(&logseq);
    assert_eq!(asked.len(), 4, "2 resolvers and 2 hops");
    // the second hop expanded 500 of the 600, the lowest ids
    let expanded: Vec<String> = (1000..1000 + MAX_FRONTIER as i64).map(|id| id.to_string()).collect();
    assert!(asked[3].contains(&format!("[(ground [{}]) [?source ...]]", expanded.join(" "))));
    let codes: Vec<&str> = answer.warnings.iter().map(|warning| warning.code.as_str()).collect();
    assert_eq!(codes, ["frontier_truncated", "no_path_within"]);
    assert_eq!(
        answer.warnings[0].message,
        "Hop 2 expanded only 500 of the 600 pages reached before it, the ones with the lowest ids, so \"no path\" may be a false negative. Try a smaller max_depth or more specific pages."
    );
}

/// 600 pages linked from Atlas, highest id first, and a hop 2 over the 500 lowest that reaches one more page, 5000
fn after_a_cut_hop(hop_three: Value) -> impl Fn(&Value) -> Value + Send + 'static {
    let pages = atlas_and_bob();
    move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?source ...]]") {
            Value::Array((1000..1600).rev().map(|id| row(10, id, &format!("Page {id}"), "outbound", 1)).collect())
        } else if text.contains("[(ground [1000 1001") {
            json!([row(1000, 5000, "Team X", "outbound", 1)])
        } else if text.contains("[(ground [5000]) [?source ...]]") {
            hop_three.clone()
        } else {
            json!([])
        }
    }
}

#[tokio::test]
async fn a_path_found_after_a_cut_hop_is_real_and_says_a_shorter_one_may_exist() {
    let logseq = mock_logseq(after_a_cut_hop(json!([row(5000, 20, "Bob", "outbound", 1)]))).await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 3, 3).await.unwrap();

    assert_eq!(answer.hops(), Some(3));
    assert_eq!(answer.nodes.iter().map(|node| node.id).collect::<Vec<_>>(), [10, 1000, 5000, 20]);
    assert_eq!(answer.warnings.len(), 1);
    assert_eq!(answer.warnings[0].code, "frontier_truncated");
    assert_eq!(
        answer.warnings[0].message,
        "Hop 2 expanded only 500 of the 600 pages reached before it, the ones with the lowest ids, so this path of 3 hops is real but a shorter one may exist. \
         Start from a more specific page to be sure of the shortest."
    );
    assert!(!answer.has_more());
}

#[tokio::test]
async fn a_path_found_at_the_cut_hop_itself_is_as_short_as_any_and_says_nothing() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?source ...]]") {
            Value::Array((1000..1600).rev().map(|id| row(10, id, &format!("Page {id}"), "outbound", 1)).collect())
        } else {
            json!([row(1200, 20, "Bob", "outbound", 1)])
        }
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 3, 3).await.unwrap();

    assert_eq!(answer.hops(), Some(2));
    assert!(answer.warnings.is_empty());
}

#[tokio::test]
async fn a_page_that_is_no_page_fails_with_the_closest_names_and_the_other_page_is_still_resolved() {
    let pages = vec![page(10, "Atlas", &[])];
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains(":block/namespace") {
            json!([])
        } else if text == "logseq.Editor.getAllPages" {
            json!([{"id": 10, "name": "atlas", "originalName": "Atlas"}])
        } else {
            panic!("unexpected request {text}")
        }
    })
    .await;

    let error = explore_path(&client(&logseq), "Atlas", "Atlsa", 2, 2).await.unwrap_err();

    assert!(matches!(error, ToolError::PageNotFound(_)), "{error}");
    assert!(error.to_string().starts_with("No page \"Atlsa\"."));
    // both resolvers ran, then the missing page's leaf query and its suggestion lookup
    assert_eq!(logseq.seen.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn a_failed_connection_is_the_error_even_when_the_other_page_is_not_found_first() {
    // Nothing listens: both resolvers fail to connect. The error is the connection's, not a missing page.
    // Port 1 is privileged and never bound, so the connection is refused; a port freed by dropping a listener
    // could be handed to another test's mock in this binary (#450).
    let dead = "http://127.0.0.1:1".to_owned();
    let client = LogseqClient::new(&Config { api_url: dead, auth_token: "t".into(), timeout_ms: Some(2000), tips: None });

    let error = explore_path(&client, "Atlas", "Bob", 2, 2).await.unwrap_err();

    assert!(error.to_string().starts_with("Cannot connect to LogSeq at"), "{error}");
}

#[tokio::test]
async fn a_failed_hop_is_the_error_and_not_an_empty_path() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!({"error": "Query timed out"}),
    })
    .await;

    let error = explore_path(&client(&logseq), "Atlas", "Bob", 2, 2).await.unwrap_err();

    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn a_null_hop_stops_the_walk_with_no_more_calls_and_says_a_path_may_have_been_missed() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?source ...]]") {
            json!([row(10, 30, "Team X", "outbound", 1)])
        } else {
            // hop 2 and anything after it
            Value::Null
        }
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 3, 3).await.unwrap();

    // 2 resolvers, hop 1, hop 2 (null): no hop 3, though 3 hops were allowed
    assert_eq!(asked(&logseq).len(), 4);
    assert!(answer.nodes.is_empty());
    assert!(!answer.has_more());
    assert_eq!(answer.warnings.len(), 1, "no no_path_within: that is not known");
    assert_eq!(answer.warnings[0].code, "links_unavailable");
    assert_eq!(
        answer.warnings[0].message,
        format!(
            "LogSeq returned no answer when looking up the pages linked at hop 2 of the path (possibly no graph open or a \
             re-index in progress), so the walk stopped there and a path may have been missed. \
             This does not mean the pages are not connected. {RETRY}"
        )
    );
}

#[tokio::test]
async fn a_real_empty_answer_is_no_path_and_not_unavailable() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!([]),
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 2, 2).await.unwrap();

    assert_eq!(answer.warnings.iter().map(|warning| warning.code.as_str()).collect::<Vec<_>>(), ["no_path_within"]);
}

#[tokio::test]
async fn a_null_hop_after_a_cut_hop_keeps_the_frontier_warning_and_adds_its_own() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?source ...]]") {
            Value::Array((1000..1600).rev().map(|id| row(10, id, &format!("Page {id}"), "outbound", 1)).collect())
        } else {
            Value::Null
        }
    })
    .await;

    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 2, 2).await.unwrap();

    let codes: Vec<&str> = answer.warnings.iter().map(|warning| warning.code.as_str()).collect();
    assert_eq!(codes, ["frontier_truncated", "links_unavailable"]);
    assert!(!answer.has_more());
}

#[tokio::test]
async fn a_depth_past_the_limit_says_it_was_capped() {
    let pages = atlas_and_bob();
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?source ...]]") {
            json!([row(10, 30, "Team X", "outbound", 1)])
        } else if text.contains("[(ground [30]) [?source ...]]") {
            json!([row(30, 31, "Team Y", "outbound", 1)])
        } else if text.contains("[(ground [31]) [?source ...]]") {
            json!([row(31, 32, "Team Z", "outbound", 1)])
        } else {
            panic!("unexpected request {text}")
        }
    })
    .await;

    // the handler passes at most 3 and the depth it was asked for
    let answer = explore_path(&client(&logseq), "Atlas", "Bob", 3, 9).await.unwrap();

    assert_eq!(asked(&logseq).len(), 5);
    assert_eq!(answer.warnings.len(), 1);
    assert_eq!(
        answer.warnings[0].message,
        "No path from \"Atlas\" to \"Bob\" within 3 hops. max_depth 9 was capped at 3. max_depth is capped at 3, so no longer path can be searched."
    );
    assert!(!answer.has_more());
}
