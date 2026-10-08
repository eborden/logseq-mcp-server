//! fuzzysort 3.1.0's `go` with a `key`, a `limit` and the `threshold` the TypeScript server
//! passes, ported (the closest-name suggestions of `suggestPages`, `src/utils/resolve-page.ts`).
//!
//! The suggestions are part of an error message that the parity harness compares byte for byte,
//! so what matters is which three names come back, and in which order. That depends on
//! fuzzysort's scores, the order its priority queue gives equal scores, and the details of the
//! matching, so this follows the library's code step for step instead of using another fuzzy
//! matcher. Where the library has a quirk, it is kept and said:
//! - A score is a negative number, nearer 0 the better; a result is kept only if a search's
//!   characters appear in order in the target.
//! - The `threshold` is `-10000`, which `denormalizeScore` turns into `NaN` (the logarithm of a
//!   negative number), and every comparison with `NaN` is false, so it filters nothing. It's not
//!   a parameter here: nothing is filtered by score.
//! - Strings are UTF-16, as in JavaScript: indexes, lengths and scores count code units. A
//!   character outside the Basic Multilingual Plane counts twice.
//! - Accents are removed from Latin letters before matching (`é` is `e`), and a search with spaces
//!   is split into words that each have to match.
//!
//! Not ported, because `suggestPages` doesn't use it: `all`, `keys`, `highlight`, `scoreFn`,
//! partial matches and the prepared-string cache.
//!
//! The tests compare this against the library itself: `tests/data/fuzzysort-oracle.json` holds
//! what fuzzysort 3.1.0 returned for made-up names and searches, scores included.
//! `scripts/parity/fuzzysort-oracle.ts` writes that file, and `src/fuzzysort-oracle.test.ts`
//! recomputes it with the installed fuzzysort, so it can't drift from the library the TypeScript
//! server runs.

// PARITY(#299): the whole module copies fuzzysort 3.1.0's matching, scoring and result order, so
// the closest names in a "no such page" message are the same three the TypeScript server gives. A
// Rust-only server could use any matcher (and the accent stripping and UTF-16 counting below only
// exist to reproduce its scores) — drop if Rust becomes the only server.

use icu_normalizer::DecomposingNormalizer;
use icu_properties::CodePointMapData;
use icu_properties::props::Script;

use crate::js;

/// A matching target and its score.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Match {
    /// Index into the targets that were searched.
    pub index: usize,
    pub score: f64,
}

/// The best `limit` of `targets` for `search`, best first. As `fuzzysort.go(search, targets,
/// { key, limit, threshold })` returns them, with equal scores in the order its priority queue
/// leaves them. An empty target never matches, nor does an empty search.
// PARITY(#299): no score threshold, because the TypeScript call passes `threshold: -10000`, which
// fuzzysort turns into NaN and never compares true (suspected TS bug: it reads as a cutoff and
// is none) — drop if Rust becomes the only server.
pub fn go(search: &str, targets: &[&str], limit: usize) -> Vec<Match> {
    if search.is_empty() || limit == 0 {
        return Vec::new();
    }
    let search = Search::new(search);
    let mut queue = Queue::default();
    let mut kept = 0;
    for (index, text) in targets.iter().enumerate() {
        if text.is_empty() {
            continue;
        }
        let mut target = Target::new(text);
        if search.bitflags & target.bitflags != search.bitflags {
            continue;
        }
        let Some(found) = algorithm(&search.needle, &mut target, false) else { continue };
        let entry = Match { index, score: found.score };
        if kept < limit {
            queue.add(entry);
            kept += 1;
        } else if entry.score > queue.peek().score {
            queue.replace_top(entry);
        }
    }
    let mut results = vec![Match { index: 0, score: 0.0 }; kept];
    for slot in results.iter_mut().rev() {
        *slot = queue.poll();
    }
    results
}

/// What `prepareLowerInfo` makes of a string.
struct LowerInfo {
    /// The lowercased, accent-free string, as UTF-16 (`_lower`).
    lower: Vec<u16>,
    /// Its code units, as many as the accent-free string has (`lowerCodes`).
    codes: Vec<u16>,
    bitflags: u32,
    contains_space: bool,
}

