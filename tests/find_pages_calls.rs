//! The LogSeq traffic and the answers of `logseq_find_pages` against a mock LogSeq on a local port: the one call it
//! makes whatever the filter (#490), what `names` and `property` with `value` find, what they refuse before any call,
//! and how a `null` or failed page list reaches the caller. The call counts are those in `CLAUDE.md` ("Current
//! Implementation Status"); the parity harness (`parity.rs`) checks the same calls and the result bytes against the
//! recorded results. Every page, name and property here is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::snapshots::Snapshots;
use logseq_mcp_server::tools::find_pages;
use rmcp::model::{CallToolResult, JsonObject};
use serde_json::{Value, json};

/// What `logseq.Editor.getAllPages` answers for a small made-up graph: two people, a project that declares an alias, two
/// projects that declare the same one, a page nothing wrote, and a journal.
fn graph() -> Value {
    json!([
        {"id": 1, "name": "alice", "originalName": "Alice", "journal?": false, "file": {"id": 5001}, "properties": {"role": "designer", "createdBy": ["Bob"]}},
        {"id": 2, "name": "bob", "originalName": "Bob", "journal?": false, "file": {"id": 5002}, "properties": {"role": "engineer", "reviewers": ["Alice", "Carol"]}},
        {"id": 3, "name": "project atlas", "originalName": "Project Atlas", "journal?": false, "file": {"id": 5003}, "alias": [{"id": 4}],
         "properties": {"alias": ["atlas"], "status": "active", "effort": 3, "reviewed": true, "owner": ["Alice"], "dueDate": ["Jan 15th, 2025"]}},
        {"id": 4, "name": "atlas", "originalName": "Atlas", "journal?": false, "alias": [{"id": 3}]},
        {"id": 5, "name": "project borealis", "originalName": "Project Borealis", "journal?": false, "file": {"id": 5005}, "alias": [{"id": 7}],
         "properties": {"alias": ["roadmap"], "status": "planning"}},
        {"id": 6, "name": "project cascade", "originalName": "Project Cascade", "journal?": false, "file": {"id": 5006}, "alias": [{"id": 7}],
         "properties": {"alias": ["roadmap"], "status": "active"}},
        {"id": 7, "name": "roadmap", "originalName": "roadmap", "journal?": false, "alias": [{"id": 5}, {"id": 6}]},
        {"id": 8, "name": "carol", "originalName": "Carol", "journal?": false},
        {"id": 9, "name": "jan 1st, 2025", "originalName": "Jan 1st, 2025", "journal?": true, "file": {"id": 5009}}
    ])
}

fn arguments(value: Value) -> Option<JsonObject> {
    value.as_object().cloned()
}

fn text_of(result: &CallToolResult, block: usize) -> String {
    serde_json::to_value(result).unwrap()["content"][block]["text"].as_str().unwrap().to_owned()
}

/// The first content block as JSON.
fn body(result: &CallToolResult) -> Value {
    serde_json::from_str(&text_of(result, 0)).unwrap()
}

/// The names of the pages a result lists.
fn listed(body: &Value) -> Vec<&str> {
    body["pages"].as_array().unwrap().iter().map(|page| page["name"].as_str().unwrap()).collect()
}

async fn find(args: Value) -> (CallToolResult, Vec<String>) {
    let logseq = mock_logseq(vec![graph()]).await;
    let result = find_pages::call(&client(&logseq), true, &Snapshots::new(1), arguments(args)).await.unwrap();
    let calls = methods(&logseq);
    assert_eq!(args_of(&logseq, 0), Vec::<Value>::new());
    (result, calls)
}

const ONE_CALL: [&str; 1] = ["logseq.Editor.getAllPages"];

#[tokio::test]
async fn fifty_names_cost_the_one_call_a_single_name_does() {
    let (one, calls) = find(json!({"names": ["alice"]})).await;
    assert_eq!(calls, ONE_CALL);
    assert_eq!(listed(&body(&one)), ["Alice"]);

    // fifty names, three of them found and the rest missing, with closest names for each miss: still one call
    let mut names: Vec<String> = (1..=47).map(|n| format!("Nobody {n}")).collect();
    names.extend(["bob".to_owned(), "Atlas".to_owned(), "CAROL".to_owned()]);
    assert_eq!(names.len(), 50);
    let (fifty, calls) = find(json!({"names": names})).await;
    assert_eq!(calls, ONE_CALL);
    let body = body(&fifty);
    assert_eq!(body["names"].as_array().unwrap().len(), 50);
    assert_eq!(listed(&body), ["Bob", "Carol", "Project Atlas"]);
    assert_eq!(body["total"], 3);
}

