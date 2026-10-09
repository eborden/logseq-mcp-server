//! MCP resources (the Rust side of `src/resources.ts`). Read-only, like everything here (BR-0002).
//! Two: `logseq://page/{name}`, one page as Markdown text, through the same lookup as
//! `logseq_get_page` (aliases, ISO dates, case-insensitive names) and the same renderer
//! (`crate::markdown`, never a second one).
//!
//! The reading guide (`logseq://guide`) is the server `instructions` plus a one-line index of the tools and
//! prompts, for hosts that let a user attach a resource to a conversation or that don't pass `instructions`
//! to the model.

use rmcp::ErrorData;
use rmcp::model::{ErrorCode, ReadResourceResult, Resource, ResourceContents, ResourceTemplate};
use serde_json::Value;

use crate::client::LogseqClient;
use crate::errors::ToolError;
use crate::js;
use crate::instructions::SERVER_INSTRUCTIONS;
use crate::markdown::{FooterMeta, PageRenderOptions, render_page, with_footer};
use crate::mcp_error::mcp_error;
use crate::prompts;
use crate::tools::{self, get_page::get_page};

const PAGE_URI_PREFIX: &str = "logseq://page/";
pub const PAGE_URI_TEMPLATE: &str = "logseq://page/{name}";

/// Longest page name accepted in a resource URI, in UTF-16 code units, matching the prompt topic limit.
const MAX_PAGE_NAME_LENGTH: usize = 200;

/// Most characters (UTF-16 code units) of a page returned in one read. A page can be far larger
/// than a context window; the cut is announced at the end of the text, never silent (BR-0006).
pub const MAX_PAGE_CHARS: usize = 50_000;

const MARKDOWN: &str = "text/markdown";

pub const GUIDE_URI: &str = "logseq://guide";

/// What `resources/read` lists as available, in the "Unknown resource" message.
const AVAILABLE: &str = "logseq://guide, logseq://page/{name}";

/// `resources/list`: the reading guide.
pub fn list() -> Vec<Resource> {
    vec![
        Resource::new(GUIDE_URI, "guide")
            .with_title("LogSeq reading guide")
            .with_description("How to read this server's results, which tool to start with, and an index of tools and prompts.")
            .with_mime_type(MARKDOWN),
    ]
}

/// The tools in the order `TOOL_DESCRIPTIONS` (`src/tool-descriptions.ts`) lists them, which the guide follows
/// (`tools/list` has its own order). A test checks it names every tool once.
const GUIDE_TOOL_ORDER: [&str; 16] = [
    "logseq_list_pages",
    "logseq_get_current_context",
    "logseq_get_graph_info",
    "logseq_get_page",
    "logseq_get_page_outline",
    "logseq_get_block",
    "logseq_get_backlinks",
    "logseq_search_blocks",
    "logseq_query_by_property",
    "logseq_query_by_date_range",
    "logseq_build_context",
    "logseq_get_context_for_query",
    "logseq_get_concept_network",
    "logseq_search_by_relationship",
    "logseq_get_concept_evolution",
    "logseq_check_links",
];

/// The reading guide as Markdown (`buildGuide`): the server instructions, then one line per tool (the first
/// line of its description, which is what it does), per prompt and per resource.
pub fn build_guide() -> String {
    let tools = tools::list();
    let tool_lines: Vec<String> = GUIDE_TOOL_ORDER
        .iter()
        .map(|name| {
            let tool = tools.iter().find(|tool| tool.name == *name).expect("every tool in the guide order is registered");
            let description = tool.description.as_deref().unwrap_or_default();
            // `summaryLine`: `description.split('\n', 1)[0].trim()`
            format!("- {name}: {}", js::trim(description.split('\n').next().unwrap_or_default()))
        })
        .collect();
    let prompt_lines: Vec<String> =
        prompts::list().iter().map(|prompt| format!("- {}: {}", prompt.name, prompt.description.as_deref().unwrap_or_default())).collect();
    [
        "# LogSeq MCP guide".to_owned(),
        String::new(),
        SERVER_INSTRUCTIONS.to_owned(),
        String::new(),
        "## Tools".to_owned(),
        String::new(),
        tool_lines.join("\n"),
        String::new(),
        "## Prompts".to_owned(),
        String::new(),
        prompt_lines.join("\n"),
        String::new(),
        "## Resources".to_owned(),
        String::new(),
        format!("- {GUIDE_URI}: this guide"),
        format!("- {PAGE_URI_TEMPLATE}: one page as text (URL-encode the name; aliases and ISO dates work)"),
        String::new(),
    ]
    .join("\n")
}

