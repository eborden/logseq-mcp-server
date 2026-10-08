//! What a block search suggests next (`logseq_search_blocks` in `src/utils/tips.ts`). Tips are
//! built from the finished result, as JSON, never by the search itself, so the result keeps its
//! shape: they read the same fields the TypeScript tips read (`pageName`, `context.page`, `page`,
//! `tags`, `pageRefs`), in the same order.

use serde_json::{Map, Value, json};

use crate::js;
use crate::tips::{MAX_TIPS, suggest_call};

fn as_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `nonEmptyString`: a string that isn't blank, as it is.
fn non_empty(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !js::trim(text).is_empty())
}

/// The name a page-like object carries: its original name in either spelling, else its name.
fn name_of_page<'v>(page: Option<&'v Map<String, Value>>) -> Option<&'v str> {
    let page = page?;
    non_empty(page.get("originalName")).or_else(|| non_empty(page.get("original-name"))).or_else(|| non_empty(page.get("name")))
}

/// `pageNameOf`: the page name of a block in the shapes the tools return: slim blocks (`pageName`),
/// search context (`context.page`), and a full block's own `page`.
fn page_name_of(block: &Value) -> Option<&str> {
    let block = block.as_object()?;
    let context_page = as_object(as_object(block.get("context")).and_then(|context| context.get("page")));
    non_empty(block.get("pageName"))
        .or_else(|| name_of_page(context_page))
        .or_else(|| name_of_page(as_object(block.get("page"))))
}

/// `journalStatus`: whether the page behind a block is a journal date page. True or false when the
/// block carries a page entity with a name, `None` when only a name (a slim block) or a bare id is
/// known.
fn journal_status(block: &Value) -> Option<bool> {
    let block = as_object(Some(block))?;
    let context_page = as_object(as_object(block.get("context")).and_then(|context| context.get("page")));
    let page = [context_page, as_object(block.get("page"))].into_iter().flatten().find(|page| name_of_page(Some(page)).is_some())?;
    let set = |key: &str| page.get(key).is_some_and(|value| !value.is_null());
    Some(
        page.get("isJournal") == Some(&Value::Bool(true))
            || set("journalDate")
            || page.get("journal?") == Some(&Value::Bool(true))
            || page.get("journal") == Some(&Value::Bool(true))
            || set("journalDay")
            || set("journal-day"),
    )
}

/// `topicsOf`: the topic names a block mentions: its `#tags` and `[[page refs]]` (slim blocks), and
/// `context.tags`.
fn topics_of(block: &Value) -> Vec<&str> {
    let Some(block) = block.as_object() else { return Vec::new() };
    let context_tags = as_object(block.get("context")).and_then(|context| context.get("tags"));
    [block.get("tags"), block.get("pageRefs"), context_tags]
        .into_iter()
        .flat_map(|list| list.and_then(Value::as_array).into_iter().flatten())
        .filter_map(|topic| non_empty(Some(topic)))
        .collect()
}

/// `mostCommon`: the most frequent value; the first one seen wins a tie.
fn most_common<'v>(values: impl IntoIterator<Item = &'v str>) -> Option<&'v str> {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for value in values {
        match counts.iter_mut().find(|(seen, _)| *seen == value) {
            Some((_, count)) => *count += 1,
            None => counts.push((value, 1)),
        }
    }
    let mut best: Option<&str> = None;
    let mut best_count = 0;
    for (value, count) in counts {
        if count > best_count {
            best = Some(value);
            best_count = count;
        }
    }
    best
}

enum Kind {
    Page,
    Topic,
}

/// `suggestTopic`: the topic worth a `build_context` call for a set of hit blocks. Most hits sit on
/// journal date pages, which make the least informative next step, so in order:
/// 1. the page most hits are on, among pages known not to be journals;
/// 2. the `#tag` or `[[ref]]` most hits mention (slim hits carry no journal flag);
/// 3. the most common page whose kind is unknown (its journal flag isn't in the hit);
/// 4. a journal page, only when nothing else is available.
fn suggest_topic(blocks: &[Value]) -> Option<(&str, Kind)> {
    let named: Vec<(&str, Option<bool>)> =
        blocks.iter().filter_map(|block| page_name_of(block).map(|name| (name, journal_status(block)))).collect();

    let non_journal = most_common(named.iter().filter(|(_, journal)| *journal == Some(false)).map(|(name, _)| *name));
    if let Some(name) = non_journal {
        return Some((name, Kind::Page));
    }
    if let Some(topic) = most_common(blocks.iter().flat_map(topics_of)) {
        return Some((topic, Kind::Topic));
    }
    if let Some(name) = most_common(named.iter().filter(|(_, journal)| journal.is_none()).map(|(name, _)| *name)) {
        return Some((name, Kind::Page));
    }
    most_common(named.iter().map(|(name, _)| *name)).map(|name| (name, Kind::Page))
}

