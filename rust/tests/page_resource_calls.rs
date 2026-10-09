//! The LogSeq traffic of the `logseq://page/{name}` resource against a mock LogSeq on a local port,
//! and what it answers. It reads a page the way `logseq_get_page` does with `include_children`, so
//! it makes the same calls: the page, then its blocks. The parity harness
//! (`parity.rs`) checks the same against the TypeScript server. Every page and block here
//! is made up (BR-0001).

mod common;

use common::{args_of, client, editor_block, methods, mock_logseq, uuid};
use logseq_mcp_server::resources::{self, MAX_PAGE_CHARS};
use serde_json::{Value, json};

fn editor_page(id: i64, name: &str, original: &str) -> Value {
    json!({"id": id, "uuid": uuid(id), "name": name, "originalName": original, "journal?": false, "file": {"id": id + 5000}})
}

fn text_of(result: &rmcp::model::ReadResourceResult) -> String {
    serde_json::to_value(result).unwrap()["contents"][0]["text"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_page_is_read_with_its_blocks_in_two_calls_and_is_markdown_text() {
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas"), json!([editor_block(11, "First"), editor_block(12, "Second")])]).await;
    let result = resources::read(&client(&logseq), "logseq://page/Project%20Atlas").await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.Editor.getPage", "logseq.Editor.getPageBlocksTree"]);
    assert_eq!(args_of(&logseq, 0), [json!("Project Atlas")]);
    let written = serde_json::to_value(&result).unwrap();
    // the uri as sent, the type, and the text: no footer, no tips
    assert_eq!(written["contents"].as_array().unwrap().len(), 1);
    assert_eq!(written["contents"][0]["uri"], "logseq://page/Project%20Atlas");
    assert_eq!(written["contents"][0]["mimeType"], "text/markdown");
    assert_eq!(text_of(&result), "# Project Atlas\n\n- First\n- Second\n");
}

#[tokio::test]
async fn a_page_with_no_blocks_says_so_and_an_alias_says_where_it_came_from() {
    let logseq = mock_logseq(vec![
        Value::Null,
        json!([[{"id": 10, "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 5010}}, "alias"]]),
        editor_page(10, "project atlas", "Project Atlas"),
        json!([]),
    ])
    .await;
    let result = resources::read(&client(&logseq), "logseq://page/atlas").await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.Editor.getPage", "logseq.DB.datascriptQuery", "logseq.Editor.getPage", "logseq.Editor.getPageBlocksTree"]);
    assert_eq!(text_of(&result), "# Project Atlas\n\n(resolved from \"atlas\", matched by alias)\n\n(this page has no blocks)\n");
}

#[tokio::test]
async fn a_null_block_tree_adds_the_footer_and_a_page_with_no_blocks_does_not() {
    // BR-0011: `null` is no answer, and the text must not read as a page with nothing on it without saying why
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas"), Value::Null]).await;
    let text = text_of(&resources::read(&client(&logseq), "logseq://page/Project%20Atlas").await.unwrap());
    assert!(text.starts_with("# Project Atlas\n\n(this page has no blocks)\n\n---\nWarnings:\n- page_blocks_unavailable: "), "{text}");
    assert!(text.ends_with("check which graph is open.\n"), "{text}");
    assert!(!text.contains("hasMore"), "{text}");

    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas"), json!([])]).await;
    let text = text_of(&resources::read(&client(&logseq), "logseq://page/Project%20Atlas").await.unwrap());
    assert_eq!(text, "# Project Atlas\n\n(this page has no blocks)\n");
}

#[tokio::test]
async fn a_long_page_is_cut_at_the_cap_and_the_notice_says_how_to_read_on() {
    let blocks: Vec<Value> = (0..40).map(|i| editor_block(100 + i, &format!("{i} {}", "x".repeat(2000)))).collect();
    let logseq = mock_logseq(vec![editor_page(10, "project atlas", "Project Atlas"), Value::Array(blocks)]).await;
    let text = text_of(&resources::read(&client(&logseq), "logseq://page/project%20atlas").await.unwrap());
    let notice = format!("[Cut at {MAX_PAGE_CHARS} characters. The page continues. Use logseq_get_page or logseq_get_block for the rest.]");
    assert!(text.ends_with(&format!("\n\n{notice}\n")), "{}", &text[text.len() - 200..]);
    assert!(text.len() < MAX_PAGE_CHARS + 500);
}

#[tokio::test]
async fn a_name_nothing_matches_is_resource_not_found_with_the_tool_s_message() {
    let logseq = mock_logseq(vec![Value::Null, json!([]), json!([]), json!([{"originalName": "Project Atlas"}])]).await;
    let error = resources::read(&client(&logseq), "logseq://page/Atlas").await.unwrap_err();
    assert_eq!(error.code.0, -32002);
    assert_eq!(
        error.message,
        "MCP error -32002: No page \"Atlas\". Closest: Project Atlas. Try logseq_search_blocks to find it by content, or logseq_list_pages (name_contains) to browse names."
    );
    assert!(error.data.is_none());
}

#[tokio::test]
async fn an_ambiguous_name_is_invalid_params() {
    let page = |id: i64, name: &str, original: &str| json!({"id": id, "name": name, "original-name": original, "file": {"id": id + 5000}});
    let logseq = mock_logseq(vec![Value::Null, json!([[page(40, "alice", "Alice"), "alias"], [page(41, "alice notes", "Alice Notes"), "alias"]])]).await;
    let error = resources::read(&client(&logseq), "logseq://page/al").await.unwrap_err();
    assert_eq!(error.code.0, -32602);
    assert!(error.message.starts_with("MCP error -32602: "), "{}", error.message);
    assert_eq!(methods(&logseq).len(), 2);
}

#[tokio::test]
async fn a_bad_uri_is_refused_before_any_call() {
    let logseq = mock_logseq(vec![]).await;
    for (uri, code) in [("logseq://page/%E0%A4%A", -32602), ("logseq://page/", -32602), ("logseq://elsewhere", -32002), ("file:///x", -32002)] {
        let error = resources::read(&client(&logseq), uri).await.unwrap_err();
        assert_eq!(error.code.0, code, "{uri}");
    }
    let error = resources::read(&client(&logseq), "logseq://nope").await.unwrap_err();
    assert_eq!(error.message, "MCP error -32002: Unknown resource \"logseq://nope\". Available: logseq://guide, logseq://page/{name}.");
    assert!(methods(&logseq).is_empty());
}

#[tokio::test]
async fn the_guide_is_read_without_a_call() {
    let logseq = mock_logseq(vec![]).await;
    let read = resources::read(&client(&logseq), "logseq://guide").await.unwrap();
    let text = serde_json::to_value(&read).unwrap()["contents"][0]["text"].as_str().unwrap().to_owned();
    assert!(text.starts_with("# LogSeq MCP guide\n\n"), "{text}");
    assert!(methods(&logseq).is_empty());
}

#[tokio::test]
async fn a_failure_that_is_not_the_page_s_is_an_internal_error_with_its_own_message() {
    let logseq = mock_logseq(vec![json!({"id": 1})]).await;
    let error = resources::read(&client(&logseq), "logseq://page/x").await.unwrap_err();
    assert_eq!(error.code.0, -32603);
    assert!(!error.message.starts_with("MCP error"), "{}", error.message);
}
