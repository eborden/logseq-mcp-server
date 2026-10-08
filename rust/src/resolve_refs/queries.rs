//! The one query a level of ref lookups makes (`DatalogQueryBuilder.refTargets`).

use crate::edn::{BlockUuid, DatalogInput, PageName, Query, ground_uuids};

/// How many levels below an embedded block the lookup fetches (`EMBED_DESCENDANT_LEVELS`).
pub const EMBED_DESCENDANT_LEVELS: usize = 3;

/// What a level of `((uuid))` refs and `{{embed}}`s points at, in ONE query:
/// - `block_uuids`: the referenced blocks themselves;
/// - `descendant_uuids`: every block up to [`EMBED_DESCENDANT_LEVELS`] levels below those blocks
///   (for `{{embed ((uuid))}}`);
/// - `page_names`: each page entity and its top-level blocks (for `{{embed [[page]]}}`). Names
///   are bound through `:in` as a collection.
///
/// Rows are flat pulls of `[id, uuid, content, name, original-name, left, parent, page]`, to
/// be put back into trees by `parent` and ordered with `left`. A page with no entity has no row.
/// A uuid with no block may have none either, or a placeholder row: LogSeq 0.10 makes an entity
/// for a `((uuid))` nobody has (#138).
///
/// There must be at least one uuid or page name.
pub fn ref_targets(block_uuids: &[BlockUuid], descendant_uuids: &[BlockUuid], page_names: &[PageName]) -> Query {
    assert!(
        !block_uuids.is_empty() || !descendant_uuids.is_empty() || !page_names.is_empty(),
        "ref_targets needs at least one uuid or page name"
    );
    let mut branches: Vec<String> = Vec::new();
    if !block_uuids.is_empty() {
        branches.push(format!("(and {} [?e :block/uuid ?u])", ground_uuids(block_uuids, "?u")));
    }
    if !descendant_uuids.is_empty() {
        branches.push(format!(
            "(and {} [?r :block/uuid ?ru] (or-join [?r ?e] [?e :block/parent ?r] \
             (and [?m1 :block/parent ?r] [?e :block/parent ?m1]) \
             (and [?m1 :block/parent ?r] [?m2 :block/parent ?m1] [?e :block/parent ?m2])))",
            ground_uuids(descendant_uuids, "?ru")
        ));
    }
    if !page_names.is_empty() {
        branches.push("[?e :block/name ?n]".to_owned());
        branches.push("(and [?pg :block/name ?n] [?e :block/parent ?pg])".to_owned());
    }

    let head = if page_names.is_empty() { "[?e]" } else { "[?e ?n]" };
    let input = if page_names.is_empty() { "" } else { " :in $ [?n ...]" };
    Query {
        text: format!(
            "[:find (pull ?e [:db/id :block/uuid :block/content :block/name :block/original-name \
             {{:block/left [:db/id]}} {{:block/parent [:db/id]}} \
             {{:block/page [:db/id :block/name :block/original-name]}}]){input} \
             :where (or-join {head} {})]",
            branches.join(" ")
        ),
        inputs: if page_names.is_empty() { Vec::new() } else { vec![DatalogInput::PageNames(page_names.to_vec())] },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";

    fn uuids(ids: &[&str]) -> Vec<BlockUuid> {
        ids.iter().map(|id| BlockUuid::parse(id).unwrap()).collect()
    }

    #[test]
    fn refs_alone_bind_no_input_and_embed_the_uuids_as_literals() {
        let query = ref_targets(&uuids(&[A, B]), &[], &[]);
        assert!(query.inputs.is_empty());
        assert!(query.text.contains(&format!("[(ground [#uuid \"{A}\" #uuid \"{B}\"]) [?u ...]]")), "{}", query.text);
        assert!(query.text.contains("(or-join [?e] (and "));
        assert!(!query.text.contains(":in"));
    }

    #[test]
    fn page_names_are_bound_as_one_lowercase_collection() {
        let query = ref_targets(&[], &[], &[PageName::new("Project Atlas"), PageName::new("Bob")]);
        assert_eq!(query.inputs.len(), 1);
        assert_eq!(query.inputs[0].to_edn(), r#"["project atlas","bob"]"#);
        assert!(query.text.contains(":in $ [?n ...] :where (or-join [?e ?n] [?e :block/name ?n] (and [?pg :block/name ?n] [?e :block/parent ?pg]))"));
        assert!(!query.text.contains("Atlas") && !query.text.contains("atlas"));
    }

    #[test]
    fn an_embedded_block_adds_its_descendants_three_levels_down() {
        let query = ref_targets(&uuids(&[A]), &uuids(&[A]), &[]);
        assert!(query.text.contains("[?r :block/uuid ?ru] (or-join [?r ?e] [?e :block/parent ?r] (and [?m1 :block/parent ?r] [?e :block/parent ?m1])"));
        assert!(query.text.contains("[?m2 :block/parent ?m1] [?e :block/parent ?m2]"));
        assert!(query.text.contains(&format!("[(ground [#uuid \"{A}\"]) [?ru ...]]")));
    }

    #[test]
    #[should_panic(expected = "at least one")]
    fn a_query_with_nothing_to_look_up_is_a_bug() {
        ref_targets(&[], &[], &[]);
    }
}
