//! The parity test's own machinery (#379): the stub LogSeq, the server process and its environment, the way a
//! run waits for LogSeq calls that arrive late, what a perturbed case is, the data files the cases come from and
//! the list of cases that read today's date. `parity.rs` and `parity_self_check.rs` run the cases with these; this
//! file shows each part does what they rely on. The Node harness's tests held the same parts before it was
//! retired.
//!
//! The stand-in servers below run in a thread of this test and speak MCP over a pair of pipes
//! (`Server::from_streams`), so a run can be shown against a server that answers late, answers with an error,
//! stops answering or closes its output, which the real server never does.

mod parity_support;

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use parity_support::cases::{Canned, Case, Request, case_of, data_dir, group_files_in, load_cases, load_cases_in, load_ceilings_in, load_clock_cases, load_comparator_table, load_tool_list, perturb_cases, render_ceilings, without_clock_cases};
use parity_support::record::{render_group, render_tool_list};
use parity_support::server::{PARITY_NOW_MS, PARITY_TZ, Run, Server, run_parity, run_parity_with, scratch_dir};
use parity_support::stub::{DATASCRIPT_QUERY, LOGSEQ_PORT, Stub, call_key};
use serde_json::{Value, json};

// ---- an HTTP client for the stub

/// A POST to the stub's `/api`, as LogSeq's client sends it: the status, and the JSON body.
fn post_to(api_url: &str, token: &str, body: &Value) -> (u16, Value) {
    let address = api_url.strip_prefix("http://").expect("the stub speaks plain HTTP");
    let mut stream = TcpStream::connect(address).expect("connect to the stub");
    let body = body.to_string();
    write!(stream, "POST /api HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).expect("read the stub's answer");
    let status = reply.split(' ').nth(1).and_then(|s| s.parse().ok()).expect("a status line");
    let text = reply.split_once("\r\n\r\n").map_or("", |(_, text)| text);
    (status, serde_json::from_str(text).unwrap_or(Value::Null))
}

fn post(stub: &Stub, method: &str, args: &[Value]) -> (u16, Value) {
    post_to(&stub.api_url, &stub.auth_token, &json!({"method": method, "args": args}))
}

fn call(method: &str) -> Canned {
    Canned { method: method.to_owned(), args: vec![], response: Value::Null }
}

const EDITOR: [&str; 3] = ["logseq.Editor.getCurrentPage", "logseq.Editor.getCurrentBlock", "logseq.Editor.getSelectedBlocks"];

fn wait(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}

// ---- the stub LogSeq

#[test]
fn the_stub_answers_by_method_and_query_text_checks_the_token_and_fails_loud_on_an_unknown_call() {
    let stub = Stub::start();
    assert!(!stub.api_url.ends_with(&format!(":{LOGSEQ_PORT}")), "the stub is on LogSeq's own port");
    stub.load([&Canned { method: DATASCRIPT_QUERY.to_owned(), args: vec![json!("[:find ?a]"), json!("\"alice\"")], response: json!([[1]]) }]);

    // The query's layout is not part of what is asked
    let (status, known) = post(&stub, DATASCRIPT_QUERY, &[json!("[:find\n ?a]"), json!("\"alice\"")]);
    assert_eq!((status, known), (200, json!([[1]])));
    let (status, _) = post_to(&stub.api_url, "wrong", &json!({"method": DATASCRIPT_QUERY, "args": ["[:find ?a]"]}));
    assert_eq!(status, 401);
    let (status, unknown) = post(&stub, DATASCRIPT_QUERY, &[json!("[:find ?z]")]);
    assert_eq!(status, 200);
    assert!(unknown.get("error").is_some(), "{unknown}");

    assert_eq!(stub.calls().len(), 2);
    let failures = stub.failures();
    assert_eq!(failures.len(), 2, "{failures:?}");
    assert_eq!(failures[0], "request with a wrong or missing auth token");
    assert!(failures[1].contains("no canned response for logseq.DB.datascriptQuery [:find ?z]"), "{failures:?}");
}

#[test]
fn the_stub_answers_one_query_asked_twice_in_the_order_of_its_answers() {
    let stub = Stub::start();
    let answer = |n: i64| Canned { method: DATASCRIPT_QUERY.to_owned(), args: vec![json!("[:find ?a]"), json!("\"x\"")], response: json!([[n]]) };
    stub.load([&answer(1), &answer(2)]);
    assert_eq!(post(&stub, DATASCRIPT_QUERY, &[json!("[:find ?a]"), json!("\"x\"")]).1, json!([[1]]));
    assert_eq!(post(&stub, DATASCRIPT_QUERY, &[json!("[:find ?a]"), json!("\"x\"")]).1, json!([[2]]));
    assert_eq!(stub.failures(), Vec::<String>::new());
    // The third has no answer left
    post(&stub, DATASCRIPT_QUERY, &[json!("[:find ?a]"), json!("\"x\"")]);
    assert_eq!(stub.failures().len(), 1);
}

#[test]
fn the_stub_answers_only_a_call_a_recorded_call_answers_so_a_changed_input_fails_the_case() {
    let stub = Stub::start();
    let answer = |input: &str, n: i64| Canned { method: DATASCRIPT_QUERY.to_owned(), args: vec![json!("[:find ?a]"), json!(input)], response: json!([[n]]) };
    stub.load([&answer("\"x\"", 1), &answer("\"y\"", 2)]);
    // The same query with an input no recorded call has: no answer, whatever else is listed for the query
    let (status, unanswered) = post(&stub, DATASCRIPT_QUERY, &[json!("[:find ?a]"), json!("\"z\"")]);
    assert_eq!(status, 200);
    assert!(unanswered.get("error").is_some(), "{unanswered}");
    assert_eq!(stub.failures().len(), 1);
    assert!(stub.failures()[0].contains("no canned response for logseq.DB.datascriptQuery [:find ?a] (inputs [\"\\\"z\\\"\"])"), "{:?}", stub.failures());
    // Calls with recorded inputs are answered in either order, each by its own input
    assert_eq!(post(&stub, DATASCRIPT_QUERY, &[json!("[:find ?a]"), json!("\"y\"")]).1, json!([[2]]));
    assert_eq!(post(&stub, DATASCRIPT_QUERY, &[json!("[:find ?a]"), json!("\"x\"")]).1, json!([[1]]));
    assert_eq!(stub.failures().len(), 1);
    // Every call is logged, the unanswered one included
    assert_eq!(stub.calls().len(), 3);
}

#[test]
fn a_call_is_keyed_by_its_query_text_without_layout_and_other_methods_by_their_args() {
    assert_eq!(call_key(DATASCRIPT_QUERY, &[json!("[:find\n   ?a]"), json!("\"x\"")]), format!("{DATASCRIPT_QUERY} [:find ?a]"));
    assert_eq!(call_key("logseq.Editor.getPage", &[json!("alice")]), "logseq.Editor.getPage [\"alice\"]");
}

#[test]
fn the_stub_settles_once_every_call_of_a_step_has_arrived_though_the_first_answer_came_back_long_before() {
    // #340: a tool that fails on the first answer returns before its other concurrent calls reach the stub
    let stub = Stub::start();
    let canned: Vec<Canned> = EDITOR.iter().map(|m| call(m)).collect();
    stub.load(&canned);
    post(&stub, EDITOR[0], &[]);
    let settled = AtomicBool::new(false);
    thread::scope(|scope| {
        scope.spawn(|| {
            post(&stub, EDITOR[2], &[]);
        });
        scope.spawn(|| {
            wait(40);
            post(&stub, EDITOR[1], &[]);
        });
        let settling = scope.spawn(|| {
            stub.settle(3, 5000);
            settled.store(true, Ordering::SeqCst);
        });
        wait(15);
        assert!(!settled.load(Ordering::SeqCst), "the third call has not come yet");
        settling.join().unwrap();
    });
    let mut methods: Vec<String> = stub.calls().into_iter().map(|c| c.method).collect();
    methods.sort();
    let mut want: Vec<String> = EDITOR.iter().map(|m| (*m).to_owned()).collect();
    want.sort();
    assert_eq!(methods, want);
    assert_eq!(stub.failures(), Vec::<String>::new());
}

#[test]
fn the_stub_does_not_settle_while_a_request_is_still_being_read_even_when_the_listed_calls_have_all_come() {
    let stub = Stub::start();
    stub.load(&[call(EDITOR[0])]);
    post(&stub, EDITOR[0], &[]);
    // An extra call whose body is written slowly: the count is already reached, one request is mid-body
    let body = json!({"method": EDITOR[1], "args": []}).to_string();
    let address = stub.api_url.strip_prefix("http://").unwrap().to_owned();
    let mut stream = TcpStream::connect(&address).unwrap();
    write!(stream, "POST /api HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", stub.auth_token, body.len()).unwrap();
    stream.write_all(&body.as_bytes()[..5]).unwrap();
    stream.flush().unwrap();
    wait(20);
    let settled = AtomicBool::new(false);
    thread::scope(|scope| {
        let settling = scope.spawn(|| {
            stub.settle(1, 5000);
            settled.store(true, Ordering::SeqCst);
        });
        wait(60);
        assert!(!settled.load(Ordering::SeqCst), "one request is still being read");
        stream.write_all(&body.as_bytes()[5..]).unwrap();
        stream.flush().unwrap();
        settling.join().unwrap();
    });
    assert_eq!(stub.calls().iter().map(|c| c.method.as_str()).collect::<Vec<_>>(), [EDITOR[0], EDITOR[1]]);
}

#[test]
fn the_stub_gives_up_after_a_quiet_period_when_calls_never_come() {
    // A server that makes fewer calls than the case lists shows as a failed comparison, so the wait is a cost, not a hang
    let stub = Stub::start();
    stub.load([]);
    let started = Instant::now();
    stub.settle(2, 5000);
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(200), "{waited:?}");
    assert!(waited < Duration::from_millis(2000), "{waited:?}");
    assert!(stub.calls().is_empty());
}

