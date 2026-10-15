//! Server `instructions`, sent in the `initialize` response (#44). Hosts show them to the model once per
//! session, so every character is paid for every session. The text is held byte for byte by
//! the guide resource (`tests/data/parity/resources.json`).
//!
//! The text routes by the four tool types of ADR-0037 (get, find, explore, check) and gives one line to each
//! second-brain question, then keeps the notes on reading results. Every tool but `logseq_get_graph` (a
//! debugging aid) is named, and the length is held at or under `MAX_CHARS` (#496).

/// The server instructions.
pub const SERVER_INSTRUCTIONS: &str = r##"Read-only access to a LogSeq graph. Nothing here edits it.

Types: get (you name it), find (criteria in, hits out), explore (what it is, how it connects or changed), check (before writing).
- recall a topic or refresh on a person: logseq_explore_context (one page per call, in parallel)
- what happened in a period, or how a page changed: logseq_explore_timeline
- how two pages connect: logseq_explore_network with to
- keywords, blocks linking to pages, a block property: logseq_find_blocks
- a page name you lack, or a page property: logseq_find_pages
- before writing links: logseq_check_links
- a named page or block: logseq_get_page (a miss suggests names), logseq_get_block; this page: logseq_get_current; long page: logseq_get_page detail outline, then logseq_get_block

Reading results:
- ((uuid)) is a block ref: logseq_get_block, or resolve_refs.
- A warning means the result was cut or partial; read it before saying something doesn't exist. hasMore: true: pass nextCursor as cursor; false: the warning says why.
- Search is literal (no synonyms); traversal follows only [[links]] and #tags.
- Tips in the meta block are optional."##;

/// The most characters the instructions may hold: the length of the text this replaced (#496). Every
/// session pays for each one, so a longer text has to say what it buys and raise this on purpose.
#[cfg(test)]
const MAX_CHARS: usize = 1145;

#[cfg(test)]
mod tests {
    use super::*;

    /// The instructions are model-facing text paid for every session, and the parity harness holds the guide resource, which
    /// embeds them, to the bytes recorded in `tests/data/parity/resources.json`. This keeps the
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

    #[test]
    fn the_text_fits_the_character_budget() {
        let chars = SERVER_INSTRUCTIONS.chars().count();
        assert!(chars <= MAX_CHARS, "the instructions are {chars} characters, over the {MAX_CHARS} budget");
    }

    /// Routing by type (ADR-0037): the four types are named, and every tool but `get_graph` appears.
    #[test]
    fn the_text_names_the_four_types_and_every_routed_tool() {
        for ty in ["get (", "find (", "explore (", "check ("] {
            assert!(SERVER_INSTRUCTIONS.contains(ty), "the instructions don't introduce the type {ty:?}");
        }
        for tool in crate::tools::list() {
            let name = tool.name.to_string();
            if name != "logseq_get_graph" {
                assert!(SERVER_INSTRUCTIONS.contains(&name), "the instructions don't route to {name}");
            }
        }
    }

    /// Each tool sits on the line that names its question, not just somewhere in the text: swapping two routes fails.
    #[test]
    fn each_question_line_names_its_tool() {
        let routes: [(&str, &[&str]); 13] = [
            ("a topic", &["logseq_explore_context"]),
            ("a period", &["logseq_explore_timeline"]),
            ("how two pages connect", &["logseq_explore_network"]),
            ("keywords", &["logseq_find_blocks"]),
            ("a block property", &["logseq_find_blocks"]),
            ("a page property", &["logseq_find_pages"]),
            ("a page name", &["logseq_find_pages"]),
            ("before writing links", &["logseq_check_links"]),
            ("a named page or block", &["logseq_get_page", "logseq_get_block"]),
            ("this page", &["logseq_get_current"]),
            ("long page", &["logseq_get_page detail outline, then logseq_get_block"]),
            ("how a page changed", &["logseq_explore_timeline"]),
            ("refresh on a person", &["logseq_explore_context"]),
        ];
        for (question, tools) in routes {
            let lines: Vec<&str> = SERVER_INSTRUCTIONS.lines().filter(|line| line.contains(question)).collect();
            assert_eq!(lines.len(), 1, "{question:?} should be on exactly one line, found {}", lines.len());
            for tool in tools {
                assert!(lines[0].contains(tool), "the line for {question:?} doesn't name {tool}: {}", lines[0]);
            }
        }
    }

    /// A tool is always written with its `logseq_` prefix: the real-tools test only reads prefixed words, so a bare
    /// name, current or former, would slip past it. The former names mirror `FORMER_TOOL_NAMES` in
    /// `tests/guards/skill-tools-check.ts` (the 16 v1 tools and the two ADR-0008 removed earlier).
    #[test]
    fn no_tool_is_named_without_its_prefix() {
        const FORMER: [&str; 18] = [
            "build_context",
            "check_links",
            "get_backlinks",
            "get_block",
            "get_concept_evolution",
            "get_concept_network",
            "get_context_for_query",
            "get_current_context",
            "get_graph_info",
            "get_page",
            "get_page_outline",
            "list_pages",
            "query_by_date_range",
            "query_by_property",
            "search_blocks",
            "search_by_relationship",
            "get_entity_timeline",
            "get_related_pages",
        ];
        let current: Vec<String> =
            crate::tools::list().iter().map(|tool| tool.name.trim_start_matches("logseq_").to_owned()).collect();
        for word in SERVER_INSTRUCTIONS.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
            assert!(
                !FORMER.contains(&word) && !current.iter().any(|name| name == word),
                "the instructions name {word} without the logseq_ prefix"
            );
        }
    }
}
