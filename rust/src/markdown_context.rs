//! Markdown for the context tools (#43), built on
//! the shared pieces in `crate::markdown`: `build_context` and `get_context_for_query` here, and
//! the concept network (`render_network`, #313). Same conventions: `[[Page]]` links, `- ` bullets,
//! `((uuid))` refs untouched. Warnings, `hasMore` and tips are not rendered here; the tool adds
//! them with `with_footer`.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::block_tree::build_block_trees_ordered;
use crate::entity::id_of;
use crate::js;
use crate::markdown::{OutlineOptions, page_link, page_title, property_lines, render_outline, resolved_from_line};

/// What [`render_topic_context`] takes (`ContextRenderOptions`).
#[derive(Debug, Clone, Copy)]
pub struct ContextRenderOptions {
    /// Block snippets and uuids instead of bodies
    pub compact: bool,
    /// Heading level of the title (default 1); sections go one level below it
    pub heading_level: usize,
}

impl Default for ContextRenderOptions {
    fn default() -> Self {
        ContextRenderOptions { compact: false, heading_level: 1 }
    }
}

fn heading(level: usize, text: &str) -> String {
    format!("{} {text}", "#".repeat(level.min(6)))
}

/// `count`: `shown`, or `shown of total` when the tool cut the list and knows the real count.
fn count(shown: usize, total: Option<u64>) -> String {
    match total {
        Some(total) if total > shown as u64 => format!("{shown} of {total}"),
        _ => shown.to_string(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null) | Some(Value::Bool(false)))
}

/// The number a `totals` entry holds.
fn total_of(context: &Value, key: &str) -> Option<u64> {
    context.get("totals")?.get(key)?.as_u64()
}

fn array<'a>(context: &'a Value, key: &str) -> &'a [Value] {
    context.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `blockTree`: the topic's blocks as a tree. `directBlocks` are flat Datalog pulls, in query order;
/// the `:block/parent` and `:block/left` links give back the page's order and nesting. A block whose
/// parent was cut by `max_blocks` is shown as a top-level one, and a pull with neither link is too, so
/// nothing is dropped. The trees of the pages of an alias group follow the main page's, in the order
/// each page's first top-level block came (`build_block_trees_ordered`).
fn block_tree(blocks: &[Value], page_id: i64) -> Vec<Value> {
    let with_page: Vec<Map<String, Value>> = blocks
        .iter()
        .map(|block| {
            let mut block = block.as_object().cloned().unwrap_or_default();
            if !truthy(block.get("page")) && !truthy(block.get("parent")) {
                block.insert("page".to_owned(), json!({"id": page_id}));
            }
            block
        })
        .collect();
    build_block_trees_ordered(with_page, &[page_id]).into_iter().flat_map(|(_, trees)| trees).collect()
}

/// A block as the outline lists it by itself: its own children are not part of it.
fn alone(block: &Value) -> Value {
    let mut map = block.as_object().cloned().unwrap_or_default();
    map.insert("children".to_owned(), Value::Array(Vec::new()));
    Value::Object(map)
}

/// `groupBySource`: reference blocks grouped by the page they sit on, in first-seen order.
fn group_by_source(references: &[Value]) -> Vec<(Value, Vec<Value>)> {
    let mut groups: Vec<(Value, Vec<Value>)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for reference in references {
        let page = reference.get("sourcePage").filter(|page| page.is_object()).cloned().unwrap_or_else(|| json!({}));
        // the page's id as text, else its title
        let key = id_of(Some(&page)).map_or_else(|| page_title(&page, None), |id| id.to_string());
        let at = *index.entry(key).or_insert_with(|| {
            groups.push((page.clone(), Vec::new()));
            groups.len() - 1
        });
        groups[at].1.push(reference.get("block").cloned().unwrap_or(Value::Null));
    }
    groups
}

