//! `logseq_get_current_context` (the Rust side of `src/tools/get-current-context.ts`): what the user
//! is looking at in LogSeq right now: the open page, the block being edited and any selected blocks.
//!
//! Calls: 3 Editor calls made at once (`getCurrentPage`, `getCurrentBlock`, `getSelectedBlocks`),
//! plus one Datalog pull by `:db/id` only when a block's page is not already known (#15). It never
//! fetches all pages. An answer of `null` is a case of its own: no page open is a normal result
//! (`page: null` with a message), not an error. Infrastructure errors propagate (BR-0003).
//!
//! This directory holds everything only the current context uses: the answers it reads
//! (`wire.rs`). What it shares with other tools is outside it: the page lookup by id, slim output,
//! entity fields and the tool helpers.

mod wire;

use std::collections::HashMap;

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::client::LogseqClient;
use crate::edn::PageId;
use crate::entity::{id_of, page_display_name};
use crate::errors::ToolError;
use crate::js;
use crate::pages_by_ids::pages_by_ids;
use crate::slim::{to_slim_block, to_slim_page};
use crate::tool::{input_schema, read_only_annotations, success_result, with_empty_required};

pub const NAME: &str = "logseq_get_current_context";

/// The description the TypeScript server gives the tool (`src/tool-descriptions.ts`).
const DESCRIPTION: &str = "Get what the user is looking at in LogSeq right now: the open page, the block being edited, and any selected blocks.\n\n\
**Use when:** the user says \"this page\", \"this block\" or \"what I'm looking at\" without naming it. Then pass the page name to logseq_build_context or logseq_get_page.\n\n\
**Can't find:** anything not open right now. Returns page: null with a message when no page is open.";

/// What the result says when no page is open.
pub const NO_PAGE_OPEN_MESSAGE: &str = "No page is open in LogSeq (for example the All Pages view is showing).";

/// The tool takes no arguments, and whatever is sent is ignored.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct Args {}

/// The tool as `tools/list` shows it. Read-only like every tool, but not idempotent: the result
/// depends on what the user has open in the LogSeq UI, which changes between calls.
pub fn definition() -> Tool {
    Tool::new(NAME, DESCRIPTION, with_empty_required(input_schema::<Args>()))
        .with_title("Get Current Context")
        .with_annotations(read_only_annotations("Get Current Context").idempotent(false))
}

/// A call: the context LogSeq is showing, as JSON.
pub async fn call(client: &LogseqClient, _tips_enabled: bool, _arguments: Option<JsonObject>) -> Result<CallToolResult, ToolError> {
    let context = get_current_context(client).await?;
    Ok(success_result(vec![ContentBlock::text(js::json_stringify(&context.into_value()))]))
}

/// What the user is looking at: `page` is `null` when nothing is open, and then `message` says so.
#[derive(Debug, Clone, PartialEq)]
pub struct CurrentContext {
    pub page: Option<Map<String, Value>>,
    pub message: Option<&'static str>,
    pub focused_block: Option<Map<String, Value>>,
    /// Absent when nothing is selected
    pub selected_blocks: Option<Vec<Map<String, Value>>>,
}

impl CurrentContext {
    /// The result in the key order the TypeScript server writes it: `page` (even when `null`),
    /// `message`, `focusedBlock`, `selectedBlocks`.
    pub fn into_value(self) -> Value {
        let mut result = Map::new();
        result.insert("page".into(), self.page.map_or(Value::Null, Value::Object));
        if let Some(message) = self.message {
            result.insert("message".into(), Value::from(message));
        }
        if let Some(block) = self.focused_block {
            result.insert("focusedBlock".into(), Value::Object(block));
        }
        if let Some(blocks) = self.selected_blocks {
            result.insert("selectedBlocks".into(), Value::Array(blocks.into_iter().map(Value::Object).collect()));
        }
        Value::Object(result)
    }
}

/// The id of the page a block sits on (`blockPageId`): `None` when the block carries no page.
fn block_page_id(block: &Map<String, Value>) -> Option<i64> {
    id_of(block.get("page"))
}

/// `isBlockEntity`: `getCurrentPage` answers a block, not a page, when the user has zoomed into
/// one. It has no `name`, and it has a `page`.
fn is_block_entity(entity: &Map<String, Value>) -> bool {
    !entity.contains_key("name") && entity.get("uuid").is_some_and(Value::is_string) && entity.contains_key("page")
}

