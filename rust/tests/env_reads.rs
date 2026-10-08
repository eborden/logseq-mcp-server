//! The environment is read in one place, `src/env.rs`, into a typed `Env`. This fails when any
//! other source file reads a variable or the home directory itself.

use std::fs;
use std::path::{Path, PathBuf};

const READS: [&str; 6] = ["env::var(", "env::var_os(", "env::vars(", "env::vars_os(", "home_dir(", "env!(\"HOME"];

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
        .filter(|(_, line)| READS.iter().any(|needle| line.contains(needle)))
        .map(|(n, line)| format!("{}: {}", n + 1, line.trim()))
        .collect()
}

#[test]
fn flags_environment_reads() {
    assert_eq!(hits("let a = std::env::var(\"X\");\n// std::env::var(\"Y\")\nlet h = std::env::home_dir();").len(), 2);
    assert!(hits("let p = env.config_path.as_path();").is_empty());
}

#[test]
fn only_env_rs_reads_the_environment() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let files = rust_files(&src);
    assert!(files.iter().any(|f| f.ends_with("env.rs")), "the scan must see src/env.rs");
    assert!(!hits(&fs::read_to_string(src.join("env.rs")).unwrap()).is_empty(), "env.rs is where the reads are");
    let found: Vec<String> = files
        .iter()
        .filter(|file| !file.ends_with("env.rs"))
        .flat_map(|file| {
            let text = fs::read_to_string(file).unwrap();
            hits(&text).into_iter().map(move |hit| format!("{}:{hit}", file.display()))
        })
        .collect();
    assert!(found.is_empty(), "read the environment in src/env.rs only, through Env:\n{}", found.join("\n"));
}
