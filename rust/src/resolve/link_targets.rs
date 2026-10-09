//! `resolveLinkTargets` (#146): many names resolved the way a `[[link]]` resolves, in one Datalog
//! query however many names there are. These are routes 1 and 2 of [`super::resolve_page`] (exact
//! name, then alias), with the same stub and ambiguity rules, so a file-less page counts as a page.
//! ISO dates and namespace leaves are left out on purpose: `[[2025-01-01]]` and `[[atlas]]` link to
//! the page with exactly that name, not to a journal or to `projects/atlas`.

use std::collections::HashMap;

use super::{Resolution, queries, resolve_from_rows, wire};
use crate::client::LogseqClient;
use crate::edn::PageName;
use crate::errors::ToolError;
use crate::js;

/// What [`resolve_link_targets`] found for each name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkTargetResolutions {
    /// Keyed by the name trimmed and lowercased. A name that is not a key here asked nothing (it
    /// was blank), and the caller reads it as not found.
    pub resolutions: HashMap<String, Resolution>,
    /// True when LogSeq answered `null` instead of rows (#64). "No such page" and "not checked" can't
    /// be told apart then, so every name is [`Resolution::NotFound`] and the caller should say so
    /// rather than report the names as missing.
    pub unavailable: bool,
}

/// The key a name is looked up by: trimmed and lowercased, as LogSeq trims ref names and stores
/// `:block/name` lowercase.
pub fn link_key(name: &str) -> String {
    js::trim(name).to_lowercase()
}

/// `resolveLinkTargets`: names are trimmed and lowercased and duplicates are sent once. An empty
/// list, or one of blank names only, costs no call. Infrastructure errors propagate.
pub async fn resolve_link_targets(client: &LogseqClient, names: &[&str]) -> Result<LinkTargetResolutions, ToolError> {
    let mut keys: Vec<String> = Vec::new();
    for name in names {
        let key = link_key(name);
        if !key.is_empty() && !keys.contains(&key) {
            keys.push(key);
        }
    }
    let mut resolutions = HashMap::new();
    if keys.is_empty() {
        return Ok(LinkTargetResolutions { resolutions, unavailable: false });
    }

    let query = queries::link_targets(&keys.iter().map(|key| PageName::new(key)).collect::<Vec<_>>());
    let answer = client.execute_datalog_query(&query.text, &query.inputs).await?;
    let rows = wire::link_target_rows(&answer)?;
    let unavailable = rows.is_none();

    let mut by_name: HashMap<String, Vec<wire::ResolverRow>> = HashMap::new();
    for row in rows.unwrap_or_default() {
        // A `null` page, or a name that is not text, answers no term
        let (Some(page), Some(name)) = (row.page, row.name) else { continue };
        by_name.entry(name).or_default().push(wire::ResolverRow { page, via: Some(row.via) });
    }
    for key in keys {
        // `resolveFromRows(key, ...)`: the name is the key, trimmed and lowercase already
        let resolution = by_name.get(&key).and_then(|rows| resolve_from_rows(&key, rows)).unwrap_or(Resolution::NotFound);
        resolutions.insert(key, resolution);
    }
    Ok(LinkTargetResolutions { resolutions, unavailable })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::MatchedBy;
    use serde_json::json;

    fn resolve(rows: serde_json::Value) -> HashMap<String, Resolution> {
        let rows = wire::link_target_rows(&rows).unwrap().unwrap();
        let mut by_name: HashMap<String, Vec<wire::ResolverRow>> = HashMap::new();
        for row in rows {
            let (Some(page), Some(name)) = (row.page, row.name) else { continue };
            by_name.entry(name).or_default().push(wire::ResolverRow { page, via: Some(row.via) });
        }
        by_name.into_iter().filter_map(|(name, rows)| resolve_from_rows(&name, &rows).map(|found| (name, found))).collect()
    }

    #[test]
    fn a_key_is_trimmed_and_lowercased() {
        assert_eq!(link_key("  Alice \n"), "alice");
        assert_eq!(link_key(" "), "");
    }

    #[test]
    fn each_name_is_resolved_by_its_own_rows() {
        let found = resolve(json!([
            [{"id": 1, "name": "alice", "original-name": "Alice", "file": {"id": 9}}, "name", "alice"],
            [{"id": 2, "name": "robert", "original-name": "Robert", "file": {"id": 8}}, "alias", "bob"],
            [null, "name", "ghost"],
            [{"id": 3, "name": "x"}, "name", 5]
        ]));
        let Some(Resolution::Found(alice)) = found.get("alice") else { panic!("alice is found") };
        assert_eq!((alice.original_name.as_str(), alice.matched_by), ("Alice", MatchedBy::Name));
        let Some(Resolution::Found(bob)) = found.get("bob") else { panic!("bob is found by alias") };
        assert_eq!((bob.original_name.as_str(), bob.matched_by), ("Robert", MatchedBy::Alias));
        assert!(!found.contains_key("ghost") && found.len() == 2);
    }

    #[test]
    fn a_bare_alias_target_gives_way_to_the_page_that_declares_it() {
        let found = resolve(json!([
            [{"id": 20, "name": "bob", "original-name": "Bob"}, "name", "bob"],
            [{"id": 21, "name": "robert", "original-name": "Robert", "file": {"id": 8}}, "alias", "bob"]
        ]));
        let Some(Resolution::Found(page)) = found.get("bob") else { panic!("one page") };
        assert_eq!(page.original_name, "Robert");
    }
}
