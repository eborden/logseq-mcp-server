//! `logseq_query_by_property`: the blocks whose
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

use crate::args::{Scalar, parse_args};
use crate::block_tree::{camelize_block, camelize_keys};
use crate::client::LogseqClient;
use crate::errors::ToolError;
use crate::meta::{ResultMeta, ResultWarning};
use crate::resolve::RETRY_ADVICE;
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

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Find blocks whose property equals a value (e.g. status::done). Capped by limit (max 500): check meta.\n\n\
**Matching:** key as stored (created-at) or camelCase; values are exact strings (\"42\", \"true\"); a multi-value property matches if any one value equals it. Flat list with page name, no children.\n\
**Can't find:** partial values, ranges, or over 500 matches. For text use logseq_search_blocks.";

fn default_limit() -> u64 {
    DEFAULT_PROPERTY_LIMIT
}

fn default_slim_results() -> bool {
    DEFAULT_SLIM_RESULTS
}

/// The search's arguments. Unknown fields are ignored, as in every tool (see `input_schema`).
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

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Query by Property")
        .with_annotations(read_only_annotations("Query by Property"))
}

/// A call: arguments read, the query, then its meta and tips.
pub async fn call(client: &LogseqClient, tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = parse_args::<Args>(arguments.as_ref())?;
    let found = query_by_property_with_meta(client, &args.property_key, &args.property_value, args.slim_results, args.limit).await?;
    let mut content = vec![ContentBlock::text(Value::Array(found.results.clone()).to_string())];
    // `property_tips` has none for an empty list, which is what a `null` answer gives (BR-0011)
    let tips = if tips_enabled { property_tips(&found.results) } else { Vec::new() };
    // The meta when the list was cut, the tips beside it or alone
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
        content.push(ContentBlock::text(json!({ "meta": meta }).to_string()));
    }
    Ok(success_result(content))
}

/// The matches of a property search and what to say about them.
#[derive(Debug, Clone, PartialEq)]
pub struct PropertyResults {
    /// Slim blocks, or full ones (camelCase keys) with `slim_results: false`
    pub results: Vec<Value>,
    /// Only when `limit` cut the list or LogSeq answered `null` (`property_query_unavailable`, BR-0011, #415), so
    /// output below the cap carries none
    pub meta: Option<ResultMeta>,
}

/// The query was not answered: `results` is `[]`, but not because nothing matches. No parameter fetches what LogSeq did
/// not answer, so the warning carries no `howToFetchAll` and `hasMore` stays false (BR-0011). The retry advice is in the
/// message.
fn property_query_unavailable(property_key: &str) -> ResultWarning {
    ResultWarning::new(
        "property_query_unavailable",
        format!(
            "LogSeq returned no answer when looking up blocks with the property {} (possibly no graph open or a re-index in \
             progress), so the empty list may not mean nothing matches. {RETRY_ADVICE}",
            json!(property_key)
        ),
    )
}

/// A block's id as the sort reads it.
fn block_id(block: &Map<String, Value>) -> i64 {
    block.get("id").and_then(crate::wire::whole_number).unwrap_or(0)
}

/// The id of the page a block sits on (`id`, else `db/id`), 0 when it carries none.
fn page_id(block: &Map<String, Value>) -> i64 {
    crate::entity::id_of(block.get("page")).unwrap_or(0)
}

/// Page id (`page_id`, 0 for none), then block id.
fn by_page_then_block(a: &Map<String, Value>, b: &Map<String, Value>) -> Ordering {
    page_id(a).cmp(&page_id(b)).then_with(|| block_id(a).cmp(&block_id(b)))
}

/// Query blocks whose property `property_key` equals `property_value`: the first `limit` of them
/// (default 100, at most [`MAX_PROPERTY_LIMIT`]) after sorting by page id, then block id, which is
/// stable and no ranking. The meta carries a `results_truncated` warning and `totals.matches`, the
/// number of matching blocks before the cut, known from the one query. When LogSeq answers `null` the results are
/// `[]` and the meta carries a `property_query_unavailable` warning and no `totals` (BR-0011, #415); no matches is
/// an empty `results` and no meta.
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
) -> Result<PropertyResults, ToolError> {
    // A key LogSeq can't have is refused before any call
    let key = PropertyKey::parse(property_key)?;
    let query = queries::blocks_by_property(&key, &property_value.to_js_string());
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    let Some(pulled) = wire::blocks(&answer)? else {
        let meta = ResultMeta::new(vec![property_query_unavailable(property_key)], &[]);
        return Ok(PropertyResults { results: Vec::new(), meta: Some(meta) });
    };

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
    Ok(PropertyResults { results, meta })
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
    fn a_page_spelled_db_id_sorts_by_that_id_not_as_page_zero() {
        let mut spelled = block(5, None);
        spelled.insert("page".into(), json!({"db/id": 30}));
        let mut blocks = vec![spelled, block(7, Some(10)), block(6, Some(40))];
        blocks.sort_by(by_page_then_block);
        let ids: Vec<i64> = blocks.iter().map(block_id).collect();
        assert_eq!(ids, [7, 5, 6]);
    }

    #[test]
    fn the_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_query_by_property in the ADR-0016 snapshot
        let pinned = json!({
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
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_pinned() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Query by Property"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Query by Property", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"property_key": "status", "property_value": "done"});
        let without = |param: &str| {
            let mut base = base.clone();
            base.as_object_mut().unwrap().remove(param);
            base
        };
        sweep::<Args>(without("property_key"), "property_key", Takes::Text, true);
        sweep::<Args>(without("property_value"), "property_value", Takes::Scalar, true);
        sweep::<Args>(base.clone(), "limit", Takes::Count(0), false);
        sweep::<Args>(base, "slim_results", Takes::Flag, false);
    }

    #[test]
    fn the_arguments_read_as_the_schema_defaults_say() {
        let required = json!({"property_key": "status", "property_value": 3});
        let defaults = parse_args::<Args>(required.as_object()).unwrap();
        assert_eq!(
            defaults,
            Args { property_key: "status".into(), property_value: Scalar::Number(3.0), limit: 100, slim_results: true }
        );
        assert_eq!(serde_json::from_value::<Args>(required).unwrap(), defaults);
        // the first argument in schema order that is wrong is the one reported
        let bad = json!({"slim_results": 0, "limit": "a", "property_value": []});
        assert_eq!(
            parse_args::<Args>(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'property_key': missing\n\nExpected: a string (required)\nExample: property_key: \"...\""
        );
        let bad = json!({"property_key": "a", "slim_results": 0, "limit": "a", "property_value": []});
        assert_eq!(
            parse_args::<Args>(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'property_value': []\n\nExpected: a string, a number or a boolean, not an array\nExample: property_value: \"...\""
        );
        let bad = json!({"property_key": "a", "slim_results": 0, "limit": "a", "property_value": false});
        assert_eq!(
            parse_args::<Args>(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'limit': \"a\"\n\nExpected: a number, not a string\nExample: limit: 5"
        );
    }
}
