//! The LogSeq traffic of `logseq_get_block` and `logseq_get_page` against a mock LogSeq on a local
//! port: how many calls each makes, in which order, with which arguments, and what it answers. The
//! Rust side of the call counts in `CLAUDE.md` ("Current Implementation Status"); the parity
//! harness (`parity.rs`) checks the same calls and the result bytes against the
//! TypeScript server. Every page and block here is made up (BR-0001).

mod common;

use common::{args_of, client, editor_block, methods, mock_logseq, uuid};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::{get_block, get_page};
use serde_json::{Value, json};

/// The page as `logseq.Editor.getPage` answers it.
fn editor_page(id: i64, name: &str, original: &str, file: bool) -> Value {
    let mut page = json!({"id": id, "uuid": uuid(id), "name": name, "originalName": original, "journal?": false});
    if file {
        page["file"] = json!({"id": id + 5000});
    }
    page
}

/// The page as the resolver's pull answers it.
fn pulled_page(id: i64, name: &str, original: &str, file: bool) -> Value {
    let mut page = json!({"id": id, "name": name, "original-name": original});
    if file {
        page["file"] = json!({"id": id + 5000});
    }
    page
}

fn text_of(result: &rmcp::model::CallToolResult, block: usize) -> String {
    serde_json::to_value(result).unwrap()["content"][block]["text"].as_str().unwrap().to_owned()
}

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

// ---- logseq_get_block

