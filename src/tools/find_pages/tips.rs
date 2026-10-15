//! What the page list suggests next.

use serde_json::json;

use crate::tips::{MAX_TIPS, non_empty, suggest_call};

/// Tips for a finished list: open the first match, when the caller narrowed the list (`text`, `names` or
/// `property`). Nothing for an unfiltered list, since there is no match to open, or for an empty one.
pub fn find_pages_tips(narrowed: bool, first_page: Option<&str>) -> Vec<String> {
    let mut tips = Vec::new();
    if let (true, Some(first)) = (narrowed, first_page.and_then(non_empty)) {
        tips.push(format!(
            "To open the first match: {}.",
            suggest_call("logseq_get_page", &json!({"page": first, "detail": "full"}))
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
            find_pages_tips(true, Some("Project Atlas")),
            [r#"To open the first match: logseq_get_page {"page":"Project Atlas","detail":"full"}."#]
        );
    }

    #[test]
    fn nothing_is_suggested_without_a_filter_a_page_or_with_a_blank_name() {
        assert!(find_pages_tips(false, Some("Project Atlas")).is_empty());
        assert!(find_pages_tips(true, None).is_empty());
        assert!(find_pages_tips(true, Some(" ")).is_empty());
    }
}
