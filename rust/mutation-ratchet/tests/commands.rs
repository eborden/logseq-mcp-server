//! The three commands the workflows call, end to end: what files they write and when they fail.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use common::{FakeLister, Repo};
use mutation_ratchet::plan::{Group, Kind, Mode, Plan};
use mutation_ratchet::run::{Args, full_plan_command, plan_command, report_command};

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn scratch_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mutation-ratchet-cmd-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn args(pairs: &[&str]) -> Args {
    Args::parse(&pairs.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
}

const LIMITS: &str = "MUTANTS_TOOL_VERSION=27.1.0\nJOB_TIMEOUT_MINUTES=20\nOVERHEAD_SECONDS=300\nSPARE_SECONDS=120\nSECONDS_PER_MUTANT=20\nMUTANT_JOBS=2\nMUTANT_BUDGET=78\nFULL_RUN_SLICES=1\n";

fn limits_file() -> PathBuf {
    let path = scratch_dir().join("limits.env");
    fs::write(&path, LIMITS).unwrap();
    path
}

const A_RS: &str = "pub fn double(n: u32) -> u32 {\n    n * 2\n}\n";

fn repo_with_a_pr(change: &str) -> Repo {
    let repo = Repo::new();
    repo.write("rust/src/a.rs", A_RS);
    repo.write("rust/src/b.rs", "pub fn b() -> u32 {\n    1\n}\n");
    repo.commit("base");
    repo.git(&["checkout", "-q", "-b", "pr"]);
    repo.write("rust/src/a.rs", change);
    repo.commit("change");
    repo.git(&["checkout", "-q", "main"]);
    repo.merge("pr");
    repo
}

fn read(dir: &Path, name: &str) -> String {
    fs::read_to_string(dir.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[test]
fn plan_writes_the_plan_the_diff_the_file_lists_and_the_summary() {
    let repo = repo_with_a_pr(&A_RS.replace("n * 2", "n + n"));
    let out = scratch_dir();
    let limits = limits_file();
    let summary = plan_command(
        &args(&["--repo", repo.root.to_str().unwrap(), "--out", out.to_str().unwrap(), "--limits", limits.to_str().unwrap()]),
        &FakeLister::new(3, &[]),
    )
    .unwrap();
    assert!(summary.contains("Mutating 3 mutants in 1 file."), "{summary}");
    let plan: Plan = serde_json::from_str(&read(&out, "plan.json")).unwrap();
    assert_eq!(plan.kind, Kind::Pr);
    assert_eq!(plan.budget, Some(78));
    assert_eq!(read(&out, "in-diff-files.txt"), "src/a.rs\n");
    assert_eq!(read(&out, "whole-files.txt"), "");
    assert!(read(&out, "in-diff.diff").contains("+++ b/src/a.rs"));
    assert_eq!(read(&out, "summary.md"), summary);
    assert_eq!(read(&out, "base-sha.txt").trim(), repo.git(&["rev-parse", "HEAD^1"]));
    let env = read(&out, "plan.env");
    assert!(env.contains("IN_DIFF_FILES=1\n") && env.contains("WHOLE_FILES=0\n") && env.contains("SELECTED_MUTANTS=3\n") && env.contains("NOTHING_SELECTED=false\n"), "{env}");
}

#[test]
fn plan_of_a_diff_with_no_source_change_says_nothing_was_mutated() {
    let repo = Repo::new();
    repo.write("rust/src/a.rs", A_RS);
    repo.write("rust/README.md", "one\n");
    repo.commit("base");
    repo.git(&["checkout", "-q", "-b", "pr"]);
    repo.write("rust/README.md", "two\n");
    repo.commit("change");
    repo.git(&["checkout", "-q", "main"]);
    repo.merge("pr");
    let out = scratch_dir();
    let limits = limits_file();
    let summary = plan_command(
        &args(&["--repo", repo.root.to_str().unwrap(), "--out", out.to_str().unwrap(), "--limits", limits.to_str().unwrap()]),
        &FakeLister::new(3, &[]),
    )
    .unwrap();
    assert!(summary.contains("**Nothing was mutated.**"), "{summary}");
    assert!(read(&out, "plan.env").contains("NOTHING_SELECTED=true\n"));
    assert!(!out.join("in-diff.diff").exists());
}

#[test]
fn plan_refuses_a_limits_file_whose_budget_does_not_match_its_numbers() {
    let repo = repo_with_a_pr(&A_RS.replace("n * 2", "n + n"));
    let out = scratch_dir();
    let bad = scratch_dir().join("limits.env");
    fs::write(&bad, LIMITS.replace("MUTANT_BUDGET=78", "MUTANT_BUDGET=100")).unwrap();
    let error = plan_command(
        &args(&["--repo", repo.root.to_str().unwrap(), "--out", out.to_str().unwrap(), "--limits", bad.to_str().unwrap()]),
        &FakeLister::new(3, &[]),
    )
    .unwrap_err();
    assert!(error.contains("MUTANT_BUDGET"), "{error}");
}

#[test]
fn a_proof_plan_is_the_files_the_pr_job_left_out() {
    let repo = repo_with_a_pr(&A_RS.replace("n * 2", "n + n"));
    let limits = limits_file();
    // 60 mutants in a.rs do not fit the budget of 78 (60 + 60 > 78): the PR job leaves it out, the proof run takes it.
    let pr_out = scratch_dir();
    let lister = FakeLister::new(60, &[]);
    let common = ["--repo", repo.root.to_str().unwrap(), "--limits", limits.to_str().unwrap()];
    let pr_args: Vec<&str> = common.iter().copied().chain(["--out", pr_out.to_str().unwrap()]).collect();
    plan_command(&args(&pr_args), &lister).unwrap();
    assert!(read(&pr_out, "plan.env").contains("NOTHING_SELECTED=true\n") && read(&pr_out, "plan.env").contains("LEFT_OUT_NEEDS_PROOF=1\n"));

    let proof_out = scratch_dir();
    let proof_args: Vec<&str> = common.iter().copied().chain(["--out", proof_out.to_str().unwrap(), "--proof"]).collect();
    let summary = plan_command(&args(&proof_args), &lister).unwrap();
    let plan: Plan = serde_json::from_str(&read(&proof_out, "plan.json")).unwrap();
    assert_eq!(plan.kind, Kind::Proof);
    assert_eq!(plan.budget, None);
    assert_eq!((plan.selected[0].file.as_str(), plan.selected[0].mutants, plan.selected[0].mode), ("src/a.rs", 60, Mode::InDiff));
    assert!(summary.contains("Mutation proof plan"), "{summary}");
    assert!(read(&proof_out, "plan.env").contains("NOTHING_SELECTED=false\n"));
}

#[test]
fn full_plan_writes_the_slice_and_refuses_an_index_outside_the_slices() {
    let repo = repo_with_a_pr(&A_RS.replace("n * 2", "n + n"));
    let limits = limits_file();
    let lister = FakeLister::new(1, &[("src/a.rs", 5), ("src/b.rs", 4), ("src/c.rs", 3)]);
    let out = scratch_dir();
    let summary = full_plan_command(
        &args(&["--repo", repo.root.to_str().unwrap(), "--out", out.to_str().unwrap(), "--limits", limits.to_str().unwrap(), "--slices", "2", "--index", "1"]),
        &lister,
    )
    .unwrap();
    // 5 | 4 + 3 split into two slices: the second holds b and c.
    assert_eq!(read(&out, "whole-files.txt"), "src/b.rs\nsrc/c.rs\n");
    assert!(summary.contains("Slice 2 of 2"), "{summary}");
    let plan: Plan = serde_json::from_str(&read(&out, "plan.json")).unwrap();
    assert_eq!(plan.kind, Kind::Full);
    assert!(plan.selected.iter().all(|i| i.group == Group::Full && i.mode == Mode::Whole));
    assert_eq!(plan.selected_mutants(), 7);

    let bad = full_plan_command(
        &args(&["--repo", repo.root.to_str().unwrap(), "--out", out.to_str().unwrap(), "--limits", limits.to_str().unwrap(), "--slices", "2", "--index", "2"]),
        &lister,
    );
    assert!(bad.unwrap_err().contains("outside"));
}

#[test]
fn full_plan_uses_the_slice_count_in_the_limits_file_by_default() {
    let repo = repo_with_a_pr(&A_RS.replace("n * 2", "n + n"));
    let limits = limits_file();
    let out = scratch_dir();
    full_plan_command(
        &args(&["--repo", repo.root.to_str().unwrap(), "--out", out.to_str().unwrap(), "--limits", limits.to_str().unwrap(), "--index", "0"]),
        &FakeLister::new(1, &[("src/a.rs", 5), ("src/b.rs", 4)]),
    )
    .unwrap();
    assert_eq!(read(&out, "whole-files.txt"), "src/a.rs\nsrc/b.rs\n");
}

// -- report --

fn outcomes_json(caught: usize, missed: usize, baseline: &str) -> String {
    let mutant = |summary: &str| {
        format!(
            r#"{{"scenario":{{"Mutant":{{"name":"n","package":"p","file":"src/a.rs"}}}},"summary":"{summary}","phase_results":[{{"phase":"Build","duration":2.0,"process_status":"Success","argv":[]}},{{"phase":"Test","duration":8.0,"process_status":"Success","argv":[]}}]}}"#
        )
    };
    let mut items = vec![format!(r#"{{"scenario":"Baseline","summary":"{baseline}","phase_results":[]}}"#)];
    items.extend((0..caught).map(|_| mutant("CaughtMutant")));
    items.extend((0..missed).map(|_| mutant("MissedMutant")));
    format!(
        r#"{{"outcomes":[{}],"total_mutants":{},"missed":{missed},"caught":{caught},"timeout":0,"unviable":0,"success":0,"cargo_mutants_version":"27.1.0"}}"#,
        items.join(","),
        caught + missed
    )
}

/// A plan with a.rs measured by its changed lines (4 mutants), saved as plan.json.
fn plan_file(kind: &str) -> PathBuf {
    let dir = scratch_dir();
    let plan = format!(
        r#"{{"kind":"{kind}","budget":78,"selected":[{{"file":"src/a.rs","group":"changed_source","mode":"in_diff","mutants":4}}],"left_out":[],"no_mutants":[],"deleted_sources":[],"tests_left_to_full_run":[],"tests_added":0,"tests_only_added_in":[]}}"#
    );
    let path = dir.join("plan.json");
    fs::write(&path, plan).unwrap();
    path
}

fn results_dir(exit: Option<&str>, outcomes: Option<&str>) -> PathBuf {
    let dir = scratch_dir();
    let run = dir.join("in-diff");
    fs::create_dir_all(run.join("mutants.out")).unwrap();
    if let Some(exit) = exit {
        fs::write(run.join("exit"), exit).unwrap();
    }
    if let Some(outcomes) = outcomes {
        fs::write(run.join("mutants.out/outcomes.json"), outcomes).unwrap();
    }
    dir
}

fn report(plan: &Path, results: &Path, extra: &[&str]) -> (mutation_ratchet::run::Reported, PathBuf) {
    let out = scratch_dir();
    let mut pairs = vec!["--plan", plan.to_str().unwrap(), "--results", results.to_str().unwrap(), "--out", out.to_str().unwrap()];
    pairs.extend_from_slice(extra);
    (report_command(&args(&pairs)).unwrap(), out)
}

#[test]
fn a_report_of_a_run_with_a_missed_mutant_is_not_a_failure() {
    let results = results_dir(Some("2\n"), Some(&outcomes_json(3, 1, "Success")));
    let (reported, out) = report(&plan_file("pr"), &results, &["--head", "abc123", "--tool-version", "27.1.0"]);
    assert!(reported.failures.is_empty(), "{:?}", reported.failures);
    assert!(reported.summary.contains("75.0%"), "{}", reported.summary);
    let measured: serde_json::Value = serde_json::from_str(&read(&out, "measured-files.json")).unwrap();
    assert_eq!(measured["files"], serde_json::json!(["src/a.rs"]));
    assert_eq!(measured["head"], "abc123");
    let json: serde_json::Value = serde_json::from_str(&read(&out, "report.json")).unwrap();
    assert_eq!(json["files"]["src/a.rs"]["missed"], 1);
    assert_eq!(read(&out, "summary.md"), reported.summary);
}

#[test]
fn exit_codes_that_mean_a_broken_run_fail_the_report() {
    for code in ["4", "5", "6", "70", "1", "signal"] {
        let results = results_dir(Some(code), None);
        let (reported, _) = report(&plan_file("pr"), &results, &[]);
        assert!(!reported.failures.is_empty(), "exit {code}");
    }
}

#[test]
fn a_run_that_recorded_no_exit_code_fails_the_report() {
    let results = results_dir(None, Some(&outcomes_json(4, 0, "Success")));
    let (reported, _) = report(&plan_file("pr"), &results, &[]);
    assert!(reported.failures.iter().any(|f| f.contains("no exit code")), "{:?}", reported.failures);
}

#[test]
fn a_malformed_outcomes_file_fails_the_report() {
    let results = results_dir(Some("0"), Some("{\"outcomes\": ["));
    let (reported, _) = report(&plan_file("pr"), &results, &[]);
    assert!(reported.failures.iter().any(|f| f.contains("outcomes.json is unusable")), "{:?}", reported.failures);
}

#[test]
fn a_clean_exit_with_no_outcomes_file_fails_the_report() {
    let results = results_dir(Some("0"), None);
    let (reported, _) = report(&plan_file("pr"), &results, &[]);
    assert!(reported.failures.iter().any(|f| f.contains("wrote no outcomes.json")), "{:?}", reported.failures);
}

#[test]
fn a_failed_baseline_fails_the_report() {
    let results = results_dir(Some("4"), Some(&outcomes_json(0, 0, "Failure")));
    let (reported, _) = report(&plan_file("pr"), &results, &[]);
    assert!(reported.failures.iter().any(|f| f.contains("baseline failed")), "{:?}", reported.failures);
}

#[test]
fn the_wrong_tool_version_fails_the_report() {
    let results = results_dir(Some("0"), Some(&outcomes_json(4, 0, "Success")));
    let (reported, _) = report(&plan_file("pr"), &results, &["--tool-version", "27.2.0"]);
    assert!(reported.failures.iter().any(|f| f.contains("27.1.0, not 27.2.0")), "{:?}", reported.failures);
}

#[test]
fn a_plan_with_nothing_selected_reports_without_any_results() {
    let dir = scratch_dir();
    let plan = dir.join("plan.json");
    fs::write(
        &plan,
        r#"{"kind":"pr","budget":78,"selected":[],"left_out":[],"no_mutants":[],"deleted_sources":[],"tests_left_to_full_run":[],"tests_added":0,"tests_only_added_in":[]}"#,
    )
    .unwrap();
    let (reported, out) = report(&plan, &dir.join("no-results"), &[]);
    assert!(reported.failures.is_empty());
    assert!(reported.summary.contains("**Nothing was mutated.**"));
    let measured: serde_json::Value = serde_json::from_str(&read(&out, "measured-files.json")).unwrap();
    assert_eq!(measured["files"], serde_json::json!([]));
}

#[test]
fn a_count_that_differs_from_the_plan_is_in_the_report_but_does_not_fail_it() {
    let results = results_dir(Some("0"), Some(&outcomes_json(3, 0, "Success")));
    let (reported, out) = report(&plan_file("pr"), &results, &[]);
    assert!(reported.failures.is_empty());
    let json: serde_json::Value = serde_json::from_str(&read(&out, "report.json")).unwrap();
    assert_eq!(json["count_mismatches"].as_array().unwrap().len(), 1);
}

#[test]
fn arguments_are_checked() {
    assert!(Args::parse(&["plan".to_string()]).is_err());
    assert!(Args::parse(&["--repo".to_string()]).is_err());
    assert!(Args::parse(&["--repo".to_string(), "a".to_string(), "--repo".to_string(), "b".to_string()]).is_err());
}

// -- measure and test-times --

#[test]
fn measure_prints_a_row_and_the_size_summary_with_no_file_name() {
    let dir = scratch_dir();
    let path = dir.join("outcomes.json");
    fs::write(&path, outcomes_json(3, 1, "Success")).unwrap();
    let out = mutation_ratchet::run::main_with(&["measure", "--label", "j2", "--outcomes", path.to_str().unwrap(), "--wall", "90"].map(String::from)).unwrap();
    assert!(out.starts_with("| Run | Mutants |"), "{out}");
    assert!(out.contains("\n| j2 | 4 | 3 caught, 1 missed, 0 timeout, 0 unviable (0.0%) |"), "{out}");
    assert!(out.contains("| 90 s |"), "{out}");
    assert!(out.contains("4 mutants in 1 files."), "{out}");
    assert!(!out.contains("a.rs"), "{out}");
}

#[test]
fn measure_of_a_malformed_file_is_an_error() {
    let dir = scratch_dir();
    let path = dir.join("outcomes.json");
    fs::write(&path, "{").unwrap();
    assert!(mutation_ratchet::run::main_with(&["measure", "--label", "x", "--outcomes", path.to_str().unwrap()].map(String::from)).is_err());
}

#[test]
fn test_times_lists_the_slowest_binary_first() {
    let dir = scratch_dir();
    let path = dir.join("baseline.log");
    fs::write(
        &path,
        "Running unittests src/lib.rs (x)\ntest result: ok. 1 passed; finished in 0.50s\nRunning tests/slow.rs (y)\ntest result: ok. 1 passed; finished in 9.00s\n",
    )
    .unwrap();
    let out = mutation_ratchet::run::main_with(&["test-times", "--log", path.to_str().unwrap()].map(String::from)).unwrap();
    assert_eq!(out, "2 test binaries, 9.5 s in all.\n9.00 s  tests/slow.rs\n0.50 s  unittests src/lib.rs\n");
}

#[test]
fn an_unknown_command_or_none_is_an_error_with_the_usage() {
    assert!(mutation_ratchet::run::main_with(&[]).unwrap_err().contains("usage"));
    assert!(mutation_ratchet::run::main_with(&["nope".to_string()]).unwrap_err().contains("unknown command"));
}
