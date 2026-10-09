//! The job summary: what a run planned, what it measured, and what it left out, in words.
//!
//! Nothing here carries a block of a graph or a log: file paths, function-free counts and seconds only (BR-0001). An empty
//! plan says in words that nothing was mutated, so a green job is never read as a measured pass.

use std::fmt::Write;

use crate::exit::Exit;
use crate::outcomes::Outcomes;
use crate::plan::{Group, Kind, Mode, Plan};
use crate::score::{Counts, show};

/// One `cargo mutants` call of a run: the exit it recorded and, if it wrote one, what was in its `outcomes.json`.
pub struct RunResult {
    pub name: &'static str,
    pub exit: Exit,
    pub outcomes: Option<Outcomes>,
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub fn render_plan(plan: &Plan) -> String {
    let mut out = String::new();
    let title = match plan.kind {
        Kind::Pr => "Mutation plan",
        Kind::Proof => "Mutation proof plan",
        Kind::Full => "Mutation full-run slice",
    };
    let _ = writeln!(out, "## {title}\n");

    if plan.is_empty() {
        out.push_str("**Nothing was mutated.** ");
        out.push_str(&why_empty(plan));
        out.push_str("\n\nThis is not a pass of any file: no mutant ran, so no file was measured.\n");
    } else {
        let budget = match plan.budget {
            Some(budget) => format!(" Budget: {budget} mutants, the re-run reserve (the largest selected file, counted twice) included."),
            None => String::new(),
        };
        let _ = writeln!(
            out,
            "Mutating {} in {}.{budget}\n",
            plural(plan.selected_mutants(), "mutant", "mutants"),
            plural(plan.selected.len(), "file", "files"),
        );
        if !plan.selected.is_empty() {
            out.push_str("| File | Why | Mutated | Mutants |\n|---|---|---|---|\n");
            for item in &plan.selected {
                let _ = writeln!(out, "| `{}` | {} | {} | {} |", item.file, item.group.label(), mode_words(item.mode), item.mutants);
            }
            out.push('\n');
        }
    }

    if !plan.left_out.is_empty() {
        out.push_str("### Left out of this run\n\n");
        out.push_str("They didn't fit the budget. A changed source or an edited test left out needs a `mutation-proof` run on the head commit before the ratchet passes it (ADR-0033). A baseline entry is covered by the next full run.\n\n");
        out.push_str("| File | Why | Mutated | Mutants | Needs a proof run |\n|---|---|---|---|---|\n");
        for left in &plan.left_out {
            let item = &left.item;
            let proof = if left.requires_proof { "yes" } else { "no" };
            let _ = writeln!(out, "| `{}` | {} | {} | {} | {proof} |", item.file, item.group.label(), mode_words(item.mode), item.mutants);
        }
        out.push('\n');
    }

    let mut notes: Vec<String> = Vec::new();
    for group in [Group::ChangedSource, Group::EditedTest, Group::BaselineEntry] {
        let files: Vec<&str> = plan.no_mutants.iter().filter(|n| n.group == group).map(|n| n.file.as_str()).collect();
        if !files.is_empty() {
            notes.push(format!("{} ({}) hold no mutants to measure: {}.", plural(files.len(), "file", "files"), group.label(), join_code(&files)));
        }
    }
    if !plan.deleted_sources.is_empty() {
        let files: Vec<&str> = plan.deleted_sources.iter().map(String::as_str).collect();
        notes.push(format!("Deleted, so nothing left to mutate: {}.", join_code(&files)));
    }
    if !plan.tests_left_to_full_run.is_empty() {
        let files: Vec<&str> = plan.tests_left_to_full_run.iter().map(String::as_str).collect();
        notes.push(format!(
            "Left to the next full run (a test under `rust/tests/` maps to no source file the job can read): {}.",
            join_code(&files)
        ));
    }
    if plan.tests_added > 0 {
        notes.push(format!("{} added under `rust/tests/`, ignored: a new test can only add kills.", plural(plan.tests_added, "test file was", "test files were")));
    }
    if !plan.tests_only_added_in.is_empty() {
        let files: Vec<&str> = plan.tests_only_added_in.iter().map(String::as_str).collect();
        notes.push(format!("Only test lines were added in {}; ignored for the same reason.", join_code(&files)));
    }
    if !notes.is_empty() {
        out.push_str("### Not measured here\n\n");
        for note in notes {
            let _ = writeln!(out, "- {note}");
        }
        out.push('\n');
    }
    out
}

fn why_empty(plan: &Plan) -> String {
    let mut reasons: Vec<&str> = Vec::new();
    if !plan.no_mutants.is_empty() {
        reasons.push("the changed lines hold no mutants");
    }
    if !plan.deleted_sources.is_empty() {
        reasons.push("the only changed sources were deleted");
    }
    if !plan.tests_only_added_in.is_empty() || plan.tests_added > 0 {
        reasons.push("the only test changes were additions");
    }
    if !plan.tests_left_to_full_run.is_empty() {
        reasons.push("the edited tests are left to a full run");
    }
    if reasons.is_empty() {
        "The pull request changes no Rust source under `rust/src` and no baseline entry.".to_string()
    } else {
        format!("The pull request has no changed code to measure: {}.", reasons.join(", "))
    }
}

fn mode_words(mode: Mode) -> &'static str {
    match mode {
        Mode::InDiff => "changed lines",
        Mode::Whole => "whole file",
    }
}

