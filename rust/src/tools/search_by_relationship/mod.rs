//! `logseq_search_by_relationship` (the Rust side of `src/tools/search-by-relationship.ts`): blocks
//! tied to topic A by a link to topic B, as `references`, `referenced-by` / `in-pages-linking-to`
//! (one query each, see below) or `connected-within` N hops (#7), cut to `limit` (#61, #183).
//!
//! Calls: the page resolver for each topic (1 query for an exact name, an alias or an ISO date; the
//! two topics run together, and once when both are the same name), then the alias groups (1 query for
//! both topics, none when neither has an alias link), then the search itself. `references`, `referenced-by` and
//! `in-pages-linking-to` are 1 query. `connected-within` is O(`max_distance`): 1 query per hop,
//! seeded with the resolved ids, ending at the first hop that reaches topic B, then the two page
//! trees (2 `logseq.Editor.getPageBlocksTree` calls) only when a connection was found. Two names of
//! one page make no hop query and return a `same_topic` warning. The cut is applied after the
//! queries, so it costs no call.
//!
//! A `null` answer is not an empty one (BR-0011, #342). It costs no extra call and adds a warning
//! with no `howToFetchAll`: `relationship_unavailable` for a relationship query, `hop_unavailable`
//! (the walk stops at that hop) and `page_blocks_unavailable` for a page tree of a found connection.
//!
//! This directory holds what only this search uses: its queries (`queries.rs`) and the answers it
//! reads (`wire.rs`). The alias groups, the page resolver, the block budget and the truncation
//! warnings are shared. The tool has no tips.

mod queries;
mod wire;

use std::collections::HashSet;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::parse_args;
use crate::block_budget::{Budget, count_blocks, take_blocks};
use crate::client::LogseqClient;
use crate::edn::{PageId, PageName};
use crate::errors::{MatchedBy, ToolError};
use crate::js;
use crate::meta::ResultWarning;
use crate::resolve::alias::{AliasSet, alias_set_warnings, resolve_alias_sets};
use crate::resolve::{ResolvedPage, require_page};
use crate::tool::{input_schema, read_only_annotations, success_result};
use crate::truncation::{CappedTruncation, INLINE_BLOCKS, capped_truncation_warning};

pub const NAME: &str = "logseq_search_by_relationship";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "Find blocks tied to topic A by a link to topic B: references, referenced-by, in-pages-linking-to, or connected-within N hops. Both topics must be pages. Capped by limit (max 500): see warnings.\n\n\
**Can't find:** plain-text relationships (matching is on [[links]] and #tags, not words), or over 500 results.\n\
**Alternatives:** logseq_search_blocks (keywords), logseq_get_concept_network (overview).";

/// Hops `connected-within` walks when `max_distance` is absent.
pub const DEFAULT_MAX_DISTANCE: u64 = 2;

/// Most pages expanded in one `connected-within` hop. Journal pages link to almost everything, so
/// the frontier can grow into the thousands; each hop embeds its ids in one query.
pub const DEFAULT_MAX_FRONTIER: usize = 500;

/// Entries in `results` when `limit` is absent (#61).
pub const DEFAULT_RELATIONSHIP_LIMIT: u64 = 50;

/// Most entries `results` holds, whatever `limit` asks for (#61). A cut at the maximum is a
/// `results_truncated` warning with no `howToFetchAll`, and `hasMore` stays false.
pub const MAX_RELATIONSHIP_LIMIT: u64 = 500;

/// No parameter reaches past the cut: the topics and the type fix the query, and `max_distance`
/// only decides whether `connected-within` finds a connection, not how many blocks it returns.
const NARROWER: &str = "No other parameter narrows this query.";

/// What the cut list holds, for the warning. The Datalog types return matching blocks in LogSeq's
/// order, which is not a ranking. `connected-within` has its own wording.
const MATCHING_BLOCKS: &str = "matching blocks (the first ones listed, not ranked)";

// `relationship_type`, as the input schema lists it. Inlined into the tool's schema, not referenced
// from `$defs`: the MCP SDK client drops `$defs`. No doc comment, which would become a `description`
// of the enum beside the parameter's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
#[schemars(inline)]
pub enum RelationshipType {
    References,
    ReferencedBy,
    InPagesLinkingTo,
    ConnectedWithin,
}

