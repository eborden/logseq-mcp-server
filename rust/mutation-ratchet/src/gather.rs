//! Read git and the tool, and hand `plan.rs` its input.
//!
//! This is the only part of the package that starts a process. The tool is behind `Lister` so a test can stand in for it,
//! and git is run for real (against a scratch repository in the tests), since what a diff says is exactly what could be
//! got wrong: the base, the merge commit, the paths.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::baseline;
use crate::diff::{LineChanges, Status, parse_line_changes, parse_name_status};
use crate::listing::count_by_file;
use crate::plan::{Plan, PlanInput, make_plan};
use crate::regions::{Regions, read_regions};

/// The server crate's directory in the repository, and the two places in it a PR can change what is measured.
const CRATE_DIR: &str = "rust";
const SRC_PREFIX: &str = "rust/src/";
const TESTS_PREFIX: &str = "rust/tests/";
const BASELINE_PATH: &str = "rust/mutation-baseline.json";

/// Lists mutants as `cargo mutants --list --json` does. With a diff, only those overlapping its changed lines.
pub trait Lister {
    fn list(&self, in_diff: Option<&Path>) -> Result<String, String>;
}

/// The real tool, run in the server crate's directory. `--list` parses and builds nothing.
pub struct CargoMutants {
    pub crate_dir: PathBuf,
}

impl Lister for CargoMutants {
    fn list(&self, in_diff: Option<&Path>) -> Result<String, String> {
        let mut command = Command::new("cargo");
        command.args(["mutants", "--list", "--json", "--colors", "never"]).current_dir(&self.crate_dir);
        if let Some(diff) = in_diff {
            command.arg("--in-diff").arg(diff);
        }
        let output = command.output().map_err(|e| format!("couldn't start cargo mutants: {e}"))?;
        if !output.status.success() {
            let why = match crate::exit::classify(output.status.code()) {
                crate::exit::Exit::Broken(why) => why.to_string(),
                _ => "cargo mutants --list failed".to_string(),
            };
            return Err(format!("cargo mutants --list failed: {why}"));
        }
        String::from_utf8(output.stdout).map_err(|_| "cargo mutants --list printed text that is not UTF-8".to_string())
    }
}

/// A repository on disk, read through the `git` program.
pub struct Git {
    pub root: PathBuf,
}

impl Git {
    fn run(&self, args: &[&str]) -> Result<String, String> {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            // Plain output whatever the user's or the runner's configuration says.
            .args(["-c", "core.quotepath=off", "-c", "diff.renames=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"])
            .args(args)
            .output()
            .map_err(|e| format!("couldn't start git: {e}"))?;
        if !output.status.success() {
            return Err(format!("git {} failed: {}", args.first().copied().unwrap_or(""), String::from_utf8_lossy(&output.stderr).trim()));
        }
        String::from_utf8(output.stdout).map_err(|_| "git printed text that is not UTF-8".to_string())
    }

    /// `rev` as a full commit id.
    pub fn rev_parse(&self, rev: &str) -> Result<String, String> {
        Ok(self.run(&["rev-parse", "--verify", &format!("{rev}^{{commit}}")])?.trim().to_string())
    }

    /// The base of a pull request run: the first parent of the merge commit that was checked out, never the event's base SHA.
    /// That one can be older than the base branch's tip once the base has moved, and a diff from it carries the base's own
    /// changes and doesn't match the tree (cargo-mutants exit 5) or lands mutants on the wrong lines (ADR-0033 "The diff base
    /// is exact"). The merge commit is `HEAD`.
    pub fn base_of_merge_commit(&self) -> Result<String, String> {
        self.rev_parse("HEAD^1")
    }

    fn name_status(&self, base: &str) -> Result<Vec<(Status, String)>, String> {
        let out = self.run(&["diff", "--no-renames", "--name-status", "-z", base, "HEAD", "--", CRATE_DIR])?;
        parse_name_status(&out).map_err(|e| e.to_string())
    }

