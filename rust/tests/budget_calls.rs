//! The character budget of a tool result (#485) through each tool's `call`, against a mock LogSeq: a result
//! over the budget comes back cut with a `result_size_truncated` warning, one under it is unchanged, and the cut
//! costs no LogSeq call. The unit tests beside each tool cover under, at and over the budget and a single entry
//! larger than the budget; the parity harness holds the recorded results. Every page and block here is made up
//! (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq, uuid};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::dates::Clock;
use logseq_mcp_server::tools::{explore_context, explore_network, find_blocks};
use serde_json::{Value, json};

/// 2025-03-12T03:30:00Z, the instant the parity harness reads as now.
const NOW: Clock = Clock::Fixed(1_741_750_200_000);

const DATALOG: &str = "logseq.DB.datascriptQuery";
const LINKED_REFERENCES: &str = "logseq.Editor.getPageLinkedReferences";

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

fn text_of(result: &rmcp::model::CallToolResult, block: usize) -> String {
    serde_json::to_value(result).unwrap()["content"][block]["text"].as_str().unwrap().to_owned()
}

fn root() -> Value {
    json!([[{"id": 10, "uuid": uuid(10), "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 5010}}, "name"]])
}

/// A connected-pages row: `[source, connected, name, originalName, isJournal, relType, count]`.
fn row(connected: i64, name: &str) -> Value {
    json!([10, connected, name.to_lowercase(), name, false, "outbound", 1])
}

/// `count` neighbours of the root, each with a name of `length` characters
fn neighbours(count: i64, length: usize) -> Value {
    Value::Array((0..count).map(|id| row(100 + id, &format!("{id:04}{}", "n".repeat(length)))).collect())
}

#[tokio::test]
async fn a_network_under_the_budget_is_unchanged_and_one_over_it_is_cut_with_no_extra_call() {
    let args = json!({"page": "Project Atlas", "max_depth": 1});
    let logseq = mock_logseq(vec![root(), neighbours(10, 50)]).await;
    let small = explore_network::call(&client(&logseq), true, arguments(args.clone())).await.unwrap();
    assert!(!text_of(&small, 0).contains("result_size_truncated"));
    assert_eq!(methods(&logseq), [DATALOG, DATALOG]);

    // 40 neighbours with 1,000-character names: 40,000 characters of names alone
    let logseq = mock_logseq(vec![root(), neighbours(40, 1000)]).await;
    let big = explore_network::call(&client(&logseq), true, arguments(json!({"page": "Project Atlas", "max_depth": 1, "max_fanout": 100}))).await.unwrap();
    // the cut reads no more than the walk does
    assert_eq!(methods(&logseq), [DATALOG, DATALOG]);
    assert_eq!(args_of(&logseq, 1).len(), 1);
    let text = text_of(&big, 0);
    assert!(size(&text) <= BUDGET_CHARS, "{}", size(&text));
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["truncated"], true);
    assert_eq!(value["hasMore"], false);
    let warnings = value["warnings"].as_array().unwrap();
    assert_eq!(warnings.last().unwrap()["code"], "result_size_truncated");
    // the root and the nearest pages stay, and an edge never points at a page that was cut
    let ids: Vec<i64> = value["nodes"].as_array().unwrap().iter().map(|node| node["id"].as_i64().unwrap()).collect();
    assert_eq!(ids[0], 10);
    assert!(ids.len() > 1 && ids.len() < 41, "{}", ids.len());
    for edge in value["edges"].as_array().unwrap() {
        assert!(ids.contains(&edge["from"].as_i64().unwrap()) && ids.contains(&edge["to"].as_i64().unwrap()));
    }
}

#[tokio::test]
async fn a_network_in_markdown_is_cut_to_the_budget_with_the_warning_in_its_footer() {
    let logseq = mock_logseq(vec![root(), neighbours(40, 1000)]).await;
    let result = explore_network::call(
        &client(&logseq),
        true,
        arguments(json!({"page": "Project Atlas", "max_depth": 1, "max_fanout": 100, "format": "markdown"})),
    )
    .await
    .unwrap();
    let text = text_of(&result, 0);
    assert!(size(&text) <= BUDGET_CHARS, "{}", size(&text));
    assert!(text.contains("result_size_truncated: Showing "), "{}", &text[text.len().saturating_sub(600)..]);
    assert_eq!(methods(&logseq), [DATALOG, DATALOG]);
}

/// A linking block of `length` characters on source page `page`.
fn linking_block(id: i64, page: i64, length: usize) -> Value {
    json!({"id": id, "uuid": uuid(id), "content": format!("links [[Atlas]] {}", "x".repeat(length)), "page": {"id": page, "name": format!("p{page}"), "originalName": format!("P{page}")}})
}

/// The linked references of a page: 6 source pages with 5 blocks of `length` characters each, in the order of their ids.
fn six_sources(length: usize) -> Value {
    let page = |id: i64| json!({"id": id, "name": format!("p{id}"), "originalName": format!("P{id}")});
    json!((1..=6).map(|id| json!([page(id), (0..5).map(|n| linking_block(id * 100 + n, id, length)).collect::<Vec<_>>()])).collect::<Vec<_>>())
}

fn reference_ids(value: &Value) -> Vec<i64> {
    value["references"].as_array().unwrap().iter().map(|reference| reference["block"]["id"].as_i64().unwrap()).collect()
}

#[tokio::test]
async fn references_over_the_budget_are_cut_from_the_last_one_and_the_next_offset_reads_on() {
    // 30 references of about 2,000 characters: 60,000 characters, with the caps raised past them
    let logseq = mock_logseq(vec![root(), json!([]), six_sources(2000)]).await;
    let result = explore_context::call(&client(&logseq), false, arguments(json!({"page": "Project Atlas", "max_references": 100}))).await.unwrap();
    // the cut reads no more than the call does
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, LINKED_REFERENCES]);
    let text = text_of(&result, 0);
    assert!(size(&text) <= BUDGET_CHARS, "{}", size(&text));
    let first: Value = serde_json::from_str(&text).unwrap();
    let kept = reference_ids(&first);
    assert!(kept.len() > 5 && kept.len() < 30, "{}", kept.len());
    assert_eq!(first["totals"]["references"], 30);
    assert_eq!(first["warnings"][0]["code"], "result_size_truncated");
    assert_eq!(first["hasMore"], true);
    let how = first["warnings"][0]["howToFetchAll"].as_str().unwrap();
    assert!(how.starts_with(&format!("Set references_offset to {} for the next references.", kept.len())), "{how}");

    // the next page starts where the cut fell: the same ranking, read further on, with nothing skipped or repeated
    let logseq = mock_logseq(vec![root(), json!([]), six_sources(2000)]).await;
    let next = explore_context::call(&client(&logseq), false, arguments(json!({"page": "Project Atlas", "max_references": 100, "references_offset": kept.len(), "max_blocks": 0}))).await.unwrap();
    let second: Value = serde_json::from_str(&text_of(&next, 0)).unwrap();
    let rest = reference_ids(&second);
    // the six pages link five times each, so the ranking is by name: the ids run in order
    let all: Vec<i64> = (1..=6).flat_map(|id| (0..5).map(move |n| id * 100 + n)).collect();
    assert_eq!(kept, all[..kept.len()]);
    assert_eq!(rest, all[kept.len()..kept.len() + rest.len()]);
    assert_eq!(second["totals"]["references"], 30);
}

/// A search row: one block of `length` characters of text, newest when `id` is highest, on page 5.
fn hit(id: i64, length: usize) -> Value {
    json!([{"id": id, "uuid": uuid(id), "content": format!("mentions the importer {}", "x".repeat(length)), "page": {"id": 5, "name": "alice", "original-name": "Alice"}}])
}

fn page_row() -> Value {
    json!([{"id": 5, "name": "alice", "original-name": "Alice"}])
}

#[tokio::test]
async fn a_search_under_the_budget_is_unchanged_and_one_over_it_is_cut_with_no_extra_call() {
    let small: Vec<Value> = (1..=20).map(|id| hit(id, 100)).collect();
    let logseq = mock_logseq(vec![json!(small)]).await;
    let result = find_blocks::call(&client(&logseq), true, NOW, arguments(json!({"text": "importer"}))).await.unwrap();
    let meta: Value = serde_json::from_str(&text_of(&result, 1)).unwrap();
    assert_eq!(meta["meta"]["warnings"], json!([]));
    assert_eq!(serde_json::from_str::<Vec<Value>>(&text_of(&result, 0)).unwrap().len(), 20);

    // 100 hits of 600 characters: ~70,000 characters, at the default limit of 100
    let big: Vec<Value> = (1..=100).map(|id| hit(id, 600)).collect();
    let logseq = mock_logseq(vec![json!(big)]).await;
    let result = find_blocks::call(&client(&logseq), true, NOW, arguments(json!({"text": "importer"}))).await.unwrap();
    // the cut reads no more than the search does
    assert_eq!(methods(&logseq), [DATALOG]);
    let (results, meta) = (text_of(&result, 0), text_of(&result, 1));
    assert!(size(&results) + size(&meta) <= BUDGET_CHARS, "{}", size(&results) + size(&meta));
    let kept: Vec<Value> = serde_json::from_str(&results).unwrap();
    assert!(kept.len() > 1 && kept.len() < 100, "{}", kept.len());
    // the newest hits stay, and a hit is whole
    assert_eq!(kept[0]["uuid"], uuid(100));
    let meta: Value = serde_json::from_str(&meta).unwrap();
    let warnings = meta["meta"]["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0]["code"], "result_size_truncated");
    // no parameter raises the size limit, but the next page reads on from where the cut fell
    assert_eq!(warnings[0]["howToFetchAll"], format!("Set offset to {} for the next page.", kept.len()));
    assert_eq!(meta["meta"]["hasMore"], true);
    assert_eq!(meta["meta"]["totals"], json!({"matches": 100}));
}

#[tokio::test]
async fn the_offset_a_size_cut_names_reads_on_with_the_next_hits_and_no_overlap() {
    // 100 hits of 600 characters, the same answer for each call: the first page is cut to the budget, and the page the
    // warning names starts at the next hit and is cut the same way
    let big: Vec<Value> = (1..=100).map(|id| hit(id, 600)).collect();
    let page = |offset: Option<usize>| {
        let big = big.clone();
        async move {
            let logseq = mock_logseq(vec![json!(big)]).await;
            let args = offset.map_or(json!({"text": "importer"}), |offset| json!({"text": "importer", "offset": offset}));
            let result = find_blocks::call(&client(&logseq), true, NOW, arguments(args)).await.unwrap();
            assert_eq!(methods(&logseq), [DATALOG], "a page costs the same one call");
            let hits: Vec<Value> = serde_json::from_str(&text_of(&result, 0)).unwrap();
            (hits, search_meta(&result))
        }
    };
    let (first, meta) = page(None).await;
    let how = meta["warnings"][0]["howToFetchAll"].as_str().unwrap().to_owned();
    assert_eq!(how, format!("Set offset to {} for the next page.", first.len()));

    let (second, meta) = page(Some(first.len())).await;
    // the hits are newest first, so the second page starts at the next id down, and no hit is on both
    assert_eq!(first[0]["uuid"], uuid(100));
    assert_eq!(second[0]["uuid"], uuid(100 - first.len() as i64));
    assert!(second.iter().all(|hit| !first.contains(hit)));
    assert_eq!(meta["totals"]["matches"], 100, "the total counts the hits skipped too");
    let warning = &meta["warnings"][0];
    assert_eq!(warning["code"], "result_size_truncated");
    assert!(warning["message"].as_str().unwrap().contains(&format!("matching blocks from offset {}", first.len())), "{warning}");
    assert_eq!(warning["howToFetchAll"], format!("Set offset to {} for the next page.", first.len() + second.len()));

    // an offset past the last hit reads nothing, and says nothing was cut
    let (none, meta) = page(Some(100)).await;
    assert!(none.is_empty());
    assert_eq!(meta["warnings"], json!([]));
    assert_eq!(meta["hasMore"], false);
    assert_eq!(meta["totals"]["matches"], 100);
}

#[tokio::test]
async fn a_search_cut_by_its_limit_and_its_size_offers_no_larger_limit() {
    // 300 matches and a limit of 200, then a size cut: raising `limit` would return the same first hits cut at
    // the same place, so no warning offers it
    let big: Vec<Value> = (1..=300).map(|id| hit(id, 600)).collect();
    let logseq = mock_logseq(vec![json!(big)]).await;
    let result = find_blocks::call(&client(&logseq), true, NOW, arguments(json!({"text": "importer", "limit": 200}))).await.unwrap();
    let meta: Value = serde_json::from_str(&text_of(&result, 1)).unwrap();
    let warnings = meta["meta"]["warnings"].as_array().unwrap();
    assert_eq!(warnings.iter().map(|warning| warning["code"].as_str().unwrap()).collect::<Vec<_>>(), ["result_size_truncated"]);
    assert!(warnings[0]["message"].as_str().unwrap().contains(" of 300 matching blocks"), "{}", warnings[0]["message"]);
    // the next page is the way on, and it is not a larger limit
    assert!(warnings[0]["howToFetchAll"].as_str().unwrap().starts_with("Set offset to "), "{}", warnings[0]["howToFetchAll"]);
    assert!(!warnings[0]["howToFetchAll"].as_str().unwrap().contains("limit"), "{}", warnings[0]["howToFetchAll"]);
    assert_eq!(meta["meta"]["hasMore"], true);
    assert_eq!(meta["meta"]["totals"]["matches"], 300);
}

/// The warning codes and `howToFetchAll` of the meta block of a search result
fn search_meta(result: &rmcp::model::CallToolResult) -> Value {
    serde_json::from_str::<Value>(&text_of(result, 1)).unwrap()["meta"].clone()
}

#[tokio::test]
async fn the_raise_a_limit_warning_offers_returns_exactly_that_many_hits_and_one_more_is_cut() {
    // 300 matches of ~270 characters each: the default limit of 100 fits the budget, a raise to every match does not
    let many: Vec<Value> = (1..=300).map(|id| hit(id, 150)).collect();
    let run = |limit: Option<u64>| {
        let many = many.clone();
        async move {
            let logseq = mock_logseq(vec![json!(many)]).await;
            let args = limit.map_or(json!({"text": "importer"}), |limit| json!({"text": "importer", "limit": limit}));
            let result = find_blocks::call(&client(&logseq), true, NOW, arguments(args)).await.unwrap();
            assert_eq!(methods(&logseq), [DATALOG]);
            let hits = serde_json::from_str::<Vec<Value>>(&text_of(&result, 0)).unwrap().len();
            (hits, search_meta(&result))
        }
    };
    let (hits, meta) = run(None).await;
    assert_eq!(hits, 100);
    let warning = &meta["warnings"][0];
    assert_eq!(warning["code"], "results_truncated");
    assert_eq!(meta["hasMore"], true);
    let how = warning["howToFetchAll"].as_str().unwrap();
    // the next page leads, and the raise is the alternative
    assert!(how.starts_with("Set offset to 100 for the next page. Or set limit to "), "{how}");
    let offered: usize = how.split("Or set limit to ").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap();
    assert!(offered > 100 && offered < 300, "{how}");
    assert!(!how.contains("get all"), "{how}");

    // the offered limit returns that many hits with no size cut, and one more is cut to the offered count
    let (hits, meta) = run(Some(offered as u64)).await;
    assert_eq!(hits, offered);
    assert!(meta["warnings"].as_array().unwrap().iter().all(|warning| warning["code"] != "result_size_truncated"), "{meta}");
    // the size cut's own warning is longer than a limit cut's, so it keeps a hit or so fewer than the offered count
    let (hits, meta) = run(Some(offered as u64 + 1)).await;
    assert!(hits <= offered && hits + 3 >= offered, "{hits} of {offered}");
    assert_eq!(meta["warnings"][0]["code"], "result_size_truncated");
    assert_eq!(meta["warnings"][0]["howToFetchAll"], format!("Set offset to {hits} for the next page."));
    assert_eq!(meta["hasMore"], true);
}

#[tokio::test]
async fn a_search_with_context_is_cut_to_the_budget_and_the_page_lookup_stays_one_call() {
    let big: Vec<Value> = (1..=100).map(|id| hit(id, 300)).collect();
    let logseq = mock_logseq(vec![json!(big), json!([page_row()])]).await;
    let result = find_blocks::call(
        &client(&logseq),
        true,
        NOW,
        arguments(json!({"text": "importer", "include_context": true, "slim_results": false})),
    )
    .await
    .unwrap();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG]);
    let (results, meta) = (text_of(&result, 0), text_of(&result, 1));
    assert!(size(&results) + size(&meta) <= BUDGET_CHARS, "{}", size(&results) + size(&meta));
    let kept: Vec<Value> = serde_json::from_str(&results).unwrap();
    assert!(kept.len() < 100 && kept.iter().all(|hit| hit["context"]["page"]["originalName"] == "Alice"));
    let meta: Value = serde_json::from_str(&meta).unwrap();
    let warning = &meta["meta"]["warnings"][0];
    assert_eq!(warning["code"], "result_size_truncated");
    // the advice names the settings that make a hit smaller
    assert!(warning["message"].as_str().unwrap().contains("include_context: false and slim_results: true make each hit smaller"));
}

