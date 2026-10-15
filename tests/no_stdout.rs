//! Stdout is the MCP stdio channel (ADR-0004): nothing in `src/` may print to it.
//! `rmcp::transport::stdio()` in `main.rs` is the one writer, and
//! it is the protocol itself.

use std::fs;
use std::path::{Path, PathBuf};

const FORBIDDEN: [&str; 5] = ["print!(", "println!(", "stdout()", "io::stdout", "dbg!("];

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

fn hits(text: &str) -> Vec<String> {
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim_start().starts_with("//"))
        .filter(|(_, line)| {
            FORBIDDEN.iter().any(|needle| {
                // `eprint!(` and `eprintln!(` contain `print!(`/`println!(`; they go to stderr.
                line.match_indices(needle).any(|(i, _)| !line[..i].ends_with('e'))
            })
        })
        .map(|(n, line)| format!("{}: {}", n + 1, line.trim()))
        .collect()
}

#[test]
fn flags_stdout_writes_and_allows_stderr() {
    assert_eq!(hits("println!(\"x\");\neprintln!(\"y\");\n// println!(\"z\")\nlet o = std::io::stdout();\ndbg!(v);").len(), 3);
    assert!(hits("eprint!(\"a\"); eprintln!(\"b\");").is_empty());
}

#[test]
fn no_source_file_writes_to_stdout() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let files = rust_files(&src);
    assert!(files.iter().any(|f| f.ends_with("main.rs")), "the scan must see src/main.rs");
    let found: Vec<String> = files
        .iter()
        .flat_map(|file| {
            let text = fs::read_to_string(file).unwrap();
            hits(&text).into_iter().map(move |hit| format!("{}:{hit}", file.display()))
        })
        .collect();
    assert!(found.is_empty(), "stdout is the MCP channel; log with eprintln! (ADR-0004):\n{}", found.join("\n"));
}