impl RelationshipType {
    pub fn as_str(self) -> &'static str {
        match self {
            RelationshipType::References => "references",
            RelationshipType::ReferencedBy => "referenced-by",
            RelationshipType::InPagesLinkingTo => "in-pages-linking-to",
            RelationshipType::ConnectedWithin => "connected-within",
        }
    }

}

fn default_max_distance() -> u64 {
    DEFAULT_MAX_DISTANCE
}

fn default_limit() -> u64 {
    DEFAULT_RELATIONSHIP_LIMIT
}

/// The tool's arguments, as `tools/list` shows them. The schema is generated from this type, and a
/// call parses its arguments into it (ADR-0019). Unknown fields are ignored, as every TypeScript tool
/// ignores them.
///
/// The two counts are `u64`, not `u32`: the schema is the same (an integer, at least 0), and the
/// value is echoed back (`query.maxDistance`, "N was asked for"), so a number past `u32` stays
/// exact.
#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq)]
pub struct Args {
    /// Primary topic to search for (page name, alias or ISO date)
    pub topic_a: String,
    /// Related topic that defines the relationship (page name, alias or ISO date)
    pub topic_b: String,
    /// Type of relationship: references (blocks about A that reference B), referenced-by (blocks about A in pages referenced by B), in-pages-linking-to (blocks about A in pages linking to B), connected-within (topics connected within N hops)
    pub relationship_type: RelationshipType,
    /// Maximum graph distance for connected-within (default: 2)
    #[serde(default = "default_max_distance")]
    pub max_distance: u64,
    /// Max results (default: 50, max: 500). connected-within counts every block of both pages, nested ones too, topic A's first; a block that lost children has childrenTruncated
    #[serde(default = "default_limit")]
    pub limit: u64,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Search by Relationship")
        .with_annotations(read_only_annotations("Search by Relationship"))
}

/// A call: arguments read, then the search.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = parse_args::<Args>(arguments.as_ref())?;
    let result = search_by_relationship(client, &args).await?;
    Ok(success_result(vec![ContentBlock::text(result.to_string())]))
}

/// `isInfrastructureError`: the connection to LogSeq failed (not running, timeout, rejected token).
fn is_infrastructure(error: &ToolError) -> bool {
    matches!(error, ToolError::Logseq(error) if error.is_infrastructure())
}

/// `resolveTopics`: both topics resolved at once. The same name (ignoring case and surrounding
/// whitespace) is resolved once. When both fail, the error is deterministic: a connection, timeout or
/// auth error first, then topic A's, then topic B's, whichever request happened to finish first.
async fn resolve_topics(client: &LogseqClient, topic_a: &str, topic_b: &str) -> Result<(ResolvedPage, ResolvedPage), ToolError> {
    let same_name = js::trim(topic_a).to_lowercase() == js::trim(topic_b).to_lowercase();
    if same_name {
        let resolved = require_page(client, topic_a).await?;
        return Ok((resolved.clone(), resolved));
    }
    let (a, b) = tokio::join!(require_page(client, topic_a), require_page(client, topic_b));
    match (a, b) {
        (Ok(a), Ok(b)) => Ok((a, b)),
        (Err(a), Err(b)) => Err(if is_infrastructure(&a) || !is_infrastructure(&b) { a } else { b }),
        (Err(error), Ok(_)) | (Ok(_), Err(error)) => Err(error),
    }
}

/// `limit` as the cap on `results`: floored and clamped to 0..500 (#61).
fn result_cap(limit: u64) -> usize {
    limit.min(MAX_RELATIONSHIP_LIMIT) as usize
}

/// What a cut `connected-within` kept from each topic's page tree, in blocks, nested ones included.
struct TopicCounts {
    kept_a: usize,
    kept_b: usize,
    total_a: usize,
    total_b: usize,
    /// A kept block lost some of its children (it carries `childrenTruncated`)
    partial_block: bool,
}

/// `connectedWithinEntries`: `what` for a cut `connected-within`: the unit (every block of the two
/// pages' trees, nested ones too, in document order, topic A's page first), how many kept blocks came
/// from each topic and how many each page has, so a reader can see when topic B's blocks were dropped
/// entirely, and whether a kept block lost children. All of it is known from the two tree calls, so
/// this costs nothing.
fn connected_within_entries(counts: &TopicCounts) -> String {
    let TopicCounts { kept_a, kept_b, total_a, total_b, partial_block } = counts;
    format!(
        "blocks of the two pages, nested ones counted (kept {kept_a} from topic A and {kept_b} from topic B, of {total_a} and {total_b}; \
         topic A's first, then topic B's{})",
        if *partial_block { "; a kept block shows fewer children than it has (childrenTruncated)" } else { "" }
    )
}