#[tokio::test]
async fn each_name_is_answered_with_its_page_or_null_and_the_closest_names_in_the_order_it_was_sent() {
    let (result, calls) = find(json!({"names": ["Atlas", "alice", "  BOB ", "Dave", "roadmap", "Proj Atlas"]})).await;
    assert_eq!(calls, ONE_CALL);
    assert_eq!(
        text_of(&result, 0),
        json!({
            "names": [
                {"name": "Atlas", "page": "Project Atlas"},
                {"name": "alice", "page": "Alice"},
                {"name": "  BOB ", "page": "Bob"},
                {"name": "Dave", "page": null},
                {"name": "roadmap", "page": null, "candidates": ["Project Borealis", "Project Cascade"]},
                {"name": "Proj Atlas", "page": null, "suggestions": ["Project Atlas"]}
            ],
            "total": 5,
            "pages": [
                {"name": "Alice"},
                {"name": "Bob"},
                {"name": "Project Atlas", "aliases": ["Atlas"]},
                {"name": "Project Borealis", "aliases": ["roadmap"]},
                {"name": "Project Cascade", "aliases": ["roadmap"]}
            ]
        })
        .to_string()
    );
}

#[tokio::test]
async fn a_journal_is_no_page_of_this_tool_and_a_name_for_one_has_none() {
    let (result, _) = find(json!({"names": ["Jan 1st, 2025"]})).await;
    let body = body(&result);
    assert_eq!(body["names"][0]["page"], Value::Null);
    assert_eq!(body["total"], 0);
    assert_eq!(body["pages"], json!([]));
}

#[tokio::test]
async fn the_filters_narrow_the_one_list_together() {
    // text and names: the pages both keep
    let (result, calls) = find(json!({"text": "project", "names": ["alice", "Atlas", "roadmap"]})).await;
    assert_eq!(calls, ONE_CALL);
    assert_eq!(listed(&body(&result)), ["Project Atlas", "Project Borealis", "Project Cascade"]);

    // names and a property: the pages that have the property among the pages the names found. A name whose page the
    // property drops is still answered with that page
    let (result, calls) = find(json!({"names": ["Atlas", "roadmap", "alice"], "property": "status", "value": "active"})).await;
    assert_eq!(calls, ONE_CALL);
    let body = body(&result);
    assert_eq!(listed(&body), ["Project Atlas", "Project Cascade"]);
    assert_eq!(body["names"][2], json!({"name": "alice", "page": "Alice"}));

    // text, names and a property
    let (result, _) = find(json!({"text": "cascade", "names": ["roadmap"], "property": "status", "value": "active"})).await;
    assert_eq!(listed(&self::body(&result)), ["Project Cascade"]);
    let (result, _) = find(json!({"text": "borealis", "names": ["roadmap"], "property": "status", "value": "active"})).await;
    assert_eq!(listed(&self::body(&result)), Vec::<&str>::new());
}

