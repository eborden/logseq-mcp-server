//! The parity cases, read from `tests/data/parity/*.json`, and the perturbation the self-check applies.
//!
//! Those files are the only source of the cases and of the golden results (#379): each group file holds its
//! cases, one per line, and each case holds its stub answers, its MCP request, its recorded calls (as `steps`) and
//! the golden result under `expected`. A case is added or edited by hand, and `PARITY_RECORD=1 cargo test --test
//! parity_record -- --nocapture` (`record.rs`) fills in or rewrites the `expected` of the cases whose result
//! changed in meaning. `tool-list.json` is the recorded `tools/list`, `clock-cases.json` lists the cases that
//! read today's date, and `call-ceilings.json` holds each case's call ceiling (ADR-0034 Decision 5), apart from
//! the call fixtures so that adding or rewriting a fixture can't raise it. None of the three is a group file.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

const RECORD: &str = "record it: PARITY_RECORD=1 cargo test --test parity_record -- --nocapture";

/// The files in the data folder that are not case groups.
pub const NOT_GROUPS: [&str; 3] = ["tool-list", "clock-cases", "call-ceilings"];

/// A LogSeq call the server should make, with the answer the stub gives.
#[derive(Debug, Clone)]
pub struct Canned {
    pub method: String,
    pub args: Vec<Value>,
    pub response: Value,
}

/// The one MCP request a case makes.
#[derive(Debug, Clone)]
pub enum Request {
    /// `tools/call` of the case's `tool`
    Tool,
    /// `resources/read`
    ReadResource(String),
    ListResourceTemplates,
    ListResources,
    ListPrompts,
    /// `prompts/get`: the name, and the arguments when the case sends some
    GetPrompt { name: String, arguments: Option<Value> },
}

/// One tool call (or other request) and the LogSeq traffic it should cause, with its golden result.
#[derive(Debug, Clone)]
pub struct Case {
    /// The case-group file it came from, for a message
    pub group: String,
    /// Unique across every group
    pub name: String,
    pub tool: String,
    pub arguments: Value,
    /// The recorded calls, as the retired server made them: steps in order, the calls of one step made at once.
    /// The grouping and the order are history (ADR-0034 Decision 5): the comparison reads them as the calls the
    /// stub can answer. The answers to one query are given in the order they are listed here.
    pub steps: Vec<Vec<Canned>>,
    /// The most LogSeq calls the server may make for this case (ADR-0011, ADR-0034 Decision 5). It is read from
    /// `call-ceilings.json`, never from the case, so a fixture added or rewritten can't raise it. For the
    /// recorder, a case with no entry yet has as many as it records calls.
    pub ceiling: usize,
    /// The answer for the last call in the self-check, in place of the suffixed strings
    pub perturbed: Option<Value>,
    pub request: Request,
    /// The golden result, recorded from the TypeScript server before it was retired. `Value::Null` for a case
    /// that has none yet, which only the recorder reads (`load_cases_for_recording`).
    pub expected: Value,
}

impl Case {
    /// Every call the stub should have an answer for, in step order.
    pub fn canned(&self) -> impl Iterator<Item = &Canned> {
        self.steps.iter().flatten()
    }

    pub fn call_count(&self) -> usize {
        self.canned().count()
    }
}

/// The data folder: the cases, their golden results, the recorded tool list and the clock list.
pub fn data_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("data").join("parity")
}

fn read_json(file: &Path) -> Value {
    let text = fs::read_to_string(file).unwrap_or_else(|e| panic!("{}: {e}\n{RECORD}", file.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not JSON: {e}\n{RECORD}", file.display()))
}

fn text_of<'a>(object: &'a Map<String, Value>, key: &str, case: &str) -> &'a str {
    object.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("case {case:?}: {key} is not a string\n{RECORD}"))
}

fn canned_of(call: &Value, case: &str) -> Canned {
    let call = call.as_object().unwrap_or_else(|| panic!("case {case:?}: a step holds a call that is not an object"));
    Canned {
        method: text_of(call, "method", case).to_owned(),
        args: call.get("args").and_then(Value::as_array).unwrap_or_else(|| panic!("case {case:?}: a call has no args")).clone(),
        response: call.get("response").unwrap_or_else(|| panic!("case {case:?}: a call has no response")).clone(),
    }
}

