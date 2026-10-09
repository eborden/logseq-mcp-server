//! Next-step tips (#44, BR-0009). After a result the model
//! usually needs one more call, and a tip names it with ready-to-use arguments. Tips are built
//! from the result, never by the tool's own code, so the primary result keeps its shape; they
//! travel in a trailing `{"meta":{"tips":[...]}}` content block, and there is none when there are
//! no tips. What every tool's tips share is here; what a tool suggests is in its own directory.

use serde_json::{Map, Value, json};

use crate::js;

/// Most tips one result carries, each one line.
pub const MAX_TIPS: usize = 2;

/// A suggested call: the tool name followed by its arguments as JSON, so a name with quotes,
/// backslashes or newlines stays a valid call.
pub fn suggest_call(tool: &str, args: &Value) -> String {
    format!("{tool} {}", args)
}

/// A text that isn't blank (`nonEmptyString`).
pub fn non_empty(text: &str) -> Option<&str> {
    (!js::trim(text).is_empty()).then_some(text)
}

/// `metaContent(null, tips)`: the trailing block that carries the tips, or `None` when there are none.
pub fn tips_content(tips: &[String]) -> Option<String> {
    (!tips.is_empty()).then(|| json!({"meta": {"tips": tips}}).to_string())
}

fn as_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `nonEmptyString`: a string that isn't blank, as it is.
fn non_empty_value(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !js::trim(text).is_empty())
}

/// The name a page-like object carries: its original name in either spelling, else its name.
fn name_of_page<'v>(page: Option<&'v Map<String, Value>>) -> Option<&'v str> {
    let page = page?;
    non_empty_value(page.get("originalName")).or_else(|| non_empty_value(page.get("original-name"))).or_else(|| non_empty_value(page.get("name")))
}

/// `pageNameOf`: the page name of a block in the shapes the tools return: slim blocks (`pageName`),
/// search context (`context.page`), and a full block's own `page`.
fn page_name_of(block: &Value) -> Option<&str> {
    let block = block.as_object()?;
    let context_page = as_object(as_object(block.get("context")).and_then(|context| context.get("page")));
    non_empty_value(block.get("pageName"))
        .or_else(|| name_of_page(context_page))
        .or_else(|| name_of_page(as_object(block.get("page"))))
}

/// `journalStatus`: whether the page behind a block is a journal date page. True or false when the
/// block carries a page entity with a name, `None` when only a name (a slim block) or a bare id is
/// known.
pub(crate) fn journal_status(block: &Value) -> Option<bool> {
    let block = as_object(Some(block))?;
    let context_page = as_object(as_object(block.get("context")).and_then(|context| context.get("page")));
    let page = [context_page, as_object(block.get("page"))].into_iter().flatten().find(|page| name_of_page(Some(page)).is_some())?;
    let set = |key: &str| page.get(key).is_some_and(|value| !value.is_null());
    Some(
        page.get("isJournal") == Some(&Value::Bool(true))
            || set("journalDate")
            || page.get("journal?") == Some(&Value::Bool(true))
            || page.get("journal") == Some(&Value::Bool(true))
            || set("journalDay")
            || set("journal-day"),
    )
}

/// `topicsOf`: the topic names a block mentions: its `#tags` and `[[page refs]]` (slim blocks), and
/// `context.tags`.
fn topics_of(block: &Value) -> Vec<&str> {
    let Some(block) = block.as_object() else { return Vec::new() };
    let context_tags = as_object(block.get("context")).and_then(|context| context.get("tags"));
    [block.get("tags"), block.get("pageRefs"), context_tags]
        .into_iter()
        .flat_map(|list| list.and_then(Value::as_array).into_iter().flatten())
        .filter_map(|topic| non_empty_value(Some(topic)))
        .collect()
}

/// `mostCommon`: the most frequent value; the first one seen wins a tie.
fn most_common<'v>(values: impl IntoIterator<Item = &'v str>) -> Option<&'v str> {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for value in values {
        match counts.iter_mut().find(|(seen, _)| *seen == value) {
            Some((_, count)) => *count += 1,
            None => counts.push((value, 1)),
        }
    }
    let mut best: Option<&str> = None;
    let mut best_count = 0;
    for (value, count) in counts {
        if count > best_count {
            best = Some(value);
            best_count = count;
        }
    }
    best
}

pub(crate) enum Kind {
    Page,
    Topic,
}

/// `suggestTopic`: the topic worth a `build_context` call for a set of hit blocks. Most hits sit on
/// journal date pages, which make the least informative next step, so in order:
/// 1. the page most hits are on, among pages known not to be journals;
/// 2. the `#tag` or `[[ref]]` most hits mention (slim hits carry no journal flag);
/// 3. the most common page whose kind is unknown (its journal flag isn't in the hit);
/// 4. a journal page, only when nothing else is available.
pub(crate) fn suggest_topic(blocks: &[Value]) -> Option<(&str, Kind)> {
    let named: Vec<(&str, Option<bool>)> =
        blocks.iter().filter_map(|block| page_name_of(block).map(|name| (name, journal_status(block)))).collect();

    let non_journal = most_common(named.iter().filter(|(_, journal)| *journal == Some(false)).map(|(name, _)| *name));
    if let Some(name) = non_journal {
        return Some((name, Kind::Page));
    }
    if let Some(topic) = most_common(blocks.iter().flat_map(topics_of)) {
        return Some((topic, Kind::Topic));
    }
    if let Some(name) = most_common(named.iter().filter(|(_, journal)| journal.is_none()).map(|(name, _)| *name)) {
        return Some((name, Kind::Page));
    }
    most_common(named.iter().map(|(name, _)| *name)).map(|name| (name, Kind::Page))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_tips_is_no_block() {
        assert_eq!(tips_content(&[]), None);
    }

    #[test]
    fn tips_travel_in_a_meta_block() {
        let text = tips_content(&["a \"b\"".to_owned()]).unwrap();
        assert_eq!(text, r#"{"meta":{"tips":["a \"b\""]}}"#);
    }

    #[test]
    fn a_call_is_the_tool_and_its_arguments_as_json() {
        assert_eq!(
            suggest_call("logseq_get_block", &json!({"block_uuid": "u", "include_children": true})),
            r#"logseq_get_block {"block_uuid":"u","include_children":true}"#
        );
    }

    #[test]
    fn a_blank_text_is_not_a_tip_argument() {
        assert_eq!(non_empty("  "), None);
        assert_eq!(non_empty(" a "), Some(" a "));
    }
}
