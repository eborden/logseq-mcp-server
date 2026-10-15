//! The block finder's `page` and `links_to` filters (#492) through its `call`, against a mock LogSeq on a local port:
//! how many calls a search that names pages makes, in which order, with which inputs, and what it answers. The
//! parity harness (`parity.rs`) checks the same calls and the result bytes against the recorded results; the filters
//! that name no page are pinned in `simple_tools_calls.rs`. Every page and block here is made up (BR-0001).
//!
//! The names are resolved one after the other, so this mock answers by what a request asks, not by its place in the
//! line.

use std::sync::{Arc, Mutex};

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use logseq_mcp_server::dates::Clock;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::snapshots::Snapshots;
use logseq_mcp_server::tools::find_blocks;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 2025-03-12T12:00:00Z: the 12th in every zone from UTC-12 to UTC+11, as in `simple_tools_calls.rs`.
const NOW: Clock = Clock::Fixed(1_741_780_800_000);

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

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

fn page(id: i64, name: &str, alias: &[i64]) -> Value {
    let mut page = json!({"id": id, "name": name.to_lowercase(), "original-name": name, "file": {"id": id + 5000}});
    if !alias.is_empty() {
        page["alias"] = Value::Array(alias.iter().map(|id| json!({"id": id})).collect());
    }
    page
}

/// A search hit, as a row of the finder's query.
fn hit(id: i64, content: &str) -> Value {
    json!([{"id": id, "uuid": format!("00000000-0000-4000-8000-{id:012}"), "content": content, "page": {"id": 10, "name": "atlas", "original-name": "Atlas"}}])
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

fn is_search(request: &Value) -> bool {
    text_of(request).starts_with("[:find (pull ?b [* {:block/page")
}

fn resolve(name: &str, pages: &[Value]) -> Value {
    Value::Array(pages.iter().filter(|page| page["name"] == name).map(|page| json!([page, "name"])).collect())
}

/// What a call asked, in order: a query's text or a method's name.
fn asked(logseq: &MockLogseq) -> Vec<String> {
    logseq.seen.lock().unwrap().iter().map(text_of).collect()
}

fn searches(logseq: &MockLogseq) -> Vec<Value> {
    logseq.seen.lock().unwrap().iter().filter(|request| is_search(request)).cloned().collect()
}

fn count_resolvers(logseq: &MockLogseq) -> usize {
    logseq.seen.lock().unwrap().iter().filter(|request| resolver_name(request).is_some()).count()
}

/// The two content blocks of a call: the results, then the meta.
async fn run(logseq: &MockLogseq, tips: bool, args: Value) -> Result<(Vec<Value>, Value), ToolError> {
    let result = find_blocks::call(&client(logseq), tips, NOW, &Snapshots::new(1), arguments(args)).await?;
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    let results: Vec<Value> = serde_json::from_str(content[0]["text"].as_str().unwrap()).unwrap();
    let meta: Value = serde_json::from_str(content[1]["text"].as_str().unwrap()).unwrap();
    Ok((results, meta["meta"].clone()))
}

#[tokio::test]
async fn a_page_and_a_link_cost_two_resolvers_and_the_search_and_match_by_the_ids_of_the_pages() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!([hit(101, "see [[Bob]]"), hit(102, "and #bob")]),
    })
    .await;

    let (results, meta) = run(&logseq, false, json!({"page": "Atlas", "links_to": ["Bob"]})).await.unwrap();

    // two resolvers and the search: the 3 calls the `references` mode of the relationship search made
    assert_eq!(logseq.seen.lock().unwrap().len(), 3);
    assert_eq!(count_resolvers(&logseq), 2);
    let search = &searches(&logseq)[0];
    assert_eq!(
        search["args"],
        json!(["[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}]) :in $ :where [(ground [10]) [?page ...]] [?b :block/page ?page] [(ground [20]) [?ref0 ...]] [?b :block/refs ?ref0]]"])
    );
    // newest first, and no name in the query text
    assert_eq!(results.iter().map(|hit| hit["uuid"].as_str().unwrap().to_owned()).collect::<Vec<_>>().len(), 2);
    assert_eq!(results[0]["content"], "and #bob");
    assert_eq!(meta, json!({"hasMore": false, "warnings": [], "totals": {"matches": 2}}));
}

