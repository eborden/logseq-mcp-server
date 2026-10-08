//! What LogSeq answers, parsed into typed values at the boundary (the Rust side of
//! `src/response-schemas.ts` and `src/utils/parse-response.ts`, #202).
//!
//! A tool never reads a `serde_json::Value` it got from LogSeq. Each answer a tool makes is
//! parsed here into a type that holds only the fields the tool reads, and an answer that isn't
//! that shape is a [`ResponseError`], never "no data" (BR-0003). As in TypeScript:
//! - extra keys pass, since LogSeq adds them, and a field the tool doesn't read is still checked
//!   when the schema names it, so a mistyped one fails here and not three tools later;
//! - `null` is a case of its own (BR-0011): the parsers return `None` for a `null` answer and
//!   the tool decides what that means;
//! - the error names the method and where the first mismatch is, in zod's words, and never a value
//!   from the answer, because an answer is the user's graph (ADR-0004).
//!
//! The first mismatch is the first in the schema's field order, depth first, which is the order
//! each parser reads its fields in. Each parser lists them in the TypeScript schema's order.
//!
//! One deliberate difference: an `:db/id` must be a whole number. zod's `z.number()` takes a
//! fraction, and the TypeScript tools then fail at `groundIds` or carry on, depending on which
//! page it was. LogSeq never sends one, so the Rust side refuses it where it reads it.

use std::fmt;

use serde_json::{Map, Value};

/// The method a Datalog answer reports in a [`ResponseError`].
pub const DATALOG_METHOD: &str = "logseq.DB.datascriptQuery";

/// LogSeq answered, but not in a shape this server reads (`LogSeqResponseError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseError {
    pub method: String,
    /// Where the first mismatch is, e.g. `[0][0].id`, or `(response)` for the top level.
    pub path: String,
    /// What was expected there, in zod's words: types only, never the received value.
    pub problem: String,
}

impl fmt::Display for ResponseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "LogSeq answered {} in a shape this server can't read: {}: {}\n\n\
             Steps to fix:\n\
             1. Check which LogSeq version is running. This server is tested against LogSeq 0.10.x, and a different version may name or type fields differently\n\
             2. If the version is right, report this on the project's GitHub issues with the method name and the path above (leave out page names and block text)",
            self.method, self.path, self.problem
        )
    }
}

impl std::error::Error for ResponseError {}

#[derive(Debug, Clone)]
enum Part {
    Index(usize),
    Key(&'static str),
}

/// The first thing wrong with an answer.
#[derive(Debug)]
struct Issue {
    path: Vec<Part>,
    problem: String,
}

type Parsed<T> = Result<T, Issue>;

/// A reader that knows where in the answer it is, so an issue can say.
#[derive(Default)]
struct Reader {
    path: Vec<Part>,
}

impl Reader {
    fn issue(&self, problem: impl Into<String>) -> Issue {
        Issue { path: self.path.clone(), problem: problem.into() }
    }

    fn at<T>(&mut self, part: Part, read: impl FnOnce(&mut Reader) -> Parsed<T>) -> Parsed<T> {
        self.path.push(part);
        let result = read(self);
        self.path.pop();
        result
    }

    fn mismatch(&self, expected: &str, found: Option<&Value>) -> Issue {
        self.issue(format!("Invalid input: expected {expected}, received {}", kind(found)))
    }