/// The cut `results`, the warning that says so and the count before the cut.
#[derive(Debug, PartialEq)]
struct Capped {
    results: Vec<Value>,
    warning: Option<ResultWarning>,
    /// `totals.blocks`: the count before the cut, in the cap's unit. Present only when a cut was made.
    total_blocks: Option<usize>,
}

/// The cut after the walk and the queries, so it costs no call. `trees` is each topic's page tree
/// when a `connected-within` found a connection; `results` is then the two trees together.
fn cap_results(results: Vec<Value>, trees: Option<(Vec<Value>, Vec<Value>)>, limit: u64) -> Capped {
    let cap = result_cap(limit);
    if let Some((tree_a, tree_b)) = trees {
        // `connected-within` counts every block of the two trees, nested ones too, in document order
        // (topic A's page, then B's), so the result is bounded however deep the trees run (#183). At
        // or below the cap `results` goes out as it came, untouched.
        let (total_a, total_b) = (count_blocks(&tree_a), count_blocks(&tree_b));
        let total = total_a + total_b;
        if total <= cap {
            return Capped { results, warning: None, total_blocks: None };
        }
        // One budget over both trees, so the cut falls where one pass over A then B would put it
        let mut budget = Budget::new(cap);
        let kept_a = take_blocks(&tree_a, &mut budget);
        let kept_b = take_blocks(&tree_b, &mut budget);
        let kept_count_a = count_blocks(&kept_a);
        let warning = cut_warning(
            &connected_within_entries(&TopicCounts {
                kept_a: kept_count_a,
                kept_b: cap - kept_count_a,
                total_a,
                total_b,
                partial_block: budget.partial,
            }),
            cap,
            total,
            limit,
        );
        let mut kept = kept_a;
        kept.extend(kept_b);
        return Capped { results: kept, warning: Some(warning), total_blocks: Some(total) };
    }
    if results.len() > cap {
        let total = results.len();
        let warning = cut_warning(MATCHING_BLOCKS, cap, total, limit);
        let mut kept = results;
        kept.truncate(cap);
        return Capped { results: kept, warning: Some(warning), total_blocks: Some(total) };
    }
    Capped { results, warning: None, total_blocks: None }
}

fn cut_warning(what: &str, shown: usize, total: usize, requested: u64) -> ResultWarning {
    capped_truncation_warning(CappedTruncation {
        what,
        shown,
        total,
        param: "limit",
        max: MAX_RELATIONSHIP_LIMIT as usize,
        narrower: NARROWER,
        requested: Some(requested),
        code: "results_truncated",
        inline_max: Some(INLINE_BLOCKS),
        paging: None,
    })
}

/// `resolvedFromInfo`: which page a topic stood for, when it was an alias, date or namespace leaf
/// rather than an exact name.
fn resolved_from(input: &str, resolved: &ResolvedPage) -> Option<Value> {
    (resolved.matched_by != MatchedBy::Name)
        .then(|| json!({"name": input, "matchedBy": resolved.matched_by.as_str(), "resolvedTo": resolved.original_name}))
}

/// What the hop-by-hop walk of `connected-within` found.
#[derive(Debug, PartialEq, Eq)]
enum Walk {
    /// Some name of topic B is within `max_distance` hops of some name of topic A
    Connected,
    /// None was, and the walk may be incomplete when a hop was cut: `(hop, pages that hop reached)`
    NotConnected { cut_at: Option<(u64, usize)> },
    /// LogSeq gave no answer (`null`) for `hop`, so the walk stopped there with no further call (BR-0011).
    /// "Not connected" is not known. `cut_at` is an earlier hop that was cut, which stays true.
    Unavailable { hop: u64, cut_at: Option<(u64, usize)> },
}

