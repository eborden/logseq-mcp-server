//! The two JavaScript behaviors the server still needs. Results are not one of them: every tool
//! result is written by `serde_json` (ADR-0009, ADR-0034), with an object's keys in insertion order
//! and a number in serde's spelling, and the recorded results are compared by meaning.
//!
//! - White space (`trim`, `trim_end`) is Rust's `char::is_whitespace` (#299, wave C2).
//! - [`number_to_string`] is how LogSeq spells a number. It is not here to match the TypeScript server.

/// The text without white space at either end: Rust's `char::is_whitespace` (Unicode `White_Space`).
/// The TypeScript server used JavaScript's set, which adds U+FEFF and leaves out U+0085; the
/// Rust server takes Rust's (#299). Kept as a name for the many callers; it is `str::trim`.
pub fn trim(value: &str) -> &str {
    value.trim()
}

/// The text without white space at its end (`str::trim_end`).
pub fn trim_end(value: &str) -> &str {
    value.trim_end()
}

/// A number as `String(n)` or a template literal writes it (ECMAScript `Number::toString`).
///
/// This is not parity code. `Scalar::to_js_string` in `args.rs` uses it to spell a `query_by_property`
/// value the way LogSeq stored it: LogSeq is ClojureScript, so its `(str ?v)` writes a number as
/// JavaScript does (`1e+21`, `0.000001`, `3` for `3.0`), and a value spelled any other way would match
/// nothing. Nothing else calls it: results, Markdown property values and sort keys use serde's spelling.
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
