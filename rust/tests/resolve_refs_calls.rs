//! The ref resolver's LogSeq traffic and results against a mock LogSeq on a local port: how many
//! queries it makes (one per nesting level, none when nothing has a ref), what it binds and what
//! it makes of each answer. The Rust side of `src/utils/resolve-refs.test.ts`; the parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the TypeScript
//! server, through `logseq_get_block` and `logseq_get_page`. Every page and block here is made up
//! (BR-0001).

mod common;

use common::{args_of, client, editor_block, methods, mock_logseq, uuid};
use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::resolve_refs::{Options, resolve_block_refs, resolve_block_refs_with};
use serde_json::{Value, json};

/// A block as a ref lookup pulls it: on the page "Project Atlas" (id 100) unless `parent` says
/// it hangs off another block. `left` is what orders it among its siblings.
fn target(id: i64, content: &str, parent: i64, left: i64) -> Value {
    json!([{
        "id": id, "uuid": uuid(id), "content": content, "left": {"id": left}, "parent": {"id": parent},
        "page": {"id": 100, "name": "project atlas", "original-name": "Project Atlas"}
    }])
}

fn root(content: &str) -> Value {
    editor_block(1, content)
}

fn text(value: &Value) -> String {
    serde_json::to_string(value).unwrap()
}

#[tokio::test]
async fn blocks_with_no_ref_make_no_call_and_come_back_as_they_were() {
    let logseq = mock_logseq(vec![]).await;
    let roots = vec![root("plain ((not a uuid)) and {{embed [[]]}}"), json!({"id": 2, "uuid": uuid(2)})];
    let resolved = resolve_block_refs(&client(&logseq), &roots).await.unwrap();
    assert_eq!(resolved.blocks, roots);
    assert!(resolved.warnings.is_empty());
    assert!(methods(&logseq).is_empty());
}

#[tokio::test]
async fn a_ref_costs_one_query_and_is_replaced_inline_with_the_page_it_sits_on() {
    let logseq = mock_logseq(vec![json!([target(2, "Bob owns the importer\nid:: 00000000-0000-4000-8000-000000000002", 100, 100)])]).await;
    let roots = vec![root(&format!("see (({}))", uuid(2)))];
    let resolved = resolve_block_refs(&client(&logseq), &roots).await.unwrap();

    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    // the uuid is embedded as a #uuid literal in the one `ground`; nothing else is bound
    let args = args_of(&logseq, 0);
    assert_eq!(args.len(), 1);
    assert!(args[0].as_str().unwrap().contains(&format!("[(ground [#uuid \"{}\"]) [?u ...]]", uuid(2))));
    // the content is untouched, and the two new keys follow the block's own, in this order
    assert_eq!(
        text(&resolved.blocks[0]),
        format!(
            r#"{{"id":1,"uuid":"{}","content":"see (({}))","page":{{"id":100}},"resolvedContent":"see Bob owns the importer","resolvedRefs":[{{"uuid":"{}","content":"Bob owns the importer","page":"Project Atlas","status":"ok"}}]}}"#,
            uuid(1),
            uuid(2),
            uuid(2)
        )
    );
    assert!(resolved.warnings.is_empty());
    // the input is not changed
    assert!(roots[0].get("resolvedContent").is_none());
}

#[tokio::test]
async fn a_chain_costs_one_query_per_level_and_stops_at_depth_two_with_a_warning() {
    let logseq = mock_logseq(vec![
        json!([target(2, &format!("mid (({}))", uuid(3)), 100, 100)]),
        json!([target(3, &format!("end (({}))", uuid(4)), 100, 100)]),
    ])
    .await;
    let resolved = resolve_block_refs(&client(&logseq), &[root(&format!("go (({}))", uuid(2)))]).await.unwrap();

    assert_eq!(methods(&logseq).len(), 2);
    let block = &resolved.blocks[0];
    assert_eq!(block["resolvedContent"], format!("go mid end (({}))", uuid(4)));
    let statuses: Vec<(&str, &str)> =
        block["resolvedRefs"].as_array().unwrap().iter().map(|r| (r["uuid"].as_str().unwrap(), r["status"].as_str().unwrap())).collect();
    assert_eq!(statuses, [(uuid(2).as_str(), "ok"), (uuid(3).as_str(), "ok"), (uuid(4).as_str(), "depth_limit")]);
    assert_eq!(resolved.warnings.len(), 1);
    assert_eq!(resolved.warnings[0].code, "refs_depth_limit");
    assert_eq!(
        resolved.warnings[0].message,
        "1 reference(s) were not followed because they are more than 2 levels deep. They are left as written."
    );
    assert!(resolved.warnings[0].how_to_fetch_all.as_deref().unwrap().contains("logseq_get_block"));
}

