//! The self-check of the golden-result test (#371): a test that can't fail proves nothing. It runs every parity case against the stub with one answer changed (the last call of
//! each case gets a suffix on every string, or becomes a LogSeq error when it holds none) and requires that
//! every case with a LogSeq call then fails. That the server's result depends on what LogSeq said, and that the
//! comparator notices, is what the pass in `parity.rs` rests on.
//!
//! A second test lowers every ceiling by one and requires every case with a call to fail on it.
//!
//! It is its own test file so `cargo test --test parity` stays the quick check; it runs the whole case set
//! once more, so its runtime is about that of the parity run.

mod parity_support;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use parity_support::cases::{Case, load_cases, load_clock_cases, load_tool_list, perturb_cases, without_clock_cases};
use parity_support::compare::compare_results;
use parity_support::server::{PARITY_NOW_MS, Run, run_parity};
use parity_support::suggestion_rules::candidates_of;
use serde_json::{Value, json};

/// `value` with every `nextCursor` token in it (at any depth) rewritten: the token is decoded, `edit` changes its
/// payload, and it is encoded again. How many tokens were rewritten is added to `count`.
fn rewrite_cursors(value: &Value, edit: &dyn Fn(&mut Value), count: &mut usize) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, inner)| {
                    let rewritten = match (key.as_str(), inner) {
                        ("nextCursor", Value::String(token)) => {
                            let bytes = URL_SAFE_NO_PAD.decode(token).expect("a recorded nextCursor is base64url");
                            let mut payload: Value = serde_json::from_slice(&bytes).expect("its payload is JSON");
                            edit(&mut payload);
                            *count += 1;
                            Value::String(URL_SAFE_NO_PAD.encode(payload.to_string()))
                        }
                        _ => rewrite_cursors(inner, edit, count),
                    };
                    (key.clone(), rewritten)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(|item| rewrite_cursors(item, edit, count)).collect()),
        other => other.clone(),
    }
}

/// A recorded result with each `nextCursor` in the JSON texts of its `content` rewritten, and how many there were.
fn with_cursors_rewritten(expected: &Value, edit: &dyn Fn(&mut Value)) -> (Value, usize) {
    let mut count = 0;
    let mut result = expected.clone();
    if let Some(blocks) = result.get_mut("content").and_then(Value::as_array_mut) {
        for block in blocks {
            let Some(parsed) = block.get("text").and_then(Value::as_str).and_then(|text| serde_json::from_str::<Value>(text).ok()) else { continue };
            block["text"] = Value::String(rewrite_cursors(&parsed, edit, &mut count).to_string());
        }
    }
    (result, count)
}

#[test]
fn the_comparator_holds_every_recorded_next_cursor_to_what_it_says_and_to_nothing_else() {
    // ADR-0038: a token names a snapshot (a counter and the start time of the server), which is no part of the result's
    // meaning, and holds the position and the anchor, which are. Neither half of that rule may stop being checked.
    let cases = load_cases();
    let mut checked = 0;
    for case in &cases {
        let (other_snapshot, count) = with_cursors_rewritten(&case.expected, &|payload| payload["snapshot"] = json!({"started": 1, "n": 4242}));
        if count == 0 {
            continue;
        }
        checked += 1;
        let candidates = candidates_of(case);
        assert_eq!(compare_results(&case.expected, &other_snapshot, &candidates), Vec::<String>::new(), "{}: another snapshot is no difference", case.name);
        let edits: [(&str, &dyn Fn(&mut Value)); 5] = [
            ("position", &|payload| payload["position"] = json!({"kind": "index", "at": 424_242})),
            ("anchor", &|payload| payload["anchor"] = json!(-1)),
            ("arguments", &|payload| payload["args"] = json!({"text": "a search nobody made"})),
            ("tool", &|payload| payload["tool"] = json!("logseq_no_tool")),
            ("version", &|payload| payload["v"] = json!(99)),
        ];
        for (what, edit) in edits {
            let (wrong, _) = with_cursors_rewritten(&case.expected, edit);
            assert!(!compare_results(&case.expected, &wrong, &candidates).is_empty(), "{}: a different {what} passed", case.name);
        }
    }
    assert!(checked > 0, "no recorded case has a nextCursor, so the rule is held to nothing");
}

