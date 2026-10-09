//! The plan against real git history, in scratch repositories, with a stand-in for the tool.
//!
//! What a diff says is what could be got wrong, so git is run for real here: the merge commit's first parent as the base, the
//! paths, the diff handed to `--in-diff`. Only `cargo mutants --list` is faked (it needs the tool, which nobody runs on a
//! developer machine).

mod common;

use std::fs;
use std::path::Path;

use common::{FakeLister, Repo};
use mutation_ratchet::gather::{Git, Lister, plan_from};
use mutation_ratchet::plan::{Group, Mode, Plan};

const A_RS: &str = "\
pub fn double(n: u32) -> u32 {
    n * 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles() {
        assert_eq!(double(2), 4);
        assert_eq!(double(0), 0);
    }
}
";

const B_RS: &str = "pub fn name() -> &'static str {\n    \"b\"\n}\n";

fn base_repo() -> Repo {
    let repo = Repo::new();
    repo.write("rust/src/a.rs", A_RS);
    repo.write("rust/src/b.rs", B_RS);
    repo.write("rust/README.md", "readme\n");
    repo.write("rust/tests/t.rs", "#[test]\nfn t() {}\n");
    repo.commit("base");
    repo
}

fn run(repo: &Repo, lister: &FakeLister, budget: usize) -> Plan {
    let git = Git { root: repo.root.clone() };
    let base = git.base_of_merge_commit().unwrap();
    let scratch = repo.root.join("out");
    fs::create_dir_all(&scratch).unwrap();
    plan_from(&git, lister, &base, budget, &scratch).unwrap().0
}

/// A pull request branch off the current commit that changes `path` to `text`, merged back with a merge commit.
fn merged_pr(repo: &Repo, changes: &[(&str, &str)]) {
    repo.git(&["checkout", "-q", "-b", "pr"]);
    for (path, text) in changes {
        repo.write(path, text);
    }
    repo.commit("the change");
    repo.git(&["checkout", "-q", "main"]);
    repo.merge("pr");
}

#[test]
fn a_change_to_code_selects_the_mutants_on_its_lines() {
    let repo = base_repo();
    merged_pr(&repo, &[("rust/src/a.rs", &A_RS.replace("n * 2", "n + n"))]);
    let lister = FakeLister::new(3, &[]);
    let plan = run(&repo, &lister, 78);
    assert_eq!(plan.selected.len(), 1);
    let item = &plan.selected[0];
    assert_eq!((item.file.as_str(), item.group, item.mode, item.mutants), ("src/a.rs", Group::ChangedSource, Mode::InDiff, 3));
    let asked = lister.asked.borrow();
    assert!(asked.len() == 1 && asked[0].is_some(), "one --in-diff listing and no whole listing");
}

#[test]
fn the_diff_given_to_the_tool_names_the_file_relative_to_the_crate() {
    let repo = base_repo();
    merged_pr(&repo, &[("rust/src/a.rs", &A_RS.replace("n * 2", "n + n"))]);
    let lister = FakeLister::new(1, &[]);
    run(&repo, &lister, 78);
    let asked = lister.asked.borrow();
    let diff = asked[0].as_ref().unwrap();
    assert!(diff.contains("--- a/src/a.rs") && diff.contains("+++ b/src/a.rs"), "{diff}");
    assert!(!diff.contains("rust/src"), "the tool names files relative to the crate: {diff}");
}

#[test]
fn a_pr_with_no_source_change_is_an_empty_plan_and_asks_the_tool_nothing() {
    let repo = base_repo();
    merged_pr(&repo, &[("rust/README.md", "changed readme\n")]);
    let lister = FakeLister::new(3, &[("src/a.rs", 5)]);
    let plan = run(&repo, &lister, 78);
    assert!(plan.is_empty());
    assert!(lister.asked.borrow().is_empty());
}

