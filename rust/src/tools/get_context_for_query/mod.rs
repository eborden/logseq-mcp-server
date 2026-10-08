//! `logseq_get_context_for_query` (the Rust side of `src/tools/get-context-for-query.ts`): context
//! for a natural-language question. Its `[[page]]` and `#tag` topics each get a
//! `logseq_build_context` (with the caps 10 blocks, 5 related pages and 10 references), and a query
//! that names none is searched for its first three words over three letters instead.
//!
//! Calls: for each topic (at most `max_topics`), what `build_context` makes; a topic with no page
//! or an ambiguous name is skipped, with a warning, and costs the resolver and the suggestion
//! lookup. For a query with no topic and at least one keyword: 1 query (the block search for the
//! longest keyword, cut here to the blocks that hold every keyword), and 1 more with
//! `format: "markdown"` for the pages of the hits kept (none when there are no hits).
//!
//! `format: "markdown"` renders the result through [`crate::markdown_context`], its warnings and
//! `hasMore` in a footer. `compact` reduces every block to its snippet and uuid ([`crate::compact`]).

use std::collections::HashSet;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::Arguments;
use crate::client::LogseqClient;
use crate::compact::compact_query_context;
use crate::errors::ToolError;
use crate::js;
use crate::markdown::{FooterMeta, with_footer};
use crate::markdown_context::render_query_context;
use crate::meta::candidate;
use crate::output_format::OutputFormat;
use crate::tool::{input_schema, read_only_annotations, success_result};
use crate::tools::build_context::{Caps, TopicContext, build_context_for_topic};
use crate::tools::search_blocks::{find_blocks, full_blocks_with_context};
use crate::truncation::{CappedTruncation, capped_truncation_warning};

pub const NAME: &str = "logseq_get_context_for_query";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "Context for a natural-language question. Takes [[page]] and #tag topics from the query, else searches its first 3 words over 3 letters (max 100 hits), and builds context for each.\n\n\
**Can't find:** meaning, or over 100 keyword hits (put specific words first). Topics come from links, tags or literal words, so put page names in [[brackets]].\n\
**Alternatives:** logseq_build_context for one known topic.";

/// Topics the query's `[[refs]]` and `#tags` are cut to when `max_topics` is absent.
pub const DEFAULT_MAX_TOPICS: u64 = 5;
/// Keyword hits kept when `max_search_results` is absent.
pub const DEFAULT_MAX_SEARCH_RESULTS: u64 = 20;

/// Most keyword hits one call returns (#61). A larger `max_search_results` is clamped to it, and a
/// cut at the maximum is reported by a `search_results_truncated` warning with no `howToFetchAll`.
pub const MAX_SEARCH_RESULTS: u64 = 100;

/// How to reach hits past the maximum: no parameter fetches them.
const NARROWER: &str = "Put the most specific words first: only the first three words longer than three letters, other than stop words, are searched.";

/// The caps each topic's context is built under.
const TOPIC_CAPS: Caps = Caps { max_blocks: 10, max_related_pages: 5, max_references: 10, include_temporal_context: true, resolve_refs: false };

/// Words a keyword search leaves out.
const COMMON_WORDS: &[&str] = &[
    "what", "when", "where", "who", "why", "how", "the", "a", "an", "is", "are", "was", "were", "do", "does", "did", "can", "could", "should", "would", "in",
    "on", "at", "to", "for", "of", "with", "about", "by",
];

fn default_max_topics() -> u32 {
    DEFAULT_MAX_TOPICS as u32
}

fn default_max_search_results() -> u32 {
    DEFAULT_MAX_SEARCH_RESULTS as u32
}

/// The tool's arguments, as `tools/list` shows them. The schema is generated from this type
/// (ADR-0019); a call reads its arguments through [`Arguments`], which words a bad one as the
/// TypeScript server does. Unknown fields are ignored, as every TypeScript tool ignores them.
#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)]
pub struct Args {
    /// Natural language query (can include [[page references]] and #tags)
    pub query: String,
    /// Maximum number of topics to extract context for (default: 5)
    #[serde(default = "default_max_topics")]
    #[schemars(range(min = 1))]
    pub max_topics: u32,
    /// Maximum number of search results for queries without explicit topics (default: 20, max: 100)
    #[serde(default = "default_max_search_results")]
    pub max_search_results: u32,
    /// json (default), or markdown text. Markdown has block uuids only on search hits and with compact
    pub format: Option<OutputFormat>,
    /// Block snippets and uuids, no bodies. Read one with logseq_get_block
    #[serde(default)]
    pub compact: bool,
}

