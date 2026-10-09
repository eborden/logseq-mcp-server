//! `logseq_check_links` (the Rust side of `src/tools/check-links.ts`, #146): the concept-linking
//! safety gate, run in the server. It checks a text before and after a pass that added `[[links]]`:
//!
//! 1. **Prose preserved:** stripping `[[ ]]` from both texts leaves them identical.
//! 2. **Brackets balanced:** as many `[[` as `]]`, and no `[[` opened inside another on the same line.
//! 3. **Refs resolve:** every `[[term]]` in `after` names a page or an alias, file-less pages
//!    included, through the shared resolver in one Datalog query. A term is trimmed before it is
//!    matched, as LogSeq trims ref names, and an alias several pages declare fails.
//! 4. **Refs preserved:** every `[[term]]` in `before` is still a ref in `after`, as many times.
//!
//! Calls: one Datalog query for all the distinct `[[terms]]` in `after`, however many there are
//! (`:in $ [?n ...]`), and none when it has no terms. Never one call per term. Checks 1, 2 and 4 read
//! only the texts (`text.rs`). Read-only: it reads page names, never writes. The tool has no tips.

mod text;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::args::Arguments;
use crate::client::LogseqClient;
use crate::errors::{InvalidParameter, MatchedBy, ToolError};
use crate::js;
use crate::meta::ResultWarning;
use crate::resolve::{Resolution, link_key, resolve_link_targets};
use crate::tool::{input_schema, read_only_annotations, result_value, success_result};

use self::text::{BracketCheck, ProseCheck, RefsPreservedCheck, check_brackets, check_prose, check_refs_preserved, key_counts, key_of, link_counts};

pub const NAME: &str = "logseq_check_links";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "Check a [[link]] pass. ok is true only if after strips back to before, brackets balance and don't nest, every ref in before is kept, and each [[term]] names exactly one page or alias.\n\n\
**Can't find:** a link to the wrong page, or a name split across a ref.";

/// Most UTF-16 code units (`string.length`) `before` or `after` may hold, about 12k tokens each. A
/// journal day or page file is well under. An emoji counts as two.
pub const MAX_TEXT_CHARS: usize = 50_000;

/// Most distinct `[[terms]]` one call resolves. More is rejected before any LogSeq call.
pub const MAX_LINK_TERMS: usize = 500;

/// The tool's arguments, as `tools/list` shows them. Both texts are required and capped at
/// [`MAX_TEXT_CHARS`], so the input stays bounded (ADR-0011). An empty string is a text, not a
/// missing one. The cap on distinct terms is checked by [`check_links`], before any LogSeq call.
///
/// Units: the cap counts UTF-16 code units (`string.length`), while the advertised JSON Schema
/// `maxLength` counts code points. Text outside the Basic Multilingual Plane takes two units per
/// character, so about 25,000 emoji pass a validating client and are then rejected here, with a clear
/// error and no LogSeq call. Deliberate, as in TypeScript: the cap bounds memory.
#[derive(Debug, Clone, Deserialize, JsonSchema, PartialEq)]
pub struct Args {
    /// Text before linking
    #[schemars(length(max = 50000))]
    pub before: String,
    /// before plus [[links]], at most 500 distinct terms
    #[schemars(length(max = 50000))]
    pub after: String,
}

/// Read the arguments in the order the schema lists them, so the first one that is wrong is the one
/// reported, as `parseArgs` does.
fn read_args(arguments: Option<&JsonObject>) -> Result<Args, ToolError> {
    let read = Arguments::new(arguments);
    Ok(Args { before: read.required_string_max("before", MAX_TEXT_CHARS)?, after: read.required_string_max("after", MAX_TEXT_CHARS)? })
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Check Links")
        .with_annotations(read_only_annotations("Check Links"))
}

/// A call: arguments read, then the checks.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let args = read_args(arguments.as_ref())?;
    let result = check_links(client, &args.before, &args.after).await?;
    Ok(success_result(vec![ContentBlock::text(js::json_stringify(&result))]))
}

/// `countOf(text, token)`: how many non-overlapping copies of `token` the text holds.
fn count_of(text: &str, token: &str) -> usize {
    text.matches(token).count()
}

