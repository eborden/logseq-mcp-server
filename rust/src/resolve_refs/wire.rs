//! What the ref lookup reads from LogSeq: the blocks and pages a `((uuid))` or an embed points at.

use serde::Deserialize;
use serde_json::Value;

use crate::wire::{DATALOG_METHOD, EntityRef, Id, Optional, ResponseError, parse};

/// The page a target block sits on: the parts the lookup pulls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetPage {
    pub id: Option<i64>,
    pub name: Option<String>,
    pub original_name: Option<String>,
}

/// A block or page the lookup pulled. A block has `uuid`, `content`, `left`,
/// `parent` and `page`; a page has `name` and `original-name`. A placeholder LogSeq makes for a
/// `((uuid))` that no real block has holds only `id`, `uuid` and `content`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(from = "Pulled")]
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

/// What a row is read as: `id` is the one field a row must have.
#[derive(Deserialize)]
struct Pulled {
    id: Id,
    #[serde(default)]
    uuid: Optional<String>,
    #[serde(default)]
    content: Optional<String>,
    #[serde(default)]
    name: Optional<String>,
    #[serde(default, rename = "original-name")]
    original_name: Optional<String>,
    #[serde(default)]
    left: Optional<EntityRef>,
    #[serde(default)]
    parent: Optional<EntityRef>,
    #[serde(default)]
    page: Optional<PulledPage>,
}

#[derive(Deserialize)]
struct PulledPage {
    #[serde(default)]
    id: Optional<Id>,
    #[serde(default)]
    name: Optional<String>,
    #[serde(default, rename = "original-name")]
    original_name: Optional<String>,
}

impl From<Pulled> for RefTarget {
    fn from(pulled: Pulled) -> Self {
        RefTarget {
            id: pulled.id.0,
            uuid: pulled.uuid.into_option(),
            content: pulled.content.into_option(),
            name: pulled.name.into_option(),
            original_name: pulled.original_name.into_option(),
            left_id: pulled.left.into_option().and_then(|left| left.id),
            parent_id: pulled.parent.into_option().and_then(|parent| parent.id),
            page: pulled.page.into_option().map(|page| TargetPage {
                id: page.id.into_option().map(|id| id.0),
                name: page.name.into_option(),
                original_name: page.original_name.into_option(),
            }),
        }
    }
}

/// The answer: `null`, or one `[target | null]` per row. A `null` cell is `None`,
/// which the lookup skips.
pub fn target_rows(answer: &Value) -> Result<Option<Vec<Option<RefTarget>>>, ResponseError> {
    Ok(parse::<Option<Vec<(Option<RefTarget>,)>>>(DATALOG_METHOD, answer)?.map(|rows| rows.into_iter().map(|(target,)| target).collect()))
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
        assert_eq!(problem(target_rows(&json!({}))), "answer: expected a list, got an object");
        assert_eq!(problem(target_rows(&json!([[1]]))), "answer[0][0]: expected an object, got a number");
        assert_eq!(problem(target_rows(&json!([[]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(target_rows(&json!([[{"uuid": "u"}]]))), "answer[0][0].id: required, but missing");
        assert_eq!(problem(target_rows(&json!([[{"id": 1, "content": 5}]]))), "answer[0][0].content: expected a string, got a number");
        assert_eq!(problem(target_rows(&json!([[{"id": 1, "page": null}]]))), "answer[0][0].page: expected an object, got null");
        assert_eq!(problem(target_rows(&json!([[{"id": 1, "page": {"name": 4}}]]))), "answer[0][0].page.name: expected a string, got a number");
        assert_eq!(problem(target_rows(&json!([[{"id": 1, "parent": {"id": "x"}}]]))), "answer[0][0].parent.id: expected a whole number, got a string");
    }

    /// The fields a ref target may leave out: left out is fine, `null` is a mismatch at that field (BR-0003).
    #[test]
    fn a_null_in_any_field_that_may_be_left_out_is_a_mismatch_and_leaving_it_out_is_not() {
        for key in ["uuid", "content", "name", "original-name", "left", "parent", "page"] {
            let mut target = json!({"id": 1});
            assert!(target_rows(&json!([[target.clone()]])).is_ok(), "{key} left out");
            target[key] = Value::Null;
            let said = problem(target_rows(&json!([[target]])));
            assert!(said.starts_with(&format!("answer[0][0].{key}: expected ")), "{said}");
        }
        for key in ["id", "name", "original-name"] {
            let mut page = json!({});
            assert!(target_rows(&json!([[{"id": 1, "page": page.clone()}]])).is_ok(), "page.{key} left out");
            page[key] = Value::Null;
            let said = problem(target_rows(&json!([[{"id": 1, "page": page}]])));
            assert!(said.starts_with(&format!("answer[0][0].page.{key}: expected ")), "{said}");
        }
        // the one a row must have
        assert_eq!(problem(target_rows(&json!([[{"id": null}]]))), "answer[0][0].id: expected a whole number, got null");
    }
}