#[tokio::test]
async fn a_depth_of_zero_makes_no_call_and_leaves_the_ref_at_the_depth_limit() {
    let logseq = mock_logseq(vec![]).await;
    let options = Options { max_depth: 0, ..Options::default() };
    let resolved = resolve_block_refs_with(&client(&logseq), &[root(&format!("(({}))", uuid(2)))], options).await.unwrap();
    assert!(methods(&logseq).is_empty());
    assert_eq!(resolved.blocks[0]["resolvedRefs"][0]["status"], "depth_limit");
    assert!(resolved.warnings[0].message.contains("more than 0 levels deep"));
}

#[tokio::test]
async fn a_ref_back_to_a_block_on_the_path_is_a_cycle_named_after_its_page_and_left_as_written() {
    let logseq = mock_logseq(vec![
        json!([target(2, &format!("back (({}))", uuid(1)), 100, 100)]),
        json!([target(1, &format!("(({}))", uuid(2)), 100, 100)]),
    ])
    .await;
    let resolved = resolve_block_refs(&client(&logseq), &[root(&format!("(({}))", uuid(2)))]).await.unwrap();
    let block = &resolved.blocks[0];
    assert_eq!(block["resolvedContent"], format!("back (({}))", uuid(1)));
    assert_eq!(block["resolvedRefs"][1]["status"], "cycle");
    assert_eq!(block["resolvedRefs"][1]["page"], "Project Atlas");
    assert_eq!(block["resolvedRefs"][1]["content"], Value::Null);
    assert!(resolved.warnings.is_empty());
}

#[tokio::test]
async fn two_siblings_that_name_one_block_both_resolve_and_the_block_is_asked_for_once() {
    let logseq = mock_logseq(vec![json!([target(2, "shared", 100, 100)])]).await;
    let roots = vec![root(&format!("(({}))", uuid(2))), editor_block(3, &format!("also (({}))", uuid(2)))];
    let resolved = resolve_block_refs(&client(&logseq), &roots).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    assert_eq!(resolved.blocks[0]["resolvedContent"], "shared");
    assert_eq!(resolved.blocks[1]["resolvedContent"], "also shared");
}

#[tokio::test]
async fn an_uppercase_uuid_is_asked_for_and_reported_in_lowercase() {
    let upper = "0000000A-0000-4000-8000-00000000000B";
    let lower = upper.to_lowercase();
    let found = json!([{"id": 2, "uuid": lower, "content": "found", "page": {"id": 100, "name": "p"}}]);
    let logseq = mock_logseq(vec![json!([found])]).await;
    let resolved = resolve_block_refs(&client(&logseq), &[root(&format!("(({upper}))"))]).await.unwrap();
    assert_eq!(resolved.blocks[0]["resolvedRefs"][0]["uuid"], lower);
    assert_eq!(resolved.blocks[0]["resolvedRefs"][0]["status"], "ok");
    assert!(args_of(&logseq, 0)[0].as_str().unwrap().contains(&format!("#uuid \"{lower}\"")));
}