/// `checkLinks`: run the linking gate over `before` and `after`. Returns each check's outcome, `ok`
/// for all four, and meta: `totals` counts the refs on each side and the distinct terms; a warning
/// says when resolution could not run (LogSeq answered `null`) or a candidate list was cut.
///
/// Fails with [`ToolError::InvalidParameter`] if `after` has more than [`MAX_LINK_TERMS`] distinct
/// terms.
pub async fn check_links(client: &LogseqClient, before: &str, after: &str) -> Result<Value, ToolError> {
    let prose = check_prose(before, after);
    let brackets = check_brackets(after);
    let refs_preserved = check_refs_preserved(before, after);

    let mut terms: Vec<String> = link_counts(after).into_iter().map(|(term, _)| term).collect();
    terms.sort();
    let distinct_keys: std::collections::HashSet<String> = terms.iter().map(|term| key_of(term)).collect();
    if distinct_keys.len() > MAX_LINK_TERMS {
        return Err(ToolError::InvalidParameter(InvalidParameter {
            param: "after".to_owned(),
            value: format!("{} distinct [[terms]]", distinct_keys.len()),
            expected: format!("at most {MAX_LINK_TERMS} distinct [[terms]]. Check the text in parts"),
            example: None,
        }));
    }
    // Preexisting: linked before, and no copy added (check 4 rules out fewer)
    let refs_before: std::collections::HashMap<String, usize> = key_counts(before).into_iter().collect();
    let refs_after: std::collections::HashMap<String, usize> = key_counts(after).into_iter().collect();
    let preexisting = |term: &str| {
        let was = refs_before.get(&key_of(term)).copied().unwrap_or(0);
        // `term` is in `after`, so its count there is at least 1: `<= was` already means `was >= 1`
        refs_after.get(&key_of(term)).copied().unwrap_or(0) <= was
    };

    let names: Vec<&str> = terms.iter().map(String::as_str).collect();
    let targets = resolve_link_targets(client, &names).await?;
    let mut warnings: Vec<ResultWarning> = Vec::new();
    let mut resolved: Vec<ResolvedRef> = Vec::new();
    let mut unresolved: Vec<&str> = Vec::new();
    let mut ambiguous: Vec<AmbiguousRef> = Vec::new();
    let mut ambiguous_all_preexisting = true;

    if targets.unavailable {
        warnings.push(ResultWarning::new(
            "refs_unchecked",
            format!(
                "LogSeq returned no answer for the {} [[terms]], so none could be checked. \
                 This is not the same as missing pages: check that a graph is open and call again.",
                terms.len()
            ),
        ));
    } else {
        for term in &terms {
            match targets.resolutions.get(&link_key(term)).unwrap_or(&Resolution::NotFound) {
                Resolution::Found(page) => resolved.push(ResolvedRef {
                    term,
                    page: &page.original_name,
                    matched_by: if page.matched_by == MatchedBy::Alias { "alias" } else { "name" },
                }),
                Resolution::Ambiguous(found) => {
                    let existing = preexisting(term);
                    ambiguous_all_preexisting &= existing;
                    ambiguous.push(AmbiguousRef {
                        term,
                        candidates: found.candidates.iter().map(|candidate| candidate.original_name.as_str()).collect(),
                        total_candidates: found.total_candidates,
                        preexisting: existing,
                    });
                    if found.total_candidates > found.candidates.len() {
                        warnings.push(ResultWarning::new(
                            "candidates_truncated",
                            format!(
                                "[[{term}]] is an alias of {} pages. Showing {}, the most this lists; the rest can't be fetched in one call.",
                                found.total_candidates,
                                found.candidates.len()
                            ),
                        ));
                    }
                }
                Resolution::NotFound => unresolved.push(term),
            }
        }
    }
    let refs_ok = !targets.unavailable && unresolved.is_empty() && ambiguous_all_preexisting;

    Ok(result_value(&CheckLinksOutput {
        // `buildResultMeta`: `hasMore` follows the warnings. None of these warnings offers a way to fetch more.
        has_more: warnings.iter().any(|warning| warning.how_to_fetch_all.is_some()),
        warnings: &warnings,
        totals: RefTotals { refs_before: count_of(before, "[["), refs_after: brackets.opens, terms: terms.len() },
        ok: prose.ok && brackets.ok && refs_ok && refs_preserved.ok,
        prose: &prose,
        brackets: &brackets,
        refs: RefsCheck { ok: refs_ok, resolved, unresolved, ambiguous },
        refs_preserved: &refs_preserved,
    }))
}

/// A `[[term]]` that names one page: the term as written, the page it reaches and how.
#[derive(Serialize)]
struct ResolvedRef<'a> {
    term: &'a str,
    page: &'a str,
    #[serde(rename = "matchedBy")]
    matched_by: &'static str,
}

/// A `[[term]]` that several pages answer to, and whether it was already a link before the pass.
#[derive(Serialize)]
struct AmbiguousRef<'a> {
    term: &'a str,
    candidates: Vec<&'a str>,
    #[serde(rename = "totalCandidates")]
    total_candidates: usize,
    preexisting: bool,
}

