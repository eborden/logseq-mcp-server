//! The character budget (#507, #485) of the `get` and `find` tools #509 and #506 left out, through each tool's `call`
//! against a mock LogSeq: a result over the budget comes back cut with a `result_size_truncated` warning, one under it
//! is unchanged, and the cut costs no LogSeq call. The unit tests beside each tool cover under, at and over the
//! budget and a single entry larger than the budget; the parity harness holds the recorded results. Every page and
//! block here is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq, uuid};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::tools::get_page;
use serde_json::{Value, json};

const PAGE: &str = "logseq.Editor.getPage";
const TREE: &str = "logseq.Editor.getPageBlocksTree";

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

fn text_of(result: &rmcp::model::CallToolResult, block: usize) -> String {
    serde_json::to_value(result).unwrap()["content"][block]["text"].as_str().unwrap().to_owned()
}

fn editor_page() -> Value {
    json!({"id": 10, "uuid": uuid(10), "name": "project atlas", "originalName": "Project Atlas", "journal?": false, "file": {"id": 5010}})
}

/// A top-level block of `length` characters with `children` children of `length` characters each.
fn block(id: i64, length: usize, children: i64) -> Value {
    let child = |n: i64| json!({"id": id * 100 + n, "uuid": uuid(id * 100 + n), "content": format!("child {n} {}", "y".repeat(length)), "page": {"id": 10}, "children": []});
    json!({"id": id, "uuid": uuid(id), "content": format!("block {id} {}", "x".repeat(length)), "page": {"id": 10}, "children": (1..=children).map(child).collect::<Vec<_>>()})
}

fn all_uuids(blocks: &[Value]) -> Vec<String> {
    blocks.iter().flat_map(|block| std::iter::once(block["uuid"].as_str().unwrap().to_owned()).chain(all_uuids(block["children"].as_array().map_or(&[][..], Vec::as_slice)))).collect()
}

// ---- logseq_get_page, detail full

#[tokio::test]
async fn a_full_page_under_the_budget_is_unchanged_and_one_over_it_is_cut_with_no_extra_call() {
    let small: Vec<Value> = (1..=5).map(|id| block(id, 100, 2)).collect();
    let logseq = mock_logseq(vec![editor_page(), json!(small)]).await;
    let result = get_page::call(&client(&logseq), true, arguments(json!({"page": "Project Atlas", "detail": "full"}))).await.unwrap();
    let page: Value = serde_json::from_str(&text_of(&result, 0)).unwrap();
    assert!(page.get("warnings").is_none() && page.get("hasMore").is_none(), "{page}");
    assert_eq!(page["children"], json!(small));

    // 30 blocks of 1,000 characters with 2 children of 1,000 each: ~90,000 characters
    let big: Vec<Value> = (1..=30).map(|id| block(id, 1000, 2)).collect();
    let logseq = mock_logseq(vec![editor_page(), json!(big)]).await;
    let result = get_page::call(&client(&logseq), true, arguments(json!({"page": "Project Atlas", "detail": "full"}))).await.unwrap();
    // the cut reads no more than the page does
    assert_eq!(methods(&logseq), [PAGE, TREE]);
    assert_eq!(args_of(&logseq, 1), [json!("Project Atlas")]);
    let (page_text, tips) = (text_of(&result, 0), text_of(&result, 1));
    assert!(size(&page_text) + size(&tips) <= BUDGET_CHARS, "{}", size(&page_text) + size(&tips));
    let page: Value = serde_json::from_str(&page_text).unwrap();
    // `hasMore` and `warnings` come last, there is no way to fetch the rest by a parameter, and the page keeps its other keys
    assert_eq!(page["hasMore"], false);
    let warnings = page["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0]["code"], "result_size_truncated");
    assert!(warnings[0].get("howToFetchAll").is_none());
    let message = warnings[0]["message"].as_str().unwrap();
    assert!(message.starts_with("Showing ") && message.contains(" of 90 blocks of the page (nested ones counted"), "{message}");
    assert!(message.contains("detail \"outline\"") && message.contains("logseq_get_block"), "{message}");
    assert_eq!(page.as_object().unwrap().keys().rev().take(2).collect::<Vec<_>>(), ["warnings", "hasMore"]);
    // the first blocks in page order are kept, whole, and the last block kept says it lost children when it did
    let kept = all_uuids(page["children"].as_array().unwrap());
    let sent: Vec<String> = all_uuids(&big);
    assert_eq!(kept, sent[..kept.len()]);
    assert!(kept.len() > 3 && kept.len() < 90, "{}", kept.len());
}

#[tokio::test]
async fn a_full_page_in_markdown_is_cut_to_the_budget_with_the_warning_in_its_footer() {
    let big: Vec<Value> = (1..=30).map(|id| block(id, 1000, 2)).collect();
    let logseq = mock_logseq(vec![editor_page(), json!(big)]).await;
    let result = get_page::call(&client(&logseq), true, arguments(json!({"page": "Project Atlas", "detail": "full", "format": "markdown"}))).await.unwrap();
    assert_eq!(methods(&logseq), [PAGE, TREE]);
    let text = text_of(&result, 0);
    assert!(size(&text) <= BUDGET_CHARS, "{}", size(&text));
    assert!(text.contains("result_size_truncated: Showing "), "{}", &text[text.len().saturating_sub(700)..]);
}

#[tokio::test]
async fn one_block_over_the_budget_is_kept_alone_and_a_page_of_one_is_not_cut() {
    // a single block of 40,000 characters: nothing to cut, so it is returned whole with no warning
    let logseq = mock_logseq(vec![editor_page(), json!([block(1, 40_000, 0)])]).await;
    let result = get_page::call(&client(&logseq), false, arguments(json!({"page": "Project Atlas", "detail": "full"}))).await.unwrap();
    let page: Value = serde_json::from_str(&text_of(&result, 0)).unwrap();
    assert!(page.get("warnings").is_none());
    assert_eq!(page["children"].as_array().unwrap().len(), 1);

    // the first of three is 40,000 characters: it is kept alone, and the warning says that even it is over
    let logseq = mock_logseq(vec![editor_page(), json!([block(1, 40_000, 0), block(2, 10, 0), block(3, 10, 0)])]).await;
    let result = get_page::call(&client(&logseq), false, arguments(json!({"page": "Project Atlas", "detail": "full"}))).await.unwrap();
    let page: Value = serde_json::from_str(&text_of(&result, 0)).unwrap();
    assert_eq!(page["children"].as_array().unwrap().len(), 1);
    let message = page["warnings"][0]["message"].as_str().unwrap();
    assert!(message.starts_with("Showing 1 of 3 blocks of the page"), "{message}");
    assert!(message.contains("Even those are over that size"), "{message}");
}

#[tokio::test]
async fn a_page_without_its_blocks_is_never_cut() {
    let mut properties = editor_page();
    properties["properties"] = json!({"notes": "z".repeat(40_000)});
    let logseq = mock_logseq(vec![properties]).await;
    let result = get_page::call(&client(&logseq), true, arguments(json!({"page": "Project Atlas"}))).await.unwrap();
    let page: Value = serde_json::from_str(&text_of(&result, 0)).unwrap();
    assert!(page.get("warnings").is_none());
    assert_eq!(methods(&logseq), [PAGE]);
}
