//! Read `mutants.out/outcomes.json` (cargo-mutants 27.1.0, `src/outcome.rs`).
//!
//! The tool says its format "is subject to change", so this reads only the fields it needs, checks them strictly, and fails
//! with a message that names the problem and never a value. A report that is silently wrong would set a gate, so a file that
//! doesn't match what the tool promises is an error, not an empty result: the totals it carries must agree with its
//! outcomes (a file cut short by a killed job fails here), and a mutant with an outcome the score has no rule for is
//! refused.

use std::collections::BTreeMap;
use std::fmt;

use serde::Deserialize;
use serde_json::Value;

use crate::score::Counts;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutcomesError(pub String);

impl fmt::Display for OutcomesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for OutcomesError {}

fn err<T>(message: impl Into<String>) -> Result<T, OutcomesError> {
    Err(OutcomesError(message.into()))
}

#[derive(Deserialize)]
struct Raw {
    outcomes: Vec<RawOutcome>,
    total_mutants: usize,
    caught: usize,
    missed: usize,
    timeout: usize,
    unviable: usize,
    cargo_mutants_version: String,
}

#[derive(Deserialize)]
struct RawOutcome {
    scenario: Value,
    summary: String,
    #[serde(default)]
    phase_results: Vec<RawPhase>,
}

#[derive(Deserialize)]
struct RawPhase {
    phase: String,
    duration: f64,
}

/// The unmutated build and test the tool runs first.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Baseline {
    pub succeeded: bool,
    pub build_seconds: f64,
    pub test_seconds: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcomes {
    pub tool_version: String,
    /// Outcome counts by file, relative to the server crate (`src/x.rs`).
    pub per_file: BTreeMap<String, Counts>,
    /// `None` when the file has no baseline outcome (the tool wrote nothing for it).
    pub baseline: Option<Baseline>,
    /// Build plus test seconds of each mutant that reached the build or the test, in the order the tool recorded them.
    pub mutant_seconds: Vec<f64>,
}

impl Outcomes {
    pub fn total(&self) -> Counts {
        let mut total = Counts::default();
        for counts in self.per_file.values() {
            total += *counts;
        }
        total
    }
}

pub fn parse(text: &str) -> Result<Outcomes, OutcomesError> {
    let raw: Raw = serde_json::from_str(text).map_err(|e| OutcomesError(format!("outcomes.json doesn't have the expected shape: {e}")))?;

    let mut per_file: BTreeMap<String, Counts> = BTreeMap::new();
    let mut baseline = None;
    let mut mutant_seconds = Vec::new();
    let mut mutants = 0usize;
    for outcome in &raw.outcomes {
        let seconds = |phase: &str| -> f64 { outcome.phase_results.iter().filter(|p| p.phase == phase).map(|p| p.duration).sum() };
        match scenario_file(&outcome.scenario)? {
            None => {
                baseline = Some(Baseline {
                    succeeded: outcome.summary == "Success",
                    build_seconds: seconds("Build"),
                    test_seconds: seconds("Test"),
                });
            }
            Some(file) => {
                mutants += 1;
                let counts = per_file.entry(file).or_default();
                match outcome.summary.as_str() {
                    "CaughtMutant" => counts.caught += 1,
                    "MissedMutant" => counts.missed += 1,
                    "Timeout" => counts.timeout += 1,
                    "Unviable" => counts.unviable += 1,
                    _ => return err("a mutant has an outcome other than caught, missed, timeout or unviable"),
                }
                let work = seconds("Build") + seconds("Test");
                if work > 0.0 {
                    mutant_seconds.push(work);
                }
            }
        }
    }

    let total = {
        let mut total = Counts::default();
        for counts in per_file.values() {
            total += *counts;
        }
        total
    };
    if raw.total_mutants != mutants
        || raw.caught != total.caught
        || raw.missed != total.missed
        || raw.timeout != total.timeout
        || raw.unviable != total.unviable
    {
        return err("the totals in outcomes.json don't agree with its outcomes (the run was cut short, or the format changed)");
    }
    Ok(Outcomes { tool_version: raw.cargo_mutants_version, per_file, baseline, mutant_seconds })
}

