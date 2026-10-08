//! `tests/fixtures/graph-linking/` through `logseq_check_links` (#369), against a stub LogSeq built
//! from the fixture's `pages.txt`. The fixture is the worked example and the regression suite for
//! the concept-linking skill and its gate. This is the port of the test that ran it in TypeScript,
//! `src/tools/check-links.test.ts` (last version: commit 10103c8), which went with the TypeScript
//! server (#356):
//!
//! - `expected/` passes, each file in `negative/` fails on the check the fixture README names,
//!   an unchanged note passes;
//! - the "bare" variant (an overlay of two pages) passes with its own expected result, and its
//!   premises (nothing ties `Devon` to a roster) are pinned;
//! - the prose check's first difference agrees with an independent reference, on a table of tricky
//!   pairs and on seeded random ones.
//!
//! Every page here is the fixture's, made up (BR-0001).

mod common;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use common::{MockLogseq, args_of, client, methods, mock_logseq};
use logseq_mcp_server::tools::check_links::check_links;
use serde_json::{Value, json};

// ---------------------------------------------------------------- the fixture

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("graph-linking")
}

fn fixture(path: &str) -> String {
    let file = fixture_dir().join(path);
    fs::read_to_string(&file).unwrap_or_else(|error| panic!("read {}: {error}", file.display()))
}

/// The `.md` files of a fixture directory, sorted.
fn page_files(dir: &str) -> Vec<String> {
    let mut files: Vec<String> = fs::read_dir(fixture_dir().join(dir))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".md"))
        .collect();
    files.sort();
    files
}

/// The bare graph's pages: the base `pages/`, with the same-named files of `variants/bare/pages/` replacing theirs.
fn bare_graph_pages() -> HashMap<String, String> {
    let mut pages = HashMap::new();
    for file in page_files("pages") {
        pages.insert(file.clone(), fixture(&format!("pages/{file}")));
    }
    for file in page_files("variants/bare/pages") {
        pages.insert(file.clone(), fixture(&format!("variants/bare/pages/{file}")));
    }
    pages
}

// ---------------------------------------------------------------- the stub graph

/// A page of the stub graph. `file: false` is a page LogSeq made for a link or an alias.
struct StubPage {
    name: &'static str,
    file: bool,
    aliases: Vec<&'static str>,
}

/// The rows LogSeq answers `linkTargets` with, for every name in the graph: a page's own name, and an
/// alias value, which is also a file-less page of that name, linked back to the page that declares it
/// (stored both ways, as LogSeq does). The query binds only the names the text has, and the resolver
/// reads the rows of those names alone, so rows for the others are ignored: answering for all of them
/// lets one canned answer serve any text.
fn link_target_rows(pages: &[StubPage]) -> Value {
    struct Entity {
        id: i64,
        name: String,
        original: String,
        file: bool,
    }
    let mut entities: Vec<Entity> = Vec::new();
    let mut alias_of: Vec<(String, usize)> = Vec::new(); // (name linked from, entity index of the page it points at)
    let entity = |entities: &mut Vec<Entity>, original: &str, file: bool| -> usize {
        let key = original.to_lowercase();
        let at = entities.iter().position(|e| e.name == key).unwrap_or_else(|| {
            entities.push(Entity { id: entities.len() as i64 + 1, name: key, original: original.to_owned(), file: false });
            entities.len() - 1
        });
        entities[at].file |= file;
        at
    };
    for page in pages {
        entity(&mut entities, page.name, page.file);
    }
    for page in pages {
        let declaring = entity(&mut entities, page.name, page.file);
        for alias in &page.aliases {
            let target = entity(&mut entities, alias, false);
            alias_of.push((entities[target].name.clone(), declaring));
            alias_of.push((entities[declaring].name.clone(), target));
        }
    }
    let as_json = |e: &Entity| {
        let mut entity = json!({"id": e.id, "name": e.name, "original-name": e.original});
        if e.file {
            entity["file"] = json!({"id": 1000 + e.id});
        }
        entity
    };
    let mut rows: Vec<Value> = Vec::new();
    for e in &entities {
        rows.push(json!([as_json(e), "name", e.name]));
        for (name, source) in &alias_of {
            if *name == e.name {
                rows.push(json!([as_json(&entities[*source]), "alias", e.name]));
            }
        }
    }
    Value::Array(rows)
}

