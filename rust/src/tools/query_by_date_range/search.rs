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
use regex_syntax::hir::{ClassUnicode, ClassUnicodeRange};
use serde_json::Value;

use crate::resolve::alias::AliasSet;

/// What decides whether a block matches a term.
pub struct BlockMatcher {
    /// The term, lowercase
    term: String,
    /// The group's other names, a class of characters per position: the character and everything it
    /// simple-case-folds with, as the `iu` flags of a JavaScript regular expression compare it
    other_names: Vec<Vec<ClassUnicode>>,
    /// The ids of the pages of the group
    page_ids: HashSet<i64>,
}

impl BlockMatcher {
    /// `blockMatcher(searchTerm, aliasSet)`. The term's own name stays out of the whole-word
    /// names: `includes` matches it, and a case-folding comparison would also match spellings
    /// (`ſam` for `sam`) that `includes` does not.
    pub fn new(search_term: &str, alias_set: Option<&AliasSet>) -> BlockMatcher {
        let term = search_term.to_lowercase();
        let other_names = alias_set
            .map(|set| set.members.iter().map(|member| member.name.as_str()).filter(|name| *name != term).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .map(|name| name.chars().map(folds_with).collect())
            .collect();
        let page_ids = alias_set.map(|set| set.members.iter().map(|member| member.id).collect()).unwrap_or_default();
        BlockMatcher { term, other_names, page_ids }
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
        if self.other_names.is_empty() {
            return false;
        }
        let chars: Vec<char> = content.chars().collect();
        // a match may start at any position of the text, including the end, which an empty name fits
        (0..=chars.len()).any(|start| {
            let after_word_edge = start == 0 || !is_letter_or_number(chars[start - 1]);
            after_word_edge
                && self.other_names.iter().any(|name| {
                    let end = start + name.len();
                    end <= chars.len()
                        && chars[start..end].iter().zip(name).all(|(&c, class)| class.ranges().iter().any(|r| r.start() <= c && c <= r.end()))
                        && (end == chars.len() || !is_letter_or_number(chars[end]))
                })
        })
    }
}

/// A character and every character it simple-case-folds with (`ſ`, `s` and `S`): the class the `iu`
/// flags of a JavaScript regular expression compare it by. `ß`, `İ` and `ı` fold with nothing.
fn folds_with(c: char) -> ClassUnicode {
    let mut class = ClassUnicode::new([ClassUnicodeRange::new(c, c)]);
    class.case_fold_simple();
    class
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
        let matcher = BlockMatcher::new("Atlas", None);
        assert!(matcher.matches(&block("Kickoff for PROJECT ATLAS today")));
        assert!(matcher.matches(&block("the atlases")));
        assert!(!matcher.matches(&block("nothing here")));
        assert!(!matcher.matches(&json!({"id": 1})));
    }

    #[test]
    fn another_name_of_the_group_matches_only_as_a_whole_word() {
        let group = set(&[(1, "ai"), (2, "artificial intelligence")]);
        let matcher = BlockMatcher::new("ai", Some(&group));
        // the term itself matches inside a word, as `includes` does
        assert!(matcher.matches(&block("he said so")));
        // another name must stand alone
        let matcher = BlockMatcher::new("artificial intelligence", Some(&group));
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
        let matcher = BlockMatcher::new("atlas", Some(&group));
        assert!(matcher.matches(&json!({"id": 1, "content": "unrelated", "refs": [{"id": 9}, {"id": 2}]})));
        assert!(!matcher.matches(&json!({"id": 1, "content": "unrelated", "refs": [{"id": 9}, {}]})));
        assert!(!matcher.matches(&json!({"id": 1, "content": "unrelated"})));
    }

    #[test]
    fn names_are_compared_by_simple_case_folding_not_by_lowercase_alone() {
        // `ſ` (long s) folds to `s` under the `iu` flags
        let stands = |name: &str, text: &str| {
            let group = set(&[(1, "other"), (2, name)]);
            BlockMatcher::new("other", Some(&group)).matches(&block(text))
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
        // no simple fold: dotless i (Turkic only) and sharp s
        assert!(!stands("i", "\u{131}"));
        assert!(!stands("\u{df}", "ss"));
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
