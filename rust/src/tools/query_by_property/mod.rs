//! `logseq_query_by_property` (the Rust side of `src/tools/query-by-property.ts`): the blocks whose
//! property equals a value, flat, with their page's name.
//!
//! Calls: 1, whatever the number of matches (#33). The match runs inside LogSeq, against
//! `:block/properties`: a scalar matches when its text is the value, a set when it contains it.
//! Blocks are sorted here (page id, then block id) and cut to `limit`, since Datalog here has no
//! `:limit` (#61).
//!
//! This directory holds everything only the property search uses: its query (`queries.rs`), the
//! answer it reads (`wire.rs`) and its tip (`tips.rs`). What it shares with other tools is outside
//! it: slim output, entity fields, the camelCase spelling of a pulled block (`block_tree`), the
//! truncation warnings and the tool helpers.

mod queries;
mod tips;
mod wire;

use std::cmp::Ordering;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::{Arguments, Scalar};
use crate::block_tree::{camelize_block, camelize_keys};
use crate::client::LogseqClient;
use crate::errors::ToolError;
use crate::js;
use crate::meta::{ResultMeta, ResultWarning};
use crate::slim::{DEFAULT_SLIM_RESULTS, to_slim_block};
use crate::tool::{input_schema, read_only_annotations, success_result};
use crate::truncation::{CappedTruncation, blocks_inline_max, capped_truncation_warning};

use self::queries::PropertyKey;
use self::tips::property_tips;

pub const NAME: &str = "logseq_query_by_property";

/// Blocks returned when `limit` is absent.
pub const DEFAULT_PROPERTY_LIMIT: u64 = 100;

/// Most blocks one call returns (#61). A larger `limit` is clamped to it, and a cut at the maximum
/// is reported by a `results_truncated` warning with no `howToFetchAll`.
pub const MAX_PROPERTY_LIMIT: u64 = 500;

/// The query takes only a key and an exact value, so nothing narrows it further.
const NARROWER: &str = "No other parameter narrows this query.";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "Find blocks whose property equals a value (e.g. status::done). Capped by limit (max 500): check meta.\n\n\
**Matching:** key as stored (created-at) or camelCase; values are exact strings (\"42\", \"true\"); a multi-value property matches if any one value equals it. Flat list with page name, no children.\n\
**Can't find:** partial values, ranges, or over 500 matches. For text use logseq_search_blocks.";

fn default_limit() -> u64 {
    DEFAULT_PROPERTY_LIMIT
}

fn default_slim_results() -> bool {
    DEFAULT_SLIM_RESULTS
}

/// The search's arguments. Unknown fields are ignored, as every TypeScript tool ignores them.
#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
pub struct Args {
    /// Name of the property to query (letters, digits, "-" and "_"; createdAt and created-at are equivalent)
    pub property_key: String,
    /// Value to match for the property. For multi-value properties, matches if any one value equals it
    pub property_value: Scalar,
    /// Max blocks to return (default: 100, max: 500)
    #[serde(default = "default_limit")]
    pub limit: u64,
    /// Slim blocks (default). false returns full entities
    #[serde(default = "default_slim_results")]
    pub slim_results: bool,
}

/// Read the arguments in the order the schema lists them, so the first one that is wrong is the one
/// reported, as `parseArgs` does.
fn read_args(arguments: Option<&JsonObject>) -> Result<Args, ToolError> {
    let read = Arguments::new(arguments);
    Ok(Args {
        property_key: read.required_string("property_key")?,
        property_value: read.required_scalar("property_value")?,
        limit: read.count_or("limit", 0, DEFAULT_PROPERTY_LIMIT)?,
        slim_results: read.boolean("slim_results", DEFAULT_SLIM_RESULTS)?,
    })
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Query by Property")
        .with_annotations(read_only_annotations("Query by Property"))
}

