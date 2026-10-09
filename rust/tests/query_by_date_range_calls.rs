//! The LogSeq traffic of `logseq_query_by_date_range` against a mock LogSeq on a local port: how
//! many calls it makes, in which order and with which inputs. The Rust side of the call counts in
//! `CLAUDE.md` ("Current Implementation Status"); the parity harness (`parity.rs`) checks
//! the same calls and the result bytes against the TypeScript server. Every page and block here
//! is made up (BR-0001).

mod common;

use common::{args_of, client, methods, mock_logseq};
use logseq_mcp_server::dates::{CalendarDate, DatePreset};
use logseq_mcp_server::errors::ToolError;
use logseq_mcp_server::tools::query_by_date_range::{Args, query_journals};
use serde_json::{Value, json};

/// Tuesday 2025-03-11, the local day the parity harness fixes.
const TODAY: CalendarDate = CalendarDate { year: 2025, month: 3, day: 11 };

fn args() -> Args {
    Args {
        start_date: None,
        end_date: None,
        last_n: None,
        preset: None,
        search_term: None,
        slim_results: true,
        include_content: true,
        top_concepts_limit: 10,
        resolve_refs: false,
        max_blocks: 200,
    }
}

fn range(start: i64, end: i64) -> Args {
    Args { start_date: Some(start), end_date: Some(end), ..args() }
}

fn page(id: i64, day: i64) -> Value {
    json!([{"id": id, "uuid": format!("00000000-0000-4000-8000-{id:012}"), "name": format!("day {day}"), "original-name": format!("Day {day}"), "journal-day": day}])
}

fn block(id: i64, page: i64, content: &str) -> Value {
    json!([{"id": id, "uuid": format!("00000000-0000-4000-8000-{id:012}"), "content": content, "page": {"id": page}, "parent": {"id": page}, "left": {"id": page}}])
}

/// The inputs of request `n`, the EDN text the client sent for each.
fn inputs(logseq: &common::MockLogseq, n: usize) -> Vec<String> {
    args_of(logseq, n)[1..].iter().map(|input| input.as_str().expect("an input is sent as text").to_owned()).collect()
}

fn result_of(json: &str) -> Value {
    serde_json::from_str(json).unwrap()
}

#[tokio::test]
async fn a_range_costs_two_calls_whatever_its_length() {
    let logseq = mock_logseq(vec![json!([page(1, 20250101), page(2, 20250102)]), json!([block(11, 1, "a"), block(12, 2, "b")])]).await;
    let found = query_journals(&client(&logseq), &range(20250101, 20250131), TODAY).await.unwrap();
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery", "logseq.DB.datascriptQuery"]);
    assert_eq!(inputs(&logseq, 0), ["20250101", "20250131"]);
    assert_eq!(inputs(&logseq, 1), ["20250101", "20250131"]);
    assert_eq!(result_of(&found.json)["summary"]["totalDays"], 2);
}