#[test]
fn the_stub_waits_no_longer_than_the_maximum_for_a_server_that_keeps_calling_and_not_at_all_for_zero() {
    let stub = Stub::start();
    stub.load([]);
    let calling = AtomicBool::new(true);
    thread::scope(|scope| {
        let caller = scope.spawn(|| {
            while calling.load(Ordering::SeqCst) {
                post(&stub, "logseq.Editor.getCurrentPage", &[]);
                wait(10);
            }
        });
        let started = Instant::now();
        stub.settle(1000, 300);
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(300), "{waited:?}");
        assert!(waited < Duration::from_millis(1500), "{waited:?}");
        let again = Instant::now();
        stub.settle(1000, 0);
        assert!(again.elapsed() < Duration::from_millis(100), "{:?}", again.elapsed());
        calling.store(false, Ordering::SeqCst);
        caller.join().unwrap();
    });
}

// ---- stand-in servers

/// What a stand-in answers a request with.
enum Reply {
    Result(Value),
    Error { code: i64, message: String, data: Option<Value> },
    /// No answer at all
    Silent,
    /// Close the output and end
    Close,
}

/// A server in a thread of this test, over a pair of pipes. `handler` answers every request but the handshake.
fn stand_in(mut handler: impl FnMut(&str, &Value) -> Reply + Send + 'static) -> Server {
    let (requests, to_server) = std::io::pipe().unwrap();
    let (from_server, mut answers) = std::io::pipe().unwrap();
    thread::spawn(move || {
        for line in BufReader::new(requests).lines() {
            let Ok(line) = line else { return };
            let request: Value = serde_json::from_str(&line).expect("the client sends JSON");
            let (Some(id), Some(method)) = (request.get("id"), request["method"].as_str()) else { continue };
            let reply = match method {
                "initialize" => Reply::Result(json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "stand-in", "version": "1.0.0"}})),
                _ => handler(method, &request["params"]),
            };
            let message = match reply {
                Reply::Result(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                Reply::Error { code, message, data } => {
                    let mut error = json!({"code": code, "message": message});
                    if let Some(data) = data {
                        error["data"] = data;
                    }
                    json!({"jsonrpc": "2.0", "id": id, "error": error})
                }
                Reply::Silent => continue,
                Reply::Close => return,
            };
            if writeln!(answers, "{message}").and_then(|()| answers.flush()).is_err() {
                return;
            }
        }
    });
    Server::from_streams(to_server, from_server)
}

