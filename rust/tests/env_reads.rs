//! The environment is read in one place, `src/env.rs`, into a typed `Env`. This fails when any
//! other source file can reach `std::env` for anything but the harmless `temp_dir`, `args` and
//! `current_dir`.
//!
//! It works on tokens, not lines: comments and string literals are dropped first, so a call
//! split across lines is still seen and a mention in a comment or string is not. It flags:
//! - a path into `std::env` (`std::env::var`, `::std::env::vars_os`) other than the three above;
//! - a bare `env::name` path, which only an import of `std::env` would make resolve, unless it
//!   names one of the three (a path through our own module, `crate::env::Env`, is fine);
//! - any `use` of `std::env`, alone or grouped (`use std::{env, fs}`), since an import lets a
//!   bare `var(...)` through.
//!
//! The `env!` macro is compile-time and is not a read.

use std::fs;
use std::path::{Path, PathBuf};

const ALLOWED: [&str; 3] = ["temp_dir", "args", "current_dir"];

/// The source with comments and string and char literals replaced by spaces.
fn strip(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    let ident = |c: char| c.is_alphanumeric() || c == '_';
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '/' && next == Some('/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            let mut depth = 0;
            while i < chars.len() {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            out.push(' ');
        } else if c == 'r' && (i == 0 || !ident(chars[i - 1])) && matches!(next, Some('"') | Some('#')) {
            // A raw string: r"..." or r#"..."#, any number of #.
            let mut j = i + 1;
            let mut hashes = 0;
            while chars.get(j) == Some(&'#') {
                hashes += 1;
                j += 1;
            }
            if chars.get(j) != Some(&'"') {
                out.push(c);
                i += 1;
                continue;
            }
            j += 1;
            while j < chars.len() && !(chars[j] == '"' && (1..=hashes).all(|k| chars.get(j + k) == Some(&'#'))) {
                j += 1;
            }
            i = j + 1 + hashes;
            out.push(' ');
        } else if c == '"' {
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                i += if chars[i] == '\\' { 2 } else { 1 };
            }
            i += 1;
            out.push(' ');
        } else if c == '\'' && (next == Some('\\') || chars.get(i + 2) == Some(&'\'')) {
            // A char literal ('x', '\n', '\''); a lifetime ('a) has no closing quote there.
            i += 2;
            while i < chars.len() && chars[i] != '\'' {
                i += 1;
            }
            i += 1;
            out.push(' ');
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Identifiers, `::` and single punctuation characters.
fn tokens(stripped: &str) -> Vec<String> {
    let chars: Vec<char> = stripped.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            out.push(chars[start..i].iter().collect());
        } else if c == ':' && chars.get(i + 1) == Some(&':') {
            out.push("::".to_owned());
            i += 2;
        } else {
            out.push(c.to_string());
            i += 1;
        }
    }
    out
}

/// What in `source` reaches `std::env`, one description per hit.
fn hits(source: &str) -> Vec<String> {
    let t = tokens(&strip(source));
    let at = |i: usize| t.get(i).map(String::as_str).unwrap_or("");
    let mut found = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if at(i) == "use" {
            let end = (i..t.len()).find(|&j| at(j) == ";").unwrap_or(t.len());
            let tree = &t[i + 1..end];
            let first = tree.iter().position(|tok| tok != "::").unwrap_or(0);
            if tree.get(first).map(String::as_str) == Some("std") && tree.iter().any(|tok| tok == "env") {
                found.push(format!("use {}", tree.join("")));
            }
            i = end;
            continue;
        }
        if at(i) == "env" && at(i + 1) == "::" {
            let name = at(i + 2);
            let (prefixed, prefix) = if at(i.wrapping_sub(1)) == "::" { (true, at(i.wrapping_sub(2))) } else { (false, "") };
            let into_std = prefix == "std" || prefix == "core";
            if (into_std || !prefixed) && !ALLOWED.contains(&name) {
                found.push(format!("{}env::{name}", if prefixed { format!("{prefix}::") } else { String::new() }));
            }
        }
        i += 1;
    }
    found
}

fn rust_files(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .unwrap()
        .flat_map(|entry| {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path)
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                vec![path]
            } else {
                vec![]
            }
        })
        .collect()
}

/// Only `<src>/env.rs` itself may read the environment, not a nested `env.rs`.
fn is_exempt(file: &Path, src: &Path) -> bool {
    file == src.join("env.rs")
}

#[test]
fn flags_reads_however_they_are_written() {
    assert_eq!(hits("let a = std::env::var(\"X\");"), ["std::env::var"]);
    assert_eq!(hits("let a = ::std::env::vars_os();"), ["std::env::vars_os"]);
    assert_eq!(hits("let h = std::env::home_dir();"), ["std::env::home_dir"]);
    // Split across lines, with a comment in the middle.
    assert_eq!(hits("let a = std\n    ::env // reads X\n    ::var(\"X\");"), ["std::env::var"]);
    // An import, then a bare call: the import is what is flagged.
    assert_eq!(hits("use std::env::var;\nfn f() { let _ = var(\"X\"); }"), ["use std::env::var"]);
    assert_eq!(hits("use std::env;\nfn f() { let _ = env::var(\"X\"); }"), ["use std::env", "env::var"]);
    assert_eq!(hits("use std::{collections::HashMap, env};"), ["use std::{collections::HashMap,env}"]);
    assert_eq!(hits("pub use ::std::{\n    env::{self, var},\n};"), ["use ::std::{env::{self,var},}"]);
}

#[test]
fn ignores_what_is_not_a_read() {
    for source in [
        "// std::env::var(\"X\")",
        "/* std::env::var(\"X\") /* nested */ std::env::vars() */",
        "let s = \"std::env::var\";",
        "let s = r#\"use std::env;\"#;",
        "let c = '\"'; let d = std::env::temp_dir();",
        "fn f<'a>(x: &'a str) {}",
        "let dir = env!(\"CARGO_MANIFEST_DIR\");",
        "let p = std::env::temp_dir(); let a = std::env::args(); let c = std::env::current_dir();",
        "use logseq_mcp_server::env::Env; use crate::env::{Env, TipsOverride};",
        "let e = crate::env::Env::from_vars(&vars, None);",
        "let env = make(); env.config_path.as_path();",
        "use std::{fs, path::Path};",
    ] {
        assert!(hits(source).is_empty(), "{source:?}: {:?}", hits(source));
    }
}

#[test]
fn only_the_top_level_env_rs_is_exempt() {
    let src = Path::new("/repo/rust/src");
    assert!(is_exempt(Path::new("/repo/rust/src/env.rs"), src));
    assert!(!is_exempt(Path::new("/repo/rust/src/x/env.rs"), src));
    assert!(!is_exempt(Path::new("/repo/rust/src/myenv.rs"), src));
}

#[test]
fn only_env_rs_reads_the_environment() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let files = rust_files(&src);
    assert!(files.iter().any(|f| is_exempt(f, &src)), "the scan must see src/env.rs");
    assert!(!hits(&fs::read_to_string(src.join("env.rs")).unwrap()).is_empty(), "env.rs is where the reads are");
    let found: Vec<String> = files
        .iter()
        .filter(|file| !is_exempt(file, &src))
        .flat_map(|file| {
            let text = fs::read_to_string(file).unwrap();
            hits(&text).into_iter().map(move |hit| format!("{}: {hit}", file.display()))
        })
        .collect();
    assert!(found.is_empty(), "read the environment in src/env.rs only, through Env:\n{}", found.join("\n"));
}
