//! What the page outline reads from LogSeq: the blocks its query pulls (`outlineBlockSchema`).

use std::fmt;

use serde::Deserialize;
use serde::de::value::MapAccessDeserializer;
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde_json::Value;

use crate::wire::{DATALOG_METHOD, EntityRef, IdVisitor, Optional, ResponseError, entity_id, parse};

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

impl<'de> Deserialize<'de> for Parent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Parent, D::Error> {
        deserializer.deserialize_any(ParentVisitor)
    }
}

struct ParentVisitor;

impl<'de> Visitor<'de> for ParentVisitor {
    type Value = Parent;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a whole number or an object")
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Parent, E> {
        IdVisitor.visit_u64(value).map(|id| Parent::Id(id.0))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Parent, E> {
        IdVisitor.visit_i64(value).map(|id| Parent::Id(id.0))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Parent, E> {
        IdVisitor.visit_f64(value).map(|id| Parent::Id(id.0))
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Parent, A::Error> {
        EntityRef::deserialize(MapAccessDeserializer::new(map)).map(Parent::Ref)
    }
}

/// A block as the outline's query pulls it (`outlineBlockSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "Pulled")]
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

/// What a row is read as.
#[derive(Deserialize)]
struct Pulled {
    #[serde(default)]
    id: Optional<crate::wire::Id>,
    #[serde(default, rename = "db/id")]
    db_id: Optional<crate::wire::Id>,
    uuid: String,
    #[serde(default)]
    content: Optional<String>,
    #[serde(default)]
    left: Optional<EntityRef>,
    #[serde(default)]
    parent: Optional<Parent>,
}

impl TryFrom<Pulled> for OutlineBlock {
    type Error = &'static str;

    fn try_from(pulled: Pulled) -> Result<Self, Self::Error> {
        let id = pulled.id.into_option().map(|id| id.0);
        let db_id = pulled.db_id.into_option().map(|id| id.0);
        if id.is_none() && db_id.is_none() {
            return Err("a block needs an id or a db/id, and has neither");
        }
        Ok(OutlineBlock {
            id,
            db_id,
            uuid: pulled.uuid,
            content: pulled.content.into_option(),
            left_id: pulled.left.into_option().and_then(|left| left.id),
            parent: pulled.parent.into_option(),
        })
    }
}

/// `responses.outlineRows`: `[block | null]` per row. A `null` cell is `None`, which the outline
/// skips.
pub fn outline_rows(answer: &Value) -> Result<Option<Vec<Option<OutlineBlock>>>, ResponseError> {
    Ok(parse::<Option<Vec<(Option<OutlineBlock>,)>>>(DATALOG_METHOD, answer)?.map(|rows| rows.into_iter().map(|(block,)| block).collect()))
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
        for (bad, said) in [
            (json!("a"), "answer[0][0].parent: expected a whole number or an object, got a string"),
            (json!({"id": "a"}), "answer[0][0].parent.id: expected a whole number, got a string"),
            (json!(null), "answer[0][0].parent: expected a whole number or an object, got null"),
            (json!(true), "answer[0][0].parent: expected a whole number or an object, got a boolean"),
            (json!({"id": 1, "db/id": "x"}), "answer[0][0].parent.db/id: expected a whole number, got a string"),
            (json!(1.5), "answer[0][0].parent: expected a whole number, got a number with a fraction"),
        ] {
            assert_eq!(problem(parent(bad)), said);
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
        assert_eq!(problem(outline_rows(&json!([[{"uuid": "u"}]]))), "answer[0][0]: a block needs an id or a db/id, and has neither");
        assert_eq!(
            problem(outline_rows(&json!([[{"id": 1}]]))),
            "answer[0][0].uuid: required, but missing"
        );
        assert_eq!(
            problem(outline_rows(&json!([[{"id": 1, "uuid": "u", "content": null}]]))),
            "answer[0][0].content: expected a string, got null"
        );
        assert_eq!(
            problem(outline_rows(&json!([[{"id": 1, "uuid": "u", "left": null}]]))),
            "answer[0][0].left: expected an object, got null"
        );
        assert_eq!(problem(outline_rows(&json!([[1]]))), "answer[0][0]: expected an object, got a number");
        assert_eq!(problem(outline_rows(&json!([[[]]]))), "answer[0][0]: expected an object, got a list");
        assert_eq!(problem(outline_rows(&json!([{}]))), "answer[0]: expected a row, got an object");
        assert_eq!(problem(outline_rows(&json!([[{"id": 1, "uuid": "u"}, {"id": 2}]]))), "answer[0]: the row has more cells than this server reads");
    }

    #[test]
    fn an_id_must_be_a_whole_number() {
        assert_eq!(problem(outline_rows(&json!([[{"id": 1.5, "uuid": "u"}]]))), "answer[0][0].id: expected a whole number, got a number with a fraction");
        // JSON.parse reads 5.0 as 5.
        assert!(outline_rows(&json!([[{"id": 5.0, "uuid": "u"}]])).is_ok());
    }
}
