//! The comparator's own rules (#379): what `parity_support/compare.rs` and `suggestion_rules.rs` accept and reject,
//! each shown on small values that are made up. `parity.rs` runs the comparator over every recorded case and
//! shows it can fail on each of them; this file holds the rules one by one, the ones the Node harness's tests held
//! before that harness was retired.
//!
//! The rules:
//! - the LogSeq calls (`compare_calls`, ADR-0034 Decision 5): each call made matches a recorded call, in any order, a
//!   query asked twice is matched in the recorded order, at most the case's ceiling are made, and all are reads
//!   (`stale_ceiling` is the other side: fewer than the ceiling is a failure to lower it, for a run of the cases as committed);
//! - a result: its keys and content blocks, a JSON text by deep equality and minified, every other text byte for
//!   byte, a resource's `contents`, a prompt's messages, a JSON-RPC error (`compare_results`);
//! - `tools/list` by meaning (ADR-0031): the normalization of a schema and the failures it still reports;
//! - the closest names of a missing page by the rules of ADR-0032.

mod parity_support;

use parity_support::cases::{Canned, Case, Request, load_cases, load_tool_list};
use parity_support::compare::{check_wrong_lists, compare_calls, compare_results, compare_tool_lists, is_read_method, normalize_schema, stale_ceiling};
use parity_support::stub::{Call, DATASCRIPT_QUERY};
use parity_support::suggestion_rules::{
    GUIDANCE, REQUIRED_CASES, candidates_of, check_list, check_reference_list, check_reference_lists, fold, matches_of, missing_required_cases, parse_not_found,
    required_kinds_of, split_list,
};
use serde_json::{Map, Value, json};

// ---- the LogSeq calls

fn editor(method: &str) -> Canned {
    Canned { method: format!("logseq.Editor.{method}"), args: vec![], response: json!([]) }
}

fn q(text: &str, input: &str) -> Canned {
    Canned { method: DATASCRIPT_QUERY.to_owned(), args: vec![json!(text), json!(input)], response: json!([]) }
}

fn made(canned: &Canned) -> Call {
    Call { method: canned.method.clone(), args: canned.args.clone() }
}

fn made_all(canned: &[&Canned]) -> Vec<Call> {
    canned.iter().map(|c| made(c)).collect()
}

fn permutations<T: Clone>(items: &[T]) -> Vec<Vec<T>> {
    if items.len() <= 1 {
        return vec![items.to_vec()];
    }
    (0..items.len())
        .flat_map(|i| {
            let mut rest = items.to_vec();
            let item = rest.remove(i);
            permutations(&rest).into_iter().map(move |mut tail| {
                tail.insert(0, item.clone());
                tail
            })
        })
        .collect()
}

#[test]
fn the_calls_may_be_made_in_any_order_and_in_any_grouping() {
    let (a, b, c) = (q("[:find ?a]", "\"alice\""), q("[:find ?b]", "\"bob\""), editor("getAllPages"));
    // However the recorded server grouped them, and in whatever order they arrive
    for steps in [vec![vec![a.clone()], vec![b.clone(), c.clone()]], vec![vec![a.clone(), b.clone(), c.clone()]], vec![vec![a.clone()], vec![b.clone()], vec![c.clone()]]] {
        for order in permutations(&[&a, &b, &c]) {
            assert_eq!(compare_calls(&steps, 3, &made_all(&order)), Vec::<String>::new());
        }
    }
}

#[test]
fn a_recorded_call_never_made_is_not_a_failure_and_fewer_calls_than_the_ceiling_pass() {
    let (a, b, c) = (q("[:find ?a]", "\"alice\""), q("[:find ?b]", "\"bob\""), editor("getAllPages"));
    let steps = [vec![a.clone()], vec![b.clone(), c.clone()]];
    assert_eq!(compare_calls(&steps, 3, &made_all(&[&a, &c])), Vec::<String>::new());
    assert_eq!(compare_calls(&steps, 3, &made_all(&[&b])), Vec::<String>::new());
    assert_eq!(compare_calls(&steps, 3, &[]), Vec::<String>::new());
    // A ceiling below the recorded count (a call saved, the ceiling lowered) leaves the extra fixture unused
    assert_eq!(compare_calls(&steps, 2, &made_all(&[&a, &b])), Vec::<String>::new());
}

#[test]
fn a_call_no_recorded_call_answers_fails_the_case_whatever_else_is_true() {
    let (a, b) = (q("[:find ?a]", "\"alice\""), q("[:find ?b]", "\"bob\""));
    let steps = [vec![a.clone()]];
    // Another input, another query, another method: each is one failure, with the ceiling out of the way
    for wrong in [q("[:find ?a]", "\"Alice\""), b.clone(), editor("getAllPages")] {
        let failures = compare_calls(&steps, 9, &made_all(&[&a, &wrong]));
        assert_eq!(failures.len(), 1, "{wrong:?}: {failures:?}");
        assert!(failures[0].contains("no recorded call answers"), "{failures:?}");
    }
    // The call a case does record, made in place of the wrong one, passes
    assert!(compare_calls(&steps, 9, &made_all(&[&a])).is_empty());
    // An input added, or taken away
    let mut more = a.clone();
    more.args.push(json!("extra"));
    assert_eq!(compare_calls(&steps, 9, &made_all(&[&more])).len(), 1);
    let mut fewer = a.clone();
    fewer.args.pop();
    assert_eq!(compare_calls(&steps, 9, &made_all(&[&fewer])).len(), 1);
}

#[test]
fn a_query_asked_more_than_it_was_recorded_has_no_recorded_call_left_to_answer_it() {
    let a = q("[:find ?a]", "\"alice\"");
    let steps = [vec![a.clone()], vec![a.clone()]];
    assert_eq!(compare_calls(&steps, 2, &made_all(&[&a, &a])), Vec::<String>::new());
    // The third is answered by nothing, and is over the ceiling too: two failures
    let third = compare_calls(&steps, 2, &made_all(&[&a, &a, &a]));
    assert_eq!(third.len(), 2, "{third:?}");
    assert!(third.iter().any(|f| f.contains("no recorded call answers")) && third.iter().any(|f| f.contains("ceiling")), "{third:?}");
    // And with room under the ceiling, it is still the third that fails
    assert_eq!(compare_calls(&steps, 9, &made_all(&[&a, &a, &a])).len(), 1);
}