    fn line_changes(&self, base: &str, path: &str) -> Result<LineChanges, String> {
        let out = self.run(&["diff", "--no-renames", "--no-ext-diff", "-U0", base, "HEAD", "--", path])?;
        parse_line_changes(&out).map_err(|e| format!("{path}: {e}"))
    }

    /// A file's text at a revision, `None` when it isn't there.
    fn show(&self, rev: &str, path: &str) -> Result<Option<String>, String> {
        let spec = format!("{rev}:{path}");
        if self.run(&["cat-file", "-e", &spec]).is_err() {
            return Ok(None);
        }
        self.run(&["show", &spec]).map(Some)
    }

    fn rust_sources_at_head(&self) -> Result<Vec<String>, String> {
        let out = self.run(&["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", SRC_PREFIX])?;
        Ok(out.split('\0').filter(|p| p.ends_with(".rs")).map(String::from).collect())
    }

    /// The diff `cargo mutants --in-diff` reads: paths relative to the crate (`a/src/x.rs`), as the tool's mutants are.
    pub fn diff_for(&self, base: &str, files: &[&str]) -> Result<String, String> {
        let mut args = vec!["diff", "--no-renames", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--relative=rust", base, "HEAD", "--"];
        let paths: Vec<String> = files.iter().map(|f| format!("{CRATE_DIR}/{f}")).collect();
        args.extend(paths.iter().map(String::as_str));
        self.run(&args)
    }
}

/// How the plan's inputs were found.
pub struct Gathered {
    pub input: PlanInput,
    /// Every changed source file that still exists (added or modified), crate-relative.
    pub changed_files: Vec<String>,
}

/// Read the PR's changes between `base` and `HEAD` and count the mutants they touch.
pub fn gather(git: &Git, lister: &dyn Lister, base: &str, budget: usize, scratch: &Path) -> Result<Gathered, String> {
    let mut input = PlanInput { budget, ..PlanInput::default() };
    let changes = git.name_status(base)?;

    let mut sources: Vec<(Status, String)> = Vec::new();
    for (status, path) in &changes {
        if let Some(rest) = path.strip_prefix(SRC_PREFIX) {
            if rest.ends_with(".rs") {
                sources.push((*status, format!("src/{rest}")));
            }
        } else if path.starts_with(TESTS_PREFIX) {
            match status {
                Status::Added => input.tests_added += 1,
                Status::Modified | Status::Deleted => {
                    input.tests_edited.insert(path.clone());
                }
            }
        }
    }

    // A `#[cfg(test)] mod x;` file has no mutants of its own: its tests belong to the file that declares it.
    let test_module_owners = if sources.is_empty() { BTreeMap::new() } else { test_module_owners(git)? };

    let mut changed_files = Vec::new();
    for (status, file) in &sources {
        let path = format!("{CRATE_DIR}/{file}");
        if *status == Status::Deleted {
            input.deleted_sources.insert(file.clone());
            if let Some(owners) = test_module_owners.get(file) {
                input.tests_weakened.extend(owners.iter().cloned());
            }
            continue;
        }
        changed_files.push(file.clone());
        let changes = git.line_changes(base, &path)?;
        let new_text = git.show("HEAD", &path)?.ok_or_else(|| format!("{path} is changed but not at HEAD"))?;
        let new_regions = read_regions(&new_text).map_err(|e| format!("{path}: {e}"))?;
        let old_regions = match status {
            Status::Modified => {
                let old = git.show(base, &path)?.ok_or_else(|| format!("{path} is modified but not at the base"))?;
                read_regions(&old).map_err(|e| format!("{path} at the base: {e}"))?
            }
            _ => Regions::default(),
        };
        let kind = classify(&changes, &old_regions, &new_regions, test_module_owners.contains_key(file));
        if kind.code_changed {
            input.code_changed.insert(file.clone());
        }
        if kind.tests_weakened {
            match test_module_owners.get(file) {
                Some(owners) => input.tests_weakened.extend(owners.iter().cloned()),
                None => {
                    input.tests_weakened.insert(file.clone());
                }
            }
        }
        if kind.only_added_tests {
            input.tests_only_added_in.insert(file.clone());
        }
    }

    let old_baseline = git.show(base, BASELINE_PATH)?.map(|t| baseline::parse(&t)).transpose().map_err(|e| format!("the base's baseline: {e}"))?;
    let new_baseline = git.show("HEAD", BASELINE_PATH)?.map(|t| baseline::parse(&t)).transpose().map_err(|e| format!("the head's baseline: {e}"))?;
    input.baseline_entries = baseline::files_of_changed_entries(old_baseline.as_ref(), new_baseline.as_ref());

    if !input.code_changed.is_empty() {
        let files: Vec<&str> = input.code_changed.iter().map(String::as_str).collect();
        let diff = git.diff_for(base, &files)?;
        let diff_path = scratch.join("in-diff-all.diff");
        fs::write(&diff_path, diff).map_err(|e| format!("couldn't write the diff: {e}"))?;
        input.in_diff_counts = count_by_file(&lister.list(Some(&diff_path))?).map_err(|e| e.to_string())?;
    }
    if !input.tests_weakened.is_empty() || !input.baseline_entries.is_empty() {
        input.whole_counts = count_by_file(&lister.list(None)?).map_err(|e| e.to_string())?;
    }
    Ok(Gathered { input, changed_files })
}

/// How one source file's change sorts.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FileChange {
    /// A changed line outside any test item: code a mutant can sit on.
    pub code_changed: bool,
    /// A line removed or edited inside a test item: a test was weakened, or may have been.
    pub tests_weakened: bool,
    /// The change is only added lines inside test items: new tests can only add kills.
    pub only_added_tests: bool,
}

