//! The text of a response error is fixed text (ADR-0004: no value from a LogSeq answer in an error).
//!
//! The deserializer in `src/wire/deserializer.rs` keeps the message it is given by `custom`, which is what a
//! `try_from`, a `deserialize_with` or a visitor reaches through `de::Error::custom`. So the places that can
//! call it are listed here, and a new one fails this test until its author has read the rule: the message is
//! a string literal or a `&'static str` written in this crate, never a `format!` of what was received.

use std::fs;
use std::path::{Path, PathBuf};

/// A source file that may make a `custom` error, and why its text is fixed.
const ALLOWED: [(&str, &str); 5] = [
    ("src/args.rs", "reads the arguments a client sent, never a LogSeq answer (ADR-0004 is about the answer); its one visitor builds no error text"),
    ("src/resolve/wire.rs", "hand-written row visitors whose only error is `invalid_length`, which the deserializer turns into fixed text"),
    ("src/tools/get_page_outline/wire.rs", "`TryFrom` with `type Error = &'static str`, and a `custom(\"...\")` with a literal"),
    ("src/wire.rs", "hand-written visitors (`Id`, `Number`, `Object`, `Optional`) whose errors are `invalid_value` with a literal, which the deserializer turns into fixed text"),
    ("src/wire/deserializer.rs", "defines `custom`, the one place a message is kept as given (`Problem::Other`), and says that only fixed text may be passed"),
];

/// What makes a type able to put its own text in an error.
///
/// `::custom` and `.custom(` stand for every spelling of the call: `Error::custom(`, `E::custom(` through an alias
/// or a generic parameter, `de::Error::custom` passed as a function value (`.map_err(de::Error::custom)`), and a
/// method call. The `impl` and `Visitor` tokens catch a hand-written deserializer, which can build an error from
/// a received value without ever writing `custom`. `fn custom` catches a type that defines its own `custom`.
const TOKENS: [&str; 9] = [
    "serde(try_from",
    "try_from = \"",
    "deserialize_with",
    "serde(with",
    "::custom",
    ".custom(",
    "fn custom",
    "impl Deserialize",
    ".deserialize_any(",
];

/// The keys of a `#[serde(...)]` attribute that hand over the error (or the whole read) to code written by hand,
/// wherever they sit in the list: `#[serde(default, with = "m")]` has `with` second. `from` and `into` are left
/// out on purpose: they name a `From` / `Into` conversion, which cannot fail, so it has no error text to fix.
const SERDE_KEYS: [&str; 3] = ["with", "deserialize_with", "try_from"];

/// The traits a hand-written reader implements, whatever the lifetime is called: `impl<'de> Visitor<'de> for`,
/// `impl<'a> Deserialize<'a> for`, `impl Visitor<'_> for`, `impl<'de, T: Deserialize<'de>> Deserialize<'de> for`.
const READER_TRAITS: [&str; 3] = ["Deserialize", "DeserializeSeed", "Visitor"];

/// The calls that make an error, in a listed file. Their arguments must not hold a `format!`.
const ERROR_CALLS: [&str; 7] =
    ["invalid_value(", "invalid_type(", "invalid_length(", "custom(", "Issue::other(", "Problem::Other(", "Why::Other("];

/// The one file that is wholly tests (`#[cfg(test)] mod reading;`), so the scan skips it. By exact path, so a
/// file of that name anywhere else is scanned.
const ONLY_TESTS: &str = "src/wire/reading.rs";

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The code of a source text, without its tests and without comments.
///
/// The tests module is cut off only where it is the last item. A line at column 0 after its opening line, other
/// than the closing `}`, is rustfmt's sign that an item follows the module: that item is code and is kept.
fn code_of(text: &str) -> String {
    const TESTS: &str = "#[cfg(test)]\nmod tests";
    let (before, after) = match text.find(TESTS) {
        Some(at) => (&text[..at], text[at + TESTS.len()..].lines().skip(1).collect::<Vec<_>>()),
        None => (text, Vec::new()),
    };
    let item_after = after.iter().position(|line| !line.is_empty() && !line.starts_with(char::is_whitespace) && *line != "}");
    let kept = item_after.map(|at| after[at..].join("\n")).unwrap_or_default();
    format!("{before}\n{kept}").lines().filter(|line| !line.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
}

/// The text between the `(` that opens at `from` (the index after it) and its matching `)`, skipping strings.
fn call_text(code: &str, from: usize) -> &str {
    let (mut depth, mut in_string, mut escaped) = (1, false, false);
    for (at, ch) in code[from..].char_indices() {
        match ch {
            _ if escaped => escaped = false,
            '\\' if in_string => escaped = true,
            '"' => in_string = !in_string,
            '(' if !in_string => depth += 1,
            ')' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return &code[from..from + at];
                }
            }
            _ => {}
        }
    }
    &code[from..]
}