/// The walk of `connected-within`: a level-synchronous BFS, one query per hop for the whole frontier
/// in both link directions, so the cost is O(`max_distance`) calls. `seeds` are every name of topic A,
/// `targets` every name of topic B other than those A's names already are.
async fn walk(client: &LogseqClient, seeds: &[i64], targets: &HashSet<i64>, max_distance: u64) -> Result<Walk, ToolError> {
    let mut visited: HashSet<i64> = seeds.iter().copied().collect();
    let mut frontier: Vec<i64> = seeds.to_vec();
    let mut cut_at: Option<(u64, usize)> = None;

    let mut depth = 1;
    while depth <= max_distance && !frontier.is_empty() {
        if frontier.len() > DEFAULT_MAX_FRONTIER {
            // Deterministic cut: lowest ids (oldest pages) first
            cut_at.get_or_insert((depth, frontier.len()));
            frontier.sort_unstable();
            frontier.truncate(DEFAULT_MAX_FRONTIER);
        }
        let ids = frontier.iter().map(|&id| PageId::new(id)).collect::<Result<Vec<_>, _>>()?;
        let query = queries::neighbor_pages(&ids);
        let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
        // `null` is not "no neighbours" (BR-0011): the walk stops here instead of ending "not connected"
        let Some(neighbors) = wire::id_rows(&answer)? else {
            return Ok(Walk::Unavailable { hop: depth, cut_at });
        };

        if neighbors.iter().any(|id| targets.contains(id)) {
            return Ok(Walk::Connected);
        }
        frontier = Vec::new();
        for id in neighbors {
            if visited.insert(id) {
                frontier.push(id);
            }
        }
        depth += 1;
    }
    Ok(Walk::NotConnected { cut_at })
}

/// The ids of an alias set, as plain numbers.
fn member_ids(set: &AliasSet) -> Vec<i64> {
    set.members.iter().map(|member| member.id).collect()
}

/// `getPageBlocksTree` for a page's lookup name, or `None` when LogSeq gave no answer (`null`, BR-0011),
/// which is not a page with no blocks.
async fn fetch_tree(client: &LogseqClient, name: &str) -> Result<Option<Vec<Value>>, ToolError> {
    let answer = client.call_api("logseq.Editor.getPageBlocksTree", &[Value::from(name)]).await?;
    Ok(wire::blocks(&answer)?)
}

/// No `howToFetchAll` on the warnings below: no parameter fetches what LogSeq did not answer (like
/// `pages_unavailable`, #64), so `hasMore` is unaffected. The retry advice is in the message.
const RETRY_ADVICE: &str = "Retry in a moment, or call logseq_get_graph_info to check which graph is open.";

/// What the query of a relationship type looks for, for the warning.
fn relationship_sought(relationship_type: RelationshipType, topic_a: &str, topic_b: &str) -> String {
    match relationship_type {
        RelationshipType::References => format!("the blocks of \"{topic_a}\" that reference \"{topic_b}\""),
        RelationshipType::InPagesLinkingTo => format!("the blocks that reference \"{topic_a}\" in pages linking to \"{topic_b}\""),
        RelationshipType::ReferencedBy => format!("the blocks that reference \"{topic_a}\" in pages referenced by \"{topic_b}\""),
        RelationshipType::ConnectedWithin => unreachable!("connected-within has its own warnings"),
    }
}

fn relationship_unavailable(relationship_type: RelationshipType, topic_a: &str, topic_b: &str) -> ResultWarning {
    ResultWarning::new(
        "relationship_unavailable",
        format!(
            "LogSeq returned no answer when looking up {} (possibly no graph open or a re-index in progress), \
             so the empty results may not mean nothing matches. {RETRY_ADVICE}",
            relationship_sought(relationship_type, topic_a, topic_b)
        ),
    )
}

fn frontier_truncated((depth, reached): (u64, usize)) -> ResultWarning {
    ResultWarning::new(
        "frontier_truncated",
        format!(
            "Hop {depth} reached {reached} pages; only {DEFAULT_MAX_FRONTIER} were expanded, \
             so \"not connected\" may be a false negative. Try a smaller max_distance or more specific topics."
        ),
    )
}

fn hop_unavailable(hop: u64) -> ResultWarning {
    ResultWarning::new(
        "hop_unavailable",
        format!(
            "LogSeq returned no answer when looking up the pages reached at hop {hop} (possibly no graph open or a \
             re-index in progress), so the walk stopped there and \"not connected\" may be wrong. \
             This does not mean the topics are not connected. {RETRY_ADVICE}"
        ),
    )
}

