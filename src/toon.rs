//! The one TOON encoder (BR-0014, #469). Every tool that takes `format: "toon"` writes its result
//! through here, so a result looks the same wherever it is read. Never add a second encoder.
//!
//! TOON writes a list's keys once instead of on every row, so a flat list costs the model fewer tokens.
//! The function takes the final result value, the one the JSON output would be written from, and
//! returns text with the same data in the same key order (BR-0013), `null`, empty arrays and numbers
//! included. Errors and the ambiguous-name answer are never encoded here: they stay JSON.

use serde_json::Value;

use crate::errors::ToolError;

/// The text of a TOON-encoded result value.
///
/// An encode failure is a defect, not an input problem: every `Value` a tool builds is encodable. It still
/// reaches the caller as an error, never as an empty result (BR-0003). The crate's own message is not shown, as
/// it may quote the value.
pub fn encode(value: &Value) -> Result<String, ToolError> {
    toon_format::encode_default(value).map_err(|_| ToolError::Failed("Failed to encode the result as TOON".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Pins the TOON text of one value, so a change of key order (BR-0013) or a crate upgrade that
    /// writes TOON differently fails here. Keys are not in alphabetical order, one list is uniform (written as
    /// a table, its keys once) and one is not.
    #[test]
    fn a_fixed_value_encodes_to_the_pinned_toon_text() {
        let value = json!({
            "total": 3,
            "hasMore": false,
            "warnings": [],
            "pages": [
                {"name": "Alpha", "aliases": ["A", "Al"]},
                {"name": "Beta"},
            ],
            "rows": [
                {"uuid": "u1", "snippet": "one, two", "page": null},
                {"uuid": "u2", "snippet": "three", "page": "Alpha"},
            ],
        });
        let pinned = "total: 3\nhasMore: false\nwarnings: []\npages[2]:\n  - name: Alpha\n    aliases[2]: A,Al\n  - name: Beta\n\
                      rows[2]{uuid,snippet,page}:\n  u1,\"one, two\",null\n  u2,three,Alpha";
        assert_eq!(encode(&value).unwrap(), pinned);
    }
}
