//! The LogSeq traffic of `logseq_explore_context` against a mock
//! LogSeq on a local port: how many calls each makes, in which order, with which inputs. The call
//! counts are those in CLAUDE.md ("Current Implementation Status"); the parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the recorded results.
//! Every page and block here is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq, uuid};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::explore_context::{Caps, TopicContext, explore_page_context};
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

// ---- the references: most-linking pages first, and cut by their page size

/// The linked references of a page, as the Editor call sends them: bob links once, alice three times, carol twice.
fn three_sources() -> Value {
    json!([
        [source(20, "Bob"), [linking_block(201, 20)]],
        [source(40, "Alice"), [linking_block(401, 40), linking_block(402, 40), linking_block(403, 40)]],
        [source(30, "Carol"), [linking_block(301, 30), linking_block(302, 30)]],
    ])
}

fn reference_ids(context: &TopicContext) -> Vec<i64> {
    context.references.iter().map(|reference| reference.block["id"].as_i64().unwrap()).collect()
}

async fn explored(caps: Caps) -> (TopicContext, usize) {
    let logseq = mock_logseq(vec![json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]), json!([]), three_sources()]).await;
    let context = explore_page_context(&client(&logseq), "Project Atlas", caps).await.unwrap();
    (context, methods(&logseq).len())
}

#[tokio::test]
async fn the_references_are_ranked_by_linking_blocks_and_the_related_pages_keep_logseqs_order_at_no_extra_call() {
    let (context, calls) = explored(Caps::default()).await;
    // the same 3 calls as before the ranking
    assert_eq!(calls, 3);
    // alice (3 blocks), carol (2), bob (1), the blocks of one page together
    assert_eq!(reference_ids(&context), [401, 402, 403, 301, 302, 201]);
    // the related pages are as they were: the order the references were sent in
    assert_eq!(context.related_pages.iter().map(|page| page["originalName"].as_str().unwrap()).collect::<Vec<_>>(), ["Bob", "Alice", "Carol"]);
    assert_eq!(context.totals.references, 6);
    assert!(context.warnings.is_empty());
}

#[tokio::test]
async fn a_page_size_that_cuts_the_references_offers_the_raise_and_no_cursor_without_a_snapshot_to_read_from() {
    let (first, calls) = explored(Caps { max_references: 2, ..Caps::default() }).await;
    assert_eq!(calls, 3, "a page size costs no call");
    assert_eq!(reference_ids(&first), [401, 402]);
    let warning = &first.warnings[0];
    assert_eq!(warning.code, "references_truncated");
    assert_eq!(warning.message, "Showing 1-2 of 6 references.");
    // the library function keeps no snapshot, so the one way on is the raise; `call` leads with the cursor
    assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_references to 6 (or higher) to get all 6 in one call."));
    assert_eq!((first.next_cursor, first.totals.references), (None, 6));
    // a page size at the number there are is no cut
    let (whole, _) = explored(Caps { max_references: 6, ..Caps::default() }).await;
    assert!(whole.warnings.is_empty());
}

#[tokio::test]
async fn a_cap_of_zero_leaves_the_references_out_and_offers_the_raise() {
    let (context, _) = explored(Caps { max_references: 0, ..Caps::default() }).await;
    assert!(context.references.is_empty());
    let warning = &context.warnings[0];
    assert_eq!(warning.message, "Showing 0 of 6 references.");
    assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set max_references to 6 (or higher) to get all 6 in one call."));
}

