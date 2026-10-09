//! What `cargo mutants`' exit code means for a job (ADR-0033, and the tool's book, `exit-codes.md`).
//!
//! 0 means every viable mutant was caught, 2 that some were missed and 3 that some timed out. None of those is a broken run:
//! a missed mutant is a number for the ratchet to read, not a failure of the job. The rest mean the run didn't measure what
//! it was asked to, so the job fails: 1 usage, 4 the unmutated tests already fail, 5 the `--in-diff` diff doesn't match the
//! tree, 6 it isn't a diff, 70 an internal error. A code the book doesn't list, or none at all (a signal), fails too: a
//! guess about an unknown outcome would decide a gate.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    /// 0: every viable mutant was caught.
    Clean,
    /// 2: some mutant was missed.
    Missed,
    /// 3: some mutant timed out.
    TimedOut,
    /// Anything else: the job fails, with this explanation.
    Broken(&'static str),
}

/// `None` is a process that ended without an exit code (killed by a signal).
pub fn classify(code: Option<i32>) -> Exit {
    match code {
        Some(0) => Exit::Clean,
        Some(2) => Exit::Missed,
        Some(3) => Exit::TimedOut,
        Some(1) => Exit::Broken("usage error: bad cargo-mutants arguments"),
        Some(4) => Exit::Broken("the unmutated tests already fail, so no mutant was tested"),
        Some(5) => Exit::Broken("the --in-diff diff doesn't match the tree (is the base the merge commit's first parent?)"),
        Some(6) => Exit::Broken("the --in-diff diff isn't a valid diff"),
        Some(70) => Exit::Broken("cargo-mutants hit an internal error"),
        Some(_) => Exit::Broken("cargo-mutants exited with a code its book doesn't list"),
        None => Exit::Broken("cargo-mutants was killed before it exited"),
    }
}

impl Exit {
    pub fn fails_the_job(self) -> bool {
        matches!(self, Exit::Broken(_))
    }
}

/// The exit code a run recorded in a file (`$?`, as text), `None` for a signal, or an error when the file doesn't say.
pub fn parse_recorded(text: &str) -> Result<Option<i32>, String> {
    let text = text.trim();
    if text == "signal" {
        return Ok(None);
    }
    text.parse::<i32>()
        .map(Some)
        .map_err(|_| "the recorded exit code is neither a number nor `signal`".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_two_and_three_are_not_job_failures() {
        for code in [0, 2, 3] {
            assert!(!classify(Some(code)).fails_the_job(), "exit {code}");
        }
        assert_eq!(classify(Some(0)), Exit::Clean);
        assert_eq!(classify(Some(2)), Exit::Missed);
        assert_eq!(classify(Some(3)), Exit::TimedOut);
    }

    #[test]
    fn four_five_six_and_seventy_are_job_failures() {
        for code in [4, 5, 6, 70] {
            assert!(classify(Some(code)).fails_the_job(), "exit {code}");
        }
    }

    #[test]
    fn usage_an_unknown_code_and_a_signal_fail_too() {
        assert!(classify(Some(1)).fails_the_job());
        assert!(classify(Some(101)).fails_the_job());
        assert!(classify(Some(-1)).fails_the_job());
        assert!(classify(None).fails_the_job());
    }

    #[test]
    fn a_base_that_does_not_match_the_tree_says_to_check_the_first_parent() {
        match classify(Some(5)) {
            Exit::Broken(why) => assert!(why.contains("first parent")),
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn a_recorded_exit_code_reads_back() {
        assert_eq!(parse_recorded("2\n"), Ok(Some(2)));
        assert_eq!(parse_recorded(" 70 "), Ok(Some(70)));
        assert_eq!(parse_recorded("signal"), Ok(None));
        assert!(parse_recorded("").is_err());
        assert!(parse_recorded("two").is_err());
    }
}