/// `Ok(None)` for the baseline, `Ok(Some(file))` for a mutant, an error for any other scenario.
fn scenario_file(scenario: &Value) -> Result<Option<String>, OutcomesError> {
    match scenario {
        Value::String(name) if name == "Baseline" => Ok(None),
        Value::Object(map) if map.len() == 1 => match map.get("Mutant").and_then(|m| m.get("file")).and_then(Value::as_str) {
            Some(file) => Ok(Some(file.to_string())),
            None => err("a mutant scenario has no file"),
        },
        _ => err("an outcome has a scenario that is neither the baseline nor a mutant"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mutant(file: &str, summary: &str, build: f64, test: f64) -> String {
        format!(
            r#"{{"scenario":{{"Mutant":{{"name":"{file}:1:1: replace f with ()","package":"p","file":"{file}","function":null,"span":{{"start":{{"line":1,"column":1}},"end":{{"line":1,"column":2}}}},"replacement":"()","genre":"FnValue"}}}},"summary":"{summary}","log_path":"log/x.log","diff_path":"diff/x.diff","phase_results":[{{"phase":"Build","duration":{build},"process_status":"Success","argv":["cargo"]}},{{"phase":"Test","duration":{test},"process_status":"Success","argv":["cargo"]}}]}}"#
        )
    }

    fn baseline(summary: &str) -> String {
        format!(
            r#"{{"scenario":"Baseline","summary":"{summary}","log_path":"log/baseline.log","diff_path":null,"phase_results":[{{"phase":"Build","duration":90.5,"process_status":"Success","argv":["cargo"]}},{{"phase":"Test","duration":30.0,"process_status":"Success","argv":["cargo"]}}]}}"#
        )
    }

    fn file(outcomes: &[String], caught: usize, missed: usize, timeout: usize, unviable: usize) -> String {
        let total = caught + missed + timeout + unviable;
        format!(
            r#"{{"outcomes":[{}],"total_mutants":{total},"missed":{missed},"caught":{caught},"timeout":{timeout},"unviable":{unviable},"success":0,"start_time":"2026-10-09T00:00:00Z","end_time":"2026-10-09T00:10:00Z","cargo_mutants_version":"27.1.0"}}"#,
            outcomes.join(",")
        )
    }

    fn sample() -> String {
        file(
            &[
                baseline("Success"),
                mutant("src/a.rs", "CaughtMutant", 5.0, 15.0),
                mutant("src/a.rs", "MissedMutant", 5.0, 20.0),
                mutant("src/a.rs", "Timeout", 5.0, 60.0),
                mutant("src/b.rs", "Unviable", 4.0, 0.0),
                mutant("src/b.rs", "CaughtMutant", 5.0, 12.0),
            ],
            2,
            1,
            1,
            1,
        )
    }

    #[test]
    fn counts_each_outcome_by_file() {
        let outcomes = parse(&sample()).unwrap();
        assert_eq!(outcomes.tool_version, "27.1.0");
        assert_eq!(outcomes.per_file["src/a.rs"], Counts { caught: 1, missed: 1, timeout: 1, unviable: 0, ignored: 0 });
        assert_eq!(outcomes.per_file["src/b.rs"], Counts { caught: 1, missed: 0, timeout: 0, unviable: 1, ignored: 0 });
        assert_eq!(outcomes.total().total(), 5);
    }

    #[test]
    fn the_baseline_is_kept_apart_from_the_mutants() {
        let outcomes = parse(&sample()).unwrap();
        assert_eq!(outcomes.baseline, Some(Baseline { succeeded: true, build_seconds: 90.5, test_seconds: 30.0 }));
        assert_eq!(outcomes.per_file.len(), 2);
    }

    #[test]
    fn the_seconds_of_a_mutant_are_its_build_and_test() {
        let outcomes = parse(&sample()).unwrap();
        assert_eq!(outcomes.mutant_seconds, vec![20.0, 25.0, 65.0, 4.0, 17.0]);
    }

    #[test]
    fn a_failed_baseline_is_recorded_not_hidden() {
        let text = file(&[baseline("Failure")], 0, 0, 0, 0);
        let outcomes = parse(&text).unwrap();
        assert_eq!(outcomes.baseline.map(|b| b.succeeded), Some(false));
        assert!(outcomes.per_file.is_empty());
    }

    #[test]
    fn a_run_with_no_baseline_outcome_has_none() {
        let outcomes = parse(&file(&[mutant("src/a.rs", "CaughtMutant", 1.0, 1.0)], 1, 0, 0, 0)).unwrap();
        assert_eq!(outcomes.baseline, None);
    }

    #[test]
    fn a_malformed_file_is_an_error_and_never_an_empty_result() {
        assert!(parse("").is_err());
        assert!(parse("not json").is_err());
        assert!(parse("{}").is_err());
        assert!(parse(r#"{"outcomes":"x"}"#).is_err());
        assert!(parse("[]").is_err());
    }

    #[test]
    fn a_file_cut_short_fails_the_totals_check() {
        // The header says 5 mutants but the file carries 3 outcomes, as when a killed job's file was copied mid-write.
        let text = file(&[mutant("src/a.rs", "CaughtMutant", 1.0, 1.0)], 3, 1, 1, 0);
        let error = parse(&text).unwrap_err();
        assert!(error.0.contains("totals"), "{error}");
    }

    #[test]
    fn totals_that_disagree_with_any_one_outcome_kind_fail() {
        let one = mutant("src/a.rs", "CaughtMutant", 1.0, 1.0);
        // Same total of 1, but the header calls it a miss.
        assert!(parse(&file(std::slice::from_ref(&one), 0, 1, 0, 0)).is_err());
        assert!(parse(&file(std::slice::from_ref(&one), 0, 0, 1, 0)).is_err());
        assert!(parse(&file(std::slice::from_ref(&one), 0, 0, 0, 1)).is_err());
        assert!(parse(&file(&[one], 1, 0, 0, 0)).is_ok());
    }

    #[test]
    fn an_outcome_the_score_has_no_rule_for_is_refused() {
        for summary in ["Success", "Failure", "SomethingNew"] {
            let text = file(&[mutant("src/a.rs", summary, 1.0, 1.0)], 0, 0, 0, 0);
            assert!(parse(&text).is_err(), "{summary}");
        }
    }

    #[test]
    fn a_scenario_that_is_neither_baseline_nor_mutant_is_refused() {
        let odd = r#"{"scenario":"Freshen","summary":"Success","phase_results":[]}"#.to_string();
        assert!(parse(&file(&[odd], 0, 0, 0, 0)).is_err());
        let no_file = r#"{"scenario":{"Mutant":{"name":"x"}},"summary":"CaughtMutant","phase_results":[]}"#.to_string();
        assert!(parse(&file(&[no_file], 1, 0, 0, 0)).is_err());
    }

    #[test]
    fn the_error_names_the_problem_and_not_a_value() {
        let secret = mutant("src/very_secret_name.rs", "Bogus", 1.0, 1.0);
        let error = parse(&file(&[secret], 0, 0, 0, 0)).unwrap_err();
        assert!(!error.0.contains("very_secret_name"), "{error}");
    }
}
