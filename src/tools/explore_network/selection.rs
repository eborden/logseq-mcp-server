//! Which of a depth's new pages join the network. The caps keep a hub page usable: `max_fanout` limits what
//! one page may add, `max_nodes` what the whole network may hold, and the choice never depends on
//! the order the query's rows came in.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// A page that links more than this many pages is a roll-up, like the weekly or monthly summary pages a graph
/// generates: it behaves like a journal, linking to almost everything, so it comes last and is not walked through
/// (#498). A count of distinct pages, not blocks: a page with a hundred blocks that link five pages is not one.
///
/// Measured on the hub fixture (`tests/fixtures/README.md`, "Roll-up pages"): its ordinary pages link up to 5
/// pages, its hub 70. 30 is twice the default `max_fanout` (15), so a page over it could fill two fanouts by itself.
pub const HUB_LINKS: i64 = 30;

/// A page seen at this depth that isn't in the network yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: i64,
    pub name: String,
    pub is_journal: bool,
    /// The pages this page links (0 when the walk did not ask or the page links none). Journals are leaves already,
    /// so only another page can be a roll-up
    pub links: i64,
    /// Reference count per frontier page this candidate is linked to
    pub by_source: HashMap<i64, i64>,
    /// The sum of `by_source`
    pub total: i64,
}

impl Candidate {
    /// A page that links more than [`HUB_LINKS`] pages, and is not a journal.
    pub fn is_hub(&self) -> bool {
        !self.is_journal && self.links > HUB_LINKS
    }

    /// A journal or a roll-up: it ranks after every other page.
    fn is_leaf_like(&self) -> bool {
        self.is_journal || self.is_hub()
    }
}

/// What [`select_candidates`] kept and what each cap dropped.
#[derive(Debug, PartialEq, Eq)]
pub struct Selection {
    /// In rank order
    pub admitted: Vec<Candidate>,
    /// Pages no frontier page had room for under `max_fanout`
    pub dropped_by_fanout: usize,
    /// Pages the node budget could not hold
    pub dropped_by_budget: usize,
}

/// The order of candidates: pages that are neither a journal nor a roll-up
/// first, then the higher score, then the lower id.
fn rank(score: impl Fn(&Candidate) -> i64) -> impl Fn(&Candidate, &Candidate) -> Ordering {
    move |a, b| {
        a.is_leaf_like()
            .cmp(&b.is_leaf_like())
            .then_with(|| score(b).cmp(&score(a)))
            .then_with(|| a.id.cmp(&b.id))
    }
}

/// Pick which candidates join the network at this depth.
///
/// Rank: pages that are neither journals nor roll-ups first, then more references, then lower id.
/// 1. Each frontier page keeps its top `max_fanout` new neighbours (ranked by the references to that
///    page); the survivors are the union.
/// 2. If that still exceeds the remaining node budget, the best by total references are kept.
pub fn select_candidates(candidates: &HashMap<i64, Candidate>, frontier: &[i64], max_fanout: usize, budget: i64) -> Selection {
    let mut kept: HashSet<i64> = HashSet::new();
    for source in frontier {
        let mut neighbours: Vec<&Candidate> = candidates.values().filter(|c| c.by_source.contains_key(source)).collect();
        neighbours.sort_by(|a, b| rank(|c| c.by_source.get(source).copied().unwrap_or(0))(a, b));
        kept.extend(neighbours.into_iter().take(max_fanout).map(|c| c.id));
    }
    let mut admitted: Vec<Candidate> = kept.iter().map(|id| candidates[id].clone()).collect();
    admitted.sort_by(|a, b| rank(|c| c.total)(a, b));
    let room = usize::try_from(budget.max(0)).unwrap_or(usize::MAX);
    admitted.truncate(room);
    Selection {
        dropped_by_fanout: candidates.len() - kept.len(),
        dropped_by_budget: kept.len() - admitted.len(),
        admitted,
    }
}