/// `/\p{Script=Latin}+/gu` replaced by its NFD, then every U+0300..U+036F removed.
// PARITY(#299): fuzzysort strips accents only from Latin-script runs, and leaves the rest of
// `toLowerCase()`'s output as it is — drop if Rust becomes the only server.
fn remove_accents(text: &str) -> String {
    let script = CodePointMapData::<Script>::new();
    let nfd = DecomposingNormalizer::new_nfd();
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    for c in text.chars() {
        if script.get(c) == Script::Latin {
            run.push(c);
        } else {
            if !run.is_empty() {
                out.push_str(&nfd.normalize(&run));
                run.clear();
            }
            out.push(c);
        }
    }
    if !run.is_empty() {
        out.push_str(&nfd.normalize(&run));
    }
    out.retain(|c| !('\u{300}'..='\u{36f}').contains(&c));
    out
}

fn prepare_lower_info(text: &str) -> LowerInfo {
    let text = remove_accents(text);
    let length = text.encode_utf16().count();
    let lower = js::utf16(&text.to_lowercase());
    // `str.toLowerCase()` can be longer than `str` (U+0130); only `str.length` codes are read
    let codes: Vec<u16> = lower.iter().copied().take(length).collect();
    let mut bitflags = 0u32;
    let mut contains_space = false;
    for &code in &codes {
        if code == 32 {
            contains_space = true; // a space sets no bit: a search with one is matched word by word
            continue;
        }
        let bit = match code {
            97..=122 => u32::from(code) - 97,
            48..=57 => 26,
            0..=127 => 30,
            _ => 31,
        };
        bitflags |= 1 << bit;
    }
    LowerInfo { lower, codes, bitflags, contains_space }
}

/// A search, or one word of a search with spaces.
struct Needle {
    lower: Vec<u16>,
    codes: Vec<u16>,
    contains_space: bool,
    /// The words of a search with spaces, distinct, in order.
    words: Vec<Needle>,
}

struct Search {
    needle: Needle,
    bitflags: u32,
}

impl Search {
    fn new(search: &str) -> Search {
        let search = js::trim(search);
        let info = prepare_lower_info(search);
        let mut words = Vec::new();
        if info.contains_space {
            let mut seen: Vec<&str> = Vec::new();
            for word in search.split(js::is_js_space).filter(|word| !word.is_empty()) {
                if seen.contains(&word) {
                    continue;
                }
                seen.push(word);
                let word_info = prepare_lower_info(word);
                // `_lower` of a word is the plain lowercase, accents kept (as the library has it)
                words.push(Needle {
                    lower: js::utf16(&word.to_lowercase()),
                    codes: word_info.codes,
                    contains_space: false,
                    words: Vec::new(),
                });
            }
        }
        Search {
            bitflags: info.bitflags,
            needle: Needle { lower: info.lower, codes: info.codes, contains_space: info.contains_space, words },
        }
    }
}

struct Target {
    lower: Vec<u16>,
    codes: Vec<u16>,
    bitflags: u32,
    /// For each index, the index of the next start of a word (`_nextBeginningIndexes`).
    next: Vec<usize>,
}

impl Target {
    fn new(text: &str) -> Target {
        let info = prepare_lower_info(text);
        Target { next: next_beginning_indexes(text), lower: info.lower, codes: info.codes, bitflags: info.bitflags }
    }
}

/// `prepareBeginningIndexes`: an uppercase letter after a lowercase one, and any character
/// after or that is not a letter or digit, starts a word. Only ASCII letters and digits count
/// as such, so every other code unit starts a word.
fn beginning_indexes(units: &[u16]) -> Vec<usize> {
    let mut beginnings = Vec::new();
    let (mut was_upper, mut was_alphanumeric) = (false, false);
    for (i, &code) in units.iter().enumerate() {
        let upper = (65..=90).contains(&code);
        let alphanumeric = upper || (97..=122).contains(&code) || (48..=57).contains(&code);
        if (upper && !was_upper) || !was_alphanumeric || !alphanumeric {
            beginnings.push(i);
        }
        was_upper = upper;
        was_alphanumeric = alphanumeric;
    }
    beginnings
}

