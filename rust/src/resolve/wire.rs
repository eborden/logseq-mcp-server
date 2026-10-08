//! What the page resolver reads from LogSeq (BR-0010): the pages a pull answers, the route that
//! found each, and the names `getAllPages` lists. Shared by every tool that takes a page; the
//! reader and the error are in `crate::wire`.

use serde_json::Value;

use crate::wire::{DATALOG_METHOD, Part, Parsed, Reader, ResponseError, entity_id, to_error};

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
    /// The page has at least one `:block/alias` link (`hasAliasLinks`). LogSeq stores each alias
    /// in both directions, so a page without any has no aliases and the alias lookup is skipped.
    pub has_alias_links: bool,
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
        let alias_links = self.entity_refs(map, "alias")?;
        self.optional_entity_ref(map, "namespace")?;
        self.map_field(map, "properties")?;
        // pagePulledKeys
        let db_id = self.id(map, "db/id")?;
        let original_name = self.string(map, "original-name")?;
        self.number(map, "journal-day")?;
        self.number(map, "created-at")?;
        self.number(map, "updated-at")?;
        self.map_field(map, "properties-text-values")?;
        // PARITY(#299): reads the Editor API's `originalName` spelling from a Datalog pull, as `entity-fields`
        // does — drop if Rust becomes the only server.
        // `entity-fields` reads `originalName` first, in case a pull carried the Editor API's
        // spelling. The schema doesn't name it, so it is read only when it is text.
        let camel = map.get("originalName").and_then(Value::as_str).map(str::to_owned);
        Ok(PulledPage {
            id,
            db_id,
            name,
            original_name: camel.filter(|name| !name.is_empty()).or(original_name),
            has_file: file.is_some(),
            has_alias_links: alias_links > 0,
        })
    }

    /// `pageLikeSchema`, checked and not kept: a page of either spelling, every field optional.
    /// The Editor API's fields (`originalName`, `journalDay`, `createdAt`, `updatedAt`) sit
    /// between the shared fields and the pulled ones in the schema, so a mismatch is reported in
    /// that order.
    pub(crate) fn page_like_check(&mut self, value: Option<&Value>) -> Parsed<()> {
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

/// `responses.aliasSetRows`: `[startId, member]` per row, the alias group of each start page.
pub fn alias_set_rows(answer: &Value) -> Result<Option<Vec<(f64, PulledPage)>>, ResponseError> {
    let mut reader = Reader::default();
    reader
        .rows(answer, 2, |r, cells| {
            let start = r.at(Part::Index(0), |r| match cells.first() {
                Some(value) => r.number_value(value),
                None => Err(r.mismatch("number", None)),
            })?;
            let member = r.at(Part::Index(1), |r| r.pulled_page(cells.get(1)))?;
            Ok((start, member))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn problem<T: std::fmt::Debug>(result: Result<T, ResponseError>) -> String {
        let error = result.unwrap_err();
        format!("{}: {}", error.path, error.problem)
    }

    // Each expected message below is what the TypeScript schema (`responses.*`, zod 4) reports for
    // the same answer: `npx tsx` over `schema.safeParse(answer).error.issues[0]`.

    #[test]
    fn a_null_answer_is_not_an_empty_one() {
        assert_eq!(resolver_rows(&Value::Null).unwrap(), None);
        assert_eq!(resolver_rows(&json!([])).unwrap(), Some(vec![]));
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
    fn the_message_names_the_method_and_the_path_and_no_value() {
        let error = resolver_rows(&json!([[{"id": 1, "name": "secret page"}, 5]])).unwrap_err();
        let message = error.to_string();
        assert!(message.starts_with(
            "LogSeq answered logseq.DB.datascriptQuery in a shape this server can't read: [0][1]: Invalid input: expected string, received number\n\nSteps to fix:\n1. Check which LogSeq version"
        ));
        assert!(!message.contains("secret page"));
    }
}
