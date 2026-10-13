//! The linked references of a page: where they are read (one Editor call, or one Datalog query over an alias group),
//! and the order they are shown in, most-linking source pages first (#178).
//!
//! Both reads give `[page, blocks]` tuples, one per source page ([`Backlink`]). The Editor call's order is LogSeq's
//! own and the alias group's is by name, and neither says which pages link most, so [`rank_backlinks`] puts that order
//! on both. It costs no call.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::block_tree::{camelize_block, camelize_keys};
use crate::client::LogseqClient;
use crate::errors::ToolError;
use crate::order;
use crate::resolve::alias::{AliasSet, linked_references_of_pages};

use super::wire::{self, Backlink, LINKED_REFERENCES_METHOD};

/// A string or number a page or block carries, as text.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// A field of an optional entity.
fn field<'a>(map: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a Value> {
    map.and_then(|map| map.get(key))
}

/// The first of `candidates` that is present (a `null` can't occur, the schema
/// refuses it).
fn first_present<'a>(candidates: impl IntoIterator<Item = Option<&'a Value>>) -> Option<&'a Value> {
    candidates.into_iter().flatten().find(|value| !value.is_null())
}

/// The name a source page ties on: `name` is lowercase, so case never decides.
fn rank_name(backlink: &Backlink) -> String {
    first_present([field(backlink.page.as_object(), "name"), field(backlink.block_page(), "name")]).map(js_string).unwrap_or_default()
}

fn rank_id(backlink: &Backlink) -> i64 {
    first_present([field(backlink.page.as_object(), "id"), field(backlink.block_page(), "id")]).and_then(crate::wire::whole_number).unwrap_or(0)
}

/// Source pages ranked by how many blocks link the target, most first (#178).
/// Ties break by page name (lowercase, plain code-unit order), then by page id, so the order is
/// the same on every run and on both paths. The blocks of each page keep the order they came in.
pub fn rank_backlinks(results: Vec<Backlink>) -> Vec<Backlink> {
    let mut keyed: Vec<(String, i64, Backlink)> = results.into_iter().map(|b| (rank_name(&b), rank_id(&b), b)).collect();
    keyed.sort_by(|a, b| {
        b.2.blocks
            .len()
            .cmp(&a.2.blocks.len())
            .then_with(|| order::by_name(&a.0, &b.0))
            .then_with(|| a.1.cmp(&b.1))
    });
    keyed.into_iter().map(|(_, _, backlink)| backlink).collect()
}

/// The `{ page, blocks }` of each source page of the aliased query, as the Editor API shapes it
/// (camelCase entities, the page nested in each block the same one).
fn group_by_source_page(rows: Vec<Option<Map<String, Value>>>) -> Vec<Backlink> {
    struct Group {
        page: Map<String, Value>,
        /// Blocks by id, in the order each id first came
        blocks: Vec<(i64, Map<String, Value>)>,
        index: HashMap<i64, usize>,
    }
    let mut groups: Vec<Group> = Vec::new();
    let mut by_page: HashMap<i64, usize> = HashMap::new();
    for row in rows.into_iter().flatten() {
        let mut block = camelize_block(&row);
        // A block with no page id has no source page
        let Some(page_id) = block.get("page").and_then(Value::as_object).and_then(|page| page.get("id")).and_then(crate::wire::whole_number) else {
            continue;
        };
        let at = *by_page.entry(page_id).or_insert_with(|| {
            let page = block.get("page").and_then(Value::as_object).expect("checked above");
            groups.push(Group { page: camelize_keys(page), blocks: Vec::new(), index: HashMap::new() });
            groups.len() - 1
        });
        let group = &mut groups[at];
        block.insert("page".to_owned(), Value::Object(group.page.clone()));
        let block_id = block.get("id").and_then(crate::wire::whole_number).unwrap_or_default();
        match group.index.get(&block_id) {
            Some(&i) => group.blocks[i].1 = block,
            None => {
                group.index.insert(block_id, group.blocks.len());
                group.blocks.push((block_id, block));
            }
        }
    }
    groups
        .into_iter()
        .map(|mut group| {
            group.blocks.sort_by_key(|(id, _)| *id);
            Backlink { page: Value::Object(group.page), blocks: group.blocks.into_iter().map(|(_, block)| Value::Object(block)).collect() }
        })
        .collect()
}

/// The linked references of a resolved page. Without aliases this is the Editor
/// API's own call for `resolved_name`, unchanged. For a page with aliases it is one Datalog query
/// over the ids of the whole group, shaped like that call's result (camelCase entities, one
/// `[page, blocks]` tuple per source page), the pages in order of name, then id. The related pages keep
/// that order, and the references are ranked ([`rank_backlinks`]).
///
/// `None` is LogSeq's `null` on either path (BR-0011, #318): no answer, which is not "nothing links
/// here". The caller says so.
pub async fn fetch_backlinks(client: &LogseqClient, resolved_name: &str, alias_set: &AliasSet) -> Result<Option<Vec<Backlink>>, ToolError> {
    if !alias_set.has_aliases() {
        let answer = client.call_api(LINKED_REFERENCES_METHOD, &[Value::from(resolved_name)]).await?;
        return Ok(wire::linked_references(answer)?);
    }
    let query = linked_references_of_pages(&alias_set.ids()?);
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    let Some(rows) = wire::block_rows(answer)? else {
        return Ok(None);
    };
    let mut groups = group_by_source_page(rows);
    groups.sort_by(by_page_name_then_id);
    Ok(Some(groups))
}

