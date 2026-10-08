//! The closest-name rules of ADR-0032 (closest-page-suggestions-match-by-meaning), Decision 3 (#335), as
//! the ADR states them. The list of names after `Closest:` in a page-not-found
//! message is held to rules, not bytes: the recorded lists are the TypeScript matcher's, which no server now
//! has.
//!
//! This file is the checker and nothing else: the comparator (`compare.rs`) decides when to run it. The words
//! below are the ADR's: the reference is the TypeScript server's recorded result for a case; the candidates
//! are the `originalName` strings of the stubbed `logseq.Editor.getAllPages` answer; `fold` is trim, Unicode
//! NFD, drop combining marks, lowercase; E, P, T and N are the sets the ADR names. The fold here is its own
//! (the server's is in `src/fuzzy.rs`), so a change there is judged by a second reading of the rule.

use icu_normalizer::DecomposingNormalizer;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use icu_properties::CodePointMapData;
use logseq_mcp_server::js;
use serde_json::{Value, json};

use super::cases::Case;

/// The fixed sentence that closes every page-not-found message (`PageNotFoundError`).
pub const GUIDANCE: &str = "Try logseq_search_blocks to find it by content, or logseq_list_pages (name_contains) to browse names.";

const LIST_START: &str = " Closest: ";

/// The ending of a message that has a list: the list's full stop, then the guidance.
fn closing() -> String {
    format!(". {GUIDANCE}")
}

/// `fold(s)`: trim, Unicode NFD, drop combining marks, lowercase.
pub fn fold(text: &str) -> String {
    let nfd = DecomposingNormalizer::new_nfd();
    let categories = CodePointMapData::<GeneralCategory>::new();
    let decomposed = nfd.normalize(js::trim(text));
    let unmarked: String = decomposed.chars().filter(|c| !GeneralCategoryGroup::Mark.contains(categories.get(*c))).collect();
    unmarked.to_lowercase()
}

/// The input's tokens: its fold split on spaces, empty pieces dropped.
pub fn tokens_of(input: &str) -> Vec<String> {
    fold(input).split(' ').filter(|t| !t.is_empty()).map(str::to_owned).collect()
}

/// A name covers a token when the token's characters appear in order, not necessarily next to each other,
/// in its fold.
fn covers(folded_name: &str, token: &str) -> bool {
    let wanted: Vec<char> = token.chars().collect();
    let mut at = 0;
    for ch in folded_name.chars() {
        if at < wanted.len() && ch == wanted[at] {
            at += 1;
        }
    }
    at == wanted.len()
}

/// The ADR's sets over the (distinct) candidates for one input.
#[derive(Debug, Default)]
pub struct Matches {
    /// Candidates whose fold equals the input's fold
    pub exact: Vec<String>,
    /// Candidates whose fold starts with the input's fold and isn't equal to it
    pub prefix: Vec<String>,
    /// E and P together
    pub both: Vec<String>,
    /// Candidates that cover every token of the input
    pub covering: Vec<String>,
}

fn distinct(candidates: &[String]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for name in candidates {
        if !name.is_empty() && !names.contains(name) {
            names.push(name.clone());
        }
    }
    names
}

pub fn matches_of(input: &str, candidates: &[String]) -> Matches {
    let names = distinct(candidates);
    let wanted = fold(input);
    let tokens = tokens_of(input);
    let exact: Vec<String> = names.iter().filter(|n| fold(n) == wanted).cloned().collect();
    let prefix: Vec<String> = names.iter().filter(|n| fold(n) != wanted && fold(n).starts_with(&wanted)).cloned().collect();
    let covering = names.iter().filter(|n| tokens.iter().all(|t| covers(&fold(n), t))).cloned().collect();
    let both = exact.iter().chain(prefix.iter()).cloned().collect();
    Matches { exact, prefix, both, covering }
}

/// A page-not-found message, read the way the ADR says: the frame, and the list between its edges.
#[derive(Debug)]
pub struct NotFound {
    /// Everything up to and including `Closest: ` (a `MCP error <code>: ` prefix of a JSON-RPC error
    /// included), or up to `No page <json>.` with no list
    pub opening: String,
    /// The input, decoded
    pub input: String,
    /// The text of the list; absent when the message has none
    pub list: Option<String>,
}