#[tokio::test]
async fn a_single_search_hit_over_the_budget_comes_back_alone_and_the_first_of_many_says_so() {
    // one hit of 40,000 characters: nothing to cut, so it is returned whole with no warning
    let logseq = mock_logseq(vec![json!([hit(1, 40_000)])]).await;
    let result = find_blocks::call(&client(&logseq), false, NOW, arguments(json!({"text": "importer"}))).await.unwrap();
    assert_eq!(serde_json::from_str::<Vec<Value>>(&text_of(&result, 0)).unwrap().len(), 1);
    let meta: Value = serde_json::from_str(&text_of(&result, 1)).unwrap();
    assert_eq!(meta["meta"]["warnings"], json!([]));

    // the newest of three is 40,000 characters: it is kept alone, and the warning says that even it is over
    let logseq = mock_logseq(vec![json!([hit(3, 40_000), hit(2, 10), hit(1, 10)])]).await;
    let result = find_blocks::call(&client(&logseq), false, NOW, arguments(json!({"text": "importer"}))).await.unwrap();
    let kept: Vec<Value> = serde_json::from_str(&text_of(&result, 0)).unwrap();
    assert_eq!(kept.len(), 1);
    let meta: Value = serde_json::from_str(&text_of(&result, 1)).unwrap();
    let message = meta["meta"]["warnings"][0]["message"].as_str().unwrap();
    assert!(message.starts_with("Showing 1 of 3 matching blocks"), "{message}");
    assert!(message.contains("Even those are over that size"), "{message}");
}
