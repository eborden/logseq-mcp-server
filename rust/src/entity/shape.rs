//! The shapes of the pages and blocks LogSeq sends, as types that derive `Deserialize`. Each names the
//! fields this crate reads of that entity, and no others: an extra key passes, and a field nobody reads
//! can hold anything, which is what lets LogSeq add keys without breaking a tool.
//!
//! A tool carries these entities as the `serde_json::Value` LogSeq sent (BR-0004) and reads them through
//! the functions in [`super`], which are tolerant (a field of another type reads as absent). So a shape is
//! the guard that makes that safe: a field read that is present but mistyped, or absent where it is
//! needed, fails the answer here, with a [`crate::wire::ResponseError`] (BR-0003). That is why a field
//! belongs in a shape if any code reads it off such an entity, and why one that no code reads does not.
//!
//! Every field LogSeq may leave out is an `Option`: absent is `None`, and `null` is not (as the value of a
//! struct's field, `Option` does not read `null` as absent; see `Wire` in `wire/deserializer.rs`). A shape that is only
//! checked is never read back, hence the allowed dead code.

#![allow(dead_code)]

use serde::Deserialize;

use crate::wire::{EntityRef, Id, Number, Object};

/// A page nested in a block (`:block/page`) or listed among its `refs`, in either spelling. Only what
/// [`super::page_display_name`], [`super::journal_flag`], [`super::journal_day_of`] and the id readers take
/// from it.
#[derive(Deserialize)]
pub(crate) struct NestedPage {
    id: Option<Id>,
    #[serde(rename = "db/id")]
    db_id: Option<Id>,
    name: Option<String>,
    #[serde(rename = "originalName")]
    original_name: Option<String>,
    #[serde(rename = "original-name")]
    original_name_pulled: Option<String>,
    #[serde(rename = "journal?")]
    is_journal: Option<bool>,
    journal: Option<bool>,
    #[serde(rename = "journalDay")]
    journal_day: Option<Number>,
    #[serde(rename = "journal-day")]
    journal_day_pulled: Option<Number>,
}

/// A block, in the fields both spellings share and the code reads. `children` is not read here: without
/// `includeChildren` the Editor API gives unfetched `["uuid", id]` tuples there, not blocks.
#[derive(Deserialize)]
pub(crate) struct Block {
    id: Id,
    uuid: String,
    content: Option<String>,
    page: Option<NestedPage>,
    parent: Option<EntityRef>,
    left: Option<EntityRef>,
    properties: Option<Object>,
    marker: Option<String>,
    refs: Option<Vec<NestedPage>>,
}

/// A page from the Editor API (`getPage`, `getAllPages`, the open page): camelCase keys, and an `id` and
/// a `name` it always has.
#[derive(Deserialize)]
pub(crate) struct EditorPage {
    pub(crate) id: Id,
    pub(crate) name: String,
    #[serde(rename = "originalName")]
    pub(crate) original_name: Option<String>,
    #[serde(rename = "journal?")]
    pub(crate) is_journal: Option<bool>,
    pub(crate) journal: Option<bool>,
    /// The page is backed by a file: it wrote its own `alias::` line, rather than being a stub
    pub(crate) file: Option<EntityRef>,
    pub(crate) alias: Option<Vec<EntityRef>>,
    properties: Option<Object>,
    #[serde(rename = "journalDay")]
    journal_day: Option<Number>,
}

/// A page from a Datalog pull: LogSeq's own kebab-case keys, every field optional, the id too.
#[derive(Deserialize)]
pub(crate) struct PulledPage {
    pub(crate) id: Option<Id>,
    #[serde(rename = "db/id")]
    pub(crate) db_id: Option<Id>,
    pub(crate) name: Option<String>,
    #[serde(rename = "original-name")]
    pub(crate) original_name: Option<String>,
    #[serde(rename = "journal?")]
    is_journal: Option<bool>,
    journal: Option<bool>,
    pub(crate) file: Option<EntityRef>,
    pub(crate) alias: Option<Vec<EntityRef>>,
    properties: Option<Object>,
    #[serde(rename = "journal-day")]
    journal_day: Option<Number>,
}

/// A page of either spelling, every field optional: the source page of a linked reference, which the
/// Editor API sends camelized and the aliased Datalog query kebab-case. Nothing asks such a page whether it
/// has a file or aliases, so those are not checked.
#[derive(Deserialize)]
pub(crate) struct PageLike {
    id: Option<Id>,
    #[serde(rename = "db/id")]
    db_id: Option<Id>,
    name: Option<String>,
    #[serde(rename = "originalName")]
    original_name: Option<String>,
    #[serde(rename = "original-name")]
    original_name_pulled: Option<String>,
    #[serde(rename = "journal?")]
    is_journal: Option<bool>,
    journal: Option<bool>,
    properties: Option<Object>,
    #[serde(rename = "journalDay")]
    journal_day: Option<Number>,
    #[serde(rename = "journal-day")]
    journal_day_pulled: Option<Number>,
}