/// Sort a file's changed lines into code and tests. `all_test` is a file that is a `#[cfg(test)] mod x;` of another: every
/// line of it is test.
pub fn classify(changes: &LineChanges, old: &Regions, new: &Regions, all_test: bool) -> FileChange {
    let added_code = !all_test && changes.added.iter().any(|line| !new.is_test_line(*line));
    let removed_code = !all_test && changes.removed.iter().any(|line| !old.is_test_line(*line));
    let removed_test = if all_test { !changes.removed.is_empty() } else { changes.removed.iter().any(|line| old.is_test_line(*line)) };
    let code_changed = added_code || removed_code;
    FileChange {
        code_changed,
        tests_weakened: removed_test,
        only_added_tests: !code_changed && !removed_test && !changes.added.is_empty(),
    }
}

/// For each file that is the body of a `#[cfg(test)] mod x;`, the files that declare it. Paths are crate-relative.
fn test_module_owners(git: &Git) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    let mut owners: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for path in git.rust_sources_at_head()? {
        let Some(text) = git.show("HEAD", &path)? else { continue };
        let regions = read_regions(&text).map_err(|e| format!("{path}: {e}"))?;
        let Some(declaring) = path.strip_prefix(&format!("{CRATE_DIR}/")) else { continue };
        for name in &regions.test_modules {
            for candidate in module_files(declaring, name) {
                owners.entry(candidate).or_default().insert(declaring.to_string());
            }
        }
    }
    Ok(owners)
}

/// Where `mod name;` in `declaring` may live: the file beside the module's directory, or `mod.rs` inside it. A module in
/// `lib.rs`, `main.rs` or `mod.rs` looks in its own directory, any other in a directory named for the file.
pub fn module_files(declaring: &str, name: &str) -> Vec<String> {
    let path = Path::new(declaring);
    let dir = path.parent().unwrap_or(Path::new(""));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let base = if matches!(stem, "lib" | "main" | "mod") { dir.to_path_buf() } else { dir.join(stem) };
    vec![base.join(format!("{name}.rs")), base.join(name).join("mod.rs")]
        .into_iter()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect()
}