/// The `#[serde(...)]` keys of `SERDE_KEYS` that a source text uses, in any position of the attribute.
fn serde_keys(code: &str) -> Vec<&'static str> {
    let mut found = Vec::new();
    for (at, head) in code.match_indices("serde(") {
        for part in call_text(code, at + head.len()).split(',') {
            let key = part.split('=').next().unwrap_or("").trim();
            if let Some(known) = SERDE_KEYS.iter().find(|known| **known == key) {
                found.push(*known);
            }
        }
    }
    found
}

/// The reader traits (`READER_TRAITS`) that a source text implements by hand, whatever the lifetime is called and
/// however rustfmt wrapped the line: whitespace of any kind, newlines too, may sit between the closing `>` and
/// the `for` (or a `where`) that follows it.
fn reader_impls(code: &str) -> Vec<&'static str> {
    let mut found = Vec::new();
    for name in READER_TRAITS {
        let head = format!("{name}<'");
        for (at, _) in code.match_indices(&head) {
            let rest = &code[at + head.len()..];
            let Some(close) = rest.find('>') else { continue };
            let next = rest[close + 1..].trim_start();
            let word = next.split(|ch: char| !ch.is_alphanumeric() && ch != '_').next().unwrap_or("");
            if matches!(word, "for" | "where") {
                found.push(name);
            }
        }
    }
    found
}

/// Whether an error call (`ERROR_CALLS`) in a source text has a `format!` among its arguments.
fn formats_an_error(code: &str) -> bool {
    ERROR_CALLS.iter().any(|call| code.match_indices(call).any(|(at, _)| call_text(code, at + call.len()).contains("format!(")))
}

/// The code of a file, without its tests and without comments.
fn code(path: &Path) -> String {
    code_of(&fs::read_to_string(path).unwrap())
}

/// What a source text holds that makes its own error text: the `TOKENS`, then the `serde` keys and the reader
/// traits it implements, by name.
fn tokens_in(source: &str) -> Vec<&'static str> {
    let code = code_of(source);
    let mut found: Vec<&'static str> = TOKENS.iter().copied().filter(|token| code.contains(token)).collect();
    found.extend(serde_keys(&code));
    found.extend(reader_impls(&code));
    found
}

#[test]
fn only_the_listed_files_can_put_their_own_text_in_an_error() {
    let mut files = Vec::new();
    sources(&root().join("src"), &mut files);
    let mut found = Vec::new();
    for file in files {
        let relative = file.strip_prefix(root()).unwrap().to_string_lossy().replace('\\', "/");
        if relative == ONLY_TESTS {
            continue;
        }
        if !tokens_in(&fs::read_to_string(&file).unwrap()).is_empty() {
            found.push(relative);
        }
    }
    found.sort();
    let allowed: Vec<&str> = ALLOWED.iter().map(|(path, _)| *path).collect();
    assert_eq!(
        found, allowed,
        "a file that makes its own error text (try_from, deserialize_with, custom) must keep it fixed text, never a received value (ADR-0004): add it to ALLOWED with the reason, after checking"
    );
}

#[test]
fn the_deserializer_says_the_rule_where_custom_is_defined() {
    let deserializer = fs::read_to_string(root().join("src/wire/deserializer.rs")).unwrap();
    assert!(deserializer.contains("Only fixed text may be passed"), "`custom` must say that its message is kept as given");
    assert!(deserializer.contains("fixed text written in this crate"), "`Problem::Other` must say that its text is fixed");
}

