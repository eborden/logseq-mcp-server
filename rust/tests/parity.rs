//! The golden-result test (#371): run the server binary against the stub LogSeq and hold it to the results
//! recorded from the TypeScript server before it was retired (`scripts/parity/expected`, exported to
//! `tests/data/parity/` by `npx vite-node scripts/export-parity.ts`). It is the Rust side of the Node
//! harness `scripts/parity.ts`, run by `cargo test` so that a mutant (`cargo-mutants`, ADR-0033) is killed by
//! any parity case that notices it.
//!
//! It checks, for every case:
//! - the result: a JSON tool result by deep equality (key order ignored, array order kept, numbers by value)
//!   and minified (ADR-0009), every other text (markdown, a prompt's messages, a resource read, the frame of a
//!   page-not-found message) byte for byte, and the closest names of a page-not-found message by the rules of
//!   ADR-0032 (#335);
//! - the LogSeq calls and their inputs: the steps of a case in order, the calls within a step as a set, and
//!   nothing after the last step; a call the stub has no answer for is a failure;
//! and once: `tools/list` by meaning against the recorded list (ADR-0031, #292), that startup and `tools/list`
//! make no LogSeq call, and that the recorded set exercises the closest-name rules.
//!
//! Every rule that decides whether an answer matches is in `parity_support/compare.rs`. `parity_self_check.rs`
//! runs the same cases against perturbed stub answers.
//!
//! A release build ignores `LOGSEQ_MCP_NOW` (`src/env.rs`), so under `--release` the cases that read today's
//! date leave the run (`clock-cases.json`), as `--real-clock` leaves them out of the Node harness.

mod parity_support;

use parity_support::cases::{Case, load_cases, load_clock_cases, load_comparator_table, load_tool_list, perturb_value, without_clock_cases};
use parity_support::compare::{compare_calls, compare_results, compare_tool_lists, minified_failures, normalize_schema, same_text, values_equal};
use parity_support::server::{PARITY_NOW_MS, Run, run_parity};
use parity_support::stub::Call;
use parity_support::suggestion_rules::{
    GUIDANCE, candidates_of, check_list, check_reference_list, fold, matches_of, not_found_sites, parse_not_found, read_message, split_list, with_message,
    wrong_lists, WRONG_LIST_LABELS,
};
use serde_json::{Value, json};

/// The cases this build can hold to the recording.
fn cases_for_this_build() -> Vec<Case> {
    let cases = load_cases();
    if cfg!(debug_assertions) { cases } else { without_clock_cases(cases, &load_clock_cases()) }
}

#[test]
fn every_parity_case_matches_its_golden_result() {
    let cases = cases_for_this_build();
    let report = run_parity(&Run { cases: &cases, unperturbed: &cases, expected_tool_list: &load_tool_list(), now_ms: PARITY_NOW_MS, settle_ms: 2000 });
    assert!(
        report.failures.is_empty(),
        "{} failure(s) in {} case(s):\n- {}\n{}",
        report.failures.len(),
        cases.len(),
        report.failures.join("\n- "),
        if report.stderr.trim().is_empty() { String::new() } else { format!("server stderr:\n{}", report.stderr.trim()) }
    );
}

// ---- the comparator can fail: each rule it applies is shown to reject a wrong answer

/// The golden result with every JSON text of its `content` changed in one value and written back compactly, so the
/// text is still JSON and the comparison goes through deep equality; `None` when no text of it is JSON.
fn with_json_texts_perturbed(expected: &Value) -> Option<Value> {
    let mut wrong = expected.clone();
    let mut any = false;
    for block in wrong.get_mut("content")?.as_array_mut()? {
        let Some(text) = block.get("text").and_then(Value::as_str) else { continue };
        let Ok(parsed) = serde_json::from_str::<Value>(text) else { continue };
        if !(parsed.is_object() || parsed.is_array()) {
            continue;
        }
        block["text"] = Value::String(serde_json::to_string(&perturb_value(&parsed)).unwrap());
        any = true;
    }
    any.then_some(wrong)
}

