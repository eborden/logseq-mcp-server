//! The LogSeq traffic of `logseq_explore_context` against a mock
//! LogSeq on a local port: how many calls each makes, in which order, with which inputs. The call
//! counts are those in CLAUDE.md ("Current Implementation Status"); the parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the recorded results.
//! Every page and block here is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq, uuid};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::explore_context::{Caps, explore_page_context};
use serde_json::{Value, json};

const DATALOG: &str = "logseq.DB.datascriptQuery";
const LINKED_REFERENCES: &str = "logseq.Editor.getPageLinkedReferences";

fn page(id: i64, name: &str, original: &str, extra: Value) -> Value {
    let mut page = json!({"id": id, "uuid": uuid(id), "name": name, "original-name": original, "file": {"id": id + 5000}});
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        page[key] = value;
    }
    page
}

fn flat_block(id: i64, page: i64, content: &str) -> Value {
    json!([{"id": id, "uuid": uuid(id), "content": content, "page": {"id": page}, "parent": {"id": page}, "left": {"id": page}}])
}

fn linking_block(id: i64, page: i64) -> Value {
    json!({"id": id, "uuid": uuid(id), "content": "Mentions [[Project Atlas]]", "page": {"id": page}})
}

fn source(id: i64, name: &str) -> Value {
    json!({"id": id, "name": name.to_lowercase(), "originalName": name})
}

#[tokio::test]
async fn an_exact_name_costs_three_calls_the_resolver_the_blocks_and_the_linked_references() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]),
        json!([flat_block(101, 10, "First")]),
        json!([[source(20, "Bob"), [linking_block(201, 20)]]]),
    ])
    .await;
    let context = explore_page_context(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();

    assert_eq!(methods(&logseq), [DATALOG, DATALOG, LINKED_REFERENCES]);
    // the name is bound as a lowercase EDN string for the resolver and the blocks, and never embedded
    assert_eq!(args_of(&logseq, 0)[1], "\"project atlas\"");
    assert_eq!(args_of(&logseq, 1)[1], "\"project atlas\"");
    assert!(!args_of(&logseq, 1)[0].as_str().unwrap().contains("project atlas"));
    // the Editor call gets the name as typed
    assert_eq!(args_of(&logseq, 2), [json!("Project Atlas")]);
    assert_eq!((context.direct_blocks.len(), context.related_pages.len(), context.references.len()), (1, 1, 1));
    assert!(!context.has_more());
}

#[tokio::test]
async fn a_page_with_aliases_adds_the_alias_query_and_reads_the_group_with_datalog_alone() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]]),
        json!([[10, {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}], [10, {"id": 11, "name": "atlas", "original-name": "Atlas"}]]),
        json!([flat_block(1101, 11, "On the alias"), flat_block(101, 10, "On the page")]),
        json!([]),
    ])
    .await;
    let context = explore_page_context(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();

    // no Editor call for the references: one Datalog query over the group
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, DATALOG, DATALOG]);
    assert!(args_of(&logseq, 2)[0].as_str().unwrap().contains("[(ground [10 11]) [?page ...]]"));
    assert!(args_of(&logseq, 3)[0].as_str().unwrap().contains("[(ground [10 11]) [?p ...]]"));
    // the page asked about comes first
    assert_eq!(context.direct_blocks[0]["id"], 101);
    assert_eq!(context.resolved_aliases.unwrap(), ["Atlas", "Project Atlas"]);
}

#[tokio::test]
async fn resolve_refs_adds_one_query_per_level_and_none_when_no_block_has_a_ref() {
    let with_ref = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]),
        json!([flat_block(101, 10, &format!("See (({}))", uuid(2)))]),
        json!([]),
        json!([[{"id": 2, "uuid": uuid(2), "content": "the target", "left": {"id": 10}, "parent": {"id": 10}, "page": {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}}]]),
    ])
    .await;
    let caps = Caps { resolve_refs: true, ..Caps::default() };
    explore_page_context(&client(&with_ref), "Project Atlas", caps).await.unwrap();
    assert_eq!(methods(&with_ref).len(), 4);

    let without_ref = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]),
        json!([flat_block(101, 10, "Plain")]),
        json!([]),
    ])
    .await;
    explore_page_context(&client(&without_ref), "Project Atlas", caps).await.unwrap();
    assert_eq!(methods(&without_ref).len(), 3);
}

