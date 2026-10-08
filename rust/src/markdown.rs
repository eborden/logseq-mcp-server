//! The one Markdown renderer (#43; the Rust side of `src/utils/markdown.ts`). Every tool that takes
//! `format: "markdown"` and the `logseq://page/{name}` resource render through here, so a page
//! looks the same wherever it is read. Never add a second renderer.
//!
//! Layout, the way LogSeq stores a page:
//! - a `#` title, then page properties as `key:: value` lines;
//! - blocks as `- ` bullets, one tab per nesting level, continuation lines of a multi-line block
//!   indented under the bullet;
//! - `((uuid))` refs stay exactly as written. With `resolve_refs` a block also shows its
//!   `resolvedContent` on a `[resolved]` line below it;
//! - a short footer for warnings, `hasMore` and tips ([`render_footer`]).
//!
//! The functions are pure: they take the tools' result objects (`serde_json::Value`, as LogSeq
//! sent them) and return text. They read tolerantly, as the TypeScript ones do, because the shapes
//! differ by source (Editor API camelCase, Datalog kebab-case, `children` that are unfetched
//! `["uuid", "<id>"]` tuples rather than blocks).
//!
//! Not ported yet: `compact`, and `showUuid` and `showPage` on the outline. Only the tools that
//! take them use them (`build_context`, `get_context_for_query`), and they come with those tools.
//!
//! Lengths and cuts are in UTF-16 code units, as JavaScript counts them (see `js`).

use serde_json::{Map, Value};

use crate::js;

/// Shown after the start of a first block that alone exceeds the limit.
pub const TRUNCATED_BLOCK_MARKER: &str = "\n[This block is longer than the limit and was truncated here.]";

/// `nonEmpty`: a string that isn't blank, as it is.
fn non_empty(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !js::trim(text).is_empty())
}

/// `pageTitle`: the original-case title of a page entity in any of the shapes the tools return,
/// else its name, else `fallback`, else `""`.
pub fn page_title(page: &Value, fallback: Option<&str>) -> String {
    non_empty(page.get("originalName"))
        .or_else(|| non_empty(page.get("original-name")))
        .or_else(|| non_empty(page.get("name")))
        .or(fallback)
        .unwrap_or("")
        .to_owned()
}

/// `isPreBlock`: either spelling of the flag, set to `true`.
fn is_pre_block(block: &Map<String, Value>) -> bool {
    block.get("pre-block?") == Some(&Value::Bool(true)) || block.get("preBlock?") == Some(&Value::Bool(true))
}

