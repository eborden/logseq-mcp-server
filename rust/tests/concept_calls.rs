//! The LogSeq traffic of `logseq_get_concept_network` and `logseq_get_concept_evolution` against a mock
//! LogSeq on a local port: how many calls each makes, in which order, with which inputs. The Rust side
//! of the call counts in CLAUDE.md ("Current Implementation Status"); the parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the TypeScript server.
//! Every page and block here is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq, uuid};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::get_concept_evolution::{GroupBy, Options as EvolutionOptions, get_concept_evolution};
use logseq_mcp_server::tools::get_concept_network::{Options, get_concept_network};
use serde_json::{Value, json};

const DATALOG: &str = "logseq.DB.datascriptQuery";
const TREE: &str = "logseq.Editor.getPageBlocksTree";
const GET_PAGE: &str = "logseq.Editor.getPage";

fn page(id: i64, name: &str, original: &str, extra: Value) -> Value {
    let mut page = json!({"id": id, "uuid": uuid(id), "name": name, "original-name": original, "file": {"id": id + 5000}});
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        page[key] = value;
    }
    page
}

/// A connected-pages row: `[source, connected, name, originalName, isJournal, relType, count]`.
fn row(source: i64, connected: i64, name: &str, journal: bool, rel: &str, count: i64) -> Value {
    json!([source, connected, name.to_lowercase(), name, journal, rel, count])
}

fn root() -> Value {
    json!([[page(10, "project atlas", "Project Atlas", json!({})), "name"]])
}

fn depth(max_depth: u64) -> (u64, Options) {
    (max_depth, Options::default())
}

#[tokio::test]
async fn an_exact_name_costs_the_resolver_and_one_query_per_depth() {
    let logseq = mock_logseq(vec![
        root(),
        json!([row(10, 20, "Bob", false, "outbound", 2), row(10, 21, "Carol", false, "inbound", 1)]),
        json!([row(20, 22, "Dave", false, "outbound", 1)]),
    ])
    .await;
    let (max_depth, options) = depth(2);
    let network = get_concept_network(&client(&logseq), "Project Atlas", max_depth, options).await.unwrap();

    assert_eq!(methods(&logseq), [DATALOG, DATALOG, DATALOG]);
    // the name is bound as a lowercase EDN string for the resolver and never embedded
    assert_eq!(args_of(&logseq, 0)[1], "\"project atlas\"");
    // each depth's query covers the whole frontier, the ids embedded and nothing bound
    let first = args_of(&logseq, 1);
    assert_eq!(first.len(), 1);
    assert!(first[0].as_str().unwrap().contains("[(ground [10]) [?source ...]]"));
    // Bob and Carol were both admitted at depth 1, so the second query covers both, in rank order
    let second = args_of(&logseq, 2);
    assert!(second[0].as_str().unwrap().contains("[(ground [20 21]) [?source ...]]"), "{}", second[0]);
    assert_eq!(network.nodes.len(), 4);
    assert!(!network.truncated && network.warnings.is_empty());
}

#[tokio::test]
async fn a_depth_that_admits_nothing_to_expand_ends_the_walk() {
    // only a journal at depth 1, and a journal is a leaf: no second query although max_depth is 2
    let logseq = mock_logseq(vec![root(), json!([row(10, 30, "Jan 1st, 2025", true, "outbound", 2)])]).await;
    let (max_depth, options) = depth(2);
    let network = get_concept_network(&client(&logseq), "Project Atlas", max_depth, options).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
    assert_eq!(network.nodes.len(), 2);

    // with expand_journals it is walked through
    let walked = mock_logseq(vec![root(), json!([row(10, 30, "Jan 1st, 2025", true, "outbound", 2)]), json!([])]).await;
    get_concept_network(&client(&walked), "Project Atlas", 2, Options { expand_journals: true, ..Options::default() }).await.unwrap();
    assert_eq!(methods(&walked).len(), 3);
    assert!(args_of(&walked, 2)[0].as_str().unwrap().contains("[(ground [30]) [?source ...]]"));
}

