//! What the ref lookup reads from LogSeq: the blocks and pages a `((uuid))` or an embed points at
//! (`refTargetSchema` and `responses.refTargetRows` in `src/response-schemas.ts`).

use serde_json::Value;

use crate::wire::{DATALOG_METHOD, Part, Parsed, Reader, ResponseError, to_error};

/// The page a target block sits on: the parts the lookup pulls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetPage {
    pub id: Option<i64>,
    pub name: Option<String>,
    pub original_name: Option<String>,
}

/// A block or page the lookup pulled (`refTargets`). A block has `uuid`, `content`, `left`,
/// `parent` and `page`; a page has `name` and `original-name`. A placeholder LogSeq makes for a
/// `((uuid))` that no real block has holds only `id`, `uuid` and `content`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefTarget {
    pub id: i64,
    pub uuid: Option<String>,
    pub content: Option<String>,
    pub name: Option<String>,
    pub original_name: Option<String>,
    /// The `id` of `:block/left`, which orders siblings
    pub left_id: Option<i64>,
    /// The `id` of `:block/parent`
    pub parent_id: Option<i64>,
    pub page: Option<TargetPage>,
}

impl Reader {
    fn ref_target(&mut self, value: Option<&Value>) -> Parsed<RefTarget> {
        let map = self.object(value)?;
        // `id` is the one field a row must have
        self.required_whole(map, "id")?;
        let id = self.id(map, "id")?.expect("a checked id is there");
        let uuid = self.string(map, "uuid")?;
        let content = self.string(map, "content")?;
        let name = self.string(map, "name")?;
        let original_name = self.string(map, "original-name")?;
        let left = self.optional_entity_ref(map, "left")?;
        let parent = self.optional_entity_ref(map, "parent")?;
        let page = self.at(Part::Key("page"), |r| match map.get("page") {
            None => Ok(None),
            some => {
                let page = r.object(some)?;
                Ok(Some(TargetPage {
                    id: r.id(page, "id")?,
                    name: r.string(page, "name")?,
                    original_name: r.string(page, "original-name")?,
                }))
            }
        })?;
        Ok(RefTarget {
            id,
            uuid,
            content,
            name,
            original_name,
            left_id: left.and_then(|left| left.id),
            parent_id: parent.and_then(|parent| parent.id),
            page,
        })
    }
}

/// `responses.refTargetRows`: `null`, or one `[target | null]` per row. A `null` cell is `None`,
/// which the lookup skips.
pub fn target_rows(answer: &Value) -> Result<Option<Vec<Option<RefTarget>>>, ResponseError> {
    let mut reader = Reader::default();
    reader
        .rows(answer, 1, |r, cells| {
            r.at(Part::Index(0), |r| match cells.first() {
                Some(Value::Null) => Ok(None),
                cell => r.ref_target(cell).map(Some),
            })
        })
        .map_err(|issue| to_error(DATALOG_METHOD, issue))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn problem<T: std::fmt::Debug>(result: Result<T, ResponseError>) -> String {
        let error = result.unwrap_err();
        format!("{}: {}", error.path, error.problem)
    }

    #[test]
    fn a_block_is_read_with_the_ids_of_its_left_parent_and_page() {
        let answer = json!([[{
            "id": 7, "uuid": "u", "content": "text", "left": {"id": 5}, "parent": {"id": 3},
            "page": {"id": 2, "name": "alice", "original-name": "Alice"}, "extra": true
        }]]);
        let rows = target_rows(&answer).unwrap().unwrap();
        assert_eq!(
            rows,
            [Some(RefTarget {
                id: 7,
                uuid: Some("u".into()),
                content: Some("text".into()),
                name: None,
                original_name: None,
                left_id: Some(5),
                parent_id: Some(3),
                page: Some(TargetPage { id: Some(2), name: Some("alice".into()), original_name: Some("Alice".into()) }),
            })]
        );
    }

    #[test]
    fn a_placeholder_and_a_page_have_only_what_they_have() {
        let rows = target_rows(&json!([[{"id": 1, "uuid": "u", "content": "id:: u"}], [{"id": 2, "name": "alice", "original-name": "Alice"}]]))
            .unwrap()
            .unwrap();
        assert_eq!((rows[0].as_ref().unwrap().page.clone(), rows[0].as_ref().unwrap().name.clone()), (None, None));
        assert_eq!(rows[1].as_ref().unwrap().name.as_deref(), Some("alice"));
        assert_eq!(rows[1].as_ref().unwrap().content, None);
    }

    #[test]
    fn null_is_its_own_case_and_a_null_cell_is_skipped() {
        assert_eq!(target_rows(&json!(null)).unwrap(), None);
        assert_eq!(target_rows(&json!([])).unwrap(), Some(vec![]));
        assert_eq!(target_rows(&json!([[null]])).unwrap(), Some(vec![None]));
    }

    #[test]
    fn a_row_that_is_not_a_target_is_an_error_naming_the_path_and_no_value() {
        assert_eq!(problem(target_rows(&json!({}))), "(response): Invalid input: expected array, received object");
        assert_eq!(problem(target_rows(&json!([[1]]))), "[0][0]: Invalid input: expected object, received number");
        assert_eq!(problem(target_rows(&json!([[]]))), "[0][0]: Invalid input: expected object, received undefined");
        assert_eq!(problem(target_rows(&json!([[{"uuid": "u"}]]))), "[0][0].id: Invalid input: expected number, received undefined");
        assert_eq!(problem(target_rows(&json!([[{"id": 1, "content": 5}]]))), "[0][0].content: Invalid input: expected string, received number");
        assert_eq!(problem(target_rows(&json!([[{"id": 1, "page": null}]]))), "[0][0].page: Invalid input: expected object, received null");
        assert_eq!(problem(target_rows(&json!([[{"id": 1, "page": {"name": 4}}]]))), "[0][0].page.name: Invalid input: expected string, received number");
        assert_eq!(problem(target_rows(&json!([[{"id": 1, "parent": {"id": "x"}}]]))), "[0][0].parent.id: Invalid input: expected number, received string");
    }
}
