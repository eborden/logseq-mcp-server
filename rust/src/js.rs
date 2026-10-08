//! What the TypeScript server inherits from JavaScript and puts in its output: which characters
//! `trim()` removes, how a number is written, how `JSON.stringify` orders object keys, and the
//! order `localeCompare` gives page names. Each is here once, named for the JavaScript behavior
//! it copies, so a tool can say "as `JSON.stringify` writes it" instead of redoing the rule.
//!
//! JavaScript strings are UTF-16. Where a length or an index is part of the output (a snippet
//! cut at 80 characters, the fuzzy matcher's scores) the callers work in UTF-16 code units, with
//! [`utf16`], and not in Rust's bytes or `char`s.

use std::cmp::Ordering;

use icu_normalizer::DecomposingNormalizer;
use serde_json::Value;

// PARITY(#299): the set of characters JavaScript's `trim()` and `\s` take as white space (U+FEFF in, U+0085 out)
// where Rust's differs — drop if Rust becomes the only server.
/// A character `String.prototype.trim()` removes: JavaScript's WhiteSpace and LineTerminator.
/// That is Rust's `White_Space` plus U+FEFF (a byte-order mark), less U+0085, which JavaScript
/// keeps. It is also what `\s` matches.
pub fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

/// `String.prototype.trim()`.
pub fn trim(value: &str) -> &str {
    value.trim_matches(is_js_space)
}

/// `String.prototype.trimEnd()`.
pub fn trim_end(value: &str) -> &str {
    value.trim_end_matches(is_js_space)
}

// PARITY(#299): JavaScript counts, cuts and indexes strings by UTF-16 code unit, which shows in the
// snippet cut and fuzzysort's scores — drop if Rust becomes the only server.
/// The UTF-16 code units of a string, which is what `.length`, `charCodeAt` and `slice` count.
pub fn utf16(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

// PARITY(#299): how JavaScript writes a number in an error message (`1e+21`, `0.000001`) — drop if Rust
// becomes the only server.
/// A number as `String(n)` or a template literal writes it (ECMAScript `Number::toString`).
/// JSON has no NaN or infinity, so a value that came from JSON is always finite.
pub fn number_to_string(n: f64) -> String {
    if n == 0.0 {
        return "0".to_owned(); // also -0
    }
    if n < 0.0 {
        return format!("-{}", number_to_string(-n));
    }
    // Rust's `{:e}` writes the shortest digits that read back as the same f64, as JavaScript does.
    let scientific = format!("{n:e}");
    let (mantissa, exponent) = scientific.split_once('e').expect("{:e} always has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n_exp = exponent.parse::<i32>().expect("an integer exponent") + 1; // the spec's `n`
    if k <= n_exp && n_exp <= 21 {
        format!("{digits}{}", "0".repeat((n_exp - k) as usize))
    } else if 0 < n_exp && n_exp <= 21 {
        format!("{}.{}", &digits[..n_exp as usize], &digits[n_exp as usize..])
    } else if -6 < n_exp && n_exp <= 0 {
        format!("0.{}{digits}", "0".repeat((-n_exp) as usize))
    } else {
        let e = n_exp - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

// PARITY(#299): `JSON.stringify` writes integer-like object keys first and numbers its own way — drop if
// Rust becomes the only server.
/// `JSON.stringify(value)`, for the places the TypeScript server writes a value it was handed
/// into a message (a bad argument, a conflicting alias). Numbers are written as JavaScript writes
/// them, and an object's integer-like keys come first, in ascending order, then the others in
/// the order they came: a JavaScript object keeps its keys that way.
pub fn json_stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().expect("a JSON number is finite")),
        Value::String(s) => serde_json::to_string(s).expect("a string serializes"),
        Value::Array(items) => format!("[{}]", items.iter().map(json_stringify).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut indices: Vec<(u32, &String)> =
                map.keys().filter_map(|key| array_index(key).map(|index| (index, key))).collect();
            indices.sort();
            let others = map.keys().filter(|key| array_index(key).is_none());
            let entries: Vec<String> = indices
                .into_iter()
                .map(|(_, key)| key)
                .chain(others)
                .map(|key| format!("{}:{}", serde_json::to_string(key).expect("a key serializes"), json_stringify(&map[key])))
                .collect();
            format!("{{{}}}", entries.join(","))
        }
    }
}

// PARITY(#299): writes a snippet cut inside an emoji as a lone-surrogate escape, which is ill-formed
// UTF-16 that many clients replace with U+FFFD (suspected TS bug: `slice` should cut by code point) — drop
// if Rust becomes the only server.
/// `JSON.stringify(text)` for a JavaScript string that may be ill-formed: a code unit that is half
/// of a surrogate pair, which happens when a string is cut between the two. JSON.stringify writes
/// such a unit as the escape `\ud83d` (well-formed JSON.stringify, ES2019), and Rust's `String`
/// can't hold one, so a string cut by UTF-16 index is kept as code units until it is written.
pub fn json_string_utf16(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

/// A key JavaScript treats as an array index: a canonical decimal below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()));
    canonical.then(|| key.parse::<u32>().ok()).flatten().filter(|index| *index != u32::MAX)
}

// PARITY(#299): copies `localeCompare`, which orders candidate pages by the host's locale and ICU, so the
// TypeScript order differs from machine to machine (suspected TS bug: sort by a fixed order) — drop if
// Rust becomes the only server.
/// The order `a.localeCompare(b)` gives in Node's default (root) collation, approximated.
///
/// ICU's collation compares in layers. First the letters, digits and symbols as a sequence,
/// ignoring accents and case; then the accents; then the case. Across kinds of character the
/// order is whitespace, punctuation, symbols, digits, Latin letters, then every other script.
/// ASCII punctuation has its own order (below), which differs from the code point order.
///
/// This copies that for ASCII and for the Latin letters with accents, which is what a page name
/// is. It doesn't copy ICU's expansions and contractions (`ß` as `ss`, `æ` as `ae`), nor the
/// order inside other scripts, which here is by code point. Node's order also depends on the
/// host's locale; this is the root one (`en-US`).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let (a, b) = (collation_keys(a), collation_keys(b));
    let primary = |k: &[CollationKey]| k.iter().map(|key| key.primary).collect::<Vec<_>>();
    primary(&a)
        .cmp(&primary(&b))
        .then_with(|| a.iter().map(|k| k.accents.as_slice()).cmp(b.iter().map(|k| k.accents.as_slice())))
        .then_with(|| a.iter().map(|k| k.upper).cmp(b.iter().map(|k| k.upper)))
}

