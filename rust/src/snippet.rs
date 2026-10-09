//! The first-line snippet: what a block looks like
//! when the model should see what it is about without paying for its body. The page outline, the
//! `compact` output of the context tools and compact Markdown all use it, so it is here and not in
//! any one tool's directory.
//!
//! Lengths and cuts count code points (`chars()`), never UTF-16 code units, so a cut never lands
//! inside a character: no lone surrogate and no U+FFFD (#299, wave C2). A cut can still fall
//! between the code points of one visible character (a ZWJ emoji, a letter and its combining
//! mark), as any count of characters does.

use serde::Serialize;

use crate::js;

/// Longest first-line snippet, in characters (code points), ellipsis included (#43).
pub const SNIPPET_MAX_CHARS: usize = 80;

/// The first non-blank line of a block's content, trimmed. Empty for a block with no content, or
/// with only blank lines.
pub fn first_non_blank_line(content: Option<&str>) -> &str {
    content.and_then(|content| content.split('\n').map(js::trim).find(|line| !line.is_empty())).unwrap_or("")
}

/// The first `count` characters (code points) of `text`, or all of it when it has fewer.
pub fn first_chars(text: &str, count: usize) -> &str {
    text.char_indices().nth(count).map_or(text, |(end, _)| &text[..end])
}

/// A block's first line, cut to [`SNIPPET_MAX_CHARS`] characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Snippet(String);

impl Snippet {
    /// `firstLineSnippet`: the first non-blank line, trimmed, cut to 80 characters with a
    /// trailing `...`. Empty for a block with no content.
    pub fn of(content: Option<&str>) -> Snippet {
        let line = first_non_blank_line(content);
        if line.chars().count() <= SNIPPET_MAX_CHARS {
            return Snippet(line.to_owned());
        }
        // `max - 3` characters, the white space the cut leaves at the end trimmed, then the ellipsis
        Snippet(format!("{}...", js::trim_end(first_chars(line, SNIPPET_MAX_CHARS - 3))))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snippet(content: &str) -> String {
        Snippet::of(Some(content)).as_str().to_owned()
    }

    #[test]
    fn a_snippet_is_the_first_non_blank_line_trimmed() {
        assert_eq!(snippet("  \n\n  Hello  \nsecond"), "Hello");
        assert_eq!(snippet("   "), "");
        assert_eq!(Snippet::of(None).as_str(), "");
    }

    #[test]
    fn a_long_line_is_cut_to_eighty_characters_with_an_ellipsis() {
        let eighty = "x".repeat(80);
        assert_eq!(snippet(&eighty), eighty);
        assert_eq!(snippet(&"x".repeat(81)), format!("{}...", "x".repeat(77)));
        // the space the cut leaves at the end is trimmed
        assert_eq!(snippet(&format!("{} {}", "x".repeat(76), "y".repeat(10))), format!("{}...", "x".repeat(76)));
    }

    #[test]
    fn a_character_outside_the_bmp_counts_as_one_and_is_never_split() {
        // 80 rockets are 160 UTF-16 units and 80 characters: no cut
        let eighty = "\u{1F680}".repeat(80);
        assert_eq!(snippet(&eighty), eighty);
        // 81 are cut at 77 whole rockets
        assert_eq!(snippet(&"\u{1F680}".repeat(81)), format!("{}...", "\u{1F680}".repeat(77)));
        // a rocket at the boundary (the 77th character) stays whole
        let text = format!("{}\u{1F680}{}", "x".repeat(76), "y".repeat(10));
        assert_eq!(snippet(&text), format!("{}\u{1F680}...", "x".repeat(76)));
        let json = serde_json::to_string(&Snippet::of(Some(&text))).unwrap();
        assert_eq!(json, format!("\"{}\u{1F680}...\"", "x".repeat(76)));
        assert!(!json.contains("\\ud") && !json.contains('\u{FFFD}'));
    }

    #[test]
    fn a_zwj_emoji_and_a_combining_mark_are_cut_by_code_point() {
        // The family emoji is 5 code points (3 people, 2 joiners): the cut at 77 keeps only the first.
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let text = format!("{}{family}{}", "x".repeat(76), "y".repeat(10));
        assert_eq!(snippet(&text), format!("{}\u{1F468}...", "x".repeat(76)));
        // "e" and a combining acute accent are 2 code points: a cut between them leaves a bare "e"
        let text = format!("{}e\u{301}{}", "x".repeat(76), "y".repeat(10));
        assert_eq!(snippet(&text), format!("{}e...", "x".repeat(76)));
        // a cut after both keeps the mark with its letter
        let text = format!("{}e\u{301}{}", "x".repeat(75), "y".repeat(10));
        assert_eq!(snippet(&text), format!("{}e\u{301}...", "x".repeat(75)));
    }

    #[test]
    fn first_chars_counts_code_points() {
        assert_eq!(first_chars("a\u{1F680}b", 2), "a\u{1F680}");
        assert_eq!(first_chars("abc", 0), "");
        assert_eq!(first_chars("abc", 3), "abc");
        assert_eq!(first_chars("abc", 10), "abc");
    }
}
