//! Next-step tips (#44, BR-0009; the Rust side of `src/utils/tips.ts`). After a result the model
//! usually needs one more call, and a tip names it with ready-to-use arguments. Tips are built
//! from the result, never by the tool's own code, so the primary result keeps its shape; they
//! travel in a trailing `{"meta":{"tips":[...]}}` content block, and there is none when there are
//! no tips. What every tool's tips share is here; what a tool suggests is in its own directory.

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
pub fn non_empty(text: &str) -> Option<&str> {
    (!js::trim(text).is_empty()).then_some(text)
}

/// `metaContent(null, tips)`: the trailing block that carries the tips, or `None` when there are none.
pub fn tips_content(tips: &[String]) -> Option<String> {
    (!tips.is_empty()).then(|| json!({"meta": {"tips": tips}}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_tips_is_no_block() {
        assert_eq!(tips_content(&[]), None);
    }

    #[test]
    fn tips_travel_in_a_meta_block() {
        let text = tips_content(&["a \"b\"".to_owned()]).unwrap();
        assert_eq!(text, r#"{"meta":{"tips":["a \"b\""]}}"#);
    }

    #[test]
    fn a_call_is_the_tool_and_its_arguments_as_json() {
        assert_eq!(
            suggest_call("logseq_get_block", &json!({"block_uuid": "u", "include_children": true})),
            r#"logseq_get_block {"block_uuid":"u","include_children":true}"#
        );
    }

    #[test]
    fn a_blank_text_is_not_a_tip_argument() {
        assert_eq!(non_empty("  "), None);
        assert_eq!(non_empty(" a "), Some(" a "));
    }
}
