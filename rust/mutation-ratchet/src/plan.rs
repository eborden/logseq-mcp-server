//! What a pull request's mutation run measures, and what it leaves out (ADR-0033 "The plan comes from the PR's own diff"
//! and "The budget").
//!
//! The plan is a pure function of the PR's changes, the exact mutant counts the tool printed and the budget, so every
//! rule in it is a unit test and the same inputs always pick the same files. Reading git and running the tool is in
//! `gather.rs`; this file never touches either.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// Why a file is in the plan. The order is the priority order of the walk, and so the order files are taken first-fit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Group {
    /// Code changed outside any test item: mutants overlapping the changed lines (`--in-diff`).
    ChangedSource,
    /// A line was removed or edited inside the file's own test items: the whole file (`--file`).
    EditedTest,
    /// The file's baseline entry changed: the whole file, so a raise is checked against all of it.
    BaselineEntry,
    /// A full run: every mutant of the files in one slice.
    Full,
}

impl Group {
    pub fn label(self) -> &'static str {
        match self {
            Group::ChangedSource => "changed source",
            Group::EditedTest => "edited in-file test",
            Group::BaselineEntry => "changed baseline entry",
            Group::Full => "full run",
        }
    }

    /// A changed source or a weakened test that the PR run left out fails the ratchet until a proof run has measured it
    /// (ADR-0033). A baseline entry is covered by the full run, so leaving it out is a warning only.
    pub fn requires_proof(self) -> bool {
        matches!(self, Group::ChangedSource | Group::EditedTest)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Only the mutants overlapping the PR's changed lines.
    InDiff,
    /// Every mutant in the file.
    Whole,
}

/// One file the run measures, and how many mutants that is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    /// Relative to the server crate (`src/x.rs`), as `cargo mutants` names it.
    pub file: String,
    pub group: Group,
    pub mode: Mode,
    pub mutants: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeftOut {
    pub item: Item,
    pub requires_proof: bool,
}

/// A file the PR touched that has nothing to measure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoMutants {
    pub file: String,
    pub group: Group,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// The PR job.
    Pr,
    /// A proof run: the left-out changed sources of the PR job, with no budget.
    Proof,
    /// A slice of a full run.
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub kind: Kind,
    /// Mutants the run may take, reserve included. `None` for a proof or a full run.
    pub budget: Option<usize>,
    pub selected: Vec<Item>,
    pub left_out: Vec<LeftOut>,
    pub no_mutants: Vec<NoMutants>,
    /// Source files the PR deleted: nothing left to mutate.
    pub deleted_sources: Vec<String>,
    /// Files under `rust/tests/` the PR edited or deleted, which the PR job can't map to a source file: left to a full run.
    pub tests_left_to_full_run: Vec<String>,
    /// Files under `rust/tests/` the PR added. A new test can only add kills, so they are ignored.
    pub tests_added: usize,
    /// Source files whose only change is added lines inside their own test items: ignored for the same reason.
    pub tests_only_added_in: Vec<String>,
}

/// Everything the plan is made from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlanInput {
    /// Mutants the run may take, the re-run reserve included (see `fits`).
    pub budget: usize,
    /// Source files with a changed line outside their test items.
    pub code_changed: BTreeSet<String>,
    /// Source files with a removed or edited line inside their test items. A change in a `#[cfg(test)] mod x;` file is
    /// listed under the file that declares it, since the test file itself has no mutants.
    pub tests_weakened: BTreeSet<String>,
    /// Files of the baseline entries the PR added or changed.
    pub baseline_entries: BTreeSet<String>,
    /// Mutants overlapping the PR's changed lines, by file (`--list --in-diff`).
    pub in_diff_counts: BTreeMap<String, usize>,
    /// Every mutant, by file (`--list`).
    pub whole_counts: BTreeMap<String, usize>,
    pub deleted_sources: BTreeSet<String>,
    pub tests_edited: BTreeSet<String>,
    pub tests_added: usize,
    pub tests_only_added_in: BTreeSet<String>,
}

