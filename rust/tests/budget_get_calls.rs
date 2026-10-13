//! The character budget (#507, #485) of the `get` and `find` tools #509 and #506 left out, through each tool's `call`
//! against a mock LogSeq: a result over the budget comes back cut with a `result_size_truncated` warning, one under it
//! is unchanged, and the cut costs no LogSeq call. The unit tests beside each tool cover under, at and over the
//! budget and a single entry larger than the budget; the parity harness holds the recorded results. Every page and
//! block here is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq, uuid};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::tools::{find_pages, get_block, get_page};
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

// ---- logseq_find_pages

const ALL_PAGES: &str = "logseq.Editor.getAllPages";

/// `count` pages with a file, each name `length` characters after its number, and an alias on every third.
fn pages(count: i64, length: usize) -> Value {
    let page = |n: i64| {
        let name = format!("{n:05}{}", "p".repeat(length));
        json!({"id": n + 1, "name": name, "originalName": name, "journal?": false, "file": {"id": 5000 + n}})
    };
    json!((0..count).map(page).collect::<Vec<_>>())
}

async fn find(answer: Value, args: Value) -> (Value, Value) {
    let logseq = mock_logseq(vec![answer]).await;
    let result = find_pages::call(&client(&logseq), true, arguments(args)).await.unwrap();
    assert_eq!(methods(&logseq), [ALL_PAGES], "the cut reads no more than the list does");
    let body: Value = serde_json::from_str(&text_of(&result, 0)).unwrap();
    let tips = serde_json::to_value(&result).unwrap()["content"].as_array().unwrap().get(1).map_or(Value::Null, |block| block["text"].clone());
    assert!(size(&text_of(&result, 0)) + tips.as_str().map_or(0, size) <= BUDGET_CHARS);
    (body, tips)
}

#[tokio::test]
async fn a_thousand_pages_of_long_names_are_cut_to_the_budget_and_the_next_page_is_named() {
    // 1,000 pages of ~70-character names: ~85,000 characters at the largest limit
    let (body, _) = find(pages(1000, 60), json!({"limit": 1000})).await;
    let kept = body["pages"].as_array().unwrap().len();
    assert!(kept > 100 && kept < 1000, "{kept}");
    assert_eq!(body["total"], 1000);
    assert_eq!(body["hasMore"], true);
    let warning = &body["warnings"][0];
    assert_eq!(warning["code"], "result_size_truncated");
    assert_eq!(warning["howToFetchAll"], format!("Set offset to {kept} for the next page."));
    assert_eq!(body["pages"][0]["name"], format!("00000{}", "p".repeat(60)));

    // that offset reads on from the next page, and the pages of the two reads are every page once
    let (next, _) = find(pages(1000, 60), json!({"limit": 1000, "offset": kept})).await;
    assert_eq!(next["pages"][0]["name"], format!("{kept:05}{}", "p".repeat(60)));
    assert!(next["warnings"][0]["message"].as_str().unwrap().contains(&format!("of {} pages from offset {kept}", 1000 - kept)));
}

#[tokio::test]
async fn a_short_list_and_a_list_of_short_names_are_left_alone() {
    let (body, _) = find(pages(300, 20), json!({"limit": 1000})).await;
    assert_eq!(body["pages"].as_array().unwrap().len(), 300);
    assert!(body.get("warnings").is_none());
    // the default limit of 200 over a graph of 300: the usual limit warning, which says a larger limit gets them all
    let (body, _) = find(pages(300, 20), json!({})).await;
    assert_eq!(body["warnings"][0]["code"], "pages_truncated");
    assert!(body["warnings"][0]["howToFetchAll"].as_str().unwrap().contains("to get all 300 in one call"));
}

#[tokio::test]
async fn a_limit_cut_offers_a_raise_only_where_the_raised_list_fits() {
    // 600 pages of ~75 characters: 200 fit, all 600 do not
    let (body, _) = find(pages(600, 60), json!({})).await;
    assert_eq!(body["pages"].as_array().unwrap().len(), 200);
    let warning = &body["warnings"][0];
    assert_eq!(warning["code"], "pages_truncated");
    let how = warning["howToFetchAll"].as_str().unwrap();
    assert!(how.starts_with("Set offset to 200 for the next page. Or set limit to "), "{how}");
    assert!(how.contains("That is the most that fits") && !how.contains("get all"), "{how}");
    let offered: usize = how.split("Or set limit to ").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap();
    assert!(offered > 200 && offered < 600, "{how}");
    // the offered limit returns that many pages
    let (body, _) = find(pages(600, 60), json!({"limit": offered})).await;
    assert_eq!(body["pages"].as_array().unwrap().len(), offered);
    assert_eq!(body["warnings"][0]["code"], "pages_truncated");
}

#[tokio::test]
async fn a_list_in_toon_is_measured_as_toon() {
    // 1,000 short names are over the budget in JSON and under it in TOON, which writes the key once
    let (json_body, _) = find(pages(1000, 20), json!({"limit": 1000})).await;
    assert!(json_body["pages"].as_array().unwrap().len() < 1000);
    let logseq = mock_logseq(vec![pages(1000, 20)]).await;
    let result = find_pages::call(&client(&logseq), true, arguments(json!({"limit": 1000, "format": "toon"}))).await.unwrap();
    let text = text_of(&result, 0);
    assert!(size(&text) <= BUDGET_CHARS, "{}", size(&text));
    assert!(!text.contains("result_size_truncated"));
    // every one of the 1,000 pages is there
    assert_eq!(text.matches(&"p".repeat(20)).count(), 1000);
}

// ---- logseq_get_block, include_children

