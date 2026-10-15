//! The closest page names for a missing page, picked with the `nucleo-matcher` crate.
//!
//! The list is part of a "no such page" message that the parity harness holds to rules, not to a
//! recorded list of names ([ADR-0034 (golden-results-are-the-contract)], Decision 4), so
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
//! Every comparison is made on folded text, and the fold is the harness's: trim, Unicode NFD, drop the
//! marks, lowercase. nucleo's own normalization is off (`Normalization::Never`, `CaseMatching::Respect`,
//! and none of its Unicode features). Its table is wrong for Latin Extended Additional in 0.3.1 (`ạ`
//! becomes `o`), it doesn't split letters the way NFD does (`ø`), and `Normalization::Smart` turns it off
//! for a word that holds an accent. What nucleo is left to do is the subsequence match and the score, over
//! text that is already folded.
//!
//! The words are the folded input split on spaces, one `Atom` each, built by `Atom::new` with no escape
//! processing and `AtomKind::Fuzzy`, so an fzf operator (`^`, `$`, `'`, `!`) or a backslash is just a
//! character.

use std::cmp::Reverse;
use std::collections::HashSet;

use icu_normalizer::{DecomposingNormalizer, DecomposingNormalizerBorrowed};
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use icu_properties::{CodePointMapData, CodePointMapDataBorrowed};
use nucleo_matcher::pattern::{Atom, AtomKind, CaseMatching, Normalization};
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

/// The harness's `fold(s)`: trim, NFD, drop the general category Mark (`\p{M}`), lowercase.
struct Folder {
    nfd: DecomposingNormalizerBorrowed<'static>,
    categories: CodePointMapDataBorrowed<'static, GeneralCategory>,
}

impl Folder {
    fn new() -> Self {
        Self { nfd: DecomposingNormalizer::new_nfd(), categories: CodePointMapData::<GeneralCategory>::new() }
    }

    fn fold(&self, text: &str) -> String {
        let decomposed = self.nfd.normalize(js::trim(text));
        let unmarked: String =
            decomposed.chars().filter(|c| !GeneralCategoryGroup::Mark.contains(self.categories.get(*c))).collect();
        unmarked.to_lowercase()
    }
}

/// The indexes into `names` of the best `limit` closest names to `input`, best first.
pub fn go(input: &str, names: &[&str], limit: usize) -> Vec<usize> {
    let folder = Folder::new();
    let wanted = folder.fold(input);
    let atoms: Vec<Atom> = wanted
        .split(' ')
        .filter(|word| !word.is_empty())
        .map(|word| Atom::new(word, CaseMatching::Respect, Normalization::Never, AtomKind::Fuzzy, false))
        .collect();
    if atoms.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut buffer = Vec::new();
    let mut seen = HashSet::new();

    let mut found: Vec<(Tier, Reverse<u32>, usize, usize)> = Vec::new();
    for (index, name) in names.iter().enumerate() {
        if name.is_empty() || !seen.insert(*name) {
            continue;
        }
        let folded = folder.fold(name);
        let haystack = Utf32Str::new(&folded, &mut buffer);
        let scores: Option<Vec<u32>> = atoms.iter().map(|atom| atom.score(haystack, &mut matcher).map(u32::from)).collect();
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
        let score = if tier == Tier::Fuzzy { scores.map_or(0, |scores| scores.iter().sum()) } else { 0 };
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
    fn an_accent_on_the_input_still_matches_a_name_without_it() {
        // one word, then a word of two, in a name that has no accent at all
        assert_eq!(closest("cfé", &["Cafe", "Bob"]), ["Cafe"]);
        assert_eq!(closest("menu café", &["Cafe Menu", "Bob"]), ["Cafe Menu"]);
        assert_eq!(closest("bayes naïve", &["naive bayes", "Bob"]), ["naive bayes"]);
        // typed with a combining accent, as macOS often gives it
        let listed = closest("menu cafe\u{301}", &["Café Menu", "Cafe Menu", "Bob"]);
        assert_eq!(listed.iter().copied().collect::<HashSet<_>>(), HashSet::from(["Café Menu", "Cafe Menu"]));
    }

    #[test]
    fn latin_extended_additional_letters_fold_as_nfd_does() {
        // nucleo-matcher 0.3.1's own table maps `ạ` to `o` and `ḍ` to `i`
        assert_eq!(closest("nguyen", &["Nguyễn", "Bob"]), ["Nguyễn"]);
        assert_eq!(closest("viet", &["Việt Nam", "Bob"]), ["Việt Nam"]);
        assert_eq!(closest("ha noi", &["Hà Nội", "Bob"]), ["Hà Nội"]);
        assert!(closest("mo", &["Mạ"]).is_empty());
        assert_eq!(closest("ma", &["Mạ"]), ["Mạ"]);
    }

    #[test]
    fn a_letter_nfd_does_not_split_stays_itself() {
        // `ø` has no decomposition: "bjorn" doesn't cover "Bjørn", and "bjørn" does
        assert!(closest("bjorn", &["Bjørn", "Bob"]).is_empty());
        assert_eq!(closest("bjørn", &["Bjørn", "Bob"]), ["Bjørn"]);
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
    fn a_name_is_trimmed_as_the_harness_does() {
        assert_eq!(closest("alice", &[" Alice ", "Bob"]), [" Alice "]);
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
    fn a_backslash_is_a_plain_character() {
        // `a\ b` is the words `a\` and `b`: "a b" has no backslash, and a word with one doubles nothing
        assert!(closest("a\\ b", &["a b", "ab"]).is_empty());
        assert_eq!(closest("a\\ b", &["a\\ b"]), ["a\\ b"]);
        assert_eq!(closest("menu café\\x", &["café\\x menu", "Bob"]), ["café\\x menu"]);
    }

    #[test]
    fn a_character_outside_the_bmp_is_one_character() {
        assert_eq!(closest("\u{1F600}x", &["\u{1F600} x", "x"]), ["\u{1F600} x"]);
    }
}
