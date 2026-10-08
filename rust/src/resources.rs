//! MCP resources (the Rust side of `src/resources.ts`). Read-only, like everything here (BR-0002).
//! So far one: `logseq://page/{name}`, one page as Markdown text, through the same lookup as
//! `logseq_get_page` (aliases, ISO dates, case-insensitive names) and the same renderer
//! (`crate::markdown`, never a second one).
//!
//! The reading guide (`logseq://guide`) is not here yet: it lists the tools and prompts, so it
//! comes with them (#316). Until then `resources/list` is empty and the guide is an unknown URI.

use rmcp::ErrorData;
use rmcp::model::{ErrorCode, ReadResourceResult, Resource, ResourceContents, ResourceTemplate};
use serde_json::Value;

use crate::client::LogseqClient;
use crate::errors::ToolError;
use crate::js;
use crate::markdown::{PageRenderOptions, render_page};
use crate::tools::get_page::get_page;

const PAGE_URI_PREFIX: &str = "logseq://page/";
pub const PAGE_URI_TEMPLATE: &str = "logseq://page/{name}";

/// Longest page name accepted in a resource URI, in UTF-16 code units, matching the prompt topic limit.
const MAX_PAGE_NAME_LENGTH: usize = 200;

/// Most characters (UTF-16 code units) of a page returned in one read. A page can be far larger
/// than a context window; the cut is announced at the end of the text, never silent (BR-0006).
pub const MAX_PAGE_CHARS: usize = 50_000;

const MARKDOWN: &str = "text/markdown";

/// What `resources/read` lists as available, in the "Unknown resource" message. #316 adds the guide.
const AVAILABLE: &str = PAGE_URI_TEMPLATE;

/// `resources/list`: none until the guide (#316).
pub fn list() -> Vec<Resource> {
    Vec::new()
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

// PARITY(#299): the TypeScript SDK's `McpError` writes "MCP error <code>: " before its message, so that is
// what goes on the wire, and the SDK sends no `data` (the `{ uri }` the resource code builds never leaves
// the server; suspected TS bug) — drop if Rust becomes the only server.
/// A JSON-RPC error as the TypeScript server sends an `McpError`.
fn mcp_error(code: ErrorCode, message: &str) -> ErrorData {
    ErrorData::new(code, format!("MCP error {}: {message}", code.0), None)
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
    Ok(ReadResourceResult::new(vec![ResourceContents::text(text, uri).with_mime_type(MARKDOWN)]))
}

/// `resources/read`.
pub async fn read(client: &LogseqClient, uri: &str) -> Result<ReadResourceResult, ErrorData> {
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
        assert!(list().is_empty());
    }
}
