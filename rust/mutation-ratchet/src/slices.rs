//! Split a full run into slices of whole files, balanced by mutant count (ADR-0033 "Slices").
//!
//! A slice is a set of files, never part of a file, so a file's score is always from one job. The split is deterministic:
//! the same counts always give the same slices, so a night's slice can be named by its index.

use std::collections::BTreeMap;

/// `count` slices of the files in `mutants_by_file`. Heaviest files first, each onto the lightest slice so far (the lowest
/// index on a tie), so slices differ by at most the largest file. Files inside a slice are sorted by path. A file with no
/// mutants is left out: there is nothing to run for it.
pub fn slice_files(mutants_by_file: &BTreeMap<String, usize>, count: usize) -> Vec<Vec<String>> {
    let count = count.max(1);
    let mut files: Vec<(&String, usize)> = mutants_by_file.iter().filter(|(_, n)| **n > 0).map(|(f, n)| (f, *n)).collect();
    files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let mut slices: Vec<(usize, Vec<String>)> = vec![(0, Vec::new()); count];
    for (file, n) in files {
        let lightest = (0..count).min_by_key(|&i| (slices[i].0, i)).unwrap_or(0);
        slices[lightest].0 += n;
        slices[lightest].1.push(file.clone());
    }
    slices
        .into_iter()
        .map(|(_, mut files)| {
            files.sort();
            files
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(items: &[(&str, usize)]) -> BTreeMap<String, usize> {
        items.iter().map(|(f, n)| (f.to_string(), *n)).collect()
    }

    fn total(slice: &[String], by_file: &BTreeMap<String, usize>) -> usize {
        slice.iter().map(|f| by_file[f]).sum()
    }

    #[test]
    fn one_slice_holds_every_file_with_mutants() {
        let by_file = counts(&[("src/b.rs", 3), ("src/a.rs", 5), ("src/empty.rs", 0)]);
        assert_eq!(slice_files(&by_file, 1), vec![vec!["src/a.rs".to_string(), "src/b.rs".to_string()]]);
    }

    #[test]
    fn a_count_of_zero_is_one_slice() {
        assert_eq!(slice_files(&counts(&[("src/a.rs", 1)]), 0).len(), 1);
    }

    #[test]
    fn slices_are_balanced_by_mutant_count() {
        let by_file = counts(&[("src/a.rs", 10), ("src/b.rs", 9), ("src/c.rs", 6), ("src/d.rs", 5), ("src/e.rs", 4), ("src/f.rs", 2)]);
        let slices = slice_files(&by_file, 3);
        let totals: Vec<usize> = slices.iter().map(|s| total(s, &by_file)).collect();
        assert_eq!(totals.iter().sum::<usize>(), 36);
        assert!(totals.iter().max().unwrap() - totals.iter().min().unwrap() <= 2, "{totals:?}");
        assert_eq!(totals, vec![12, 13, 11]);
    }

    #[test]
    fn every_file_is_in_exactly_one_slice() {
        let by_file = counts(&[("src/a.rs", 7), ("src/b.rs", 1), ("src/c.rs", 3), ("src/d.rs", 3), ("src/e.rs", 9)]);
        let mut all: Vec<String> = slice_files(&by_file, 4).into_iter().flatten().collect();
        all.sort();
        assert_eq!(all, by_file.keys().cloned().collect::<Vec<_>>());
    }

    #[test]
    fn the_split_is_the_same_every_time_and_ties_go_to_the_lower_index() {
        let by_file = counts(&[("src/a.rs", 4), ("src/b.rs", 4), ("src/c.rs", 4)]);
        let first = slice_files(&by_file, 2);
        assert_eq!(first, slice_files(&by_file, 2));
        assert_eq!(first, vec![vec!["src/a.rs".to_string(), "src/c.rs".to_string()], vec!["src/b.rs".to_string()]]);
    }

    #[test]
    fn more_slices_than_files_leaves_some_empty() {
        let slices = slice_files(&counts(&[("src/a.rs", 2)]), 3);
        assert_eq!(slices.len(), 3);
        assert_eq!(slices.iter().filter(|s| s.is_empty()).count(), 2);
    }
}
