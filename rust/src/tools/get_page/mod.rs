//! `logseq_get_page`: one page by name, at the depth `detail` asks for (ADR-0037, #489):
//!
//! - `page` (the default): the page itself.
//! - `full`: the page with its blocks, optionally with their `((uuid))` refs and `{{embed}}`s resolved. This is what
//!   `include_children: true` was before v2.
//! - `outline`: the page's top-level blocks as a uuid, a first line and a child count, from [`outline`]. This is what
//!   the tool `logseq_get_page_outline` was before v2, and its result is unchanged.
//!
//! Calls (`page` and `full`): 1 for the exact name of a page that has a file (`logseq.Editor.getPage` alone, no
//! resolver), and 1 more with `full` (`getPageBlocksTree`), 2 in all. A name that isn't such a
//! page (an alias, an ISO date, a namespace leaf, a stub with no file, or no page at all) goes to
//! the page resolver too: one Datalog query for an exact name, alias or date, a second for a
//! namespace leaf, the suggestion lookup for a miss, and another `getPage` call when the resolver
//! found a different page than the exact name. With `resolve_refs`, up to 2 more Datalog queries,
//! none when no block holds a ref. The calls of `outline` are in its own module.
//!
//! The page and its blocks are the entities the Editor API sent, key order and spelling included
//! (BR-0004). The result adds `resolvedFrom` when the name wasn't an exact one, then `children`,
//! then `hasMore` and `warnings` (with `resolve_refs`, or when LogSeq answered `null` for the blocks: a
//! `page_blocks_unavailable` warning, BR-0011).
//!
//! With `format: "markdown"` the same page is rendered by `crate::markdown` into one text block,
//! its warnings, `hasMore` and tips in a footer, and no separate tips block. The calls are the same.
//! `format` and `resolve_refs` each fit only some `detail`s (`check_combination`): an outline takes `json` or
//! `toon` and no `resolve_refs`, a page or a full page takes `json` or `markdown`.
//!
//! A full page has no count cap, so [`call`] cuts it to the character budget (#507, #485): its blocks, nested ones
//! counted, in page order, until the text it sends is at most `BUDGET_CHARS`. A block is never cut inside its text
//! (BR-0007), and a kept block that lost children says so with `childrenTruncated`. No parameter pages a page, so
//! the `result_size_truncated` warning has no `howToFetchAll`; it names the outline and `logseq_get_block`. A page
//! under the budget, and a `page` or `outline` result, are as they were.

pub mod outline;
mod tips;
pub mod wire;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::parse_args;
use crate::client::LogseqClient;
use crate::errors::{InvalidParameter, MatchedBy, PageNotFound, ToolError};
use crate::js;
use crate::markdown::{FooterMeta, PageRenderOptions, render_page, with_footer};
use crate::meta::ResultWarning;
use crate::output_format::ListFormat;
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::{ResolvedPage, require_page};
use crate::resolve_refs::{resolve_block_refs, with_meta};
use crate::tips::tips_content;
use crate::tool::{input_schema, read_only_annotations, success_result};

use crate::block_budget::{Budget, count_blocks, take_blocks};
use crate::budget::{Fit, fit, size};
use crate::resolve_refs::push_warning;
use crate::truncation::{SizeCut, size_truncation_warning};

use self::outline::{MAX_OUTLINE_BLOCKS, outline_result};
use self::tips::page_tips;

pub const NAME: &str = "logseq_get_page";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Get a page by name (case-insensitive). detail: page (default), full (adds its blocks) or outline (top-level blocks: uuid, first line, child count).\n\n\
**Use when:** you know the page name.\n\
**Can't find:** pages by keyword (logseq_find_blocks, logseq_find_pages) or what links here (logseq_get_backlinks).\n\
**Alternatives:** logseq_build_context adds related pages and references.";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("page", &["name", "page_name"])];

/// How much of the page comes back. A word that is none of the three is refused by `parse_args`. No doc comment: it
/// would become a `description` of the enum beside the parameter's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Detail {
    Page,
    Full,
    Outline,
}

/// The `format` of this tool: one parameter, with the words of both of its families, since `detail` decides which
/// two are valid (`check_combination`). No doc comment, as above.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PageFormat {
    Json,
    Markdown,
    Toon,
}