/// The rest of `text` after one `MCP error <code>: ` prefix.
fn strip_mcp_error(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("MCP error ")?;
    let rest = rest.strip_prefix('-').unwrap_or(rest);
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    rest[digits..].strip_prefix(": ")
}

/// Read a message as a page-not-found message, or `None` when it isn't one.
pub fn parse_not_found(message: &str) -> Option<NotFound> {
    let mut rest = message;
    while let Some(next) = strip_mcp_error(rest) {
        rest = next;
    }
    let after_name = rest.strip_prefix("No page ")?;
    // A JSON string literal: a quote, then any character but a quote or backslash, or a backslash and one more, then a quote
    let bytes = after_name.as_bytes();
    if bytes.first() != Some(&b'"') {
        return None;
    }
    let mut at = 1;
    loop {
        match bytes.get(at)? {
            b'"' => break,
            b'\\' => at += 2,
            _ => at += 1,
        }
    }
    let literal = after_name.get(..=at)?;
    let after_literal = after_name.get(at + 1..)?.strip_prefix('.')?;
    let input: String = serde_json::from_str(literal).ok()?;
    let frame_end = message.len() - after_literal.len();
    let guidance = format!(" {GUIDANCE}");
    if after_literal == guidance {
        return Some(NotFound { opening: message[..frame_end].to_owned(), input, list: None });
    }
    let listed = after_literal.strip_prefix(LIST_START)?.strip_suffix(&closing())?;
    if listed.is_empty() {
        return None;
    }
    Some(NotFound { opening: format!("{}{LIST_START}", &message[..frame_end]), input, list: Some(listed.to_owned()) })
}

/// Every way to read a list as one to three distinct candidates joined by `, `, trying the longest name first
/// and backing up when a choice leaves the rest unreadable (names can contain `, `). The first is the split
/// rules 4 to 6 use. It stops at two, which is all anyone needs to know ("is it unique").
pub fn split_list(list: &str, candidates: &[String]) -> Vec<Vec<String>> {
    let mut names = distinct(candidates);
    names.sort_by_key(|name| std::cmp::Reverse(name.encode_utf16().count()));
    let mut found: Vec<Vec<String>> = Vec::new();
    walk(list, 0, &mut Vec::new(), &names, &mut found);
    found
}

fn walk(list: &str, start: usize, chosen: &mut Vec<String>, names: &[String], found: &mut Vec<Vec<String>>) {
    if found.len() >= 2 || chosen.len() == 3 {
        return;
    }
    for name in names {
        if !list[start..].starts_with(name.as_str()) || chosen.contains(name) {
            continue;
        }
        let end = start + name.len();
        if end == list.len() {
            let mut whole = chosen.clone();
            whole.push(name.clone());
            found.push(whole);
        } else if list[end..].starts_with(", ") {
            chosen.push(name.clone());
            walk(list, end + 2, chosen, names, found);
            chosen.pop();
        }
        if found.len() >= 2 {
            return;
        }
    }
}

fn show(names: &[String]) -> String {
    if names.is_empty() { "none".to_owned() } else { names.iter().map(|n| json!(n).to_string()).collect::<Vec<_>>().join(", ") }
}

