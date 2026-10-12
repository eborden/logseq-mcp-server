//! `logseq_find_pages`: the non-journal pages in name
//! order, each with the other names it goes by (`alias::`), narrowed by any of three filters that AND together:
//! `text` (a substring of a name or alias), `names` (exact names or aliases, each answered with its page, or
//! with `null` and the closest names) and `property` with `value` (a page property).
//!
//! Calls: 1 (`logseq.Editor.getAllPages`), whatever the filter, `limit`, `offset`, number of names or number
//! of aliases. The `alias` ids, `file` and `properties` ride on every page entity, so the alias groups are
//! folded here (#171), the names are resolved here, the property is matched here, and the window is cut here.
//! Resolving a name does the name and alias routes of the page resolver (BR-0010) over that one answer. The
//! namespace-leaf and ISO-date routes are not part of it: they find a page by something other than a name it
//! has, and a journal is no page of this tool.
//!
//! This directory holds everything only the finder uses: the answer it reads (`wire.rs`) and its tip
//! (`tips.rs`).

mod tips;
mod wire;

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::args::{Scalar, parse_args};
use crate::client::LogseqClient;
use crate::errors::{InvalidParameter, MAX_CANDIDATES, ToolError};
use crate::fuzzy;
use crate::js;
use crate::meta::ResultWarning;
use crate::order;
use crate::output_format::ListFormat;
use crate::property::{PropertyKey, has_property};
use crate::resolve::MAX_SUGGESTIONS;
use crate::tips::{non_empty, tips_value};
use crate::tool::{input_schema, read_only_annotations, result_value, success_result};
use crate::truncation::{CappedTruncation, INLINE_PAGES, Paging, capped_truncation_warning};

use self::tips::find_pages_tips;
use self::wire::ListedEntity;

pub const NAME: &str = "logseq_find_pages";

/// Pages returned when `limit` is absent (#61).
pub const DEFAULT_FIND_PAGES_LIMIT: u64 = 200;
/// Most names one call looks up. More is refused by `parse_args`, never cut, so no name goes unanswered (BR-0006).
pub const MAX_NAMES: usize = 50;

/// Most pages one call returns. A larger `limit` is clamped to it, and `offset` reaches the pages
/// past it, so a cut at the maximum still has a `howToFetchAll`.
pub const MAX_FIND_PAGES_LIMIT: u64 = 1000;

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Find non-journal pages as { name, aliases? }. Filters AND: text (substring of name or alias); names (up to 50, exact name or alias; each answered with its page, or null plus closest names); property + value (page property).\n\n\
**Can't find:** journals (logseq_query_by_date_range), block text (logseq_find_blocks), or past 200 (use offset). Warning pages_unavailable: list unknown, not empty.";

fn default_limit() -> u64 {
    DEFAULT_FIND_PAGES_LIMIT
}

/// The finder's arguments. Unknown fields are ignored, as in every tool (see `input_schema`).
#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
pub struct Args {
    /// Filter pages whose name or alias contains this text (case-insensitive)
    pub text: Option<String>,
    /// Page names or aliases to look up exactly, ignoring case (1 to 50)
    #[schemars(length(min = 1, max = 50))]
    pub names: Option<Vec<String>>,
    /// Page property to match (letters, digits, "-" and "_"; createdAt and created-at are equivalent). Needs value
    pub property: Option<String>,
    /// Exact value of the property. A multi-value property matches if any one value equals it. Needs property
    #[serde(default)]
    #[schemars(with = "Scalar")]
    pub value: Option<Scalar>,
    /// Max pages (default: 200, max: 1000)
    #[serde(default = "default_limit")]
    pub limit: u64,
    /// Pages to skip, in name order; shifts if the graph changes
    #[serde(default)]
    pub offset: u64,
    /// json (default), or toon text: a list's keys once, not on every row
    pub format: Option<ListFormat>,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Find Pages")
        .with_annotations(read_only_annotations("Find Pages"))
}

