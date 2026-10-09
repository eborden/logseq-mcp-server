//! What the page resolver reads from LogSeq (BR-0010): the pages a pull answers, the route that
//! found each, and the names `getAllPages` lists. Shared by every tool that takes a page; the
//! reader and the error are in `crate::wire`.

use std::fmt;

use serde::Deserialize;
use serde::de::{self, Deserializer, SeqAccess, Visitor};
use serde_json::Value;

use crate::entity::shape;
use crate::wire::{DATALOG_METHOD, Id, Optional, ResponseError, entity_id, items, parse};

/// A page as a Datalog pull answers it, with the fields the tools read.
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
    /// The entity as LogSeq sent it, whole (`pull [*]`), for a tool whose result carries the page
    /// (BR-0004). `Null` for a page built without one.
    pub raw: Value,
}

impl PulledPage {
    /// A page read as [`shape::PulledPage`], with the entity as LogSeq sent it.
    fn read(shape: shape::PulledPage, raw: Option<&Value>) -> Self {
        PulledPage {
            id: shape.id.into_option().map(|id| id.0),
            db_id: shape.db_id.into_option().map(|id| id.0),
            name: shape.name.into_option(),
            original_name: shape.original_name.into_option(),
            has_file: shape.file.into_option().is_some(),
            has_alias_links: shape.alias.into_option().is_some_and(|links| !links.is_empty()),
            raw: raw.cloned().unwrap_or(Value::Null),
        }
    }

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

/// One row of the resolver's first query: the page and the route that found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolverRow {
    pub page: PulledPage,
    /// `name`, `alias` or `journal-date`. Absent for a plain page row, which is an exact match.
    pub via: Option<String>,
}

/// `[page, via?]`: the page cell, and a route cell that a plain page row leaves out.
struct ResolverCells {
    page: shape::PulledPage,
    via: Option<String>,
}

impl<'de> Deserialize<'de> for ResolverCells {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_tuple(2, ResolverCellsVisitor)
    }
}

struct ResolverCellsVisitor;

impl<'de> Visitor<'de> for ResolverCellsVisitor {
    type Value = ResolverCells;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a row")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut cells: A) -> Result<ResolverCells, A::Error> {
        let page = cells.next_element()?.ok_or_else(|| de::Error::invalid_length(0, &self))?;
        let via = cells.next_element()?;
        Ok(ResolverCells { page, via })
    }
}

/// `responses.resolverRows`: `[page, via?]` per row.
pub fn resolver_rows(answer: &Value) -> Result<Option<Vec<ResolverRow>>, ResponseError> {
    let Some(rows) = parse::<Option<Vec<ResolverCells>>>(DATALOG_METHOD, answer)? else { return Ok(None) };
    Ok(Some(
        rows.into_iter()
            .zip(items(answer))
            .map(|(cells, row)| ResolverRow { page: PulledPage::read(cells.page, row.get(0)), via: cells.via })
            .collect(),
    ))
}

/// One row of the link-target query: the page, the route that found it and the name it answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkTargetRow {
    /// `None` is a `null` cell, which the caller skips
    pub page: Option<PulledPage>,
    /// `name` or `alias`
    pub via: String,
    /// The name asked for, when it is text (a row whose name isn't is skipped)
    pub name: Option<String>,
}

/// `[page | null, via, name]`. The name is not read for its type: a row that leaves it out, or whose name is
/// not text, has no name and is skipped by the caller.
struct LinkTargetCells {
    page: Option<shape::PulledPage>,
    via: String,
    name: Option<String>,
}

impl<'de> Deserialize<'de> for LinkTargetCells {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_tuple(3, LinkTargetCellsVisitor)
    }
}

struct LinkTargetCellsVisitor;

impl<'de> Visitor<'de> for LinkTargetCellsVisitor {
    type Value = LinkTargetCells;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a row")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut cells: A) -> Result<LinkTargetCells, A::Error> {
        let page = cells.next_element()?.ok_or_else(|| de::Error::invalid_length(0, &self))?;
        let via = cells.next_element()?.ok_or_else(|| de::Error::invalid_length(1, &self))?;
        let name = cells.next_element::<Value>()?.and_then(|name| if let Value::String(name) = name { Some(name) } else { None });
        Ok(LinkTargetCells { page, via, name })
    }
}

