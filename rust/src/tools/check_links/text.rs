//! The checks of `logseq_check_links` that read only the two texts (checks 1, 2 and 4 of
//! `src/tools/check-links.ts`). Each matches the script it replaced, regex for regex, and the
//! crate has no regex engine, so the three patterns are scanned by hand.
//!
//! The texts are read as `char`s. The TypeScript code counts UTF-16 code units, but every position
//! it reports is a whole code point (it steps back from the middle of a surrogate pair), and two
//! strings first differ at the same code point however it is counted, so a `char` index is the
//! same position.

use std::collections::HashMap;

use serde::Serialize;

use crate::js;

/// Characters of context an excerpt keeps before and after the position it points at.
const EXCERPT_BEFORE: usize = 30;
const EXCERPT_AFTER: usize = 50;

/// Where the stripped texts first differ. Excerpts are of the texts with brackets removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProseDifference {
    /// 1-based line of the first difference
    pub line: usize,
    /// 1-based column on that line, in characters (code points)
    pub column: usize,
    /// That stretch of `before`, brackets removed
    pub before: String,
    /// That stretch of `after`, brackets removed
    pub after: String,
}

/// Check 1: stripping `[[ ]]` from both texts leaves them identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProseCheck {
    pub ok: bool,
    /// Absent when the prose is preserved
    #[serde(rename = "firstDifference", skip_serializing_if = "Option::is_none")]
    pub first_difference: Option<ProseDifference>,
}

/// The first line where a `[[` opens inside another, and the stretch around it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Nested {
    pub line: usize,
    pub excerpt: String,
}

/// Check 2: as many `[[` as `]]`, and no `[[` opened inside another on the same line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BracketCheck {
    pub ok: bool,
    /// `[[` in `after`
    pub opens: usize,
    /// `]]` in `after`
    pub closes: usize,
    /// Absent when nothing nests
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nested: Option<Nested>,
}

/// A ref that was in `before` and is in `after` fewer times.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemovedRef {
    /// The term as `before` first spells it
    pub term: String,
    /// Refs to that name in `before`, in any casing
    pub before: usize,
    /// Refs to it in `after`, fewer than in `before`
    pub after: usize,
}

/// Check 4: every `[[term]]` in `before` is still a ref in `after`, as many times.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RefsPreservedCheck {
    pub ok: bool,
    pub removed: Vec<RemovedRef>,
}

/// Each `[[term]]` of the text as a `(start, end)` range of `chars`, brackets included: the
/// script's `\[\[([^\[\]]+)\]\]`, which perl and grep apply one line at a time, so
/// `/\[\[([^\[\]\n]+)\]\]/g`. Matches don't overlap, and a failed attempt moves on one character.
fn link_ranges(chars: &[char]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut at = 0;
    while at + 1 < chars.len() {
        if chars[at] == '[' && chars[at + 1] == '[' {
            let term_start = at + 2;
            let term_end = term_start + chars[term_start..].iter().take_while(|c| !matches!(c, '[' | ']' | '\n')).count();
            if term_end > term_start && chars.get(term_end) == Some(&']') && chars.get(term_end + 1) == Some(&']') {
                ranges.push((at, term_end + 2));
                at = term_end + 2;
                continue;
            }
        }
        at += 1;
    }
    ranges
}

/// The term between the brackets of a range of [`link_ranges`].
fn term_of(chars: &[char], (start, end): (usize, usize)) -> String {
    chars[start + 2..end - 2].iter().collect()
}

/// `stripBrackets`: `[[term]]` to `term`, one pass, as the script's `s/\[\[([^\[\]]+)\]\]/$1/g`.
pub fn strip_brackets(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for range in link_ranges(&chars) {
        out.extend(&chars[at..range.0]);
        out.push_str(&term_of(&chars, range));
        at = range.1;
    }
    out.extend(&chars[at..]);
    out
}