fn page_blocks_unavailable(which: &str, topic: &str) -> ResultWarning {
    ResultWarning::new(
        "page_blocks_unavailable",
        format!(
            "LogSeq returned no answer when looking up the blocks of topic {which} (\"{topic}\") (possibly no graph open or a \
             re-index in progress), so its blocks are missing from the results although the topics are connected. \
             This does not mean the page has no blocks. {RETRY_ADVICE}"
        ),
    )
}

/// `searchByRelationship`: blocks tied to topic A by a link to topic B. Returns the result as the
/// JSON the tool prints.
///
/// A topic with aliases matches references written under any of its names (`resolvedAliases` says
/// which): one extra query for both topics together, and none when neither has an alias. Two names of
/// one page (the same name twice, or a page and its alias) are not a connection: no walk, no results
/// and a `same_topic` warning. A walk whose hop was cut (500 pages) and found nothing says
/// `frontier_truncated`: "not connected" may be a false negative, while a found connection is always
/// real.
///
/// Fails with [`ToolError::PageNotFound`] (guidance with the closest names) if a topic matches no page,
/// and [`ToolError::AmbiguousPage`] (with the candidates) if one matches several.
pub async fn search_by_relationship(client: &LogseqClient, args: &Args) -> Result<Value, ToolError> {
    let Args { topic_a, topic_b, relationship_type, max_distance, limit } = args;
    let mut results: Vec<Value> = Vec::new();
    // Each topic's page tree, for a `connected-within` that found a connection
    let mut trees: Option<(Vec<Value>, Vec<Value>)> = None;
    let mut warnings: Vec<ResultWarning> = Vec::new();

    // Resolve both topics first (exact name, alias or ISO date: one query each), together and, when both
    // topics are the same name, once. A topic that matches no page or several pages fails instead of
    // quietly returning nothing.
    let (resolved_a, resolved_b) = resolve_topics(client, topic_a, topic_b).await?;
    let (name_a, name_b) = (resolved_a.lookup_name.as_str(), resolved_b.lookup_name.as_str());

    // The names each topic goes by (#69): one query for both, none when neither has an alias
    let mut sets = resolve_alias_sets(client, &[&resolved_a.page, &resolved_b.page]).await?;
    let set_b = sets.remove(1);
    let set_a = sets.remove(0);
    let same_topic_page = resolved_a.page.entity_id() == resolved_b.page.entity_id();
    warnings.extend(alias_set_warnings(&if same_topic_page { vec![&set_a] } else { vec![&set_a, &set_b] }));
    let any_aliases = set_a.has_aliases() || set_b.has_aliases();

    match relationship_type {
        // Blocks on topic A's page whose :block/refs include topic B's page. Matching on refs (not content)
        // is case-insensitive and covers [[link]], #tag, #[[multi word]] and uuid-style refs.
        RelationshipType::References => {
            let query = if any_aliases {
                queries::blocks_on_pages_referencing_ids(&set_a.ids()?, &set_b.ids()?)?
            } else {
                queries::blocks_on_page_referencing(&PageName::new(name_a), &PageName::new(name_b))
            };
            results = fetch_blocks(client, query).await?.unwrap_or_else(|| {
                warnings.push(relationship_unavailable(*relationship_type, topic_a, topic_b));
                Vec::new()
            });
        }
        // Blocks that reference topic A, on pages that also hold a block referencing topic B (inbound: the
        // pages that link to B).
        RelationshipType::InPagesLinkingTo => {
            let query = if any_aliases {
                queries::blocks_referencing_in_pages_linking_ids(&set_a.ids()?, &set_b.ids()?)?
            } else {
                queries::blocks_referencing_in_pages_linking(&PageName::new(name_a), &PageName::new(name_b))
            };
            results = fetch_blocks(client, query).await?.unwrap_or_else(|| {
                warnings.push(relationship_unavailable(*relationship_type, topic_a, topic_b));
                Vec::new()
            });
        }
        // Blocks that reference topic A, on pages that a block on topic B's page references (outbound: the
        // pages B links to). The TypeScript server ran the inbound query here too, against its own
        // description (#299, D5); the maintainer approved making it do what the description says.
        RelationshipType::ReferencedBy => {
            let query = if any_aliases {
                queries::blocks_referencing_in_pages_referenced_by_ids(&set_a.ids()?, &set_b.ids()?)?
            } else {
                queries::blocks_referencing_in_pages_referenced_by(&PageName::new(name_a), &PageName::new(name_b))
            };
            results = fetch_blocks(client, query).await?.unwrap_or_else(|| {
                warnings.push(relationship_unavailable(*relationship_type, topic_a, topic_b));
                Vec::new()
            });
        }
        RelationshipType::ConnectedWithin => {
            // The ids come from the resolved pages and their alias groups, so no further lookups are
            // needed. Every name of a topic counts as that topic: the walk starts from all of A's names and
            // ends at any of B's.
            let id_a = resolved_a.page.entity_id();
            let id_b = resolved_b.page.entity_id();
            let seeds: Vec<i64> = match id_a {
                None => Vec::new(),
                Some(_) if set_a.has_aliases() => member_ids(&set_a),
                Some(id) => vec![id],
            };

            if id_b.is_some_and(|id| seeds.contains(&id)) {
                // Both topics are names of one page (the same name, or a page and its alias). There is
                // nothing to connect, and a walk would "find" the page again through its own links (the
                // `alias::` block refs the alias stub), so say so instead of walking.
                warnings.push(ResultWarning::new(
                    "same_topic",
                    format!(
                        "\"{topic_a}\" and \"{topic_b}\" are names of the same page, so connected-within has nothing to connect. \
                         Ask about two different pages."
                    ),
                ));
            } else if let (Some(_), Some(id_b)) = (id_a, id_b) {
                // Any name of B ends the walk, except names B shares with A: the walk starts there, so
                // reaching them proves nothing. B's own page is never one of them (checked above).
                let mut targets: HashSet<i64> = HashSet::new();
                targets.insert(id_b);
                if set_b.has_aliases() {
                    targets.extend(member_ids(&set_b));
                }
                targets.retain(|id| !seeds.contains(id));

                match walk(client, &seeds, &targets, *max_distance).await? {
                    Walk::Connected => {
                        // If connected, return blocks from both topics. A tree LogSeq didn't answer is
                        // missing, not empty: the connection stays reported and a warning says what's absent.
                        let tree_a = fetch_tree(client, name_a).await?;
                        let tree_b = fetch_tree(client, name_b).await?;
                        if tree_a.is_none() {
                            warnings.push(page_blocks_unavailable("A", topic_a));
                        }
                        if tree_b.is_none() {
                            warnings.push(page_blocks_unavailable("B", topic_b));
                        }
                        let (tree_a, tree_b) = (tree_a.unwrap_or_default(), tree_b.unwrap_or_default());
                        results = tree_a.iter().chain(&tree_b).cloned().collect();
                        trees = Some((tree_a, tree_b));
                    }
                    Walk::NotConnected { cut_at } => warnings.extend(cut_at.map(frontier_truncated)),
                    Walk::Unavailable { hop, cut_at } => {
                        warnings.extend(cut_at.map(frontier_truncated));
                        warnings.push(hop_unavailable(hop));
                    }
                }
            }
        }
    }

    let capped = cap_results(results, trees, *limit);
    warnings.extend(capped.warning);

    let mut query = Map::new();
    query.insert("topicA".into(), json!(topic_a));
    query.insert("topicB".into(), json!(topic_b));
    query.insert("relationshipType".into(), json!(relationship_type.as_str()));
    if *relationship_type == RelationshipType::ConnectedWithin {
        query.insert("maxDistance".into(), json!(max_distance));
    }

    let mut result = Map::new();
    result.insert("query".into(), Value::Object(query));
    result.insert("relationshipType".into(), json!(relationship_type.as_str()));
    let (from_a, from_b) = (resolved_from(topic_a, &resolved_a), resolved_from(topic_b, &resolved_b));
    if from_a.is_some() || from_b.is_some() {
        let mut from = Map::new();
        from.extend(from_a.map(|from| ("topicA".to_owned(), from)));
        from.extend(from_b.map(|from| ("topicB".to_owned(), from)));
        result.insert("resolvedFrom".into(), Value::Object(from));
    }
    let (aliases_a, aliases_b) = (set_a.resolved_aliases(), set_b.resolved_aliases());
    if aliases_a.is_some() || aliases_b.is_some() {
        let mut aliases = Map::new();
        aliases.extend(aliases_a.map(|names| ("topicA".to_owned(), json!(names))));
        aliases.extend(aliases_b.map(|names| ("topicB".to_owned(), json!(names))));
        result.insert("resolvedAliases".into(), Value::Object(aliases));
    }
    result.insert("results".into(), Value::Array(capped.results));
    // `buildResultMeta`: `hasMore` follows the warnings, and `totals` is there only when a cut was made
    result.insert("hasMore".into(), json!(warnings.iter().any(|warning| warning.how_to_fetch_all.is_some())));
    result.insert("warnings".into(), serde_json::to_value(&warnings).expect("warnings serialize"));
    if let Some(total) = capped.total_blocks {
        result.insert("totals".into(), json!({ "blocks": total }));
    }
    Ok(Value::Object(result))
}

