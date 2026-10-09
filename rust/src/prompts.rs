//! MCP prompts (the Rust side of `src/prompts.ts`, #46): reusable starting messages a host shows as
//! slash commands or menu entries. Each returns one short user message that tells the model which
//! tools to call, in what order, and what to hand back. The server stays read-only (BR-0002): a
//! prompt never calls LogSeq and never asks the model to write to the graph through these tools.
//!
//! The long-form guidance lives in `skills/logseq-skills/`. These prompts carry only the steps and the
//! hard limits, and say to follow the skill when the host has it, so the two don't drift into two
//! copies of the same text.
//!
//! Arguments are checked here (strings only, as MCP prompt arguments always are) and a bad one is an
//! `InvalidParams` error. Dates come from the clock passed in, never read inside a builder, so tests
//! don't depend on today's date.

use std::collections::HashMap;

use rmcp::ErrorData;
use rmcp::model::{ErrorCode, GetPromptResult, JsonObject, Prompt, PromptArgument, PromptMessage, Role};
use serde_json::Value;

use crate::dates::CalendarDate;
use crate::js;
use crate::mcp_error::mcp_error;

/// Longest topic accepted, in characters. A topic is a page name or a short
/// phrase, not a paragraph.
pub const MAX_TOPIC_LENGTH: usize = 200;

struct ArgumentDefinition {
    name: &'static str,
    description: &'static str,
    required: bool,
}

struct PromptDefinition {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    arguments: &'static [ArgumentDefinition],
    build: fn(&Arguments, CalendarDate) -> Result<String, ErrorData>,
}

/// What `prompts/get` was sent, every value a string.
type Arguments = HashMap<String, String>;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

fn invalid(message: &str) -> ErrorData {
    mcp_error(ErrorCode::INVALID_PARAMS, message)
}

/// `JSON.stringify` of a string.
fn quoted(text: &str) -> String {
    Value::from(text).to_string()
}

/// The length of a text in characters (code points).
fn length(text: &str) -> usize {
    text.chars().count()
}

/// Reject arguments the prompt does not declare, so a typo is not silently ignored. They are named in the
/// order they were sent in.
fn reject_unknown_arguments(definition: &PromptDefinition, raw: &JsonObject) -> Result<(), ErrorData> {
    let unknown: Vec<String> = raw
        .keys()
        .filter(|key| !definition.arguments.iter().any(|known| known.name == key.as_str()))
        .map(|key| quoted(key))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    let known: Vec<&str> = definition.arguments.iter().map(|a| a.name).collect();
    Err(invalid(&format!(
        "Prompt {} has no argument {}. Arguments: {}.",
        quoted(definition.name),
        unknown.join(", "),
        if known.is_empty() { "(none)".to_owned() } else { known.join(", ") }
    )))
}

fn required_text<'a>(prompt: &str, args: &'a Arguments, name: &str) -> Result<&'a str, ErrorData> {
    let text = args.get(name).map(|value| js::trim(value)).unwrap_or("");
    if text.is_empty() {
        return Err(invalid(&format!("Prompt {} needs a non-empty \"{name}\" argument.", quoted(prompt))));
    }
    let long = length(text);
    if long > MAX_TOPIC_LENGTH {
        return Err(invalid(&format!(
            "\"{name}\" is {long} characters; the limit is {MAX_TOPIC_LENGTH}. Use a page name or a short phrase."
        )));
    }
    Ok(text)
}

fn optional_text<'a>(args: &'a Arguments, name: &str) -> Result<Option<&'a str>, ErrorData> {
    let Some(text) = args.get(name).map(|value| js::trim(value)).filter(|text| !text.is_empty()) else {
        return Ok(None);
    };
    let long = length(text);
    if long > MAX_TOPIC_LENGTH {
        return Err(invalid(&format!("\"{name}\" is {long} characters; the limit is {MAX_TOPIC_LENGTH}.")));
    }
    Ok(Some(text))
}

/// The digits of `text` from `at`, exactly `count` of them, as a number. `\d` is `[0-9]` only.
fn digits(text: &[u8], at: usize, count: usize) -> Option<u32> {
    let slice = text.get(at..at + count)?;
    slice.iter().try_fold(0u32, |n, b| b.is_ascii_digit().then(|| n * 10 + u32::from(b - b'0')))
}