#[tokio::test]
async fn aliases_add_one_query_for_every_page_together_and_the_search_covers_each_group() {
    let pages = vec![page(10, "Atlas", &[11]), page(20, "Bob", &[21])];
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text.starts_with("[:find ?start") {
            json!([
                [10, {"id": 10, "name": "atlas", "original-name": "Atlas"}],
                [10, {"id": 11, "name": "project atlas", "original-name": "Project Atlas"}],
                [20, {"id": 20, "name": "bob", "original-name": "Bob"}],
                [20, {"id": 21, "name": "robert", "original-name": "Robert"}]
            ])
        } else {
            json!([hit(101, "see [[Robert]]")])
        }
    })
    .await;

    let (results, meta) = run(&logseq, false, json!({"page": "Atlas", "links_to": ["Bob"]})).await.unwrap();

    // two resolvers, one alias lookup for both pages, the search: 4
    let calls = asked(&logseq);
    assert_eq!(calls.len(), 4);
    assert_eq!(calls.iter().filter(|text| text.contains("[(ground [10 20]) [?start ...]]")).count(), 1, "{calls:?}");
    assert!(calls[3].contains(":where [(ground [10 11]) [?page ...]] [?b :block/page ?page] [(ground [20 21]) [?ref0 ...]] [?b :block/refs ?ref0]]"), "{}", calls[3]);
    assert_eq!(results.len(), 1);
    // each page that has aliases says which names it was searched under, before the completeness keys
    assert_eq!(meta["resolvedAliases"], json!({"Atlas": ["Atlas", "Project Atlas"], "Bob": ["Bob", "Robert"]}));
    let keys: Vec<&str> = meta.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["resolvedAliases", "hasMore", "warnings", "totals"]);
    assert!(meta.get("resolvedFrom").is_none(), "both names were exact");
}

#[tokio::test]
async fn a_name_that_is_an_alias_says_which_page_it_stood_for_and_an_exact_one_says_nothing() {
    // "Alpha" is declared as an alias by Atlas: the resolver answers Atlas, through the alias
    let atlas = page(10, "Atlas", &[11]);
    let logseq = mock_logseq(move |request| {
        let text = text_of(request);
        if let Some(name) = resolver_name(request) {
            match name.as_str() {
                "alpha" => json!([[atlas, "alias"]]),
                _ => json!([]),
            }
        } else if text.starts_with("[:find ?start") {
            json!([[10, {"id": 10, "name": "atlas", "original-name": "Atlas"}], [10, {"id": 11, "name": "alpha", "original-name": "Alpha"}]])
        } else {
            json!([hit(101, "x")])
        }
    })
    .await;

    let (_, meta) = run(&logseq, false, json!({"links_to": ["Alpha"]})).await.unwrap();
    assert_eq!(meta["resolvedFrom"], json!([{"name": "Alpha", "matchedBy": "alias", "resolvedTo": "Atlas"}]));
    assert_eq!(meta["resolvedAliases"], json!({"Atlas": ["Alpha", "Atlas"]}));
}

#[tokio::test]
async fn a_name_given_twice_is_resolved_once_and_the_page_may_be_one_of_the_links() {
    let pages = vec![page(10, "Atlas", &[])];
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!([hit(101, "x")]),
    })
    .await;

    run(&logseq, false, json!({"page": "Atlas", "links_to": [" ATLAS ", "atlas"]})).await.unwrap();

    // one resolver for the three spellings of one name, then the search, which asks for the page and, twice, its links
    assert_eq!(logseq.seen.lock().unwrap().len(), 2);
    assert_eq!(count_resolvers(&logseq), 1);
    let query = text_of(&searches(&logseq)[0]);
    assert!(query.contains("[(ground [10]) [?ref0 ...]] [?b :block/refs ?ref0] [(ground [10]) [?ref1 ...]] [?b :block/refs ?ref1]"), "{query}");
}

