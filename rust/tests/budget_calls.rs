//! The character budget of a tool result (#485) through each tool's `call`, against a mock LogSeq: a result
//! over the budget comes back cut with a `result_size_truncated` warning, one under it is unchanged, and the cut
//! costs no LogSeq call. The unit tests beside each tool cover under, at and over the budget and a single entry
//! larger than the budget; the parity harness holds the recorded results. Every page and block here is made up
//! (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq, uuid};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::tools::{get_backlinks, get_concept_network};
use serde_json::{Value, json};

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
    let args = json!({"concept_name": "Project Atlas", "max_depth": 1});
    let logseq = mock_logseq(vec![root(), neighbours(10, 50)]).await;
    let small = get_concept_network::call(&client(&logseq), true, arguments(args.clone())).await.unwrap();
    assert!(!text_of(&small, 0).contains("result_size_truncated"));
    assert_eq!(methods(&logseq), [DATALOG, DATALOG]);

    // 40 neighbours with 1,000-character names: 40,000 characters of names alone
    let logseq = mock_logseq(vec![root(), neighbours(40, 1000)]).await;
    let big = get_concept_network::call(&client(&logseq), true, arguments(json!({"concept_name": "Project Atlas", "max_depth": 1, "max_fanout": 100}))).await.unwrap();
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
    let result = get_concept_network::call(
        &client(&logseq),
        true,
        arguments(json!({"concept_name": "Project Atlas", "max_depth": 1, "max_fanout": 100, "format": "markdown"})),
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

#[tokio::test]
async fn backlinks_over_the_budget_are_cut_from_the_last_block_and_the_meta_block_says_so() {
    let page = |id: i64| json!({"id": id, "name": format!("p{id}"), "originalName": format!("P{id}")});
    // 6 source pages with 5 blocks of 2,000 characters each: 60,000 characters
    let linked: Vec<Value> = (1..=6).map(|id| json!([page(id), (0..5).map(|n| linking_block(id * 100 + n, id, 2000)).collect::<Vec<_>>()])).collect();
    let logseq = mock_logseq(vec![root(), json!(linked)]).await;
    let result = get_backlinks::call(&client(&logseq), false, arguments(json!({"page_name": "Project Atlas", "max_pages": 100, "max_blocks_per_page": 50}))).await.unwrap();
    assert_eq!(methods(&logseq), [DATALOG, LINKED_REFERENCES]);
    let (results, meta) = (text_of(&result, 0), text_of(&result, 1));
    assert!(size(&results) + size(&meta) <= BUDGET_CHARS, "{}", size(&results) + size(&meta));
    let meta: Value = serde_json::from_str(&meta).unwrap();
    assert_eq!(meta["meta"]["warnings"][0]["code"], "result_size_truncated");
    assert_eq!(meta["meta"]["hasMore"], false);
    assert_eq!(meta["meta"]["totals"], json!({"pages": 6, "blocks": 30}));
    // the pages keep their order, and only the page the cut fell in is partial
    let kept: Vec<Value> = serde_json::from_str(&results).unwrap();
    assert!(kept.len() < 6);
    let counts: Vec<usize> = kept.iter().map(|tuple| tuple[1].as_array().unwrap().len()).collect();
    assert!(counts[..counts.len() - 1].iter().all(|&count| count == 5), "{counts:?}");
}
