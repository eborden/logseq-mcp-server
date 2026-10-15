//! A page over time: the blocks on the page and the blocks that link to it, as one entry per journal day, oldest first,
//! with the blocks on non-journal pages last when no period is given.
//!
//! Calls: the page resolver (1 query for an exact name, an alias or an ISO date; a namespace-leaf name adds the leaf
//! query, and a missing page adds the suggestion lookup before it fails), the alias lookup (1 query, only when the page
//! has alias links), the page's block tree (`getPageBlocksTree`), the page itself (`getPage`, to put its day on the
//! tree's blocks) and the mentions (1 Datalog query, over the whole alias group for a page with aliases): 4 for a page
//! with no aliases and an exact name, 5 with aliases. The period, the cap and the roll-up of top concepts are applied after
//! the fetch, so they cost no call.
//!
//! The blocks are the entities LogSeq sent (BR-0004): the tree's blocks with their children, each with the page's own
//! entity as its `page`, and the mentions as the query pulled them, minus the `refs` the roll-up read.
//!
//! No clock is read here: a block's day is its page's `journalDay`.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::days::{entries_by_day, in_period, unique_by_id};
use super::queries::{blocks_referencing_page, blocks_referencing_pages};
use super::top_concepts::{ConceptRef, extract_concept_refs};
use super::wire::mention_rows;
use super::Found;
use crate::client::LogseqClient;
use crate::edn::{PageId, PageName};
use crate::errors::ToolError;
use crate::meta::ResultWarning;
use crate::period::Period;
use crate::resolve::alias::{alias_set_warnings, resolve_alias_set};
use crate::resolve::{RETRY_ADVICE, require_page};
use crate::tools::explore_context::resolved_from;
use crate::tools::get_page::wire as page_wire;

/// The warnings for a `null` answer to one of the three lookups (BR-0011). No `howToFetchAll` on any: no
/// parameter fetches what LogSeq did not answer (like `pages_unavailable`, #64), so none adds to `hasMore`.
fn page_blocks_unavailable() -> ResultWarning {
    ResultWarning::new(
        "page_blocks_unavailable",
        format!(
            "LogSeq returned no answer when looking up the blocks of this page (possibly no graph open or a re-index in \
             progress), so the page's own blocks are missing from the result. This does not mean the page has no \
             blocks. {RETRY_ADVICE}"
        ),
    )
}

fn page_unavailable_warning() -> ResultWarning {
    ResultWarning::new(
        "page_unavailable",
        format!(
            "LogSeq returned no answer when looking up this page (possibly no graph open or a re-index in progress), so \
             the page's blocks lost their day and are listed with the mentions that have none. This does not mean the page \
             has no day. {RETRY_ADVICE}"
        ),
    )
}

fn mentions_unavailable_warning() -> ResultWarning {
    ResultWarning::new(
        "mentions_unavailable",
        format!(
            "LogSeq returned no answer when looking up the blocks that mention this page (possibly no graph open or a \
             re-index in progress), so the mentions are missing from the result. This does not mean nothing \
             mentions it. {RETRY_ADVICE}"
        ),
    )
}