    /// A value that must be an object (`z.object`).
    fn object<'v>(&self, value: Option<&'v Value>) -> Parsed<&'v Map<String, Value>> {
        match value {
            Some(Value::Object(map)) => Ok(map),
            other => Err(self.mismatch("object", other)),
        }
    }

    /// A field that may be absent and, when present, must be a number (`z.number().optional()`).
    fn number(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<Option<f64>> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(None),
            Some(value) => r.number_value(value).map(Some),
        })
    }

    fn number_value(&self, value: &Value) -> Parsed<f64> {
        match value {
            Value::Number(n) => Ok(n.as_f64().expect("a JSON number is finite")),
            other => Err(self.mismatch("number", Some(other))),
        }
    }

    /// A field that may be absent and, when present, must be a whole number: a `:db/id`.
    fn id(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<Option<i64>> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(None),
            Some(value) => {
                let n = r.number_value(value)?;
                // 2^53 is where an f64 stops holding every whole number, as a JavaScript number does
                if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
                    Ok(Some(n as i64))
                } else {
                    Err(r.mismatch("int", Some(value)))
                }
            }
        })
    }

    fn string(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<Option<String>> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(None),
            Some(value) => r.string_value(value).map(Some),
        })
    }

    fn string_value(&self, value: &Value) -> Parsed<String> {
        match value {
            Value::String(s) => Ok(s.clone()),
            other => Err(self.mismatch("string", Some(other))),
        }
    }

    fn required_string(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<String> {
        self.at(Part::Key(key), |r| match map.get(key) {
            Some(value) => r.string_value(value),
            None => Err(r.mismatch("string", None)),
        })
    }

    fn boolean(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<Option<bool>> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(other) => Err(r.mismatch("boolean", Some(other))),
        })
    }

    /// A field that may be absent and must be a map when present (`propertiesSchema`: the keys
    /// are the user's own and the values anything, so only the map is checked).
    fn map_field(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<()> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None | Some(Value::Object(_)) => Ok(()),
            Some(_) => Err(r.issue("expected an object")),
        })
    }

    /// `{ id?, "db/id"? }`: a bare reference to a page or a block (`entityRefSchema`).
    fn entity_ref(&mut self, value: Option<&Value>) -> Parsed<EntityRef> {
        let map = self.object(value)?;
        Ok(EntityRef { id: self.id(map, "id")?, db_id: self.id(map, "db/id")? })
    }

    fn optional_entity_ref(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<Option<EntityRef>> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(None),
            some => r.entity_ref(some).map(Some),
        })
    }

    fn entity_refs(&mut self, map: &Map<String, Value>, key: &'static str) -> Parsed<()> {
        self.at(Part::Key(key), |r| match map.get(key) {
            None => Ok(()),
            Some(Value::Array(items)) => {
                for (i, item) in items.iter().enumerate() {
                    r.at(Part::Index(i), |r| r.entity_ref(Some(item)))?;
                }
                Ok(())
            }
            Some(other) => Err(r.mismatch("array", Some(other))),
        })
    }

    /// An answer that is `null` or a list of rows, each row a tuple of `width` cells (`rows(...)`
    /// in TypeScript). A row longer than `width` is wrong, and a shorter one is read with its
    /// missing cells as `undefined`, which each cell's parser accepts or not.
    fn rows<T>(
        &mut self,
        answer: &Value,
        width: usize,
        read_row: impl Fn(&mut Reader, &[Value]) -> Parsed<T>,
    ) -> Parsed<Option<Vec<T>>> {
        let items = match answer {
            Value::Null => return Ok(None),
            Value::Array(items) => items,
            other => return Err(self.mismatch("array", Some(other))),
        };
        let mut rows = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            rows.push(self.at(Part::Index(i), |r| match item {
                Value::Array(cells) if cells.len() > width => {
                    Err(r.issue(format!("Too big: expected array to have <{width} items")))
                }
                Value::Array(cells) => read_row(r, cells),
                other => Err(r.mismatch("tuple", Some(other))),
            })?);
        }
        Ok(Some(rows))
    }
}

/// What zod calls the type of a JSON value in "received ...".
fn kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// An issue as `LogSeqResponseError` reports it: `[0].id` for a path of `0, "id"`, and
/// `(response)` for the top level.
fn to_error(method: &str, issue: Issue) -> ResponseError {
    let path = if issue.path.is_empty() {
        "(response)".to_owned()
    } else {
        let joined: String = issue
            .path
            .iter()
            .map(|part| match part {
                Part::Index(i) => format!("[{i}]"),
                Part::Key(key) => format!(".{key}"),
            })
            .collect();
        joined.strip_prefix('.').map(str::to_owned).unwrap_or(joined)
    };
    ResponseError { method: method.to_owned(), path, problem: issue.problem }
}

/// A bare reference to an entity: the ids it carries, in either spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EntityRef {
    pub id: Option<i64>,
    pub db_id: Option<i64>,
}

