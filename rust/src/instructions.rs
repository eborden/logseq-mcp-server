//! Server `instructions`, sent in the `initialize` response (#44). Hosts show them to the model once per
//! session, so every character is paid for every session. The text is the TypeScript server's, byte for byte, as
//! recorded in the guide resource (`rust/tests/data/parity/resources.json`).

/// The server instructions.
pub const SERVER_INSTRUCTIONS: &str = r##"Read-only access to a LogSeq graph. Nothing here edits it.

Start with:
- "what do I know about X": logseq_build_context (one topic) or logseq_get_context_for_query (a question)
- keywords: logseq_search_blocks
- journals and "last week": logseq_query_by_date_range
- unsure of a page name: logseq_list_pages
- "this page": logseq_get_current_context
- a long page: logseq_get_page_outline, then logseq_get_block on the uuids you pick

Reading results:
- Page names are case-insensitive. Block uuid is the stable id; numeric id is internal.
- ((uuid)) in content is a block ref. Fetch it with logseq_get_block, or pass resolve_refs (get_page, get_block, build_context, query_by_date_range) to get resolvedRefs.
- A warning means the result was cut or partial. hasMore: true means a parameter can fetch more (howToFetchAll says which); with hasMore: false the warning says why not (narrow the request). Check warnings before saying something doesn't exist.
- Search is literal (no synonyms) and traversal only follows [[links]] and #tags.
- A trailing meta block may carry tips for a next call. Ignore them if unhelpful."##;

#[cfg(test)]
mod tests {
    use super::*;

    /// The instructions are model-facing text paid for every session, and the parity harness holds the guide resource, which
    /// embeds them, to the bytes recorded from the TypeScript server (`rust/tests/data/parity/resources.json`). This keeps the
    /// two things that don't move: the opening line, and that every tool the text names is a tool this server has.
    #[test]
    fn the_text_opens_read_only_and_names_only_real_tools() {
        assert!(SERVER_INSTRUCTIONS.starts_with("Read-only access to a LogSeq graph. Nothing here edits it."));
        let listed: Vec<String> = crate::tools::list().iter().map(|tool| tool.name.to_string()).collect();
        for word in SERVER_INSTRUCTIONS.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
            if word.starts_with("logseq_") {
                assert!(listed.iter().any(|name| name == word), "the instructions name {word}, which is not a tool");
            }
        }
    }
}