/// A query for blocks, run and unwrapped (`extractBlocks`), or `None` when LogSeq gave no answer
/// (`null`, BR-0011), which is not "nothing matches".
async fn fetch_blocks(client: &LogseqClient, query: crate::edn::Query) -> Result<Option<Vec<Value>>, ToolError> {
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    Ok(wire::block_rows(&answer)?.map(|rows| rows.into_iter().map(Value::Object).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: i64, children: Vec<Value>) -> Value {
        json!({"id": id, "uuid": format!("u{id}"), "children": children})
    }

    fn ids(blocks: &[Value]) -> Vec<i64> {
        blocks.iter().flat_map(|b| std::iter::once(b["id"].as_i64().unwrap()).chain(ids(b["children"].as_array().unwrap()))).collect()
    }

    #[test]
    fn matching_blocks_within_the_limit_come_back_untouched() {
        let blocks: Vec<Value> = (1..=3).map(|id| block(id, vec![])).collect();
        let capped = cap_results(blocks.clone(), None, 3);
        assert_eq!((capped.results, capped.warning, capped.total_blocks), (blocks, None, None));
    }

    #[test]
    fn matching_blocks_past_the_limit_are_cut_and_counted() {
        let blocks: Vec<Value> = (1..=5).map(|id| block(id, vec![])).collect();
        let capped = cap_results(blocks, None, 2);
        assert_eq!(ids(&capped.results), [1, 2]);
        assert_eq!(capped.total_blocks, Some(5));
        let warning = capped.warning.unwrap();
        assert_eq!(warning.code, "results_truncated");
        assert_eq!(warning.message, "Showing 2 of 5 matching blocks (the first ones listed, not ranked).");
        assert_eq!(warning.how_to_fetch_all.as_deref(), Some("Set limit to 5 (or higher) to get all 5."));
    }

    #[test]
    fn a_limit_past_the_maximum_is_the_maximum_and_says_so() {
        let blocks: Vec<Value> = (1..=501).map(|id| block(id, vec![])).collect();
        let capped = cap_results(blocks, None, 900);
        assert_eq!(capped.results.len(), 500);
        let warning = capped.warning.unwrap();
        assert_eq!(
            warning.message,
            "Showing 500 of 501 matching blocks (the first ones listed, not ranked): limit is capped at its maximum of 500 (900 was asked for), \
             so the rest can't be fetched in one call. No other parameter narrows this query."
        );
        assert_eq!(warning.how_to_fetch_all, None);
    }

    #[test]
    fn two_trees_are_cut_in_document_order_topic_a_first_and_a_cut_parent_says_so() {
        let tree_a = vec![block(1, vec![block(2, vec![]), block(3, vec![])])];
        let tree_b = vec![block(10, vec![]), block(11, vec![])];
        let all: Vec<Value> = tree_a.iter().chain(&tree_b).cloned().collect();
        let capped = cap_results(all, Some((tree_a, tree_b)), 2);
        assert_eq!(ids(&capped.results), [1, 2]);
        assert_eq!(capped.results[0]["childrenTruncated"], json!(true));
        assert_eq!(capped.total_blocks, Some(5));
        assert_eq!(
            capped.warning.unwrap().message,
            "Showing 2 of 5 blocks of the two pages, nested ones counted (kept 2 from topic A and 0 from topic B, of 3 and 2; \
             topic A's first, then topic B's; a kept block shows fewer children than it has (childrenTruncated))."
        );
    }

    #[test]
    fn trees_within_the_limit_come_back_as_they_came() {
        let tree_a = vec![block(1, vec![block(2, vec![])])];
        let tree_b = vec![block(10, vec![])];
        let all: Vec<Value> = tree_a.iter().chain(&tree_b).cloned().collect();
        let capped = cap_results(all.clone(), Some((tree_a, tree_b)), 3);
        assert_eq!((capped.results, capped.warning, capped.total_blocks), (all, None, None));
    }

    #[test]
    fn a_limit_of_zero_keeps_nothing_and_says_how_many_there_were() {
        let capped = cap_results(vec![block(1, vec![])], None, 0);
        assert!(capped.results.is_empty());
        assert_eq!(capped.warning.unwrap().message, "Showing 0 of 1 matching blocks (the first ones listed, not ranked).");
    }

    #[test]
    fn a_topic_that_was_not_an_exact_name_says_which_page_it_stood_for() {
        let resolved = |matched_by| ResolvedPage {
            page: crate::resolve::PulledPage::default(),
            matched_by,
            original_name: "Project Atlas".to_owned(),
            lookup_name: "project atlas".to_owned(),
        };
        assert_eq!(resolved_from("Atlas", &resolved(MatchedBy::Name)), None);
        assert_eq!(
            resolved_from("Atlas", &resolved(MatchedBy::Alias)),
            Some(json!({"name": "Atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"}))
        );
    }

    #[test]
    fn the_arguments_default_and_are_read_in_schema_order() {
        let read = |value: Value| parse_args::<Args>(value.as_object());
        let args = read(json!({"topic_a": "A", "topic_b": "B", "relationship_type": "references", "max_distance": null})).unwrap();
        assert_eq!((args.max_distance, args.limit, args.relationship_type), (2, 50, RelationshipType::References));
        // topic_a is read before the others, whatever else is wrong
        assert_eq!(
            read(json!({"topic_b": 1})).unwrap_err().to_string(),
            "Invalid parameter 'topic_a': missing\n\nExpected: a string (required)\nExample: topic_a: \"...\""
        );
        assert!(read(json!({"topic_a": "A", "topic_b": "B"})).unwrap_err().to_string().starts_with("Invalid parameter 'relationship_type': missing"));
        assert_eq!(
            read(json!({"topic_a": "A", "topic_b": "B", "relationship_type": "connected-within", "max_distance": -1})).unwrap_err().to_string(),
            "Invalid parameter 'max_distance': -1\n\nExpected: at least 0\nExample: max_distance: 0"
        );
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"topic_a": "A", "topic_b": "B", "relationship_type": "references"});
        let without = |param: &str| {
            let mut base = base.clone();
            base.as_object_mut().unwrap().remove(param);
            base
        };
        sweep::<Args>(without("topic_a"), "topic_a", Takes::Text, true);
        sweep::<Args>(without("topic_b"), "topic_b", Takes::Text, true);
        let words = &["references", "referenced-by", "in-pages-linking-to", "connected-within"];
        sweep::<Args>(without("relationship_type"), "relationship_type", Takes::Words(words), true);
        sweep::<Args>(base.clone(), "max_distance", Takes::Count(0), false);
        sweep::<Args>(base, "limit", Takes::Count(0), false);
    }

    #[test]
    fn the_search_schema_means_what_the_typescript_one_means() {
        use crate::tool::testing::{meaning, schema_of};
        // `inputSchema` of logseq_search_by_relationship in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "topic_a": {"type": "string", "description": "Primary topic to search for (page name, alias or ISO date)"},
                "topic_b": {"type": "string", "description": "Related topic that defines the relationship (page name, alias or ISO date)"},
                "relationship_type": {
                    "type": "string",
                    "enum": ["references", "referenced-by", "in-pages-linking-to", "connected-within"],
                    "description": "Type of relationship: references (blocks about A that reference B), referenced-by (blocks about A in pages referenced by B), in-pages-linking-to (blocks about A in pages linking to B), connected-within (topics connected within N hops)",
                },
                "max_distance": {"type": "integer", "minimum": 0, "default": 2, "description": "Maximum graph distance for connected-within (default: 2)"},
                "limit": {
                    "type": "integer",
                    "minimum": 0,
                    "default": 50,
                    "description": "Max results (default: 50, max: 500). connected-within counts every block of both pages, nested ones too, topic A's first; a block that lost children has childrenTruncated",
                },
            },
            "required": ["topic_a", "topic_b", "relationship_type"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_search_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Search by Relationship"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Search by Relationship", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }
}