/// `entityId`: `id`, else `db/id` when `id` is absent or zero (`entity?.id || entity?.['db/id']`).
fn entity_id(id: Option<i64>, db_id: Option<i64>) -> Option<i64> {
    id.filter(|id| *id != 0).or(db_id)
}

impl EntityRef {
    pub fn entity_id(&self) -> Option<i64> {
        entity_id(self.id, self.db_id)
    }
}

/// A page as a Datalog pull answers it (`pulledPageSchema`), with the fields the tools read.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PulledPage {
    id: Option<i64>,
    db_id: Option<i64>,
    /// `:block/name`, lowercase. Absent from a pull that didn't ask for it.
    pub name: Option<String>,
    original_name: Option<String>,
    /// The page is backed by a file. A page that only exists as a link target has none (a stub).
    pub has_file: bool,
}

impl PulledPage {
    pub fn entity_id(&self) -> Option<i64> {
        entity_id(self.id, self.db_id)
    }

    /// `pageName`: the lowercased `:block/name`, `""` when the page has none.
    pub fn lower_name(&self) -> String {
        self.name.as_deref().unwrap_or("").to_lowercase()
    }

    /// `pageDisplayName`: the original-case name, else `:block/name`, else `""`. An empty
    /// original name counts as missing.
    pub fn display_name(&self) -> String {
        self.original_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .or(self.name.as_deref().filter(|name| !name.is_empty()))
            .unwrap_or("")
            .to_owned()
    }
}

impl Reader {
    fn pulled_page(&mut self, value: Option<&Value>) -> Parsed<PulledPage> {
        let map = self.object(value)?;
        let id = self.id(map, "id")?;
        let name = self.string(map, "name")?;
        // pageShared
        self.string(map, "uuid")?;
        self.boolean(map, "journal?")?;
        self.boolean(map, "journal")?;
        let file = self.optional_entity_ref(map, "file")?;
        self.entity_refs(map, "alias")?;
        self.optional_entity_ref(map, "namespace")?;
        self.map_field(map, "properties")?;
        // pagePulledKeys
        let db_id = self.id(map, "db/id")?;
        let original_name = self.string(map, "original-name")?;
        self.number(map, "journal-day")?;
        self.number(map, "created-at")?;
        self.number(map, "updated-at")?;
        self.map_field(map, "properties-text-values")?;
        // `entity-fields` reads `originalName` first, in case a pull carried the Editor API's
        // spelling. The schema doesn't name it, so it is read only when it is text.
        let camel = map.get("originalName").and_then(Value::as_str).map(str::to_owned);
        Ok(PulledPage {
            id,
            db_id,
            name,
            original_name: camel.filter(|name| !name.is_empty()).or(original_name),
            has_file: file.is_some(),
        })
    }
}

/// One row of the resolver's first query: the page and the route that found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolverRow {
    pub page: PulledPage,
    /// `name`, `alias` or `journal-date`. Absent for a plain page row, which is an exact match.
    pub via: Option<String>,
}

/// `responses.resolverRows`: `[page, via?]` per row.
pub fn resolver_rows(answer: &Value) -> Result<Option<Vec<ResolverRow>>, ResponseError> {
    let mut reader = Reader::default();
    reader
        .rows(answer, 2, |r, cells| {
            let page = r.at(Part::Index(0), |r| r.pulled_page(cells.first()))?;
            let via = r.at(Part::Index(1), |r| match cells.get(1) {
                None => Ok(None),
                Some(value) => r.string_value(value).map(Some),
            })?;
            Ok(ResolverRow { page, via })
        })
        .map_err(|issue| to_error(DATALOG_METHOD, issue))
}

/// `responses.pageRows`: `[page]` per row.
pub fn page_rows(answer: &Value) -> Result<Option<Vec<PulledPage>>, ResponseError> {
    let mut reader = Reader::default();
    reader
        .rows(answer, 1, |r, cells| r.at(Part::Index(0), |r| r.pulled_page(cells.first())))
        .map_err(|issue| to_error(DATALOG_METHOD, issue))
}

