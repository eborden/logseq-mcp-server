//! `logseq_find_pages`: the non-journal pages in name
//! order, each with the other names it goes by (`alias::`), narrowed by any of three filters that AND together:
//! `text` (a substring of a name or alias), `names` (exact names or aliases, each answered with its page, or
//! with `null` and the closest names) and `property` with `value` (a page property).
//!
//! Calls: 1 (`logseq.Editor.getAllPages`), whatever the filter, `limit`, number of names or number
//! of aliases. The `alias` ids, `file` and `properties` ride on every page entity, so the alias groups are
//! folded here (#171), the names are resolved here, the property is matched here, and the list is cut into pages
//! here. Resolving a name does the name and alias routes of the page resolver (BR-0010) over that one answer. The
//! namespace-leaf and ISO-date routes are not part of it: they find a page by something other than a name it
//! has, and a journal is no page of this tool.
//!
//! The whole matching list is read in that one call and cut here into pages (ADR-0038, #551). A page holds at most
//! `limit` pages and at most the character budget (#507, #485, `crate::budget`), the last in name order left out, and
//! when pages are left it carries a `nextCursor` and says so with a `pages_truncated` (the count) or
//! `result_size_truncated` (the budget) warning (BR-0006). A call with only that `cursor` reads the next page: from the
//! snapshot the first call kept, with no LogSeq call, or, when the snapshot is gone, with the one call the first page
//! made, resuming at the first page named after the last one sent (`cursor_stale` says when the list moved). A page is
//! never cut inside its names (BR-0007), so a first page over the budget comes back alone and the cursor moves past it.
//! The `names` answers are the request as the server read it: page 1 carries them, never cut, and the pages after it
//! don't repeat them ([`NAMES_ON_CONTINUATION`]). A list under the budget and the limit is as it was, byte for byte.
//!
//! This directory holds everything only the finder uses: the answer it reads (`wire.rs`) and its tip
//! (`tips.rs`).

mod tips;
mod wire;

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::args::{Scalar, parse_args};
use crate::budget::{BUDGET_CHARS, size};
use crate::client::LogseqClient;
use crate::cursor::{Anchor, Cursor, Position, SnapshotKey, decode, encode, invalid};
use crate::errors::{InvalidParameter, MAX_CANDIDATES, ToolError};
use crate::fuzzy;
use crate::js;
use crate::meta::ResultWarning;
use crate::order;
use crate::output_format::ListFormat;
use crate::paging::{Cut, PagedCut, Stale, page_of, paged_warning, refuse_with_cursor, resume_at, serve, stale_warning};
use crate::property::{PropertyFilter, has_property};
use crate::resolve::MAX_SUGGESTIONS;
use crate::snapshots::{Snapshots, resident_weight};
use crate::tips::{non_empty, tips_value};
use crate::tool::{CursorSchema, input_schema, read_only_annotations, result_value, success_result};

use self::tips::find_pages_tips;
use self::wire::ListedEntity;

pub const NAME: &str = "logseq_find_pages";

/// Pages returned when `limit` is absent (#61).
pub const DEFAULT_FIND_PAGES_LIMIT: u64 = 200;
/// Most names one call looks up. More is refused by `parse_args`, never cut, so no name goes unanswered (BR-0006).
pub const MAX_NAMES: usize = 50;

/// Most pages one page of the result holds. A larger `limit` is clamped to it, and the cursor reaches the pages past
/// it.
pub const MAX_FIND_PAGES_LIMIT: u64 = 1000;

/// The code of the warning for a result cut at `limit`.
const COUNT_CUT: &str = "pages_truncated";

/// What the list holds, as a warning says it.
const WHAT: &str = "pages";

/// What a warning says to see fewer pages: the three filters that narrow the list.
const NARROWER: &str = "Narrow text, names or property to see the rest.";

/// Whether a page read with a cursor repeats the `names` answers. They describe the request, which page 1 already
/// said and the token carries, so the pages after it leave them out (the maintainer's recommendation on #551, in the
/// brief; one switch to flip if it is not wanted).
const NAMES_ON_CONTINUATION: bool = false;

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Find non-journal pages as { name, aliases? }. Filters AND: text (substring of name or alias); names (up to 50, exact name or alias; each answered with its page, or null plus closest names); property + value (page property). Pages of limit (max 1000); hasMore: send only cursor=nextCursor.\n\n\
**Can't find:** journals (logseq_explore_timeline) or block text (logseq_find_blocks). Warning pages_unavailable: list unknown, not empty.";

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
    /// Page size: most pages per call (default: 200, max: 1000)
    #[serde(default = "default_limit")]
    pub limit: u64,
    /// json (default), or toon text: a list's keys once, not on every row
    pub format: Option<ListFormat>,
    // No doc comment: the shared description is the type's (`CursorSchema`), and a doc comment would replace it
    #[schemars(with = "Option<CursorSchema>")]
    pub cursor: Option<String>,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Find Pages")
        .with_annotations(read_only_annotations("Find Pages"))
}

/// What a cursor says about where to read on, once decoded and checked against this tool: the page the last page
/// ended with and the index of the next one. The arguments come back as [`Args`], parsed again like any other
/// (ADR-0038: nothing in a token is trusted).
struct Resume {
    cursor: Cursor,
    /// The index of the first page of the next page, in the list as the first call read it
    at: usize,
    /// The name (lowercase, the key the list is sorted by) of the last page the page before sent
    anchor: String,
    /// The token as sent, for a refusal
    token: String,
}

