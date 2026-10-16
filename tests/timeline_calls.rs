//! The LogSeq traffic of `logseq_explore_timeline` against a mock LogSeq on a local port: how many calls it makes, in
//! which order and with which inputs, for a period alone and for a page. The call counts are those in `docs/performance.md`
//! ("Current Implementation Status"); the parity harness (`parity.rs`) checks the same calls and the result bytes against
//! the recorded results. Every page and block here is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq, uuid};
use logseq_mcp_server::args::YyyyMmDd;
use logseq_mcp_server::dates::{CalendarDate, DatePreset};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::explore_timeline::{Args, GroupBy, explore_timeline};
use serde_json::{Value, json};

/// Tuesday 2025-03-11, the local day the parity harness fixes.
const TODAY: CalendarDate = CalendarDate { year: 2025, month: 3, day: 11 };

const DATALOG: &str = "logseq.DB.datascriptQuery";
const TREE: &str = "logseq.Editor.getPageBlocksTree";
const GET_PAGE: &str = "logseq.Editor.getPage";

fn args() -> Args {
    Args {
        page: None,
        start_date: None,
        end_date: None,
        last_n: None,
        preset: None,
        group_by: None,
        slim_results: true,
        include_content: true,
        top_concepts_limit: 10,
        resolve_refs: false,
        max_blocks: 200,
        cursor: None,
    }
}

fn range(start: i64, end: i64) -> Args {
    Args { start_date: Some(YyyyMmDd(start)), end_date: Some(YyyyMmDd(end)), ..args() }
}

fn of_page(name: &str) -> Args {
    Args { page: Some(name.to_owned()), ..args() }
}

fn journal(id: i64, day: i64) -> Value {
    json!([{"id": id, "uuid": uuid(id), "name": format!("day {day}"), "original-name": format!("Day {day}"), "journal-day": day}])
}

fn block(id: i64, page: i64, content: &str) -> Value {
    json!([{"id": id, "uuid": uuid(id), "content": content, "page": {"id": page}, "parent": {"id": page}, "left": {"id": page}}])
}

/// The inputs of request `n`, the EDN text the client sent for each.
fn inputs(logseq: &common::MockLogseq, n: usize) -> Vec<String> {
    args_of(logseq, n)[1..].iter().map(|input| input.as_str().expect("an input is sent as text").to_owned()).collect()
}

fn result_of(json: &str) -> Value {
    serde_json::from_str(json).unwrap()
}

fn codes(result: &Value) -> Vec<&str> {
    result["warnings"].as_array().map(|warnings| warnings.iter().map(|warning| warning["code"].as_str().unwrap()).collect()).unwrap_or_default()
}

// ---- a period alone

#[tokio::test]
async fn a_range_costs_two_calls_whatever_its_length() {
    let logseq = mock_logseq(vec![json!([journal(1, 20250101), journal(2, 20250102)]), json!([block(11, 1, "a"), block(12, 2, "b")])]).await;
    let found = explore_timeline(&client(&logseq), &range(20250101, 20250131), TODAY).await.unwrap();
    assert_eq!(methods(&logseq), [DATALOG, DATALOG]);
    assert_eq!(inputs(&logseq, 0), ["20250101", "20250131"]);
    assert_eq!(inputs(&logseq, 1), ["20250101", "20250131"]);
    let result = result_of(&found.json);
    assert_eq!(result["summary"]["totalDays"], 2);
    assert_eq!(result["dateRange"], json!({"start": 20250101, "end": 20250131}));
    assert!(result.get("page").is_none());
}

