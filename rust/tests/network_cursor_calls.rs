//! The cursor of `logseq_explore_network` (ADR-0038, #556) through its `call`, against a mock LogSeq on a local port: what a
//! page read from a snapshot costs (no call), what a page read after the snapshot is gone costs (the calls the first page made, and
//! no more), how a walk that moved between two pages is resumed, what a bad token or a cursor with another argument gets
//! before any call, and that a walk several times the budget is read to the end with every page and every edge once.
//! Every page here is made up (BR-0001).

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MockLogseq, args_of, client, methods, mock_logseq, mock_logseq_answering, uuid};
use logseq_mcp_server::budget::{BUDGET_CHARS, size};
use logseq_mcp_server::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::snapshots::{Limits, Snapshots};
use logseq_mcp_server::tools::explore_network;
use serde_json::{Value, json};

const DATALOG: &str = "logseq.DB.datascriptQuery";
const NEXT_PAGE: &str = "Pass nextCursor as cursor, with no other argument, to read the next page.";
const ROOT: i64 = 10;

/// One link out of a page: the page it links, its name, how many blocks make the link, and whether it is a journal.
#[derive(Clone)]
struct Link {
    to: i64,
    name: String,
    count: i64,
    journal: bool,
}

/// What LogSeq holds: the pages each page links, which a test changes between two pages.
type World = Arc<Mutex<HashMap<i64, Vec<Link>>>>;

fn link(to: i64, name: &str, count: i64) -> Link {
    Link { to, name: name.to_owned(), count, journal: false }
}

/// A root with `count` neighbours (ids 1000 and up), each named by its number and `length` more characters.
fn star(count: i64, length: usize) -> World {
    let links = (0..count).map(|n| link(1000 + n, &format!("Page {n:04} {}", "p".repeat(length)), 1)).collect();
    Arc::new(Mutex::new(HashMap::from([(ROOT, links)])))
}

fn name_of(n: i64, length: usize) -> String {
    format!("Page {n:04} {}", "p".repeat(length))
}

/// The ids bound with `ground` in a connected-pages query: the frontier.
fn frontier_of(query: &str) -> Vec<i64> {
    let start = query.find("[(ground [").expect("a connected-pages query grounds its frontier") + "[(ground [".len();
    let end = query[start..].find("])").unwrap() + start;
    query[start..end].split_whitespace().map(|id| id.parse().unwrap()).collect()
}

