//! The mutants `cargo mutants --list --json` prints, counted by file.
//!
//! The plan counts mutants exactly with the tool (ADR-0033 "The budget"), so there is no cached count to go stale.

use std::collections::BTreeMap;
use std::fmt;

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListError(pub String);

impl fmt::Display for ListError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ListError {}

#[derive(Deserialize)]
struct Listed {
    /// Relative to the directory cargo-mutants ran in (the server's, `rust/`), with forward slashes.
    file: String,
}

/// Mutants per file from the stdout of `cargo mutants --list --json`.
///
/// With `--in-diff` the tool prints nothing at all, not `[]`, when the diff overlaps no mutant (it returns before the list is
/// printed), so empty output is an empty list.
pub fn count_by_file(stdout: &str) -> Result<BTreeMap<String, usize>, ListError> {
    let mut counts = BTreeMap::new();
    if stdout.trim().is_empty() {
        return Ok(counts);
    }
    let listed: Vec<Listed> = serde_json::from_str(stdout)
        .map_err(|err| ListError(format!("`cargo mutants --list --json` printed something that is not a list of mutants: {err}")))?;
    for mutant in listed {
        *counts.entry(mutant.file).or_insert(0) += 1;
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_mutants_per_file_and_ignores_the_other_fields() {
        let out = r#"[
          {"name":"src/a.rs:1:1: replace f with ()","package":"p","file":"src/a.rs","function":null,"span":{"start":{"line":1,"column":1},"end":{"line":2,"column":1}},"replacement":"()","genre":"FnValue","diff":""},
          {"name":"src/a.rs:5:1: replace g with ()","package":"p","file":"src/a.rs","replacement":"()","genre":"FnValue"},
          {"name":"src/b.rs:1:1: replace h with ()","package":"p","file":"src/b.rs"}
        ]"#;
        let counts = count_by_file(out).unwrap();
        assert_eq!(counts.get("src/a.rs"), Some(&2));
        assert_eq!(counts.get("src/b.rs"), Some(&1));
        assert_eq!(counts.len(), 2);
    }

    #[test]
    fn no_output_is_an_empty_list_and_so_is_an_empty_array() {
        assert!(count_by_file("").unwrap().is_empty());
        assert!(count_by_file("\n").unwrap().is_empty());
        assert!(count_by_file("[]").unwrap().is_empty());
    }

    #[test]
    fn output_that_is_not_a_list_is_an_error() {
        assert!(count_by_file("not json").is_err());
        assert!(count_by_file("{}").is_err());
        assert!(count_by_file(r#"[{"name":"x"}]"#).is_err());
        assert!(count_by_file(r#"[{"file":1}]"#).is_err());
    }
}
