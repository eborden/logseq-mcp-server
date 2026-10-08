//! Whether a top-level block matches `search_term` (`blockMatcher` in
//! `src/tools/query-by-date-range.ts`): case-insensitive and literal.
//!
//! When the term is the name of a page that has aliases (#69), a block also matches if it
//! references any page of the group (`#tag` and `[[link]]` forms included), or if its text holds
//! one of the group's other names as a whole word. Only the term itself matches inside a word: a
//! short alias such as `AI` must not match "said". A term that is not a page name, or names a page
//! without aliases, matches exactly as before.

use std::collections::HashSet;

use icu_properties::CodePointMapData;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use regex::{Regex, RegexBuilder};
use serde_json::Value;

use crate::errors::ToolError;
use crate::resolve::alias::AliasSet;

/// What decides whether a block matches a term.
pub struct BlockMatcher {
    /// The term, lowercase
    term: String,
    /// The group's other names, each a literal that matches in any case (simple Unicode case folding)
    other_names: Vec<Regex>,
    /// The ids of the pages of the group
    page_ids: HashSet<i64>,
}

impl BlockMatcher {
    /// `blockMatcher(searchTerm, aliasSet)`. The term's own name stays out of the whole-word
    /// names: `includes` matches it, and a case-folding comparison would also match spellings
    /// (`ſam` for `sam`) that `includes` does not. Fails only for a name too long to compile.
    pub fn new(search_term: &str, alias_set: Option<&AliasSet>) -> Result<BlockMatcher, ToolError> {
        let term = search_term.to_lowercase();
        let other_names = alias_set
            .map(|set| set.members.iter().map(|member| member.name.as_str()).filter(|name| *name != term).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .map(|name| {
                RegexBuilder::new(&regex::escape(name))
                    .case_insensitive(true)
                    .build()
                    .map_err(|_| ToolError::Failed("A name of the page is too long to search for".to_owned()))
            })
            .collect::<Result<_, _>>()?;
        let page_ids = alias_set.map(|set| set.members.iter().map(|member| member.id).collect()).unwrap_or_default();
        Ok(BlockMatcher { term, other_names, page_ids })
    }

    /// Whether a block matches: its content holds the term or, as a whole word, another name of
    /// the group, or it references a page of the group (`block.refs`, bare `{ id }` objects).
    pub fn matches(&self, block: &Value) -> bool {
        let content = block.get("content").and_then(Value::as_str).unwrap_or("").to_lowercase();
        if content.contains(&self.term) || self.has_other_name_as_word(&content) {
            return true;
        }
        block
            .get("refs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|reference| reference.get("id").and_then(Value::as_f64).is_some_and(|id| self.page_ids.contains(&(id as i64))))
    }

    /// `(?<![\p{L}\p{N}])(?:name|name...)(?![\p{L}\p{N}])` with the `iu` flags, as a test: some name
    /// of the group stands in the text with no letter or digit on either side.
    fn has_other_name_as_word(&self, content: &str) -> bool {
        self.other_names.iter().any(|name| stands_alone_in(name, content))
    }
}

/// Whether `name` matches somewhere in `text` with no letter or number on either side. The regular
/// expression has no lookaround, so each match is checked here, and the search moves on one character
/// from where a match began, which finds a match that overlaps one that failed (`ab-a` in `ab-ab-a`).
fn stands_alone_in(name: &Regex, text: &str) -> bool {
    let mut from = 0;
    while let Some(found) = name.find_at(text, from) {
        let before_ok = text[..found.start()].chars().next_back().is_none_or(|c| !is_letter_or_number(c));
        let after_ok = text[found.end()..].chars().next().is_none_or(|c| !is_letter_or_number(c));
        if before_ok && after_ok {
            return true;
        }
        // an empty name matches at the end of the text too, where the search stops
        let Some(next) = text[found.start()..].chars().next() else { return false };
        from = found.start() + next.len_utf8();
    }
    false
}

/// `\p{L}` or `\p{N}`: a letter or a number in any script.
fn is_letter_or_number(c: char) -> bool {
    let category = CodePointMapData::<GeneralCategory>::new().get(c);
    GeneralCategoryGroup::Letter.contains(category) || GeneralCategoryGroup::Number.contains(category)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolve::alias::AliasMember;
    use serde_json::json;

    fn set(members: &[(i64, &str)]) -> AliasSet {
        AliasSet {
            members: members.iter().map(|(id, name)| AliasMember { id: *id, name: (*name).to_owned(), original_name: (*name).to_owned() }).collect(),
            truncated: false,
        }
    }

    fn block(content: &str) -> Value {
        json!({"id": 1, "content": content, "refs": []})
    }

    #[test]
    fn a_plain_term_matches_its_text_in_any_case_and_inside_a_word() {
        let matcher = BlockMatcher::new("Atlas", None).unwrap();
        assert!(matcher.matches(&block("Kickoff for PROJECT ATLAS today")));
        assert!(matcher.matches(&block("the atlases")));
        assert!(!matcher.matches(&block("nothing here")));
        assert!(!matcher.matches(&json!({"id": 1})));
    }

    #[test]
    fn another_name_of_the_group_matches_only_as_a_whole_word() {
        let group = set(&[(1, "ai"), (2, "artificial intelligence")]);
        let matcher = BlockMatcher::new("ai", Some(&group)).unwrap();
        // the term itself matches inside a word, as `includes` does
        assert!(matcher.matches(&block("he said so")));
        // another name must stand alone
        let matcher = BlockMatcher::new("artificial intelligence", Some(&group)).unwrap();
        assert!(matcher.matches(&block("notes on AI, mostly")));
        assert!(!matcher.matches(&block("he said so")));
        assert!(!matcher.matches(&block("domain driven")));
        assert!(matcher.matches(&block("(AI)")));
        assert!(matcher.matches(&block("ai")));
        assert!(matcher.matches(&block("ai and more")));
        assert!(!matcher.matches(&block("ai2")));
        assert!(!matcher.matches(&block("éai")));
    }

    #[test]
    fn a_block_that_references_a_page_of_the_group_matches_whatever_it_says() {
        let group = set(&[(1, "atlas"), (2, "project atlas")]);
        let matcher = BlockMatcher::new("atlas", Some(&group)).unwrap();
        assert!(matcher.matches(&json!({"id": 1, "content": "unrelated", "refs": [{"id": 9}, {"id": 2}]})));
        assert!(!matcher.matches(&json!({"id": 1, "content": "unrelated", "refs": [{"id": 9}, {}]})));
        assert!(!matcher.matches(&json!({"id": 1, "content": "unrelated"})));
    }

    #[test]
    fn names_are_compared_by_simple_case_folding_not_by_lowercase_alone() {
        // `ſ` (long s) folds to `s` under the `iu` flags
        let stands = |name: &str, text: &str| {
            let group = set(&[(1, "other"), (2, name)]);
            BlockMatcher::new("other", Some(&group)).unwrap().matches(&block(text))
        };
        assert!(stands("sam", "call \u{17f}am now"));
        assert!(stands("sam", "call SAM now"));
        // the Kelvin sign, final sigma and the two ligatures and two accented iotas whose uppercase is longer
        assert!(stands("k", "a \u{212a} b"));
        assert!(stands("\u{3c3}", "\u{3c2}"));
        assert!(stands("\u{fb05}", "\u{fb06}"));
        assert!(stands("\u{fb06}", "\u{fb05}"));
        assert!(stands("\u{1fd3}", "\u{390}"));
        assert!(stands("\u{1fe3}", "\u{3b0}"));
        // no simple fold: dotless i (Turkic only), sharp s and dotted capital I
        assert!(!stands("i", "\u{131}"));
        assert!(!stands("\u{df}", "ss"));
    }

    #[test]
    fn a_name_that_overlaps_a_failed_match_is_still_found() {
        // `ab-a` first matches at 0, followed by a letter, then again at 3, after a hyphen and at the end
        let group = set(&[(1, "other"), (2, "ab-a")]);
        let matcher = BlockMatcher::new("other", Some(&group)).unwrap();
        assert!(matcher.matches(&block("ab-ab-a")));
        assert!(!matcher.matches(&block("ab-ab")));
        // a name with a regular-expression metacharacter is a literal
        let group = set(&[(1, "other"), (2, "c++")]);
        let matcher = BlockMatcher::new("other", Some(&group)).unwrap();
        assert!(matcher.matches(&block("learn c++ today")));
        assert!(!matcher.matches(&block("learn cc today")));
    }

    #[test]
    fn a_name_too_long_to_compile_is_an_error_not_a_miss() {
        let long = "k".repeat(80_000);
        let group = set(&[(1, "other"), (2, &long)]);
        assert!(matches!(BlockMatcher::new("other", Some(&group)), Err(ToolError::Failed(_))));
    }

    #[test]
    fn letters_and_numbers_of_any_script_are_word_characters() {
        for c in ['a', 'Z', '5', '\u{e9}', '\u{4e2d}', '\u{663}', '\u{2160}'] {
            assert!(is_letter_or_number(c), "{c}");
        }
        for c in [' ', '-', '_', '(', '\u{1F680}', '\u{301}'] {
            assert!(!is_letter_or_number(c), "{c:?}");
        }
    }
}