/// `prepareNextBeginningIndexes`, over the accent-free target as it was typed (not lowercased).
fn next_beginning_indexes(text: &str) -> Vec<usize> {
    let units = js::utf16(&remove_accents(text));
    let length = units.len();
    let beginnings = beginning_indexes(&units);
    let mut next = Vec::with_capacity(length);
    let mut last = beginnings.first().copied();
    let mut last_i = 0;
    for i in 0..length {
        if last.is_some_and(|beginning| beginning > i) {
            next.push(last.expect("just checked"));
        } else {
            last_i += 1;
            last = beginnings.get(last_i).copied();
            next.push(last.unwrap_or(length));
        }
    }
    next
}

struct Found {
    score: f64,
    /// The matched positions in the target, ascending.
    indexes: Vec<usize>,
}

/// `algorithm`: the best way the needle's characters appear in the target, or `None`.
fn algorithm(needle: &Needle, target: &mut Target, allow_spaces: bool) -> Option<Found> {
    if !allow_spaces && needle.contains_space {
        return algorithm_spaces(needle, target);
    }
    let search_len = needle.codes.len();
    let target_len = target.codes.len();
    if search_len == 0 || target_len == 0 {
        return None;
    }

    // The characters in order anywhere in the target, or nothing
    let mut simple: Vec<usize> = Vec::with_capacity(search_len);
    let (mut search_i, mut target_i) = (0, 0);
    loop {
        if needle.codes[search_i] == target.codes[target_i] {
            simple.push(target_i);
            search_i += 1;
            if search_i == search_len {
                break;
            }
        }
        target_i += 1;
        if target_i >= target_len {
            return None;
        }
    }

    // The same, but each at the start of a word or right after the one before ("strict")
    // `next` is as long as the target, but a string whose lowercase is longer (U+0130) has
    // fewer; an index past the end means the end, where the library would read `undefined`.
    let after = |next: &[usize], i: usize| next.get(i).copied().unwrap_or(target_len);
    let mut search_i = 0;
    let mut success_strict = false;
    let mut strict: Vec<usize> = Vec::with_capacity(search_len);
    let mut target_i = if simple[0] == 0 { 0 } else { after(&target.next, simple[0] - 1) };
    let mut backtracks = 0;
    if target_i != target_len {
        loop {
            if target_i >= target_len {
                // No good place for this character: move the one before it forward
                if search_i == 0 {
                    break;
                }
                backtracks += 1;
                if backtracks > 200 {
                    break; // exponential backtracking: give up and keep the bad match
                }
                search_i -= 1;
                let last = strict.pop().expect("a character was matched before it");
                target_i = after(&target.next, last);
            } else if needle.codes[search_i] == target.codes[target_i] {
                strict.push(target_i);
                search_i += 1;
                if search_i == search_len {
                    success_strict = true;
                    break;
                }
                target_i += 1;
            } else {
                target_i = after(&target.next, target_i);
            }
        }
    }

    // Is the search a substring of the target, and does it start a word?
    let mut substring = if search_len <= 1 { None } else { index_of(&target.lower, &needle.lower, simple[0]) };
    let is_substring = substring.is_some();
    let mut is_substring_beginning = match substring {
        None => false,
        Some(at) => at == 0 || target.next.get(at - 1) == Some(&at),
    };
    // A substring that doesn't start a word: look for one that does, for a better score
    if let (true, false, Some(found)) = (is_substring, is_substring_beginning, substring) {
        let mut i = 0;
        while i < target.next.len() {
            if i <= found {
                i = after(&target.next, i);
                continue;
            }
            if (0..search_len).all(|s| target.codes.get(i + s) == Some(&needle.codes[s])) {
                substring = Some(i);
                is_substring_beginning = true;
                break;
            }
            i = after(&target.next, i);
        }
    }

    let score_of = |matches: &[usize]| -> f64 {
        let mut score = 0.0f64;
        let mut extra_groups = 0.0f64;
        for i in 1..search_len {
            if matches[i] as isize - matches[i - 1] as isize != 1 {
                score -= matches[i] as f64;
                extra_groups += 1.0;
            }
        }
        let unmatched_distance = matches[search_len - 1] as isize - matches[0] as isize - (search_len as isize - 1);
        score -= (12 + unmatched_distance) as f64 * extra_groups; // more groups cost more
        if matches[0] != 0 {
            score -= (matches[0] * matches[0]) as f64 * 0.2; // not starting near the beginning
        }
        if !success_strict {
            score *= 1000.0;
        } else {
            // a strict match on a target with many words loses points
            let mut unique_beginnings = 1usize;
            let mut i = after(&target.next, 0);
            while i < target_len {
                unique_beginnings += 1;
                i = after(&target.next, i);
            }
            if unique_beginnings > 24 {
                score *= ((unique_beginnings - 24) * 10) as f64;
            }
        }
        let length_penalty = (target_len as f64 - search_len as f64) / 2.0; // longer targets lose points
        score -= length_penalty;
        let squared = (1 + search_len * search_len) as f64;
        if is_substring {
            score /= squared;
        }
        if is_substring_beginning {
            score /= squared;
        }
        score -= length_penalty;
        score
    };

    let from_substring = |at: usize| -> Vec<usize> { (0..search_len).map(|i| at + i).collect() };
    let matches = if !success_strict {
        match substring {
            Some(at) => from_substring(at), // a substring is a better match than the loose one
            None => simple,
        }
    } else if is_substring_beginning {
        from_substring(substring.expect("a substring beginning is a substring"))
    } else {
        strict
    };
    Some(Found { score: score_of(&matches), indexes: matches })
}