#[tokio::test]
async fn a_uuid_with_no_row_or_only_a_placeholder_is_missing_and_not_asked_for_again() {
    // level 1 asks for 2 and 3; 2 has no row, 3 has LogSeq's placeholder (no page, no name)
    let placeholder = json!([{"id": 9, "uuid": uuid(3), "content": format!("id:: {}", uuid(3))}]);
    let logseq = mock_logseq(vec![json!([placeholder])]).await;
    let content = format!("(({})) (({}))", uuid(2), uuid(3));
    let resolved = resolve_block_refs(&client(&logseq), &[root(&content)]).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    let block = &resolved.blocks[0];
    assert_eq!(block["resolvedContent"], content);
    let statuses: Vec<&str> = block["resolvedRefs"].as_array().unwrap().iter().map(|r| r["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, ["missing", "missing"]);
    assert!(resolved.warnings.is_empty());
}

#[tokio::test]
async fn a_real_block_whose_content_is_only_its_id_line_still_resolves_to_empty_text() {
    let empty = json!([{"id": 2, "uuid": uuid(2), "content": format!("id:: {}", uuid(2)), "page": {"id": 100, "name": "p", "original-name": "P"}}]);
    let logseq = mock_logseq(vec![json!([empty])]).await;
    let resolved = resolve_block_refs(&client(&logseq), &[root(&format!("[(({}))]", uuid(2)))]).await.unwrap();
    assert_eq!(resolved.blocks[0]["resolvedContent"], "[]");
    assert_eq!(resolved.blocks[0]["resolvedRefs"][0]["status"], "ok");
}

#[tokio::test]
async fn a_null_answer_leaves_the_refs_unavailable_with_a_warning_that_has_no_way_to_fetch() {
    let logseq = mock_logseq(vec![Value::Null]).await;
    let content = format!("(({})) {{{{embed [[Atlas]]}}}}", uuid(2));
    let resolved = resolve_block_refs(&client(&logseq), &[root(&content)]).await.unwrap();
    // `null` is not "missing", and the next level is not asked: nothing was found to read refs from
    assert_eq!(methods(&logseq).len(), 1);
    let block = &resolved.blocks[0];
    assert_eq!(block["resolvedContent"], content);
    let statuses: Vec<&str> = block["resolvedRefs"].as_array().unwrap().iter().map(|r| r["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, ["unavailable", "unavailable"]);
    assert_eq!(resolved.warnings.len(), 1);
    assert_eq!(resolved.warnings[0].code, "refs_unavailable");
    assert_eq!(resolved.warnings[0].how_to_fetch_all, None);
    assert!(resolved.warnings[0].message.starts_with("LogSeq returned no answer when looking up 2 reference(s)"));
}

#[tokio::test]
async fn an_empty_array_is_missing_not_unavailable() {
    let logseq = mock_logseq(vec![json!([])]).await;
    let resolved = resolve_block_refs(&client(&logseq), &[root(&format!("(({}))", uuid(2)))]).await.unwrap();
    assert_eq!(resolved.blocks[0]["resolvedRefs"][0]["status"], "missing");
    assert!(resolved.warnings.is_empty());
}

#[tokio::test]
async fn a_block_embed_shows_the_block_and_three_levels_of_its_children_in_order_indented() {
    // the embedded block (2) has children 3 then 4 (4's left is 3), and 3 has a child 5; sent shuffled
    let logseq = mock_logseq(vec![json!([
        target(4, "Child B", 2, 3),
        target(5, "Grandchild", 3, 3),
        target(2, "Embedded", 100, 100),
        target(3, "Child A", 2, 2),
    ])])
    .await;
    let resolved = resolve_block_refs(&client(&logseq), &[root(&format!("{{{{embed (({}))}}}}", uuid(2)))]).await.unwrap();
    let args = args_of(&logseq, 0)[0].as_str().unwrap().to_owned();
    assert!(args.contains("[?r :block/uuid ?ru]") && args.contains("[?m2 :block/parent ?m1] [?e :block/parent ?m2]"));
    let block = &resolved.blocks[0];
    assert_eq!(block["resolvedContent"], "Embedded\n  - Child A\n    - Grandchild\n  - Child B");
    assert_eq!(
        text(&block["resolvedRefs"]),
        format!(
            r#"[{{"uuid":"{}","embed":"block","content":"Embedded\n  - Child A\n    - Grandchild\n  - Child B","page":"Project Atlas","status":"ok"}}]"#,
            uuid(2)
        )
    );
}

#[tokio::test]
async fn a_block_embed_is_cut_at_the_embed_limit_and_says_how_to_fetch_the_rest() {
    let logseq = mock_logseq(vec![json!([
        target(2, "Embedded", 100, 100),
        target(3, "Child A", 2, 2),
        target(4, "Child B", 2, 3),
        target(5, "Child C", 2, 4),
    ])])
    .await;
    let options = Options { embed_limit: 2, ..Options::default() };
    let resolved = resolve_block_refs_with(&client(&logseq), &[root(&format!("{{{{embed (({}))}}}}", uuid(2)))], options).await.unwrap();
    assert_eq!(resolved.blocks[0]["resolvedContent"], "Embedded\n  - Child A\n[... 2 more blocks not shown]");
    assert_eq!(resolved.warnings.len(), 1);
    assert_eq!(resolved.warnings[0].code, "embed_truncated");
    assert_eq!(resolved.warnings[0].message, format!("Embed of block {} shows 2 of 4 blocks.", uuid(2)));
    assert_eq!(
        resolved.warnings[0].how_to_fetch_all.as_deref(),
        Some(format!("Call logseq_get_block with block_uuid \"{}\" and include_children true.", uuid(2)).as_str())
    );
}

#[tokio::test]
async fn a_page_embed_binds_the_lowercase_name_and_shows_the_top_level_blocks_in_order() {
    let page = json!([{"id": 100, "name": "project atlas", "original-name": "Project Atlas"}]);
    let logseq = mock_logseq(vec![json!([page, target(12, "Second", 100, 11), target(11, "First", 100, 100)])]).await;
    let resolved = resolve_block_refs(&client(&logseq), &[root("{{embed [[ Project ATLAS ]]}}")]).await.unwrap();
    let args = args_of(&logseq, 0);
    assert_eq!(args[1], "[\"project atlas\"]");
    assert!(args[0].as_str().unwrap().contains(":in $ [?n ...]"));
    assert!(!args[0].as_str().unwrap().to_lowercase().contains("atlas"));
    let block = &resolved.blocks[0];
    assert_eq!(block["resolvedContent"], "- First\n- Second");
    // the page is named as LogSeq spells it
    assert_eq!(
        text(&block["resolvedRefs"]),
        r#"[{"embed":"page","content":"- First\n- Second","page":"Project Atlas","status":"ok"}]"#
    );
}

#[tokio::test]
async fn a_page_embed_with_no_entity_is_missing_and_keeps_the_name_as_written() {
    let logseq = mock_logseq(vec![json!([])]).await;
    let resolved = resolve_block_refs(&client(&logseq), &[root("{{embed [[ Nowhere ]]}}")]).await.unwrap();
    assert_eq!(resolved.blocks[0]["resolvedContent"], "{{embed [[ Nowhere ]]}}");
    assert_eq!(
        text(&resolved.blocks[0]["resolvedRefs"]),
        r#"[{"embed":"page","content":null,"page":"Nowhere","status":"missing"}]"#
    );
}

#[tokio::test]
async fn refs_in_children_are_resolved_in_the_same_batch() {
    let logseq = mock_logseq(vec![json!([target(2, "one", 100, 100), target(3, "two", 100, 100)])]).await;
    let mut parent = root(&format!("top (({}))", uuid(2)));
    parent["children"] = json!([editor_block(5, &format!("child (({}))", uuid(3))), editor_block(6, "no ref")]);
    let unfetched = json!({"id": 7, "uuid": uuid(7), "content": "x", "children": [["uuid", "abc"]]});
    let resolved = resolve_block_refs(&client(&logseq), &[parent, unfetched]).await.unwrap();

    assert_eq!(methods(&logseq).len(), 1);
    assert_eq!(resolved.blocks[0]["resolvedContent"], "top one");
    assert_eq!(resolved.blocks[0]["children"][0]["resolvedContent"], "child two");
    assert!(resolved.blocks[0]["children"][1].get("resolvedContent").is_none());
}

#[tokio::test]
async fn a_root_that_is_not_a_block_comes_back_as_sent_beside_a_root_that_is_annotated() {
    let logseq = mock_logseq(vec![json!([target(2, "one", 100, 100)])]).await;
    let roots = [json!(["uuid", "abc"]), root(&format!("top (({}))", uuid(2)))];
    let resolved = resolve_block_refs(&client(&logseq), &roots).await.unwrap();

    assert_eq!(resolved.blocks[0], json!(["uuid", "abc"]));
    assert_eq!(resolved.blocks[1]["resolvedContent"], "top one");
}

#[tokio::test]
async fn an_unfetched_child_tuple_is_left_as_sent_beside_real_children_that_are_still_annotated() {
    let logseq = mock_logseq(vec![json!([target(2, "one", 100, 100)])]).await;
    let mut parent = root("top");
    parent["children"] = json!([["uuid", "abc"], editor_block(5, &format!("child (({}))", uuid(2))), "bare"]);
    let unfetched = json!({"id": 7, "uuid": uuid(7), "content": "x", "children": [["uuid", "abc"]]});
    let resolved = resolve_block_refs(&client(&logseq), &[parent, unfetched]).await.unwrap();

    let children = &resolved.blocks[0]["children"];
    assert_eq!(children[0], json!(["uuid", "abc"]));
    assert_eq!(children[1]["resolvedContent"], "child one");
    // anything else that is not a block comes back untouched too
    assert_eq!(children[2], "bare");
    assert_eq!(text(&resolved.blocks[1]["children"]), r#"[["uuid","abc"]]"#);
}

#[tokio::test]
async fn an_answer_that_is_not_a_target_is_a_response_error_and_not_an_empty_result() {
    let logseq = mock_logseq(vec![json!([[{"uuid": "no id"}]])]).await;
    let error = resolve_block_refs(&client(&logseq), &[root(&format!("(({}))", uuid(2)))]).await.unwrap_err();
    match error {
        ToolError::Response(response) => assert_eq!((response.method.as_str(), response.path.as_str()), ("logseq.DB.datascriptQuery", "answer[0][0].id")),
        other => panic!("expected a response error, got {other}"),
    }
}

#[tokio::test]
async fn a_connection_failure_propagates_instead_of_returning_unresolved_blocks() {
    let unreachable: LogseqClient = {
        // a port nothing listens on: bound to get a free one, then closed
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        LogseqClient::new(&logseq_mcp_server::config::Config { api_url, auth_token: "t".into(), timeout_ms: Some(2000), tips: None })
    };
    let error = resolve_block_refs(&unreachable, &[root(&format!("(({}))", uuid(2)))]).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}
