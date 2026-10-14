//! The cursor token (ADR-0038): how a call reads the next page of a list a tool cut. It is the base64url (no padding)
//! of a versioned JSON payload that carries everything the next page needs, so the server keeps no progress: the tool,
//! its arguments as they were resolved, the position of the next entry, the last entry that was sent (the anchor) and
//! the key of the snapshot the first call kept (`crate::snapshots`).
//!
//! Nothing in a token is trusted. A bad version, a payload that doesn't parse or a token made by another tool is an
//! [`InvalidParameter`] before any LogSeq call ([`decode`]). The arguments are parsed again by the tool
//! (`parse_args`), and the position is checked against the list it indexes (`crate::paging`). There is no signature:
//! every tool is read-only, so a forged token can only ask for a read the caller could have asked for with arguments.
//!
//! The arguments are stored as resolved: a period given as `last_n` or a preset is stored as its start and end dates,
//! so a page read again after midnight reads the same window.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::errors::InvalidParameter;

/// The token's format. A payload of another version is refused, never guessed at.
pub const VERSION: u64 = 1;

/// Where the next page starts in the list a tool built.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Position {
    /// An index into one ordered list of entries
    Index { at: usize },
    /// An index into each of the three lists of `explore_context`: its blocks, its references and its related pages.
    /// Added with the first token so the format is fixed once; only that tool reads it.
    Sections { blocks: usize, references: usize, related: usize },
}

/// The last entry a page sent, by what names it in its list: a block's `:db/id`, or a page name or a uuid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Anchor {
    Id(i64),
    Text(String),
}

/// Which snapshot a token was made from: the server process that made it (its start time in milliseconds) and a
/// counter within it, so a restarted server never mistakes a counter it hands out again for one a client still holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotKey {
    pub started: u64,
    pub n: u64,
}

/// What a token holds. The fields are written in this order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub v: u64,
    /// The name of the tool that made it, e.g. `logseq_find_blocks`
    pub tool: String,
    /// The tool's arguments, resolved, as the tool's own parse reads them
    pub args: Map<String, Value>,
    pub position: Position,
    pub anchor: Anchor,
    pub snapshot: SnapshotKey,
}

impl Cursor {
    /// A token of the current version.
    pub fn new(tool: &str, args: Map<String, Value>, position: Position, anchor: Anchor, snapshot: SnapshotKey) -> Cursor {
        Cursor { v: VERSION, tool: tool.to_owned(), args, position, anchor, snapshot }
    }
}

/// The token as a client passes it back: base64url, no padding.
pub fn encode(cursor: &Cursor) -> String {
    // A cursor holds only strings, numbers and maps with string keys, which serde_json always writes
    let payload = serde_json::to_vec(cursor).expect("a cursor serializes: its keys are strings and its numbers finite");
    URL_SAFE_NO_PAD.encode(payload)
}

/// The refusal of a token: `reason` says what is wrong with it. A tool uses it for what only it can tell once the
/// token is decoded (a position that is not an index, arguments it does not take).
pub fn invalid(token: &str, tool: &str, reason: &str) -> InvalidParameter {
    InvalidParameter {
        param: "cursor".to_owned(),
        value: shown(token),
        expected: format!("the nextCursor of a result of {tool}, as it was sent ({reason})"),
        example: Some("cursor: \"<nextCursor>\"".to_owned()),
    }
}

/// The token a tool made, or an [`InvalidParameter`] for one that isn't. `tool` is the name of the tool that reads it:
/// a token another tool made is refused, since its arguments are that tool's.
pub fn decode(token: &str, tool: &str) -> Result<Cursor, InvalidParameter> {
    let refuse = |reason: &str| invalid(token, tool, reason);
    let bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| refuse("this is not a cursor: it is not base64url text"))?;
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| refuse("this is not a cursor: its content is not what a cursor holds"))?;
    match payload.get("v").and_then(Value::as_u64) {
        Some(VERSION) => {}
        Some(_) => return Err(refuse("this cursor is of a version this server doesn't read; repeat the first call to get a new one")),
        None => return Err(refuse("this is not a cursor: it has no version")),
    }
    let cursor: Cursor = serde_json::from_value(payload).map_err(|_| refuse("this is not a cursor: its content is not what a cursor holds"))?;
    if cursor.tool != tool {
        return Err(refuse("this cursor was made by another tool; pass it to the tool that returned it"));
    }
    Ok(cursor)
}

