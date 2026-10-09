//! The numbers a measurement run reports (#364 PR 1): how long the baseline took, how long a mutant takes, how many were
//! unviable, how long the run took. Counts and seconds only, never a name from the code or a graph (BR-0001).

use crate::outcomes::Outcomes;
use crate::score::{Counts, show};

/// Nearest-rank percentile of already sorted values, `p` in 0 to 1. `None` for no values.
pub fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (p * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

/// One table row for a run: `label | mutants | outcomes | baseline | seconds per mutant | wall`.
pub fn row(label: &str, outcomes: &Outcomes, wall_seconds: Option<f64>) -> String {
    let counts: Counts = outcomes.total();
    let baseline = match outcomes.baseline {
        Some(b) => format!("build {:.0} s, test {:.0} s", b.build_seconds, b.test_seconds),
        None => "none".to_string(),
    };
    let mut sorted = outcomes.mutant_seconds.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let per_mutant = if sorted.is_empty() {
        "-".to_string()
    } else {
        let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;
        format!(
            "mean {mean:.1}, median {:.1}, p90 {:.1}, max {:.1}",
            percentile(&sorted, 0.5).unwrap_or(0.0),
            percentile(&sorted, 0.9).unwrap_or(0.0),
            sorted[sorted.len() - 1]
        )
    };
    let wall = wall_seconds.map_or("-".to_string(), |s| format!("{s:.0} s"));
    format!(
        "| {label} | {} | {} caught, {} missed, {} timeout, {} unviable ({}) | {baseline} | {per_mutant} | {wall} |",
        counts.total(),
        counts.caught,
        counts.missed,
        counts.timeout,
        counts.unviable,
        show(counts.unviable_share()),
    )
}

pub const HEADER: &str = "| Run | Mutants | Outcomes | Baseline | Seconds per mutant (build and test) | Wall |\n|---|---|---|---|---|---|";

/// The mutants per file group of a run, as counts only: how many files hold how many mutants. For the measurement's "mutant
/// count per file and in total" without naming a file.
pub fn size_summary(outcomes: &Outcomes) -> String {
    let mut sizes: Vec<usize> = outcomes.per_file.values().map(Counts::total).collect();
    sizes.sort_unstable();
    let files = sizes.len();
    let total: usize = sizes.iter().sum();
    let bucket = |lo: usize, hi: usize| sizes.iter().filter(|n| **n >= lo && **n <= hi).count();
    format!(
        "{total} mutants in {files} files. Mutants per file: median {}, largest {}. Files with 1-5: {}, 6-20: {}, 21-50: {}, 51-100: {}, over 100: {}.",
        sizes.get(files / 2).copied().unwrap_or(0),
        sizes.last().copied().unwrap_or(0),
        bucket(1, 5),
        bucket(6, 20),
        bucket(21, 50),
        bucket(51, 100),
        bucket(101, usize::MAX),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::outcomes::Baseline;

    fn outcomes(per_file: &[(&str, Counts)], seconds: &[f64]) -> Outcomes {
        Outcomes {
            tool_version: "27.1.0".into(),
            per_file: per_file.iter().map(|(f, c)| (f.to_string(), *c)).collect::<BTreeMap<_, _>>(),
            baseline: Some(Baseline { succeeded: true, build_seconds: 61.4, test_seconds: 29.6 }),
            mutant_seconds: seconds.to_vec(),
        }
    }

    fn counts(caught: usize, missed: usize, timeout: usize, unviable: usize) -> Counts {
        Counts { caught, missed, timeout, unviable, ignored: 0 }
    }

    #[test]
    fn percentiles_are_nearest_rank() {
        let values = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        assert_eq!(percentile(&values, 0.5), Some(5.0));
        assert_eq!(percentile(&values, 0.9), Some(9.0));
        assert_eq!(percentile(&values, 1.0), Some(10.0));
        assert_eq!(percentile(&values, 0.0), Some(1.0));
        assert_eq!(percentile(&[], 0.5), None);
        assert_eq!(percentile(&[7.0], 0.9), Some(7.0));
    }

    #[test]
    fn a_row_has_the_counts_the_baseline_and_the_seconds_per_mutant() {
        let o = outcomes(&[("src/a.rs", counts(6, 2, 1, 1)), ("src/b.rs", counts(0, 0, 0, 0))], &[10.0, 20.0, 30.0, 40.0]);
        let row = row("j2", &o, Some(125.4));
        assert_eq!(
            row,
            "| j2 | 10 | 6 caught, 2 missed, 1 timeout, 1 unviable (10.0%) | build 61 s, test 30 s | mean 25.0, median 20.0, p90 40.0, max 40.0 | 125 s |"
        );
    }

    #[test]
    fn a_row_with_nothing_to_show_says_so() {
        let mut o = outcomes(&[], &[]);
        o.baseline = None;
        let row = row("empty", &o, None);
        assert!(row.contains("| 0 | 0 caught") && row.contains("| none | - | - |"), "{row}");
    }

    #[test]
    fn the_size_summary_gives_counts_and_buckets_but_no_file_name() {
        let o = outcomes(&[("src/secret_name.rs", counts(60, 0, 0, 0)), ("src/b.rs", counts(3, 0, 0, 0)), ("src/c.rs", counts(10, 0, 0, 0))], &[]);
        let text = size_summary(&o);
        assert_eq!(
            text,
            "73 mutants in 3 files. Mutants per file: median 10, largest 60. Files with 1-5: 1, 6-20: 1, 21-50: 0, 51-100: 1, over 100: 0."
        );
        assert!(!text.contains("secret_name"));
    }

    #[test]
    fn the_header_has_one_column_per_row_field() {
        let columns = HEADER.lines().next().unwrap().matches('|').count();
        let o = outcomes(&[("src/a.rs", counts(1, 0, 0, 0))], &[1.0]);
        assert_eq!(row("x", &o, Some(1.0)).matches('|').count(), columns);
    }
}
