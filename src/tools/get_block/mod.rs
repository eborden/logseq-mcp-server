//! `logseq_get_block`: one block by uuid, optionally
//! with its children, optionally with its `((uuid))` refs and `{{embed}}`s resolved.
//!
//! Calls: 1 (`logseq.Editor.getBlock`), and with `resolve_refs` up to 2 more Datalog queries, one
//! per nesting level, none when the block and its children hold no ref (see `resolve_refs`).
//!
//! The block is the entity LogSeq sent, key order and spelling included (BR-0004); with
//! `resolve_refs` it gains `resolvedContent` and `resolvedRefs` where it holds a ref, and `hasMore`
//! and `warnings` last.
//!
//! With `format: "markdown"` the block and the children fetched are rendered by `crate::markdown`
//! into one text block, with its warnings and `hasMore` in a footer. The calls are the same.
//!
//! With `include_children` the subtree has no count cap, so [`call`] cuts it to the character budget (#507, #485) and
//! reads the rest with a cursor (ADR-0038, #552): the block, then its descendants in document order, until the text it
//! sends is at most `BUDGET_CHARS`. A block is never cut inside its text (BR-0007), and a kept block that lost children
//! says so with `childrenTruncated`. A cut subtree carries `nextCursor` and a `result_size_truncated` warning whose
//! `howToFetchAll` says to pass it. The page after it, read from the snapshot the first call kept (no LogSeq call) or,
//! when the snapshot is gone, with the calls the first page made, is `{ uuid, continued: true, children }`: the block's
//! own body is not repeated, and a block that sits below one of its children names the ones it sits under
//! (`ancestors`, `crate::tree_paging`). A block read without its children is one entity and is never cut.
//!
//! A call with a `cursor` takes no other argument, and `uuid` is optional in the schema for that reason (BR-0008): the
//! handler refuses a call with neither.

mod wire;

use std::time::Instant;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args::parse_args;
use crate::client::LogseqClient;
use crate::errors::{InvalidParameter, ToolError};
use crate::markdown::{FooterMeta, render_block, with_footer};
use crate::output_format::OutputFormat;
use crate::paging::refuse_with_cursor;
use crate::params::{ParamAliases, resolve_param_aliases};
use crate::resolve_refs::{resolve_block_refs, with_meta};
use crate::snapshots::Snapshots;
use crate::tool::{CursorSchema, input_schema, read_only_annotations, success_result};
use crate::tree_paging::{Resume, Root, Spec, Tree, read};

pub const NAME: &str = "logseq_get_block";

/// The tool's description, as `tools/list` carries it (recorded in the `tool-list` golden, ADR-0034).
const DESCRIPTION: &str = "Get one block by UUID, optionally with its children (hasMore: send only cursor=nextCursor). UUIDs come from other results and from ((uuid)) refs in content.\n\n\
**Can't find:** blocks by text (logseq_find_blocks) or by numeric id. For a whole page use logseq_get_page.";

/// Parameter aliases (BR-0008): not in the schema, so they cost nothing in `tools/list`.
const ALIASES: ParamAliases = &[("uuid", &["block_uuid"])];

/// The block tool's arguments. Unknown fields are ignored, as in every tool (see `input_schema`).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {
    /// UUID of the block to retrieve
    pub uuid: Option<String>,
    /// Whether to include child blocks
    #[serde(default)]
    pub include_children: bool,
    /// Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)
    #[serde(default)]
    pub resolve_refs: bool,
    /// json (default), or markdown text. Markdown has block uuids only on search hits and with compact
    pub format: Option<OutputFormat>,
    // No doc comment: the shared description is the type's (`CursorSchema`), and a doc comment would replace it
    #[schemars(with = "Option<CursorSchema>")]
    pub cursor: Option<String>,
}

/// The tool as `tools/list` shows it.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, input_schema::<Args>())
        .with_title("Get Block")
        .with_annotations(read_only_annotations("Get Block"))
}

