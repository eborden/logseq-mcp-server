//! Reading `[[page refs]]` and `#tags` out of text: one grammar for every tool that does it
//! (slim `pageRefs` and `tags`, `get_context_for_query`'s topics, the `check_links` checks and the
//! `{{embed [[page]]}}` of `resolve_refs`).
//!
//! A page ref is `[[` + a name + `]]`. The name is one or more characters, none of them `[`, `]` or
//! a newline. LogSeq's own pattern for a ref without nesting is `\[\[([^\[\]]+)\]\]`; a newline is
//! left out as well, since a name is one line and `check_links` reads its texts a line at a time.
//! So `[[[a]]` holds `a`, and `[[]]`, `[[a]b]]` and `[[a\nb]]` hold none.
//!
//! A ref may hold refs: `[[a [[b]] c]]` is the page `a [[b]] c`, and the `[[b]]` inside it is the
//! page `b`. Both are refs, so refs can overlap, and [`page_refs`] lists the outer ref before the
//! ones inside it (by where each starts). An outer ref is listed only when it has text of its own,
//! a character that is not white space outside its nested refs. A wrapper with none, `[[[[b]]]]` or
//! `[[ [[b]] ]]`, is only the page `b`. A ref is closed on its line: an outer ref with no closing
//! `]]`, or one that runs over a newline, is no ref, though refs closed inside it still are. A
//! stray `[` or `]` inside an outer ref (one that is not half of `[[` or `]]`) makes it no ref, as
//! it does for a name without nesting.
//!
//! Matches run left to right. An attempt that fails moves on one character, so a ref can start
//! inside the failed attempt: `[[a[[b]]` holds `b`, and `[[[a]]` holds `a`.
//!
//! A tag is a `#` followed by one or more characters that are neither white space
//! ([`char::is_whitespace`]) nor `#`. The run ends at the next `#`, which starts a tag of its own,
//! and takes in everything else, so `#a,` is the tag `a,`.
//!
//! A bracketed tag, `#[[tag with spaces]]`, is another spelling of `#abc` for a name with spaces.
//! It is one tag whose text is the name between the brackets (no `#`, no brackets), under the name
//! grammar of a ref: one or more characters that are not `[`, `]` or a newline, closed by `]]` on
//! the same line. The ref scanner is unchanged: the same text still holds the ref `tag with spaces`.
//! A `#[[` with no closing `]]` on its line falls back to the run rule, so `#[[weekly` is the tag
//! `[[weekly`, as it always was.

use std::collections::HashMap;
use std::ops::Range;

/// A character a ref's name may hold.
pub fn is_name_char(c: char) -> bool {
    !matches!(c, '[' | ']' | '\n')
}

/// The length in bytes of the longest run of name characters at the start of `text`.
pub fn name_len(text: &str) -> usize {
    text.find(|c| !is_name_char(c)).unwrap_or(text.len())
}

/// The ref without nesting that starts `text`, if one does: its name and the text after its closing
/// `]]`.
fn leaf_ref_at(text: &str) -> Option<(&str, &str)> {
    let after_open = text.strip_prefix("[[")?;
    let len = name_len(after_open);
    if len == 0 {
        return None;
    }
    let rest = after_open[len..].strip_prefix("]]")?;
    Some((&after_open[..len], rest))
}

/// The ref that starts `text`, if one does: its name and the text after its closing `]]`. One with
/// nesting counts when [`page_refs`] lists it, so a wrapper with no text of its own is none.
pub fn ref_at(text: &str) -> Option<(&str, &str)> {
    if let Some(found) = leaf_ref_at(text) {
        return Some(found);
    }
    if !text.starts_with("[[") {
        return None;
    }
    // A ref never runs over a newline, so the scan is of the line only
    let line = &text[..text.find('\n').unwrap_or(text.len())];
    let outer = page_refs(line).into_iter().next().filter(|found| found.range.start == 0)?;
    Some((outer.name, &text[outer.range.end..]))
}

/// A ref found in a text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRef<'a> {
    /// Where the ref sits, brackets included, as byte offsets
    pub range: Range<usize>,
    /// The name between the brackets
    pub name: &'a str,
}