/// The page tool's arguments. Unknown fields are ignored, as in every tool (see `input_schema`).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {
    /// Page name, alias, or ISO date (2025-01-01) for a journal
    pub page: String,
    /// page (default): the page itself. full: adds its blocks, nested. outline: top-level blocks as uuid, first line and child count
    pub detail: Option<Detail>,
    /// Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2). Not for outline
    #[serde(default)]
    pub resolve_refs: bool,
    /// json (default). markdown for page and full, toon for outline
    pub format: Option<PageFormat>,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Page")
        .with_annotations(read_only_annotations("Get Page"))
}

/// A call: aliases folded, arguments read, the combination of `detail`, `format` and `resolve_refs` checked before
/// any LogSeq call, then the page, then its tips.
pub async fn call(client: &LogseqClient, tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let args = parse_args::<Args>(arguments.as_ref())?;
    let detail = args.detail.unwrap_or(Detail::Page);
    check_combination(detail, args.format, args.resolve_refs)?;
    if detail == Detail::Outline {
        let format = (args.format == Some(PageFormat::Toon)).then_some(ListFormat::Toon);
        return outline_result(client, tips_enabled, &args.page, format).await;
    }
    let full = detail == Detail::Full;
    let page = get_page(client, &args.page, full, args.resolve_refs).await?;
    let tips = if tips_enabled { page_tips(&page, &args.page, full) } else { Vec::new() };
    // The text the call sends, which the character budget measures (#507): the page, then its tips
    let markdown = args.format == Some(PageFormat::Markdown);
    let texts = |page: &Value| -> Vec<String> {
        if markdown {
            let body = render_page(page, PageRenderOptions { blocks_fetched: full, ..Default::default() });
            return vec![with_footer(body, &FooterMeta::of_result(page, &tips))];
        }
        let mut texts = vec![page.to_string()];
        texts.extend(tips_content(&tips));
        texts
    };
    let page = if full { fit_to_budget(page, &texts, markdown) } else { page };
    Ok(success_result(texts(&page).into_iter().map(ContentBlock::text).collect()))
}

/// The page as it is when its text fits the character budget (#507, #485), else with the first blocks that do, nested
/// ones counted, in page order. A block is never cut inside its text (BR-0007), so a first block over the budget
/// comes back alone, and the warning says so.
fn fit_to_budget(page: Value, texts: &impl Fn(&Value) -> Vec<String>, markdown: bool) -> Value {
    let total = page.get("children").and_then(Value::as_array).map_or(0, |blocks| count_blocks(blocks));
    let size_of = |kept: usize| -> usize {
        let sent = if kept < total { cut_page(&page, kept, total, false, markdown) } else { page.clone() };
        texts(&sent).iter().map(|text| size(text)).sum()
    };
    match fit(total, 1, size_of) {
        Fit::Whole => page,
        Fit::Cut { kept, oversize } => cut_page(&page, kept, total, oversize, markdown),
    }
}

/// The page cut to its first `kept` blocks of `total` (nested ones counted, in page order), with the
/// `result_size_truncated` warning and `hasMore` worked out again. Every key keeps its place, and `hasMore` and
/// `warnings` come last when the page had none.
fn cut_page(page: &Value, kept: usize, total: usize, oversize: bool, markdown: bool) -> Value {
    let Value::Object(fields) = page else { return page.clone() };
    let blocks = fields.get("children").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let mut budget = Budget::new(kept);
    let first = take_blocks(blocks, &mut budget);
    let mut cut = fields.clone();
    cut.insert("children".into(), Value::Array(first));
    // Markdown writes no marker for a block that lost children, so it names none
    let lost = if markdown { "the last blocks kept may have lost some of their children" } else { "a kept block marked childrenTruncated lost some of its children" };
    let warning = size_truncation_warning(SizeCut {
        what: "blocks of the page (nested ones counted, in page order)",
        kept,
        total,
        oversize,
        advice: &format!(
            "The last blocks are left out, and {lost}. A page can't be paged and no parameter raises this limit: \
             list its top-level blocks with detail \"outline\" (at most {MAX_OUTLINE_BLOCKS}), then read one with logseq_get_block and include_children."
        ),
        how_to_fetch_all: None,
    });
    Value::Object(push_warning(cut, &warning))
}

