//! What a block search suggests next. Tips are
//! built from the finished result, as JSON, never by the search itself, so the result keeps its
//! shape: they read these fields (`pageName`, `context.page`, `page`,
//! `tags`, `pageRefs`), in this order.

use serde_json::{Value, json};

use crate::js;
use crate::tips::{Kind, MAX_TIPS, suggest_call, suggest_topic};

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

/// The text, trimmed, up to the first run of white space (Rust's set).
fn first_word(query: &str) -> Option<&str> {
    let trimmed = js::trim(query);
    let word = trimmed.split(char::is_whitespace).next().unwrap_or("");
    (!word.is_empty()).then_some(word)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tips::journal_status;

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
    fn the_first_word_stops_at_white_space() {
        assert_eq!(first_word("\u{a0}one\u{3000}two"), Some("one"));
        assert_eq!(first_word("one\u{85}two"), Some("one"));
        assert_eq!(first_word("one\u{feff}two"), Some("one\u{feff}two"));
    }
}
