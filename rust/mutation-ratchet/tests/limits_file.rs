//! The committed `limits.env` and the workflows that read it must agree, and the workflows keep the promises ADR-0033 makes
//! of them (ADR-0033 "The budget", "Quiet by construction", and #364's constraints).

use std::fs;
use std::path::PathBuf;

use mutation_ratchet::limits::{Limits, parse};

fn package_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn repo_file(path: &str) -> String {
    let full = package_dir().join("../..").join(path);
    fs::read_to_string(&full).unwrap_or_else(|e| panic!("{}: {e}", full.display()))
}

fn limits() -> Limits {
    parse(&fs::read_to_string(package_dir().join("limits.env")).unwrap()).unwrap()
}

const WORKFLOWS: [&str; 2] = [".github/workflows/rust-mutation.yml", ".github/workflows/rust-mutation-full.yml"];
const SETUP_ACTION: &str = ".github/actions/rust-mutation-setup/action.yml";

#[test]
fn the_committed_limits_are_consistent() {
    limits().check().unwrap();
}

#[test]
fn the_pr_job_timeout_is_the_one_the_budget_was_computed_from() {
    let text = repo_file(WORKFLOWS[0]);
    let timeouts: Vec<u64> = text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("timeout-minutes:"))
        .map(|v| v.trim().parse().expect("a literal number of minutes"))
        .collect();
    assert_eq!(timeouts, vec![limits().job_timeout_minutes], "the PR workflow has one job and its timeout is JOB_TIMEOUT_MINUTES");
}

#[test]
fn the_workflows_load_the_limits_through_the_setup_action_and_never_repeat_one() {
    assert!(repo_file(SETUP_ACTION).contains("rust/mutation-ratchet/limits.env"), "the setup action loads limits.env");
    for name in WORKFLOWS {
        let text = repo_file(name);
        assert!(text.contains("uses: ./.github/actions/rust-mutation-setup"), "{name} uses the setup action");
        for key in ["MUTANT_BUDGET", "MUTANT_JOBS", "SECONDS_PER_MUTANT", "FULL_RUN_SLICES", "MUTANTS_TOOL_VERSION"] {
            for digit in '0'..='9' {
                assert!(!text.contains(&format!("{key}={digit}")), "{name} must not set {key}; it belongs in limits.env");
            }
        }
    }
}

#[test]
fn no_call_of_the_tool_passes_more_than_two_jobs() {
    let mut texts: Vec<(String, String)> = WORKFLOWS.iter().map(|n| (n.to_string(), repo_file(n))).collect();
    texts.push(("run-plan.sh".to_string(), repo_file("rust/mutation-ratchet/run-plan.sh")));
    let mut seen = 0;
    for (name, text) in &texts {
        for line in text.lines().filter(|l| !l.trim_start().starts_with('#')) {
            if let Some(rest) = line.split("--jobs").nth(1) {
                seen += 1;
                let value = rest.trim_start_matches(['=', ' ']).split_whitespace().next().unwrap_or("");
                assert!(["\"${MUTANT_JOBS}\"", "\"${jobs}\"", "1", "2"].contains(&value), "{name}: `--jobs` is {value:?}");
            }
        }
        // The calibration function is called with a job count of 1 or 2 only.
        for line in text.lines().map(str::trim).filter(|l| l.starts_with("calibrate ")) {
            let jobs = line.split_whitespace().nth(2).unwrap_or("");
            assert!(jobs == "1" || jobs == "2", "{name}: {line}");
        }
    }
    // The calibration function's call and run-plan.sh's, which every other job goes through.
    assert!(seen >= 2, "the guard saw the calls it guards ({seen})");
}

#[test]
fn every_action_is_pinned_by_commit_sha_or_is_local() {
    let mut texts: Vec<(String, String)> = WORKFLOWS.iter().map(|n| (n.to_string(), repo_file(n))).collect();
    texts.push((SETUP_ACTION.to_string(), repo_file(SETUP_ACTION)));
    let mut seen = 0;
    for (name, text) in &texts {
        for line in text.lines().filter(|l| !l.trim_start().starts_with('#')) {
            let Some(target) = line.trim().trim_start_matches("- ").strip_prefix("uses:") else { continue };
            let target = target.trim().split_whitespace().next().unwrap_or("");
            seen += 1;
            if target.starts_with("./") {
                continue;
            }
            let (_, version) = target.split_once('@').unwrap_or(("", ""));
            assert!(version.len() == 40 && version.chars().all(|c| c.is_ascii_hexdigit()), "{name}: {target} is not pinned by commit SHA");
        }
    }
    assert!(seen >= 8, "the guard saw the actions it guards ({seen})");
}

#[test]
fn no_workflow_publishes_writes_or_runs_on_a_push() {
    for name in WORKFLOWS {
        let text = repo_file(name);
        assert!(text.contains("permissions:\n  contents: read\n"), "{name} has read-only permissions");
        for forbidden in ["contents: write", "packages: write", "id-token", "npm publish", "cargo publish", "gh release", "git tag", "git push"] {
            assert!(!text.contains(forbidden), "{name} must not contain {forbidden:?} (ADR-0017: workflows build and test only)");
        }
    }
    let pr = repo_file(WORKFLOWS[0]);
    assert!(!pr.contains("\n  push:"), "the PR job has no push trigger (ADR-0033: no results cache to save)");
    assert!(pr.contains("cancel-in-progress: true"), "a superseded PR run is cancelled");
}

#[test]
fn the_dependency_cache_is_restored_and_never_saved() {
    let action = repo_file(SETUP_ACTION);
    assert!(action.contains("cache-save-if: 'false'"));
    assert!(action.contains("cache-shared-key: rust-deps"));
    // The build job saves under the same key.
    assert!(repo_file(".github/workflows/ci.yml").contains("cache-shared-key: rust-deps"));
}

#[test]
fn the_full_workflow_is_started_by_labels_and_declares_dispatch() {
    let text = repo_file(WORKFLOWS[1]);
    assert!(text.contains("types: [labeled]"));
    assert!(text.contains("workflow_dispatch:"));
    for label in ["mutation-proof", "mutation-full"] {
        assert!(text.contains(&format!("github.event.label.name == '{label}'")), "{label} starts a job");
    }
}