/// What a cursor stands for once its arguments are read: a call that reads a block with its children.
fn paged_args(token: &Resume) -> Result<Args, InvalidParameter> {
    let args = parse_args::<Args>(Some(&token.cursor.args)).ok().filter(|args| args.cursor.is_none() && args.uuid.is_some() && args.include_children);
    args.ok_or_else(|| token.refuse(NAME, "its arguments are not a read of a block with its children"))
}

/// The arguments of a block with its children as a cursor carries them: what the call asked, read again by [`Args`].
fn stored_arguments(args: &Args, uuid: &str) -> Map<String, Value> {
    let mut stored = Map::new();
    stored.insert("uuid".into(), json!(uuid));
    stored.insert("include_children".into(), json!(true));
    if args.resolve_refs {
        stored.insert("resolve_refs".into(), json!(true));
    }
    match args.format {
        Some(OutputFormat::Json) => stored.insert("format".into(), json!("json")),
        Some(OutputFormat::Markdown) => stored.insert("format".into(), json!("markdown")),
        None => None,
    };
    stored
}

/// The refusal of a call with neither a uuid nor a cursor, before any LogSeq call (BR-0008).
fn needs_uuid() -> ToolError {
    ToolError::InvalidParameter(InvalidParameter {
        param: "uuid".to_owned(),
        value: "missing".to_owned(),
        expected: "a string (required unless cursor is given)".to_owned(),
        example: Some("uuid: \"...\"".to_owned()),
    })
}

/// A call: aliases folded, arguments read, then the block. This tool has no tips.
///
/// A call with a `cursor` takes no other argument (they are in the token, ADR-0038), and is refused as such on the
/// arguments after the alias is folded, so `{ cursor, block_uuid }` is not a cursor alone (BR-0008). It reads the next
/// page of a block with its children. A call with neither `uuid` nor `cursor` is refused here, not by the schema.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, snapshots: &Snapshots, arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let arguments = resolve_param_aliases(ALIASES, arguments)?;
    let asked = parse_args::<Args>(arguments.as_ref())?;
    let (args, resume) = match asked.cursor.clone() {
        Some(token) => {
            refuse_with_cursor::<Args>(arguments.as_ref())?;
            let resume = Resume::read(&token, NAME)?;
            (paged_args(&resume)?, Some(resume))
        }
        None => (asked, None),
    };
    let Some(uuid) = args.uuid.as_deref() else { return Err(needs_uuid()) };
    // The text the call sends for a block, which the character budget measures (#507)
    let markdown = args.format == Some(OutputFormat::Markdown);
    let text = |block: &Value| if markdown { with_footer(render_block(block), &FooterMeta::of_result(block, &[])) } else { block.to_string() };
    // Without `include_children` the children are unfetched `["uuid", "<id>"]` tuples, and the result is one block
    if !args.include_children {
        let block = get_block(client, uuid, false, args.resolve_refs).await?;
        return Ok(success_result(vec![ContentBlock::text(text(&block))]));
    }
    let stored = resume.as_ref().map_or_else(|| stored_arguments(&args, uuid), |resume| resume.cursor.args.clone());
    let spec = Spec { tool: NAME, root: Root::Block, markdown };
    let build = || async { Ok::<_, ToolError>(Tree::new(Root::Block, get_block(client, uuid, true, args.resolve_refs).await?)) };
    let texts = |block: &Value| vec![text(block)];
    let sent = read(snapshots, resume.as_ref(), &stored, &spec, Instant::now(), build, &texts).await?;
    Ok(success_result(sent.into_iter().map(ContentBlock::text).collect()))
}

/// `BlockNotFoundError`, which shows the uuid as the caller wrote it.
fn not_found(uuid: &str) -> ToolError {
    ToolError::Failed(format!(
        "Block not found: \"{uuid}\"\n\nTip: Block UUIDs come from search results or page queries. Verify the UUID is correct."
    ))
}

