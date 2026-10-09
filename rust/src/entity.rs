//! Pages and blocks as LogSeq spells them (the Rust side of `src/utils/entity-fields.ts` and the
//! entity schemas in `src/response-schemas.ts`).
//!
//! LogSeq spells an entity two ways. `logseq.Editor.*` camelizes keys (`originalName`,
//! `journalDay`); a Datalog pull keeps LogSeq's own (`original-name`, `journal-day`). A tool's full
//! output carries each entity as it came, key order and spelling included (BR-0004), so an entity
//! is kept as the `serde_json::Value` LogSeq sent and is never rewritten into one shape. This
//! module does two things with it:
//! - *checks* it against the shapes in [`shape`] (read by the tool's own wire reader), so a field the
//!   code reads that is missing or mistyped is a `ResponseError` and never "no data" (BR-0003);
//! - *reads* a field whichever way it is spelled (the free functions below), which is the one
//!   place that knows the two spellings, so no tool carries its own `a ?? b ?? c`.
//!
//! Only the spelling is decided here. What an empty or absent value means stays with the caller,
//! except [`page_display_name`], which is the one display-name policy.

use serde_json::Value;

use crate::wire::entity_id;

pub(crate) mod shape;

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    // ---- the shapes: what a page or a block must be for the code that reads it

    use super::shape::{Block, EditorPage, NestedPage, PageLike, PulledPage};
    use crate::wire::parse;
    use serde::de::DeserializeOwned;

    /// What a shape says of an answer: `path: problem`, or a panic when it accepts it.
    fn problem<T: DeserializeOwned>(value: Value) -> String {
        match parse::<T>("m", &value) {
            Ok(_) => panic!("accepted {value}"),
            Err(error) => format!("{}: {}", error.path, error.problem),
        }
    }

    fn accepts<T: DeserializeOwned>(value: Value) -> bool {
        parse::<T>("m", &value).is_ok()
    }

    #[test]
    fn an_editor_page_needs_an_id_and_a_name() {
        assert_eq!(problem::<EditorPage>(json!({"name": "a"})), "answer.id: required, but missing");
        assert_eq!(problem::<EditorPage>(json!({"id": 1})), "answer.name: required, but missing");
        assert_eq!(problem::<EditorPage>(json!({"id": 1, "name": "a", "alias": [{"id": "x"}]})), "answer.alias[0].id: expected a whole number, got a string");
        assert!(accepts::<EditorPage>(json!({"id": 1, "name": "a", "originalName": "A", "extra": 1})));
    }

    #[test]
    fn what_the_check_accepts_as_an_id_the_readers_read_and_never_as_absent() {
        // `5.0` and `1e3` are whole numbers to a JavaScript number but floats to serde_json
        for (id, read) in [(json!(5), 5), (json!(5.0), 5), (json!(1e3), 1000)] {
            let page = json!({"id": id, "name": "a", "uuid": "u"});
            assert!(accepts::<EditorPage>(page.clone()), "{id}");
            assert!(accepts::<Block>(page.clone()), "{id}");
            assert_eq!(id_of(Some(&page)), Some(read), "{id}");
        }
        // a fraction or a number past 2^53 is no id, and the check says so
        for id in [json!(1.5), json!(1e300), json!(9007199254740993u64)] {
            let page = json!({"id": id, "name": "a", "uuid": "u"});
            assert!(problem::<EditorPage>(page.clone()).starts_with("answer.id: expected a whole number"), "{id}");
            assert!(problem::<Block>(page).starts_with("answer.id: expected a whole number"), "{id}");
        }
    }

    #[test]
    fn a_block_needs_an_id_and_a_uuid_and_checks_its_page_and_refs() {
        assert_eq!(problem::<Block>(json!({"uuid": "u"})), "answer.id: required, but missing");
        assert_eq!(problem::<Block>(json!({"id": 1})), "answer.uuid: required, but missing");
        assert_eq!(problem::<Block>(json!({"id": 1, "uuid": "u", "content": 5})), "answer.content: expected a string, got a number");
        assert_eq!(problem::<Block>(json!({"id": 1, "uuid": "u", "page": null})), "answer.page: expected an object, got null");
        assert_eq!(problem::<Block>(json!({"id": 1, "uuid": "u", "refs": [{"name": 3}]})), "answer.refs[0].name: expected a string, got a number");
        assert!(accepts::<Block>(json!({"id": 1, "uuid": "u", "children": ["uuid", "x"], "page": {"id": 2}})));
    }

    #[test]
    fn a_field_that_may_be_left_out_may_not_be_null() {
        // a null is a mismatch in every field a shape reads (BR-0003), so a field read as absent is absent
        let block = |key: &str| {
            let mut block = json!({"id": 1, "uuid": "u"});
            block[key] = Value::Null;
            block
        };
        for key in ["content", "page", "parent", "left", "properties", "marker", "refs"] {
            assert!(problem::<Block>(block(key)).starts_with(&format!("answer.{key}: expected ")), "{key}");
        }
        let nested = |key: &str| {
            let mut page = json!({});
            page[key] = Value::Null;
            page
        };
        for key in ["id", "db/id", "name", "originalName", "original-name", "journal?", "journal", "journalDay", "journal-day"] {
            assert!(problem::<NestedPage>(nested(key)).starts_with(&format!("answer.{key}: expected ")), "{key}");
        }
        let editor = |key: &str| {
            let mut page = json!({"id": 1, "name": "a"});
            page[key] = Value::Null;
            page
        };
        for key in ["originalName", "journal?", "journal", "file", "alias", "properties", "journalDay"] {
            assert!(problem::<EditorPage>(editor(key)).starts_with(&format!("answer.{key}: expected ")), "{key}");
        }
        for key in ["id", "db/id", "name", "original-name", "journal?", "journal", "file", "alias", "properties", "journal-day"] {
            assert!(problem::<PulledPage>(nested(key)).starts_with(&format!("answer.{key}: expected ")), "{key}");
        }
        for key in ["id", "db/id", "name", "originalName", "original-name", "journal?", "journal", "properties", "journalDay", "journal-day"] {
            assert!(problem::<PageLike>(nested(key)).starts_with(&format!("answer.{key}: expected ")), "{key}");
        }
    }

    #[test]
    fn a_field_nothing_reads_may_hold_anything() {
        let unread = json!({"uuid": 5, "namespace": [1], "createdAt": "x", "updatedAt": null, "created-at": {}, "updated-at": [], "properties-text-values": 7});
        let with_unread = |mut page: Value| {
            page.as_object_mut().unwrap().extend(unread.as_object().unwrap().clone());
            page
        };
        assert!(accepts::<EditorPage>(with_unread(json!({"id": 1, "name": "a"}))));
        assert!(accepts::<PulledPage>(with_unread(json!({}))));
        assert!(accepts::<PageLike>(with_unread(json!({}))));
        assert!(accepts::<NestedPage>(with_unread(json!({}))));
        // and a block's children, which are not read here
        assert!(accepts::<Block>(json!({"id": 1, "uuid": "u", "children": {"a": 1}, "path-refs": "x", "format": 3})));
    }
}
