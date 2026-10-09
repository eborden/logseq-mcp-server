//! The recorder of the golden results (#379). The group files in `tests/data/parity/` are the only source of the
//! cases and of the results recorded for them, so a result is recorded here, from the Rust server, and not
//! generated from anywhere else.
//!
//! `PARITY_RECORD=1 cargo test --test parity_record -- --nocapture` runs every case against the stub with the
//! debug build (which reads the fixed clock, `src/env.rs`) and rewrites the `expected` of a case only when its
//! result changed in meaning (`compare_results`: JSON by deep equality, closest names by the rules of ADR-0034 Decision 4,
//! everything else byte for byte). A case whose result is the same by that comparison keeps the bytes recorded for
//! it, so the diff of a re-record is the change and not the spelling of the Rust server's output. A case with no
//! `expected` yet is new, and gets its result. The recorded `tools/list` is rewritten the same way, entry by entry
//! (`compare_tool_lists`). The files are written as the Node recorder wrote them: one case per line, the case's
//! JSON minified by `serde_json` (`Value`'s `Display`), and the tool list indented by two spaces.
//!
//! A re-record is a decision: a golden result is the tool contract (ADR-0034), and a change to one needs the
//! maintainer's explicit OK, recorded on the pull request, and the `golden-change` label. So the recorder
//! - refuses to run when `CI` is set, in a release build (which ignores `LOGSEQ_MCP_NOW`) and for any value of
//!   `PARITY_RECORD` but `1`;
//! - records every case and the whole tool list, never a part of them;
//! - lowers a case's call ceiling (`call-ceilings.json`, ADR-0034 Decision 5) to the number of calls the server made
//!   when that is fewer, gives a case with no ceiling the number it made, and never raises one: a case that made
//!   more calls than its ceiling is a failure, and nothing is recorded;
//! - writes nothing when a case's LogSeq calls are wrong, when the server fails a case, or when a recorded
//!   closest-names list would break rules 3 to 6 of ADR-0034 Decision 4 or the recorded set would lack a case they require.
//!
//! The planning is plain functions over JSON values (`plan_group`, `plan_tool_list`, `render_group`), so
//! `tests/parity_record.rs` tests each rule without a server, and the whole recorder end to end against a copy of
//! some of the files.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::cases::{Case, case_of, group_files_in, load_cases_for_recording, load_ceilings_in, load_tool_list_in, render_ceilings};
use super::compare::{compare_results, compare_tool_lists};
use super::server::{PARITY_NOW_MS, Run, run_parity};
use super::suggestion_rules::{candidates_of, check_reference_lists, missing_required_cases};

/// The variable that asks for a recording.
pub const RECORD_VAR: &str = "PARITY_RECORD";

/// What the environment asks for.
#[derive(Debug, PartialEq, Eq)]
pub enum RecordRequest {
    /// Nothing: the recorder's test passes without doing anything
    Off,
    /// Record every case and the tool list
    Record,
}

/// What `PARITY_RECORD` asks for, given a lookup of the environment and whether this is a debug build. A request
/// that isn't allowed is an error and never a quiet no-op, so a recording that was asked for and refused is seen.
pub fn record_request(env: &dyn Fn(&str) -> Option<String>, debug_build: bool) -> Result<RecordRequest, String> {
    let set = |name: &str| env(name).is_some_and(|value| !value.is_empty());
    if !set(RECORD_VAR) {
        return Ok(RecordRequest::Off);
    }
    if set("CI") {
        return Err(format!("{RECORD_VAR} is never run in CI: a golden result changes only with the maintainer's explicit OK, recorded on the pull request"));
    }
    if !debug_build {
        return Err(format!("{RECORD_VAR} needs the debug build: a release build ignores LOGSEQ_MCP_NOW, so the cases that read today's date would be recorded for the wrong day"));
    }
    match env(RECORD_VAR).as_deref() {
        Some("1") => Ok(RecordRequest::Record),
        other => Err(format!("{RECORD_VAR} must be 1 to record, got {other:?}")),
    }
}

/// One case whose recorded result changes, and why: each line is a difference `compare_results` found, or
/// `new case` when the case had no result yet.
#[derive(Debug, PartialEq, Eq)]
pub struct CaseChange {
    pub name: String,
    pub lines: Vec<String>,
}

