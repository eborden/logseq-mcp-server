//! The score of a file or of a set of mutants (ADR-0033 "Tool and scope").
//!
//! Caught and timed-out mutants over caught, timed-out and missed ones. A timeout counts as caught, as in ADR-0026
//! (the tool times a mutant out at 5 times the baseline test time, 20 s at least). An unviable mutant, which doesn't
//! compile, counts for nothing. An ignored mutant (one an `exclude_re` entry removes) is never run, so it is in neither the
//! numerator nor the denominator. `ignored` is carried so the baseline's `ignores` count has a home and a test says it
//! changes no score.

use std::ops::AddAssign;

/// Outcome counts for a set of mutants.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub caught: usize,
    pub missed: usize,
    pub timeout: usize,
    pub unviable: usize,
    /// Removed by an `exclude_re` entry: never run, so in neither side of the score.
    pub ignored: usize,
}

impl AddAssign for Counts {
    fn add_assign(&mut self, other: Counts) {
        self.caught += other.caught;
        self.missed += other.missed;
        self.timeout += other.timeout;
        self.unviable += other.unviable;
        self.ignored += other.ignored;
    }
}

impl Counts {
    /// Every mutant the tool tried, whatever happened to it. Ignored ones were not tried.
    pub fn total(&self) -> usize {
        self.caught + self.missed + self.timeout + self.unviable
    }

    /// The mutants that say something about the tests: a viable mutant either failed a test (caught, timed out) or didn't.
    pub fn measured(&self) -> usize {
        self.caught + self.missed + self.timeout
    }

    /// Percent, or `None` when no mutant was measured (an empty file, or only unviable mutants), so a score of 0 or 100 is
    /// never made up for nothing.
    pub fn score(&self) -> Option<f64> {
        let measured = self.measured();
        if measured == 0 {
            return None;
        }
        Some(100.0 * (self.caught + self.timeout) as f64 / measured as f64)
    }

    /// The share of the tried mutants that didn't compile, in percent. `None` when none were tried.
    pub fn unviable_share(&self) -> Option<f64> {
        (self.total() > 0).then(|| 100.0 * self.unviable as f64 / self.total() as f64)
    }
}

/// A score as one decimal place, or a dash for none.
pub fn show(score: Option<f64>) -> String {
    match score {
        Some(value) => format!("{value:.1}%"),
        None => "-".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(caught: usize, missed: usize, timeout: usize, unviable: usize) -> Counts {
        Counts { caught, missed, timeout, unviable, ignored: 0 }
    }

    #[test]
    fn a_score_is_caught_over_caught_and_missed() {
        assert_eq!(counts(9, 1, 0, 0).score(), Some(90.0));
        assert_eq!(counts(0, 4, 0, 0).score(), Some(0.0));
        assert_eq!(counts(4, 0, 0, 0).score(), Some(100.0));
    }

    #[test]
    fn a_timeout_counts_as_caught() {
        assert_eq!(counts(2, 1, 1, 0).score(), Some(75.0));
        assert_eq!(counts(0, 0, 3, 0).score(), Some(100.0));
        assert_eq!(counts(2, 1, 1, 0).score(), counts(3, 1, 0, 0).score());
    }

    #[test]
    fn an_unviable_mutant_counts_for_nothing() {
        assert_eq!(counts(3, 1, 0, 0).score(), counts(3, 1, 0, 500).score());
        assert_eq!(counts(0, 0, 0, 7).score(), None);
    }

    #[test]
    fn an_ignored_mutant_is_out_of_both_sides() {
        let plain = counts(3, 1, 0, 0);
        let with_ignores = Counts { ignored: 40, ..plain };
        assert_eq!(with_ignores.score(), plain.score());
        assert_eq!(with_ignores.total(), plain.total());
        assert_eq!(Counts { ignored: 5, ..counts(0, 0, 0, 0) }.score(), None);
    }

    #[test]
    fn nothing_measured_is_no_score_not_zero_or_a_hundred() {
        assert_eq!(counts(0, 0, 0, 0).score(), None);
        assert_eq!(show(None), "-");
    }

    #[test]
    fn counts_add_up_and_the_unviable_share_is_of_everything_tried() {
        let mut total = counts(1, 2, 3, 4);
        total += Counts { ignored: 7, ..counts(10, 20, 30, 40) };
        assert_eq!(total, Counts { ignored: 7, ..counts(11, 22, 33, 44) });
        assert_eq!(total.total(), 110);
        assert_eq!(total.measured(), 66);
        assert_eq!(counts(1, 0, 0, 1).unviable_share(), Some(50.0));
        assert_eq!(counts(0, 0, 0, 0).unviable_share(), None);
    }

    #[test]
    fn a_score_shows_one_decimal() {
        assert_eq!(show(Some(91.25)), "91.2%");
        assert_eq!(show(Some(100.0)), "100.0%");
    }
}