/// `responses.pageNames`: `getAllPages`, read for the original name of each page. A page whose
/// `originalName` is absent is `None`.
pub fn page_names(answer: &Value, method: &str) -> Result<Option<Vec<Option<String>>>, ResponseError> {
    let mut reader = Reader::default();
    let read = |reader: &mut Reader| -> Parsed<Option<Vec<Option<String>>>> {
        let items = match answer {
            Value::Null => return Ok(None),
            Value::Array(items) => items,
            other => return Err(reader.mismatch("array", Some(other))),
        };
        let mut names = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            names.push(reader.at(Part::Index(i), |r| {
                let map = r.object(Some(item))?;
                r.string(map, "originalName")
            })?);
        }
        Ok(Some(names))
    };
    read(&mut reader).map_err(|issue| to_error(method, issue))
}

/// A block's parent as the outline reads it: a bare number, or `{ id }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parent {
    Id(i64),
    Ref(EntityRef),
}

impl Parent {
    /// `parentIdOf`: the number itself, or the reference's `id` (not its `db/id`).
    pub fn id(self) -> Option<i64> {
        match self {
            Parent::Id(id) => Some(id),
            Parent::Ref(reference) => reference.id,
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

    fn id_value(&self, value: &Value) -> Parsed<i64> {
        let n = self.number_value(value)?;
        if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
            Ok(n as i64)
        } else {
            Err(self.mismatch("int", Some(value)))
        }
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

    fn problem<T: fmt::Debug>(result: Result<T, ResponseError>) -> String {
        let error = result.unwrap_err();
        format!("{}: {}", error.path, error.problem)
    }

    // Each expected message below is what the TypeScript schema (`responses.*`, zod 4) reports for
    // the same answer: `npx tsx` over `schema.safeParse(answer).error.issues[0]`.

    #[test]
    fn a_null_answer_is_not_an_empty_one() {
        assert_eq!(resolver_rows(&Value::Null).unwrap(), None);
        assert_eq!(resolver_rows(&json!([])).unwrap(), Some(vec![]));
        assert_eq!(outline_rows(&Value::Null).unwrap(), None);
        assert_eq!(page_rows(&Value::Null).unwrap(), None);
        assert_eq!(page_names(&Value::Null, "m").unwrap(), None);
    }

    #[test]
    fn a_resolver_row_is_a_page_and_an_optional_route() {
        let rows = resolver_rows(&json!([
            [{"id": 10, "name": "project atlas", "original-name": "Project Atlas", "file": {"id": 1}, "extra": 1}, "name"],
            [{"id": 20, "name": "bob"}]
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(rows[0].via.as_deref(), Some("name"));
        assert_eq!(rows[0].page.entity_id(), Some(10));
        assert_eq!(rows[0].page.display_name(), "Project Atlas");
        assert!(rows[0].page.has_file);
        assert_eq!(rows[1].via, None);
        assert_eq!(rows[1].page.display_name(), "bob");
        assert!(!rows[1].page.has_file);
    }

    #[test]
    fn an_id_falls_back_to_db_id_when_it_is_zero_or_absent() {
        let page = |value: Value| resolver_rows(&json!([[value]])).unwrap().unwrap().remove(0).page;
        assert_eq!(page(json!({"db/id": 7})).entity_id(), Some(7));
        assert_eq!(page(json!({"id": 0, "db/id": 7})).entity_id(), Some(7));
        assert_eq!(page(json!({"id": 3, "db/id": 7})).entity_id(), Some(3));
        assert_eq!(page(json!({})).entity_id(), None);
    }

    #[test]
    fn a_name_that_is_not_text_is_a_response_error_naming_the_path() {
        assert_eq!(
            problem(resolver_rows(&json!([[{"id": 1, "name": null}, "x"]]))),
            "[0][0].name: Invalid input: expected string, received null"
        );
        assert_eq!(
            problem(resolver_rows(&json!([[{"id": "1"}, "x"]]))),
            "[0][0].id: Invalid input: expected number, received string"
        );
        assert_eq!(
            problem(resolver_rows(&json!([[{"id": 1, "file": {"id": "a"}}, "x"]]))),
            "[0][0].file.id: Invalid input: expected number, received string"
        );
        assert_eq!(
            problem(resolver_rows(&json!([[{"id": 1, "alias": [1]}, "x"]]))),
            "[0][0].alias[0]: Invalid input: expected object, received number"
        );
        assert_eq!(
            problem(resolver_rows(&json!([[{"id": 1, "alias": {}}, "x"]]))),
            "[0][0].alias: Invalid input: expected array, received object"
        );
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1, "properties": []}, "x"]]))), "[0][0].properties: expected an object");
        assert_eq!(
            problem(resolver_rows(&json!([[{"id": 1, "original-name": null}, "x"]]))),
            "[0][0].original-name: Invalid input: expected string, received null"
        );
        assert_eq!(
            problem(resolver_rows(&json!([[{"id": 1, "journal?": "yes"}, "x"]]))),
            "[0][0].journal?: Invalid input: expected boolean, received string"
        );
    }

    #[test]
    fn the_first_mismatch_in_schema_order_is_the_one_reported() {
        // `id` comes before `name` in the schema, whichever the answer lists first.
        assert_eq!(
            problem(resolver_rows(&json!([[{"name": 2, "id": "a"}, "x"]]))),
            "[0][0].id: Invalid input: expected number, received string"
        );
    }

    #[test]
    fn a_row_is_a_tuple_of_the_right_width() {
        assert_eq!(problem(resolver_rows(&json!({"a": 1}))), "(response): Invalid input: expected array, received object");
        assert_eq!(problem(resolver_rows(&json!("x"))), "(response): Invalid input: expected array, received string");
        assert_eq!(problem(resolver_rows(&json!([1]))), "[0]: Invalid input: expected tuple, received number");
        assert_eq!(problem(resolver_rows(&json!([null]))), "[0]: Invalid input: expected tuple, received null");
        assert_eq!(problem(resolver_rows(&json!([[]]))), "[0][0]: Invalid input: expected object, received undefined");
        assert_eq!(problem(resolver_rows(&json!([[null, "x"]]))), "[0][0]: Invalid input: expected object, received null");
        assert_eq!(problem(resolver_rows(&json!([[[], "x"]]))), "[0][0]: Invalid input: expected object, received array");
        assert_eq!(
            problem(resolver_rows(&json!([[{"id": 1}, 1]]))),
            "[0][1]: Invalid input: expected string, received number"
        );
        assert_eq!(
            problem(resolver_rows(&json!([[{"id": 1}, null]]))),
            "[0][1]: Invalid input: expected string, received null"
        );
        // Too many cells is reported before any cell is read, whatever the cells hold.
        assert_eq!(problem(resolver_rows(&json!([[{"id": "1"}, "x", "y"]]))), "[0]: Too big: expected array to have <2 items");
        assert_eq!(problem(page_rows(&json!([[{"id": 1}, 2]]))), "[0]: Too big: expected array to have <1 items");
    }

    #[test]
    fn a_page_name_list_reads_only_the_original_name() {
        let names = page_names(&json!([{"originalName": "Alice", "id": 1}, {}]), "m").unwrap().unwrap();
        assert_eq!(names, vec![Some("Alice".to_owned()), None]);
        assert_eq!(
            problem(page_names(&json!([{"originalName": "a"}, {"originalName": 3}]), "m")),
            "[1].originalName: Invalid input: expected string, received number"
        );
        assert_eq!(problem(page_names(&json!([{}, null]), "m")), "[1]: Invalid input: expected object, received null");
        assert_eq!(problem(page_names(&json!({}), "m")), "(response): Invalid input: expected array, received object");
        assert_eq!(page_names(&json!([1]), "logseq.Editor.getAllPages").unwrap_err().method, "logseq.Editor.getAllPages");
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
        // Only `id` counts for a parent reference, as `parentIdOf` has it.
        let rows = outline_rows(&json!([[{"id": 1, "uuid": "u", "parent": {"db/id": 9}}]])).unwrap().unwrap();
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

    #[test]
    fn the_message_names_the_method_and_the_path_and_no_value() {
        let error = resolver_rows(&json!([[{"id": 1, "name": "secret page"}, 5]])).unwrap_err();
        let message = error.to_string();
        assert!(message.starts_with(
            "LogSeq answered logseq.DB.datascriptQuery in a shape this server can't read: [0][1]: Invalid input: expected string, received number\n\nSteps to fix:\n1. Check which LogSeq version"
        ));
        assert!(!message.contains("secret page"));
    }
}
