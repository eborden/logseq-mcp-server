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
//! A full page has no count cap, so [`call`] cuts it to the character budget (#507, #485) and reads the rest with a
//! cursor (ADR-0038, #552): its blocks, nested ones counted, in page order, until the text it sends is at most
//! `BUDGET_CHARS`. A block is never cut inside its text (BR-0007), and a kept block that lost children says so with
//! `childrenTruncated`. A cut page carries `nextCursor` and a `result_size_truncated` warning whose `howToFetchAll` says
//! to pass it, and the page after it, read from the snapshot the first call kept (no LogSeq call) or, when the snapshot
//! is gone, with the calls the first page made, starts at the next block. A page that starts inside a subtree names
//! the blocks it sits under (`ancestors`, `crate::tree_paging`). A page under the budget, and a `page` or `outline`
//! result, are as they were.
//!
//! A call with a `cursor` takes no other argument, and `page` is optional in the schema for that reason (BR-0008): the
//! handler refuses a call with neither.

pub mod outline;
mod tips;
pub mod wire;

use std::time::Instant;

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
use crate::paging::refuse_with_cursor;
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve::{ResolvedPage, require_page};
use crate::resolve_refs::{resolve_block_refs, with_meta};
use crate::snapshots::Snapshots;
use crate::tips::tips_content;
use crate::tool::{CursorSchema, input_schema, read_only_annotations, success_result};
use crate::tree_paging::{Resume, Root, Spec, Tree, read};

use self::outline::{Read, outline_result};
use self::tips::page_tips;

pub const NAME: &str = "logseq_get_page";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Get a page by name (case-insensitive). detail: page (default), full (adds its blocks; hasMore: send only cursor=nextCursor) or outline (top-level blocks: uuid, first line, child count).\n\n\
**Use when:** you know the page name.\n\
**Can't find:** pages by keyword (logseq_find_blocks, logseq_find_pages).\n\
**Alternatives:** logseq_explore_context adds related pages and what links here.";

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
    pub page: Option<String>,
    /// page (default): the page itself. full: adds its blocks, nested. outline: top-level blocks as uuid, first line and child count
    pub detail: Option<Detail>,
    /// Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2). Not for outline
    #[serde(default)]
    pub resolve_refs: bool,
    /// json (default). markdown for page and full, toon for outline
    pub format: Option<PageFormat>,
    // No doc comment: the shared description is the type's (`CursorSchema`), and a doc comment would replace it
    #[schemars(with = "Option<CursorSchema>")]
    pub cursor: Option<String>,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Page")
        .with_annotations(read_only_annotations("Get Page"))
}

/// What a cursor stands for once its arguments are read: a call that reads the blocks of a page (`full`) or its
/// outline.
fn paged_args(token: &Resume) -> Result<Args, InvalidParameter> {
    let args = parse_args::<Args>(Some(&token.cursor.args)).ok().filter(|args| args.cursor.is_none() && args.page.is_some());
    args.filter(|args| matches!(args.detail, Some(Detail::Full | Detail::Outline)) && check_combination(args.detail.unwrap_or(Detail::Full), args.format, args.resolve_refs).is_ok())
        .ok_or_else(|| token.refuse(NAME, "its arguments are not a read of the blocks or the outline of a page"))
}

/// The arguments of a full page or an outline as a cursor carries them: what the call asked, read again by [`Args`].
fn stored_arguments(args: &Args, page: &str) -> Map<String, Value> {
    let mut stored = Map::new();
    stored.insert("page".into(), json!(page));
    stored.insert("detail".into(), json!(if args.detail == Some(Detail::Outline) { "outline" } else { "full" }));
    if args.resolve_refs {
        stored.insert("resolve_refs".into(), json!(true));
    }
    match args.format {
        Some(PageFormat::Json) => stored.insert("format".into(), json!("json")),
        Some(PageFormat::Markdown) => stored.insert("format".into(), json!("markdown")),
        Some(PageFormat::Toon) => stored.insert("format".into(), json!("toon")),
        None => None,
    };
    stored
}

/// The refusal of a call with neither a page nor a cursor, before any LogSeq call (BR-0008).
fn needs_page() -> ToolError {
    ToolError::InvalidParameter(InvalidParameter {
        param: "page".to_owned(),
        value: "missing".to_owned(),
        expected: "a string (required unless cursor is given)".to_owned(),
        example: Some("page: \"...\"".to_owned()),
    })
}

