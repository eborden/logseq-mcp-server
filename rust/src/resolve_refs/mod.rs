//! Resolving `((uuid))` block refs and `{{embed}}`s in returned blocks (#18, BR-0007).
//!
//! The blocks keep their `content` untouched. A block that holds at least one ref or embed gains:
//! - `resolvedContent`: its content with every resolvable ref replaced inline by the target's
//!   text (nested refs resolved too, down to the depth limit);
//! - `resolvedRefs`: one entry per distinct ref found, nested ones included, so the model still
//!   has the uuid to act on and sees why something stayed as it is.
//!
//! Batching: refs are fetched breadth first, ONE Datalog query per nesting level
//! ([`queries::ref_targets`]), so a call costs at most `max_depth` queries however many refs
//! there are, and none when nothing has a ref.
//!
//! Depth: a ref in the returned block is level 1, a ref inside its target level 2, and so on.
//! Refs deeper than `max_depth` are left as written (`depth_limit`).
//!
//! A `null` answer (BR-0011, #260): when LogSeq answers a level's query with `null`, its refs
//! were never looked up. They stay as written with status `unavailable` (not `missing`, #272),
//! and a `refs_unavailable` warning counts them. A real empty answer still means `missing`.
//!
//! Cycles: the set of uuids "being expanded" is tracked per path, not shared across siblings. Two
//! siblings that reference the same block both resolve; only a ref back to a block already on the
//! current path is a `cycle`.
//!
//! The blocks are the `serde_json::Value`s LogSeq sent: a tool's output carries each block as it
//! came (BR-0004), so a block is copied and given its two keys, never rebuilt.

mod queries;
mod tokens;
mod wire;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::block_tree::order_siblings;
use crate::client::LogseqClient;
use crate::edn::{BlockUuid, PageName};
use crate::errors::ToolError;
use crate::meta::ResultWarning;
use crate::tool::result_value;

use self::queries::{EMBED_DESCENDANT_LEVELS, ref_targets};
use self::tokens::{Kind, Token, clean_content, scan};
use self::wire::{RefTarget, target_rows};

/// Nesting levels followed by default (`DEFAULT_REF_DEPTH`).
pub const DEFAULT_REF_DEPTH: usize = 2;
/// Blocks one embed may show by default (`DEFAULT_EMBED_LIMIT`); the rest are cut with a warning.
pub const DEFAULT_EMBED_LIMIT: usize = 20;

/// The caps a resolution runs under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    /// Nesting levels to follow
    pub max_depth: usize,
    /// Blocks one embed may show, at least 1
    pub embed_limit: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options { max_depth: DEFAULT_REF_DEPTH, embed_limit: DEFAULT_EMBED_LIMIT }
    }
}

/// The blocks with their refs resolved, and what the caller should say about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    /// The blocks passed in, in order: copies with `resolvedContent` and `resolvedRefs` added to
    /// the blocks that hold a ref or embed
    pub blocks: Vec<Value>,
    /// Capped embeds and refs left at the depth limit, for the caller to merge into its meta
    pub warnings: Vec<ResultWarning>,
}

type Row = Arc<RefTarget>;

/// A block an embed shows: the embedded block (depth 0), its children (1), theirs (2), ...
struct EmbedMember {
    row: Row,
    depth: usize,
}

/// A page an embed shows: its entity, if the lookup found one, and its top-level blocks in order.
struct PageEmbed {
    entity: Option<Row>,
    top: Vec<Row>,
}

/// What the per-level queries found, keyed by lowercase uuid or page name.
#[derive(Default)]
struct RefStore {
    /// `None`: queried and not found
    blocks: HashMap<String, Option<Row>>,
    trees: HashMap<String, Vec<EmbedMember>>,
    pages: HashMap<String, PageEmbed>,
    /// `<kind>:<key>` of every token whose lookup got a `null` answer (#260). Not found is a
    /// different thing: that is a `None` in `blocks`, or a page with no entity. These were never
    /// looked up.
    unavailable: HashSet<String>,
}

/// Strings in the order they were first added (a set that keeps insertion order).
#[derive(Default)]
struct OrderedSet {
    items: Vec<String>,
    seen: HashSet<String>,
}

