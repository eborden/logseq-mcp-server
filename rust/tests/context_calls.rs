//! The LogSeq traffic of `logseq_build_context` and `logseq_get_context_for_query` against a mock
//! LogSeq on a local port: how many calls each makes, in which order, with which inputs. The Rust
//! side of the call counts in CLAUDE.md ("Current Implementation Status"); the parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the TypeScript server.
//! Every page and block here is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq, uuid};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::build_context::{Caps, build_context_for_topic};
use logseq_mcp_server::tools::get_context_for_query::get_context_for_query;
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
    let context = build_context_for_topic(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();

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
    let context = build_context_for_topic(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();

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
    build_context_for_topic(&client(&with_ref), "Project Atlas", caps).await.unwrap();
    assert_eq!(methods(&with_ref).len(), 4);

    let without_ref = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]),
        json!([flat_block(101, 10, "Plain")]),
        json!([]),
    ])
    .await;
    build_context_for_topic(&client(&without_ref), "Project Atlas", caps).await.unwrap();
    assert_eq!(methods(&without_ref).len(), 3);
}

#[tokio::test]
async fn a_missing_page_adds_the_suggestion_lookup_and_fails_with_the_closest_names() {
    let logseq = mock_logseq(vec![json!([]), json!([]), json!([{"originalName": "Project Atlas"}])]).await;
    let error = build_context_for_topic(&client(&logseq), "Projct Atlas", Caps::default()).await.unwrap_err();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, "logseq.Editor.getAllPages"]);
    assert!(matches!(&error, ToolError::PageNotFound(missing) if missing.suggestions == ["Project Atlas"]), "{error}");
}

#[tokio::test]
async fn each_topic_costs_what_build_context_costs_and_a_missing_one_is_a_warning() {
    let logseq = mock_logseq(vec![
        // [[Gone]]: no page, so the resolver, the leaf query and the suggestions
        json!([]),
        json!([]),
        json!([]),
        // #bob
        json!([[page(20, "bob", "Bob", json!({})), "name"]]),
        json!([flat_block(211, 20, "Bob owns it")]),
        json!([]),
    ])
    .await;
    let context = get_context_for_query(&client(&logseq), "about [[Gone]] and #bob", 5, 20, false).await.unwrap();
    assert_eq!(methods(&logseq).len(), 6);
    assert_eq!(context.contexts.len(), 1);
    assert_eq!(context.warnings[0].code, "topic_not_found");
    // the topic's own caps are 10 blocks, 5 related pages and 10 references
    assert_eq!(args_of(&logseq, 4)[1], "\"bob\"");
}

#[tokio::test]
async fn a_query_with_no_topic_is_one_search_and_one_more_for_the_pages_of_the_hits_for_markdown() {
    let hit = |id: i64, content: &str| json!([{"id": id, "uuid": uuid(id), "content": content, "page": {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}}]);
    let hits = || json!([hit(300, "The importer retries rows"), hit(250, "importer alone")]);

    let json_call = mock_logseq(vec![hits()]).await;
    let context = get_context_for_query(&client(&json_call), "what does the importer do with retries", 5, 20, false).await.unwrap();
    assert_eq!(methods(&json_call), [DATALOG]);
    // the longest keyword is searched, as a case-insensitive pattern bound with `:in`
    assert_eq!(args_of(&json_call, 0)[1], "\"(?i)importer\"");
    assert_eq!(context.search_results.unwrap().len(), 1);

    let markdown_call = mock_logseq(vec![hits(), json!([[page(10, "project atlas", "Project Atlas", json!({}))]])]).await;
    get_context_for_query(&client(&markdown_call), "what does the importer do with retries", 5, 20, true).await.unwrap();
    assert_eq!(methods(&markdown_call), [DATALOG, DATALOG]);
    assert!(args_of(&markdown_call, 1)[0].as_str().unwrap().contains("[(ground [10]) [?p ...]]"));

    // no hit kept: no page to look up
    let none = mock_logseq(vec![json!([])]).await;
    get_context_for_query(&client(&none), "what does the importer do with retries", 5, 20, true).await.unwrap();
    assert_eq!(methods(&none).len(), 1);

    // no keyword at all: no call
    let nothing = mock_logseq(vec![]).await;
    let context = get_context_for_query(&client(&nothing), "what is the way of it", 5, 20, true).await.unwrap();
    assert!(methods(&nothing).is_empty() && context.search_results.is_none());
}

// ---- BR-0011, #338: a `null` answer is no answer, not "nothing there"

fn codes(warnings: &[logseq_mcp_server::meta::ResultWarning]) -> Vec<&str> {
    warnings.iter().map(|warning| warning.code.as_str()).collect()
}