/// A call: aliases folded, arguments read, the combination of `detail`, `format` and `resolve_refs` checked before
/// any LogSeq call, then the page, then its tips.
///
/// A call with a `cursor` takes no other argument (they are in the token, ADR-0038), and is refused as such on the
/// arguments after the aliases are folded, so `{ cursor, name }` is not a cursor alone (BR-0008). It reads the next
/// page of the blocks of a full page. A call with neither `page` nor `cursor` is refused here, not by the schema.
pub async fn call(client: &LogseqClient, tips_enabled: bool, snapshots: &Snapshots, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let asked = parse_args::<Args>(arguments.as_ref())?;
    let (args, resume) = match asked.cursor.clone() {
        Some(token) => {
            refuse_with_cursor::<Args>(arguments.as_ref())?;
            let resume = Resume::read(&token, NAME)?;
            (paged_args(&resume)?, Some(resume))
        }
        None => (asked, None),
    };
    let Some(page_name) = args.page.as_deref() else { return Err(needs_page()) };
    let detail = args.detail.unwrap_or(Detail::Page);
    check_combination(detail, args.format, args.resolve_refs)?;
    if detail == Detail::Outline {
        let format = (args.format == Some(PageFormat::Toon)).then_some(ListFormat::Toon);
        let stored = resume.as_ref().map_or_else(|| stored_arguments(&args, page_name), |resume| resume.cursor.args.clone());
        return outline_result(client, Read { tips_enabled, snapshots, page: page_name, format, stored: &stored, resume: resume.as_ref() }).await;
    }
    let full = detail == Detail::Full;
    // The text the call sends for a page, which the character budget measures (#507): the page, then its tips
    let markdown = args.format == Some(PageFormat::Markdown);
    let texts = |page: &Value| -> Vec<String> {
        let tips = if tips_enabled { page_tips(page, page_name, full) } else { Vec::new() };
        if markdown {
            let body = render_page(page, PageRenderOptions { blocks_fetched: full, ..Default::default() });
            return vec![with_footer(body, &FooterMeta::of_result(page, &tips))];
        }
        let mut texts = vec![page.to_string()];
        texts.extend(tips_content(&tips));
        texts
    };
    if !full {
        let page = get_page(client, page_name, false, args.resolve_refs).await?;
        return Ok(success_result(texts(&page).into_iter().map(ContentBlock::text).collect()));
    }
    // A full page is cut to the budget and read to the end with the cursor. The token carries the arguments, so a
    // snapshot is served only to a call that asks for the page it was built from
    let stored = resume.as_ref().map_or_else(|| stored_arguments(&args, page_name), |resume| resume.cursor.args.clone());
    let spec = Spec { tool: NAME, root: Root::Page, markdown };
    let build = || async { Ok::<_, ToolError>(Tree::new(Root::Page, get_page(client, page_name, true, args.resolve_refs).await?)) };
    let sent = read(snapshots, resume.as_ref(), &stored, &spec, Instant::now(), build, &texts).await?;
    Ok(success_result(sent.into_iter().map(ContentBlock::text).collect()))
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
                "cursor": {"type": "string", "description": crate::tool::CURSOR_DESCRIPTION},
            },
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
            assert_eq!((read.page.as_deref(), read.detail, read.resolve_refs), (Some("Atlas"), None, true), "{alias}");
        }
        // the first bad argument in schema order is the one reported
        let error = parse_args::<Args>(args(json!({"page": "a", "detail": "all", "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'detail': \"all\""), "{error}");
        let error = parse_args::<Args>(args(json!({"page": "a", "detail": "full", "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'format': \"xml\""), "{error}");
        // `page` is optional in the schema, so a call without it parses: the handler refuses it (BR-0008)
        assert_eq!(parse_args::<Args>(args(json!({"detail": "full"})).as_ref()).unwrap().page, None);
        // the v1 parameter is gone: it is ignored, as every unknown argument is, and the page comes without its blocks
        let read = parse_args::<Args>(args(json!({"page": "a", "include_children": true})).as_ref()).unwrap();
        assert_eq!(read.detail, None);
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"page": "Atlas"});
        sweep::<Args>(json!({}), "page", Takes::Text, false);
        sweep::<Args>(base.clone(), "detail", Takes::Words(&["page", "full", "outline"]), false);
        sweep::<Args>(base.clone(), "resolve_refs", Takes::Flag, false);
        sweep::<Args>(base.clone(), "format", Takes::Words(&["json", "markdown", "toon"]), false);
        sweep::<Args>(base, "cursor", Takes::Text, false);
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

    #[test]
    fn a_call_with_neither_a_page_nor_a_cursor_is_refused_with_the_missing_page_named() {
        let error = needs_page().to_string();
        assert_eq!(error, "Invalid parameter 'page': missing\n\nExpected: a string (required unless cursor is given)\nExample: page: \"...\"");
    }

    #[test]
    fn a_cursor_with_an_alias_of_the_page_is_not_a_cursor_alone() {
        // BR-0008: the aliases are folded first, so `{ cursor, name }` is `{ cursor, page }` and the page can't change
        for alias in ["name", "page_name"] {
            let args = json!({"cursor": "abc", alias: "Atlas"}).as_object().cloned();
            let folded = resolve_param_aliases(ALIASES, args).unwrap();
            let error = refuse_with_cursor::<Args>(folded.as_ref()).unwrap_err();
            assert_eq!((error.param.as_str(), error.value.as_str()), ("page", "\"Atlas\""), "{alias}");
        }
        let alone = resolve_param_aliases(ALIASES, json!({"cursor": "abc"}).as_object().cloned()).unwrap();
        assert!(refuse_with_cursor::<Args>(alone.as_ref()).is_ok());
    }

    fn resume_with(args: Value) -> Resume {
        use crate::cursor::{Anchor, Cursor, Position, SnapshotKey, encode};
        let cursor = Cursor::new(NAME, args.as_object().cloned().unwrap(), Position::Index { at: 3 }, Anchor::Text("u".into()), SnapshotKey { started: 1, n: 1 });
        Resume::read(&encode(&cursor), NAME).unwrap()
    }

    #[test]
    fn a_cursor_stands_only_for_the_blocks_of_a_full_page_and_its_arguments_read_as_a_call_does() {
        let full = json!({"page": "Atlas", "detail": "full", "resolve_refs": true, "format": "markdown"});
        let args = paged_args(&resume_with(full)).unwrap();
        assert_eq!((args.page.as_deref(), args.detail, args.resolve_refs, args.format), (Some("Atlas"), Some(Detail::Full), true, Some(PageFormat::Markdown)));
        // an outline, in TOON as well
        let outline = paged_args(&resume_with(json!({"page": "Atlas", "detail": "outline", "format": "toon"}))).unwrap();
        assert_eq!((outline.detail, outline.format), (Some(Detail::Outline), Some(PageFormat::Toon)));
        // not a full page or an outline, no page, a format the detail doesn't take, resolve_refs on an outline, a cursor
        // inside the cursor
        for args in [
            json!({"page": "Atlas"}),
            json!({"page": "Atlas", "detail": "page"}),
            json!({"detail": "full"}),
            json!({"page": "Atlas", "detail": "full", "format": "toon"}),
            json!({"page": "Atlas", "detail": "outline", "format": "markdown"}),
            json!({"page": "Atlas", "detail": "outline", "resolve_refs": true}),
            json!({"page": "Atlas", "detail": "full", "cursor": "abc"}),
            json!({"page": 5, "detail": "full"}),
        ] {
            let error = paged_args(&resume_with(args.clone())).err().unwrap_or_else(|| panic!("{args}"));
            assert_eq!(error.param, "cursor", "{args}");
            assert!(error.expected.contains("its arguments are not a read of the blocks or the outline of a page"), "{error}");
        }
    }

    #[test]
    fn an_outline_cursor_carries_its_detail_and_its_toon_format() {
        let args = parse_args::<Args>(json!({"page": "Atlas", "detail": "outline", "format": "toon"}).as_object()).unwrap();
        assert_eq!(Value::Object(stored_arguments(&args, "Atlas")).to_string(), r#"{"page":"Atlas","detail":"outline","format":"toon"}"#);
    }

    #[test]
    fn the_arguments_a_cursor_carries_are_the_call_that_made_it_and_read_back_to_it() {
        let args = parse_args::<Args>(json!({"page": " Atlas ", "detail": "full", "resolve_refs": true, "format": "markdown"}).as_object()).unwrap();
        let stored = stored_arguments(&args, " Atlas ");
        assert_eq!(Value::Object(stored.clone()).to_string(), r#"{"page":" Atlas ","detail":"full","resolve_refs":true,"format":"markdown"}"#);
        let again = parse_args::<Args>(Some(&stored)).unwrap();
        assert_eq!((again.page.as_deref(), again.detail, again.resolve_refs, again.format), (Some(" Atlas "), Some(Detail::Full), true, Some(PageFormat::Markdown)));
        // what is the default is left out
        let plain = parse_args::<Args>(json!({"page": "a", "detail": "full"}).as_object()).unwrap();
        assert_eq!(Value::Object(stored_arguments(&plain, "a")).to_string(), r#"{"page":"a","detail":"full"}"#);
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
