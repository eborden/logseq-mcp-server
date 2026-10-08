//! The Datalog queries only the date-range tool makes (`getJournalPagesInRange`,
//! `getJournalBlocksInRange` and `getJournalPagesUpTo` in `src/datalog/queries.ts`). The day
//! bounds are bound with `:in`, as typed [`DayBound`]s, so no value is part of the query text.
//!
//! `[?page :block/name]` is required in every one: blocks LogSeq creates in the app on a journal
//! page carry `:block/journal-day` too (a scheduled or deadline date does not, #140), and without
//! it they match as pages.

use crate::edn::{DatalogInput, DayBound, Query};
use crate::errors::ToolError;

/// `assertJournalBounds`'s check of one bound: a whole number, as a plain `Error` says it.
pub fn day_bound(label: &str, value: f64) -> Result<DayBound, ToolError> {
    DayBound::from_number(value).ok_or_else(|| {
        ToolError::Failed(format!("Invalid journal {label} date: {} (expected an integer)", crate::js::number_to_string(value)))
    })
}

/// The journal pages whose day falls in a range, inclusive, as full pulls. Fails for a bound that
/// is not a whole number, the start first.
pub fn journal_pages_in_range(start: f64, end: f64) -> Result<Query, ToolError> {
    let (start, end) = (day_bound("start", start)?, day_bound("end", end)?);
    Ok(Query {
        text: "[:find (pull ?page [*]) :in $ ?start ?end :where [?page :block/name] [?page :block/journal-day ?day] \
               [(>= ?day ?start)] [(<= ?day ?end)]]"
            .to_owned(),
        inputs: vec![DatalogInput::DayBound(start), DatalogInput::DayBound(end)],
    })
}

/// Every block on the journal pages in a range, flat (the caller rebuilds the tree from
/// `:block/parent` and `:block/left`). Each block's `refs` come back as the referenced pages' own
/// maps (`id`, `name`, `original-name`, `journal?`, `journal-day` when set) instead of bare `{id}`,
/// so the roll-up of top concepts needs no further call. A ref to a block has no `name`.
pub fn journal_blocks_in_range(start: f64, end: f64) -> Result<Query, ToolError> {
    let (start, end) = (day_bound("start", start)?, day_bound("end", end)?);
    Ok(Query {
        text: "[:find (pull ?block [* {:block/refs [:db/id :block/name :block/original-name :block/journal? :block/journal-day]}]) \
               :in $ ?start ?end :where [?page :block/name] [?page :block/journal-day ?day] \
               [(>= ?day ?start)] [(<= ?day ?end)] [?block :block/page ?page]]"
            .to_owned(),
        inputs: vec![DatalogInput::DayBound(start), DatalogInput::DayBound(end)],
    })
}

/// The journal pages on or before a day. The caller sorts by `journal-day` and keeps the newest N,
/// so one query finds "the last N journals that exist" however many days are missing. It pulls
/// only the identifying attributes, not `[*]`: a graph with years of journals has hundreds.
pub fn journal_pages_up_to(latest: f64) -> Result<Query, ToolError> {
    let latest = DayBound::from_number(latest).ok_or_else(|| {
        ToolError::Failed(format!("Invalid journal latest date: {} (expected an integer)", crate::js::number_to_string(latest)))
    })?;
    Ok(Query {
        text: "[:find (pull ?page [:db/id :block/uuid :block/name :block/original-name :block/journal-day :block/journal?]) \
               :in $ ?latest :where [?page :block/name] [?page :block/journal-day ?day] [(<= ?day ?latest)]]"
            .to_owned(),
        inputs: vec![DatalogInput::DayBound(latest)],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_range_queries_bind_both_bounds_and_embed_no_value() {
        for query in [journal_pages_in_range(20250101.0, 20250107.0).unwrap(), journal_blocks_in_range(20250101.0, 20250107.0).unwrap()] {
            assert!(query.text.contains(":in $ ?start ?end :where [?page :block/name] [?page :block/journal-day ?day]"));
            assert!(!query.text.contains("2025"));
            let inputs: Vec<String> = query.inputs.iter().map(DatalogInput::to_edn).collect();
            assert_eq!(inputs, ["20250101", "20250107"]);
        }
    }

    #[test]
    fn a_day_that_is_no_real_date_is_still_a_bound() {
        // the tool accepts day 31 of any month, so the query has to carry it
        let inputs: Vec<String> = journal_pages_in_range(20250231.0, 20250231.0).unwrap().inputs.iter().map(DatalogInput::to_edn).collect();
        assert_eq!(inputs, ["20250231", "20250231"]);
    }

    #[test]
    fn the_up_to_query_pulls_only_the_identifying_attributes() {
        let query = journal_pages_up_to(20250112.0).unwrap();
        assert!(query.text.starts_with("[:find (pull ?page [:db/id :block/uuid :block/name :block/original-name :block/journal-day :block/journal?])"));
        assert_eq!(query.inputs.iter().map(DatalogInput::to_edn).collect::<Vec<_>>(), ["20250112"]);
    }

    #[test]
    fn a_bound_that_is_not_whole_is_a_plain_error_naming_which() {
        assert_eq!(journal_pages_in_range(1.5, 2.0).unwrap_err().to_string(), "Invalid journal start date: 1.5 (expected an integer)");
        assert_eq!(journal_blocks_in_range(1.0, 2.5).unwrap_err().to_string(), "Invalid journal end date: 2.5 (expected an integer)");
        assert_eq!(journal_pages_up_to(0.5).unwrap_err().to_string(), "Invalid journal latest date: 0.5 (expected an integer)");
    }
}