/// Refuses what `detail` can't take, naming what it can. The outline has no block bodies to resolve, so
/// `resolve_refs` is refused there rather than ignored, and its `format` is `json` or `toon`; the page and the
/// full page render as `json` or `markdown`. The arguments are checked in the order the schema lists them, so
/// `resolve_refs` comes before `format`.
fn check_combination(detail: Detail, format: Option<PageFormat>, resolve_refs: bool) -> Result<(), ToolError> {
    if detail == Detail::Outline && resolve_refs {
        return Err(ToolError::InvalidParameter(InvalidParameter {
            param: "resolve_refs".to_owned(),
            value: "true".to_owned(),
            expected: "false, or left out, with detail \"outline\", which has no block bodies to resolve. Use detail \"full\" to resolve refs".to_owned(),
            example: Some("detail: \"full\"".to_owned()),
        }));
    }
    let (word, valid, example) = match (detail, format) {
        (Detail::Outline, Some(PageFormat::Markdown)) => ("markdown", "json or toon with detail \"outline\". markdown is for detail \"page\" or \"full\"", "format: \"toon\""),
        (Detail::Page | Detail::Full, Some(PageFormat::Toon)) => ("toon", "json or markdown with detail \"page\" or \"full\". toon is for detail \"outline\"", "format: \"markdown\""),
        _ => return Ok(()),
    };
    Err(ToolError::InvalidParameter(InvalidParameter {
        param: "format".to_owned(),
        value: json!(word).to_string(),
        expected: valid.to_owned(),
        example: Some(example.to_owned()),
    }))
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
/// With `include_children` (`detail: "full"`) the page gains `children`, its top-level blocks (nested), when it has
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

    // With `detail: "full"` (`include_children`), fetch the page blocks tree
    let mut warnings: Vec<ResultWarning> = Vec::new();
    if include_children {
        let answer = client.call_api(wire::BLOCKS_METHOD, &[Value::from(lookup_name.as_str())]).await?;
        // `null` is not `[]` (BR-0011). An empty tree is a page with no blocks and says nothing. `null` may mean no
        // graph is open or LogSeq is re-indexing, so the page is returned without `children` and a warning says why.
        // No `howToFetchAll`: no parameter fetches blocks LogSeq did not answer, so `hasMore` stays false (BR-0006).
        match wire::blocks(&answer)? {
            None => warnings.push(blocks_unavailable()),
            Some(blocks) if blocks.is_empty() => {}
            Some(blocks) => {
                result.insert("children".into(), Value::Array(blocks));
            }
        }
    }

    if !resolve_refs {
        return Ok(Value::Object(if warnings.is_empty() { result } else { with_meta(result, &warnings) }));
    }
    let roots: Vec<Value> = result.get("children").and_then(Value::as_array).cloned().unwrap_or_default();
    let resolved = resolve_block_refs(client, &roots).await?;
    // `{ ...result, ...(result.children ? { children: blocks } : {}), ...buildResultMeta(warnings) }`
    let mut annotated: Map<String, Value> = result;
    if annotated.contains_key("children") {
        annotated.insert("children".into(), Value::Array(resolved.blocks));
    }
    warnings.extend(resolved.warnings);
    Ok(Value::Object(with_meta(annotated, &warnings)))
}

