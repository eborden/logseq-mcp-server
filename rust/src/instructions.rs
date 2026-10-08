//! Server `instructions`, sent in the `initialize` response (`src/instructions.ts`, #44). Hosts show
//! them to the model once per session, so every character is paid for every session.

/// The text of `SERVER_INSTRUCTIONS` in `src/instructions.ts`, byte for byte. A test reads that file and
/// fails if the two drift apart.
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

    /// The template literal of `SERVER_INSTRUCTIONS` in the TypeScript source. It holds no escape and no
    /// substitution, so its text is what is between the backticks.
    #[test]
    fn the_text_is_the_typescript_servers() {
        let source = include_str!("../../src/instructions.ts");
        let opening = "SERVER_INSTRUCTIONS = `";
        let start = source.find(opening).expect("the constant") + opening.len();
        let end = start + source[start..].find('`').expect("the closing backtick");
        let typescript = &source[start..end];
        assert!(!typescript.contains('\\') && !typescript.contains("${"), "the template has an escape or a substitution; read it as JavaScript would");
        assert_eq!(SERVER_INSTRUCTIONS, typescript);
    }
}