fn root_page() -> Value {
    json!([[{"id": ROOT, "uuid": uuid(ROOT), "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 5010}}, "name"]])
}

/// The root as a page that has an alias (the stub 11): its alias group is one node and its depth 1 is one grouped query.
fn aliased_root_page() -> Value {
    json!([[{"id": ROOT, "uuid": uuid(ROOT), "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 5010}, "alias": [{"id": 11}]}, "name"]])
}

/// What the mock answers: the root to the resolver (with an alias when `aliased`), the alias group to its query, and to a
/// connected-pages query the links of each page of its frontier, each with a `degree` row (3 pages, so none is a roll-up;
/// 41 for a page named `Hub ...`, which is). A query that asks for snippets gets the text cell on every row.
fn answer(world: &World, aliased: bool, request: &Value) -> Value {
    let args = request["args"].as_array().unwrap();
    if args.len() > 1 {
        return if aliased { aliased_root_page() } else { root_page() };
    }
    let query = args[0].as_str().unwrap();
    let grouped = query.contains("[[?source ?group]");
    if !grouped && !query.contains("?source") {
        return json!([[ROOT, {"id": ROOT, "name": "project atlas", "original-name": "Project Atlas"}], [ROOT, {"id": 11, "name": "atlas", "original-name": "Atlas"}]]);
    }
    let snippets = query.contains("(max ?key)");
    let world = world.lock().unwrap();
    let sources = if grouped { vec![ROOT] } else { frontier_of(query) };
    let mut rows = Vec::new();
    for source in sources {
        for link in world.get(&source).map_or(&[][..], Vec::as_slice) {
            let lower = link.name.to_lowercase();
            let mut outbound = vec![json!(source), json!(link.to), json!(lower), json!(link.name), json!(link.journal), json!("outbound"), json!(link.count)];
            let mut degree = vec![json!(source), json!(link.to), json!(lower), json!(link.name), json!(false), json!("degree"), json!(if link.name.starts_with("Hub") { 41 } else { 3 })];
            if snippets {
                let text = format!("Note on {}", link.name);
                outbound.push(json!([1, text.len(), text]));
                degree.push(json!([1, 0, ""]));
            }
            rows.push(Value::Array(outbound));
            if !link.journal {
                rows.push(Value::Array(degree));
            }
        }
    }
    Value::Array(rows)
}

async fn logseq_holding(world: &World) -> MockLogseq {
    let world = Arc::clone(world);
    mock_logseq_answering(move |request| answer(&world, false, request)).await
}

async fn logseq_holding_an_aliased_root(world: &World) -> MockLogseq {
    let world = Arc::clone(world);
    mock_logseq_answering(move |request| answer(&world, true, request)).await
}

fn arguments(value: Value) -> Option<rmcp::model::JsonObject> {
    value.as_object().cloned()
}

fn snapshots() -> Snapshots {
    Snapshots::new(1_760_000_000_000)
}

async fn call_text(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<String, ToolError> {
    let result = explore_network::call(&client(logseq), true, snapshots, arguments(args)).await?;
    let content = serde_json::to_value(&result).unwrap()["content"].clone();
    assert_eq!(content.as_array().unwrap().len(), 1, "a network is one content block");
    Ok(content[0]["text"].as_str().unwrap().to_owned())
}

/// The body of a call. A page over the budget is one page, returned whole (BR-0007), so the size is checked here.
async fn call(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> Result<Value, ToolError> {
    let text = call_text(logseq, snapshots, args).await?;
    let body: Value = serde_json::from_str(&text).unwrap();
    assert!(size(&text) <= BUDGET_CHARS || body["nodes"].as_array().unwrap().len() <= 1, "a page is over the budget: {}", size(&text));
    Ok(body)
}

fn ids(body: &Value) -> Vec<i64> {
    body["nodes"].as_array().unwrap().iter().map(|node| node["id"].as_i64().unwrap()).collect()
}

fn edges(body: &Value) -> Vec<(i64, i64)> {
    body["edges"].as_array().unwrap().iter().map(|edge| (edge["from"].as_i64().unwrap(), edge["to"].as_i64().unwrap())).collect()
}

fn cursor_of(body: &Value) -> String {
    body["nextCursor"].as_str().expect("a page that leaves pages has a nextCursor").to_owned()
}

fn warning_codes(body: &Value) -> Vec<String> {
    body["warnings"].as_array().map_or_else(Vec::new, |warnings| warnings.iter().map(|warning| warning["code"].as_str().unwrap().to_owned()).collect())
}

fn neighbour_ids(from: i64, count: i64) -> Vec<i64> {
    (0..count).map(|n| from + n).collect()
}

// ---- a hit: the later pages cost nothing

#[tokio::test]
async fn the_pages_after_the_first_are_read_from_the_snapshot_and_make_no_call() {
    let world = star(90, 10);
    let logseq = logseq_holding(&world).await;
    let snapshots = snapshots();
    let args = json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100});

    let first = call(&logseq, &snapshots, args).await.unwrap();
    assert_eq!(ids(&first).len(), 40);
    assert_eq!((first["hasMore"].clone(), first["truncated"].clone()), (json!(true), json!(false)));
    assert_eq!(first["warnings"][0]["code"], "pages_truncated");
    assert_eq!(first["warnings"][0]["message"], "Showing 1-40 of 91 pages.");
    assert!(first["warnings"][0]["howToFetchAll"].as_str().unwrap().starts_with(NEXT_PAGE));
    assert_eq!(methods(&logseq), [DATALOG, DATALOG], "the first page: the resolver and the one depth");

    // the graph changes under the pages: a hit page still shows the walk as the first page read it
    world.lock().unwrap().clear();
    let second = call(&logseq, &snapshots, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(ids(&second).len(), 40);
    assert_eq!(second["warnings"][0]["message"], "Showing 41-80 of 91 pages.");
    assert_eq!(second["warnings"][0]["howToFetchAll"], NEXT_PAGE, "a cursor call can't change the page size, so no raise");
    assert_eq!(second["hasMore"], true);

    let third = call(&logseq, &snapshots, json!({"cursor": cursor_of(&second)})).await.unwrap();
    assert_eq!(ids(&third).len(), 11);
    // the last page is complete: no cursor, no hasMore
    assert_eq!((third["hasMore"].clone(), third.get("nextCursor").is_none(), warning_codes(&third)), (json!(false), true, Vec::<String>::new()));
    assert_eq!(methods(&logseq), [DATALOG, DATALOG], "pages 2 and 3 made no LogSeq call");

    // every page once, in the order the walk admitted them, and every edge once
    let all: Vec<i64> = [&first, &second, &third].iter().flat_map(|page| ids(page)).collect();
    assert_eq!(all, [vec![ROOT], neighbour_ids(1000, 90)].concat());
    let sent: Vec<(i64, i64)> = [&first, &second, &third].iter().flat_map(|page| edges(page)).collect();
    assert_eq!(sent.len(), 90);
    assert!(sent.iter().all(|(from, _)| *from == ROOT));
    // `page` and `truncated` ride on every page
    for page in [&first, &second, &third] {
        assert_eq!((page["page"].clone(), page["truncated"].clone()), (json!("Project Atlas"), json!(false)));
    }
}

// ---- a miss: the first page's calls, and no more

#[tokio::test]
async fn a_page_whose_snapshot_is_gone_costs_the_calls_the_first_page_made_with_the_same_inputs() {
    let world = star(90, 10);
    let logseq = logseq_holding(&world).await;
    let first = call(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);

    // a restarted server: no snapshot, and its own start time, so the key the cursor holds is nobody's
    let second = call(&logseq, &Snapshots::new(1_760_000_999_999), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq), [DATALOG; 4], "page 1's calls again, and no more");
    assert_eq!((args_of(&logseq, 2), args_of(&logseq, 3)), (args_of(&logseq, 0), args_of(&logseq, 1)), "the same query text and inputs");
    assert_eq!(ids(&second), neighbour_ids(1039, 40));
    assert!(!warning_codes(&second).contains(&"cursor_stale".to_owned()), "the walk did not move: {second}");
    assert_eq!(second["warnings"][0]["message"], "Showing 41-80 of 91 pages.");
}

#[tokio::test]
async fn a_snapshot_older_than_its_age_is_a_miss_that_reads_logseq_again() {
    let world = star(90, 10);
    let logseq = logseq_holding(&world).await;
    let aged = Snapshots::with_limits(1_760_000_000_000, Limits { max_age: Duration::ZERO, ..Limits::STARTING });
    let first = call(&logseq, &aged, json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100})).await.unwrap();
    let second = call(&logseq, &aged, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!((methods(&logseq).len(), ids(&second).len()), (4, 40), "the second page read LogSeq again, with the first page's two calls");
}

#[tokio::test]
async fn a_miss_that_builds_a_snapshot_serves_the_next_page_from_it() {
    let world = star(90, 10);
    let logseq = logseq_holding(&world).await;
    let first = call(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100})).await.unwrap();
    let restarted = Snapshots::new(1_760_000_999_999);
    let second = call(&logseq, &restarted, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4);
    let third = call(&logseq, &restarted, json!({"cursor": cursor_of(&second)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "the page after a rebuild is read from the rebuilt snapshot");
    assert_eq!(ids(&third), neighbour_ids(1079, 11));
}

#[tokio::test]
async fn a_walk_over_the_snapshot_limit_is_built_again_for_each_page_and_still_read_to_the_end() {
    let world = star(90, 10);
    let logseq = logseq_holding(&world).await;
    let small = Snapshots::with_limits(1_760_000_000_000, Limits { snapshot_bytes: 10, ..Limits::STARTING });
    let mut body = call(&logseq, &small, json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100})).await.unwrap();
    let mut all = ids(&body);
    while body.get("nextCursor").is_some() {
        body = call(&logseq, &small, json!({"cursor": cursor_of(&body)})).await.unwrap();
        all.extend(ids(&body));
    }
    assert_eq!(all, [vec![ROOT], neighbour_ids(1000, 90)].concat());
    assert_eq!(methods(&logseq).len(), 6, "each of the three pages made the two calls: nothing was kept");
}

// ---- a walk that moved between the pages

/// The first page of a walk of 100 neighbours with the page size 30: pages 0 to 28 below the root, with a cursor to 30.
async fn first_page_of_100(logseq: &MockLogseq) -> String {
    let first = call(logseq, &snapshots(), json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 30, "max_fanout": 100})).await.unwrap();
    assert_eq!((ids(&first).len(), *ids(&first).last().unwrap()), (30, 1028));
    cursor_of(&first)
}

#[tokio::test]
async fn a_walk_that_gained_an_earlier_page_resumes_after_the_last_page_sent_with_no_repeat_and_says_so() {
    let world = star(100, 10);
    let logseq = logseq_holding(&world).await;
    let cursor = first_page_of_100(&logseq).await;

    // a page linked by more blocks ranks first: every position moved by one
    world.lock().unwrap().get_mut(&ROOT).unwrap().push(link(2000, "Newcomer", 5));
    let second = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    assert_eq!(ids(&second)[0], 1029, "the page resumes by id, not by position: page 1028 is not sent again");
    assert_eq!(warning_codes(&second)[0], "cursor_stale");
    assert!(second["warnings"][0]["message"].as_str().unwrap().contains("resumes right after it, so none is repeated"));
    // the newcomer took the place of the last page under the fanout of 100, so the walk still holds 101 pages
    let cut = second["warnings"].as_array().unwrap().iter().find(|warning| warning["code"] == "pages_truncated").unwrap();
    assert!(cut["message"].as_str().unwrap().starts_with("Showing 32-61 of 101 pages"), "{}", cut["message"]);
}

#[tokio::test]
async fn a_walk_that_lost_a_page_it_had_shown_or_the_anchor_itself_loses_none_of_the_rest() {
    for removed in [1010, 1028] {
        let world = star(100, 10);
        let logseq = logseq_holding(&world).await;
        let cursor = first_page_of_100(&logseq).await;
        world.lock().unwrap().get_mut(&ROOT).unwrap().retain(|link| link.to != removed);
        let second = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
        assert_eq!(warning_codes(&second)[0], "cursor_stale", "removed {removed}");
        // with the anchor gone the page starts at the same position, so a page may be missing or repeated: it says so
        let start = if removed == 1028 { 1030 } else { 1029 };
        assert_eq!(ids(&second)[0], start, "removed {removed}");
        assert_eq!(ids(&second).len(), 30);
    }
}

#[tokio::test]
async fn a_walk_that_shrank_below_the_position_is_an_empty_page_and_not_an_error() {
    let world = star(100, 10);
    let logseq = logseq_holding(&world).await;
    let cursor = first_page_of_100(&logseq).await;
    world.lock().unwrap().get_mut(&ROOT).unwrap().truncate(2);
    let second = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    assert_eq!(second["nodes"], json!([]));
    assert_eq!(warning_codes(&second), ["cursor_stale"]);
    assert!(second.get("nextCursor").is_none() && second["hasMore"] == false);
}

// ---- the whole walk, page after page

async fn read_to_the_end(logseq: &MockLogseq, snapshots: &Snapshots, args: Value) -> (Vec<Value>, usize) {
    let mut pages = vec![call(logseq, snapshots, args).await.unwrap()];
    while pages.last().unwrap().get("nextCursor").is_some() {
        assert!(pages.len() < 200, "a cursor that never ends");
        let last = pages.last().unwrap();
        assert_eq!(last["hasMore"], true);
        pages.push(call(logseq, snapshots, json!({"cursor": cursor_of(last)})).await.unwrap());
        assert!(!ids(pages.last().unwrap()).is_empty(), "a page with a cursor to read on after it holds a page");
    }
    let count = pages.len();
    assert_eq!(pages.last().unwrap()["hasMore"], false);
    (pages, count)
}

#[tokio::test]
async fn a_budget_cut_page_reads_on_to_the_end_with_every_page_and_edge_once_hit_or_miss() {
    // 100 neighbours with names of ~900 characters: ~100,000 characters of nodes, edges and warnings
    let world = star(100, 900);
    let args = json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 500, "max_fanout": 100});
    let expected = [vec![ROOT], neighbour_ids(1000, 100)].concat();

    let hit = logseq_holding(&world).await;
    let (pages, count) = read_to_the_end(&hit, &snapshots(), args.clone()).await;
    assert!(count >= 3, "{count}");
    assert_eq!(pages.iter().flat_map(ids).collect::<Vec<_>>(), expected);
    assert_eq!(pages.iter().flat_map(edges).count(), 100);
    assert_eq!(pages[0]["warnings"][0]["code"], "result_size_truncated");
    assert!(pages[0]["warnings"][0]["message"].as_str().unwrap().contains("Showing 1-"), "{}", pages[0]["warnings"][0]["message"]);
    assert_eq!(methods(&hit).len(), 2, "the pages after the first made no call");

    // a miss on every page: a new server each time, so each page makes the two calls and reads the same walk
    let miss = logseq_holding(&world).await;
    let mut body = call(&miss, &snapshots(), args).await.unwrap();
    let mut seen = ids(&body);
    let mut miss_pages = 1;
    while body.get("nextCursor").is_some() {
        body = call(&miss, &Snapshots::new(2 + miss_pages as u64), json!({"cursor": cursor_of(&body)})).await.unwrap();
        seen.extend(ids(&body));
        miss_pages += 1;
    }
    assert_eq!(seen, expected, "a hit page and a miss page read the same walk");
    assert_eq!((miss_pages, methods(&miss).len()), (count, count * 2), "a miss costs the first page's two calls, once a page");
}

#[tokio::test]
async fn a_page_over_the_budget_by_itself_is_returned_alone_and_the_cursor_moves_past_it() {
    let world = star(3, 10);
    world.lock().unwrap().get_mut(&ROOT).unwrap()[0].name = format!("A{}", "x".repeat(40_000));
    let logseq = logseq_holding(&world).await;
    let shared = snapshots();
    // the root, then the 40,000-character page, which ranks first among equals (the lowest id)
    let mut pages = vec![call(&logseq, &shared, json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 2})).await.unwrap()];
    while pages.last().unwrap().get("nextCursor").is_some() {
        let cursor = cursor_of(pages.last().unwrap());
        pages.push(call(&logseq, &shared, json!({"cursor": cursor})).await.unwrap());
    }
    // the root alone fits, the long page is a page of its own, and the cursor moves past it
    assert_eq!(pages.iter().map(ids).collect::<Vec<_>>(), [vec![ROOT], vec![1000], vec![1001, 1002]]);
    assert_eq!(pages[1]["warnings"][0]["code"], "result_size_truncated");
    assert!(pages[1]["warnings"][0]["message"].as_str().unwrap().contains("Even those are over that size"));
    assert_eq!(methods(&logseq).len(), 2);
}