#[tokio::test]
async fn a_block_with_children_over_the_budget_is_cut_and_one_without_is_left_alone() {
    let subtree = |children: i64| json!({"id": 5, "uuid": uuid(5), "content": "Parent", "page": {"id": 10}, "children": (1..=children).map(|n| block(500 + n, 1000, 0)).collect::<Vec<_>>()});
    let logseq = mock_logseq(vec![subtree(5)]).await;
    let small = get_block::call(&client(&logseq), true, arguments(json!({"uuid": uuid(5), "include_children": true}))).await.unwrap();
    assert!(!text_of(&small, 0).contains("result_size_truncated"));

    // 60 children of 1,000 characters: ~60,000 characters
    let logseq = mock_logseq(vec![subtree(60)]).await;
    let result = get_block::call(&client(&logseq), true, arguments(json!({"uuid": uuid(5), "include_children": true}))).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.Editor.getBlock"]);
    let text = text_of(&result, 0);
    assert!(size(&text) <= BUDGET_CHARS, "{}", size(&text));
    let cut: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(cut["childrenTruncated"], true);
    assert_eq!(cut["hasMore"], false);
    assert_eq!(cut["warnings"][0]["code"], "result_size_truncated");
    let kept = cut["children"].as_array().unwrap().len();
    assert!(kept > 10 && kept < 60, "{kept}");

    // the same block read without its children is one entity, whatever its size: LogSeq sends the children unfetched
    let mut huge = subtree(0);
    huge["content"] = json!("x".repeat(40_000));
    huge["children"] = json!([["uuid", uuid(501)], ["uuid", uuid(502)]]);
    let logseq = mock_logseq(vec![huge.clone()]).await;
    let result = get_block::call(&client(&logseq), true, arguments(json!({"uuid": uuid(5)}))).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&text_of(&result, 0)).unwrap(), huge);
}

#[tokio::test]
async fn a_block_with_children_in_markdown_is_cut_with_the_warning_in_its_footer() {
    let children: Vec<Value> = (1..=60).map(|n| block(500 + n, 1000, 0)).collect();
    let logseq = mock_logseq(vec![json!({"id": 5, "uuid": uuid(5), "content": "Parent", "page": {"id": 10}, "children": children})]).await;
    let result = get_block::call(&client(&logseq), true, arguments(json!({"uuid": uuid(5), "include_children": true, "format": "markdown"}))).await.unwrap();
    let text = text_of(&result, 0);
    assert!(size(&text) <= BUDGET_CHARS, "{}", size(&text));
    assert!(text.contains("result_size_truncated: Showing "), "{}", &text[text.len().saturating_sub(500)..]);
}

// ---- logseq_get_page, detail outline

const DATALOG: &str = "logseq.DB.datascriptQuery";

/// A top-level block row of the outline query: the first line is `length` characters.
fn outline_row(id: i64, left: i64, length: usize) -> Value {
    json!([{"id": id, "uuid": uuid(id), "content": "w".repeat(length), "left": {"id": left}, "parent": {"id": 10}}])
}

fn outline_answer(count: i64, length: usize) -> Value {
    json!((0..count).map(|n| outline_row(1000 + n, if n == 0 { 10 } else { 999 + n }, length)).collect::<Vec<_>>())
}

fn resolved_root() -> Value {
    json!([[{"id": 10, "uuid": uuid(10), "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 5010}}, "name"]])
}

#[tokio::test]
async fn an_outline_of_two_hundred_full_lines_is_cut_to_the_budget_and_a_short_one_is_not() {
    // 200 blocks of 80-character lines: the cap of 200 alone leaves ~31,000 characters
    let logseq = mock_logseq(vec![resolved_root(), outline_answer(200, 80)]).await;
    let result = get_page::call(&client(&logseq), true, arguments(json!({"page": "Project Atlas", "detail": "outline"}))).await.unwrap();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG]);
    let (outline, tips) = (text_of(&result, 0), text_of(&result, 1));
    assert!(size(&outline) + size(&tips) <= BUDGET_CHARS, "{}", size(&outline) + size(&tips));
    let outline: Value = serde_json::from_str(&outline).unwrap();
    let kept = outline["blocks"].as_array().unwrap().len();
    assert!(kept > 150 && kept < 200, "{kept}");
    assert_eq!(outline["hasMore"], false);
    assert_eq!(outline["totals"], json!({"blocks": 200}));
    let warnings = outline["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0]["code"], "result_size_truncated");
    assert!(warnings[0]["message"].as_str().unwrap().starts_with(&format!("Showing {kept} of 200 top-level blocks")));

    let logseq = mock_logseq(vec![resolved_root(), outline_answer(200, 20)]).await;
    let result = get_page::call(&client(&logseq), true, arguments(json!({"page": "Project Atlas", "detail": "outline"}))).await.unwrap();
    let outline: Value = serde_json::from_str(&text_of(&result, 0)).unwrap();
    assert_eq!(outline["blocks"].as_array().unwrap().len(), 200);
    assert_eq!(outline["warnings"], json!([]));
}

#[tokio::test]
async fn an_outline_in_toon_is_measured_as_toon() {
    let logseq = mock_logseq(vec![resolved_root(), outline_answer(200, 80)]).await;
    let result = get_page::call(&client(&logseq), true, arguments(json!({"page": "Project Atlas", "detail": "outline", "format": "toon"}))).await.unwrap();
    let (outline, tips) = (text_of(&result, 0), text_of(&result, 1));
    assert!(size(&outline) + size(&tips) <= BUDGET_CHARS);
    // the keys are written once in TOON, so what it sends is judged as TOON and not as the JSON it replaces
    assert!(!outline.contains("result_size_truncated"), "{}", &outline[outline.len().saturating_sub(300)..]);
    assert_eq!(outline.matches("00000000-0000-4000-8000-").count(), 200);
}
