//! Pages and blocks as LogSeq spells them (the Rust side of `src/utils/entity-fields.ts` and the
//! entity schemas in `src/response-schemas.ts`).
//!
//! LogSeq spells an entity two ways. `logseq.Editor.*` camelizes keys (`originalName`,
//! `journalDay`); a Datalog pull keeps LogSeq's own (`original-name`, `journal-day`). A tool's full
//! output carries each entity as it came, key order and spelling included (BR-0004), so an entity
//! is kept as the `serde_json::Value` LogSeq sent and is never rewritten into one shape. This
//! module does two things with it:
//! - *checks* it against the schema the TypeScript server checks it with (`check_*`, run by the
//!   tool's own reader), so a field the code reads that is missing or mistyped is a
//!   `ResponseError` and never "no data" (BR-0003);
//! - *reads* a field whichever way it is spelled (the free functions below), which is the one
//!   place that knows the two spellings, so no tool carries its own `a ?? b ?? c`.
//!
//! Only the spelling is decided here. What an empty or absent value means stays with the caller,
//! except [`page_display_name`], which is the one display-name policy.

use serde_json::Value;

use crate::wire::{Parsed, Part, Reader, entity_id};

/// A whole number a JSON value holds, as the id of an entity is.
fn whole(value: Option<&Value>) -> Option<i64> {
    value.and_then(crate::wire::whole_number)
}

/// `entityId`: the id of an entity or of a reference to one, in either spelling. A missing `id`
/// falls through to `db/id`; an `id` of 0 is an id.
pub fn id_of(entity: Option<&Value>) -> Option<i64> {
    let map = entity?.as_object()?;
    entity_id(whole(map.get("id")), whole(map.get("db/id")))
}

/// The text a key holds, when it is text.
fn text<'v>(map: &'v serde_json::Map<String, Value>, key: &str) -> Option<&'v str> {
    map.get(key).and_then(Value::as_str)
}

/// `originalNameOf`: the original-case name, in either spelling. An empty one counts as missing.
pub fn original_name_of(page: Option<&Value>) -> Option<&str> {
    let map = page?.as_object()?;
    // `a || b`: the first that is not empty, else the second
    text(map, "originalName").filter(|name| !name.is_empty()).or_else(|| text(map, "original-name"))
}

/// `pageDisplayName`: the original-case name, else `:block/name`, else `""`. An empty original name
/// counts as missing, so a page never shows as blank while it has a name.
pub fn page_display_name(page: Option<&Value>) -> String {
    let name = page.and_then(Value::as_object).and_then(|map| text(map, "name"));
    original_name_of(page).filter(|name| !name.is_empty()).or(name.filter(|name| !name.is_empty())).unwrap_or("").to_owned()
}

/// `journalFlag`: the page's journal flag as LogSeq set it, in either spelling. `None` when it says
/// nothing.
pub fn journal_flag(page: Option<&Value>) -> Option<bool> {
    let map = page?.as_object()?;
    map.get("journal?").and_then(Value::as_bool).or_else(|| map.get("journal").and_then(Value::as_bool))
}

/// `journalDayOf`: the `YYYYMMDD` journal day of a page, in either spelling.
pub fn journal_day_of(page: Option<&Value>) -> Option<i64> {
    let map = page?.as_object()?;
    whole(map.get("journalDay")).or_else(|| whole(map.get("journal-day")))
}