#[tokio::test]
async fn a_range_with_no_journal_makes_one_call_and_never_asks_for_blocks() {
    let logseq = mock_logseq(vec![json!([])]).await;
    let found = explore_timeline(&client(&logseq), &range(20250101, 20250107), TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    assert_eq!(result_of(&found.json)["entries"], json!([]));
}

#[tokio::test]
async fn last_n_is_the_last_n_calendar_days_in_the_two_calls_of_a_range_and_lists_the_newest_first() {
    let logseq = mock_logseq(vec![json!([journal(1, 20250311), journal(3, 20250310)]), json!([])]).await;
    let found = explore_timeline(&client(&logseq), &Args { last_n: Some(2), ..args() }, TODAY).await.unwrap();
    // today and the day before, whether or not each has a journal: no query for which journals exist
    assert_eq!(methods(&logseq), [DATALOG, DATALOG]);
    assert_eq!(inputs(&logseq, 0), ["20250310", "20250311"]);
    assert_eq!(inputs(&logseq, 1), ["20250310", "20250311"]);
    let result = result_of(&found.json);
    assert_eq!(result["dateRange"], json!({"start": 20250310, "end": 20250311}));
    let dates: Vec<&Value> = result["entries"].as_array().unwrap().iter().map(|entry| &entry["date"]).collect();
    assert_eq!(dates, [&json!(20250311), &json!(20250310)]);
}

#[tokio::test]
async fn a_preset_is_resolved_against_today_before_the_call() {
    let logseq = mock_logseq(vec![json!([])]).await;
    explore_timeline(&client(&logseq), &Args { preset: Some(DatePreset::LastWeek), ..args() }, TODAY).await.unwrap();
    assert_eq!(inputs(&logseq, 0), ["20250303", "20250309"]);
}

#[tokio::test]
async fn a_call_with_neither_a_page_nor_a_period_or_a_bad_one_makes_no_call() {
    let logseq = mock_logseq(vec![]).await;
    let bad = [
        args(),
        Args { last_n: Some(1), preset: Some(DatePreset::Today), ..args() },
        range(20250107, 20250101),
        range(2025, 20250101),
        Args { start_date: Some(YyyyMmDd(20250101)), ..args() },
        of_page("  "),
    ];
    for bad in bad {
        let error = explore_timeline(&client(&logseq), &bad, TODAY).await.unwrap_err();
        assert!(matches!(error, ToolError::InvalidParameter(_)), "{error}");
    }
    assert!(methods(&logseq).is_empty());
    let error = explore_timeline(&client(&logseq), &args(), TODAY).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "Invalid parameter 'page or period': none given\n\nExpected: A page, or a period (start_date with end_date, last_n or preset), or both\n\
         Example: page: \"Project Atlas\", or last_n: 7, or page: \"Project Atlas\" with preset: \"last_month\""
    );
}