impl OrderedSet {
    fn insert(&mut self, item: &str) {
        if self.seen.insert(item.to_owned()) {
            self.items.push(item.to_owned());
        }
    }

    fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// A row LogSeq made for a `((uuid))` that no real block has (#138). LogSeq 0.10 creates a
/// placeholder entity holding just that uuid: no `:block/page`, `:block/parent` or `:block/name`,
/// and content `id:: <uuid>`. Every real block has a page, and a page has a name, so a row with
/// neither is the placeholder. Content is not the signal: a real empty block with a pinned id
/// holds the same `id::` line and must still resolve.
fn is_placeholder(row: &RefTarget) -> bool {
    row.page.as_ref().and_then(|page| page.id).is_none() && row.name.is_none()
}

/// The name of the page a block sits on.
fn page_name_of(row: Option<&RefTarget>) -> Option<String> {
    let page = row?.page.as_ref()?;
    page.original_name.clone().or_else(|| page.name.clone())
}

/// A target's text: a block's content without its `id::` line, or a page's name.
fn text_of(row: &RefTarget) -> String {
    match &row.content {
        Some(content) => clean_content(content),
        None => row.original_name.clone().or_else(|| row.name.clone()).unwrap_or_default(),
    }
}

fn sort_siblings(rows: Vec<Row>) -> Vec<Row> {
    order_siblings(rows, |row| row.id, |row| row.left_id)
}

/// Contents a token makes visible, which are the next level's refs to look for.
fn visible_texts(store: &RefStore, token: &Token, limit: usize) -> Vec<String> {
    match token.kind {
        Kind::Ref => match store.blocks.get(&token.key) {
            Some(Some(row)) => vec![text_of(row)],
            _ => Vec::new(),
        },
        Kind::BlockEmbed => store.trees.get(&token.key).map_or_else(Vec::new, |members| members.iter().take(limit).map(|m| text_of(&m.row)).collect()),
        Kind::PageEmbed => store.pages.get(&token.key).map_or_else(Vec::new, |page| page.top.iter().take(limit).map(|row| text_of(row)).collect()),
    }
}

fn walk_descendants(root: &Row, children_of: &HashMap<i64, Vec<Row>>, levels: usize) -> Vec<EmbedMember> {
    let mut members = Vec::new();
    // No visited set: the rows come from one `:find`, so each appears once with one parent, and `levels` bounds it
    fn walk(row: &Row, depth: usize, children_of: &HashMap<i64, Vec<Row>>, levels: usize, members: &mut Vec<EmbedMember>) {
        members.push(EmbedMember { row: Arc::clone(row), depth });
        if depth >= levels {
            return;
        }
        let children = children_of.get(&row.id).cloned().unwrap_or_default();
        for child in sort_siblings(children) {
            walk(&child, depth + 1, children_of, levels, members);
        }
    }
    walk(root, 0, children_of, levels, &mut members);
    members
}

fn ingest(store: &mut RefStore, rows: &[Row], block_uuids: &OrderedSet, descendant_uuids: &OrderedSet, page_names: &OrderedSet) {
    let mut by_uuid: HashMap<String, Row> = HashMap::new();
    let mut children_of: HashMap<i64, Vec<Row>> = HashMap::new();
    for row in rows {
        if let Some(uuid) = &row.uuid {
            by_uuid.insert(uuid.to_lowercase(), Arc::clone(row));
        }
        if let Some(parent_id) = row.parent_id {
            children_of.entry(parent_id).or_default().push(Arc::clone(row));
        }
    }

    // A placeholder counts as not found: its ref or embed is `missing`, not `ok` with empty text (#138)
    for uuid in &block_uuids.items {
        let row = by_uuid.get(uuid).filter(|row| !is_placeholder(row)).cloned();
        store.blocks.insert(uuid.clone(), row);
    }

    for uuid in &descendant_uuids.items {
        let root = store.blocks.get(uuid).cloned().flatten();
        if let Some(root) = root {
            store.trees.insert(uuid.clone(), walk_descendants(&root, &children_of, EMBED_DESCENDANT_LEVELS));
        }
    }

    for name in &page_names.items {
        let entity = rows.iter().find(|row| row.name.as_deref().is_some_and(|row_name| row_name.to_lowercase() == *name)).cloned();
        let top = entity.as_ref().map_or_else(Vec::new, |entity| sort_siblings(children_of.get(&entity.id).cloned().unwrap_or_default()));
        store.pages.insert(name.clone(), PageEmbed { entity, top });
    }
}

fn uuids_of(set: &OrderedSet) -> Result<Vec<BlockUuid>, ToolError> {
    // A token's uuid is strict hex, so this never fails; it is the type that says so
    set.items.iter().map(|uuid| BlockUuid::parse(uuid).map_err(ToolError::from)).collect()
}

async fn fetch_levels(client: &LogseqClient, root_texts: Vec<String>, options: Options) -> Result<RefStore, ToolError> {
    let mut store = RefStore::default();
    let mut scanned: HashSet<String> = HashSet::new();
    let mut texts = root_texts;

    let mut level = 1;
    while level <= options.max_depth && !texts.is_empty() {
        let mut block_uuids = OrderedSet::default();
        let mut descendant_uuids = OrderedSet::default();
        let mut page_names = OrderedSet::default();
        let mut visited: Vec<Token> = Vec::new();
        // The tokens this level's query answers for, so a `null` answer can be pinned on them
        let mut asked: Vec<Token> = Vec::new();

        for text in &texts {
            for found in scan(text) {
                let token = found.token;
                if !scanned.insert(token.identity()) {
                    continue;
                }
                visited.push(token.clone());

                if token.kind == Kind::PageEmbed {
                    // Scanned once, so never in `store.pages` yet. `scanned` stays: a `null` answer caches
                    // nothing, and only `scanned` stops the next level asking again (#260)
                    page_names.insert(&token.key);
                    asked.push(token);
                    continue;
                }
                let cached = store.blocks.get(&token.key);
                if matches!(cached, Some(None)) {
                    continue;
                }
                let is_cached = cached.is_some();
                if !is_cached {
                    block_uuids.insert(&token.key);
                    asked.push(token.clone());
                }
                if token.kind == Kind::BlockEmbed && !store.trees.contains_key(&token.key) {
                    descendant_uuids.insert(&token.key);
                    block_uuids.insert(&token.key);
                    if is_cached {
                        asked.push(token);
                    }
                }
            }
        }

        // A block embed's uuid is in `block_uuids` as well, so `descendant_uuids` needs no test of its own
        if !block_uuids.is_empty() || !page_names.is_empty() {
            let pages: Vec<PageName> = page_names.items.iter().map(|name| PageName::new(name)).collect();
            let query = ref_targets(&uuids_of(&block_uuids)?, &uuids_of(&descendant_uuids)?, &pages);
            let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
            match target_rows(&answer)? {
                // `null` is not `[]` (BR-0011, #260): the targets were not looked up, so none of them is "missing"
                None => store.unavailable.extend(asked.iter().map(Token::identity)),
                Some(rows) => {
                    let rows: Vec<Row> = rows.into_iter().flatten().map(Arc::new).collect();
                    ingest(&mut store, &rows, &block_uuids, &descendant_uuids, &page_names);
                }
            }
        }

        texts = visited.iter().flat_map(|token| visible_texts(&store, token, options.embed_limit)).collect();
        level += 1;
    }
    Ok(store)
}

/// One resolved ref, as `resolvedRefs` lists it (`ResolvedRef`): which target it is (`uuid`, `embed`), what it
/// resolved to (`content`, `page`), then `status`. `uuid` and `embed` are left out where they don't apply; `content`
/// and `page` are `null` when the target has none.
#[derive(Serialize)]
struct ResolvedRef {
    /// The target's uuid; none for a page embed
    #[serde(skip_serializing_if = "Option::is_none")]
    uuid: Option<String>,
    /// `block` or `page` for an embed; none for a plain ref
    #[serde(skip_serializing_if = "Option::is_none")]
    embed: Option<&'static str>,
    content: Option<String>,
    page: Option<String>,
    status: &'static str,
}

/// One entry per embed kind, target and status.
fn dedupe_refs(refs: Vec<ResolvedRef>) -> Vec<ResolvedRef> {
    let mut seen = HashSet::new();
    refs.into_iter()
        .filter(|entry| {
            let target = entry.uuid.clone().or_else(|| entry.page.as_ref().map(|page| page.to_lowercase())).unwrap_or_else(|| "undefined".to_owned());
            seen.insert(format!("{}:{target}:{}", entry.embed.unwrap_or("ref"), entry.status))
        })
        .collect()
}

/// An embed cut at the embed limit: what it is, what it shows, and the call that fetches the rest.
struct EmbedCut {
    key: String,
    what: String,
    unit: &'static str,
    fetch: String,
}

struct Renderer<'a> {
    store: &'a RefStore,
    options: Options,
    /// By `embed:<key>`, in the order first set: the same key always carries the same warning
    warnings: Vec<(String, ResultWarning)>,
    depth_limited: HashSet<String>,
    unavailable_refs: HashSet<String>,
}

