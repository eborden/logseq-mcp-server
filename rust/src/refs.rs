//! Reading `[[page refs]]` and `#tags` out of text: one grammar for every tool that does it
//! (slim `pageRefs` and `tags`, `get_context_for_query`'s topics, the `check_links` checks and the
//! `{{embed [[page]]}}` of `resolve_refs`).
//!
//! A page ref is `[[` + a name + `]]`. The name is one or more characters, none of them `[`, `]` or
//! a newline. LogSeq's own pattern for a ref without nesting is `\[\[([^\[\]]+)\]\]`; a newline is
//! left out as well, since a name is one line and `check_links` reads its texts a line at a time.
//! So `[[a [[b]] c]]` holds one ref, `b` (the outer name has a bracket in it), `[[[a]]` holds `a`,
//! and `[[]]`, `[[a]b]]` and `[[a\nb]]` hold none.
//!
//! Matches run left to right and don't overlap. An attempt that fails moves on one character, so a
//! ref can start inside the failed attempt.
//!
//! A tag is a `#` followed by one or more characters that are neither white space
//! ([`char::is_whitespace`]) nor `#`. The run ends at the next `#`, which starts a tag of its own,
//! and takes in everything else, so `#a,` is the tag `a,` and `#[[weekly` is the tag `[[weekly`.

use std::ops::Range;

/// A character a ref's name may hold.
pub fn is_name_char(c: char) -> bool {
    !matches!(c, '[' | ']' | '\n')
}

/// The length in bytes of the longest run of name characters at the start of `text`.
pub fn name_len(text: &str) -> usize {
    text.find(|c| !is_name_char(c)).unwrap_or(text.len())
}

/// The ref that starts `text`, if one does: its name and the text after its closing `]]`.
pub fn ref_at(text: &str) -> Option<(&str, &str)> {
    let after_open = text.strip_prefix("[[")?;
    let len = name_len(after_open);
    if len == 0 {
        return None;
    }
    let rest = after_open[len..].strip_prefix("]]")?;
    Some((&after_open[..len], rest))
}

/// A ref found in a text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRef<'a> {
    /// Where the ref sits, brackets included, as byte offsets
    pub range: Range<usize>,
    /// The name between the brackets
    pub name: &'a str,
}

/// Every ref in `text`, in order.
pub fn page_refs(text: &str) -> Vec<PageRef<'_>> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at + 1 < bytes.len() {
        // `[` is ASCII, so `at` is on a character boundary whenever it holds one
        if bytes[at] == b'[' {
            if let Some((name, rest)) = ref_at(&text[at..]) {
                let end = text.len() - rest.len();
                found.push(PageRef { range: at..end, name });
                at = end;
                continue;
            }
        }
        at += 1;
    }
    found
}