#[tokio::test]
async fn a_walk_exactly_at_the_page_size_has_no_cursor_and_one_more_page_has_one() {
    for (count, cursor) in [(49, false), (50, true)] {
        let world = star(count, 10);
        let logseq = logseq_holding(&world).await;
        let body = call(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_depth": 1, "max_fanout": 100})).await.unwrap();
        assert_eq!(body.get("nextCursor").is_some(), cursor, "{count} neighbours");
        assert_eq!(ids(&body).len(), 50);
        assert_eq!(body["hasMore"], cursor);
        assert_eq!(body["warnings"].as_array().unwrap().len(), usize::from(cursor));
    }
}

#[tokio::test]
async fn a_root_with_no_link_and_a_depth_of_zero_are_one_page_with_no_cursor() {
    let alone: World = Arc::new(Mutex::new(HashMap::new()));
    let logseq = logseq_holding(&alone).await;
    let body = call(&logseq, &snapshots(), json!({"page": "Project Atlas"})).await.unwrap();
    assert_eq!((ids(&body), body["hasMore"].clone(), body.get("nextCursor").is_none(), body["warnings"].clone()), (vec![ROOT], json!(false), true, json!([])));

    let world = star(10, 10);
    let logseq = logseq_holding(&world).await;
    let body = call(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_depth": 0})).await.unwrap();
    assert_eq!((ids(&body), methods(&logseq).len()), (vec![ROOT], 1));
    assert!(body.get("nextCursor").is_none());
}

// ---- the rules of the walk, beside the cursor

#[tokio::test]
async fn a_rule_that_left_pages_out_keeps_truncated_and_offers_its_raise_while_has_more_is_the_cursors_alone() {
    // 8 neighbours with a fanout of 5: 3 are left out by the rule, and the 6 pages kept fit one page of 100
    let world = star(8, 10);
    let logseq = logseq_holding(&world).await;
    let body = call(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 100, "max_fanout": 5})).await.unwrap();
    assert_eq!((ids(&body).len(), body["truncated"].clone(), body["hasMore"].clone()), (6, json!(true), json!(false)));
    assert!(body.get("nextCursor").is_none());
    assert_eq!(warning_codes(&body), ["network_truncated"]);
    let warning = &body["warnings"][0];
    assert!(warning["message"].as_str().unwrap().contains("at least 3 more connected pages were dropped"), "{warning}");
    let raise = warning["howToFetchAll"].as_str().unwrap();
    assert!(raise.starts_with("Set max_fanout higher (max 100)"), "{raise}");
    assert!(!raise.contains("fit"), "the raise does not claim the larger result fits: {raise}");

    // with a page size of 3 the same walk has a cursor too, and the two ways sit side by side in two warnings
    let first = call(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 3, "max_fanout": 5})).await.unwrap();
    assert_eq!((first["hasMore"].clone(), first["truncated"].clone()), (json!(true), json!(true)));
    assert_eq!(warning_codes(&first), ["network_truncated", "pages_truncated"]);
    assert!(first["warnings"][0]["howToFetchAll"].as_str().unwrap().starts_with("Set max_fanout higher"));
    assert!(first["warnings"][1]["howToFetchAll"].as_str().unwrap().starts_with(NEXT_PAGE));
    // the last page still says the walk was cut by a rule, with the raise, and no cursor
    let last = call(&logseq, &snapshots(), json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!((last["hasMore"].clone(), last["truncated"].clone(), warning_codes(&last)), (json!(false), json!(true), vec!["network_truncated".to_owned()]));
}