/// A call: arguments read, the query, then its meta and tips.
pub async fn call(client: &LogseqClient, tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = read_args(arguments.as_ref())?;
    let found = query_by_property_with_meta(client, &args.property_key, &args.property_value, args.slim_results, args.limit).await?;
    // `null` from LogSeq is `null` here, and has no meta or tips (BR-0011)
    let Some(found) = found else { return Ok(success_result(vec![ContentBlock::text("null")])) };

    let mut content = vec![ContentBlock::text(js::json_stringify(&Value::Array(found.results.clone())))];
    let tips = if tips_enabled { property_tips(&found.results) } else { Vec::new() };
    // `metaContent(meta, tips)`: the meta when the list was cut, the tips beside it or alone
    let meta = match (&found.meta, tips.is_empty()) {
        (None, true) => None,
        (None, false) => Some(json!({ "tips": tips })),
        (Some(meta), _) => {
            let mut meta = serde_json::to_value(meta).expect("a result meta serializes");
            if !tips.is_empty() {
                meta.as_object_mut().expect("a result meta is an object").insert("tips".into(), json!(tips));
            }
            Some(meta)
        }
    };
    if let Some(meta) = meta {
        content.push(ContentBlock::text(js::json_stringify(&json!({ "meta": meta }))));
    }
    Ok(success_result(content))
}

/// The matches of a property search and what to say about them.
#[derive(Debug, Clone, PartialEq)]
pub struct PropertyResults {
    /// Slim blocks, or full ones (camelCase keys) with `slim_results: false`
    pub results: Vec<Value>,
    /// Only when `limit` cut the list, so output below the cap carries none
    pub meta: Option<ResultMeta>,
}

/// A block's id as the sort reads it.
fn block_id(block: &Map<String, Value>) -> i64 {
    block.get("id").and_then(crate::wire::whole_number).unwrap_or(0)
}

// PARITY(#299): the sort reads only `page.id`, so a page spelled `db/id`, which LogSeq never sends for a
// nested pull, sorts as page 0 (suspected TS bug: read it as `entityId` does) - drop if Rust becomes the only
// server.
/// `a.page?.id ?? 0`: the id of the page a block sits on, 0 when it carries none.
fn page_id(block: &Map<String, Value>) -> i64 {
    block.get("page").and_then(|page| page.get("id")).and_then(crate::wire::whole_number).unwrap_or(0)
}

/// `(a.page?.id ?? 0) - (b.page?.id ?? 0) || a.id - b.id`: page id, then block id.
fn by_page_then_block(a: &Map<String, Value>, b: &Map<String, Value>) -> Ordering {
    page_id(a).cmp(&page_id(b)).then_with(|| block_id(a).cmp(&block_id(b)))
}

