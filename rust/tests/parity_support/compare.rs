//! The comparator: every rule that decides whether the server's answer is the recorded one lives here, and
//! nowhere else in the parity test (#371, #379).
//!
//! - [`compare_results`] is the entry for a tool, prompt or resource result: structure equal, the closest
//!   names of a page-not-found message by the rules of ADR-0034 Decision 4 (`suggestion_rules.rs`), every text as below,
//!   every other value equal, and every JSON tool result minified.
//! - [`same_text`] and [`same_tool_text`] are the places that decide whether two result texts match. A tool
//!   result's JSON text (`content`) is compared by deep equality (the maintainer's decision on #371): object
//!   key order is ignored, array order is kept, numbers compare by value. Every other text is compared byte for
//!   byte: a markdown result (`format: "markdown"`), a TOON result (`format: "toon"`, BR-0014), a prompt's messages, a resource read, and the frame of a
//!   page-not-found message outside the closest names. Nothing else compares text.
//! - [`minified_failures`] holds every JSON tool result to ADR-0009 separately, so deep equality can't let
//!   layout whitespace through: the text is parsed, written again by `serde_json` (`Value`'s `Display`, which writes no
//!   layout, the server's own writer), and has to be as long.
//! - [`compare_calls`] holds the LogSeq calls to a case's recorded calls and its ceiling (ADR-0034 Decision 5): each
//!   call made matches a recorded call, in any order, and there are at most as many as the ceiling. [`stale_ceiling`]
//!   is the other side: a run of the cases as committed that makes fewer than the ceiling fails until it is lowered.
//! - [`compare_tool_lists`] holds `tools/list` to the recorded list by meaning (ADR-0034 Decision 3, #292).

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use super::cases::{Canned, Case};
use super::stub::{Call, canonical};
use super::suggestion_rules::{Site, WRONG_LIST_LABELS, candidates_of, check_suggestion_rules, describe_site, not_found_sites, read_message, with_message, wrong_lists};

/// Whether two values are the same JSON value: objects by key (order doesn't matter), numbers by value
/// (`50`, `50.0` and `5e1` are one number), everything else exactly.
pub fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_i64(), y.as_i64(), x.as_u64(), y.as_u64()) {
            (Some(i), Some(j), _, _) => i == j,
            (_, _, Some(i), Some(j)) => i == j,
            _ => x.as_f64() == y.as_f64(),
        },
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(key, v)| y.get(key).is_some_and(|w| values_equal(v, w))),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(v, w)| values_equal(v, w)),
        _ => a == b,
    }
}

/// A value for a failure message: JSON with object keys sorted.
fn stable(value: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let keys: BTreeSet<&String> = map.keys().collect();
                Value::Object(keys.into_iter().map(|k| (k.clone(), sorted(&map[k]))).collect::<Map<_, _>>())
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    sorted(value).to_string()
}

/// Whether two result texts are the same: byte for byte (see the module's note).
pub fn same_text(expected: &str, actual: &str) -> bool {
    expected == actual
}

/// A text that is a JSON object or array, parsed. A tool's JSON result is always one of those, and a
/// markdown or TOON result is not JSON at all.
fn json_container(text: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(text).ok()?;
    (value.is_object() || value.is_array()).then_some(value)
}

/// Whether two texts of a tool result's `content` are the same: by deep equality when both are JSON (key
/// order ignored, array order kept, numbers by value), byte for byte otherwise (markdown, TOON).
pub fn same_tool_text(expected: &str, actual: &str) -> bool {
    match (json_container(expected), json_container(actual)) {
        (Some(want), Some(got)) => values_equal(&want, &got),
        _ => same_text(expected, actual),
    }
}

/// Whether a number is a whole number written as a float (`1.0`, `3e0`): the compact spelling is the integer
/// (`1`, `3`). A float too large for an integer (`1e21`) has no such spelling and is not one.
fn is_whole_float(n: &serde_json::Number) -> bool {
    n.is_f64() && n.as_f64().is_some_and(|f| f.fract() == 0.0 && f.abs() < 9.0e18)
}