/// The fixture's graph: the titles of `pages.txt`, plus the one alias its pages declare. `pages.txt` lists pages as
/// `logseq_list_pages` names them (#171), so an alias is not a line of its own: `Priya` has `alias:: Priya Raghavan`.
fn fixture_graph() -> Vec<StubPage> {
    // `pages.txt` is read at run time, but a `&'static str` name wants a leak: the test process is short
    fixture("pages.txt")
        .lines()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(|title| {
            let name: &'static str = Box::leak(title.to_owned().into_boxed_str());
            StubPage { name, file: true, aliases: if name == "Priya" { vec!["Priya Raghavan"] } else { vec![] } }
        })
        .collect()
}

/// `check_links` over the fixture's graph. The tool makes one Datalog query for the distinct terms and no Editor call.
async fn gate(before: &str, after: &str) -> Value {
    let logseq: MockLogseq = mock_logseq(vec![link_target_rows(&fixture_graph())]).await;
    let result = check_links(&client(&logseq), before, after).await.unwrap();
    assert!(methods(&logseq).len() <= 1, "check_links made more than one call: {:?}", methods(&logseq));
    if let Some(call) = methods(&logseq).first() {
        assert_eq!(call, "logseq.DB.datascriptQuery");
        assert!(args_of(&logseq, 0)[0].as_str().unwrap().contains(":in $ [?n ...]"));
    }
    result
}

// ---------------------------------------------------------------- the script's fixture

#[tokio::test]
async fn it_passes_the_expected_result_prose_kept_brackets_balanced_every_ref_resolves() {
    let baseline = fixture("journals/2024_03_11.md");
    let logseq = mock_logseq(vec![link_target_rows(&fixture_graph())]).await;

    let result = check_links(&client(&logseq), &baseline, &fixture("expected/2024_03_11.md")).await.unwrap();

    assert_eq!(result["ok"], true);
    assert_eq!(result["prose"], json!({"ok": true}));
    assert_eq!(result["brackets"], json!({"ok": true, "opens": 5, "closes": 5}));
    assert_eq!(
        result["refs"],
        json!({
            "ok": true,
            "resolved": [
                {"term": "Beacon", "page": "Beacon", "matchedBy": "name"},
                {"term": "Devon", "page": "Devon", "matchedBy": "name"},
                // Case differs from the page title: still the same page
                {"term": "NorthWind", "page": "Northwind", "matchedBy": "name"},
                // The alias case: the full name reaches the page that declares it
                {"term": "Priya Raghavan", "page": "Priya", "matchedBy": "alias"},
                {"term": "Quarterly Planning", "page": "Quarterly Planning", "matchedBy": "name"},
            ],
            "unresolved": [],
            "ambiguous": [],
        })
    );
    assert_eq!(result["refsPreserved"], json!({"ok": true, "removed": []}));
    // The script's report line: refs before 1, after 5, added 4
    assert_eq!(result["totals"], json!({"refsBefore": 1, "refsAfter": 5, "terms": 5}));
    assert_eq!(result["hasMore"], false);
    assert_eq!(result["warnings"], json!([]));
    // One query for the five terms, as the sorted, trimmed and lowercased names
    assert_eq!(methods(&logseq), ["logseq.DB.datascriptQuery"]);
    assert_eq!(args_of(&logseq, 0)[1], json!("[\"beacon\",\"devon\",\"northwind\",\"priya raghavan\",\"quarterly planning\"]"));
}

#[tokio::test]
async fn it_fails_check_1_alone_for_negative_reworded() {
    let baseline = fixture("journals/2024_03_11.md");

    let result = gate(&baseline, &fixture("negative/reworded.md")).await;

    assert_eq!(result["ok"], false);
    assert_eq!(result["prose"]["ok"], false);
    // `structured logs` became `Structured Logging`: the first byte that differs is the `S`
    assert_eq!(result["prose"]["firstDifference"]["line"], 8);
    assert!(result["prose"]["firstDifference"]["before"].as_str().unwrap().contains("structured logs before"));
    assert!(result["prose"]["firstDifference"]["after"].as_str().unwrap().contains("Structured Logging before"));
    assert_eq!(result["brackets"]["ok"], true);
    // The page exists, so check 3 passes: rewording is caught by check 1 alone
    assert_eq!(result["refs"]["ok"], true);
    assert_eq!(result["refsPreserved"]["ok"], true);
}

