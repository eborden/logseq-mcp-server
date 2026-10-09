//! Slim output (BR-0012; the Rust side of `src/utils/slim-entities.ts`): the essential fields of a
//! block or a page, with the empty ones left out. A tool that offers `slim_results` builds each
//! entry here, so every tool slims the same way.
//!
//! Entries are `serde_json` maps in the key order the TypeScript server writes them (ADR-0009).
//! The entities they read are the `Value`s LogSeq sent, in either key spelling (see [`crate::entity`]).

use serde_json::{Map, Value};

use crate::entity::{journal_day_of, journal_flag, page_display_name};
use crate::js;
use crate::refs;

/// Whether tools with a `slim_results` parameter slim their output when the caller doesn't say
/// (#42). `slim_results: false` is the opt-out. The default lives at the argument boundary.
pub const DEFAULT_SLIM_RESULTS: bool = true;

/// `extractPageRefs`: the `[[PageName]]` references in block content, without the brackets
/// (the grammar of [`crate::refs`]).
pub fn extract_page_refs(content: &str) -> Vec<String> {
    refs::page_refs(content).into_iter().map(|found| found.name.to_owned()).collect()
}

/// `extractTags`: the `#tag`s in block content, without the `#` (the grammar of [`crate::refs`]).
pub fn extract_tags(content: &str) -> Vec<String> {
    refs::tags(content).into_iter().map(str::to_owned).collect()
}

/// `isEmptyValue`: a value that says nothing: null, an empty or blank string, an empty array or an
/// empty object. `false` and `0` say something, so they are not empty.
pub fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => js::trim(text).is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
        Value::Bool(_) | Value::Number(_) => false,
    }
}

/// `nonEmptyProperties`: the properties without the empty ones, or `None` when none are left.
/// `status:: false` and `count:: 0` stay.
pub fn non_empty_properties(properties: Option<&Value>) -> Option<Value> {
    let kept: Map<String, Value> =
        properties?.as_object()?.iter().filter(|(_, value)| !is_empty_value(value)).map(|(k, v)| (k.clone(), v.clone())).collect();
    (!kept.is_empty()).then_some(Value::Object(kept))
}

/// `toSlimBlock`: `uuid` and `content` always stay, even for an empty block. `pageName` is left out
/// when it is blank, `properties` when none has a value, and `marker`, `tags` and `pageRefs` when
/// there are none. Children never carry `pageName`: they sit on their parent's page.
///
/// `page_name` is what to show for the block's page: pass `""` to leave it out.
pub fn to_slim_block(block: &Map<String, Value>, page_name: &str) -> Map<String, Value> {
    let mut slim = Map::new();
    if let Some(uuid) = block.get("uuid") {
        slim.insert("uuid".into(), uuid.clone());
    }
    let content = block.get("content").and_then(Value::as_str).unwrap_or("");
    slim.insert("content".into(), Value::from(content));

    if !js::trim(page_name).is_empty() {
        slim.insert("pageName".into(), Value::from(page_name));
    }
    if let Some(properties) = non_empty_properties(block.get("properties")) {
        slim.insert("properties".into(), properties);
    }
    // Only when there is a marker
    if let Some(marker) = block.get("marker").and_then(Value::as_str).filter(|marker| !marker.is_empty()) {
        slim.insert("marker".into(), Value::from(marker));
    }
    let tags = extract_tags(content);
    if !tags.is_empty() {
        slim.insert("tags".into(), Value::from(tags));
    }
    let page_refs = extract_page_refs(content);
    if !page_refs.is_empty() {
        slim.insert("pageRefs".into(), Value::from(page_refs));
    }
    // Resolved refs (resolve_refs) ride along on slim blocks too, only when present
    if let Some(resolved) = block.get("resolvedContent") {
        slim.insert("resolvedContent".into(), resolved.clone());
    }
    if let Some(refs) = block.get("resolvedRefs").filter(|refs| refs.as_array().is_some_and(|items| !items.is_empty())) {
        slim.insert("resolvedRefs".into(), refs.clone());
    }
    // Only when max_blocks cut some of the children, so a cut block is not read as a leaf
    if block.get("childrenTruncated").is_some_and(is_truthy) {
        slim.insert("childrenTruncated".into(), Value::Bool(true));
    }
    if let Some(children) = block.get("children").and_then(Value::as_array).filter(|children| !children.is_empty()) {
        // Only block objects: a child that is not one (an unfetched `["uuid", id]` tuple) has no fields to slim
        let slimmed: Vec<Value> =
            children.iter().filter_map(Value::as_object).map(|child| Value::Object(to_slim_block(child, ""))).collect();
        slim.insert("children".into(), Value::Array(slimmed));
    }
    slim
}