fn has_whole_float(value: &Value) -> bool {
    match value {
        Value::Number(n) => is_whole_float(n),
        Value::Array(items) => items.iter().any(has_whole_float),
        Value::Object(map) => map.values().any(has_whole_float),
        _ => false,
    }
}

/// The JSON texts of a tool result's `content` that are not minified (ADR-0009): a text that parses as JSON and
/// is not byte for byte what `serde_json` writes for the same value has layout whitespace in it, or a spelling
/// of a string or number that is not the compact one (`\u0041`, `\/`, `1e0`, `1e+21`). The server writes every
/// result with `serde_json` (`Value`'s `Display`, no layout), so that writer is the measure. A whole number
/// written as a float (`1.0`) is not minified either: its compact spelling is `1`. Numbers still compare by
/// value (ADR-0034), so `3` and `3.0` are one number to `values_equal`; this check is the one place that holds
/// the spelling.
pub fn minified_failures(result: &Value) -> Vec<String> {
    let blocks = result.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    blocks
        .iter()
        .enumerate()
        .filter_map(|(i, block)| {
            let text = block.get("text")?.as_str()?;
            let value = json_container(text)?;
            let compact = value.to_string();
            if text != compact {
                let (have, want) = (text.encode_utf16().count(), compact.encode_utf16().count());
                return Some(format!("content[{i}].text is JSON that is not minified (ADR-0009): {have} characters, {want} written without layout and in the compact spelling"));
            }
            has_whole_float(&value).then(|| format!("content[{i}].text is JSON that is not minified (ADR-0009): a whole number is written as a float"))
        })
        .collect()
}