fn plain_case(name: &str, tool: &str, request: Request) -> Case {
    Case { group: "g".into(), name: name.into(), tool: tool.into(), arguments: json!({}), steps: vec![], ceiling: 0, perturbed: None, request, expected: Value::Null }
}

#[test]
fn a_json_rpc_error_on_a_resource_or_prompt_is_the_result_of_the_case() {
    let mut server = stand_in(|_, _| Reply::Error { code: -32002, message: "No page".into(), data: Some(json!({"uri": "x"})) });
    server.initialize().unwrap();
    let read = plain_case("n", "t", Request::ReadResource("logseq://page/x".into()));
    assert_eq!(server.run_case(&read).unwrap(), json!({"error": {"code": -32002, "message": "MCP error -32002: No page", "data": {"uri": "x"}}}));
    let prompt = plain_case("n", "t", Request::GetPrompt { name: "x".into(), arguments: Some(json!({"a": "b"})) });
    assert_eq!(server.run_case(&prompt).unwrap(), json!({"error": {"code": -32002, "message": "MCP error -32002: No page", "data": {"uri": "x"}}}));
}

#[test]
fn a_json_rpc_error_on_a_tool_call_or_a_listing_is_a_failure_of_the_case_and_the_run_goes_on() {
    let mut server = stand_in(|_, _| Reply::Error { code: -32602, message: "bad".into(), data: None });
    server.initialize().unwrap();
    for request in [Request::Tool, Request::ListPrompts, Request::ListResources, Request::ListResourceTemplates] {
        let error = server.run_case(&plain_case("n", "t", request)).unwrap_err();
        assert_eq!((error.message.as_str(), error.server_gone), ("MCP error -32602: bad", false));
    }
}

#[test]
fn the_clients_own_timeout_or_closed_connection_is_not_a_result_and_ends_the_run() {
    // Neither says anything about the server's answer, so neither is recorded as one
    let mut quiet = stand_in(|method, _| if method == "tools/list" { Reply::Result(json!({"tools": []})) } else { Reply::Silent }).with_timeout(Duration::from_millis(200));
    quiet.initialize().unwrap();
    let timed_out = quiet.run_case(&plain_case("n", "t", Request::ReadResource("logseq://page/x".into()))).unwrap_err();
    assert!(timed_out.server_gone && timed_out.message.contains("timed out"), "{timed_out:?}");

    let mut closing = stand_in(|_, _| Reply::Close);
    closing.initialize().unwrap();
    let closed = closing.run_case(&plain_case("n", "t", Request::ReadResource("logseq://page/x".into()))).unwrap_err();
    assert!(closed.server_gone && closed.message.contains("closed its output"), "{closed:?}");
}