#[tokio::test]
async fn a_hub_reached_by_expand_journals_is_read_to_the_end_and_truncated_stays_true() {
    // the root links a journal that links 60 pages: with expand_journals it is walked through, and the fanout of 15 leaves 45 out
    let world: World = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut world = world.lock().unwrap();
        world.insert(ROOT, vec![Link { to: 500, name: "Jan 1st, 2025".to_owned(), count: 1, journal: true }]);
        world.insert(500, (0..60).map(|n| link(1000 + n, &name_of(n, 5), 1)).collect());
    }
    let logseq = logseq_holding(&world).await;
    let (pages, count) = read_to_the_end(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_depth": 2, "max_nodes": 5, "expand_journals": true})).await;
    assert_eq!(count, 4, "the root, the journal and 15 pages: 17 pages, 5 to a page");
    assert_eq!(pages.iter().flat_map(ids).count(), 17);
    assert!(pages.iter().all(|page| page["truncated"] == true));
    assert!(pages.last().unwrap().get("nextCursor").is_none());
    assert_eq!(methods(&logseq).len(), 3, "the resolver and two depths, read once");
    // the depth labels never change between pages
    let depths: Vec<i64> = pages.iter().flat_map(|page| page["nodes"].as_array().unwrap().clone()).map(|node| node["depth"].as_i64().unwrap()).collect();
    assert_eq!(depths[..2], [0, 1]);
    assert!(depths[2..].iter().all(|depth| *depth == 2));
}