#[test]
fn more_calls_than_the_ceiling_fail_even_when_each_matches_a_recorded_call() {
    let (a, b) = (q("[:find ?a]", "\"alice\""), q("[:find ?b]", "\"bob\""));
    let steps = [vec![a.clone(), b.clone()]];
    assert_eq!(compare_calls(&steps, 2, &made_all(&[&a, &b])), Vec::<String>::new());
    let over = compare_calls(&steps, 1, &made_all(&[&a, &b]));
    assert_eq!(over.len(), 1);
    assert!(over[0].contains("2 call(s), over the case's ceiling of 1"), "{over:?}");
    // A ceiling of nothing allows nothing
    assert_eq!(compare_calls(&steps, 0, &made_all(&[&a])).len(), 1);
    assert_eq!(compare_calls(&steps, 0, &[]), Vec::<String>::new());
}

#[test]
fn a_ceiling_above_the_calls_made_is_stale_and_names_the_command_that_lowers_it() {
    assert_eq!(stale_ceiling(3, 3), None);
    assert_eq!(stale_ceiling(0, 0), None);
    // Over the ceiling is compare_calls' failure, not this one
    assert_eq!(stale_ceiling(2, 3), None);
    let stale = stale_ceiling(4, 3).expect("a ceiling above the calls made");
    assert!(stale.contains("made 3 call(s), under the case's ceiling of 4") && stale.contains("PARITY_RECORD=1 cargo test --test parity_record"), "{stale}");
    assert!(stale_ceiling(1, 0).is_some());
}

#[test]
fn every_call_is_a_read_the_recorded_ones_and_the_made_ones() {
    for read in ["logseq.DB.datascriptQuery", "logseq.DB.q", "logseq.Editor.getPage", "logseq.Editor.getAllPages", "logseq.Editor.getPageLinkedReferences", "logseq.App.getCurrentGraph"] {
        assert!(is_read_method(read), "{read} is a read");
    }
    for write in [
        "logseq.Editor.insertBlock",
        "logseq.Editor.updateBlock",
        "logseq.Editor.createPage",
        "logseq.Editor.deletePage",
        "logseq.Editor.removeBlock",
        "logseq.Editor.upsertBlockProperty",
        "logseq.App.setCurrentGraphConfigs",
        "logseq.Editor.get",
        "logseq.Editor.getting",
        "getPage",
        "",
    ] {
        assert!(!is_read_method(write), "{write:?} is not a read");
    }
    let insert = Canned { method: "logseq.Editor.insertBlock".into(), args: vec![json!("page"), json!("text")], response: json!({"id": 1}) };
    // A recorded write fails the case, though the server made it exactly as recorded and within the ceiling
    let recorded = compare_calls(&[vec![insert.clone()]], 1, &made_all(&[&insert]));
    assert!(recorded.iter().any(|f| f.contains("recorded call") && f.contains("not a read")), "{recorded:?}");
    assert!(recorded.iter().any(|f| f.contains("made a call that is not a read")), "{recorded:?}");
    // A write the server made, with every recorded call a read, fails
    let a = q("[:find ?a]", "\"alice\"");
    let made = compare_calls(&[vec![a.clone()]], 9, &made_all(&[&a, &insert]));
    assert_eq!(made.len(), 1, "{made:?}");
    assert!(made[0].contains("not a read"), "{made:?}");
}

// ---- a result: keys, blocks and texts

fn text_result(text: &str) -> Value {
    json!({"content": [{"type": "text", "text": text}]})
}

