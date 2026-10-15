//! The Datalog query that pulls full page entities for some ids. The block search (`include_context`) and the current context both make
//! it, so it is here and not in either tool's directory. Only page `:db/id`s are embedded, through
//! [`ground_ids`], which takes [`PageId`]s and not numbers; nothing is bound with `:in`.

use crate::edn::{PageId, Query, ground_ids};

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
