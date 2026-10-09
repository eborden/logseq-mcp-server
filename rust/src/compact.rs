//! `compact` JSON (#43; the Rust side of `src/utils/compact.ts`): the same result with ids, titles
//! and link targets, and no block bodies. A block shrinks to `{ uuid, snippet }`, where the snippet
//! is its first line cut to 80 characters; the model reads only the blocks it picks, with
//! `logseq_get_block`. The Markdown form of `compact` shows the same snippets.
//!
//! Supported by `build_context` and `get_context_for_query`, whose blocks are the bulk of the
//! output. Everything outside the blocks (`summary`, `totals`, `warnings`, `hasMore`,
//! `resolvedFrom`) is kept as it is.
//!
//! These functions take a tool's result as the JSON value it is written as, and return one, so a
//! key keeps its place (a replaced key stays where it was).

use serde_json::{Map, Value};

use crate::entity::{id_of, original_name_of};
use crate::snippet::Snippet;

/// `compactBlock`: `{ uuid, snippet }`. A block with no `uuid` has none here either.
pub fn compact_block(block: &Value) -> Value {
    let mut out = Map::new();
    if let Some(uuid) = block.get("uuid") {
        out.insert("uuid".into(), uuid.clone());
    }
    out.insert("snippet".into(), Value::String(Snippet::of(block.get("content").and_then(Value::as_str)).as_str().to_owned()));
    Value::Object(out)
}

/// `compactPage`: `{ id, name, originalName }`, each only when the page has it.
pub fn compact_page(page: &Value) -> Value {
    let mut out = Map::new();
    if let Some(id) = id_of(Some(page)) {
        out.insert("id".into(), Value::from(id));
    }
    if let Some(name) = page.get("name") {
        out.insert("name".into(), name.clone());
    }
    if let Some(original_name) = original_name_of(Some(page)) {
        out.insert("originalName".into(), Value::String(original_name.to_owned()));
    }
    Value::Object(out)
}

/// `{ ...map, key: value }`: the key is replaced where it is, or added at the end.
fn with(mut map: Map<String, Value>, key: &str, value: Value) -> Map<String, Value> {
    map.insert(key.to_owned(), value);
    map
}