#[test]
fn the_text_a_listed_type_gives_is_a_literal() {
    let outline = code(&root().join("src/tools/get_page_outline/wire.rs"));
    assert!(outline.contains("type Error = &'static str;"), "the outline's try_from must fail with a &'static str");
    for (at, _) in outline.match_indices("custom(") {
        assert!(outline[at + "custom(".len()..].starts_with('"'), "custom must be given a string literal");
    }
    for (at, _) in outline.match_indices("return Err(") {
        assert!(outline[at + "return Err(".len()..].starts_with('"'), "an error from try_from must be a string literal");
    }
}

// The scan reads text, so each bypass below is a made-up source held in a string: no violating file is in the tree.

#[test]
fn the_scan_catches_a_custom_call_through_an_alias_or_a_generic_parameter() {
    let source = "fn read<E: de::Error>(text: &str) -> E {\n    E::custom(format!(\"bad {text}\"))\n}\n";
    assert!(tokens_in(source).contains(&"::custom"), "`E::custom(` has no `Error::custom(` in it, and must still be caught");
}

#[test]
fn the_scan_catches_custom_passed_as_a_function() {
    let source = "let id = parse(text).map_err(de::Error::custom)?;\n";
    assert!(tokens_in(source).contains(&"::custom"), "`.map_err(de::Error::custom)` has no opening paren, and must still be caught");
}

#[test]
fn the_scan_catches_custom_called_as_a_method() {
    let source = "let error = issue.custom(received);\n";
    assert!(tokens_in(source).contains(&".custom("), "a `.custom(` method call must be caught");
}

#[test]
fn the_scan_catches_a_type_that_defines_its_own_custom() {
    let source = "impl de::Error for Mine {\n    fn custom<T: fmt::Display>(message: T) -> Self {\n        Mine(message.to_string())\n    }\n}\n";
    assert!(tokens_in(source).contains(&"fn custom"), "a second `custom` must be caught");
}

#[test]
fn the_scan_catches_a_hand_written_deserialize_impl() {
    for source in [
        "impl<'de> Deserialize<'de> for Mine {\n    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> { todo!() }\n}\n",
        "impl Deserialize for Mine {}\n",
        "impl<'de, T: Deserialize<'de>> Deserialize<'de> for Wrapper<T> {}\n",
    ] {
        assert!(!tokens_in(source).is_empty(), "a manual `Deserialize` impl must be caught: {source}");
    }
}

#[test]
fn the_scan_catches_a_hand_written_visitor() {
    for source in [
        "impl<'de> Visitor<'de> for MineVisitor {\n    type Value = Mine;\n}\n",
        "impl Visitor<'_> for MineVisitor {\n    type Value = Mine;\n}\n",
        "let value = deserializer.deserialize_any(MineVisitor)?;\n",
    ] {
        assert!(!tokens_in(source).is_empty(), "a manual `Visitor` must be caught: {source}");
    }
}

#[test]
fn the_scan_still_catches_each_attribute_that_names_its_own_error() {
    for source in ["#[serde(try_from = \"Raw\")]\n", "#[serde(deserialize_with = \"f\")]\n", "#[serde(with = \"m\")]\n"] {
        assert!(!tokens_in(source).is_empty(), "an attribute that picks its own error must be caught: {source}");
    }
}

#[test]
fn the_scan_passes_ordinary_code() {
    let source = "#[derive(Deserialize)]\nstruct Page {\n    name: String,\n}\n\nfn read(answer: &Value) -> Result<Page, ResponseError> {\n    wire::read(\"Editor.getPage\", answer)\n}\n";
    assert_eq!(tokens_in(source), Vec::<&str>::new());
}

#[test]
fn the_scan_ignores_a_comment() {
    let source = "// E::custom( is how a bad one looks\nfn fine() {}\n";
    assert_eq!(tokens_in(source), Vec::<&str>::new());
}