/// Every tag in `text`, without its `#`, in order.
pub fn tags(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(offset) = text[at..].find('#') {
        let start = at + offset + 1;
        let len = text[start..].find(|c: char| c == '#' || c.is_whitespace()).unwrap_or(text.len() - start);
        if len > 0 {
            found.push(&text[start..start + len]);
        }
        // The run stops before the `#` or space that ended it, so a `#` there starts the next tag
        at = start + len;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(text: &str) -> Vec<&str> {
        page_refs(text).into_iter().map(|found| found.name).collect()
    }

    #[test]
    fn a_ref_is_a_name_of_one_or_more_characters_between_double_brackets() {
        assert_eq!(names("see [[Alice]] and [[Bob Smith]]"), ["Alice", "Bob Smith"]);
        assert_eq!(names("[[ padded ]]"), [" padded "]);
        assert_eq!(names("no refs, a [single] one, ]] and [["), Vec::<&str>::new());
    }

    #[test]
    fn an_empty_or_unclosed_ref_is_not_one() {
        assert_eq!(names("[[]]"), Vec::<&str>::new());
        assert_eq!(names("[[open"), Vec::<&str>::new());
        assert_eq!(names("[[a]"), Vec::<&str>::new());
        assert_eq!(names("[["), Vec::<&str>::new());
        assert_eq!(names(""), Vec::<&str>::new());
    }

    #[test]
    fn a_bracket_in_the_name_is_no_ref() {
        assert_eq!(names("[[a]b]]"), Vec::<&str>::new());
        assert_eq!(names("[[a[b]]"), Vec::<&str>::new());
        assert_eq!(names("[[a]]]"), ["a"]);
    }

    #[test]
    fn a_failed_attempt_moves_on_one_character_so_a_ref_can_start_inside_it() {
        assert_eq!(names("[[[a]]"), ["a"]);
        assert_eq!(names("[[a[[b]]"), ["b"]);
        assert_eq!(names("[[x]b]] [[ok]]"), ["ok"]);
    }

    #[test]
    fn nested_refs_leave_the_inner_one() {
        assert_eq!(names("[[outer [[inner]] tail]]"), ["inner"]);
        assert_eq!(names("[[a [[b [[c]] d]] e]]"), ["c"]);
    }

    #[test]
    fn a_newline_ends_the_attempt() {
        assert_eq!(names("[[a\nb]]"), Vec::<&str>::new());
        assert_eq!(names("[[a\n[[b]]"), ["b"]);
        assert_eq!(names("[[a]]\n[[b]]"), ["a", "b"]);
        // a carriage return is part of a name, as the line ending of `\r\n` is read by the line
        assert_eq!(names("[[a\rb]]"), ["a\rb"]);
    }

    #[test]
    fn adjacent_refs_are_both_found_and_never_overlap() {
        assert_eq!(names("[[a]][[b]]"), ["a", "b"]);
        assert_eq!(names("[[a]]]]"), ["a"]);
        assert_eq!(names("[[a]]]]b]]"), ["a"]);
        let found = page_refs("x[[a]][[bc]]");
        assert_eq!(found.iter().map(|f| f.range.clone()).collect::<Vec<_>>(), [1..6, 6..12]);
    }

    #[test]
    fn names_may_hold_any_other_character() {
        assert_eq!(names("café [[naïve]] [[é🙂]] [[日本語/ページ]]"), ["naïve", "é🙂", "日本語/ページ"]);
        // the range is in bytes and slices back to the ref, brackets included
        let text = "é [[é🙂]] é";
        let found = page_refs(text);
        assert_eq!(&text[found[0].range.clone()], "[[é🙂]]");
        assert_eq!(names("#a [[b#c d]]"), ["b#c d"]);
    }

    #[test]
    fn ref_at_reads_only_a_ref_that_starts_the_text() {
        assert_eq!(ref_at("[[a]] tail"), Some(("a", " tail")));
        assert_eq!(ref_at(" [[a]]"), None);
        assert_eq!(ref_at("[[]]"), None);
        assert_eq!(ref_at("[[a]b]]"), None);
        assert_eq!(ref_at("[[a]]]"), Some(("a", "]")));
    }

    #[test]
    fn a_name_run_stops_at_a_bracket_or_a_newline() {
        assert_eq!(name_len("abc]]"), 3);
        assert_eq!(name_len("abc[d"), 3);
        assert_eq!(name_len("ab\nc"), 2);
        assert_eq!(name_len("é🙂"), "é🙂".len());
        assert_eq!(name_len(""), 0);
    }

    #[test]
    fn a_tag_runs_to_white_space_or_the_next_hash() {
        assert_eq!(tags("#a #b-c, # d #\u{e9}t\u{e9}\n#e"), ["a", "b-c,", "\u{e9}t\u{e9}", "e"]);
        assert_eq!(tags("###"), Vec::<&str>::new());
        assert_eq!(tags("end#"), Vec::<&str>::new());
        assert_eq!(tags("a#b#c"), ["b", "c"]);
        assert_eq!(tags(""), Vec::<&str>::new());
    }

    #[test]
    fn a_tag_at_the_end_of_a_line_or_a_text_ends_there() {
        assert_eq!(tags("done #ship\nnext"), ["ship"]);
        assert_eq!(tags("done #ship"), ["ship"]);
        assert_eq!(tags("done #ship\r\n#two"), ["ship", "two"]);
        assert_eq!(tags("tab\t#a\t#b"), ["a", "b"]);
    }

    #[test]
    fn a_tag_is_cut_at_unicode_white_space_and_keeps_unicode_names() {
        assert_eq!(tags("#a\u{a0}b #\u{3000}c"), ["a"]);
        assert_eq!(tags("#日本語 #é🙂"), ["日本語", "é🙂"]);
    }

    #[test]
    fn a_hash_before_a_bracketed_name_takes_the_brackets_up_to_white_space() {
        assert_eq!(tags("#[[weekly review]]"), ["[[weekly"]);
        assert_eq!(tags("#[[x]] y"), ["[[x]]"]);
    }
}
