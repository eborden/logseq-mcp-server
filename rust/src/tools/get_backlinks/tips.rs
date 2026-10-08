//! What the backlinks tool suggests next (`logseq_get_backlinks` in `src/utils/tips.ts`).

use serde_json::json;

use crate::tips::{MAX_TIPS, non_empty, suggest_call};

/// Tips for a finished call: read the page itself, with its related pages. `page_name` is the
/// name as the caller sent it. Nothing for an empty result, or for a result that is not a list
/// (a `null` answer from LogSeq).
pub fn backlink_tips(page_name: &str, has_results: bool) -> Vec<String> {
    let mut tips = Vec::new();
    if let (Some(page), true) = (non_empty(page_name), has_results) {
        tips.push(format!(
            "For the page's own content and related pages: {}.",
            suggest_call("logseq_build_context", &json!({"topic_name": page}))
        ));
    }
    tips.truncate(MAX_TIPS);
    tips
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tip_names_the_page_as_the_caller_wrote_it() {
        assert_eq!(
            backlink_tips("Project \"Atlas\"", true),
            ["For the page's own content and related pages: logseq_build_context {\"topic_name\":\"Project \\\"Atlas\\\"\"}."]
        );
    }

    #[test]
    fn an_empty_result_or_a_blank_name_has_no_tip() {
        assert!(backlink_tips("Atlas", false).is_empty());
        assert!(backlink_tips("  ", true).is_empty());
    }
}