#[tokio::test]
async fn an_edge_between_pages_sent_on_different_pages_arrives_with_the_later_one() {
    // the root links 3 pages, and the first of them links the third: that edge is on the page of the third
    let world = star(3, 5);
    world.lock().unwrap().insert(1000, vec![link(1002, &name_of(2, 5), 2)]);
    let logseq = logseq_holding(&world).await;
    let shared = snapshots();
    let first = call(&logseq, &shared, json!({"page": "Project Atlas", "max_depth": 2, "max_nodes": 2})).await.unwrap();
    assert_eq!((ids(&first), edges(&first)), (vec![ROOT, 1000], vec![(ROOT, 1000)]));
    let second = call(&logseq, &shared, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!(ids(&second), [1001, 1002]);
    // the edge from the first page's page to 1002 rides with 1002, the later of its two ends
    assert_eq!(edges(&second), [(ROOT, 1001), (ROOT, 1002), (1000, 1002)]);
}

// ---- the format rides in the token

#[tokio::test]
async fn a_markdown_walk_is_read_to_the_end_with_each_page_in_markdown_and_its_own_footer() {
    let world = star(90, 10);
    let logseq = logseq_holding(&world).await;
    let shared = snapshots();
    let mut text = call_text(&logseq, &shared, json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100, "format": "markdown"})).await.unwrap();
    let mut pages = 1;
    loop {
        assert!(!text.starts_with('{'), "markdown stays markdown: {}", &text[..text.len().min(200)]);
        let Some(token) = text.lines().find_map(|line| line.trim().strip_prefix("nextCursor: ")).map(str::to_owned) else { break };
        assert!(text.contains("---") && text.contains("hasMore: true"), "a page with a cursor has its own footer");
        text = call_text(&logseq, &shared, json!({"cursor": token})).await.unwrap();
        pages += 1;
        assert!(pages < 10);
    }
    assert_eq!(pages, 3);
    assert!(!text.contains("hasMore: true"), "the last page has no more");
    assert_eq!(methods(&logseq).len(), 2);
}