/// A group file as it will be written.
#[derive(Debug)]
pub struct GroupPlan {
    pub name: String,
    /// Every case of the group, as its JSON object, with the results to be recorded in place
    pub cases: Vec<Value>,
    /// The cases whose result changes. Nothing is written for a group with none.
    pub changes: Vec<CaseChange>,
}

/// What recording `results` does to the cases of a group: a case with no `expected` takes its result, one whose
/// recorded result differs in meaning from its result takes the result, and every other case is as it was, bytes
/// included.
pub fn plan_group(name: &str, cases: &[Value], results: &HashMap<String, Value>) -> Result<GroupPlan, String> {
    let mut planned = Vec::new();
    let mut changes = Vec::new();
    for raw in cases {
        let case = case_of(name, raw, false);
        let Some(result) = results.get(&case.name) else {
            return Err(format!("the server gave no result for the case {:?}", case.name));
        };
        let mut object = raw.as_object().expect("a case is an object").clone();
        match object.get("expected") {
            None => {
                changes.push(CaseChange { name: case.name.clone(), lines: vec!["new case".to_owned()] });
                object.insert("expected".to_owned(), result.clone());
            }
            Some(recorded) => {
                // The closest names of a missing page are held to the rules of ADR-0034 Decision 4, not to bytes: a list the rules accept is no change
                let lines = compare_results(recorded, result, &candidates_of(&case));
                if !lines.is_empty() {
                    changes.push(CaseChange { name: case.name.clone(), lines });
                    object.insert("expected".to_owned(), result.clone());
                }
            }
        }
        planned.push(Value::Object(object));
    }
    Ok(GroupPlan { name: name.to_owned(), cases: planned, changes })
}

/// A group file's text: the group's name, then the cases one to a line.
pub fn render_group(name: &str, cases: &[Value]) -> String {
    let lines: Vec<String> = cases.iter().map(|case| format!("  {case}")).collect();
    format!("{{\"group\":{},\"cases\":[\n{}\n]}}\n", json!(name), lines.join(",\n"))
}

/// The recorded tool list as it will be written.
#[derive(Debug)]
pub struct ToolListPlan {
    pub tools: Vec<Value>,
    /// Each difference in meaning between the recorded list and the server's
    pub changes: Vec<String>,
}

/// What recording the server's `tools/list` does: nothing (`None`) when it is the recorded list by meaning
/// (ADR-0034 Decision 3: the schemars spellings of a schema don't count), otherwise the server's list, with every tool that
/// is the same by meaning keeping the bytes it had.
pub fn plan_tool_list(recorded: &[Value], server: &[Value]) -> Option<ToolListPlan> {
    let changes = compare_tool_lists(recorded, server);
    if changes.is_empty() {
        return None;
    }
    let tools = server
        .iter()
        .map(|tool| {
            let before = recorded.iter().find(|candidate| candidate["name"] == tool["name"]);
            match before {
                Some(before) if compare_tool_lists(std::slice::from_ref(before), std::slice::from_ref(tool)).is_empty() => before.clone(),
                _ => tool.clone(),
            }
        })
        .collect();
    Some(ToolListPlan { tools, changes })
}

/// The recorded tool list's text: indented by two spaces.
pub fn render_tool_list(tools: &[Value]) -> String {
    format!("{}\n", serde_json::to_string_pretty(&Value::Array(tools.to_vec())).expect("a tool list serializes"))
}

/// The call ceilings as they will be written.
#[derive(Debug)]
pub struct CeilingPlan {
    /// Every recorded ceiling, the lowered ones and the new ones included
    pub ceilings: BTreeMap<String, usize>,
    /// One line for each ceiling that moves, and how
    pub changes: Vec<String>,
}