#[tokio::test]
async fn it_fails_checks_1_and_3_for_negative_invented_page() {
    let baseline = fixture("journals/2024_03_11.md");

    let result = gate(&baseline, &fixture("negative/invented-page.md")).await;

    assert_eq!(result["ok"], false);
    assert_eq!(result["prose"]["ok"], false);
    assert_eq!(result["refs"]["ok"], false);
    assert_eq!(result["refs"]["unresolved"], json!(["Retry Budget"]));
}

#[tokio::test]
async fn it_fails_check_3_alone_for_negative_unresolved_only() {
    let baseline = fixture("journals/2024_03_11.md");

    let result = gate(&baseline, &fixture("negative/unresolved-only.md")).await;

    assert_eq!(result["ok"], false);
    assert_eq!(result["prose"], json!({"ok": true}));
    assert_eq!(result["brackets"]["ok"], true);
    assert_eq!(result["refsPreserved"]["ok"], true);
    assert_eq!(result["refs"]["ok"], false);
    assert_eq!(result["refs"]["unresolved"], json!(["retry budget"]));
}

#[tokio::test]
async fn it_passes_an_unchanged_note_linking_nothing_is_safe() {
    let baseline = fixture("journals/2024_03_11.md");

    let result = gate(&baseline, &baseline).await;

    assert_eq!(result["ok"], true);
    assert_eq!(result["totals"], json!({"refsBefore": 1, "refsAfter": 1, "terms": 1}));
}

#[test]
fn every_negative_case_the_readme_names_is_a_file_and_no_other_is() {
    assert_eq!(page_files("negative"), ["invented-page.md", "reworded.md", "unresolved-only.md"]);
}

// ---------------------------------------------------------------- the bare variant (#169)

#[test]
fn the_bare_variant_only_overrides_pages_that_exist_in_the_base_graph_so_no_page_is_added_or_removed() {
    let base = page_files("pages");
    for file in page_files("variants/bare/pages") {
        assert!(base.contains(&file), "{file} is not a page of the base graph");
    }
    let mut pages: Vec<String> = bare_graph_pages().into_keys().collect();
    pages.sort();
    assert_eq!(pages, base);
}

#[test]
fn nothing_ties_the_bare_first_name_to_the_note_no_other_page_mentions_it_and_its_own_page_links_nothing() {
    let pages = bare_graph_pages();

    // Pinned exactly: any property, link or "Engineer on Atlas Squad" would tie him to the roster
    assert_eq!(
        pages["Devon.md"].trim(),
        "- Engineer.",
        "variants/bare/pages/Devon.md must hold only \"- Engineer.\" (nothing may tie Devon to a roster page)"
    );
    for (file, text) in &pages {
        if file != "Devon.md" {
            assert!(!text.to_lowercase().contains("devon"), "{file} mentions Devon");
        }
        // A property value is a ref to that page in LogSeq, so a `key:: ...Atlas Squad...` line anywhere in the
        // graph would corroborate like a roster entry. The roster page itself has no such line.
        for line in text.lines() {
            if is_property_line(line) && line.to_lowercase().contains("atlas squad") {
                panic!("{file} has a property that refs the roster page: {}", line.trim());
            }
        }
    }
    // The premise is an exact title match, so the page and its name in pages.txt stay
    assert!(pages.contains_key("Devon.md"));
    assert!(fixture("pages.txt").lines().any(|line| line == "Devon"));
}

/// `^\s*(- )?[\w-]+::`
fn is_property_line(line: &str) -> bool {
    let rest = line.trim_start();
    let rest = rest.strip_prefix("- ").unwrap_or(rest);
    let key = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-').count();
    key > 0 && rest.chars().skip(key).take(2).collect::<String>() == "::"
}

#[tokio::test]
async fn the_bare_variant_passes_its_expected_result_devon_is_plain_the_single_referent_matches_still_link() {
    let baseline = fixture("journals/2024_03_11.md");
    let expected = fixture("variants/bare/expected/2024_03_11.md");
    assert!(expected.contains("; Devon took the rollback owner slot."));

    let result = gate(&baseline, &expected).await;

    assert_eq!(result["ok"], true);
    assert_eq!(
        result["refs"],
        json!({
            "ok": true,
            "resolved": [
                {"term": "Beacon", "page": "Beacon", "matchedBy": "name"},
                {"term": "NorthWind", "page": "Northwind", "matchedBy": "name"},
                {"term": "Priya Raghavan", "page": "Priya", "matchedBy": "alias"},
                {"term": "Quarterly Planning", "page": "Quarterly Planning", "matchedBy": "name"},
            ],
            "unresolved": [],
            "ambiguous": [],
        })
    );
    assert_eq!(result["totals"], json!({"refsBefore": 1, "refsAfter": 4, "terms": 4}));
}

