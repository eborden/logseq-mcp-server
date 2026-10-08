//! The recorder of the golden results (#379) and the tests of its rules. The group files in `tests/data/parity/`
//! are the only source of the cases and their results, so this is the one way a result is recorded:
//!
//! ```text
//! PARITY_RECORD=1 cargo test --test parity_record -- --nocapture
//! ```
//!
//! It runs every case against the stub with the debug build and rewrites a result only when it changed in
//! meaning (`parity_support/record.rs` has the rules and why). It refuses to run when `CI` is set. A recording
//! changes the tool contract (ADR-0034), so its diff needs the maintainer's explicit OK and the `golden-change`
//! label before it merges.
//!
//! Without `PARITY_RECORD`, `record_the_golden_results_when_asked` does nothing, and the other tests here check
//! the recorder itself. They never write to `tests/data/parity/`: the end-to-end ones record a copy of some of
//! its files.

mod parity_support;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use parity_support::cases::{data_dir, load_tool_list, load_tool_list_in};
use parity_support::compare::compare_tool_lists;
use parity_support::record::{RecordRequest, plan_group, plan_tool_list, record_goldens, record_request, render_group, render_tool_list};
use parity_support::server::scratch_dir;
use parity_support::suggestion_rules::GUIDANCE;
use serde_json::{Value, json};

// ---- the entry: PARITY_RECORD=1

#[test]
fn record_the_golden_results_when_asked() {
    let env = |name: &str| std::env::var(name).ok();
    match record_request(&env, cfg!(debug_assertions)) {
        Ok(RecordRequest::Off) => {}
        Ok(RecordRequest::Record) => {
            let report = record_goldens(&data_dir(), true).unwrap_or_else(|e| panic!("{e}"));
            for line in &report.lines {
                println!("{line}");
            }
        }
        Err(refused) => panic!("{refused}"),
    }
}

fn environment(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    move |name| map.get(name).cloned()
}

#[test]
fn nothing_is_recorded_unless_asked() {
    assert_eq!(record_request(&environment(&[]), true), Ok(RecordRequest::Off));
    assert_eq!(record_request(&environment(&[("PARITY_RECORD", "")]), true), Ok(RecordRequest::Off));
    // Asking for nothing is not refused anywhere, so CI and a release build run the other tests here as they are
    assert_eq!(record_request(&environment(&[("CI", "true")]), true), Ok(RecordRequest::Off));
    assert_eq!(record_request(&environment(&[]), false), Ok(RecordRequest::Off));
}

#[test]
fn a_recording_is_asked_for_by_one() {
    assert_eq!(record_request(&environment(&[("PARITY_RECORD", "1")]), true), Ok(RecordRequest::Record));
    // CI set to nothing is not CI
    assert_eq!(record_request(&environment(&[("PARITY_RECORD", "1"), ("CI", "")]), true), Ok(RecordRequest::Record));
    for other in ["0", "true", "yes", "all"] {
        let refused = record_request(&environment(&[("PARITY_RECORD", other)]), true).unwrap_err();
        assert!(refused.contains("must be 1"), "{other}: {refused}");
    }
}

#[test]
fn a_recording_is_refused_in_ci() {
    for value in ["true", "1", "false", "yes"] {
        let refused = record_request(&environment(&[("PARITY_RECORD", "1"), ("CI", value)]), true).unwrap_err();
        assert!(refused.contains("never run in CI"), "CI={value}: {refused}");
    }
    // Whatever else is wrong, CI is the reason given
    assert!(record_request(&environment(&[("PARITY_RECORD", "0"), ("CI", "true")]), false).unwrap_err().contains("never run in CI"));
}

#[test]
fn a_recording_is_refused_in_a_release_build() {
    let refused = record_request(&environment(&[("PARITY_RECORD", "1")]), false).unwrap_err();
    assert!(refused.contains("debug build") && refused.contains("LOGSEQ_MCP_NOW"), "{refused}");
}

