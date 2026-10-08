//! What `logseq.Editor.getAllPages` answers, for the fields the page list reads
//! (`responses.editorPages` in `src/response-schemas.ts`).

use serde_json::Value;

use crate::entity::journal_flag;
use crate::wire::{Part, Reader, ResponseError, to_error};

/// The method the answer comes from, as a response error names it.
pub const METHOD: &str = "logseq.Editor.getAllPages";

/// A page as the list reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedEntity {
    pub id: i64,
    /// `:block/name`, lowercase
    pub name: String,
    /// `originalName`, or the name when the page has none or it is empty (`displayName`)
    pub display_name: String,
    /// LogSeq says it is a journal (`journal?`, or `journal`)
    pub journal: bool,
    /// The page is backed by a file: it wrote its own `alias::` line, rather than being a stub
    pub written: bool,
    /// The ids in `alias`. A link with no `id` points at nothing and is left out.
    pub alias_ids: Vec<i64>,
}

/// `responses.editorPages`: `null`, or one entity per page.
pub fn pages(answer: &Value) -> Result<Option<Vec<ListedEntity>>, ResponseError> {
    let mut reader = Reader::default();
    let read = |reader: &mut Reader| -> Result<Option<Vec<ListedEntity>>, crate::wire::Issue> {
        let items = match answer {
            Value::Null => return Ok(None),
            Value::Array(items) => items,
            other => return Err(reader.mismatch("array", Some(other))),
        };
        let mut pages = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            reader.at(Part::Index(i), |r| r.check_editor_page(Some(item)))?;
            pages.push(entity(item));
        }
        Ok(Some(pages))
    };
    read(&mut reader).map_err(|issue| to_error(METHOD, issue))
}

/// Read a checked page. `id` and `name` are there, and every other field has the type checked.
fn entity(page: &Value) -> ListedEntity {
    let alias_ids = page
        .get("alias")
        .and_then(Value::as_array)
        .map(|links| links.iter().filter_map(|link| link.get("id").and_then(Value::as_f64)).map(|id| id as i64).collect())
        .unwrap_or_default();
    let name = page["name"].as_str().expect("a checked page has a name");
    // `page.originalName || page.name`: the Editor API's spelling only, and an empty one counts as missing
    let display_name = page.get("originalName").and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or(name);
    ListedEntity {
        id: page["id"].as_f64().expect("a checked page has an id") as i64,
        name: name.to_owned(),
        display_name: display_name.to_owned(),
        journal: journal_flag(Some(page)).unwrap_or(false),
        written: page.get("file").is_some_and(|file| !file.is_null()),
        alias_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            ListedEntity { id: 1, name: "alice".into(), display_name: "Alice".into(), journal: false, written: true, alias_ids: vec![2] }
        );
        assert_eq!(
            pages[1],
            ListedEntity { id: 2, name: "al".into(), display_name: "al".into(), journal: true, written: false, alias_ids: vec![] }
        );
    }

    #[test]
    fn null_is_not_an_empty_list() {
        assert_eq!(pages(&json!(null)).unwrap(), None);
        assert_eq!(pages(&json!([])).unwrap(), Some(vec![]));
    }

    #[test]
    fn a_page_the_list_cannot_read_is_an_error_naming_the_path() {
        assert_eq!(problem(json!({})), "(response): Invalid input: expected array, received object");
        assert_eq!(problem(json!([{"id": 1, "name": "a"}, {"id": "2", "name": "b"}])), "[1].id: Invalid input: expected number, received string");
        assert_eq!(problem(json!([{"id": 1}])), "[0].name: Invalid input: expected string, received undefined");
    }
}