impl<'a> Renderer<'a> {
    fn new(store: &'a RefStore, options: Options) -> Self {
        Renderer { store, options, warnings: Vec::new(), depth_limited: HashSet::new(), unavailable_refs: HashSet::new() }
    }

    /// Render `text`, whose own refs are at `depth`, pushing one entry per ref into `sink`.
    fn render(&mut self, text: &str, path: &[String], depth: usize, sink: &mut Vec<ResolvedRef>) -> String {
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for found in scan(text) {
            out.push_str(&text[last..found.range.start]);
            out.push_str(&self.expand(&found.token, path, depth, sink));
            last = found.range.end;
        }
        out.push_str(&text[last..]);
        out
    }

    fn all_warnings(&self) -> Vec<ResultWarning> {
        let mut warnings: Vec<ResultWarning> = self.warnings.iter().map(|(_, warning)| warning.clone()).collect();
        if !self.depth_limited.is_empty() {
            warnings.push(ResultWarning {
                code: "refs_depth_limit".into(),
                message: format!(
                    "{} reference(s) were not followed because they are more than {} levels deep. They are left as written.",
                    self.depth_limited.len(),
                    self.options.max_depth
                ),
                how_to_fetch_all: Some(
                    "Fetch each ref whose status is \"depth_limit\" with logseq_get_block (its uuid) or logseq_get_page (its page).".into(),
                ),
            });
        }
        if !self.unavailable_refs.is_empty() {
            // No howToFetchAll: no parameter fetches what LogSeq did not answer (like `pages_unavailable`)
            warnings.push(ResultWarning::new(
                "refs_unavailable",
                format!(
                    "LogSeq returned no answer when looking up {} reference(s) (possibly no graph open or a re-index in progress), \
                     so they were not resolved and are left as written with status \"unavailable\". This does not mean they are missing. \
                     Retry in a moment, or call logseq_get_graph_info to check which graph is open.",
                    self.unavailable_refs.len()
                ),
            ));
        }
        warnings
    }

