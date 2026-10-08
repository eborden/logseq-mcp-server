//! The closest page names for a missing page (`suggestPages`, `src/utils/resolve-page.ts`), picked
//! with the `nucleo-matcher` crate.
//!
//! The list is part of a "no such page" message that the parity harness holds to rules, not to the
//! TypeScript server's bytes ([ADR-0032 (closest-page-suggestions-match-by-meaning)], Decision 3), so
//! this doesn't follow fuzzysort. What it has to give is, in order:
//! 1. the names that equal the input, ignoring case and accents (rule 4);
//! 2. then the names that start with it (rule 4);
//! 3. then the names that contain each of the input's words as a subsequence, best score first
//!    (rule 5: a listed name covers every word, so the list can't be the same three pages for every
//!    input; rule 6: such a name is never left out while there is room).
//!
//! Within the first two groups the shorter name comes first (it is the nearer one), and within the third
//! the better nucleo score does, then the shorter name. Ties keep the order `getAllPages` listed the
//! names in. Names are distinct (rule 3), and an empty name or input matches nothing.
//!
//! The words are the input split on spaces, each matched on its own as `Pattern::new` does with
//! `AtomKind::Fuzzy`, not `Pattern::parse`, so an fzf operator (`^`, `$`, `'`, `!`) is just a
//! character. `Pattern::new` still reads `\ ` as an escaped space, which would let a word match
//! text the input didn't type, so each word gets a pattern of its own and none holds a space.

use std::cmp::Reverse;
use std::collections::HashSet;

use nucleo_matcher::chars::{normalize, to_lower_case};
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use crate::js;

/// Which group a name falls in. The derived order is the order of the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Tier {
    /// The folded name equals the folded input
    Exact,
    /// The folded name starts with the folded input
    Prefix,
    /// Every word of the input is a subsequence of the name
    Fuzzy,
}

/// Lowercased, and with accents taken off the letters nucleo knows (`É` is `e`), the way the harness's
/// `fold` does it for ordinary names. Combining marks are dropped, as a name typed as `e` and U+0301 is `é`.
fn fold(text: &str) -> String {
    text.chars()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .map(|c| to_lower_case(normalize(c)))
        .collect()
}