/// `algorithmSpaces`, for a search with spaces: each word has to match, in any order, and the
/// score is their average less a penalty for out-of-order words. A search that is an exact
/// substring, spaces included, scores as that when it's better.
fn algorithm_spaces(needle: &Needle, target: &mut Target) -> Option<Found> {
    let words = needle.words.len();
    if words == 0 {
        return None;
    }
    let mut score = 0.0f64;
    let mut first_seen_last = 0usize;
    let mut changes: Vec<(usize, usize)> = Vec::new();
    let mut last_indexes = Vec::new();
    let restore = |target: &mut Target, changes: &[(usize, usize)]| {
        for &(i, was) in changes.iter().rev() {
            target.next[i] = was;
        }
    };
    for (i, word) in needle.words.iter().enumerate() {
        let Some(result) = algorithm(word, target, false) else {
            restore(target, &changes);
            return None;
        };
        // A word that matched as one run makes its end a word start, so "straw berry" finds
        // "strawberry" for the words after it
        if i != words - 1 && result.indexes.windows(2).all(|pair| pair[1] - pair[0] == 1) {
            let new_beginning = result.indexes[result.indexes.len() - 1] + 1;
            let to_replace = target.next[new_beginning - 1];
            for at in (0..new_beginning).rev() {
                if to_replace != target.next[at] {
                    break;
                }
                target.next[at] = new_beginning;
                changes.push((at, to_replace));
            }
        }
        score += result.score / words as f64;
        // points off for words out of order
        if result.indexes[0] < first_seen_last {
            score -= ((first_seen_last - result.indexes[0]) * 2) as f64;
        }
        first_seen_last = result.indexes[0];
        last_indexes = result.indexes;
    }
    restore(target, &changes);

    if let Some(whole) = algorithm(needle, target, true) {
        if whole.score > score {
            return Some(whole);
        }
    }
    Some(Found { score, indexes: last_indexes })
}

/// `haystack.indexOf(needle, from)` over UTF-16.
fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(haystack.len()));
    }
    if needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&at| &haystack[at..at + needle.len()] == needle)
}

/// fuzzysort's priority queue: a hacked FastPriorityQueue, a min-heap on score, and the order it
/// leaves equal scores in is part of what a search returns, so it is copied and not replaced
/// with `BinaryHeap`. `poll` fills a slot from the end of the heap and moves the smaller child
/// up to a leaf before sifting the new top back up.
// PARITY(#299): a copy of fuzzysort's heap so equal scores come out in the order it leaves them,
// where `BinaryHeap` would pick another — drop if Rust becomes the only server.
#[derive(Default)]
struct Queue {
    heap: Vec<Match>,
    size: usize,
}