/// The page named `name` over time: its blocks and the blocks that link to it (under any of its aliases) inside
/// `period`, or all of them with no period.
///
/// `name` is a page name, an alias or an ISO date (`2025-01-01`). When the name was an alias, date or namespace leaf
/// rather than an exact name, `resolvedFrom` says which page was used; `resolvedAliases` lists the names covered.
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if no page matches and
/// [`ToolError::AmbiguousPage`] (with the candidates) if several do.
///
/// `with_refs` pulls each mention's refs for the roll-up of top concepts; with none (`top_concepts_limit` 0) they are left out.
pub async fn fetch(client: &LogseqClient, name: &str, period: Option<Period>, with_refs: bool) -> Result<Found, ToolError> {
    // Resolve the name first (exact name, alias or ISO date, in one query)
    let resolved = require_page(client, name).await?;
    let lookup_name = resolved.lookup_name.clone();

    // The names this page goes by (#69): a page with no `alias::` costs no call here
    let alias_set = resolve_alias_set(client, &resolved.page).await?;

    // The page's own blocks, as a tree
    let answer = client.call_api(page_wire::BLOCKS_METHOD, &[Value::from(lookup_name.as_str())]).await?;
    let tree = page_wire::blocks(&answer)?;

    // The page itself, to enrich the tree's blocks, which name their page by a bare `{ id }`
    let answer = client.call_api(page_wire::PAGE_METHOD, &[Value::from(lookup_name.as_str())]).await?;
    let page = page_wire::page(&answer)?;
    let mut tree = tree;
    // A `null` page leaves the tree's blocks with their bare `{ id }` page, so they would lose their day and look like
    // blocks on a non-journal page: that is `page_unavailable` (BR-0011), said only when there are blocks to enrich.
    let mut page_unavailable = false;
    if let Some(blocks) = tree.as_mut() {
        match page.as_ref() {
            Some(page) => {
                for block in blocks {
                    if let Value::Object(map) = block {
                        map.insert("page".to_owned(), page.clone());
                    }
                }
            }
            None => page_unavailable = !blocks.is_empty(),
        }
    }

    // Also search for inline mentions using Datalog. For an alias group, one query matches references
    // to any of its names and adds the blocks of the alias pages (the page's own come from the tree).
    let main_page_id = resolved.page.entity_id();
    let query = if alias_set.has_aliases() {
        let ids = alias_set.ids()?;
        let own: Vec<PageId> = ids.iter().copied().filter(|id| Some(id.get() as i64) != main_page_id).collect();
        blocks_referencing_pages(&ids, &own, with_refs)
    } else {
        blocks_referencing_page(&PageName::new(&lookup_name), with_refs)
    };
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    // A `null` answer is not "no mentions" (BR-0011): the page is listed without any, and the result says so.
    let mut mentions = mention_rows(&answer)?;

    // What each mention links, for the roll-up of top concepts: the query pulls each ref as a page map, and the block
    // goes on without them, as it did before the roll-up (a full result carries the block as LogSeq sent it).
    let mut refs_by_block: HashMap<i64, Vec<ConceptRef>> = HashMap::new();
    for block in mentions.iter_mut().flatten() {
        let Value::Object(map) = block else { continue };
        let Some(refs) = map.remove("refs") else { continue };
        let Some(id) = map.get("id").and_then(crate::wire::whole_number) else { continue };
        let mut holder = serde_json::Map::new();
        holder.insert("refs".to_owned(), refs);
        refs_by_block.insert(id, extract_concept_refs(&holder));
    }

    // Combine and deduplicate. A `null` block tree is not "no blocks on the page" either (BR-0011).
    let blocks_unavailable = tree.is_none();
    let mentions_unavailable = mentions.is_none();
    let all_blocks: Vec<Value> = tree.unwrap_or_default().into_iter().chain(mentions.unwrap_or_default()).collect();
    let unique = unique_by_id(all_blocks);

    // The period bounds the days; the blocks on non-journal pages have none, so a period leaves them out
    let filtered = in_period(unique, period);

    // The span of the dated blocks, for `dateRange` when there is no period
    let days: Vec<i64> = filtered.iter().filter_map(super::days::day_of).collect();
    let span = days.iter().copied().min().zip(days.iter().copied().max());
    let entries = entries_by_day(filtered);

    let mut warnings = alias_set_warnings(&[&alias_set]);
    if blocks_unavailable {
        warnings.push(page_blocks_unavailable());
    }
    if page_unavailable {
        warnings.push(page_unavailable_warning());
    }
    if mentions_unavailable {
        warnings.push(mentions_unavailable_warning());
    }

    let mut answered: Vec<(&'static str, Value)> = vec![("page", Value::from(name))];
    if let Some(from) = resolved_from(name, &resolved) {
        answered.push(("resolvedFrom", from));
    }
    if let Some(names) = alias_set.resolved_aliases() {
        answered.push(("resolvedAliases", Value::from(names)));
    }
    let group: HashSet<i64> = alias_set.members.iter().map(|member| member.id).collect();
    Ok(Found { entries, refs_by_block, warnings, answered, span, group })
}