/// Check 3: every `[[term]]` in `after` names one page or alias.
#[derive(Serialize)]
struct RefsCheck<'a> {
    ok: bool,
    resolved: Vec<ResolvedRef<'a>>,
    unresolved: Vec<&'a str>,
    ambiguous: Vec<AmbiguousRef<'a>>,
}

/// How much was checked.
#[derive(Serialize)]
struct RefTotals {
    #[serde(rename = "refsBefore")]
    refs_before: usize,
    #[serde(rename = "refsAfter")]
    refs_after: usize,
    terms: usize,
}

/// A result as written, in BR-0013's order: what must not be missed (`hasMore`, `warnings`, `totals`, then the
/// verdict `ok`), then the four checks.
#[derive(Serialize)]
struct CheckLinksOutput<'a> {
    #[serde(rename = "hasMore")]
    has_more: bool,
    warnings: &'a [ResultWarning],
    totals: RefTotals,
    ok: bool,
    prose: &'a ProseCheck,
    brackets: &'a BracketCheck,
    refs: RefsCheck<'a>,
    #[serde(rename = "refsPreserved")]
    refs_preserved: &'a RefsPreservedCheck,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_result_says_what_may_be_missing_and_the_verdict_before_the_four_checks() {
        use crate::tool::testing::keys;
        let ambiguous = AmbiguousRef { term: "al", candidates: vec!["Alice", "Alan"], total_candidates: 2, preexisting: false };
        let output = CheckLinksOutput {
            has_more: false,
            warnings: &[],
            totals: RefTotals { refs_before: 0, refs_after: 1, terms: 1 },
            ok: false,
            prose: &check_prose("a", "a"),
            brackets: &check_brackets("[[a]]"),
            refs: RefsCheck {
                ok: false,
                resolved: vec![ResolvedRef { term: "a", page: "A", matched_by: "name" }],
                unresolved: vec!["gone"],
                ambiguous: vec![ambiguous],
            },
            refs_preserved: &check_refs_preserved("", ""),
        };
        let value = result_value(&output);
        assert_eq!(keys(&value), ["hasMore", "warnings", "totals", "ok", "prose", "brackets", "refs", "refsPreserved"]);
        assert_eq!(keys(&value["totals"]), ["refsBefore", "refsAfter", "terms"]);
        assert_eq!(keys(&value["refs"]), ["ok", "resolved", "unresolved", "ambiguous"]);
        assert_eq!(keys(&value["refs"]["resolved"][0]), ["term", "page", "matchedBy"]);
        assert_eq!(keys(&value["refs"]["ambiguous"][0]), ["term", "candidates", "totalCandidates", "preexisting"]);
        assert_eq!(js::json_stringify(&value["refs"]["unresolved"]), r#"["gone"]"#);
    }

    fn read(value: Value) -> Result<Args, ToolError> {
        read_args(value.as_object())
    }

    #[test]
    fn both_texts_are_required_and_before_is_read_first() {
        assert_eq!(read(json!({"before": "", "after": ""})).unwrap(), Args { before: String::new(), after: String::new() });
        assert_eq!(
            read(json!({"after": 1})).unwrap_err().to_string(),
            "Invalid parameter 'before': missing\n\nExpected: a string (required)\nExample: before: \"...\""
        );
        assert_eq!(
            read(json!({"before": "a", "after": null})).unwrap_err().to_string(),
            "Invalid parameter 'after': missing\n\nExpected: a string (required)\nExample: after: \"...\""
        );
    }

    #[test]
    fn a_text_over_the_cap_is_zods_too_big_and_the_cap_counts_utf16_units() {
        let long = "x".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(
            read(json!({"before": long, "after": ""})).unwrap_err().to_string(),
            format!("Invalid parameter 'before': \"{long}\"\n\nExpected: Too big: expected string to have <=50000 characters")
        );
        assert!(read(json!({"before": "x".repeat(MAX_TEXT_CHARS), "after": ""})).is_ok());
        // 25,001 emoji are 50,002 units
        let emoji = "\u{1F600}".repeat(25_001);
        assert_eq!(
            read(json!({"before": "", "after": emoji})).unwrap_err().to_string(),
            format!("Invalid parameter 'after': \"{emoji}\"\n\nExpected: Too big: expected string to have <=50000 characters")
        );
        assert!(read(json!({"before": "", "after": "\u{1F600}".repeat(25_000)})).is_ok());
    }

    #[test]
    fn the_check_links_schema_means_what_the_typescript_one_means() {
        use crate::tool::testing::{meaning, schema_of};
        // `inputSchema` of logseq_check_links in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "before": {"type": "string", "maxLength": 50000, "description": "Text before linking"},
                "after": {"type": "string", "maxLength": 50000, "description": "before plus [[links]], at most 500 distinct terms"},
            },
            "required": ["before", "after"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_check_links_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Check Links"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Check Links", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }
}