#[test]
fn an_absent_is_error_is_not_is_error_false_and_the_content_blocks_are_counted() {
    let result = text_result(r#"{"page":"Alice"}"#);
    let with_flag = |flag: bool| {
        let mut copy = result.clone();
        copy["isError"] = json!(flag);
        copy
    };
    assert_eq!(compare_results(&result, &with_flag(false), &[]), vec!["the result has unexpected key(s) isError".to_owned()]);
    assert_eq!(compare_results(&with_flag(false), &result, &[]), vec!["the result lacks key(s) isError".to_owned()]);
    assert_eq!(compare_results(&with_flag(false), &with_flag(true), &[]).len(), 1);
    let mut two_blocks = result.clone();
    two_blocks["content"].as_array_mut().unwrap().push(json!({"type": "text", "text": "{}"}));
    assert_eq!(compare_results(&result, &two_blocks, &[]), vec!["expected 1 content block(s), got 2".to_owned()]);
}

#[test]
fn any_key_the_recorded_server_did_not_send_is_a_failure() {
    let result = text_result(r#"{"page":"Alice"}"#);
    let mut structured = result.clone();
    structured["structuredContent"] = json!({"page": "Alice"});
    assert_eq!(compare_results(&result, &structured, &[]), vec!["the result has unexpected key(s) structuredContent".to_owned()]);
    let mut meta = result.clone();
    meta["_meta"] = json!({});
    assert_eq!(compare_results(&result, &meta, &[]).len(), 1);
    let mut annotated = result.clone();
    annotated["content"][0]["annotations"] = json!({"priority": 1});
    assert_eq!(compare_results(&result, &annotated, &[]), vec!["content[0] has unexpected key(s) annotations".to_owned()]);
    let (mut one, mut other) = (result.clone(), result.clone());
    one["_meta"] = json!({"a": 1});
    other["_meta"] = json!({"a": 2});
    assert_eq!(compare_results(&one, &other, &[]), vec![r#"_meta: expected {"a":1}, got {"a":2}"#.to_owned()]);
}

#[test]
fn a_resource_is_compared_by_the_text_of_each_block_and_its_other_fields() {
    let block = json!({"uri": "logseq://page/Alice", "mimeType": "text/markdown", "text": "# Alice\n"});
    let read = json!({"contents": [block]});
    assert_eq!(compare_results(&read, &read, &[]), Vec::<String>::new());
    let with_block = |change: &dyn Fn(&mut Value)| {
        let mut copy = block.clone();
        change(&mut copy);
        json!({"contents": [copy]})
    };
    let failures = compare_results(&read, &with_block(&|b| b["text"] = json!("# Alice \n")), &[]);
    assert_eq!(failures.len(), 1);
    assert!(failures[0].contains("contents[0].text differs at character 7"), "{failures:?}");
    assert_eq!(
        compare_results(&read, &with_block(&|b| b["mimeType"] = json!("text/plain")), &[]),
        vec![r#"contents[0].mimeType: expected "text/markdown", got "text/plain""#.to_owned()]
    );
    assert_eq!(compare_results(&read, &json!({"contents": [block, block]}), &[]), vec!["expected 1 contents block(s), got 2".to_owned()]);
    assert_eq!(compare_results(&read, &with_block(&|b| drop(b.as_object_mut().unwrap().remove("mimeType"))), &[]), vec!["contents[0] lacks key(s) mimeType".to_owned()]);
}

#[test]
fn a_json_rpc_error_recorded_as_a_result_is_compared_by_value() {
    let error = json!({"error": {"code": -32002, "message": "No page"}});
    assert_eq!(compare_results(&error, &error, &[]), Vec::<String>::new());
    assert_eq!(compare_results(&error, &json!({"error": {"code": -32602, "message": "No page"}}), &[]).len(), 1);
    assert_eq!(compare_results(&error, &json!({"error": {"code": -32002, "message": "No page", "data": {"uri": "x"}}}), &[]).len(), 1);
}

#[test]
fn a_prompt_is_compared_by_the_text_of_each_message_and_everything_else_by_value() {
    let message = |text: &str| json!({"role": "user", "content": {"type": "text", "text": text}});
    let prompt = |description: &str, messages: Vec<Value>| json!({"description": description, "messages": messages});
    let got = prompt("Weekly", vec![message("Write a summary\nSteps:")]);
    assert_eq!(compare_results(&got, &got, &[]), Vec::<String>::new());
    let failures = compare_results(&got, &prompt("Weekly", vec![message("Write a summary\nSteps: ")]), &[]);
    assert_eq!(failures.len(), 1);
    assert!(failures[0].contains("messages[0] text differs at character 22"), "{failures:?}");
    assert_eq!(compare_results(&got, &prompt("Weekly", vec![message("Write a summary\nSteps:"), message("more")]), &[]), vec!["expected 1 message(s), got 2".to_owned()]);
    let assistant = json!({"role": "assistant", "content": {"type": "text", "text": "Write a summary\nSteps:"}});
    let failures = compare_results(&got, &prompt("Weekly", vec![assistant]), &[]);
    assert_eq!(failures.len(), 1);
    assert!(failures[0].starts_with("messages[0]: expected"), "{failures:?}");
    assert_eq!(compare_results(&got, &prompt("Monthly", vec![message("Write a summary\nSteps:")]), &[]), vec![r#"description: expected "Weekly", got "Monthly""#.to_owned()]);
}

// ---- tools/list, by meaning (ADR-0031)

/// The tool list with one tool's input schema edited.
fn with_schema(tools: &[Value], name: &str, edit: impl FnOnce(&mut Value)) -> Vec<Value> {
    let mut copy = tools.to_vec();
    let tool = copy.iter_mut().find(|t| t["name"] == name).unwrap_or_else(|| panic!("no tool {name}"));
    edit(&mut tool["inputSchema"]);
    copy
}

/// Keys in reverse order, all the way down, so that only key order differs.
fn reversed_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(reversed_keys).collect()),
        Value::Object(map) => Value::Object(map.iter().rev().map(|(k, v)| (k.clone(), reversed_keys(v))).collect()),
        other => other.clone(),
    }
}

/// A word the way the Node harness cased a definition's name: `relationship_type` is `RelationshipType`.
fn def_name(name: &str) -> String {
    let mut out = String::new();
    let mut upper = true;
    for c in name.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// An input schema written the way schemars writes the same contract: enums under `$defs`, reached by `$ref` (an
/// `allOf` wrapper when required, an `anyOf` with null when optional), other optional fields typed `[T, "null"]`,
/// `format` on numbers, `title` on everything, `$schema`, the `required` list reversed and every object's keys
/// reversed. The meaning is unchanged.
fn schemars_style(schema: &Value) -> Value {
    let required: Vec<&str> = schema.get("required").and_then(Value::as_array).map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut defs = Map::new();
    let mut properties = Map::new();
    for (name, property) in schema["properties"].as_object().expect("a tool schema has properties") {
        let mut rest = property.as_object().unwrap().clone();
        let description = rest.remove("description");
        let with_description = |mut object: Map<String, Value>| {
            if let Some(description) = &description {
                object.insert("description".to_owned(), description.clone());
            }
            Value::Object(object)
        };
        if rest.contains_key("enum") {
            let def = def_name(name);
            let mut definition = Map::new();
            definition.insert("title".to_owned(), json!(def));
            definition.extend(rest);
            defs.insert(def.clone(), Value::Object(definition));
            let reference = json!({"$ref": format!("#/$defs/{def}")});
            let wrapped = if required.contains(&name.as_str()) { json!({"allOf": [reference]}) } else { json!({"anyOf": [reference, {"type": "null"}]}) };
            properties.insert(name.clone(), with_description(wrapped.as_object().unwrap().clone()));
            continue;
        }
        let mut titled = rest.clone();
        titled.insert("title".to_owned(), json!(name));
        if property.get("type") == Some(&json!("number")) {
            titled.insert("format".to_owned(), json!("double"));
        }
        if !required.contains(&name.as_str()) {
            if let Some(kind) = property.get("type").and_then(Value::as_str) {
                titled.insert("type".to_owned(), json!([kind, "null"]));
            }
        }
        properties.insert(name.clone(), with_description(titled));
    }
    let mut out = Map::new();
    out.insert("$schema".to_owned(), json!("https://json-schema.org/draft/2020-12/schema"));
    out.insert("title".to_owned(), json!("Args"));
    out.extend(schema.as_object().unwrap().clone());
    out.insert("properties".to_owned(), Value::Object(properties));
    if let Some(list) = schema.get("required").and_then(Value::as_array) {
        out.insert("required".to_owned(), Value::Array(list.iter().rev().cloned().collect()));
    }
    out.insert("$defs".to_owned(), Value::Object(defs));
    reversed_keys(&Value::Object(out))
}

fn quirky(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            let mut copy = tool.clone();
            copy["inputSchema"] = schemars_style(&tool["inputSchema"]);
            copy
        })
        .collect()
}

#[test]
fn the_recorded_tool_list_has_every_tool_and_equals_itself() {
    let tools = load_tool_list();
    assert_eq!(tools.len(), 16);
    assert_eq!(compare_tool_lists(&tools, &tools.clone()), Vec::<String>::new());
}

#[test]
fn a_list_that_differs_only_in_serialization_quirks_is_equal() {
    let tools = load_tool_list();
    let rewritten = quirky(&tools);
    // The rewrite reached every quirk it is meant to show
    let text = Value::Array(rewritten.clone()).to_string();
    for quirk in ["\"$ref\"", "\"$defs\"", "\"allOf\"", "{\"type\":\"null\"}", "\"null\"]", "\"format\":\"double\"", "\"title\":\"limit\"", "\"$schema\""] {
        assert!(text.contains(quirk), "the rewrite shows no {quirk}");
    }
    assert_eq!(compare_tool_lists(&tools, &rewritten), Vec::<String>::new());
}

/// The list with every whole `default` and `maxLength` written as a float, and how many were.
fn with_floats(value: &Value, count: &mut usize) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|v| with_floats(v, count)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, v)| match (key.as_str(), v.as_u64()) {
                    ("default" | "maxLength", Some(n)) => {
                        *count += 1;
                        (key.clone(), json!(n as f64))
                    }
                    _ => (key.clone(), with_floats(v, count)),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

#[test]
fn numbers_are_compared_by_value() {
    let tools = load_tool_list();
    let mut count = 0;
    let floats: Vec<Value> = tools.iter().map(|t| with_floats(t, &mut count)).collect();
    assert!(count > 10, "only {count} numbers were written as floats");
    assert!(Value::Array(floats.clone()).to_string().contains("50.0"), "the default 50 is a float now");
    assert_eq!(compare_tool_lists(&tools, &floats), Vec::<String>::new());
}

#[test]
fn a_changed_bound_type_enum_value_required_field_or_description_fails_with_its_path_and_both_values() {
    let tools = load_tool_list();
    let changed: Vec<(&str, Vec<Value>, &str)> = vec![
        ("bound", with_schema(&tools, "logseq_check_links", |s| s["properties"]["after"]["maxLength"] = json!(50001)), "logseq_check_links.inputSchema.properties.after.maxLength: expected 50000, got 50001"),
        ("type", with_schema(&tools, "logseq_build_context", |s| s["properties"]["max_blocks"]["type"] = json!("number")), "logseq_build_context.inputSchema.properties.max_blocks.type: expected \"integer\", got \"number\""),
        ("enum value", with_schema(&tools, "logseq_get_page", |s| s["properties"]["format"]["enum"] = json!(["json", "md"])), "logseq_get_page.inputSchema.properties.format.enum[1]: expected \"markdown\", got \"md\""),
        ("required field", with_schema(&tools, "logseq_build_context", |s| s["required"] = json!([])), "logseq_build_context.inputSchema.required: expected [\"topic_name\"], got []"),
        ("parameter description", with_schema(&tools, "logseq_build_context", |s| {
            let text = s["properties"]["max_blocks"]["description"].as_str().unwrap().to_owned();
            s["properties"]["max_blocks"]["description"] = json!(format!("{text}!"));
        }), "logseq_build_context.inputSchema.properties.max_blocks.description: expected"),
        ("tool description", tools.iter().map(|t| if t["name"] == "logseq_get_block" { let mut c = t.clone(); c["description"] = json!(format!("{} ", t["description"].as_str().unwrap())); c } else { t.clone() }).collect(), "logseq_get_block.description: expected"),
        ("default", with_schema(&tools, "logseq_build_context", |s| s["properties"]["max_blocks"]["default"] = json!(51)), "logseq_build_context.inputSchema.properties.max_blocks.default: expected 50, got 51"),
        ("additionalProperties", with_schema(&tools, "logseq_get_page", |s| s["additionalProperties"] = json!(false)), "logseq_get_page.inputSchema.additionalProperties: expected nothing, got false"),
    ];
    for (what, list, line) in &changed {
        let failures = compare_tool_lists(&tools, list);
        assert_eq!(failures.len(), 1, "{what}: {failures:?}");
        assert!(failures[0].contains(line), "{what}: {failures:?}");
    }
    // Enum values are compared in order: the same values swapped is a difference
    let swapped = with_schema(&tools, "logseq_get_page", |s| s["properties"]["format"]["enum"] = json!(["markdown", "json"]));
    assert_eq!(
        compare_tool_lists(&tools, &swapped),
        vec![
            "logseq_get_page.inputSchema.properties.format.enum[0]: expected \"json\", got \"markdown\"".to_owned(),
            "logseq_get_page.inputSchema.properties.format.enum[1]: expected \"markdown\", got \"json\"".to_owned()
        ]
    );
    // A change is still caught when the schema is in the quirky form
    let bound = quirky(&with_schema(&tools, "logseq_check_links", |s| s["properties"]["after"]["maxLength"] = json!(1)));
    let failures = compare_tool_lists(&tools, &bound);
    assert_eq!(failures.len(), 1);
    assert!(failures[0].contains("after.maxLength: expected 50000, got 1"), "{failures:?}");
    let enum_value = quirky(&with_schema(&tools, "logseq_search_by_relationship", |s| s["properties"]["relationship_type"]["enum"][0] = json!("refs")));
    let failures = compare_tool_lists(&tools, &enum_value);
    assert_eq!(failures.len(), 1);
    assert!(failures[0].contains("relationship_type.enum[0]: expected \"references\", got \"refs\""), "{failures:?}");
}

#[test]
fn a_missing_renamed_or_retitled_tool_and_changed_annotations_fail() {
    let tools = load_tool_list();
    assert_eq!(compare_tool_lists(&tools, &tools[1..]), vec![format!("{}: missing", tools[0]["name"].as_str().unwrap())]);
    let edit = |name: &str, change: &dyn Fn(&mut Value)| -> Vec<Value> {
        tools
            .iter()
            .map(|t| {
                let mut copy = t.clone();
                if t["name"] == name {
                    change(&mut copy);
                }
                copy
            })
            .collect()
    };
    let renamed = edit("logseq_get_page", &|t| t["name"] = json!("logseq_get_page_v2"));
    assert_eq!(compare_tool_lists(&tools, &renamed), vec!["logseq_get_page: missing".to_owned(), "logseq_get_page_v2: not in the reference".to_owned()]);
    let retitled = edit("logseq_get_page", &|t| t["title"] = json!("Page"));
    assert_eq!(compare_tool_lists(&tools, &retitled), vec!["logseq_get_page.title: expected \"Get Page\", got \"Page\"".to_owned()]);
    let annotated = edit("logseq_get_page", &|t| t["annotations"]["readOnlyHint"] = json!(false));
    assert_eq!(compare_tool_lists(&tools, &annotated), vec!["logseq_get_page.annotations.readOnlyHint: expected true, got false".to_owned()]);
}

#[test]
fn a_property_named_format_and_a_null_on_a_required_property_still_count() {
    let tools = load_tool_list();
    let no_format = with_schema(&tools, "logseq_get_page", |s| drop(s["properties"].as_object_mut().unwrap().remove("format")));
    let failures = compare_tool_lists(&tools, &no_format);
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].starts_with("logseq_get_page.inputSchema.properties.format: expected {") && failures[0].ends_with(", got nothing"), "{failures:?}");
    assert!(failures[0].contains(r#""enum":["json","markdown"]"#), "{failures:?}");
    // The tools with a `format` parameter: its enum and description still count
    let with_format: Vec<&str> = tools.iter().filter(|t| t["inputSchema"]["properties"].get("format").is_some()).map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(with_format.len(), 5, "{with_format:?}");
    for name in with_format {
        let enum_changed = with_schema(&tools, name, |s| s["properties"]["format"]["enum"] = json!(["json"]));
        assert_eq!(compare_tool_lists(&tools, &enum_changed), vec![format!("{name}.inputSchema.properties.format.enum: expected [\"json\",\"markdown\"], got [\"json\"]")], "{name}");
        let described = quirky(&with_schema(&tools, name, |s| s["properties"]["format"]["description"] = json!("other")));
        let failures = compare_tool_lists(&tools, &described);
        assert_eq!(failures.len(), 1, "{name}: {failures:?}");
        assert!(failures[0].starts_with(&format!("{name}.inputSchema.properties.format.description: expected \"")) && failures[0].ends_with(", got \"other\""), "{name}: {failures:?}");
    }
    let nullable = with_schema(&tools, "logseq_build_context", |s| s["properties"]["topic_name"]["type"] = json!(["string", "null"]));
    assert_eq!(
        compare_tool_lists(&tools, &nullable),
        vec!["logseq_build_context.inputSchema.properties.topic_name.type: expected \"string\", got [\"string\",\"null\"]".to_owned()]
    );
}

fn tool_with(schema: Value) -> Vec<Value> {
    vec![json!({"name": "x", "inputSchema": schema})]
}

#[test]
fn a_schema_is_normalized_to_its_meaning() {
    let schema = json!({"$schema": "x", "type": "object", "properties": {"a": {"$ref": "#/$defs/A"}}, "required": ["b", "a"], "$defs": {"A": {"type": "string"}}});
    assert_eq!(normalize_schema(&schema).unwrap(), json!({"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a", "b"]}));
    // What was given is not changed: the normalization takes a reference, and the same call twice gives the same value
    assert_eq!(normalize_schema(&schema), normalize_schema(&schema));
}

#[test]
fn a_parameter_named_like_a_keyword_is_kept() {
    let schema = json!({
        "properties": {"format": {"type": "string", "format": "x"}, "title": {"type": "string"}, "$schema": {"type": "number"}, "$ref": {"type": "boolean"}},
        "patternProperties": {"^title$": {"type": "string", "title": "T"}},
        "dependentSchemas": {"format": {"required": ["b", "a"]}}
    });
    assert_eq!(
        normalize_schema(&schema).unwrap(),
        json!({
            "properties": {"format": {"type": "string"}, "title": {"type": "string"}, "$schema": {"type": "number"}, "$ref": {"type": "boolean"}},
            "patternProperties": {"^title$": {"type": "string"}},
            "dependentSchemas": {"format": {"required": ["a", "b"]}}
        })
    );
}

#[test]
fn quirks_are_normalized_under_every_subschema_position_and_a_real_difference_there_still_shows() {
    // One schema with a leaf at each position; `leaf` is the plain form, `quirky_leaf` the same meaning
    fn nest(leaf: &mut dyn FnMut(u32) -> Value) -> Value {
        json!({
            "type": "object",
            "properties": {
                "a": {"type": "array", "items": leaf(1), "prefixItems": [leaf(2)], "contains": leaf(3), "unevaluatedItems": leaf(17)},
                // Draft 2019-09 and earlier: a list of `items`, then `additionalItems`
                "b": {"type": "array", "items": [leaf(18)], "additionalItems": leaf(19)}
            },
            "unevaluatedProperties": leaf(20),
            "additionalProperties": leaf(4),
            "patternProperties": {"^x": leaf(5)},
            "propertyNames": leaf(6),
            "dependentSchemas": {"a": leaf(7)},
            "not": leaf(8),
            "anyOf": [leaf(9), {"type": "null", "description": "kept: not an optional property"}],
            "oneOf": [leaf(10), leaf(11)],
            "allOf": [leaf(12), leaf(13)],
            "if": leaf(14),
            "then": leaf(15),
            "else": leaf(16)
        })
    }
    let mut leaf = |n: u32| json!({"type": "string", "maxLength": n, "enum": ["p", "q"]});
    let mut defs = Map::new();
    let mut quirky_form = nest(&mut |n: u32| {
        defs.insert(format!("L{n}"), json!({"title": format!("L{n}"), "format": "f", "enum": ["p", "q"], "maxLength": n, "type": "string"}));
        json!({"$ref": format!("#/definitions/L{n}")})
    });
    quirky_form["$schema"] = json!("s");
    quirky_form["definitions"] = Value::Object(defs);
    let plain = nest(&mut leaf);
    assert_eq!(normalize_schema(&quirky_form).unwrap(), normalize_schema(&plain).unwrap());
    let text = normalize_schema(&quirky_form).unwrap().to_string();
    for gone in ["\"$ref\"", "\"definitions\"", "\"format\"", "\"title\"", "\"$schema\""] {
        assert!(!text.contains(gone), "{gone} is left in {text}");
    }
    for n in 1..=20 {
        let mut changed = quirky_form.clone();
        changed["definitions"][format!("L{n}")]["maxLength"] = json!(99);
        let failures = compare_tool_lists(&tool_with(plain.clone()), &tool_with(changed));
        assert_eq!(failures.len(), 1, "position {n}: {failures:?}");
        assert!(failures[0].ends_with(&format!("maxLength: expected {n}, got 99")), "position {n}: {failures:?}");
    }
}

#[test]
fn keywords_that_clash_with_a_ref_stay_as_an_all_of_so_they_still_differ() {
    let schema = json!({"properties": {"a": {"$ref": "#/$defs/A", "type": "number"}}, "$defs": {"A": {"type": "string"}}});
    assert_eq!(normalize_schema(&schema).unwrap(), json!({"properties": {"a": {"allOf": [{"type": "string"}, {"type": "number"}]}}}));
}

#[test]
fn a_recursive_dangling_or_anchor_ref_is_a_failure_and_not_a_loop() {
    let recursive = json!({"properties": {"a": {"$ref": "#/$defs/A"}}, "$defs": {"A": {"properties": {"b": {"$ref": "#/$defs/A"}}}}});
    let failures = compare_tool_lists(&tool_with(json!({})), &tool_with(recursive));
    assert!(failures.len() == 1 && failures[0].contains("is recursive"), "{failures:?}");
    let failures = compare_tool_lists(&tool_with(json!({})), &tool_with(json!({"$ref": "#/$defs/Nope"})));
    assert!(failures.len() == 1 && failures[0].contains("points at nothing"), "{failures:?}");
    // An anchor is not a JSON pointer: it fails rather than resolving to the root
    let anchored = json!({"properties": {"a": {"$ref": "#Foo"}}, "$defs": {"Foo": {"$anchor": "Foo", "type": "string"}}});
    let failures = compare_tool_lists(&tool_with(json!({})), &tool_with(anchored));
    assert!(failures.len() == 1 && failures[0].contains("only local JSON pointers are supported"), "{failures:?}");
}

#[test]
fn null_is_dropped_only_from_optional_top_level_arguments_and_not_from_nested_objects() {
    let schema = |a: Value, b: Value| json!({"type": "object", "properties": {"a": a, "opts": {"type": "object", "properties": {"b": b}}}});
    let plain = tool_with(schema(json!({"type": "string"}), json!({"type": "string"})));
    // Top level: the recorded server dropped an explicit null, so these mean the same
    assert_eq!(compare_tool_lists(&plain, &tool_with(schema(json!({"type": ["string", "null"]}), json!({"type": "string"})))), Vec::<String>::new());
    assert_eq!(
        compare_tool_lists(&plain, &tool_with(schema(json!({"anyOf": [{"type": "string"}, {"type": "null"}]}), json!({"type": "string"})))),
        Vec::<String>::new()
    );
    // Nested: the recorded server rejected null there, so accepting it is a difference
    assert_eq!(
        compare_tool_lists(&plain, &tool_with(schema(json!({"type": "string"}), json!({"type": ["string", "null"]})))),
        vec!["x.inputSchema.properties.opts.properties.b.type: expected \"string\", got [\"string\",\"null\"]".to_owned()]
    );
    assert_eq!(compare_tool_lists(&plain, &tool_with(schema(json!({"type": "string"}), json!({"anyOf": [{"type": "string"}, {"type": "null"}]})))).len(), 2);
}

// ---- the closest names of a missing page (ADR-0032)

const PAGES: [&str; 7] = ["Alice", "Alice Notes", "Alicia Cole", "Bob", "Project Atlas", "Project Zed", "Project Quill"];

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|n| (*n).to_owned()).collect()
}

