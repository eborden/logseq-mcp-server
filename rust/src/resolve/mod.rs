//! The shared page resolver (the Rust side of `src/utils/resolve-page.ts`, BR-0010): a page name
//! becomes one page, or the candidates when it is ambiguous, or "no such page" with the closest
//! names. Every tool that takes a page goes through [`require_page`].
//!
//! Not ported yet: `resolveLinkTargets` (`check_links`) and `resolveAliasSetByName` (the alias
//! group of a free-text name, for a `search_term`). The alias groups of resolved pages (#69) are
//! in [`alias`].
//!
//! The resolver's own queries (`queries.rs`) and wire types (`wire.rs`) live in this directory,
//! since only it reads them; a tool gets the page it resolved as a [`PulledPage`].

pub mod alias;
mod queries;
mod wire;

use std::collections::HashSet;

use crate::client::LogseqClient;
use crate::edn::{JournalDay, PageName, Query};
use crate::errors::{AmbiguousPage, Candidate, MAX_CANDIDATES, MatchedBy, PageNotFound, ToolError};
use crate::fuzzy;
use crate::js;
pub use self::wire::PulledPage;
use self::wire::ResolverRow;

/// How many "did you mean" names a not-found message carries.
const MAX_SUGGESTIONS: usize = 3;

/// The method `suggestPages` reads every page name with.
const GET_ALL_PAGES: &str = "logseq.Editor.getAllPages";

/// A name that resolved to exactly one page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPage {
    /// The page as pulled by Datalog
    pub page: PulledPage,
    pub matched_by: MatchedBy,
    /// The original-case name of the page
    pub original_name: String,
    /// The name to hand to follow-up calls (`lookupName`). For an exact match it is the caller's
    /// own trimmed text, otherwise the resolved page's lowercase name.
    pub lookup_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    Found(ResolvedPage),
    Ambiguous(AmbiguousPage),
    NotFound,
}

/// `isoDateToJournalDay`: `2025-01-01` as the journal day `20250101`. Anything else, including an
/// impossible date (`2025-02-30`), is `None` and is then an ordinary page name.
///
/// One difference: a year before 1000 is `None` here. A journal day is eight digits, and the
/// TypeScript code sends a seven-digit number for the years 0100 to 0999 (and `None` below
/// that, as here, since `Date.UTC` reads years 0 to 99 as 19xx).
pub fn iso_date_to_journal_day(input: &str) -> Option<JournalDay> {
    let bytes = js::trim(input).as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = bytes.get(range)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0, |n, d| n * 10 + u32::from(d - b'0')))
    };
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    JournalDay::from_ymd(digits(0..4)?, digits(5..7)?, digits(8..10)?).ok()
}

/// Which page an entity is, for de-duplication: its id, else its name.
#[derive(PartialEq, Eq, Hash)]
enum PageKey {
    Id(i64),
    Name(String),
}

// PARITY(#299): sorts by `localeCompare`, whose order depends on the host's locale (suspected TS bug; see
// `js::locale_compare`) — drop if Rust becomes the only server.
/// Pages from rows, one per entity, ordered by name so output never depends on row order.
fn distinct_pages(pages: Vec<&PulledPage>) -> Vec<&PulledPage> {
    let mut seen = HashSet::new();
    let mut out: Vec<&PulledPage> = pages
        .into_iter()
        .filter(|page| seen.insert(page.entity_id().map_or_else(|| PageKey::Name(page.lower_name()), PageKey::Id)))
        .collect();
    out.sort_by(|a, b| js::locale_compare(&a.lower_name(), &b.lower_name()));
    out
}

/// The pages that declare an alias, not the stubs LogSeq made around them. `alias:: a, b, c` links
/// all three names to each other, so in a group of three or more the stubs point at each other's
/// names as well. Only the page with a file wrote the declaration: if one or more pages have a
/// file, the stubs are not candidates. Two file-backed pages declaring the same name stay
/// ambiguous.
fn declaring_pages(pages: Vec<&PulledPage>) -> Vec<&PulledPage> {
    let written: Vec<&PulledPage> = pages.iter().copied().filter(|page| page.has_file).collect();
    if written.is_empty() { pages } else { written }
}

fn found(page: &PulledPage, matched_by: MatchedBy, lookup_name: String) -> Resolution {
    Resolution::Found(ResolvedPage { page: page.clone(), matched_by, original_name: page.display_name(), lookup_name })
}