fn first_char_difference(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

/// Forty characters either side of the first difference, quoted.
fn around(text: &str, at: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let from = at.saturating_sub(40);
    let to = (at + 40).min(chars.len());
    json!(chars[from.min(chars.len())..to].iter().collect::<String>()).to_string()
}

fn text_difference(label: &str, expected: &str, actual: &str) -> String {
    let at = first_char_difference(expected, actual);
    format!("{label} differs at character {at}:\n  expected: {}\n  actual:   {}", around(expected, at), around(actual, at))
}

/// Keys one object has and the other lacks, as failure lines.
fn key_differences(place: &str, expected: &Value, actual: &Value) -> Vec<String> {
    let keys = |value: &Value| -> BTreeSet<String> { value.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default() };
    let (want, got) = (keys(expected), keys(actual));
    let missing: Vec<&String> = want.difference(&got).collect();
    let unexpected: Vec<&String> = got.difference(&want).collect();
    let join = |names: Vec<&String>| names.into_iter().map(String::as_str).collect::<Vec<_>>().join(", ");
    let mut failures = Vec::new();
    if !missing.is_empty() {
        failures.push(format!("{place} lacks key(s) {}", join(missing)));
    }
    if !unexpected.is_empty() {
        failures.push(format!("{place} has unexpected key(s) {}", join(unexpected)));
    }
    failures
}

/// A prompt's messages: the text of each by `same_text`, and anything else equal.
fn compare_messages(expected: &[Value], actual: &[Value]) -> Vec<String> {
    if expected.len() != actual.len() {
        return vec![format!("expected {} message(s), got {}", expected.len(), actual.len())];
    }
    let text_of = |message: &Value| message.get("content").and_then(|c| c.get("text")).and_then(Value::as_str).map(str::to_owned);
    let mut failures = Vec::new();
    for (i, (want, got)) in expected.iter().zip(actual).enumerate() {
        match (text_of(want), text_of(got)) {
            (Some(w), Some(g)) if same_text(&w, &g) => {
                // The text matches; the rest of the message has to as well
                let strip = |message: &Value| {
                    let mut copy = message.clone();
                    if let Some(content) = copy.get_mut("content").and_then(Value::as_object_mut) {
                        content.remove("text");
                    }
                    copy
                };
                if !values_equal(&strip(want), &strip(got)) {
                    failures.push(format!("messages[{i}]: expected {}, got {}", stable(want), stable(got)));
                }
            }
            (Some(w), Some(g)) => failures.push(text_difference(&format!("messages[{i}] text"), &w, &g)),
            _ => {
                if !values_equal(want, got) {
                    failures.push(format!("messages[{i}]: expected {}, got {}", stable(want), stable(got)));
                }
            }
        }
    }
    failures
}

/// Compare a result with the expected one: the same top-level keys, the same content blocks with the same
/// fields, each `text` the same by [`same_tool_text`] (`content`) or [`same_text`] (`contents`), and every
/// other value equal.
fn compare_result(expected: &Value, actual: &Value) -> Vec<String> {
    let mut failures = key_differences("the result", expected, actual);
    let (Some(want), Some(got)) = (expected.as_object(), actual.as_object()) else {
        if !values_equal(expected, actual) {
            failures.push(format!("expected {}, got {}", stable(expected), stable(actual)));
        }
        return failures;
    };
    for (key, wanted) in want {
        if key == "content" || key == "contents" {
            continue;
        }
        let Some(actual_value) = got.get(key) else { continue };
        if let (true, Some(w), Some(g)) = (key == "messages", wanted.as_array(), actual_value.as_array()) {
            failures.extend(compare_messages(w, g));
            continue;
        }
        if !values_equal(wanted, actual_value) {
            failures.push(format!("{key}: expected {}, got {}", stable(wanted), stable(actual_value)));
        }
    }
    // A tool result's `content` and a resource's `contents`: the same blocks with the same fields
    for list in ["content", "contents"] {
        let (Some(wanted), Some(actual_list)) = (want.get(list), got.get(list)) else { continue };
        let blocks = |value: &Value| value.as_array().cloned().unwrap_or_default();
        let (want_blocks, got_blocks) = (blocks(wanted), blocks(actual_list));
        if want_blocks.len() != got_blocks.len() {
            failures.push(format!("expected {} {list} block(s), got {}", want_blocks.len(), got_blocks.len()));
        }
        for (i, (w, g)) in want_blocks.iter().zip(&got_blocks).enumerate() {
            failures.extend(key_differences(&format!("{list}[{i}]"), w, g));
            let Some(w_object) = w.as_object() else { continue };
            for (key, w_value) in w_object {
                let Some(g_value) = g.get(key) else { continue };
                match (key.as_str(), w_value.as_str(), g_value.as_str()) {
                    ("text", Some(w_text), Some(g_text)) => {
                        // A tool result's text is JSON, markdown or TOON; a resource's is whatever it renders, byte for byte
                        let same = if list == "content" { same_tool_text(w_text, g_text) } else { same_text(w_text, g_text) };
                        if !same {
                            failures.push(text_difference(&format!("{list}[{i}].text"), w_text, g_text));
                        }
                    }
                    _ => {
                        if !values_equal(w_value, g_value) {
                            failures.push(format!("{list}[{i}].{key}: expected {}, got {}", stable(w_value), stable(g_value)));
                        }
                    }
                }
            }
        }
    }
    failures
}

/// Compare a result with the recorded one. The recorded result holds a page-not-found message that lists
/// closest names (ADR-0034 Decision 4, #335): that list is held to the rules, and the rest of the result, the message's
/// frame included, to [`compare_result`]. A result with no such message is compared as [`compare_result`] does.
/// `candidates` are the names the stub's `getAllPages` answer holds.
///
/// This is the one function the parity test calls to judge a result.
pub fn compare_results(expected: &Value, actual: &Value, candidates: &[String]) -> Vec<String> {
    let mut failures = Vec::new();
    let mut masked = actual.clone();
    for site in not_found_sites(expected) {
        // A result that holds no message there is a difference compare_result reports
        let Some(got) = read_message(actual, site) else { continue };
        // A block that is not the minified serialization of its own message (pretty-printed, escaped another
        // way) is a byte difference (ADR-0009, rule 1): leave it unmasked so compare_result reports it
        if let Site::Tool(index) = site {
            let text = actual.get("content").and_then(|c| c.get(index)).and_then(|b| b.get("text")).and_then(Value::as_str);
            if text != Some(json!({"error": got}).to_string().as_str()) {
                continue;
            }
        }
        let want = read_message(expected, site).expect("the site was found in the expected result");
        for failure in check_suggestion_rules(&want, &got, candidates) {
            failures.push(format!("{} breaks {failure}", describe_site(site)));
        }
        masked = with_message(&masked, site, &want);
    }
    failures.extend(compare_result(expected, &masked));
    failures.extend(minified_failures(actual));
    failures
}

/// Whether a LogSeq API method only reads (BR-0002): a Datalog query, the simple-query DSL, or a `get...` method of
/// the Editor or App API. It is an allowlist, so a method nobody has classified is not a read.
pub fn is_read_method(method: &str) -> bool {
    if method == "logseq.DB.datascriptQuery" || method == "logseq.DB.q" {
        return true;
    }
    ["logseq.Editor.get", "logseq.App.get"].iter().any(|prefix| method.strip_prefix(prefix).and_then(|rest| rest.chars().next()).is_some_and(|c| c.is_ascii_uppercase()))
}

/// Compare the calls a server made with a case's recorded calls and its ceiling (ADR-0034 Decision 5, ADR-0011):
/// - every call made matches a recorded call in method, query text (layout aside) and inputs, and a recorded call
///   answers one made call (a query asked twice is matched to its recorded calls in the recorded order). A call
///   that matches none fails, whatever the server did with the error;
/// - at most `ceiling` calls are made. Fewer pass, and so does a recorded call that was never made;
/// - every call, recorded or made, is a read (BR-0002);
/// - the order of the calls, and their grouping into steps, are not compared.
pub fn compare_calls(steps: &[Vec<Canned>], ceiling: usize, actual: &[Call]) -> Vec<String> {
    let mut failures = Vec::new();
    for call in steps.iter().flatten().filter(|c| !is_read_method(&c.method)) {
        failures.push(format!("the recorded call {} is not a read (BR-0002)", canonical(&call.method, &call.args)));
    }
    // The recorded calls not yet used by a call made, in the recorded order
    let mut unused: Vec<String> = steps.iter().flatten().map(|c| canonical(&c.method, &c.args)).collect();
    for call in actual {
        let made = canonical(&call.method, &call.args);
        if !is_read_method(&call.method) {
            failures.push(format!("the server made a call that is not a read (BR-0002): {made}"));
        } else if let Some(at) = unused.iter().position(|recorded| *recorded == made) {
            unused.remove(at);
        } else {
            failures.push(format!("the server made a call no recorded call answers: {made}"));
        }
    }
    if actual.len() > ceiling {
        failures.push(format!("the server made {} call(s), over the case's ceiling of {ceiling} (ADR-0011)", actual.len()));
    }
    failures
}

/// The failure for a case whose server made fewer calls than its ceiling allows, `None` when it made as many. The
/// ceiling is a ratchet (ADR-0034 Decision 5): a change that saves a call lowers it in the same pull request, which
/// needs no OK, so a saved call can't be spent again later without asking. Only a run of the cases as committed asks
/// this (a perturbed answer can change the count), and `compare_calls` alone doesn't, since it judges one set of calls.
pub fn stale_ceiling(ceiling: usize, made: usize) -> Option<String> {
    (made < ceiling).then(|| {
        format!("the server made {made} call(s), under the case's ceiling of {ceiling}: lower it with PARITY_RECORD=1 cargo test --test parity_record -- --nocapture (lowering needs no OK)")
    })
}

// ---- tools/list, by meaning (ADR-0034 Decision 3, #292)
//
// Both sides go through `normalize_schema`, which removes only what no client can see in validation:
//   1. `$ref` is replaced by the schema it points at, and `$defs` / `definitions` are dropped. A `$ref` with
//      sibling keywords, and an `allOf` of one schema, are merged into one schema. If a key clashes, both stay
//      as an `allOf`, and differ.
//   2. A top-level argument that is not in `required` and also accepts null loses the null (the server drops a
//      top-level null before parsing, so there null and absent are the same argument).
//   3. `$schema`, `format` and `title` keywords are dropped (a property *named* format or title is kept, and so
//      are the tool's title and annotations, which are compared exactly).
//   4. Numbers are compared by value.
//   5. `required` is sorted, and object keys never matter.
// Everything else is compared exactly.

const SCHEMA_KEYWORDS: [&str; 10] =
    ["additionalProperties", "additionalItems", "unevaluatedProperties", "unevaluatedItems", "contains", "propertyNames", "not", "if", "then", "else"];
const SCHEMA_LIST_KEYWORDS: [&str; 4] = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_MAP_KEYWORDS: [&str; 3] = ["properties", "patternProperties", "dependentSchemas"];
const DROPPED_KEYWORDS: [&str; 5] = ["$schema", "$defs", "definitions", "format", "title"];

/// Both schemas as one; an `allOf` of the two if any key holds different values.
fn merge(a: &Map<String, Value>, b: &Map<String, Value>) -> Map<String, Value> {
    let mut out = a.clone();
    for (key, value) in b {
        if out.get(key).is_some_and(|existing| !values_equal(existing, value)) {
            let mut clash = Map::new();
            clash.insert("allOf".to_owned(), json!([Value::Object(a.clone()), Value::Object(b.clone())]));
            return clash;
        }
        out.insert(key.clone(), value.clone());
    }
    out
}

/// The schema a local JSON pointer (`#/$defs/Name`) names.
fn resolve_pointer<'a>(root: &'a Value, reference: &str) -> Result<&'a Value, String> {
    if reference != "#" && !reference.starts_with("#/") {
        return Err(format!("can't resolve $ref {}: only local JSON pointers are supported", json!(reference)));
    }
    let mut node = root;
    for raw in reference[1..].split('/').skip(1) {
        let part = raw.replace("~1", "/").replace("~0", "~");
        node = node.get(&part).ok_or_else(|| format!("$ref {} points at nothing", json!(reference)))?;
    }
    Ok(node)
}