fn message(input: &str, list: Option<&str>) -> String {
    match list {
        Some(list) => format!("No page {}. Closest: {list}. {GUIDANCE}", json!(input)),
        None => format!("No page {}. {GUIDANCE}", json!(input)),
    }
}

/// A tool result as the server prints a page-not-found error: `{"error": <message>}`, minified.
fn tool_error(text: &str) -> Value {
    json!({"content": [{"type": "text", "text": json!({"error": text}).to_string()}], "isError": true})
}

fn resource_error(text: &str) -> Value {
    json!({"error": {"code": -32002, "message": text}})
}

/// The rule failures of a server that printed `list` where the reference printed `reference`, for the input.
fn judge(input: &str, reference: Option<&str>, list: Option<&str>, candidates: &[String]) -> Vec<String> {
    compare_results(&tool_error(&message(input, reference)), &tool_error(&message(input, list)), candidates)
}

fn judge_pages(input: &str, reference: Option<&str>, list: Option<&str>) -> String {
    judge(input, reference, list, &names(&PAGES)).join("\n")
}

const TYPO: &str = "Project Atlas, Project Zed, Project Quill";

#[test]
fn the_fold_trims_drops_accents_and_lowercases_and_the_sets_follow_it() {
    assert_eq!(fold("  Café Ünï  "), "cafe uni");
    let matches = matches_of("cafe", &names(&["CAFÉ", "Café Notes", "Coffee", "Bob"]));
    assert_eq!(matches.exact, names(&["CAFÉ"]));
    assert_eq!(matches.prefix, names(&["Café Notes"]));
    assert_eq!(matches.both, names(&["CAFÉ", "Café Notes"]));
    assert_eq!(matches.covering, names(&["CAFÉ", "Café Notes"]));
}

