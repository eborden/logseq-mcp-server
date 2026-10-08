//! `logseq_search_blocks` (the Rust side of `src/tools/search-blocks.ts`): a case-insensitive,
//! literal substring search over block content, newest first.
//!
//! Calls: 1 (the search query), or 2 with `include_context` (one batched lookup of the pages the
//! returned blocks sit on, and none when no block has a page id). The match runs inside LogSeq
//! (`re-pattern` / `re-find` over the text with its metacharacters escaped), results are sorted
//! here, newest first (highest block id), and cut to `limit`, since Datalog here has no `:limit`.
//!
//! This directory holds everything only the search uses: its queries (`queries.rs`), the answers it
//! reads (`wire.rs`) and its tip (`tips.rs`). What it shares with other tools is outside it: slim
//! output, entity fields, the truncation warnings and the tool helpers.

mod queries;
mod tips;
mod wire;

use std::collections::HashMap;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::Arguments;
use crate::client::LogseqClient;
use crate::edn::PageId;
use crate::entity::{id_of, page_display_name};
use crate::errors::ToolError;
use crate::js;
use crate::meta::{ResultMeta, ResultWarning};
use crate::slim::{DEFAULT_SLIM_RESULTS, extract_page_refs, extract_tags, to_slim_block, to_slim_page};
use crate::tool::{input_schema, read_only_annotations, success_result};
use crate::truncation::{CappedTruncation, blocks_inline_max, capped_truncation_warning};

use self::tips::search_tips;

pub const NAME: &str = "logseq_search_blocks";

/// Results returned when `limit` is absent.
pub const DEFAULT_SEARCH_LIMIT: u64 = 100;

/// Most results one call returns (#61). A larger `limit` is clamped to it, and a cut at the maximum
/// is reported by a `results_truncated` warning with no `howToFetchAll`.
pub const MAX_SEARCH_LIMIT: u64 = 500;

/// How to reach matches past the maximum: no parameter fetches them.
const NARROWER: &str = "Narrow the query to see the rest.";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "Case-insensitive literal substring search over block content, newest first, capped by limit (max 500). Check hasMore and warnings.\n\n\
**Can't find:** synonyms, stems or related words (try variants), blocks by property (logseq_query_by_property), link structure (logseq_search_by_relationship), or over 500 matches in one call (narrow the query).\n\
**Next:** logseq_build_context on a result's page.";

fn default_slim_results() -> bool {
    DEFAULT_SLIM_RESULTS
}

/// The search's arguments. Unknown fields are ignored, as every TypeScript tool ignores them.
#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
pub struct Args {
    /// Text to search for in block content
    pub query: String,
    /// Maximum number of results to return (default: 100, max: 500)
    pub limit: Option<u64>,
    /// Include semantic context (page, references, tags)
    #[serde(default)]
    pub include_context: bool,
    /// Slim blocks (default). false returns full entities
    #[serde(default = "default_slim_results")]
    pub slim_results: bool,
}

/// Read the arguments in the order the schema lists them, so the first one that is wrong is the one
/// reported, as `parseArgs` does.
fn read_args(arguments: Option<&JsonObject>) -> Result<Args, ToolError> {
    let read = Arguments::new(arguments);
    Ok(Args {
        query: read.required_string("query")?,
        limit: read.optional_count("limit", 0)?,
        include_context: read.boolean("include_context", false)?,
        slim_results: read.boolean("slim_results", DEFAULT_SLIM_RESULTS)?,
    })
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Search Blocks")
        .with_annotations(read_only_annotations("Search Blocks"))
}

/// A call: arguments read, the search, then its meta and tips.
pub async fn call(client: &LogseqClient, tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = read_args(arguments.as_ref())?;
    let found = search_blocks_with_meta(client, &args.query, args.limit, args.include_context, args.slim_results).await?;
    // `null` from LogSeq is `null` here, and has no meta or tips: no matches is an empty array
    let Some(found) = found else { return Ok(success_result(vec![ContentBlock::text("null")])) };

    let mut content = vec![ContentBlock::text(js::json_stringify(&Value::Array(found.results.clone())))];
    let tips = if tips_enabled { search_tips(&args.query, &found.results, found.matches()) } else { Vec::new() };
    let mut meta = serde_json::to_value(&found.meta).expect("a result meta serializes");
    if !tips.is_empty() {
        meta.as_object_mut().expect("a result meta is an object").insert("tips".into(), json!(tips));
    }
    content.push(ContentBlock::text(js::json_stringify(&json!({ "meta": meta }))));
    Ok(success_result(content))
}