/// The indexes into `names` of the best `limit` closest names to `input`, best first.
pub fn go(input: &str, names: &[&str], limit: usize) -> Vec<usize> {
    let input = js::trim(input);
    let words: Vec<&str> = input.split(' ').filter(|word| !word.is_empty()).collect();
    if words.is_empty() || limit == 0 {
        return Vec::new();
    }
    let patterns: Vec<Pattern> =
        words.iter().map(|word| Pattern::new(word, CaseMatching::Ignore, Normalization::Smart, AtomKind::Fuzzy)).collect();
    let wanted = fold(input);
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut buffer = Vec::new();
    let mut seen = HashSet::new();

    let mut found: Vec<(Tier, Reverse<u32>, usize, usize)> = Vec::new();
    for (index, name) in names.iter().enumerate() {
        if name.is_empty() || !seen.insert(*name) {
            continue;
        }
        let haystack = Utf32Str::new(name, &mut buffer);
        let scores: Option<Vec<u32>> =
            patterns.iter().map(|pattern| pattern.score(haystack, &mut matcher)).collect();
        let score = scores.as_ref().map_or(0, |scores| scores.iter().sum());
        let folded = fold(name);
        let tier = if folded == wanted {
            Tier::Exact
        } else if folded.starts_with(&wanted) {
            Tier::Prefix
        } else if scores.is_some() {
            Tier::Fuzzy
        } else {
            continue;
        };
        // A score only ranks the names that matched by being spread out: an exact or prefix match is as
        // close as it gets, and the shorter name is the nearer one
        let score = if tier == Tier::Fuzzy { score } else { 0 };
        found.push((tier, Reverse(score), name.chars().count(), index));
    }
    found.sort_unstable();
    found.into_iter().take(limit).map(|(_, _, _, index)| index).collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn closest<'a>(input: &str, names: &[&'a str]) -> Vec<&'a str> {
        go(input, names, 3).into_iter().map(|index| names[index]).collect()
    }

    #[test]
    fn exact_matches_come_before_prefix_matches_before_fuzzy_ones() {
        let names = ["Zed Alice", "Alice Notes", "A l i c e", "ALICE", "Alice", "Bob"];
        let listed = closest("alice", &names);
        assert_eq!(listed[2], "Alice Notes");
        assert_eq!(listed[..2].iter().copied().collect::<HashSet<_>>(), HashSet::from(["Alice", "ALICE"]));
        assert_eq!(closest("alice", &["Zed Alice", "A l i c e", "Alice Notes"])[0], "Alice Notes");
    }

    #[test]
    fn a_prefix_match_beats_a_better_scoring_fuzzy_one() {
        // "ab" is the whole of "ab" in "xab", but a prefix of "abxxxxxxxx"
        assert_eq!(closest("ab", &["xab", "abxxxxxxxx"]), ["abxxxxxxxx", "xab"]);
    }

    #[test]
    fn a_shorter_name_comes_first_among_prefix_matches() {
        assert_eq!(closest("al", &["Alice Notes", "Alan", "Albert", "Alba"]), ["Alan", "Alba", "Albert"]);
    }

    #[test]
    fn the_limit_is_kept_and_a_zero_limit_gives_none() {
        let names = ["Alice", "Alan", "Alba", "Albert"];
        assert_eq!(go("al", &names, 2).len(), 2);
        assert!(go("al", &names, 0).is_empty());
    }

    #[test]
    fn a_typo_finds_the_name_it_was_meant_for() {
        assert_eq!(closest("smth", &["Smith, Alice", "Bob", "Project Atlas"]), ["Smith, Alice"]);
    }

    #[test]
    fn every_word_of_the_input_has_to_be_covered() {
        let names = ["Project Atlas", "Project Zed", "Atlas"];
        assert_eq!(closest("proj atl", &names), ["Project Atlas"]);
        assert!(closest("proj qqq", &names).is_empty());
    }

    #[test]
    fn a_name_that_covers_no_word_order_is_still_listed_as_each_word_is_matched_alone() {
        assert_eq!(closest("atlas project", &["Project Atlas"]), ["Project Atlas"]);
    }

    #[test]
    fn case_and_accents_do_not_matter() {
        assert_eq!(closest("cafe", &["Bob", "Café Notes", "CAFÉ"]), ["CAFÉ", "Café Notes"]);
        assert_eq!(closest("CAFÉ", &["Cafe", "Bob"]), ["Cafe"]);
        // "e" followed by a combining acute accent
        assert_eq!(closest("cafe", &["Cafe\u{301}"]), ["Cafe\u{301}"]);
    }

    #[test]
    fn nothing_that_does_not_cover_the_input_is_listed() {
        assert!(closest("zzz", &["Project Atlas", "Alice", "Bob"]).is_empty());
    }

    #[test]
    fn an_empty_input_or_name_matches_nothing() {
        assert!(closest("", &["Alice"]).is_empty());
        assert!(closest("   ", &["Alice"]).is_empty());
        assert!(closest("a", &["", "Alice"]) == ["Alice"]);
    }

    #[test]
    fn a_name_listed_twice_is_listed_once() {
        assert_eq!(go("alice", &["Alice", "Alice", "Alice Notes"], 3), [0, 2]);
    }

    #[test]
    fn fzf_operators_are_plain_characters() {
        let names = ["Alice", "!Alice", "^Alice", "Alice$", "'Alice"];
        assert_eq!(closest("!alice", &names), ["!Alice"]);
        assert_eq!(closest("^alice", &names), ["^Alice"]);
        assert_eq!(closest("alice$", &names), ["Alice$"]);
        assert_eq!(closest("'alice", &names), ["'Alice"]);
    }

    #[test]
    fn a_backslash_is_not_an_escaped_space() {
        // `Pattern::new` alone would read `a\ b` as the one word "a b", which "a b" matches without any backslash
        assert!(closest("a\\ b", &["a b", "ab"]).is_empty());
        assert_eq!(closest("a\\ b", &["a\\ b"]), ["a\\ b"]);
    }

    #[test]
    fn a_character_outside_the_bmp_is_one_character() {
        assert_eq!(closest("\u{1F600}x", &["\u{1F600} x", "x"]), ["\u{1F600} x"]);
    }
}