/// The order of the source pages of the aliased path: by name ([`order::by_name`]), then page id. A page
/// without a name sorts first, as the empty name.
fn by_page_name_then_id(a: &Backlink, b: &Backlink) -> Ordering {
    let name = |backlink: &Backlink| backlink.page.get("name").map(js_string).unwrap_or_default();
    let id = |backlink: &Backlink| backlink.page.get("id").and_then(crate::wire::whole_number).unwrap_or_default();
    order::by_name(&name(a), &name(b)).then_with(|| id(a).cmp(&id(b)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn block(id: i64) -> Value {
        json!({"id": id, "uuid": format!("u{id}")})
    }

    fn source(id: i64, name: &str, blocks: usize) -> Backlink {
        Backlink {
            page: json!({"id": id, "name": name, "originalName": name.to_uppercase()}),
            blocks: (0..blocks as i64).map(|i| block(id * 1000 + i)).collect(),
        }
    }

    #[test]
    fn the_aliased_groups_sort_by_name_then_id_and_a_nameless_page_sorts_first() {
        let nameless = Backlink { page: json!({"id": 9}), blocks: vec![] };
        let mut groups = vec![source(3, "z", 1), source(2, "a", 1), nameless, source(1, "a", 1)];
        groups.sort_by(by_page_name_then_id);
        let ids: Vec<i64> = groups.iter().map(|g| g.page["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, [9, 1, 2, 3]);
    }

    fn names(results: &[Backlink]) -> Vec<String> {
        results.iter().map(rank_name).collect()
    }

    #[test]
    fn pages_rank_by_block_count_then_name_then_id() {
        let ranked = rank_backlinks(vec![source(1, "b", 1), source(2, "a", 1), source(3, "c", 3), source(4, "a", 1)]);
        assert_eq!(names(&ranked), ["c", "a", "a", "b"]);
        assert_eq!(ranked.iter().map(rank_id).collect::<Vec<_>>(), [3, 2, 4, 1]);
    }

    #[test]
    fn a_tuple_with_no_page_ranks_itself_by_its_first_block() {
        let nameless = Backlink { page: Value::Null, blocks: vec![json!({"id": 1, "uuid": "u", "page": {"id": 7, "name": "z", "originalName": "Z"}})] };
        assert_eq!((rank_name(&nameless), rank_id(&nameless)), ("z".to_owned(), 7));
        let bare = Backlink { page: Value::Null, blocks: vec![] };
        assert_eq!((rank_name(&bare), rank_id(&bare)), (String::new(), 0));
    }

    #[test]
    fn ranking_is_a_total_order_that_ignores_the_order_the_pages_came_in() {
        let pages = || vec![source(5, "e", 2), source(1, "a", 2), source(3, "c", 1), source(2, "b", 1), source(4, "d", 3)];
        let forward = rank_backlinks(pages());
        let reversed = rank_backlinks(pages().into_iter().rev().collect());
        assert_eq!(forward, reversed);
        assert_eq!(names(&forward), ["d", "a", "e", "b", "c"]);
    }

    #[test]
    fn the_aliased_rows_group_by_source_page_with_blocks_sorted_and_camelized() {
        let row = |id: i64, page: i64| {
            Some(json!({"id": id, "uuid": format!("u{id}"), "path-refs": [], "page": {"id": page, "name": format!("p{page}"), "original-name": format!("P{page}"), "journal-day": 20250101}}))
                .and_then(|v| v.as_object().cloned())
        };
        let groups = group_by_source_page(vec![row(30, 2), row(20, 1), None, row(10, 2), row(20, 1)]);
        assert_eq!(groups.len(), 2);
        // the first page seen first; its blocks by id, and a repeated id once
        assert_eq!(groups[0].page, json!({"id": 2, "name": "p2", "originalName": "P2", "journalDay": 20250101}));
        assert_eq!(groups[0].blocks.iter().map(|b| b["id"].as_i64().unwrap()).collect::<Vec<_>>(), [10, 30]);
        assert_eq!(groups[1].blocks.len(), 1);
        assert_eq!(groups[0].blocks[0]["pathRefs"], json!([]));
        assert_eq!(groups[0].blocks[0]["page"], groups[0].page);
    }

    #[test]
    fn a_row_without_a_page_id_is_skipped() {
        let rows = vec![json!({"id": 1, "uuid": "u"}).as_object().cloned(), json!({"id": 2, "uuid": "u", "page": {"name": "x"}}).as_object().cloned()];
        assert!(group_by_source_page(rows).is_empty());
    }
}
