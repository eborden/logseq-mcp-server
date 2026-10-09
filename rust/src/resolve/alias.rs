//! Alias groups (#69; the Rust side of `src/utils/alias-set.ts`). `alias::` makes two names one
//! concept, but a reference written under either name points at its own page entity, so a tool
//! that follows links to one page id misses the rest. A tool that follows links to a page asks
//! for the page's [`AliasSet`] first and uses every id in it.
//!
//! LogSeq stores each alias in both directions (verified by `scripts/probe-constraints.ts`, which
//! reports any one-directional link), so a page whose pulled entity has no `alias` key has no
//! aliases and needs no query. A page that has some costs one Datalog query, for any number of
//! pages, two hops, bound with `ground_ids`.
//!
//! [`resolve_alias_set_by_name`] is the group of a free-text name (a `search_term`), where "not a
//! page" is an ordinary answer.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use super::queries;
use super::RETRY_ADVICE;
pub use super::queries::linked_references_of_pages;
use super::wire::{self, PulledPage};
use crate::client::LogseqClient;
use crate::edn::{PageId, PageName};
use crate::errors::ToolError;
use crate::js;
use crate::meta::ResultWarning;

/// Most pages one alias group may hold here. Groups are written by hand (`alias:: a, b, c`), so a
/// handful is normal; the cap only bounds the id lists embedded in follow-up queries, and a group
/// that exceeds it says so.
pub const MAX_ALIAS_SET_SIZE: usize = 50;

/// One page of an alias group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasMember {
    pub id: i64,
    /// Lowercased `:block/name`
    pub name: String,
    pub original_name: String,
}

impl AliasMember {
    /// `memberOf`: a page with an id. One without can't be queried and is not a member.
    fn of(page: &PulledPage) -> Option<AliasMember> {
        page.entity_id().map(|id| AliasMember { id, name: page.lower_name(), original_name: page.display_name() })
    }
}

/// Every page that names the same thing: the page asked about plus the pages it aliases and the
/// pages aliasing it, in either direction. `members[0]` is always the page asked about (when it
/// has an id at all); the others are ordered by name so output never depends on row order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasSet {
    pub members: Vec<AliasMember>,
    /// The group was cut at [`MAX_ALIAS_SET_SIZE`]
    pub truncated: bool,
    /// LogSeq answered the alias query with `null` (BR-0011): the group is unknown, not empty, and
    /// the set holds only what the caller already had. The name the lookup was about, for the warning.
    pub unavailable: Option<String>,
}

impl AliasSet {
    /// `singleAliasSet`: a set holding only `page`. No query, nothing to union.
    pub fn single(page: &PulledPage) -> AliasSet {
        AliasSet { members: AliasMember::of(page).into_iter().collect(), truncated: false, unavailable: None }
    }

    /// `hasAliases`: the set holds more than the page asked about.
    pub fn has_aliases(&self) -> bool {
        self.members.len() > 1
    }

    /// `aliasIds`: page ids of the set, as ids a query can embed.
    pub fn ids(&self) -> Result<Vec<PageId>, ToolError> {
        self.members.iter().map(|member| PageId::new(member.id).map_err(ToolError::from)).collect()
    }

    // PARITY(#299): orders names with `localeCompare('en')`, as `js::locale_compare` orders them (ICU root collation), then by
    // code unit — drop if Rust becomes the only server.
    /// `resolvedAliases`: the original-case names the tool covered, sorted so asking by either
    /// name of the group reports the same list. `None` when the page has no aliases, so default
    /// output is unchanged. Names `en` collation ties fall back to code-unit order, so the order
    /// never follows arrival order.
    pub fn resolved_aliases(&self) -> Option<Vec<String>> {
        if !self.has_aliases() {
            return None;
        }
        let mut names: Vec<String> = self.members.iter().map(|member| member.original_name.clone()).collect();
        names.sort_by(|a, b| js::locale_compare(a, b).then_with(|| compare_code_units(a, b)));
        Some(names)
    }
}