impl Reader {
    /// A field that must be present and a whole number: a `:db/id` (`z.number()`).
    pub(crate) fn required_whole(&mut self, map: &serde_json::Map<String, Value>, key: &'static str) -> Parsed<()> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Err(r.mismatch("number", None)),
            Some(value) => r.id_value(value).map(|_| ()),
        })
    }

    /// The fields a page has in both dialects (`pageShared`).
    fn check_page_shared(&mut self, map: &serde_json::Map<String, Value>) -> Parsed<()> {
        self.string(map, "uuid")?;
        self.boolean(map, "journal?")?;
        self.boolean(map, "journal")?;
        self.optional_entity_ref(map, "file")?;
        self.entity_refs(map, "alias")?;
        self.optional_entity_ref(map, "namespace")?;
        self.map_field(map, "properties")?;
        Ok(())
    }

    /// `editorPageSchema`: a page from the Editor API (`getAllPages`), camelCase keys.
    pub(crate) fn check_editor_page(&mut self, value: Option<&Value>) -> Parsed<()> {
        let map = self.object(value)?;
        self.required_whole(map, "id")?;
        self.required_string(map, "name")?;
        self.check_page_shared(map)?;
        self.string(map, "originalName")?;
        self.number(map, "journalDay")?;
        self.number(map, "createdAt")?;
        self.number(map, "updatedAt")?;
        Ok(())
    }

    /// `pulledPageSchema`: a page from a Datalog pull, LogSeq's own kebab-case keys. Every field is
    /// optional, the id too.
    pub(crate) fn check_pulled_page(&mut self, value: Option<&Value>) -> Parsed<()> {
        let map = self.object(value)?;
        self.id(map, "id")?;
        self.string(map, "name")?;
        self.check_page_shared(map)?;
        self.id(map, "db/id")?;
        self.string(map, "original-name")?;
        self.number(map, "journal-day")?;
        self.number(map, "created-at")?;
        self.number(map, "updated-at")?;
        self.map_field(map, "properties-text-values")?;
        Ok(())
    }

    /// `pageLikeSchema`, checked and not kept: a page of either spelling, every field optional.
    /// The Editor API's fields (`originalName`, `journalDay`, `createdAt`, `updatedAt`) sit
    /// between the shared fields and the pulled ones in the schema, so a mismatch is reported in
    /// that order.
    pub(crate) fn check_page_like(&mut self, value: Option<&Value>) -> Parsed<()> {
        let map = self.object(value)?;
        self.id(map, "id")?;
        self.string(map, "name")?;
        self.string(map, "uuid")?;
        self.boolean(map, "journal?")?;
        self.boolean(map, "journal")?;
        self.optional_entity_ref(map, "file")?;
        self.entity_refs(map, "alias")?;
        self.optional_entity_ref(map, "namespace")?;
        self.map_field(map, "properties")?;
        self.string(map, "originalName")?;
        self.number(map, "journalDay")?;
        self.number(map, "createdAt")?;
        self.number(map, "updatedAt")?;
        self.id(map, "db/id")?;
        self.string(map, "original-name")?;
        self.number(map, "journal-day")?;
        self.number(map, "created-at")?;
        self.number(map, "updated-at")?;
        self.map_field(map, "properties-text-values")?;
        Ok(())
    }

    /// `nestedPageSchema`: the page nested in a block, or one of its refs. Only what the readers
    /// take from such a page is checked, since a block carries one page and several refs.
    pub(crate) fn check_nested_page(&mut self, value: Option<&Value>) -> Parsed<()> {
        let map = self.object(value)?;
        self.id(map, "id")?;
        self.id(map, "db/id")?;
        self.string(map, "name")?;
        self.string(map, "originalName")?;
        self.string(map, "original-name")?;
        self.boolean(map, "journal?")?;
        self.boolean(map, "journal")?;
        self.number(map, "journalDay")?;
        self.number(map, "journal-day")?;
        Ok(())
    }

    /// `blockSchema`: a block, in the fields both dialects spell the same and the code reads.
    /// `children` is not checked: without `includeChildren` the Editor API gives unfetched tuples
    /// there, not blocks.
    pub(crate) fn check_block(&mut self, value: Option<&Value>) -> Parsed<()> {
        let map = self.object(value)?;
        self.required_whole(map, "id")?;
        self.required_string(map, "uuid")?;
        self.string(map, "content")?;
        self.at(Part::Key("page"), |r| match map.get("page") {
            None => Ok(()),
            some => r.check_nested_page(some),
        })?;
        self.optional_entity_ref(map, "parent")?;
        self.optional_entity_ref(map, "left")?;
        self.map_field(map, "properties")?;
        self.string(map, "marker")?;
        self.at(Part::Key("refs"), |r| match map.get("refs") {
            None => Ok(()),
            Some(Value::Array(items)) => {
                for (i, item) in items.iter().enumerate() {
                    r.at(Part::Index(i), |r| r.check_nested_page(Some(item)))?;
                }
                Ok(())
            }
            Some(other) => Err(r.mismatch("array", Some(other))),
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::to_error;
    use serde_json::json;

    fn problem(check: impl FnOnce(&mut Reader, Option<&Value>) -> Parsed<()>, value: Value) -> String {
        let issue = check(&mut Reader::default(), Some(&value)).unwrap_err();
        let error = to_error("m", issue);
        format!("{}: {}", error.path, error.problem)
    }

    #[test]
    fn an_id_falls_through_to_db_id_only_when_it_is_missing() {
        assert_eq!(id_of(Some(&json!({"id": 7, "db/id": 9}))), Some(7));
        assert_eq!(id_of(Some(&json!({"id": 0, "db/id": 9}))), Some(0));
        assert_eq!(id_of(Some(&json!({"db/id": 9}))), Some(9));
        assert_eq!(id_of(Some(&json!({}))), None);
        assert_eq!(id_of(Some(&json!(null))), None);
        assert_eq!(id_of(None), None);
    }

    #[test]
    fn the_original_name_is_read_in_either_spelling_and_empty_counts_as_missing() {
        assert_eq!(page_display_name(Some(&json!({"name": "alice", "originalName": "Alice"}))), "Alice");
        assert_eq!(page_display_name(Some(&json!({"name": "alice", "original-name": "Alice"}))), "Alice");
        assert_eq!(page_display_name(Some(&json!({"name": "alice", "originalName": "", "original-name": "Alice"}))), "Alice");
        assert_eq!(page_display_name(Some(&json!({"name": "alice", "originalName": ""}))), "alice");
        assert_eq!(page_display_name(Some(&json!({"id": 3}))), "");
        assert_eq!(page_display_name(None), "");
    }

    #[test]
    fn the_journal_flag_and_day_are_read_in_either_spelling() {
        assert_eq!(journal_flag(Some(&json!({"journal?": false, "journal": true}))), Some(false));
        assert_eq!(journal_flag(Some(&json!({"journal": true}))), Some(true));
        assert_eq!(journal_flag(Some(&json!({}))), None);
        assert_eq!(journal_day_of(Some(&json!({"journal-day": 20250101}))), Some(20250101));
        assert_eq!(journal_day_of(Some(&json!({"journalDay": 20250102, "journal-day": 1}))), Some(20250102));
    }

    #[test]
    fn an_editor_page_needs_an_id_and_a_name() {
        let check = |r: &mut Reader, v: Option<&Value>| r.check_editor_page(v);
        assert_eq!(problem(check, json!({"name": "a"})), "id: Invalid input: expected number, received undefined");
        assert_eq!(problem(check, json!({"id": 1})), "name: Invalid input: expected string, received undefined");
        assert_eq!(problem(check, json!({"id": 1, "name": "a", "alias": [{"id": "x"}]})), "alias[0].id: Invalid input: expected number, received string");
        assert!(check(&mut Reader::default(), Some(&json!({"id": 1, "name": "a", "originalName": "A", "extra": 1}))).is_ok());
    }

    #[test]
    fn what_the_check_accepts_as_an_id_the_readers_read_and_never_as_absent() {
        // `5.0` and `1e3` are whole numbers to a JavaScript number but floats to serde_json
        let editor = |r: &mut Reader, v: Option<&Value>| r.check_editor_page(v);
        let block = |r: &mut Reader, v: Option<&Value>| r.check_block(v);
        for (id, read) in [(json!(5), 5), (json!(5.0), 5), (json!(1e3), 1000)] {
            let page = json!({"id": id, "name": "a", "uuid": "u"});
            assert!(editor(&mut Reader::default(), Some(&page)).is_ok(), "{id}");
            assert!(block(&mut Reader::default(), Some(&page)).is_ok(), "{id}");
            assert_eq!(id_of(Some(&page)), Some(read), "{id}");
        }
        // a fraction or a number past 2^53 is no id, and the check says so
        for id in [json!(1.5), json!(1e300), json!(9007199254740993u64)] {
            let page = json!({"id": id, "name": "a", "uuid": "u"});
            assert!(problem(editor, page.clone()).starts_with("id: Invalid input: expected int"), "{id}");
            assert!(problem(block, page).starts_with("id: Invalid input: expected int"), "{id}");
        }
    }

    #[test]
    fn a_block_needs_an_id_and_a_uuid_and_checks_its_page_and_refs() {
        let check = |r: &mut Reader, v: Option<&Value>| r.check_block(v);
        assert_eq!(problem(check, json!({"uuid": "u"})), "id: Invalid input: expected number, received undefined");
        assert_eq!(problem(check, json!({"id": 1})), "uuid: Invalid input: expected string, received undefined");
        assert_eq!(problem(check, json!({"id": 1, "uuid": "u", "content": 5})), "content: Invalid input: expected string, received number");
        assert_eq!(problem(check, json!({"id": 1, "uuid": "u", "page": null})), "page: Invalid input: expected object, received null");
        assert_eq!(problem(check, json!({"id": 1, "uuid": "u", "refs": [{"name": 3}]})), "refs[0].name: Invalid input: expected string, received number");
        assert!(check(&mut Reader::default(), Some(&json!({"id": 1, "uuid": "u", "children": ["uuid", "x"], "page": {"id": 2}}))).is_ok());
    }
}