#[test]
fn the_scan_ignores_a_tests_module_that_is_the_last_item() {
    let source = "fn fine() {}\n\n#[cfg(test)]\nmod tests {\n    fn t() { E::custom(\"x\") }\n\n    #[test]\n    fn u() {}\n}\n";
    assert_eq!(tokens_in(source), Vec::<&str>::new());
}

#[test]
fn the_scan_reads_an_item_placed_after_the_tests_module() {
    let source = "#[cfg(test)]\nmod tests {\n    fn t() {}\n}\n\nfn later<E: de::Error>() -> E {\n    E::custom(\"x\")\n}\n";
    assert!(tokens_in(source).contains(&"::custom"), "code after an early `mod tests` must still be scanned");
}

#[test]
fn the_scan_catches_a_serde_key_wherever_it_sits_in_the_attribute() {
    for (source, key) in [
        ("#[serde(with = \"m\")]\n", "with"),
        ("#[serde(default, with = \"m\")]\n", "with"),
        ("#[serde(default,with=\"m\")]\n", "with"),
        ("#[serde(rename = \"x\", deserialize_with = \"f\")]\n", "deserialize_with"),
        ("#[serde(default, try_from = \"Raw\")]\n", "try_from"),
    ] {
        assert!(tokens_in(source).contains(&key), "`{key}` in a serde attribute must be caught: {source}");
    }
}

#[test]
fn the_scan_passes_the_serde_keys_that_pick_no_error() {
    let source = "#[serde(rename = \"with\", default = \"from\", skip_serializing_if = \"Option::is_none\")]\n#[serde(transparent)]\n#[serde(from = \"Raw\")]\nstruct A;\n";
    assert_eq!(tokens_in(source), Vec::<&str>::new());
}

#[test]
fn the_scan_catches_a_reader_trait_whatever_its_lifetime_is_called() {
    for (source, name) in [
        ("impl<'a> Deserialize<'a> for Mine {}\n", "Deserialize"),
        ("impl<'de> Deserialize<'de> for Mine {}\n", "Deserialize"),
        ("impl<'de, T: Deserialize<'de>> Deserialize<'de> for Wrapper<T> {}\n", "Deserialize"),
        ("impl<'a> Visitor<'a> for MineVisitor {}\n", "Visitor"),
        ("impl<'de> Visitor<'de> for MineVisitor {}\n", "Visitor"),
        ("impl Visitor<'_> for MineVisitor {}\n", "Visitor"),
        ("impl<'a> DeserializeSeed<'a> for Mine {}\n", "DeserializeSeed"),
    ] {
        assert!(tokens_in(source).contains(&name), "`{name}` implemented by hand must be caught: {source}");
    }
}

#[test]
fn the_scan_catches_a_reader_trait_impl_that_rustfmt_wrapped() {
    for (source, name) in [
        ("impl<'de> Deserialize<'de>\n    for SomeVeryLongTypeName<WithGenerics> {}\n", "Deserialize"),
        ("impl<'de> Deserialize<'de>\nfor SomeVeryLongTypeName {}\n", "Deserialize"),
        ("impl<'de> Deserialize<'de>\n        where\n    T: Clone,\n{}\n", "Deserialize"),
        ("impl<'a> Deserialize<'a>  \n   for Mine {}\n", "Deserialize"),
        ("impl<'de> DeserializeSeed<'de>\n    for SomeVeryLongTypeName<WithGenerics> {}\n", "DeserializeSeed"),
        ("impl<'de> DeserializeSeed<'de>\n    where\n        T: Clone,\n{}\n", "DeserializeSeed"),
        ("impl<'de> Visitor<'de>\n    for SomeVeryLongVisitorName<WithGenerics> {}\n", "Visitor"),
        ("impl<'de> Visitor<'de>\n    where\n        T: Clone,\n{}\n", "Visitor"),
        ("impl Visitor<'_>\n\tfor Mine {}\n", "Visitor"),
    ] {
        assert!(tokens_in(source).contains(&name), "a wrapped `{name}` impl must be caught: {source}");
    }
}