fn join_code(files: &[&str]) -> String {
    files.iter().map(|f| format!("`{f}`")).collect::<Vec<_>>().join(", ")
}

/// What the runs measured. `runs` holds one entry per `cargo mutants` call the plan asked for.
pub fn render_results(plan: &Plan, runs: &[RunResult]) -> String {
    let mut out = String::new();
    out.push_str("## Mutation results\n\n");
    out.push_str("Informational: there is no committed baseline yet, so no file is compared to one and nothing here gates.\n\n");

    let mut total = Counts::default();
    let mut rows: Vec<(String, &'static str, Counts)> = Vec::new();
    for run in runs {
        match (&run.exit, &run.outcomes) {
            (Exit::Broken(why), _) => {
                let _ = writeln!(out, "- **`{}` run broke:** {why}.", run.name);
            }
            (_, None) => {
                let _ = writeln!(out, "- **`{}` run wrote no outcomes.json.**", run.name);
            }
            (_, Some(outcomes)) => {
                if let Some(baseline) = outcomes.baseline {
                    let state = if baseline.succeeded { "passed" } else { "FAILED" };
                    let _ = writeln!(
                        out,
                        "- `{}` run: unmutated baseline {state} (build {:.0} s, test {:.0} s).",
                        run.name, baseline.build_seconds, baseline.test_seconds
                    );
                }
                for (file, counts) in &outcomes.per_file {
                    total += *counts;
                    rows.push((file.clone(), run.name, *counts));
                }
                let slow = outcomes.mutant_seconds.iter().cloned().fold(0.0_f64, f64::max);
                if !outcomes.mutant_seconds.is_empty() {
                    let mean = outcomes.mutant_seconds.iter().sum::<f64>() / outcomes.mutant_seconds.len() as f64;
                    let _ = writeln!(out, "- `{}` run: mean {mean:.1} s and slowest {slow:.1} s of build and test per mutant.", run.name);
                }
            }
        }
    }
    out.push('\n');

    if rows.is_empty() {
        out.push_str("**No mutant was measured.**\n");
    } else {
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        out.push_str("| File | Run | Caught | Timeout | Missed | Unviable | Score |\n|---|---|---|---|---|---|---|\n");
        for (file, run, c) in &rows {
            let _ = writeln!(out, "| `{file}` | {run} | {} | {} | {} | {} | {} |", c.caught, c.timeout, c.missed, c.unviable, show(c.score()));
        }
        let _ = writeln!(
            out,
            "\nTotal: {} caught, {} timed out, {} missed, {} unviable ({} of tried). Score {}.",
            total.caught,
            total.timeout,
            total.missed,
            total.unviable,
            show(total.unviable_share()),
            show(total.score())
        );
    }

    let mismatches = count_mismatches(plan, runs);
    if !mismatches.is_empty() {
        let _ = writeln!(out, "\nThe run measured a different number of mutants than `--list` counted for: {}.", mismatches.join(", "));
    }
    out
}

/// Files whose measured mutants differ from the number the plan counted, by name.
pub fn count_mismatches(plan: &Plan, runs: &[RunResult]) -> Vec<String> {
    let mut mismatched = Vec::new();
    for item in &plan.selected {
        let measured: usize = runs
            .iter()
            .filter_map(|run| run.outcomes.as_ref())
            .filter_map(|o| o.per_file.get(&item.file))
            .map(Counts::total)
            .sum();
        if measured != item.mutants {
            mismatched.push(format!("`{}` ({} planned, {} measured)", item.file, item.mutants, measured));
        }
    }
    mismatched
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::outcomes::Baseline;
    use crate::plan::{Item, LeftOut, NoMutants};

    fn plan(selected: Vec<Item>) -> Plan {
        Plan {
            kind: Kind::Pr,
            budget: Some(78),
            selected,
            left_out: vec![],
            no_mutants: vec![],
            deleted_sources: vec![],
            tests_left_to_full_run: vec![],
            tests_added: 0,
            tests_only_added_in: vec![],
        }
    }

    fn item(file: &str, group: Group, mode: Mode, mutants: usize) -> Item {
        Item { file: file.into(), group, mode, mutants }
    }

    #[test]
    fn an_empty_plan_says_nothing_was_mutated_and_that_it_is_not_a_pass() {
        let text = render_plan(&plan(vec![]));
        assert!(text.contains("**Nothing was mutated.**"), "{text}");
        assert!(text.contains("no changed Rust source") || text.contains("changes no Rust source"), "{text}");
        assert!(text.contains("not a pass of any file"), "{text}");
        assert!(!text.contains("| File |"), "{text}");
    }

    #[test]
    fn an_empty_plan_says_why_when_it_knows() {
        let mut p = plan(vec![]);
        p.no_mutants.push(NoMutants { file: "src/c.rs".into(), group: Group::ChangedSource });
        p.tests_only_added_in.push("src/t.rs".into());
        let text = render_plan(&p);
        assert!(text.contains("the changed lines hold no mutants"), "{text}");
        assert!(text.contains("the only test changes were additions"), "{text}");
        assert!(text.contains("`src/c.rs`"), "{text}");
    }

    #[test]
    fn a_plan_lists_each_selected_file_with_its_reason_and_mode() {
        let p = plan(vec![
            item("src/a.rs", Group::ChangedSource, Mode::InDiff, 3),
            item("src/b.rs", Group::EditedTest, Mode::Whole, 20),
        ]);
        let text = render_plan(&p);
        assert!(text.contains("Mutating 23 mutants in 2 files."), "{text}");
        assert!(text.contains("| `src/a.rs` | changed source | changed lines | 3 |"), "{text}");
        assert!(text.contains("| `src/b.rs` | edited in-file test | whole file | 20 |"), "{text}");
        assert!(!text.contains("Nothing was mutated"), "{text}");
    }

    #[test]
    fn a_single_mutant_in_a_single_file_reads_in_the_singular() {
        let text = render_plan(&plan(vec![item("src/a.rs", Group::ChangedSource, Mode::InDiff, 1)]));
        assert!(text.contains("Mutating 1 mutant in 1 file."), "{text}");
    }

    #[test]
    fn left_out_files_are_named_with_whether_they_need_a_proof_run() {
        let mut p = plan(vec![]);
        p.left_out = vec![
            LeftOut { item: item("src/big.rs", Group::ChangedSource, Mode::InDiff, 90), requires_proof: true },
            LeftOut { item: item("src/entry.rs", Group::BaselineEntry, Mode::Whole, 60), requires_proof: false },
        ];
        let text = render_plan(&p);
        assert!(text.contains("### Left out of this run"), "{text}");
        assert!(text.contains("| `src/big.rs` | changed source | changed lines | 90 | yes |"), "{text}");
        assert!(text.contains("| `src/entry.rs` | changed baseline entry | whole file | 60 | no |"), "{text}");
        assert!(!text.contains("Nothing was mutated"), "a plan with files left out is not an empty plan: {text}");
    }

    #[test]
    fn tests_left_to_a_full_run_and_ignored_ones_are_named() {
        let mut p = plan(vec![item("src/a.rs", Group::ChangedSource, Mode::InDiff, 1)]);
        p.tests_left_to_full_run = vec!["rust/tests/x.rs".into()];
        p.tests_added = 2;
        p.deleted_sources = vec!["src/old.rs".into()];
        let text = render_plan(&p);
        assert!(text.contains("Left to the next full run"), "{text}");
        assert!(text.contains("`rust/tests/x.rs`"), "{text}");
        assert!(text.contains("2 test files were added"), "{text}");
        assert!(text.contains("`src/old.rs`"), "{text}");
    }

    fn outcomes(per_file: &[(&str, Counts)]) -> Outcomes {
        Outcomes {
            tool_version: "27.1.0".into(),
            per_file: per_file.iter().map(|(f, c)| (f.to_string(), *c)).collect::<BTreeMap<_, _>>(),
            baseline: Some(Baseline { succeeded: true, build_seconds: 60.0, test_seconds: 30.0 }),
            mutant_seconds: vec![10.0, 20.0],
        }
    }

    fn counts(caught: usize, missed: usize) -> Counts {
        Counts { caught, missed, timeout: 0, unviable: 0, ignored: 0 }
    }

    #[test]
    fn results_show_a_row_per_file_and_say_nothing_gates() {
        let p = plan(vec![item("src/a.rs", Group::ChangedSource, Mode::InDiff, 4)]);
        let run = RunResult { name: "in-diff", exit: Exit::Missed, outcomes: Some(outcomes(&[("src/a.rs", counts(3, 1))])) };
        let text = render_results(&p, &[run]);
        assert!(text.contains("nothing here gates"), "{text}");
        assert!(text.contains("| `src/a.rs` | in-diff | 3 | 0 | 1 | 0 | 75.0% |"), "{text}");
        assert!(text.contains("unmutated baseline passed (build 60 s, test 30 s)"), "{text}");
        assert!(text.contains("mean 15.0 s and slowest 20.0 s"), "{text}");
    }

    #[test]
    fn a_broken_run_is_said_to_have_broken_and_a_missing_outcomes_file_too() {
        let p = plan(vec![item("src/a.rs", Group::ChangedSource, Mode::InDiff, 4)]);
        let broken = RunResult { name: "in-diff", exit: Exit::Broken("the unmutated tests already fail"), outcomes: None };
        let silent = RunResult { name: "whole", exit: Exit::Clean, outcomes: None };
        let text = render_results(&p, &[broken, silent]);
        assert!(text.contains("**`in-diff` run broke:** the unmutated tests already fail."), "{text}");
        assert!(text.contains("**`whole` run wrote no outcomes.json.**"), "{text}");
        assert!(text.contains("**No mutant was measured.**"), "{text}");
    }

    #[test]
    fn a_count_that_differs_from_the_list_is_called_out() {
        let p = plan(vec![item("src/a.rs", Group::ChangedSource, Mode::InDiff, 5)]);
        let run = RunResult { name: "in-diff", exit: Exit::Clean, outcomes: Some(outcomes(&[("src/a.rs", counts(4, 0))])) };
        assert_eq!(count_mismatches(&p, std::slice::from_ref(&run)), vec!["`src/a.rs` (5 planned, 4 measured)".to_string()]);
        assert!(render_results(&p, &[run]).contains("a different number of mutants"));
    }
}