/// A call: arguments read, the list, then its tip.
pub async fn call(client: &LogseqClient, tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = parse_args::<Args>(arguments.as_ref())?;
    let result = find_pages(client, &args).await?;
    let mut content = vec![ContentBlock::text(ListFormat::text(args.format, &result.to_value())?)];
    if tips_enabled {
        let first = result.pages.first().map(|page| page.name.as_str());
        if let Some(tips) = tips_value(&find_pages_tips(narrowed(&args), first)) {
            content.push(ContentBlock::text(ListFormat::text(args.format, &tips)?));
        }
    }
    Ok(success_result(content))
}

/// Whether the call narrowed the list: a `text` that isn't blank, any `names`, or a `property`. A blank `text` is no
/// filter that finds anything to open.
fn narrowed(args: &Args) -> bool {
    args.text.as_deref().and_then(non_empty).is_some() || args.names.is_some() || args.property.is_some()
}

/// One page of the list (#171). `aliases` holds the other names of the page, in original casing
/// and name order, and is left out when there are none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListedPage {
    pub name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

/// How one requested name came out. `page` is the page it names, in the page's own casing (the page that
/// declares it when the name is an alias), or `null`. With no page, `suggestions` holds the closest page names
/// when there are any; and when the name is an alias that several pages declare, `candidates` names those pages
/// (at most [`MAX_CANDIDATES`]) and `candidateCount` says how many there are when that is more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NameAnswer {
    /// The name as it was sent
    pub name: String,
    pub page: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<String>,
    #[serde(rename = "candidateCount", skip_serializing_if = "Option::is_none")]
    pub candidate_count: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<String>,
}

/// `hasMore` and `warnings` are present only when LogSeq returned no page list (`null`) or `limit`
/// cut the list. A result that holds every matching page from `offset` on, including a genuinely
/// empty graph, carries neither. `names` is present only when `names` was asked for and LogSeq returned a page
/// list: no list is no answer to a name (BR-0011), so none is given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FindPagesResult {
    pub names: Option<Vec<NameAnswer>>,
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

/// A result as written, in BR-0013's order: how each name was read (`names`, the server's reading of the request),
/// then how many pages there were (`total`), then `hasMore` and `warnings` when a warning applies, then the `pages`.
#[derive(Serialize)]
struct FindPagesOutput<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    names: Option<&'a [NameAnswer]>,
    total: usize,
    #[serde(flatten)]
    completeness: Option<Completeness<'a>>,
    pages: &'a [ListedPage],
}