/// JavaScript truthiness of a JSON value.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `toSlimPage`: `name` and `originalName`, the properties that have a value, and the journal
/// metadata only for a journal page.
pub fn to_slim_page(page: &Value) -> Map<String, Value> {
    let mut slim = Map::new();
    if let Some(name) = page.get("name") {
        slim.insert("name".into(), name.clone());
    }
    slim.insert("originalName".into(), Value::from(page_display_name(Some(page))));
    if let Some(properties) = non_empty_properties(page.get("properties")) {
        slim.insert("properties".into(), properties);
    }
    if journal_flag(Some(page)).unwrap_or(false) {
        slim.insert("isJournal".into(), Value::Bool(true));
        if let Some(day) = journal_day_of(Some(page)).filter(|day| *day != 0) {
            slim.insert("journalDate".into(), Value::from(day));
        }
    }
    slim
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn page_refs_are_read_by_the_one_grammar_of_the_refs_module() {
        assert_eq!(extract_page_refs("see [[Alice]] and [[Bob Smith]]"), ["Alice", "Bob Smith"]);
        assert_eq!(extract_page_refs("[[]] [[a]"), Vec::<String>::new());
        assert_eq!(extract_page_refs("[[[a]]"), ["a"]);
        assert_eq!(extract_page_refs("[[a\nb]]"), Vec::<String>::new());
        assert_eq!(extract_page_refs("[[a [[b]] c]]"), ["b"]);
        assert_eq!(extract_page_refs("[[a]][[b]]"), ["a", "b"]);
        assert_eq!(extract_page_refs("[[a]b]]"), Vec::<String>::new());
        assert_eq!(extract_page_refs("café [[naïve]]"), ["naïve"]);
    }

    #[test]
    fn tags_run_to_white_space_or_the_next_hash() {
        assert_eq!(extract_tags("a #one, #two#three # four #"), ["one,", "two", "three"]);
        assert_eq!(extract_tags("#a\u{a0}#b c"), ["a", "b"]);
        assert_eq!(extract_tags("no tags"), Vec::<String>::new());
        assert_eq!(extract_tags("#é #\u{1F680}x"), ["é", "\u{1F680}x"]);
        assert_eq!(extract_tags("#a\u{85}b"), ["a"]);
        // U+FEFF is not white space to Rust, so it stays in the tag
        assert_eq!(extract_tags("#a\u{feff}b"), ["a\u{feff}b"]);
    }

    #[test]
    fn empty_values_say_nothing_but_false_and_zero_do() {
        for empty in [json!(null), json!(""), json!("  "), json!([]), json!({})] {
            assert!(is_empty_value(&empty), "{empty}");
        }
        for full in [json!(false), json!(0), json!("x"), json!([null]), json!({"a": null})] {
            assert!(!is_empty_value(&full), "{full}");
        }
        assert_eq!(non_empty_properties(Some(&json!({"a": "", "b": false, "c": 0, "d": []}))), Some(json!({"b": false, "c": 0})));
        assert_eq!(non_empty_properties(Some(&json!({"a": ""}))), None);
        assert_eq!(non_empty_properties(None), None);
    }

    fn slim(block: Value, page_name: &str) -> String {
        js::json_stringify(&Value::Object(to_slim_block(block.as_object().unwrap(), page_name)))
    }

    #[test]
    fn a_slim_block_keeps_uuid_and_content_and_leaves_out_what_is_empty() {
        assert_eq!(slim(json!({"id": 1, "uuid": "u"}), ""), r#"{"uuid":"u","content":""}"#);
        assert_eq!(
            slim(
                json!({"id": 1, "uuid": "u", "content": "TODO ship [[Project Atlas]] #urgent", "marker": "TODO",
                       "properties": {"status": "open", "empty": ""}, "page": {"id": 2}}),
                "My Page"
            ),
            r#"{"uuid":"u","content":"TODO ship [[Project Atlas]] #urgent","pageName":"My Page","properties":{"status":"open"},"marker":"TODO","tags":["urgent"],"pageRefs":["Project Atlas"]}"#
        );
        assert_eq!(slim(json!({"uuid": "u", "content": "x", "marker": ""}), "  "), r#"{"uuid":"u","content":"x"}"#);
    }

    #[test]
    fn children_are_slimmed_without_a_page_name() {
        assert_eq!(
            slim(json!({"uuid": "u", "content": "a", "childrenTruncated": true, "children": [{"uuid": "c", "content": "b #t"}]}), "P"),
            r##"{"uuid":"u","content":"a","pageName":"P","childrenTruncated":true,"children":[{"uuid":"c","content":"b #t","tags":["t"]}]}"##
        );
    }

    #[test]
    fn a_slim_page_names_its_journal_only_for_a_journal() {
        let page = |value: Value| js::json_stringify(&Value::Object(to_slim_page(&value)));
        assert_eq!(page(json!({"name": "alice", "originalName": "Alice", "properties": {"type": "person"}})), r#"{"name":"alice","originalName":"Alice","properties":{"type":"person"}}"#);
        assert_eq!(
            page(json!({"name": "jan 1st, 2025", "original-name": "Jan 1st, 2025", "journal?": true, "journalDay": 20250101})),
            r#"{"name":"jan 1st, 2025","originalName":"Jan 1st, 2025","isJournal":true,"journalDate":20250101}"#
        );
        assert_eq!(page(json!({"name": "x", "journal?": true, "journal-day": 0})), r#"{"name":"x","originalName":"x","isJournal":true}"#);
        assert_eq!(page(json!({"id": 4})), r#"{"originalName":""}"#);
    }
}
