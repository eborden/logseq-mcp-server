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
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::args::Arguments;
use crate::client::LogseqClient;
use crate::compact::compact_query_context;
use crate::errors::{Candidate, ToolError};
use crate::js;
use crate::markdown::{FooterMeta, with_footer};
use crate::markdown_context::render_query_context;
use crate::meta::ResultWarning;
use crate::output_format::OutputFormat;
use crate::tool::{input_schema, read_only_annotations, result_value, success_result};
use crate::tools::build_context::{Caps, TopicContext, TopicContextOutput, build_context_for_topic};
use crate::tools::search_blocks::{find_blocks, full_blocks_with_context, hit_pages_unavailable};
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

/// A warning of a query's result (`QueryWarning`): `code` and `message` first, then the detail (`topic`, and for
/// an ambiguous topic its `candidates`), then the remedy (`howToFetchAll`), each only where it applies (BR-0013).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueryWarning {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<Candidate>>,
    #[serde(rename = "totalCandidates", skip_serializing_if = "Option::is_none")]
    pub total_candidates: Option<usize>,
    #[serde(rename = "howToFetchAll", skip_serializing_if = "Option::is_none")]
    pub how_to_fetch_all: Option<String>,
}

impl QueryWarning {
    fn new(code: &str, message: String) -> Self {
        QueryWarning { code: code.to_owned(), message, topic: None, candidates: None, total_candidates: None, how_to_fetch_all: None }
    }

    fn about(mut self, topic: &str) -> Self {
        self.topic = Some(topic.to_owned());
        self
    }

    fn how_to_fetch_all(mut self, how: String) -> Self {
        self.how_to_fetch_all = Some(how);
        self
    }
}

impl From<ResultWarning> for QueryWarning {
    fn from(warning: ResultWarning) -> Self {
        QueryWarning { how_to_fetch_all: warning.how_to_fetch_all, ..QueryWarning::new(&warning.code, warning.message) }
    }
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
    pub warnings: Vec<QueryWarning>,
}

/// What the result holds (`summary`): the topics, the blocks of every topic and the hits, the distinct pages.
#[derive(Serialize)]
struct QuerySummary {
    #[serde(rename = "totalTopics")]
    total_topics: usize,
    #[serde(rename = "totalBlocks")]
    total_blocks: usize,
    #[serde(rename = "totalPages")]
    total_pages: usize,
}

/// A query's result as written, in BR-0013's order: what was answered (`query`, `extractedTopics`), what must not
/// be missed (`hasMore`, `warnings`, `summary`), then the data (`contexts`, `searchResults`).
#[derive(Serialize)]
struct QueryContextOutput<'a> {
    query: &'a str,
    #[serde(rename = "extractedTopics")]
    extracted_topics: &'a [String],
    #[serde(rename = "hasMore")]
    has_more: bool,
    warnings: &'a [QueryWarning],
    summary: QuerySummary,
    // PARITY(#299): a topic's own warnings are dropped here, and only `topic_truncated` says it was cut, so the
    // `alias_set_truncated` warning of a topic whose alias group was cut is never shown (suspected TS bug) —
    // drop if Rust becomes the only server.
    contexts: Vec<TopicContextOutput<'a>>,
    #[serde(rename = "searchResults", skip_serializing_if = "Option::is_none")]
    search_results: Option<&'a [Value]>,
}