#[test]
fn a_base_that_moved_is_the_merge_commits_first_parent_so_only_the_prs_own_change_is_in_the_diff() {
    let repo = base_repo();
    let event_base = repo.git(&["rev-parse", "HEAD"]);
    // The PR branch is cut from the old base...
    repo.git(&["checkout", "-q", "-b", "pr"]);
    repo.write("rust/src/a.rs", &A_RS.replace("n * 2", "n + n"));
    repo.commit("the change");
    // ...and the base branch moves on, changing a different file.
    repo.git(&["checkout", "-q", "main"]);
    repo.write("rust/src/b.rs", &B_RS.replace("\"b\"", "\"bee\""));
    let moved_tip = repo.commit("main moves");
    repo.merge("pr");

    let git = Git { root: repo.root.clone() };
    assert_eq!(git.base_of_merge_commit().unwrap(), moved_tip, "HEAD^1 is the base's tip when it was merged");
    assert_ne!(git.base_of_merge_commit().unwrap(), event_base, "the event's base is the old one");

    let lister = FakeLister::new(2, &[]);
    let plan = run(&repo, &lister, 78);
    assert_eq!(plan.selected.iter().map(|i| i.file.as_str()).collect::<Vec<_>>(), vec!["src/a.rs"], "b.rs is the base's own change");

    // The same merge measured from the old base would count the base's change as the PR's: the bug the first parent avoids.
    let scratch = repo.root.join("out-old");
    fs::create_dir_all(&scratch).unwrap();
    let lister = FakeLister::new(2, &[]);
    let (plan, _) = plan_from(&git, &lister, &event_base, 78, &scratch).unwrap();
    let files: Vec<&str> = plan.selected.iter().map(|i| i.file.as_str()).collect();
    assert_eq!(files, vec!["src/a.rs", "src/b.rs"]);
}

#[test]
fn a_change_only_inside_the_test_module_that_adds_a_test_is_ignored() {
    let repo = base_repo();
    let with_new_test = A_RS.replace(
        "        assert_eq!(double(0), 0);\n    }\n",
        "        assert_eq!(double(0), 0);\n    }\n\n    #[test]\n    fn doubles_three() {\n        assert_eq!(double(3), 6);\n    }\n",
    );
    merged_pr(&repo, &[("rust/src/a.rs", &with_new_test)]);
    let lister = FakeLister::new(3, &[("src/a.rs", 5)]);
    let plan = run(&repo, &lister, 78);
    assert!(plan.is_empty(), "{plan:?}");
    assert_eq!(plan.tests_only_added_in, vec!["src/a.rs".to_string()]);
    assert!(lister.asked.borrow().is_empty());
}

#[test]
fn a_change_only_inside_the_test_module_that_edits_a_line_measures_the_whole_file() {
    let repo = base_repo();
    merged_pr(&repo, &[("rust/src/a.rs", &A_RS.replace("assert_eq!(double(0), 0);", "assert!(double(0) < 1);"))]);
    let lister = FakeLister::new(3, &[("src/a.rs", 5), ("src/b.rs", 1)]);
    let plan = run(&repo, &lister, 78);
    assert_eq!(plan.selected.len(), 1);
    let item = &plan.selected[0];
    assert_eq!((item.file.as_str(), item.group, item.mode, item.mutants), ("src/a.rs", Group::EditedTest, Mode::Whole, 5));
    assert!(plan.left_out.is_empty());
}

#[test]
fn deleting_a_test_line_measures_the_whole_file() {
    let repo = base_repo();
    merged_pr(&repo, &[("rust/src/a.rs", &A_RS.replace("        assert_eq!(double(0), 0);\n", ""))]);
    let lister = FakeLister::new(3, &[("src/a.rs", 5)]);
    let plan = run(&repo, &lister, 78);
    assert_eq!(plan.selected[0].group, Group::EditedTest);
}

#[test]
fn a_change_to_code_and_to_its_tests_selects_the_file_whole() {
    let repo = base_repo();
    let both = A_RS.replace("n * 2", "n + n").replace("assert_eq!(double(0), 0);", "assert!(double(0) < 1);");
    merged_pr(&repo, &[("rust/src/a.rs", &both)]);
    let lister = FakeLister::new(3, &[("src/a.rs", 5)]);
    let plan = run(&repo, &lister, 78);
    assert_eq!(plan.selected.len(), 1);
    assert_eq!((plan.selected[0].group, plan.selected[0].mode, plan.selected[0].mutants), (Group::EditedTest, Mode::Whole, 5));
}

#[test]
fn a_diff_over_the_budget_is_left_out_and_needs_a_proof() {
    let repo = base_repo();
    merged_pr(&repo, &[("rust/src/a.rs", &A_RS.replace("n * 2", "n + n"))]);
    let lister = FakeLister::new(60, &[]);
    let plan = run(&repo, &lister, 78);
    assert!(plan.selected.is_empty());
    assert_eq!(plan.left_out.len(), 1);
    assert!(plan.left_out[0].requires_proof);
    assert!(!plan.is_empty());
}

#[test]
fn a_new_source_file_is_all_changed_lines() {
    let repo = base_repo();
    merged_pr(&repo, &[("rust/src/c.rs", "pub fn c() -> u32 {\n    3\n}\n")]);
    let lister = FakeLister::new(4, &[]);
    let plan = run(&repo, &lister, 78);
    assert_eq!(plan.selected.len(), 1);
    assert_eq!((plan.selected[0].file.as_str(), plan.selected[0].mutants), ("src/c.rs", 4));
}