/// A ref that closes where it starts, as the attempts to read one find it.
#[derive(Debug, Clone, Copy)]
struct Closed {
    /// Where the closing `]]` ends
    end: usize,
    /// Whether [`page_refs`] lists it: it holds no ref, or it has text of its own
    listed: bool,
}

/// The attempt to read a ref that starts at `at` (where `[[` is), calling `on_child` with the start
/// of each ref inside it. `closed` holds what the attempts at every later start found. A start of
/// `[[` inside this one that closed nothing fails it, since its name would hold a stray bracket.
fn attempt(text: &str, at: usize, closed: &HashMap<usize, Closed>, mut on_child: impl FnMut(usize)) -> Option<Closed> {
    let bytes = text.as_bytes();
    let mut i = at + 2;
    let mut own_text = false;
    let mut nested = false;
    loop {
        match *bytes.get(i)? {
            b'[' if bytes.get(i + 1) == Some(&b'[') => {
                let child = closed.get(&i)?;
                on_child(i);
                nested = true;
                i = child.end;
            }
            b']' if bytes.get(i + 1) == Some(&b']') => {
                // `[[]]` has no name
                if i == at + 2 {
                    return None;
                }
                return Some(Closed { end: i + 2, listed: !nested || own_text });
            }
            b'[' | b']' | b'\n' => return None,
            _ => {
                // `i` is on a character boundary: it only steps over whole characters and refs
                let c = text[i..].chars().next()?;
                own_text |= !c.is_whitespace();
                i += c.len_utf8();
            }
        }
    }
}

/// Every ref in `text`, an outer ref before the refs inside it, in order of where each starts.
pub fn page_refs(text: &str) -> Vec<PageRef<'_>> {
    let bytes = text.as_bytes();
    // `[` is ASCII, so each of these is on a character boundary
    let opens: Vec<usize> = (0..bytes.len().saturating_sub(1)).filter(|&at| bytes[at] == b'[' && bytes[at + 1] == b'[').collect();
    // Right to left, so each attempt finds the refs inside it settled. An attempt reads its own
    // characters once and steps over the refs inside it, so the whole is linear in the text.
    let mut closed: HashMap<usize, Closed> = HashMap::new();
    for &at in opens.iter().rev() {
        if let Some(found) = attempt(text, at, &closed, |_| {}) {
            closed.insert(at, found);
        }
    }
    // Left to right: a ref starts where the last one ended or later. What is inside a ref is found
    // by reading it again, on a stack so a deep nest can't overflow the call stack.
    let mut found = Vec::new();
    let mut resume = 0;
    for &top in &opens {
        let Some(&outermost) = closed.get(&top).filter(|_| top >= resume) else { continue };
        resume = outermost.end;
        let mut pending = vec![top];
        while let Some(start) = pending.pop() {
            let Some(this) = attempt(text, start, &closed, |child| pending.push(child)) else { continue };
            if this.listed {
                found.push(PageRef { range: start..this.end, name: &text[start + 2..this.end - 2] });
            }
        }
    }
    found.sort_by_key(|found| found.range.start);
    found
}