/// A real calendar day from `YYYY-MM-DD` or `YYYYMMDD` (each hyphen optional), or `None`.
fn parse_day(text: &str) -> Option<CalendarDate> {
    let bytes = text.as_bytes();
    let year = digits(bytes, 0, 4)?;
    let mut at = 4;
    if bytes.get(at) == Some(&b'-') {
        at += 1;
    }
    let month = digits(bytes, at, 2)?;
    at += 2;
    if bytes.get(at) == Some(&b'-') {
        at += 1;
    }
    let day = digits(bytes, at, 2)?;
    at += 2;
    if at != bytes.len() {
        return None;
    }
    CalendarDate::real(year as i32, month, day)
}

/// `YYYY-MM-DD`, the year padded to four digits so that year 50 reads `0050`.
fn iso(date: CalendarDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year, date.month, date.day)
}

/// `YYYY-MM`.
fn iso_month(date: CalendarDate) -> String {
    format!("{:04}-{:02}", date.year, date.month)
}

/// A work week, Monday to Friday.
#[derive(Debug, PartialEq, Eq)]
pub struct WeekRange {
    pub monday: String,
    /// First journal day to fetch (`YYYYMMDD`): the Monday
    pub start: u32,
    /// Last journal day to fetch (`YYYYMMDD`): Friday, or today for a week still in progress
    pub end: u32,
    pub end_iso: String,
    /// True when today falls before Friday, so the summary covers a partial week
    pub partial: bool,
}

/// `resolveWeek`: work weeks run Monday to Friday. `week` is `this` (default), `last`, or any day in
/// the week as `YYYY-MM-DD` / `YYYYMMDD`. A week still under way ends today.
pub fn resolve_week(week: Option<&str>, today: CalendarDate) -> Result<WeekRange, ErrorData> {
    let spec = week.unwrap_or("this").to_lowercase();
    let anchor = match spec.as_str() {
        "this" => today,
        "last" => today.shifted(-7),
        _ => parse_day(&spec).ok_or_else(|| {
            invalid(&format!(
                "\"week\" must be \"this\", \"last\", or a date as YYYY-MM-DD or YYYYMMDD (any day in the week); got {}.",
                quoted(week.unwrap_or_default())
            ))
        })?,
    };
    // Journal days are `YYYYMMDD` integers, which have no year before 0000, so a week that starts earlier starts on
    // 0000-01-01. (`week` of 0000-01-01 or 0000-01-02: the week's Monday and Friday both fall in year -1, so the
    // week is that one day.)
    let first_day = CalendarDate { year: 0, month: 1, day: 1 };
    let true_monday = anchor.monday();
    let monday = true_monday.max(first_day);
    if monday > today {
        return Err(invalid(&format!(
            "The week of {} has not started yet. Use \"this\", \"last\", or a date in a past or current week.",
            iso(monday)
        )));
    }
    // Any year is a real year, so a week whose Monday falls in year 99 (`week` of 0100-01-01 to 0100-01-03) ends
    // on the calendar's Friday, 0100-01-01 (end_date 1000101).
    let friday = true_monday.shifted(4).max(first_day);
    let end = if friday > today { today } else { friday };
    Ok(WeekRange {
        monday: iso(monday),
        start: monday.to_logseq_day(),
        end: end.to_logseq_day(),
        end_iso: iso(end),
        partial: end < friday,
    })
}

/// A calendar month.
#[derive(Debug, PartialEq, Eq)]
pub struct MonthRange {
    pub month: String,
    pub start: u32,
    pub end: u32,
    pub end_iso: String,
    pub partial: bool,
}

/// `YYYY-MM` as `^(\d{4})-(\d{2})$` reads it.
fn parse_month(text: &str) -> Option<(u32, u32)> {
    let bytes = text.as_bytes();
    if bytes.len() != 7 || bytes[4] != b'-' {
        return None;
    }
    Some((digits(bytes, 0, 4)?, digits(bytes, 5, 2)?))
}

/// `resolveMonth`: `month` is `this` (default), `last`, or `YYYY-MM`. A month still under way ends today.
pub fn resolve_month(month: Option<&str>, today: CalendarDate) -> Result<MonthRange, ErrorData> {
    let spec = month.unwrap_or("this").to_lowercase();
    let first = match spec.as_str() {
        "this" => today.first_of_month(0),
        "last" => today.first_of_month(-1),
        _ => {
            let parsed = parse_month(&spec).filter(|(_, m)| (1..=12).contains(m));
            let Some((year, m)) = parsed else {
                return Err(invalid(&format!(
                    "\"month\" must be \"this\", \"last\", or YYYY-MM; got {}.",
                    quoted(month.unwrap_or_default())
                )));
            };
            CalendarDate { year: year as i32, month: m, day: 1 }
        }
    };
    if first > today {
        return Err(invalid(&format!(
            "{} has not started yet. Use \"this\", \"last\", or a past or current month.",
            iso_month(first)
        )));
    }
    let last = first.last_of_month_before(1);
    let end = if last > today { today } else { last };
    Ok(MonthRange {
        month: iso_month(first),
        start: first.to_logseq_day(),
        end: end.to_logseq_day(),
        end_iso: iso(end),
        partial: end < last,
    })
}