/// ASCII punctuation and symbols in the order ICU's root collation sorts them.
const ASCII_PUNCTUATION_ORDER: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// The code points ICU's root collation ignores completely, as ranges: `("a" + c + "b").localeCompare("ab")`
/// is 0 for each of them on Node 24 (ICU 78.2). Generated by scanning every code point with that test, so
/// it is Node's own set (962 code points in 88 ranges): the C0 and C1 controls, soft hyphen, the combining
/// grapheme joiner, the zero-width and bidi marks (U+200B-U+200F, U+202A-U+202E, U+2060-U+206F), the
/// variation selectors (U+FE00-U+FE0F, which an emoji page name often carries), U+FEFF and others.
const COLLATION_IGNORABLE: [(u32, u32); 88] = [
    (0x0, 0x8),
    (0xe, 0x1f),
    (0x7f, 0x84),
    (0x86, 0x9f),
    (0xad, 0xad),
    (0x34f, 0x34f),
    (0x488, 0x489),
    (0x591, 0x5af),
    (0x5bd, 0x5bd),
    (0x5c4, 0x5c5),
    (0x600, 0x605),
    (0x610, 0x61a),
    (0x61c, 0x61c),
    (0x640, 0x640),
    (0x6d6, 0x6dd),
    (0x6df, 0x6e4),
    (0x6e7, 0x6e8),
    (0x6ea, 0x6ed),
    (0x70f, 0x70f),
    (0x740, 0x740),
    (0x743, 0x744),
    (0x747, 0x74a),
    (0x7fa, 0x7fa),
    (0x890, 0x891),
    (0x898, 0x89d),
    (0x8ca, 0x8e2),
    (0x8ea, 0x8ef),
    (0x8f3, 0x8f3),
    (0x951, 0x952),
    (0xf18, 0xf19),
    (0xf35, 0xf35),
    (0xf37, 0xf37),
    (0xf3e, 0xf3f),
    (0xf86, 0xf87),
    (0xfc6, 0xfc6),
    (0x17b4, 0x17b5),
    (0x17d3, 0x17d3),
    (0x180a, 0x180f),
    (0x1a7f, 0x1a7f),
    (0x1b6b, 0x1b73),
    (0x1cd0, 0x1ce8),
    (0x1cf4, 0x1cf4),
    (0x1cf7, 0x1cf9),
    (0x200b, 0x200f),
    (0x202a, 0x202e),
    (0x2060, 0x2064),
    (0x2066, 0x206f),
    (0x2d7f, 0x2d7f),
    (0xa670, 0xa672),
    (0xa8e0, 0xa8f1),
    (0xfe00, 0xfe0f),
    (0xfe21, 0xfe21),
    (0xfe23, 0xfe26),
    (0xfe28, 0xfe28),
    (0xfe2a, 0xfe2d),
    (0xfe2f, 0xfe2f),
    (0xfe73, 0xfe73),
    (0xfeff, 0xfeff),
    (0xfff9, 0xfffb),
    (0x102e0, 0x102e0),
    (0x10efb, 0x10efb),
    (0x10efd, 0x10eff),
    (0x110bd, 0x110bd),
    (0x110cd, 0x110cd),
    (0x11366, 0x1136c),
    (0x11370, 0x11374),
    (0x113e1, 0x113e2),
    (0x13430, 0x13440),
    (0x13447, 0x13455),
    (0x16fe4, 0x16fe4),
    (0x1bca0, 0x1bca3),
    (0x1cf00, 0x1cf2d),
    (0x1cf30, 0x1cf46),
    (0x1d165, 0x1d169),
    (0x1d16d, 0x1d182),
    (0x1d185, 0x1d18b),
    (0x1d1aa, 0x1d1ad),
    (0x1d242, 0x1d244),
    (0x1da00, 0x1da36),
    (0x1da3b, 0x1da6c),
    (0x1da75, 0x1da75),
    (0x1da84, 0x1da84),
    (0x1da9b, 0x1da9f),
    (0x1daa1, 0x1daaf),
    (0x1e8d0, 0x1e8d6),
    (0xe0001, 0xe0001),
    (0xe0020, 0xe007f),
    (0xe0100, 0xe01ef),
];

