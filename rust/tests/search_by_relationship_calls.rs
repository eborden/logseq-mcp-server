//! The relationship search's (`connected-within`, its one type since #492) LogSeq traffic against a mock LogSeq on a local port: how many calls
//! it makes, in which order, with which inputs, and what it answers. The call
//! counts are those in `CLAUDE.md` ("Current Implementation Status"); the parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the recorded results.
//! Every page and block here is made up (BR-0001).
//!
//! The two topics are resolved together, so the order their first two requests arrive in is not
//! fixed. This mock answers by what a request asks, not by its place in the line.

use std::sync::{Arc, Mutex};

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::search_by_relationship::{Args, RelationshipType, search_by_relationship};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct MockLogseq {
    api_url: String,
    seen: Arc<Mutex<Vec<Value>>>,
}

/// A LogSeq that answers each request with `answer(request)`, and records the requests. It stops
/// with the test.
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

fn uuid(n: i64) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn page(id: i64, name: &str, alias: &[i64]) -> Value {
    let mut page = json!({"id": id, "name": name.to_lowercase(), "original-name": name, "file": {"id": id + 5000}});
    if !alias.is_empty() {
        page["alias"] = Value::Array(alias.iter().map(|id| json!({"id": id})).collect());
    }
    page
}

fn editor_block(id: i64) -> Value {
    json!({"id": id, "uuid": uuid(id), "content": format!("block {id}"), "page": {"id": 10}, "children": []})
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
    let found: Vec<Value> = pages.iter().filter(|page| page["name"] == name).map(|page| json!([page, "name"])).collect();
    Value::Array(found)
}

fn args(a: &str, b: &str, relationship_type: RelationshipType) -> Args {
    Args { topic_a: a.into(), topic_b: b.into(), relationship_type, max_distance: 2, limit: 50 }
}

/// What a call asked, in order: a query's text or a method's name.
fn asked(logseq: &MockLogseq) -> Vec<String> {
    logseq.seen.lock().unwrap().iter().map(text_of).collect()
}

fn count_matching(logseq: &MockLogseq, needle: &str) -> usize {
    asked(logseq).iter().filter(|text| text.contains(needle)).count()
}

#[tokio::test]
async fn the_same_name_twice_is_resolved_once() {
    let pages = vec![page(10, "Atlas", &[])];
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!([]),
    })
    .await;

    let result = search_by_relationship(&client(&logseq), &args("Atlas", " ATLAS ", RelationshipType::ConnectedWithin)).await.unwrap();

    // one resolver for both topics, and no walk: they are one page
    assert_eq!(logseq.seen.lock().unwrap().len(), 1);
    assert_eq!(count_matching(&logseq, ":in $ ?n :where"), 1);
    assert_eq!(result["warnings"][0]["code"], "same_topic");
}

#[tokio::test]
async fn a_topic_with_aliases_adds_one_query_for_both_topics_and_matches_by_id() {
    let pages = vec![page(10, "Atlas", &[11]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.starts_with("[:find ?start") {
            json!([[10, {"id": 10, "name": "atlas", "original-name": "Atlas"}], [10, {"id": 11, "name": "project atlas", "original-name": "Project Atlas"}]])
        } else {
            // the hop from every name of topic A reaches nothing
            json!([])
        }
    })
    .await;

    let result = search_by_relationship(&client(&logseq), &args("Atlas", "Bob", RelationshipType::ConnectedWithin)).await.unwrap();

    // two resolvers, one alias lookup for both topics, one hop query over the ids of the group
    assert_eq!(logseq.seen.lock().unwrap().len(), 4);
    assert_eq!(count_matching(&logseq, "[(ground [10]) [?start ...]]"), 1);
    assert_eq!(count_matching(&logseq, "[(ground [10 11]) [?p ...]]"), 1);
    assert_eq!(result["resolvedAliases"], json!({"topicA": ["Atlas", "Project Atlas"]}));
}