/// `renderTopicContext`: a topic's context: title, page properties, its blocks, related pages, and
/// the blocks that reference it grouped by source page.
pub fn render_topic_context(context: &Value, options: ContextRenderOptions) -> String {
    let ContextRenderOptions { compact, heading_level } = options;
    let main = context.get("mainPage").filter(|page| page.is_object()).cloned().unwrap_or_else(|| json!({}));
    let topic = context.get("topic").and_then(Value::as_str);
    let mut lines: Vec<String> = vec![heading(heading_level, &page_title(&main, topic)), String::new()];

    if let Some(note) = resolved_from_line(context.get("resolvedFrom")) {
        lines.push(note);
        lines.push(String::new());
    }
    if let Some(temporal) = context.get("temporalContext") {
        if temporal.get("isJournal") == Some(&Value::Bool(true)) {
            if let Some(date) = temporal.get("date").and_then(crate::wire::whole_number) {
                lines.push(format!("Journal: {date}"));
                lines.push(String::new());
            }
        }
    }
    let blocks = array(context, "directBlocks");
    let page_id = id_of(Some(&main)).unwrap_or(0);
    let tree = if blocks.is_empty() { Vec::new() } else { block_tree(blocks, page_id) };
    // The pre-block's own text when it was fetched, so keys and values are shown as stored
    let props = property_lines(main.get("properties"), Some(&tree));
    if !props.lines.is_empty() {
        lines.extend(props.lines.iter().cloned());
        lines.push(String::new());
    }

    let section = heading_level + 1;

    // Blocks
    if blocks.is_empty() {
        lines.push("(this page has no blocks)".to_owned());
        lines.push(String::new());
    } else {
        // Properties are rendered above, so the block that holds them is not repeated
        let outline = render_outline(&tree, OutlineOptions { compact, skip_pre_blocks: props.from_pre_block, ..Default::default() });
        lines.push(heading(section, &format!("Blocks ({})", count(blocks.len(), total_of(context, "blocks")))));
        lines.push(String::new());
        lines.extend(outline.lines);
        lines.push(String::new());
    }

    // Related pages
    let related = array(context, "relatedPages");
    if !related.is_empty() {
        let links: Vec<String> = related
            .iter()
            .map(|entry| {
                let link = page_link(entry.get("page").unwrap_or(&Value::Null));
                match entry.get("relationshipType").and_then(Value::as_str) {
                    // the server sets `relationshipType` on every entry
                    Some("inbound") | None => link,
                    Some(other) => format!("{link} ({other})"),
                }
            })
            .collect();
        lines.push(heading(section, &format!("Related pages ({})", count(links.len(), total_of(context, "relatedPages")))));
        lines.push(String::new());
        lines.push(links.join(", "));
        lines.push(String::new());
    }

    // References, grouped by source page
    let references = array(context, "references");
    if !references.is_empty() {
        lines.push(heading(section, &format!("References ({})", count(references.len(), total_of(context, "references")))));
        lines.push(String::new());
        for (page, blocks) in group_by_source(references) {
            lines.push(heading(section + 1, &page_link(&page)));
            lines.push(String::new());
            // One bullet per referencing block; its own children are not part of the reference
            let alone: Vec<Value> = blocks.iter().map(alone).collect();
            lines.extend(render_outline(&alone, OutlineOptions { compact, ..Default::default() }).lines);
            lines.push(String::new());
        }
    }

    format!("{}\n", js::trim_end(&lines.join("\n")))
}