/// What recording does to the call ceilings (ADR-0034 Decision 5): a case that made fewer calls than its ceiling
/// has it lowered to that number, so a saved call can't be spent again without asking; a case with no ceiling
/// takes the number it made; every other ceiling is as it was. Nothing is ever raised, and a ceiling for a case
/// this run didn't have (a copy of some of the files) is kept.
pub fn plan_ceilings(recorded: &BTreeMap<String, usize>, cases: &[Case], made: &HashMap<String, usize>) -> Result<CeilingPlan, String> {
    let mut ceilings = recorded.clone();
    let mut changes = Vec::new();
    for case in cases {
        let Some(&count) = made.get(&case.name) else {
            return Err(format!("the server made no calls to count for the case {:?}", case.name));
        };
        match recorded.get(&case.name) {
            None => {
                changes.push(format!("new ceiling: {} is {count}", case.name));
                ceilings.insert(case.name.clone(), count);
            }
            Some(&ceiling) if count < ceiling => {
                changes.push(format!("ceiling lowered: {} {ceiling} to {count}", case.name));
                ceilings.insert(case.name.clone(), count);
            }
            Some(_) => {}
        }
    }
    Ok(CeilingPlan { ceilings, changes })
}

/// What a recording did.
#[derive(Debug, Default)]
pub struct RecordReport {
    /// What changed, for the person who reads the output
    pub lines: Vec<String>,
    /// The files written
    pub written: Vec<PathBuf>,
}

fn with_results(cases: &[Case], results: &HashMap<String, Value>) -> Vec<Case> {
    cases.iter().map(|case| Case { expected: results[&case.name].clone(), ..case.clone() }).collect()
}

/// Record the folder `dir`: run every case of its group files against the stub, and rewrite what changed in
/// meaning. `require_suggestion_cases` is for the real case set: the recorded results have to hold every kind of
/// closest-names case ADR-0034 Decision 4 requires, which a copy of some of the files can't.
pub fn record_goldens(dir: &Path, require_suggestion_cases: bool) -> Result<RecordReport, String> {
    let cases = load_cases_for_recording(dir);
    let recorded_tools = load_tool_list_in(dir);
    let report = run_parity(&Run { cases: &cases, unperturbed: &cases, expected_tool_list: &[], now_ms: PARITY_NOW_MS, settle_ms: 2000, record: true });
    if !report.failures.is_empty() {
        return Err(format!(
            "nothing was recorded: {} failure(s)\n- {}\n{}",
            report.failures.len(),
            report.failures.join("\n- "),
            if report.stderr.trim().is_empty() { String::new() } else { format!("server stderr:\n{}", report.stderr.trim()) }
        ));
    }
    // The results about to be recorded are the reference from now on: their closest names have to pass the rules
    let recording = with_results(&cases, &report.results);
    let mut broken = check_reference_lists(&recording);
    if require_suggestion_cases {
        broken.extend(missing_required_cases(&recording));
    }
    if !broken.is_empty() {
        return Err(format!("nothing was recorded: the results break the closest-name rules of ADR-0032\n- {}", broken.join("\n- ")));
    }

    let mut out = RecordReport::default();
    let mut writes: Vec<(PathBuf, String)> = Vec::new();
    for group in group_files_in(dir) {
        let plan = plan_group(&group.name, &group.cases, &report.results)?;
        for change in &plan.changes {
            out.lines.push(format!("changed: {}", change.name));
            out.lines.extend(change.lines.iter().map(|line| format!("  - {line}")));
        }
        if !plan.changes.is_empty() {
            writes.push((group.path.clone(), render_group(&plan.name, &plan.cases)));
        }
    }
    match plan_tool_list(&recorded_tools, &report.tool_list) {
        Some(plan) => {
            out.lines.extend(plan.changes.iter().map(|line| format!("tools/list changed: {line}")));
            writes.push((dir.join("tool-list.json"), render_tool_list(&plan.tools)));
        }
        None => out.lines.push("tools/list: no change in meaning; the file is left as it is".to_owned()),
    }
    let ceilings = plan_ceilings(&load_ceilings_in(dir, true), &cases, &report.call_counts)?;
    if !ceilings.changes.is_empty() {
        out.lines.extend(ceilings.changes.iter().map(|line| format!("  - {line}")));
        writes.push((dir.join("call-ceilings.json"), render_ceilings(&ceilings.ceilings)));
    }
    for (path, text) in writes {
        fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
        out.lines.push(format!("wrote {}", path.display()));
        out.written.push(path);
    }
    if out.written.is_empty() {
        out.lines.push("nothing changed in meaning; no file was written".to_owned());
    } else {
        out.lines.push("review the JSON diff before committing: a changed golden result needs the maintainer's explicit OK and the golden-change label".to_owned());
    }
    Ok(out)
}
