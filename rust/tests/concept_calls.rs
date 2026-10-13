//! The LogSeq traffic of `logseq_explore_network` against a mock
//! LogSeq on a local port: how many calls it makes, in which order, with which inputs. The call counts
//! are those in CLAUDE.md ("Current Implementation Status"); the parity harness
//! (`parity.rs`) checks the same calls and the result bytes against the recorded results.
//! Every page and block here is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq, uuid};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::explore_network::{HUB_LINKS, Options, explore_network};
use serde_json::{Value, json};

const DATALOG: &str = "logseq.DB.datascriptQuery";

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
    let network = explore_network(&client(&logseq), "Project Atlas", max_depth, options).await.unwrap();

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
    let network = explore_network(&client(&logseq), "Project Atlas", max_depth, options).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
    assert_eq!(network.nodes.len(), 2);

    // with expand_journals it is walked through
    let walked = mock_logseq(vec![root(), json!([row(10, 30, "Jan 1st, 2025", true, "outbound", 2)]), json!([])]).await;
    explore_network(&client(&walked), "Project Atlas", 2, Options { expand_journals: true, ..Options::default() }).await.unwrap();
    assert_eq!(methods(&walked).len(), 3);
    assert!(args_of(&walked, 2)[0].as_str().unwrap().contains("[(ground [30]) [?source ...]]"));
}

#[tokio::test]
async fn a_depth_past_the_limit_is_the_callers_to_clamp_and_zero_asks_nothing_of_the_graph() {
    // the handler passes at most 3; the walk itself does exactly the depth it is given
    let zero = mock_logseq(vec![json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]])]).await;
    let network = explore_network(&client(&zero), "Project Atlas", 0, Options::default()).await.unwrap();
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
    let network = explore_network(&client(&logseq), "Project Atlas", 2, Options::default()).await.unwrap();

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
    let error = explore_network(&client(&logseq), "Projct Atlas", 2, Options::default()).await.unwrap_err();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, "logseq.Editor.getAllPages"]);
    assert!(matches!(&error, ToolError::PageNotFound(missing) if missing.suggestions == ["Project Atlas"]), "{error}");
}

fn codes(warnings: &[logseq_mcp_server::meta::ResultWarning]) -> Vec<&str> {
    warnings.iter().map(|warning| warning.code.as_str()).collect()
}

#[tokio::test]
async fn a_null_answer_for_the_first_depth_is_a_links_unavailable_warning_not_an_empty_network() {
    let null = mock_logseq(vec![root(), json!(null)]).await;
    let network = explore_network(&client(&null), "Project Atlas", 2, Options::default()).await.unwrap();
    // the root alone, and the walk stopped at once: no depth 2 query
    assert_eq!(network.nodes.len(), 1);
    assert_eq!(methods(&null).len(), 2);
    assert_eq!(codes(&network.warnings), ["links_unavailable"]);
    let warning = &network.warnings[0];
    assert!(warning.message.contains("depth 1"), "{}", warning.message);
    assert!(warning.message.contains("This does not mean those pages link to nothing."), "{}", warning.message);
    // nothing to fetch with a parameter, so no hasMore, and nothing was cut
    assert!(warning.how_to_fetch_all.is_none());
    assert!(!network.has_more() && !network.truncated);
    assert_eq!(network.to_value()["hasMore"], false);

    // a real [] is a network with no links, and says nothing
    let empty = mock_logseq(vec![root(), json!([])]).await;
    let network = explore_network(&client(&empty), "Project Atlas", 2, Options::default()).await.unwrap();
    assert!(network.warnings.is_empty());
}

