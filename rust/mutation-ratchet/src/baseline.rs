//! `rust/mutation-baseline.json`, the committed per-file scores (ADR-0033 "Baseline").
//!
//! The file is PR 2 of #364, so nothing gates on it yet. It is read here so that the plan's third group (a changed baseline
//! entry is measured whole) exists from the start and its shape is pinned:
//!
//! ```json
//! {
//!   "cargo-mutants": "27.1.0",
//!   "files": {
//!     "rust/src/a.rs": { "score": 91.3, "ignores": 2 },
//!     "rust/src/b.rs": { "score": 100.0, "ignores": 0 }
//!   }
//! }
//! ```
//!
//! Keys are repository paths, one line per file in sorted order. `files_of_changed_entries` gives them back as paths relative
//! to the server crate (`src/a.rs`), which is how `cargo mutants` names a file.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaselineError(pub String);

impl fmt::Display for BaselineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BaselineError {}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub score: f64,
    pub ignores: u32,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Baseline {
    #[serde(rename = "cargo-mutants")]
    pub tool_version: String,
    pub files: BTreeMap<String, Entry>,
}

/// The prefix of a key: the server crate's directory in the repository.
pub const CRATE_DIR: &str = "rust/";

pub fn parse(text: &str) -> Result<Baseline, BaselineError> {
    let baseline: Baseline = serde_json::from_str(text).map_err(|e| BaselineError(format!("the baseline doesn't have the expected shape: {e}")))?;
    for (key, entry) in &baseline.files {
        if !key.starts_with(CRATE_DIR) || key.len() == CRATE_DIR.len() {
            return Err(BaselineError("a baseline key is not a path under rust/".into()));
        }
        if !(0.0..=100.0).contains(&entry.score) {
            return Err(BaselineError("a baseline score is outside 0 to 100".into()));
        }
    }
    Ok(baseline)
}

/// Files whose entry is new or different in `new`. A removed entry is not here: its file has nothing left to check.
/// `old` is `None` when the base has no baseline yet (the PR that introduces it), so every entry counts as new.
pub fn files_of_changed_entries(old: Option<&Baseline>, new: Option<&Baseline>) -> BTreeSet<String> {
    let Some(new) = new else { return BTreeSet::new() };
    new.files
        .iter()
        .filter(|(key, entry)| old.and_then(|old| old.files.get(*key)) != Some(entry))
        .map(|(key, _)| key.strip_prefix(CRATE_DIR).unwrap_or(key).to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn baseline(entries: &[(&str, f64, u32)]) -> Baseline {
        Baseline {
            tool_version: "27.1.0".into(),
            files: entries.iter().map(|(k, score, ignores)| (k.to_string(), Entry { score: *score, ignores: *ignores })).collect(),
        }
    }

    #[test]
    fn reads_the_documented_shape() {
        let text = r#"{"cargo-mutants":"27.1.0","files":{"rust/src/a.rs":{"score":91.3,"ignores":2},"rust/src/b.rs":{"score":100.0,"ignores":0}}}"#;
        assert_eq!(parse(text).unwrap(), baseline(&[("rust/src/a.rs", 91.3, 2), ("rust/src/b.rs", 100.0, 0)]));
    }

    #[test]
    fn refuses_what_it_does_not_know() {
        assert!(parse("").is_err());
        assert!(parse("{}").is_err());
        assert!(parse(r#"{"cargo-mutants":"27.1.0","files":{},"extra":1}"#).is_err());
        assert!(parse(r#"{"cargo-mutants":"27.1.0","files":{"src/a.rs":{"score":1.0,"ignores":0}}}"#).is_err());
        assert!(parse(r#"{"cargo-mutants":"27.1.0","files":{"rust/":{"score":1.0,"ignores":0}}}"#).is_err());
        assert!(parse(r#"{"cargo-mutants":"27.1.0","files":{"rust/src/a.rs":{"score":101.0,"ignores":0}}}"#).is_err());
        assert!(parse(r#"{"cargo-mutants":"27.1.0","files":{"rust/src/a.rs":{"score":-1.0,"ignores":0}}}"#).is_err());
        assert!(parse(r#"{"cargo-mutants":"27.1.0","files":{"rust/src/a.rs":{"score":1.0}}}"#).is_err());
    }

    #[test]
    fn a_changed_or_added_entry_is_found_and_an_unchanged_or_removed_one_is_not() {
        let old = baseline(&[("rust/src/same.rs", 90.0, 0), ("rust/src/raised.rs", 80.0, 0), ("rust/src/gone.rs", 70.0, 0), ("rust/src/ign.rs", 60.0, 0)]);
        let new = baseline(&[("rust/src/same.rs", 90.0, 0), ("rust/src/raised.rs", 85.0, 0), ("rust/src/added.rs", 80.0, 1), ("rust/src/ign.rs", 60.0, 1)]);
        let changed = files_of_changed_entries(Some(&old), Some(&new));
        assert_eq!(changed.into_iter().collect::<Vec<_>>(), vec!["src/added.rs", "src/ign.rs", "src/raised.rs"]);
    }

    #[test]
    fn the_pr_that_adds_the_baseline_changes_every_entry() {
        let new = baseline(&[("rust/src/a.rs", 90.0, 0), ("rust/src/b.rs", 80.0, 0)]);
        assert_eq!(files_of_changed_entries(None, Some(&new)).len(), 2);
    }

    #[test]
    fn no_baseline_at_the_head_changes_nothing() {
        let old = baseline(&[("rust/src/a.rs", 90.0, 0)]);
        assert!(files_of_changed_entries(Some(&old), None).is_empty());
        assert!(files_of_changed_entries(None, None).is_empty());
    }
}
