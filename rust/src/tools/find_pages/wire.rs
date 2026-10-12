//! What `logseq.Editor.getAllPages` answers, for the fields the page finder reads.

use serde_json::Value;

use crate::entity::shape::EditorPage;
use crate::wire::{Properties, ResponseError, parse};

/// The method the answer comes from, as a response error names it.
pub const METHOD: &str = "logseq.Editor.getAllPages";

/// A page as the finder reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct ListedEntity {
    pub id: i64,
    /// `:block/name`, lowercase
    pub name: String,
    /// `originalName`, or the name when the page has none or it is empty
    pub display_name: String,
    /// LogSeq says it is a journal (`journal?`, or `journal`)
    pub journal: bool,
    /// The page is backed by a file: it wrote its own `alias::` line, rather than being a stub
    pub written: bool,
    /// The ids in `alias`. A link with no `id` points at nothing and is left out.
    pub alias_ids: Vec<i64>,
    /// The page-level properties, which a page with none leaves out
    pub properties: Option<Properties>,
}

impl From<EditorPage> for ListedEntity {
    fn from(page: EditorPage) -> Self {
        // the original name, else the name: the Editor API's spelling only, and an empty one counts as missing
        let display_name = page.original_name.filter(|name| !name.is_empty()).unwrap_or_else(|| page.name.clone());
        ListedEntity {
            id: page.id.0,
            name: page.name,
            display_name,
            // `journal?`, else `journal`
            journal: page.is_journal.or(page.journal).unwrap_or(false),
            written: page.file.is_some(),
            alias_ids: page.alias.unwrap_or_default().into_iter().filter_map(|link| link.id).collect(),
            properties: page.properties,
        }
    }
}

/// The answer: `null`, or one entity per page.
pub fn pages(answer: &Value) -> Result<Option<Vec<ListedEntity>>, ResponseError> {
    Ok(parse::<Option<Vec<EditorPage>>>(METHOD, answer)?.map(|pages| pages.into_iter().map(ListedEntity::from).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::PropertyValue;
    use serde_json::json;

    fn problem(answer: Value) -> String {
        let error = pages(&answer).unwrap_err();
        format!("{}: {}", error.path, error.problem)
    }

    #[test]
    fn a_page_is_read_for_the_fields_the_list_uses() {
        let answer = json!([
            {"id": 1, "name": "alice", "originalName": "Alice", "file": {"id": 9}, "alias": [{"id": 2}, {}], "journal?": false},
            {"id": 2, "name": "al", "originalName": "", "journal": true}
        ]);
        let pages = pages(&answer).unwrap().unwrap();
        assert_eq!(
            pages[0],
            ListedEntity { id: 1, name: "alice".into(), display_name: "Alice".into(), journal: false, written: true, alias_ids: vec![2], properties: None }
        );
        assert_eq!(
            pages[1],
            ListedEntity { id: 2, name: "al".into(), display_name: "al".into(), journal: true, written: false, alias_ids: vec![], properties: None }
        );
    }

    #[test]
    fn the_properties_of_a_page_are_read_by_kind_and_a_value_of_no_kind_is_read_too() {
        let answer = json!([{"id": 1, "name": "a", "properties": {
            "status": "active", "effort": 3, "ratio": 0.75, "reviewed": true,
            "owner": ["Alice", 4, null, ["x"], {"y": 1}, "Bob"], "note": null, "nested": {"a": [1]}
        }}]);
        let page = pages(&answer).unwrap().unwrap().remove(0);
        assert_eq!(
            page.properties,
            Some(Properties(vec![
                ("status".to_owned(), PropertyValue::Text("active".to_owned())),
                ("effort".to_owned(), PropertyValue::Number(3.0)),
                ("ratio".to_owned(), PropertyValue::Number(0.75)),
                ("reviewed".to_owned(), PropertyValue::Flag(true)),
                ("owner".to_owned(), PropertyValue::Set(vec!["Alice".to_owned(), "Bob".to_owned()])),
                ("note".to_owned(), PropertyValue::Other),
                ("nested".to_owned(), PropertyValue::Other),
            ]))
        );
        // a page with no properties has none, and an empty map is a page with none to match
        assert_eq!(pages(&json!([{"id": 1, "name": "a"}])).unwrap().unwrap()[0].properties, None);
        assert_eq!(pages(&json!([{"id": 1, "name": "a", "properties": {}}])).unwrap().unwrap()[0].properties, Some(Properties(vec![])));
    }

    #[test]
    fn properties_that_are_no_object_are_an_error_that_never_shows_a_key() {
        assert_eq!(problem(json!([{"id": 1, "name": "a", "properties": []}])), "answer[0].properties: expected an object, got a list");
        assert_eq!(problem(json!([{"id": 1, "name": "a", "properties": null}])), "answer[0].properties: expected an object, got null");
    }

    #[test]
    fn a_float_valued_whole_id_is_read_as_that_id_and_never_panics() {
        let answer = json!([{"id": 5.0, "name": "a", "alias": [{"id": 1e3}]}]);
        let page = pages(&answer).unwrap().unwrap().remove(0);
        assert_eq!((page.id, page.alias_ids), (5, vec![1000]));
    }

    #[test]
    fn null_is_not_an_empty_list() {
        assert_eq!(pages(&json!(null)).unwrap(), None);
        assert_eq!(pages(&json!([])).unwrap(), Some(vec![]));
    }

    #[test]
    fn a_page_the_list_cannot_read_is_an_error_naming_the_path() {
        assert_eq!(problem(json!({})), "answer: expected a list, got an object");
        assert_eq!(problem(json!([{"id": 1, "name": "a"}, {"id": "2", "name": "b"}])), "answer[1].id: expected a whole number, got a string");
        assert_eq!(problem(json!([{"id": 1}])), "answer[0].name: required, but missing");
        assert_eq!(problem(json!([{"id": 1, "name": 5}])), "answer[0].name: expected a string, got a number");
        assert_eq!(problem(json!([{"id": 1.5, "name": "a"}])), "answer[0].id: expected a whole number, got a number with a fraction");
        assert_eq!(problem(json!([{"name": "a"}])), "answer[0].id: required, but missing");
        // a field the list reads is checked, and `null` is not an absent one
        assert_eq!(problem(json!([{"id": 1, "name": "a", "originalName": null}])), "answer[0].originalName: expected a string, got null");
        assert_eq!(problem(json!([{"id": 1, "name": "a", "file": null}])), "answer[0].file: expected an object, got null");
        assert_eq!(problem(json!([{"id": 1, "name": "a", "alias": [null]}])), "answer[0].alias[0]: expected an object, got null");
    }

    #[test]
    fn a_field_the_list_never_reads_may_hold_anything() {
        let answer = json!([{"id": 1, "name": "a", "uuid": 5, "namespace": [], "createdAt": "x", "updatedAt": null, "extra": {}}]);
        assert_eq!(pages(&answer).unwrap().unwrap().len(), 1);
    }
}
