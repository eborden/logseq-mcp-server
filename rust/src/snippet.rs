//! The first-line snippet (`firstLineSnippet` in `src/utils/snippet.ts`): what a block looks like
//! when the model should see what it is about without paying for its body. The page outline, the
//! `compact` output of the context tools and compact Markdown all use it, so it is here and not in
//! any one tool's directory.

use serde::Serialize;
use serde::ser::Error as _;
use serde_json::value::RawValue;

use crate::js;

/// Longest first-line snippet, in UTF-16 code units, ellipsis included (#43).
pub const SNIPPET_MAX_CHARS: usize = 80;

/// The first non-blank line of a block's content, a UTF-16 string: kept as code units, since a
/// cut can fall between the halves of a surrogate pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snippet(Vec<u16>);

impl Snippet {
    // PARITY(#299): cuts at 80 UTF-16 code units with `slice`, which can split an emoji and leave a lone
    // surrogate (suspected TS bug) — drop if Rust becomes the only server.
    /// `firstLineSnippet`: the first non-blank line, trimmed, cut to 80 code units with a
    /// trailing `...`. Empty for a block with no content.
    pub fn of(content: Option<&str>) -> Snippet {
        let line = content.and_then(|content| content.split('\n').map(js::trim).find(|line| !line.is_empty())).unwrap_or("");
        let mut units = js::utf16(line);
        if units.len() > SNIPPET_MAX_CHARS {
            units.truncate(SNIPPET_MAX_CHARS - 3); // `slice(0, max(0, max - 3))`
            while units.last().is_some_and(|&unit| char::from_u32(unit.into()).is_some_and(js::is_js_space)) {
                units.pop(); // `trimEnd`
            }
            units.extend("...".encode_utf16());
        }
        Snippet(units)
    }

    /// The text, with a half of a surrogate pair replaced, for a reader that wants a `String`.
    pub fn to_string_lossy(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }
}

impl Serialize for Snippet {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        RawValue::from_string(js::json_string_utf16(&self.0)).map_err(S::Error::custom)?.serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snippet(content: &str) -> String {
        Snippet::of(Some(content)).to_string_lossy()
    }

    #[test]
    fn a_snippet_is_the_first_non_blank_line_trimmed() {
        assert_eq!(snippet("  \n\n  Hello  \nsecond"), "Hello");
        assert_eq!(snippet("   "), "");
        assert_eq!(Snippet::of(None).to_string_lossy(), "");
    }

    #[test]
    fn a_long_line_is_cut_to_eighty_units_with_an_ellipsis() {
        let eighty = "x".repeat(80);
        assert_eq!(snippet(&eighty), eighty);
        assert_eq!(snippet(&"x".repeat(81)), format!("{}...", "x".repeat(77)));
        // the space the cut leaves at the end is trimmed
        assert_eq!(snippet(&format!("{} {}", "x".repeat(76), "y".repeat(10))), format!("{}...", "x".repeat(76)));
    }

    #[test]
    fn a_cut_between_the_halves_of_an_emoji_keeps_the_lone_half_as_an_escape() {
        // 76 units then an emoji: the cut at 77 keeps its first half, as slice() does
        let text = format!("{}\u{1F680}{}", "x".repeat(76), "y".repeat(10));
        let json = serde_json::to_string(&Snippet::of(Some(&text))).unwrap();
        assert_eq!(json, format!("\"{}\\ud83d...\"", "x".repeat(76)));
        // an emoji that fits whole stays whole
        let whole = serde_json::to_string(&Snippet::of(Some("\u{1F680} go"))).unwrap();
        assert_eq!(whole, "\"\u{1F680} go\"");
    }
}