/// One case from its JSON object. A case with no `expected` panics unless `require_expected` is false, which
/// is for the recorder: a case new to the file has no golden result until it is recorded.
pub fn case_of(group: &str, value: &Value, require_expected: bool) -> Case {
    let object = value.as_object().expect("a case is an object");
    let name = text_of(object, "name", "?").to_owned();
    let steps: Vec<Vec<Canned>> = object
        .get("steps")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("case {name:?} has no steps"))
        .iter()
        .map(|step| step.as_array().unwrap_or_else(|| panic!("case {name:?}: a step is not a list")).iter().map(|call| canned_of(call, &name)).collect())
        .collect();
    // The order the harness decides in: a listing, a prompt, a resource, then the tool
    let flag = |key: &str| object.get(key).and_then(Value::as_bool) == Some(true);
    let request = if flag("listResourceTemplates") {
        Request::ListResourceTemplates
    } else if flag("listResources") {
        Request::ListResources
    } else if flag("listPrompts") {
        Request::ListPrompts
    } else if let Some(prompt) = object.get("getPrompt") {
        Request::GetPrompt {
            name: text_of(prompt.as_object().expect("getPrompt is an object"), "name", &name).to_owned(),
            arguments: prompt.get("arguments").cloned(),
        }
    } else if let Some(uri) = object.get("readResource").and_then(Value::as_str) {
        Request::ReadResource(uri.to_owned())
    } else {
        Request::Tool
    };
    let expected = match object.get("expected") {
        Some(expected) => expected.clone(),
        None if require_expected => panic!("case {name:?} has no golden result\n{RECORD}"),
        None => Value::Null,
    };
    let ceiling: usize = steps.iter().map(Vec::len).sum();
    Case {
        group: group.to_owned(),
        tool: text_of(object, "tool", &name).to_owned(),
        arguments: object.get("arguments").cloned().unwrap_or_else(|| json!({})),
        steps,
        ceiling,
        perturbed: object.get("perturbed").cloned(),
        request,
        expected,
        name,
    }
}

/// A group file as it is written: the group's name and its cases, each as the JSON object on its line.
#[derive(Debug, Clone)]
pub struct GroupFile {
    pub name: String,
    pub path: PathBuf,
    pub cases: Vec<Value>,
}

/// Every group file of a folder, in the order of the files' names. A group file names its group, and the name
/// is the file's stem.
pub fn group_files_in(dir: &Path) -> Vec<GroupFile> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}\n{RECORD}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter(|path| !path.file_stem().and_then(|s| s.to_str()).is_some_and(|stem| NOT_GROUPS.contains(&stem)))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let group = read_json(&path);
            let name = group["group"].as_str().unwrap_or_else(|| panic!("{} does not name its group", path.display())).to_owned();
            assert_eq!(
                Some(name.as_str()),
                path.file_stem().and_then(|s| s.to_str()),
                "{} names the group {name:?}, which is not its file's name",
                path.display()
            );
            let cases = group["cases"].as_array().unwrap_or_else(|| panic!("{} holds no list of cases", path.display())).clone();
            GroupFile { name, path, cases }
        })
        .collect()
}

/// Each case's call ceiling by case name: `call-ceilings.json` of a folder, an object of whole numbers. The file
/// may be absent only for the recorder (`record`), which then gives the cases their first ceilings.
pub fn load_ceilings_in(dir: &Path, record: bool) -> BTreeMap<String, usize> {
    let file = dir.join("call-ceilings.json");
    if record && !file.exists() {
        return BTreeMap::new();
    }
    let object = read_json(&file);
    let object = object.as_object().unwrap_or_else(|| panic!("{} is not an object of ceilings by case name", file.display()));
    object
        .iter()
        .map(|(name, ceiling)| {
            let ceiling = ceiling.as_u64().unwrap_or_else(|| panic!("the call ceiling of {name:?} is not a whole number: {ceiling}"));
            (name.clone(), usize::try_from(ceiling).expect("a ceiling fits a usize"))
        })
        .collect()
}

/// The text of `call-ceilings.json`: the ceilings by case name, sorted, one to a line.
pub fn render_ceilings(ceilings: &BTreeMap<String, usize>) -> String {
    format!("{}\n", serde_json::to_string_pretty(ceilings).expect("ceilings serialize"))
}

fn cases_in(dir: &Path, require_expected: bool) -> Vec<Case> {
    // The recorder (`require_expected` false) may meet a case with no ceiling and gives it one. A run may not: a
    // case without a ceiling, or a ceiling without a case, is a failure, so a ceiling can't be dropped or left behind
    let ceilings = load_ceilings_in(dir, !require_expected);
    let mut cases = Vec::new();
    for group in group_files_in(dir) {
        for case in &group.cases {
            let mut case = case_of(&group.name, case, require_expected);
            match ceilings.get(&case.name) {
                Some(ceiling) => case.ceiling = *ceiling,
                None if require_expected => panic!("case {:?} has no call ceiling in call-ceilings.json\n{RECORD}", case.name),
                None => {}
            }
            cases.push(case);
        }
    }
    let mut names = HashSet::new();
    for case in &cases {
        assert!(names.insert(case.name.as_str()), "duplicate parity case name {:?}", case.name);
    }
    if require_expected {
        let stale: Vec<&String> = ceilings.keys().filter(|name| !names.contains(name.as_str())).collect();
        assert!(stale.is_empty(), "call-ceilings.json holds a ceiling for case(s) that don't exist: {stale:?}");
    }
    assert!(!cases.is_empty(), "no parity cases were read from {}", dir.display());
    cases
}