/// How many of this depth's candidates the selection left out that no earlier depth left out too. A page cut at
/// one depth stays outside the network and can be offered again at the next, and counts once (#666).
pub fn newly_dropped(candidates: &HashMap<i64, Candidate>, selection: &Selection, already_dropped: &mut HashSet<i64>) -> usize {
    let admitted: HashSet<i64> = selection.admitted.iter().map(|c| c.id).collect();
    candidates.keys().filter(|id| !admitted.contains(id)).filter(|id| already_dropped.insert(**id)).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: i64, is_journal: bool, by_source: &[(i64, i64)]) -> Candidate {
        Candidate {
            id,
            name: format!("page {id}"),
            is_journal,
            links: 0,
            by_source: by_source.iter().copied().collect(),
            total: by_source.iter().map(|(_, count)| count).sum(),
        }
    }

    fn pool(candidates: Vec<Candidate>) -> HashMap<i64, Candidate> {
        candidates.into_iter().map(|c| (c.id, c)).collect()
    }

    fn ids(selection: &Selection) -> Vec<i64> {
        selection.admitted.iter().map(|c| c.id).collect()
    }

    #[test]
    fn non_journal_pages_come_first_then_more_references_then_the_lower_id() {
        let candidates = pool(vec![
            candidate(5, true, &[(1, 9)]),
            candidate(4, false, &[(1, 1)]),
            candidate(3, false, &[(1, 2)]),
            candidate(2, false, &[(1, 2)]),
        ]);
        let selection = select_candidates(&candidates, &[1], 10, 10);
        assert_eq!(ids(&selection), [2, 3, 4, 5]);
        assert_eq!((selection.dropped_by_fanout, selection.dropped_by_budget), (0, 0));
    }

    #[test]
    fn each_frontier_page_keeps_its_top_fanout_and_the_union_survives() {
        // page 1 links 10, 11, 12 and page 2 links 12, 13: with a fanout of 1 each keeps its best
        let candidates = pool(vec![
            candidate(10, false, &[(1, 3)]),
            candidate(11, false, &[(1, 2)]),
            candidate(12, false, &[(1, 1), (2, 5)]),
            candidate(13, false, &[(2, 1)]),
        ]);
        let selection = select_candidates(&candidates, &[1, 2], 1, 10);
        // page 1 keeps 10 (3 references), page 2 keeps 12 (5 references)
        assert_eq!(ids(&selection), [12, 10]);
        assert_eq!((selection.dropped_by_fanout, selection.dropped_by_budget), (2, 0));
    }

    #[test]
    fn a_page_cut_at_two_depths_is_counted_once() {
        let mut seen = HashSet::new();
        let first = pool(vec![candidate(10, false, &[(1, 3)]), candidate(11, false, &[(1, 1)])]);
        let selection = select_candidates(&first, &[1], 1, 10);
        assert_eq!(newly_dropped(&first, &selection, &mut seen), 1);
        // page 11 is offered again at the next depth and cut again, beside a new page 12
        let second = pool(vec![candidate(11, false, &[(2, 1)]), candidate(12, false, &[(2, 1)]), candidate(13, false, &[(2, 5)])]);
        let selection = select_candidates(&second, &[2], 1, 10);
        assert_eq!(newly_dropped(&second, &selection, &mut seen), 1);
    }

    #[test]
    fn the_budget_keeps_the_best_by_total_and_counts_what_it_dropped() {
        let candidates = pool(vec![candidate(10, false, &[(1, 1)]), candidate(11, false, &[(1, 4)]), candidate(12, false, &[(1, 2)])]);
        let selection = select_candidates(&candidates, &[1], 10, 2);
        assert_eq!(ids(&selection), [11, 12]);
        assert_eq!((selection.dropped_by_fanout, selection.dropped_by_budget), (0, 1));
    }

    #[test]
    fn a_budget_of_zero_or_less_admits_nothing() {
        let candidates = pool(vec![candidate(10, false, &[(1, 1)])]);
        for budget in [0, -3] {
            let selection = select_candidates(&candidates, &[1], 10, budget);
            assert!(selection.admitted.is_empty());
            assert_eq!(selection.dropped_by_budget, 1);
        }
    }

    fn linking(links: i64, mut candidate: Candidate) -> Candidate {
        candidate.links = links;
        candidate
    }

    #[test]
    fn a_page_is_a_roll_up_when_it_links_more_pages_than_the_threshold_and_is_not_a_journal() {
        // under, at and over the threshold
        assert!(!linking(HUB_LINKS - 1, candidate(1, false, &[(9, 1)])).is_hub());
        assert!(!linking(HUB_LINKS, candidate(1, false, &[(9, 1)])).is_hub());
        assert!(linking(HUB_LINKS + 1, candidate(1, false, &[(9, 1)])).is_hub());
        // a journal is a leaf already, and is never counted as a roll-up
        assert!(!linking(HUB_LINKS + 1, candidate(1, true, &[(9, 1)])).is_hub());
    }

    #[test]
    fn a_roll_up_ranks_after_every_page_that_is_not_one_whatever_its_count() {
        let candidates = pool(vec![
            linking(HUB_LINKS + 1, candidate(1, false, &[(9, 100)])),
            candidate(2, false, &[(9, 1)]),
            linking(HUB_LINKS, candidate(3, false, &[(9, 1)])),
        ]);
        assert_eq!(ids(&select_candidates(&candidates, &[9], 10, 10)), [2, 3, 1]);
        // and it is the first to go when a cap bites
        let kept = select_candidates(&candidates, &[9], 2, 10);
        assert_eq!(ids(&kept), [2, 3]);
        assert_eq!((kept.dropped_by_fanout, kept.dropped_by_budget), (1, 0));
        let kept = select_candidates(&candidates, &[9], 10, 2);
        assert_eq!(ids(&kept), [2, 3]);
        assert_eq!((kept.dropped_by_fanout, kept.dropped_by_budget), (0, 1));
    }

    #[test]
    fn a_roll_up_and_a_journal_rank_together_by_count_then_id() {
        let candidates = pool(vec![
            candidate(1, true, &[(9, 1)]),
            linking(HUB_LINKS + 1, candidate(2, false, &[(9, 5)])),
            candidate(3, false, &[(9, 1)]),
        ]);
        assert_eq!(ids(&select_candidates(&candidates, &[9], 10, 10)), [3, 2, 1]);
    }

    #[test]
    fn a_journal_ranks_below_every_other_page_whatever_its_count() {
        let candidates = pool(vec![candidate(1, true, &[(9, 100)]), candidate(2, false, &[(9, 1)])]);
        assert_eq!(ids(&select_candidates(&candidates, &[9], 1, 10)), [2]);
    }
}
