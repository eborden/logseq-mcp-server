//! `limits.env`: the constants of the mutation workflows, in one file both read (ADR-0033 "The budget", as ADR-0028 did).
//!
//! The PR job and the proof run must plan with the same budget or a proof would measure other files than the PR job left
//! out, so the constants live here and each workflow copies the lines into its environment. The arithmetic that gives
//! `MUTANT_BUDGET` is written next to it in the file, and `check` here recomputes it, so the number and its reason can't
//! drift apart. The file is `KEY=VALUE` lines and `#` comments, nothing else.

use std::collections::BTreeMap;
use std::fmt;

use crate::plan::{BudgetInputs, mutant_budget};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitsError(pub String);

impl fmt::Display for LimitsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LimitsError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The PR job's `timeout-minutes`, which the workflow repeats as a literal (a test holds the two equal).
    pub job_timeout_minutes: u64,
    /// Seconds before the first mutant: the tool's install, the dependency restore, the baseline build and test, for each of
    /// the two `cargo mutants` calls a mixed plan makes.
    pub overhead_seconds: u64,
    /// Seconds kept unused.
    pub spare_seconds: u64,
    /// The slowest measured seconds per mutant.
    pub seconds_per_mutant: u64,
    /// `--jobs`: at most 2 (ADR-0033 "Quiet by construction").
    pub mutant_jobs: u64,
    /// Mutants the PR job may take, the re-run reserve included. Must equal what the numbers above give.
    pub mutant_budget: usize,
    /// How many chained jobs a full run is split into.
    pub full_run_slices: u64,
}

pub fn parse(text: &str) -> Result<Limits, LimitsError> {
    let mut values: BTreeMap<&str, &str> = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            return Err(LimitsError("a line is neither a comment nor KEY=VALUE".into()));
        };
        if values.insert(key.trim(), value.trim()).is_some() {
            return Err(LimitsError(format!("{} is set twice", key.trim())));
        }
    }
    let number = |key: &str| -> Result<u64, LimitsError> {
        values
            .get(key)
            .ok_or_else(|| LimitsError(format!("{key} is missing")))?
            .parse::<u64>()
            .map_err(|_| LimitsError(format!("{key} is not a whole number")))
    };
    let limits = Limits {
        job_timeout_minutes: number("JOB_TIMEOUT_MINUTES")?,
        overhead_seconds: number("OVERHEAD_SECONDS")?,
        spare_seconds: number("SPARE_SECONDS")?,
        seconds_per_mutant: number("SECONDS_PER_MUTANT")?,
        mutant_jobs: number("MUTANT_JOBS")?,
        mutant_budget: number("MUTANT_BUDGET")? as usize,
        full_run_slices: number("FULL_RUN_SLICES")?,
    };
    let known = ["JOB_TIMEOUT_MINUTES", "OVERHEAD_SECONDS", "SPARE_SECONDS", "SECONDS_PER_MUTANT", "MUTANT_JOBS", "MUTANT_BUDGET", "FULL_RUN_SLICES"];
    if let Some(extra) = values.keys().find(|key| !known.contains(key)) {
        return Err(LimitsError(format!("{extra} is not a limit")));
    }
    Ok(limits)
}

impl Limits {
    /// The rules of the file: `--jobs` is 1 or 2, a slice count is at least 1, and the budget is the arithmetic of the numbers
    /// beside it.
    pub fn check(&self) -> Result<(), LimitsError> {
        if !(1..=2).contains(&self.mutant_jobs) {
            return Err(LimitsError("MUTANT_JOBS must be 1 or 2".into()));
        }
        if self.full_run_slices == 0 {
            return Err(LimitsError("FULL_RUN_SLICES must be at least 1".into()));
        }
        let computed = mutant_budget(&BudgetInputs {
            timeout_seconds: self.job_timeout_minutes * 60,
            overhead_seconds: self.overhead_seconds,
            spare_seconds: self.spare_seconds,
            seconds_per_mutant: self.seconds_per_mutant,
            jobs: self.mutant_jobs,
        });
        if computed != self.mutant_budget {
            return Err(LimitsError(format!("MUTANT_BUDGET is {} but the numbers beside it give {computed}", self.mutant_budget)));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "# a comment\nJOB_TIMEOUT_MINUTES=20\nOVERHEAD_SECONDS=300\nSPARE_SECONDS=120\nSECONDS_PER_MUTANT=20\nMUTANT_JOBS=2\nMUTANT_BUDGET=78\nFULL_RUN_SLICES=1\n";

    #[test]
    fn reads_the_limits_and_skips_comments_and_blank_lines() {
        let limits = parse(&format!("\n  \n{GOOD}")).unwrap();
        assert_eq!(limits.job_timeout_minutes, 20);
        assert_eq!(limits.mutant_budget, 78);
        assert_eq!(limits.full_run_slices, 1);
    }

    #[test]
    fn the_budget_must_be_what_the_numbers_beside_it_give() {
        parse(GOOD).unwrap().check().unwrap();
        let wrong = GOOD.replace("MUTANT_BUDGET=78", "MUTANT_BUDGET=79");
        assert!(parse(&wrong).unwrap().check().unwrap_err().0.contains("give 78"));
    }

    #[test]
    fn jobs_are_one_or_two_and_slices_at_least_one() {
        assert!(parse(&GOOD.replace("MUTANT_JOBS=2", "MUTANT_JOBS=3")).unwrap().check().is_err());
        assert!(parse(&GOOD.replace("MUTANT_JOBS=2", "MUTANT_JOBS=0")).unwrap().check().is_err());
        assert!(parse(&GOOD.replace("FULL_RUN_SLICES=1", "FULL_RUN_SLICES=0")).unwrap().check().is_err());
        // One job halves the budget: 780 * 1 / 20.
        let one = GOOD.replace("MUTANT_JOBS=2", "MUTANT_JOBS=1").replace("MUTANT_BUDGET=78", "MUTANT_BUDGET=39");
        parse(&one).unwrap().check().unwrap();
    }

    #[test]
    fn a_missing_duplicate_unknown_or_non_numeric_value_is_an_error() {
        assert!(parse(&GOOD.replace("SPARE_SECONDS=120\n", "")).is_err());
        assert!(parse(&format!("{GOOD}MUTANT_JOBS=1\n")).is_err());
        assert!(parse(&format!("{GOOD}EXTRA=1\n")).is_err());
        assert!(parse(&GOOD.replace("SPARE_SECONDS=120", "SPARE_SECONDS=two")).is_err());
        assert!(parse(&format!("{GOOD}not a line\n")).is_err());
    }
}