/// `resources/templates/list`: the page template.
pub fn templates() -> Vec<ResourceTemplate> {
    vec![
        ResourceTemplate::new(PAGE_URI_TEMPLATE, "page")
            .with_title("LogSeq page")
            .with_description("One page and its blocks as Markdown text. The name is case-insensitive and may be an alias or an ISO date (2025-01-01) for a journal.")
            .with_mime_type(MARKDOWN),
    ]
}

/// `decodeURIComponent`: every `%XX` becomes its byte, and the bytes must be UTF-8. `None` is the
/// `URIError` (a `%` without two hex digits after it, or bytes that aren't UTF-8).
fn decode_uri_component(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let digit = |b: u8| (b as char).to_digit(16);
            out.push((digit(hex[0])? * 16 + digit(hex[1])?) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The page name from a `logseq://page/{name}` URI, or an `InvalidParams` error.
fn page_name_from_uri(uri: &str) -> Result<String, ErrorData> {
    let encoded = &uri[PAGE_URI_PREFIX.len()..];
    let Some(decoded) = decode_uri_component(encoded) else {
        return Err(mcp_error(ErrorCode::INVALID_PARAMS, &format!("Invalid page name encoding in {uri}. URL-encode the page name.")));
    };
    let name = js::trim(&decoded);
    if name.is_empty() {
        return Err(mcp_error(ErrorCode::INVALID_PARAMS, &format!("No page name in {uri}. Use {PAGE_URI_TEMPLATE}.")));
    }
    let length = name.encode_utf16().count();
    if length > MAX_PAGE_NAME_LENGTH {
        return Err(mcp_error(ErrorCode::INVALID_PARAMS, &format!("Page name is {length} characters; the limit is {MAX_PAGE_NAME_LENGTH}.")));
    }
    Ok(name.to_owned())
}

/// Read a page as Markdown text. A missing page is a resource-not-found error, an ambiguous name
/// an invalid-params one, and anything else (LogSeq down, an answer it shouldn't give) an internal error.
async fn read_page(client: &LogseqClient, uri: &str) -> Result<ReadResourceResult, ErrorData> {
    let name = page_name_from_uri(uri)?;
    let page = match get_page(client, &name, true, false).await {
        Ok(page) => page,
        // rmcp rewrites -32002 to -32602 for a client that negotiated protocol 2026-07-28 or newer (SEP-2164); the
        // TypeScript SDK can't negotiate that, so it's not a regression, and the rewrite stays (#299)
        Err(error @ ToolError::PageNotFound(_)) => return Err(mcp_error(ErrorCode::RESOURCE_NOT_FOUND, &error.to_string())),
        Err(error @ ToolError::AmbiguousPage(_)) => return Err(mcp_error(ErrorCode::INVALID_PARAMS, &error.to_string())),
        Err(error) => return Err(ErrorData::new(ErrorCode::INTERNAL_ERROR, error.to_string(), None)),
    };

    // The one shared renderer (#43): the same text `logseq_get_page` returns with format: "markdown"
    let cut_notice = format!("[Cut at {MAX_PAGE_CHARS} characters. The page continues. Use logseq_get_page or logseq_get_block for the rest.]");
    let text = render_page(
        &page,
        PageRenderOptions { blocks_fetched: true, max_chars: Some(MAX_PAGE_CHARS), cut_notice: Some(&cut_notice), fallback_title: Some(&name) },
    );
    // A page carries `warnings` only when LogSeq gave no answer for its blocks (`page_blocks_unavailable`, BR-0011). The
    // footer is then the same one `logseq_get_page` renders; with no warning the text is the page alone.
    let text = with_footer(text, &FooterMeta::of_result(&page, &[]));
    Ok(ReadResourceResult::new(vec![ResourceContents::text(text, uri).with_mime_type(MARKDOWN)]))
}

/// `resources/read`.
pub async fn read(client: &LogseqClient, uri: &str) -> Result<ReadResourceResult, ErrorData> {
    if uri == GUIDE_URI {
        return Ok(ReadResourceResult::new(vec![ResourceContents::text(build_guide(), uri).with_mime_type(MARKDOWN)]));
    }
    if uri.starts_with(PAGE_URI_PREFIX) {
        return read_page(client, uri).await;
    }
    Err(mcp_error(
        ErrorCode::RESOURCE_NOT_FOUND,
        &format!("Unknown resource {}. Available: {AVAILABLE}.", js::json_stringify(&Value::from(uri))),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn name_of(uri: &str) -> Result<String, String> {
        page_name_from_uri(uri).map_err(|error| error.message.into_owned())
    }

    #[test]
    fn a_name_is_percent_decoded_and_trimmed() {
        assert_eq!(name_of("logseq://page/Project%20Atlas").unwrap(), "Project Atlas");
        assert_eq!(name_of("logseq://page/2025-01-01").unwrap(), "2025-01-01");
        assert_eq!(name_of("logseq://page/a%2Fb%3Fc%23d+e").unwrap(), "a/b?c#d+e", "every escape is decoded, and `+` is not a space");
        assert_eq!(name_of("logseq://page/caf%C3%A9%20\u{1F680}").unwrap(), "caf\u{e9} \u{1F680}", "escaped and plain UTF-8 mix");
        assert_eq!(name_of("logseq://page/%20Atlas%0A").unwrap(), "Atlas");
        assert_eq!(name_of("logseq://page/%e2%82%ac").unwrap(), "\u{20ac}", "hex digits in either case");
    }

    #[test]
    fn a_bad_escape_is_an_encoding_error() {
        for bad in ["logseq://page/50%", "logseq://page/a%2", "logseq://page/%zz", "logseq://page/%C3", "logseq://page/%FF", "logseq://page/%ED%A0%80"] {
            assert_eq!(
                name_of(bad).unwrap_err(),
                format!("MCP error -32602: Invalid page name encoding in {bad}. URL-encode the page name."),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_blank_name_and_a_long_one_are_invalid_params() {
        assert_eq!(name_of("logseq://page/").unwrap_err(), "MCP error -32602: No page name in logseq://page/. Use logseq://page/{name}.");
        assert!(name_of("logseq://page/%20%09").unwrap_err().starts_with("MCP error -32602: No page name in"));
        assert!(name_of(&format!("logseq://page/{}", "a".repeat(200))).is_ok());
        assert_eq!(
            name_of(&format!("logseq://page/{}", "a".repeat(201))).unwrap_err(),
            "MCP error -32602: Page name is 201 characters; the limit is 200."
        );
        // the limit counts UTF-16 code units, as `.length` does: 100 rockets are 200, 101 are 202
        assert!(name_of(&format!("logseq://page/{}", "\u{1F680}".repeat(100))).is_ok());
        assert!(name_of(&format!("logseq://page/{}", "\u{1F680}".repeat(101))).unwrap_err().contains("is 202 characters"));
    }

    #[test]
    fn errors_carry_the_code_and_the_sdk_prefix_and_no_data() {
        let error = mcp_error(ErrorCode::RESOURCE_NOT_FOUND, "No page \"x\".");
        assert_eq!((error.code.0, error.message.as_ref(), error.data), (-32002, "MCP error -32002: No page \"x\".", None));
    }

    #[test]
    fn the_page_template_is_the_one_typescript_lists() {
        assert_eq!(
            serde_json::to_value(templates()).unwrap(),
            json!([{
                "uriTemplate": "logseq://page/{name}",
                "name": "page",
                "title": "LogSeq page",
                "description": "One page and its blocks as Markdown text. The name is case-insensitive and may be an alias or an ISO date (2025-01-01) for a journal.",
                "mimeType": "text/markdown",
            }])
        );
    }

    #[test]
    fn the_guide_is_the_one_resource_listed() {
        assert_eq!(
            serde_json::to_value(list()).unwrap(),
            json!([{
                "uri": "logseq://guide",
                "name": "guide",
                "title": "LogSeq reading guide",
                "description": "How to read this server's results, which tool to start with, and an index of tools and prompts.",
                "mimeType": "text/markdown",
            }])
        );
    }

    #[test]
    fn the_guide_order_names_every_tool_once() {
        let mut ordered: Vec<&str> = GUIDE_TOOL_ORDER.to_vec();
        ordered.sort_unstable();
        let mut listed: Vec<String> = tools::list().iter().map(|tool| tool.name.to_string()).collect();
        listed.sort_unstable();
        assert_eq!(ordered, listed);
    }

    #[test]
    fn the_guide_has_the_instructions_and_an_index_of_tools_prompts_and_resources() {
        let guide = build_guide();
        assert!(guide.starts_with(&format!("# LogSeq MCP guide\n\n{SERVER_INSTRUCTIONS}\n\n## Tools\n\n- logseq_list_pages: List non-journal pages")));
        assert!(guide.contains("\n- logseq_check_links: Check a [[link]] pass."));
        assert!(guide.contains("\n\n## Prompts\n\n- weekly_summary: Summarize a Monday-to-Friday week"));
        assert!(guide.ends_with(
            "\n\n## Resources\n\n- logseq://guide: this guide\n- logseq://page/{name}: one page as text (URL-encode the name; aliases and ISO dates work)\n"
        ));
        // each tool is one line: the description's first line only
        assert_eq!(guide.matches("\n- logseq_").count(), 16);
    }
}