/// Rules 3 to 6 for a list, for an input and the candidates. Empty when the list passes.
pub fn check_list(list: &str, input: &str, candidates: &[String]) -> Vec<String> {
    let splits = split_list(list, candidates);
    let Some(names) = splits.first() else {
        return vec![format!("rule 3: the closest names {} are not one to three distinct candidates joined by \", \"", json!(list))];
    };
    let mut failures = Vec::new();
    let Matches { exact, prefix, both, covering } = matches_of(input, candidates);

    // Rule 4: exact and prefix first, exact before prefix (skipped for an input that folds to nothing)
    if !fold(input).is_empty() {
        let k = both.len().min(3);
        let head = &names[..k.min(names.len())];
        if head.len() < k || head.iter().any(|name| !both.contains(name)) {
            failures.push(format!(
                "rule 4: the first {k} name(s) must be exact or prefix matches of {} ({}), got {}",
                json!(input),
                show(&both),
                show(names)
            ));
        }
        // Among the names listed: which of more than three exact or prefix matches are listed is left unchecked (ADR-0032)
        for (at, name) in names.iter().enumerate() {
            if !prefix.contains(name) {
                continue;
            }
            let late: Vec<String> = names[at + 1..].iter().filter(|n| exact.contains(n)).cloned().collect();
            if !late.is_empty() {
                failures.push(format!("rule 4: the prefix match {} is listed before the exact match {}", json!(name), show(&late)));
            }
        }
    }

    // Rule 5: every listed name covers every token
    let stray: Vec<String> = names.iter().filter(|name| !covering.contains(name)).cloned().collect();
    if !stray.is_empty() {
        failures.push(format!("rule 5: {} does not cover every word of {}", show(&stray), json!(input)));
    }

    // Rule 6: as many names as there are to list, up to three
    let wanted = covering.len().min(3);
    if names.len() < wanted {
        failures.push(format!("rule 6: {} name(s) listed, {wanted} cover {}: {}", names.len(), json!(input), show(&covering)));
    }
    failures
}

/// Check one page-not-found message against the reference's: rules 1 and 2 on the frame, and rules 3 to 6 on
/// the list when the reference has one. Empty when the message passes. The list's edges come from the
/// reference's frame (the ADR's rule 1), so a name that contains `. Try` or ends with a full stop moves
/// nothing.
pub fn check_suggestion_rules(reference: &str, message: &str, candidates: &[String]) -> Vec<String> {
    let reference_parsed = parse_not_found(reference).unwrap_or_else(|| panic!("not a page-not-found message: {}", json!(reference)));
    let closing = closing();
    let Some(list) = &reference_parsed.list else {
        if message == reference {
            return Vec::new();
        }
        // The message with a list in it has the reference's opening, a list, and its closing
        let listed = format!("{}{LIST_START}", reference_parsed.opening);
        return if message.starts_with(&listed) && message.ends_with(&closing) {
            vec!["rule 2: the reference lists no closest names, this message does".to_owned()]
        } else {
            vec![format!("rule 1: the message differs from the reference's outside the list\n  expected: {}\n  actual:   {}", json!(reference), json!(message))]
        };
    };
    let _ = list;
    let opening = &reference_parsed.opening;
    if message.len() >= opening.len() + closing.len() && message.starts_with(opening.as_str()) && message.ends_with(&closing) {
        let list = &message[opening.len()..message.len() - closing.len()];
        return if list.is_empty() {
            vec!["rule 3: the closest names are empty".to_owned()]
        } else {
            check_list(list, &reference_parsed.input, candidates)
        };
    }
    let without_list = format!("{} {GUIDANCE}", &opening[..opening.len() - LIST_START.len()]);
    if message == without_list {
        return vec!["rule 2: the reference lists closest names, this message lists none".to_owned()];
    }
    vec![format!(
        "rule 1: the message differs from the reference's outside the list\n  expected: {} ... {}\n  actual:   {}",
        json!(opening),
        json!(closing),
        json!(message)
    )]
}

/// The reference's own list has to pass rules 3 to 6, and be read one way only, before it is recorded.
pub fn check_reference_list(reference: &str, candidates: &[String]) -> Vec<String> {
    let Some(NotFound { input, list: Some(list), .. }) = parse_not_found(reference) else { return Vec::new() };
    let mut failures = check_list(&list, &input, candidates);
    if split_list(&list, candidates).len() > 1 {
        failures.push("rule 3: the list can be split into names in two ways, so it can not be recorded".to_owned());
    }
    failures
}

// ---- where a message sits in a result

/// A page-not-found message in a result: a tool result's content block (`{"error": ...}` JSON), or a JSON-RPC error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Site {
    Tool(usize),
    Error,
}

pub fn describe_site(site: Site) -> String {
    match site {
        Site::Tool(index) => format!("content[{index}] error"),
        Site::Error => "error message".to_owned(),
    }
}

