//! Finding refs and embeds in a block's text, and cleaning a target's text .
//! Both are small regex-shaped patterns and the crate has no regex engine, so they are written out
//! here: leftmost-first alternation, white space as Rust takes it (`char::is_whitespace`, not the
//! wider `\s` of a JavaScript regex) and ASCII-only case folding, as the `i` flag does.

use std::ops::Range;

use crate::js;
use crate::refs;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `((uuid))`
    Ref,
    /// `{{embed ((uuid))}}`
    BlockEmbed,
    /// `{{embed [[page]]}}`
    PageEmbed,
}

impl Kind {
    /// The kind's name in a lookup key (`<kind>:<key>`).
    pub fn tag(self) -> &'static str {
        match self {
            Kind::Ref => "ref",
            Kind::BlockEmbed => "block_embed",
            Kind::PageEmbed => "page_embed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: Kind,
    /// The text as written, to leave in place when the target can't be shown
    pub raw: String,
    /// The lowercase uuid, or the page name as written (trimmed) for a page embed
    pub target: String,
    /// Lookup key: the lowercase uuid, or the lowercase page name
    pub key: String,
}

impl Token {
    /// What a lookup of this token is known by: the kind and the key.
    pub fn identity(&self) -> String {
        format!("{}:{}", self.kind.tag(), self.key)
    }
}

/// A token and where it sits in the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub range: Range<usize>,
    pub token: Token,
}

/// `s` without the literal `lit` at its start, matched ignoring ASCII case (the `i` flag).
fn strip_ci<'a>(s: &'a str, lit: &str) -> Option<&'a str> {
    let head = s.get(..lit.len())?;
    head.eq_ignore_ascii_case(lit).then(|| &s[lit.len()..])
}

/// `\s*`, with Rust's white space
fn skip_space(s: &str) -> &str {
    s.trim_start_matches(char::is_whitespace)
}

/// `\s+`
fn skip_space_1(s: &str) -> Option<&str> {
    let rest = skip_space(s);
    (rest.len() < s.len()).then_some(rest)
}

/// A strict 8-4-4-4-12 hex uuid at the start of `s`, in either case, and what follows it.
fn uuid(s: &str) -> Option<(&str, &str)> {
    let bytes = s.as_bytes();
    let valid = bytes.len() >= 36
        && bytes[..36].iter().enumerate().all(|(i, &b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        });
    valid.then(|| s.split_at(36))
}

/// `\{\{embed\s+\(\((UUID)\)\)\s*\}\}`, the text after the opening `{{`.
fn block_embed(rest: &str) -> Option<(&str, &str)> {
    let rest = skip_space_1(strip_ci(rest, "embed")?)?;
    let (id, rest) = uuid(rest.strip_prefix("((")?)?;
    let rest = skip_space(rest.strip_prefix("))")?).strip_prefix("}}")?;
    Some((id, rest))
}

/// `\{\{embed\s+<page ref>\s*\}\}`, the text after the opening `{{`. The page ref is the one
/// grammar of [`refs`].
fn page_embed(rest: &str) -> Option<(&str, &str)> {
    let (name, rest) = refs::ref_at(skip_space_1(strip_ci(rest, "embed")?)?)?;
    let rest = skip_space(rest).strip_prefix("}}")?;
    Some((name, rest))
}

/// `\(\((UUID)\)\)`, the text after the opening `((`.
fn plain_ref(rest: &str) -> Option<(&str, &str)> {
    let (id, rest) = uuid(rest)?;
    Some((id, rest.strip_prefix("))")?))
}

/// The refs and embeds in `text`, in order, left to right and not overlapping: `{{embed ((uuid))}}`,
/// `{{embed [[page]]}}` and `((uuid))`, in that order of precedence at a position. Only strict
/// uuids match, so `((not a uuid))` is left alone.
pub fn scan(text: &str) -> Vec<Found> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        // Every pattern opens with an ASCII bracket, so `i` is at a character boundary when it matches
        let opened = match bytes[i] {
            b'{' if bytes.get(i + 1) == Some(&b'{') => try_embed(&text[i + 2..]),
            b'(' if bytes.get(i + 1) == Some(&b'(') => plain_ref(&text[i + 2..]).map(|(id, rest)| (Kind::Ref, id, rest)),
            _ => None,
        };
        let Some((kind, captured, rest)) = opened else {
            i += 1;
            continue;
        };
        let end = text.len() - rest.len();
        let (target, key) = match kind {
            Kind::PageEmbed => {
                let name = js::trim(captured);
                (name.to_owned(), name.to_lowercase())
            }
            Kind::Ref | Kind::BlockEmbed => (captured.to_ascii_lowercase(), captured.to_ascii_lowercase()),
        };
        found.push(Found { range: i..end, token: Token { kind, raw: text[i..end].to_owned(), target, key } });
        i = end;
    }
    found
}