#[tokio::test]
async fn a_null_answer_at_a_later_depth_keeps_what_was_found_and_leaves_truncated_as_the_caps_set_it() {
    let logseq = mock_logseq(vec![
        root(),
        json!([row(10, 20, "Bob", false, "outbound", 2), row(10, 21, "Carol", false, "inbound", 1)]),
        json!(null),
    ])
    .await;
    // the fanout cap drops Carol at depth 1, then depth 2 gets no answer
    let network = explore_network(&client(&logseq), "Project Atlas", 3, Options { max_fanout: 1, ..Options::default() }).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
    assert_eq!(network.nodes.iter().map(|node| node.name.as_str()).collect::<Vec<_>>(), ["Project Atlas", "Bob"]);
    assert!(network.truncated);
    assert_eq!(codes(&network.warnings), ["network_truncated", "links_unavailable"]);
    assert!(network.warnings[1].message.contains("depth 2"), "{}", network.warnings[1].message);
    assert!(network.warnings[1].how_to_fetch_all.is_none());

    // without a cap that bit, `truncated` stays false
    let quiet = mock_logseq(vec![root(), json!([row(10, 20, "Bob", false, "outbound", 2)]), json!(null)]).await;
    let network = explore_network(&client(&quiet), "Project Atlas", 3, Options::default()).await.unwrap();
    assert!(!network.truncated && !network.has_more());
    assert_eq!(codes(&network.warnings), ["links_unavailable"]);
}

#[tokio::test]
async fn a_null_answer_for_the_aliased_first_depth_is_a_links_unavailable_warning_beside_the_alias_group() {
    // the alias group answers, then the grouped depth-1 query (a separate branch of the walk) answers null
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]]),
        json!([[10, {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}], [10, {"id": 11, "name": "atlas", "original-name": "Atlas"}]]),
        json!(null),
    ])
    .await;
    let network = explore_network(&client(&logseq), "Project Atlas", 2, Options::default()).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
    assert!(args_of(&logseq, 2)[0].as_str().unwrap().contains("[(ground [[10 10] [11 10]]) [[?source ?group] ...]]"));
    assert_eq!(network.nodes.len(), 1);
    assert_eq!(network.resolved_aliases.as_deref(), Some(&["Atlas".to_owned(), "Project Atlas".to_owned()][..]));
    assert_eq!(codes(&network.warnings), ["links_unavailable"]);
    assert!(network.warnings[0].message.contains("depth 1"), "{}", network.warnings[0].message);
    assert!(!network.has_more() && !network.truncated);
}

/// A `degree` row: how many pages the connected page links.
fn degree(source: i64, connected: i64, name: &str, pages: i64) -> Value {
    json!([source, connected, name.to_lowercase(), name, false, "degree", pages])
}

/// The names of a network's pages, in the order they joined.
fn names(network: &logseq_mcp_server::tools::explore_network::Network) -> Vec<&str> {
    network.nodes.iter().map(|node| node.name.as_str()).collect()
}

/// The depth-1 answer of a root with a roll-up and some topical pages. A roll-up links more pages than `HUB_LINKS`, and
/// its two blocks that link the root out-rank a topical page's one.
fn roll_up_rows(roll_up_links: i64) -> Value {
    json!([
        row(10, 20, "Roll Up", false, "inbound", 2),
        degree(10, 20, "Roll Up", roll_up_links),
        row(10, 21, "Topic A", false, "outbound", 1),
        degree(10, 21, "Topic A", 3),
        row(10, 22, "Topic B", false, "outbound", 1),
        degree(10, 22, "Topic B", 4),
    ])
}

#[tokio::test]
async fn a_roll_up_ranks_after_the_topical_pages_and_is_a_leaf_that_a_warning_names() {
    let logseq = mock_logseq(vec![root(), roll_up_rows(HUB_LINKS + 1), json!([])]).await;
    let network = explore_network(&client(&logseq), "Project Atlas", 2, Options::default()).await.unwrap();

    // the same calls as without the rule: the resolver and one query per depth, and the degrees came with the first
    assert_eq!(methods(&logseq), [DATALOG, DATALOG, DATALOG]);
    assert_eq!(names(&network), ["Project Atlas", "Topic A", "Topic B", "Roll Up"]);
    // depth 2 walks through the topical pages and not through the roll-up (ids 21 and 22 only)
    assert!(args_of(&logseq, 2)[0].as_str().unwrap().contains("[(ground [21 22]) [?source ...]]"), "{}", args_of(&logseq, 2)[0]);
    // the links of the pair still make an edge
    assert_eq!(network.edges.len(), 3);
    assert!(!network.truncated);
    assert_eq!(codes(&network.warnings), ["hub_pages_not_expanded"]);
    let warning = &network.warnings[0];
    assert!(warning.message.contains("Roll Up (31 pages)"), "{}", warning.message);
    // 4 pages are kept and the roll-up links 31: walking through it brings up to 15 more
    assert!(warning.how_to_fetch_all.as_deref().is_some_and(|how| how.starts_with("Set expand_journals to true")));
    assert!(warning.how_to_fetch_all.as_deref().is_some_and(|how| how.contains("adds at least 15 pages")), "{:?}", warning.how_to_fetch_all);
    assert!(network.has_more());
}