// PARITY(#299): an ambiguous result names the page as the caller typed it (untrimmed) while its reasons name
// the trimmed one (suspected TS inconsistency) — drop if Rust becomes the only server.
fn pick(pages: &[&PulledPage], matched_by: MatchedBy, reason: String, page_name: &str) -> Resolution {
    if let [page] = pages {
        return found(page, matched_by, page.lower_name());
    }
    let candidates = pages
        .iter()
        .take(MAX_CANDIDATES)
        .map(|page| Candidate {
            name: page.lower_name(),
            original_name: page.display_name(),
            matched_by,
            reason: reason.clone(),
        })
        .collect();
    Resolution::Ambiguous(AmbiguousPage { page_name: page_name.to_owned(), candidates, total_candidates: pages.len() })
}

/// `JSON.stringify(text)`.
fn json_string(text: &str) -> String {
    js::json_stringify(&serde_json::Value::String(text.to_owned()))
}

/// Routes 1-3 of [`resolve_page`] over the rows of its first query, for one trimmed name. Each
/// row's `via` is `"name"` (or absent), `"alias"` or `"journal-date"`. `None` when no route
/// matched, which is when `resolve_page` goes on to the namespace leaf.
///
/// The `page_name` of an ambiguous result is the name as the caller typed it, which is why
/// `input` is passed apart from the trimmed `name`.
fn resolve_from_rows(input: &str, name: &str, rows: &[ResolverRow]) -> Option<Resolution> {
    // A row without a `via` is a plain page row, i.e. an exact match
    let by_route = |via: &str| -> Vec<&PulledPage> {
        rows.iter().filter(|row| row.via.as_deref().unwrap_or("name") == via).map(|row| &row.page).collect()
    };
    let exact = by_route("name").first().copied();
    let alias_sources = declaring_pages(
        distinct_pages(by_route("alias"))
            .into_iter()
            .filter(|page| exact.is_none_or(|exact| page.entity_id() != exact.entity_id()))
            .collect(),
    );
    let journals = distinct_pages(by_route("journal-date"));
    let alias_reason = || format!("declares alias {}", json_string(name));

    if let Some(exact) = exact {
        // A stub is a page nobody wrote: no file. Real pages keep the name.
        let is_stub = !exact.has_file;
        if is_stub && !alias_sources.is_empty() {
            return Some(pick(&alias_sources, MatchedBy::Alias, alias_reason(), input));
        }
        // `[[2025-01-01]]` links and `date:: 2025-01-01` values create a stub named like the date
        // when the graph's journal titles use another format. The journal for that day is the
        // page the caller means.
        let other_journals: Vec<&PulledPage> =
            journals.iter().copied().filter(|page| page.entity_id() != exact.entity_id()).collect();
        if is_stub && !other_journals.is_empty() {
            return Some(pick(&other_journals, MatchedBy::JournalDate, format!("journal page for {name}"), input));
        }
        return Some(found(exact, MatchedBy::Name, name.to_owned()));
    }
    if !alias_sources.is_empty() {
        return Some(pick(&alias_sources, MatchedBy::Alias, alias_reason(), input));
    }
    if !journals.is_empty() {
        return Some(pick(&journals, MatchedBy::JournalDate, format!("journal page for {name}"), input));
    }
    None
}

async fn run(client: &LogseqClient, query: &Query) -> Result<serde_json::Value, ToolError> {
    Ok(client.execute_datalog_query(&query.text, &query.inputs).await?)
}

/// Resolve a page name to one page, or to the candidates when it is ambiguous.
///
/// One Datalog query covers three routes; only if all three find nothing is a second query run
/// (the namespace-leaf lookup), so an exact match, an alias and an ISO date each cost one API
/// call. Order, first hit wins:
///
/// 1. **Exact name** (`:block/name`, case-insensitive). It wins even when other pages alias the
///    same name, with one exception: a *bare alias target*. `alias:: Bob` on a page makes LogSeq
///    create an empty stub page "bob" (no file, no blocks), so a stub that other pages alias is
///    not a real page and the alias sources are used instead.
/// 2. **Alias.** The page(s) whose `:block/alias` points at the name. One source resolves to it;
///    several are ambiguous.
/// 3. **ISO date** (`2025-01-01`): the journal page with that `:block/journal-day`, whatever the
///    graph's journal title format is. It also beats a file-less stub that merely has the date as
///    its name; a real page named like the date wins.
/// 4. **Namespace leaf**: `atlas` finds `projects/atlas`. One page resolves to it; several are
///    ambiguous.
///
/// Infrastructure errors (connection, timeout, auth) propagate untouched.
pub async fn resolve_page(client: &LogseqClient, input: &str) -> Result<Resolution, ToolError> {
    let name = js::trim(input);
    let journal_day = iso_date_to_journal_day(name);
    let page_name = PageName::new(name);

    let answer = run(client, &queries::resolve_page(&page_name, journal_day)).await?;
    // PARITY(#299): a `null` answer is read as "no rows", so the page is reported as not found
    // when LogSeq didn't answer (suspected TS bug, BR-0011) — fix per #301, in both servers.
    let rows = wire::resolver_rows(&answer)?.unwrap_or_default();
    if let Some(resolution) = resolve_from_rows(input, name, &rows) {
        return Ok(resolution);
    }

    // Last resort, and only for names that are not dates
    if journal_day.is_none() {
        let answer = run(client, &queries::namespace_leaf_pages(&page_name)).await?;
        // PARITY(#299): the same `null` as "no rows" for the leaf lookup (suspected TS bug, BR-0011) — fix per #301.
        let rows = wire::page_rows(&answer)?.unwrap_or_default();
        let leaves = distinct_pages(rows.iter().collect());
        if !leaves.is_empty() {
            let reason = format!("namespace page ending in {}", json_string(&format!("/{name}")));
            return Ok(pick(&leaves, MatchedBy::NamespaceLeaf, reason, input));
        }
    }
    Ok(Resolution::NotFound)
}

