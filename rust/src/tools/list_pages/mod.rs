//! `logseq_list_pages` (the Rust side of `src/tools/list-pages.ts`): the non-journal pages in name
//! order, each with the other names it goes by (`alias::`), filtered by `name_contains`.
//!
//! Calls: 1 (`logseq.Editor.getAllPages`), whatever the filter, `limit`, `offset` or number of
//! aliases. The `alias` ids and `file` ride on every page entity, so the alias groups are folded
//! here in TypeScript's way (#171), and the window is cut here.
//!
//! This directory holds everything only the list uses: the answer it reads (`wire.rs`) and its tip
//! (`tips.rs`).

mod tips;
mod wire;

use std::cmp::Ordering;
use std::collections::HashMap;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::args::Arguments;
use crate::client::LogseqClient;
use crate::errors::ToolError;
use crate::meta::ResultWarning;
use crate::order;
use crate::tips::tips_content;
use crate::tool::{input_schema, read_only_annotations, result_value, success_result};
use crate::truncation::{CappedTruncation, INLINE_PAGES, Paging, capped_truncation_warning};

use self::tips::list_pages_tips;
use self::wire::ListedEntity;

pub const NAME: &str = "logseq_list_pages";

/// Pages returned when `limit` is absent (#61).
pub const DEFAULT_LIST_PAGES_LIMIT: u64 = 200;
/// Most pages one call returns. A larger `limit` is clamped to it, and `offset` reaches the pages
/// past it, so a cut at the maximum still has a `howToFetchAll`.
pub const MAX_LIST_PAGES_LIMIT: u64 = 1000;
/// Pages skipped when `offset` is absent.
pub const DEFAULT_LIST_PAGES_OFFSET: u64 = 0;

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "List non-journal pages as { name, aliases? }, filtered by name_contains (substring of name or alias). Aliases nest under pages.\n\n\
**Use when:** unsure which pages exist or what the user calls something.\n\
**Can't find:** journals (logseq_query_by_date_range), block text (logseq_search_blocks), or past 200 (use offset). Warning pages_unavailable: list unknown, not empty.\n\
**Next:** logseq_get_page.";

fn default_limit() -> u64 {
    DEFAULT_LIST_PAGES_LIMIT
}

/// The list's arguments. Unknown fields are ignored, as every TypeScript tool ignores them.
#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
pub struct Args {
    /// Filter pages whose name or alias contains this text (case-insensitive)
    pub name_contains: Option<String>,
    /// Max pages (default: 200, max: 1000)
    #[serde(default = "default_limit")]
    pub limit: u64,
    /// Pages to skip, in name order; shifts if the graph changes
    #[serde(default)]
    pub offset: u64,
}

/// Read the arguments in the order the schema lists them, so the first one that is wrong is the one
/// reported, as `parseArgs` does.
fn read_args(arguments: Option<&JsonObject>) -> Result<Args, ToolError> {
    let read = Arguments::new(arguments);
    Ok(Args {
        name_contains: read.optional_string("name_contains")?,
        limit: read.count_or("limit", 0, DEFAULT_LIST_PAGES_LIMIT)?,
        offset: read.count_or("offset", 0, DEFAULT_LIST_PAGES_OFFSET)?,
    })
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("List Pages")
        .with_annotations(read_only_annotations("List Pages"))
}

/// A call: arguments read, the list, then its tip.
pub async fn call(client: &LogseqClient, tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = read_args(arguments.as_ref())?;
    let result = list_pages(client, &args).await?;
    let mut content = vec![ContentBlock::text(result.to_value().to_string())];
    if tips_enabled {
        let first = result.pages.first().map(|page| page.name.as_str());
        if let Some(tips) = tips_content(&list_pages_tips(args.name_contains.as_deref(), first)) {
            content.push(ContentBlock::text(tips));
        }
    }
    Ok(success_result(content))
}

/// One page of the list (#171). `aliases` holds the other names of the page, in original casing
/// and name order, and is left out when there are none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListedPage {
    pub name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

/// `hasMore` and `warnings` are present only when LogSeq returned no page list (`null`) or `limit`
/// cut the list. A result that holds every matching page from `offset` on, including a genuinely
/// empty graph, carries neither.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListPagesResult {
    pub pages: Vec<ListedPage>,
    /// Every matching canonical page, before `offset` and `limit`. An alias is not a page of its own
    pub total: usize,
    pub warning: Option<ResultWarning>,
}

/// The completeness keys that come with a warning, the one warning in a list.
#[derive(Serialize)]
struct Completeness<'a> {
    #[serde(rename = "hasMore")]
    has_more: bool,
    warnings: [&'a ResultWarning; 1],
}