#[test]
fn the_input_and_the_list_are_read_out_of_the_message_in_a_tool_result_and_in_a_json_rpc_error() {
    let quoted = parse_not_found(&message("say \"hi\"", Some("A, B"))).unwrap();
    assert_eq!((quoted.opening.as_str(), quoted.input.as_str(), quoted.list.as_deref()), ("No page \"say \\\"hi\\\"\". Closest: ", "say \"hi\"", Some("A, B")));
    let bare = parse_not_found(&message("x", None)).unwrap();
    assert_eq!((bare.opening.as_str(), bare.input.as_str(), bare.list), ("No page \"x\".", "x", None));
    // a JSON-RPC error's message is read as it is, and one with a prefix in front is not a not-found message
    assert!(parse_not_found(&format!("MCP error -32002: {}", message("x", Some("A")))).is_none());
    assert!(parse_not_found("No page name in logseq://page/. Use logseq://page/{name}.").is_none());
}

#[test]
fn a_list_is_split_around_names_that_contain_a_comma_longest_first_and_a_second_reading_is_reported() {
    let candidates = names(&["Smith, Alice", "Smith", "Bob"]);
    assert_eq!(split_list("Smith, Alice, Bob", &candidates), vec![names(&["Smith, Alice", "Bob"])]);
    // "Smith" alone fits too, but "Alice" is not a candidate, so there is one reading
    assert_eq!(split_list("Smith, Alice", &candidates), vec![names(&["Smith, Alice"])]);
    // with "Alice" a candidate too there are two readings, the longest-first one first
    let more = names(&["Smith, Alice", "Smith", "Bob", "Alice"]);
    assert_eq!(split_list("Smith, Alice", &more), vec![names(&["Smith, Alice"]), names(&["Smith", "Alice"])]);
    // a choice that leaves the rest unreadable is backed out of: "Smith, Alice" first dead-ends, "Smith" first works
    assert_eq!(split_list("Smith, Alice, Bob", &names(&["Smith", "Smith, Alice", "Alice, Bob"])), vec![names(&["Smith", "Alice, Bob"])]);
    assert_eq!(split_list("Bob, Bob", &names(&["Bob"])), Vec::<Vec<String>>::new());
    assert_eq!(split_list("A, B, C, D", &names(&["A", "B", "C", "D"])), Vec::<Vec<String>>::new());
}

