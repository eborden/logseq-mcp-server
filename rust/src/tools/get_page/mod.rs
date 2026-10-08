//! `logseq_get_page` (the Rust side of `src/tools/get-page.ts`): a page by name, optionally with
//! its blocks, optionally with their `((uuid))` refs and `{{embed}}`s resolved.
//!
//! Calls: 1 for the exact name of a page that has a file (`logseq.Editor.getPage` alone, no
//! resolver), and 1 more with `include_children` (`getPageBlocksTree`), 2 in all. A name that isn't such a
//! page (an alias, an ISO date, a namespace leaf, a stub with no file, or no page at all) goes to
//! the page resolver too: one Datalog query for an exact name, alias or date, a second for a
//! namespace leaf, the suggestion lookup for a miss, and another `getPage` call when the resolver
//! found a different page than the exact name. With `resolve_refs`, up to 2 more Datalog queries,
//! none when no block holds a ref.
//!
//! The page and its blocks are the entities the Editor API sent, key order and spelling included
//! (BR-0004). The result adds `resolvedFrom` when the name wasn't an exact one, then `children`,
//! then (with `resolve_refs`) `hasMore` and `warnings`. `format: "markdown"` is not written yet
//! (#310).

mod tips;
mod wire;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::Arguments;
use crate::client::LogseqClient;
use crate::errors::{MatchedBy, PageNotFound, ToolError};
use crate::js;
use crate::output_format::{OutputFormat, require_json};
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::{ResolvedPage, require_page};
use crate::resolve_refs::{resolve_block_refs, with_meta};
use crate::tips::tips_content;
use crate::tool::{input_schema, read_only_annotations, success_result};

use self::tips::page_tips;

pub const NAME: &str = "logseq_get_page";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "Get a page by name (case-insensitive). With include_children, also its blocks.\n\n\
**Use when:** you know the page name.\n\
**Can't find:** pages by keyword (logseq_search_blocks, logseq_list_pages) or what links here (logseq_get_backlinks).\n\
**Alternatives:** logseq_build_context adds related pages and references; logseq_get_page_outline for a long page.";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("page_name", &["name", "page"])];

/// The page tool's arguments. Unknown fields are ignored, as every TypeScript tool ignores them.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {
    /// Page name, alias, or ISO date (2025-01-01) for a journal
    pub page_name: String,
    /// Whether to include child blocks/pages
    #[serde(default)]
    pub include_children: bool,
    /// Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)
    #[serde(default)]
    pub resolve_refs: bool,
    /// json (default), or markdown text. Markdown has block uuids only on search hits and with compact
    pub format: Option<OutputFormat>,
}

/// The arguments in the order the schema lists them, so the first one that is wrong is the one
/// reported, as `parseArgs` does.
fn read_args(arguments: Option<&JsonObject>) -> Result<Args, ToolError> {
    let read = Arguments::new(arguments);
    Ok(Args {
        page_name: read.required_string("page_name")?,
        include_children: read.boolean("include_children", false)?,
        resolve_refs: read.boolean("resolve_refs", false)?,
        format: OutputFormat::read(&read)?,
    })
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Page")
        .with_annotations(read_only_annotations("Get Page"))
}

/// A call: aliases folded, arguments read, the page, then its tips.
pub async fn call(client: &LogseqClient, tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let args = read_args(arguments.as_ref())?;
    require_json(args.format)?;
    let page = get_page(client, &args.page_name, args.include_children, args.resolve_refs).await?;
    let mut content = vec![ContentBlock::text(js::json_stringify(&page))];
    if tips_enabled {
        if let Some(tips) = tips_content(&page_tips(&page, &args.page_name, args.include_children)) {
            content.push(ContentBlock::text(tips));
        }
    }
    Ok(success_result(content))
}

/// `resolvedFrom`: says the page isn't the exact name the caller gave. Absent for an exact match.
/// `name` is the name as the caller typed it, untrimmed.
fn resolved_from(input: &str, resolved: &ResolvedPage) -> Option<Value> {
    (resolved.matched_by != MatchedBy::Name)
        .then(|| json!({"name": input, "matchedBy": resolved.matched_by.as_str(), "resolvedTo": resolved.original_name}))
}

/// A page's Editor API entity by name, or `None`.
async fn editor_page(client: &LogseqClient, name: &str) -> Result<Option<Value>, ToolError> {
    let answer = client.call_api(wire::PAGE_METHOD, &[Value::from(name)]).await?;
    Ok(wire::page(&answer)?)
}