/// The warning for a `null` answer to the page's block tree.
fn blocks_unavailable() -> ResultWarning {
    ResultWarning::new(
        "page_blocks_unavailable",
        "LogSeq returned no answer when looking up the blocks of this page (possibly no graph open or a re-index in progress), \
         so the page is returned without its children. This does not mean the page has no blocks. \
         Retry in a moment, or call logseq_get_graph to check which graph is open."
            .to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};

    #[test]
    fn the_page_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_get_page in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "page": {"type": "string", "description": "Page name, alias, or ISO date (2025-01-01) for a journal"},
                "detail": {"type": "string", "enum": ["page", "full", "outline"], "description": "page (default): the page itself. full: adds its blocks, nested. outline: top-level blocks as uuid, first line and child count"},
                "resolve_refs": {"type": "boolean", "default": false, "description": "Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2). Not for outline"},
                "format": {"type": "string", "enum": ["json", "markdown", "toon"], "description": "json (default). markdown for page and full, toon for outline"},
            },
            "required": ["page"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    #[test]
    fn the_page_tool_is_read_only_and_titled_as_pinned() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Page"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Page", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_description_opens_with_the_type_verb_and_keeps_its_limit_and_cant_find_line() {
        assert!(DESCRIPTION.starts_with("Get "));
        assert!(DESCRIPTION.contains("**Can't find:**"));
        assert!(DESCRIPTION.chars().count() <= 400, "{} characters", DESCRIPTION.chars().count());
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_the_aliases_are_folded() {
        let args = |value: Value| value.as_object().cloned();
        for alias in ["name", "page_name"] {
            let folded = resolve_param_aliases(ALIASES, args(json!({alias: "Atlas", "resolve_refs": true}))).unwrap();
            let read = parse_args::<Args>(folded.as_ref()).unwrap();
            assert_eq!((read.page.as_str(), read.detail, read.resolve_refs), ("Atlas", None, true), "{alias}");
        }
        // the first bad argument in schema order is the one reported
        let error = parse_args::<Args>(args(json!({"page": "a", "detail": "all", "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'detail': \"all\""), "{error}");
        let error = parse_args::<Args>(args(json!({"page": "a", "detail": "full", "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'format': \"xml\""), "{error}");
        let error = parse_args::<Args>(args(json!({"detail": "full"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'page': missing"), "{error}");
        // the v1 parameter is gone: it is ignored, as every unknown argument is, and the page comes without its blocks
        let read = parse_args::<Args>(args(json!({"page": "a", "include_children": true})).as_ref()).unwrap();
        assert_eq!(read.detail, None);
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"page": "Atlas"});
        sweep::<Args>(json!({}), "page", Takes::Text, true);
        sweep::<Args>(base.clone(), "detail", Takes::Words(&["page", "full", "outline"]), false);
        sweep::<Args>(base.clone(), "resolve_refs", Takes::Flag, false);
        sweep::<Args>(base, "format", Takes::Words(&["json", "markdown", "toon"]), false);
    }

    #[test]
    fn a_page_takes_json_or_markdown_and_an_outline_json_or_toon() {
        for detail in [Detail::Page, Detail::Full] {
            for format in [None, Some(PageFormat::Json), Some(PageFormat::Markdown)] {
                assert!(check_combination(detail, format, false).is_ok(), "{detail:?} {format:?}");
            }
            let error = check_combination(detail, Some(PageFormat::Toon), false).unwrap_err().to_string();
            assert_eq!(
                error,
                "Invalid parameter 'format': \"toon\"\n\nExpected: json or markdown with detail \"page\" or \"full\". toon is for detail \"outline\"\nExample: format: \"markdown\""
            );
        }
        for format in [None, Some(PageFormat::Json), Some(PageFormat::Toon)] {
            assert!(check_combination(Detail::Outline, format, false).is_ok(), "{format:?}");
        }
        let error = check_combination(Detail::Outline, Some(PageFormat::Markdown), false).unwrap_err().to_string();
        assert_eq!(
            error,
            "Invalid parameter 'format': \"markdown\"\n\nExpected: json or toon with detail \"outline\". markdown is for detail \"page\" or \"full\"\nExample: format: \"toon\""
        );
    }

    #[test]
    fn resolve_refs_is_refused_on_an_outline_and_taken_on_the_other_details() {
        for detail in [Detail::Page, Detail::Full] {
            assert!(check_combination(detail, None, true).is_ok());
        }
        let error = check_combination(Detail::Outline, None, true).unwrap_err().to_string();
        assert_eq!(
            error,
            "Invalid parameter 'resolve_refs': true\n\nExpected: false, or left out, with detail \"outline\", which has no block bodies to resolve. Use detail \"full\" to resolve refs\nExample: detail: \"full\""
        );
        // resolve_refs is listed before format, so it is the one reported when both are wrong
        let both = check_combination(Detail::Outline, Some(PageFormat::Markdown), true).unwrap_err().to_string();
        assert!(both.starts_with("Invalid parameter 'resolve_refs'"), "{both}");
    }

    /// A page whose blocks are `count` top-level ones of `length` characters, each with one child of the same length.
    fn page_of(count: usize, length: usize) -> Value {
        let block = |n: usize| {
            json!({"uuid": format!("u{n}"), "content": "x".repeat(length), "children": [{"uuid": format!("c{n}"), "content": "y".repeat(length), "children": []}]})
        };
        json!({"id": 1, "originalName": "Atlas", "children": (0..count).map(block).collect::<Vec<_>>()})
    }

    fn json_text(page: &Value) -> Vec<String> {
        vec![page.to_string()]
    }

    #[test]
    fn a_full_page_at_the_budget_is_untouched_and_one_character_over_is_cut() {
        use crate::budget::BUDGET_CHARS;
        // pad the content of the last block so that the page's text is exactly the budget
        let mut page = page_of(10, 100);
        let base = size(&page.to_string());
        page["children"][9]["content"] = json!("x".repeat(100 + BUDGET_CHARS - base));
        assert_eq!(size(&page.to_string()), BUDGET_CHARS);
        assert_eq!(fit_to_budget(page.clone(), &json_text, false), page);
        page["children"][9]["content"] = json!("x".repeat(100 + BUDGET_CHARS - base + 1));
        let cut = fit_to_budget(page.clone(), &json_text, false);
        assert_ne!(cut, page);
        assert!(size(&cut.to_string()) <= BUDGET_CHARS);
    }

    #[test]
    fn a_cut_keeps_the_first_blocks_in_page_order_and_marks_the_last_one_that_lost_children() {
        let page = page_of(40, 1000);
        let cut = fit_to_budget(page.clone(), &json_text, false);
        assert!(size(&cut.to_string()) <= crate::budget::BUDGET_CHARS);
        let blocks = cut["children"].as_array().unwrap();
        // 80 blocks with their children, ~2,000 characters per top-level block: about 14 fit
        assert!(blocks.len() > 5 && blocks.len() < 40, "{}", blocks.len());
        assert_eq!(blocks[0], page["children"][0]);
        // one more block would not fit, and the warning counts nested blocks
        let kept = count_blocks(blocks);
        assert!(size(&cut_page(&page, kept + 1, 80, false, false).to_string()) > crate::budget::BUDGET_CHARS);
        let warning = &cut["warnings"][0];
        assert_eq!(warning["code"], "result_size_truncated");
        assert!(warning["message"].as_str().unwrap().starts_with(&format!("Showing {kept} of 80 blocks of the page (nested ones counted, in page order)")));
        assert_eq!(cut["hasMore"], false);
        let keys: Vec<&String> = cut.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "originalName", "children", "hasMore", "warnings"]);
    }

    #[test]
    fn a_cut_keeps_the_warnings_a_page_already_had_and_the_marker_of_a_block_that_lost_children() {
        let mut page = page_of(40, 1000);
        page["hasMore"] = json!(false);
        page["warnings"] = json!([{"code": "ref_unresolved", "message": "m"}]);
        let cut = fit_to_budget(page, &json_text, false);
        let codes: Vec<&str> = cut["warnings"].as_array().unwrap().iter().map(|warning| warning["code"].as_str().unwrap()).collect();
        assert_eq!(codes, ["ref_unresolved", "result_size_truncated"]);
        let keys: Vec<&String> = cut.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "originalName", "children", "hasMore", "warnings"]);
        // a block is cut between its own children: with 1,000-character blocks the cut can fall between a block and its child
        let last = cut["children"].as_array().unwrap().last().unwrap();
        let lost = last["children"].as_array().unwrap().is_empty();
        assert_eq!(last.get("childrenTruncated").is_some(), lost);
    }

    #[test]
    fn a_page_with_no_blocks_or_one_block_is_never_cut() {
        let empty = json!({"id": 1, "originalName": "Atlas"});
        assert_eq!(fit_to_budget(empty.clone(), &json_text, false), empty);
        let one = json!({"id": 1, "children": [{"uuid": "u", "content": "x".repeat(40_000), "children": []}]});
        assert_eq!(fit_to_budget(one.clone(), &json_text, false), one);
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