/// What [`render_outline`] takes.
#[derive(Debug, Clone, Copy, Default)]
pub struct OutlineOptions {
    /// Stop after this many characters (UTF-16 code units) and report `cut`. Unlimited when `None`.
    pub max_chars: Option<usize>,
    /// Leave out pre-blocks, whose text is the page properties already rendered above
    pub skip_pre_blocks: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outline {
    pub lines: Vec<String>,
    /// True when `max_chars` stopped the outline before the last block
    pub cut: bool,
}

/// JavaScript's `string.length`.
fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// One block as a bullet: `content`, with its continuation lines and `resolvedContent` indented under it.
fn bullet_text(block: &Map<String, Value>, depth: usize) -> String {
    let indent = "\t".repeat(depth);
    let content = block.get("content").and_then(Value::as_str).unwrap_or("");
    let mut lines = Vec::new();
    for (i, line) in content.split('\n').enumerate() {
        lines.push(if i == 0 { format!("{indent}- {line}") } else { format!("{indent}  {line}") });
    }
    // `content` is never changed; the resolved text is shown beside it, not in place of it
    if let Some(resolved) = block.get("resolvedContent").and_then(Value::as_str).filter(|resolved| *resolved != content) {
        for (i, line) in resolved.split('\n').enumerate() {
            lines.push(if i == 0 { format!("{indent}  [resolved] {line}") } else { format!("{indent}    {line}") });
        }
    }
    lines.join("\n")
}

/// `text.slice(0, end)` in UTF-16 code units, for a `text` too long for what is left of the budget.
// PARITY(#299): the cut is by UTF-16 code unit, as `slice` cuts. A cut between the halves of a surrogate
// pair would leave a lone surrogate, which a Rust string can't hold (TypeScript writes it as a `\ud83d`
// escape, ill-formed text that many clients show as U+FFFD): the cut stops one unit earlier instead
// (suspected TS bug: `slice` should cut by code point) — drop if Rust becomes the only server.
fn slice_start(text: &str, end: usize) -> String {
    let units = js::utf16(text);
    let mut end = end.min(units.len());
    if end > 0 && (0xD800..0xDC00).contains(&units[end - 1]) {
        end -= 1;
    }
    String::from_utf16(&units[..end]).expect("a cut that keeps both halves of every pair is well-formed")
}

struct Walk {
    out: Vec<String>,
    left: usize,
    cut: bool,
    skip_pre_blocks: bool,
}

impl Walk {
    fn walk(&mut self, siblings: &[Value], depth: usize) {
        for block in siblings {
            if self.cut {
                return;
            }
            // Not a block object (an unfetched `["uuid", "<id>"]` tuple, say): skipped
            let Some(block) = block.as_object() else { continue };
            if self.skip_pre_blocks && is_pre_block(block) {
                continue;
            }
            let text = bullet_text(block, depth);
            let size = length(&text) + 1;
            if size > self.left {
                self.cut = true;
                // A first block over the cap would otherwise render as an empty page.
                // Keep its start, with a marker, so the reader sees real content.
                if self.out.is_empty() {
                    let keep = self.left.saturating_sub(TRUNCATED_BLOCK_MARKER.len() + 1);
                    self.out.push(format!("{}{TRUNCATED_BLOCK_MARKER}", slice_start(&text, keep)));
                }
                return;
            }
            self.out.push(text);
            self.left -= size;
            if let Some(children) = block.get("children").and_then(Value::as_array) {
                self.walk(children, depth + 1);
            }
        }
    }
}

/// `renderOutline`: a block tree as an outline. Stops at `max_chars` when given, and says so
/// through `cut`; the caller owns the notice. Children that are not block objects (unfetched
/// `["uuid", "<id>"]` tuples) are skipped.
pub fn render_outline(blocks: &[Value], options: OutlineOptions) -> Outline {
    let mut walk = Walk { out: Vec::new(), left: options.max_chars.unwrap_or(usize::MAX), cut: false, skip_pre_blocks: options.skip_pre_blocks };
    walk.walk(blocks, 0);
    Outline { lines: walk.out, cut: walk.cut }
}

/// `kebabKey`: `fooBar` back to `foo-bar`. The Editor API camelCases property keys, LogSeq files
/// write them kebab-case. `/([a-z0-9])([A-Z])/g`: matches don't overlap, so in `aBC` only `aB` matches.
fn kebab_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let mut out = String::with_capacity(key.len() + 2);
    let mut i = 0;
    while i < chars.len() {
        if i + 1 < chars.len() && (chars[i].is_ascii_lowercase() || chars[i].is_ascii_digit()) && chars[i + 1].is_ascii_uppercase() {
            out.push(chars[i]);
            out.push('-');
            out.push(chars[i + 1]);
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out.to_lowercase()
}

fn as_link(value: &str) -> String {
    if value.contains("[[") { value.to_owned() } else { format!("[[{value}]]") }
}

/// `propertyValue`: a property's value as text, or `None` when it has nothing to show.
fn property_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Array(items) => {
            // A multi-value property (a set in Datalog, an array from the Editor API) holds page refs
            let parts: Vec<String> = items
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) if !js::trim(text).is_empty() => Some(as_link(text)),
                    other => property_value(other),
                })
                .collect();
            (!parts.is_empty()).then(|| parts.join(", "))
        }
        Value::Object(_) => Some(js::json_stringify(value)),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(n) => Some(js::number_to_string(n.as_f64().expect("a JSON number is finite"))),
        Value::String(text) => (!js::trim(text).is_empty()).then(|| text.clone()),
    }
}

