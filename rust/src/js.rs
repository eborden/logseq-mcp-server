//! What the TypeScript server inherits from JavaScript and puts in its output: which characters
//! `trim()` removes, how a number is written, how `JSON.stringify` orders object keys, and the
//! order `localeCompare` gives page names. Each is here once, named for the JavaScript behavior
//! it copies, so a tool can say "as `JSON.stringify` writes it" instead of redoing the rule.
//!
//! JavaScript strings are UTF-16. Where a length or an index is part of the output (a snippet
//! cut at 80 characters) the callers work in UTF-16 code units, with
//! [`utf16`], and not in Rust's bytes or `char`s.

use std::cmp::Ordering;
use std::sync::OnceLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
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
// snippet cut — drop if Rust becomes the only server.
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
            let entries: Vec<String> = entries_in_js_order(map)
                .into_iter()
                .map(|(key, value)| format!("{}:{}", serde_json::to_string(key).expect("a key serializes"), json_stringify(value)))
                .collect();
            format!("{{{}}}", entries.join(","))
        }
    }
}

// PARITY(#299): a JavaScript object lists integer-like keys first, whatever order they came in — drop if
// Rust becomes the only server.
/// An object's entries in the order `Object.entries` (and `JSON.stringify`) gives them: integer-like
/// keys first, in ascending order, then the others in the order they came.
pub fn entries_in_js_order(map: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indices: Vec<(u32, (&String, &Value))> =
        map.iter().filter_map(|(key, value)| array_index(key).map(|index| (index, (key, value)))).collect();
    indices.sort_by_key(|(index, _)| *index);
    let others = map.iter().filter(|(key, _)| array_index(key).is_none());
    indices.into_iter().map(|(_, entry)| entry).chain(others).collect()
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
// TypeScript order differs from machine to machine (suspected TS bug: sort by a fixed order). It copies
// ICU's root collation except for Han, which differs on purpose (accepted, see below) — drop if Rust becomes the
// only server.
/// The order `a.localeCompare(b)` gives in Node's default (root) collation: the Unicode Collation
/// Algorithm with CLDR's root data, which is what `icu_collator` runs. Node 24 (ICU 78) and the
/// crate's data are both CLDR 48.
///
/// The data is the same CLDR root except for Han, which differs on purpose (the maintainer accepted
/// it, #299): ICU4C orders ideographs by radical and stroke across every block, so U+3400 comes
/// before U+65E5, where `icu_collator`'s compiled data gives them implicit weights in code point
/// order, block after block. Ideographs inside the original block U+4E00..U+9FA5 mostly agree
/// (code point order there follows radical and stroke, with exceptions); a pair that crosses into an
/// extension block, the compatibility ideographs or U+9FA6 and up can differ. ICU4X has no supported
/// setting for it (`-u-co-unihan` gives the same order). No other difference is known.
///
/// ICU compares in layers. First the letters, digits and symbols as a sequence, ignoring accents
/// and case; then the accents; then the case. Across kinds of character the order is white space,
/// punctuation, symbols, digits, then the scripts one after another (Latin, Greek, Cyrillic, ...).
/// `ß` sorts as `ss`, and the zero-width marks, controls and variation selectors count for
/// nothing at all.
///
/// Node's order also depends on the host's locale; this is the root one (`en-US` has no tailoring
/// of its own). Strings that are canonically equivalent (NFC and NFD) compare equal.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(CollatorPreferences::default(), CollatorOptions::default())
                .expect("the compiled root collation data loads")
        })
        .compare(a, b)
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
            assert_eq!(locale_compare(&format!("a{ignorable}b"), "ab"), Ordering::Equal, "{ignorable:?}");
        }
        // what a name is made of is not ignorable: space, tab (U+0009), U+0085, a heart
        for kept in [' ', '\t', '\u{85}', '\u{2764}'] {
            assert_ne!(locale_compare(&format!("a{kept}b"), "ab"), Ordering::Equal, "{kept:?}");
        }
        assert_eq!(locale_compare("\u{2764}\u{fe0f} a", "\u{2764} b"), Ordering::Less);
        assert_eq!(locale_compare("lrm\u{202a} one", "lrm two"), Ordering::Less);
    }

    #[test]
    fn locale_compare_orders_scripts_one_after_another_as_icu_does() {
        // `sorted` is Node 24 (ICU 78) sorting these with localeCompare: symbols and digits, Latin, Greek, Cyrillic,
        // Hebrew, Arabic, Devanagari, Thai, Hangul, kana, then Han.
        let sorted = [
            "_x", "\u{1f600}", "2025", "ab", "Alice", "apple", "\u{fb06}", "\u{17f}t", "\u{dc}n\u{ef}code", "zebra",
            "\u{3b1}\u{3bb}\u{3c6}\u{3b1}", "\u{3a9}mega", "\u{431}\u{435}\u{442}\u{430}", "\u{411}\u{435}\u{442}\u{430}",
            "\u{42f}\u{431}\u{43b}\u{43e}\u{43a}\u{43e}", "\u{5e9}\u{5dc}\u{5d5}\u{5dd}", "\u{645}\u{631}\u{62d}\u{628}\u{627}",
            "\u{939}\u{93f}\u{928}\u{94d}\u{926}\u{940}", "\u{e44}\u{e17}\u{e22}", "\u{d55c}\u{ad6d}\u{c5b4}",
            "\u{30ab}\u{30bf}\u{30ab}\u{30ca}", "\u{3072}\u{3089}\u{304c}\u{306a}", "\u{65e5}\u{672c}", "\u{65e5}\u{672c}\u{8a9e}",
        ];
        assert_pairwise_in_order(&sorted);
    }

    #[test]
    fn locale_compare_puts_latin_before_greek_whatever_the_code_points() {
        // U+FB06 (a Latin ligature of "st") is above every Greek letter in code points and still sorts as "st".
        assert_pairwise_in_order(&["ad", "ae", "\u{e6}", "af", "sa", "sr", "ss", "\u{df}", "st", "\u{fb06}", "su", "sz", "\u{3a3}igma", "\u{3a9}mega"]);
        assert_eq!(locale_compare("\u{fb06}", "\u{3a9}mega"), Ordering::Less);
        assert_eq!(locale_compare("z", "\u{3b1}"), Ordering::Less);
    }

    #[test]
    fn locale_compare_orders_inside_a_script_as_icu_does() {
        // Hangul, then kana, then Han. These ideographs sit in the original block, where the radical-stroke order
        // Node uses and the code point order `icu_collator` uses happen to agree.
        assert_pairwise_in_order(&["\u{d55c}\u{ae00}", "\u{304b}\u{306a}", "\u{4e2d}", "\u{4e2d}\u{6587}", "\u{65e5}", "\u{65e5}\u{672c}", "\u{65e5}\u{672c}\u{8a9e}", "\u{6c49}\u{5b57}", "\u{6f22}\u{5b57}"]);
        // the case and accent layers still apply after the letters: a, ä, then "a-α" (a hyphen sorts before letters)
        assert_pairwise_in_order(&[
            "a", "\u{e4}", "a-\u{3b1}", "aether", "\u{c6}ther", "alpha", "Alpha", "alpha ", "Alpha2", "o", "\u{f8}", "\u{d8}", "p", "\u{df}",
            "strasse", "Strasse", "Stra\u{df}e", "\u{3b1}", "\u{3b1}lpha",
        ]);
    }

    #[test]
    fn locale_compare_orders_han_across_blocks_by_code_point_unlike_node() {
        // KNOWN DIFFERENCE from Node 24 (#299): ICU4C's root puts Han in radical-stroke order across blocks, so
        // `"\u{3400}".localeCompare("\u{65e5}")` is -1 there. `icu_collator`'s compiled root data orders by code
        // point block after block (URO, then Extension A, ...), so Rust says 1. Pinned so a change shows up, and
        // is to be flipped if the radical-stroke order ever lands.
        assert_eq!(locale_compare("\u{3400}", "\u{65e5}"), Ordering::Greater); // Node: Less
        assert_eq!(locale_compare("\u{20000}", "\u{65e5}"), Ordering::Greater); // Node: Less
        assert_eq!(locale_compare("\u{f900}", "\u{3400}"), Ordering::Less); // Node: Greater
        assert_eq!(locale_compare("\u{9fa5}", "\u{9fa6}"), Ordering::Less); // Node: Greater
    }

    #[test]
    fn locale_compare_calls_canonically_equivalent_strings_equal() {
        assert_eq!(locale_compare("caf\u{e9}", "cafe\u{301}"), Ordering::Equal);
        assert_eq!(locale_compare("\u{3a9}", "\u{2126}"), Ordering::Equal); // Greek capital omega and the ohm sign
    }

    /// Each string is `Less` than every one after it, and `Equal` to itself.
    fn assert_pairwise_in_order(sorted: &[&str]) {
        for (i, a) in sorted.iter().enumerate() {
            for (j, b) in sorted.iter().enumerate() {
                assert_eq!(locale_compare(a, b), i.cmp(&j), "{a:?} against {b:?}");
            }
        }
    }
}