#[test]
fn a_run_ends_at_the_case_after_which_the_server_stopped_answering() {
    let cases = vec![plain_case("first", "t", Request::Tool), plain_case("second", "t", Request::Tool)];
    let run = Run { cases: &cases, unperturbed: &cases, expected_tool_list: &[], now_ms: PARITY_NOW_MS, settle_ms: 0, record: true };
    let report = run_parity_with(&run, &|_, _, _| {
        stand_in(|method, _| if method == "tools/list" { Reply::Result(json!({"tools": []})) } else { Reply::Close }).with_timeout(Duration::from_millis(500))
    });
    assert!(report.failures.iter().any(|f| f.starts_with("[t: first] the call failed")), "{:?}", report.failures);
    assert!(report.failures.iter().any(|f| f.contains("the cases after this one were not run")), "{:?}", report.failures);
    assert!(!report.failures.iter().any(|f| f.starts_with("[t: second]")), "{:?}", report.failures);
}

/// A server with one tool, `late_calls`, that makes three LogSeq Editor calls as `get_current_context` does and
/// returns its result as soon as the first answer is in. The other two are sent 50 ms later, so they reach the
/// stub after the result. It is the case a run has to wait for before it reads the stub's call log (#340).
fn late_calls_server(config_path: &Path) -> Server {
    let config: Value = serde_json::from_str(&fs::read_to_string(config_path).unwrap()).unwrap();
    let (api_url, token) = (config["apiUrl"].as_str().unwrap().to_owned(), config["authToken"].as_str().unwrap().to_owned());
    stand_in(move |method, _| match method {
        "tools/list" => Reply::Result(json!({"tools": [{"name": "late_calls", "inputSchema": {"type": "object"}}]})),
        "tools/call" => {
            post_to(&api_url, &token, &json!({"method": EDITOR[0], "args": []}));
            let (api_url, token) = (api_url.clone(), token.clone());
            thread::spawn(move || {
                wait(50);
                for method in &EDITOR[1..] {
                    post_to(&api_url, &token, &json!({"method": method, "args": []}));
                }
            });
            Reply::Result(json!({"content": [{"type": "text", "text": "returned before the other calls were sent"}]}))
        }
        other => panic!("the stand-in was asked for {other}"),
    })
}

fn late_case(name: &str) -> Case {
    Case { steps: vec![EDITOR.iter().map(|m| Canned { method: (*m).to_owned(), args: vec![], response: Value::Null }).collect()], ceiling: EDITOR.len(), ..plain_case(name, "late_calls", Request::Tool) }
}

#[test]
fn a_run_sees_all_three_calls_of_each_case_because_it_waits_for_them_before_it_reads_the_log() {
    let cases = vec![late_case("late calls"), late_case("late calls again")];
    let run = Run { cases: &cases, unperturbed: &cases, expected_tool_list: &[], now_ms: PARITY_NOW_MS, settle_ms: 2000, record: true };
    let report = run_parity_with(&run, &|config, _, _| late_calls_server(config));
    assert_eq!(report.failures, Vec::<String>::new());
    assert_eq!(report.call_counts["late calls"], 3);
    assert_eq!(report.call_counts["late calls again"], 3);
}

#[test]
fn without_the_wait_the_calls_come_after_the_result_and_the_next_case_would_find_them() {
    let cases = vec![late_case("late calls"), late_case("late calls again")];
    let run = Run { cases: &cases, unperturbed: &cases, expected_tool_list: &[], now_ms: PARITY_NOW_MS, settle_ms: 0, record: true };
    let report = run_parity_with(&run, &|config, _, _| late_calls_server(config));
    // Fewer calls than a case lists pass the comparison, so the count the run read is what shows the wait matters
    assert!(report.call_counts["late calls"] < 3, "{:?}", report.call_counts);
}

// ---- the server's environment

fn env_of(command: &std::process::Command) -> HashMap<String, Option<String>> {
    command.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect()
}

#[test]
fn the_server_gets_a_sandboxed_home_so_one_that_ignores_the_config_variable_finds_no_fallback() {
    let dir = scratch_dir("parity");
    let home = dir.join("home");
    let config = dir.join("config.json");
    let env = env_of(&Server::command(&config, &home, PARITY_NOW_MS));
    let text = |key: &str| env.get(key).unwrap_or_else(|| panic!("{key} is not set")).clone();
    assert_eq!(text("LOGSEQ_MCP_CONFIG"), Some(config.to_string_lossy().into_owned()));
    assert_eq!(text("HOME"), Some(home.to_string_lossy().into_owned()));
    assert_ne!(text("HOME"), std::env::var("HOME").ok(), "the server's home is the caller's");
    assert!(home.is_dir() && home.starts_with(env!("CARGO_TARGET_TMPDIR")), "{home:?} is not an empty folder under the target directory");
    assert_eq!(fs::read_dir(&home).unwrap().count(), 0, "the home is not empty");
    assert_eq!(text("USERPROFILE"), text("HOME"));
    assert_eq!(text("XDG_CONFIG_HOME"), Some(home.join(".config").to_string_lossy().into_owned()));
    // macOS looks the home folder up by user, not $HOME, unless this is set
    if cfg!(target_os = "macos") {
        assert_eq!(text("CFFIXED_USER_HOME"), text("HOME"));
    } else {
        assert!(!env.contains_key("CFFIXED_USER_HOME"));
    }
    // Tips are left at their default, whatever the caller had set
    assert_eq!(text("LOGSEQ_MCP_TIPS"), None);
    let _ = fs::remove_dir_all(&dir);
}