fn is_null_schema(schema: &Value) -> bool {
    let Some(object) = schema.as_object() else { return false };
    object.len() == 1
        && (object.get("type") == Some(&json!("null"))
            || object.get("const") == Some(&Value::Null)
            || object.get("enum").and_then(Value::as_array).is_some_and(|e| e.len() == 1 && e[0].is_null()))
}

/// An optional property's schema without the null it also accepts (rule 2).
fn without_null(schema: &Value) -> Value {
    let Some(object) = schema.as_object() else { return schema.clone() };
    let mut s = object.clone();
    if let Some(types) = s.get("type").and_then(Value::as_array).cloned() {
        if types.contains(&json!("null")) {
            let rest: Vec<Value> = types.into_iter().filter(|t| t != &json!("null")).collect();
            s.insert("type".to_owned(), if rest.len() == 1 { rest[0].clone() } else { Value::Array(rest) });
        }
    }
    if let Some(values) = s.get("enum").and_then(Value::as_array).cloned() {
        if values.contains(&Value::Null) {
            s.insert("enum".to_owned(), Value::Array(values.into_iter().filter(|v| !v.is_null()).collect()));
        }
    }
    for key in ["anyOf", "oneOf"] {
        let Some(branches) = s.get(key).and_then(Value::as_array).cloned() else { continue };
        if !branches.iter().any(is_null_schema) {
            continue;
        }
        let rest: Vec<Value> = branches.into_iter().filter(|b| !is_null_schema(b)).collect();
        if let (1, Some(only)) = (rest.len(), rest.first().and_then(Value::as_object)) {
            s.remove(key);
            s = merge(&s, only);
        } else {
            s.insert(key.to_owned(), Value::Array(rest));
        }
    }
    Value::Object(s)
}