#[tokio::test]
async fn a_journal_is_no_roll_up_however_many_pages_it_links_and_a_journal_leaf_withholds_the_offer() {
    // the journal links 40 pages and makes no degree row (the query leaves journals out), but a reply that had one is no roll-up either
    let mut rows = roll_up_rows(HUB_LINKS + 1).as_array().unwrap().clone();
    rows.push(json!([10, 30, "jan 1st, 2025", "Jan 1st, 2025", true, "inbound", 1]));
    rows.push(json!([10, 30, "jan 1st, 2025", "Jan 1st, 2025", true, "degree", 40]));
    let logseq = mock_logseq(vec![root(), json!(rows), json!([])]).await;
    let network = explore_network(&client(&logseq), "Project Atlas", 2, Options::default()).await.unwrap();
    assert_eq!(names(&network), ["Project Atlas", "Topic A", "Topic B", "Roll Up", "Jan 1st, 2025"]);
    // only the roll-up is named
    assert_eq!(codes(&network.warnings), ["hub_pages_not_expanded"]);
    let warning = &network.warnings[0];
    assert!(warning.message.contains("Roll Up (31 pages)") && !warning.message.contains("Jan 1st"), "{}", warning.message);
    // `expand_journals` would also walk through the journal, which is not counted in what it brings: no offer
    assert!(warning.how_to_fetch_all.is_none() && !network.has_more());
}

#[tokio::test]
async fn a_page_at_the_threshold_is_walked_through_and_one_over_it_is_not() {
    for (links, walked) in [(HUB_LINKS - 1, true), (HUB_LINKS, true), (HUB_LINKS + 1, false)] {
        let logseq = mock_logseq(vec![root(), roll_up_rows(links), json!([])]).await;
        let network = explore_network(&client(&logseq), "Project Atlas", 2, Options::default()).await.unwrap();
        let second = args_of(&logseq, 2)[0].as_str().unwrap().to_owned();
        assert_eq!(second.contains("[(ground [20 21 22]) [?source ...]]"), walked, "{links} links: {second}");
        assert_eq!(network.warnings.is_empty(), walked, "{links} links");
        // the roll-up ranks first among the pages that tie, so the pages are in order of their counts
        let expected = if walked { ["Project Atlas", "Roll Up", "Topic A", "Topic B"] } else { ["Project Atlas", "Topic A", "Topic B", "Roll Up"] };
        assert_eq!(names(&network), expected, "{links} links");
    }
}

#[tokio::test]
async fn a_roll_up_is_walked_through_with_expand_journals_but_still_ranks_last() {
    let logseq = mock_logseq(vec![root(), roll_up_rows(HUB_LINKS + 20), json!([])]).await;
    let network = explore_network(&client(&logseq), "Project Atlas", 2, Options { expand_journals: true, ..Options::default() }).await.unwrap();
    assert_eq!(names(&network), ["Project Atlas", "Topic A", "Topic B", "Roll Up"]);
    assert!(args_of(&logseq, 2)[0].as_str().unwrap().contains("[(ground [21 22 20]) [?source ...]]"), "{}", args_of(&logseq, 2)[0]);
    assert!(network.warnings.is_empty());
}

