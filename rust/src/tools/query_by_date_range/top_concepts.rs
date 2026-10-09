//! `summary.topConcepts`: the pages the returned blocks reference most . Tags, `[[links]]` and aliases all end up as `:block/refs` of the
//! same page, so they merge on page id with no parsing of content.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::entity::id_of;

/// Default for `top_concepts_limit`.
pub const DEFAULT_TOP_CONCEPTS_LIMIT: u32 = 10;

/// Pages LogSeq itself creates, which would otherwise top every ranking: the task markers (a
/// `TODO` block references the page `todo`) and the flashcard tag. Compared against the lowercase
/// `:block/name`. Journal pages are excluded separately, by their journal markers, not by name.
pub const BUILT_IN_CONCEPTS: &[&str] =
    &["todo", "doing", "done", "now", "later", "waiting", "canceled", "cancelled", "in-progress", "card"];

/// A referenced page, as pulled with each journal block (`:block/refs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConceptRef {
    pub id: i64,
    /// Original-case name
    pub name: String,
}

/// One entry of `summary.topConcepts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopConcept {
    /// Original-case page name
    pub name: String,
    /// Number of returned blocks (nested ones included) that reference the page
    pub count: usize,
    /// Number of distinct journal days those blocks are on, so `days <= count`
    pub days: usize,
}

/// The concept refs of one flat Datalog block (pulled with nested
/// `:block/refs`). Dropped: refs without a name (block refs), journal pages, and
/// [`BUILT_IN_CONCEPTS`]. Each page appears once.
pub fn extract_concept_refs(block: &Map<String, Value>) -> Vec<ConceptRef> {
    let Some(refs) = block.get("refs").and_then(Value::as_array) else { return Vec::new() };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for page in refs {
        let Some(map) = page.as_object() else { continue };
        let Some(id) = id_of(Some(page)) else { continue };
        let Some(lower_name) = map.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()) else { continue };
        if map.get("journal?") == Some(&Value::Bool(true)) || map.get("journal-day").is_some_and(|day| !day.is_null()) {
            continue;
        }
        if BUILT_IN_CONCEPTS.contains(&lower_name) || !seen.insert(id) {
            continue;
        }
        let name = map.get("original-name").and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or(lower_name);
        out.push(ConceptRef { id, name: name.to_owned() });
    }
    out
}

/// Order: count desc, then days desc, then name ([`order::by_name`]: lowercase, then exact).
fn compare_concepts(a: &TopConcept, b: &TopConcept) -> Ordering {
    b.count
        .cmp(&a.count)
        .then(b.days.cmp(&a.days))
        .then_with(|| crate::order::by_name(&a.name, &b.name))
}

struct Tally {
    name: String,
    count: usize,
    /// The days, as `YYYYMMDD` numbers
    days: HashSet<i64>,
}

/// The concepts the returned blocks reference, best first, at most `limit`.
///
/// Counts every block in the trees, children included: `count` is the number of blocks referencing
/// a page, `days` the number of distinct entries (journal days) they sit on.
///
/// `entries` are the returned journal days, each with its block trees; `refs_by_block` is
/// [`extract_concept_refs`] output keyed by block id.
pub fn roll_up_top_concepts<'a>(
    entries: impl IntoIterator<Item = (i64, &'a [Value])>,
    refs_by_block: &HashMap<i64, Vec<ConceptRef>>,
    limit: u64,
) -> Vec<TopConcept> {
    if limit == 0 {
        return Vec::new();
    }
    fn visit(blocks: &[Value], date: i64, refs_by_block: &HashMap<i64, Vec<ConceptRef>>, order: &mut Vec<i64>, tally: &mut HashMap<i64, Tally>) {
        for block in blocks {
            let block_id = block.get("id").and_then(crate::wire::whole_number);
            for concept in block_id.and_then(|id| refs_by_block.get(&id)).into_iter().flatten() {
                let slot = tally.entry(concept.id).or_insert_with(|| {
                    order.push(concept.id);
                    Tally { name: concept.name.clone(), count: 0, days: HashSet::new() }
                });
                slot.count += 1;
                slot.days.insert(date);
            }
            visit(block.get("children").and_then(Value::as_array).map_or(&[], Vec::as_slice), date, refs_by_block, order, tally);
        }
    }
    let mut order = Vec::new();
    let mut tally = HashMap::new();
    for (date, blocks) in entries {
        visit(blocks, date, refs_by_block, &mut order, &mut tally);
    }

    // `tally.values()` is in insertion order, and the sort is stable
    let mut concepts: Vec<TopConcept> = order
        .iter()
        .map(|id| &tally[id])
        .map(|slot| TopConcept { name: slot.name.clone(), count: slot.count, days: slot.days.len() })
        .collect();
    concepts.sort_by(compare_concepts);
    concepts.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    concepts
}

