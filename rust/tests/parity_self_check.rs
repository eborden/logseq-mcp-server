//! The self-check of the golden-result test (#371, `--self-check` of `scripts/parity.ts`): a test that can't
//! fail proves nothing. It runs every parity case against the stub with one answer changed (the last call of
//! each case gets a suffix on every string, or becomes a LogSeq error when it holds none) and requires that
//! every case with a LogSeq call then fails. That the server's result depends on what LogSeq said, and that the
//! comparator notices, is what the pass in `parity.rs` rests on.
//!
//! It is its own test file so `cargo test --test parity` stays the quick check; it runs the whole case set
//! once more, so its runtime is about that of the parity run.

mod parity_support;

use parity_support::cases::{Case, load_cases, load_clock_cases, load_tool_list, perturb_cases, without_clock_cases};
use parity_support::server::{PARITY_NOW_MS, Run, run_parity};

#[test]
fn every_case_with_a_logseq_call_fails_once_its_last_answer_is_perturbed() {
    let cases: Vec<Case> = {
        let all = load_cases();
        // A release build ignores the fixed clock (src/env.rs), so the cases that read today's date leave the run
        if cfg!(debug_assertions) { all } else { without_clock_cases(all, &load_clock_cases()) }
    };
    let perturbed = perturb_cases(&cases);
    let report = run_parity(&Run { cases: &perturbed, unperturbed: &cases, expected_tool_list: &load_tool_list(), now_ms: PARITY_NOW_MS, settle_ms: 2000 });
    let not_caught: Vec<&str> = cases
        .iter()
        .filter(|case| case.call_count() > 0)
        .filter(|case| !report.failures.iter().any(|f| f.starts_with(&format!("[{}: {}]", case.tool, case.name))))
        .map(|case| case.name.as_str())
        .collect();
    assert!(not_caught.is_empty(), "perturbing the last answer of these cases went unnoticed ({} of {}):\n- {}", not_caught.len(), cases.len(), not_caught.join("\n- "));
    // The cases with no call have no answer to perturb, so nothing fails there
    assert!(cases.iter().any(|case| case.call_count() == 0), "the cases with no LogSeq call are part of the set");
}