#[tokio::test]
async fn a_roll_up_at_the_last_depth_is_shown_and_needs_no_warning_since_nothing_is_walked_there() {
    let logseq = mock_logseq(vec![root(), roll_up_rows(HUB_LINKS + 1)]).await;
    let network = explore_network(&client(&logseq), "Project Atlas", 1, Options::default()).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
    assert_eq!(names(&network), ["Project Atlas", "Topic A", "Topic B", "Roll Up"]);
    assert!(network.warnings.is_empty() && !network.has_more());
}

#[tokio::test]
async fn a_cap_that_bites_drops_the_roll_up_first_and_the_warning_is_the_cap_s() {
    let logseq = mock_logseq(vec![root(), roll_up_rows(HUB_LINKS + 1), json!([])]).await;
    let network = explore_network(&client(&logseq), "Project Atlas", 2, Options { max_fanout: 2, ..Options::default() }).await.unwrap();
    assert_eq!(names(&network), ["Project Atlas", "Topic A", "Topic B"]);
    assert!(network.truncated);
    assert_eq!(codes(&network.warnings), ["network_truncated"]);
}

#[tokio::test]
async fn walking_through_a_roll_up_is_not_offered_when_it_would_bring_no_page() {
    // the node budget is full: a roll-up that is walked through would add nothing
    let full = mock_logseq(vec![root(), roll_up_rows(HUB_LINKS + 1), json!([])]).await;
    let network = explore_network(&client(&full), "Project Atlas", 2, Options { max_nodes: 4, ..Options::default() }).await.unwrap();
    assert_eq!(codes(&network.warnings), ["hub_pages_not_expanded"]);
    assert!(network.warnings[0].how_to_fetch_all.is_none() && !network.has_more() && !network.truncated);

    // the network already holds more pages than the roll-up links: all of them are in it
    let mut rows: Vec<Value> = (0..40).flat_map(|n| [row(10, 100 + n, &format!("Topic {n}"), false, "outbound", 1), degree(10, 100 + n, &format!("Topic {n}"), 2)]).collect();
    rows.extend([row(10, 20, "Roll Up", false, "inbound", 2), degree(10, 20, "Roll Up", HUB_LINKS + 1)]);
    let held = mock_logseq(vec![root(), json!(rows), json!([])]).await;
    let network = explore_network(&client(&held), "Project Atlas", 2, Options { max_fanout: 100, ..Options::default() }).await.unwrap();
    assert_eq!(network.nodes.len(), 42);
    assert_eq!(codes(&network.warnings), ["hub_pages_not_expanded"]);
    assert!(network.warnings[0].how_to_fetch_all.is_none() && !network.has_more());
}

#[tokio::test]
async fn walking_through_a_roll_up_is_not_offered_when_the_walk_did_not_get_to_the_end() {
    let logseq = mock_logseq(vec![root(), roll_up_rows(HUB_LINKS + 1), json!(null)]).await;
    let network = explore_network(&client(&logseq), "Project Atlas", 2, Options::default()).await.unwrap();
    assert_eq!(codes(&network.warnings), ["hub_pages_not_expanded", "links_unavailable"]);
    assert!(network.warnings[0].how_to_fetch_all.is_none() && !network.has_more());
}

#[tokio::test]
async fn a_page_with_aliases_asks_for_the_degrees_in_its_grouped_query_too() {
    let logseq = mock_logseq(vec![
        json!([[page(10, "project atlas", "Project Atlas", json!({"alias": [{"id": 11}]})), "name"]]),
        json!([[10, {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}], [10, {"id": 11, "name": "atlas", "original-name": "Atlas"}]]),
        roll_up_rows(HUB_LINKS + 1),
    ])
    .await;
    let network = explore_network(&client(&logseq), "Project Atlas", 1, Options::default()).await.unwrap();
    let grouped = args_of(&logseq, 2)[0].as_str().unwrap().to_owned();
    assert!(grouped.contains("[(ground \"degree\") ?rel-type]"), "{grouped}");
    assert_eq!(names(&network), ["Project Atlas", "Topic A", "Topic B", "Roll Up"]);
}