#[test]
fn the_comparator_fails_on_every_perturbed_golden_result() {
    let cases = cases_for_this_build();
    let mut not_caught = Vec::new();
    let mut by_deep_equality = 0;
    for case in &cases {
        let candidates = candidates_of(case);
        // The answer the server would give if the golden result were different in one value of each JSON text it
        // holds; a result with no JSON text (markdown, a prompt, a resource) in every string it holds
        let json = with_json_texts_perturbed(&case.expected);
        let wrong = json.clone().unwrap_or_else(|| perturb_value(&case.expected));
        let failures = compare_results(&case.expected, &wrong, &candidates);
        if failures.is_empty() {
            not_caught.push(case.name.as_str());
        }
        // The perturbed text is JSON that is as minified as the original, so it is deep equality that rejects it
        if json.is_some() {
            if failures.iter().all(|f| f.contains("not minified")) {
                not_caught.push(case.name.as_str());
            }
            by_deep_equality += 1;
        }
        // And the same result is a pass
        assert_eq!(compare_results(&case.expected, &case.expected, &candidates), Vec::<String>::new(), "{}", case.name);
    }
    assert!(not_caught.is_empty(), "a perturbed golden result passed, or was rejected for something other than its value: {not_caught:?}");
    assert!(by_deep_equality > 500, "the JSON results are most of the cases; only {by_deep_equality} were perturbed as JSON");
}

#[test]
fn the_comparator_fails_on_a_text_that_differs_by_a_trailing_space() {
    for case in cases_for_this_build() {
        let Some(blocks) = case.expected.get("content").or(case.expected.get("contents")).and_then(Value::as_array) else { continue };
        for (i, block) in blocks.iter().enumerate() {
            let Some(text) = block.get("text").and_then(Value::as_str) else { continue };
            let list = if case.expected.get("content").is_some() { "content" } else { "contents" };
            let mut wrong = case.expected.clone();
            wrong[list][i]["text"] = Value::String(format!("{text} "));
            assert!(!compare_results(&case.expected, &wrong, &candidates_of(&case)).is_empty(), "{}: a trailing space in {list}[{i}] passed", case.name);
        }
    }
}

#[test]
fn the_comparator_fails_on_a_wrong_call() {
    for case in cases_for_this_build().iter().filter(|c| c.call_count() > 0) {
        let as_made = |change: &dyn Fn(&mut Vec<Call>)| {
            let mut calls: Vec<Call> = case.canned().map(|c| Call { method: c.method.clone(), args: c.args.clone() }).collect();
            change(&mut calls);
            calls
        };
        assert_eq!(compare_calls(&case.steps, &as_made(&|_| {})), Vec::<String>::new(), "{}: the calls as listed", case.name);
        assert!(!compare_calls(&case.steps, &as_made(&|calls| calls[0].method.push_str("X"))).is_empty(), "{}: a wrong method passed", case.name);
        assert!(!compare_calls(&case.steps, &as_made(&|calls| calls[0].args.push(json!("extra")))).is_empty(), "{}: an extra input passed", case.name);
        assert!(!compare_calls(&case.steps, &as_made(&|calls| drop(calls.pop()))).is_empty(), "{}: a missing call passed", case.name);
        assert!(!compare_calls(&case.steps, &as_made(&|calls| calls.push(calls[0].clone()))).is_empty(), "{}: a call after the last step passed", case.name);
    }
}

#[test]
fn the_calls_within_a_step_are_a_set_and_the_steps_are_in_order() {
    let cases = cases_for_this_build();
    let concurrent = cases.iter().find(|c| c.steps.iter().any(|step| step.len() > 1 && step[0].method != step[1].method)).expect("a case with concurrent calls");
    let made = |order: &dyn Fn(&mut Vec<Call>)| {
        let mut calls: Vec<Call> = concurrent.canned().map(|c| Call { method: c.method.clone(), args: c.args.clone() }).collect();
        order(&mut calls);
        calls
    };
    // Swap the two calls of the first step that has two
    let start: usize = concurrent.steps.iter().take_while(|step| step.len() < 2).map(Vec::len).sum();
    let swapped = made(&|calls| calls.swap(start, start + 1));
    assert_eq!(compare_calls(&concurrent.steps, &swapped), Vec::<String>::new());

    let sequential = cases.iter().find(|c| c.steps.len() > 1 && c.steps[0].len() == 1 && c.steps[1].len() == 1 && c.steps[0][0].method != c.steps[1][0].method);
    if let Some(sequential) = sequential {
        let mut calls: Vec<Call> = sequential.canned().map(|c| Call { method: c.method.clone(), args: c.args.clone() }).collect();
        calls.swap(0, 1);
        assert!(!compare_calls(&sequential.steps, &calls).is_empty(), "two steps made in the other order passed");
    }
}