    fn expand(&mut self, token: &Token, path: &[String], depth: usize, sink: &mut Vec<ResolvedRef>) -> String {
        let store = self.store;
        let is_page = token.kind == Kind::PageEmbed;
        let path_key = if is_page { format!("page:{}", token.key) } else { token.key.clone() };
        let entry = sink.len();
        sink.push(ResolvedRef {
            uuid: (!is_page).then(|| token.key.clone()),
            embed: match token.kind {
                Kind::Ref => None,
                Kind::BlockEmbed => Some("block"),
                Kind::PageEmbed => Some("page"),
            },
            content: None,
            page: is_page.then(|| token.target.clone()),
            status: "ok",
        });

        if path.contains(&path_key) {
            sink[entry].status = "cycle";
            if !is_page {
                sink[entry].page = page_name_of(store.blocks.get(&token.key).and_then(|row| row.as_deref()));
            }
            return token.raw.clone();
        }
        if store.unavailable.contains(&token.identity()) {
            // Checked before depth: it was asked for and got no answer. Not `missing`, which claims the target
            // does not exist, and not `depth_limit`, whose advice (fetch it with get_block) would not help (#272).
            // Safe at any depth: a key enters `store.unavailable` only when a level within max_depth asked for it, so
            // a copy past the limit always has a shallower twin that also reads `unavailable`, and a retry fixes both.
            sink[entry].status = "unavailable";
            self.unavailable_refs.insert(path_key);
            return token.raw.clone();
        }

        let page_target = if is_page { store.pages.get(&token.key) } else { None };
        let block_target = if is_page { None } else { store.blocks.get(&token.key) };
        if depth > self.options.max_depth || (page_target.is_none() && block_target.is_none()) {
            sink[entry].status = "depth_limit";
            self.depth_limited.insert(path_key);
            return token.raw.clone();
        }
        let found = if is_page { page_target.is_some_and(|page| page.entity.is_some()) } else { block_target.is_some_and(Option::is_some) };
        if !found {
            sink[entry].status = "missing";
            return token.raw.clone();
        }

        let mut next = path.to_vec();
        next.push(path_key.clone());
        let limit = self.options.embed_limit;
        let text = match (page_target, block_target.and_then(|row| row.as_ref())) {
            (Some(page), _) => {
                let entity = page.entity.as_ref().expect("a found page has its entity");
                let shown = &page.top[..page.top.len().min(limit)];
                let name = entity.original_name.clone().or_else(|| entity.name.clone()).unwrap_or_else(|| token.target.clone());
                sink[entry].page = Some(name.clone());
                let mut lines = Vec::with_capacity(shown.len());
                for row in shown {
                    lines.push(format!("- {}", self.render(&text_of(row), &next, depth + 1, sink)));
                }
                let mut text = lines.join("\n");
                text.push_str(&self.truncation_note(
                    EmbedCut {
                        key: path_key,
                        fetch: format!("Call logseq_get_page with page_name \"{name}\" and include_children true."),
                        what: format!("page \"{name}\""),
                        unit: "top-level blocks",
                    },
                    shown.len(),
                    page.top.len(),
                ));
                text
            }
            (None, Some(row)) if token.kind == Kind::BlockEmbed => {
                sink[entry].page = page_name_of(Some(row));
                // Set for every found block embed at the level that scanned it (a `null` answer returned above)
                let members = store.trees.get(&token.key).map_or(&[][..], Vec::as_slice);
                let shown = &members[..members.len().min(limit)];
                let mut lines = Vec::with_capacity(shown.len());
                for member in shown {
                    let rendered = self.render(&text_of(&member.row), &next, depth + 1, sink);
                    lines.push(if member.depth == 0 { rendered } else { format!("{}- {rendered}", "  ".repeat(member.depth)) });
                }
                let mut text = lines.join("\n");
                text.push_str(&self.truncation_note(
                    EmbedCut {
                        key: path_key,
                        what: format!("block {}", token.key),
                        unit: "blocks",
                        fetch: format!("Call logseq_get_block with block_uuid \"{}\" and include_children true.", token.key),
                    },
                    shown.len(),
                    members.len(),
                ));
                text
            }
            (None, Some(row)) => {
                sink[entry].page = page_name_of(Some(row)).or_else(|| row.name.as_ref().map(|name| row.original_name.clone().unwrap_or_else(|| name.clone())));
                self.render(&text_of(row), &next, depth + 1, sink)
            }
            (None, None) => unreachable!("a found target is a page or a block"),
        };
        sink[entry].content = Some(text.clone());
        text
    }