/// A depth-1 answer with the text of one block in a last cell, as the query that asks for snippets answers it.
/// The last cell is the key the query ranks the blocks of a pair by, `[prose, length, content]`.
fn snippet_row(source: i64, connected: i64, name: &str, rel: &str, count: i64, text: &str) -> Value {
    let prose = i32::from(!text.starts_with("[[") && !text.starts_with('#'));
    json!([source, connected, name.to_lowercase(), name, false, rel, count, [prose, text.chars().count().min(200), text]])
}

#[tokio::test]
async fn snippets_come_with_the_first_depth_and_cost_no_call() {
    let logseq = mock_logseq(vec![
        root(),
        json!([
            // a page the root links and is linked by: the root's own block is the one shown
            snippet_row(10, 20, "Bob", "outbound", 1, "Met Bob at the fair\nsecond line"),
            snippet_row(10, 20, "Bob", "inbound", 1, "Notes from Bob"),
            degree_with_snippet(10, 20, "Bob", 2),
            // a page that only links the root: its block is shown
            snippet_row(10, 21, "Carol", "inbound", 1, &"x".repeat(100)),
            // a page whose block has no text
            snippet_row(10, 22, "Dave", "outbound", 1, ""),
        ]),
        json!([row(20, 23, "Erin", false, "outbound", 1)]),
    ])
    .await;
    let options = Options { with_snippets: true, ..Options::default() };
    let network = explore_network(&client(&logseq), "Project Atlas", 2, options).await.unwrap();

    // one resolver query and one query per depth, as without snippets
    assert_eq!(methods(&logseq).len(), 3);
    let first = args_of(&logseq, 1)[0].as_str().unwrap().to_owned();
    assert!(first.contains("(max ?key)"), "{first}");
    // the second depth asks for no text, and its rows have no extra cell
    assert!(!args_of(&logseq, 2)[0].as_str().unwrap().contains("?content"));
    let edges = network.to_value()["edges"].clone();
    let snippet = |to: i64| edges.as_array().unwrap().iter().find(|edge| edge["to"] == to).and_then(|edge| edge["snippet"].as_str().map(str::to_owned));
    assert_eq!(snippet(20).as_deref(), Some("Met Bob at the fair"));
    assert_eq!(snippet(21), Some(format!("{}...", "x".repeat(77))));
    assert_eq!(snippet(22), None, "an empty block says nothing");
    // an edge past the first depth has none
    assert_eq!(snippet(23), None);
    assert!(network.warnings.is_empty());
}

fn degree_with_snippet(source: i64, connected: i64, name: &str, pages: i64) -> Value {
    snippet_row(source, connected, name, "degree", pages, "")
}

#[tokio::test]
async fn without_with_snippets_no_edge_has_a_snippet_and_the_query_asks_for_no_text() {
    let logseq = mock_logseq(vec![root(), json!([row(10, 20, "Bob", false, "outbound", 3)])]).await;
    let network = explore_network(&client(&logseq), "Project Atlas", 1, Options::default()).await.unwrap();
    assert!(!args_of(&logseq, 1)[0].as_str().unwrap().contains("?content"));
    assert!(network.to_value()["edges"][0].get("snippet").is_none());
}

#[tokio::test]
async fn a_snippet_row_with_no_text_cell_is_a_response_error_not_an_empty_snippet() {
    let logseq = mock_logseq(vec![root(), json!([row(10, 20, "Bob", false, "outbound", 3)])]).await;
    let error = explore_network(&client(&logseq), "Project Atlas", 1, Options { with_snippets: true, ..Options::default() }).await.unwrap_err();
    assert!(matches!(error, ToolError::Response(_)), "{error}");
}

#[tokio::test]
async fn an_infrastructure_error_for_the_connected_pages_propagates() {
    let failing = mock_logseq(vec![root(), json!({"error": "Query timed out"})]).await;
    let error = explore_network(&client(&failing), "Project Atlas", 2, Options::default()).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