/// `withFetchedChildren`: without `includeChildren`, the Editor API gives a block's `children` as
/// unfetched `["uuid", "<id>"]` tuples rather than blocks. Keep only the children that are blocks
/// with text, so slimming has nothing to choke on; `logseq_get_block` fetches the rest.
fn with_fetched_children(block: &Map<String, Value>) -> Map<String, Value> {
    let Some(Value::Array(children)) = block.get("children") else { return block.clone() };
    let mut rest: Map<String, Value> = block.iter().filter(|(key, _)| key.as_str() != "children").map(|(k, v)| (k.clone(), v.clone())).collect();
    let fetched: Vec<Value> = children
        .iter()
        .filter_map(Value::as_object)
        .filter(|child| child.get("content").is_some_and(Value::is_string))
        .map(|child| Value::Object(with_fetched_children(child)))
        .collect();
    rest.insert("children".into(), Value::Array(fetched));
    rest
}

/// Get the page, focused block and selected blocks the user currently has open.
///
/// API calls: 3 Editor calls, plus 1 Datalog query only when a block's page is not already known.
pub async fn get_current_context(client: &LogseqClient) -> Result<CurrentContext, ToolError> {
    // `Promise.all` rejects on the first error, but the other two fetches still run to completion, so the
    // TypeScript server always makes all three calls. `join!` lets all three finish too, and the errors are
    // then raised in a fixed order (page, block, selection). With two answers wrong at once TypeScript reports
    // whichever arrives first, so the parity cases never have two.
    let (page_answer, block_answer, selected_answer) =
        tokio::join!(fetch_current_page(client), fetch_current_block(client), fetch_selected_blocks(client));
    let (current_page, current_block, selected) = (page_answer?, block_answer?, selected_answer?);

    // `getCurrentPage` answers the block itself when the user has zoomed into one.
    let zoomed_block = current_page.as_ref().and_then(Value::as_object).filter(|entity| is_block_entity(entity));
    // PARITY(#299): an answer with no `name` and no `page` is neither a page nor a zoomed block, and is read as a
    // page anyway, so a block that lacks its `page` shows up as a page with an empty name (suspected TS bug) —
    // drop if Rust becomes the only server.
    let page_entity = current_page.as_ref().filter(|_| zoomed_block.is_none());

    let focused = current_block.as_ref().and_then(Value::as_object).or(zoomed_block);
    let selected_blocks: Vec<&Map<String, Value>> = selected.iter().flatten().filter_map(Value::as_object).collect();
    let all_blocks: Vec<&Map<String, Value>> = focused.into_iter().chain(selected_blocks.iter().copied()).collect();

    // Page names by id: the open page is already known; resolve the rest in one pull.
    let mut page_names: HashMap<i64, String> = HashMap::new();
    if let Some(entity) = page_entity {
        if let Some(id) = entity.get("id").and_then(Value::as_i64) {
            page_names.insert(id, page_display_name(Some(entity)));
        }
    }

    let mut missing_ids: Vec<i64> = Vec::new();
    for id in all_blocks.iter().filter_map(|block| block_page_id(block)) {
        if !page_names.contains_key(&id) && !missing_ids.contains(&id) {
            missing_ids.push(id);
        }
    }

    if !missing_ids.is_empty() {
        let ids = missing_ids.iter().map(|&id| PageId::new(id)).collect::<Result<Vec<_>, _>>()?;
        let query = pages_by_ids(&ids);
        let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
        // PARITY(#299): a `null` answer is read as no pages, so every block silently loses its page name and the
        // result may say no page is open, where BR-0011 asks for a warning that the names are unavailable
        // (suspected TS bug) — fix per #326, in both servers.
        for pulled in wire::page_rows(&answer)?.unwrap_or_default().into_iter().flatten() {
            if let Some(id) = id_of(Some(&pulled)) {
                page_names.insert(id, page_display_name(Some(&pulled)));
            }
        }
    }

    let slim = |block: &Map<String, Value>| -> Map<String, Value> {
        let name = block_page_id(block).and_then(|id| page_names.get(&id)).map_or("", String::as_str);
        to_slim_block(&with_fetched_children(block), name)
    };

    // Page: the open one, else the page of the block being looked at.
    let mut page: Option<Map<String, Value>> = page_entity.map(to_slim_page);
    if page.is_none() {
        let name = all_blocks.first().and_then(|block| block_page_id(block)).and_then(|id| page_names.get(&id)).filter(|name| !name.is_empty());
        if let Some(name) = name {
            let mut stand_in = Map::new();
            stand_in.insert("name".into(), Value::from(name.to_lowercase()));
            stand_in.insert("originalName".into(), Value::from(name.as_str()));
            page = Some(stand_in);
        }
    }

    Ok(CurrentContext {
        message: page.is_none().then_some(NO_PAGE_OPEN_MESSAGE),
        page,
        focused_block: focused.map(slim),
        selected_blocks: (!selected_blocks.is_empty()).then(|| selected_blocks.iter().map(|block| slim(block)).collect()),
    })
}

