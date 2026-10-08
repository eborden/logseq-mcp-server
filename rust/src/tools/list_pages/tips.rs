//! What the page list suggests next (`logseq_list_pages` in `src/utils/tips.ts`).

use serde_json::json;

use crate::tips::{MAX_TIPS, non_empty, suggest_call};

/// Tips for a finished list: open the first match, when the caller filtered by name. Nothing for an
/// unfiltered list, since there is no match to open, or for an empty one.
pub fn list_pages_tips(name_contains: Option<&str>, first_page: Option<&str>) -> Vec<String> {
    let mut tips = Vec::new();
    if let (Some(_), Some(first)) = (name_contains.and_then(non_empty), first_page.and_then(non_empty)) {
        tips.push(format!(
            "To open the first match: {}.",
            suggest_call("logseq_get_page", &json!({"page_name": first, "include_children": true}))
        ));
    }
    tips.truncate(MAX_TIPS);
    tips
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_filtered_list_suggests_opening_its_first_page() {
        assert_eq!(
            list_pages_tips(Some("atl"), Some("Project Atlas")),
            [r#"To open the first match: logseq_get_page {"page_name":"Project Atlas","include_children":true}."#]
        );
    }

    #[test]
    fn nothing_is_suggested_without_a_filter_a_page_or_with_blanks() {
        assert!(list_pages_tips(None, Some("Project Atlas")).is_empty());
        assert!(list_pages_tips(Some("atl"), None).is_empty());
        assert!(list_pages_tips(Some("  "), Some("Project Atlas")).is_empty());
        assert!(list_pages_tips(Some("atl"), Some(" ")).is_empty());
    }
}