/// `renderQueryContext`: context for a natural-language query: the topics found, each topic's
/// context one heading level down, and the keyword search results when the query named no topic.
pub fn render_query_context(context: &Value, compact: bool) -> String {
    let query = context.get("query").and_then(Value::as_str).unwrap_or_default();
    let mut lines: Vec<String> = vec![format!("# Context for: {query}"), String::new()];
    let topics: Vec<&str> = array(context, "extractedTopics").iter().filter_map(Value::as_str).collect();
    if !topics.is_empty() {
        let links: Vec<String> = topics.iter().map(|topic| format!("[[{topic}]]")).collect();
        lines.push(format!("Topics: {}", links.join(", ")));
        lines.push(String::new());
    }

    let mut parts = vec![js::trim_end(&lines.join("\n")).to_owned()];
    let contexts = array(context, "contexts");
    for topic in contexts {
        let rendered = render_topic_context(topic, ContextRenderOptions { compact, heading_level: 2 });
        parts.push(js::trim_end(&rendered).to_owned());
    }

    if let Some(results) = context.get("searchResults").and_then(Value::as_array) {
        // Each hit carries its ((uuid)) and page, or it could not be followed up (#80)
        let alone: Vec<Value> = results.iter().map(alone).collect();
        let outline = render_outline(&alone, OutlineOptions { compact, show_uuid: true, show_page: true, ..Default::default() });
        let mut section = vec![heading(2, &format!("Search results ({})", results.len())), String::new()];
        if outline.lines.is_empty() {
            section.push("(no matches)".to_owned());
        } else {
            section.extend(outline.lines);
        }
        parts.push(section.join("\n"));
    } else if contexts.is_empty() {
        parts.push("(no results)".to_owned());
    }

    format!("{}\n", parts.join("\n\n"))
}

