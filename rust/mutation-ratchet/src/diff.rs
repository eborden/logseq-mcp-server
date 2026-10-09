//! What a `git diff` says about one file: its status and which lines changed.
//!
//! Both come from git's own machine-readable forms (`--name-status -z`, and the hunk headers of `-U0`), so no
//! unified-diff body is ever parsed here.

use std::fmt;

/// How a path changed between the base and the head.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    Added,
    Modified,
    Deleted,
}

/// The lines a diff touches: `added` are line numbers in the new file, `removed` are line numbers in the old one.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LineChanges {
    pub added: Vec<u32>,
    pub removed: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffError(pub String);

impl fmt::Display for DiffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DiffError {}

/// Read `git diff --name-status -z --no-renames` output: `STATUS NUL PATH NUL` repeated.
///
/// With renames off git reports only A, M, D, T (type change) and U (unmerged). A type change is a modification here.
/// Anything else is an error rather than a guess, since the plan decides what is tested from it.
pub fn parse_name_status(output: &str) -> Result<Vec<(Status, String)>, DiffError> {
    let mut parts = output.split('\0');
    let mut out = Vec::new();
    loop {
        let Some(status) = parts.next() else { break };
        if status.is_empty() {
            // The trailing NUL leaves one empty piece, and an empty diff is one empty piece.
            if parts.all(str::is_empty) {
                break;
            }
            return Err(DiffError("name-status output has an empty status".into()));
        }
        let Some(path) = parts.next().filter(|p| !p.is_empty()) else {
            return Err(DiffError(format!("name-status status {status:?} has no path")));
        };
        let status = match status {
            "A" => Status::Added,
            "M" | "T" => Status::Modified,
            "D" => Status::Deleted,
            other => return Err(DiffError(format!("unexpected name-status status {other:?}"))),
        };
        out.push((status, path.to_string()));
    }
    Ok(out)
}

/// Read the hunk headers of a zero-context diff of one file (`git diff -U0`).
///
/// A header is `@@ -OLD[,N] +NEW[,M] @@`. N and M default to 1 and a count of 0 means that side has no lines in the hunk.
/// Only header lines are read, so a changed line that happens to start with `@@ -` can't be taken for one: in a diff
/// every body line starts with a space, `+` or `-`.
pub fn parse_line_changes(diff: &str) -> Result<LineChanges, DiffError> {
    let mut changes = LineChanges::default();
    for line in diff.lines() {
        let Some(rest) = line.strip_prefix("@@ -") else { continue };
        let header = rest.split(" @@").next().unwrap_or(rest);
        let mut sides = header.split(" +");
        let (Some(old), Some(new), None) = (sides.next(), sides.next(), sides.next()) else {
            return Err(DiffError("a hunk header is not `@@ -a,b +c,d @@`".into()));
        };
        let (old_start, old_count) = range(old)?;
        let (new_start, new_count) = range(new)?;
        changes.removed.extend(old_start..old_start + old_count);
        changes.added.extend(new_start..new_start + new_count);
    }
    Ok(changes)
}

fn range(text: &str) -> Result<(u32, u32), DiffError> {
    let bad = || DiffError(format!("a hunk range {text:?} is not `start[,count]`"));
    let (start, count) = match text.split_once(',') {
        Some((start, count)) => (start, count),
        None => (text, "1"),
    };
    Ok((start.parse().map_err(|_| bad())?, count.parse().map_err(|_| bad())?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_status_reads_each_status() {
        let out = "A\0rust/src/a.rs\0M\0rust/src/b.rs\0D\0rust/src/c.rs\0T\0rust/src/d.rs\0";
        assert_eq!(
            parse_name_status(out).unwrap(),
            vec![
                (Status::Added, "rust/src/a.rs".to_string()),
                (Status::Modified, "rust/src/b.rs".to_string()),
                (Status::Deleted, "rust/src/c.rs".to_string()),
                (Status::Modified, "rust/src/d.rs".to_string()),
            ]
        );
    }

    #[test]
    fn name_status_of_an_empty_diff_is_empty() {
        assert_eq!(parse_name_status("").unwrap(), vec![]);
        assert_eq!(parse_name_status("\0").unwrap(), vec![]);
    }

    #[test]
    fn name_status_keeps_a_path_with_spaces_and_newlines() {
        let out = "M\0rust/tests/a b\nc.rs\0";
        assert_eq!(parse_name_status(out).unwrap(), vec![(Status::Modified, "rust/tests/a b\nc.rs".to_string())]);
    }

    #[test]
    fn name_status_rejects_what_it_does_not_know() {
        assert!(parse_name_status("R100\0a\0b\0").is_err());
        assert!(parse_name_status("M\0").is_err());
        assert!(parse_name_status("M\0\0").is_err());
        assert!(parse_name_status("\0M\0a\0").is_err());
    }

    #[test]
    fn hunk_headers_give_added_and_removed_lines() {
        let diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,2 +3,3 @@ fn x() {\n-a\n-b\n+c\n+d\n+e\n@@ -10 +11 @@\n-z\n+y\n";
        let changes = parse_line_changes(diff).unwrap();
        assert_eq!(changes.removed, vec![3, 4, 10]);
        assert_eq!(changes.added, vec![3, 4, 5, 11]);
    }

    #[test]
    fn a_pure_addition_has_no_removed_lines_and_a_pure_deletion_no_added_ones() {
        let added = parse_line_changes("@@ -4,0 +5,2 @@\n+a\n+b\n").unwrap();
        assert_eq!((added.removed, added.added), (vec![], vec![5, 6]));
        let deleted = parse_line_changes("@@ -7,2 +6,0 @@\n-a\n-b\n").unwrap();
        assert_eq!((deleted.removed, deleted.added), (vec![7, 8], vec![]));
    }

    #[test]
    fn a_new_file_is_all_added_lines() {
        let changes = parse_line_changes("--- /dev/null\n+++ b/f\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n").unwrap();
        assert_eq!((changes.removed, changes.added), (vec![], vec![1, 2, 3]));
    }

    #[test]
    fn a_body_line_that_looks_like_a_header_is_not_one() {
        // A removed line `@@ -1 +1 @@` shows up in a diff as `-@@ -1 +1 @@`, never at the start of a line.
        let changes = parse_line_changes("@@ -2 +2 @@\n-@@ -9,9 +9,9 @@\n+x\n").unwrap();
        assert_eq!((changes.removed, changes.added), (vec![2], vec![2]));
    }

    #[test]
    fn a_diff_with_no_hunk_has_no_changes() {
        assert_eq!(parse_line_changes("").unwrap(), LineChanges::default());
        assert_eq!(parse_line_changes("Binary files a/f and b/f differ\n").unwrap(), LineChanges::default());
    }

    #[test]
    fn a_malformed_header_is_an_error() {
        assert!(parse_line_changes("@@ -x +1 @@\n").is_err());
        assert!(parse_line_changes("@@ -1,2 @@\n").is_err());
        assert!(parse_line_changes("@@ -1 +1,y @@\n").is_err());
    }
}