#[test]
fn a_deleted_source_file_is_named_and_not_measured() {
    let repo = base_repo();
    repo.git(&["checkout", "-q", "-b", "pr"]);
    repo.remove("rust/src/b.rs");
    repo.commit("delete");
    repo.git(&["checkout", "-q", "main"]);
    repo.merge("pr");
    let lister = FakeLister::new(4, &[]);
    let plan = run(&repo, &lister, 78);
    assert!(plan.is_empty());
    assert_eq!(plan.deleted_sources, vec!["src/b.rs".to_string()]);
}

#[test]
fn edited_and_added_tests_under_rust_tests_are_sorted_into_left_to_a_full_run_and_ignored() {
    let repo = base_repo();
    merged_pr(&repo, &[("rust/tests/t.rs", "#[test]\nfn t() { assert!(true); }\n"), ("rust/tests/new.rs", "#[test]\nfn n() {}\n")]);
    let lister = FakeLister::new(1, &[]);
    let plan = run(&repo, &lister, 78);
    assert_eq!(plan.tests_left_to_full_run, vec!["rust/tests/t.rs".to_string()]);
    assert_eq!(plan.tests_added, 1);
    assert!(plan.is_empty());
}

#[test]
fn a_changed_baseline_entry_measures_that_file_whole() {
    let repo = base_repo();
    let baseline = |score: &str| format!("{{\"cargo-mutants\":\"27.1.0\",\"files\":{{\"rust/src/a.rs\":{{\"score\":{score},\"ignores\":0}},\"rust/src/b.rs\":{{\"score\":80.0,\"ignores\":0}}}}}}\n");
    repo.write("rust/mutation-baseline.json", &baseline("90.0"));
    repo.commit("add the baseline");
    merged_pr(&repo, &[("rust/mutation-baseline.json", &baseline("95.0"))]);
    let lister = FakeLister::new(1, &[("src/a.rs", 5), ("src/b.rs", 2)]);
    let plan = run(&repo, &lister, 78);
    assert_eq!(plan.selected.len(), 1);
    assert_eq!((plan.selected[0].file.as_str(), plan.selected[0].group, plan.selected[0].mode), ("src/a.rs", Group::BaselineEntry, Mode::Whole));
}

#[test]
fn a_change_in_an_out_of_line_test_module_file_is_the_declaring_files_weakened_test() {
    let repo = Repo::new();
    repo.write("rust/src/wire.rs", "pub fn read() -> u32 {\n    1\n}\n\n#[cfg(test)]\nmod reading;\n");
    repo.write("rust/src/wire/reading.rs", "#[test]\nfn reads() {\n    assert_eq!(super::read(), 1);\n    assert_eq!(super::read() + 1, 2);\n}\n");
    repo.commit("base");
    merged_pr(&repo, &[("rust/src/wire/reading.rs", "#[test]\nfn reads() {\n    assert_eq!(super::read(), 1);\n}\n")]);
    let lister = FakeLister::new(1, &[("src/wire.rs", 3)]);
    let plan = run(&repo, &lister, 78);
    assert_eq!(plan.selected.len(), 1);
    let item = &plan.selected[0];
    assert_eq!((item.file.as_str(), item.group, item.mode, item.mutants), ("src/wire.rs", Group::EditedTest, Mode::Whole, 3));
}

#[test]
fn a_file_that_does_not_parse_fails_the_plan_instead_of_guessing() {
    let repo = base_repo();
    merged_pr(&repo, &[("rust/src/a.rs", "pub fn broken( {\n")]);
    let git = Git { root: repo.root.clone() };
    let base = git.base_of_merge_commit().unwrap();
    let scratch = repo.root.join("out");
    fs::create_dir_all(&scratch).unwrap();
    let error = plan_from(&git, &FakeLister::new(1, &[]), &base, 78, &scratch).err().expect("an error");
    assert!(error.contains("src/a.rs") && error.contains("parse"), "{error}");
}

#[test]
fn a_tool_that_fails_fails_the_plan() {
    struct Broken;
    impl Lister for Broken {
        fn list(&self, _: Option<&Path>) -> Result<String, String> {
            Err("cargo mutants --list failed: the --in-diff diff doesn't match the tree".into())
        }
    }
    let repo = base_repo();
    merged_pr(&repo, &[("rust/src/a.rs", &A_RS.replace("n * 2", "n + n"))]);
    let git = Git { root: repo.root.clone() };
    let base = git.base_of_merge_commit().unwrap();
    let scratch = repo.root.join("out");
    fs::create_dir_all(&scratch).unwrap();
    assert!(plan_from(&git, &Broken, &base, 78, &scratch).is_err());
}