#[tokio::test]
async fn the_most_pages_a_call_can_name_cost_six_resolvers_and_the_search() {
    let names = ["Atlas", "Alice", "Bob", "Carol", "Dave", "Erin"];
    let pages: Vec<Value> = names.iter().enumerate().map(|(n, name)| page(10 + n as i64, name, &[])).collect();
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!([]),
    })
    .await;

    let (results, meta) = run(&logseq, false, json!({"page": "Atlas", "links_to": ["Alice", "Bob", "Carol", "Dave", "Erin"], "text": "x"})).await.unwrap();

    assert_eq!(logseq.seen.lock().unwrap().len(), 7);
    assert_eq!(count_resolvers(&logseq), 6);
    // the order the names were asked in is the order of the groups, and every string is an input
    let query = text_of(&searches(&logseq)[0]);
    for (n, id) in (11..16).enumerate() {
        assert!(query.contains(&format!("[(ground [{id}]) [?ref{n} ...]] [?b :block/refs ?ref{n}]")), "{query}");
    }
    assert!(query.contains(":in $ ?pattern :where"), "{query}");
    assert!(!query.contains("Alice") && !query.contains("alice"), "{query}");
    assert!(results.is_empty());
    assert_eq!(meta["totals"], json!({"matches": 0}));
}

#[tokio::test]
async fn the_pages_combine_with_the_text_the_property_and_the_period_in_the_one_search() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!([hit(101, "x")]),
    })
    .await;

    run(&logseq, false, json!({"page": "Atlas", "links_to": ["Bob"], "text": "a.b", "property": "status", "value": "doing", "last_n": 7})).await.unwrap();

    // 2 resolvers and 1 search, whatever the filters
    assert_eq!(logseq.seen.lock().unwrap().len(), 3);
    let search = &searches(&logseq)[0];
    let query = search["args"][0].as_str().unwrap();
    assert!(query.contains(":in $ ?start ?end ?key ?value ?pattern :where [(ground [10]) [?page ...]] [?page :block/name]"), "{query}");
    assert!(query.contains("[(ground [20]) [?ref0 ...]] [?b :block/refs ?ref0] [?b :block/properties ?props]"), "{query}");
    // the days of `last_n: 7` ending 2025-03-12, then the property, then the text, each bound as an input
    assert_eq!(search["args"].as_array().unwrap()[1..], [json!("20250306"), json!("20250312"), json!(r#""status""#), json!(r#""doing""#), json!(r#""(?i)a\\.b""#)]);
}

#[tokio::test]
async fn a_page_that_does_not_exist_is_an_error_with_the_closest_names_and_the_search_is_never_made() {
    let pages = vec![page(10, "Atlas", &[])];
    let all = json!([{"id": 10, "name": "atlas", "originalName": "Atlas"}, {"id": 12, "name": "atlantis", "originalName": "Atlantis"}]);
    let logseq = mock_logseq(move |request| match request["method"].as_str().unwrap() {
        "logseq.Editor.getAllPages" => all.clone(),
        _ => match resolver_name(request) {
            Some(name) => resolve(&name, &pages),
            None => json!([]),
        },
    })
    .await;

    let error = run(&logseq, false, json!({"page": "Atlas", "links_to": ["Atla"]})).await.unwrap_err();

    assert!(matches!(&error, ToolError::PageNotFound(missing) if missing.page_name == "Atla" && missing.suggestions.iter().any(|name| name == "Atlas")), "{error}");
    assert!(searches(&logseq).is_empty(), "no search for a page that is not there");
}

#[tokio::test]
async fn a_name_that_two_pages_share_is_ambiguous_and_nothing_is_picked() {
    let pages = vec![page(11, "Bob One", &[]), page(12, "Bob Two", &[])];
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) if name == "bob" => json!([[pages[0], "alias"], [pages[1], "alias"]]),
        Some(_) => json!([]),
        None => json!([]),
    })
    .await;

    let error = run(&logseq, false, json!({"links_to": ["Bob"]})).await.unwrap_err();

    assert!(matches!(error, ToolError::AmbiguousPage(_)), "{error}");
    assert!(searches(&logseq).is_empty());
}

#[tokio::test]
async fn a_logseq_error_while_resolving_a_page_is_an_error_and_not_an_empty_result() {
    let logseq = mock_logseq(|_| json!({"error": "Query timed out"})).await;
    let error = run(&logseq, false, json!({"page": "Atlas"})).await.unwrap_err();
    assert_eq!(error.to_string(), "LogSeq API error: Query timed out");
    assert!(searches(&logseq).is_empty());
}