async fn fetch_current_page(client: &LogseqClient) -> Result<Option<Value>, ToolError> {
    Ok(wire::current_page(client.call_api(wire::GET_CURRENT_PAGE, &[]).await?)?)
}

async fn fetch_current_block(client: &LogseqClient) -> Result<Option<Value>, ToolError> {
    Ok(wire::current_block(client.call_api(wire::GET_CURRENT_BLOCK, &[]).await?)?)
}

async fn fetch_selected_blocks(client: &LogseqClient) -> Result<Option<Vec<Value>>, ToolError> {
    Ok(wire::selected_blocks(client.call_api(wire::GET_SELECTED_BLOCKS, &[]).await?)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::testing::{meaning, schema_of};
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().expect("an object").clone()
    }

    #[test]
    fn the_schema_is_an_empty_object_as_in_typescript() {
        let typescript = json!({"type": "object", "properties": {}, "required": []});
        assert_eq!(meaning(&schema_of::<Args>()), meaning(&typescript));
    }

    #[test]
    fn the_tool_is_read_only_titled_and_not_idempotent_as_in_typescript() {
        let tool = definition();
        assert_eq!(tool.name, NAME);
        assert_eq!(tool.title.as_deref(), Some("Get Current Context"));
        assert_eq!(
            serde_json::to_value(&tool.annotations).unwrap(),
            json!({"title": "Get Current Context", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false})
        );
    }

    #[test]
    fn an_answer_is_a_zoomed_block_when_it_has_no_name_and_has_a_page() {
        assert!(is_block_entity(&object(json!({"id": 1, "uuid": "u", "page": {"id": 2}}))));
        assert!(!is_block_entity(&object(json!({"id": 1, "uuid": "u", "name": "a", "page": {"id": 2}}))));
        assert!(!is_block_entity(&object(json!({"id": 1, "uuid": "u"}))));
        // a `null` name is a name, as `name !== undefined` has it
        assert!(!is_block_entity(&object(json!({"id": 1, "uuid": "u", "name": null, "page": {"id": 2}}))));
    }

    #[test]
    fn unfetched_children_are_dropped_at_every_depth_and_the_key_moves_last() {
        let block = object(json!({
            "id": 1, "uuid": "a", "children": [["uuid", "x"], {"id": 3, "uuid": "c", "content": "kid", "children": [["uuid", "y"]]}, {"id": 4}, "text"], "content": "p"
        }));
        assert_eq!(
            js::json_stringify(&Value::Object(with_fetched_children(&block))),
            r#"{"id":1,"uuid":"a","content":"p","children":[{"id":3,"uuid":"c","content":"kid","children":[]}]}"#
        );
        // children that are not a list are left as they came
        let odd = object(json!({"id": 1, "children": {"id": 2}}));
        assert_eq!(with_fetched_children(&odd), odd);
    }

    #[test]
    fn the_result_is_written_in_key_order_with_a_null_page() {
        let context = CurrentContext { page: None, message: Some(NO_PAGE_OPEN_MESSAGE), focused_block: Some(object(json!({"uuid": "u"}))), selected_blocks: Some(vec![]) };
        assert_eq!(
            js::json_stringify(&context.into_value()),
            r#"{"page":null,"message":"No page is open in LogSeq (for example the All Pages view is showing).","focusedBlock":{"uuid":"u"},"selectedBlocks":[]}"#
        );
    }
}