#[tokio::test]
async fn a_null_answer_to_the_blocks_is_a_warning_and_a_real_empty_list_is_not() {
    let referencing = || json!([[source(20, "Bob"), [linking_block(201, 20)]]]);
    let logseq = mock_logseq(vec![json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]), Value::Null, referencing()]).await;
    let context = build_context_for_topic(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();
    assert_eq!(codes(&context.warnings), ["page_blocks_unavailable"]);
    let warning = &context.warnings[0];
    assert!(warning.message.contains("\"Project Atlas\"") && warning.message.contains("may not mean the page has none"), "{}", warning.message);
    // nothing fetches what LogSeq did not answer: no `howToFetchAll`, so `hasMore` stays false
    assert!(warning.how_to_fetch_all.is_none() && !context.has_more());
    // the other parts are still there
    assert_eq!((context.direct_blocks.len(), context.related_pages.len(), context.references.len()), (0, 1, 1));
    assert_eq!(methods(&logseq).len(), 3);

    let empty = mock_logseq(vec![json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]), json!([]), referencing()]).await;
    let context = build_context_for_topic(&client(&empty), "Project Atlas", Caps::default()).await.unwrap();
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
    let context = build_context_for_topic(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();
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
    assert!(build_context_for_topic(&client(&empty), "Project Atlas", Caps::default()).await.unwrap().warnings.is_empty());
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
    let context = build_context_for_topic(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();
    assert_eq!(codes(&context.warnings), ["page_blocks_unavailable", "backlinks_unavailable"]);
    assert!(!context.has_more());
    assert_eq!(methods(&logseq).len(), 4);
}

#[tokio::test]
async fn a_null_answer_to_the_keyword_search_is_a_warning_with_an_empty_list_and_a_real_empty_list_is_not() {
    let logseq = mock_logseq(vec![Value::Null]).await;
    let context = get_context_for_query(&client(&logseq), "what does the importer do with retries", 5, 20, true).await.unwrap();
    // no hit kept, so no page lookup
    assert_eq!(methods(&logseq).len(), 1);
    assert_eq!(context.search_results, Some(vec![]));
    assert_eq!(context.warnings.len(), 1);
    let warning = &context.warnings[0];
    assert_eq!(warning.code, "search_unavailable");
    assert!(warning.message.contains("\"importer\", \"retries\"") && warning.message.contains("may not mean nothing matches"), "{}", warning.message);
    assert!(warning.how_to_fetch_all.is_none() && warning.topic.is_none() && !context.has_more());

    let empty = mock_logseq(vec![json!([])]).await;
    let context = get_context_for_query(&client(&empty), "what does the importer do with retries", 5, 20, false).await.unwrap();
    assert_eq!(context.search_results, Some(vec![]));
    assert!(context.warnings.is_empty());
}

#[tokio::test]
async fn a_topic_with_an_unanswered_part_is_rolled_up_into_one_warning_about_the_topic() {
    let logseq = mock_logseq(vec![
        // #bob: the blocks are not answered
        json!([[page(20, "bob", "Bob", json!({})), "name"]]),
        Value::Null,
        json!([]),
        // #carol: answered
        json!([[page(30, "carol", "Carol", json!({})), "name"]]),
        json!([flat_block(311, 30, "Carol owns it")]),
        json!([]),
    ])
    .await;
    let context = get_context_for_query(&client(&logseq), "about #bob and #carol", 5, 20, false).await.unwrap();
    assert_eq!(context.contexts.len(), 2);
    // the topic's own warning is not repeated; the roll-up names the topic and the code, and fetches nothing
    assert_eq!(context.warnings.len(), 1);
    let warning = &context.warnings[0];
    assert_eq!((warning.code.as_str(), warning.topic.as_deref()), ("topic_unavailable", Some("bob")));
    assert!(warning.message.contains("\"bob\"") && warning.message.contains("page_blocks_unavailable"), "{}", warning.message);
    assert!(warning.how_to_fetch_all.is_none() && !context.has_more());
    assert_eq!(codes(&context.contexts[0].warnings), ["page_blocks_unavailable"]);
}

#[tokio::test]
async fn a_cut_topic_keeps_its_truncation_warning_beside_the_roll_up() {
    let rows: Vec<Value> = (0..12).map(|n| flat_block(500 + n, 20, "A block")).collect();
    let logseq = mock_logseq(vec![json!([[page(20, "bob", "Bob", json!({})), "name"]]), json!(rows), Value::Null]).await;
    let context = get_context_for_query(&client(&logseq), "about #bob", 5, 20, false).await.unwrap();
    assert_eq!(context.warnings.iter().map(|w| w.code.as_str()).collect::<Vec<_>>(), ["topic_truncated", "topic_unavailable"]);
    // only the cut has a remedy, so `hasMore` is the cut's
    assert!(context.has_more());
    assert!(context.warnings[1].how_to_fetch_all.is_none());
}

#[tokio::test]
async fn a_null_answer_from_the_resolver_fails_the_query_for_any_topic() {
    let logseq = mock_logseq(vec![
        json!([[page(20, "bob", "Bob", json!({})), "name"]]),
        json!([flat_block(211, 20, "Bob owns it")]),
        json!([]),
        // the second topic: the resolver is not answered
        Value::Null,
    ])
    .await;
    let error = get_context_for_query(&client(&logseq), "about #bob and #carol", 5, 20, false).await.unwrap_err();
    assert!(matches!(error, ToolError::Failed(_)), "{error}");
    assert!(error.to_string().starts_with("LogSeq returned no answer when looking up the page \"carol\""), "{error}");
    // it stops there: no leaf query, no suggestion lookup
    assert_eq!(methods(&logseq).len(), 4);
}