/// `renderProperties`: properties as LogSeq writes them, `key:: value`, rebuilt from a `properties`
/// map. Keys are shown kebab-case, multi-value properties as `[[a]], [[b]]`. Empty values are left
/// out. This is the fallback for a page whose pre-block was not fetched: the pre-block's own text
/// ([`pre_block_lines`]) is the faithful form, and is preferred.
pub fn render_properties(properties: Option<&Value>) -> Vec<String> {
    let Some(Value::Object(map)) = properties else { return Vec::new() };
    js::entries_in_js_order(map)
        .into_iter()
        .filter_map(|(key, value)| property_value(value).map(|text| format!("{}:: {text}", kebab_key(key))))
        .collect()
}

/// `preBlockLines`: the text of a page's pre-block (its property block) as lines, exactly as
/// LogSeq stores it, or `None` when the tree has none or it is empty. No key or value mapping
/// happens, so nothing is lost.
pub fn pre_block_lines(blocks: &[Value]) -> Option<Vec<String>> {
    let pre = blocks.iter().find(|block| block.as_object().is_some_and(is_pre_block) && non_empty(block.get("content")).is_some())?;
    let content = pre.get("content").and_then(Value::as_str).expect("checked above");
    Some(js::trim_end(content).split('\n').map(str::to_owned).collect())
}

/// The page-properties section, and whether it came from the pre-block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyLines {
    pub lines: Vec<String>,
    /// So the caller knows whether the outline must skip the pre-block
    pub from_pre_block: bool,
}

/// `propertyLines`: the pre-block's own text when the tree has one, else [`render_properties`] on
/// the `properties` map.
pub fn property_lines(properties: Option<&Value>, blocks: Option<&[Value]>) -> PropertyLines {
    match blocks.and_then(pre_block_lines) {
        Some(lines) => PropertyLines { lines, from_pre_block: true },
        None => PropertyLines { lines: render_properties(properties), from_pre_block: false },
    }
}

/// What [`render_page`] takes.
#[derive(Debug, Clone, Copy, Default)]
pub struct PageRenderOptions<'a> {
    /// Whether the blocks were asked for. A page fetched without them gets a title and properties
    /// only; a fetched page with no blocks says so instead of looking empty.
    pub blocks_fetched: bool,
    /// Cut the outline here and append `cut_notice`. Unlimited when `None`.
    pub max_chars: Option<usize>,
    /// Text appended on its own paragraph when the outline was cut
    pub cut_notice: Option<&'a str>,
    /// Title when the page entity has no name
    pub fallback_title: Option<&'a str>,
}

/// `resolvedFromLine`: the `(resolved from "x", matched by alias)` note for a page reached through
/// an alias, date or namespace leaf.
pub fn resolved_from_line(resolved_from: Option<&Value>) -> Option<String> {
    let map = resolved_from?.as_object()?;
    // `JSON.stringify(undefined)` and `String(undefined)` are both "undefined"
    let name = map.get("name").map_or_else(|| "undefined".to_owned(), js::json_stringify);
    let matched_by = match map.get("matchedBy") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => js::json_stringify(other),
        None => "undefined".to_owned(),
    };
    Some(format!("(resolved from {name}, matched by {matched_by})"))
}