#[test]
fn a_query_is_compared_without_its_layout_but_with_its_inputs() {
    let step = |query: &str, input: &str| vec![parity_support::cases::Canned { method: "logseq.DB.datascriptQuery".into(), args: vec![json!(query), json!(input)], response: json!([]) }];
    let call = |query: &str, input: &str| Call { method: "logseq.DB.datascriptQuery".into(), args: vec![json!(query), json!(input)] };
    let steps = [step("[:find ?p\n   :where [?p :a ?b]]", "\"x\"")];
    assert!(compare_calls(&steps, &[call("[:find ?p :where [?p :a ?b]]", "\"x\"")]).is_empty());
    assert!(!compare_calls(&steps, &[call("[:find ?p :where [?p :a ?b]]", "\"y\"")]).is_empty());
    assert!(!compare_calls(&steps, &[call("[:find ?q :where [?p :a ?b]]", "\"x\"")]).is_empty());
}

#[test]
fn the_tool_list_comparison_fails_on_a_wrong_tool_and_ignores_what_no_client_can_see() {
    let recorded = load_tool_list();
    assert_eq!(compare_tool_lists(&recorded, &recorded), Vec::<String>::new());
    for (i, tool) in recorded.iter().enumerate() {
        let name = tool["name"].as_str().unwrap();
        let mut changed = recorded.clone();
        changed[i]["description"] = json!(format!("{} (changed)", tool["description"].as_str().unwrap()));
        assert!(!compare_tool_lists(&recorded, &changed).is_empty(), "{name}: a changed description passed");
        let mut annotated = recorded.clone();
        annotated[i]["annotations"]["readOnlyHint"] = json!(false);
        assert!(!compare_tool_lists(&recorded, &annotated).is_empty(), "{name}: a changed annotation passed");
        let mut schema = recorded.clone();
        schema[i]["inputSchema"]["properties"]["parity_extra"] = json!({"type": "string"});
        assert!(!compare_tool_lists(&recorded, &schema).is_empty(), "{name}: an added argument passed");
        let mut removed = recorded.clone();
        removed.remove(i);
        assert!(!compare_tool_lists(&recorded, &removed).is_empty(), "{name}: a missing tool passed");
        assert!(!compare_tool_lists(&removed, &recorded).is_empty(), "{name}: an unrecorded tool passed");
    }
}

#[test]
fn the_tool_list_is_compared_by_meaning() {
    let tool = |schema: Value| vec![json!({"name": "t", "title": "T", "annotations": {"title": "T"}, "description": "d", "inputSchema": schema})];
    let recorded = tool(json!({
        "type": "object",
        "properties": {"page_name": {"type": "string"}, "limit": {"type": "integer", "minimum": 0, "maximum": 50}},
        "required": ["page_name"],
        "additionalProperties": false
    }));
    // schemars' spelling: a $ref into $defs, a nullable optional argument, a format keyword, a title, floats for whole numbers
    let spelled_differently = tool(json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Args",
        "type": "object",
        "properties": {
            "page_name": {"type": "string"},
            "limit": {"anyOf": [{"$ref": "#/$defs/Limit"}, {"type": "null"}]}
        },
        "required": ["page_name"],
        "additionalProperties": false,
        "$defs": {"Limit": {"type": "integer", "format": "uint32", "minimum": 0.0, "maximum": 5e1}}
    }));
    assert_eq!(compare_tool_lists(&recorded, &spelled_differently), Vec::<String>::new());
    // A required argument's null is meaning, and so is a changed bound
    let nullable_required = tool(json!({
        "type": "object",
        "properties": {"page_name": {"type": ["string", "null"]}, "limit": {"type": "integer", "minimum": 0, "maximum": 50}},
        "required": ["page_name"],
        "additionalProperties": false
    }));
    assert!(!compare_tool_lists(&recorded, &nullable_required).is_empty());
    let other_bound = tool(json!({
        "type": "object",
        "properties": {"page_name": {"type": "string"}, "limit": {"type": "integer", "minimum": 0, "maximum": 51}},
        "required": ["page_name"],
        "additionalProperties": false
    }));
    assert!(!compare_tool_lists(&recorded, &other_bound).is_empty());
    assert!(normalize_schema(&json!({"properties": {"a": {"$ref": "#/$defs/Nowhere"}}})).is_err());
    assert!(normalize_schema(&json!({"$defs": {"A": {"$ref": "#/$defs/A"}}, "properties": {"a": {"$ref": "#/$defs/A"}}})).is_err());
}

