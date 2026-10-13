//! The pages a block search is scoped to (#492): `page`, the blocks on one page, and `links_to`, the blocks that link to
//! every one of 1 to 5 pages. Both take what every page-taking tool takes (an exact name, an alias, an ISO date, a
//! namespace leaf), resolved by `require_page` (BR-0010), and both follow the alias group of each page (#69): a block
//! on any name of the `page` counts, and a block links to a listed page when it links to any name of it.
//!
//! Calls: one resolver query per distinct name (a name given twice, or as the `page` and again in `links_to`, is
//! resolved once), then one alias-group query for every page together and none when no page has an alias link. The
//! names are resolved one after the other, in the order given, so the error of a call with several bad names is
//! the first one's and never depends on which request finished first. At most 6 names, so at most 6 + 1 calls.

use crate::edn::PageId;
use crate::errors::{InvalidParameter, MatchedBy, ToolError};
use crate::js;
use crate::meta::ResultWarning;
use crate::resolve::alias::{AliasSet, alias_set_warnings, resolve_alias_sets};
use crate::resolve::{ResolvedPage, require_page};
use serde_json::{Map, Value, json};

/// Most pages `links_to` takes. More is refused by `parse_args`, never cut, so no page goes unlinked (BR-0006); the
/// schema's `maxItems` is this constant.
pub const MAX_LINKS_TO: usize = 5;

/// A page the search names, as the block query reads it: every page of its alias group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    /// The name as the caller wrote it, for what the search says about itself
    pub asked: String,
    /// The ids of the page and of the pages that name the same thing. Never empty.
    pub ids: Vec<PageId>,
}

/// A name that was not the exact name of its page (`resolvedFrom`, BR-0010).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFrom {
    pub name: String,
    pub matched_by: MatchedBy,
    pub resolved_to: String,
}

impl ResolvedFrom {
    fn to_value(&self) -> Value {
        json!({"name": self.name, "matchedBy": self.matched_by.as_str(), "resolvedTo": self.resolved_to})
    }
}

/// What the resolving found that the result says (BR-0010, #69): which names were not exact, which names each group
/// covers, and what went wrong with an alias lookup.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Notes {
    pub resolved_from: Vec<ResolvedFrom>,
    /// Each page that has aliases, by its original name, with every name of its group (original case, sorted)
    pub resolved_aliases: Vec<(String, Vec<String>)>,
    pub warnings: Vec<ResultWarning>,
}

impl Notes {
    /// `resolvedFrom`: one `{ name, matchedBy, resolvedTo }` for each name that was an alias, a date or a namespace
    /// leaf. `None` when every name was exact, so a call with exact names has the output it always had.
    pub fn resolved_from_value(&self) -> Option<Value> {
        (!self.resolved_from.is_empty()).then(|| Value::Array(self.resolved_from.iter().map(ResolvedFrom::to_value).collect()))
    }

    /// `resolvedAliases`: the names each aliased page was searched under. `None` when no page has aliases.
    pub fn resolved_aliases_value(&self) -> Option<Value> {
        (!self.resolved_aliases.is_empty())
            .then(|| Value::Object(self.resolved_aliases.iter().map(|(page, names)| (page.clone(), json!(names))).collect::<Map<_, _>>()))
    }
}

/// The pages of a call, resolved. Empty when the call named none.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Scope {
    pub page: Option<Group>,
    /// One group per page the blocks must link to, in the order asked
    pub links_to: Vec<Group>,
    pub notes: Notes,
}

impl Scope {
    /// The call named a page, so the search is narrowed by one.
    pub fn is_empty(&self) -> bool {
        self.page.is_none() && self.links_to.is_empty()
    }
}

/// The names of `page` and `links_to` are not blank, or an [`InvalidParameter`]. A blank name is a mistake of the
/// caller's, not a page that is missing, so it is refused before any call.
pub fn check_names(page: Option<&str>, links_to: Option<&[String]>) -> Result<(), InvalidParameter> {
    let blank = |name: &str| js::trim(name).is_empty();
    if page.is_some_and(blank) {
        return Err(blank_name("page", page.unwrap_or_default(), "page: \"project atlas\""));
    }
    if let Some(name) = links_to.and_then(|names| names.iter().find(|name| blank(name))) {
        return Err(blank_name("links_to", name, "links_to: [\"alice\"]"));
    }
    Ok(())
}

fn blank_name(param: &str, name: &str, example: &str) -> InvalidParameter {
    InvalidParameter {
        param: param.to_owned(),
        value: json!(name).to_string(),
        expected: "a page name, alias or ISO date; a blank name is no page".to_owned(),
        example: Some(example.to_owned()),
    }
}

/// The key a name is resolved once under: what `require_page` would trim and the page names fold.
fn key_of(name: &str) -> String {
    js::trim(name).to_lowercase()
}

