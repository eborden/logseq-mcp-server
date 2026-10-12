//! The character budget of a tool result (#485, ADR-0011, BR-0006): the count caps bound what a tool
//! returns in items, and this bounds it in characters, because a host refuses to show a result that is too
//! long and the call then costs tokens and returns nothing usable.
//!
//! It is applied after the count caps, to the text the tool would send (the serialized JSON, or the Markdown
//! with its footer), and makes no LogSeq call. A result that fits is untouched, byte for byte. A result that
//! doesn't is cut from the tail of the tool's main list, whole entries only, and says so with a
//! `result_size_truncated` warning ([`crate::truncation::size_truncation_warning`]).
//!
//! An entry is never cut inside its text (BR-0007). When even the first entry alone is over the budget it is
//! returned alone, and the warning says so.
//!
//! A tool calls [`fit`] with how many entries it has and a closure that says how long the result is with its
//! first `k` entries (and, for `k` below the total, with the warning). The size is not linear in `k`, so
//! the cut is found by bisection instead of by dropping one entry at a time.

/// The most characters a cut tool result holds. The failures that prompted it started at about 50,000
/// characters (the host's threshold, `references/context-efficiency.md` in the skill, section 7), and this
/// leaves room for the host's own framing and for several results in one turn. There is no parameter to
/// raise it (#485).
pub const BUDGET_CHARS: usize = 30_000;

/// The code of the warning a cut carries.
pub const SIZE_TRUNCATED_CODE: &str = "result_size_truncated";

/// How long a text is, in characters (not bytes: the host counts characters).
pub fn size(text: &str) -> usize {
    text.chars().count()
}

/// What [`fit`] decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fit {
    /// The result fits as it is, or has too few entries to cut: send it untouched, with no warning.
    Whole,
    /// Keep the first `kept` entries and add the warning. `oversize` is true when even the first `min_kept`
    /// entries, the least a cut keeps, are over the budget. That can be those entries alone, or the rest of the
    /// result around them (the page, the properties, the warnings); the cut can't tell which, so the warning says
    /// neither. Entries are returned whole either way.
    Cut { kept: usize, oversize: bool },
}

/// Decides how many of `total` entries to keep so the result fits [`BUDGET_CHARS`].
///
/// `min_kept` is the fewest a cut keeps (1 for a list whose first entry is the answer, which is returned
/// alone however large it is). `size_of(k)` is the length of the result holding the first `k` entries,
/// including the warning for any `k` below `total`; `size_of(total)` is the untouched result.
///
/// The result's length is taken to grow with `k`, so the largest `k` that fits is found by bisection:
/// `O(log total)` calls of `size_of`.
pub fn fit(total: usize, min_kept: usize, size_of: impl Fn(usize) -> usize) -> Fit {
    if total <= min_kept || size_of(total) <= BUDGET_CHARS {
        return Fit::Whole;
    }
    if size_of(min_kept) > BUDGET_CHARS {
        return Fit::Cut { kept: min_kept, oversize: true };
    }
    // `low` fits and `high` doesn't, so the answer lies in [low, high)
    let (mut low, mut high) = (min_kept, total);
    while high - low > 1 {
        let middle = low + (high - low) / 2;
        if size_of(middle) <= BUDGET_CHARS {
            low = middle;
        } else {
            high = middle;
        }
    }
    Fit::Cut { kept: low, oversize: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A result of `k` entries of `each` characters, plus `fixed` characters of frame, and a 200-character
    /// warning when some were cut (`k` below `total`).
    fn sized(total: usize, each: usize, fixed: usize) -> impl Fn(usize) -> usize {
        move |k| fixed + k * each + if k < total { 200 } else { 0 }
    }

    #[test]
    fn size_counts_characters_not_bytes() {
        assert_eq!(size("abc"), 3);
        assert_eq!(size("héllo ✓"), 7);
    }

    #[test]
    fn an_empty_result_and_one_entry_are_never_cut() {
        assert_eq!(fit(0, 1, |_| 10 * BUDGET_CHARS), Fit::Whole);
        // a single entry larger than the budget is returned alone, uncut (BR-0007)
        assert_eq!(fit(1, 1, |_| 10 * BUDGET_CHARS), Fit::Whole);
    }

    #[test]
    fn a_result_under_the_budget_is_untouched() {
        assert_eq!(fit(10, 1, sized(10, 100, 500)), Fit::Whole);
    }

    #[test]
    fn a_result_exactly_at_the_budget_is_untouched_and_one_over_is_cut() {
        // 100 entries of 295 characters and a 500-character frame: exactly 30,000
        assert_eq!(fit(100, 1, sized(100, 295, 500)), Fit::Whole);
        // one character over loses entries
        let over = |k: usize| 500 + k * 295 + usize::from(k == 100);
        assert_eq!(over(100), BUDGET_CHARS + 1);
        assert!(matches!(fit(100, 1, over), Fit::Cut { oversize: false, .. }));
    }

    #[test]
    fn a_cut_keeps_the_most_entries_that_fit_with_the_warning() {
        // 200 entries of 300 characters, 500 of frame, 200 of warning: k * 300 + 700 <= 30,000 gives 97
        let size_of = sized(200, 300, 500);
        let Fit::Cut { kept, oversize } = fit(200, 1, &size_of) else { panic!("should cut") };
        assert_eq!((kept, oversize), (97, false));
        assert!(size_of(kept) <= BUDGET_CHARS);
        assert!(size_of(kept + 1) > BUDGET_CHARS);
    }

    #[test]
    fn a_first_entry_over_the_budget_is_kept_alone_and_the_cut_says_so() {
        let size_of = |k: usize| 40_000 * k;
        assert_eq!(fit(5, 1, size_of), Fit::Cut { kept: 1, oversize: true });
    }

    #[test]
    fn the_least_a_cut_keeps_is_the_callers_choice() {
        // 3 of 10 fit, but a list that must keep 4 keeps 4 and says it is over
        let size_of = |k: usize| 9_000 * k;
        assert_eq!(fit(10, 1, size_of), Fit::Cut { kept: 3, oversize: false });
        assert_eq!(fit(10, 4, size_of), Fit::Cut { kept: 4, oversize: true });
    }

    #[test]
    fn the_cut_costs_a_logarithmic_number_of_renders() {
        let calls = std::cell::Cell::new(0usize);
        let size_of = |k: usize| {
            calls.set(calls.get() + 1);
            k * 100
        };
        assert_eq!(fit(1000, 1, size_of), Fit::Cut { kept: 300, oversize: false });
        assert!(calls.get() <= 16, "{} renders", calls.get());
    }
}