/// Mutants a run can take, from the job's time (ADR-0033 "The budget"): the timeout, less the overhead (install, dependency
/// restore, the baseline build and test, once for each `cargo mutants` call) and a spare, times the jobs, over the slowest
/// measured seconds per mutant. The re-run reserve is not in it: it depends on the files chosen, so `fits` holds it.
pub struct BudgetInputs {
    pub timeout_seconds: u64,
    pub overhead_seconds: u64,
    pub spare_seconds: u64,
    pub seconds_per_mutant: u64,
    pub jobs: u64,
}

pub fn mutant_budget(inputs: &BudgetInputs) -> usize {
    if inputs.seconds_per_mutant == 0 {
        return 0;
    }
    let usable = inputs
        .timeout_seconds
        .saturating_sub(inputs.overhead_seconds)
        .saturating_sub(inputs.spare_seconds);
    (usable.saturating_mul(inputs.jobs) / inputs.seconds_per_mutant) as usize
}

/// Whether a selection of `total` mutants whose largest file has `largest` fits `budget`. The largest file is counted twice:
/// once for its run and once as the reserve for the one re-run a file below its baseline gets (ADR-0033 "The budget").
/// The boundary is inclusive: `total + largest == budget` fits.
pub fn fits(total: usize, largest: usize, budget: usize) -> bool {
    total.checked_add(largest).is_some_and(|needed| needed <= budget)
}

pub fn make_plan(input: &PlanInput) -> Plan {
    let mut candidates: Vec<Item> = Vec::new();
    let mut no_mutants: Vec<NoMutants> = Vec::new();

    for file in &input.code_changed {
        match input.in_diff_counts.get(file).copied().unwrap_or(0) {
            0 => no_mutants.push(NoMutants { file: file.clone(), group: Group::ChangedSource }),
            mutants => candidates.push(Item { file: file.clone(), group: Group::ChangedSource, mode: Mode::InDiff, mutants }),
        }
    }
    // A file in both whole-file groups is one item, under the first group.
    let whole_files: BTreeSet<&String> = input.tests_weakened.iter().chain(&input.baseline_entries).collect();
    for file in whole_files {
        let group = if input.tests_weakened.contains(file) { Group::EditedTest } else { Group::BaselineEntry };
        match input.whole_counts.get(file).copied().unwrap_or(0) {
            0 => no_mutants.push(NoMutants { file: file.clone(), group }),
            mutants => candidates.push(Item { file: file.clone(), group, mode: Mode::Whole, mutants }),
        }
    }
    candidates.sort_by(|a, b| (a.group, &a.file).cmp(&(b.group, &b.file)));
    no_mutants.sort_by(|a, b| (a.group, &a.file).cmp(&(b.group, &b.file)));

    let mut chosen: BTreeMap<String, Item> = BTreeMap::new();
    let mut left_out: Vec<LeftOut> = Vec::new();
    for item in candidates {
        if chosen.get(&item.file).is_some_and(|taken| taken.mode == Mode::Whole) {
            continue;
        }
        // A whole-file item replaces the file's in-diff one: it subsumes it, so only the difference is new.
        let (mut total, mut largest) = (item.mutants, item.mutants);
        for (file, taken) in &chosen {
            if *file != item.file {
                total += taken.mutants;
                largest = largest.max(taken.mutants);
            }
        }
        if fits(total, largest, input.budget) {
            chosen.insert(item.file.clone(), item);
        } else {
            let requires_proof = item.group.requires_proof();
            left_out.push(LeftOut { item, requires_proof });
        }
    }
    let mut selected: Vec<Item> = chosen.into_values().collect();
    selected.sort_by(|a, b| (a.group, &a.file).cmp(&(b.group, &b.file)));

    Plan {
        kind: Kind::Pr,
        budget: Some(input.budget),
        selected,
        left_out,
        no_mutants,
        deleted_sources: input.deleted_sources.iter().cloned().collect(),
        tests_left_to_full_run: input.tests_edited.iter().cloned().collect(),
        tests_added: input.tests_added,
        tests_only_added_in: input.tests_only_added_in.iter().cloned().collect(),
    }
}