#[test]
fn every_case_with_a_logseq_call_fails_once_its_last_answer_is_perturbed() {
    let cases: Vec<Case> = {
        let all = load_cases();
        // A release build ignores the fixed clock (src/env.rs), so the cases that read today's date leave the run
        if cfg!(debug_assertions) { all } else { without_clock_cases(all, &load_clock_cases()) }
    };
    let perturbed = perturb_cases(&cases);
    let report = run_parity(&Run { cases: &perturbed, unperturbed: &cases, expected_tool_list: &load_tool_list(), now_ms: PARITY_NOW_MS, settle_ms: 2000, record: false });
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

#[test]
fn every_case_with_a_logseq_call_fails_once_its_ceiling_is_one_below_the_calls_it_makes() {
    // The ceiling rule (ADR-0034 Decision 5) can fail on the real server, for every case: the server makes the calls it
    // always made, one more than the ceiling now allows
    let cases: Vec<Case> = {
        let all = load_cases();
        if cfg!(debug_assertions) { all } else { without_clock_cases(all, &load_clock_cases()) }
    };
    let tight: Vec<Case> = cases.iter().map(|case| Case { ceiling: case.ceiling.saturating_sub(1), ..case.clone() }).collect();
    let report = run_parity(&Run { cases: &tight, unperturbed: &cases, expected_tool_list: &load_tool_list(), now_ms: PARITY_NOW_MS, settle_ms: 2000, record: false });
    let of = |case: &Case| report.failures.iter().filter(|f| f.starts_with(&format!("[{}: {}]", case.tool, case.name))).cloned().collect::<Vec<_>>();
    let not_caught: Vec<&str> = cases.iter().filter(|case| case.ceiling > 0).filter(|case| !of(case).iter().any(|f| f.contains("over the case's ceiling"))).map(|case| case.name.as_str()).collect();
    assert!(not_caught.is_empty(), "a ceiling one below the calls made went unnoticed in these cases ({} of {}):\n- {}", not_caught.len(), cases.len(), not_caught.join("\n- "));
    // A case with no call has a ceiling of 0 and makes none, so it still passes
    let quiet: Vec<&Case> = cases.iter().filter(|case| case.ceiling == 0).collect();
    assert!(!quiet.is_empty(), "the cases with no LogSeq call are part of the set");
    for case in quiet {
        assert_eq!(of(case), Vec::<String>::new(), "{}: a case that makes no call failed", case.name);
    }
}

#[test]
fn every_case_fails_once_its_ceiling_is_one_above_the_calls_it_makes() {
    // The other half of the ratchet: a saved call has to lower the ceiling, or a later change could spend it with no OK
    // (ADR-0034 Decision 5). Every case, those that make no call included, is given one more than it uses. Both lists are the
    // loosened cases, so the run judges them as committed; what is under test is the server's calls against the ceiling
    let cases: Vec<Case> = {
        let all = load_cases();
        if cfg!(debug_assertions) { all } else { without_clock_cases(all, &load_clock_cases()) }
    };
    let loose: Vec<Case> = cases.iter().map(|case| Case { ceiling: case.ceiling + 1, ..case.clone() }).collect();
    let report = run_parity(&Run { cases: &loose, unperturbed: &loose, expected_tool_list: &load_tool_list(), now_ms: PARITY_NOW_MS, settle_ms: 2000, record: false });
    let not_caught: Vec<&str> = cases
        .iter()
        .filter(|case| !report.failures.iter().any(|f| f.starts_with(&format!("[{}: {}]", case.tool, case.name)) && f.contains("under the case's ceiling")))
        .map(|case| case.name.as_str())
        .collect();
    assert!(not_caught.is_empty(), "a ceiling one above the calls made went unnoticed in these cases ({} of {}):\n- {}", not_caught.len(), cases.len(), not_caught.join("\n- "));
}
