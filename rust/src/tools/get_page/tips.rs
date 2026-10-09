//! What a page suggests next.

use serde_json::{Value, json};

use crate::tips::{MAX_TIPS, non_empty, suggest_call};

/// Tips for a finished page read: its blocks, if they weren't asked for, and what links to it.
/// The page is named as LogSeq spells it (`originalName`), else as the caller did.
pub fn page_tips(result: &Value, page_name: &str, include_children: bool) -> Vec<String> {
    let shown = result.get("originalName").and_then(Value::as_str).and_then(non_empty).or_else(|| non_empty(page_name));
    let Some(page) = shown else { return Vec::new() };
    let mut tips = Vec::new();
    if !include_children {
        tips.push(format!("For its blocks: {}.", suggest_call("logseq_get_page", &json!({"page_name": page, "include_children": true}))));
    }
    tips.push(format!("For what links here: {}.", suggest_call("logseq_get_backlinks", &json!({"page_name": page}))));
    tips.truncate(MAX_TIPS);
    tips
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_read_without_its_blocks_suggests_both_next_steps() {
        let result = json!({"originalName": "Project Atlas"});
        assert_eq!(
            page_tips(&result, "atlas", false),
            [
                r#"For its blocks: logseq_get_page {"page_name":"Project Atlas","include_children":true}."#,
                r#"For what links here: logseq_get_backlinks {"page_name":"Project Atlas"}."#,
            ]
        );
    }

    #[test]
    fn a_page_read_with_its_blocks_suggests_only_the_links() {
        let tips = page_tips(&json!({"originalName": "Atlas"}), "atlas", true);
        assert_eq!(tips, [r#"For what links here: logseq_get_backlinks {"page_name":"Atlas"}."#]);
    }

    #[test]
    fn the_name_the_caller_gave_stands_in_for_a_missing_or_blank_original_name() {
        assert!(page_tips(&json!({}), "alice", true)[0].contains(r#"{"page_name":"alice"}"#));
        assert!(page_tips(&json!({"originalName": "  "}), "alice", true)[0].contains(r#"{"page_name":"alice"}"#));
        assert!(page_tips(&json!({"originalName": 5}), "alice", true)[0].contains(r#"{"page_name":"alice"}"#));
        // no name to suggest a call with: no tip
        assert!(page_tips(&json!({}), " ", false).is_empty());
    }
}
