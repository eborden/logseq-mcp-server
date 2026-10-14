//! What a block search suggests next. Tips are
//! built from the finished result, as JSON, never by the search itself, so the result keeps its
//! shape: they read these fields (`pageName`, `context.page`, `page`,
//! `tags`, `pageRefs`), in this order. One set of tips serves every filter, since the result has one shape.

use serde_json::{Value, json};

use crate::js;
use crate::tips::{Kind, MAX_TIPS, suggest_call, suggest_topic};

/// The filters other than `text` a search had, which the tip for a miss names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Others {
    pub property: bool,
    pub period: bool,
    /// The search was limited to the blocks on a page
    pub page: bool,
    /// The search needed links to some pages
    pub links_to: bool,
}

/// Tips for a finished search: for a miss, a shorter word and a page-name search (when the search had a `text`) or a
/// reminder of how the `others` match; otherwise a read of the page or topic most results are on. `matches` is
/// `totals.matches`, which tells a real miss from `limit: 0`, which also returns nothing, and from a cursor past the
/// last match.
pub fn find_tips(text: Option<&str>, others: Others, results: &[Value], matches: Option<usize>) -> Vec<String> {
    let mut tips = Vec::new();
    if results.is_empty() {
        // An empty array is a miss only if nothing matched
        if matches.is_some_and(|matches| matches > 0) {
            return tips;
        }
        tips.push(match text {
            Some(text) => {
                let word = (!js::trim(text).is_empty()).then(|| first_word(text)).flatten();
                format!(
                    "No match. Search is literal (no synonyms): try a shorter or different word{}",
                    match word {
                        Some(word) => format!(", or {}.", suggest_call("logseq_find_pages", &json!({"text": word}))),
                        None => ".".to_owned(),
                    }
                )
            }
            None => format!("No match. {}: loosen a filter.", how_the_filters_match(others)),
        });
    } else {
        tips.push(match suggest_topic(results) {
            Some((name, kind)) => format!(
                "To read the {}: {}.",
                match kind {
                    Kind::Topic => "topic most results mention",
                    Kind::Page => "page most results are on",
                },
                suggest_call("logseq_explore_context", &json!({"page": name}))
            ),
            None => "Results carry page ids only. Repeat with slim_results: true to get page names, then logseq_explore_context on one."
                .to_owned(),
        });
    }
    tips.truncate(MAX_TIPS);
    tips
}