#[tokio::test]
async fn a_depth_past_the_limit_is_the_callers_to_clamp_and_zero_asks_nothing_of_the_graph() {
    // the handler passes at most 3; the walk itself does exactly the depth it is given
    let zero = mock_logseq(vec![json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]])]).await;
    let network = get_concept_network(&client(&zero), "Project Atlas", 0, Options::default()).await.unwrap();
    // not even the alias lookup of a page that has alias links
    assert_eq!(methods(&zero), [DATALOG]);
    assert_eq!(network.nodes.len(), 1);
    assert!(network.resolved_aliases.is_none());
}

#[tokio::test]
async fn a_page_with_aliases_adds_the_alias_query_and_expands_every_name_in_one_query_at_depth_one() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]]),
        json!([[10, {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}], [10, {"id": 11, "name": "atlas", "original-name": "Atlas"}]]),
        // a link to the stub is a link inside the group: dropped
        json!([row(10, 20, "Bob", false, "outbound", 2), row(10, 11, "Atlas", false, "outbound", 1)]),
        json!([row(20, 11, "Atlas", false, "outbound", 3)]),
    ])
    .await;
    let network = get_concept_network(&client(&logseq), "Project Atlas", 2, Options::default()).await.unwrap();

    assert_eq!(methods(&logseq).len(), 4);
    let grouped = args_of(&logseq, 2)[0].as_str().unwrap().to_owned();
    assert!(grouped.contains("[(ground [[10 10] [11 10]]) [[?source ?group] ...]]"), "{grouped}");
    assert!(grouped.contains("(count-distinct ?block)"));
    // depth 2 goes back to the plain query, over the pages admitted
    assert!(args_of(&logseq, 3)[0].as_str().unwrap().contains("[(ground [20]) [?source ...]]"));
    assert_eq!(network.resolved_aliases.as_deref(), Some(&["Atlas".to_owned(), "Project Atlas".to_owned()][..]));
    assert_eq!(network.nodes.len(), 2);
    assert_eq!(network.edges.len(), 1);
}

#[tokio::test]
async fn a_missing_page_adds_the_suggestion_lookup_and_fails_with_the_closest_names() {
    let logseq = mock_logseq(vec![json!([]), json!([]), json!([{"originalName": "Project Atlas"}])]).await;
    let error = get_concept_network(&client(&logseq), "Projct Atlas", 2, Options::default()).await.unwrap_err();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, "logseq.Editor.getAllPages"]);
    assert!(matches!(&error, ToolError::PageNotFound(missing) if missing.suggestions == ["Project Atlas"]), "{error}");
}