#[tokio::test]
async fn connected_within_costs_one_query_per_hop_and_then_the_two_trees() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?p ...]]") {
            json!([[30], [31]])
        } else if text.contains("[(ground [30 31]) [?p ...]]") {
            json!([[20], [32]])
        } else if text == "logseq.Editor.getPageBlocksTree" {
            match request["args"][0].as_str().unwrap() {
                "Atlas" => json!([editor_block(101)]),
                _ => json!([editor_block(201)]),
            }
        } else {
            panic!("unexpected request {text}")
        }
    })
    .await;

    let result = search_by_relationship(&client(&logseq), &args("Atlas", "Bob", RelationshipType::ConnectedWithin)).await.unwrap();

    // 2 resolvers, hop 1, hop 2 (finds Bob), 2 trees
    let asked = asked(&logseq);
    assert_eq!(asked.len(), 6);
    assert_eq!(asked[4..], ["logseq.Editor.getPageBlocksTree", "logseq.Editor.getPageBlocksTree"]);
    assert_eq!(logseq.seen.lock().unwrap()[4]["args"], json!(["Atlas"]));
    assert_eq!(logseq.seen.lock().unwrap()[5]["args"], json!(["Bob"]));
    assert_eq!(result["query"]["maxDistance"], 2);
    assert_eq!(result["results"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn a_walk_that_finds_nothing_stops_after_max_distance_hops_and_reads_no_tree() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!([]),
    })
    .await;

    let result = search_by_relationship(&client(&logseq), &args("Atlas", "Bob", RelationshipType::ConnectedWithin)).await.unwrap();

    // 2 resolvers and the first hop, which reaches nothing, so there is no second hop
    assert_eq!(logseq.seen.lock().unwrap().len(), 3);
    assert_eq!(result["results"], json!([]));
    assert_eq!(result["warnings"], json!([]));
}

#[tokio::test]
async fn a_distance_of_zero_walks_no_hop() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => panic!("unexpected request {}", text_of(request)),
    })
    .await;
    let mut zero = args("Atlas", "Bob", RelationshipType::ConnectedWithin);
    zero.max_distance = 0;

    let result = search_by_relationship(&client(&logseq), &zero).await.unwrap();

    assert_eq!(logseq.seen.lock().unwrap().len(), 2);
    assert_eq!(result["query"]["maxDistance"], 0);
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

    let result = search_by_relationship(&client(&logseq), &args("Atlas", "Project Atlas", RelationshipType::ConnectedWithin)).await.unwrap();

    // 2 resolvers and the alias lookup, and no hop
    assert_eq!(logseq.seen.lock().unwrap().len(), 3);
    assert_eq!(result["warnings"][0]["code"], "same_topic");
    assert_eq!(result["results"], json!([]));
    assert_eq!(result["resolvedFrom"], json!({"topicB": {"name": "Project Atlas", "matchedBy": "alias", "resolvedTo": "Atlas"}}));
}

#[tokio::test]
async fn a_hop_past_five_hundred_pages_expands_the_lowest_ids_and_warns_if_nothing_is_found() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?p ...]]") {
            // 600 neighbours, highest first
            Value::Array((1000..1600).rev().map(|id| json!([id])).collect())
        } else {
            json!([])
        }
    })
    .await;

    let result = search_by_relationship(&client(&logseq), &args("Atlas", "Bob", RelationshipType::ConnectedWithin)).await.unwrap();

    let asked = asked(&logseq);
    assert_eq!(asked.len(), 4, "2 resolvers and 2 hops");
    // the second hop expanded 500 of the 600, the lowest ids
    let expanded: Vec<String> = (1000..1500).map(|id| id.to_string()).collect();
    assert!(asked[3].contains(&format!("[(ground [{}]) [?p ...]]", expanded.join(" "))));
    assert_eq!(result["warnings"][0]["code"], "frontier_truncated");
    assert_eq!(
        result["warnings"][0]["message"],
        "Hop 2 reached 600 pages; only 500 were expanded, so \"not connected\" may be a false negative. Try a smaller max_distance or more specific topics."
    );
}

#[tokio::test]
async fn a_topic_that_is_no_page_fails_with_the_closest_names_and_the_other_topic_is_still_resolved() {
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

    let error = search_by_relationship(&client(&logseq), &args("Atlas", "Atlsa", RelationshipType::ConnectedWithin)).await.unwrap_err();

    assert!(matches!(error, ToolError::PageNotFound(_)), "{error}");
    assert!(error.to_string().starts_with("No page \"Atlsa\"."));
    // both resolvers ran, then the missing topic's leaf query and its suggestion lookup
    assert_eq!(logseq.seen.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn a_failed_connection_is_the_error_even_when_the_other_topic_is_not_found_first() {
    // Nothing listens: both resolvers fail to connect. The error is the connection's, not a missing page.
    // Port 1 is privileged and never bound, so the connection is refused; a port freed by dropping a listener
    // could be handed to another test's mock in this binary (#450).
    let dead = "http://127.0.0.1:1".to_owned();
    let client = LogseqClient::new(&Config { api_url: dead, auth_token: "t".into(), timeout_ms: Some(2000), tips: None });

    let error = search_by_relationship(&client, &args("Atlas", "Bob", RelationshipType::ConnectedWithin)).await.unwrap_err();

    assert!(error.to_string().starts_with("Cannot connect to LogSeq at"), "{error}");
}

const RETRY: &str = "Retry in a moment, or call logseq_get_graph to check which graph is open.";

#[tokio::test]
async fn a_null_hop_stops_the_walk_with_no_more_calls_and_says_not_connected_may_be_wrong() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?p ...]]") {
            json!([[30]])
        } else {
            // hop 2 and anything after it
            Value::Null
        }
    })
    .await;

    let mut args = args("Atlas", "Bob", RelationshipType::ConnectedWithin);
    args.max_distance = 5;
    let result = search_by_relationship(&client(&logseq), &args).await.unwrap();

    // 2 resolvers, hop 1, hop 2 (null): no hop 3 and no trees, though 5 hops were allowed
    assert_eq!(asked(&logseq).len(), 4);
    assert_eq!(result["results"], json!([]));
    assert_eq!(result["hasMore"], json!(false));
    assert_eq!(
        result["warnings"],
        json!([{
            "code": "hop_unavailable",
            "message": format!(
                "LogSeq returned no answer when looking up the pages reached at hop 2 (possibly no graph open or a \
                 re-index in progress), so the walk stopped there and \"not connected\" may be wrong. \
                 This does not mean the topics are not connected. {RETRY}"
            ),
        }])
    );
}