// ---- what a recording changes in a group

fn case(name: &str, expected: Option<Value>) -> Value {
    let mut case = json!({"name": name, "tool": "logseq_get_page", "arguments": {"page_name": "Alice"}, "steps": []});
    if let Some(expected) = expected {
        case["expected"] = expected;
    }
    case
}

fn tool_result(text: &str) -> Value {
    json!({"content": [{"type": "text", "text": text}]})
}

fn results(pairs: &[(&str, Value)]) -> HashMap<String, Value> {
    pairs.iter().map(|(name, result)| ((*name).to_owned(), result.clone())).collect()
}

#[test]
fn a_result_that_is_the_same_by_meaning_keeps_its_recorded_bytes() {
    let recorded = tool_result(r#"{"a":1,"b":[1,2],"c":{"x":"y"}}"#);
    // The same value with its keys in another order
    let server = tool_result(r#"{"c":{"x":"y"},"b":[1,2],"a":1}"#);
    let cases = [case("alice", Some(recorded.clone()))];
    let plan = plan_group("get-page", &cases, &results(&[("alice", server)])).unwrap();
    assert!(plan.changes.is_empty(), "{:?}", plan.changes);
    assert_eq!(plan.cases, cases);
    // So nothing is written for it, which `record_goldens` decides by the changes
    assert_eq!(render_group("get-page", &plan.cases), render_group("get-page", &cases));
}

#[test]
fn a_result_that_differs_in_meaning_is_recorded_and_says_why() {
    let cases = [case("alice", Some(tool_result(r#"{"a":1}"#))), case("bob", Some(tool_result(r#"{"a":1}"#)))];
    let plan = plan_group("get-page", &cases, &results(&[("alice", tool_result(r#"{"a":2}"#)), ("bob", tool_result(r#"{"a":1}"#))])).unwrap();
    assert_eq!(plan.changes.len(), 1);
    assert_eq!(plan.changes[0].name, "alice");
    assert!(plan.changes[0].lines.iter().any(|line| line.contains("content[0].text differs")), "{:?}", plan.changes[0].lines);
    assert_eq!(plan.cases[0]["expected"], tool_result(r#"{"a":2}"#));
    // The case that did not change is as it was
    assert_eq!(plan.cases[1], cases[1]);
}

#[test]
fn a_result_with_layout_whitespace_is_a_change_because_a_recorded_result_is_minified() {
    let cases = [case("alice", Some(tool_result(r#"{"a":1}"#)))];
    let plan = plan_group("get-page", &cases, &results(&[("alice", tool_result("{\"a\": 1}"))])).unwrap();
    assert_eq!(plan.changes.len(), 1);
    assert!(plan.changes[0].lines.iter().any(|line| line.contains("not minified")), "{:?}", plan.changes[0].lines);
}

#[test]
fn a_case_with_no_result_yet_takes_the_servers_as_its_last_key() {
    let cases = [case("alice", None)];
    let plan = plan_group("get-page", &cases, &results(&[("alice", tool_result("{}"))])).unwrap();
    assert_eq!(plan.changes.len(), 1);
    assert_eq!(plan.changes[0].lines, vec!["new case".to_owned()]);
    let keys: Vec<&String> = plan.cases[0].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["name", "tool", "arguments", "steps", "expected"]);
}

#[test]
fn a_case_the_server_gave_no_result_for_stops_the_recording() {
    let cases = [case("alice", Some(tool_result("{}")))];
    let refused = plan_group("get-page", &cases, &HashMap::new()).unwrap_err();
    assert!(refused.contains("\"alice\""), "{refused}");
}

#[test]
fn the_closest_names_of_a_missing_page_are_recorded_only_when_the_rules_reject_them() {
    let pages = ["Project Atlas", "Project Zed", "Project Quill", "Bob"];
    let mut with_pages = case("typo", None);
    with_pages["steps"] = json!([[{"method": "logseq.Editor.getAllPages", "args": [], "response": pages.iter().map(|n| json!({"originalName": n})).collect::<Vec<_>>()}]]);
    let message = |list: &str| json!({"error": format!("No page \"Projct\". Closest: {list}. {GUIDANCE}")}).to_string();
    let error_result = |list: &str| json!({"content": [{"type": "text", "text": message(list)}], "isError": true});
    let mut cases = [with_pages];
    cases[0]["expected"] = error_result("Project Atlas, Project Zed, Project Quill");

    // Other names the rules accept, in another order: no change, so the recorded list stays
    let same = plan_group("get-page", &cases, &results(&[("typo", error_result("Project Quill, Project Zed, Project Atlas"))])).unwrap();
    assert!(same.changes.is_empty(), "{:?}", same.changes);
    assert_eq!(same.cases[0]["expected"], cases[0]["expected"]);
    // An unrelated name breaks rule 5: recorded
    let unrelated = plan_group("get-page", &cases, &results(&[("typo", error_result("Project Atlas, Bob, Project Quill"))])).unwrap();
    assert_eq!(unrelated.changes.len(), 1);
    assert!(unrelated.changes[0].lines.iter().any(|line| line.contains("rule 5")), "{:?}", unrelated.changes[0].lines);
}

#[test]
fn a_group_is_written_one_case_to_a_line_as_json_stringify_writes_it() {
    let cases = [json!({"name": "a", "n": 1.0, "k": {"2": "b", "1": "a", "x": 1e21}}), json!({"name": "b é\n"})];
    assert_eq!(render_group("g", &cases), "{\"group\":\"g\",\"cases\":[\n  {\"name\":\"a\",\"n\":1,\"k\":{\"1\":\"a\",\"2\":\"b\",\"x\":1e+21}},\n  {\"name\":\"b é\\n\"}\n]}\n");
}

// ---- what a recording changes in the tool list

fn tool(name: &str, description: &str, schema: Value) -> Value {
    json!({"name": name, "title": name, "annotations": {"title": name, "readOnlyHint": true}, "description": description, "inputSchema": schema})
}

fn schema(limit: Value) -> Value {
    json!({"type": "object", "properties": {"limit": limit}, "additionalProperties": false})
}

#[test]
fn the_tool_list_is_left_alone_when_it_is_the_same_by_meaning() {
    let recorded = vec![tool("t1", "d", schema(json!({"type": "integer", "minimum": 0})))];
    assert!(plan_tool_list(&recorded, &recorded).is_none());
    // What the server's own schema library writes: a format keyword, a title, floats, a nullable optional argument
    let spelled = vec![tool("t1", "d", schema(json!({"type": ["integer", "null"], "format": "uint32", "title": "Limit", "minimum": 0.0})))];
    assert!(plan_tool_list(&recorded, &spelled).is_none());
}

#[test]
fn a_changed_tool_is_recorded_and_the_others_keep_their_bytes() {
    let recorded = vec![
        tool("t1", "first", schema(json!({"type": "integer", "minimum": 0}))),
        tool("t2", "second", schema(json!({"type": "integer", "minimum": 0}))),
        tool("t3", "third", schema(json!({"type": "integer"}))),
    ];
    let server = vec![
        tool("t1", "first, changed", schema(json!({"type": "integer", "minimum": 0}))),
        // Same by meaning, spelled the way the server's library writes it
        tool("t2", "second", schema(json!({"type": ["integer", "null"], "format": "uint32", "minimum": 0}))),
        tool("t3", "third", schema(json!({"type": "integer", "maximum": 9}))),
        tool("t4", "new", schema(json!({"type": "string"}))),
    ];
    let plan = plan_tool_list(&recorded, &server).expect("a change in meaning");
    assert_eq!(plan.changes.len(), 3, "{:?}", plan.changes);
    assert!(plan.changes.iter().any(|c| c.starts_with("t1.description")));
    assert!(plan.changes.iter().any(|c| c.starts_with("t3.inputSchema")));
    assert!(plan.changes.iter().any(|c| c == "t4: not in the reference"));
    // The server's list, with the entry that did not change in meaning as it was recorded
    assert_eq!(plan.tools, vec![server[0].clone(), recorded[1].clone(), server[2].clone(), server[3].clone()]);
}

#[test]
fn a_tool_the_server_no_longer_lists_leaves_the_recorded_list() {
    let recorded = vec![tool("t1", "d", schema(json!({"type": "integer"}))), tool("t2", "d", schema(json!({"type": "integer"})))];
    let plan = plan_tool_list(&recorded, &recorded[..1]).expect("a tool is missing");
    assert_eq!(plan.changes, vec!["t2: missing".to_owned()]);
    assert_eq!(plan.tools, vec![recorded[0].clone()]);
}

#[test]
fn the_tool_list_is_written_indented_by_two_spaces_with_a_final_newline() {
    assert_eq!(render_tool_list(&[json!({"name": "t", "list": [], "o": {}})]), "[\n  {\n    \"name\": \"t\",\n    \"list\": [],\n    \"o\": {}\n  }\n]\n");
}

// ---- the whole recorder, against a copy of some of the files

fn copy_of(files: &[&str]) -> PathBuf {
    let dir = scratch_dir("record");
    for file in files {
        fs::copy(data_dir().join(file), dir.join(file)).expect("copy a data file");
    }
    dir
}

fn read_cases(dir: &Path, file: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(&fs::read_to_string(dir.join(file)).unwrap()).unwrap()["cases"].as_array().unwrap().clone()
}

fn case_named<'a>(cases: &'a mut [Value], name: &str) -> &'a mut Value {
    cases.iter_mut().find(|c| c["name"] == name).unwrap_or_else(|| panic!("no case {name:?}"))
}

#[test]
fn recording_the_recorded_files_writes_nothing() {
    let dir = copy_of(&["get-page-outline.json", "tool-list.json"]);
    let before: Vec<String> = ["get-page-outline.json", "tool-list.json"].iter().map(|f| fs::read_to_string(dir.join(f)).unwrap()).collect();
    let report = record_goldens(&dir, false).unwrap_or_else(|e| panic!("{e}"));
    assert!(report.written.is_empty(), "{:?}", report.lines);
    let after: Vec<String> = ["get-page-outline.json", "tool-list.json"].iter().map(|f| fs::read_to_string(dir.join(f)).unwrap()).collect();
    assert_eq!(before, after);
    assert!(report.lines.iter().any(|l| l.contains("no file was written")), "{:?}", report.lines);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn recording_restores_what_changed_in_meaning_and_leaves_the_rest_as_it_was() {
    let dir = copy_of(&["get-page-outline.json", "tool-list.json"]);
    let original = read_cases(&dir, "get-page-outline.json");
    let original_tools = load_tool_list();
    // The committed file is in the form the recorder writes, or this test would show the form and not the change
    assert_eq!(fs::read_to_string(dir.join("get-page-outline.json")).unwrap(), render_group("get-page-outline", &original));
    assert_eq!(fs::read_to_string(dir.join("tool-list.json")).unwrap(), render_tool_list(&original_tools));

    let mut cases = original.clone();
    // 1. a golden result that is wrong: recorded again
    case_named(&mut cases, "namespace leaf")["expected"]["content"][0]["text"] = json!("{\"wrong\":true}");
    // 2. a case with no result yet: filled in
    case_named(&mut cases, "alias").as_object_mut().unwrap().remove("expected");
    // 3. a result that is the same by meaning with its keys the other way round: its tampered bytes stay
    let reordered = {
        let case = case_named(&mut cases, "exact name, blocks out of order with children");
        let text: Value = serde_json::from_str(case["expected"]["content"][0]["text"].as_str().unwrap()).unwrap();
        let reversed: serde_json::Map<String, Value> = text.as_object().unwrap().iter().rev().map(|(k, v)| (k.clone(), v.clone())).collect();
        let reversed_text = serde_json::to_string(&Value::Object(reversed)).unwrap();
        assert_ne!(case["expected"]["content"][0]["text"].as_str().unwrap(), reversed_text, "the case needs two keys to reorder");
        case["expected"]["content"][0]["text"] = json!(reversed_text);
        case.clone()
    };
    fs::write(dir.join("get-page-outline.json"), render_group("get-page-outline", &cases)).unwrap();

    // The tool list: one description changed, one schema spelled the way the server's library writes it
    let mut tools = original_tools.clone();
    tools[0]["description"] = json!("a description the server does not have");
    let first_property = tools[1]["inputSchema"]["properties"].as_object().unwrap().keys().next().unwrap().clone();
    tools[1]["inputSchema"]["properties"][&first_property]["title"] = json!("a title, which no client can see");
    fs::write(dir.join("tool-list.json"), render_tool_list(&tools)).unwrap();

    let report = record_goldens(&dir, false).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(report.written.len(), 2, "{:?}", report.lines);
    assert!(report.lines.iter().any(|l| l == "changed: namespace leaf"), "{:?}", report.lines);
    assert!(report.lines.iter().any(|l| l == "changed: alias" || l == "  - new case"), "{:?}", report.lines);
    assert!(!report.lines.iter().any(|l| l.starts_with("changed: exact name")), "{:?}", report.lines);

    let mut want = original.clone();
    *case_named(&mut want, "exact name, blocks out of order with children") = reordered;
    assert_eq!(fs::read_to_string(dir.join("get-page-outline.json")).unwrap(), render_group("get-page-outline", &want));
    // The tool whose description was changed is the server's again, in the server's own spelling of its schema, so
    // it is the recorded one by meaning and not necessarily by bytes. The one spelled differently keeps its bytes,
    // and so does every tool that was not touched.
    let recorded = load_tool_list_in(&dir);
    assert_eq!(recorded.len(), original_tools.len());
    assert!(compare_tool_lists(&original_tools[..1], &recorded[..1]).is_empty(), "{:?}", compare_tool_lists(&original_tools[..1], &recorded[..1]));
    assert_eq!(recorded[1], tools[1]);
    assert_eq!(recorded[2..], original_tools[2..]);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn recording_writes_nothing_when_a_case_makes_the_wrong_calls() {
    let dir = copy_of(&["get-page-outline.json", "tool-list.json"]);
    let mut cases = read_cases(&dir, "get-page-outline.json");
    // The case lists no answer for the calls the server makes, and a golden result that is wrong, which a recording
    // from calls that went wrong would have recorded
    let broken = case_named(&mut cases, "alias");
    broken["steps"] = json!([]);
    broken["expected"]["content"][0]["text"] = json!("{\"wrong\":true}");
    fs::write(dir.join("get-page-outline.json"), render_group("get-page-outline", &cases)).unwrap();
    let before = fs::read_to_string(dir.join("get-page-outline.json")).unwrap();

    let refused = record_goldens(&dir, false).unwrap_err();
    assert!(refused.contains("nothing was recorded") && refused.contains("alias") && refused.contains("no canned response"), "{refused}");
    assert_eq!(fs::read_to_string(dir.join("get-page-outline.json")).unwrap(), before);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn recording_writes_nothing_when_the_set_lacks_the_closest_name_cases_the_adr_requires() {
    // One group file holds some of them, not all: the real set is held to the requirement, a copy isn't
    let dir = copy_of(&["get-page-outline.json", "tool-list.json"]);
    let before = fs::read_to_string(dir.join("get-page-outline.json")).unwrap();
    let refused = record_goldens(&dir, true).unwrap_err();
    assert!(refused.contains("nothing was recorded") && refused.contains("lack a required closest-names case"), "{refused}");
    assert_eq!(fs::read_to_string(dir.join("get-page-outline.json")).unwrap(), before);
    let _ = fs::remove_dir_all(&dir);
}