    fn truncation_note(&mut self, cut: EmbedCut, shown: usize, total: usize) -> String {
        if total <= shown {
            return String::new();
        }
        let warning = ResultWarning {
            code: "embed_truncated".into(),
            message: format!("Embed of {} shows {shown} of {total} {}.", cut.what, cut.unit),
            how_to_fetch_all: Some(cut.fetch),
        };
        let key = format!("embed:{}", cut.key);
        // The same key always carries the same warning, so setting it again changes nothing
        match self.warnings.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, existing)) => *existing = warning,
            None => self.warnings.push((key, warning)),
        }
        format!("\n[... {} more {} not shown]", total - shown, cut.unit)
    }

    /// A copy of `block` with `resolvedContent` and `resolvedRefs` when its content holds a ref or
    /// embed, and its `children` annotated the same way.
    fn annotate(&mut self, block: &Value) -> Value {
        // Not a block (an unfetched child is a `["uuid","<id>"]` tuple): pass it through as sent (BR-0007)
        let Some(map) = block.as_object() else { return block.clone() };
        let mut out = map.clone();
        if let Some(content) = map.get("content").and_then(Value::as_str).filter(|content| !scan(content).is_empty()) {
            let path: Vec<String> = map.get("uuid").and_then(Value::as_str).map(|uuid| uuid.to_lowercase()).into_iter().collect();
            let mut refs = Vec::new();
            let resolved = self.render(content, &path, 1, &mut refs);
            out.insert("resolvedContent".into(), Value::String(resolved));
            out.insert("resolvedRefs".into(), result_value(&dedupe_refs(refs)));
        }
        if let Some(children) = map.get("children").and_then(Value::as_array) {
            out.insert("children".into(), Value::Array(children.iter().map(|child| self.annotate(child)).collect()));
        }
        Value::Object(out)
    }
}