/// `renderPage`: one page as Markdown: title, resolved-from note, page properties, then the block
/// outline (children of the page entity). No footer; add one with [`with_footer`].
pub fn render_page(page: &Value, options: PageRenderOptions<'_>) -> String {
    let mut lines = vec![format!("# {}", page_title(page, options.fallback_title)), String::new()];
    if let Some(note) = resolved_from_line(page.get("resolvedFrom")) {
        lines.push(note);
        lines.push(String::new());
    }

    let blocks: &[Value] = page.get("children").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let props = property_lines(page.get("properties"), options.blocks_fetched.then_some(blocks));
    if !props.lines.is_empty() {
        lines.extend(props.lines.iter().cloned());
        lines.push(String::new());
    }

    if !options.blocks_fetched {
        return format!("{}\n", js::trim_end(&lines.join("\n")));
    }

    // The pre-block is the page properties, which are rendered above from its own text
    let outline = render_outline(blocks, OutlineOptions { max_chars: options.max_chars, skip_pre_blocks: props.from_pre_block });
    let body = if !outline.lines.is_empty() || outline.cut { outline.lines.join("\n") } else { "(this page has no blocks)".to_owned() };
    let notice = match options.cut_notice {
        Some(notice) if outline.cut => format!("\n\n{notice}"),
        _ => String::new(),
    };
    format!("{}\n{body}{notice}\n", lines.join("\n"))
}

/// `renderBlock`: one block with its children (as many as were fetched), under a `Block ((uuid))`
/// heading. A block's own text is what it holds; its page is not rendered, because the Editor API
/// returns only a page id for it.
pub fn render_block(block: &Value) -> String {
    let heading = match non_empty(block.get("uuid")) {
        Some(uuid) => format!("# Block (({uuid}))"),
        None => "# Block".to_owned(),
    };
    let outline = render_outline(std::slice::from_ref(block), OutlineOptions::default());
    format!("{heading}\n\n{}\n", outline.lines.join("\n"))
}

/// A warning as the tools report it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FooterWarning {
    pub code: Option<String>,
    pub message: String,
    pub how_to_fetch_all: Option<String>,
}

/// The parts of `ResultMeta` the footer shows, plus tips.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FooterMeta {
    pub warnings: Vec<FooterWarning>,
    pub has_more: bool,
    pub tips: Vec<String>,
}

impl FooterMeta {
    /// The meta a tool's result carries in its own fields (`warnings`, `hasMore`), as the TypeScript
    /// tools pass the result itself to `withFooter`, with the tips the tool made.
    pub fn of_result(result: &Value, tips: &[String]) -> Self {
        let text = |value: Option<&Value>| value.and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
        let warnings = result
            .get("warnings")
            .and_then(Value::as_array)
            .map(|warnings| {
                warnings
                    .iter()
                    .map(|warning| FooterWarning {
                        code: text(warning.get("code")),
                        message: warning.get("message").and_then(Value::as_str).unwrap_or("undefined").to_owned(),
                        how_to_fetch_all: text(warning.get("howToFetchAll")),
                    })
                    .collect()
            })
            .unwrap_or_default();
        FooterMeta { warnings, has_more: result.get("hasMore") == Some(&Value::Bool(true)), tips: tips.to_vec() }
    }
}

/// `renderFooter`: warnings, `hasMore` and tips as a short footer after a `---` rule, or `""` when
/// there is nothing to say. The same information the JSON `meta` carries:
///
/// ```text
/// ---
/// Warnings:
/// - blocks_truncated: Showing 50 of 80 blocks. Set max_blocks to 80 (or higher) to get all 80.
/// hasMore: true
/// Tips:
/// - logseq_get_backlinks {"page_name":"Alice"}
/// ```
pub fn render_footer(meta: &FooterMeta) -> String {
    let mut lines: Vec<String> = Vec::new();
    if !meta.warnings.is_empty() {
        lines.push("Warnings:".to_owned());
        for warning in &meta.warnings {
            let label = warning.code.as_ref().map(|code| format!("{code}: ")).unwrap_or_default();
            let how = warning.how_to_fetch_all.as_ref().map(|how| format!(" {how}")).unwrap_or_default();
            lines.push(format!("- {label}{}{how}", warning.message));
        }
    }
    if meta.has_more {
        lines.push("hasMore: true".to_owned());
    }
    if !meta.tips.is_empty() {
        lines.push("Tips:".to_owned());
        lines.extend(meta.tips.iter().map(|tip| format!("- {tip}")));
    }
    if lines.is_empty() { String::new() } else { format!("---\n{}", lines.join("\n")) }
}