/// The calendar day of a count of days since 1970-01-01 (proleptic Gregorian).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let day = doe - (365 * yoe + yoe / 4 - yoe / 100) + 1;
    let mp = (5 * (doe - (365 * yoe + yoe / 4 - yoe / 100)) + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

#[test]
fn the_clock_and_the_zone_are_fixed_so_a_result_that_depends_on_today_is_the_same_on_every_day() {
    let dir = scratch_dir("parity");
    let env = env_of(&Server::command(&dir.join("config.json"), &dir.join("home"), PARITY_NOW_MS));
    assert_eq!(env["LOGSEQ_MCP_NOW"], Some(PARITY_NOW_MS.to_string()));
    assert_eq!(env["TZ"], Some(PARITY_TZ.to_owned()));
    // 03:30 UTC on the 12th is 23:30 on the 11th in New York (daylight saving began on the 9th, so it is UTC-4)
    let (seconds, day) = (PARITY_NOW_MS.div_euclid(1000), 86_400);
    assert_eq!(seconds.rem_euclid(day), 3 * 3600 + 30 * 60);
    assert_eq!(civil_from_days(seconds.div_euclid(day)), (2025, 3, 12));
    let in_new_york = seconds - 4 * 3600;
    assert_eq!((civil_from_days(in_new_york.div_euclid(day)), in_new_york.rem_euclid(day)), ((2025, 3, 11), 23 * 3600 + 30 * 60));
    assert_eq!(PARITY_TZ, "America/New_York");
    let _ = fs::remove_dir_all(&dir);
}

// ---- a perturbed case

fn call_with(response: Value) -> Canned {
    Canned { method: "logseq.Editor.getAllPages".into(), args: vec![], response }
}

fn two_calls() -> Case {
    Case { steps: vec![vec![call_with(json!([{"name": "first"}]))], vec![call_with(json!([{"name": "second"}]))]], ..plain_case("two calls", "logseq_list_pages", Request::Tool) }
}

fn last_answer(case: &Case) -> &Value {
    &case.steps.last().unwrap().last().unwrap().response
}

#[test]
fn a_perturbed_case_has_the_strings_of_its_last_call_suffixed_and_nothing_else_changed() {
    let original = two_calls();
    let perturbed = perturb_cases(std::slice::from_ref(&original));
    assert_eq!(last_answer(&perturbed[0]), &json!([{"name": "second (perturbed)"}]));
    assert_eq!(perturbed[0].steps[0][0].response, json!([{"name": "first"}]));
    assert_eq!(last_answer(&original), &json!([{"name": "second"}]));
}

#[test]
fn an_answer_with_no_string_becomes_a_logseq_error_and_a_case_with_no_calls_is_unchanged() {
    let no_strings = Case { steps: vec![vec![call_with(json!([]))]], ..two_calls() };
    let no_calls = Case { steps: vec![], ..two_calls() };
    let perturbed = perturb_cases(&[no_strings, no_calls]);
    assert_eq!(last_answer(&perturbed[0]), &json!({"error": "parity harness: perturbed answer"}));
    assert!(perturbed[1].steps.is_empty());
}

#[test]
fn the_last_call_gets_the_answer_a_case_names_as_perturbed_whatever_it_is_and_no_other_call() {
    for answer in [json!([]), json!(null), json!(0), json!(""), json!(false), json!({"rows": 1})] {
        let case = Case { perturbed: Some(answer.clone()), ..two_calls() };
        let perturbed = perturb_cases(&[case]);
        assert_eq!(last_answer(&perturbed[0]), &answer);
        assert_eq!(perturbed[0].steps[0][0].response, json!([{"name": "first"}]));
    }
}

#[test]
fn a_case_names_its_perturbed_answer_by_the_key_in_the_data_and_a_missing_key_is_no_answer() {
    let raw = |extra: Value| {
        let mut case = json!({"name": "n", "tool": "t", "arguments": {}, "steps": [[{"method": "logseq.Editor.getAllPages", "args": [], "response": [{"name": "x"}]}]]});
        if let Some(extra) = extra.as_object() {
            case.as_object_mut().unwrap().extend(extra.clone());
        }
        case_of("g", &case, false)
    };
    assert!(raw(json!({})).perturbed.is_none());
    // A null answer is an answer: the key is there
    assert_eq!(raw(json!({"perturbed": null})).perturbed, Some(Value::Null));
    assert_eq!(last_answer(&perturb_cases(&[raw(json!({"perturbed": null}))])[0]), &Value::Null);
    assert_eq!(last_answer(&perturb_cases(&[raw(json!({}))])[0]), &json!([{"name": "x (perturbed)"}]));
}

// ---- the data the cases come from

#[test]
fn the_data_folder_holds_group_files_the_tool_list_the_clock_list_and_the_call_ceilings_and_nothing_else() {
    let mut names: Vec<String> = fs::read_dir(data_dir()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let groups = group_files_in(&data_dir());
    let mut want: Vec<String> = groups.iter().map(|g| format!("{}.json", g.name)).collect();
    want.extend(["tool-list.json".to_owned(), "clock-cases.json".to_owned(), "call-ceilings.json".to_owned()]);
    want.sort();
    assert_eq!(names, want);
}

#[test]
fn every_case_has_a_golden_result_and_a_name_no_other_case_has() {
    let cases = load_cases();
    assert!(cases.len() > 900, "only {} cases", cases.len());
    let mut names: Vec<&str> = cases.iter().map(|c| c.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), cases.len(), "two cases share a name");
    for case in &cases {
        assert!(case.expected.is_object(), "{}: the golden result is {}", case.name, case.expected);
    }
}

#[test]
fn the_data_files_are_in_the_form_the_recorder_writes() {
    // So a re-record's diff is the change, and not the form of the file
    for group in group_files_in(&data_dir()) {
        let text = fs::read_to_string(&group.path).unwrap();
        assert!(text == render_group(&group.name, &group.cases), "{} is not in the recorder's form: record it, or write the file as `render_group` does", group.path.display());
    }
    let tools = data_dir().join("tool-list.json");
    assert!(fs::read_to_string(&tools).unwrap() == render_tool_list(&load_tool_list()), "tool-list.json is not in the recorder's form");
    let clock = data_dir().join("clock-cases.json");
    let names: Value = serde_json::from_str(&fs::read_to_string(&clock).unwrap()).unwrap();
    assert!(fs::read_to_string(&clock).unwrap() == format!("{}\n", serde_json::to_string_pretty(&names).unwrap()), "clock-cases.json is not indented by two spaces");
    let ceilings = data_dir().join("call-ceilings.json");
    assert!(fs::read_to_string(&ceilings).unwrap() == render_ceilings(&load_ceilings_in(&data_dir(), false)), "call-ceilings.json is not in the recorder's form: sorted by case name, one to a line");
}

#[test]
fn every_case_has_a_call_ceiling_no_higher_than_its_recorded_calls_and_none_is_left_without_a_case() {
    let cases = load_cases();
    for case in &cases {
        // A ceiling is the most calls the server may make: a case can't make more calls than it records answers for,
        // so one above the recorded count is slack that was never earned
        assert!(case.ceiling <= case.call_count(), "{}: the ceiling {} is above the {} recorded calls", case.name, case.ceiling, case.call_count());
    }
    assert!(cases.iter().any(|case| case.ceiling > 0), "no case makes a call");
    // A ceiling with no case, and a case with no ceiling, are failures of the load
    let dir = scratch_dir("ceilings");
    let group = &group_files_in(&data_dir())[0];
    fs::write(dir.join(format!("{}.json", group.name)), fs::read_to_string(&group.path).unwrap()).unwrap();
    let mut all = load_ceilings_in(&data_dir(), false);
    all.retain(|name, _| group.cases.iter().any(|c| c["name"] == name.as_str()));
    fs::write(dir.join("call-ceilings.json"), render_ceilings(&all)).unwrap();
    assert_eq!(load_cases_in(&dir).len(), group.cases.len());
    let first = group.cases[0]["name"].as_str().unwrap().to_owned();
    let mut without = all.clone();
    without.remove(&first);
    fs::write(dir.join("call-ceilings.json"), render_ceilings(&without)).unwrap();
    let panicked = std::panic::catch_unwind(|| load_cases_in(&dir)).unwrap_err();
    let message = panicked.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(message.contains("has no call ceiling") && message.contains(&first), "{message}");
    let mut stale = all;
    stale.insert("a case that is not there".to_owned(), 1);
    fs::write(dir.join("call-ceilings.json"), render_ceilings(&stale)).unwrap();
    let panicked = std::panic::catch_unwind(|| load_cases_in(&dir)).unwrap_err();
    let message = panicked.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(message.contains("ceiling for case(s) that don't exist") && message.contains("a case that is not there"), "{message}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_comparator_table_has_rows_of_both_verdicts_with_unique_names() {
    let table = load_comparator_table();
    assert!(table.iter().any(|row| row.same) && table.iter().any(|row| !row.same));
    let mut names: Vec<&str> = table.iter().map(|row| row.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), table.len());
}

// ---- the cases that read today's date

fn named(names: &[&str]) -> Vec<Case> {
    names.iter().map(|n| plain_case(n, "t", Request::Tool)).collect()
}

fn names_of(cases: &[Case]) -> Vec<&str> {
    cases.iter().map(|c| c.name.as_str()).collect()
}

#[test]
fn the_cases_that_read_today_leave_a_run_and_the_rest_keep_their_order() {
    let cases = named(&["a", "b", "c"]);
    assert_eq!(names_of(&without_clock_cases(cases.clone(), &["b".to_owned()])), ["a", "c"]);
    assert_eq!(names_of(&without_clock_cases(cases, &[])), ["a", "b", "c"]);
}

#[test]
#[should_panic(expected = "names case(s) that don't exist: [\"gone\"]")]
fn a_listed_name_that_no_case_has_is_refused_so_a_rename_cannot_leave_a_stale_one() {
    without_clock_cases(named(&["a"]), &["a".to_owned(), "gone".to_owned()]);
}

#[test]
fn the_clock_list_names_only_real_cases_and_none_twice() {
    let clock = load_clock_cases();
    let all = load_cases();
    assert!(!clock.is_empty());
    assert_eq!(without_clock_cases(all.clone(), &clock).len(), all.len() - clock.len());
    let mut sorted = clock.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), clock.len(), "a case is listed twice");
}