fn normalize_node(node: &Value, root: &Value, refs: &[String]) -> Result<Value, String> {
    let Some(object) = node.as_object() else { return Ok(node.clone()) };

    if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
        if refs.iter().any(|r| r == reference) {
            return Err(format!("$ref {} is recursive; the harness can't compare it", json!(reference)));
        }
        let mut deeper = refs.to_vec();
        deeper.push(reference.to_owned());
        let target = normalize_node(resolve_pointer(root, reference)?, root, &deeper)?;
        let siblings: Map<String, Value> = object.iter().filter(|(k, _)| *k != "$ref").map(|(k, v)| (k.clone(), v.clone())).collect();
        let rest = normalize_node(&Value::Object(siblings), root, refs)?;
        return Ok(match (&target, &rest) {
            (Value::Object(t), Value::Object(r)) => Value::Object(merge(t, r)),
            _ => target,
        });
    }

    let mut out = Map::new();
    for (key, value) in object {
        if DROPPED_KEYWORDS.contains(&key.as_str()) {
            continue;
        }
        let normalized = if SCHEMA_KEYWORDS.contains(&key.as_str()) {
            normalize_node(value, root, refs)?
        } else if let (true, Some(list)) = (SCHEMA_LIST_KEYWORDS.contains(&key.as_str()), value.as_array()) {
            Value::Array(list.iter().map(|v| normalize_node(v, root, refs)).collect::<Result<_, _>>()?)
        } else if key == "items" {
            match value.as_array() {
                Some(list) => Value::Array(list.iter().map(|v| normalize_node(v, root, refs)).collect::<Result<_, _>>()?),
                None => normalize_node(value, root, refs)?,
            }
        } else if let (true, Some(map)) = (SCHEMA_MAP_KEYWORDS.contains(&key.as_str()), value.as_object()) {
            Value::Object(map.iter().map(|(name, v)| Ok((name.clone(), normalize_node(v, root, refs)?))).collect::<Result<Map<_, _>, String>>()?)
        } else {
            value.clone()
        };
        out.insert(key.clone(), normalized);
    }

    if let Some(required) = out.get("required").and_then(Value::as_array).cloned() {
        let mut sorted = required;
        sorted.sort_by_key(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()));
        out.insert("required".to_owned(), Value::Array(sorted));
    }
    if let Some([Value::Object(only)]) = out.get("allOf").and_then(Value::as_array).map(Vec::as_slice) {
        let only = only.clone();
        out.remove("allOf");
        out = merge(&only, &out);
    }
    Ok(Value::Object(out))
}