#[tokio::test]
async fn a_null_answer_is_read_as_no_connected_pages_and_an_infrastructure_error_propagates() {
    let null = mock_logseq(vec![root(), json!(null)]).await;
    let network = get_concept_network(&client(&null), "Project Atlas", 2, Options::default()).await.unwrap();
    assert_eq!(network.nodes.len(), 1);

    let failing = mock_logseq(vec![root(), json!({"error": "Query timed out"})]).await;
    let error = get_concept_network(&client(&failing), "Project Atlas", 2, Options::default()).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

// ---- the concept's timeline

fn tree_block(id: i64) -> Value {
    json!({"id": id, "uuid": uuid(id), "content": "On the page", "page": {"id": 10}})
}

fn mention(id: i64, page_id: i64, day: i64) -> Value {
    json!([{"id": id, "uuid": uuid(id), "content": "Mentions [[Project Atlas]]", "page": {"id": page_id, "name": format!("day {day}"), "journal-day": day}}])
}

fn editor_page() -> Value {
    json!({"id": 10, "name": "project atlas", "originalName": "Project Atlas"})
}

#[tokio::test]
async fn an_exact_name_costs_four_calls_the_resolver_the_tree_the_page_and_the_mentions() {
    let logseq = mock_logseq(vec![root(), json!([tree_block(101)]), editor_page(), json!([mention(201, 31, 20250310), mention(202, 30, 20250101)])]).await;
    let evolution = get_concept_evolution(&client(&logseq), "  Project Atlas ", EvolutionOptions::default()).await.unwrap();

    assert_eq!(methods(&logseq), [DATALOG, TREE, GET_PAGE, DATALOG]);
    assert_eq!(args_of(&logseq, 0)[1], "\"project atlas\"");
    // the Editor calls get the name as typed, trimmed; the query gets it lowercased, bound
    assert_eq!(args_of(&logseq, 1), [json!("Project Atlas")]);
    assert_eq!(args_of(&logseq, 2), [json!("Project Atlas")]);
    assert_eq!(args_of(&logseq, 3)[1], "\"project atlas\"");
    assert!(!args_of(&logseq, 3)[0].as_str().unwrap().contains("atlas"));
    // oldest first, the page's own undated block last
    let dates: Vec<Option<f64>> = evolution.timeline.iter().map(|(date, _)| *date).collect();
    assert_eq!(dates, [Some(20250101.0), Some(20250310.0), None]);
    // the tree's block carries the page the Editor API gave
    assert_eq!(evolution.timeline[2].1[0]["page"], editor_page());
}

#[tokio::test]
async fn a_page_with_aliases_adds_the_alias_query_and_reads_the_group_with_one_mentions_query() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]]),
        json!([[10, {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}], [10, {"id": 11, "name": "atlas", "original-name": "Atlas"}]]),
        json!([]),
        editor_page(),
        json!([]),
    ])
    .await;
    let evolution = get_concept_evolution(&client(&logseq), "Project Atlas", EvolutionOptions::default()).await.unwrap();

    assert_eq!(methods(&logseq), [DATALOG, DATALOG, TREE, GET_PAGE, DATALOG]);
    let query = args_of(&logseq, 4)[0].as_str().unwrap().to_owned();
    // references to either name, and the blocks of the pages that are not the one asked about
    assert!(query.contains("(and [(ground [10 11]) [?ref ...]] [?block :block/refs ?ref])"), "{query}");
    assert!(query.contains("(and [(ground [11]) [?own ...]] [?block :block/page ?own])"), "{query}");
    assert_eq!(evolution.resolved_aliases.unwrap(), ["Atlas", "Project Atlas"]);
}

#[tokio::test]
async fn a_null_answer_is_read_as_nothing_found_and_a_missing_page_or_an_error_is_not() {
    let nulls = mock_logseq(vec![root(), json!(null), json!(null), json!(null)]).await;
    let evolution = get_concept_evolution(&client(&nulls), "Project Atlas", EvolutionOptions::default()).await.unwrap();
    assert!(evolution.timeline.is_empty());

    let missing = mock_logseq(vec![json!([]), json!([]), json!([])]).await;
    let error = get_concept_evolution(&client(&missing), "Projct Atlas", EvolutionOptions::default()).await.unwrap_err();
    assert!(matches!(error, ToolError::PageNotFound(_)), "{error}");
    assert_eq!(methods(&missing).len(), 3);

    let failing = mock_logseq(vec![root(), json!([]), json!({"error": "Query timed out"})]).await;
    let error = get_concept_evolution(&client(&failing), "Project Atlas", EvolutionOptions::default()).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn the_cap_and_the_grouping_cost_no_call() {
    let mentions: Vec<Value> = (0..5).map(|i| mention(300 + i, 40 + i, 20250301 + i)).collect();
    let logseq = mock_logseq(vec![root(), json!([]), editor_page(), Value::Array(mentions)]).await;
    let options = EvolutionOptions { group_by: Some(GroupBy::Week), max_entries: 3, ..EvolutionOptions::default() };
    let evolution = get_concept_evolution(&client(&logseq), "Project Atlas", options).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4);
    assert_eq!(evolution.timeline.len(), 3);
    assert_eq!(evolution.summary.total_mentions, 5);
    assert_eq!(evolution.warnings[0].code, "entries_truncated");
    assert_eq!(evolution.grouped_timeline.as_ref().unwrap().len(), 1);
}