#[tokio::test]
async fn a_missing_page_adds_the_suggestion_lookup_and_fails_with_the_closest_names() {
    let logseq = mock_logseq(vec![json!([]), json!([]), json!([{"originalName": "Project Atlas"}])]).await;
    let error = explore_page_context(&client(&logseq), "Projct Atlas", Caps::default()).await.unwrap_err();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, "logseq.Editor.getAllPages"]);
    assert!(matches!(&error, ToolError::PageNotFound(missing) if missing.suggestions == ["Project Atlas"]), "{error}");
}


// ---- BR-0011, #338: a `null` answer is no answer, not "nothing there"

fn codes(warnings: &[logseq_mcp_server::meta::ResultWarning]) -> Vec<&str> {
    warnings.iter().map(|warning| warning.code.as_str()).collect()
}

#[tokio::test]
async fn a_null_answer_to_the_blocks_is_a_warning_and_a_real_empty_list_is_not() {
    let referencing = || json!([[source(20, "Bob"), [linking_block(201, 20)]]]);
    let logseq = mock_logseq(vec![json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]), Value::Null, referencing()]).await;
    let context = explore_page_context(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();
    assert_eq!(codes(&context.warnings), ["page_blocks_unavailable"]);
    let warning = &context.warnings[0];
    assert!(warning.message.contains("\"Project Atlas\"") && warning.message.contains("may not mean the page has none"), "{}", warning.message);
    // nothing fetches what LogSeq did not answer: no `howToFetchAll`, so `hasMore` stays false
    assert!(warning.how_to_fetch_all.is_none() && !context.has_more());
    // the other parts are still there
    assert_eq!((context.direct_blocks.len(), context.related_pages.len(), context.references.len()), (0, 1, 1));
    assert_eq!(methods(&logseq).len(), 3);

    let empty = mock_logseq(vec![json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]), json!([]), referencing()]).await;
    let context = explore_page_context(&client(&empty), "Project Atlas", Caps::default()).await.unwrap();
    assert!(context.warnings.is_empty());
}

#[tokio::test]
async fn a_null_answer_to_the_linked_references_is_a_warning_and_a_real_empty_list_is_not() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]),
        json!([flat_block(101, 10, "Only")]),
        Value::Null,
    ])
    .await;
    let context = explore_page_context(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();
    assert_eq!(codes(&context.warnings), ["backlinks_unavailable"]);
    let warning = &context.warnings[0];
    assert!(warning.message.contains("\"Project Atlas\"") && warning.message.contains("may not mean nothing links here"), "{}", warning.message);
    assert!(warning.how_to_fetch_all.is_none() && !context.has_more());
    assert_eq!((context.direct_blocks.len(), context.related_pages.len(), context.references.len()), (1, 0, 0));

    let empty = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]),
        json!([flat_block(101, 10, "Only")]),
        json!([]),
    ])
    .await;
    assert!(explore_page_context(&client(&empty), "Project Atlas", Caps::default()).await.unwrap().warnings.is_empty());
}

#[tokio::test]
async fn a_null_answer_to_each_aliased_query_is_the_same_warning() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]]),
        json!([[10, {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}], [10, {"id": 11, "name": "atlas", "original-name": "Atlas"}]]),
        Value::Null,
        Value::Null,
    ])
    .await;
    let context = explore_page_context(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();
    assert_eq!(codes(&context.warnings), ["page_blocks_unavailable", "backlinks_unavailable"]);
    assert!(!context.has_more());
    assert_eq!(methods(&logseq).len(), 4);
}