/// A page by name, alias, or ISO date, as the Editor API sent it.
///
/// Fast path (1 API call): the Editor API finds an exact name, in any casing. A page with a file is
/// a real page that keeps its name, so no resolution can change the answer. Aliases, dates and
/// namespace leaves come back `null` here; a stub (no file) may be an alias target or have a
/// journal behind it, so both go to the resolver.
///
/// With `include_children` the page gains `children`, its top-level blocks (nested), when it has
/// any. With `resolve_refs` the blocks are annotated and `hasMore` and `warnings` are added, even
/// when there are no blocks.
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if no page matches,
/// and [`ToolError::AmbiguousPage`] (with the candidates) if several do.
pub async fn get_page(client: &LogseqClient, page_name: &str, include_children: bool, resolve_refs: bool) -> Result<Value, ToolError> {
    let lookup = js::trim(page_name);
    let direct = editor_page(client, lookup).await?;

    let mut entity = direct.clone();
    let mut lookup_name = lookup.to_owned();
    let mut from = None;
    if direct.as_ref().is_none_or(|page| page.get("file").is_none_or(Value::is_null)) {
        let resolved = require_page(client, page_name).await?;
        lookup_name = resolved.lookup_name.clone();
        from = resolved_from(page_name, &resolved);
        // An exact match is the page already fetched; anything else needs its own fetch
        entity = if resolved.matched_by == MatchedBy::Name && direct.is_some() { direct } else { editor_page(client, &lookup_name).await? };
    }

    // The page vanished between the two calls
    let Some(Value::Object(mut result)) = entity else {
        return Err(ToolError::PageNotFound(PageNotFound { page_name: page_name.to_owned(), suggestions: Vec::new() }));
    };
    if let Some(from) = from {
        result.insert("resolvedFrom".into(), from);
    }

    // If include_children is requested, fetch the page blocks tree
    if include_children {
        let answer = client.call_api(wire::BLOCKS_METHOD, &[Value::from(lookup_name.as_str())]).await?;
        // PARITY(#299): a `null` answer leaves the page without `children` and says nothing, where BR-0011 asks
        // for a warning that the blocks were unavailable (suspected TS bug) — fix per #323, in both servers.
        if let Some(blocks) = wire::blocks(&answer)?.filter(|blocks| !blocks.is_empty()) {
            result.insert("children".into(), Value::Array(blocks));
        }
    }

    if !resolve_refs {
        return Ok(Value::Object(result));
    }
    let roots: Vec<Value> = result.get("children").and_then(Value::as_array).cloned().unwrap_or_default();
    let resolved = resolve_block_refs(client, &roots).await?;
    // `{ ...result, ...(result.children ? { children: blocks } : {}), ...buildResultMeta(warnings) }`
    let mut annotated: Map<String, Value> = result;
    if annotated.contains_key("children") {
        annotated.insert("children".into(), Value::Array(resolved.blocks));
    }
    Ok(Value::Object(with_meta(annotated, &resolved.warnings)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};

    #[test]
    fn the_page_schema_means_what_the_typescript_one_means() {
        // `inputSchema` of logseq_get_page in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "page_name": {"type": "string", "description": "Page name, alias, or ISO date (2025-01-01) for a journal"},
                "include_children": {"type": "boolean", "default": false, "description": "Whether to include child blocks/pages"},
                "resolve_refs": {"type": "boolean", "default": false, "description": "Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
            },
            "required": ["page_name"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_page_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Page"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Page", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_the_aliases_are_folded() {
        let args = |value: Value| value.as_object().cloned();
        let folded = resolve_param_aliases(ALIASES, args(json!({"name": "Atlas", "resolve_refs": true}))).unwrap();
        let read = read_args(folded.as_ref()).unwrap();
        assert_eq!((read.page_name.as_str(), read.include_children, read.resolve_refs), ("Atlas", false, true));
        let error = read_args(args(json!({"page_name": "a", "include_children": "yes", "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'include_children': \"yes\""), "{error}");
        let error = read_args(args(json!({})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'page_name': missing"), "{error}");
    }

    #[test]
    fn a_page_found_another_way_says_where_it_came_from_and_an_exact_one_says_nothing() {
        let page = |matched_by| ResolvedPage { page: Default::default(), matched_by, original_name: "Project Atlas".into(), lookup_name: "project atlas".into() };
        assert_eq!(resolved_from(" atlas ", &page(MatchedBy::Name)), None);
        assert_eq!(
            resolved_from(" atlas ", &page(MatchedBy::Alias)).unwrap().to_string(),
            r#"{"name":" atlas ","matchedBy":"alias","resolvedTo":"Project Atlas"}"#
        );
    }
}