/// What the five-token scan this one replaced caught, spelled the way the old scan saw it and the way rustfmt
/// might wrap or space it. Every one must still be caught: a guard may only get stronger.
#[test]
fn everything_the_old_five_token_scan_caught_is_still_caught() {
    let corpus = [
        // `serde(try_from`
        "#[serde(try_from = \"Raw\")]\nstruct A;\n",
        "#[serde(try_from=\"Raw\")]\nstruct A;\n",
        "#[serde(\n    try_from = \"Raw\"\n)]\nstruct A;\n",
        "#[serde(try_from = \"Raw\", default)]\nstruct A;\n",
        // `try_from = "`
        "#[cfg_attr(feature = \"x\", serde(try_from = \"Raw\"))]\nstruct A;\n",
        "#[some(try_from = \"Raw\")]\nstruct A;\n",
        // `deserialize_with`
        "#[serde(deserialize_with = \"f\")]\nx: u8,\n",
        "#[serde(\n    default,\n    deserialize_with = \"f\"\n)]\nx: u8,\n",
        "#[serde(default, deserialize_with=\"f\")]\nx: u8,\n",
        // `serde(with`
        "#[serde(with = \"m\")]\nx: u8,\n",
        "#[serde(with=\"m\")]\nx: u8,\n",
        "#[serde(\n    with = \"m\"\n)]\nx: u8,\n",
        "#[serde(with = \"m\", default)]\nx: u8,\n",
        // `Error::custom(`
        "Err(de::Error::custom(\"x\"))\n",
        "Err(Error::custom(\"x\"))\n",
        "Err(serde::de::Error::custom(\n    \"x\",\n))\n",
        "Err(de::Error\n    ::custom(\"x\"))\n",
        "Err(de::Error::custom(format!(\"bad {value}\")))\n",
        "x.map_err(|_| <E as de::Error>::custom(\"x\"))\n",
    ];
    for source in corpus {
        assert!(!tokens_in(source).is_empty(), "the old scan caught this, so this one must: {source}");
    }
}

#[test]
fn the_scan_passes_a_bound_that_only_names_a_reader_trait() {
    let source = "fn read<'de, T: Deserialize<'de>, V: Visitor<'de>, S: DeserializeSeed<'de>>(t: T) {}\n";
    assert_eq!(tokens_in(source), Vec::<&str>::new());
}

#[test]
fn only_the_one_file_of_tests_is_skipped_by_path() {
    let wire = fs::read_to_string(root().join("src/wire.rs")).unwrap();
    assert!(wire.contains("#[cfg(test)]\nmod reading;"), "{ONLY_TESTS} must be declared as a test-only module");
    assert!(root().join(ONLY_TESTS).is_file(), "{ONLY_TESTS} must exist");
}

#[test]
fn the_check_for_a_format_in_an_error_call_catches_each_call() {
    for source in [
        "Err(E::invalid_value(Unexpected::Str(s), &format!(\"not {s}\")))\n",
        "Err(de::Error::custom(format!(\"bad {text}\")))\n",
        "Issue::other(&format!(\"a {value}\"))\n",
        "Issue::new(Problem::Other(format!(\"{text}\")))\n",
        "E::invalid_length(n, &format!(\"{n}\"))\n",
        "x.ok_or_else(|| de::Error::custom(format!(\"(\\\"{x}\")))\n",
    ] {
        assert!(formats_an_error(source), "a `format!` inside an error call must be caught: {source}");
    }
}

#[test]
fn the_check_for_a_format_in_an_error_call_passes_fixed_text() {
    for source in [
        "Err(E::invalid_value(Unexpected::Str(s), &\"a whole number\"))\n",
        "let names = format!(\"{a} or {b}\");\nIssue::other(\"fixed\")\n",
        "Issue::new(Problem::Other(\"given twice\".to_owned()))\n",
    ] {
        assert!(!formats_an_error(source), "fixed text in an error call must pass: {source}");
    }
}

#[test]
fn no_listed_file_formats_text_into_an_error_call() {
    for (path, _) in ALLOWED {
        assert!(!formats_an_error(&code(&root().join(path))), "{path} puts a `format!` inside an error call: ADR-0004 allows fixed text only");
    }
}