/// A block by uuid, as LogSeq sent it.
///
/// With `include_children` its `children` are blocks, nested; without, LogSeq sends them as
/// unfetched `["uuid", "<id>"]` tuples. With `resolve_refs` the block and its children are
/// annotated and `hasMore` and `warnings` are added (at most 2 extra Datalog queries).
///
/// Fails with a "Block not found" error when LogSeq answers `null`.
pub async fn get_block(client: &LogseqClient, uuid: &str, include_children: bool, resolve_refs: bool) -> Result<Value, ToolError> {
    let mut call_args = vec![Value::from(uuid)];
    if include_children {
        call_args.push(serde_json::json!({ "includeChildren": true }));
    }
    let answer = client.call_api(wire::METHOD, &call_args).await?;
    let Some(block) = wire::block(&answer)? else { return Err(not_found(uuid)) };

    if !resolve_refs {
        return Ok(block);
    }
    let resolved = resolve_block_refs(client, std::slice::from_ref(&block)).await?;
    let annotated = resolved.blocks.into_iter().next().expect("one block in, one block out");
    // `{ ...blocks[0], ...buildResultMeta(warnings) }`: a block is an object, and anything else spreads to nothing
    let fields = match annotated {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    Ok(Value::Object(with_meta(fields, &resolved.warnings)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};
    use serde_json::json;

    #[test]
    fn the_block_schema_means_what_the_pinned_one_means() {
        // `inputSchema` of logseq_get_block in the ADR-0016 snapshot
        let pinned = json!({
            "type": "object",
            "properties": {
                "uuid": {"type": "string", "description": "UUID of the block to retrieve"},
                "include_children": {"type": "boolean", "default": false, "description": "Whether to include child blocks"},
                "resolve_refs": {"type": "boolean", "default": false, "description": "Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)"},
                "format": {"type": "string", "enum": ["json", "markdown"], "description": "json (default), or markdown text. Markdown has block uuids only on search hits and with compact"},
                "cursor": {"type": "string", "description": crate::tool::CURSOR_DESCRIPTION},
            },
        });
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&pinned));
    }

    #[test]
    fn the_block_tool_is_read_only_and_titled_as_pinned() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Block"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Block", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false})
        );
    }

    #[test]
    fn the_arguments_are_read_in_schema_order_and_the_block_uuid_alias_is_folded() {
        let args = |value: Value| value.as_object().cloned();
        let folded = resolve_param_aliases(ALIASES, args(json!({"block_uuid": "u1", "include_children": true}))).unwrap();
        let read = parse_args::<Args>(folded.as_ref()).unwrap();
        assert_eq!((read.uuid.as_deref(), read.include_children, read.resolve_refs), (Some("u1"), true, false));
        // the first bad argument in schema order is the one reported
        let error = parse_args::<Args>(args(json!({"uuid": 5, "resolve_refs": "yes"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'uuid': 5"), "{error}");
        let error = parse_args::<Args>(args(json!({"uuid": "u", "resolve_refs": "yes", "format": "xml"})).as_ref()).unwrap_err();
        assert!(error.to_string().starts_with("Invalid parameter 'resolve_refs': \"yes\""), "{error}");
        // `uuid` is optional in the schema, so a call without it parses: the handler refuses it (BR-0008)
        assert_eq!(parse_args::<Args>(args(json!({})).as_ref()).unwrap().uuid, None);
    }

    #[test]
    fn every_argument_takes_what_it_says_and_nothing_else() {
        use crate::args::testing::{Takes, sweep};
        let base = json!({"uuid": "u1"});
        sweep::<Args>(json!({}), "uuid", Takes::Text, false);
        sweep::<Args>(base.clone(), "include_children", Takes::Flag, false);
        sweep::<Args>(base.clone(), "resolve_refs", Takes::Flag, false);
        sweep::<Args>(base.clone(), "format", Takes::Words(&["json", "markdown"]), false);
        sweep::<Args>(base, "cursor", Takes::Text, false);
    }

    #[test]
    fn a_call_with_neither_a_uuid_nor_a_cursor_is_refused_with_the_missing_uuid_named() {
        assert_eq!(needs_uuid().to_string(), "Invalid parameter 'uuid': missing\n\nExpected: a string (required unless cursor is given)\nExample: uuid: \"...\"");
    }

    #[test]
    fn a_cursor_with_the_alias_of_the_uuid_is_not_a_cursor_alone() {
        // BR-0008: the alias is folded first, so `{ cursor, block_uuid }` is `{ cursor, uuid }` and the block can't change
        let args = json!({"cursor": "abc", "block_uuid": "u1"}).as_object().cloned();
        let folded = resolve_param_aliases(ALIASES, args).unwrap();
        let error = refuse_with_cursor::<Args>(folded.as_ref()).unwrap_err();
        assert_eq!((error.param.as_str(), error.value.as_str()), ("uuid", "\"u1\""));
        let alone = resolve_param_aliases(ALIASES, json!({"cursor": "abc"}).as_object().cloned()).unwrap();
        assert!(refuse_with_cursor::<Args>(alone.as_ref()).is_ok());
    }

    fn resume_with(args: Value) -> Resume {
        use crate::cursor::{Anchor, Cursor, Position, SnapshotKey, encode};
        let cursor = Cursor::new(NAME, args.as_object().cloned().unwrap(), Position::Index { at: 3 }, Anchor::Text("u".into()), SnapshotKey { started: 1, n: 1 });
        Resume::read(&encode(&cursor), NAME).unwrap()
    }

    #[test]
    fn a_cursor_stands_only_for_a_block_read_with_its_children_and_its_arguments_read_as_a_call_does() {
        let full = json!({"uuid": "u1", "include_children": true, "resolve_refs": true, "format": "markdown"});
        let args = paged_args(&resume_with(full)).unwrap();
        assert_eq!((args.uuid.as_deref(), args.include_children, args.resolve_refs, args.format), (Some("u1"), true, true, Some(OutputFormat::Markdown)));
        for args in [json!({"uuid": "u1"}), json!({"include_children": true}), json!({"uuid": "u1", "include_children": true, "cursor": "abc"}), json!({"uuid": 5, "include_children": true})] {
            let error = paged_args(&resume_with(args.clone())).err().unwrap_or_else(|| panic!("{args}"));
            assert_eq!(error.param, "cursor", "{args}");
            assert!(error.expected.contains("its arguments are not a read of a block with its children"), "{error}");
        }
    }

    #[test]
    fn the_arguments_a_cursor_carries_are_the_call_that_made_it_and_read_back_to_it() {
        let args = parse_args::<Args>(json!({"uuid": "U1", "include_children": true, "resolve_refs": true, "format": "markdown"}).as_object()).unwrap();
        let stored = stored_arguments(&args, "U1");
        assert_eq!(Value::Object(stored.clone()).to_string(), r#"{"uuid":"U1","include_children":true,"resolve_refs":true,"format":"markdown"}"#);
        let again = parse_args::<Args>(Some(&stored)).unwrap();
        assert_eq!((again.uuid.as_deref(), again.include_children, again.resolve_refs, again.format), (Some("U1"), true, true, Some(OutputFormat::Markdown)));
        let plain = parse_args::<Args>(json!({"uuid": "u", "include_children": true}).as_object()).unwrap();
        assert_eq!(Value::Object(stored_arguments(&plain, "u")).to_string(), r#"{"uuid":"u","include_children":true}"#);
    }

    #[test]
    fn a_missing_block_is_named_as_the_caller_wrote_it() {
        assert_eq!(
            not_found("a \"b\"").to_string(),
            "Block not found: \"a \"b\"\"\n\nTip: Block UUIDs come from search results or page queries. Verify the UUID is correct."
        );
    }
}