/// `responses.linkTargetRows`: `[page | null, via, name]` per row. The name may be anything, and only text is kept.
pub fn link_target_rows(answer: &Value) -> Result<Option<Vec<LinkTargetRow>>, ResponseError> {
    let Some(rows) = parse::<Option<Vec<LinkTargetCells>>>(DATALOG_METHOD, answer)? else { return Ok(None) };
    Ok(Some(
        rows.into_iter()
            .zip(items(answer))
            .map(|(cells, row)| LinkTargetRow {
                page: cells.page.map(|page| PulledPage::read(page, row.get(0))),
                via: cells.via,
                name: cells.name,
            })
            .collect(),
    ))
}

/// `responses.aliasSetRows`: `[startId, member]` per row, the alias group of each start page.
pub fn alias_set_rows(answer: &Value) -> Result<Option<Vec<(i64, PulledPage)>>, ResponseError> {
    let Some(rows) = parse::<Option<Vec<(Id, shape::PulledPage)>>>(DATALOG_METHOD, answer)? else { return Ok(None) };
    Ok(Some(rows.into_iter().zip(items(answer)).map(|((start, member), row)| (start.0, PulledPage::read(member, row.get(1)))).collect()))
}

/// `responses.aliasSetByNameRows`: `[startPage, member]` per row, the alias group of the page a name
/// found, both sides pulled.
pub fn alias_set_by_name_rows(answer: &Value) -> Result<Option<Vec<(PulledPage, PulledPage)>>, ResponseError> {
    let Some(rows) = parse::<Option<Vec<(shape::PulledPage, shape::PulledPage)>>>(DATALOG_METHOD, answer)? else { return Ok(None) };
    Ok(Some(
        rows.into_iter()
            .zip(items(answer))
            .map(|((start, member), row)| (PulledPage::read(start, row.get(0)), PulledPage::read(member, row.get(1))))
            .collect(),
    ))
}

/// `responses.pageRows`: `[page]` per row.
pub fn page_rows(answer: &Value) -> Result<Option<Vec<PulledPage>>, ResponseError> {
    let Some(rows) = parse::<Option<Vec<(shape::PulledPage,)>>>(DATALOG_METHOD, answer)? else { return Ok(None) };
    Ok(Some(rows.into_iter().zip(items(answer)).map(|((page,), row)| PulledPage::read(page, row.get(0))).collect()))
}

/// A page as `getAllPages` lists it, for the one field the closest-name search reads.
#[derive(Deserialize)]
struct ListedName {
    #[serde(default, rename = "originalName")]
    original_name: Optional<String>,
}