impl FindPagesResult {
    /// The result in BR-0013's key order.
    pub fn to_value(&self) -> Value {
        result_value(&FindPagesOutput {
            names: self.names.as_deref(),
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
/// Which page is canonical follows the resolver: a page with a file wrote the
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

/// The property filter, checked: a key LogSeq can store and the value as the text it is matched by.
struct PropertyFilter {
    key: PropertyKey,
    value: String,
}

/// `property` and `value` go together. Both or neither is a filter; one alone is refused before any LogSeq call,
/// naming the one that is missing. A key LogSeq can't store is refused the same way (the arguments are checked in the
/// order the schema lists them, so a bad `property` is reported before a missing `value`).
fn property_filter(args: &Args) -> Result<Option<PropertyFilter>, InvalidParameter> {
    match (args.property.as_deref(), args.value.as_ref()) {
        (None, None) => Ok(None),
        (Some(property), Some(value)) => Ok(Some(PropertyFilter { key: PropertyKey::parse(property, "property")?, value: value.to_js_string() })),
        (Some(property), None) => {
            PropertyKey::parse(property, "property")?;
            Err(InvalidParameter {
                param: "value".to_owned(),
                value: "missing".to_owned(),
                expected: "the value to match (property and value go together)".to_owned(),
                example: Some("value: \"active\"".to_owned()),
            })
        }
        (None, Some(_)) => Err(InvalidParameter {
            param: "property".to_owned(),
            value: "missing".to_owned(),
            expected: "the property to match value against (property and value go together)".to_owned(),
            example: Some("property: \"status\"".to_owned()),
        }),
    }
}

/// Which entries each requested name names, and how each name came out. A name matches an entry when it equals the
/// page's name or one of its aliases, ignoring case and the white space around it. The entries a name matched are
/// the second answer: the positions of all of them, so the filter keeps exactly the pages some name found.
///
/// A name no entry matches is answered with the closest page names (the resolver's, [`fuzzy::go`]), taken from every
/// non-journal page entity, the alias stubs among them, since each of those is a name this tool answers to. A name
/// that several entries match is a name several pages declare, as the resolver finds one ambiguous: no single page.
fn answer_names(names: &[String], entries: &[Entry<'_>], pages: &[&ListedEntity]) -> (Vec<NameAnswer>, HashSet<usize>) {
    let mut index: HashMap<String, Vec<usize>> = HashMap::new();
    for (at, entry) in entries.iter().enumerate() {
        for name in std::iter::once(entry.page).chain(entry.aliases.iter().copied()).map(|entity| entity.name.to_lowercase()) {
            let matched = index.entry(name).or_default();
            if !matched.contains(&at) {
                matched.push(at);
            }
        }
    }
    let mut found = HashSet::new();
    // the names to suggest from, built when a name first misses
    let mut targets: Option<Vec<&str>> = None;
    let answers = names
        .iter()
        .map(|name| {
            let matched = index.get(&js::trim(name).to_lowercase()).map_or(&[][..], Vec::as_slice);
            found.extend(matched.iter().copied());
            let mut answer = NameAnswer { name: name.clone(), page: None, candidates: Vec::new(), candidate_count: None, suggestions: Vec::new() };
            match matched {
                [only] => answer.page = Some(entries[*only].page.display_name.clone()),
                [] => {
                    let targets = targets.get_or_insert_with(|| pages.iter().map(|page| page.display_name.as_str()).collect());
                    answer.suggestions = fuzzy::go(name, targets, MAX_SUGGESTIONS).into_iter().map(|at| targets[at].to_owned()).collect();
                }
                several => {
                    answer.candidates = several.iter().take(MAX_CANDIDATES).map(|at| entries[*at].page.display_name.clone()).collect();
                    answer.candidate_count = (several.len() > MAX_CANDIDATES).then_some(several.len());
                }
            }
            answer
        })
        .collect();
    (answers, found)
}

/// Non-journal pages in name order, `offset` pages in, at most `limit` of them (#61). Each page
/// carries its aliases, which use no `limit` slots (#171). `text` matches the page's name
/// or any alias, and returns the page with all its aliases. `names` keeps the pages one of the names finds,
/// and `property` with `value` the pages that have the property; all three AND together. `total` counts every
/// matching page, whatever `offset` and `limit` are. When pages remain after the ones returned, a `pages_truncated`
/// warning says how to get them: raise `limit` when that fits under the maximum, and set `offset`
/// to the next page in any case, so `hasMore` is true.
///
/// `names` answers each name against every non-journal page, not only the pages the other filters keep, so a name
/// that finds a page the other filters drop is still a name that has a page.
pub async fn find_pages(client: &LogseqClient, args: &Args) -> Result<FindPagesResult, ToolError> {
    let requested = args.limit;
    let limit = requested.min(MAX_FIND_PAGES_LIMIT) as usize;
    let offset = usize::try_from(args.offset).unwrap_or(usize::MAX);
    // refused before any call
    let property = property_filter(args)?;

    let answer = client.call_api(wire::METHOD, &[]).await?;
    // `null` is not `[]` (BR-0011). An empty array is a graph with no pages. `null` may mean no graph
    // is open or LogSeq is re-indexing, so the empty list is reported with a warning instead of
    // passing for "none". `hasMore` stays false: no parameter fetches a page list that does not
    // exist, so the warning has no `howToFetchAll` (the retry advice is in the message). A name has no
    // answer either: "no page" would say the page is missing.
    let Some(all_pages) = wire::pages(&answer)? else {
        return Ok(FindPagesResult {
            names: None,
            pages: Vec::new(),
            total: 0,
            warning: Some(ResultWarning::new(
                "pages_unavailable",
                "LogSeq returned no page list (possibly no graph open or a re-index in progress), \
                 so the empty list may not mean the graph is empty. \
                 Retry in a moment, or call logseq_get_graph to check which graph is open."
                    .to_owned(),
            )),
        });
    };

    // Journals are not listed, and take no part in alias groups
    let pages: Vec<&ListedEntity> = all_pages.iter().filter(|page| !page.journal).collect();
    let mut entries = nest_aliases(&pages);
    entries.sort_by(|a, b| by_name(a.page, b.page));

    let (names, named) = match args.names.as_deref() {
        Some(names) => {
            let (answers, found) = answer_names(names, &entries, &pages);
            (Some(answers), Some(found))
        }
        None => (None, None),
    };
    // Filter by text if specified (case-insensitive): the page's own name or any alias
    let text = args.text.as_deref().filter(|text| !text.is_empty()).map(str::to_lowercase);
    let mut position = 0;
    entries.retain(|entry| {
        let at = position;
        position += 1;
        text.as_ref().is_none_or(|lower| {
            entry.page.name.to_lowercase().contains(lower) || entry.aliases.iter().any(|alias| alias.name.to_lowercase().contains(lower))
        }) && named.as_ref().is_none_or(|found| found.contains(&at))
            && property
                .as_ref()
                .is_none_or(|filter| entry.page.properties.as_ref().is_some_and(|properties| has_property(properties, &filter.key, &filter.value)))
    });

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
        return Ok(FindPagesResult { names, pages, total, warning: None });
    }
    let warning = pages_truncated(pages.len(), total, offset, requested);
    Ok(FindPagesResult { names, pages, total, warning: Some(warning) })
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
        max: MAX_FIND_PAGES_LIMIT as usize,
        narrower: "Narrow text to see the rest.",
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
    use crate::wire::{Properties, PropertyValue};
    use serde_json::json;

    fn entity(id: i64, name: &str, written: bool, alias_ids: &[i64]) -> ListedEntity {
        ListedEntity {
            id,
            name: name.to_lowercase(),
            display_name: name.to_owned(),
            journal: false,
            written,
            alias_ids: alias_ids.to_vec(),
            properties: None,
        }
    }

    fn with_properties(mut entity: ListedEntity, properties: &[(&str, PropertyValue)]) -> ListedEntity {
        entity.properties = Some(Properties(properties.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect()));
        entity
    }

    fn text(text: &str) -> PropertyValue {
        PropertyValue::Text(text.to_owned())
    }

    fn answer(entities: &[ListedEntity], names: &[&str]) -> (Vec<NameAnswer>, Vec<usize>) {
        let pages: Vec<&ListedEntity> = entities.iter().collect();
        let mut entries = nest_aliases(&pages);
        entries.sort_by(|a, b| by_name(a.page, b.page));
        let names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
        let (answers, found) = answer_names(&names, &entries, &pages);
        let mut found: Vec<usize> = found.into_iter().collect();
        found.sort_unstable();
        (answers, found)
    }

    fn listed(entities: &[ListedEntity], text: Option<&str>) -> Vec<(String, Vec<String>)> {
        let pages: Vec<&ListedEntity> = entities.iter().collect();
        let mut entries = nest_aliases(&pages);
        if let Some(wanted) = text {
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
    fn a_name_finds_the_page_that_has_it_as_a_name_or_an_alias_ignoring_case_and_the_space_around_it() {
        let pages = [entity(1, "Alice Rivera", true, &[2]), entity(2, "Al", false, &[1]), entity(3, "Bob", true, &[]), entity(4, "Carol", false, &[])];
        let (answers, found) = answer(&pages, &["bob", "  ALICE rivera ", "al", "Carol"]);
        let page = |name: &str, page: &str| NameAnswer { name: name.to_owned(), page: Some(page.to_owned()), candidates: vec![], candidate_count: None, suggestions: vec![] };
        // an alias answers with the page that declares it, a stub with no page declaring it is a page, and a name keeps
        // the spelling it was sent in
        assert_eq!(answers, [page("bob", "Bob"), page("  ALICE rivera ", "Alice Rivera"), page("al", "Alice Rivera"), page("Carol", "Carol")]);
        // entries in name order: Alice Rivera, Bob, Carol
        assert_eq!(found, [0, 1, 2]);
    }

    #[test]
    fn a_name_that_is_not_there_is_null_with_the_closest_names_and_finds_nothing() {
        let pages = [entity(1, "Alice Rivera", true, &[]), entity(2, "Bob", true, &[]), entity(3, "Alicia", true, &[])];
        let (answers, found) = answer(&pages, &["Alic", "Dave", ""]);
        assert_eq!(answers[0].page, None);
        assert_eq!(answers[0].suggestions, ["Alicia", "Alice Rivera"]);
        assert_eq!((answers[1].page.as_deref(), answers[1].suggestions.is_empty()), (None, true), "nothing is close to Dave");
        assert_eq!((answers[2].page.as_deref(), answers[2].suggestions.is_empty()), (None, true), "a blank name has no page and no suggestion");
        assert_eq!(found, Vec::<usize>::new());
        assert!(answers.iter().all(|answer| answer.candidates.is_empty() && answer.candidate_count.is_none()));
    }

    #[test]
    fn a_suggestion_is_a_name_the_tool_answers_to_and_never_a_journal() {
        let mut journal = entity(3, "Alice 2025", true, &[]);
        journal.journal = true;
        let pages = [entity(1, "Alice Rivera", true, &[2]), entity(2, "Allie", false, &[1]), journal];
        let pages_ref: Vec<&ListedEntity> = pages.iter().filter(|page| !page.journal).collect();
        let mut entries = nest_aliases(&pages_ref);
        entries.sort_by(|a, b| by_name(a.page, b.page));
        let (answers, _) = answer_names(&["Alie".to_owned()], &entries, &pages_ref);
        let mut suggested = answers[0].suggestions.clone();
        suggested.sort();
        assert_eq!(suggested, ["Alice Rivera", "Allie"], "the alias stub is a name, the journal is not");
    }

    #[test]
    fn a_name_that_two_pages_declare_is_no_one_page_and_names_them() {
        let pages = [entity(1, "Alice", true, &[3]), entity(2, "Allie", true, &[3]), entity(3, "Al", false, &[1, 2])];
        let (answers, found) = answer(&pages, &["al"]);
        assert_eq!(answers[0].page, None);
        assert_eq!(answers[0].candidates, ["Alice", "Allie"]);
        assert_eq!(answers[0].candidate_count, None);
        assert!(answers[0].suggestions.is_empty());
        assert_eq!(found, [0, 1], "both pages are found, as the text filter finds both");
    }

    #[test]
    fn the_candidates_are_cut_at_the_resolvers_maximum_and_the_count_says_how_many() {
        let mut pages = vec![entity(100, "Shared", false, &(1..=12).collect::<Vec<i64>>())];
        pages.extend((1..=12).map(|id| entity(id, &format!("Page {id:02}"), true, &[100])));
        let (answers, found) = answer(&pages, &["shared"]);
        assert_eq!(answers[0].candidates.len(), MAX_CANDIDATES);
        assert_eq!(answers[0].candidates[0], "Page 01");
        assert_eq!(answers[0].candidate_count, Some(12));
        assert_eq!(found.len(), 12, "the filter keeps every page, though the answer lists ten");
    }

    #[test]
    fn a_name_answers_as_a_page_or_null_and_leaves_out_what_does_not_apply() {
        let found = NameAnswer { name: "bob".into(), page: Some("Bob".into()), candidates: vec![], candidate_count: None, suggestions: vec![] };
        let miss = NameAnswer { name: "Dave".into(), page: None, candidates: vec![], candidate_count: None, suggestions: vec!["Dave Chen".into()] };
        let ambiguous = NameAnswer { name: "al".into(), page: None, candidates: vec!["Alice".into()], candidate_count: Some(11), suggestions: vec![] };
        assert_eq!(serde_json::to_string(&found).unwrap(), r#"{"name":"bob","page":"Bob"}"#);
        assert_eq!(serde_json::to_string(&miss).unwrap(), r#"{"name":"Dave","page":null,"suggestions":["Dave Chen"]}"#);
        assert_eq!(serde_json::to_string(&ambiguous).unwrap(), r#"{"name":"al","page":null,"candidates":["Alice"],"candidateCount":11}"#);
    }

    fn args_with(extra: Value) -> Args {
        let mut sent = json!({});
        sent.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        parse_args::<Args>(sent.as_object()).unwrap()
    }

    #[test]
    fn property_and_value_go_together_and_a_missing_half_is_named_before_any_call() {
        let both = property_filter(&args_with(json!({"property": "createdBy", "value": "Alice"}))).unwrap().unwrap();
        assert_eq!((both.key.as_str(), both.value.as_str()), ("created-by", "Alice"));
        let number = property_filter(&args_with(json!({"property": "effort", "value": 3}))).unwrap().unwrap();
        assert_eq!(number.value, "3", "a number is matched as the text JavaScript writes");
        assert!(property_filter(&args_with(json!({}))).unwrap().is_none());
        assert_eq!(
            property_filter(&args_with(json!({"property": "status"}))).err().unwrap().to_string(),
            "Invalid parameter 'value': missing\n\nExpected: the value to match (property and value go together)\nExample: value: \"active\""
        );
        assert_eq!(
            property_filter(&args_with(json!({"value": "active"}))).err().unwrap().to_string(),
            "Invalid parameter 'property': missing\n\nExpected: the property to match value against (property and value go together)\nExample: property: \"status\""
        );
        // a key LogSeq can't store is refused as the property, ahead of the value that is missing
        assert_eq!(
            property_filter(&args_with(json!({"property": "a b"}))).err().unwrap().to_string(),
            "Invalid parameter 'property': a b\n\nExpected: a property name made of letters, digits, \"-\" and \"_\", starting with a letter or digit\nExample: status"
        );
    }

    #[test]
    fn a_blank_text_is_no_narrowing_but_a_name_or_a_property_is() {
        assert!(!narrowed(&args_with(json!({}))));
        assert!(!narrowed(&args_with(json!({"text": "  "}))));
        assert!(!narrowed(&args_with(json!({"text": ""}))));
        assert!(narrowed(&args_with(json!({"text": "atl"}))));
        assert!(narrowed(&args_with(json!({"names": ["Alice"]}))));
        assert!(narrowed(&args_with(json!({"property": "status", "value": "active"}))));
    }

    #[test]
    fn a_page_with_the_property_is_a_page_with_a_file_that_carries_it() {
        let atlas = with_properties(entity(1, "Project Atlas", true, &[]), &[("status", text("active"))]);
        let stub = entity(2, "Atlas", false, &[]);
        let filter = PropertyFilter { key: PropertyKey::parse("status", "property").unwrap(), value: "active".to_owned() };
        let has = |page: &ListedEntity| page.properties.as_ref().is_some_and(|properties| has_property(properties, &filter.key, &filter.value));
        assert!(has(&atlas));
        assert!(!has(&stub), "a page with no properties has none");
    }

    #[test]
    fn names_that_collate_equal_still_have_one_order() {
        let a = entity(1, "caf\u{e9}", true, &[]);
        let b = entity(2, "cafe\u{301}", true, &[]);
        assert_ne!(by_name(&a, &b), Ordering::Equal);
        assert_eq!(by_name(&a, &b), by_name(&b, &a).reverse());
    }

    #[test]
    fn the_names_the_total_and_the_warning_come_before_the_pages() {
        let plain = FindPagesResult {
            names: None,
            pages: vec![ListedPage { name: "Alice".into(), aliases: vec!["Al".into()] }, ListedPage { name: "Bob".into(), aliases: vec![] }],
            total: 2,
            warning: None,
        };
        assert_eq!(plain.to_value().to_string(), r#"{"total":2,"pages":[{"name":"Alice","aliases":["Al"]},{"name":"Bob"}]}"#);
        assert_eq!(keys(&plain.to_value()), ["total", "pages"]);
        let cut = FindPagesResult {
            names: None,
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
        let no_more = FindPagesResult { warning: Some(ResultWarning::new("c", "m".into())), ..cut };
        assert_eq!(no_more.to_value()["hasMore"], false);
        // the server's reading of the names comes first, as the echo of the request does (BR-0013)
        let named = FindPagesResult {
            names: Some(vec![NameAnswer { name: "bob".into(), page: Some("Bob".into()), candidates: vec![], candidate_count: None, suggestions: vec![] }]),
            pages: vec![ListedPage { name: "Bob".into(), aliases: vec![] }],
            total: 1,
            warning: None,
        };
        assert_eq!(named.to_value().to_string(), r#"{"names":[{"name":"bob","page":"Bob"}],"total":1,"pages":[{"name":"Bob"}]}"#);
        assert_eq!(keys(&named.to_value()), ["names", "total", "pages"]);
        let named_and_cut = FindPagesResult { warning: cut.warning.clone(), ..named };
        assert_eq!(keys(&named_and_cut.to_value()), ["names", "total", "hasMore", "warnings", "pages"]);
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
    fn the_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_find_pages in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Filter pages whose name or alias contains this text (case-insensitive)"},
                "names": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 50, "description": "Page names or aliases to look up exactly, ignoring case (1 to 50)"},
                "property": {"type": "string", "description": "Page property to match (letters, digits, \"-\" and \"_\"; createdAt and created-at are equivalent). Needs value"},
                "value": {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"}], "description": "Exact value of the property. A multi-value property matches if any one value equals it. Needs property"},
                "limit": {"type": "integer", "minimum": 0, "default": 200, "description": "Max pages (default: 200, max: 1000)"},
                "offset": {"type": "integer", "minimum": 0, "default": 0, "description": "Pages to skip, in name order; shifts if the graph changes"},
                "format": {"type": "string", "enum": ["json", "toon"], "description": "json (default), or toon text: a list's keys once, not on every row"},
            },
            "required": [],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_pinned() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Find Pages"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Find Pages", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_names_are_limited_to_the_constant_the_schema_and_the_parser_share() {
        let schema = schema_of::<Args>();
        assert_eq!(schema["properties"]["names"]["maxItems"], json!(MAX_NAMES));
        assert_eq!(schema["properties"]["names"]["minItems"], json!(1));
    }

    #[test]
    fn the_arguments_read_as_the_schema_defaults_say() {
        let defaults = parse_args::<Args>(None).unwrap();
        assert_eq!(defaults, Args { text: None, names: None, property: None, value: None, limit: 200, offset: 0, format: None });
        assert_eq!(serde_json::from_value::<Args>(json!({})).unwrap(), defaults);
        let bad = json!({"limit": 2.5, "offset": -1});
        assert_eq!(
            parse_args::<Args>(bad.as_object()).unwrap_err().to_string(),
            "Invalid parameter 'limit': 2.5\n\nExpected: an integer, not a fraction\nExample: limit: 5"
        );
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        sweep::<Args>(json!({}), "text", Takes::Text, false);
        sweep::<Args>(json!({}), "names", Takes::List(MAX_NAMES), false);
        sweep::<Args>(json!({}), "property", Takes::Text, false);
        sweep::<Args>(json!({}), "value", Takes::Scalar, false);
        sweep::<Args>(json!({}), "limit", Takes::Count(0), false);
        sweep::<Args>(json!({}), "offset", Takes::Count(0), false);
    }
}