#[test]
fn a_reference_whose_list_can_be_read_two_ways_is_not_recorded() {
    let failures = check_reference_list(&message("smi", Some("Smith, Alice")), &names(&["Smith", "Alice", "Smith, Alice"]));
    assert!(failures.join("\n").contains("in two ways"), "{failures:?}");
}

#[test]
fn a_list_that_the_rules_leave_open_passes() {
    assert_eq!(judge_pages("Projct", Some(TYPO), Some(TYPO)), "");
    // Other names where the rules leave the choice open
    assert_eq!(judge_pages("Projct", Some(TYPO), Some("Project Quill, Project Zed, Project Atlas")), "");
    assert_eq!(judge_pages("alice", Some("Alice, Alice Notes, Alicia Cole"), Some("Alice, Alice Notes, Alicia Cole")), "");
}

#[test]
fn a_message_with_no_list_passes_where_the_reference_has_none() {
    assert_eq!(judge_pages("zzz", None, None), "");
    assert_eq!(judge_pages("2031-12-31", None, None), "");
}

#[test]
fn a_name_is_read_decoded_one_with_a_quote_a_backslash_a_full_stop_or_an_embedded_try() {
    let candidates = names(&["Say \"hi\" \\ bye", "Bob", "Notes v. Try it.", "Notes v2."]);
    let said = "Say \"hi\" \\ bye";
    assert_eq!(judge("say \"hi\"", Some(said), Some(said), &candidates), Vec::<String>::new());
    assert_eq!(judge("notes v", Some("Notes v2., Notes v. Try it."), Some("Notes v. Try it., Notes v2."), &candidates), Vec::<String>::new());
    // the closing is matched at the end of the message, so the full stop of the last name stays in the list
    assert_eq!(parse_not_found(&message("notes v", Some("Notes v2., Notes v. Try it."))).unwrap().list.as_deref(), Some("Notes v2., Notes v. Try it."));
}