// ---------------------------------------------------------------------------
// Prompt text
// ---------------------------------------------------------------------------

const READ_ONLY_NOTE: &str =
    "The logseq_* tools only read. Show the result here; write it into the graph only if I ask and you have file access.";

/// What a summary's `Signals` section may hold.
struct SummaryBudget {
    words: &'static str,
    total: u32,
    items: &'static str,
}

/// Summary limits shared by both granularities. Full rules: references/summary-compression.md in logseq-skills.
fn summary_rules(budget: &SummaryBudget) -> String {
    let SummaryBudget { words, total, items } = budget;
    [
        "Rules (hard limits):".to_owned(),
        format!("- Signals: {items} items, {words} words each, one sentence, {total} words in total, no em-dashes."),
        "- Each signal is the thing plus the number or the stake, then stop. Cut explanations.".to_owned(),
        "- Keep what cannot be rebuilt from other systems (how a person works, a boundary, a judgment call) before ticket counts or figures.".to_owned(),
        "- Merge related items before dropping any. Use a flat list with no theme headers.".to_owned(),
        "- Mark sparingly with **Win:**, **Frustration:**, **Unusual:** or **Milestone:**. Leave routine items unmarked.".to_owned(),
        "- [[Link]] only significant people and topics. Open items are ((block-uuid)) refs, never pasted text, and only if still open.".to_owned(),
        r###"- Output: a "tags::" line, a 2-sentence gist, then "## Signals", "## Unresolved" and "## Personal" (all three, even if empty), indented with tabs."###.to_owned(),
    ]
    .join("\n")
}

/// `logseq_list_pages` returns names A-Z, 200 per call (#61), so dated pages come oldest first and a
/// long list cuts the newest. This says how to reach the last `n`.
fn newest_last(n: u32) -> String {
    format!("Names come A-Z, oldest first: if hasMore is true, call again with offset set to total minus {n}.")
}

fn skill_note(skill: &str) -> String {
    format!("If the logseq-skills skill is available, follow its {skill} workflow instead of the steps below.")
}