/// Tips for a finished search: for a miss, a shorter word and a page-name search; otherwise a read
/// of the page or topic most results are on. `matches` is `totals.matches`, which tells a real miss
/// from `limit: 0`, which also returns nothing.
pub fn search_tips(query: &str, results: &[Value], matches: Option<usize>) -> Vec<String> {
    let mut tips = Vec::new();
    if results.is_empty() {
        // An empty array is a miss only if nothing matched
        if matches.is_some_and(|matches| matches > 0) {
            return tips;
        }
        let word = (!js::trim(query).is_empty()).then(|| first_word(query)).flatten();
        tips.push(format!(
            "No match. Search is literal (no synonyms): try a shorter or different word{}",
            match word {
                Some(word) => format!(", or {}.", suggest_call("logseq_list_pages", &json!({"name_contains": word}))),
                None => ".".to_owned(),
            }
        ));
    } else {
        tips.push(match suggest_topic(results) {
            Some((name, kind)) => format!(
                "To read the {}: {}.",
                match kind {
                    Kind::Topic => "topic most results mention",
                    Kind::Page => "page most results are on",
                },
                suggest_call("logseq_build_context", &json!({"topic_name": name}))
            ),
            None => "Results carry page ids only. Repeat with slim_results: true to get page names, then logseq_build_context on one."
                .to_owned(),
        });
    }
    tips.truncate(MAX_TIPS);
    tips
}

/// `query.trim().split(/\s+/)[0]`: the text up to the first run of white space.
fn first_word(query: &str) -> Option<&str> {
    let trimmed = js::trim(query);
    let word = trimmed.split(js::is_js_space).next().unwrap_or("");
    (!word.is_empty()).then_some(word)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slim(page: &str, tags: &[&str]) -> Value {
        json!({"uuid": "u", "content": "c", "pageName": page, "tags": tags})
    }

    fn page_tip(name: &str) -> String {
        format!("To read the page most results are on: logseq_build_context {{\"topic_name\":\"{name}\"}}.")
    }

    #[test]
    fn a_miss_suggests_a_shorter_word_and_a_page_name_search() {
        assert_eq!(
            search_tips("  importer rows ", &[], Some(0)),
            [r#"No match. Search is literal (no synonyms): try a shorter or different word, or logseq_list_pages {"name_contains":"importer"}."#]
        );
        assert_eq!(
            search_tips("   ", &[], None),
            ["No match. Search is literal (no synonyms): try a shorter or different word."]
        );
        // limit 0 returns nothing but did match
        assert!(search_tips("x", &[], Some(4)).is_empty());
    }

    #[test]
    fn the_page_most_hits_are_on_is_suggested_and_a_tie_goes_to_the_first_seen() {
        let hits = [slim("Bob", &[]), slim("Alice", &[]), slim("Alice", &[]), slim("Bob", &[])];
        // slim hits carry no journal flag, so the kind of page is unknown; no tags, so the unknown page wins
        assert_eq!(search_tips("x", &hits, Some(4)), [page_tip("Bob")]);
        assert_eq!(search_tips("x", &hits[1..3], Some(2)), [page_tip("Alice")]);
    }

    #[test]
    fn a_tag_beats_a_page_of_unknown_kind() {
        let hits = [slim("Alice", &["urgent"]), slim("Bob", &["urgent", "later"])];
        assert_eq!(
            search_tips("x", &hits, Some(2)),
            [r#"To read the topic most results mention: logseq_build_context {"topic_name":"urgent"}."#]
        );
    }

    #[test]
    fn a_page_known_not_to_be_a_journal_beats_everything_else() {
        let journal = json!({"uuid": "a", "content": "c", "context": {"page": {"name": "jan 1st, 2025", "originalName": "Jan 1st, 2025", "isJournal": true}, "tags": ["t"]}});
        let plain = json!({"uuid": "b", "content": "c", "context": {"page": {"name": "alice", "originalName": "Alice"}}});
        assert_eq!(search_tips("x", &[journal.clone(), journal.clone(), plain], Some(3)), [page_tip("Alice")]);
        assert_eq!(
            search_tips("x", &[journal], Some(1)),
            [r#"To read the topic most results mention: logseq_build_context {"topic_name":"t"}."#]
        );
    }

    #[test]
    fn a_full_hit_names_its_page_by_the_original_name_and_counts_as_no_journal() {
        // a full block carries `page: {id, name, original-name}`, and no journal key: the tip reads it as a plain page
        let hit = json!({"id": 1, "uuid": "u", "content": "c", "page": {"id": 2, "name": "alice", "original-name": "Alice"}});
        assert_eq!(search_tips("x", &[hit], Some(1)), [page_tip("Alice")]);
        assert_eq!(journal_status(&json!({"page": {"id": 2}})), None);
    }

    #[test]
    fn hits_with_no_page_name_say_so() {
        let hit = json!({"id": 1, "uuid": "u", "content": "c", "page": {"id": 2}});
        assert_eq!(
            search_tips("x", &[hit], Some(1)),
            ["Results carry page ids only. Repeat with slim_results: true to get page names, then logseq_build_context on one."]
        );
    }

    #[test]
    fn the_first_word_stops_at_javascript_white_space() {
        assert_eq!(first_word("\u{a0}one\u{3000}two"), Some("one"));
        assert_eq!(first_word("one\u{85}two"), Some("one\u{85}two"));
    }
}