fn map_of(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn each(value: Option<&Value>, f: impl Fn(&Value) -> Value) -> Value {
    Value::Array(value.and_then(Value::as_array).map(|items| items.iter().map(f).collect()).unwrap_or_default())
}

/// `compactTopicContext`: a topic's context with block bodies replaced by snippets and pages by
/// their names.
pub fn compact_topic_context(context: &Value) -> Value {
    let mut out = map_of(context);
    out = with(out, "mainPage", compact_page(context.get("mainPage").unwrap_or(&Value::Null)));
    out = with(out, "directBlocks", each(context.get("directBlocks"), compact_block));
    out = with(
        out,
        "relatedPages",
        each(context.get("relatedPages"), |related| {
            let page = compact_page(related.get("page").unwrap_or(&Value::Null));
            Value::Object(with(map_of(related), "page", page))
        }),
    );
    out = with(
        out,
        "references",
        each(context.get("references"), |reference| {
            let mut entry = Map::new();
            entry.insert("block".into(), compact_block(reference.get("block").unwrap_or(&Value::Null)));
            entry.insert("sourcePage".into(), compact_page(reference.get("sourcePage").unwrap_or(&Value::Null)));
            Value::Object(entry)
        }),
    );
    Value::Object(out)
}

/// `compactQueryContext`: a query's context with every topic compacted and the search hits reduced
/// to snippets.
pub fn compact_query_context(context: &Value) -> Value {
    let mut out = map_of(context);
    out = with(out, "contexts", each(context.get("contexts"), compact_topic_context));
    // `searchResults: undefined` is no key once written
    if let Some(results) = context.get("searchResults") {
        out = with(out, "searchResults", each(Some(results), compact_block));
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::json_stringify;
    use serde_json::json;

    #[test]
    fn a_block_is_its_uuid_and_the_first_line_of_its_content() {
        assert_eq!(compact_block(&json!({"id": 1, "uuid": "u1", "content": "\n  Hello  \nmore", "page": {"id": 2}})), json!({"uuid": "u1", "snippet": "Hello"}));
        // a block with no content has an empty snippet, one with no uuid has none
        assert_eq!(json_stringify(&compact_block(&json!({"uuid": "u2"}))), r#"{"uuid":"u2","snippet":""}"#);
        assert_eq!(json_stringify(&compact_block(&json!({"content": "x"}))), r#"{"snippet":"x"}"#);
    }

    #[test]
    fn a_page_is_its_id_name_and_original_name_in_either_spelling() {
        assert_eq!(json_stringify(&compact_page(&json!({"id": 1, "name": "atlas", "original-name": "Atlas", "uuid": "x"}))), r#"{"id":1,"name":"atlas","originalName":"Atlas"}"#);
        assert_eq!(json_stringify(&compact_page(&json!({"db/id": 7, "originalName": "Atlas"}))), r#"{"id":7,"originalName":"Atlas"}"#);
        assert_eq!(json_stringify(&compact_page(&json!({"id": 3}))), r#"{"id":3}"#);
        assert_eq!(compact_page(&json!({})), json!({}));
    }

    fn context() -> Value {
        json!({
            "topic": "atlas",
            "mainPage": {"id": 1, "name": "atlas", "original-name": "Atlas", "properties": {"a": "b"}},
            "directBlocks": [{"id": 5, "uuid": "u5", "content": "first\nsecond"}],
            "relatedPages": [{"page": {"id": 2, "name": "bob", "originalName": "Bob", "uuid": "p"}, "relationshipType": "inbound"}],
            "references": [{"block": {"id": 6, "uuid": "u6", "content": "see [[Atlas]]"}, "sourcePage": {"id": 2, "name": "bob", "originalName": "Bob"}}],
            "summary": {"totalBlocks": 1},
            "hasMore": false,
            "warnings": [],
            "totals": {"blocks": 1}
        })
    }

    #[test]
    fn a_topic_context_keeps_its_keys_and_loses_its_bodies() {
        assert_eq!(
            json_stringify(&compact_topic_context(&context())),
            concat!(
                r#"{"topic":"atlas","mainPage":{"id":1,"name":"atlas","originalName":"Atlas"},"#,
                r#""directBlocks":[{"uuid":"u5","snippet":"first"}],"#,
                r#""relatedPages":[{"page":{"id":2,"name":"bob","originalName":"Bob"},"relationshipType":"inbound"}],"#,
                r#""references":[{"block":{"uuid":"u6","snippet":"see [[Atlas]]"},"sourcePage":{"id":2,"name":"bob","originalName":"Bob"}}],"#,
                r#""summary":{"totalBlocks":1},"hasMore":false,"warnings":[],"totals":{"blocks":1}}"#
            )
        );
    }

    #[test]
    fn a_query_context_compacts_every_topic_and_the_search_hits() {
        let query = json!({"query": "q", "extractedTopics": ["atlas"], "contexts": [context()], "searchResults": [{"id": 9, "uuid": "u9", "content": "hit"}], "warnings": [], "hasMore": false});
        let compacted = compact_query_context(&query);
        assert_eq!(compacted["searchResults"], json!([{"uuid": "u9", "snippet": "hit"}]));
        assert_eq!(compacted["contexts"][0]["directBlocks"], json!([{"uuid": "u5", "snippet": "first"}]));
        assert_eq!(compacted.as_object().unwrap().keys().collect::<Vec<_>>(), ["query", "extractedTopics", "contexts", "searchResults", "warnings", "hasMore"]);
        // a query with no keyword search has no `searchResults` to compact
        let none = compact_query_context(&json!({"query": "q", "contexts": []}));
        assert!(none.get("searchResults").is_none());
    }
}