#[test]
fn the_page_resource_error_is_read_the_same_way() {
    let reference = resource_error(&message("Projct", Some(TYPO)));
    let swapped = resource_error(&message("Projct", Some("Project Zed, Project Quill, Project Atlas")));
    assert_eq!(compare_results(&reference, &swapped, &names(&PAGES)), Vec::<String>::new());
    let unrelated = resource_error(&message("Projct", Some("Bob")));
    assert!(compare_results(&reference, &unrelated, &names(&PAGES)).join("\n").contains("rule 5"));
}

#[test]
fn rule_5_catches_an_unrelated_name() {
    let failures = judge_pages("Projct", Some(TYPO), Some("Project Atlas, Bob, Project Quill"));
    assert!(failures.contains("rule 5") && failures.contains("\"Bob\" does not cover"), "{failures}");
}

#[test]
fn rule_6_catches_too_few_names_and_allows_fewer_when_fewer_cover() {
    assert!(judge_pages("Projct", Some(TYPO), Some("Project Atlas, Project Zed")).contains("rule 6: 2 name(s) listed, 3 cover"));
    assert_eq!(judge("Projct", Some("Project Atlas"), Some("Project Atlas"), &names(&["Project Atlas", "Bob"])), Vec::<String>::new());
}

#[test]
fn rule_1_catches_a_wrong_frame_and_the_rest_of_the_result_stays_byte_for_byte() {
    let reference = tool_error(&message("Projct", Some(TYPO)));
    let candidates = names(&PAGES);
    let wrong_guidance = tool_error("No page \"Projct\". Closest: Project Atlas. Try something else.");
    assert!(compare_results(&reference, &wrong_guidance, &candidates).join("\n").contains("rule 1"));
    let other_input = tool_error(&message("Projt", Some(TYPO)));
    assert!(compare_results(&reference, &other_input, &candidates).join("\n").contains("rule 1"));
    let mut not_an_error = reference.clone();
    not_an_error["isError"] = json!(false);
    assert!(compare_results(&reference, &not_an_error, &candidates).join("\n").contains("isError"));
}

#[test]
fn rule_2_catches_a_missing_list_and_a_list_the_reference_does_not_have() {
    assert!(judge_pages("Projct", Some(TYPO), None).contains("rule 2: the reference lists closest names, this message lists none"));
    assert!(judge_pages("zzz", None, Some("Bob")).contains("rule 2: the reference lists no closest names, this message does"));
}

#[test]
fn rule_3_catches_a_name_that_is_not_a_candidate_a_repeat_and_four_names() {
    for list in ["Project Atlas, Project Zed, Project Quil", "project atlas, Project Zed, Project Quill", "Project Atlas, Project Atlas, Project Zed", &format!("{TYPO}, Alice")] {
        assert!(judge_pages("Projct", Some(TYPO), Some(list)).contains("rule 3"), "{list}");
    }
}

#[test]
fn rule_4_catches_an_exact_or_prefix_hit_that_is_not_placed_first() {
    let reference = "Alice, Alice Notes, Alicia Cole";
    // a name that only covers the input ahead of the hits
    assert!(judge_pages("alice", Some(reference), Some("Alicia Cole, Alice, Alice Notes")).contains("rule 4: the first 2 name(s) must be exact or prefix matches"));
    // the prefix hit ahead of the exact one
    assert!(judge_pages("alice", Some(reference), Some("Alice Notes, Alice, Alicia Cole")).contains("rule 4: the prefix match \"Alice Notes\" is listed before the exact match \"Alice\""));
    // a prefix hit left out of a list that has a place for it
    let pages = names(&["Project Atlas", "Project Zed", "Project Quill", "Alicia Cole", "Alice"]);
    assert!(judge("proj", Some(TYPO), Some("Project Atlas, Alicia Cole"), &pages).join("\n").contains("rule 4"));
    // an input that folds to nothing has no exact or prefix hit to put first
    assert_eq!(check_list("Bob, Alice, Alice Notes", "   ", &names(&PAGES)), Vec::<String>::new());
}

#[test]
fn rule_4_judges_the_order_among_the_names_listed_and_which_of_several_hits_are_listed_is_open() {
    let cafes = names(&["Café", "Cafe", "Café Notes", "Café Bar"]);
    // "Cafe" is an exact match that is not listed, and "Café" is one that is, first: nothing listed is out of order
    assert_eq!(check_list("Café, Café Notes, Café Bar", "cafe", &cafes), Vec::<String>::new());
    // a listed exact match after a prefix match
    assert!(check_list("Café Notes, Café Bar, Café", "cafe", &cafes).join("\n").contains("rule 4: the prefix match \"Café Notes\" is listed before the exact match \"Café\""));
    assert!(check_list("Café Notes, Café Bar, Cafe", "cafe", &names(&["Cafe", "Café Notes", "Café Bar", "Café Cup"])).join("\n").contains("rule 4"));
    // no exact match listed at all, because the matcher left it out: only prefix matches, all in order
    assert_eq!(check_list("Café Notes, Café Bar, Café Cup", "cafe", &names(&["Cafe", "Café Notes", "Café Bar", "Café Cup"])), Vec::<String>::new());
}