/// `plan.rs`'s `make_plan` over what `gather` found.
pub fn plan_from(git: &Git, lister: &dyn Lister, base: &str, budget: usize, scratch: &Path) -> Result<(Plan, Gathered), String> {
    let gathered = gather(git, lister, base, budget, scratch)?;
    Ok((make_plan(&gathered.input), gathered))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::regions::LineRange;

    fn regions(ranges: &[(u32, u32)]) -> Regions {
        Regions { tests: ranges.iter().map(|(start, end)| LineRange { start: *start, end: *end }).collect(), test_modules: vec![] }
    }

    fn changes(added: &[u32], removed: &[u32]) -> LineChanges {
        LineChanges { added: added.to_vec(), removed: removed.to_vec() }
    }

    #[test]
    fn a_changed_line_outside_a_test_item_is_code() {
        let r = regions(&[(10, 20)]);
        assert_eq!(classify(&changes(&[3], &[]), &r, &r, false), FileChange { code_changed: true, tests_weakened: false, only_added_tests: false });
    }

    #[test]
    fn a_removed_line_outside_a_test_item_is_code_too() {
        let r = regions(&[(10, 20)]);
        assert!(classify(&changes(&[], &[3]), &r, &r, false).code_changed);
    }

    #[test]
    fn a_diff_entirely_inside_a_test_item_that_only_adds_is_not_measured() {
        let r = regions(&[(10, 20)]);
        let kind = classify(&changes(&[12, 13], &[]), &r, &r, false);
        assert_eq!(kind, FileChange { code_changed: false, tests_weakened: false, only_added_tests: true });
    }

    #[test]
    fn a_diff_entirely_inside_a_test_item_that_removes_a_line_weakens_the_tests() {
        let r = regions(&[(10, 20)]);
        let kind = classify(&changes(&[12], &[12]), &r, &r, false);
        assert_eq!(kind, FileChange { code_changed: false, tests_weakened: true, only_added_tests: false });
        assert!(classify(&changes(&[], &[15]), &r, &r, false).tests_weakened, "a pure deletion of a test line");
    }

    #[test]
    fn the_old_regions_judge_removed_lines_and_the_new_ones_added_lines() {
        // The test module moved down 5 lines. Line 12 was test at the base and is code now; line 12 is test now, code before.
        let old = regions(&[(10, 20)]);
        let new = regions(&[(15, 25)]);
        let kind = classify(&changes(&[12], &[]), &old, &new, false);
        assert!(kind.code_changed, "added line 12 is outside the new test item");
        let kind = classify(&changes(&[], &[22]), &old, &new, false);
        assert!(kind.code_changed, "removed line 22 is outside the old test item");
    }

    #[test]
    fn a_change_that_touches_code_and_tests_is_both() {
        let r = regions(&[(10, 20)]);
        let kind = classify(&changes(&[3, 12], &[12]), &r, &r, false);
        assert!(kind.code_changed && kind.tests_weakened && !kind.only_added_tests);
    }

    #[test]
    fn a_test_only_module_file_is_never_code() {
        let none = Regions::default();
        let kind = classify(&changes(&[1, 2], &[3]), &none, &none, true);
        assert_eq!(kind, FileChange { code_changed: false, tests_weakened: true, only_added_tests: false });
        let added = classify(&changes(&[1, 2], &[]), &none, &none, true);
        assert_eq!(added, FileChange { code_changed: false, tests_weakened: false, only_added_tests: true });
    }

    #[test]
    fn an_added_file_has_only_added_lines() {
        let new = regions(&[(5, 9)]);
        let kind = classify(&changes(&[1, 2, 3, 4, 5, 6, 7, 8, 9], &[]), &Regions::default(), &new, false);
        assert!(kind.code_changed && !kind.tests_weakened);
    }

    #[test]
    fn a_module_file_is_found_beside_or_inside_its_declaring_file() {
        assert_eq!(module_files("src/wire.rs", "reading"), vec!["src/wire/reading.rs", "src/wire/reading/mod.rs"]);
        assert_eq!(module_files("src/lib.rs", "tests"), vec!["src/tests.rs", "src/tests/mod.rs"]);
        assert_eq!(module_files("src/resolve/mod.rs", "t"), vec!["src/resolve/t.rs", "src/resolve/t/mod.rs"]);
        assert_eq!(module_files("src/main.rs", "t"), vec!["src/t.rs", "src/t/mod.rs"]);
    }
}
