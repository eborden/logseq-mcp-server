//! The one Datalog query only the current context makes (`getPagesByIds` in
//! `src/datalog/queries.ts`). Only page `:db/id`s are embedded, through [`ground_ids`], which
//! takes [`PageId`]s and not numbers.

use crate::edn::{PageId, Query, ground_ids};

// The block search makes the same query (`search_blocks::queries::pages_by_ids`). It is repeated here so
// that no tool's directory reaches into another's; both build what `getPagesByIds` builds. Hoisting it
// into one shared module is tracked in #327.
/// The full page entities for some ids, in one query.
pub fn pages_by_ids(ids: &[PageId]) -> Query {
    Query {
        text: format!("[:find (pull ?p [*]) :where {} [?p :block/name]]", ground_ids(ids, "?p")),
        inputs: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_are_pulled_by_id_with_nothing_bound() {
        let query = pages_by_ids(&[PageId::new(7).unwrap(), PageId::new(9).unwrap()]);
        assert_eq!(query.text, "[:find (pull ?p [*]) :where [(ground [7 9]) [?p ...]] [?p :block/name]]");
        assert!(query.inputs.is_empty());
    }
}