/// `renderNetwork`: a concept network: the pages grouped by distance from the root, then one line per
/// linked pair. `A -> B` means blocks on A reference B, `A <- B` that blocks on B reference A, and
/// `A <-> B (out/in)` both; the number is the reference count. `A` is always the page closer to the
/// root.
pub fn render_network(network: &Value) -> String {
    let nodes = array(network, "nodes");
    let depth_of = |node: &Value| node.get("depth").and_then(Value::as_i64);
    let name_of = |node: &Value| node.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
    let root = nodes.iter().find(|node| depth_of(node) == Some(0));
    let title = root.map(name_of).unwrap_or_else(|| network.get("concept").and_then(Value::as_str).unwrap_or_default().to_owned());
    let mut lines: Vec<String> = vec![format!("# Concept network: [[{title}]]"), String::new()];
    if let Some(note) = resolved_from_line(network.get("resolvedFrom")) {
        lines.push(note);
        lines.push(String::new());
    }

    // The pages by depth, each depth's pages in the order of `nodes`
    let mut by_depth: Vec<(i64, Vec<String>)> = Vec::new();
    for node in nodes {
        let Some(depth) = depth_of(node).filter(|depth| *depth != 0) else { continue };
        let link = format!("[[{}]]", name_of(node));
        match by_depth.iter_mut().find(|(seen, _)| *seen == depth) {
            Some((_, names)) => names.push(link),
            None => by_depth.push((depth, vec![link])),
        }
    }
    if by_depth.is_empty() {
        lines.push("(no linked pages)".to_owned());
        lines.push(String::new());
    }
    by_depth.sort_by_key(|(depth, _)| *depth);
    for (depth, names) in &by_depth {
        lines.push(format!("## Depth {depth} ({})", names.len()));
        lines.push(String::new());
        lines.push(names.join(", "));
        lines.push(String::new());
    }

    let names: HashMap<i64, String> = nodes.iter().filter_map(|node| Some((id_of(Some(node))?, name_of(node)))).collect();
    let number = |edge: &Value, key: &str| edge.get(key).and_then(Value::as_i64).unwrap_or(0);
    let links: Vec<String> = array(network, "edges")
        .iter()
        .filter_map(|edge| {
            let from = names.get(&number(edge, "from"))?;
            let to = names.get(&number(edge, "to"))?;
            let (outbound, inbound) = (number(edge, "outbound"), number(edge, "inbound"));
            let link = if outbound > 0 && inbound > 0 {
                format!("<-> [[{to}]] ({outbound}/{inbound})")
            } else if outbound > 0 {
                format!("-> [[{to}]] ({outbound})")
            } else {
                format!("<- [[{to}]] ({inbound})")
            };
            Some(format!("- [[{from}]] {link}"))
        })
        .collect();
    if !links.is_empty() {
        lines.push(format!("## Links ({})", links.len()));
        lines.push(String::new());
        lines.extend(links);
        lines.push(String::new());
    }

    format!("{}\n", js::trim_end(&lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID_A: &str = "11111111-1111-4111-8111-111111111111";

    /// A flat pulled block: id, parent, left, content.
    fn block(id: i64, page: i64, parent: i64, left: i64, content: &str) -> Value {
        json!({"id": id, "uuid": format!("u{id}"), "content": content, "page": {"id": page}, "parent": {"id": parent}, "left": {"id": left}})
    }

    fn context() -> Value {
        json!({
            "topic": "atlas",
            "mainPage": {"id": 10, "name": "atlas", "original-name": "Atlas", "properties": {"type": "project", "tags": ["alpha", "beta"]}},
            "directBlocks": [
                block(3, 10, 10, 2, "second top"),
                block(1, 10, 10, 10, "first top"),
                block(2, 10, 1, 1, "child of first"),
            ],
            "relatedPages": [{"page": {"id": 20, "name": "bob", "originalName": "Bob"}, "relationshipType": "inbound"}],
            "references": [
                {"block": {"id": 201, "uuid": "u201", "content": "Mentions [[Atlas]]", "children": [{"content": "not shown"}]}, "sourcePage": {"id": 20, "name": "bob", "originalName": "Bob"}},
                {"block": {"id": 301, "uuid": "u301", "content": "Also [[Atlas]]"}, "sourcePage": {"id": 30, "name": "carol", "originalName": "Carol"}},
                {"block": {"id": 202, "uuid": "u202", "content": "Again [[Atlas]]"}, "sourcePage": {"id": 20, "name": "bob", "originalName": "Bob"}},
            ],
            "totals": {"blocks": 5, "relatedPages": 1, "references": 3},
        })
    }

    #[test]
    fn blocks_are_nested_and_ordered_by_the_left_chain() {
        let tree = block_tree(context()["directBlocks"].as_array().unwrap(), 10);
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0]["content"], "first top");
        assert_eq!(tree[0]["children"][0]["content"], "child of first");
        assert_eq!(tree[1]["content"], "second top");
        assert_eq!(tree[1]["children"], json!([]));
    }

    #[test]
    fn a_block_whose_parent_was_cut_and_a_pull_with_no_links_are_top_level_ones() {
        let blocks = vec![block(7, 10, 99, 99, "orphan"), json!({"id": 8, "uuid": "u8", "content": "bare"})];
        let tree = block_tree(&blocks, 10);
        assert_eq!(tree.iter().map(|b| b["content"].as_str().unwrap()).collect::<Vec<_>>(), ["orphan", "bare"]);
        // the bare block gets the page it was asked for: a block with no page and no parent is not lost
        assert!(block_tree(&[json!({"id": 9, "uuid": "u9"})], 10).len() == 1);
    }

    #[test]
    fn the_trees_of_an_alias_group_follow_the_main_page_s_in_the_order_each_page_came() {
        let blocks = vec![block(31, 30, 30, 30, "on 30"), block(11, 10, 10, 10, "on 10"), block(21, 20, 20, 20, "on 20"), block(32, 30, 30, 31, "also on 30")];
        let tree = block_tree(&blocks, 10);
        assert_eq!(tree.iter().map(|b| b["content"].as_str().unwrap()).collect::<Vec<_>>(), ["on 10", "on 30", "also on 30", "on 20"]);
    }

    #[test]
    fn a_topic_is_a_title_properties_blocks_related_pages_and_references_by_source_page() {
        let text = render_topic_context(&context(), ContextRenderOptions::default());
        assert_eq!(
            text,
            "# Atlas\n\
             \n\
             type:: project\n\
             tags:: [[alpha]], [[beta]]\n\
             \n\
             ## Blocks (3 of 5)\n\
             \n\
             - first top\n\
             \t- child of first\n\
             - second top\n\
             \n\
             ## Related pages (1)\n\
             \n\
             [[Bob]]\n\
             \n\
             ## References (3)\n\
             \n\
             ### [[Bob]]\n\
             \n\
             - Mentions [[Atlas]]\n\
             - Again [[Atlas]]\n\
             \n\
             ### [[Carol]]\n\
             \n\
             - Also [[Atlas]]\n"
        );
    }

    #[test]
    fn a_page_with_no_blocks_says_so_and_a_journal_names_its_day() {
        let context = json!({
            "topic": "2025-01-01",
            "resolvedFrom": {"name": "2025-01-01", "matchedBy": "journal-date", "resolvedTo": "Jan 1st, 2025"},
            "mainPage": {"id": 1, "name": "jan 1st, 2025", "original-name": "Jan 1st, 2025"},
            "directBlocks": [], "relatedPages": [], "references": [],
            "temporalContext": {"isJournal": true, "date": 20250101},
        });
        assert_eq!(
            render_topic_context(&context, ContextRenderOptions::default()),
            "# Jan 1st, 2025\n\n(resolved from \"2025-01-01\", matched by journal-date)\n\nJournal: 20250101\n\n(this page has no blocks)\n"
        );
        // no mainPage name: the topic is the title
        assert!(render_topic_context(&json!({"topic": "atlas", "directBlocks": []}), ContextRenderOptions::default()).starts_with("# atlas\n"));
    }

    #[test]
    fn a_pre_block_is_the_properties_and_is_not_repeated_among_the_blocks() {
        let mut pre = block(1, 10, 10, 10, "type:: project\nstatus:: active");
        pre["pre-block?"] = json!(true);
        let context = json!({"topic": "atlas", "mainPage": {"id": 10, "name": "atlas", "properties": {"type": "project"}}, "directBlocks": [pre, block(2, 10, 10, 1, "body")]});
        let text = render_topic_context(&context, ContextRenderOptions::default());
        assert_eq!(text, "# atlas\n\ntype:: project\nstatus:: active\n\n## Blocks (2)\n\n- body\n");
    }

    #[test]
    fn compact_shows_a_snippet_and_the_uuid_and_a_heading_level_moves_the_sections() {
        let text = render_topic_context(&context(), ContextRenderOptions { compact: true, heading_level: 2 });
        assert!(text.starts_with("## Atlas\n"), "{text}");
        assert!(text.contains("\n### Blocks (3 of 5)\n\n- first top ((u1))\n\t- child of first ((u2))\n- second top ((u3))\n"), "{text}");
        assert!(text.contains("\n#### [[Bob]]\n\n- Mentions [[Atlas]] ((u201))\n- Again [[Atlas]] ((u202))\n"), "{text}");
    }

    #[test]
    fn a_non_inbound_relationship_is_named() {
        let context = json!({"topic": "t", "directBlocks": [], "relatedPages": [{"page": {"name": "x"}, "relationshipType": "outbound"}]});
        assert!(render_topic_context(&context, ContextRenderOptions::default()).contains("[[x]] (outbound)"));
    }

    #[test]
    fn a_query_lists_its_topics_then_each_context_one_level_down() {
        let query = json!({"query": "what about [[Atlas]]?", "extractedTopics": ["Atlas"], "contexts": [{"topic": "Atlas", "mainPage": {"id": 1, "name": "atlas", "originalName": "Atlas"}, "directBlocks": [block(1, 1, 1, 1, "x")], "relatedPages": [], "references": []}]});
        assert_eq!(
            render_query_context(&query, false),
            "# Context for: what about [[Atlas]]?\n\nTopics: [[Atlas]]\n\n## Atlas\n\n### Blocks (1)\n\n- x\n"
        );
        assert_eq!(render_query_context(&json!({"query": "q", "extractedTopics": [], "contexts": []}), false), "# Context for: q\n\n(no results)\n");
    }

    fn network() -> Value {
        json!({
            "concept": "atlas",
            "resolvedFrom": {"name": "atlas", "matchedBy": "alias", "resolvedTo": "Project Atlas"},
            "nodes": [
                {"id": 10, "name": "Project Atlas", "depth": 0},
                {"id": 20, "name": "Bob", "depth": 1},
                {"id": 30, "name": "Carol", "depth": 2},
                {"id": 40, "name": "Dave", "depth": 1},
            ],
            "edges": [
                {"from": 10, "to": 20, "type": "reference", "count": 5, "outbound": 3, "inbound": 2},
                {"from": 10, "to": 40, "type": "reference", "count": 1, "outbound": 1, "inbound": 0},
                {"from": 20, "to": 30, "type": "backlink", "count": 4, "outbound": 0, "inbound": 4},
                {"from": 20, "to": 99, "type": "reference", "count": 1, "outbound": 1, "inbound": 0},
            ],
            "truncated": false,
        })
    }

    #[test]
    fn a_network_is_its_pages_by_depth_then_one_line_per_linked_pair() {
        assert_eq!(
            render_network(&network()),
            "# Concept network: [[Project Atlas]]\n\
             \n\
             (resolved from \"atlas\", matched by alias)\n\
             \n\
             ## Depth 1 (2)\n\
             \n\
             [[Bob]], [[Dave]]\n\
             \n\
             ## Depth 2 (1)\n\
             \n\
             [[Carol]]\n\
             \n\
             ## Links (3)\n\
             \n\
             - [[Project Atlas]] <-> [[Bob]] (3/2)\n\
             - [[Project Atlas]] -> [[Dave]] (1)\n\
             - [[Bob]] <- [[Carol]] (4)\n"
        );
    }

    #[test]
    fn a_network_with_no_neighbours_says_so_and_has_no_links_section() {
        let alone = json!({"concept": "atlas", "nodes": [{"id": 10, "name": "Atlas", "depth": 0}], "edges": []});
        assert_eq!(render_network(&alone), "# Concept network: [[Atlas]]\n\n(no linked pages)\n");
        // no node at depth 0: the name asked for is the title
        assert!(render_network(&json!({"concept": "atlas", "nodes": [], "edges": []})).starts_with("# Concept network: [[atlas]]\n"));
    }

    #[test]
    fn keyword_hits_carry_their_uuid_and_page_and_say_when_there_are_none() {
        let hit = json!({"id": 1, "uuid": UUID_A, "content": "a hit\nover two lines", "context": {"page": {"id": 5, "name": "alice", "originalName": "Alice"}}});
        let query = json!({"query": "hit", "extractedTopics": [], "contexts": [], "searchResults": [hit]});
        assert_eq!(
            render_query_context(&query, false),
            format!("# Context for: hit\n\n## Search results (1)\n\n- a hit (({UUID_A})) (in [[Alice]])\n  over two lines\n")
        );
        assert_eq!(
            render_query_context(&query, true),
            format!("# Context for: hit\n\n## Search results (1)\n\n- a hit (({UUID_A})) (in [[Alice]])\n")
        );
        let none = json!({"query": "hit", "extractedTopics": [], "contexts": [], "searchResults": []});
        assert_eq!(render_query_context(&none, false), "# Context for: hit\n\n## Search results (0)\n\n(no matches)\n");
    }

    #[test]
    fn a_missing_query_name_or_concept_writes_nothing_where_javascript_wrote_undefined() {
        // the server sets all three on every result, so these inputs are not reached
        assert_eq!(render_query_context(&json!({"extractedTopics": [], "contexts": []}), false), "# Context for:\n\n(no results)\n");
        let nameless = json!({"nodes": [{"depth": 0}], "edges": []});
        assert_eq!(render_network(&nameless), "# Concept network: [[]]\n\n(no linked pages)\n");
        assert_eq!(render_network(&json!({"nodes": [], "edges": []})), "# Concept network: [[]]\n\n(no linked pages)\n");
    }
}