impl Resume {
    fn read(token: &str) -> Result<(Args, Resume), InvalidParameter> {
        let cursor = decode(token, NAME)?;
        let Position::Index { at } = cursor.position else {
            return Err(invalid(token, NAME, "this is not a cursor of this tool: its position is not one page"));
        };
        let Anchor::Text(anchor) = cursor.anchor.clone() else {
            return Err(invalid(token, NAME, "this is not a cursor of this tool: its last page is not a name"));
        };
        // The arguments the token holds are read as any call's are. A cursor holds none of its own
        let args = parse_args::<Args>(Some(&cursor.args)).ok().filter(|args| args.cursor.is_none());
        let args = args.ok_or_else(|| invalid(token, NAME, "its arguments are not ones this tool takes"))?;
        Ok((args, Resume { cursor, at, anchor, token: token.to_owned() }))
    }

    /// A token whose arguments no longer make a search: the same refusal as one that doesn't parse.
    fn refuse(&self, reason: &str) -> InvalidParameter {
        invalid(&self.token, NAME, reason)
    }
}

/// The arguments of a search as a cursor carries them: what the call asked, with `limit` as it is read (a larger one is
/// clamped, so the same search with 2000 and with 1000 has one token). Read again by [`Args`].
fn stored_arguments(args: &Args) -> Map<String, Value> {
    let mut stored = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            stored.insert(key.to_owned(), value);
        }
    };
    put("text", args.text.as_ref().map(|text| json!(text)));
    put("names", args.names.as_ref().map(|names| json!(names)));
    put("property", args.property.as_ref().map(|property| json!(property)));
    put(
        "value",
        args.value.as_ref().map(|value| match value {
            Scalar::Text(text) => json!(text),
            Scalar::Number(number) => json!(number),
            Scalar::Flag(flag) => json!(flag),
        }),
    );
    put("limit", Some(json!(args.limit.min(MAX_FIND_PAGES_LIMIT))));
    put(
        "format",
        args.format.map(|format| match format {
            ListFormat::Json => json!("json"),
            ListFormat::Toon => json!("toon"),
        }),
    );
    stored
}

/// A call: arguments read, the list read (from the snapshot a cursor names, or from LogSeq), then one page of it with
/// its tip. The character budget (#507, #485) is applied here, to the text the call sends.
///
/// A call with a `cursor` takes no other argument: they are in the token. The page it reads starts where the token's
/// position says, if the last page the page before sent is just before it, and otherwise right after that page in name
/// order, with a `cursor_stale` warning (BR-0006).
pub async fn call(client: &LogseqClient, tips_enabled: bool, snapshots: &Snapshots, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let asked = parse_args::<Args>(arguments.as_ref())?;
    let now = Instant::now();
    let (args, resume) = match asked.cursor.clone() {
        Some(token) => {
            refuse_with_cursor::<Args>(arguments.as_ref())?;
            let (args, resume) = Resume::read(&token)?;
            (args, Some(resume))
        }
        None => (asked, None),
    };
    // refused before any call
    let property = property_filter(&args).map_err(|error| resume.as_ref().map_or(error, |resume| resume.refuse("its arguments are not a search this tool makes")))?;
    // The arguments the list was built from: the cursor's own, byte for byte, so the snapshot it names is the one asked for
    let stored = match &resume {
        Some(resume) => resume.cursor.args.clone(),
        None => stored_arguments(&args),
    };
    let served = serve(snapshots, resume.as_ref().map(|resume| &resume.cursor.snapshot), &stored, now, || listing_of(client, &args, property.as_ref())).await?;
    let listing = &*served.list;
    let total = listing.pages.len();
    let (start, stale) = match &resume {
        None => (0, None),
        Some(resume) => {
            // The list is in name order, so the pages after the anchor are the first ones with a name after it: found by
            // key, which holds when the list gained a page before the position, or lost the anchor itself
            let resumed = resume_at(
                total,
                resume.at,
                |at| listing.keys[at] == resume.anchor,
                || Some(listing.keys.partition_point(|key| order::by_name(key, &resume.anchor) != Ordering::Greater)),
            );
            (resumed.start, resumed.stale)
        }
    };
    let view = View {
        listing,
        start,
        page_size: args.limit.min(MAX_FIND_PAGES_LIMIT) as usize,
        stale,
        first_page: resume.is_none(),
        narrowed: narrowed(&args),
        tips_enabled,
        format: args.format,
        token: Some(Token { args: stored.clone(), key: served.key }),
    };
    let page = page_of(total, start, view.page_size, |kept| view.size(kept));
    // A list that fits one page needs no snapshot, and a hit is kept already
    if page.next().is_some() {
        served.keep(snapshots, &stored, listing.weight(), now);
    }
    let texts = view.texts(page.kept, page.cut)?;
    Ok(success_result(texts.into_iter().map(ContentBlock::text).collect()))
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

/// One page of the result. `hasMore`, `nextCursor` and `warnings` are present only when a warning applies: LogSeq
/// returned no page list (`null`), the list was cut, or it moved between two pages. A result that holds every matching
/// page from where it starts, including a genuinely empty graph, carries none. `names` is present only when `names`
/// was asked for, LogSeq returned a page list and this is the first page: no list is no answer to a name (BR-0011), so
/// none is given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FindPagesResult {
    pub names: Option<Vec<NameAnswer>>,
    pub pages: Vec<ListedPage>,
    /// Every matching canonical page, before the window. An alias is not a page of its own
    pub total: usize,
    pub warnings: Vec<ResultWarning>,
    /// The cursor that reads the next page: there exactly when `hasMore` is true (ADR-0038)
    pub next_cursor: Option<String>,
}