/// A block embed, else a page embed, after the `{{`.
fn try_embed(rest: &str) -> Option<(Kind, &str, &str)> {
    block_embed(rest)
        .map(|(id, rest)| (Kind::BlockEmbed, id, rest))
        .or_else(|| page_embed(rest).map(|(name, rest)| (Kind::PageEmbed, name, rest)))
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The length of an `id:: <uuid>` line at the start of `s`, with its line ending, or `None`:
/// `^[ \t]*id::[ \t]*[0-9a-f-]{36}[ \t]*(\r?\n|$)` with the `i` and `m` flags, where `$` is the end
/// of the text or the place before any line terminator.
fn id_line(s: &str) -> Option<usize> {
    let blanks = |s: &str| s.trim_start_matches([' ', '\t']).len();
    let rest = &s[s.len() - blanks(s)..];
    let rest = strip_ci(rest, "id::")?;
    let rest = &rest[rest.len() - blanks(rest)..];
    let value = rest.as_bytes().get(..36)?;
    if !value.iter().all(|&b| b.is_ascii_hexdigit() || b == b'-') {
        return None;
    }
    let rest = &rest[36..];
    let rest = &rest[rest.len() - blanks(rest)..];
    let ending = if rest.starts_with("\r\n") {
        2
    } else if rest.starts_with('\n') {
        1
    } else if rest.chars().next().is_none_or(is_line_terminator) {
        0 // `$`: the end, or the place before a lone `\r`, U+2028 or U+2029
    } else {
        return None;
    };
    Some(s.len() - rest.len() + ending)
}

/// A block's text without the `id::` property line LogSeq stores in it, wherever
/// it sits, with any spacing and line ending and only at the start of a line, then without
/// trailing white space.
pub fn clean_content(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut previous: Option<char> = None;
    let mut i = 0;
    while i < content.len() {
        if previous.is_none_or(is_line_terminator) {
            if let Some(length) = id_line(&content[i..]) {
                // The line ending is gone with the line, so the next line starts here
                previous = content[..i + length].chars().next_back();
                i += length;
                continue;
            }
        }
        let c = content[i..].chars().next().expect("i is inside the text");
        out.push(c);
        previous = Some(c);
        i += c.len_utf8();
    }
    js::trim_end(&out).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000B";

    fn kinds(text: &str) -> Vec<(Kind, String, String)> {
        scan(text).into_iter().map(|found| (found.token.kind, found.token.raw, found.token.key)).collect()
    }

    #[test]
    fn a_ref_an_embed_and_a_page_embed_are_found_in_order() {
        let text = format!("see (({A})) and {{{{embed (({B}))}}}} then {{{{embed [[Project Atlas]]}}}}");
        let found = scan(&text);
        assert_eq!(found.iter().map(|f| f.token.kind).collect::<Vec<_>>(), [Kind::Ref, Kind::BlockEmbed, Kind::PageEmbed]);
        // a uuid key is lowercase, a page key is the trimmed name lowercased and the target keeps its case
        assert_eq!(found[1].token.key, B.to_ascii_lowercase());
        assert_eq!((found[2].token.target.as_str(), found[2].token.key.as_str()), ("Project Atlas", "project atlas"));
        assert_eq!(&text[found[0].range.clone()], format!("(({A}))"));
        assert_eq!(found[2].token.raw, "{{embed [[Project Atlas]]}}");
        assert_eq!(found[0].token.identity(), format!("ref:{A}"));
    }

    #[test]
    fn only_strict_uuids_match() {
        assert!(scan("((not a uuid)) ((00000000-0000-4000-8000-00000000000)) ((00000000-0000-4000-8000-00000000000g))").is_empty());
        // 37 characters: the ref needs `))` right after the 36th
        assert!(scan(&format!("(({A}0))")).is_empty());
    }

    #[test]
    fn an_embed_allows_any_space_around_its_target_and_any_case_for_the_word() {
        let wide = format!("{{{{EMBED \u{a0}\t(({A})) \n}}}}");
        assert_eq!(kinds(&wide).len(), 1);
        assert_eq!(kinds(&wide)[0].0, Kind::BlockEmbed);
        // no space after "embed" is no embed, and the ref inside is found on its own
        let tight = format!("{{{{embed(({A}))}}}}");
        assert_eq!(kinds(&tight).iter().map(|k| k.0).collect::<Vec<_>>(), [Kind::Ref]);
        // U+FEFF is not white space (Rust's set, not JavaScript's)
        assert_eq!(kinds(&format!("{{{{embed\u{feff}(({A}))}}}}")).iter().map(|k| k.0).collect::<Vec<_>>(), [Kind::Ref]);
        // U+0085 is
        assert_eq!(kinds(&format!("{{{{embed\u{85}(({A}))}}}}"))[0].0, Kind::BlockEmbed);
    }

    #[test]
    fn an_embed_that_is_not_closed_leaves_its_ref_to_be_found() {
        let text = format!("{{{{embed (({A}))}} (({B}))");
        assert_eq!(kinds(&text).iter().map(|k| k.0).collect::<Vec<_>>(), [Kind::Ref, Kind::Ref]);
    }

    #[test]
    fn a_page_embed_name_has_no_brackets_or_line_breaks() {
        assert!(scan("{{embed [[]]}}").is_empty());
        assert!(scan("{{embed [[a\nb]]}}").is_empty());
        assert!(scan("{{embed [[a[b]]}}").is_empty());
        assert!(scan("{{embed [[a]b]]}}").is_empty());
        // a carriage return is allowed, as are spaces at both ends, which the target trims
        let found = scan("{{embed [[  Bob\r ]] }}");
        assert_eq!((found[0].token.target.as_str(), found[0].token.key.as_str()), ("Bob", "bob"));
        // a name made of white space only is a name, and trims to an empty one
        assert_eq!(scan("{{embed [[ ]]}}")[0].token.key, "");
    }

    #[test]
    fn text_around_multibyte_characters_scans_without_splitting_them() {
        let text = format!("café ((x)) \u{1F680} (({A})) é{{{{");
        let found = scan(&text);
        assert_eq!(found.len(), 1);
        assert_eq!(&text[found[0].range.clone()], format!("(({A}))"));
    }

    fn clean(text: &str) -> String {
        clean_content(text)
    }

    #[test]
    fn the_id_line_goes_wherever_it_sits_with_any_spacing_and_line_ending() {
        assert_eq!(clean(&format!("Hello\nid:: {A}")), "Hello");
        assert_eq!(clean(&format!("id:: {A}\nHello")), "Hello");
        assert_eq!(clean(&format!("a\n  \t ID::\t{B}  \r\nb")), "a\nb");
        assert_eq!(clean(&format!("id:: {A}")), "");
        // a line ending that is a lone CR or U+2028 is left in place: it ends the line, so `$` matches
        // before it, but only `\r?\n` is part of the match
        assert_eq!(clean(&format!("x\rid:: {A}\ry")), "x\r\ry");
        assert_eq!(clean(&format!("x\u{2028}id:: {A}\u{2028}y")), "x\u{2028}\u{2028}y");
        // two lines in a row
        assert_eq!(clean(&format!("id:: {A}\nid:: {B}\nHi")), "Hi");
    }

    #[test]
    fn only_a_line_that_is_the_id_property_alone_goes() {
        assert_eq!(clean(&format!("see id:: {A}")), format!("see id:: {A}"));
        assert_eq!(clean(&format!("id:: {A} and more")), format!("id:: {A} and more"));
        assert_eq!(clean("id:: not-a-uuid"), "id:: not-a-uuid");
        assert_eq!(clean(&format!("id::{A}0")), format!("id::{A}0"));
        // the text is trimmed at the end only
        assert_eq!(clean("  Hello  \n\n"), "  Hello");
    }
}
