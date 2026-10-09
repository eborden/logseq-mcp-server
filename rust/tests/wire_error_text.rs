//! The text of a response error is fixed text (ADR-0004: no value from a LogSeq answer in an error).
//!
//! The deserializer in `src/wire/deserializer.rs` keeps the message it is given by `custom`, which is what a
//! `try_from`, a `deserialize_with` or a visitor reaches through `de::Error::custom`. So the places that can
//! call it are listed here, and a new one fails this test until its author has read the rule: the message is
//! a string literal or a `&'static str` written in this crate, never a `format!` of what was received.

use std::fs;
use std::path::{Path, PathBuf};

/// A source file that may make a `custom` error, and why its text is fixed.
const ALLOWED: [(&str, &str); 1] = [
    ("src/tools/get_page_outline/wire.rs", "`TryFrom` with `type Error = &'static str`, and a `custom(\"...\")` with a literal"),
];

/// What makes a type able to put its own text in an error.
const TOKENS: [&str; 5] = ["serde(try_from", "try_from = \"", "deserialize_with", "serde(with", "Error::custom("];

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

/// The code of a file, without its tests and without comments.
fn code(path: &Path) -> String {
    let text = fs::read_to_string(path).unwrap();
    let end = text.find("#[cfg(test)]\nmod tests").unwrap_or(text.len());
    text[..end].lines().filter(|line| !line.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
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
        let code = code(&file);
        if TOKENS.iter().any(|token| code.contains(token)) {
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