/// 2026-07-12T03:30:00Z, 16 months on: a case that reads only the month or the year changes at this instant.
const MONTHS_ON_MS: i64 = 1_783_827_000_000;

#[cfg(debug_assertions)]
#[test]
fn the_clock_list_names_exactly_the_cases_whose_result_moves_with_the_clock() {
    // The server run at two instants other than the recorded one: a week on, and 16 months on, so a case that
    // reads only the week and one that reads only the month or the year each change. A case that reads the date but
    // is not listed would fail the release run on main, which no pull request runs; a listed case that does not
    // would be left out of it for nothing. (A release build ignores the clock, so this runs in the debug build.)
    let cases = load_cases();
    let tools = load_tool_list();
    let clock = load_clock_cases();
    let mut moved = std::collections::BTreeSet::new();
    for now_ms in [PARITY_NOW_MS + 7 * 24 * 3600 * 1000, MONTHS_ON_MS] {
        let report = run_parity(&Run { cases: &cases, unperturbed: &cases, expected_tool_list: &tools, now_ms, settle_ms: 2000, record: false });
        let of_case = |failure: &str, case: &Case| failure.starts_with(&format!("[{}: {}]", case.tool, case.name));
        let unexplained: Vec<&String> = report.failures.iter().filter(|f| !cases.iter().any(|c| of_case(f, c))).collect();
        assert!(unexplained.is_empty(), "{unexplained:?}\n{}", report.stderr);
        for case in &cases {
            if report.failures.iter().any(|f| of_case(f, case)) {
                moved.insert(case.name.clone());
            }
        }
    }
    let mut listed = clock;
    listed.sort();
    assert_eq!(moved.into_iter().collect::<Vec<_>>(), listed);
}