/// A concept as the result writes it: `name`, `count`, `days`.
pub fn concept_value(concept: &TopConcept) -> Value {
    let mut map = Map::new();
    map.insert("name".into(), Value::from(concept.name.as_str()));
    map.insert("count".into(), Value::from(concept.count));
    map.insert("days".into(), Value::from(concept.days));
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn block(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn names(refs: &[ConceptRef]) -> Vec<&str> {
        refs.iter().map(|r| r.name.as_str()).collect()
    }

    #[test]
    fn journal_pages_built_in_pages_and_blocks_are_not_concepts() {
        let refs = extract_concept_refs(&block(json!({"refs": [
            {"id": 1, "name": "project atlas", "original-name": "Project Atlas"},
            {"id": 2, "name": "jan 1st, 2025", "journal?": true},
            {"id": 3, "name": "jan 2nd, 2025", "journal-day": 20250102},
            {"id": 4, "name": "todo"},
            {"id": 5},
            {"id": 6, "name": ""},
            {"name": "no id"},
            {"id": 7, "name": "bob"},
            {"id": 1, "name": "project atlas", "original-name": "Project Atlas"},
            {"db/id": 8, "name": "carol", "original-name": ""},
            7,
        ]})));
        // each page once; the name is the original case, the lowercase one when that is empty
        assert_eq!(names(&refs), ["Project Atlas", "bob", "carol"]);
        assert_eq!(refs.iter().map(|r| r.id).collect::<Vec<_>>(), [1, 7, 8]);
        assert!(extract_concept_refs(&block(json!({"refs": "x"}))).is_empty());
        assert!(extract_concept_refs(&block(json!({}))).is_empty());
        // a journal flag that is not `true` and a null journal day leave the page in
        let kept = extract_concept_refs(&block(json!({"refs": [{"id": 1, "name": "a", "journal?": false, "journal-day": null}]})));
        assert_eq!(names(&kept), ["a"]);
    }

    fn rolled(limit: u64) -> Vec<TopConcept> {
        let refs = |ids: &[(i64, &str)]| ids.iter().map(|(id, name)| ConceptRef { id: *id, name: (*name).to_owned() }).collect::<Vec<_>>();
        let by_block: HashMap<i64, Vec<ConceptRef>> = HashMap::from([
            (1, refs(&[(10, "Atlas"), (20, "bob")])),
            (2, refs(&[(10, "Atlas")])),
            (3, refs(&[(20, "bob"), (30, "Cara")])),
            (4, refs(&[(30, "cara")])),
        ]);
        let day1 = vec![json!({"id": 1, "children": [{"id": 2, "children": []}]})];
        let day2 = vec![json!({"id": 3, "children": []}), json!({"id": 4, "children": []})];
        roll_up_top_concepts([(20250101, day1.as_slice()), (20250102, day2.as_slice())], &by_block, limit)
    }

    fn summary(concepts: &[TopConcept]) -> Vec<(String, usize, usize)> {
        concepts.iter().map(|c| (c.name.clone(), c.count, c.days)).collect()
    }

    #[test]
    fn concepts_count_nested_blocks_and_distinct_days_and_sort_by_count_then_days_then_name() {
        // all three are on 2 blocks; bob is on two days, so it leads, and Atlas comes before Cara by name
        assert_eq!(summary(&rolled(10)), [("bob".to_owned(), 2, 2), ("Atlas".to_owned(), 2, 1), ("Cara".to_owned(), 2, 1)]);
        // a page keeps the name it was first seen under
        assert_eq!(rolled(10)[2].name, "Cara");
    }

    #[test]
    fn the_limit_keeps_the_best_and_zero_keeps_none() {
        assert_eq!(summary(&rolled(2)), [("bob".to_owned(), 2, 2), ("Atlas".to_owned(), 2, 1)]);
        assert!(rolled(0).is_empty());
        assert_eq!(rolled(u64::MAX).len(), 3);
    }

    #[test]
    fn names_that_differ_only_in_case_are_ordered_lowercase_first_then_exactly() {
        let a = TopConcept { name: "alice".into(), count: 1, days: 1 };
        let b = TopConcept { name: "Alice".into(), count: 1, days: 1 };
        // equal lowercased, so the exact names decide: "A" (0x41) is below "a" (0x61)
        assert_eq!(compare_concepts(&b, &a), Ordering::Less);
        assert_eq!(compare_concepts(&a, &a), Ordering::Equal);
    }

    #[test]
    fn a_concept_is_written_as_name_count_days() {
        let concept = TopConcept { name: "Atlas".into(), count: 3, days: 2 };
        assert_eq!(concept_value(&concept).to_string(), r#"{"name":"Atlas","count":3,"days":2}"#);
    }
}