/// What a call asked for, read from the arguments in the order the schema lists them, so the first
/// one that is wrong is the one reported, as `parseArgs` does.
#[derive(Debug, PartialEq)]
struct Request {
    query: String,
    max_topics: u64,
    max_search_results: u64,
    format: Option<OutputFormat>,
    compact: bool,
}

fn read_args(arguments: Option<&JsonObject>) -> Result<Request, ToolError> {
    let read = Arguments::new(arguments);
    Ok(Request {
        query: read.required_string("query")?,
        // The tool slices with max_topics, so 0 would keep no topic at all (#293)
        max_topics: read.count_or("max_topics", 1, DEFAULT_MAX_TOPICS)?,
        max_search_results: read.count_or("max_search_results", 0, DEFAULT_MAX_SEARCH_RESULTS)?,
        format: OutputFormat::read(&read)?,
        compact: read.boolean("compact", false)?,
    })
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Context for Query")
        .with_annotations(read_only_annotations("Get Context for Query"))
}

/// A call: arguments read, the context, then JSON, compact JSON or Markdown. This tool makes no tips.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let request = read_args(arguments.as_ref())?;
    // Markdown names the page of each keyword hit; JSON hits keep their shape
    let hit_pages = request.format == Some(OutputFormat::Markdown);
    let context = get_context_for_query(client, &request.query, request.max_topics, request.max_search_results, hit_pages).await?;
    let result = context.to_value();
    if request.format == Some(OutputFormat::Markdown) {
        let body = render_query_context(&result, request.compact);
        return Ok(success_result(vec![ContentBlock::text(with_footer(body, &FooterMeta::of_result(&result, &[])))]));
    }
    let shown = if request.compact { compact_query_context(&result) } else { result };
    Ok(success_result(vec![ContentBlock::text(js::json_stringify(&shown))]))
}

/// A query's context (`QueryContext`). Each topic's `hasMore`, `warnings` and `totals` are not
/// repeated: its advice names `logseq_build_context` parameters, so it is rolled up into `warnings`.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryContext {
    pub query: String,
    pub extracted_topics: Vec<String>,
    pub contexts: Vec<TopicContext>,
    /// The keyword hits, when the query named no topic and had a keyword to search
    pub search_results: Option<Vec<Value>>,
    /// Each as the TypeScript object is written (`QueryWarning`): `topic`, `candidates` and
    /// `totalCandidates` only where they apply
    pub warnings: Vec<Value>,
}

impl QueryContext {
    /// `hasMore`: some warning says how to fetch what it cut.
    pub fn has_more(&self) -> bool {
        self.warnings.iter().any(|warning| warning.get("howToFetchAll").is_some())
    }

    /// `summary.totalBlocks`: the blocks of every topic, then the keyword hits.
    fn total_blocks(&self) -> usize {
        self.contexts.iter().map(|context| context.direct_blocks.len()).sum::<usize>() + self.search_results.as_ref().map_or(0, Vec::len)
    }

    /// `summary.totalPages`: the distinct pages, by `id`, among every topic's page and related pages.
    fn total_pages(&self) -> usize {
        let id = |page: &Value| page.get("id").and_then(crate::wire::whole_number);
        let mut pages = HashSet::new();
        for context in &self.contexts {
            pages.insert(id(&context.main_page));
            pages.extend(context.related_pages.iter().map(id));
        }
        pages.len()
    }

    /// The result as the TypeScript object is written: `query`, `extractedTopics`, `contexts`,
    /// `searchResults`, `warnings`, `hasMore`, `summary`.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("query".into(), json!(self.query));
        out.insert("extractedTopics".into(), json!(self.extracted_topics));
        // PARITY(#299): a topic's own warnings are dropped here, and only `topic_truncated` says it was cut, so the
        // `alias_set_truncated` warning of a topic whose alias group was cut is never shown (suspected TS bug) —
        // drop if Rust becomes the only server.
        out.insert("contexts".into(), Value::Array(self.contexts.iter().map(|context| context.to_value(false)).collect()));
        if let Some(results) = &self.search_results {
            out.insert("searchResults".into(), Value::Array(results.clone()));
        }
        out.insert("warnings".into(), Value::Array(self.warnings.clone()));
        out.insert("hasMore".into(), json!(self.has_more()));
        out.insert(
            "summary".into(),
            json!({"totalTopics": self.contexts.len(), "totalBlocks": self.total_blocks(), "totalPages": self.total_pages()}),
        );
        Value::Object(out)
    }
}