// PARITY(#299): orders by UTF-16 code unit, as JavaScript's `<` does, which differs from code point order for
// a character above U+FFFF against one in U+E000..U+FFFF — drop if Rust becomes the only server.
/// `a < b ? -1 : a > b ? 1 : 0`: JavaScript compares strings by UTF-16 code unit.
pub fn compare_code_units(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `aliasSetWarnings`: the `alias_set_truncated` warning for each set that was cut, and the
/// `alias_lookup_unavailable` warning for each whose lookup LogSeq did not answer (#318). No
/// `howToFetchAll` on the second: no parameter fetches what LogSeq did not answer.
pub fn alias_set_warnings(sets: &[&AliasSet]) -> Vec<ResultWarning> {
    sets.iter().filter_map(|set| unavailable_warning(set).or_else(|| truncated_warning(set))).collect()
}

fn unavailable_warning(set: &AliasSet) -> Option<ResultWarning> {
    let name = set.unavailable.as_ref()?;
    Some(ResultWarning::new(
        "alias_lookup_unavailable",
        format!(
            "LogSeq returned no answer when looking up the aliases of \"{name}\" (possibly no graph open or a \
             re-index in progress), so references written under its other names may be missing. \
             This does not mean it has no aliases. {RETRY_ADVICE}"
        ),
    ))
}

fn truncated_warning(set: &AliasSet) -> Option<ResultWarning> {
    set.truncated.then(|| {
        ResultWarning::new(
            "alias_set_truncated",
            format!(
                "The alias group of \"{}\" has more than {MAX_ALIAS_SET_SIZE} pages; \
                 only the page itself and {} aliases were used, so references written under \
                 the other names are missing. The maximum cannot be raised.",
                set.members.first().map_or("", |member| member.original_name.as_str()),
                MAX_ALIAS_SET_SIZE - 1
            ),
        )
    })
}

// PARITY(#299): sorts members with `localeCompare`, whose order depends on the host's locale (suspected TS
// bug; see `js::locale_compare`) — drop if Rust becomes the only server.
/// `buildSet`: fold query members into a set, start page first, the rest by name, capped.
fn build_set(start: AliasMember, found: Vec<AliasMember>) -> AliasSet {
    let mut seen = HashSet::new();
    let mut others: Vec<AliasMember> = Vec::new();
    for member in found {
        if member.id != start.id {
            match seen.contains(&member.id) {
                // a later row for the same page replaces the earlier one, keeping its place
                true => {
                    let at = others.iter().position(|other| other.id == member.id).expect("it was seen");
                    others[at] = member;
                }
                false => {
                    seen.insert(member.id);
                    others.push(member);
                }
            }
        }
    }
    others.sort_by(|a, b| js::locale_compare(&a.name, &b.name).then(a.id.cmp(&b.id)));
    let room = MAX_ALIAS_SET_SIZE - 1;
    let truncated = others.len() > room;
    others.truncate(room);
    let mut members = vec![start];
    members.extend(others);
    AliasSet { members, truncated, unavailable: None }
}

/// The alias sets of several resolved pages, in one Datalog query for all of them, and none when
/// no page has an alias link. Pass the pages exactly as the resolver returned them.
///
/// Infrastructure errors (connection, timeout, auth) propagate: an alias lookup that failed must
/// not look like "no aliases".
pub async fn resolve_alias_sets(client: &LogseqClient, pages: &[&PulledPage]) -> Result<Vec<AliasSet>, ToolError> {
    let starts: Vec<AliasSet> = pages.iter().map(|page| AliasSet::single(page)).collect();
    let mut query_ids: Vec<i64> = Vec::new();
    for (set, page) in starts.iter().zip(pages) {
        if let (Some(start), true) = (set.members.first(), page.has_alias_links) {
            if !query_ids.contains(&start.id) {
                query_ids.push(start.id);
            }
        }
    }
    if query_ids.is_empty() {
        return Ok(starts);
    }

    let ids: Vec<PageId> = query_ids.iter().map(|&id| PageId::new(id)).collect::<Result<_, _>>()?;
    let query = queries::alias_sets(&ids);
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    // A `null` is no answer, not "no aliases" (BR-0011): each queried page keeps its one-page set, marked unavailable
    let Some(rows) = wire::alias_set_rows(&answer)? else {
        return Ok(starts
            .into_iter()
            .map(|set| match set.members.first() {
                Some(start) if query_ids.contains(&start.id) => {
                    let name = start.original_name.clone();
                    AliasSet { unavailable: Some(name), ..set }
                }
                _ => set,
            })
            .collect());
    };

    let mut by_start: HashMap<i64, Vec<AliasMember>> = HashMap::new();
    for (start_id, page) in rows {
        if let Some(member) = AliasMember::of(&page) {
            by_start.entry(start_id).or_default().push(member);
        }
    }
    Ok(starts
        .into_iter()
        .map(|set| match set.members.first().and_then(|start| by_start.get(&start.id).map(|found| (start, found))) {
            Some((start, found)) => build_set(start.clone(), found.clone()),
            None => set,
        })
        .collect())
}

/// The alias set of one resolved page (see [`resolve_alias_sets`]).
pub async fn resolve_alias_set(client: &LogseqClient, page: &PulledPage) -> Result<AliasSet, ToolError> {
    Ok(resolve_alias_sets(client, &[page]).await?.remove(0))
}

/// `resolveAliasSetByName`: the alias set of a page known only by name, or `None` when no page has
/// that name or it has no aliases. For free text that may or may not be a page name (a
/// `search_term`), where "not a page" is an ordinary answer, not an error. One Datalog query.
/// A `null` answer is not that answer (BR-0011, #318): it is a set with no members, marked
/// [`AliasSet::unavailable`], so the caller can say the lookup failed.
pub async fn resolve_alias_set_by_name(client: &LogseqClient, name: &str) -> Result<Option<AliasSet>, ToolError> {
    let query = queries::alias_set_by_name(&PageName::new(name));
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    let Some(rows) = wire::alias_set_by_name_rows(&answer)? else {
        return Ok(Some(AliasSet { members: Vec::new(), truncated: false, unavailable: Some(name.to_owned()) }));
    };
    Ok(alias_set_of_rows(&rows))
}

/// What `resolveAliasSetByName` makes of the rows: the first start page that has an id, the
/// members of every row, and the set they make, or `None` when it holds no more than the start page.
fn alias_set_of_rows(rows: &[(PulledPage, PulledPage)]) -> Option<AliasSet> {
    let first = rows.iter().find_map(|(start, _)| AliasMember::of(start))?;
    let found: Vec<AliasMember> = rows.iter().filter_map(|(_, member)| AliasMember::of(member)).collect();
    Some(build_set(first, found)).filter(AliasSet::has_aliases)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn member(id: i64, name: &str) -> AliasMember {
        AliasMember { id, name: name.to_lowercase(), original_name: name.to_owned() }
    }

    fn page(value: serde_json::Value) -> PulledPage {
        wire::page_rows(&json!([[value]])).unwrap().unwrap().remove(0)
    }

    #[test]
    fn a_name_found_by_rows_is_a_set_only_when_it_has_aliases() {
        let row = |start: serde_json::Value, member: serde_json::Value| (page(start), page(member));
        let atlas = || json!({"id": 1, "name": "atlas", "original-name": "Atlas"});
        let rows = [row(atlas(), json!({"id": 2, "name": "project atlas", "original-name": "Project Atlas"})), row(atlas(), atlas())];
        let set = alias_set_of_rows(&rows).unwrap();
        assert_eq!(set.members.iter().map(|m| m.id).collect::<Vec<_>>(), [1, 2]);
        // the page alone (a link from itself) is no group, and no rows is no page
        assert_eq!(alias_set_of_rows(&[row(atlas(), atlas())]), None);
        assert_eq!(alias_set_of_rows(&[]), None);
        // a start page with no id is passed over for the next one
        let rows = [row(json!({"name": "no id"}), atlas()), row(atlas(), json!({"id": 3, "name": "b"}))];
        assert_eq!(alias_set_of_rows(&rows).unwrap().members[0].id, 1);
    }

    #[test]
    fn a_page_alone_is_a_set_of_one_and_reports_no_aliases() {
        let set = AliasSet::single(&page(json!({"id": 1, "name": "alice", "original-name": "Alice"})));
        assert_eq!(set.members, vec![member(1, "Alice")]);
        assert!(!set.has_aliases() && !set.truncated);
        assert_eq!(set.resolved_aliases(), None);
        assert!(AliasSet::single(&page(json!({"name": "no id"}))).members.is_empty());
    }

    #[test]
    fn the_start_page_leads_and_the_rest_are_ordered_by_name_without_duplicates() {
        let found = vec![member(3, "Zed"), member(1, "Alice"), member(2, "bob"), member(3, "Zed"), member(2, "bob")];
        let set = build_set(member(1, "Alice"), found);
        assert_eq!(set.members.iter().map(|m| m.id).collect::<Vec<_>>(), [1, 2, 3]);
        assert!(set.has_aliases());
    }

    #[test]
    fn resolved_aliases_are_the_original_names_sorted() {
        let set = build_set(member(9, "Zoe"), vec![member(1, "alice notes"), member(2, "Álvaro"), member(3, "Alice")]);
        assert_eq!(set.resolved_aliases().unwrap(), ["Alice", "alice notes", "Álvaro", "Zoe"]);
    }

    #[test]
    fn a_group_past_the_cap_keeps_the_start_and_49_and_says_so() {
        let found: Vec<AliasMember> = (0..60).map(|i| member(100 + i, &format!("page {i:02}"))).collect();
        let set = build_set(member(1, "Start"), found);
        assert_eq!((set.members.len(), set.truncated), (50, true));
        assert_eq!(set.members[49].original_name, "page 48");
        let warnings = alias_set_warnings(&[&set]);
        let [warning] = &warnings[..] else { panic!("one warning") };
        assert_eq!(warning.code, "alias_set_truncated");
        assert_eq!(
            warning.message,
            "The alias group of \"Start\" has more than 50 pages; only the page itself and 49 aliases were used, \
             so references written under the other names are missing. The maximum cannot be raised."
        );
        assert!(alias_set_warnings(&[&AliasSet::single(&page(json!({"id": 1})))]).is_empty());
    }

    #[test]
    fn an_unavailable_lookup_says_so_and_is_never_also_reported_as_cut() {
        let unavailable = AliasSet { unavailable: Some("Atlas".to_owned()), ..AliasSet::single(&page(json!({"id": 1, "name": "atlas", "original-name": "Atlas"}))) };
        let warnings = alias_set_warnings(&[&unavailable]);
        let [warning] = &warnings[..] else { panic!("one warning") };
        assert_eq!(warning.code, "alias_lookup_unavailable");
        assert_eq!(
            warning.message,
            "LogSeq returned no answer when looking up the aliases of \"Atlas\" (possibly no graph open or a re-index in \
             progress), so references written under its other names may be missing. \
             This does not mean it has no aliases. Retry in a moment, or call logseq_get_graph_info to check which graph is open."
        );
        assert_eq!(warning.how_to_fetch_all, None);
        // the set is the page alone, so no names are reported as covered
        assert_eq!(unavailable.resolved_aliases(), None);
        // a set that is somehow both is reported once, as unavailable, and a cut set alone is still `alias_set_truncated`
        let both = AliasSet { truncated: true, ..unavailable.clone() };
        assert_eq!(alias_set_warnings(&[&both]).iter().map(|w| w.code.as_str()).collect::<Vec<_>>(), ["alias_lookup_unavailable"]);
        let cut = AliasSet { truncated: true, ..AliasSet::single(&page(json!({"id": 1, "name": "atlas", "original-name": "Atlas"}))) };
        assert_eq!(alias_set_warnings(&[&cut]).iter().map(|w| w.code.as_str()).collect::<Vec<_>>(), ["alias_set_truncated"]);
    }

    #[test]
    fn code_units_order_an_astral_character_before_a_private_use_one() {
        // JavaScript's `<` compares UTF-16 units: U+1F680 is 0xD83D 0xDE80, below U+E000
        assert_eq!(compare_code_units("\u{1F680}", "\u{E000}"), Ordering::Less);
        assert_eq!("\u{1F680}".cmp("\u{E000}"), Ordering::Greater);
    }
}
