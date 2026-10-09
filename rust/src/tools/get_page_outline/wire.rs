//! What the page outline reads from LogSeq: the blocks its query pulls (`outlineBlockSchema`).

use serde_json::Value;

use crate::wire::{DATALOG_METHOD, EntityRef, Part, Parsed, Reader, ResponseError, entity_id, to_error};

/// A block's parent as the outline reads it: a bare number, or `{ id }` (or `{ "db/id" }`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parent {
    Id(i64),
    Ref(EntityRef),
}

impl Parent {
    /// The parent's id: the number itself, or the reference's `id`, else its `db/id`, as a block's own id reads.
    pub fn id(self) -> Option<i64> {
        match self {
            Parent::Id(id) => Some(id),
            Parent::Ref(reference) => reference.entity_id(),
        }
    }
}

/// A block as the outline's query pulls it (`outlineBlockSchema`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineBlock {
    id: Option<i64>,
    db_id: Option<i64>,
    pub uuid: String,
    pub content: Option<String>,
    /// The `id` of `left`, which is all the outline reads of it.
    pub left_id: Option<i64>,
    pub parent: Option<Parent>,
}

impl OutlineBlock {
    pub fn entity_id(&self) -> Option<i64> {
        entity_id(self.id, self.db_id)
    }
}

impl Reader {
    fn outline_block(&mut self, value: Option<&Value>) -> Parsed<OutlineBlock> {
        let map = self.object(value)?;
        let id = self.id(map, "id")?;
        let db_id = self.id(map, "db/id")?;
        let uuid = self.required_string(map, "uuid")?;
        let content = self.string(map, "content")?;
        let left = self.optional_entity_ref(map, "left")?;
        let parent = self.at(Part::Key("parent"), |r| match map.get("parent") {
            None => Ok(None),
            Some(number @ Value::Number(_)) => r.id_value(number).map(|id| Some(Parent::Id(id))),
            Some(object @ Value::Object(_)) => match r.entity_ref(Some(object)) {
                Ok(reference) => Ok(Some(Parent::Ref(reference))),
                Err(_) => Err(r.issue("Invalid input")),
            },
            Some(_) => Err(r.issue("Invalid input")),
        })?;
        if id.is_none() && db_id.is_none() {
            return Err(self.issue("a block needs an id"));
        }
        Ok(OutlineBlock { id, db_id, uuid, content, left_id: left.and_then(|l| l.id), parent })
    }
}

/// `responses.outlineRows`: `[block | null]` per row. A `null` cell is `None`, which the outline
/// skips.
pub fn outline_rows(answer: &Value) -> Result<Option<Vec<Option<OutlineBlock>>>, ResponseError> {
    let mut reader = Reader::default();
    reader
        .rows(answer, 1, |r, cells| {
            r.at(Part::Index(0), |r| match cells.first() {
                Some(Value::Null) => Ok(None),
                other => r.outline_block(other).map(Some),
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
    fn a_null_answer_is_not_an_empty_one() {
        assert_eq!(outline_rows(&Value::Null).unwrap(), None);
        assert_eq!(outline_rows(&json!([])).unwrap(), Some(vec![]));
    }

    #[test]
    fn an_outline_row_reads_the_fields_the_outline_uses() {
        let rows = outline_rows(&json!([
            [{"id": 101, "uuid": "u1", "content": "Kickoff", "left": {"id": 10}, "parent": {"id": 10}, "extra": true}],
            [{"db/id": 102, "uuid": "u2", "parent": 10}],
            [null]
        ]))
        .unwrap()
        .unwrap();
        let first = rows[0].as_ref().unwrap();
        assert_eq!((first.entity_id(), first.uuid.as_str(), first.content.as_deref()), (Some(101), "u1", Some("Kickoff")));
        assert_eq!((first.left_id, first.parent.and_then(Parent::id)), (Some(10), Some(10)));
        let second = rows[1].as_ref().unwrap();
        assert_eq!((second.entity_id(), second.content.as_deref(), second.left_id), (Some(102), None, None));
        assert_eq!(second.parent.and_then(Parent::id), Some(10));
        assert_eq!(rows[2], None);
    }

    #[test]
    fn a_parent_is_a_reference_or_a_number_and_nothing_else() {
        let parent = |value: Value| outline_rows(&json!([[{"id": 1, "uuid": "u", "parent": value}]]));
        for bad in [json!("a"), json!({"id": "a"}), json!(null), json!(true), json!({"id": 1, "db/id": "x"})] {
            assert_eq!(problem(parent(bad)), "[0][0].parent: Invalid input");
        }
        // A parent reference reads `id`, then `db/id`, as a block's own id does.
        let rows = outline_rows(&json!([[{"id": 1, "uuid": "u", "parent": {"db/id": 9}}]])).unwrap().unwrap();
        assert_eq!(rows[0].as_ref().unwrap().parent.and_then(Parent::id), Some(9));
        let rows = outline_rows(&json!([[{"id": 1, "uuid": "u", "parent": {"id": 4, "db/id": 9}}]])).unwrap().unwrap();
        assert_eq!(rows[0].as_ref().unwrap().parent.and_then(Parent::id), Some(4));
        let rows = outline_rows(&json!([[{"id": 1, "uuid": "u", "parent": {}}]])).unwrap().unwrap();
        assert_eq!(rows[0].as_ref().unwrap().parent.and_then(Parent::id), None);
    }

    #[test]
    fn an_outline_block_needs_an_id_and_a_uuid() {
        assert_eq!(problem(outline_rows(&json!([[{"uuid": "u"}]]))), "[0][0]: a block needs an id");
        assert_eq!(
            problem(outline_rows(&json!([[{"id": 1}]]))),
            "[0][0].uuid: Invalid input: expected string, received undefined"
        );
        assert_eq!(
            problem(outline_rows(&json!([[{"id": 1, "uuid": "u", "content": null}]]))),
            "[0][0].content: Invalid input: expected string, received null"
        );
        assert_eq!(
            problem(outline_rows(&json!([[{"id": 1, "uuid": "u", "left": null}]]))),
            "[0][0].left: Invalid input: expected object, received null"
        );
        assert_eq!(problem(outline_rows(&json!([[1]]))), "[0][0]: Invalid input: expected object, received number");
        assert_eq!(problem(outline_rows(&json!([[[]]]))), "[0][0]: Invalid input: expected object, received array");
        assert_eq!(problem(outline_rows(&json!([{}]))), "[0]: Invalid input: expected tuple, received object");
        assert_eq!(problem(outline_rows(&json!([[{"id": 1, "uuid": "u"}, {"id": 2}]]))), "[0]: Too big: expected array to have <1 items");
    }

    #[test]
    fn an_id_must_be_a_whole_number() {
        assert_eq!(problem(outline_rows(&json!([[{"id": 1.5, "uuid": "u"}]]))), "[0][0].id: Invalid input: expected int, received number");
        // JSON.parse reads 5.0 as 5.
        assert!(outline_rows(&json!([[{"id": 5.0, "uuid": "u"}]])).is_ok());
    }
}