/// `extractTopicsFromQuery`, the `[[page references]]`: the text between `[[` and `]]`, at least one
/// character, none of them `]`.
fn page_refs(query: &str) -> Vec<&str> {
    let bytes = query.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at + 1 < bytes.len() {
        if bytes[at] == b'[' && bytes[at + 1] == b'[' {
            let start = at + 2;
            // `[^\]]+` runs to the next `]`, which must start the closing `]]`
            if let Some(end) = bytes[start..].iter().position(|&byte| byte == b']').map(|offset| start + offset) {
                if end > start && bytes.get(end + 1) == Some(&b']') {
                    found.push(&query[start..end]);
                    at = end + 2;
                    continue;
                }
            }
        }
        at += 1;
    }
    found
}

/// `extractTopicsFromQuery`, the `#tags`: the text after a `#`, at least one character, none of them
/// whitespace or `#`.
fn tags(query: &str) -> Vec<&str> {
    let bytes = query.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'#' {
            let start = at + 1;
            let end = query[start..].char_indices().find(|&(_, c)| c == '#' || js::is_js_space(c)).map_or(query.len(), |(offset, _)| start + offset);
            if end > start {
                found.push(&query[start..end]);
                at = end;
                continue;
            }
        }
        at += 1;
    }
    found
}

/// `extractTopicsFromQuery`: the `[[page references]]`, then the `#tags`, each once, first seen first.
fn extract_topics(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    page_refs(query).into_iter().chain(tags(query)).filter(|topic| seen.insert(*topic)).map(str::to_owned).collect()
}

/// The words a keyword search looks for: the first three words of the query, lowercased, longer
/// than three letters (UTF-16 code units, as `length` counts them) and not stop words.
fn keywords(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split(js::is_js_space)
        .filter(|word| js::utf16(word).len() > 3 && !COMMON_WORDS.contains(word))
        .take(3)
        .map(str::to_owned)
        .collect()
}