// ---- an aliased root, snippets and roll-ups across pages

#[tokio::test]
async fn an_aliased_root_is_one_node_and_names_its_aliases_on_every_page_and_a_miss_makes_the_same_three_calls() {
    let world = star(90, 10);
    let logseq = logseq_holding_an_aliased_root(&world).await;
    let shared = snapshots();
    let first = call(&logseq, &shared, json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100})).await.unwrap();
    // the resolver, the alias group, and the one grouped query of depth 1
    assert_eq!(methods(&logseq).len(), 3);
    assert!(args_of(&logseq, 2)[0].as_str().unwrap().contains("[(ground [[10 10] [11 10]]) [[?source ?group] ...]]"));
    assert_eq!(first["resolvedAliases"], json!(["Atlas", "Project Atlas"]));
    assert_eq!(ids(&first).len(), 40);

    // a hit: nothing asked, the aliases ride on the page
    let second = call(&logseq, &shared, json!({"cursor": cursor_of(&first)})).await.unwrap();
    assert_eq!((methods(&logseq).len(), second["resolvedAliases"].clone()), (3, json!(["Atlas", "Project Atlas"])));
    // a miss: the first page's three calls again, with the same inputs
    let third = call(&logseq, &Snapshots::new(77), json!({"cursor": cursor_of(&second)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 6);
    assert_eq!((args_of(&logseq, 3), args_of(&logseq, 4), args_of(&logseq, 5)), (args_of(&logseq, 0), args_of(&logseq, 1), args_of(&logseq, 2)));
    assert_eq!(third["resolvedAliases"], json!(["Atlas", "Project Atlas"]));
    assert_eq!(ids(&third), neighbour_ids(1079, 11));
    // the alias group is one node: the stub is not a page of the walk
    assert!(ids(&first).iter().chain(&ids(&second)).chain(&ids(&third)).all(|id| *id != 11));
}

#[tokio::test]
async fn with_snippets_the_snippet_rides_on_the_page_that_carries_the_edge_of_the_root() {
    let world = star(90, 10);
    let logseq = logseq_holding(&world).await;
    let shared = snapshots();
    let first = call(&logseq, &shared, json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100, "with_snippets": true})).await.unwrap();
    let second = call(&logseq, &shared, json!({"cursor": cursor_of(&first)})).await.unwrap();
    for (page, first_id) in [(&first, 1000), (&second, 1039)] {
        let edges = page["edges"].as_array().unwrap();
        assert!(!edges.is_empty());
        // every edge of the root is on the page of its other end, with that page's own snippet
        for edge in edges {
            let to = edge["to"].as_i64().unwrap();
            assert!(to >= first_id, "{edge}");
            assert_eq!(edge["snippet"], format!("Note on {}", name_of(to - 1000, 10)));
        }
    }
    assert_eq!(first["edges"].as_array().unwrap().len() + second["edges"].as_array().unwrap().len(), 79);
    assert_eq!(methods(&logseq).len(), 2, "snippets ride in the same calls, and the second page is a hit");
}