/// A `[[term]]` count per term as written, in the order each term first appears.
pub fn link_counts(text: &str) -> Vec<(String, usize)> {
    let chars: Vec<char> = text.chars().collect();
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for range in link_ranges(&chars) {
        let term = term_of(&chars, range);
        match index.get(&term) {
            Some(&at) => counts[at].1 += 1,
            None => {
                index.insert(term.clone(), counts.len());
                counts.push((term, 1));
            }
        }
    }
    counts
}

/// The page name a term links to (`keyOf`): trimmed and lowercased, as LogSeq trims ref names and
/// stores `:block/name` lowercase. This is one place where the tool departs from the script, which
/// lowercases without trimming: `[[ Alice ]]` resolves to `Alice` here.
pub fn key_of(term: &str) -> String {
    js::trim(term).to_lowercase()
}

/// Refs per page name (`key_of` of each term), however each copy is spelled, in the order each name
/// first appears.
pub fn key_counts(text: &str) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for (term, count) in link_counts(text) {
        let key = key_of(&term);
        match index.get(&key) {
            Some(&at) => counts[at].1 += count,
            None => {
                index.insert(key.clone(), counts.len());
                counts.push((key, count));
            }
        }
    }
    counts
}

/// The last newline before `index`. There is none before index 0.
fn last_newline_before(chars: &[char], index: usize) -> Option<usize> {
    chars[..index].iter().rposition(|c| *c == '\n')
}

/// `excerpt`: the stretch of the line around `index`, cut to the excerpt window, in whole code points.
fn excerpt(chars: &[char], index: usize) -> String {
    let start = last_newline_before(chars, index).map_or(0, |at| at + 1);
    let end = chars[index..].iter().position(|c| *c == '\n').map_or(chars.len(), |at| index + at);
    let head = &chars[start..index];
    let tail = &chars[index..end];
    let left: String = if head.len() > EXCERPT_BEFORE {
        format!("...{}", head[head.len() - EXCERPT_BEFORE..].iter().collect::<String>())
    } else {
        head.iter().collect()
    };
    let right: String = if tail.len() > EXCERPT_AFTER {
        format!("{}...", tail[..EXCERPT_AFTER].iter().collect::<String>())
    } else {
        tail.iter().collect()
    };
    left + &right
}

/// `position`: 1-based line and code-point column of `index`.
fn position(chars: &[char], index: usize) -> (usize, usize) {
    let before = &chars[..index];
    let line_start = before.iter().rposition(|c| *c == '\n').map_or(0, |at| at + 1);
    (before.iter().filter(|c| **c == '\n').count() + 1, index - line_start + 1)
}

/// Check 1.
pub fn check_prose(before: &str, after: &str) -> ProseCheck {
    let a: Vec<char> = strip_brackets(before).chars().collect();
    let b: Vec<char> = strip_brackets(after).chars().collect();
    if a == b {
        return ProseCheck { ok: true, first_difference: None };
    }
    // a and b differ, so this stops at or before the first difference: past the end of one, its
    // character is missing and the other's is not
    let at = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let (line, column) = position(&a, at);
    ProseCheck {
        ok: false,
        first_difference: Some(ProseDifference { line, column, before: excerpt(&a, at), after: excerpt(&b, at) }),
    }
}

/// The start of the first `[[` opened before the previous one closed on its line: the script's
/// `\[\[[^][]*\[\[`, which can't run past a newline (`/\[\[[^\[\]\n]*\[\[/`).
fn first_nested(chars: &[char]) -> Option<usize> {
    (0..chars.len().saturating_sub(1)).find(|&at| {
        if chars[at] != '[' || chars[at + 1] != '[' {
            return false;
        }
        let run_end = at + 2 + chars[at + 2..].iter().take_while(|c| !matches!(c, '[' | ']' | '\n')).count();
        chars.get(run_end) == Some(&'[') && chars.get(run_end + 1) == Some(&'[')
    })
}

/// Check 2.
pub fn check_brackets(after: &str) -> BracketCheck {
    let opens = after.matches("[[").count();
    let closes = after.matches("]]").count();
    let chars: Vec<char> = after.chars().collect();
    let nested = first_nested(&chars).map(|at| Nested { line: position(&chars, at).0, excerpt: excerpt(&chars, at) });
    BracketCheck { ok: opens == closes && nested.is_none(), opens, closes, nested }
}