/// A warning object, keys in the order given.
fn warning(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(entries.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn topic_warning(context: &TopicContext, topic: &str) -> Value {
    let totals = context.totals;
    warning(vec![
        ("code", json!("topic_truncated")),
        ("topic", json!(topic)),
        (
            "message",
            json!(format!(
                "Context for \"{topic}\" is capped: showing {}/{} blocks, {}/{} references, {}/{} related pages.",
                context.direct_blocks.len(),
                totals.blocks,
                context.references.len(),
                totals.references,
                context.related_pages.len(),
                totals.related_pages
            )),
        ),
        (
            "howToFetchAll",
            json!(format!(
                "Call logseq_build_context with topic_name {} and raise max_blocks ({}), max_references ({}) and max_related_pages ({}).",
                js::json_stringify(&json!(topic)),
                totals.blocks,
                totals.references,
                totals.related_pages
            )),
        ),
    ])
}

/// `getContextForQuery`: the context for a natural-language query.
///
/// `max_topics` cuts the topics extracted (at least 1). `max_search_results` is the keyword hits
/// kept (clamped to [`MAX_SEARCH_RESULTS`]; a cut adds a `search_results_truncated` warning, and
/// one at the maximum has no `howToFetchAll`, so it doesn't set `hasMore`, BR-0006). `hit_pages`
/// adds each keyword hit's page (`context.page`) in one extra batched query, for output that names
/// the page of a hit, such as Markdown (#43).
///
/// A topic with no page, or an ambiguous name, is skipped with a warning. Anything else that goes
/// wrong (connection, timeout, auth, an answer this server can't read) propagates.
pub async fn get_context_for_query(
    client: &LogseqClient,
    query: &str,
    max_topics: u64,
    max_search_results: u64,
    hit_pages: bool,
) -> Result<QueryContext, ToolError> {
    let extracted_topics = extract_topics(query);
    let mut contexts = Vec::new();
    let mut warnings: Vec<Value> = Vec::new();

    if extracted_topics.len() as u64 > max_topics {
        warnings.push(warning(vec![
            ("code", json!("topics_truncated")),
            ("message", json!(format!("Found {} topics; only the first {max_topics} were used.", extracted_topics.len()))),
            ("howToFetchAll", json!(format!("Set max_topics to {} (or higher) to use all of them.", extracted_topics.len()))),
        ]));
    }

    for topic in extracted_topics.iter().take(max_topics as usize) {
        match build_context_for_topic(client, topic, TOPIC_CAPS).await {
            Ok(context) => {
                if context.has_more() {
                    warnings.push(topic_warning(&context, topic));
                }
                contexts.push(context);
            }
            // A missing topic page is an expected partial result: skip it and say so. Everything else
            // (connection, timeout, auth, unexpected) propagates.
            Err(ToolError::PageNotFound(_)) => warnings.push(warning(vec![
                ("code", json!("topic_not_found")),
                ("topic", json!(topic)),
                ("message", json!(format!("No page found for topic \"{topic}\"; it was skipped."))),
            ])),
            // An ambiguous topic is skipped the same way, but its candidates are kept so the caller can
            // retry logseq_build_context with the one it means.
            Err(ToolError::AmbiguousPage(ambiguous)) => {
                warnings.push(warning(vec![
                    ("code", json!("ambiguous_page")),
                    ("message", json!(ambiguous.to_string())),
                    ("topic", json!(topic)),
                    ("candidates", Value::Array(ambiguous.candidates.iter().map(candidate).collect())),
                    ("totalCandidates", json!(ambiguous.total_candidates)),
                ]));
                // A cut list is reported by a warning, not by hasMore: no parameter fetches the rest
                if let Some(note) = ambiguous.truncation_note() {
                    warnings.push(warning(vec![("code", json!("candidates_truncated")), ("topic", json!(topic)), ("message", json!(note))]));
                }
            }
            Err(error) => return Err(error),
        }
    }

    // With no explicit topics, do a text search
    let mut search_results = None;
    if extracted_topics.is_empty() {
        let keywords = keywords(query);
        if !keywords.is_empty() {
            // Search for one keyword and keep the blocks holding every keyword. The one query returns
            // every match, so nothing is cut before the filter (no extra call) and the count of hits
            // below is the real total (#61). The longest keyword (the first of equal length) is usually
            // the rarest, so LogSeq sends back fewer blocks than for a common first word. The hits are
            // the same whichever keyword is searched, since the filter needs all of them, and so is their
            // order: the search sorts newest first and the filter keeps it. The search is the only data
            // source on this path, so any failure propagates: an empty result must mean "nothing matched".
            let searched = keywords.iter().fold(&keywords[0], |longest, keyword| if js::utf16(keyword).len() > js::utf16(longest).len() { keyword } else { longest });
            // PARITY(#299): a `null` answer is read as "no matches", so a search LogSeq didn't answer looks like
            // one that found nothing (suspected TS bug, BR-0011) — fix per #338, in both servers.
            let blocks = find_blocks(client, searched).await?.unwrap_or_default();
            let hits: Vec<Value> = blocks
                .into_iter()
                .filter(|block| {
                    let content = block.get("content").and_then(Value::as_str).unwrap_or("").to_lowercase();
                    keywords.iter().all(|keyword| content.contains(keyword.as_str()))
                })
                .collect();

            let kept_count = (max_search_results.min(MAX_SEARCH_RESULTS) as usize).min(hits.len());
            if hits.len() > kept_count {
                warnings.push(
                    serde_json::to_value(capped_truncation_warning(CappedTruncation {
                        what: "keyword hits",
                        shown: kept_count,
                        total: hits.len(),
                        param: "max_search_results",
                        max: MAX_SEARCH_RESULTS as usize,
                        narrower: NARROWER,
                        requested: Some(max_search_results),
                        code: "search_results_truncated",
                        inline_max: None,
                        paging: None,
                    }))
                    .expect("a warning serializes"),
                );
            }
            let kept: Vec<Value> = hits.into_iter().take(kept_count).collect();

            // Pages only for the hits kept: one batched lookup
            search_results = Some(if hit_pages { full_blocks_with_context(client, kept).await? } else { kept });
        }
    }

    Ok(QueryContext { query: query.to_owned(), extracted_topics, contexts, search_results, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};

    fn args(value: Value) -> Option<JsonObject> {
        value.as_object().cloned()
    }

    #[test]
    fn the_query_schema_means_what_the_typescript_one_means() {
        // `inputSchema` of logseq_get_context_for_query in the ADR-0016 snapshot
        let typescript = json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language query (can include [[page references]] and #tags)"},
                "max_topics": {"type": "integer", "minimum": 1, "default": 5, "description": "Maximum number of topics to extract context for (default: 5)"},
                "max_search_results": {"type": "integer", "minimum": 0, "default": 20, "description": "Maximum number of search results for queries without explicit topics (default: 20, max: 100)"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
                "compact": {"type": "boolean", "default": false, "description": "Block snippets and uuids, no bodies. Read one with logseq_get_block"},
            },
            "required": ["query"],
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_tool_is_read_only_and_titled_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Context for Query"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Context for Query", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_a_topic_count_below_one_is_refused() {
        let request = read_args(args(json!({"query": "q", "max_search_results": 0})).as_ref()).unwrap();
        assert_eq!((request.max_topics, request.max_search_results, request.compact), (5, 0, false));
        let error = read_args(args(json!({"query": "q", "max_topics": 0, "max_search_results": -1})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'max_topics': 0"), "{error}");
        let error = read_args(args(json!({"query": "q", "compact": "yes"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'compact': \"yes\""), "{error}");
        let error = read_args(args(json!({})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'query': missing"), "{error}");
    }

    #[test]
    fn topics_are_the_page_references_then_the_tags_each_once() {
        // the comma after a tag is part of it, as the regex `[^\s#]+` has it
        assert_eq!(extract_topics("what about [[Atlas]] and #beta, [[Bob Smith]] #beta [[Atlas]] #gamma#delta"), ["Atlas", "Bob Smith", "beta,", "beta", "gamma", "delta"]);
        assert_eq!(extract_topics("nothing here"), Vec::<String>::new());
    }

    #[test]
    fn a_page_reference_is_one_or_more_characters_up_to_a_closing_pair() {
        assert_eq!(page_refs("[[a]] [[b c]]"), ["a", "b c"]);
        // an empty one, an unclosed one and one with a lone `]` before the pair are not references
        assert_eq!(page_refs("[[]] [[open [[x]b]]"), Vec::<&str>::new());
        // a `[` inside is part of the name
        assert_eq!(page_refs("[[[a]]"), ["[a"]);
        assert_eq!(page_refs("[[a]]]"), ["a"]);
        assert_eq!(page_refs("[[caf\u{e9}]]"), ["caf\u{e9}"]);
    }

    #[test]
    fn a_tag_runs_to_whitespace_or_the_next_hash() {
        assert_eq!(tags("#a #b-c, # d #\u{e9}t\u{e9}\n#e"), ["a", "b-c,", "\u{e9}t\u{e9}", "e"]);
        assert_eq!(tags("###"), Vec::<&str>::new());
        assert_eq!(tags("end#"), Vec::<&str>::new());
        assert_eq!(tags("a#b#c"), ["b", "c"]);
    }

    #[test]
    fn keywords_are_the_first_three_long_words_that_are_not_stop_words() {
        assert_eq!(keywords("What does the Importer do about Retries and Timeouts today"), ["importer", "retries", "timeouts"]);
        assert_eq!(keywords("how is it"), Vec::<String>::new());
        // a word of three letters is out, however it is spaced
        assert_eq!(keywords("abc\u{a0}abcd  efgh"), ["abcd", "efgh"]);
        // length counts UTF-16 code units: two emoji are four of them
        assert_eq!(keywords("\u{1F680}\u{1F680} xyz"), ["\u{1F680}\u{1F680}"]);
    }

    #[test]
    fn the_longest_keyword_is_searched_and_the_first_of_equal_length() {
        let words = ["long".to_owned(), "longer".to_owned(), "second".to_owned()];
        let searched = words.iter().fold(&words[0], |longest, keyword| if js::utf16(keyword).len() > js::utf16(longest).len() { keyword } else { longest });
        assert_eq!(searched, "longer");
    }

    #[test]
    fn a_capped_topic_names_what_was_cut_and_how_to_get_it() {
        let context = TopicContext {
            topic: "Atlas".into(),
            resolved_from: None,
            resolved_aliases: None,
            main_page: json!({"id": 1}),
            direct_blocks: vec![json!({}); 10],
            related_pages: vec![json!({}); 5],
            references: vec![json!({}); 10].into_iter().map(|block| crate::tools::build_context::Reference { block, source_page: json!({}) }).collect(),
            temporal_context: None,
            warnings: Vec::new(),
            totals: crate::tools::build_context::Totals { blocks: 12, related_pages: 5, references: 30 },
        };
        assert_eq!(
            js::json_stringify(&topic_warning(&context, "Atlas \"x\"")),
            concat!(
                r#"{"code":"topic_truncated","topic":"Atlas \"x\"","message":"Context for \"Atlas \"x\"\" is capped: showing 10/12 blocks, 10/30 references, 5/5 related pages.","#,
                r#""howToFetchAll":"Call logseq_build_context with topic_name \"Atlas \\\"x\\\"\" and raise max_blocks (12), max_references (30) and max_related_pages (5)."}"#
            )
        );
    }
}