/// A result as written, in BR-0013's order: how many pages there were (`total`), then `hasMore` and `warnings` when
/// a warning applies, then the `pages`.
#[derive(Serialize)]
struct ListPagesOutput<'a> {
    total: usize,
    #[serde(flatten)]
    completeness: Option<Completeness<'a>>,
    pages: &'a [ListedPage],
}

impl ListPagesResult {
    /// The result in BR-0013's key order.
    pub fn to_value(&self) -> Value {
        result_value(&ListPagesOutput {
            total: self.total,
            completeness: self.warning.as_ref().map(|warning| Completeness { has_more: warning.how_to_fetch_all.is_some(), warnings: [warning] }),
            pages: &self.pages,
        })
    }
}

/// A list entry with the entities behind it, kept until the filter and the window are applied.
struct Entry<'a> {
    page: &'a ListedEntity,
    aliases: Vec<&'a ListedEntity>,
}

/// A total order on page names ([`order::by_name`]): `getAllPages` order is not guaranteed, so a
/// tie between two names would put one name on two pages and drop the other.
fn by_name(a: &ListedEntity, b: &ListedEntity) -> Ordering {
    order::by_name(&a.name, &b.name)
}

/// Fold alias links into the page list (#171), from the `alias` ids that `getAllPages` already
/// carries on every entity, so it costs no call.
///
/// Which page is canonical follows the resolver (`declaringPages`): a page with a file wrote the
/// `alias::` line, so it is canonical, and the file-less stubs LogSeq made for its alias names nest
/// under it. LogSeq links an alias group of three or more as a clique, but the declaring page links
/// all of them, so a stub's canonical pages are the file-backed pages it links to directly.
///
/// - Two file-backed pages that declare the same name (an ambiguous alias) each list that name, so
///   the name shows up under both and `total` counts both pages.
/// - A page with a file never nests under another, even when one declares the other as an alias.
/// - A stub that links no file-backed page has nothing to nest under and stays a top-level page.
///
/// Links are read in both directions, in case a LogSeq version stores one.
fn nest_aliases<'a>(pages: &[&'a ListedEntity]) -> Vec<Entry<'a>> {
    let mut by_id: HashMap<i64, &ListedEntity> = HashMap::new();
    for page in pages {
        by_id.insert(page.id, page); // the last of two pages with one id wins, as a `Map` does
    }
    let mut neighbours: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut link = |from: i64, to: i64| {
        if from == to || !by_id.contains_key(&to) {
            return;
        }
        let linked = neighbours.entry(from).or_default();
        if !linked.contains(&to) {
            linked.push(to);
        }
    };
    for page in pages {
        for &target in &page.alias_ids {
            link(page.id, target);
            link(target, page.id);
        }
    }

    let mut entries = Vec::new();
    for page in pages {
        let linked: Vec<&ListedEntity> =
            neighbours.get(&page.id).map(|ids| ids.iter().map(|id| by_id[id]).collect()).unwrap_or_default();
        if page.written {
            let mut aliases: Vec<&ListedEntity> = linked.into_iter().filter(|other| !other.written).collect();
            aliases.sort_by(|a, b| by_name(a, b));
            entries.push(Entry { page, aliases });
        } else if !linked.iter().any(|other| other.written) {
            entries.push(Entry { page, aliases: Vec::new() });
        }
    }
    entries
}

/// Non-journal pages in name order, `offset` pages in, at most `limit` of them (#61). Each page
/// carries its aliases, which use no `limit` slots (#171). `name_contains` matches the page's name
/// or any alias, and returns the page with all its aliases. `total` counts every matching page,
/// whatever `offset` and `limit` are. When pages remain after the ones returned, a `pages_truncated`
/// warning says how to get them: raise `limit` when that fits under the maximum, and set `offset`
/// to the next page in any case, so `hasMore` is true.
pub async fn list_pages(client: &LogseqClient, args: &Args) -> Result<ListPagesResult, ToolError> {
    let requested = args.limit;
    let limit = requested.min(MAX_LIST_PAGES_LIMIT) as usize;
    let offset = usize::try_from(args.offset).unwrap_or(usize::MAX);

    let answer = client.call_api(wire::METHOD, &[]).await?;
    // `null` is not `[]` (BR-0011). An empty array is a graph with no pages. `null` may mean no graph
    // is open or LogSeq is re-indexing, so the empty list is reported with a warning instead of
    // passing for "none". `hasMore` stays false: no parameter fetches a page list that does not
    // exist, so the warning has no `howToFetchAll` (the retry advice is in the message).
    let Some(all_pages) = wire::pages(&answer)? else {
        return Ok(ListPagesResult {
            pages: Vec::new(),
            total: 0,
            warning: Some(ResultWarning::new(
                "pages_unavailable",
                "LogSeq returned no page list (possibly no graph open or a re-index in progress), \
                 so the empty list may not mean the graph is empty. \
                 Retry in a moment, or call logseq_get_graph_info to check which graph is open."
                    .to_owned(),
            )),
        });
    };

    // Journals are not listed, and take no part in alias groups
    let pages: Vec<&ListedEntity> = all_pages.iter().filter(|page| !page.journal).collect();
    let mut entries = nest_aliases(&pages);

    // Filter by name if specified (case-insensitive): the page's own name or any alias
    if let Some(wanted) = args.name_contains.as_deref().filter(|text| !text.is_empty()) {
        let lower = wanted.to_lowercase();
        entries.retain(|entry| {
            entry.page.name.to_lowercase().contains(&lower) || entry.aliases.iter().any(|alias| alias.name.to_lowercase().contains(&lower))
        });
    }

    entries.sort_by(|a, b| by_name(a.page, b.page));
    let listed: Vec<ListedPage> = entries
        .iter()
        .map(|entry| ListedPage {
            name: entry.page.display_name.clone(),
            aliases: entry.aliases.iter().map(|alias| alias.display_name.clone()).collect(),
        })
        .collect();

    let total = listed.len();
    let pages: Vec<ListedPage> = listed.into_iter().skip(offset).take(limit).collect();
    if offset.saturating_add(pages.len()) >= total {
        return Ok(ListPagesResult { pages, total, warning: None });
    }
    let warning = pages_truncated(pages.len(), total, offset, requested);
    Ok(ListPagesResult { pages, total, warning: Some(warning) })
}