/// Every tag in `text`, without its `#`, in order. A bracketed tag, `#[[tag with spaces]]`, is one
/// tag whose text is the name between the brackets.
pub fn tags(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(offset) = text[at..].find('#') {
        let start = at + offset + 1;
        // A name that follows the ref grammar, closed on its line. Without a closing `]]` the run
        // rule below reads `#[[weekly` as it always did.
        if let Some((name, rest)) = leaf_ref_at(&text[start..]) {
            found.push(name);
            at = text.len() - rest.len();
            continue;
        }
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
    fn a_ref_holding_a_ref_is_a_page_and_the_inner_one_is_another() {
        assert_eq!(names("[[a [[b]] c]]"), ["a [[b]] c", "b"]);
        assert_eq!(names("[[outer [[inner]] tail]]"), ["outer [[inner]] tail", "inner"]);
        // outer first, by where each starts, and each range slices back to its own brackets
        let text = "x [[a [[b]] c]] y";
        let found = page_refs(text);
        assert_eq!(found.iter().map(|f| f.range.clone()).collect::<Vec<_>>(), [2..15, 6..11]);
        assert_eq!(&text[found[0].range.clone()], "[[a [[b]] c]]");
        assert_eq!(&text[found[1].range.clone()], "[[b]]");
        // nothing changes for refs that don't nest
        assert_eq!(names("[[a]] [[b]]"), ["a", "b"]);
        assert_eq!(names("[[a]][[b]]"), ["a", "b"]);
    }

    #[test]
    fn two_levels_of_nesting_list_each_ref_by_where_it_starts() {
        assert_eq!(names("[[a [[b [[c]] ]] ]]"), ["a [[b [[c]] ]] ", "b [[c]] ", "c"]);
        assert_eq!(names("[[a [[b [[c]] d]] e]]"), ["a [[b [[c]] d]] e", "b [[c]] d", "c"]);
        // siblings inside one outer ref, in order, and refs after it
        assert_eq!(names("[[x [[a]] y [[b]] z]] [[c]]"), ["x [[a]] y [[b]] z", "a", "b", "c"]);
        // a nested ref that closes right where its outer one does
        assert_eq!(names("[[a [[b]]]]"), ["a [[b]]", "b"]);
        assert_eq!(names("[[[[a]]b]]"), ["[[a]]b", "a"]);
    }

    #[test]
    fn a_wrapper_with_no_text_of_its_own_is_only_the_refs_inside_it() {
        assert_eq!(names("[[[[b]]]]"), ["b"]);
        assert_eq!(names("[[ [[b]] ]]"), ["b"]);
        assert_eq!(names("[[ [[a]] [[b]] ]]"), ["a", "b"]);
        assert_eq!(names("[[\t[[b]]\r ]]"), ["b"]);
        assert_eq!(names("[[[[a]][[b]]]]"), ["a", "b"]);
        // a wrapper of wrappers
        assert_eq!(names("[[ [[ [[b]] ]] ]]"), ["b"]);
        // text of its own, however little, makes the outer a page
        assert_eq!(names("[[x[[b]]]]"), ["x[[b]]", "b"]);
        assert_eq!(names("[[ [[b]] .]]"), [" [[b]] .", "b"]);
        assert_eq!(names("[[\u{a0}[[b]]]]"), ["b"]);
    }

    #[test]
    fn an_outer_ref_that_is_not_closed_on_its_line_is_none_but_the_refs_inside_it_still_are() {
        assert_eq!(names("[[a [[b]] c"), ["b"]);
        assert_eq!(names("[[a [[b]]"), ["b"]);
        assert_eq!(names("[[a [[b c]]"), ["b c"]);
        assert_eq!(names("[[a [[b]]\nc]]"), ["b"]);
        assert_eq!(names("[[a\n[[b]] c]]"), ["b"]);
        // a nested ref across a newline is no ref, so it fails its outer one too
        assert_eq!(names("[[a [[b\nc]] d]]"), Vec::<&str>::new());
        assert_eq!(names("[[a [[b]] c]]\n[[d [[e]] f]]"), ["a [[b]] c", "b", "d [[e]] f", "e"]);
    }

    #[test]
    fn a_stray_bracket_inside_an_outer_ref_makes_it_none() {
        assert_eq!(names("[[a [[b]] ] c]]"), ["b"]);
        assert_eq!(names("[[a [ [[b]] c]]"), ["b"]);
        assert_eq!(names("[[a [[b]] c]]]"), ["a [[b]] c", "b"]);
        // a nested ref that is no ref fails its outer one: `[[[b]]` closes nothing at its first `[[`
        assert_eq!(names("[[x [[[b]] y]]"), ["b"]);
    }

    #[test]
    fn a_deep_or_unclosed_nest_is_read_without_deep_calls_or_repeated_work() {
        let depth = 20_000;
        let deep = format!("{}b{}", "[[a ".repeat(depth), "]] ".repeat(depth));
        let found = page_refs(&deep);
        assert_eq!(found.len(), depth);
        assert_eq!(found[0].range, 0..deep.trim_end().len());
        assert_eq!(found[depth - 1].name, "a b");
        // never closed: nothing, and not one attempt per start over the whole text
        assert_eq!(page_refs(&"[[a ".repeat(depth)), Vec::new());
        assert_eq!(page_refs(&"[[".repeat(depth)), Vec::new());
        let one_line = format!("{}]]", "[[a ".repeat(depth));
        assert_eq!(names(&one_line), ["a "]);
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
    fn ref_at_reads_an_outer_ref_with_text_of_its_own_and_not_a_wrapper() {
        assert_eq!(ref_at("[[a [[b]] c]] tail"), Some(("a [[b]] c", " tail")));
        assert_eq!(ref_at("[[a [[b [[c]] ]] ]]x"), Some(("a [[b [[c]] ]] ", "x")));
        // a wrapper is only the ref inside it, and that one does not start the text
        assert_eq!(ref_at("[[[[b]]]]"), None);
        assert_eq!(ref_at("[[ [[b]] ]]"), None);
        // not closed on the line, or a stray bracket
        assert_eq!(ref_at("[[a [[b]] c"), None);
        assert_eq!(ref_at("[[a [[b]]\nc]]"), None);
        assert_eq!(ref_at("[[a [[b]] ] c]]"), None);
        // only the line is read: a later line does not close it
        assert_eq!(ref_at("[[a [[b]] c\n]]"), None);
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
    fn a_hash_before_a_bracketed_name_is_one_tag_of_that_name() {
        assert_eq!(tags("#[[tag with spaces]]"), ["tag with spaces"]);
        assert_eq!(tags("#[[weekly review]]"), ["weekly review"]);
        assert_eq!(tags("#[[x]] y"), ["x"]);
        assert_eq!(tags("#abc"), ["abc"]);
        // the ref scanner is unchanged: the same text holds the ref of that name
        assert_eq!(names("#[[tag with spaces]]"), ["tag with spaces"]);
    }

    #[test]
    fn a_bracketed_tag_without_its_closing_brackets_is_a_run_to_white_space() {
        assert_eq!(tags("#[[weekly"), ["[[weekly"]);
        assert_eq!(tags("#[[weekly review"), ["[[weekly"]);
        assert_eq!(tags("#[[a]b]]"), ["[[a]b]]"]);
        // a name does not run over a newline, so the line has no closing brackets
        assert_eq!(tags("#[[a\nb]]"), ["[[a"]);
        assert_eq!(tags("#[[a b\n]] c"), ["[[a"]);
        // a closed one on a later line is read there
        assert_eq!(tags("#[[a\n#[[b c]]"), ["[[a", "b c"]);
    }

    #[test]
    fn a_hash_before_brackets_at_the_end_of_the_text_is_the_run() {
        assert_eq!(tags("#[["), ["[["]);
        assert_eq!(tags("x #["), ["["]);
        assert_eq!(tags("#[[]]"), ["[[]]"]);
        assert_eq!(tags("#[[a]"), ["[[a]"]);
        assert_eq!(tags("#[[a]]"), ["a"]);
    }

    #[test]
    fn several_bracketed_tags_and_plain_ones_on_one_line_are_each_read() {
        assert_eq!(tags("#[[a b]] #[[c d]]"), ["a b", "c d"]);
        assert_eq!(tags("#[[a b]]#[[c d]]"), ["a b", "c d"]);
        assert_eq!(tags("#[[a b]] #c #[[d e]] #f"), ["a b", "c", "d e", "f"]);
        assert_eq!(tags("#plain #[[a b]]"), ["plain", "a b"]);
        assert_eq!(tags("#[[a b]]#c"), ["a b", "c"]);
        // what follows the closing brackets is not part of the tag
        assert_eq!(tags("#[[a b]]c"), ["a b"]);
        assert_eq!(tags("#[[a b]],"), ["a b"]);
    }

    #[test]
    fn a_bracketed_tag_name_holds_any_character_a_ref_name_may() {
        assert_eq!(tags("#[[a#b c]]"), ["a#b c"]);
        assert_eq!(tags("#[[ padded ]]"), [" padded "]);
        assert_eq!(tags("#[[日本語 é🙂]]"), ["日本語 é🙂"]);
        // a bracket inside is no name: the run rule reads it
        assert_eq!(tags("#[[a [[b]] c]]"), ["[[a"]);
        // a `[[` after a `#` further along is not a bracketed tag of the first
        assert_eq!(tags("# [[a b]]"), Vec::<&str>::new());
    }
}