/// `withFooter`: `body` followed by the footer for `meta`, one paragraph apart. Just `body` when
/// the footer is empty.
pub fn with_footer(body: String, meta: &FooterMeta) -> String {
    let footer = render_footer(meta);
    if footer.is_empty() { body } else { format!("{}\n\n{footer}\n", js::trim_end(&body)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const UUID_A: &str = "11111111-1111-4111-8111-111111111111";

    fn outline(blocks: Value) -> Vec<String> {
        render_outline(blocks.as_array().unwrap(), OutlineOptions::default()).lines
    }

    fn page(page: Value, blocks_fetched: bool) -> String {
        render_page(&page, PageRenderOptions { blocks_fetched, ..Default::default() })
    }

    #[test]
    fn nested_blocks_are_indented_with_one_tab_per_level() {
        let blocks = json!([
            {"content": "top", "children": [{"content": "child", "children": [{"content": "grandchild"}]}]},
            {"content": "sibling"},
        ]);
        assert_eq!(outline(blocks).join("\n"), "- top\n\t- child\n\t\t- grandchild\n- sibling");
    }

    #[test]
    fn continuation_lines_are_indented_under_their_bullet() {
        let lines = outline(json!([{"content": "one\ntwo", "children": [{"content": "a\nb"}]}]));
        assert_eq!(lines.join("\n"), "- one\n  two\n\t- a\n\t  b");
    }

    #[test]
    fn refs_stay_as_written_and_resolved_text_goes_beside_the_content() {
        assert_eq!(outline(json!([{"content": format!("see (({UUID_A})) for more")}])), [format!("- see (({UUID_A})) for more")]);
        let block = json!({"content": format!("see (({UUID_A}))"), "resolvedContent": "see the cited text\nover two lines"});
        assert_eq!(outline(json!([block])).join("\n"), format!("- see (({UUID_A}))\n  [resolved] see the cited text\n    over two lines"));
        assert_eq!(outline(json!([{"content": "plain", "resolvedContent": "plain"}])), ["- plain"]);
    }

    #[test]
    fn unfetched_children_and_other_non_blocks_are_skipped_and_an_empty_block_is_a_bare_bullet() {
        assert_eq!(outline(json!([{"content": "parent", "children": [["uuid", "123"], 5, null]}, "text", ["x"]])), ["- parent"]);
        assert_eq!(outline(json!([{"content": ""}, {}, {"content": 5}])), ["- ", "- ", "- "]);
    }

    #[test]
    fn pre_blocks_are_skipped_only_when_asked_to_in_either_spelling() {
        let blocks = json!([{"content": "alias:: x", "pre-block?": true}, {"content": "y", "preBlock?": true}, {"content": "real"}, {"content": "z", "pre-block?": "true"}]);
        assert_eq!(outline(blocks.clone()), ["- alias:: x", "- y", "- real", "- z"]);
        let skipped = render_outline(blocks.as_array().unwrap(), OutlineOptions { skip_pre_blocks: true, ..Default::default() });
        assert_eq!(skipped.lines, ["- real", "- z"]);
    }

    #[test]
    fn the_outline_stops_at_the_cap_and_says_so() {
        let blocks: Vec<Value> = (0..10).map(|i| json!({"content": format!("block {i} {}", "x".repeat(20))})).collect();
        let cut = render_outline(&blocks, OutlineOptions { max_chars: Some(100), ..Default::default() });
        assert!(cut.cut);
        assert!(!cut.lines.is_empty() && cut.lines.len() < 10);
        // each line costs its length and a newline: `- block 0 xxxxxxxxxxxxxxxxxxxx` is 30 + 1
        assert_eq!(cut.lines.len(), 3);
        let whole = render_outline(&blocks[..1], OutlineOptions { max_chars: Some(31), ..Default::default() });
        assert!(!whole.cut, "a block that fits exactly is not cut");
        assert!(render_outline(&blocks[..1], OutlineOptions { max_chars: Some(30), ..Default::default() }).cut);
    }

    #[test]
    fn a_first_block_over_the_cap_keeps_its_start_and_a_marker() {
        let blocks = [json!({"content": format!("START {}", "y".repeat(500))})];
        let cut = render_outline(&blocks, OutlineOptions { max_chars: Some(100), ..Default::default() });
        assert!(cut.cut);
        assert_eq!(cut.lines.len(), 1);
        assert!(cut.lines[0].contains("- START yyy"));
        assert!(cut.lines[0].ends_with(TRUNCATED_BLOCK_MARKER));
        assert_eq!(length(&cut.lines[0]), 100 - 1);
    }

    #[test]
    fn the_cut_counts_utf16_units_and_never_splits_a_surrogate_pair() {
        // `- ` and the rocket (2 units) fill 4 of the 7 units left for text after the marker
        assert_eq!(slice_start("- \u{1F680}\u{1F680}", 4), "- \u{1F680}");
        assert_eq!(slice_start("- \u{1F680}\u{1F680}", 3), "- ", "a cut between the two halves of a rocket stops before it");
        assert_eq!(slice_start("abc", 0), "");
        assert_eq!(slice_start("abc", 10), "abc");
        // a bullet of 3 rockets is 2 + 6 = 8 units; with 5 left it is over the cap
        let cut = render_outline(&[json!({"content": "\u{1F680}\u{1F680}\u{1F680}"})], OutlineOptions { max_chars: Some(5), ..Default::default() });
        assert!(cut.cut);
        assert_eq!(cut.lines, [TRUNCATED_BLOCK_MARKER]);
    }

    #[test]
    fn properties_are_key_value_lines_with_lists_joined_and_empty_values_left_out() {
        let props = json!({"type": "project", "tags": ["a", "b"], "empty": "", "none": null, "count": 3, "flag": false});
        assert_eq!(render_properties(Some(&props)), ["type:: project", "tags:: [[a]], [[b]]", "count:: 3", "flag:: false"]);
    }

    #[test]
    fn property_keys_are_kebab_case_as_logseq_stores_them() {
        let props = json!({"projectStatus": "active", "due-date": "2025-01-01", "logseq.orderListType": "number"});
        assert_eq!(
            render_properties(Some(&props)),
            ["project-status:: active", "due-date:: 2025-01-01", "logseq.order-list-type:: number"]
        );
        // matches don't overlap: only `aB` of `aBC` is a match
        assert_eq!(kebab_key("aBC"), "a-bc");
        assert_eq!(kebab_key("a1B"), "a1-b");
        assert_eq!(kebab_key("ABc"), "abc");
        assert_eq!(kebab_key("fooBarBaz"), "foo-bar-baz");
    }

    #[test]
    fn page_refs_keep_their_brackets_and_other_values_are_written_as_javascript_writes_them() {
        let props = json!({
            "see-also": ["[[Project Atlas]]", "Carol", " ", 4, null, ["x"]],
            "owner": "[[Alice]]",
            "ratings": [1, 2.5],
            "nested": {"b": 1, "2": [true]},
            "big": 1e21,
            "blank": "  ",
            "none": [null, ""],
        });
        assert_eq!(
            render_properties(Some(&props)),
            [
                "see-also:: [[Project Atlas]], [[Carol]], 4, [[x]]",
                "owner:: [[Alice]]",
                "ratings:: 1, 2.5",
                r#"nested:: {"2":[true],"b":1}"#,
                "big:: 1e+21",
            ]
        );
    }

    #[test]
    fn properties_come_out_in_the_order_javascript_lists_object_keys() {
        // integer-like keys first, ascending, then the rest in the order they came
        let props = json!({"b": "x", "10": "ten", "2": "two", "a": "y"});
        assert_eq!(render_properties(Some(&props)), ["2:: two", "10:: ten", "b:: x", "a:: y"]);
    }

    #[test]
    fn a_missing_or_non_object_properties_value_gives_nothing() {
        assert!(render_properties(None).is_empty());
        assert!(render_properties(Some(&json!("x"))).is_empty());
        assert!(render_properties(Some(&json!(["a"]))).is_empty());
        assert!(render_properties(Some(&json!({}))).is_empty());
    }

    #[test]
    fn a_page_is_its_title_then_properties_then_blocks() {
        let alice = json!({"originalName": "Alice", "name": "alice", "properties": {"type": "person"}, "children": [{"content": "first"}]});
        assert_eq!(page(alice, true), "# Alice\n\ntype:: person\n\n- first\n");
        assert_eq!(page(json!({"originalName": "Alice", "properties": {}, "children": [{"content": "first"}]}), true), "# Alice\n\n- first\n");
    }

    #[test]
    fn the_pre_block_is_the_properties_verbatim_and_is_not_repeated_in_the_outline() {
        let pre = "project-status:: active\nrelated-to:: [[Alice]], [[Bob]]\nrating:: 3\narchived:: false\n";
        let alice = json!({
            "originalName": "Alice",
            // the map the Editor API would hand back: camelCased keys, refs without brackets
            "properties": {"projectStatus": "active", "relatedTo": ["Alice", "Bob"], "rating": 3, "archived": false},
            "children": [{"content": pre, "pre-block?": true}, {"content": "real"}],
        });
        assert_eq!(page(alice, true), format!("# Alice\n\n{}\n\n- real\n", pre.trim_end()));
        // without a properties map, and in the Editor API's spelling of the flag
        let bare = json!({"originalName": "Alice", "children": [{"content": "alias:: x", "preBlock?": true}]});
        assert_eq!(page(bare, true), "# Alice\n\nalias:: x\n\n(this page has no blocks)\n");
        // a blank pre-block is no pre-block: the map is the fallback and the blank block is listed
        let blank = json!({"originalName": "Alice", "properties": {"a": "b"}, "children": [{"content": " \n", "pre-block?": true}]});
        // shown as it is: a bullet, and the second (empty) line indented under it
        assert_eq!(page(blank, true), "# Alice\n\na:: b\n\n-  \n  \n");
    }

    #[test]
    fn the_properties_map_is_the_fallback_and_a_page_without_blocks_says_so() {
        let alice = json!({"originalName": "Alice", "properties": {"projectStatus": "active", "related": ["Alice"]}, "children": [{"content": "real"}]});
        assert_eq!(page(alice, true), "# Alice\n\nproject-status:: active\nrelated:: [[Alice]]\n\n- real\n");
        assert_eq!(page(json!({"originalName": "Alice"}), true), "# Alice\n\n(this page has no blocks)\n");
        // `children` that isn't a list is no blocks
        assert_eq!(page(json!({"originalName": "Alice", "children": {}}), true), "# Alice\n\n(this page has no blocks)\n");
    }

    #[test]
    fn a_page_fetched_without_blocks_is_its_title_and_properties_only() {
        assert_eq!(page(json!({"originalName": "Alice", "properties": {"type": "person"}, "children": [{"content": "x"}]}), false), "# Alice\n\ntype:: person\n");
        assert_eq!(page(json!({"originalName": "Alice"}), false), "# Alice\n");
    }

    #[test]
    fn the_title_is_read_in_either_spelling_and_falls_back_to_the_given_one() {
        assert_eq!(page(json!({"original-name": "Bob"}), false), "# Bob\n");
        assert_eq!(page(json!({"originalName": " ", "name": "bob"}), false), "# bob\n");
        assert_eq!(render_page(&json!({}), PageRenderOptions { fallback_title: Some("x y"), ..Default::default() }), "# x y\n");
        // the title line is trimmed with the rest of a page that has nothing after it
        assert_eq!(page(json!({}), false), "#\n");
    }

    #[test]
    fn a_page_reached_another_way_says_where_it_came_from() {
        let alice = json!({"originalName": "Alice", "resolvedFrom": {"name": "Al \"x\"", "matchedBy": "alias", "resolvedTo": "Alice"}});
        assert_eq!(page(alice, false), "# Alice\n\n(resolved from \"Al \\\"x\\\"\", matched by alias)\n");
        assert_eq!(resolved_from_line(Some(&json!("x"))), None);
        assert_eq!(resolved_from_line(Some(&json!({}))).unwrap(), "(resolved from undefined, matched by undefined)");
    }

    #[test]
    fn a_cut_outline_gets_the_notice() {
        let blocks: Vec<Value> = (0..50).map(|i| json!({"content": format!("{i} {}", "x".repeat(30))})).collect();
        let alice = json!({"originalName": "Alice", "children": blocks});
        let text = render_page(&alice, PageRenderOptions { blocks_fetched: true, max_chars: Some(200), cut_notice: Some("[Cut here.]"), ..Default::default() });
        assert!(text.ends_with("\n\n[Cut here.]\n"), "{text}");
        let uncut = render_page(&json!({"originalName": "A", "children": [{"content": "x"}]}), PageRenderOptions { blocks_fetched: true, max_chars: Some(200), cut_notice: Some("[Cut here.]"), ..Default::default() });
        assert_eq!(uncut, "# A\n\n- x\n");
    }

    #[test]
    fn a_block_is_titled_by_its_uuid_and_shows_the_children_fetched() {
        let block = json!({"uuid": UUID_A, "content": "parent", "children": [{"content": "kid"}]});
        assert_eq!(render_block(&block), format!("# Block (({UUID_A}))\n\n- parent\n\t- kid\n"));
        assert_eq!(render_block(&json!({"content": "x"})), "# Block\n\n- x\n");
        assert_eq!(render_block(&json!({"uuid": " ", "content": "x"})), "# Block\n\n- x\n");
    }

    fn warning(code: Option<&str>, message: &str, how: Option<&str>) -> FooterWarning {
        FooterWarning { code: code.map(str::to_owned), message: message.to_owned(), how_to_fetch_all: how.map(str::to_owned) }
    }

    #[test]
    fn the_footer_is_empty_when_there_is_nothing_to_say() {
        assert_eq!(render_footer(&FooterMeta::default()), "");
        assert_eq!(with_footer("# A\n".to_owned(), &FooterMeta::default()), "# A\n");
    }

    #[test]
    fn the_footer_lists_warnings_hasmore_and_tips_in_that_order() {
        let meta = FooterMeta {
            warnings: vec![warning(Some("blocks_truncated"), "Showing 5 of 9 blocks.", Some("Set max_blocks to 9.")), warning(None, "w", None)],
            has_more: true,
            tips: vec!["t".to_owned()],
        };
        assert_eq!(
            render_footer(&meta).split('\n').collect::<Vec<_>>(),
            ["---", "Warnings:", "- blocks_truncated: Showing 5 of 9 blocks. Set max_blocks to 9.", "- w", "hasMore: true", "Tips:", "- t"]
        );
        let tips = FooterMeta { tips: vec![r#"logseq_get_backlinks {"page_name":"Alice"}"#.to_owned()], ..Default::default() };
        assert_eq!(render_footer(&tips), "---\nTips:\n- logseq_get_backlinks {\"page_name\":\"Alice\"}");
    }

    #[test]
    fn the_footer_goes_one_paragraph_after_the_body() {
        let tips = FooterMeta { tips: vec!["t".to_owned()], ..Default::default() };
        assert_eq!(with_footer("# A\n".to_owned(), &tips), "# A\n\n---\nTips:\n- t\n");
    }

    #[test]
    fn a_result_carries_its_own_footer_fields() {
        let result = json!({
            "id": 1,
            "hasMore": true,
            "warnings": [{"code": "refs_truncated", "message": "m", "howToFetchAll": "do it"}, {"code": "", "message": "n"}],
        });
        let meta = FooterMeta::of_result(&result, &["t".to_owned()]);
        assert_eq!(meta.warnings, [warning(Some("refs_truncated"), "m", Some("do it")), warning(None, "n", None)]);
        assert!(meta.has_more);
        assert_eq!(FooterMeta::of_result(&json!({"hasMore": "true", "warnings": {}}), &[]), FooterMeta::default());
    }
}
