//! What a property search suggests next. Tips
//! are built from the finished result, as JSON, never by the search itself. The topic worth a
//! `build_context` call is picked as it is for a block search: the same hits, the same rules.

use serde_json::{Value, json};

use crate::tips::{Kind, suggest_call, suggest_topic};

/// A read of the page or topic most matches are on, or no tip when nothing matched.
pub fn property_tips(results: &[Value]) -> Vec<String> {
    if results.is_empty() {
        return Vec::new();
    }
    match suggest_topic(results) {
        Some((name, kind)) => vec![format!(
            "To read the {}: {}.",
            match kind {
                Kind::Topic => "topic most matches mention",
                Kind::Page => "page most matches are on",
            },
            suggest_call("logseq_build_context", &json!({"topic_name": name}))
        )],
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slim(page: &str, tags: &[&str]) -> Value {
        json!({"uuid": "u", "content": "c", "pageName": page, "tags": tags})
    }

    #[test]
    fn no_match_has_no_tip() {
        assert!(property_tips(&[]).is_empty());
    }

    #[test]
    fn the_page_most_matches_are_on_is_suggested() {
        assert_eq!(
            property_tips(&[slim("Bob", &[]), slim("Alice", &[]), slim("Alice", &[])]),
            [r#"To read the page most matches are on: logseq_build_context {"topic_name":"Alice"}."#]
        );
    }

    #[test]
    fn a_tag_beats_a_page_of_unknown_kind() {
        assert_eq!(
            property_tips(&[slim("Alice", &["urgent"]), slim("Bob", &["urgent"])]),
            [r#"To read the topic most matches mention: logseq_build_context {"topic_name":"urgent"}."#]
        );
    }

    #[test]
    fn matches_that_carry_no_page_name_have_no_tip() {
        // unlike a search, which says to repeat with slim_results: a property search offers nothing here
        let hit = json!({"id": 1, "uuid": "u", "content": "c", "page": {"id": 2}});
        assert!(property_tips(&[hit]).is_empty());
    }
}