impl Queue {
    fn add(&mut self, entry: Match) {
        let mut a = self.size;
        if self.size == self.heap.len() {
            self.heap.push(entry);
        } else {
            self.heap[self.size] = entry;
        }
        self.size += 1;
        while a > 0 {
            let parent = (a - 1) >> 1;
            if entry.score < self.heap[parent].score {
                self.heap[a] = self.heap[parent];
                a = parent;
            } else {
                break;
            }
        }
        self.heap[a] = entry;
    }

    fn peek(&self) -> Match {
        self.heap[0]
    }

    fn poll(&mut self) -> Match {
        let top = self.heap[0];
        self.size -= 1;
        self.heap[0] = self.heap[self.size];
        self.sift();
        top
    }

    fn replace_top(&mut self, entry: Match) {
        self.heap[0] = entry;
        self.sift();
    }

    /// The `v` function of the library's queue.
    fn sift(&mut self) {
        let moved = self.heap[0];
        let mut a = 0usize;
        let mut child = 1usize;
        while child < self.size {
            let sibling = child + 1;
            a = child;
            if sibling < self.size && self.heap[sibling].score < self.heap[child].score {
                a = sibling;
            }
            self.heap[(a - 1) >> 1] = self.heap[a];
            child = 1 + (a << 1);
        }
        while a > 0 {
            let parent = (a - 1) >> 1;
            if moved.score < self.heap[parent].score {
                self.heap[a] = self.heap[parent];
                a = parent;
            } else {
                break;
            }
        }
        self.heap[a] = moved;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn oracle() -> Value {
        serde_json::from_str(include_str!("../tests/data/fuzzysort-oracle.json")).expect("the oracle is JSON")
    }

    fn strings(value: &Value) -> Vec<&str> {
        value.as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect()
    }

    /// Runs every recorded search and checks the names and the scores, which are exact: both
    /// sides do the same arithmetic in the same order on IEEE doubles. The scores are recorded
    /// as the text `String(score)` gives and read with `str::parse`, which is correctly rounded;
    /// `serde_json` reads a float number a unit in the last place off, now and then.
    fn check(section: &str, limit: usize) {
        let oracle = oracle();
        let names = strings(&oracle["names"]);
        let cases = oracle[section].as_array().unwrap();
        assert!(cases.len() > 60);
        for case in cases {
            let search = case["search"].as_str().unwrap();
            let got = go(search, &names, limit);
            let got_names: Vec<&str> = got.iter().map(|m| names[m.index]).collect();
            assert_eq!(got_names, strings(&case["results"]), "{section}: results for {search:?}");
            let got_scores: Vec<f64> = got.iter().map(|m| m.score).collect();
            let want_scores: Vec<f64> =
                case["scores"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().parse().unwrap()).collect();
            assert_eq!(got_scores, want_scores, "{section}: scores for {search:?}");
        }
    }

    #[test]
    fn the_best_three_are_the_ones_fuzzysort_returns_in_its_order() {
        check("limited", 3);
    }

    #[test]
    fn every_result_has_fuzzysorts_score_and_place() {
        check("full", usize::MAX);
    }

    #[test]
    fn a_misspelling_finds_the_names_it_is_closest_to() {
        let names = ["Alice", "Alice Notes", "Bob", "Project Atlas"];
        let found: Vec<&str> = go("Alce", &names, 3).iter().map(|m| names[m.index]).collect();
        assert_eq!(found, ["Alice", "Alice Notes"]);
    }

    #[test]
    fn nothing_matches_an_empty_search_a_search_of_spaces_or_an_empty_target() {
        let names = ["", "abc"];
        assert!(go("", &names, 3).is_empty());
        assert!(go("   ", &names, 3).is_empty());
        assert!(go("abc", &[""], 3).is_empty());
        assert!(go("abc", &names, 0).is_empty());
    }

    #[test]
    fn a_character_outside_the_bmp_counts_twice_as_in_javascript() {
        // "x😀y" is four code units, so the gap between "x" and "y" is two, not one: both are
        // strict matches, 3 less 14 less 2 for the longer target, against 2, 13 and 1 (the oracle
        // checks the same for "x😀" and "😀" against the library).
        assert_eq!(go("xy", &["x-y"], 1)[0].score, -16.0);
        assert_eq!(go("xy", &["x\u{1F600}y"], 1)[0].score, -19.0);
    }
}