/// Every block content in these trees, nested children included.
fn collect_contents(blocks: &[Value], into: &mut Vec<String>) {
    for block in blocks {
        if let Some(content) = block.get("content").and_then(Value::as_str) {
            into.push(content.to_owned());
        }
        if let Some(children) = block.get("children").and_then(Value::as_array) {
            collect_contents(children, into);
        }
    }
}

/// Resolve the refs and embeds in `roots` and their nested `children`, with the default caps.
///
/// Returns copies with `resolvedContent` / `resolvedRefs` added to the blocks that hold a ref or
/// embed (the input is not changed, and `content` never is). Blocks without one come back as they
/// were, and when no block has one there is no API call at all. Otherwise there is at most one
/// Datalog query per level, up to the depth.
///
/// Infrastructure errors (connection, timeout, auth) and answers this server can't read
/// propagate: unresolved blocks are never returned as if nothing had gone wrong (BR-0003).
pub async fn resolve_block_refs(client: &LogseqClient, roots: &[Value]) -> Result<Resolved, ToolError> {
    resolve_block_refs_with(client, roots, Options::default()).await
}

/// [`resolve_block_refs`] under other caps.
pub async fn resolve_block_refs_with(client: &LogseqClient, roots: &[Value], options: Options) -> Result<Resolved, ToolError> {
    assert!(options.embed_limit >= 1, "Invalid embed limit: {} (expected an integer, 1 or more)", options.embed_limit);

    let mut contents = Vec::new();
    collect_contents(roots, &mut contents);
    if !contents.iter().any(|content| !scan(content).is_empty()) {
        return Ok(Resolved { blocks: roots.to_vec(), warnings: Vec::new() });
    }

    let store = fetch_levels(client, contents, options).await?;
    let mut renderer = Renderer::new(&store, options);
    let blocks = roots.iter().map(|root| renderer.annotate(root)).collect();
    Ok(Resolved { blocks, warnings: renderer.all_warnings() })
}

/// The result meta without totals, as a block or page result carries it: `hasMore`,
/// then `warnings`. Adds both to `result`, after the keys it has.
pub fn with_meta(mut result: Map<String, Value>, warnings: &[ResultWarning]) -> Map<String, Value> {
    result.insert("hasMore".into(), Value::Bool(warnings.iter().any(|warning| warning.how_to_fetch_all.is_some())));
    result.insert("warnings".into(), serde_json::to_value(warnings).expect("warnings serialize"));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::keys;

    #[test]
    fn a_resolved_ref_names_its_target_then_what_it_resolved_to_then_its_status() {
        let block = ResolvedRef { uuid: Some("u".into()), embed: Some("block"), content: Some("c".into()), page: Some("P".into()), status: "resolved" };
        assert_eq!(keys(&result_value(&block)), ["uuid", "embed", "content", "page", "status"]);
        // a plain ref has no `embed`, and a page embed has no `uuid`
        let plain = ResolvedRef { embed: None, ..block };
        assert_eq!(keys(&result_value(&plain)), ["uuid", "content", "page", "status"]);
        let page = ResolvedRef { uuid: None, embed: Some("page"), content: Some("c".into()), page: Some("P".into()), status: "resolved" };
        assert_eq!(keys(&result_value(&page)), ["embed", "content", "page", "status"]);
    }

    #[test]
    fn a_target_with_no_content_or_page_says_null_and_does_not_leave_the_key_out() {
        let missing = ResolvedRef { uuid: Some("u".into()), embed: None, content: None, page: None, status: "missing" };
        assert_eq!(serde_json::to_string(&missing).unwrap(), r#"{"uuid":"u","content":null,"page":null,"status":"missing"}"#);
    }
}