#[tokio::test]
async fn a_range_with_no_journal_makes_one_call_and_never_asks_for_blocks() {
    let logseq = mock_logseq(vec![json!([])]).await;
    let found = query_journals(&client(&logseq), &Args { search_term: Some("atlas".into()), ..range(20250101, 20250107) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    assert_eq!(result_of(&found.json)["entries"], json!([]));
}

#[tokio::test]
async fn a_search_term_adds_one_query_for_its_alias_group_and_an_empty_one_adds_none() {
    let logseq = mock_logseq(vec![json!([page(1, 20250101)]), json!([block(11, 1, "Atlas notes")]), json!([])]).await;
    let found = query_journals(&client(&logseq), &Args { search_term: Some("Atlas".into()), ..range(20250101, 20250101) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
    // the name is bound lowercase, as a JSON string
    assert_eq!(inputs(&logseq, 2), ["\"atlas\""]);
    assert_eq!(result_of(&found.json)["summary"]["totalBlocks"], 1);

    let logseq = mock_logseq(vec![json!([page(1, 20250101)]), json!([block(11, 1, "Atlas notes")])]).await;
    query_journals(&client(&logseq), &Args { search_term: Some(String::new()), ..range(20250101, 20250101) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
}

#[tokio::test]
async fn last_n_asks_for_the_pages_up_to_today_then_the_span_of_the_pages_kept() {
    let logseq = mock_logseq(vec![json!([page(1, 20250105), page(2, 20250102), page(3, 20250103)]), json!([])]).await;
    let found = query_journals(&client(&logseq), &Args { last_n: Some(2), ..args() }, TODAY).await.unwrap();
    assert_eq!(inputs(&logseq, 0), ["20250311"]);
    assert_eq!(inputs(&logseq, 1), ["20250103", "20250105"]);
    let result = result_of(&found.json);
    assert_eq!(result["dateRange"], json!({"start": 20250103, "end": 20250105}));
    let dates: Vec<&Value> = result["entries"].as_array().unwrap().iter().map(|entry| &entry["date"]).collect();
    assert_eq!(dates, [&json!(20250105), &json!(20250103)]);
}

#[tokio::test]
async fn a_preset_is_resolved_against_today_before_the_call() {
    let logseq = mock_logseq(vec![json!([])]).await;
    query_journals(&client(&logseq), &Args { preset: Some(DatePreset::LastWeek), ..args() }, TODAY).await.unwrap();
    assert_eq!(inputs(&logseq, 0), ["20250303", "20250309"]);
}

#[tokio::test]
async fn a_selection_that_is_refused_makes_no_call() {
    let logseq = mock_logseq(vec![]).await;
    for bad in [args(), Args { last_n: Some(1), preset: Some(DatePreset::Today), ..args() }, range(20250107, 20250101), range(2025, 20250101)] {
        let error = query_journals(&client(&logseq), &bad, TODAY).await.unwrap_err();
        assert!(matches!(error, ToolError::InvalidParameter(_)), "{error}");
    }
    assert!(methods(&logseq).is_empty());
}

#[tokio::test]
async fn resolve_refs_adds_at_most_the_levels_of_refs_and_none_when_no_block_has_one() {
    let logseq = mock_logseq(vec![json!([page(1, 20250101)]), json!([block(11, 1, "no ref here")])]).await;
    let found = query_journals(&client(&logseq), &Args { resolve_refs: true, ..range(20250101, 20250101) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
    let result = result_of(&found.json);
    assert_eq!((&result["hasMore"], &result["warnings"]), (&json!(false), &json!([])));

    let reference = format!("see (({}))", "00000000-0000-4000-8000-000000000777");
    let logseq = mock_logseq(vec![
        json!([page(1, 20250101)]),
        json!([block(11, 1, &reference)]),
        json!([[{"id": 777, "uuid": "00000000-0000-4000-8000-000000000777", "content": "the target", "page": {"id": 5}}]]),
    ])
    .await;
    let found = query_journals(&client(&logseq), &Args { resolve_refs: true, ..range(20250101, 20250101) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
    assert!(found.json.contains("\"resolvedContent\":\"see the target\""), "{}", found.json);
}

#[tokio::test]
async fn the_outline_never_resolves_refs() {
    let reference = format!("see (({}))", "00000000-0000-4000-8000-000000000777");
    let logseq = mock_logseq(vec![json!([page(1, 20250101)]), json!([block(11, 1, &reference)])]).await;
    query_journals(&client(&logseq), &Args { resolve_refs: true, include_content: false, ..range(20250101, 20250101) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 2);
}

#[tokio::test]
async fn a_null_answer_is_a_warning_and_never_an_empty_range() {
    let logseq = mock_logseq(vec![Value::Null]).await;
    let found = query_journals(&client(&logseq), &range(20250101, 20250103), TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 1);
    assert_eq!(result_of(&found.json)["warnings"][0]["code"], "journals_unavailable");

    let logseq = mock_logseq(vec![json!([page(1, 20250101)]), Value::Null]).await;
    let found = query_journals(&client(&logseq), &range(20250101, 20250103), TODAY).await.unwrap();
    let result = result_of(&found.json);
    assert_eq!(result["warnings"][0]["code"], "blocks_unavailable");
    // the day is still an entry, with no blocks, which is what the warning is for
    assert_eq!(result["entries"][0]["blocks"], json!([]));
}

// BR-0011, #318: a `null` answer to the search term's alias lookup is not "that name is no page".
// The search still runs on the term alone, and the result says the other names may be missing.
#[tokio::test]
async fn a_null_answer_to_the_search_terms_alias_lookup_is_a_warning_and_the_term_still_searches() {
    let logseq = mock_logseq(vec![json!([page(1, 20250101)]), json!([block(11, 1, "Atlas notes")]), Value::Null]).await;
    let found = query_journals(&client(&logseq), &Args { search_term: Some("Atlas".into()), ..range(20250101, 20250101) }, TODAY).await.unwrap();
    assert_eq!(methods(&logseq).len(), 3);
    let result = result_of(&found.json);
    assert_eq!(result["summary"]["totalBlocks"], 1);
    assert_eq!(result["warnings"][0]["code"], "alias_lookup_unavailable");
    assert_eq!(result["warnings"].as_array().unwrap().len(), 1);
    assert!(result.get("resolvedAliases").is_none());
}

#[tokio::test]
async fn a_failed_call_is_an_error_and_never_an_empty_result() {
    let logseq = mock_logseq(vec![]).await;
    let error = query_journals(&client(&logseq), &range(20250101, 20250103), TODAY).await.unwrap_err();
    assert!(matches!(error, ToolError::Logseq(_)), "{error}");
}
