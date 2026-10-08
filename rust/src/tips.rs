//! Next-step tips (#44, BR-0009; the Rust side of `src/utils/tips.ts`). After a result the model
//! usually needs one more call, and a tip names it with ready-to-use arguments. Tips are built
//! here from the result, never by the tool, so the primary result keeps its shape; they travel in
//! a trailing `{"meta":{"tips":[...]}}` content block, and there is none when there are no tips.
//!
//! Only the tips of the tools the Rust server has are written: the page outline's.

use serde_json::{Value, json};

use crate::js;

/// Most tips one result carries, each one line.
pub const MAX_TIPS: usize = 2;

/// A suggested call: the tool name followed by its arguments as JSON, so a name with quotes,
/// backslashes or newlines stays a valid call.
pub fn suggest_call(tool: &str, args: &Value) -> String {
    format!("{tool} {}", js::json_stringify(args))
}

/// A text that isn't blank (`nonEmptyString`).
fn non_empty(text: &str) -> Option<&str> {
    (!js::trim(text).is_empty()).then_some(text)
}

/// A block of an outline, as far as tips read it.
pub struct OutlineTipBlock<'a> {
    pub uuid: &'a str,
    pub child_count: usize,
}

/// Tips for a finished `logseq_get_page_outline`: read a block with its children. A block with
/// children is the more useful read; otherwise the first block. Nothing for an empty outline.
pub fn outline_tips(blocks: &[OutlineTipBlock<'_>]) -> Vec<String> {
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

/// `metaContent(null, tips)`: the trailing block that carries the tips, or `None` when there are none.
pub fn tips_content(tips: &[String]) -> Option<String> {
    (!tips.is_empty()).then(|| json!({"meta": {"tips": tips}}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID_A: &str = "00000000-0000-4000-8000-000000000101";
    const UUID_B: &str = "00000000-0000-4000-8000-000000000102";

    #[test]
    fn the_tip_names_the_first_block_with_children_else_the_first_block() {
        let blocks = [OutlineTipBlock { uuid: UUID_A, child_count: 0 }, OutlineTipBlock { uuid: UUID_B, child_count: 3 }];
        assert_eq!(
            outline_tips(&blocks),
            [format!("To read a block and its children: logseq_get_block {{\"block_uuid\":\"{UUID_B}\",\"include_children\":true}}.")]
        );
        assert!(outline_tips(&blocks[..1])[0].contains(UUID_A));
    }

    #[test]
    fn an_empty_outline_has_no_tip_and_no_block() {
        assert!(outline_tips(&[]).is_empty());
        assert_eq!(tips_content(&[]), None);
    }

    #[test]
    fn a_blank_uuid_is_no_tip() {
        assert!(outline_tips(&[OutlineTipBlock { uuid: "  ", child_count: 1 }]).is_empty());
    }

    #[test]
    fn tips_travel_in_a_meta_block() {
        let text = tips_content(&["a \"b\"".to_owned()]).unwrap();
        assert_eq!(text, r#"{"meta":{"tips":["a \"b\""]}}"#);
    }
}