#[tokio::test]
async fn the_aliased_path_ranks_the_group_the_same_way_in_the_same_calls() {
    let aliased = |id: i64, page: i64, name: &str| json!([{"id": id, "uuid": uuid(id), "content": "links", "page": {"id": page, "name": name.to_lowercase(), "original-name": name}}]);
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]]),
        json!([[10, {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}], [10, {"id": 11, "name": "atlas", "original-name": "Atlas"}]]),
        json!([]),
        // by name the pages are Alice then Bob, and Bob links twice
        json!([aliased(401, 40, "Alice"), aliased(202, 20, "Bob"), aliased(201, 20, "Bob")]),
    ])
    .await;
    let context = explore_page_context(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, DATALOG, DATALOG]);
    // Bob first (2 blocks, in id order), then Alice; the related pages stay in the group's own order, by name
    assert_eq!(reference_ids(&context), [201, 202, 401]);
    assert_eq!(context.related_pages.iter().map(|page| page["originalName"].as_str().unwrap()).collect::<Vec<_>>(), ["Alice", "Bob"]);
}

// ---- what the linked references of get_backlinks pinned, now the references of explore_context

#[tokio::test]
async fn an_alias_name_hands_the_resolved_pages_lowercase_name_on_and_says_where_it_came_from() {
    let logseq = mock_logseq(vec![json!([[page(10, "project atlas", "Project Atlas", json!({})), "alias"]]), json!([]), json!([])]).await;
    let context = explore_page_context(&client(&logseq), "Atlas", Caps::default()).await.unwrap();
    // the Editor call gets the name of the page the alias stood for, in its own case
    assert_eq!(args_of(&logseq, 2), [json!("project atlas")]);
    assert_eq!(context.resolved_from.unwrap(), json!({"name": "Atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"}));
}

#[tokio::test]
async fn an_alias_link_with_no_other_page_in_the_group_still_uses_the_editor_call() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]]),
        json!([[10, {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}]]),
        json!([]),
        json!([]),
    ])
    .await;
    let context = explore_page_context(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, DATALOG, LINKED_REFERENCES]);
    assert!(context.resolved_aliases.is_none() && context.warnings.is_empty());
}

#[tokio::test]
async fn a_null_answer_to_the_alias_lookup_warns_and_the_editor_call_reads_the_page_alone() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]]),
        Value::Null,
        json!([]),
        json!([]),
    ])
    .await;
    let context = explore_page_context(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, DATALOG, LINKED_REFERENCES]);
    assert_eq!(codes(&context.warnings), ["alias_lookup_unavailable"]);
    assert!(!context.has_more());
}

#[tokio::test]
async fn an_error_from_logseq_is_an_error_and_not_an_empty_context() {
    // from the blocks, from the linked references, and from the aliased query
    for (answers, calls) in [
        (vec![json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]), json!({"error": "Query timed out"})], 2),
        (vec![json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]), json!([]), json!({"error": "Query timed out"})], 3),
        (
            vec![
                json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]]),
                json!([[10, {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}], [10, {"id": 11, "name": "atlas", "original-name": "Atlas"}]]),
                json!([]),
                json!({"error": "Query timed out"}),
            ],
            4,
        ),
    ] {
        let logseq = mock_logseq(answers).await;
        let error = explore_page_context(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap_err();
        assert_eq!(error.to_string(), "LogSeq API error: Query timed out");
        assert_eq!(methods(&logseq).len(), calls);
    }
}

#[tokio::test]
async fn linked_references_in_a_shape_the_server_cannot_read_are_a_response_error() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]]),
        json!([]),
        json!([[null, [{"uuid": "u"}]]]),
    ])
    .await;
    let error = explore_page_context(&client(&logseq), "Project Atlas", Caps::default()).await.unwrap_err();
    assert!(matches!(error, ToolError::Response(_)), "{error}");
    assert!(error.to_string().contains("logseq.Editor.getPageLinkedReferences in a shape this server can't read: answer[0][1][0].id"), "{error}");
}

#[tokio::test]
async fn an_ambiguous_name_stops_after_the_resolver() {
    let logseq = mock_logseq(vec![json!([
        [page(40, "alice", "Alice", json!({})), "alias"],
        [page(41, "alice notes", "Alice Notes", json!({})), "alias"]
    ])])
    .await;
    assert!(matches!(explore_page_context(&client(&logseq), "al", Caps::default()).await.unwrap_err(), ToolError::AmbiguousPage(_)));
    assert_eq!(methods(&logseq).len(), 1);
}