/// How each filter besides `text` matches, as one sentence: a property is exact, a period is journals only, a page is
/// where the block was written, and a link is a `[[link]]` or a `#tag`, never the words. The filters that were given
/// are listed in that order, with "and" before the last.
fn how_the_filters_match(others: Others) -> String {
    let mut notes = Vec::new();
    if others.property {
        notes.push("A property value must equal the stored text");
    }
    if others.period {
        notes.push("A period covers journal blocks only");
    }
    if others.page {
        notes.push("A page covers the blocks written on it and on its aliases");
    }
    if others.links_to {
        notes.push("A link is a [[link]] or a #tag, not plain words, and every links_to page is needed");
    }
    let lowered = |note: &str| note.chars().next().map_or_else(String::new, |initial| format!("{}{}", initial.to_lowercase(), &note[initial.len_utf8()..]));
    match notes.split_first() {
        None => "No filter besides text was given".to_owned(),
        Some((only, [])) => (*only).to_owned(),
        Some((first, rest)) => {
            let (last, middle) = rest.split_last().expect("a second note");
            let middle: String = middle.iter().map(|note| format!(", {}", lowered(note))).collect();
            format!("{first}{middle}, and {}", lowered(last))
        }
    }
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
        format!("To read the page most results are on: logseq_explore_context {{\"page\":\"{name}\"}}.")
    }

    #[test]
    fn a_miss_suggests_a_shorter_word_and_a_page_name_search() {
        assert_eq!(
            find_tips(Some("  importer rows "), Others::default(), &[], Some(0)),
            [r#"No match. Search is literal (no synonyms): try a shorter or different word, or logseq_find_pages {"text":"importer"}."#]
        );
        assert_eq!(
            find_tips(Some("   "), Others::default(), &[], None),
            ["No match. Search is literal (no synonyms): try a shorter or different word."]
        );
        // limit 0 returns nothing but did match
        assert!(find_tips(Some("x"), Others::default(), &[], Some(4)).is_empty());
    }

    #[test]
    fn a_miss_with_no_text_says_how_the_other_filters_match_and_has_no_word_to_suggest() {
        let said = |property: bool, period: bool| find_tips(None, Others { property, period, ..Others::default() }, &[], Some(0));
        assert_eq!(said(true, true), ["No match. A property value must equal the stored text, and a period covers journal blocks only: loosen a filter."]);
        assert_eq!(said(true, false), ["No match. A property value must equal the stored text: loosen a filter."]);
        assert_eq!(said(false, true), ["No match. A period covers journal blocks only: loosen a filter."]);
        // a page and links to pages say how they match, after the others, and three notes read as a list
        let pages = Others { page: true, links_to: true, ..Others::default() };
        assert_eq!(
            find_tips(None, pages, &[], Some(0)),
            ["No match. A page covers the blocks written on it and on its aliases, and a link is a [[link]] or a #tag, not plain words, and every links_to page is needed: loosen a filter."]
        );
        let three = Others { property: true, period: true, links_to: true, page: false };
        assert_eq!(
            find_tips(None, three, &[], Some(0)),
            ["No match. A property value must equal the stored text, a period covers journal blocks only, and a link is a [[link]] or a #tag, not plain words, and every links_to page is needed: loosen a filter."]
        );
        // matches that a cursor read past are no miss
        assert!(find_tips(None, Others::default(), &[], Some(4)).is_empty());
    }

    #[test]
    fn the_page_most_hits_are_on_is_suggested_and_a_tie_goes_to_the_first_seen() {
        let hits = [slim("Bob", &[]), slim("Alice", &[]), slim("Alice", &[]), slim("Bob", &[])];
        // slim hits carry no journal flag, so the kind of page is unknown; no tags, so the unknown page wins
        assert_eq!(find_tips(Some("x"), Others::default(), &hits, Some(4)), [page_tip("Bob")]);
        assert_eq!(find_tips(Some("x"), Others::default(), &hits[1..3], Some(2)), [page_tip("Alice")]);
    }

    #[test]
    fn a_tag_beats_a_page_of_unknown_kind() {
        let hits = [slim("Alice", &["urgent"]), slim("Bob", &["urgent", "later"])];
        assert_eq!(
            find_tips(Some("x"), Others::default(), &hits, Some(2)),
            [r#"To read the topic most results mention: logseq_explore_context {"page":"urgent"}."#]
        );
    }

    #[test]
    fn a_page_known_not_to_be_a_journal_beats_everything_else() {
        let journal = json!({"uuid": "a", "content": "c", "context": {"page": {"name": "jan 1st, 2025", "originalName": "Jan 1st, 2025", "isJournal": true}, "tags": ["t"]}});
        let plain = json!({"uuid": "b", "content": "c", "context": {"page": {"name": "alice", "originalName": "Alice"}}});
        assert_eq!(find_tips(Some("x"), Others::default(), &[journal.clone(), journal.clone(), plain], Some(3)), [page_tip("Alice")]);
        assert_eq!(
            find_tips(Some("x"), Others::default(), &[journal], Some(1)),
            [r#"To read the topic most results mention: logseq_explore_context {"page":"t"}."#]
        );
    }

    #[test]
    fn a_full_hit_names_its_page_by_the_original_name_and_counts_as_no_journal() {
        // a full block carries `page: {id, name, original-name}`, and no journal key: the tip reads it as a plain page
        let hit = json!({"id": 1, "uuid": "u", "content": "c", "page": {"id": 2, "name": "alice", "original-name": "Alice"}});
        assert_eq!(find_tips(Some("x"), Others::default(), &[hit], Some(1)), [page_tip("Alice")]);
        assert_eq!(journal_status(&json!({"page": {"id": 2}})), None);
    }

    #[test]
    fn hits_with_no_page_name_say_so() {
        let hit = json!({"id": 1, "uuid": "u", "content": "c", "page": {"id": 2}});
        assert_eq!(
            find_tips(Some("x"), Others::default(), &[hit], Some(1)),
            ["Results carry page ids only. Repeat with slim_results: true to get page names, then logseq_explore_context on one."]
        );
    }

    #[test]
    fn the_first_word_stops_at_white_space() {
        assert_eq!(first_word("\u{a0}one\u{3000}two"), Some("one"));
        assert_eq!(first_word("one\u{85}two"), Some("one"));
        assert_eq!(first_word("one\u{feff}two"), Some("one\u{feff}two"));
    }
}
