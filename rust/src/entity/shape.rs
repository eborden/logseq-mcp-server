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
//! Every field LogSeq may leave out is an [`Optional`] with `#[serde(default)]`: absent is fine, `null`
//! is not. A shape that is only checked is never read back, hence the allowed dead code.

#![allow(dead_code)]

use serde::Deserialize;

use crate::wire::{EntityRef, Id, Number, Object, Optional};

/// A page nested in a block (`:block/page`) or listed among its `refs`, in either spelling. Only what
/// [`super::page_display_name`], [`super::journal_flag`], [`super::journal_day_of`] and the id readers take
/// from it.
#[derive(Deserialize)]
pub(crate) struct NestedPage {
    #[serde(default)]
    id: Optional<Id>,
    #[serde(default, rename = "db/id")]
    db_id: Optional<Id>,
    #[serde(default)]
    name: Optional<String>,
    #[serde(default, rename = "originalName")]
    original_name: Optional<String>,
    #[serde(default, rename = "original-name")]
    original_name_pulled: Optional<String>,
    #[serde(default, rename = "journal?")]
    is_journal: Optional<bool>,
    #[serde(default)]
    journal: Optional<bool>,
    #[serde(default, rename = "journalDay")]
    journal_day: Optional<Number>,
    #[serde(default, rename = "journal-day")]
    journal_day_pulled: Optional<Number>,
}

/// A block, in the fields both spellings share and the code reads. `children` is not read here: without
/// `includeChildren` the Editor API gives unfetched `["uuid", id]` tuples there, not blocks.
#[derive(Deserialize)]
pub(crate) struct Block {
    id: Id,
    uuid: String,
    #[serde(default)]
    content: Optional<String>,
    #[serde(default)]
    page: Optional<NestedPage>,
    #[serde(default)]
    parent: Optional<EntityRef>,
    #[serde(default)]
    left: Optional<EntityRef>,
    #[serde(default)]
    properties: Optional<Object>,
    #[serde(default)]
    marker: Optional<String>,
    #[serde(default)]
    refs: Optional<Vec<NestedPage>>,
}

/// A page from the Editor API (`getPage`, `getAllPages`, the open page): camelCase keys, and an `id` and
/// a `name` it always has.
#[derive(Deserialize)]
pub(crate) struct EditorPage {
    pub(crate) id: Id,
    pub(crate) name: String,
    #[serde(default, rename = "originalName")]
    pub(crate) original_name: Optional<String>,
    #[serde(default, rename = "journal?")]
    pub(crate) is_journal: Optional<bool>,
    #[serde(default)]
    pub(crate) journal: Optional<bool>,
    /// The page is backed by a file: it wrote its own `alias::` line, rather than being a stub
    #[serde(default)]
    pub(crate) file: Optional<EntityRef>,
    #[serde(default)]
    pub(crate) alias: Optional<Vec<EntityRef>>,
    #[serde(default)]
    properties: Optional<Object>,
    #[serde(default, rename = "journalDay")]
    journal_day: Optional<Number>,
}

/// A page from a Datalog pull: LogSeq's own kebab-case keys, every field optional, the id too.
#[derive(Deserialize)]
pub(crate) struct PulledPage {
    #[serde(default)]
    pub(crate) id: Optional<Id>,
    #[serde(default, rename = "db/id")]
    pub(crate) db_id: Optional<Id>,
    #[serde(default)]
    pub(crate) name: Optional<String>,
    #[serde(default, rename = "original-name")]
    pub(crate) original_name: Optional<String>,
    #[serde(default, rename = "journal?")]
    is_journal: Optional<bool>,
    #[serde(default)]
    journal: Optional<bool>,
    #[serde(default)]
    pub(crate) file: Optional<EntityRef>,
    #[serde(default)]
    pub(crate) alias: Optional<Vec<EntityRef>>,
    #[serde(default)]
    properties: Optional<Object>,
    #[serde(default, rename = "journal-day")]
    journal_day: Optional<Number>,
}

/// A page of either spelling, every field optional: the source page of a linked reference, which the
/// Editor API sends camelized and the aliased Datalog query kebab-case. Nothing asks such a page whether it
/// has a file or aliases, so those are not checked.
#[derive(Deserialize)]
pub(crate) struct PageLike {
    #[serde(default)]
    id: Optional<Id>,
    #[serde(default, rename = "db/id")]
    db_id: Optional<Id>,
    #[serde(default)]
    name: Optional<String>,
    #[serde(default, rename = "originalName")]
    original_name: Optional<String>,
    #[serde(default, rename = "original-name")]
    original_name_pulled: Optional<String>,
    #[serde(default, rename = "journal?")]
    is_journal: Optional<bool>,
    #[serde(default)]
    journal: Optional<bool>,
    #[serde(default)]
    properties: Optional<Object>,
    #[serde(default, rename = "journalDay")]
    journal_day: Optional<Number>,
    #[serde(default, rename = "journal-day")]
    journal_day_pulled: Optional<Number>,
}
