/**
 * Server `instructions` sent in the MCP `initialize` response (#44). Hosts show
 * it to the model once per session, so every character is paid for every session.
 * Keep it short; per-tool detail belongs in the tool descriptions.
 */
export const SERVER_INSTRUCTIONS = `Read-only access to a LogSeq graph. Nothing here edits it.

Start with:
- "what do I know about X": logseq_build_context (one topic) or logseq_get_context_for_query (a question)
- keywords: logseq_search_blocks
- journals and "last week": logseq_query_by_date_range
- unsure of a page name: logseq_list_pages
- "this page": logseq_get_current_context

Reading results:
- Page names are case-insensitive. Block uuid is the stable id; numeric id is internal.
- ((uuid)) in content is a block ref. Fetch it with logseq_get_block, or pass resolve_refs (get_page, get_block, build_context, query_by_date_range) to get resolvedRefs.
- hasMore: true means the result was cut. The warnings name the parameter to raise. Check them before saying something doesn't exist.
- Search is literal (no synonyms) and traversal only follows [[links]] and #tags.
- A trailing meta block may carry tips for a next call. Ignore them if unhelpful.`;