/// Closest page names for a missing page, best first. Best-effort: when the page list can't be
/// fetched the suggestions are just empty, but connection, timeout and auth errors propagate, and
/// so does an answer this server can't read (#202). Costs one `getAllPages` call.
pub async fn suggest_pages(client: &LogseqClient, input: &str) -> Result<Vec<String>, ToolError> {
    if iso_date_to_journal_day(input).is_some() {
        return Ok(Vec::new()); // fuzzy-matching a date finds nothing useful
    }
    let answer = match client.call_api(GET_ALL_PAGES, &[]).await {
        Ok(answer) => answer,
        Err(error) if error.is_infrastructure() => return Err(error.into()),
        Err(_) => return Ok(Vec::new()),
    };
    // A page with no original name has nothing to match against
    let names: Vec<String> = wire::page_names(&answer, GET_ALL_PAGES)?.unwrap_or_default().into_iter().flatten().collect();
    let targets: Vec<&str> = names.iter().map(String::as_str).collect();
    Ok(fuzzy::go(input, &targets, MAX_SUGGESTIONS).into_iter().map(|found| names[found.index].clone()).collect())
}

/// Resolve a name that must be a page. Returns the one page, or fails with
/// [`ToolError::AmbiguousPage`] when several pages match (nothing is picked) or
/// [`ToolError::PageNotFound`] with the closest names when none does.
pub async fn require_page(client: &LogseqClient, input: &str) -> Result<ResolvedPage, ToolError> {
    match resolve_page(client, input).await? {
        Resolution::Found(page) => Ok(page),
        Resolution::Ambiguous(ambiguous) => Err(ToolError::AmbiguousPage(ambiguous)),
        Resolution::NotFound => {
            let suggestions = suggest_pages(client, input).await?;
            Err(ToolError::PageNotFound(PageNotFound { page_name: input.to_owned(), suggestions }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn row(id: i64, name: &str, original: &str, file: bool, via: Option<&str>) -> Value {
        let mut page = json!({"id": id, "name": name, "original-name": original});
        if file {
            page["file"] = json!({"id": id + 5000});
        }
        match via {
            Some(via) => json!([page, via]),
            None => json!([page]),
        }
    }

    fn resolve(name: &str, rows: Vec<Value>) -> Option<Resolution> {
        let rows = wire::resolver_rows(&Value::Array(rows)).unwrap().unwrap();
        resolve_from_rows(name, js::trim(name), &rows)
    }

    fn found_name(resolution: Option<Resolution>) -> (String, MatchedBy) {
        match resolution {
            Some(Resolution::Found(page)) => (page.original_name, page.matched_by),
            other => panic!("expected one page, got {other:?}"),
        }
    }

    #[test]
    fn iso_dates_are_real_dates_only() {
        assert_eq!(iso_date_to_journal_day("2025-01-01").map(JournalDay::as_int), Some(20250101));
        assert_eq!(iso_date_to_journal_day("  2024-02-29\n").map(JournalDay::as_int), Some(20240229));
        for not_a_date in ["2025-02-30", "2025-13-01", "2023-02-29", "25-01-01", "2025-1-01", "2025/01/01", "2025-01-01x", "٢٠٢٥-٠١-٠١", "0050-01-01", ""] {
            assert_eq!(iso_date_to_journal_day(not_a_date), None, "{not_a_date}");
        }
    }

    #[test]
    fn a_year_before_1000_is_a_name_here_and_a_date_in_typescript() {
        // DIFFERENT FROM TYPESCRIPT, on purpose: it sends the seven-digit journal day 9991231 for
        // this, so for TypeScript it is one call and no suggestions. A journal day here is eight
        // digits, so it is a plain name, which costs the leaf query and the suggestions
        // (`get_page_outline_calls.rs` counts them). The harness can't express an accepted
        // difference without weakening its comparison, so there is no parity case.
        assert_eq!(iso_date_to_journal_day("0999-12-31"), None);
        assert_eq!(iso_date_to_journal_day("0100-01-01"), None);
        assert_eq!(iso_date_to_journal_day("1000-01-01").map(JournalDay::as_int), Some(10000101));
    }

    #[test]
    fn an_exact_name_wins_over_an_alias_of_the_same_name() {
        let rows = vec![row(10, "atlas", "Atlas", true, Some("name")), row(11, "project atlas", "Project Atlas", true, Some("alias"))];
        assert_eq!(found_name(resolve("atlas", rows)), ("Atlas".into(), MatchedBy::Name));
    }

    #[test]
    fn a_bare_alias_target_gives_way_to_the_pages_that_declare_it() {
        let rows = vec![row(20, "bob", "Bob", false, Some("name")), row(21, "robert", "Robert", true, Some("alias"))];
        assert_eq!(found_name(resolve("bob", rows)), ("Robert".into(), MatchedBy::Alias));
    }

    #[test]
    fn stubs_of_an_alias_group_are_not_candidates_when_a_page_declares_it() {
        let rows = vec![
            row(31, "stub b", "Stub B", false, Some("alias")),
            row(30, "declaring", "Declaring", true, Some("alias")),
        ];
        assert_eq!(found_name(resolve("x", rows)), ("Declaring".into(), MatchedBy::Alias));
    }

    #[test]
    fn two_declaring_pages_are_ambiguous_and_ordered_by_name() {
        let rows = vec![row(41, "alice notes", "Alice Notes", true, Some("alias")), row(40, "alice", "Alice", true, Some("alias"))];
        let Some(Resolution::Ambiguous(ambiguous)) = resolve("al", rows) else { panic!("expected ambiguous") };
        assert_eq!(ambiguous.page_name, "al");
        assert_eq!(ambiguous.total_candidates, 2);
        let names: Vec<&str> = ambiguous.candidates.iter().map(|c| c.original_name.as_str()).collect();
        assert_eq!(names, ["Alice", "Alice Notes"]);
        assert_eq!(ambiguous.candidates[0].reason, "declares alias \"al\"");
    }

    #[test]
    fn the_candidate_list_is_cut_at_ten_and_counts_them_all() {
        let rows = (0..12).map(|i| row(100 + i, &format!("page {i:02}"), &format!("Page {i:02}"), true, Some("alias"))).collect();
        let Some(Resolution::Ambiguous(ambiguous)) = resolve("p", rows) else { panic!("expected ambiguous") };
        assert_eq!((ambiguous.candidates.len(), ambiguous.total_candidates), (10, 12));
        assert!(ambiguous.truncation_note().is_some());
    }

    #[test]
    fn a_journal_beats_a_stub_named_like_the_date_and_loses_to_a_real_page() {
        let stub = row(50, "2025-01-01", "2025-01-01", false, Some("name"));
        let journal = row(51, "jan 1st, 2025", "Jan 1st, 2025", true, Some("journal-date"));
        assert_eq!(found_name(resolve("2025-01-01", vec![stub.clone(), journal.clone()])), ("Jan 1st, 2025".into(), MatchedBy::JournalDate));
        let real = row(50, "2025-01-01", "2025-01-01", true, Some("name"));
        assert_eq!(found_name(resolve("2025-01-01", vec![real, journal])), ("2025-01-01".into(), MatchedBy::Name));
    }

    #[test]
    fn the_exact_page_is_not_its_own_alias_source() {
        // the same page found by name and by alias is still one page
        let rows = vec![row(60, "self", "Self", true, Some("name")), row(60, "self", "Self", true, Some("alias"))];
        assert_eq!(found_name(resolve("self", rows)), ("Self".into(), MatchedBy::Name));
    }

    #[test]
    fn no_route_means_the_leaf_lookup_is_next() {
        assert_eq!(resolve("nothing", vec![]), None);
    }

    #[test]
    fn the_ambiguous_page_name_is_the_name_as_typed() {
        let rows = vec![row(41, "alice notes", "Alice Notes", true, Some("alias")), row(40, "alice", "Alice", true, Some("alias"))];
        let rows = wire::resolver_rows(&Value::Array(rows)).unwrap().unwrap();
        let Some(Resolution::Ambiguous(ambiguous)) = resolve_from_rows("  AL ", "AL", &rows) else { panic!("expected ambiguous") };
        assert_eq!(ambiguous.page_name, "  AL ");
        assert_eq!(ambiguous.candidates[0].reason, "declares alias \"AL\"");
    }
}