/// The hits of a search and what to say about them.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchResults {
    /// Slim blocks, or full ones with `slim_results: false`
    pub results: Vec<Value>,
    pub meta: ResultMeta,
}

impl SearchResults {
    /// `totals.matches`: the number of matching blocks before `limit`.
    pub fn matches(&self) -> Option<usize> {
        self.meta.totals.get("matches").and_then(Value::as_u64).map(|matches| matches as usize)
    }
}

/// A block's id as the sort reads it (`b.id - a.id`).
fn block_id(block: &Value) -> f64 {
    block.get("id").and_then(Value::as_f64).unwrap_or(0.0)
}

/// The id of the page a block sits on (`blockPageId`): undefined when the block carries no page.
fn block_page_id(block: &Value) -> Option<i64> {
    id_of(block.get("page"))
}

/// A page pulled with `[*]` (kebab-case keys), as the camelCase page entity `getAllPages` returns
/// and `toSlimPage` reads: the pull's keys, then the Editor API's spellings added. What it builds
/// carries both `originalName` and `original-name`.
fn pulled_page_to_entity(pulled: &Map<String, Value>) -> Map<String, Value> {
    const RENAMED: [&str; 5] = ["original-name", "journal-day", "created-at", "updated-at", "properties-text-values"];
    let mut page: Map<String, Value> = pulled.iter().filter(|(key, _)| !RENAMED.contains(&key.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    if let Some(original) = pulled.get("original-name") {
        page.insert("originalName".into(), original.clone());
        page.insert("original-name".into(), original.clone());
    }
    for (kebab, camel) in [("journal-day", "journalDay"), ("created-at", "createdAt"), ("updated-at", "updatedAt"), ("properties-text-values", "propertiesTextValues")] {
        if let Some(value) = pulled.get(kebab) {
            page.insert(camel.into(), value.clone());
        }
    }
    page
}

/// A block and what `include_context` adds to it.
struct Context {
    page: Map<String, Value>,
    references: Vec<String>,
    tags: Vec<String>,
}

/// Each block with its `context` (page, references, tags), from one batched page lookup (not one
/// per block). A block with no page id, or whose page isn't found, gets none. Only the blocks kept
/// are passed, so the lookup covers no more pages than the result shows.
///
/// API calls: 1, or 0 when no block has a page id.
async fn with_page_context(client: &LogseqClient, blocks: &[Value]) -> Result<Vec<Option<Context>>, ToolError> {
    let mut page_ids: Vec<i64> = Vec::new();
    for id in blocks.iter().filter_map(block_page_id) {
        if !page_ids.contains(&id) {
            page_ids.push(id);
        }
    }

    let mut page_by_id: HashMap<i64, Map<String, Value>> = HashMap::new();
    if !page_ids.is_empty() {
        let ids = page_ids.iter().map(|&id| PageId::new(id)).collect::<Result<Vec<_>, _>>()?;
        let query = queries::pages_by_ids(&ids);
        let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
        // PARITY(#299): a `null` answer is read as no pages, so every block silently loses its context, where
        // BR-0011 asks for a warning that the context is unavailable (suspected TS bug) — fix per #326, in both servers.
        for row in wire::page_rows(&answer)?.unwrap_or_default() {
            let page = pulled_page_to_entity(row.as_object().expect("a checked page is an object"));
            if let Some(id) = page.get("id").and_then(Value::as_f64) {
                page_by_id.insert(id as i64, page);
            }
        }
    }

    Ok(blocks
        .iter()
        .map(|block| {
            // No page id, or page not found: skip context for this block
            let page = page_by_id.get(&block_page_id(block)?)?;
            let content = block.get("content").and_then(Value::as_str).unwrap_or("");
            Some(Context { page: page.clone(), references: extract_page_refs(content), tags: extract_tags(content) })
        })
        .collect())
}

/// A slim result: `toSlimBlock`, with its `context` slimmed too. Empty `references` and `tags` are
/// left out (#42): the block is slim, so the lists add only bytes.
fn slim_result(block: &Value, context: Option<&Context>) -> Value {
    let block = block.as_object().expect("a checked block is an object");
    let mut slim = to_slim_block(block, &page_display_name(block.get("page")));
    if let Some(context) = context {
        let mut slim_context = Map::new();
        slim_context.insert("page".into(), Value::Object(to_slim_page(&Value::Object(context.page.clone()))));
        if !context.references.is_empty() {
            slim_context.insert("references".into(), json!(context.references));
        }
        if !context.tags.is_empty() {
            slim_context.insert("tags".into(), json!(context.tags));
        }
        slim.insert("context".into(), Value::Object(slim_context));
    }
    Value::Object(slim)
}

/// A full result: the block as it came, with `context` after it.
fn full_result(block: &Value, context: Option<&Context>) -> Value {
    let mut result = block.clone();
    if let Some(context) = context {
        result.as_object_mut().expect("a checked block is an object").insert(
            "context".into(),
            json!({"page": context.page, "references": context.references, "tags": context.tags}),
        );
    }
    result
}

/// Search blocks for `query`: the results and their meta (`totals.matches` is the number of
/// matching blocks before `limit`, and a `results_truncated` warning says what `limit` to use to get
/// them all), or `None` when LogSeq answers `null` (no matches is an empty `results`).
///
/// `limit` (default 100) is clamped to [`MAX_SEARCH_LIMIT`]. The warning never suggests a value above
/// it, and a cut at the maximum carries no `howToFetchAll`, so `hasMore` is false there (BR-0006).
pub async fn search_blocks_with_meta(
    client: &LogseqClient,
    query: &str,
    limit: Option<u64>,
    include_context: bool,
    slim_results: bool,
) -> Result<Option<SearchResults>, ToolError> {
    let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
    let search = queries::search_blocks(query);
    let answer = client.execute_datalog_query(&search.text, &search.inputs).await?;
    let Some(mut matches) = wire::hits(&answer)? else { return Ok(None) };

    // Newest first (highest block id first). Ids are unique, and a sort that keeps ties in order
    matches.sort_by(|a, b| block_id(b).total_cmp(&block_id(a)));
    let total = matches.len();
    matches.truncate(limit.min(MAX_SEARCH_LIMIT) as usize);

    let warnings: Vec<ResultWarning> = (total > matches.len())
        .then(|| {
            capped_truncation_warning(CappedTruncation {
                what: "matching blocks",
                shown: matches.len(),
                total,
                param: "limit",
                max: MAX_SEARCH_LIMIT as usize,
                narrower: NARROWER,
                requested: Some(limit),
                code: "results_truncated",
                inline_max: Some(blocks_inline_max(include_context, slim_results)),
                paging: None,
            })
        })
        .into_iter()
        .collect();
    let meta = ResultMeta::new(warnings, &[("matches", total)]);

    // Page context only for the blocks kept, so the lookup never covers cut ones
    let contexts: Vec<Option<Context>> = if include_context { with_page_context(client, &matches).await? } else { matches.iter().map(|_| None).collect() };
    let results = matches
        .iter()
        .zip(&contexts)
        .map(|(block, context)| if slim_results { slim_result(block, context.as_ref()) } else { full_result(block, context.as_ref()) })
        .collect();
    Ok(Some(SearchResults { results, meta }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};

    #[test]
    fn a_pulled_page_gets_the_editor_spellings_after_its_own_keys() {
        let pulled = json!({
            "id": 5, "original-name": "Alice", "name": "alice", "journal-day": 20250101, "created-at": 7, "updated-at": 8,
            "properties-text-values": {"a": "b"}, "uuid": "u"
        });
        let entity = pulled_page_to_entity(pulled.as_object().unwrap());
        assert_eq!(
            js::json_stringify(&Value::Object(entity)),
            r#"{"id":5,"name":"alice","uuid":"u","originalName":"Alice","original-name":"Alice","journalDay":20250101,"createdAt":7,"updatedAt":8,"propertiesTextValues":{"a":"b"}}"#
        );
        // a pull without the renamed keys adds none
        let bare = json!({"id": 6, "name": "bob"});
        assert_eq!(js::json_stringify(&Value::Object(pulled_page_to_entity(bare.as_object().unwrap()))), r#"{"id":6,"name":"bob"}"#);
    }

    fn block(id: i64, content: &str) -> Value {
        json!({"id": id, "uuid": format!("u{id}"), "content": content, "page": {"id": 5, "name": "alice", "original-name": "Alice"}})
    }

    fn context() -> Context {
        let page = json!({"id": 5, "name": "alice", "originalName": "Alice", "original-name": "Alice", "journal?": false});
        Context { page: page.as_object().unwrap().clone(), references: vec!["Bob".into()], tags: vec![] }
    }

    #[test]
    fn a_full_result_is_the_block_as_it_came_with_its_context_after_it() {
        assert_eq!(
            js::json_stringify(&full_result(&block(1, "hi [[Bob]]"), None)),
            r#"{"id":1,"uuid":"u1","content":"hi [[Bob]]","page":{"id":5,"name":"alice","original-name":"Alice"}}"#
        );
        assert_eq!(
            js::json_stringify(&full_result(&block(1, "hi [[Bob]]"), Some(&context()))),
            r#"{"id":1,"uuid":"u1","content":"hi [[Bob]]","page":{"id":5,"name":"alice","original-name":"Alice"},"context":{"page":{"id":5,"name":"alice","originalName":"Alice","original-name":"Alice","journal?":false},"references":["Bob"],"tags":[]}}"#
        );
    }

    #[test]
    fn a_slim_result_names_the_page_and_leaves_out_what_is_empty() {
        assert_eq!(
            js::json_stringify(&slim_result(&block(1, "hi [[Bob]] #t"), None)),
            r##"{"uuid":"u1","content":"hi [[Bob]] #t","pageName":"Alice","tags":["t"],"pageRefs":["Bob"]}"##
        );
        assert_eq!(
            js::json_stringify(&slim_result(&block(1, "hi [[Bob]]"), Some(&context()))),
            r#"{"uuid":"u1","content":"hi [[Bob]]","pageName":"Alice","pageRefs":["Bob"],"context":{"page":{"name":"alice","originalName":"Alice"},"references":["Bob"]}}"#
        );
    }

    #[test]
    fn the_schema_means_what_the_typescript_one_means() {
        // `inputSchema` of logseq_search_blocks in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Text to search for in block content"},
                "limit": {"type": "integer", "minimum": 0, "description": "Maximum number of results to return (default: 100, max: 500)"},
                "include_context": {"type": "boolean", "default": false, "description": "Include semantic context (page, references, tags)"},
                "slim_results": {"type": "boolean", "default": true, "description": "Slim blocks (default). false returns full entities"},
            },
            "required": ["query"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Search Blocks"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Search Blocks", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_read_as_the_schema_defaults_say() {
        let only_query = json!({"query": "x"});
        let defaults = read_args(only_query.as_object()).unwrap();
        assert_eq!(defaults, Args { query: "x".into(), limit: None, include_context: false, slim_results: true });
        assert_eq!(serde_json::from_value::<Args>(only_query).unwrap(), defaults);
        // the first argument in schema order that is wrong is the one reported
        let bad = json!({"slim_results": 0, "limit": "a"});
        assert_eq!(read_args(bad.as_object()).unwrap_err().to_string(), "Invalid parameter 'query': missing\n\nExpected: a string (required)\nExample: query: \"...\"");
        let bad = json!({"query": "x", "slim_results": 0, "limit": "a"});
        assert_eq!(
            read_args(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'limit': \"a\"\n\nExpected: a number, not a string\nExample: limit: 5"
        );
    }
}