#[test]
fn the_bare_expected_result_differs_from_the_roster_graph_one_in_the_devon_ref_alone() {
    let roster = fixture("expected/2024_03_11.md");
    let bare = fixture("variants/bare/expected/2024_03_11.md");

    assert_eq!(roster.replace("[[Devon]]", "Devon"), bare);
}

#[tokio::test]
async fn the_gate_cannot_tell_the_two_graphs_apart_the_roster_result_also_passes_it_which_does_not_judge_identity() {
    let result = gate(&fixture("journals/2024_03_11.md"), &fixture("expected/2024_03_11.md")).await;

    assert_eq!(result["ok"], true);
}

// ---------------------------------------------------------------- check 1 against a reference

/// The rule of check 1, written again from its definition and not from the tool's code: strip every
/// `[[term]]` (one or more characters, none of them `[`, `]` or a newline) from both texts, and if
/// they differ, report the first character where they do. Where a difference is a text that ends,
/// it is at the end of the shorter one. Line and column are 1-based, in characters. The excerpts are
/// the line at that position, cut to 30 characters before it and 50 from it on, behind `...`.
///
/// The TypeScript reference this is ported from (`referenceProse`) reads the line start as
/// `lastIndexOf('\n', i - 1)`, which for `i == 0` looks at the first character: a text that opens
/// with a newline gets an empty excerpt (the tool copies that, as parity with the TypeScript server).
fn reference_prose(before: &str, after: &str) -> Value {
    fn strip(text: &str) -> Vec<char> {
        let c: Vec<char> = text.chars().collect();
        let (mut out, mut i) = (Vec::new(), 0);
        while i < c.len() {
            // the `[[`, then a run of characters outside `[`, `]` and a newline, then `]]`
            let run_end = (i + 2..c.len()).find(|&j| matches!(c[j], '[' | ']' | '\n')).unwrap_or(c.len());
            if c[i..].starts_with(&['[', '[']) && run_end > i + 2 && c[run_end..].starts_with(&[']', ']']) {
                out.extend(&c[i + 2..run_end]);
                i = run_end + 2;
            } else {
                out.push(c[i]);
                i += 1;
            }
        }
        out
    }
    let (a, b) = (strip(before), strip(after));
    if a == b {
        return json!({"ok": true});
    }
    let i = (0..a.len().min(b.len())).find(|&k| a[k] != b[k]).unwrap_or(a.len().min(b.len()));
    let around = |t: &[char]| -> String {
        let from = i.saturating_sub(1); // lastIndexOf('\n', i - 1): a negative `fromIndex` is 0
        let newline = (0..=from.min(t.len().saturating_sub(1))).rev().find(|&k| t.get(k) == Some(&'\n'));
        let start = newline.map_or(0, |k| k + 1);
        let end = (i..t.len()).find(|&k| t[k] == '\n').unwrap_or(t.len());
        let head: &[char] = if start < i { &t[start..i] } else { &[] };
        let tail: &[char] = if i < end { &t[i..end] } else { &[] };
        let left = if head.len() > 30 { format!("...{}", head[head.len() - 30..].iter().collect::<String>()) } else { head.iter().collect() };
        let right = if tail.len() > 50 { format!("{}...", tail[..50].iter().collect::<String>()) } else { tail.iter().collect() };
        left + &right
    };
    let line = a[..i].iter().filter(|c| **c == '\n').count() + 1;
    let column = a[..i].iter().rev().take_while(|c| **c != '\n').count() + 1;
    json!({"ok": false, "firstDifference": {"line": line, "column": column, "before": around(&a), "after": around(&b)}})
}

/// mulberry32: a small seeded generator, so a failure reproduces.
struct Seeded(u32);

impl Seeded {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4294967296.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() * n as f64) as usize
    }
}

/// `check_links`'s `prose`, over a stub that knows no page: only check 1 is read.
async fn prose_of(client: &logseq_mcp_server::client::LogseqClient, before: &str, after: &str) -> Value {
    check_links(client, before, after).await.unwrap()["prose"].clone()
}