#[tokio::test]
async fn the_roll_up_warning_of_a_later_page_names_only_the_roll_ups_on_it() {
    // 60 topical pages and two roll-ups, which rank after every topical page: the last two pages of the walk
    let world = star(60, 10);
    world.lock().unwrap().get_mut(&ROOT).unwrap().extend([link(2000, "Hub A", 1), link(2001, "Hub B", 1)]);
    let logseq = logseq_holding(&world).await;
    let shared = snapshots();
    let first = call(&logseq, &shared, json!({"page": "Project Atlas", "max_depth": 2, "max_nodes": 31, "max_fanout": 100})).await.unwrap();
    assert!(!warning_codes(&first).contains(&"hub_pages_not_expanded".to_owned()), "no roll-up is on the first page");
    let second = call(&logseq, &shared, json!({"cursor": cursor_of(&first)})).await.unwrap();
    let third = call(&logseq, &shared, json!({"cursor": cursor_of(&second)})).await.unwrap();
    let message = |page: &Value| page["warnings"].as_array().unwrap().iter().find(|w| w["code"] == "hub_pages_not_expanded").map(|w| w["message"].as_str().unwrap().to_owned());
    let on_second = message(&second).expect("Hub A is on the second page");
    assert!(on_second.starts_with("1 page links more than 30 pages") && on_second.contains("Hub A (41 pages)") && !on_second.contains("Hub B"), "{on_second}");
    let on_third = message(&third).expect("Hub B is on the third page");
    assert!(on_third.contains("Hub B (41 pages)") && !on_third.contains("Hub A"), "{on_third}");
    assert!(ids(&second).contains(&2000) && ids(&third) == [2001]);
    assert!(third.get("nextCursor").is_none());
}

// ---- what a token may be

fn good_args() -> Value {
    json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100})
}

fn token(change: &dyn Fn(&mut Cursor)) -> String {
    let mut cursor = Cursor::new(explore_network::NAME, good_args().as_object().cloned().unwrap(), Position::Index { at: 40 }, Anchor::Id(1038), SnapshotKey { started: 1, n: 1 });
    change(&mut cursor);
    encode(&cursor)
}

#[tokio::test]
async fn a_token_that_is_not_one_of_this_tools_is_refused_before_any_call() {
    let world = star(5, 10);
    let logseq = logseq_holding(&world).await;
    let tokens = [
        ("not base64", "this is not a token!".to_owned()),
        ("base64 of text", "bm90IGEgY3Vyc29y".to_owned()),
        ("an empty one", String::new()),
        ("another tool's", token(&|cursor| cursor.tool = "logseq_find_blocks".to_owned())),
        ("an unknown version", token(&|cursor| cursor.v = 2)),
        ("sections position", token(&|cursor| cursor.position = Position::Sections { blocks: 1, references: 0, related: 0 })),
        ("a text anchor", token(&|cursor| cursor.anchor = Anchor::Text("1038".into()))),
        ("arguments no walk takes", token(&|cursor| cursor.args = json!({"page": "Project Atlas", "max_depth": "deep"}).as_object().cloned().unwrap())),
        ("no page in the arguments", token(&|cursor| cursor.args = json!({"max_depth": 1}).as_object().cloned().unwrap())),
        ("a path in the arguments", token(&|cursor| cursor.args = json!({"page": "Project Atlas", "to": "Bob"}).as_object().cloned().unwrap())),
        ("arguments that hold a cursor", token(&|cursor| cursor.args = json!({"page": "Project Atlas", "cursor": "abc"}).as_object().cloned().unwrap())),
    ];
    for (what, bad) in tokens {
        let error = call(&logseq, &snapshots(), json!({"cursor": bad})).await.unwrap_err();
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == "cursor"), "{what}: {error}");
        assert!(error.to_string().starts_with("Invalid parameter 'cursor': "), "{what}: {error}");
    }
    assert!(methods(&logseq).is_empty(), "a bad token costs no LogSeq call");
    let error = call(&logseq, &snapshots(), json!({"cursor": token(&|cursor| cursor.tool = "logseq_find_pages".to_owned())})).await.unwrap_err();
    assert!(error.to_string().contains("made by another tool") && error.to_string().contains("a result of logseq_explore_network"), "{error}");
    // a cursor of this tool is read
    assert!(call(&logseq, &snapshots(), json!({"cursor": token(&|_| {})})).await.is_ok());
}