/// A token for a message: its first characters, since a whole one can be hundreds.
fn shown(token: &str) -> String {
    const CHARS: usize = 24;
    let head: String = token.chars().take(CHARS).collect();
    let ellipsis = if token.chars().count() > CHARS { "..." } else { "" };
    serde_json::json!(format!("{head}{ellipsis}")).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOOL: &str = "logseq_find_blocks";

    fn args() -> Map<String, Value> {
        json!({"text": "importer", "limit": 100}).as_object().cloned().unwrap()
    }

    fn cursor() -> Cursor {
        Cursor::new(TOOL, args(), Position::Index { at: 100 }, Anchor::Id(4242), SnapshotKey { started: 1_760_000_000_000, n: 3 })
    }

    fn token_of(payload: &Value) -> String {
        URL_SAFE_NO_PAD.encode(payload.to_string())
    }

    fn refusal(token: &str) -> InvalidParameter {
        decode(token, TOOL).unwrap_err()
    }

    #[test]
    fn a_token_decodes_to_what_was_encoded() {
        let token = encode(&cursor());
        assert_eq!(decode(&token, TOOL).unwrap(), cursor());
        // base64url without padding: nothing a URL or a JSON string has to escape
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "{token}");
    }

    #[test]
    fn the_payload_is_versioned_json_with_the_fields_in_order() {
        let bytes = URL_SAFE_NO_PAD.decode(encode(&cursor())).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"v":1,"tool":"logseq_find_blocks","args":{"text":"importer","limit":100},"position":{"kind":"index","at":100},"anchor":4242,"snapshot":{"started":1760000000000,"n":3}}"#
        );
    }

    #[test]
    fn a_position_in_sections_and_an_anchor_that_is_text_round_trip() {
        let sections = Cursor { position: Position::Sections { blocks: 50, references: 20, related: 0 }, anchor: Anchor::Text("a-uuid".into()), ..cursor() };
        assert_eq!(decode(&encode(&sections), TOOL).unwrap(), sections);
    }

    #[test]
    fn an_unknown_version_is_refused_and_so_is_none() {
        let mut payload = serde_json::to_value(cursor()).unwrap();
        payload["v"] = json!(2);
        assert!(refusal(&token_of(&payload)).expected.contains("version this server doesn't read"));
        payload["v"] = json!("1");
        assert!(refusal(&token_of(&payload)).expected.contains("it has no version"));
        payload.as_object_mut().unwrap().remove("v");
        assert!(refusal(&token_of(&payload)).expected.contains("it has no version"));
    }

    #[test]
    fn a_token_that_is_not_base64url_or_not_json_or_not_a_cursor_is_refused() {
        for token in ["not a token!", "abc=", "+/+/"] {
            assert!(refusal(token).expected.contains("not base64url text"), "{token:?}");
        }
        assert!(refusal("").expected.contains("its content is not what a cursor holds"));
        let not_json = URL_SAFE_NO_PAD.encode("{ nope");
        assert!(refusal(&not_json).expected.contains("its content is not what a cursor holds"));
        // JSON with the right version but the wrong shape: a missing field, a position of an unknown kind, a bad anchor
        let mut payload = serde_json::to_value(cursor()).unwrap();
        payload.as_object_mut().unwrap().remove("anchor");
        assert!(refusal(&token_of(&payload)).expected.contains("its content is not what a cursor holds"));
        let mut payload = serde_json::to_value(cursor()).unwrap();
        payload["position"] = json!({"kind": "sideways", "at": 1});
        assert!(refusal(&token_of(&payload)).expected.contains("its content is not what a cursor holds"));
        let mut payload = serde_json::to_value(cursor()).unwrap();
        payload["position"] = json!({"kind": "index", "at": -1});
        assert!(refusal(&token_of(&payload)).expected.contains("its content is not what a cursor holds"));
        assert!(refusal(&token_of(&json!([1, 2]))).expected.contains("it has no version"));
    }

    #[test]
    fn a_token_made_by_another_tool_is_refused_by_name() {
        let token = encode(&Cursor { tool: "logseq_find_pages".into(), ..cursor() });
        let error = refusal(&token);
        assert_eq!(error.param, "cursor");
        assert!(error.expected.contains("made by another tool"), "{error}");
        assert!(error.expected.contains("a result of logseq_find_blocks"), "{error}");
    }

    #[test]
    fn a_refusal_shows_the_start_of_a_long_token_and_the_whole_of_a_short_one() {
        assert_eq!(refusal("abc=").value, r#""abc=""#);
        let long = format!("{}!", "a".repeat(100));
        assert_eq!(refusal(&long).value, format!("\"{}...\"", "a".repeat(24)));
    }
}