#[tokio::test]
async fn a_block_costs_one_call_and_is_returned_as_sent() {
    let sent = json!({"id": 5, "uuid": uuid(5), "content": "Kickoff", "children": [["uuid", uuid(6)]], "propertiesOrder": [], "extra": {"2": 1, "b": 2, "1": 3}});
    let logseq = mock_logseq(vec![sent.clone()]).await;
    let result = get_block::call(&client(&logseq), true, arguments(json!({"block_uuid": uuid(5)}))).await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.Editor.getBlock"]);
    assert_eq!(args_of(&logseq, 0), [json!(uuid(5))]);
    // the block as it came, its keys in the order LogSeq sent them (integer-like ones included); no meta block, no tips
    assert_eq!(
        text_of(&result, 0),
        format!(r#"{{"id":5,"uuid":"{}","content":"Kickoff","children":[["uuid","{}"]],"propertiesOrder":[],"extra":{{"2":1,"b":2,"1":3}}}}"#, uuid(5), uuid(6))
    );
    assert_eq!(serde_json::to_value(&result).unwrap()["content"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn children_are_asked_for_with_the_include_children_option() {
    let logseq = mock_logseq(vec![editor_block(5, "Parent")]).await;
    get_block::get_block(&client(&logseq), &uuid(5), true, false).await.unwrap();
    assert_eq!(args_of(&logseq, 0), [json!(uuid(5)), json!({"includeChildren": true})]);
}

#[tokio::test]
async fn a_block_that_is_not_there_is_named_as_the_caller_wrote_it() {
    let logseq = mock_logseq(vec![Value::Null]).await;
    let error = get_block::get_block(&client(&logseq), "no such block", false, false).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "Block not found: \"no such block\"\n\nTip: Block UUIDs come from search results or page queries. Verify the UUID is correct."
    );
    assert_eq!(methods(&logseq).len(), 1);
}

#[tokio::test]
async fn resolve_refs_on_a_block_with_no_ref_adds_the_meta_and_makes_no_extra_call() {
    let logseq = mock_logseq(vec![editor_block(5, "Plain")]).await;
    let result = get_block::call(&client(&logseq), true, arguments(json!({"uuid": uuid(5), "resolve_refs": true}))).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    assert_eq!(text_of(&result, 0), format!(r#"{{"id":5,"uuid":"{}","content":"Plain","page":{{"id":100}},"hasMore":false,"warnings":[]}}"#, uuid(5)));
}

#[tokio::test]
async fn resolve_refs_on_a_block_with_a_ref_costs_one_more_query_per_level() {
    let target = json!([{"id": 7, "uuid": uuid(7), "content": "Bob owns it", "page": {"id": 100, "name": "project atlas", "original-name": "Project Atlas"}}]);
    let logseq = mock_logseq(vec![editor_block(5, &format!("see (({}))", uuid(7))), json!([target])]).await;
    let block = get_block::get_block(&client(&logseq), &uuid(5), false, true).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.Editor.getBlock", "logseq.DB.datascriptQuery"]);
    assert_eq!(block["resolvedContent"], "see Bob owns it");
    assert_eq!(block["hasMore"], false);
}

#[tokio::test]
async fn a_bad_argument_is_refused_before_any_call() {
    let logseq = mock_logseq(vec![]).await;
    let error = get_block::call(&client(&logseq), true, arguments(json!({"block_uuid": uuid(5), "format": "xml"}))).await.unwrap_err();
    assert!(error.to_string().starts_with("Invalid parameter 'format': \"xml\""), "{error}");
    assert!(methods(&logseq).is_empty());
}

#[tokio::test]
async fn a_block_as_markdown_costs_the_same_call_and_is_one_text_block_with_no_tips() {
    let sent = json!({"id": 5, "uuid": uuid(5), "content": "Kickoff\nsecond line", "children": [{"id": 6, "uuid": uuid(6), "content": "Child"}]});
    let logseq = mock_logseq(vec![sent]).await;
    let result = get_block::call(&client(&logseq), true, arguments(json!({"block_uuid": uuid(5), "include_children": true, "format": "markdown"}))).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.Editor.getBlock"]);
    assert_eq!(args_of(&logseq, 0), [json!(uuid(5)), json!({"includeChildren": true})]);
    assert_eq!(text_of(&result, 0), format!("# Block (({}))\n\n- Kickoff\n  second line\n\t- Child\n", uuid(5)));
    assert_eq!(serde_json::to_value(&result).unwrap()["content"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_missing_block_is_the_same_error_in_markdown() {
    let logseq = mock_logseq(vec![Value::Null]).await;
    let error = get_block::call(&client(&logseq), true, arguments(json!({"block_uuid": "nope", "format": "markdown"}))).await.unwrap_err();
    assert!(error.to_string().starts_with("Block not found: \"nope\""), "{error}");
    assert_eq!(methods(&logseq).len(), 1);
}

#[tokio::test]
async fn an_answer_that_is_not_a_block_is_a_response_error() {
    let logseq = mock_logseq(vec![json!({"id": 1})]).await;
    let error = get_block::get_block(&client(&logseq), &uuid(5), false, false).await.unwrap_err();
    assert!(matches!(&error, ToolError::Response(response) if response.path == "answer.uuid"), "{error}");
}

// ---- logseq_get_page

#[tokio::test]
async fn the_exact_name_of_a_page_with_a_file_costs_one_call_and_no_resolver() {
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas", true)]).await;
    let result = get_page::call(&client(&logseq), true, arguments(json!({"page_name": "  Project Atlas "}))).await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.Editor.getPage"]);
    // the name is trimmed, and kept in the caller's casing
    assert_eq!(args_of(&logseq, 0), [json!("Project Atlas")]);
    assert_eq!(
        text_of(&result, 0),
        format!(r#"{{"id":10,"uuid":"{}","name":"project atlas","originalName":"Project Atlas","journal?":false,"file":{{"id":5010}}}}"#, uuid(10))
    );
    // the page was read without its blocks, so the first tip offers them
    assert_eq!(
        text_of(&result, 1),
        r#"{"meta":{"tips":["For its blocks: logseq_get_page {\"page_name\":\"Project Atlas\",\"include_children\":true}.","For what links here: logseq_get_backlinks {\"page_name\":\"Project Atlas\"}."]}}"#
    );
}

#[tokio::test]
async fn tips_can_be_turned_off_and_a_page_read_with_its_blocks_offers_only_the_links() {
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas", true)]).await;
    let result = get_page::call(&client(&logseq), false, arguments(json!({"page_name": "Project Atlas"}))).await.unwrap();
    assert_eq!(serde_json::to_value(&result).unwrap()["content"].as_array().unwrap().len(), 1);

    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas", true), json!([editor_block(11, "First")])]).await;
    let result = get_page::call(&client(&logseq), true, arguments(json!({"page": "Project Atlas", "include_children": true}))).await.unwrap();
    assert_eq!(text_of(&result, 1), r#"{"meta":{"tips":["For what links here: logseq_get_backlinks {\"page_name\":\"Project Atlas\"}."]}}"#);
}

#[tokio::test]
async fn the_blocks_cost_one_more_call_and_a_page_with_none_gets_no_children_key() {
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas", true), json!([editor_block(11, "First"), editor_block(12, "Second")])]).await;
    let page = get_page::get_page(&client(&logseq), "Project Atlas", true, false).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.Editor.getPage", "logseq.Editor.getPageBlocksTree"]);
    assert_eq!(args_of(&logseq, 1), [json!("Project Atlas")]);
    assert_eq!(page["children"].as_array().unwrap().len(), 2);
    // `children` is the last key
    assert_eq!(page.to_string().rsplit_once(r#","children":"#).map(|(_, rest)| rest.starts_with('[')), Some(true));

    // A real `[]` is a page with no blocks and says nothing
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas", true), json!([])]).await;
    let page = get_page::get_page(&client(&logseq), "Project Atlas", true, false).await.unwrap();
    assert!(page.get("children").is_none() && page.get("warnings").is_none() && page.get("hasMore").is_none());
}

#[tokio::test]
async fn a_null_block_tree_is_a_warning_and_not_a_page_with_no_blocks() {
    // BR-0011: `null` is no answer. `hasMore` stays false and there is no `howToFetchAll` (BR-0006)
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas", true), Value::Null]).await;
    let page = get_page::get_page(&client(&logseq), "Project Atlas", true, false).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.Editor.getPage", "logseq.Editor.getPageBlocksTree"]);
    assert!(page.get("children").is_none());
    assert_eq!(page["hasMore"], false);
    let warnings = page["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0]["code"], "page_blocks_unavailable");
    assert!(warnings[0].get("howToFetchAll").is_none());
    assert!(warnings[0]["message"].as_str().unwrap().contains("does not mean the page has no blocks"));
    // the meta follows the page's own keys
    assert!(page.to_string().contains(r#","hasMore":false,"warnings":[{"code":"page_blocks_unavailable","message":"#));

    // With `resolve_refs` the warning is merged with the ones that path makes, and no ref lookup is made for no blocks
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas", true), Value::Null]).await;
    let page = get_page::get_page(&client(&logseq), "Project Atlas", true, true).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.Editor.getPage", "logseq.Editor.getPageBlocksTree"]);
    assert_eq!(page["hasMore"], false);
    assert_eq!(page["warnings"].as_array().unwrap().iter().map(|w| w["code"].as_str().unwrap()).collect::<Vec<_>>(), ["page_blocks_unavailable"]);

    // Without `include_children` no tree is asked for, so there is nothing to warn about
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas", true)]).await;
    let page = get_page::get_page(&client(&logseq), "Project Atlas", false, false).await.unwrap();
    assert!(page.get("warnings").is_none());
}

#[tokio::test]
async fn a_stub_with_no_file_costs_one_resolver_query_and_keeps_the_page_already_fetched() {
    let logseq = mock_logseq(vec![
        editor_page(20, "bob", "Bob", false),
        json!([[pulled_page(20, "bob", "Bob", false), "name"]]),
    ])
    .await;
    let page = get_page::get_page(&client(&logseq), "Bob", false, false).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.Editor.getPage", "logseq.DB.datascriptQuery"]);
    assert_eq!(page["originalName"], "Bob");
    assert!(page.get("resolvedFrom").is_none());
}

#[tokio::test]
async fn an_alias_costs_the_failed_lookup_the_resolver_and_the_fetch_of_the_real_page() {
    let logseq = mock_logseq(vec![
        Value::Null,
        json!([[pulled_page(10, "project atlas", "Project Atlas", true), "alias"]]),
        editor_page(10, "project atlas", "Project Atlas", true),
        json!([editor_block(11, "First")]),
    ])
    .await;
    let page = get_page::get_page(&client(&logseq), " Atlas", true, false).await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.Editor.getPage", "logseq.DB.datascriptQuery", "logseq.Editor.getPage", "logseq.Editor.getPageBlocksTree"]);
    assert_eq!(args_of(&logseq, 0), [json!("Atlas")]);
    // the follow-up calls use the page's own lowercase name
    assert_eq!(args_of(&logseq, 2), [json!("project atlas")]);
    assert_eq!(args_of(&logseq, 3), [json!("project atlas")]);
    // `resolvedFrom` carries the name as typed (untrimmed), then `children`
    let written = page.to_string();
    assert!(written.contains(r#""resolvedFrom":{"name":" Atlas","matchedBy":"alias","resolvedTo":"Project Atlas"},"children":["#), "{written}");
}

#[tokio::test]
async fn an_iso_date_finds_the_journal_by_its_day() {
    let logseq = mock_logseq(vec![
        Value::Null,
        json!([[pulled_page(30, "jan 1st, 2025", "Jan 1st, 2025", true), "journal-date"]]),
        editor_page(30, "jan 1st, 2025", "Jan 1st, 2025", true),
    ])
    .await;
    let page = get_page::get_page(&client(&logseq), "2025-01-01", false, false).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
    assert_eq!(page["resolvedFrom"]["matchedBy"], "journal-date");
    assert_eq!(args_of(&logseq, 1)[2], json!("20250101"));
}

#[tokio::test]
async fn a_missing_page_costs_the_lookup_the_resolver_the_leaf_query_and_the_suggestions() {
    let logseq = mock_logseq(vec![
        Value::Null,
        json!([]),
        json!([]),
        json!([{"originalName": "Project Atlas"}, {"originalName": "Alice"}]),
    ])
    .await;
    let error = get_page::get_page(&client(&logseq), "Atlas", false, false).await.unwrap_err();
    assert_eq!(methods(&logseq), ["logseq.Editor.getPage", "logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery", "logseq.Editor.getAllPages"]);
    assert!(matches!(&error, ToolError::PageNotFound(missing) if missing.page_name == "Atlas"), "{error}");
}

#[tokio::test]
async fn a_name_that_two_pages_declare_is_ambiguous_and_nothing_is_picked() {
    let logseq = mock_logseq(vec![
        Value::Null,
        json!([[pulled_page(40, "alice", "Alice", true), "alias"], [pulled_page(41, "alice notes", "Alice Notes", true), "alias"]]),
    ])
    .await;
    let error = get_page::get_page(&client(&logseq), "al", false, false).await.unwrap_err();
    assert!(matches!(error, ToolError::AmbiguousPage(ref ambiguous) if ambiguous.total_candidates == 2));
    assert_eq!(methods(&logseq).len(), 2);
}

#[tokio::test]
async fn a_page_that_vanishes_between_the_two_lookups_is_not_found_without_suggestions() {
    let logseq = mock_logseq(vec![
        Value::Null,
        json!([[pulled_page(10, "project atlas", "Project Atlas", true), "alias"]]),
        Value::Null,
    ])
    .await;
    let error = get_page::get_page(&client(&logseq), "atlas", false, false).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "No page \"atlas\". Try logseq_search_blocks to find it by content, or logseq_list_pages (name_contains) to browse names."
    );
    assert_eq!(methods(&logseq).len(), 3);
}

#[tokio::test]
async fn resolve_refs_annotates_the_blocks_and_adds_the_meta_even_when_nothing_has_a_ref() {
    let target = json!([{"id": 7, "uuid": uuid(7), "content": "Bob owns it", "page": {"id": 100, "name": "project atlas", "original-name": "Project Atlas"}}]);
    let logseq = mock_logseq(vec![
        editor_page(10, "project atlas", "Project Atlas", true),
        json!([editor_block(11, &format!("see (({}))", uuid(7))), editor_block(12, "plain")]),
        json!([target]),
    ])
    .await;
    let page = get_page::get_page(&client(&logseq), "Project Atlas", true, true).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.Editor.getPage", "logseq.Editor.getPageBlocksTree", "logseq.DB.datascriptQuery"]);
    assert_eq!(page["children"][0]["resolvedContent"], "see Bob owns it");
    assert!(page["children"][1].get("resolvedContent").is_none());
    assert!(page.to_string().ends_with(r#""hasMore":false,"warnings":[]}"#));

    // without include_children there are no blocks to look at: no query, and the meta all the same
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas", true)]).await;
    let page = get_page::get_page(&client(&logseq), "Project Atlas", false, true).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    assert!(page.to_string().ends_with(r#""file":{"id":5010},"hasMore":false,"warnings":[]}"#));
}

#[tokio::test]
async fn an_answer_that_is_not_a_page_is_a_response_error_naming_the_method() {
    let logseq = mock_logseq(vec![json!({"id": 1})]).await;
    let error = get_page::get_page(&client(&logseq), "x", false, false).await.unwrap_err();
    assert!(matches!(&error, ToolError::Response(r) if r.method == "logseq.Editor.getPage" && r.path == "answer.name"), "{error}");
}

#[tokio::test]
async fn a_page_as_markdown_costs_the_same_calls_and_carries_its_tips_in_the_footer() {
    let logseq = mock_logseq(vec![
        editor_page(10, "project atlas", "Project Atlas", true),
        json!([editor_block(11, "First"), json!({"id": 12, "uuid": uuid(12), "content": "Second", "page": {"id": 100}, "children": [editor_block(13, "Nested")]})]),
    ])
    .await;
    let result = get_page::call(&client(&logseq), true, arguments(json!({"page_name": "Project Atlas", "include_children": true, "format": "markdown"}))).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.Editor.getPage", "logseq.Editor.getPageBlocksTree"]);
    assert_eq!(
        text_of(&result, 0),
        "# Project Atlas\n\n- First\n- Second\n\t- Nested\n\n---\nTips:\n- For what links here: logseq_get_backlinks {\"page_name\":\"Project Atlas\"}.\n"
    );
    // one text block: the tips are in the footer, not a second block
    assert_eq!(serde_json::to_value(&result).unwrap()["content"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_page_as_markdown_without_blocks_or_tips_is_only_its_title() {
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas", true)]).await;
    let result = get_page::call(&client(&logseq), false, arguments(json!({"page_name": "Project Atlas", "format": "markdown"}))).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    assert_eq!(text_of(&result, 0), "# Project Atlas\n");
}

#[tokio::test]
async fn a_page_as_markdown_shows_the_refs_it_resolved_and_the_warnings_of_the_footer() {
    let target = json!([{"id": 7, "uuid": uuid(7), "content": "Bob owns it", "page": {"id": 100, "name": "project atlas", "original-name": "Project Atlas"}}]);
    let logseq = mock_logseq(vec![
        editor_page(10, "project atlas", "Project Atlas", true),
        json!([editor_block(11, &format!("see (({}))", uuid(7)))]),
        json!([target]),
    ])
    .await;
    let args = json!({"page_name": "Project Atlas", "include_children": true, "resolve_refs": true, "format": "markdown"});
    let result = get_page::call(&client(&logseq), false, arguments(args)).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
    assert_eq!(text_of(&result, 0), format!("# Project Atlas\n\n- see (({}))\n  [resolved] see Bob owns it\n", uuid(7)));
}

#[tokio::test]
async fn a_page_reached_by_an_alias_says_so_in_markdown() {
    let logseq = mock_logseq(vec![
        Value::Null,
        json!([[pulled_page(10, "project atlas", "Project Atlas", true), "alias"]]),
        editor_page(10, "project atlas", "Project Atlas", true),
    ])
    .await;
    let result = get_page::call(&client(&logseq), false, arguments(json!({"page_name": "atlas", "format": "markdown"}))).await.unwrap();
    assert_eq!(text_of(&result, 0), "# Project Atlas\n\n(resolved from \"atlas\", matched by alias)\n");
}
