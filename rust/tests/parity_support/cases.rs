//! The parity cases, read from `tests/data/parity/*.json` (written by `scripts/export-parity.ts` from the
//! case files and golden results in `scripts/parity`, #371), and the perturbation the self-check applies.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

const REGENERATE: &str = "run: npx vite-node scripts/export-parity.ts";

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
    /// Steps run in order; the calls of one step are the ones the recorded server made at once, and are
    /// compared as a set
    pub steps: Vec<Vec<Canned>>,
    /// The answer for the last call in the self-check, in place of the suffixed strings
    pub perturbed: Option<Value>,
    pub request: Request,
    /// The golden result, recorded from the TypeScript server (`scripts/parity/expected`)
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

/// The exported fixtures' folder.
pub fn data_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("data").join("parity")
}

fn read_json(file: &Path) -> Value {
    let text = fs::read_to_string(file).unwrap_or_else(|e| panic!("{}: {e}\n{REGENERATE}", file.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not JSON: {e}\n{REGENERATE}", file.display()))
}

fn text_of<'a>(object: &'a Map<String, Value>, key: &str, case: &str) -> &'a str {
    object.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("case {case:?}: {key} is not a string\n{REGENERATE}"))
}

fn canned_of(call: &Value, case: &str) -> Canned {
    let call = call.as_object().unwrap_or_else(|| panic!("case {case:?}: a step holds a call that is not an object"));
    Canned {
        method: text_of(call, "method", case).to_owned(),
        args: call.get("args").and_then(Value::as_array).unwrap_or_else(|| panic!("case {case:?}: a call has no args")).clone(),
        response: call.get("response").unwrap_or_else(|| panic!("case {case:?}: a call has no response")).clone(),
    }
}

fn case_of(group: &str, value: &Value) -> Case {
    let object = value.as_object().expect("a case is an object");
    let name = text_of(object, "name", "?").to_owned();
    let steps = object
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
    Case {
        group: group.to_owned(),
        tool: text_of(object, "tool", &name).to_owned(),
        arguments: object.get("arguments").cloned().unwrap_or_else(|| json!({})),
        steps,
        perturbed: object.get("perturbed").cloned(),
        request,
        expected: object.get("expected").unwrap_or_else(|| panic!("case {name:?} has no golden result")).clone(),
        name,
    }
}

/// Every case of every group, in the order of the group files' names.
pub fn load_cases() -> Vec<Case> {
    let mut files: Vec<PathBuf> = fs::read_dir(data_dir())
        .unwrap_or_else(|e| panic!("{}: {e}\n{REGENERATE}", data_dir().display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter(|path| !matches!(path.file_stem().and_then(|s| s.to_str()), Some("tool-list" | "clock-cases")))
        .collect();
    files.sort();
    let mut cases = Vec::new();
    for file in files {
        let group = read_json(&file);
        let group_name = group["group"].as_str().expect("a group file names its group").to_owned();
        for case in group["cases"].as_array().expect("a group file holds its cases") {
            cases.push(case_of(&group_name, case));
        }
    }
    let mut names = HashSet::new();
    for case in &cases {
        assert!(names.insert(case.name.as_str()), "duplicate parity case name {:?}", case.name);
    }
    assert!(!cases.is_empty(), "no parity cases were read from {}", data_dir().display());
    cases
}

/// The recorded `tools/list`, in the projection `{ name, title, annotations, description, inputSchema }`.
pub fn load_tool_list() -> Vec<Value> {
    read_json(&data_dir().join("tool-list.json")).as_array().expect("the tool list is a list").clone()
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

/// One row of the table both comparators are held to (`tests/data/comparator-cases.json`): two results and
/// whether the comparator calls them the same.
#[derive(Debug)]
pub struct ComparatorRow {
    pub name: String,
    pub expected: Value,
    pub actual: Value,
    /// `true` for "same", `false` for "differs"
    pub same: bool,
}

/// The shared table. The Node harness's comparator is held to the same rows by
/// `tests/guards/comparator-table.test.ts`, so the two can't drift apart.
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