/// The plan of a proof run (ADR-0033): the changed sources and edited tests the PR job left out, measured with no budget.
/// A file left out in both modes is measured whole, which covers its changed lines.
pub fn proof_plan(pr_plan: &Plan) -> Plan {
    let mut chosen: BTreeMap<String, Item> = BTreeMap::new();
    for left in pr_plan.left_out.iter().filter(|left| left.requires_proof) {
        let keep_existing = chosen.get(&left.item.file).is_some_and(|taken| taken.mode == Mode::Whole);
        if !keep_existing {
            chosen.insert(left.item.file.clone(), left.item.clone());
        }
    }
    let mut selected: Vec<Item> = chosen.into_values().collect();
    selected.sort_by(|a, b| (a.group, &a.file).cmp(&(b.group, &b.file)));
    Plan {
        kind: Kind::Proof,
        budget: None,
        selected,
        left_out: Vec::new(),
        ..pr_plan.clone()
    }
}

impl Plan {
    pub fn selected_mutants(&self) -> usize {
        self.selected.iter().map(|item| item.mutants).sum()
    }

    pub fn in_diff_files(&self) -> Vec<&str> {
        self.files_in(Mode::InDiff)
    }

    pub fn whole_files(&self) -> Vec<&str> {
        self.files_in(Mode::Whole)
    }

    fn files_in(&self, mode: Mode) -> Vec<&str> {
        let mut files: Vec<&str> = self.selected.iter().filter(|item| item.mode == mode).map(|item| item.file.as_str()).collect();
        files.sort_unstable();
        files
    }

