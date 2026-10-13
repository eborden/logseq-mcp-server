//! The one Datalog query the block finder makes. Every string (the search text as a regex, the property key and its
//! value) is bound with `:in` (ADR-0013), so nothing the caller sent is part of the query text. The page lookup the
//! finder also makes is shared: `crate::pages_by_ids`.

use crate::edn::{DatalogInput, DayBound, PageId, Query, ground_ids};
use crate::escape::escape_regex;
use crate::property::PropertyFilter;

use crate::period::Period;

/// What the blocks must satisfy, each filter present only when it was given. They AND together in one query.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Match<'a> {
    pub text: Option<&'a str>,
    /// The ids of the alias group of the page the blocks are on
    pub page: Option<&'a [PageId]>,
    /// The ids of the alias group of each page the blocks must link to: one group per page, and a block needs a ref to
    /// a page of every group
    pub links_to: Vec<&'a [PageId]>,
    pub property: Option<&'a PropertyFilter>,
    pub period: Option<Period>,
}

/// Blocks matching every filter given, each with its page's id, name and original name nested.
///
/// - `text`: LogSeq runs `re-pattern` / `re-find` over the block's content, case-insensitively, with the text's
///   metacharacters escaped so it matches as it is written.
/// - `page`: the page ids are bound with `ground_ids` straight to `?page`, the variable the period uses too, so the two
///   AND: a block on the page, and the page a journal in the span. Ids, never names, so an alias group is one clause.
/// - `links_to`: one `ground_ids` clause per listed page, each on its own variable (`?ref0`, `?ref1`, ...), and a
///   `[?b :block/refs ?ref]` for it. Matching is on `:block/refs`, so `[[x]]`, `#x`, `#[[x]]` and uuid-style refs all
///   count, in any casing, and plain text that merely holds the name does not. A block that links to two names of one
///   group is one row. Without a page or a period nothing else makes `?b` a block, so `[?b :block/page]` does.
/// - `property`: `(keyword ?key)` turns the key into the keyword `:block/properties` is indexed by (a string key, or a
///   string input read as EDN, matches nothing, constraint 1). `?v` is a scalar or a set, and LogSeq has no `string?`
///   or `coll?`, so one `or-join` covers both: `(str ?v)` equals the value, or the set contains it. `[?b :block/page]`
///   keeps blocks only, since a page carries its own `:block/properties` too.
/// - `period`: the blocks on the journal pages whose `:block/journal-day` falls in the span, both ends included, the
///   bounds bound as typed [`DayBound`]s. `[?page :block/name]` is required, or the blocks LogSeq creates in the app
///   on a journal page (which carry `:block/journal-day` too) match as pages (#140).
///
/// The clauses run in the order written, so the one that narrows most comes first: the page (one page's blocks) and the
/// period (a few pages), then the links (a block per ref), then the property (few blocks have it), then the text (every
/// block has content). A single text or property filter reads as it
/// always did, so its recorded query is the same text.
pub fn find_blocks(wanted: &Match<'_>) -> Query {
    let mut inputs = Vec::new();
    let mut declared = String::from("$");
    let mut clauses = Vec::new();
    if let Some(page) = wanted.page {
        clauses.push(ground_ids(page, "?page"));
    }
    if let Some(period) = wanted.period {
        declared.push_str(" ?start ?end");
        inputs.push(DatalogInput::DayBound(DayBound::new(period.start)));
        inputs.push(DatalogInput::DayBound(DayBound::new(period.end)));
        clauses.push(
            "[?page :block/name] [?page :block/journal-day ?day] [(>= ?day ?start)] [(<= ?day ?end)] [?b :block/page ?page]"
                .to_owned(),
        );
    } else if wanted.page.is_some() {
        clauses.push("[?b :block/page ?page]".to_owned());
    }
    for (n, group) in wanted.links_to.iter().copied().enumerate() {
        clauses.push(format!("{} [?b :block/refs ?ref{n}]", ground_ids(group, &format!("?ref{n}"))));
    }
    if !wanted.links_to.is_empty() && wanted.page.is_none() && wanted.period.is_none() {
        clauses.push("[?b :block/page]".to_owned());
    }
    if let Some(filter) = wanted.property {
        declared.push_str(" ?key ?value");
        inputs.push(DatalogInput::Str(filter.key.as_str().to_owned()));
        inputs.push(DatalogInput::Str(filter.value.clone()));
        clauses.push(
            "[?b :block/properties ?props] \
             [?b :block/page] \
             [(keyword ?key) ?kw] \
             [(get ?props ?kw) ?v] \
             (or-join [?v ?value] \
             (and [(str ?v) ?s] [(= ?s ?value)]) \
             [(contains? ?v ?value)])"
                .to_owned(),
        );
    }
    if let Some(text) = wanted.text {
        declared.push_str(" ?pattern");
        inputs.push(DatalogInput::Str(format!("(?i){}", escape_regex(text))));
        clauses.push("[?b :block/content ?c] [(re-pattern ?pattern) ?re] [(re-find ?re ?c)]".to_owned());
    }
    Query {
        text: format!("[:find (pull ?b [* {{:block/page [:db/id :block/name :block/original-name]}}]) :in {declared} :where {}]", clauses.join(" ")),
        inputs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::property::PropertyKey;

    fn property(key: &str, value: &str) -> PropertyFilter {
        PropertyFilter { key: PropertyKey::parse(key, "property").unwrap(), value: value.to_owned() }
    }

    #[test]
    fn the_text_is_escaped_and_bound_as_a_case_insensitive_pattern() {
        let query = find_blocks(&Match { text: Some("a.b (c)"), ..Match::default() });
        assert_eq!(query.inputs, [DatalogInput::Str(r"(?i)a\.b \(c\)".to_owned())]);
        assert!(!query.text.contains("a.b"), "the text is never part of the query");
        assert!(query.text.contains(":in $ ?pattern :where [?b :block/content ?c]"));
    }

    #[test]
    fn the_text_alone_is_the_query_it_always_was() {
        assert_eq!(
            find_blocks(&Match { text: Some("x"), ..Match::default() }).text,
            "[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}]) :in $ ?pattern :where \
             [?b :block/content ?c] [(re-pattern ?pattern) ?re] [(re-find ?re ?c)]]"
        );
    }

    #[test]
    fn the_key_and_the_value_are_bound_and_never_part_of_the_text() {
        let filter = property("createdAt", "a \"b\"");
        let query = find_blocks(&Match { property: Some(&filter), ..Match::default() });
        assert_eq!(query.inputs, [DatalogInput::Str("created-at".into()), DatalogInput::Str("a \"b\"".into())]);
        assert!(!query.text.contains("created") && !query.text.contains('"'));
        assert!(query.text.contains(":in $ ?key ?value :where [?b :block/properties ?props] [?b :block/page] [(keyword ?key) ?kw] [(get ?props ?kw) ?v]"));
        assert!(query.text.ends_with("(or-join [?v ?value] (and [(str ?v) ?s] [(= ?s ?value)]) [(contains? ?v ?value)])]"));
    }

    #[test]
    fn both_filters_in_one_query_with_the_property_first_and_the_inputs_in_the_order_declared() {
        let filter = property("status", "doing");
        let query = find_blocks(&Match { text: Some("x"), property: Some(&filter), ..Match::default() });
        assert!(query.text.contains(":in $ ?key ?value ?pattern :where [?b :block/properties ?props]"), "{}", query.text);
        assert!(query.text.ends_with("[?b :block/content ?c] [(re-pattern ?pattern) ?re] [(re-find ?re ?c)]]"));
        assert_eq!(query.inputs, [DatalogInput::Str("status".into()), DatalogInput::Str("doing".into()), DatalogInput::Str("(?i)x".into())]);
    }

    #[test]
    fn a_period_leads_and_binds_its_two_days_as_typed_numbers_never_in_the_text() {
        let period = Period { start: 20250101, end: 20250107 };
        let query = find_blocks(&Match { period: Some(period), ..Match::default() });
        assert_eq!(
            query.text,
            "[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}]) :in $ ?start ?end :where \
             [?page :block/name] [?page :block/journal-day ?day] [(>= ?day ?start)] [(<= ?day ?end)] [?b :block/page ?page]]"
        );
        assert_eq!(query.inputs.iter().map(DatalogInput::to_edn).collect::<Vec<_>>(), ["20250101", "20250107"]);
        assert!(!query.text.contains("2025"));
    }

    #[test]
    fn with_all_three_the_period_comes_first_then_the_property_then_the_text() {
        let filter = property("status", "doing");
        let period = Period { start: 20250101, end: 20250107 };
        let query = find_blocks(&Match { text: Some("x"), property: Some(&filter), period: Some(period), ..Match::default() });
        assert!(query.text.contains(":in $ ?start ?end ?key ?value ?pattern :where [?page :block/name]"), "{}", query.text);
        let at = |needle: &str| query.text.find(needle).unwrap_or_else(|| panic!("{needle} in {}", query.text));
        assert!(at("[?page :block/name]") < at("[?b :block/properties ?props]") && at("[?b :block/properties ?props]") < at("[?b :block/content ?c]"));
        // the journal pages are required to be pages: an app-made journal block carries a journal-day too (#140)
        assert!(query.text.contains("[?page :block/name] [?page :block/journal-day ?day]"));
        let inputs: Vec<String> = query.inputs.iter().map(DatalogInput::to_edn).collect();
        assert_eq!(inputs, ["20250101", "20250107", "\"status\"", "\"doing\"", "\"(?i)x\""]);
    }
    fn ids(ids: &[i64]) -> Vec<PageId> {
        ids.iter().map(|&id| PageId::new(id).unwrap()).collect()
    }

    const HEAD: &str = "[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}]) :in";

    #[test]
    fn a_page_binds_the_ids_of_its_group_to_the_variable_of_its_blocks_page() {
        let group = ids(&[10, 11]);
        let query = find_blocks(&Match { page: Some(&group), ..Match::default() });
        assert_eq!(query.text, format!("{HEAD} $ :where [(ground [10 11]) [?page ...]] [?b :block/page ?page]]"));
        assert!(query.inputs.is_empty(), "ids are embedded, never bound as strings");
    }

    #[test]
    fn a_page_and_a_period_share_the_page_variable_so_the_blocks_are_on_a_journal_in_the_span() {
        let group = ids(&[10]);
        let period = Period { start: 20250101, end: 20250107 };
        let query = find_blocks(&Match { page: Some(&group), period: Some(period), ..Match::default() });
        assert_eq!(
            query.text,
            format!(
                "{HEAD} $ ?start ?end :where [(ground [10]) [?page ...]] [?page :block/name] [?page :block/journal-day ?day] \
                 [(>= ?day ?start)] [(<= ?day ?end)] [?b :block/page ?page]]"
            )
        );
        // one block-on-page clause, not two
        assert_eq!(query.text.matches("[?b :block/page ?page]").count(), 1);
    }

    #[test]
    fn each_linked_page_is_its_own_ground_clause_and_ref_variable_and_a_lone_link_makes_the_block_a_block() {
        let (alice, bob) = (ids(&[20, 21]), ids(&[30]));
        let query = find_blocks(&Match { links_to: vec![alice.as_slice(), bob.as_slice()], ..Match::default() });
        assert_eq!(
            query.text,
            format!(
                "{HEAD} $ :where [(ground [20 21]) [?ref0 ...]] [?b :block/refs ?ref0] [(ground [30]) [?ref1 ...]] [?b :block/refs ?ref1] [?b :block/page]]"
            )
        );
        assert!(query.inputs.is_empty());
        // beside a page, the page clause already makes it a block
        let page = ids(&[10]);
        let query = find_blocks(&Match { page: Some(&page), links_to: vec![alice.as_slice()], ..Match::default() });
        assert_eq!(
            query.text,
            format!("{HEAD} $ :where [(ground [10]) [?page ...]] [?b :block/page ?page] [(ground [20 21]) [?ref0 ...]] [?b :block/refs ?ref0]]")
        );
    }

    #[test]
    fn with_every_filter_the_page_and_period_lead_then_the_links_then_the_property_then_the_text() {
        let (page, link) = (ids(&[10]), ids(&[20]));
        let filter = property("status", "doing");
        let period = Period { start: 20250101, end: 20250107 };
        let query = find_blocks(&Match { text: Some("x"), page: Some(&page), links_to: vec![link.as_slice()], property: Some(&filter), period: Some(period) });
        let at = |needle: &str| query.text.find(needle).unwrap_or_else(|| panic!("{needle} in {}", query.text));
        assert!(at("[(ground [10]) [?page ...]]") < at("[?page :block/name]"));
        assert!(at("[?page :block/name]") < at("[?b :block/refs ?ref0]"));
        assert!(at("[?b :block/refs ?ref0]") < at("[?b :block/properties ?props]"));
        assert!(at("[?b :block/properties ?props]") < at("[?b :block/content ?c]"));
        // the ids are part of the text, every string is an input, in the order the query declares them
        assert!(query.text.contains(":in $ ?start ?end ?key ?value ?pattern :where"), "{}", query.text);
        let inputs: Vec<String> = query.inputs.iter().map(DatalogInput::to_edn).collect();
        assert_eq!(inputs, ["20250101", "20250107", "\"status\"", "\"doing\"", "\"(?i)x\""]);
    }
}