fn is_collation_ignorable(c: char) -> bool {
    let c = c as u32;
    COLLATION_IGNORABLE
        .binary_search_by(|&(first, last)| {
            if c < first {
                Ordering::Greater
            } else if c > last {
                Ordering::Less
            } else {
                Ordering::Equal
            }
        })
        .is_ok()
}

struct CollationKey {
    primary: (u8, u32),
    /// Combining marks that followed the base character.
    accents: Vec<char>,
    upper: bool,
}

fn collation_keys(text: &str) -> Vec<CollationKey> {
    let nfd = DecomposingNormalizer::new_nfd().normalize(text);
    let mut keys: Vec<CollationKey> = Vec::new();
    for c in nfd.chars() {
        // PARITY(#299): ICU skips the characters it ignores completely when it compares, so two names that differ
        // only by one collate as equal — drop if Rust becomes the only server.
        if is_collation_ignorable(c) {
            continue;
        }
        if ('\u{300}'..='\u{36f}').contains(&c) {
            if let Some(last) = keys.last_mut() {
                last.accents.push(c);
                continue;
            }
        }
        let lower = c.to_lowercase().next().unwrap_or(c);
        let primary = if c.is_whitespace() {
            (0, c as u32)
        } else if let Some(position) = ASCII_PUNCTUATION_ORDER.find(c) {
            (1, position as u32)
        } else if c.is_ascii_digit() {
            (3, c as u32)
        } else if lower.is_ascii_lowercase() {
            (4, lower as u32)
        } else if c.is_alphabetic() {
            (5, lower as u32)
        } else {
            (2, c as u32) // other punctuation and symbols
        };
        keys.push(CollationKey { primary, accents: Vec::new(), upper: c.is_uppercase() });
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trim_removes_what_javascript_removes() {
        assert_eq!(trim("\u{feff} on \u{a0}\u{2028}\t"), "on");
        // U+0085 is white space to Rust and not to JavaScript.
        assert_eq!(trim("\u{85}on\u{85}"), "\u{85}on\u{85}");
        assert_eq!(trim_end("  a b \n"), "  a b");
    }

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        // Each expected value is what `String(n)` gives in Node.
        for (n, expected) in [
            (0.0, "0"),
            (-0.0, "0"),
            (42.0, "42"),
            (-7.0, "-7"),
            (1.5, "1.5"),
            (0.1, "0.1"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1.2345678901234567e25, "1.2345678901234566e+25"),
            (12345678901234567890.0, "12345678901234567000"),
            (-1e-9, "-1e-9"),
            (9007199254740993.0, "9007199254740992"),
        ] {
            assert_eq!(number_to_string(n), expected, "{n:e}");
        }
    }

    #[test]
    fn stringify_matches_json_stringify() {
        let value: Value = serde_json::from_str(r#"{"b":1e2,"2":true,"a":[null,1.5,"x\"y"],"1":{"z":1e21},"01":0}"#).unwrap();
        // JSON.stringify of the same JSON.parse: the integer keys first, "01" is not one.
        assert_eq!(json_stringify(&value), r#"{"1":{"z":1e+21},"2":true,"b":100,"a":[null,1.5,"x\"y"],"01":0}"#);
        assert_eq!(json_stringify(&json!({})), "{}");
        assert_eq!(json_stringify(&json!("é\n")), "\"é\\n\"");
    }

    #[test]
    fn a_cut_surrogate_pair_is_written_as_an_escape_as_json_stringify_does() {
        // JSON.stringify("a\ud83d") and JSON.stringify("\ude00b\n\u0001\"")
        assert_eq!(json_string_utf16(&[0x61, 0xd83d]), r#""a\ud83d""#);
        assert_eq!(json_string_utf16(&[0xde00, 0x62, 0x0a, 1, 0x22]), r#""\ude00b\n\u0001\"""#);
        // a whole pair is the character
        assert_eq!(json_string_utf16(&utf16("é😀\u{2028}\u{7f}")), "\"é😀\u{2028}\u{7f}\"");
        assert_eq!(json_string_utf16(&utf16("\u{8}\u{c}\r\t\\")), r#""\b\f\r\t\\""#);
    }

    #[test]
    fn locale_compare_matches_nodes_root_collation() {
        // `sorted` is Node 24 (ICU 78, en-US) sorting these with localeCompare.
        let sorted = [
            "", " ", "  ", "2025", "a", "ä", "a b", "a_b", "a-b", "ab", "alice", "alicé", "alice 10", "alice 2",
            "alice notes", "alice_notes", "alice-notes", "alice.", "alice/notes", "alice2", "alicf", "e", "é", "f",
            "jan 1st, 2025", "n", "ñ", "o", "p", "project atlas", "project atlas/log", "project atlas/retro",
            "project-atlas", "projectatlas", "z",
        ];
        for (i, a) in sorted.iter().enumerate() {
            for (j, b) in sorted.iter().enumerate() {
                assert_eq!(locale_compare(a, b), i.cmp(&j), "{a:?} against {b:?}");
            }
        }
    }

    #[test]
    fn locale_compare_orders_ascii_punctuation_as_icu_does() {
        let sorted = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";
        let chars: Vec<String> = sorted.chars().map(String::from).collect();
        for (i, a) in chars.iter().enumerate() {
            for (j, b) in chars.iter().enumerate() {
                assert_eq!(locale_compare(a, b), i.cmp(&j), "{a:?} against {b:?}");
            }
        }
    }

    #[test]
    fn locale_compare_ignores_zero_width_characters_as_icu_does() {
        assert_eq!(locale_compare("cafe\u{200b}", "cafe"), Ordering::Equal);
        assert_eq!(locale_compare("ca\u{ad}fe", "cafe"), Ordering::Equal);
        assert_eq!(locale_compare("cafe\u{200b}", "caf\u{e9}"), Ordering::Less);
        assert_eq!(locale_compare("a\u{feff}b", "ab"), Ordering::Equal);
    }

    #[test]
    fn locale_compare_ignores_what_icu_ignores_completely() {
        // an emoji with its variation selector (VS16), a bidi embedding, a control, and a combining grapheme joiner
        for ignorable in ['\u{fe0f}', '\u{fe00}', '\u{202a}', '\u{2066}', '\u{206f}', '\u{1}', '\u{7f}', '\u{34f}', '\u{61c}'] {
            assert!(is_collation_ignorable(ignorable), "{ignorable:?}");
            assert_eq!(locale_compare(&format!("a{ignorable}b"), "ab"), Ordering::Equal, "{ignorable:?}");
        }
        // what a name is made of is not ignorable: letters, space, tab (U+0009 is not in the set), accents
        for kept in ['a', ' ', '\t', '\u{301}', '\u{85}', '\u{2764}'] {
            assert!(!is_collation_ignorable(kept), "{kept:?}");
        }
        assert_eq!(locale_compare("\u{2764}\u{fe0f} a", "\u{2764} b"), Ordering::Less);
        assert_eq!(locale_compare("lrm\u{202a} one", "lrm two"), Ordering::Less);
    }

    #[test]
    fn locale_compare_puts_other_scripts_after_latin_by_code_point() {
        assert_eq!(locale_compare("z", "日本"), Ordering::Less);
        assert_eq!(locale_compare("日本", "日本語"), Ordering::Less);
        assert_eq!(locale_compare("😀", "2025"), Ordering::Less);
    }
}