/// The `pages_truncated` warning for `shown` pages from `offset` of `total`. Counted from `offset`,
/// so "get all N" means the N pages from there on. Paging leads (#196): `howToFetchAll` starts with
/// the next offset whenever there is one, and raising `limit` is the alternative. With limit 0 there
/// is no next offset, because it would not move, so only raising limit is suggested.
fn pages_truncated(shown: usize, total: usize, offset: usize, requested: u64) -> ResultWarning {
    capped_truncation_warning(CappedTruncation {
        what: &if offset > 0 { format!("pages from offset {offset}") } else { "pages".to_owned() },
        shown,
        total: total - offset,
        param: "limit",
        max: MAX_LIST_PAGES_LIMIT as usize,
        narrower: "Narrow name_contains to see the rest.",
        requested: Some(requested),
        code: "pages_truncated",
        inline_max: Some(INLINE_PAGES),
        paging: (shown > 0).then(|| Paging { param: "offset", next: format!("Set offset to {} for the next page.", offset + shown) }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{keys, meaning, schema_of};
    use serde_json::json;

    fn entity(id: i64, name: &str, written: bool, alias_ids: &[i64]) -> ListedEntity {
        ListedEntity {
            id,
            name: name.to_lowercase(),
            display_name: name.to_owned(),
            journal: false,
            written,
            alias_ids: alias_ids.to_vec(),
        }
    }

    fn listed(entities: &[ListedEntity], name_contains: Option<&str>) -> Vec<(String, Vec<String>)> {
        let pages: Vec<&ListedEntity> = entities.iter().collect();
        let mut entries = nest_aliases(&pages);
        if let Some(wanted) = name_contains {
            let lower = wanted.to_lowercase();
            entries.retain(|e| e.page.name.contains(&lower) || e.aliases.iter().any(|a| a.name.contains(&lower)));
        }
        entries.sort_by(|a, b| by_name(a.page, b.page));
        entries
            .iter()
            .map(|e| (e.page.display_name.clone(), e.aliases.iter().map(|a| a.display_name.clone()).collect()))
            .collect()
    }

    #[test]
    fn a_stub_nests_under_the_page_that_wrote_the_alias() {
        let pages = [entity(1, "Alice Rivera", true, &[2, 3]), entity(2, "Al", false, &[1]), entity(3, "Ali", false, &[1, 2]), entity(4, "Bob", true, &[])];
        assert_eq!(
            listed(&pages, None),
            [("Alice Rivera".to_owned(), vec!["Al".to_owned(), "Ali".to_owned()]), ("Bob".to_owned(), vec![])]
        );
    }

    #[test]
    fn a_name_that_two_pages_declare_is_listed_under_both() {
        let pages = [entity(1, "Alice", true, &[3]), entity(2, "Allie", true, &[3]), entity(3, "Al", false, &[1, 2])];
        assert_eq!(
            listed(&pages, None),
            [("Alice".to_owned(), vec!["Al".to_owned()]), ("Allie".to_owned(), vec!["Al".to_owned()])]
        );
    }

    #[test]
    fn a_page_with_a_file_never_nests_and_a_lone_stub_stays_top_level() {
        let pages = [entity(1, "Alice", true, &[2]), entity(2, "Bob", true, &[1]), entity(3, "Stub", false, &[]), entity(4, "Other Stub", false, &[3])];
        assert_eq!(
            listed(&pages, None),
            [("Alice".to_owned(), vec![]), ("Bob".to_owned(), vec![]), ("Other Stub".to_owned(), vec![]), ("Stub".to_owned(), vec![])]
        );
    }

    #[test]
    fn a_link_to_a_page_that_is_not_listed_points_at_nothing() {
        let pages = [entity(1, "Alice", true, &[99])];
        assert_eq!(listed(&pages, None), [("Alice".to_owned(), vec![])]);
    }

    #[test]
    fn the_filter_matches_the_name_or_an_alias_and_keeps_every_alias() {
        let pages = [entity(1, "Alice Rivera", true, &[2]), entity(2, "Nickname", false, &[1]), entity(3, "Bob", true, &[])];
        assert_eq!(listed(&pages, Some("nick")), [("Alice Rivera".to_owned(), vec!["Nickname".to_owned()])]);
        assert_eq!(listed(&pages, Some("BOB")), [("Bob".to_owned(), vec![])], "the filter is lowercased");
    }

    #[test]
    fn names_that_collate_equal_still_have_one_order() {
        let a = entity(1, "caf\u{e9}", true, &[]);
        let b = entity(2, "cafe\u{301}", true, &[]);
        assert_ne!(by_name(&a, &b), Ordering::Equal);
        assert_eq!(by_name(&a, &b), by_name(&b, &a).reverse());
    }

    #[test]
    fn the_total_and_the_warning_come_before_the_pages() {
        let plain = ListPagesResult {
            pages: vec![ListedPage { name: "Alice".into(), aliases: vec!["Al".into()] }, ListedPage { name: "Bob".into(), aliases: vec![] }],
            total: 2,
            warning: None,
        };
        assert_eq!(plain.to_value().to_string(), r#"{"total":2,"pages":[{"name":"Alice","aliases":["Al"]},{"name":"Bob"}]}"#);
        assert_eq!(keys(&plain.to_value()), ["total", "pages"]);
        let cut = ListPagesResult {
            pages: vec![],
            total: 3,
            warning: Some(ResultWarning { code: "c".into(), message: "m".into(), how_to_fetch_all: Some("h".into()) }),
        };
        assert_eq!(
            cut.to_value().to_string(),
            r#"{"total":3,"hasMore":true,"warnings":[{"code":"c","message":"m","howToFetchAll":"h"}],"pages":[]}"#
        );
        assert_eq!(keys(&cut.to_value()), ["total", "hasMore", "warnings", "pages"]);
        // a warning with no way to fetch more says so
        let no_more = ListPagesResult { warning: Some(ResultWarning::new("c", "m".into())), ..cut };
        assert_eq!(no_more.to_value()["hasMore"], false);
    }

    #[test]
    fn a_cut_names_the_next_offset_and_a_raise_of_the_limit() {
        let warning = pages_truncated(2, 5, 0, 2);
        assert_eq!(warning.code, "pages_truncated");
        assert_eq!(warning.message, "Showing 2 of 5 pages. Page through the rest with offset.");
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some("Set offset to 2 for the next page. Or set limit to 5 (or higher) to get all 5 in one call.")
        );
        let later = pages_truncated(2, 9, 3, 2);
        assert_eq!(later.message, "Showing 2 of 6 pages from offset 3. Page through the rest with offset.");
        assert!(later.how_to_fetch_all.unwrap().starts_with("Set offset to 5 for the next page."));
        // limit 0 shows nothing, so there is no next offset and only a raise of the limit is suggested
        let none = pages_truncated(0, 4, 0, 0);
        assert_eq!(none.message, "Showing 0 of 4 pages.");
        assert_eq!(none.how_to_fetch_all.as_deref(), Some("Set limit to 4 (or higher) to get all 4."));
    }

    #[test]
    fn the_schema_means_what_the_typescript_one_means() {
        // `inputSchema` of logseq_list_pages in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "name_contains": {"type": "string", "description": "Filter pages whose name or alias contains this text (case-insensitive)"},
                "limit": {"type": "integer", "minimum": 0, "default": 200, "description": "Max pages (default: 200, max: 1000)"},
                "offset": {"type": "integer", "minimum": 0, "default": 0, "description": "Pages to skip, in name order; shifts if the graph changes"},
            },
            "required": [],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("List Pages"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "List Pages", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_read_as_the_schema_defaults_say() {
        let defaults = read_args(None).unwrap();
        assert_eq!(defaults, Args { name_contains: None, limit: 200, offset: 0 });
        assert_eq!(serde_json::from_value::<Args>(json!({})).unwrap(), defaults);
        let bad = json!({"limit": 2.5, "offset": -1});
        assert_eq!(
            read_args(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'limit': 2.5\n\nExpected: an integer, not a fraction\nExample: limit: 5"
        );
    }
}