/// Every name resolved: the `page` first, then each of `links_to` in order. A name that matches no page fails with the
/// closest names ([`ToolError::PageNotFound`]), one that matches several with the candidates
/// ([`ToolError::AmbiguousPage`]), and a LogSeq error propagates (BR-0003).
///
/// API calls: one per distinct name, then one for all the alias groups, or none of those when no page has an alias
/// link.
pub async fn resolve_scope(client: &crate::client::LogseqClient, page: Option<&str>, links_to: &[String]) -> Result<Scope, ToolError> {
    let asked: Vec<&str> = page.into_iter().chain(links_to.iter().map(String::as_str)).collect();
    // The distinct names, in the order they first appear
    let mut resolved: Vec<(String, ResolvedPage)> = Vec::new();
    for name in &asked {
        let key = key_of(name);
        if !resolved.iter().any(|(seen, _)| *seen == key) {
            let found = require_page(client, name).await?;
            resolved.push((key, found));
        }
    }
    if resolved.is_empty() {
        return Ok(Scope::default());
    }

    let pages: Vec<&crate::resolve::PulledPage> = resolved.iter().map(|(_, found)| &found.page).collect();
    let sets = resolve_alias_sets(client, &pages).await?;

    let mut notes = Notes::default();
    notes.warnings.extend(alias_set_warnings(&sets.iter().collect::<Vec<_>>()));
    // Only the first mention of a name says how it resolved, so a name used twice says it once
    let mut said: Vec<String> = Vec::new();
    let mut group_of = |name: &str| -> Result<Group, ToolError> {
        let key = key_of(name);
        let at = resolved.iter().position(|(seen, _)| *seen == key).expect("every name was resolved");
        let (found, set) = (&resolved[at].1, &sets[at]);
        if !said.contains(&key) {
            said.push(key);
            if found.matched_by != MatchedBy::Name {
                notes.resolved_from.push(ResolvedFrom { name: name.to_owned(), matched_by: found.matched_by, resolved_to: found.original_name.clone() });
            }
            // Two names of one page (a page and its alias) are one group, said once
            if let Some(names) = set.resolved_aliases().filter(|_| !notes.resolved_aliases.iter().any(|(page, _)| *page == found.original_name)) {
                notes.resolved_aliases.push((found.original_name.clone(), names));
            }
        }
        Ok(Group { asked: name.to_owned(), ids: ids_of(set, name)? })
    };
    let page_group = page.map(&mut group_of).transpose()?;
    let links = links_to.iter().map(|name| group_of(name)).collect::<Result<Vec<_>, _>>()?;
    Ok(Scope { page: page_group, links_to: links, notes })
}

/// The ids of an alias group. A group with none can't be queried: a page the resolver found always has one.
fn ids_of(set: &AliasSet, name: &str) -> Result<Vec<PageId>, ToolError> {
    let ids = set.ids()?;
    if ids.is_empty() {
        return Err(ToolError::Failed(format!("The page \"{name}\" has no id, so blocks can't be matched to it.")));
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(page: Option<&str>, links_to: Option<&[&str]>) -> Option<String> {
        let links: Option<Vec<String>> = links_to.map(|names| names.iter().map(|name| (*name).to_owned()).collect());
        check_names(page, links.as_deref()).err().map(|error| error.to_string())
    }

    #[test]
    fn a_blank_name_is_refused_and_a_name_with_text_is_not() {
        assert_eq!(refused(Some("Atlas"), Some(&["Bob", "alice"])), None);
        assert_eq!(refused(None, None), None);
        assert_eq!(
            refused(Some("  "), None).unwrap(),
            "Invalid parameter 'page': \"  \"\n\nExpected: a page name, alias or ISO date; a blank name is no page\nExample: page: \"project atlas\""
        );
        assert_eq!(
            refused(None, Some(&["Bob", ""])).unwrap(),
            "Invalid parameter 'links_to': \"\"\n\nExpected: a page name, alias or ISO date; a blank name is no page\nExample: links_to: [\"alice\"]"
        );
        // the page is read before the list
        assert!(refused(Some(""), Some(&[" "])).unwrap().starts_with("Invalid parameter 'page'"));
    }

    #[test]
    fn a_name_is_the_same_name_ignoring_case_and_the_white_space_around_it() {
        assert_eq!(key_of("  Project Atlas "), key_of("project atlas"));
        assert_ne!(key_of("atlas"), key_of("project atlas"));
    }

    #[test]
    fn the_notes_say_nothing_for_exact_names_and_one_entry_per_name_that_was_not() {
        let none = Notes::default();
        assert_eq!((none.resolved_from_value(), none.resolved_aliases_value()), (None, None));
        let notes = Notes {
            resolved_from: vec![ResolvedFrom { name: "al".into(), matched_by: MatchedBy::Alias, resolved_to: "Alice".into() }],
            resolved_aliases: vec![("Alice".into(), vec!["Al".into(), "Alice".into()])],
            warnings: Vec::new(),
        };
        assert_eq!(notes.resolved_from_value().unwrap().to_string(), r#"[{"name":"al","matchedBy":"alias","resolvedTo":"Alice"}]"#);
        assert_eq!(notes.resolved_aliases_value().unwrap().to_string(), r#"{"Alice":["Al","Alice"]}"#);
    }
}
