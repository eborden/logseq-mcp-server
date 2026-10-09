//! What the TypeScript server inherits from JavaScript and puts in its output: how a number is
//! written and how `JSON.stringify` orders object keys. Each is here once, named for the
//! JavaScript behavior it copies, so a tool can say "as `JSON.stringify` writes it" instead of
//! redoing the rule.
//!
//! Text is not here any more. A length or a cut in the output counts code points (`chars()`),
//! and white space is Rust's `char::is_whitespace` (#299, wave C2).

use serde_json::Value;

/// A character that counts as white space: Rust's `char::is_whitespace` (Unicode `White_Space`).
/// The TypeScript server used JavaScript's set, which adds U+FEFF and leaves out U+0085; the
/// Rust server takes Rust's (#299).
pub fn is_js_space(c: char) -> bool {
    c.is_whitespace()
}

/// The text without white space at either end ([`is_js_space`]).
pub fn trim(value: &str) -> &str {
    value.trim_matches(is_js_space)
}

/// The text without white space at its end ([`is_js_space`]).
pub fn trim_end(value: &str) -> &str {
    value.trim_end_matches(is_js_space)
}

// PARITY(#299): the Markdown property value and the backlink sort key are parity uses of this function, to go
// with the result serialisation. `Scalar::to_js_string` in `args.rs` also calls it, and that use is not
// parity: LogSeq is ClojureScript and its `(str ?v)` writes a number as JavaScript does (`1e+21`,
// `0.000001`), so a `query_by_property` value must keep this spelling. Do not delete the function.
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
/// `JSON.stringify(value)`, for the results (ADR-0031, ADR-0009). A message that quotes a value
/// writes it with serde instead (`Value::to_string`). Numbers are written as JavaScript writes
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

/// A key JavaScript treats as an array index: a canonical decimal below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()));
    canonical.then(|| key.parse::<u32>().ok()).flatten().filter(|index| *index != u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trim_removes_what_rust_calls_white_space() {
        assert_eq!(trim(" on \u{a0}\u{2028}\t"), "on");
        // White space is Rust's set: U+0085 is in it, and a byte-order mark (U+FEFF) is not.
        assert_eq!(trim("\u{85}on\u{85}"), "on");
        assert_eq!(trim("\u{feff}on\u{feff}"), "\u{feff}on\u{feff}");
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
}