/// The decoded message at a site, or `None` when the result has none there.
pub fn read_message(result: &Value, site: Site) -> Option<String> {
    match site {
        Site::Error => result.get("error")?.get("message")?.as_str().map(str::to_owned),
        Site::Tool(index) => {
            let text = result.get("content")?.as_array()?.get(index)?.get("text")?.as_str()?;
            let parsed: Value = serde_json::from_str(text).ok()?;
            let object = parsed.as_object()?;
            if object.len() != 1 {
                return None;
            }
            object.get("error")?.as_str().map(str::to_owned)
        }
    }
}

/// A copy of a result with the message at a site replaced, serialized as the TypeScript server does (minified).
pub fn with_message(result: &Value, site: Site, message: &str) -> Value {
    let mut copy = result.clone();
    match site {
        Site::Error => copy["error"]["message"] = Value::String(message.to_owned()),
        Site::Tool(index) => copy["content"][index]["text"] = Value::String(json!({"error": message}).to_string()),
    }
    copy
}

/// Every place in a reference result that holds a page-not-found message.
pub fn not_found_sites(reference: &Value) -> Vec<Site> {
    let blocks = reference.get("content").and_then(Value::as_array).map_or(0, Vec::len);
    (0..blocks)
        .map(Site::Tool)
        .chain([Site::Error])
        .filter(|site| read_message(reference, *site).is_some_and(|message| parse_not_found(&message).is_some()))
        .collect()
}

/// The candidates of a case: the `originalName` strings of its `getAllPages` answers, strings only, as
/// `suggestPages` reads them.
pub fn candidates_of(case: &Case) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for call in case.canned() {
        if call.method != "logseq.Editor.getAllPages" {
            continue;
        }
        let Some(pages) = call.response.as_array() else { continue };
        for page in pages {
            if let Some(name) = page.get("originalName").and_then(Value::as_str) {
                if !names.iter().any(|n| n == name) {
                    names.push(name.to_owned());
                }
            }
        }
    }
    names
}

// ---- the recorded set has to exercise the rules (ADR-0032 Decision 3)

/// What a recorded case needs for the minimum set, in the order the ADR lists them.
pub const REQUIRED_CASES: [&str; 8] = [
    "an exact hit (E and P both non-empty)",
    "a prefix hit (E empty, P non-empty)",
    "more than three exact or prefix matches",
    "a typo with no prefix match and at least one covering name",
    "no suggestion: an ISO date",
    "no suggestion: an input no candidate covers",
    "a listed name that contains \", \"",
    "the page resource's error",
];

fn is_iso_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

/// Which of {@link REQUIRED_CASES} one recorded case is.
pub fn required_kinds_of(case: &Case) -> Vec<&'static str> {
    let mut kinds = Vec::new();
    let candidates = candidates_of(case);
    for site in not_found_sites(&case.expected) {
        let reference = parse_not_found(&read_message(&case.expected, site).unwrap()).unwrap();
        let Matches { exact, prefix, both, covering } = matches_of(&reference.input, &candidates);
        let non_empty = !fold(&reference.input).is_empty();
        let Some(list) = &reference.list else {
            if is_iso_date(&reference.input) {
                kinds.push(REQUIRED_CASES[4]);
            } else if !candidates.is_empty() && covering.is_empty() {
                kinds.push(REQUIRED_CASES[5]);
            }
            continue;
        };
        if non_empty && !exact.is_empty() && !prefix.is_empty() {
            kinds.push(REQUIRED_CASES[0]);
        }
        if non_empty && exact.is_empty() && !prefix.is_empty() {
            kinds.push(REQUIRED_CASES[1]);
        }
        if non_empty && both.len() > 3 {
            kinds.push(REQUIRED_CASES[2]);
        }
        if non_empty && both.is_empty() && !covering.is_empty() {
            kinds.push(REQUIRED_CASES[3]);
        }
        if split_list(list, &candidates).first().is_some_and(|names| names.iter().any(|name| name.contains(", "))) {
            kinds.push(REQUIRED_CASES[6]);
        }
        let is_page_resource = matches!(&case.request, super::cases::Request::ReadResource(uri) if uri.starts_with("logseq://page/"));
        if site == Site::Error && is_page_resource {
            kinds.push(REQUIRED_CASES[7]);
        }
    }
    kinds
}