/// Query blocks whose property `property_key` equals `property_value`: the first `limit` of them
/// (default 100, at most [`MAX_PROPERTY_LIMIT`]) after sorting by page id, then block id, which is
/// stable and no ranking. The meta carries a `results_truncated` warning and `totals.matches`, the
/// number of matching blocks before the cut, known from the one query. `None` when LogSeq answers
/// `null` (no matches is an empty `results`).
///
/// The warning never suggests a `limit` above the maximum, and a cut at the maximum carries no
/// `howToFetchAll`, so `hasMore` is false there (BR-0006).
///
/// API calls: 1.
pub async fn query_by_property_with_meta(
    client: &LogseqClient,
    property_key: &str,
    property_value: &Scalar,
    slim_results: bool,
    limit: u64,
) -> Result<Option<PropertyResults>, ToolError> {
    // A key LogSeq can't have is refused before any call
    let key = PropertyKey::parse(property_key)?;
    let query = queries::blocks_by_property(&key, &property_value.to_js_string());
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    let Some(pulled) = wire::blocks(&answer)? else { return Ok(None) };

    let mut matches: Vec<Map<String, Value>> = pulled
        .iter()
        .map(|block| {
            let mut block = camelize_block(block);
            if let Some(Value::Object(page)) = block.get("page") {
                let page = camelize_keys(page);
                block.insert("page".to_owned(), Value::Object(page));
            }
            block
        })
        .collect();
    // Ids are unique, and a sort that keeps ties in order
    matches.sort_by(by_page_then_block);

    let total = matches.len();
    matches.truncate(limit.min(MAX_PROPERTY_LIMIT) as usize);
    let warnings: Vec<ResultWarning> = (total > matches.len())
        .then(|| {
            capped_truncation_warning(CappedTruncation {
                // Page id then block id is a stable order but no ranking, and no parameter resumes from it
                what: "matching blocks (the first ones listed, not ranked)",
                shown: matches.len(),
                total,
                param: "limit",
                max: MAX_PROPERTY_LIMIT as usize,
                narrower: NARROWER,
                requested: Some(limit),
                code: "results_truncated",
                inline_max: Some(blocks_inline_max(false, slim_results)),
                paging: None,
            })
        })
        .into_iter()
        .collect();
    let meta = (!warnings.is_empty()).then(|| ResultMeta::new(warnings, &[("matches", total)]));

    let results = matches
        .into_iter()
        .map(|block| {
            if slim_results {
                Value::Object(to_slim_block(&block, &crate::entity::page_display_name(block.get("page"))))
            } else {
                Value::Object(block)
            }
        })
        .collect();
    Ok(Some(PropertyResults { results, meta }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};

    fn block(id: i64, page_id: Option<i64>) -> Map<String, Value> {
        let mut block = json!({"id": id, "uuid": format!("u{id}")}).as_object().unwrap().clone();
        if let Some(page_id) = page_id {
            block.insert("page".into(), json!({"id": page_id}));
        }
        block
    }

    #[test]
    fn blocks_sort_by_page_id_then_block_id_and_a_block_with_no_page_sorts_as_page_zero() {
        let mut blocks = vec![block(9, Some(20)), block(5, Some(20)), block(7, Some(10)), block(8, None), block(6, None)];
        blocks.sort_by(by_page_then_block);
        let ids: Vec<i64> = blocks.iter().map(block_id).collect();
        assert_eq!(ids, [6, 8, 7, 5, 9]);
    }

    #[test]
    fn the_schema_means_what_the_typescript_one_means() {
        // `inputSchema` of logseq_query_by_property in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "property_key": {"type": "string", "description": "Name of the property to query (letters, digits, \"-\" and \"_\"; createdAt and created-at are equivalent)"},
                "property_value": {
                    "anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}],
                    "description": "Value to match for the property. For multi-value properties, matches if any one value equals it"
                },
                "limit": {"type": "integer", "minimum": 0, "default": 100, "description": "Max blocks to return (default: 100, max: 500)"},
                "slim_results": {"type": "boolean", "default": true, "description": "Slim blocks (default). false returns full entities"},
            },
            "required": ["property_key", "property_value"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Query by Property"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Query by Property", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_read_as_the_schema_defaults_say() {
        let required = json!({"property_key": "status", "property_value": 3});
        let defaults = read_args(required.as_object()).unwrap();
        assert_eq!(
            defaults,
            Args { property_key: "status".into(), property_value: Scalar::Number(3.0), limit: 100, slim_results: true }
        );
        assert_eq!(serde_json::from_value::<Args>(required).unwrap(), defaults);
        // the first argument in schema order that is wrong is the one reported
        let bad = json!({"slim_results": 0, "limit": "a", "property_value": []});
        assert_eq!(
            read_args(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'property_key': missing\n\nExpected: a string (required)\nExample: property_key: \"...\""
        );
        let bad = json!({"property_key": "a", "slim_results": 0, "limit": "a", "property_value": []});
        assert_eq!(
            read_args(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'property_value': []\n\nExpected: a string, a number or a boolean, not an array\nExample: property_value: \"...\""
        );
        let bad = json!({"property_key": "a", "slim_results": 0, "limit": "a", "property_value": false});
        assert_eq!(
            read_args(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'limit': \"a\"\n\nExpected: a number, not a string\nExample: limit: 5"
        );
    }
}