#[tokio::test]
async fn a_cursor_with_any_other_argument_is_refused_before_any_call_and_names_it() {
    let world = star(5, 10);
    let logseq = logseq_holding(&world).await;
    let cursor = token(&|_| {});
    for (param, value) in [
        ("page", json!("Project Atlas")),
        ("name", json!("Project Atlas")),
        ("to", json!("Bob")),
        ("max_depth", json!(1)),
        ("max_nodes", json!(40)),
        ("max_fanout", json!(5)),
        ("expand_journals", json!(true)),
        ("with_snippets", json!(true)),
        ("format", json!("markdown")),
    ] {
        let mut args = json!({"cursor": cursor});
        args[param] = value;
        let error = call(&logseq, &snapshots(), args).await.unwrap_err();
        let named = if param == "name" { "page" } else { param };
        assert!(matches!(&error, ToolError::InvalidParameter(invalid) if invalid.param == named), "{param}: {error}");
        assert!(error.to_string().contains("left out when cursor is given"), "{param}: {error}");
    }
    assert!(methods(&logseq).is_empty(), "a refusal costs no call");
    // a null is no argument, and an unknown field is ignored, as everywhere
    assert!(call(&logseq, &snapshots(), json!({"cursor": cursor, "max_depth": null, "offset": 3})).await.is_ok());
}

#[tokio::test]
async fn a_call_with_neither_a_page_nor_a_cursor_is_refused_before_any_call() {
    let world = star(5, 10);
    let logseq = logseq_holding(&world).await;
    let error = call(&logseq, &snapshots(), json!({"max_depth": 1})).await.unwrap_err();
    assert_eq!(error.to_string(), "Invalid parameter 'page': missing\n\nExpected: a string (required unless cursor is given)\nExample: page: \"...\"");
    assert!(methods(&logseq).is_empty());
}

#[tokio::test]
async fn a_snapshot_is_never_served_to_a_token_that_holds_other_arguments() {
    let world = star(90, 10);
    let logseq = logseq_holding(&world).await;
    let shared = snapshots();
    let first = call(&logseq, &shared, json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100})).await.unwrap();
    // the same snapshot key, with the walk changed in the token: it is a miss, never the other walk
    let mut cursor = decode(&cursor_of(&first), explore_network::NAME).unwrap();
    cursor.args.insert("max_fanout".into(), json!(15));
    let body = call(&logseq, &shared, json!({"cursor": encode(&cursor)})).await.unwrap();
    assert_eq!(methods(&logseq).len(), 4, "the other walk read LogSeq");
    assert!(body["truncated"] == true);
}

#[tokio::test]
async fn a_token_that_holds_a_position_past_the_end_is_an_empty_last_page_and_never_a_panic() {
    let world = star(5, 10);
    let logseq = logseq_holding(&world).await;
    let cursor = token(&|cursor| cursor.position = Position::Index { at: usize::MAX });
    let body = call(&logseq, &snapshots(), json!({"cursor": cursor})).await.unwrap();
    assert_eq!(warning_codes(&body), ["cursor_stale"]);
    assert_eq!(body["nodes"], json!([]));
    assert!(body.get("nextCursor").is_none());
}

#[tokio::test]
async fn the_snapshot_key_of_another_process_is_a_miss_and_a_page_is_still_read() {
    let world = star(90, 10);
    let logseq = logseq_holding(&world).await;
    let first = call(&logseq, &snapshots(), json!({"page": "Project Atlas", "max_depth": 1, "max_nodes": 40, "max_fanout": 100})).await.unwrap();
    let mut cursor = decode(&cursor_of(&first), explore_network::NAME).unwrap();
    cursor.snapshot = SnapshotKey { started: 5, n: 1 };
    let second = call(&logseq, &snapshots(), json!({"cursor": encode(&cursor)})).await.unwrap();
    assert_eq!((methods(&logseq).len(), ids(&second).len()), (4, 40));
}

// ---- errors

#[tokio::test]
async fn a_logseq_error_on_a_miss_is_an_error_and_not_an_empty_page() {
    // nothing answers: the call fails, as the first page would
    let logseq = mock_logseq(vec![]).await;
    let error = call(&logseq, &snapshots(), json!({"cursor": token(&|_| {})})).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn a_missing_page_on_a_miss_is_the_not_found_error_of_the_first_page() {
    let logseq = mock_logseq(vec![json!([]), json!([]), json!([{"originalName": "Project Atlas"}])]).await;
    let error = call(&logseq, &snapshots(), json!({"cursor": token(&|_| {})})).await.unwrap_err();
    assert!(matches!(&error, ToolError::PageNotFound(_)), "{error}");
}

#[tokio::test]
async fn a_null_answer_for_a_depth_on_a_miss_is_the_links_unavailable_warning_and_no_cursor() {
    let logseq = mock_logseq(vec![root_page(), json!(null)]).await;
    let body = call(&logseq, &snapshots(), json!({"cursor": token(&|_| {})})).await.unwrap();
    // the walk is the root alone, so the position is past it: an empty last page that says the walk moved, and the unavailable depth
    assert_eq!(body["nodes"], json!([]));
    assert_eq!(warning_codes(&body), ["cursor_stale", "links_unavailable"]);
    assert_eq!((body["hasMore"].clone(), body.get("nextCursor").is_none()), (json!(false), true));
}
