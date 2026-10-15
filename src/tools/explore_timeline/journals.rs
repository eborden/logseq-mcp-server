//! The period alone: the journal pages of a span of days and every block on them, as one entry per day.
//!
//! Two queries whatever the length of the span (the roll-up of top concepts reads the refs pulled with the blocks, so it
//! adds none): the journal pages in range, then every block on them, skipped when no page matched. A `null` answer to
//! either is not an empty one (BR-0011, #269): the result says LogSeq gave no answer.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::queries;
use super::top_concepts::{ConceptRef, extract_concept_refs};
use super::wire;
use super::{Entry, Found};
use crate::block_tree::{build_block_trees, camelize_keys};
use crate::client::LogseqClient;
use crate::entity::id_of;
use crate::errors::ToolError;
use crate::meta::ResultWarning;
use crate::period::Period;
use crate::resolve::RETRY_ADVICE;

/// A journal page the first query found.
struct Journal {
    /// The page as the Editor API spells it
    page: Map<String, Value>,
    id: Option<i64>,
    /// The page's journal day, or 0 when it has none
    day: i64,
}

/// The journal pages a query finds, or `None` when LogSeq answered `null`. `null` is
/// not `[]` (BR-0011, #269): an empty array is a range with no journals, `null` is no answer at all.
async fn fetch_journals(client: &LogseqClient, query: crate::edn::Query) -> Result<Option<Vec<Journal>>, ToolError> {
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    let Some(pages) = wire::pages(&answer)? else { return Ok(None) };
    Ok(Some(
        pages
            .iter()
            .map(|pulled| {
                let page = camelize_keys(pulled);
                let id = page.get("id").and_then(crate::wire::whole_number);
                let day = page.get("journalDay").and_then(crate::wire::whole_number).unwrap_or(0);
                Journal { page, id, day }
            })
            .collect(),
    ))
}

/// No `howToFetchAll` on either warning: no parameter fetches what LogSeq did not answer (like
/// `pages_unavailable`, #64), so `hasMore` is unaffected. The retry advice is in the message.
fn journals_unavailable() -> ResultWarning {
    ResultWarning::new(
        "journals_unavailable",
        format!(
            "LogSeq returned no answer when looking up journal pages (possibly no graph open or a re-index \
             in progress), so the empty result may not mean there are no journals to show. {RETRY_ADVICE}"
        ),
    )
}

fn blocks_unavailable(page_count: usize) -> ResultWarning {
    ResultWarning::new(
        "blocks_unavailable",
        format!(
            "LogSeq returned no answer when looking up the blocks on {page_count} journal page(s) (possibly no graph \
             open or a re-index in progress), so their blocks are missing from this result. \
             This does not mean the days are empty. {RETRY_ADVICE}"
        ),
    )
}

/// The block trees of the blocks one query pulled, and each block's concepts for the roll-up.
///
/// The query pulls each ref as a page map. The concepts are kept for the roll-up, and the tree gets
/// the bare `{ id }` refs the Editor API returns.
fn trees_of(blocks: Vec<Map<String, Value>>, page_ids: &[i64]) -> (HashMap<i64, Vec<Value>>, HashMap<i64, Vec<ConceptRef>>) {
    let mut refs_by_block = HashMap::new();
    let flat: Vec<Map<String, Value>> = blocks
        .into_iter()
        .map(|mut block| {
            let Some(refs) = block.get("refs").and_then(Value::as_array) else { return block };
            if let Some(id) = block.get("id").and_then(crate::wire::whole_number) {
                refs_by_block.insert(id, extract_concept_refs(&block));
            }
            // each ref as `{ id }`: a ref with no id is `{}`
            let bare: Vec<Value> = refs
                .iter()
                .map(|reference| {
                    let mut bare = Map::new();
                    if let Some(id) = id_of(Some(reference)) {
                        bare.insert("id".to_owned(), Value::from(id));
                    }
                    Value::Object(bare)
                })
                .collect();
            block.insert("refs".to_owned(), Value::Array(bare));
            block
        })
        .collect();
    (build_block_trees(flat, page_ids), refs_by_block)
}

/// The days of a period as entries: the journal pages in it (every one, with no block or with some) and the blocks on
/// them as trees, oldest day first or newest first.
pub async fn fetch(client: &LogseqClient, period: Period, newest_first: bool) -> Result<Found, ToolError> {
    // Query 1: journal pages (may be empty). A `null` answer is not an empty one (BR-0011, #269): it reads as no journals
    // here, and a warning says it was no answer.
    let mut unavailable: Vec<ResultWarning> = Vec::new();
    let found = fetch_journals(client, queries::journal_pages_in_range(period.start, period.end)).await?;
    if found.is_none() {
        unavailable = vec![journals_unavailable()];
    }
    let mut journals = found.unwrap_or_default();
    journals.sort_by_key(|journal| journal.day);
    if newest_first {
        journals.reverse();
    }

    // Query 2: every block on those pages (may be empty), rebuilt into trees. Skipped when there are
    // no pages; a second query never scales with range length.
    let mut trees: HashMap<i64, Vec<Value>> = HashMap::new();
    let mut refs_by_block: HashMap<i64, Vec<ConceptRef>> = HashMap::new();
    if !journals.is_empty() {
        let query = queries::journal_blocks_in_range(period.start, period.end);
        let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
        let rows = wire::blocks(&answer)?;
        // `null` here would otherwise show journal pages that exist with no blocks, as if the days were empty
        if rows.is_none() {
            unavailable = vec![blocks_unavailable(journals.len())];
        }
        let page_ids: Vec<i64> = journals.iter().filter_map(|journal| journal.id).collect();
        (trees, refs_by_block) = trees_of(rows.unwrap_or_default(), &page_ids);
    }

    let entries = journals
        .into_iter()
        .map(|journal| {
            // every journal page has a tree, `[]` for a page with no blocks
            let blocks = journal.id.and_then(|id| trees.remove(&id)).unwrap_or_default();
            Entry { date: Some(journal.day), page: Value::Object(journal.page), blocks }
        })
        .collect();
    Ok(Found { entries, refs_by_block, warnings: unavailable, answered: Vec::new(), span: None, group: Default::default() })
}