/// A JSON Schema with the quirks above taken out, so equal meaning gives equal values.
pub fn normalize_schema(schema: &Value) -> Result<Value, String> {
    if !schema.is_object() {
        return Ok(schema.clone());
    }
    let out = normalize_node(schema, schema, &[])?;
    // Rule 2, for top-level arguments only
    let Some(properties) = out.get("properties").and_then(Value::as_object) else { return Ok(out) };
    let required: Vec<&str> = out.get("required").and_then(Value::as_array).map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let properties: Map<String, Value> = properties
        .iter()
        .map(|(name, v)| (name.clone(), if required.contains(&name.as_str()) { v.clone() } else { without_null(v) }))
        .collect();
    let mut result = out.as_object().expect("a normalized schema is an object").clone();
    result.insert("properties".to_owned(), Value::Object(properties));
    Ok(Value::Object(result))
}

/// Each place two values differ, as `path: expected ..., got ...` lines.
fn value_differences(path: &str, expected: Option<&Value>, actual: Option<&Value>) -> Vec<String> {
    let show = |v: Option<&Value>| v.map_or("nothing".to_owned(), Value::to_string);
    match (expected, actual) {
        (Some(Value::Object(e)), Some(Value::Object(a))) => {
            let keys: BTreeSet<&String> = e.keys().chain(a.keys()).collect();
            keys.into_iter().flat_map(|k| value_differences(&format!("{path}.{k}"), e.get(k), a.get(k))).collect()
        }
        (Some(Value::Array(e)), Some(Value::Array(a))) => {
            if e.len() != a.len() {
                return vec![format!("{path}: expected {}, got {}", Value::Array(e.clone()), Value::Array(a.clone()))];
            }
            e.iter().zip(a).enumerate().flat_map(|(i, (v, w))| value_differences(&format!("{path}[{i}]"), Some(v), Some(w))).collect()
        }
        (Some(e), Some(a)) if values_equal(e, a) => Vec::new(),
        (None, None) => Vec::new(),
        _ => vec![format!("{path}: expected {}, got {}", show(expected), show(actual))],
    }
}