    /// Nothing selected and nothing left out: there was nothing to measure.
    pub fn is_empty(&self) -> bool {
        self.selected.is_empty() && self.left_out.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn counts(items: &[(&str, usize)]) -> BTreeMap<String, usize> {
        items.iter().map(|(file, n)| (file.to_string(), *n)).collect()
    }

    fn files(items: &[Item]) -> Vec<(&str, Group, Mode, usize)> {
        items.iter().map(|i| (i.file.as_str(), i.group, i.mode, i.mutants)).collect()
    }

    #[test]
    fn the_budget_is_the_time_left_times_the_jobs_over_the_seconds_per_mutant() {
        let inputs = BudgetInputs { timeout_seconds: 1200, overhead_seconds: 300, spare_seconds: 120, seconds_per_mutant: 20, jobs: 2 };
        // (1200 - 300 - 120) * 2 / 20 = 78
        assert_eq!(mutant_budget(&inputs), 78);
        // Rounds down: 780 * 2 / 25 = 62.4
        assert_eq!(mutant_budget(&BudgetInputs { seconds_per_mutant: 25, ..inputs }), 62);
    }

    #[test]
    fn a_budget_never_goes_negative_and_never_divides_by_zero() {
        let inputs = BudgetInputs { timeout_seconds: 100, overhead_seconds: 300, spare_seconds: 0, seconds_per_mutant: 20, jobs: 2 };
        assert_eq!(mutant_budget(&inputs), 0);
        assert_eq!(mutant_budget(&BudgetInputs { timeout_seconds: 1000, seconds_per_mutant: 0, ..inputs }), 0);
        // The spare alone can eat the time left.
        assert_eq!(mutant_budget(&BudgetInputs { timeout_seconds: 400, overhead_seconds: 300, spare_seconds: 200, ..inputs }), 0);
    }

    #[test]
    fn the_budget_boundary_is_inclusive_and_counts_the_largest_file_twice() {
        assert!(fits(5, 5, 10));
        assert!(!fits(6, 6, 10));
        assert!(fits(7, 4, 11));
        assert!(!fits(7, 4, 10));
        assert!(fits(0, 0, 0), "an empty selection fits any budget");
        assert!(!fits(usize::MAX, 1, usize::MAX));
    }

    #[test]
    fn a_file_at_the_boundary_is_taken_and_one_over_it_is_left_out() {
        let at = make_plan(&PlanInput {
            budget: 10,
            code_changed: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 5)]),
            ..Default::default()
        });
        assert_eq!(files(&at.selected), vec![("src/a.rs", Group::ChangedSource, Mode::InDiff, 5)]);
        assert!(at.left_out.is_empty());

        let over = make_plan(&PlanInput {
            budget: 10,
            code_changed: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 6)]),
            ..Default::default()
        });
        assert!(over.selected.is_empty());
        assert_eq!(files(&[over.left_out[0].item.clone()]), vec![("src/a.rs", Group::ChangedSource, Mode::InDiff, 6)]);
        assert!(over.left_out[0].requires_proof);
    }

    #[test]
    fn the_reserve_is_the_largest_selected_file_not_the_largest_candidate() {
        // 3 + 4 = 7 and the largest is 4: 11 > 10, so the second file is left out. Alone, each fits.
        let plan = make_plan(&PlanInput {
            budget: 10,
            code_changed: set(&["src/a.rs", "src/b.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 3), ("src/b.rs", 4)]),
            ..Default::default()
        });
        assert_eq!(files(&plan.selected), vec![("src/a.rs", Group::ChangedSource, Mode::InDiff, 3)]);
        assert_eq!(plan.left_out.len(), 1);
        assert_eq!(plan.left_out[0].item.file, "src/b.rs");
    }

    #[test]
    fn files_are_taken_first_fit_so_a_file_that_does_not_fit_is_skipped_and_the_walk_goes_on() {
        // a: 8 + 8 = 16 > 12, so it is left out. b: 2 + 2 = 4 fits. c: (2 + 3) + 3 = 8 fits.
        let plan = make_plan(&PlanInput {
            budget: 12,
            code_changed: set(&["src/a.rs", "src/b.rs", "src/c.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 8), ("src/b.rs", 2), ("src/c.rs", 3)]),
            ..Default::default()
        });
        assert_eq!(
            files(&plan.selected),
            vec![
                ("src/b.rs", Group::ChangedSource, Mode::InDiff, 2),
                ("src/c.rs", Group::ChangedSource, Mode::InDiff, 3),
            ]
        );
        assert_eq!(plan.left_out.iter().map(|l| l.item.file.as_str()).collect::<Vec<_>>(), vec!["src/a.rs"]);
    }

    #[test]
    fn within_a_group_files_go_in_path_order_so_an_earlier_path_wins_a_tight_budget() {
        let plan = make_plan(&PlanInput {
            budget: 9,
            code_changed: set(&["src/z.rs", "src/a.rs"]),
            in_diff_counts: counts(&[("src/z.rs", 4), ("src/a.rs", 4)]),
            ..Default::default()
        });
        // a: 4 + 4 = 8 fits. z: 8 + 4 = 12 does not.
        assert_eq!(plan.selected[0].file, "src/a.rs");
        assert_eq!(plan.left_out[0].item.file, "src/z.rs");
    }

    #[test]
    fn the_groups_are_walked_in_priority_order_whatever_the_paths() {
        let plan = make_plan(&PlanInput {
            budget: 100,
            code_changed: set(&["src/m.rs"]),
            tests_weakened: set(&["src/b.rs"]),
            baseline_entries: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/m.rs", 1)]),
            whole_counts: counts(&[("src/a.rs", 2), ("src/b.rs", 3), ("src/m.rs", 9)]),
            ..Default::default()
        });
        assert_eq!(
            files(&plan.selected),
            vec![
                ("src/m.rs", Group::ChangedSource, Mode::InDiff, 1),
                ("src/b.rs", Group::EditedTest, Mode::Whole, 3),
                ("src/a.rs", Group::BaselineEntry, Mode::Whole, 2),
            ]
        );
    }

    #[test]
    fn when_the_budget_is_short_a_changed_source_beats_a_baseline_entry_for_it() {
        // Both are 4 mutants and only one fits (4 + 4 = 8 <= 9; two would be 8 + 4 = 12).
        let plan = make_plan(&PlanInput {
            budget: 9,
            code_changed: set(&["src/z.rs"]),
            baseline_entries: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/z.rs", 4)]),
            whole_counts: counts(&[("src/a.rs", 4)]),
            ..Default::default()
        });
        assert_eq!(plan.selected[0].file, "src/z.rs");
        let left = &plan.left_out[0];
        assert_eq!((left.item.file.as_str(), left.item.group), ("src/a.rs", Group::BaselineEntry));
        assert!(!left.requires_proof, "a baseline entry is a warning, covered by the full run");
    }

    #[test]
    fn an_edited_test_whole_file_replaces_the_files_in_diff_item_when_it_fits() {
        let plan = make_plan(&PlanInput {
            budget: 100,
            code_changed: set(&["src/a.rs"]),
            tests_weakened: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 2)]),
            whole_counts: counts(&[("src/a.rs", 20)]),
            ..Default::default()
        });
        assert_eq!(files(&plan.selected), vec![("src/a.rs", Group::EditedTest, Mode::Whole, 20)]);
        assert!(plan.left_out.is_empty());
        assert_eq!(plan.selected_mutants(), 20, "the file is counted once, not as 2 and 20");
    }

    #[test]
    fn when_the_whole_file_does_not_fit_the_changed_lines_stay_and_the_test_edit_is_left_out_for_proof() {
        let plan = make_plan(&PlanInput {
            budget: 10,
            code_changed: set(&["src/a.rs"]),
            tests_weakened: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 2)]),
            whole_counts: counts(&[("src/a.rs", 20)]),
            ..Default::default()
        });
        assert_eq!(files(&plan.selected), vec![("src/a.rs", Group::ChangedSource, Mode::InDiff, 2)]);
        assert_eq!(plan.left_out.len(), 1);
        assert_eq!(plan.left_out[0].item.group, Group::EditedTest);
        assert!(plan.left_out[0].requires_proof, "a weakened test unverified is what the ratchet is for");
    }

    #[test]
    fn a_file_in_both_whole_file_groups_is_one_edited_test_item() {
        let plan = make_plan(&PlanInput {
            budget: 100,
            tests_weakened: set(&["src/a.rs"]),
            baseline_entries: set(&["src/a.rs"]),
            whole_counts: counts(&[("src/a.rs", 5)]),
            ..Default::default()
        });
        assert_eq!(files(&plan.selected), vec![("src/a.rs", Group::EditedTest, Mode::Whole, 5)]);
    }

    #[test]
    fn a_touched_file_with_no_mutants_is_named_not_left_out() {
        let plan = make_plan(&PlanInput {
            budget: 100,
            code_changed: set(&["src/consts.rs"]),
            baseline_entries: set(&["src/gone.rs"]),
            ..Default::default()
        });
        assert!(plan.selected.is_empty() && plan.left_out.is_empty());
        assert_eq!(
            plan.no_mutants,
            vec![
                NoMutants { file: "src/consts.rs".into(), group: Group::ChangedSource },
                NoMutants { file: "src/gone.rs".into(), group: Group::BaselineEntry },
            ]
        );
        assert!(plan.is_empty());
    }

    #[test]
    fn a_diff_with_no_source_change_is_an_empty_plan() {
        let plan = make_plan(&PlanInput { budget: 78, ..Default::default() });
        assert!(plan.is_empty());
        assert_eq!(plan.selected_mutants(), 0);
        assert!(plan.in_diff_files().is_empty() && plan.whole_files().is_empty());
    }

    #[test]
    fn a_diff_only_inside_test_items_selects_nothing_and_says_what_it_ignored() {
        // The gather step puts a file whose only change is added test lines here, in neither code_changed nor tests_weakened.
        let plan = make_plan(&PlanInput {
            budget: 78,
            tests_only_added_in: set(&["src/a.rs"]),
            tests_added: 2,
            ..Default::default()
        });
        assert!(plan.is_empty());
        assert_eq!(plan.tests_only_added_in, vec!["src/a.rs".to_string()]);
        assert_eq!(plan.tests_added, 2);
    }

    #[test]
    fn edited_tests_under_rust_tests_are_named_and_left_to_the_full_run() {
        let plan = make_plan(&PlanInput {
            budget: 78,
            tests_edited: set(&["rust/tests/b.rs", "rust/tests/a.rs"]),
            ..Default::default()
        });
        assert_eq!(plan.tests_left_to_full_run, vec!["rust/tests/a.rs".to_string(), "rust/tests/b.rs".to_string()]);
        assert!(plan.is_empty(), "they are not measured, so the plan is still empty");
    }

    #[test]
    fn everything_left_out_can_leave_nothing_selected_without_the_plan_being_empty() {
        let plan = make_plan(&PlanInput {
            budget: 4,
            code_changed: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 30)]),
            ..Default::default()
        });
        assert!(plan.selected.is_empty());
        assert!(!plan.is_empty());
    }

    #[test]
    fn a_zero_budget_selects_nothing() {
        let plan = make_plan(&PlanInput {
            budget: 0,
            code_changed: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 1)]),
            ..Default::default()
        });
        assert!(plan.selected.is_empty());
        assert_eq!(plan.left_out.len(), 1);
    }

    #[test]
    fn the_files_by_mode_are_sorted_for_the_two_tool_calls() {
        let plan = make_plan(&PlanInput {
            budget: 1000,
            code_changed: set(&["src/z.rs", "src/b.rs"]),
            tests_weakened: set(&["src/y.rs", "src/c.rs"]),
            in_diff_counts: counts(&[("src/z.rs", 1), ("src/b.rs", 1)]),
            whole_counts: counts(&[("src/y.rs", 1), ("src/c.rs", 1)]),
            ..Default::default()
        });
        assert_eq!(plan.in_diff_files(), vec!["src/b.rs", "src/z.rs"]);
        assert_eq!(plan.whole_files(), vec!["src/c.rs", "src/y.rs"]);
    }

    #[test]
    fn a_proof_plan_is_the_left_out_sources_and_edited_tests_with_no_budget() {
        let pr = make_plan(&PlanInput {
            budget: 10,
            code_changed: set(&["src/big.rs", "src/small.rs"]),
            baseline_entries: set(&["src/entry.rs"]),
            in_diff_counts: counts(&[("src/big.rs", 30), ("src/small.rs", 2)]),
            whole_counts: counts(&[("src/entry.rs", 50)]),
            tests_edited: set(&["rust/tests/t.rs"]),
            ..Default::default()
        });
        let proof = proof_plan(&pr);
        assert_eq!(proof.kind, Kind::Proof);
        assert_eq!(proof.budget, None);
        assert_eq!(files(&proof.selected), vec![("src/big.rs", Group::ChangedSource, Mode::InDiff, 30)]);
        assert!(proof.left_out.is_empty(), "a baseline entry is not proved, it is a warning");
        assert_eq!(proof.tests_left_to_full_run, pr.tests_left_to_full_run);
    }

    #[test]
    fn a_proof_plan_measures_a_file_whole_when_it_was_left_out_both_ways() {
        let pr = make_plan(&PlanInput {
            budget: 4,
            code_changed: set(&["src/a.rs"]),
            tests_weakened: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 9)]),
            whole_counts: counts(&[("src/a.rs", 40)]),
            ..Default::default()
        });
        assert_eq!(pr.left_out.len(), 2);
        let proof = proof_plan(&pr);
        assert_eq!(files(&proof.selected), vec![("src/a.rs", Group::EditedTest, Mode::Whole, 40)]);
    }

    #[test]
    fn a_pr_that_left_nothing_out_has_an_empty_proof() {
        let pr = make_plan(&PlanInput {
            budget: 100,
            code_changed: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 3)]),
            ..Default::default()
        });
        assert!(proof_plan(&pr).is_empty());
    }

    #[test]
    fn a_plan_survives_json() {
        let plan = make_plan(&PlanInput {
            budget: 10,
            code_changed: set(&["src/a.rs"]),
            in_diff_counts: counts(&[("src/a.rs", 30)]),
            ..Default::default()
        });
        let text = serde_json::to_string(&plan).unwrap();
        assert_eq!(serde_json::from_str::<Plan>(&text).unwrap(), plan);
        assert!(text.contains("\"changed_source\"") && text.contains("\"in_diff\""));
    }
}