fn build_weekly_summary(args: &Arguments, today: CalendarDate) -> Result<String, ErrorData> {
    let w = resolve_week(optional_text(args, "week")?, today)?;
    let WeekRange { monday, start, end, end_iso, partial } = &w;
    let partial_note = if *partial { " The week is not over: say so in the gist." } else { "" };
    Ok([
        format!("Write a weekly summary of my LogSeq journal for the work week starting Monday {monday}, through {end_iso}.{partial_note}"),
        skill_note("weekly-summary"),
        String::new(),
        "Steps:".to_owned(),
        format!("1. logseq_query_by_date_range with start_date {start}, end_date {end} and max_blocks 200 (a bigger result can be saved to a file and never shown to you; the cut keeps the oldest days first). If the result has summary.topConcepts, use it to pick the threads to read closely. While it has a blocks_truncated warning, follow its howToFetchAll, which leads with this call: again with the same end_date, the max_blocks you last used and the start_date the warning gives (the first day not shown, or the day the cut fell inside, which repeats its kept blocks, so read it from the start). If the first day alone fills the cap, the warning names that day's block count: query that day alone at it when it is about 300 or less, then keep paging from the next day at max_blocks 200; a bigger day may come back saved, so read it in pieces with a search_term. If it still doesn't fit, or a result comes back saved to a file, don't open the file or raise the cap: lower it (and keep the lower cap for the pages after), or read the day in pieces with a search_term, and say in the gist that part of that day went unread."),
        format!(r#"2. For trend context, logseq_list_pages with name_contains "Weekly", then logseq_get_page (include_children true) on the 2 or 3 most recent. {} Read them for trends only, not for style."#, newest_last(3)),
        "3. Find what is still open: look for TODO, DOING and NOW blocks in the week (and any closed since) with logseq_search_blocks. Report only items still open.".to_owned(),
        "4. Write the summary.".to_owned(),
        String::new(),
        summary_rules(&SummaryBudget { words: "10-15", total: 150, items: "at most 12" }),
        String::new(),
        format!(r#"Name it "Weekly {monday}", tag it [[Weekly Summary]] and link the journal days that had content. {READ_ONLY_NOTE}"#),
    ]
    .join("\n"))
}

fn build_monthly_summary(args: &Arguments, today: CalendarDate) -> Result<String, ErrorData> {
    let m = resolve_month(optional_text(args, "month")?, today)?;
    let MonthRange { month, start, end, end_iso, partial } = &m;
    let partial_note = if *partial { " The month is not over: say so in the gist." } else { "" };
    Ok([
        format!("Write a monthly summary of my LogSeq notes for {month}, through {end_iso}.{partial_note}"),
        skill_note("monthly-summary"),
        String::new(),
        "A monthly summary diffs weeks against earlier months. Listing what happened is the failure mode.".to_owned(),
        String::new(),
        "Steps:".to_owned(),
        format!(r#"1. logseq_list_pages with name_contains "Weekly {month}", then logseq_get_page (include_children true) on each. If a week is missing, say so; do not invent it."#),
        format!(r#"2. logseq_list_pages with name_contains "Monthly", then logseq_get_page on the 1 or 2 most recent, for trajectory context only. {}"#, newest_last(2)),
        format!("3. Spot-check the busiest days in the raw journal: logseq_query_by_date_range with start_date {start}, end_date {end}, include_content false, top_concepts_limit 20 and max_blocks 500 for the shape (its snippets can stop early at that cap, and the first page's summary still covers the whole month), then a narrow range with content and max_blocks 200 for any day a weekly flagged. While either call has a blocks_truncated warning, follow its howToFetchAll, which leads with this call: again with the same arguments (max_blocks as you last used it) and the start_date it gives (the first day not shown, or the day the cut fell inside, which repeats its kept blocks), until a result has no warning or you have what the step needs. Say in the gist if weeks after a cut went unread. If one day alone fills the cap, the warning names that day's block count: query it alone at that count when it is about 300 or less (500 with include_content false), then keep paging from the next day. If it still doesn't fit, or a result is saved to a file, don't open the file or raise the cap: read the day in pieces with a search_term, and say in the gist that part of that day went unread."),
        "4. For each candidate signal, state its trajectory against earlier months in the text: escalating, improving, unchanged, resolved or new. A candidate with no trajectory gets merged or dropped.".to_owned(),
        "5. Verify open items against the journal, past the end of the month, before listing any as unresolved.".to_owned(),
        String::new(),
        summary_rules(&SummaryBudget { words: "12-18", total: 200, items: "at most 12" }),
        String::new(),
        format!(r#"Name it "Monthly {month}", tag it [[Monthly Summary]] and link each [[Weekly YYYY-MM-DD]] page that had content. {READ_ONLY_NOTE}"#),
    ]
    .join("\n"))
}

fn build_continue_on(args: &Arguments, _today: CalendarDate) -> Result<String, ErrorData> {
    let t = quoted(required_text("continue_on", args, "topic")?);
    Ok([
        format!("Help me continue where I left off on {t} in my LogSeq graph."),
        String::new(),
        "Steps:".to_owned(),
        format!("1. logseq_build_context with topic_name {t} (include_temporal_context true). If no page matches, try logseq_list_pages with name_contains, or logseq_search_blocks for the words."),
        format!("2. logseq_search_blocks for {t}, limit 10, to catch recent mentions in journals that the page itself lacks. Results are newest first."),
        "3. Note any TODO or DOING blocks that mention it, and how old they are.".to_owned(),
        String::new(),
        "Then answer in under 200 words: where things stand, what changed most recently (with dates), what is still open, and the one or two obvious next steps. Cite page names. If a call returns hasMore or warnings, say what may be missing.".to_owned(),
        READ_ONLY_NOTE.to_owned(),
    ]
    .join("\n"))
}

fn build_what_do_i_know(args: &Arguments, _today: CalendarDate) -> Result<String, ErrorData> {
    let t = quoted(required_text("what_do_i_know", args, "topic")?);
    Ok([
        format!("What do I know about {t}? Research my LogSeq graph."),
        skill_note("research assistant"),
        String::new(),
        "Steps:".to_owned(),
        format!("1. logseq_build_context with topic_name {t} for the page, its blocks, related pages and references. If it reads as a question rather than a name, use logseq_get_context_for_query instead."),
        format!("2. logseq_search_blocks for {t} (limit 15) for mentions outside the main page. Search is literal, so try one or two spelling variants if it comes back thin."),
        "3. logseq_get_backlinks on the one or two most relevant pages to find connections.".to_owned(),
        String::new(),
        "Then synthesize, do not dump: the main points, how the notes connect, and gaps. Name the pages each point came from. Say if a result was cut (hasMore, warnings).".to_owned(),
        READ_ONLY_NOTE.to_owned(),
    ]
    .join("\n"))
}

fn build_prioritize_tasks(args: &Arguments, _today: CalendarDate) -> Result<String, ErrorData> {
    let focus = optional_text(args, "focus")?.map(quoted);
    let scope = focus.as_ref().map(|f| format!(" Only tasks related to {f}.")).unwrap_or_default();
    Ok([
        format!("What should I work on? Find my open tasks in LogSeq and recommend an order.{scope}"),
        skill_note("task prioritization"),
        String::new(),
        "Steps:".to_owned(),
        r#"1. logseq_search_blocks for "TODO" and for "DOING" (limit 20 each)."#.to_owned(),
        r#"2. logseq_query_by_property with property_key "priority" and property_value "high", and again with property_key "status" and property_value "doing"."#.to_owned(),
        match &focus {
            Some(f) => format!("3. Keep only the tasks tied to {f} (check with logseq_build_context if a task is unclear)."),
            None => "3. Check unclear tasks with logseq_build_context before ranking them.".to_owned(),
        },
        String::new(),
        "Then give a short ranked list: what is in progress, what is high priority, what looks stale (no activity in weeks) and could be dropped or revisited. Cite the page for each. Say if a result was cut.".to_owned(),
        READ_ONLY_NOTE.to_owned(),
    ]
    .join("\n"))
}

const DEFINITIONS: &[PromptDefinition] = &[
    PromptDefinition {
        name: "weekly_summary",
        title: "Weekly summary",
        description: "Summarize a Monday-to-Friday week of journal entries into a few short signals. Defaults to this week.",
        arguments: &[ArgumentDefinition {
            name: "week",
            description: r#""this" (default), "last", or any date in the week as YYYY-MM-DD or YYYYMMDD"#,
            required: false,
        }],
        build: build_weekly_summary,
    },
    PromptDefinition {
        name: "monthly_summary",
        title: "Monthly summary",
        description: "Summarize a month from its weekly summary pages, stating the trajectory of each thread. Defaults to this month.",
        arguments: &[ArgumentDefinition { name: "month", description: r#""this" (default), "last", or YYYY-MM"#, required: false }],
        build: build_monthly_summary,
    },
    PromptDefinition {
        name: "continue_on",
        title: "Continue on a topic",
        description: "Pick up where I left off on a topic: current state, latest activity, open tasks and a suggested next step.",
        arguments: &[ArgumentDefinition { name: "topic", description: r#"Page name or short phrase, e.g. "project atlas""#, required: true }],
        build: build_continue_on,
    },
    PromptDefinition {
        name: "what_do_i_know",
        title: "What do I know about...",
        description: "Research a topic across the graph: notes, connections and gaps, with sources.",
        arguments: &[ArgumentDefinition { name: "topic", description: "Topic, page name or question", required: true }],
        build: build_what_do_i_know,
    },
    PromptDefinition {
        name: "prioritize_tasks",
        title: "What should I work on",
        description: "Find open TODO and DOING tasks, spot stale ones and suggest what to do next.",
        arguments: &[ArgumentDefinition { name: "focus", description: "Optional topic or project to narrow the tasks to", required: false }],
        build: build_prioritize_tasks,
    },
];

/// `prompts/list`.
pub fn list() -> Vec<Prompt> {
    DEFINITIONS
        .iter()
        .map(|definition| {
            let arguments = definition
                .arguments
                .iter()
                .map(|a| PromptArgument::new(a.name).with_description(a.description).with_required(a.required))
                .collect();
            Prompt::new(definition.name, Some(definition.description), Some(arguments)).with_title(definition.title)
        })
        .collect()
}

/// `prompts/get`. An unknown prompt, an unknown or missing argument, or a value that doesn't parse is an
/// `InvalidParams` error.
pub fn get(name: &str, arguments: Option<&JsonObject>, today: CalendarDate) -> Result<GetPromptResult, ErrorData> {
    let definition = DEFINITIONS.iter().find(|definition| definition.name == name).ok_or_else(|| {
        let available: Vec<&str> = DEFINITIONS.iter().map(|d| d.name).collect();
        invalid(&format!("Unknown prompt {}. Available: {}.", quoted(name), available.join(", ")))
    })?;
    let empty = JsonObject::new();
    let raw = arguments.unwrap_or(&empty);
    // Every value must be a string. The TypeScript SDK checks this before the prompt sees the request (and
    // answers -32603 with the zod issues); a malformed argument is `InvalidParams` here.
    let mut strings = Arguments::new();
    for (key, value) in raw {
        let Some(text) = value.as_str() else {
            return Err(invalid(&format!("Argument {} of prompt {} must be a string.", quoted(key), quoted(name))));
        };
        strings.insert(key.clone(), text.to_owned());
    }
    reject_unknown_arguments(definition, raw)?;
    let text = (definition.build)(&strings, today)?;
    Ok(GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)]).with_description(definition.description))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn date(year: i32, month: u32, day: u32) -> CalendarDate {
        CalendarDate { year, month, day }
    }

    /// Tuesday 2025-03-11, the harness's "today"
    const TUESDAY: CalendarDate = CalendarDate { year: 2025, month: 3, day: 11 };

    fn arguments(value: Value) -> JsonObject {
        value.as_object().unwrap().clone()
    }

    fn text_of(name: &str, args: Value, today: CalendarDate) -> Result<String, String> {
        match get(name, Some(&arguments(args)), today) {
            Ok(result) => Ok(serde_json::to_value(&result.messages[0]).unwrap()["content"]["text"].as_str().unwrap().to_owned()),
            Err(error) => Err(error.message.into_owned()),
        }
    }

    fn week(spec: Option<&str>, today: CalendarDate) -> Result<WeekRange, String> {
        resolve_week(spec, today).map_err(|error| error.message.into_owned())
    }

    fn month(spec: Option<&str>, today: CalendarDate) -> Result<MonthRange, String> {
        resolve_month(spec, today).map_err(|error| error.message.into_owned())
    }

    #[test]
    fn a_week_in_progress_ends_today_and_a_finished_one_on_friday() {
        let this = week(None, TUESDAY).unwrap();
        assert_eq!((this.monday.as_str(), this.start, this.end, this.end_iso.as_str(), this.partial), ("2025-03-10", 20250310, 20250311, "2025-03-11", true));
        let last = week(Some("last"), TUESDAY).unwrap();
        assert_eq!((last.monday.as_str(), last.start, last.end, last.partial), ("2025-03-03", 20250303, 20250307, false));
        // a Friday is a whole week, a Saturday and a Sunday belong to the week before them
        assert!(!week(None, date(2025, 3, 14)).unwrap().partial);
        assert_eq!(week(None, date(2025, 3, 15)).unwrap().end, 20250314);
        assert_eq!(week(None, date(2025, 3, 16)).unwrap().monday, "2025-03-10");
    }

    #[test]
    fn a_week_whose_monday_is_in_year_99_ends_on_the_calendars_friday() {
        // The Monday is 0099-12-28 and the calendar has Friday 0100-01-01.
        let week = week(Some("0100-01-01"), TUESDAY).unwrap();
        assert_eq!(
            (week.monday.as_str(), week.start, week.end_iso.as_str(), week.end, week.partial),
            ("0099-12-28", 991228, "0100-01-01", 1000101, false)
        );
    }

    #[test]
    fn a_week_is_named_by_any_of_its_days_in_either_spelling() {
        for spec in ["2025-03-05", "20250305", "2025-0305", "THIS", "Last"] {
            assert!(week(Some(spec), TUESDAY).is_ok(), "{spec}");
        }
        assert_eq!(week(Some("20250305"), TUESDAY).unwrap().monday, "2025-03-03");
        assert_eq!(week(Some("2025-03-02"), TUESDAY).unwrap().monday, "2025-02-24", "a Sunday is the end of the week before");
    }

    #[test]
    fn a_week_that_is_not_a_day_or_not_yet_is_invalid() {
        assert_eq!(
            week(Some("tomorrow"), TUESDAY).unwrap_err(),
            r#""week" must be "this", "last", or a date as YYYY-MM-DD or YYYYMMDD (any day in the week); got "tomorrow"."#
        );
        for bad in ["2025-02-30", "2025-13-01", "2025-00-10", "2025-03-00", "2025-3-5", "2025-03-051", "+2025-03-05"] {
            assert!(week(Some(bad), TUESDAY).unwrap_err().contains("must be \"this\""), "{bad}");
        }
        assert_eq!(week(Some("2025-03-31"), TUESDAY).unwrap_err(), "The week of 2025-03-31 has not started yet. Use \"this\", \"last\", or a date in a past or current week.");
        // a day later in the current week is not "not started"
        assert!(week(Some("2025-03-14"), TUESDAY).is_ok());
    }

    #[test]
    fn a_month_in_progress_ends_today() {
        let this = month(None, TUESDAY).unwrap();
        assert_eq!((this.month.as_str(), this.start, this.end, this.end_iso.as_str(), this.partial), ("2025-03", 20250301, 20250311, "2025-03-11", true));
        let last = month(Some("last"), TUESDAY).unwrap();
        assert_eq!((last.month.as_str(), last.start, last.end, last.partial), ("2025-02", 20250201, 20250228, false));
        assert_eq!(month(Some("last"), date(2025, 1, 5)).unwrap().month, "2024-12");
        assert_eq!(month(Some("2024-02"), TUESDAY).unwrap().end, 20240229);
        assert!(!month(None, date(2025, 3, 31)).unwrap().partial);
    }

    #[test]
    fn a_month_that_is_not_yyyy_mm_or_not_yet_is_invalid() {
        assert_eq!(month(Some("march"), TUESDAY).unwrap_err(), r#""month" must be "this", "last", or YYYY-MM; got "march"."#);
        for bad in ["2025-13", "2025-00", "2025-3", "2025-03-01", "202503"] {
            assert!(month(Some(bad), TUESDAY).unwrap_err().contains("must be \"this\""), "{bad}");
        }
        assert_eq!(month(Some("2025-04"), TUESDAY).unwrap_err(), "2025-04 has not started yet. Use \"this\", \"last\", or a past or current month.");
    }

    #[test]
    fn a_year_below_100_is_a_real_year() {
        // 0050-03-04 is a Friday: its week starts on Monday 0050-02-28 (year 50 is not a leap year)
        let old_week = week(Some("0050-03-04"), TUESDAY).unwrap();
        assert_eq!(
            (old_week.monday.as_str(), old_week.start, old_week.end_iso.as_str(), old_week.end, old_week.partial),
            ("0050-02-28", 500228, "0050-03-04", 500304, false)
        );
        let old = month(Some("0050-03"), TUESDAY).unwrap();
        assert_eq!((old.month.as_str(), old.start, old.end, old.end_iso.as_str()), ("0050-03", 500301, 500331, "0050-03-31"));
        // a three-digit year keeps its leading zero
        assert_eq!(week(Some("0500-03-04"), TUESDAY).unwrap().monday, "0500-03-01");
        assert_eq!(month(Some("0100-03"), TUESDAY).unwrap().month, "0100-03");
        // year 0 is a leap year; its first Monday is 0000-01-03
        assert_eq!(month(Some("0000-02"), TUESDAY).unwrap().end, 229);
        let zero = week(Some("0000-01-03"), TUESDAY).unwrap();
        assert_eq!((zero.monday.as_str(), zero.start, zero.end), ("0000-01-03", 103, 107));
    }

    #[test]
    fn a_week_that_starts_before_year_0_starts_on_0000_01_01() {
        // 0000-01-01 is a Saturday, so its week runs from a Monday in year -1 to a Friday in year -1; YYYYMMDD has no
        // such year, so the week is clamped to the first day it can hold
        for spec in ["0000-01-01", "0000-01-02"] {
            let clamped = week(Some(spec), TUESDAY).unwrap();
            assert_eq!(
                (clamped.monday.as_str(), clamped.start, clamped.end_iso.as_str(), clamped.end, clamped.partial),
                ("0000-01-01", 101, "0000-01-01", 101, false),
                "{spec}"
            );
        }
        // the Monday after it is a whole week of year 0
        assert_eq!(week(Some("0000-01-03"), TUESDAY).unwrap().monday, "0000-01-03");
    }

    #[test]
    fn a_prompt_needs_its_required_argument_and_names_the_ones_it_has() {
        assert_eq!(text_of("continue_on", json!({}), TUESDAY).unwrap_err(), r#"Prompt "continue_on" needs a non-empty "topic" argument."#);
        assert!(text_of("continue_on", json!({"topic": " \t "}), TUESDAY).unwrap_err().contains("needs a non-empty"));
        assert_eq!(
            text_of("continue_on", json!({"topic": "x", "tpoic": "y", "a": "b"}), TUESDAY).unwrap_err(),
            r#"Prompt "continue_on" has no argument "tpoic", "a". Arguments: topic."#
        );
        assert_eq!(
            text_of("nope", json!({}), TUESDAY).unwrap_err(),
            r#"Unknown prompt "nope". Available: weekly_summary, monthly_summary, continue_on, what_do_i_know, prioritize_tasks."#
        );
        assert_eq!(text_of("continue_on", json!({"topic": 5}), TUESDAY).unwrap_err(), r#"Argument "topic" of prompt "continue_on" must be a string."#);
    }

    #[test]
    fn an_unknown_argument_is_named_in_the_order_it_was_sent() {
        // a numeric-looking name is not moved ahead of the rest
        assert_eq!(
            text_of("prioritize_tasks", json!({"b": "x", "10": "y", "2": "z"}), TUESDAY).unwrap_err(),
            r#"Prompt "prioritize_tasks" has no argument "b", "10", "2". Arguments: focus."#
        );
    }

    #[test]
    fn a_proto_argument_is_an_argument_like_any_other() {
        let with = |args: &str| text_of("continue_on", serde_json::from_str(args).unwrap(), TUESDAY);
        assert_eq!(
            with(r#"{"topic": "atlas", "__proto__": "x"}"#).unwrap_err(),
            r#"Prompt "continue_on" has no argument "__proto__". Arguments: topic."#
        );
        assert_eq!(
            with(r#"{"__proto__": 5, "topic": "atlas"}"#).unwrap_err(),
            r#"Argument "__proto__" of prompt "continue_on" must be a string."#
        );
        assert_eq!(
            with(r#"{"topic": "atlas", "constructor": "z", "__proto__": "y"}"#).unwrap_err(),
            r#"Prompt "continue_on" has no argument "constructor", "__proto__". Arguments: topic."#
        );
    }

    #[test]
    fn a_topic_is_trimmed_quoted_and_capped_in_characters() {
        let text = text_of("continue_on", json!({"topic": "  say \"hi\"\n "}), TUESDAY).unwrap();
        assert!(text.starts_with(r#"Help me continue where I left off on "say \"hi\"" in my LogSeq graph."#), "{text}");
        assert!(text_of("continue_on", json!({"topic": "a".repeat(200)}), TUESDAY).is_ok());
        assert_eq!(
            text_of("continue_on", json!({"topic": "a".repeat(201)}), TUESDAY).unwrap_err(),
            "\"topic\" is 201 characters; the limit is 200. Use a page name or a short phrase."
        );
        // a rocket is one character, not two UTF-16 units
        assert!(text_of("continue_on", json!({"topic": "\u{1F680}".repeat(200)}), TUESDAY).is_ok());
        assert!(text_of("continue_on", json!({"topic": "\u{1F680}".repeat(201)}), TUESDAY).unwrap_err().contains("is 201 characters"));
        assert_eq!(
            text_of("prioritize_tasks", json!({"focus": "a".repeat(201)}), TUESDAY).unwrap_err(),
            "\"focus\" is 201 characters; the limit is 200."
        );
    }

    #[test]
    fn a_blank_optional_argument_is_absent() {
        let plain = text_of("prioritize_tasks", json!({}), TUESDAY).unwrap();
        assert_eq!(text_of("prioritize_tasks", json!({"focus": "  "}), TUESDAY).unwrap(), plain);
        assert!(!plain.contains("Only tasks related to"));
        let focused = text_of("prioritize_tasks", json!({"focus": "atlas"}), TUESDAY).unwrap();
        assert!(focused.contains(r#" Only tasks related to "atlas"."#) && focused.contains(r#"3. Keep only the tasks tied to "atlas""#));
    }

    #[test]
    fn the_list_is_the_five_prompts_with_their_arguments() {
        let listed = serde_json::to_value(list()).unwrap();
        let names: Vec<&str> = listed.as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["weekly_summary", "monthly_summary", "continue_on", "what_do_i_know", "prioritize_tasks"]);
        assert_eq!(listed[2]["arguments"], json!([{"name": "topic", "description": "Page name or short phrase, e.g. \"project atlas\"", "required": true}]));
    }

    #[test]
    fn every_prompt_names_only_tools_the_server_has() {
        let tools: Vec<String> = crate::tools::list().iter().map(|tool| tool.name.to_string()).collect();
        for definition in DEFINITIONS {
            let args = if definition.arguments.iter().any(|a| a.required) { json!({"topic": "atlas"}) } else { json!({}) };
            let text = text_of(definition.name, args, TUESDAY).unwrap();
            let mut named = 0;
            // "the logseq_* tools" is the one mention that isn't a tool's name
            for word in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).filter(|word| word.starts_with("logseq_") && *word != "logseq_") {
                assert!(tools.iter().any(|tool| tool == word), "{} names {word}", definition.name);
                named += 1;
            }
            assert!(named > 0, "{} names no tool", definition.name);
        }
    }
}