/// Every case of every group, in the order of the group files' names.
pub fn load_cases() -> Vec<Case> {
    cases_in(&data_dir(), true)
}

/// The same for another folder (a test's copy of some of the files).
pub fn load_cases_in(dir: &Path) -> Vec<Case> {
    cases_in(dir, true)
}

/// The cases of a folder for the recorder: one with no golden result yet is allowed, and has `Value::Null`.
pub fn load_cases_for_recording(dir: &Path) -> Vec<Case> {
    cases_in(dir, false)
}

/// The recorded `tools/list`, in the projection `{ name, title, annotations, description, inputSchema }`.
pub fn load_tool_list() -> Vec<Value> {
    load_tool_list_in(&data_dir())
}

pub fn load_tool_list_in(dir: &Path) -> Vec<Value> {
    read_json(&dir.join("tool-list.json")).as_array().expect("the tool list is a list").clone()
}

/// The cases that read today's date: the release binary ignores the fixed clock, so they leave its run.
pub fn load_clock_cases() -> Vec<String> {
    read_json(&data_dir().join("clock-cases.json"))
        .as_array()
        .expect("the clock cases are a list")
        .iter()
        .map(|name| name.as_str().expect("a clock case is a name").to_owned())
        .collect()
}

/// The cases without the ones that read today's date. Fails when a listed name is no case, so a rename
/// can't leave one to match nothing.
pub fn without_clock_cases(cases: Vec<Case>, clock_cases: &[String]) -> Vec<Case> {
    let present: HashSet<&str> = cases.iter().map(|c| c.name.as_str()).collect();
    let missing: Vec<&String> = clock_cases.iter().filter(|name| !present.contains(name.as_str())).collect();
    assert!(missing.is_empty(), "clock-cases.json names case(s) that don't exist: {missing:?}");
    cases.into_iter().filter(|c| !clock_cases.contains(&c.name)).collect()
}

/// A copy of the cases with one answer changed: every string in the response of each case's last call
/// gets a suffix, and an answer with no string at all (`[]`, `null`) becomes a LogSeq error. For the
/// check that a changed fixture fails loud. A case with no calls is unchanged.
pub fn perturb_cases(cases: &[Case]) -> Vec<Case> {
    cases
        .iter()
        .map(|case| {
            let mut copy = case.clone();
            let perturbed = copy.perturbed.clone();
            if let Some(last) = copy.steps.last_mut().and_then(|step| step.last_mut()) {
                last.response = perturbed.unwrap_or_else(|| perturb_value(&last.response));
            }
            copy
        })
        .collect()
}

/// One answer with a suffix on every string, or a LogSeq error when it holds none.
pub fn perturb_value(value: &Value) -> Value {
    fn visit(value: &Value, changed: &mut bool) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(|v| visit(v, changed)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), visit(v, changed))).collect()),
            Value::String(s) => {
                *changed = true;
                Value::String(format!("{s} (perturbed)"))
            }
            other => other.clone(),
        }
    }
    let mut changed = false;
    let out = visit(value, &mut changed);
    if changed { out } else { json!({"error": "parity harness: perturbed answer"}) }
}

/// One row of the comparator's table (`tests/data/comparator-cases.json`): two results and whether the
/// comparator calls them the same.
#[derive(Debug)]
pub struct ComparatorRow {
    pub name: String,
    pub expected: Value,
    pub actual: Value,
    /// `true` for "same", `false` for "differs"
    pub same: bool,
}

/// The table of verdicts the comparator is held to.
pub fn load_comparator_table() -> Vec<ComparatorRow> {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("data").join("comparator-cases.json");
    read_json(&file)
        .as_array()
        .expect("the comparator table is a list")
        .iter()
        .map(|row| ComparatorRow {
            name: row["name"].as_str().expect("a row has a name").to_owned(),
            expected: row["expected"].clone(),
            actual: row["actual"].clone(),
            same: match row["verdict"].as_str() {
                Some("same") => true,
                Some("differs") => false,
                other => panic!("row {:?}: the verdict is {other:?}", row["name"]),
            },
        })
        .collect()
}