/// `responses.pageNames`: `getAllPages`, read for the original name of each page. A page whose
/// `originalName` is absent is `None`.
pub fn page_names(answer: &Value, method: &str) -> Result<Option<Vec<Option<String>>>, ResponseError> {
    Ok(parse::<Option<Vec<ListedName>>>(method, answer)?.map(|pages| pages.into_iter().map(|page| page.original_name.into_option()).collect()))
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
        assert_eq!(resolver_rows(&Value::Null).unwrap(), None);
        assert_eq!(resolver_rows(&json!([])).unwrap(), Some(vec![]));
        assert_eq!(page_rows(&Value::Null).unwrap(), None);
        assert_eq!(page_names(&Value::Null, "m").unwrap(), None);
        assert_eq!(alias_set_rows(&Value::Null).unwrap(), None);
        assert_eq!(alias_set_by_name_rows(&Value::Null).unwrap(), None);
        assert_eq!(link_target_rows(&Value::Null).unwrap(), None);
    }

    #[test]
    fn an_alias_group_by_name_is_rows_of_a_start_page_and_a_member() {
        let rows = alias_set_by_name_rows(&json!([[{"id": 1, "name": "atlas"}, {"id": 2, "name": "project atlas"}]])).unwrap().unwrap();
        assert_eq!((rows[0].0.entity_id(), rows[0].1.entity_id()), (Some(1), Some(2)));
        assert_eq!(alias_set_by_name_rows(&Value::Null).unwrap(), None);
        assert_eq!(problem(alias_set_by_name_rows(&json!([[{"id": 1}]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(alias_set_by_name_rows(&json!([[null, {"id": 1}]]))), "answer[0][0]: expected an object, got null");
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
    fn a_page_carries_the_entity_as_sent() {
        let sent = json!({"id": 10, "name": "atlas", "extra": {"a": [1, null]}, "uuid": 5});
        let rows = resolver_rows(&json!([[sent.clone(), "name"]])).unwrap().unwrap();
        assert_eq!(rows[0].page.raw, sent);
        let members = alias_set_rows(&json!([[1, sent.clone()]])).unwrap().unwrap();
        assert_eq!((members[0].0, members[0].1.raw.clone()), (1, sent));
    }

    #[test]
    fn a_link_target_row_is_a_page_a_route_and_a_name_of_any_kind() {
        let rows = link_target_rows(&json!([
            [{"id": 1, "name": "alice", "file": {"id": 9}}, "name", "alice"],
            [null, "alias", "bob"],
            [{"id": 3}, "name"],
            [{"id": 4}, "name", 5]
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(rows[0].name.as_deref(), Some("alice"));
        assert!(rows[0].page.as_ref().unwrap().has_file);
        assert_eq!((rows[1].page.as_ref(), rows[1].via.as_str()), (None, "alias"));
        // the name may be anything: absent or not text, and the row is read all the same
        assert_eq!((rows[2].name.as_deref(), rows[3].name.as_deref()), (None, None));
    }

    #[test]
    fn a_link_target_row_is_wrong_in_our_words() {
        assert_eq!(problem(link_target_rows(&json!([[{"id": 1}, 5, "x"]]))), "answer[0][1]: expected a string, got a number");
        assert_eq!(problem(link_target_rows(&json!([[{"id": 1}, null, "x"]]))), "answer[0][1]: expected a string, got null");
        assert_eq!(problem(link_target_rows(&json!([[{"id": "s"}, null]]))), "answer[0][0].id: expected a whole number, got a string");
        assert_eq!(problem(link_target_rows(&json!([["x", "name"]]))), "answer[0][0]: expected an object, got a string");
        assert_eq!(problem(link_target_rows(&json!([[{"id": 1}]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(link_target_rows(&json!([[]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(link_target_rows(&json!([[{"id": 1}, "name", "x", "y"]]))), "answer[0]: the row has more cells than this server reads");
        assert_eq!(problem(link_target_rows(&json!([5]))), "answer[0]: expected a row, got a number");
    }

    #[test]
    fn a_row_with_too_few_cells_is_an_error_at_the_row() {
        assert_eq!(problem(alias_set_rows(&json!([[]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(alias_set_by_name_rows(&json!([[]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(alias_set_rows(&json!([[1, {"id": 2}], []]))), "answer[1]: the row has fewer cells than this server reads");
        assert_eq!(problem(alias_set_rows(&json!([[1]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(problem(alias_set_rows(&json!([["x"]]))), "answer[0][0]: expected a whole number, got a string");
    }

    #[test]
    fn a_trailing_route_may_be_left_out_and_the_page_may_not() {
        assert_eq!(problem(resolver_rows(&json!([[]]))), "answer[0]: the row has fewer cells than this server reads");
        assert_eq!(resolver_rows(&json!([[{"id": 1}]])).unwrap().unwrap().len(), 1);
        assert_eq!(problem(page_rows(&json!([[]]))), "answer[0]: the row has fewer cells than this server reads");
    }

    #[test]
    fn an_id_falls_back_to_db_id_only_when_it_is_absent() {
        let page = |value: Value| resolver_rows(&json!([[value]])).unwrap().unwrap().remove(0).page;
        assert_eq!(page(json!({"db/id": 7})).entity_id(), Some(7));
        assert_eq!(page(json!({"id": 0, "db/id": 7})).entity_id(), Some(0));
        assert_eq!(page(json!({"id": 3, "db/id": 7})).entity_id(), Some(3));
        assert_eq!(page(json!({})).entity_id(), None);
        assert_eq!(page(json!({"id": 5.0})).entity_id(), Some(5));
    }

    #[test]
    fn a_pulled_page_is_named_by_its_kebab_case_original_name_only() {
        let page = |value: Value| resolver_rows(&json!([[value]])).unwrap().unwrap().remove(0).page;
        assert_eq!(page(json!({"id": 1, "name": "alice", "original-name": "Alice"})).display_name(), "Alice");
        // the Editor API's spelling is not read from a pull: the lowercase name stands in
        assert_eq!(page(json!({"id": 1, "name": "alice", "originalName": "Alice"})).display_name(), "alice");
    }

    #[test]
    fn a_field_the_resolver_reads_must_be_what_it_reads() {
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1, "name": null}, "x"]]))), "answer[0][0].name: expected a string, got null");
        assert_eq!(problem(resolver_rows(&json!([[{"id": "1"}, "x"]]))), "answer[0][0].id: expected a whole number, got a string");
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1, "file": {"id": "a"}}, "x"]]))), "answer[0][0].file.id: expected a whole number, got a string");
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1, "alias": [1]}, "x"]]))), "answer[0][0].alias[0]: expected an object, got a number");
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1, "alias": {}}, "x"]]))), "answer[0][0].alias: expected a list, got an object");
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1, "properties": []}, "x"]]))), "answer[0][0].properties: expected an object, got a list");
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1, "original-name": null}, "x"]]))), "answer[0][0].original-name: expected a string, got null");
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1, "journal?": "yes"}, "x"]]))), "answer[0][0].journal?: expected a boolean, got a string");
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1, "journal-day": "x"}, "x"]]))), "answer[0][0].journal-day: expected a number, got a string");
    }

    #[test]
    fn a_field_nothing_reads_may_hold_anything() {
        let page = json!({"id": 1, "name": "a", "uuid": 5, "namespace": [], "created-at": "x", "updated-at": null, "properties-text-values": 1});
        assert_eq!(resolver_rows(&json!([[page.clone(), "name"]])).unwrap().unwrap()[0].page.raw, page);
    }

    #[test]
    fn the_first_mismatch_in_the_answers_order_is_the_one_reported() {
        assert_eq!(problem(resolver_rows(&json!([[{"name": 2, "id": "a"}, "x"]]))), "answer[0][0].name: expected a string, got a number");
        assert_eq!(problem(resolver_rows(&json!([[{"id": "a", "name": 2}, "x"]]))), "answer[0][0].id: expected a whole number, got a string");
    }

    #[test]
    fn a_row_is_a_row_of_the_right_width() {
        assert_eq!(problem(resolver_rows(&json!({"a": 1}))), "answer: expected a list, got an object");
        assert_eq!(problem(resolver_rows(&json!("x"))), "answer: expected a list, got a string");
        assert_eq!(problem(resolver_rows(&json!([1]))), "answer[0]: expected a row, got a number");
        assert_eq!(problem(resolver_rows(&json!([null]))), "answer[0]: expected a row, got null");
        assert_eq!(problem(resolver_rows(&json!([[null, "x"]]))), "answer[0][0]: expected an object, got null");
        assert_eq!(problem(resolver_rows(&json!([[[], "x"]]))), "answer[0][0]: expected an object, got a list");
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1}, 1]]))), "answer[0][1]: expected a string, got a number");
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1}, null]]))), "answer[0][1]: expected a string, got null");
        // the cells are read in order, so the first thing wrong is said, and a row too long is said after its cells
        assert_eq!(problem(resolver_rows(&json!([[{"id": "1"}, "x", "y"]]))), "answer[0][0].id: expected a whole number, got a string");
        assert_eq!(problem(resolver_rows(&json!([[{"id": 1}, "x", "y"]]))), "answer[0]: the row has more cells than this server reads");
        assert_eq!(problem(page_rows(&json!([[{"id": 1}, 2]]))), "answer[0]: the row has more cells than this server reads");
    }

    #[test]
    fn a_page_name_list_reads_only_the_original_name() {
        let names = page_names(&json!([{"originalName": "Alice", "id": 1}, {}]), "m").unwrap().unwrap();
        assert_eq!(names, vec![Some("Alice".to_owned()), None]);
        assert_eq!(
            problem(page_names(&json!([{"originalName": "a"}, {"originalName": 3}]), "m")),
            "answer[1].originalName: expected a string, got a number"
        );
        assert_eq!(problem(page_names(&json!([{}, null]), "m")), "answer[1]: expected an object, got null");
        assert_eq!(problem(page_names(&json!({}), "m")), "answer: expected a list, got an object");
        assert_eq!(page_names(&json!([1]), "logseq.Editor.getAllPages").unwrap_err().method, "logseq.Editor.getAllPages");
    }

    #[test]
    fn the_message_names_the_method_and_the_path_and_no_value() {
        let error = resolver_rows(&json!([[{"id": 1, "name": "secret page"}, 5]])).unwrap_err();
        let message = error.to_string();
        assert!(message.starts_with(
            "LogSeq answered logseq.DB.datascriptQuery in a shape this server can't read: answer[0][1]: expected a string, got a number\n\nSteps to fix:\n1. Check which LogSeq version"
        ));
        assert!(!message.contains("secret page"));
    }

    #[test]
    fn a_listed_name_may_be_left_out_and_may_not_be_null() {
        assert_eq!(page_names(&json!([{}]), "m").unwrap().unwrap(), vec![None]);
        assert_eq!(problem(page_names(&json!([{"originalName": null}]), "m")), "answer[0].originalName: expected a string, got null");
    }
}