#[test]
fn values_are_equal_by_meaning() {
    assert!(values_equal(&json!({"a": 1, "b": [50.0]}), &json!({"b": [50], "a": 1.0})));
    assert!(!values_equal(&json!({"a": 1}), &json!({"a": 2})));
    assert!(!values_equal(&json!({"a": 1}), &json!({"a": 1, "b": 1})));
    assert!(!values_equal(&json!([1, 2]), &json!([2, 1])));
}

/// A tool result with one content block holding this text.
fn tool_result(text: &str) -> Value {
    json!({"content": [{"type": "text", "text": text}]})
}

#[test]
fn a_json_tool_result_is_compared_by_deep_equality() {
    let expected = tool_result(r#"{"a":1,"b":[1,2],"c":{"x":"y","z":2}}"#);
    let same = |actual: &str| compare_results(&expected, &tool_result(actual), &[]);
    assert_eq!(same(r#"{"a":1,"b":[1,2],"c":{"x":"y","z":2}}"#), Vec::<String>::new());
    // Key order is ignored, at every depth
    assert_eq!(same(r#"{"c":{"z":2,"x":"y"},"b":[1,2],"a":1}"#), Vec::<String>::new());
    // Numbers compare by value: 1.0 is the number 1, and a server that wrote it that way is still not minified
    let spelled = same(r#"{"a":1.0,"b":[1,2],"c":{"x":"y","z":2}}"#);
    assert!(spelled.len() == 1 && spelled[0].contains("not minified"), "{spelled:?}");
    // Array order is kept
    assert!(!same(r#"{"a":1,"b":[2,1],"c":{"x":"y","z":2}}"#).is_empty());
    // A different value, a missing key and an extra key are different results
    assert!(!same(r#"{"a":2,"b":[1,2],"c":{"x":"y","z":2}}"#).is_empty());
    assert!(!same(r#"{"a":1,"b":[1,2]}"#).is_empty());
    assert!(!same(r#"{"a":1,"b":[1,2],"c":{"x":"y","z":2},"d":0}"#).is_empty());
    // A changed string, at depth, is a different result
    assert!(!same(r#"{"a":1,"b":[1,2],"c":{"x":"Y","z":2}}"#).is_empty());
    // A changed type is too: the number 1 is not the text "1"
    assert!(!same(r#"{"a":"1","b":[1,2],"c":{"x":"y","z":2}}"#).is_empty());
    assert!(!same(r#"{"a":1,"b":["1",2],"c":{"x":"y","z":2}}"#).is_empty());
    assert!(!same(r#"{"a":true,"b":[1,2],"c":{"x":"y","z":2}}"#).is_empty());
    // A null is not an absent key, in either direction
    assert!(!same(r#"{"a":1,"b":[1,2],"c":{"x":"y","z":null}}"#).is_empty());
    assert!(!same(r#"{"a":1,"b":[1,2],"c":{"x":"y"}}"#).is_empty());
    let with_null = tool_result(r#"{"a":null}"#);
    assert!(!compare_results(&with_null, &tool_result("{}"), &[]).is_empty());
    assert!(!compare_results(&tool_result("{}"), &with_null, &[]).is_empty());
    // An array's order matters at depth too, and so does its length
    let nested = tool_result(r#"{"rows":[{"id":1},{"id":2}]}"#);
    assert!(!compare_results(&nested, &tool_result(r#"{"rows":[{"id":2},{"id":1}]}"#), &[]).is_empty());
    assert!(!compare_results(&nested, &tool_result(r#"{"rows":[{"id":1}]}"#), &[]).is_empty());
    assert!(!compare_results(&nested, &tool_result(r#"{"rows":[{"id":1},{"id":2},{"id":3}]}"#), &[]).is_empty());
}

#[test]
fn values_differ_by_string_by_type_and_by_array_order() {
    assert!(!values_equal(&json!("a"), &json!("b")));
    assert!(!values_equal(&json!(1), &json!("1")));
    assert!(!values_equal(&json!(null), &json!(false)));
    assert!(!values_equal(&json!(0), &json!(false)));
    assert!(!values_equal(&json!({"a": null}), &json!({})));
    assert!(!values_equal(&json!({"a": 1}), &json!({"b": 1})));
    assert!(!values_equal(&json!([[1], [2]]), &json!([[2], [1]])));
    assert!(values_equal(&json!([{"a": 1, "b": 2}]), &json!([{"b": 2, "a": 1}])));
    assert!(values_equal(&json!("same"), &json!("same")));
}

#[test]
fn a_json_tool_result_has_to_be_minified() {
    let expected = tool_result(r#"{"a":1,"b":[1,2]}"#);
    // The same value with layout whitespace is the same by deep equality and still fails (ADR-0009)
    for layout in [r#"{"a": 1,"b":[1,2]}"#, "{\"a\":1,\"b\":[1,2]}\n", "{\n  \"a\":1,\"b\":[1,2]}", r#"{"a":1,"b":[1, 2]}"#, r#" {"a":1,"b":[1,2]}"#] {
        let failures = compare_results(&expected, &tool_result(layout), &[]);
        assert!(failures.iter().any(|f| f.contains("not minified")), "{layout:?} passed: {failures:?}");
    }
    // A spelling JSON.stringify would not have written is not minified either (the Node harness agrees)
    for spelling in [r#"{"a":1,"b":[1.0,2]}"#, r#"{"a":1,"b":[1e0,2]}"#, r#"{"a":1,"b":[1,2],"c":"\u0041"}"#, r#"{"a":1,"b":[1,2],"c":"\/"}"#] {
        assert!(!minified_failures(&tool_result(spelling)).is_empty(), "{spelling} passed");
    }
    // What JSON.stringify writes is minified, the number corners included
    assert_eq!(minified_failures(&tool_result(r#"{"a":1e+21,"b":[0.1,1.5e-7],"c":"é😀\u0001\n\""}"#)), Vec::<String>::new());
    // Whitespace inside a string is the value's, not layout
    let spaced = tool_result(r#"{"a":"x  y\n"}"#);
    assert_eq!(compare_results(&spaced, &spaced, &[]), Vec::<String>::new());
    assert_eq!(minified_failures(&tool_result("# a heading\n\n- a bullet")), Vec::<String>::new());
}

#[test]
fn markdown_prompts_and_resources_are_compared_byte_for_byte() {
    // A markdown tool result isn't JSON: any difference is one
    let markdown = tool_result("# Atlas\n\n- a block\n");
    assert_eq!(compare_results(&markdown, &markdown, &[]), Vec::<String>::new());
    assert!(!compare_results(&markdown, &tool_result("# Atlas\n\n- a block"), &[]).is_empty());
    // A resource's text is byte for byte even when it is JSON
    let resource = json!({"contents": [{"uri": "logseq://x", "mimeType": "application/json", "text": r#"{"a":1,"b":2}"#}]});
    let reordered = json!({"contents": [{"uri": "logseq://x", "mimeType": "application/json", "text": r#"{"b":2,"a":1}"#}]});
    assert_eq!(compare_results(&resource, &resource, &[]), Vec::<String>::new());
    assert!(!compare_results(&resource, &reordered, &[]).is_empty());
    // So is a prompt's message
    let prompt = json!({"messages": [{"role": "user", "content": {"type": "text", "text": r#"{"a":1,"b":2}"#}}]});
    let prompt_reordered = json!({"messages": [{"role": "user", "content": {"type": "text", "text": r#"{"b":2,"a":1}"#}}]});
    assert!(!compare_results(&prompt, &prompt_reordered, &[]).is_empty());
    assert!(same_text(r#"{"a":1}"#, r#"{"a":1}"#));
    assert!(!same_text(r#"{"a":1}"#, r#"{"a": 1}"#));
}

#[test]
fn the_frame_of_a_page_not_found_message_is_byte_for_byte() {
    let reference = tool_result(&json!({"error": message("Atlas", Some("Atlas Notes"))}).to_string());
    let candidates = names(&["Atlas Notes"]);
    assert_eq!(compare_results(&reference, &reference, &candidates), Vec::<String>::new());
    let other_frame = tool_result(&json!({"error": message("Atlas", Some("Atlas Notes")).replace("No page", "No such page")}).to_string());
    assert!(!compare_results(&reference, &other_frame, &candidates).is_empty());
}

// ---- the closest-name rules (ADR-0032), and the self-check that wrong lists are caught

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|n| (*n).to_owned()).collect()
}

fn message(input: &str, list: Option<&str>) -> String {
    match list {
        Some(list) => format!("No page {}. Closest: {list}. {GUIDANCE}", json!(input)),
        None => format!("No page {}. {GUIDANCE}", json!(input)),
    }
}

#[test]
fn a_page_not_found_message_is_read_by_its_frame() {
    let parsed = parse_not_found(&message("Atlas", Some("Atlas Notes, Atlas Log"))).unwrap();
    assert_eq!(parsed.input, "Atlas");
    assert_eq!(parsed.list.as_deref(), Some("Atlas Notes, Atlas Log"));
    assert_eq!(parsed.opening, "No page \"Atlas\". Closest: ");
    let bare = parse_not_found(&message("2025-01-01", None)).unwrap();
    assert_eq!((bare.opening.as_str(), bare.list), ("No page \"2025-01-01\".", None));
    // A JSON-RPC error carries its code in front, more than once; an escaped quote stays in the input
    let wrapped = format!("MCP error -32602: MCP error -32602: {}", message("a \"b\"", Some("A B")));
    let parsed = parse_not_found(&wrapped).unwrap();
    assert_eq!(parsed.input, "a \"b\"");
    assert!(parsed.opening.starts_with("MCP error -32602: MCP error -32602: No page "));
    assert!(parse_not_found("No page \"a\". Closest: . Try something.").is_none());
    assert!(parse_not_found("Page not found").is_none());
}

#[test]
fn the_closest_name_rules_judge_a_list() {
    let candidates = names(&["Atlas", "Atlas Notes", "Atlantis", "Beta Atlas Log", "Gamma"]);
    // Exact before prefix, then names that cover every word
    assert_eq!(check_list("Atlas, Atlas Notes, Beta Atlas Log", "atlas", &candidates), Vec::<String>::new());
    // A prefix match before the exact match breaks rule 4
    assert!(check_list("Atlas Notes, Atlas, Beta Atlas Log", "atlas", &candidates).iter().any(|f| f.starts_with("rule 4")));
    // A name that doesn't cover the input breaks rule 5
    assert!(check_list("Atlas, Gamma", "atlas", &candidates).iter().any(|f| f.starts_with("rule 5")));
    // Leaving out a name that covers the input, when there is room, breaks rule 6
    assert!(check_list("Atlas", "atlas", &candidates).iter().any(|f| f.starts_with("rule 6")));
    // A name that is no candidate breaks rule 3
    assert!(check_list("Atlas, Nowhere", "atlas", &candidates).iter().any(|f| f.starts_with("rule 3")));
    // The fold drops accents and case, and a name's characters may be apart
    assert_eq!(fold("  Cafe\u{301} "), "cafe");
    assert_eq!(matches_of("cafe", &names(&["Café", "Cafeteria"])).exact, names(&["Café"]));
    assert_eq!(matches_of("ata", &names(&["Atlas", "Gamma"])).covering, names(&["Atlas"]));
    // A name with ", " in it is read as one name, whichever way is longest
    assert_eq!(split_list("A, B, C", &names(&["A, B", "C"])), vec![names(&["A, B", "C"])]);
    assert!(check_reference_list(&message("a, b", Some("A, B")), &names(&["A, B", "A", "B"])).iter().any(|f| f.contains("two ways")));
}

#[test]
fn every_wrong_closest_name_list_is_caught() {
    let cases = cases_for_this_build();
    let mut applied = vec![0; WRONG_LIST_LABELS.len()];
    let mut not_caught = Vec::new();
    for case in &cases {
        let candidates = candidates_of(case);
        for site in not_found_sites(&case.expected) {
            let reference = read_message(&case.expected, site).unwrap();
            for wrong in wrong_lists(&reference, &candidates) {
                applied[WRONG_LIST_LABELS.iter().position(|l| *l == wrong.label).unwrap()] += 1;
                if compare_results(&case.expected, &with_message(&case.expected, site, &wrong.message), &candidates).is_empty() {
                    not_caught.push(format!("{} in {:?}", wrong.label, case.name));
                }
            }
        }
    }
    assert!(not_caught.is_empty(), "not caught: {not_caught:?}");
    for (label, count) in WRONG_LIST_LABELS.iter().zip(applied) {
        assert!(count > 0, "no recorded case a wrong list of the kind {label:?} applies to");
    }
}

// ---- the table both comparators are held to

#[test]
fn the_comparator_gives_the_verdict_of_every_row_of_the_shared_table() {
    let table = load_comparator_table();
    let wrong: Vec<String> = table
        .iter()
        .filter(|row| compare_results(&row.expected, &row.actual, &[]).is_empty() != row.same)
        .map(|row| format!("{}: expected the verdict {}", row.name, if row.same { "same" } else { "differs" }))
        .collect();
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    assert!(table.iter().any(|row| row.same) && table.iter().any(|row| !row.same), "the table needs rows of both verdicts");
    // What is the same is the same both ways round
    for row in table.iter().filter(|row| row.same) {
        assert!(compare_results(&row.actual, &row.expected, &[]).is_empty(), "{}: same one way, different the other", row.name);
    }
}