#[tokio::test]
async fn a_page_property_matches_as_the_property_query_matches_a_block_one() {
    let found = |args: Value| async move {
        let (result, calls) = find(args).await;
        assert_eq!(calls, ONE_CALL);
        listed(&body(&result)).into_iter().map(str::to_owned).collect::<Vec<String>>()
    };
    // a key as LogSeq stores it, and as the Editor API spells it
    assert_eq!(found(json!({"property": "status", "value": "active"})).await, ["Project Atlas", "Project Cascade"]);
    assert_eq!(found(json!({"property": "created-by", "value": "Bob"})).await, ["Alice"]);
    assert_eq!(found(json!({"property": "createdBy", "value": "Bob"})).await, ["Alice"]);
    assert_eq!(found(json!({"property": "CREATED_BY", "value": "Bob"})).await, ["Alice"]);
    assert_eq!(found(json!({"property": "due-date", "value": "Jan 15th, 2025"})).await, ["Project Atlas"]);
    // a value is an exact string: a number or a boolean as the text JavaScript writes it
    assert_eq!(found(json!({"property": "effort", "value": 3})).await, ["Project Atlas"]);
    assert_eq!(found(json!({"property": "effort", "value": "3"})).await, ["Project Atlas"]);
    assert_eq!(found(json!({"property": "reviewed", "value": true})).await, ["Project Atlas"]);
    assert_eq!(found(json!({"property": "reviewed", "value": false})).await, Vec::<String>::new());
    // a multi-value property matches on any one value, and a value is not matched by a part of it
    assert_eq!(found(json!({"property": "reviewers", "value": "Carol"})).await, ["Bob"]);
    assert_eq!(found(json!({"property": "reviewers", "value": "Alice"})).await, ["Bob"]);
    assert_eq!(found(json!({"property": "reviewers", "value": "Alice, Carol"})).await, Vec::<String>::new());
    assert_eq!(found(json!({"property": "status", "value": "act"})).await, Vec::<String>::new());
    assert_eq!(found(json!({"property": "status", "value": "Active"})).await, Vec::<String>::new());
    // a page that is a stub, or has no such property, is not found
    assert_eq!(found(json!({"property": "role", "value": "designer"})).await, ["Alice"]);
    assert_eq!(found(json!({"property": "nothing", "value": "x"})).await, Vec::<String>::new());
}