/// Check 4. Refs are counted per page name (`key_of`), the way LogSeq matches them, so a ref that
/// moves to a mention spelled in another case is kept. A removed ref is reported by its first
/// spelling in `before`. Respelling a ref in place still fails, through check 1.
pub fn check_refs_preserved(before: &str, after: &str) -> RefsPreservedCheck {
    let kept: HashMap<String, usize> = key_counts(after).into_iter().collect();
    let mut spelling: HashMap<String, String> = HashMap::new();
    for (term, _) in link_counts(before) {
        spelling.entry(key_of(&term)).or_insert(term);
    }
    let mut removed: Vec<RemovedRef> = Vec::new();
    for (key, count) in key_counts(before) {
        let left = kept.get(&key).copied().unwrap_or(0);
        if left < count {
            removed.push(RemovedRef { term: spelling[&key].clone(), before: count, after: left });
        }
    }
    removed.sort_by(|x, y| x.term.cmp(&y.term));
    RefsPreservedCheck { ok: removed.is_empty(), removed }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(text: &str) -> Vec<(&'static str, usize)> {
        link_counts(text).into_iter().map(|(term, n)| (Box::leak(term.into_boxed_str()) as &'static str, n)).collect()
    }

    #[test]
    fn a_link_has_one_or_more_characters_and_no_bracket_or_newline_inside() {
        assert_eq!(counts("a [[Alice]] b [[Bob]] [[Alice]]"), [("Alice", 2), ("Bob", 1)]);
        assert_eq!(counts("[[]] [[a\nb]] [[a[b]] [[a]b]]"), []);
        // a failed attempt moves on one character, so a link can start inside the failure
        assert_eq!(counts("[[[a]]"), [("a", 1)]);
        assert_eq!(counts("[[a[[b]]"), [("b", 1)]);
        assert_eq!(counts("[[ a ]] [[é🙂]]"), [(" a ", 1), ("é🙂", 1)]);
    }

    #[test]
    fn stripping_brackets_keeps_everything_else() {
        assert_eq!(strip_brackets("x [[Alice]] y [[ ]] [[a[[b]]"), "x Alice y   [[ab");
        assert_eq!(strip_brackets("no links ]] [["), "no links ]] [[");
    }

    #[test]
    fn a_key_is_the_trimmed_lowercase_name_and_counts_merge_spellings() {
        assert_eq!(key_of(" Alice\n"), "alice");
        assert_eq!(key_counts("[[Alice]] [[alice]] [[ ALICE ]] [[Bob]]"), [("alice".to_owned(), 3), ("bob".to_owned(), 1)]);
    }

    #[test]
    fn equal_prose_passes_and_a_difference_says_where() {
        assert_eq!(check_prose("a b", "a [[b]]"), ProseCheck { ok: true, first_difference: None });
        let check = check_prose("one\ntwo three", "one\ntwo thrae");
        assert_eq!(
            check.first_difference,
            Some(ProseDifference { line: 2, column: 8, before: "two three".into(), after: "two thrae".into() })
        );
        assert!(!check.ok);
    }

    #[test]
    fn one_text_a_prefix_of_the_other_differs_where_the_shorter_ends() {
        let check = check_prose("abc", "abcd");
        assert_eq!(check.first_difference, Some(ProseDifference { line: 1, column: 4, before: "abc".into(), after: "abcd".into() }));
    }

    #[test]
    fn a_difference_in_the_second_half_of_a_pair_points_at_the_pair() {
        // U+1F600 and U+1F601 share their first UTF-16 unit, and the position steps back to the pair
        let check = check_prose("a\u{1F600}b", "a\u{1F601}b");
        assert_eq!(
            check.first_difference,
            Some(ProseDifference { line: 1, column: 2, before: "a\u{1F600}b".into(), after: "a\u{1F601}b".into() })
        );
    }

    #[test]
    fn an_excerpt_is_thirty_characters_before_and_fifty_after() {
        let before = format!("{}X{}", "a".repeat(40), "b".repeat(60));
        let after = format!("{}Y{}", "a".repeat(40), "b".repeat(60));
        let difference = check_prose(&before, &after).first_difference.unwrap();
        assert_eq!(difference.column, 41);
        assert_eq!(difference.before, format!("...{}X{}...", "a".repeat(30), "b".repeat(49)));
        assert_eq!(difference.after, format!("...{}Y{}...", "a".repeat(30), "b".repeat(49)));
    }

    #[test]
    fn a_difference_at_a_leading_newline_has_an_empty_excerpt() {
        // the line a leading newline sits on is empty, whether or not index 0 looks for a newline before it
        let difference = check_prose("\nx", "y").first_difference.unwrap();
        assert_eq!((difference.line, difference.column), (1, 1));
        assert_eq!(difference.before, "");
        assert_eq!(difference.after, "y");
    }

    #[test]
    fn brackets_balance_and_do_not_nest() {
        assert_eq!(check_brackets("[[a]] and [[b]]"), BracketCheck { ok: true, opens: 2, closes: 2, nested: None });
        let unbalanced = check_brackets("[[a]] and [[b");
        assert_eq!((unbalanced.ok, unbalanced.opens, unbalanced.closes), (false, 2, 1));
        let nested = check_brackets("fine [[a]]\nbad [[a [[b]] c]]");
        assert!(!nested.ok);
        assert_eq!(nested.nested, Some(Nested { line: 2, excerpt: "bad [[a [[b]] c]]".to_owned() }));
        // a newline between the two ends the run: not nested, though unbalanced
        assert_eq!(check_brackets("[[a\n[[b]]").nested, None);
        // non-overlapping, left to right
        assert_eq!(check_brackets("[[[").opens, 1);
    }

    #[test]
    fn a_removed_ref_is_reported_by_its_first_spelling_and_in_code_point_order() {
        let check = check_refs_preserved("[[Zed]] [[bob]] [[Bob]] [[Alice]]", "Zed [[BOB]] [[Alice]]");
        assert!(!check.ok);
        assert_eq!(
            check.removed,
            [
                RemovedRef { term: "Zed".into(), before: 1, after: 0 },
                RemovedRef { term: "bob".into(), before: 2, after: 1 },
            ]
        );
        assert!(check_refs_preserved("[[Alice]]", "[[alice]] and [[Alice]]").ok);
        assert!(check_refs_preserved("plain", "[[plain]]").ok);
    }

    #[test]
    fn removed_refs_are_in_code_point_order_so_an_astral_character_follows_a_fullwidth_one() {
        // UTF-16 units would put U+1F600 (D83D DE00) before U+FF41; its code point is after
        let check = check_refs_preserved("[[\u{1F600}]] [[\u{FF41}]]", "none");
        assert_eq!(check.removed.iter().map(|r| r.term.as_str()).collect::<Vec<_>>(), ["\u{FF41}", "\u{1F600}"]);
    }

    #[test]
    fn each_check_says_whether_it_passed_before_its_detail() {
        fn written<T: serde::Serialize>(check: &T) -> String {
            serde_json::to_string(check).unwrap()
        }
        assert_eq!(written(&check_prose("a", "a")), r#"{"ok":true}"#);
        assert_eq!(
            written(&check_prose("a", "b")),
            r#"{"ok":false,"firstDifference":{"line":1,"column":1,"before":"a","after":"b"}}"#
        );
        assert_eq!(written(&check_brackets("[[a")), r#"{"ok":false,"opens":1,"closes":0}"#);
        assert_eq!(
            written(&check_brackets("[[a [[b]]")),
            r#"{"ok":false,"opens":2,"closes":1,"nested":{"line":1,"excerpt":"[[a [[b]]"}}"#
        );
        assert_eq!(written(&check_refs_preserved("[[a]]", "a")), r#"{"ok":false,"removed":[{"term":"a","before":1,"after":0}]}"#);
    }
}