#[tokio::test]
async fn a_refused_argument_makes_no_call() {
    let logseq = mock_logseq(|_| json!([])).await;
    for bad in [
        json!({"page": ""}),
        json!({"page": "  "}),
        json!({"links_to": []}),
        json!({"links_to": ["Alice", ""]}),
        json!({"links_to": ["a", "b", "c", "d", "e", "f"]}),
        json!({"links_to": "Alice"}),
        json!({"page": 5}),
        json!({"page": "Atlas", "property": "status"}),
        json!({"page": "Atlas", "last_n": 0}),
    ] {
        let error = run(&logseq, false, bad.clone()).await.unwrap_err();
        assert!(matches!(error, ToolError::InvalidParameter(_)), "{bad}: {error}");
    }
    assert!(logseq.seen.lock().unwrap().is_empty(), "{:?}", asked(&logseq));
}

#[tokio::test]
async fn a_null_search_answer_says_which_pages_the_blocks_were_asked_to_be_on_and_link_to() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!(null),
    })
    .await;

    let (results, meta) = run(&logseq, true, json!({"page": "Atlas", "links_to": ["Bob"]})).await.unwrap();

    assert!(results.is_empty());
    assert_eq!(meta["warnings"][0]["code"], "search_unavailable");
    assert!(meta["warnings"][0]["message"].as_str().unwrap().contains(r#"blocks that sit on the page "Atlas" and link to "Bob" (possibly"#));
    assert_eq!(meta["totals"], json!({}));
    assert!(meta.get("tips").is_none(), "no tip for a search that was not answered");
    assert_eq!(meta["hasMore"], false);
}

#[tokio::test]
async fn a_null_alias_lookup_is_a_warning_and_the_search_still_runs_on_the_pages_alone() {
    let pages = vec![page(10, "Atlas", &[11])];
    let logseq = mock_logseq(move |request| {
        if let Some(name) = resolver_name(request) {
            resolve(&name, &pages)
        } else if text_of(request).starts_with("[:find ?start") {
            json!(null)
        } else {
            json!([hit(101, "x")])
        }
    })
    .await;

    let (results, meta) = run(&logseq, false, json!({"links_to": ["Atlas"]})).await.unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(meta["warnings"][0]["code"], "alias_lookup_unavailable");
    assert!(text_of(&searches(&logseq)[0]).contains("[(ground [10]) [?ref0 ...]]"));
    assert!(meta.get("resolvedAliases").is_none(), "an alias group that is not known is not reported as one");
}

#[tokio::test]
async fn a_miss_with_pages_says_how_a_link_matches() {
    let pages = vec![page(10, "Atlas", &[]), page(20, "Bob", &[])];
    let logseq = mock_logseq(move |request| match resolver_name(request) {
        Some(name) => resolve(&name, &pages),
        None => json!([]),
    })
    .await;

    let (results, meta) = run(&logseq, true, json!({"page": "Atlas", "links_to": ["Bob"]})).await.unwrap();

    assert!(results.is_empty());
    assert_eq!(meta["totals"], json!({"matches": 0}));
    assert_eq!(
        meta["tips"][0],
        "No match. A page covers the blocks written on it and on its aliases, and a link is a [[link]] or a #tag, not plain words, and every links_to page is needed: loosen a filter."
    );
}

#[tokio::test]
async fn two_names_of_one_page_say_a_null_alias_lookup_once() {
    // "al" is an alias of Alice: the page and a link resolve to the same page, so there is one group of names, and its
    // lookup that LogSeq did not answer is one warning, not two
    let alice = page(10, "Alice", &[11]);
    let logseq = mock_logseq(move |request| {
        if let Some(name) = resolver_name(request) {
            match name.as_str() {
                "alice" => json!([[alice, "name"]]),
                "al" => json!([[alice, "alias"]]),
                _ => json!([]),
            }
        } else if text_of(request).starts_with("[:find ?start") {
            json!(null)
        } else {
            json!([hit(101, "x")])
        }
    })
    .await;

    let (results, meta) = run(&logseq, false, json!({"page": "Alice", "links_to": ["al"]})).await.unwrap();

    assert_eq!(results.len(), 1);
    let codes: Vec<&str> = meta["warnings"].as_array().unwrap().iter().map(|warning| warning["code"].as_str().unwrap()).collect();
    assert_eq!(codes, ["alias_lookup_unavailable"], "{meta}");
    // both names are still searched: the page, and the link, each by the ids it has
    assert_eq!(count_resolvers(&logseq), 2);
    assert!(text_of(&searches(&logseq)[0]).contains("[(ground [10]) [?page ...]] [?b :block/page ?page] [(ground [10]) [?ref0 ...]]"));
}