#[tokio::test]
async fn resolve_refs_adds_at_most_the_levels_of_refs_and_none_when_no_block_has_one() {
    let logseq = mock_logseq(vec![json!([journal(1, 20250101)]), json!([block(11, 1, "no ref here")])]).await;
    let found = explore_timeline(&client(&logseq), &Args { resolve_refs: true, ..range(20250101, 20250101) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
    let result = result_of(&found.json);
    assert_eq!((&result["hasMore"], &result["warnings"]), (&json!(false), &json!([])));

    let reference = format!("see (({}))", uuid(777));
    let logseq = mock_logseq(vec![
        json!([journal(1, 20250101)]),
        json!([block(11, 1, &reference)]),
        json!([[{"id": 777, "uuid": uuid(777), "content": "the target", "page": {"id": 5}}]]),
    ])
    .await;
    let found = explore_timeline(&client(&logseq), &Args { resolve_refs: true, ..range(20250101, 20250101) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
    assert!(found.json.contains("\"resolvedContent\":\"see the target\""), "{}", found.json);
}

#[tokio::test]
async fn the_outline_never_resolves_refs() {
    let reference = format!("see (({}))", uuid(777));
    let logseq = mock_logseq(vec![json!([journal(1, 20250101)]), json!([block(11, 1, &reference)])]).await;
    explore_timeline(&client(&logseq), &Args { resolve_refs: true, include_content: false, ..range(20250101, 20250101) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
}

#[tokio::test]
async fn a_null_answer_is_a_warning_and_never_an_empty_range() {
    let logseq = mock_logseq(vec![Value::Null]).await;
    let found = explore_timeline(&client(&logseq), &range(20250101, 20250103), TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    assert_eq!(result_of(&found.json)["warnings"][0]["code"], "journals_unavailable");

    let logseq = mock_logseq(vec![json!([journal(1, 20250101)]), Value::Null]).await;
    let found = explore_timeline(&client(&logseq), &range(20250101, 20250103), TODAY).await.unwrap();
    let result = result_of(&found.json);
    assert_eq!(result["warnings"][0]["code"], "blocks_unavailable");
    // the day is still an entry, with no blocks, which is what the warning is for
    assert_eq!(result["entries"][0]["blocks"], json!([]));
}

#[tokio::test]
async fn a_failed_call_is_an_error_and_never_an_empty_result() {
    let logseq = mock_logseq(vec![]).await;
    let error = explore_timeline(&client(&logseq), &range(20250101, 20250103), TODAY).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn group_by_week_joins_the_days_of_a_week_after_the_cut_and_costs_no_call() {
    let logseq = mock_logseq(vec![
        json!([journal(1, 20250106), journal(2, 20250107), journal(3, 20250115)]),
        json!([block(11, 1, "a"), block(12, 2, "b"), block(13, 3, "c")]),
    ])
    .await;
    let found = explore_timeline(&client(&logseq), &Args { group_by: Some(GroupBy::Week), ..range(20250101, 20250131) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
    let result = result_of(&found.json);
    let periods: Vec<&Value> = result["entries"].as_array().unwrap().iter().map(|entry| &entry["period"]).collect();
    assert_eq!(periods, [&json!("2025-W01"), &json!("2025-W03")]);
    // the blocks of a week each say their page, since the entry names none
    let first = &result["entries"][0]["blocks"];
    assert_eq!(first.as_array().unwrap().len(), 2);
    assert_eq!(first[0]["pageName"], "Day 20250106");
    assert_eq!(first[1]["pageName"], "Day 20250107");
    assert_eq!(result["summary"]["totalDays"], 3);
}

// ---- a page

fn root() -> Value {
    json!([[{"id": 10, "uuid": uuid(10), "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 5010}}, "name"]])
}

fn aliased_root() -> Vec<Value> {
    vec![
        json!([[{"id": 10, "uuid": uuid(10), "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 5010}, "alias": [{"id": 11}]}, "name"]]),
        json!([[10, {"id": 10, "name": "project atlas", "original-name": "Project Atlas"}], [10, {"id": 11, "name": "atlas", "original-name": "Atlas"}]]),
    ]
}

fn tree_block(id: i64) -> Value {
    json!({"id": id, "uuid": uuid(id), "content": "On the page", "page": {"id": 10}})
}

fn mention(id: i64, page_id: i64, day: i64) -> Value {
    json!([{"id": id, "uuid": uuid(id), "content": "Mentions [[Project Atlas]]", "page": {"id": page_id, "name": format!("day {day}"), "original-name": format!("Day {day}"), "journal-day": day}}])
}

/// A mention on a page that is not a journal.
fn undated_mention(id: i64) -> Value {
    json!([{"id": id, "uuid": uuid(id), "content": "Notes on [[Project Atlas]]", "page": {"id": 20, "name": "bob", "original-name": "Bob"}}])
}

fn editor_page() -> Value {
    json!({"id": 10, "name": "project atlas", "originalName": "Project Atlas"})
}

fn tree() -> Value {
    json!([tree_block(101), tree_block(103)])
}

async fn about_a_page(answers: Vec<Value>, args: Args) -> (Value, common::MockLogseq) {
    let logseq = mock_logseq(answers).await;
    let found = explore_timeline(&client(&logseq), &args, TODAY).await.unwrap();
    (result_of(&found.json), logseq)
}

#[tokio::test]
async fn an_exact_name_costs_four_calls_the_resolver_the_tree_the_page_and_the_mentions() {
    let answers = vec![root(), json!([tree_block(101)]), editor_page(), json!([mention(201, 31, 20250310), mention(202, 30, 20250101)])];
    let (result, logseq) = about_a_page(answers, of_page("  Project Atlas ")).await;

    assert_eq!(methods(&logseq), [DATALOG, TREE, GET_PAGE, DATALOG]);
    assert_eq!(args_of(&logseq, 0)[1], "\"project atlas\"");
    // the Editor calls get the name as typed, trimmed; the query gets it lowercased, bound
    assert_eq!(args_of(&logseq, 1), [json!("Project Atlas")]);
    assert_eq!(args_of(&logseq, 2), [json!("Project Atlas")]);
    assert_eq!(args_of(&logseq, 3)[1], "\"project atlas\"");
    assert!(!args_of(&logseq, 3)[0].as_str().unwrap().contains("atlas"));
    // oldest first, the page's own undated block last
    let dates: Vec<&Value> = result["entries"].as_array().unwrap().iter().map(|entry| &entry["date"]).collect();
    assert_eq!(dates, [&json!(20250101), &json!(20250310), &json!(null)]);
    assert_eq!(result["page"], "  Project Atlas ");
    assert_eq!(result["dateRange"], json!({"start": 20250101, "end": 20250310}));
    // a day names its page; the blocks with no day each name theirs
    assert_eq!(result["entries"][0]["pageName"], "Day 20250101");
    assert_eq!(result["entries"][2]["blocks"][0]["pageName"], "Project Atlas");
    assert!(result["entries"][2].get("pageName").is_none());
    assert_eq!(result["summary"]["totalDays"], 2);
    assert_eq!(result["summary"]["totalBlocks"], 3);
}

#[tokio::test]
async fn a_page_with_aliases_adds_the_alias_query_and_reads_the_group_with_one_mentions_query() {
    let mut answers = aliased_root();
    answers.extend([json!([]), editor_page(), json!([])]);
    let (result, logseq) = about_a_page(answers, of_page("Project Atlas")).await;

    assert_eq!(methods(&logseq), [DATALOG, DATALOG, TREE, GET_PAGE, DATALOG]);
    let query = args_of(&logseq, 4)[0].as_str().unwrap().to_owned();
    // references to either name, and the blocks of the pages that are not the one asked about
    assert!(query.contains("(and [(ground [10 11]) [?ref ...]] [?block :block/refs ?ref])"), "{query}");
    assert!(query.contains("(and [(ground [11]) [?own ...]] [?block :block/page ?own])"), "{query}");
    assert_eq!(result["resolvedAliases"], json!(["Atlas", "Project Atlas"]));
}

#[tokio::test]
async fn a_period_bounds_the_days_and_leaves_out_what_has_none() {
    let answers = vec![root(), tree(), editor_page(), json!([mention(201, 31, 20250310), mention(202, 30, 20250101), undated_mention(203)])];
    let (result, logseq) = about_a_page(answers, Args { start_date: Some(YyyyMmDd(20250301)), end_date: Some(YyyyMmDd(20250331)), ..of_page("Project Atlas") }).await;
    // the calls are the same: the period is applied to what was fetched
    assert_eq!(methods(&logseq), [DATALOG, TREE, GET_PAGE, DATALOG]);
    let dates: Vec<&Value> = result["entries"].as_array().unwrap().iter().map(|entry| &entry["date"]).collect();
    assert_eq!(dates, [&json!(20250310)]);
    assert_eq!(result["dateRange"], json!({"start": 20250301, "end": 20250331}));
    assert_eq!(result["summary"]["totalBlocks"], 1);
}

#[tokio::test]
async fn a_journal_page_asked_by_its_date_is_dated_by_its_own_day() {
    let journal_page = json!({"id": 30, "name": "jan 1st, 2025", "originalName": "Jan 1st, 2025", "journal?": true, "journalDay": 20250101});
    let answers = vec![root(), json!([tree_block(101)]), journal_page, json!([])];
    let (result, _) = about_a_page(answers, Args { start_date: Some(YyyyMmDd(20250101)), end_date: Some(YyyyMmDd(20250101)), ..of_page("Project Atlas") }).await;
    // the page's own block is on the journal day, so it is inside the period
    assert_eq!(result["entries"][0]["date"], 20250101);
    assert_eq!(result["entries"][0]["blocks"][0]["uuid"], uuid(101));
}

#[tokio::test]
async fn what_the_mentions_link_is_rolled_up_without_the_page_or_its_aliases() {
    let linking = |id: i64, day: i64| {
        json!([{"id": id, "uuid": uuid(id), "content": "x", "page": {"id": 30, "name": format!("day {day}"), "journal-day": day},
                "refs": [{"id": 10, "name": "project atlas", "original-name": "Project Atlas"}, {"id": 11, "name": "atlas", "original-name": "Atlas"},
                         {"id": 50, "name": "alice", "original-name": "Alice"}, {"id": 30, "name": format!("day {day}"), "journal?": true}]}])
    };
    let mut answers = aliased_root();
    answers.extend([json!([]), editor_page(), json!([linking(201, 20250101), linking(202, 20250102)])]);
    let (result, _) = about_a_page(answers, of_page("Project Atlas")).await;
    assert_eq!(result["summary"]["topConcepts"], json!([{"name": "Alice", "count": 2, "days": 2}]));
    // the blocks are as LogSeq sent them, without the refs the roll-up read
    let full = {
        let mut answers = aliased_root();
        answers.extend([json!([]), editor_page(), json!([linking(201, 20250101)])]);
        about_a_page(answers, Args { slim_results: false, ..of_page("Project Atlas") }).await.0
    };
    assert!(full["entries"][0]["blocks"][0].get("refs").is_none());
}

#[tokio::test]
async fn with_a_zero_limit_there_is_no_roll_up() {
    let answers = vec![root(), tree(), editor_page(), json!([])];
    let (result, logseq) = about_a_page(answers, Args { top_concepts_limit: 0, ..of_page("Project Atlas") }).await;
    assert!(result["summary"].get("topConcepts").is_none());
    // nothing reads the refs, so the mentions query does not pull them
    assert!(!args_of(&logseq, 3)[0].as_str().unwrap().contains(":block/refs [:db/id"));
}

#[tokio::test]
async fn max_blocks_cuts_the_page_in_order_with_the_undated_last_and_costs_no_call() {
    let mentions: Vec<Value> = (0..5).map(|i| mention(300 + i, 40 + i, 20250301 + i)).collect();
    let answers = vec![root(), tree(), editor_page(), Value::Array(mentions)];
    let (result, logseq) = about_a_page(answers, Args { max_blocks: 3, ..of_page("Project Atlas") }).await;
    assert_eq!(methods(&logseq).len(), 4);
    assert_eq!(result["entries"].as_array().unwrap().len(), 3);
    assert_eq!(result["summary"]["totalBlocks"], 7);
    assert_eq!(result["totals"], json!({"blocks": 7, "days": 5}));
    assert_eq!(codes(&result), ["blocks_truncated"]);
    // the undated blocks come after the five days, so this cut keeps days only
    assert_eq!(result["entries"][2]["date"], 20250303);
    assert_eq!(result["hasMore"], true);
    assert_eq!(result["warnings"][0]["howToFetchAll"], "Pass nextCursor as cursor, with no other argument, to read the next page.");
    assert!(result["nextCursor"].is_string());
}

#[tokio::test]
async fn group_by_week_joins_a_pages_days_and_keeps_the_blocks_with_no_day_as_their_own_entry() {
    let answers = vec![root(), tree(), editor_page(), json!([mention(201, 31, 20250106), mention(202, 32, 20250107), undated_mention(203)])];
    let (result, _) = about_a_page(answers, Args { group_by: Some(GroupBy::Week), ..of_page("Project Atlas") }).await;
    let entries = result["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["period"], "2025-W01");
    assert_eq!(entries[0]["blocks"].as_array().unwrap().len(), 2);
    assert_eq!(entries[1]["date"], json!(null));
    assert_eq!(entries[1]["blocks"].as_array().unwrap().len(), 3);
}

// BR-0011: a `null` is not an empty answer, and each lookup that can be `null` says which data is missing.
#[tokio::test]
async fn a_null_block_tree_is_a_page_blocks_unavailable_warning_and_the_mentions_still_count() {
    let (result, _) = about_a_page(vec![root(), json!(null), editor_page(), json!([mention(201, 31, 20250310)])], of_page("Project Atlas")).await;
    assert_eq!(codes(&result), ["page_blocks_unavailable"]);
    assert!(result["warnings"][0]["message"].as_str().unwrap().contains("This does not mean the page has no blocks."));
    assert!(result["warnings"][0].get("howToFetchAll").is_none());
    assert_eq!(result["summary"]["totalBlocks"], 1);
    // `hasMore`, `warnings` and no `totals`, as there was no cut
    assert_eq!(result["hasMore"], false);
    assert!(result.get("totals").is_none());
}

#[tokio::test]
async fn a_null_page_with_blocks_to_enrich_is_a_page_unavailable_warning_and_the_blocks_have_no_day() {
    let (result, _) = about_a_page(vec![root(), tree(), json!(null), json!([mention(201, 31, 20250310)])], of_page("Project Atlas")).await;
    assert_eq!(codes(&result), ["page_unavailable"]);
    assert!(result["warnings"][0]["message"].as_str().unwrap().contains("listed with the mentions that have none"));
    assert!(result["warnings"][0].get("howToFetchAll").is_none());
    // the tree's blocks keep their bare page and have no day
    let undated = result["entries"].as_array().unwrap().iter().find(|entry| entry["date"].is_null()).unwrap();
    let uuids: Vec<&Value> = undated["blocks"].as_array().unwrap().iter().map(|block| &block["uuid"]).collect();
    assert_eq!(uuids, [&json!(uuid(101)), &json!(uuid(103))]);
    assert_eq!(result["hasMore"], false);

    // an empty tree has nothing to enrich, so a null page says nothing
    let (empty, _) = about_a_page(vec![root(), json!([]), json!(null), json!([mention(201, 31, 20250310)])], of_page("Project Atlas")).await;
    assert_eq!(codes(&empty), Vec::<&str>::new());
}

#[tokio::test]
async fn a_null_mentions_answer_is_a_mentions_unavailable_warning_and_the_page_still_shows() {
    let (result, _) = about_a_page(vec![root(), tree(), editor_page(), json!(null)], of_page("Project Atlas")).await;
    assert_eq!(codes(&result), ["mentions_unavailable"]);
    assert!(result["warnings"][0]["message"].as_str().unwrap().contains("This does not mean nothing mentions it."));
    assert_eq!(result["summary"]["totalBlocks"], 2);
    assert_eq!(result["hasMore"], false);

    // a real [] is a page nothing mentions, and says nothing
    let (empty, _) = about_a_page(vec![root(), tree(), editor_page(), json!([])], of_page("Project Atlas")).await;
    assert_eq!(codes(&empty), Vec::<&str>::new());
}

#[tokio::test]
async fn the_unavailable_warnings_come_in_call_order_before_the_cut_and_beside_its_totals() {
    // a tree with blocks, a null page and null mentions: page before mentions
    let (result, _) = about_a_page(vec![root(), tree(), json!(null), json!(null)], of_page("Project Atlas")).await;
    assert_eq!(codes(&result), ["page_unavailable", "mentions_unavailable"]);

    // and with the cap biting, the cut follows them and `totals` appears with them
    let (result, _) = about_a_page(vec![root(), tree(), json!(null), json!(null)], Args { max_blocks: 1, ..of_page("Project Atlas") }).await;
    assert_eq!(codes(&result), ["page_unavailable", "mentions_unavailable", "blocks_truncated"]);
    assert_eq!(result["totals"]["blocks"], 2);
    // the cut falls among the blocks with no day: the cursor reads on
    assert_eq!(result["hasMore"], true);
}

#[tokio::test]
async fn when_everything_answers_null_the_page_lookup_adds_no_third_warning() {
    // no tree, so no blocks to enrich: two warnings, not three
    let (result, _) = about_a_page(vec![root(), json!(null), json!(null), json!(null)], of_page("Project Atlas")).await;
    assert_eq!(codes(&result), ["page_blocks_unavailable", "mentions_unavailable"]);
    assert_eq!(result["entries"], json!([]));
    assert_eq!(result["summary"]["totalBlocks"], 0);
}

#[tokio::test]
async fn a_null_answer_for_the_aliased_mentions_is_a_mentions_unavailable_warning_beside_the_alias_group() {
    let mut answers = aliased_root();
    answers.extend([tree(), editor_page(), json!(null)]);
    let (result, _) = about_a_page(answers, of_page("Project Atlas")).await;
    assert_eq!(codes(&result), ["mentions_unavailable"]);
    assert_eq!(result["resolvedAliases"], json!(["Atlas", "Project Atlas"]));
}

#[tokio::test]
async fn a_missing_page_or_an_infrastructure_error_is_not_a_warning() {
    let missing = mock_logseq(vec![json!([]), json!([]), json!([])]).await;
    let error = explore_timeline(&client(&missing), &of_page("Projct Atlas"), TODAY).await.unwrap_err();
    assert!(matches!(error, ToolError::PageNotFound(_)), "{error}");
    assert_eq!(methods(&missing).len(), 3);

    let failing = mock_logseq(vec![root(), json!([]), json!({"error": "Query timed out"})]).await;
    let error = explore_timeline(&client(&failing), &of_page("Project Atlas"), TODAY).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}

#[tokio::test]
async fn a_mention_with_no_week_stays_a_day_of_its_own_and_does_not_abort_the_call() {
    // a journal day of six digits (LogSeq sends eight) has no week; the dated one beside it does
    let answers = vec![root(), json!([]), editor_page(), json!([mention(301, 40, 202501), mention(302, 41, 20250101)])];
    let (result, _) = about_a_page(answers, Args { group_by: Some(GroupBy::Week), ..of_page("Project Atlas") }).await;
    assert_eq!(result["summary"]["totalBlocks"], 2);
    let entries = result["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2, "both days are listed");
    assert_eq!(entries[0]["date"], 202501);
    assert_eq!(entries[1]["period"], "2025-W01");
}