// ---- a run against the Rust server

fn case_named(cases: &[Case], name: &str) -> Case {
    cases.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no case {name:?}")).clone()
}

fn failures_of(failures: &[String], case: &Case) -> Vec<String> {
    failures.iter().filter(|f| f.starts_with(&format!("[{}: {}]", case.tool, case.name))).cloned().collect()
}

#[test]
fn a_case_fails_on_its_perturbed_answer_only_when_that_answer_changes_what_the_server_prints() {
    let cases = load_cases();
    let exact = case_named(&cases, "exact name, blocks out of order with children");
    let tools = load_tool_list();
    let run = |perturbed: Value| {
        let case = Case { perturbed: Some(perturbed), ..exact.clone() };
        let perturbed_cases = perturb_cases(&[case]);
        let report = run_parity(&Run { cases: &perturbed_cases, unperturbed: std::slice::from_ref(&exact), expected_tool_list: &tools, now_ms: PARITY_NOW_MS, settle_ms: 2000, record: false });
        failures_of(&report.failures, &exact)
    };
    // the committed answer prints the committed result: the self-check would say NOT CAUGHT
    assert_eq!(run(last_answer(&exact).clone()), Vec::<String>::new());
    // another answer prints another result: caught
    assert!(!run(json!([])).is_empty());
}

#[test]
fn a_run_fails_loud_on_a_perturbed_answer_a_call_with_no_recorded_answer_and_a_changed_tool_list() {
    let all = load_cases();
    let outline: Vec<Case> = all.iter().filter(|c| c.group == "get-page-outline").cloned().collect();
    // A reference in which one bound and one enum value differ from what the server lists
    let mut tools = load_tool_list();
    let edit = |tools: &mut Vec<Value>, name: &str, change: &dyn Fn(&mut Value)| change(&mut tools.iter_mut().find(|t| t["name"] == name).unwrap()["inputSchema"]);
    edit(&mut tools, "logseq_check_links", &|s| s["properties"]["before"]["maxLength"] = json!(40000));
    edit(&mut tools, "logseq_get_block", &|s| s["properties"]["format"]["enum"] = json!(["json", "html"]));

    let with_calls: Vec<Case> = outline.iter().filter(|c| !c.steps.is_empty()).cloned().collect();
    let exact = outline[0].clone();
    let changed = vec![
        // The outline query's answer taken away: the stub has nothing to say to it
        Case { name: "missing answer".into(), steps: vec![exact.steps[0].clone(), vec![]], ..exact.clone() },
    ];
    let broken: Vec<Case> = perturb_cases(&with_calls).into_iter().chain(changed.clone()).collect();
    // The closest names are judged against the cases as committed, as the self-check does
    let judged: Vec<Case> = with_calls.iter().cloned().chain(changed.clone()).collect();
    let report = run_parity(&Run { cases: &broken, unperturbed: &judged, expected_tool_list: &tools, now_ms: PARITY_NOW_MS, settle_ms: 2000, record: false });

    // The server is held to the recorded list by meaning
    assert!(report.failures.iter().any(|f| f == "tools/list differs in meaning, logseq_check_links.inputSchema.properties.before.maxLength: expected 40000, got 50000"), "{:?}", report.failures);
    assert!(report.failures.iter().any(|f| f == "tools/list differs in meaning, logseq_get_block.inputSchema.properties.format.enum[1]: expected \"html\", got \"markdown\""), "{:?}", report.failures);
    for case in &with_calls {
        assert!(!failures_of(&report.failures, case).is_empty(), "{}: a perturbed answer went unnoticed", case.name);
    }
    let missing = failures_of(&report.failures, &changed[0]);
    assert!(missing.iter().any(|f| f.contains("stub: no canned response")), "{:?}", report.failures);
    assert!(missing.iter().any(|f| f.contains("LogSeq calls, the server made a call no recorded call answers")), "{:?}", report.failures);
}