impl QueryContext {
    /// `hasMore`: some warning says how to fetch what it cut.
    pub fn has_more(&self) -> bool {
        self.warnings.iter().any(|warning| warning.how_to_fetch_all.is_some())
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

    /// The result in BR-0013's key order.
    pub fn to_value(&self) -> Value {
        result_value(&QueryContextOutput {
            query: &self.query,
            extracted_topics: &self.extracted_topics,
            has_more: self.has_more(),
            warnings: &self.warnings,
            summary: QuerySummary { total_topics: self.contexts.len(), total_blocks: self.total_blocks(), total_pages: self.total_pages() },
            contexts: self.contexts.iter().map(|context| context.output(false)).collect(),
            search_results: self.search_results.as_deref(),
        })
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

/// The warning for a topic whose context was cut by `TOPIC_CAPS`: what was cut, and the `logseq_build_context` call
/// that fetches it.
fn topic_warning(context: &TopicContext, topic: &str) -> QueryWarning {
    let totals = context.totals;
    QueryWarning::new(
        "topic_truncated",
        format!(
            "Context for \"{topic}\" is capped: showing {}/{} blocks, {}/{} references, {}/{} related pages.",
            context.direct_blocks.len(),
            totals.blocks,
            context.references.len(),
            totals.references,
            context.related_pages.len(),
            totals.related_pages
        ),
    )
    .about(topic)
    .how_to_fetch_all(format!(
        "Call logseq_build_context with topic_name {} and raise max_blocks ({}), max_references ({}) and max_related_pages ({}).",
        js::json_stringify(&json!(topic)),
        totals.blocks,
        totals.references,
        totals.related_pages
    ))
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
    let mut warnings: Vec<QueryWarning> = Vec::new();

    if extracted_topics.len() as u64 > max_topics {
        warnings.push(
            QueryWarning::new("topics_truncated", format!("Found {} topics; only the first {max_topics} were used.", extracted_topics.len()))
                .how_to_fetch_all(format!("Set max_topics to {} (or higher) to use all of them.", extracted_topics.len())),
        );
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
            Err(ToolError::PageNotFound(_)) => {
                warnings.push(QueryWarning::new("topic_not_found", format!("No page found for topic \"{topic}\"; it was skipped.")).about(topic))
            }
            // An ambiguous topic is skipped the same way, but its candidates are kept so the caller can
            // retry logseq_build_context with the one it means.
            Err(ToolError::AmbiguousPage(ambiguous)) => {
                warnings.push(QueryWarning {
                    candidates: Some(ambiguous.candidates.clone()),
                    total_candidates: Some(ambiguous.total_candidates),
                    ..QueryWarning::new("ambiguous_page", ambiguous.to_string()).about(topic)
                });
                // A cut list is reported by a warning, not by hasMore: no parameter fetches the rest
                if let Some(note) = ambiguous.truncation_note() {
                    warnings.push(QueryWarning::new("candidates_truncated", note).about(topic));
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
                    capped_truncation_warning(CappedTruncation {
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
                    })
                    .into(),
                );
            }
            let kept: Vec<Value> = hits.into_iter().take(kept_count).collect();

            // Pages only for the hits kept: one batched lookup
            search_results = Some(if hit_pages {
                let (with_pages, pages_unavailable) = full_blocks_with_context(client, kept).await?;
                if pages_unavailable {
                    warnings.push(hit_pages_unavailable(with_pages.len()).into());
                }
                with_pages
            } else {
                kept
            });
        }
    }

    Ok(QueryContext { query: query.to_owned(), extracted_topics, contexts, search_results, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{keys, meaning, schema_of};

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
            js::json_stringify(&result_value(&topic_warning(&context, "Atlas \"x\""))),
            concat!(
                r#"{"code":"topic_truncated","message":"Context for \"Atlas \"x\"\" is capped: showing 10/12 blocks, 10/30 references, 5/5 related pages.","#,
                r#""topic":"Atlas \"x\"","#,
                r#""howToFetchAll":"Call logseq_build_context with topic_name \"Atlas \\\"x\\\"\" and raise max_blocks (12), max_references (30) and max_related_pages (5)."}"#
            )
        );
    }

    #[test]
    fn a_warning_says_what_it_is_first_then_the_detail_then_the_remedy() {
        let candidate = Candidate { name: "alice".into(), original_name: "Alice".into(), matched_by: crate::errors::MatchedBy::Alias, reason: "r".into() };
        let every_key = QueryWarning {
            candidates: Some(vec![candidate]),
            total_candidates: Some(1),
            ..QueryWarning::new("c", "m".into()).about("t").how_to_fetch_all("h".into())
        };
        assert_eq!(keys(&result_value(&every_key)), ["code", "message", "topic", "candidates", "totalCandidates", "howToFetchAll"]);
        assert_eq!(keys(&result_value(&QueryWarning::new("c", "m".into()))), ["code", "message"]);
        assert_eq!(keys(&result_value(&QueryWarning::new("c", "m".into()).about("t"))), ["code", "message", "topic"]);
        // a candidate page keeps its identity first
        let ambiguous = result_value(&every_key);
        assert_eq!(keys(&ambiguous["candidates"][0]), ["name", "originalName", "matchedBy", "reason"]);
        // a warning that came from a result's own meta carries no topic
        let from_meta: QueryWarning = ResultWarning { how_to_fetch_all: Some("h".into()), ..ResultWarning::new("c", "m".into()) }.into();
        assert_eq!(keys(&result_value(&from_meta)), ["code", "message", "howToFetchAll"]);
    }

    fn topic(name: &str, id: i64) -> TopicContext {
        TopicContext {
            topic: name.into(),
            resolved_from: None,
            resolved_aliases: None,
            main_page: json!({"id": id}),
            direct_blocks: vec![json!({"id": 5})],
            related_pages: vec![json!({"id": 2})],
            references: Vec::new(),
            temporal_context: None,
            warnings: vec![ResultWarning::new("alias_set_truncated", "m".into())],
            totals: crate::tools::build_context::Totals { blocks: 1, related_pages: 1, references: 0 },
        }
    }

    #[test]
    fn a_query_result_says_what_it_answered_what_may_be_missing_then_the_data() {
        let mut context = QueryContext {
            query: "[[a]]".into(),
            extracted_topics: vec!["a".into()],
            contexts: vec![topic("a", 1)],
            search_results: None,
            warnings: vec![QueryWarning::new("topic_not_found", "m".into()).about("b")],
        };
        let value = context.to_value();
        assert_eq!(keys(&value), ["query", "extractedTopics", "hasMore", "warnings", "summary", "contexts"]);
        assert_eq!(value["hasMore"], false);
        assert_eq!(value["summary"], json!({"totalTopics": 1, "totalBlocks": 1, "totalPages": 2}));
        // a topic's own meta is not repeated: its warnings are rolled up, and its counts are the summary's
        assert_eq!(keys(&value["contexts"][0]), ["topic", "summary", "mainPage", "directBlocks", "relatedPages", "references"]);
        // the hits come last, and a warning with a remedy sets hasMore
        context.search_results = Some(vec![json!({"id": 9})]);
        context.warnings.push(QueryWarning::new("topics_truncated", "m".into()).how_to_fetch_all("h".into()));
        let value = context.to_value();
        assert_eq!(keys(&value), ["query", "extractedTopics", "hasMore", "warnings", "summary", "contexts", "searchResults"]);
        assert_eq!(value["hasMore"], true);
        assert_eq!(value["summary"]["totalBlocks"], 2);
    }
}
