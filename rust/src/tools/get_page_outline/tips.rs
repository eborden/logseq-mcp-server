//! What the page outline suggests next (`logseq_get_page_outline` in `src/utils/tips.ts`).

use serde_json::json;

use crate::tips::{MAX_TIPS, non_empty, suggest_call};

/// A block of an outline, as far as the tip reads it.
pub struct TipBlock<'a> {
    pub uuid: &'a str,
    pub child_count: usize,
}

/// Tips for a finished outline: read a block with its children. A block with children is the
/// more useful read; otherwise the first block. Nothing for an empty outline.
pub fn outline_tips(blocks: &[TipBlock<'_>]) -> Vec<String> {
    let pick = blocks.iter().find(|block| block.child_count > 0).or(blocks.first());
    let mut tips = Vec::new();
    if let Some(uuid) = pick.and_then(|block| non_empty(block.uuid)) {
        tips.push(format!(
            "To read a block and its children: {}.",
            suggest_call("logseq_get_block", &json!({"block_uuid": uuid, "include_children": true}))
        ));
    }
    tips.truncate(MAX_TIPS);
    tips
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID_A: &str = "00000000-0000-4000-8000-000000000101";
    const UUID_B: &str = "00000000-0000-4000-8000-000000000102";

    #[test]
    fn the_tip_names_the_first_block_with_children_else_the_first_block() {
        let blocks = [TipBlock { uuid: UUID_A, child_count: 0 }, TipBlock { uuid: UUID_B, child_count: 3 }];
        assert_eq!(
            outline_tips(&blocks),
            [format!("To read a block and its children: logseq_get_block {{\"block_uuid\":\"{UUID_B}\",\"include_children\":true}}.")]
        );
        assert!(outline_tips(&blocks[..1])[0].contains(UUID_A));
    }

    #[test]
    fn an_empty_outline_has_no_tip() {
        assert!(outline_tips(&[]).is_empty());
    }

    #[test]
    fn a_blank_uuid_is_no_tip() {
        assert!(outline_tips(&[TipBlock { uuid: "  ", child_count: 1 }]).is_empty());
    }
}