#[tokio::test]
async fn a_result_with_no_match_says_so_with_names_answered_and_no_warning() {
    let (result, _) = find(json!({"property": "nothing", "value": "x"})).await;
    assert_eq!(text_of(&result, 0), r#"{"total":0,"pages":[]}"#);
    assert_eq!(serde_json::to_value(&result).unwrap()["content"].as_array().unwrap().len(), 1, "no tip: there is no first match to open");
}

#[tokio::test]
async fn a_narrowed_list_suggests_opening_its_first_page() {
    let (result, _) = find(json!({"names": ["bob"]})).await;
    assert_eq!(
        text_of(&result, 1),
        r#"{"meta":{"tips":["To open the first match: logseq_get_page {\"page\":\"Bob\",\"detail\":\"full\"}."]}}"#
    );
    let (result, _) = find(json!({"names": ["nobody at all"]})).await;
    assert_eq!(serde_json::to_value(&result).unwrap()["content"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn names_are_written_as_toon_when_asked() {
    let (result, _) = find(json!({"names": ["bob", "Dave"], "format": "toon"})).await;
    let text = text_of(&result, 0);
    assert!(text.starts_with("names["), "{text}");
    assert!(text.contains("Dave"), "{text}");
}

#[tokio::test]
async fn what_cannot_be_read_is_refused_before_any_call() {
    for (args, message) in [
        (json!({"property": "status"}), "Invalid parameter 'value': missing\n\nExpected: the value to match (property and value go together)\nExample: value: \"active\""),
        (json!({"value": "active"}), "Invalid parameter 'property': missing\n\nExpected: the property to match value against (property and value go together)\nExample: property: \"status\""),
        (json!({"property": "a b", "value": "x"}), "Invalid parameter 'property': a b\n\nExpected: a property name made of letters, digits, \"-\" and \"_\", starting with a letter or digit\nExample: status"),
        (json!({"names": []}), "Invalid parameter 'names': []\n\nExpected: at least 1 item\nExample: names: [\"...\"]"),
        (json!({"names": "Alice"}), "Invalid parameter 'names': \"Alice\"\n\nExpected: a list of strings, not a string\nExample: names: [\"...\"]"),
        (json!({"names": ["Alice", 4]}), "Invalid parameter 'names': [\"Alice\",4]\n\nExpected: a list of strings, and every element is a string\nExample: names: [\"...\"]"),
        (json!({"value": ["x"], "property": "status"}), "Invalid parameter 'value': [\"x\"]\n\nExpected: a string, a number or a boolean, not an array\nExample: value: \"...\""),
    ] {
        let logseq = mock_logseq(vec![]).await;
        let error = find_pages::call(&client(&logseq), true, &Snapshots::new(1), arguments(args.clone())).await.unwrap_err();
        assert!(matches!(error, ToolError::InvalidParameter(_)), "{args}: {error}");
        assert_eq!(error.to_string(), message, "{args}");
        assert!(methods(&logseq).is_empty(), "{args}");
    }
}

#[tokio::test]
async fn fifty_one_names_are_refused_and_never_cut() {
    let logseq = mock_logseq(vec![]).await;
    let names: Vec<String> = (1..=51).map(|n| format!("Page {n}")).collect();
    let error = find_pages::call(&client(&logseq), true, &Snapshots::new(1), arguments(json!({"names": names}))).await.unwrap_err();
    assert!(error.to_string().starts_with("Invalid parameter 'names': [\"Page 1\""), "{error}");
    assert!(error.to_string().ends_with("\n\nExpected: at most 50 items\nExample: names: [\"...\"]"), "{error}");
    assert!(methods(&logseq).is_empty());
}

#[tokio::test]
async fn a_null_page_list_answers_no_name_and_says_it_is_unavailable() {
    let logseq = mock_logseq(vec![json!(null)]).await;
    let result = find_pages::call(&client(&logseq), true, &Snapshots::new(1), arguments(json!({"names": ["alice"], "property": "status", "value": "x"}))).await.unwrap();
    let body = body(&result);
    // no page list is no answer to a name: nothing says a page is missing
    assert!(body.get("names").is_none(), "{body}");
    assert_eq!(body["pages"], json!([]));
    assert_eq!(body["warnings"][0]["code"], "pages_unavailable");
    assert_eq!(body["hasMore"], false);
}

#[tokio::test]
async fn an_infrastructure_error_reaches_the_caller_and_is_no_empty_answer() {
    let logseq = mock_logseq(vec![]).await;
    let error = find_pages::call(&client(&logseq), true, &Snapshots::new(1), arguments(json!({"names": ["alice"]}))).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn a_page_list_that_is_not_a_list_is_an_error_naming_where() {
    let logseq = mock_logseq(vec![json!({"pages": []})]).await;
    let error = find_pages::call(&client(&logseq), true, &Snapshots::new(1), arguments(json!({"names": ["alice"]}))).await.unwrap_err();
    assert!(error.to_string().contains("answer: expected a list, got an object"), "{error}");
    let logseq = mock_logseq(vec![json!([{"id": 1, "name": "a", "properties": 5}])]).await;
    let error = find_pages::call(&client(&logseq), true, &Snapshots::new(1), arguments(json!({"property": "a", "value": "b"}))).await.unwrap_err();
    assert!(error.to_string().contains("answer[0].properties: expected an object, got a number"), "{error}");
}

#[tokio::test]
async fn the_v1_name_contains_is_ignored_like_every_unknown_argument() {
    let (result, calls) = find(json!({"name_contains": "atlas"})).await;
    assert_eq!(calls, ONE_CALL);
    assert_eq!(
        listed(&body(&result)),
        ["Alice", "Bob", "Carol", "Project Atlas", "Project Borealis", "Project Cascade"],
        "every non-journal page that is not an alias stub: no filter was read"
    );
}

#[tokio::test]
async fn limit_cuts_the_pages_leaves_every_name_answered_and_reads_on_with_a_cursor() {
    let (result, _) = find(json!({"names": ["alice", "bob", "carol", "Dave"], "limit": 1})).await;
    let body = body(&result);
    assert_eq!(listed(&body), ["Alice"]);
    assert_eq!(body["total"], 3);
    assert_eq!(body["names"].as_array().unwrap().len(), 4, "the names are not paged");
    assert_eq!(body["warnings"][0]["code"], "pages_truncated");
    assert_eq!(body["hasMore"], true);
    assert!(body["nextCursor"].is_string());
}

#[tokio::test]
async fn the_v1_offset_is_ignored_like_every_unknown_argument() {
    // `offset` went with the cursor (ADR-0038)
    let (result, calls) = find(json!({"offset": 2, "limit": 2})).await;
    assert_eq!(calls, ONE_CALL);
    assert_eq!(listed(&body(&result)), ["Alice", "Bob"]);
}