/// The completeness keys that come with a warning.
#[derive(Serialize)]
struct Completeness<'a> {
    #[serde(rename = "hasMore")]
    has_more: bool,
    #[serde(rename = "nextCursor", skip_serializing_if = "Option::is_none")]
    next_cursor: Option<&'a str>,
    warnings: &'a [ResultWarning],
}

/// A result as written, in BR-0013's order: how each name was read (`names`, the server's reading of the request),
/// then how many pages there were (`total`), then `hasMore`, `nextCursor` and `warnings` when a warning applies, then
/// the `pages`.
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
        let applies = !self.warnings.is_empty() || self.next_cursor.is_some();
        result_value(&FindPagesOutput {
            names: self.names.as_deref(),
            total: self.total,
            completeness: applies.then(|| Completeness { has_more: self.next_cursor.is_some(), next_cursor: self.next_cursor.as_deref(), warnings: &self.warnings }),
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

/// `property` and `value` go together ([`crate::property::property_filter`]).
fn property_filter(args: &Args) -> Result<Option<PropertyFilter>, InvalidParameter> {
    crate::property::property_filter(args.property.as_deref(), args.value.as_ref())
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

/// Non-journal pages in name order, at most `limit` of them (#61). Each page carries its aliases, which use no
/// `limit` slots (#171). `text` matches the page's name or any alias, and returns the page with all its aliases.
/// `names` keeps the pages one of the names finds, and `property` with `value` the pages that have the property; all
/// three AND together. `total` counts every matching page, whatever `limit` is. When pages remain after the ones
/// returned, a `pages_truncated` warning says so and offers the raise of `limit` that is the one way on without a
/// cursor: the library function reads the first page only and keeps no snapshot, so it carries no `nextCursor`.
///
/// `names` answers each name against every non-journal page, not only the pages the other filters keep, so a name
/// that finds a page the other filters drop is still a name that has a page.
///
/// This is the first page before the character budget (#507), which only [`call`] applies.
pub async fn find_pages(client: &LogseqClient, args: &Args) -> Result<FindPagesResult, ToolError> {
    let property = property_filter(args)?;
    let listing = listing_of(client, args, property.as_ref()).await?;
    let view = View {
        listing: &listing,
        start: 0,
        page_size: args.limit.min(MAX_FIND_PAGES_LIMIT) as usize,
        stale: None,
        first_page: true,
        narrowed: narrowed(args),
        tips_enabled: false,
        format: None,
        token: None,
    };
    let shown = view.page_size.min(listing.pages.len());
    Ok(view.result(shown, view.cut_at(shown)))
}

/// What a search read: every matching page in name order, and how the names were answered. This is the list a cursor
/// pages, and what a snapshot keeps.
struct Listing {
    /// The answers to `names`; `None` without `names`, and when there is no list to answer from
    names: Option<Vec<NameAnswer>>,
    /// The warning of a page list LogSeq did not answer (BR-0011): the list is empty, and no name is answered
    unavailable: Option<ResultWarning>,
    /// Every matching page, in name order
    pages: Vec<ListedPage>,
    /// The key each of `pages` is sorted by (its lowercase name), which a cursor names its last page by
    keys: Vec<String>,
}

impl Listing {
    /// What the snapshot weighs for the cache's bounds: the length of the JSON of the list, scaled to the memory
    /// it takes ([`resident_weight`]).
    fn weight(&self) -> usize {
        let length = |text: serde_json::Result<String>| text.map_or(0, |text| text.len());
        resident_weight(length(serde_json::to_string(&self.pages)) + self.names.as_ref().map_or(0, |names| length(serde_json::to_string(names))))
    }
}

/// What a cursor is made from: the arguments of the call and the snapshot its list was kept as.
struct Token {
    args: Map<String, Value>,
    key: SnapshotKey,
}

/// One page of the list, and everything its warnings, cursor and tip are made from.
struct View<'a> {
    listing: &'a Listing,
    /// The index of the first page of this page in the list
    start: usize,
    /// The most pages a page holds: `limit`, clamped
    page_size: usize,
    stale: Option<Stale>,
    /// Whether this is the first page of a list, which says what it carries of the request (the `names`, the raise)
    first_page: bool,
    narrowed: bool,
    tips_enabled: bool,
    format: Option<ListFormat>,
    /// What the next page's cursor carries. None for the library function, which has no snapshots to name
    token: Option<Token>,
}

impl View<'_> {
    /// Matching pages in all.
    fn total(&self) -> usize {
        self.listing.pages.len()
    }

    /// How the page ends when it holds the first `kept` pages it could: not at all when it reaches the last page of the
    /// list, by the page size when it holds all it could, by the budget otherwise.
    fn cut_at(&self, kept: usize) -> Option<Cut> {
        if self.start + kept >= self.total() {
            None
        } else if kept == self.page_size.min(self.total() - self.start) {
            Some(Cut::Count)
        } else {
            Some(Cut::Size { oversize: false })
        }
    }

    /// Whether the page, held to `kept` pages and ending as `cut` says, has a cursor to read on with. A page of no
    /// page has none: a cursor that does not move reads nothing on.
    fn has_next(&self, kept: usize, cut: Option<Cut>) -> bool {
        cut.is_some() && kept > 0 && self.token.is_some()
    }

    /// The cursor that starts at the page after the first `kept`, which the last of them names.
    fn next_cursor(&self, kept: usize, cut: Option<Cut>) -> Option<String> {
        let token = self.token.as_ref().filter(|_| self.has_next(kept, cut))?;
        let anchor = Anchor::Text(self.listing.keys[self.start + kept - 1].clone());
        Some(encode(&Cursor::new(NAME, token.args.clone(), Position::Index { at: self.start + kept }, anchor, token.key)))
    }

    /// What a reader can do about a result cut for its size. No parameter raises the budget, and the cursor reads on
    /// (the warning's `howToFetchAll` names it), but a narrower filter makes less to read.
    fn size_advice(&self) -> String {
        format!("The last pages in name order are left out. {NARROWER} No parameter raises the size limit.")
    }

    /// A raise of `limit` to offer beside the cursor, on the first page only (a cursor call can't change it). It is
    /// always an honest offer, since a result that is too large for the budget is cut again and carries a cursor of its own.
    fn raise(&self, cut: Cut) -> Option<String> {
        let more = self.total().min(MAX_FIND_PAGES_LIMIT as usize);
        (cut == Cut::Count && self.first_page && more > self.page_size)
            .then(|| format!("set limit to {more} for a larger page (a result holds at most {BUDGET_CHARS} characters)."))
    }

    /// The warnings of the page holding the first `kept` pages: a list that moved, then the cut.
    fn warnings(&self, kept: usize, cut: Option<Cut>) -> Vec<ResultWarning> {
        let mut warnings: Vec<ResultWarning> = self.stale.map(|stale| stale_warning(stale, WHAT)).into_iter().collect();
        if let Some(cut) = cut {
            let advice = match cut {
                Cut::Size { .. } => self.size_advice(),
                Cut::Count if self.page_size == 0 => "limit is 0, so no page is returned.".to_owned(),
                Cut::Count => String::new(),
            };
            warnings.push(paged_warning(PagedCut {
                count_code: COUNT_CUT,
                cut,
                what: WHAT,
                start: self.start,
                kept,
                total: self.total(),
                advice: &advice,
                raise: self.raise(cut),
                has_next: self.has_next(kept, Some(cut)),
            }));
        }
        warnings
    }

    /// The result holding the first `kept` pages of this page, ending as `cut` says.
    fn result(&self, kept: usize, cut: Option<Cut>) -> FindPagesResult {
        if let Some(warning) = &self.listing.unavailable {
            return FindPagesResult { names: None, pages: Vec::new(), total: 0, warnings: vec![warning.clone()], next_cursor: None };
        }
        FindPagesResult {
            names: if self.first_page || NAMES_ON_CONTINUATION { self.listing.names.clone() } else { None },
            pages: self.listing.pages[self.start..self.start + kept].to_vec(),
            total: self.total(),
            warnings: self.warnings(kept, cut),
            next_cursor: self.next_cursor(kept, cut),
        }
    }

    /// What the call sends for the first `kept` pages: the list, then its tip. Each is written in `format`.
    fn texts(&self, kept: usize, cut: Option<Cut>) -> Result<Vec<String>, ToolError> {
        let result = self.result(kept, cut);
        let mut texts = vec![ListFormat::text(self.format, &result.to_value())?];
        if self.tips_enabled {
            let first = result.pages.first().map(|page| page.name.as_str());
            if let Some(tips) = tips_value(&find_pages_tips(self.narrowed, first)) {
                texts.push(ListFormat::text(self.format, &tips)?);
            }
        }
        Ok(texts)
    }

    /// The length of the result holding the first `kept` pages, as `call` would send it (what the budget measures).
    fn size(&self, kept: usize) -> usize {
        self.texts(kept, self.cut_at(kept)).map_or(0, |texts| texts.iter().map(|text| size(text)).sum())
    }
}

/// The list of a first call, or of a cursor whose snapshot is gone: the one `getAllPages` call, then every filter
/// applied. These are the first page's calls and no more, so no call ceiling rises (ADR-0038).
async fn listing_of(client: &LogseqClient, args: &Args, property: Option<&PropertyFilter>) -> Result<Listing, ToolError> {
    let answer = client.call_api(wire::METHOD, &[]).await?;
    // `null` is not `[]` (BR-0011). An empty array is a graph with no pages. `null` may mean no graph
    // is open or LogSeq is re-indexing, so the empty list is reported with a warning instead of
    // passing for "none". `hasMore` stays false: no parameter fetches a page list that does not
    // exist, so the warning has no `howToFetchAll` (the retry advice is in the message). A name has no
    // answer either: "no page" would say the page is missing.
    let Some(all_pages) = wire::pages(&answer)? else {
        return Ok(Listing {
            names: None,
            unavailable: Some(ResultWarning::new(
                "pages_unavailable",
                "LogSeq returned no page list (possibly no graph open or a re-index in progress), \
                 so the empty list may not mean the graph is empty. \
                 Retry in a moment, or call logseq_get_graph to check which graph is open."
                    .to_owned(),
            )),
            pages: Vec::new(),
            keys: Vec::new(),
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
                .is_none_or(|filter| entry.page.properties.as_ref().is_some_and(|properties| has_property(properties, &filter.key, &filter.value)))
    });

    let keys = entries.iter().map(|entry| entry.page.name.clone()).collect();
    let pages = entries
        .iter()
        .map(|entry| ListedPage {
            name: entry.page.display_name.clone(),
            aliases: entry.aliases.iter().map(|alias| alias.display_name.clone()).collect(),
        })
        .collect();
    Ok(Listing { names, unavailable: None, pages, keys })
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
        let filter = PropertyFilter { key: crate::property::PropertyKey::parse("status", "property").unwrap(), value: "active".to_owned() };
        let has = |page: &ListedEntity| page.properties.as_ref().is_some_and(|properties| has_property(properties, &filter.key, &filter.value));
        assert!(has(&atlas));
        assert!(!has(&stub), "a page with no properties has none");
    }

    // ---- a page of the list

    use crate::budget::BUDGET_CHARS;
    use crate::paging::Page;

    const KEY: SnapshotKey = SnapshotKey { started: 1_760_000_000_000, n: 3 };
    const NEXT_PAGE: &str = "Pass nextCursor as cursor, with no other argument, to read the next page.";

    /// The key a page named `name` is sorted by.
    fn key_of(name: &str) -> String {
        name.to_lowercase()
    }

    /// A list of pages with these names, in the order given, with no aliases.
    fn listing_of_names(names: impl IntoIterator<Item = String>) -> Listing {
        let names: Vec<String> = names.into_iter().collect();
        Listing { names: None, unavailable: None, keys: names.iter().map(|name| key_of(name)).collect(), pages: names.into_iter().map(|name| ListedPage { name, aliases: Vec::new() }).collect() }
    }

    /// A list of `count` pages whose names are `length` characters long, in name order.
    fn list(count: usize, length: usize) -> Listing {
        listing_of_names((0..count).map(|n| format!("{n:05}{}", "p".repeat(length))))
    }

    /// The page of `listing` that starts at `start`, with at most `limit` pages, as `call` would read it.
    fn view_at(listing: &Listing, start: usize, limit: usize) -> View<'_> {
        View {
            listing,
            start,
            page_size: limit.min(MAX_FIND_PAGES_LIMIT as usize),
            stale: None,
            first_page: start == 0,
            narrowed: false,
            tips_enabled: true,
            format: None,
            token: Some(Token { args: json!({"limit": limit}).as_object().cloned().unwrap(), key: KEY }),
        }
    }

    /// The page the page size and the budget make of what `view` reads, and its result.
    fn paged(view: &View<'_>) -> (Page, FindPagesResult) {
        let page = page_of(view.total(), view.start, view.page_size, |kept| view.size(kept));
        (page, view.result(page.kept, page.cut))
    }

    /// The length of what the call sends for that page.
    fn sent(view: &View<'_>, page: &Page) -> usize {
        view.texts(page.kept, page.cut).unwrap().iter().map(|text| size(text)).sum()
    }

    #[test]
    fn a_list_under_the_page_size_and_the_budget_is_one_page_with_no_warning_and_no_cursor() {
        let small = list(150, 20);
        let (page, result) = paged(&view_at(&small, 0, 200));
        assert_eq!((page.kept, page.cut), (150, None));
        assert_eq!((result.warnings.clone(), result.next_cursor.clone(), result.total), (vec![], None, 150));
        assert_eq!(keys(&result.to_value()), ["total", "pages"]);
        let empty = list(0, 20);
        let (page, result) = paged(&view_at(&empty, 0, 200));
        assert_eq!((page.kept, page.cut, result.warnings.len(), result.next_cursor), (0, None, 0, None));
    }

    #[test]
    fn a_list_exactly_at_the_limit_has_no_cursor_and_one_page_more_has_one() {
        for (count, cursor) in [(200, false), (201, true)] {
            let list = list(count, 20);
            let (page, result) = paged(&view_at(&list, 0, 200));
            assert_eq!((page.kept, result.next_cursor.is_some(), result.warnings.len()), (200, cursor, usize::from(cursor)), "{count} pages");
        }
    }

    #[test]
    fn a_count_cut_leads_with_the_cursor_and_offers_the_raise_beside_it_on_the_first_page() {
        let long = list(300, 20);
        let (page, result) = paged(&view_at(&long, 0, 200));
        assert_eq!((page.kept, page.cut), (200, Some(Cut::Count)));
        let warning = &result.warnings[0];
        assert_eq!((warning.code.as_str(), warning.message.as_str()), ("pages_truncated", "Showing 1-200 of 300 pages."));
        assert_eq!(
            warning.how_to_fetch_all.as_deref(),
            Some(format!("{NEXT_PAGE} Or set limit to 300 for a larger page (a result holds at most {BUDGET_CHARS} characters).").as_str())
        );
        // the cursor names the next page and the last one sent, by the key the list is sorted by
        let cursor = decode(result.next_cursor.as_deref().unwrap(), NAME).unwrap();
        assert_eq!(cursor, Cursor::new(NAME, json!({"limit": 200}).as_object().cloned().unwrap(), Position::Index { at: 200 }, Anchor::Text(long.keys[199].clone()), KEY));
        assert_eq!(result.to_value()["hasMore"], true);
        // `hasMore` and `nextCursor` come right after the total, before the warnings and the pages (BR-0013)
        assert_eq!(keys(&result.to_value()), ["total", "hasMore", "nextCursor", "warnings", "pages"]);
    }

    #[test]
    fn the_pages_after_the_first_offer_no_raise_since_a_cursor_call_cannot_change_the_limit() {
        let long = list(300, 20);
        let (_, second) = paged(&view_at(&long, 100, 100));
        let warning = &second.warnings[0];
        assert_eq!(warning.message, "Showing 101-200 of 300 pages.");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some(NEXT_PAGE));
    }

    #[test]
    fn a_size_cut_keeps_the_most_pages_that_fit_and_says_the_budget_not_a_raise() {
        let big = list(1500, 60);
        let view = view_at(&big, 0, 1000);
        let (page, result) = paged(&view);
        let kept = page.kept;
        assert!(kept > 100 && kept < 1000, "{kept}");
        assert_eq!(page.cut, Some(Cut::Size { oversize: false }));
        assert!(sent(&view, &page) <= BUDGET_CHARS, "{}", sent(&view, &page));
        // one more page would not fit, and the pages kept are the first in name order
        assert!(view.size(kept + 1) > BUDGET_CHARS);
        assert_eq!(result.pages[..], big.pages[..kept]);
        let warning = &result.warnings[0];
        assert_eq!(warning.code, "result_size_truncated");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some(NEXT_PAGE), "a larger limit would be cut the same way, so none is offered");
        assert!(warning.message.starts_with(&format!("Showing 1-{kept} of 1500 pages: the result was cut to fit 30000 characters")), "{}", warning.message);
        assert!(warning.message.contains("The last pages in name order are left out. Narrow text, names or property to see the rest."), "{}", warning.message);
        assert_eq!(result.total, 1500);
    }

    #[test]
    fn a_page_in_the_middle_counts_from_where_it_starts_and_reads_on_after_the_pages_it_kept() {
        let big = list(2000, 60);
        let view = view_at(&big, 400, 1000);
        let (page, result) = paged(&view);
        let warning = &result.warnings[0];
        assert!(warning.message.starts_with(&format!("Showing 401-{} of 2000 pages:", 400 + page.kept)), "{}", warning.message);
        let cursor = decode(result.next_cursor.as_deref().unwrap(), NAME).unwrap();
        assert_eq!((cursor.position, cursor.anchor), (Position::Index { at: 400 + page.kept }, Anchor::Text(big.keys[400 + page.kept - 1].clone())));
        assert_eq!(result.pages[0], big.pages[400]);
    }

    #[test]
    fn reading_page_after_page_covers_a_list_several_times_the_budget_once_and_each_page_fits() {
        let big = list(1500, 60);
        let (mut start, mut seen, mut pages) = (0, Vec::new(), 0);
        loop {
            let view = view_at(&big, start, 1000);
            let (page, result) = paged(&view);
            assert!(sent(&view, &page) <= BUDGET_CHARS, "page {pages}");
            seen.extend(result.pages.iter().map(|page| page.name.clone()));
            pages += 1;
            match page.next() {
                Some(next) => start = next,
                None => break,
            }
        }
        assert_eq!(seen, big.pages.iter().map(|page| page.name.clone()).collect::<Vec<_>>());
        assert!(pages >= 3, "{pages}");
    }

    #[test]
    fn a_page_over_the_budget_is_returned_alone_and_the_cursor_moves_past_it() {
        // the first page in name order is 40,000 characters long; the two after it are small
        let giant = listing_of_names([format!("a{}", "x".repeat(40_000)), "b".to_owned(), "c".to_owned()]);
        let view = view_at(&giant, 0, 200);
        let (page, result) = paged(&view);
        assert_eq!((page.kept, page.cut), (1, Some(Cut::Size { oversize: true })));
        assert!(result.warnings[0].message.contains("Even those are over that size"), "{}", result.warnings[0].message);
        assert_eq!(page.next(), Some(1));
        let (page, result) = paged(&view_at(&giant, 1, 200));
        assert_eq!((page.kept, page.cut, result.next_cursor), (2, None, None));
    }

    #[test]
    fn a_limit_of_zero_shows_no_page_and_has_no_cursor_only_the_raise() {
        let five = list(5, 20);
        let (page, result) = paged(&view_at(&five, 0, 0));
        assert_eq!((page.kept, page.cut, result.next_cursor.clone()), (0, Some(Cut::Count), None));
        let warning = &result.warnings[0];
        assert_eq!(warning.message, "Showing 0 of 5 pages. limit is 0, so no page is returned.");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some(format!("Set limit to 5 for a larger page (a result holds at most {BUDGET_CHARS} characters).").as_str()));
        assert_eq!(result.to_value()["hasMore"], false, "nothing reads on, so hasMore is false whatever the raise offers");
    }

    #[test]
    fn the_names_are_the_frame_of_the_first_page_and_are_never_cut() {
        let mut found = list(3, 20);
        let answer = |n: usize| NameAnswer { name: format!("{n}{}", "q".repeat(1000)), page: None, candidates: Vec::new(), candidate_count: None, suggestions: vec!["s".repeat(500); 3] };
        found.names = Some((0..50).map(answer).collect());
        let (page, result) = paged(&view_at(&found, 0, 200));
        // the 50 answers are over the budget by themselves: all stay, with one page, and the warning says that even that is over
        assert_eq!(result.names.as_ref().unwrap().len(), 50);
        assert_eq!((page.kept, page.cut), (1, Some(Cut::Size { oversize: true })));
        assert!(result.warnings[0].message.contains("Even those are over that size"));
        assert!(result.next_cursor.is_some());
    }

    #[test]
    fn a_page_read_with_a_cursor_does_not_repeat_the_names_answers() {
        let mut found = list(5, 20);
        found.names = Some(vec![NameAnswer { name: "x".into(), page: None, candidates: Vec::new(), candidate_count: None, suggestions: Vec::new() }]);
        let first = view_at(&found, 0, 2).result(2, Some(Cut::Count));
        assert_eq!(first.names.as_ref().map(Vec::len), Some(1));
        let later = view_at(&found, 2, 2).result(2, Some(Cut::Count));
        assert!(later.names.is_none(), "the names describe the request, which page 1 said and the token holds");
        assert!(!later.to_value().as_object().unwrap().contains_key("names"));
        assert!(!NAMES_ON_CONTINUATION);
    }

    #[test]
    fn a_page_list_nobody_answered_is_one_warning_with_nothing_to_read_on_and_no_stale_warning() {
        let unavailable = Listing { names: None, unavailable: Some(ResultWarning::new("pages_unavailable", "m".into())), pages: Vec::new(), keys: Vec::new() };
        let mut view = view_at(&unavailable, 0, 200);
        view.stale = Some(Stale::Gone);
        let (page, result) = paged(&view);
        assert_eq!((page.kept, page.cut, result.total, result.next_cursor.clone()), (0, None, 0, None));
        assert_eq!(result.warnings.iter().map(|warning| warning.code.as_str()).collect::<Vec<_>>(), ["pages_unavailable"]);
        assert_eq!(result.to_value()["hasMore"], false);
    }

    #[test]
    fn a_list_that_moved_says_so_before_the_cut() {
        let long = list(300, 20);
        let mut view = view_at(&long, 100, 100);
        view.stale = Some(Stale::Moved);
        let (_, result) = paged(&view);
        assert_eq!(result.warnings.iter().map(|warning| warning.code.as_str()).collect::<Vec<_>>(), ["cursor_stale", "pages_truncated"]);
    }

    #[test]
    fn the_anchor_is_found_by_name_order_after_pages_came_or_went_before_it() {
        // the key the resume looks for: the first key that sorts after the anchor
        let names = ["alice", "bob", "carol", "dave", "erin"].map(str::to_owned);
        let after = |anchor: &str| names.partition_point(|key| order::by_name(key, anchor) != Ordering::Greater);
        assert_eq!(after("carol"), 3);
        assert_eq!(after("caroline"), 3, "the anchor is gone: the first page after where it was");
        assert_eq!(after("aaron"), 0);
        assert_eq!(after("zed"), 5);
    }

    #[test]
    fn toon_and_json_are_each_measured_as_they_are_sent() {
        let found = list(1000, 20);
        let json = size(&view_at(&found, 0, 1000).texts(1000, None).unwrap()[0]);
        let toon_view = View { format: Some(ListFormat::Toon), tips_enabled: false, ..view_at(&found, 0, 1000) };
        let toon = size(&toon_view.texts(1000, None).unwrap()[0]);
        assert!(toon < json, "{toon} {json}");
        // with the budget between the two sizes, JSON is cut and TOON is not
        assert!(json > BUDGET_CHARS && toon < BUDGET_CHARS, "json {json}, toon {toon}");
        assert_eq!(paged(&toon_view).0, Page { start: 0, kept: 1000, cut: None });
        assert!(paged(&view_at(&found, 0, 1000)).0.kept < 1000);
    }

    #[test]
    fn a_toon_page_carries_the_cursor_in_the_same_keys_as_json() {
        let long = list(300, 20);
        let view = View { format: Some(ListFormat::Toon), tips_enabled: false, ..view_at(&long, 0, 200) };
        let (page, result) = paged(&view);
        let text = &view.texts(page.kept, page.cut).unwrap()[0];
        assert!(text.contains("hasMore: true") && text.contains(&format!("nextCursor: {}", result.next_cursor.as_deref().unwrap())), "{text}");
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
            warnings: vec![],
            next_cursor: None,
        };
        assert_eq!(plain.to_value().to_string(), r#"{"total":2,"pages":[{"name":"Alice","aliases":["Al"]},{"name":"Bob"}]}"#);
        assert_eq!(keys(&plain.to_value()), ["total", "pages"]);
        let cut = FindPagesResult {
            names: None,
            pages: vec![],
            total: 3,
            warnings: vec![ResultWarning { code: "c".into(), message: "m".into(), how_to_fetch_all: Some("h".into()) }],
            next_cursor: Some("abc".into()),
        };
        assert_eq!(
            cut.to_value().to_string(),
            r#"{"total":3,"hasMore":true,"nextCursor":"abc","warnings":[{"code":"c","message":"m","howToFetchAll":"h"}],"pages":[]}"#
        );
        assert_eq!(keys(&cut.to_value()), ["total", "hasMore", "nextCursor", "warnings", "pages"]);
        // a warning and no cursor: hasMore is false whatever the warning offers, and there is no nextCursor
        let no_cursor = FindPagesResult { next_cursor: None, ..cut.clone() };
        assert_eq!(no_cursor.to_value()["hasMore"], false);
        assert_eq!(keys(&no_cursor.to_value()), ["total", "hasMore", "warnings", "pages"]);
        // the server's reading of the names comes first, as the echo of the request does (BR-0013)
        let named = FindPagesResult {
            names: Some(vec![NameAnswer { name: "bob".into(), page: Some("Bob".into()), candidates: vec![], candidate_count: None, suggestions: vec![] }]),
            pages: vec![ListedPage { name: "Bob".into(), aliases: vec![] }],
            total: 1,
            warnings: vec![],
            next_cursor: None,
        };
        assert_eq!(named.to_value().to_string(), r#"{"names":[{"name":"bob","page":"Bob"}],"total":1,"pages":[{"name":"Bob"}]}"#);
        assert_eq!(keys(&named.to_value()), ["names", "total", "pages"]);
        let named_and_cut = FindPagesResult { warnings: cut.warnings.clone(), next_cursor: cut.next_cursor.clone(), ..named };
        assert_eq!(keys(&named_and_cut.to_value()), ["names", "total", "hasMore", "nextCursor", "warnings", "pages"]);
    }

    // ---- the cursor: what a token holds, and what a call reads back from it

    fn token_args() -> Map<String, Value> {
        json!({"text": "atlas", "limit": 200}).as_object().cloned().unwrap()
    }

    fn cursor_with(change: impl FnOnce(&mut Cursor)) -> String {
        let mut cursor = Cursor::new(NAME, token_args(), Position::Index { at: 200 }, Anchor::Text("project atlas".into()), KEY);
        change(&mut cursor);
        encode(&cursor)
    }

    #[test]
    fn a_token_made_for_this_tool_is_read_back_as_the_arguments_it_holds() {
        let (args, resume) = Resume::read(&cursor_with(|_| {})).unwrap();
        assert_eq!((args.text.as_deref(), args.limit, args.cursor), (Some("atlas"), 200, None));
        assert_eq!((resume.at, resume.anchor.as_str(), resume.cursor.snapshot), (200, "project atlas", KEY));
    }

    #[test]
    fn a_token_this_tool_cannot_read_is_refused_by_the_cursor_and_not_by_a_parameter_it_never_sent() {
        let refused = |token: String| Resume::read(&token).err().map(|error| (error.param, error.expected));
        let (param, expected) = refused(cursor_with(|cursor| cursor.position = Position::Sections { blocks: 1, references: 0, related: 0 })).unwrap();
        assert!(param == "cursor" && expected.contains("its position is not one page"), "{expected}");
        let (_, expected) = refused(cursor_with(|cursor| cursor.anchor = Anchor::Id(7))).unwrap();
        assert!(expected.contains("its last page is not a name"), "{expected}");
        // arguments that parse as no call of this tool, and one that holds a cursor of its own
        let (_, expected) = refused(cursor_with(|cursor| cursor.args = json!({"limit": "many"}).as_object().cloned().unwrap())).unwrap();
        assert!(expected.contains("its arguments are not ones this tool takes"), "{expected}");
        let (_, expected) = refused(cursor_with(|cursor| cursor.args = json!({"text": "x", "cursor": "abc"}).as_object().cloned().unwrap())).unwrap();
        assert!(expected.contains("its arguments are not ones this tool takes"), "{expected}");
        // another tool's token, and text that is no token at all
        assert!(refused(cursor_with(|cursor| cursor.tool = "logseq_find_blocks".into())).is_some());
        assert!(Resume::read("not a cursor").is_err());
    }

    #[test]
    fn the_arguments_a_cursor_stores_read_back_as_the_search_that_made_it_with_the_limit_clamped() {
        let sent = json!({"text": "atlas", "names": ["Alice"], "property": "status", "value": 3, "limit": 5000, "format": "toon"});
        let args = parse_args::<Args>(sent.as_object()).unwrap();
        let stored = stored_arguments(&args);
        assert_eq!(Value::Object(stored.clone()), json!({"text": "atlas", "names": ["Alice"], "property": "status", "value": 3.0, "limit": 1000, "format": "toon"}));
        let back = parse_args::<Args>(Some(&stored)).unwrap();
        assert_eq!(back, Args { limit: 1000, ..args });
        // nothing that was not asked for is stored, apart from the limit that is read
        assert_eq!(Value::Object(stored_arguments(&parse_args::<Args>(None).unwrap())), json!({"limit": 200}));
    }

    #[test]
    fn a_stored_value_of_each_kind_reads_back_as_that_kind() {
        for value in [json!("active"), json!(3.0), json!(true)] {
            let args = parse_args::<Args>(json!({"property": "p", "value": value}).as_object()).unwrap();
            let back = parse_args::<Args>(Some(&stored_arguments(&args))).unwrap();
            assert_eq!(back.value, args.value);
        }
    }

    #[test]
    fn a_snapshot_weighs_the_length_of_its_json_at_the_resident_factor() {
        let one = list(1, 100);
        let json_len = serde_json::to_string(&one.pages).unwrap().len();
        assert_eq!(one.weight(), crate::snapshots::resident_weight(json_len));
        assert!(list(100, 100).weight() > list(10, 100).weight());
        let mut with_names = list(1, 100);
        with_names.names = Some(vec![NameAnswer { name: "x".into(), page: None, candidates: Vec::new(), candidate_count: None, suggestions: Vec::new() }]);
        assert!(with_names.weight() > one.weight());
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
                "limit": {"type": "integer", "minimum": 0, "default": 200, "description": "Page size: most pages per call (default: 200, max: 1000)"},
                "format": {"type": "string", "enum": ["json", "toon"], "description": "json (default), or toon text: a list's keys once, not on every row"},
                "cursor": {"type": "string", "description": crate::tool::CURSOR_DESCRIPTION},
            },
            "required": [],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
        // there is no `offset`: a cursor reads on (ADR-0038)
        assert!(schema_of::<Args>()["properties"].get("offset").is_none());
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
        assert_eq!(defaults, Args { text: None, names: None, property: None, value: None, limit: 200, format: None, cursor: None });
        assert_eq!(serde_json::from_value::<Args>(json!({})).unwrap(), defaults);
        let bad = json!({"limit": 2.5, "cursor": -1});
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
        sweep::<Args>(json!({}), "cursor", Takes::Text, false);
    }
}