#[test]
fn a_result_with_no_page_not_found_reference_stays_byte_for_byte() {
    let ok = text_result(r#"{"name":"Alice"}"#);
    let candidates = names(&PAGES);
    assert_eq!(compare_results(&ok, &ok, &candidates), Vec::<String>::new());
    assert!(compare_results(&ok, &text_result(r#"{"name":"alice"}"#), &candidates).join("\n").contains("content[0].text differs"));
    // a page-not-found message where the reference printed something else is a plain difference
    assert!(compare_results(&ok, &tool_error(&message("x", Some("Bob"))), &candidates).join("\n").contains("content[0].text differs"));
}

#[test]
fn an_envelope_that_is_not_the_minified_serialization_of_its_message_fails_whatever_the_list_says() {
    let candidates = names(&PAGES);
    let reference = tool_error(&message("Projct", Some(TYPO)));
    let with_text = |text: String| {
        let mut copy = reference.clone();
        copy["content"][0]["text"] = json!(text);
        copy
    };
    let reference_text = reference["content"][0]["text"].as_str().unwrap().to_owned();
    // the same message, pretty-printed
    let pretty = with_text(serde_json::to_string_pretty(&json!({"error": message("Projct", Some(TYPO))})).unwrap());
    assert!(compare_results(&reference, &pretty, &candidates).join("\n").contains("not minified"));
    // the same message with its first letter escaped
    let escaped = with_text(reference_text.replace("No page", "\\u004eo page"));
    let decoded: Value = serde_json::from_str(escaped["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(decoded["error"], json!(message("Projct", Some(TYPO))));
    assert!(compare_results(&reference, &escaped, &candidates).join("\n").contains("not minified"));
    // and a valid list in a reformatted envelope is no better
    let swapped = message("Projct", Some("Project Quill, Project Zed, Project Atlas"));
    let reordered = with_text(serde_json::to_string_pretty(&json!({"error": swapped})).unwrap());
    assert!(compare_results(&reference, &reordered, &candidates).join("\n").contains("content[0].text differs"));
    // the minified one passes
    assert_eq!(compare_results(&reference, &with_text(json!({"error": swapped}).to_string()), &candidates), Vec::<String>::new());
}

#[test]
fn a_result_with_no_message_where_the_reference_has_one_fails() {
    let failures = compare_results(&tool_error(&message("Projct", Some("Project Atlas"))), &text_result(r#"{"name":"Alice"}"#), &names(&PAGES));
    assert!(failures.join("\n").contains("content[0].text differs"), "{failures:?}");
}

// ---- the recorded set (ADR-0032 Decision 3)

#[test]
fn the_recorded_set_holds_every_case_the_adr_requires_and_the_references_pass_the_rules() {
    let cases = load_cases();
    assert_eq!(missing_required_cases(&cases), Vec::<String>::new());
    assert_eq!(check_reference_lists(&cases), Vec::<String>::new());
}

#[test]
fn a_required_case_that_is_missing_is_named() {
    let without_suggestions: Vec<Case> = load_cases().into_iter().filter(|c| !c.name.starts_with("suggestions: ")).collect();
    let lacking = missing_required_cases(&without_suggestions).join("\n");
    for kind in ["an exact hit", "a prefix hit", "more than three exact or prefix matches", "no suggestion: an input no candidate covers", "a listed name that contains \", \""] {
        assert!(lacking.contains(kind), "{kind} is not reported: {lacking}");
    }
    // the typo, the ISO date and the page resource's error are recorded in other groups
    for recorded_elsewhere in ["a typo", "an ISO date", "page resource"] {
        assert!(!lacking.contains(recorded_elsewhere), "{recorded_elsewhere} is reported: {lacking}");
    }
    assert_eq!(missing_required_cases(&[]).len(), REQUIRED_CASES.len());
}

#[test]
fn a_case_is_sorted_by_what_it_exercises() {
    let cases = load_cases();
    let kinds = |name: &str| required_kinds_of(cases.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no case {name:?}")));
    assert_eq!(kinds("suggestions: an exact hit comes before the prefix hits"), ["an exact hit (E and P both non-empty)"]);
    assert_eq!(kinds("suggestions: a prefix hit"), ["a prefix hit (E empty, P non-empty)"]);
    assert_eq!(kinds("suggestions: more than three prefix hits"), ["a prefix hit (E empty, P non-empty)", "more than three exact or prefix matches"]);
    assert_eq!(kinds("suggestions: no page covers the input"), ["no suggestion: an input no candidate covers"]);
    assert_eq!(
        kinds("suggestions: a name that contains a comma and a space"),
        ["a typo with no prefix match and at least one covering name", "a listed name that contains \", \""]
    );
    assert_eq!(kinds("page resource: no such page, with the closest names"), ["a typo with no prefix match and at least one covering name", "the page resource's error"]);
    assert_eq!(kinds("missing page with suggestions"), ["a typo with no prefix match and at least one covering name"]);
    assert_eq!(kinds("missing journal date"), ["no suggestion: an ISO date"]);
}

#[test]
fn a_reference_that_breaks_a_rule_is_not_recorded() {
    let pages: Vec<Value> = PAGES.iter().map(|name| json!({"originalName": name})).collect();
    let case_with = |expected: Value| Case {
        group: "g".into(),
        name: "x".into(),
        tool: "logseq_get_page".into(),
        arguments: json!({}),
        steps: vec![vec![Canned { method: "logseq.Editor.getAllPages".into(), args: vec![], response: Value::Array(pages.clone()) }]],
        ceiling: 1,
        perturbed: None,
        request: Request::Tool,
        expected,
    };
    assert!(check_reference_lists(&[case_with(tool_error(&message("Projct", Some("Bob"))))]).join("\n").contains("rule 5"));
    assert_eq!(check_reference_lists(&[case_with(tool_error(&message("Projct", Some(TYPO))))]), Vec::<String>::new());
    assert_eq!(candidates_of(&case_with(Value::Null)), names(&PAGES));
}

#[test]
fn the_wrong_list_self_check_fails_when_a_kind_of_wrong_list_applies_to_no_case() {
    // With no recorded case, no kind applies, so the check would prove nothing and says so
    let (lines, ok) = check_wrong_lists(&[]);
    assert!(!ok);
    let report = lines.join("\n");
    assert!(report.contains("no recorded case it applies to"), "{report}");
    assert_eq!(lines.len(), parity_support::suggestion_rules::WRONG_LIST_LABELS.len(), "{report}");
    // And with the recorded cases every kind applies and is caught
    let (lines, ok) = check_wrong_lists(&load_cases());
    assert!(ok, "{}", lines.join("\n"));
    assert!(lines.iter().all(|line| line.contains("caught in")), "{lines:?}");
}