/// Failures for each recorded reference whose closest names break rules 3 to 6 (or can be read two ways).
pub fn check_reference_lists(cases: &[Case]) -> Vec<String> {
    let mut failures = Vec::new();
    for case in cases {
        for site in not_found_sites(&case.expected) {
            for failure in check_reference_list(&read_message(&case.expected, site).unwrap(), &candidates_of(case)) {
                failures.push(format!("[{}] the reference's closest names break {failure}", case.name));
            }
        }
    }
    failures
}

/// Failures for the required cases the recorded set lacks (ADR-0032 Decision 3).
pub fn missing_required_cases(cases: &[Case]) -> Vec<String> {
    let seen: Vec<&str> = cases.iter().flat_map(required_kinds_of).collect();
    REQUIRED_CASES
        .iter()
        .filter(|kind| !seen.contains(kind))
        .map(|kind| format!("the recorded cases lack a required closest-names case (ADR-0032): {kind}"))
        .collect()
}

// ---- the self-check: wrong lists, each of which a rule has to catch

/// The kinds of wrong list the self-check makes, each of which has to apply to some recorded case and be
/// caught in all of them.
pub const WRONG_LIST_LABELS: [&str; 6] = [
    "a name that is not a candidate",
    "an unrelated name",
    "a wrong frame",
    "no list",
    "a reversed order",
    "a non-match before the exact or prefix hits",
];

/// One way a list can go wrong, as a message to feed the check.
pub struct WrongList {
    pub label: &'static str,
    pub message: String,
}

/// Wrong versions of a reference message with a list: a name that is not a candidate, an unrelated name, the
/// wrong frame, no list, the list in reverse (exact after prefix), and a non-match ahead of a match. A kind
/// that doesn't apply to the case (there is no unrelated candidate, the list is one name long) is left out.
pub fn wrong_lists(reference: &str, candidates: &[String]) -> Vec<WrongList> {
    let Some(NotFound { opening, input, list: Some(list) }) = parse_not_found(reference) else { return Vec::new() };
    let names = split_list(&list, candidates).into_iter().next().unwrap_or_default();
    let Matches { exact, prefix, both, covering } = matches_of(&input, candidates);
    let closing = closing();
    let make = |list: &[String]| format!("{opening}{}{closing}", list.join(", "));
    let without_list = format!("{} {GUIDANCE}", &opening[..opening.len() - LIST_START.len()]);
    let first = names.first().cloned().unwrap_or_default();
    let mut not_a_page = vec![format!("{first} (not a page)")];
    not_a_page.extend(names.iter().skip(1).cloned());
    let mut wrong = vec![
        WrongList { label: WRONG_LIST_LABELS[0], message: make(&not_a_page) },
        WrongList { label: WRONG_LIST_LABELS[2], message: format!("{opening}{}. Try something else.", names.join(", ")) },
        WrongList { label: WRONG_LIST_LABELS[3], message: without_list },
    ];
    if let Some(unrelated) = distinct(candidates).into_iter().find(|name| !covering.contains(name)) {
        wrong.push(WrongList { label: WRONG_LIST_LABELS[1], message: make(&[unrelated]) });
    }
    if !exact.is_empty() && !prefix.is_empty() && names.contains(&exact[0]) && names.contains(&prefix[0]) {
        let reversed: Vec<String> = names.iter().rev().cloned().collect();
        wrong.push(WrongList { label: WRONG_LIST_LABELS[4], message: make(&reversed) });
    }
    if let Some(miss) = covering.iter().find(|name| !both.contains(name)) {
        if !both.is_empty() {
            let mut reordered = vec![miss.clone()];
            reordered.extend(names.iter().filter(|n| *n != miss).cloned());
            reordered.truncate(3);
            wrong.push(WrongList { label: WRONG_LIST_LABELS[5], message: make(&reordered) });
        }
    }
    wrong
}