fn with_normalized_schema(tool: &Value) -> Result<Value, String> {
    let mut copy = tool.clone();
    if let (Some(object), Some(schema)) = (copy.as_object_mut(), tool.get("inputSchema")) {
        object.insert("inputSchema".to_owned(), normalize_schema(schema)?);
    }
    Ok(copy)
}

/// Compare a server's tools with the reference by meaning: tools matched by name, every field exact except
/// the input schema, which is compared after [`normalize_schema`].
pub fn compare_tool_lists(expected: &[Value], actual: &[Value]) -> Vec<String> {
    let by_name = |tools: &[Value]| -> Vec<(String, Value)> {
        tools.iter().map(|t| (t.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(), t.clone())).collect()
    };
    let (want, got) = (by_name(expected), by_name(actual));
    let names: BTreeSet<&String> = want.iter().chain(&got).map(|(name, _)| name).collect();
    let mut failures = Vec::new();
    for name in names {
        let w = want.iter().find(|(n, _)| n == name).map(|(_, t)| t);
        let g = got.iter().find(|(n, _)| n == name).map(|(_, t)| t);
        match (w, g) {
            (_, None) => failures.push(format!("{name}: missing")),
            (None, Some(_)) => failures.push(format!("{name}: not in the reference")),
            (Some(w), Some(g)) => match (with_normalized_schema(w), with_normalized_schema(g)) {
                (Ok(w), Ok(g)) => failures.extend(value_differences(name, Some(&w), Some(&g))),
                (Err(e), _) | (_, Err(e)) => failures.push(format!("{name}: {e}")),
            },
        }
    }
    failures
}

/// The self-check of the closest-name rules: for each recorded case with a list, put each kind of wrong list in the
/// reference's place and check that the rules fail it. It runs no server. Every kind has to apply to some case, or the
/// check proves nothing about it, so a kind that applies to none is a failure of the check itself. Returns the lines
/// that say what happened, and whether every kind applied and was caught.
pub fn check_wrong_lists(cases: &[Case]) -> (Vec<String>, bool) {
    let mut applied = vec![0usize; WRONG_LIST_LABELS.len()];
    let mut caught = vec![0usize; WRONG_LIST_LABELS.len()];
    let mut lines = Vec::new();
    for case in cases {
        let candidates = candidates_of(case);
        for site in not_found_sites(&case.expected) {
            let reference = read_message(&case.expected, site).expect("the site was found in the expected result");
            for wrong in wrong_lists(&reference, &candidates) {
                let at = WRONG_LIST_LABELS.iter().position(|label| *label == wrong.label).expect("a known kind of wrong list");
                applied[at] += 1;
                if compare_results(&case.expected, &with_message(&case.expected, site, &wrong.message), &candidates).is_empty() {
                    lines.push(format!("NOT CAUGHT: {} in {:?}", wrong.label, case.name));
                } else {
                    caught[at] += 1;
                }
            }
        }
    }
    let mut ok = lines.is_empty();
    for (at, label) in WRONG_LIST_LABELS.iter().enumerate() {
        if applied[at] == 0 {
            lines.push(format!("self-check, closest names, {label}: no recorded case it applies to"));
            ok = false;
        } else {
            lines.push(format!("self-check, closest names, {label}: caught in {} of {} case(s)", caught[at], applied[at]));
        }
    }
    (lines, ok)
}