#[tokio::test]
async fn a_null_page_tree_is_a_warning_naming_the_topic_and_the_connection_is_still_reported() {
    // (which trees answer null, the warned topics, the blocks that remain)
    let cases: [(&[&str], &[&str], &[i64]); 3] = [(&["Atlas"], &["A"], &[201]), (&["Bob"], &["B"], &[101]), (&["Atlas", "Bob"], &["A", "B"], &[])];
    for (null_trees, warned, kept) in cases {
        let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
        let null_trees: Vec<String> = null_trees.iter().map(|name| (*name).to_owned()).collect();
        let logseq = mock_logseq(move |request| {
            let text = text_of(request);
            if let Some(name) = resolver_name(request) {
                resolve(&name, &pages)
            } else if text.contains("[(ground [10]) [?p ...]]") {
                json!([[20]])
            } else if text == "logseq.Editor.getPageBlocksTree" {
                match request["args"][0].as_str().unwrap() {
                    name if null_trees.iter().any(|null| null == name) => Value::Null,
                    "Atlas" => json!([editor_block(101)]),
                    _ => json!([editor_block(201)]),
                }
            } else {
                panic!("unexpected request {text}")
            }
        })
        .await;

        let result = search_by_relationship(&client(&logseq), &args("Atlas", "Bob", RelationshipType::ConnectedWithin)).await.unwrap();

        // no extra call: 2 resolvers, hop 1, 2 trees
        assert_eq!(asked(&logseq).len(), 5);
        let kept_ids: Vec<i64> = result["results"].as_array().unwrap().iter().map(|block| block["id"].as_i64().unwrap()).collect();
        assert_eq!(kept_ids, kept, "{warned:?}");
        assert_eq!(result["hasMore"], json!(false));
        let warnings = result["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), warned.len(), "{warned:?}");
        for (warning, which) in warnings.iter().zip(warned) {
            let topic = if *which == "A" { "Atlas" } else { "Bob" };
            assert_eq!(warning["code"], "page_blocks_unavailable");
            assert_eq!(
                warning["message"],
                format!(
                    "LogSeq returned no answer when looking up the blocks of topic {which} (\"{topic}\") (possibly no graph open or a \
                     re-index in progress), so its blocks are missing from the results although the topics are connected. \
                     This does not mean the page has no blocks. {RETRY}"
                )
            );
        }
    }
}

#[tokio::test]
async fn a_real_empty_page_tree_has_no_warning() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?p ...]]") {
            json!([[20]])
        } else {
            json!([])
        }
    })
    .await;

    let result = search_by_relationship(&client(&logseq), &args("Atlas", "Bob", RelationshipType::ConnectedWithin)).await.unwrap();

    assert_eq!((&result["results"], &result["warnings"]), (&json!([]), &json!([])));
}

#[tokio::test]
async fn a_null_hop_after_a_cut_hop_keeps_the_frontier_warning_and_adds_its_own() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.contains("[(ground [10]) [?p ...]]") {
            Value::Array((1000..1600).rev().map(|id| json!([id])).collect())
        } else {
            Value::Null
        }
    })
    .await;

    let result = search_by_relationship(&client(&logseq), &args("Atlas", "Bob", RelationshipType::ConnectedWithin)).await.unwrap();

    let codes: Vec<&str> = result["warnings"].as_array().unwrap().iter().map(|warning| warning["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["frontier_truncated", "hop_unavailable"]);
    assert_eq!(result["hasMore"], json!(false));
}