#[test]
fn a_run_judges_the_calls_by_what_they_ask_and_how_many_there_are_not_by_their_order_grouping_or_all_being_made() {
    let all = load_cases();
    let leaf = all.iter().find(|c| c.group == "get-page-outline" && c.steps.len() == 3).expect("a case with three steps").clone();
    let never_made = Canned { method: "logseq.Editor.getPage".into(), args: vec![json!("a page the server never asks for")], response: Value::Null };
    let insert = Canned { method: "logseq.Editor.insertBlock".into(), args: vec![json!("page"), json!("text")], response: Value::Null };
    let cases = vec![
        // The calls listed in another order and another grouping: still the calls the server makes
        Case { name: "reordered".into(), steps: vec![leaf.steps[0].clone(), leaf.steps[2].clone(), leaf.steps[1].clone()], ..leaf.clone() },
        Case { name: "regrouped".into(), steps: vec![leaf.steps.iter().flatten().cloned().collect()], ..leaf.clone() },
        // A recorded call the server never makes, and a ceiling below the recorded count
        Case { name: "a call never made".into(), steps: vec![leaf.steps.iter().flatten().cloned().chain([never_made]).collect()], ..leaf.clone() },
        // The server makes more calls than the ceiling allows, each one recorded
        Case { name: "over the ceiling".into(), ceiling: leaf.call_count() - 1, ..leaf.clone() },
        // A ceiling one above the calls the server makes: a saved call has to lower it
        Case { name: "headroom".into(), ceiling: leaf.call_count() + 1, ..leaf.clone() },
        // A recorded write
        Case { name: "a recorded write".into(), steps: vec![leaf.steps.iter().flatten().cloned().chain([insert]).collect()], ..leaf.clone() },
    ];
    let report = run_parity(&Run { cases: &cases, unperturbed: &cases, expected_tool_list: &load_tool_list(), now_ms: PARITY_NOW_MS, settle_ms: 2000, record: false });
    let of = |name: &str| failures_of(&report.failures, &case_named(&cases, name));
    assert_eq!(of("reordered"), Vec::<String>::new());
    assert_eq!(of("regrouped"), Vec::<String>::new());
    assert_eq!(of("a call never made"), Vec::<String>::new());
    let over = of("over the ceiling");
    assert_eq!(over.len(), 1, "{over:?}");
    assert!(over[0].contains(&format!("the server made {} call(s), over the case's ceiling of {}", leaf.call_count(), leaf.call_count() - 1)), "{over:?}");
    let headroom = of("headroom");
    assert_eq!(headroom.len(), 1, "{headroom:?}");
    assert!(headroom[0].contains(&format!("the server made {} call(s), under the case's ceiling of {}: lower it with PARITY_RECORD=1", leaf.call_count(), leaf.call_count() + 1)), "{headroom:?}");
    let write = of("a recorded write");
    assert!(write.iter().any(|f| f.contains("is not a read (BR-0002)")), "{write:?}");
    assert_eq!(report.call_counts["reordered"], leaf.call_count());
}

#[test]
fn a_perturbed_run_is_judged_by_the_candidates_as_committed_so_a_list_that_reads_the_fixture_is_caught() {
    let all = load_cases();
    let prefix_hit = case_named(&all, "suggestions: a prefix hit");
    let tools = load_tool_list();
    let perturbed = perturb_cases(std::slice::from_ref(&prefix_hit));
    let judged_by = |unperturbed: &[Case]| {
        let report = run_parity(&Run { cases: &perturbed, unperturbed, expected_tool_list: &tools, now_ms: PARITY_NOW_MS, settle_ms: 2000, record: false });
        failures_of(&report.failures, &prefix_hit).join("\n")
    };
    // the perturbed names are candidates of the perturbed case, so by its own candidates the list passes
    assert_eq!(judged_by(&perturbed), "");
    // by the committed candidates, "Project Zed (perturbed)" is not a page
    assert!(judged_by(std::slice::from_ref(&prefix_hit)).contains("rule 3"));
}
