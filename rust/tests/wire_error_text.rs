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
const TOKENS: [&str; 13] = [
    "serde(try_from",
    "try_from = \"",
    "deserialize_with",
    "serde(with",
    "::custom",
    ".custom(",
    "fn custom",
    "impl<'de> Deserialize",
    "impl Deserialize",
    "Deserialize<'de> for",
    "Visitor<'de> for",
    "Visitor<'_> for",
    ".deserialize_any(",
];

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
fn code_of(text: &str) -> String {
    let end = text.find("#[cfg(test)]\nmod tests").unwrap_or(text.len());
    text[..end].lines().filter(|line| !line.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
}

/// The code of a file, without its tests and without comments.
fn code(path: &Path) -> String {
    code_of(&fs::read_to_string(path).unwrap())
}

/// The tokens a source text holds, in `TOKENS` order.
fn tokens_in(source: &str) -> Vec<&'static str> {
    let code = code_of(source);
    TOKENS.iter().copied().filter(|token| code.contains(token)).collect()
}

#[test]
fn only_the_listed_files_can_put_their_own_text_in_an_error() {
    let mut files = Vec::new();
    sources(&root().join("src"), &mut files);
    let mut found = Vec::new();
    for file in files {
        let relative = file.strip_prefix(root()).unwrap().to_string_lossy().replace('\\', "/");
        if relative.ends_with("/reading.rs") {
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
fn the_scan_ignores_comments_and_the_tests_module() {
    let source = "// E::custom( is how a bad one looks\nfn fine() {}\n#[cfg(test)]\nmod tests {\n    fn t() { E::custom(\"x\") }\n}\n";
    assert_eq!(tokens_in(source), Vec::<&str>::new());
}