// The pairs below are read as text, so the texts hold no lone surrogate: the TypeScript table's
// `'😀' vs '\uD83D'` rows have no Rust string. Everything else of that table is here.
const TRICKY: &[(&str, &str)] = &[
    ("", ""),
    ("", "a"),
    ("a", ""),
    ("abc", "abc"),
    ("abc", "abcd"),
    ("abcd", "abc"),
    ("abc", "abd"),
    ("\n", ""),
    ("a\n", "a"),
    ("\nb", "\nc"),
    ("[[a]]", "a"),
    ("[[a]]b", "ab"),
    ("[[a]]b", "ac"),
    ("[a", "[b"),
    ("a]]", "a]"),
    ("😀", "😁"),
    ("x😀", "x😁"),
    // brackets that are not a ref: unclosed, adjacent, nested, spanning a line, empty
    ("[[a", "a"),
    ("[[a]][[b]]", "ab"),
    ("[[a]][[b]]", "a[[b]"),
    ("[[[a]]]", "[a]"),
    ("[[a [[b]] c]]", "[[a b c]]"),
    ("[[a\nb]]", "ab"),
    ("[[]]", ""),
    ("[[ ]]", " "),
    // brackets already in `before`
    ("[[a]] b", "[[a]] c"),
    ("a [[b]]", "a [[b]]c"),
];

/// Pairs on the edges of the excerpt window: 30 and 31 characters before the difference, 50 and 51 from it on,
/// on the first line and on a later one, with a ref in the stretch and an emoji at the cut.
fn window_edges() -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for lead in [29, 30, 31, 32] {
        for tail in [48, 49, 50, 51] {
            for prefix in ["", "first\n", "[[a]]"] {
                let (head, rest) = ("x".repeat(lead), "y".repeat(tail));
                pairs.push((format!("{prefix}{head}A{rest}"), format!("{prefix}{head}B{rest}")));
                pairs.push((format!("{prefix}{head}A{rest}\nnext"), format!("{prefix}{head}A{rest}")));
                pairs.push((format!("{prefix}[[{head}]]A{rest}"), format!("{prefix}{head}\u{1F600}{rest}")));
            }
        }
    }
    pairs
}

#[tokio::test]
async fn the_prose_check_matches_the_reference_on_the_tricky_pairs() {
    let logseq = mock_logseq(vec![json!([]); TRICKY.len() + window_edges().len()]).await;
    let client = client(&logseq);
    let edges = window_edges();
    let all = TRICKY.iter().map(|(a, b)| (a.to_string(), b.to_string())).chain(edges);
    for (before, after) in all {
        assert_eq!(prose_of(&client, &before, &after).await, reference_prose(&before, &after), "{before:?} vs {after:?}");
    }
}

const PIECES: &[&str] = &["a", "b", "x", " ", "\n", "[[", "]]", "[", "]", "[[p]]", "😀", "😁", "é", "."];
const PAIRS: usize = 5000;

#[tokio::test]
async fn the_prose_check_matches_the_reference_on_seeded_random_pairs_including_prefixes_and_extensions() {
    // Each pair goes both ways. A pair whose `after` has a `[[term]]` makes one query, which this answers with no rows
    // (the terms are unresolved, which this test does not read).
    let logseq = mock_logseq(vec![json!([]); PAIRS * 2]).await;
    let client = client(&logseq);
    let mut rand = Seeded(246);
    let text = |rand: &mut Seeded| -> String {
        let pieces = rand.below(9);
        (0..pieces).map(|_| PIECES[rand.below(PIECES.len())]).collect()
    };
    let mut differing = 0;
    for n in 0..PAIRS {
        let before = text(&mut rand);
        let chars: Vec<char> = before.chars().collect();
        // Unrelated, a prefix of the other, an extension of it, or text inserted at a random position
        // (the start and end included)
        let after = match n % 4 {
            0 => text(&mut rand),
            1 => chars[..rand.below(chars.len() + 1)].iter().collect(),
            2 => before.clone() + &text(&mut rand),
            _ => {
                let at = rand.below(chars.len() + 1);
                chars[..at].iter().collect::<String>() + &text(&mut rand) + &chars[at..].iter().collect::<String>()
            }
        };
        for (x, y) in [(&before, &after), (&after, &before)] {
            let expected = reference_prose(x, y);
            differing += usize::from(expected["ok"] == false);
            assert_eq!(prose_of(&client, x, y).await, expected, "{x:?} vs {y:?}");
        }
    }
    // Most pairs differ, so the comparison is mostly of positions and excerpts, not of `{"ok":true}`
    assert!(differing > PAIRS, "only {differing} of {} pairs differ", PAIRS * 2);
}
