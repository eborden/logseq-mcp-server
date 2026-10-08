//! Run the server binary against the stub LogSeq and collect what it answers (#371): one process for every
//! case, MCP over stdio, the config pointed at the stub through a temporary `LOGSEQ_MCP_CONFIG`, the clock fixed.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use super::cases::{Case, Request};
use super::compare::{compare_calls, compare_results, compare_tool_lists};
use super::stub::Stub;
use super::suggestion_rules::{candidates_of, check_reference_lists, missing_required_cases};

/// The instant every server under test reads as "now" (`LOGSEQ_MCP_NOW`, milliseconds since 1970-01-01 UTC):
/// 2025-03-12T03:30:00Z, which is still the evening of Tuesday 2025-03-11 in [`PARITY_TZ`]. A result that
/// depends on today's date (`last_n`, a preset) is then the same on every day, and a server that reads the
/// date in UTC where the recorded one read it locally gets the 12th, not the 11th, and fails.
pub const PARITY_NOW_MS: i64 = 1_741_750_200_000;

/// The time zone every server under test runs in (`TZ`): one with daylight saving, and not UTC.
pub const PARITY_TZ: &str = "America/New_York";

/// The most to wait for the answer to one request.
pub const TIMEOUT: Duration = Duration::from_secs(30);

/// The server binary cargo built for this test.
pub fn server_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_logseq-mcp-server"))
}

/// A JSON-RPC error the server answered with, as the MCP SDK's client throws it.
#[derive(Debug)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

enum Failure {
    /// The server answered with a JSON-RPC error
    Rpc(RpcError),
    /// The client's own failure (a timeout, a closed pipe), which says nothing about the server's answer
    Transport(String),
}

/// The server process and the client end of its stdio.
pub struct Server {
    child: Option<Child>,
    stdin: Box<dyn Write + Send>,
    lines: Receiver<String>,
    next_id: i64,
    stderr: Arc<Mutex<String>>,
    timeout: Duration,
}

impl Server {
    /// The command that runs the server binary the way every run does: its config is the stub's, the clock and
    /// the time zone are fixed, and every home and config directory a server could look in for a fallback
    /// config (`~/.logseq-mcp/`) is the empty temp dir `home`, so a server that ignores the variable finds no
    /// config and can't reach a real LogSeq (BR-0001). Tips are left at their default.
    pub fn command(config_path: &Path, home: &Path, now_ms: i64) -> Command {
        let mut command = Command::new(server_binary());
        command
            .env_remove("LOGSEQ_MCP_TIPS")
            .env("LOGSEQ_MCP_CONFIG", config_path)
            .env("LOGSEQ_MCP_NOW", now_ms.to_string())
            .env("TZ", PARITY_TZ)
            .env("HOME", home)
            .env("USERPROFILE", home)
            .env("XDG_CONFIG_HOME", home.join(".config"));
        // macOS looks the home folder up by user, not $HOME, unless this is set (see scripts/logseq-instance)
        if cfg!(target_os = "macos") {
            command.env("CFFIXED_USER_HOME", home);
        }
        command
    }

    /// Start the server binary.
    pub fn start(config_path: &Path, home: &Path, now_ms: i64) -> Server {
        Server::spawn(Server::command(config_path, home, now_ms))
    }

    /// Start any command that speaks MCP over stdio.
    pub fn spawn(mut command: Command) -> Server {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().expect("start the server");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr: Box<dyn Read + Send> = Box::new(child.stderr.take().unwrap());
        Server::from_parts(Box::new(stdin), Box::new(stdout), Some(stderr), Some(child))
    }

    /// A server that is a pair of streams, for a stand-in a test runs in its own thread.
    pub fn from_streams(stdin: impl Write + Send + 'static, stdout: impl Read + Send + 'static) -> Server {
        Server::from_parts(Box::new(stdin), Box::new(stdout), None, None)
    }

    fn from_parts(stdin: Box<dyn Write + Send>, stdout: Box<dyn Read + Send>, stderr_pipe: Option<Box<dyn Read + Send>>, child: Option<Child>) -> Server {
        let (sender, lines) = channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                if sender.send(line).is_err() {
                    return;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        if let Some(pipe) = stderr_pipe {
            let sink = Arc::clone(&stderr);
            thread::spawn(move || {
                for line in BufReader::new(pipe).lines() {
                    let Ok(line) = line else { return };
                    let mut text = sink.lock().unwrap();
                    text.push_str(&line);
                    text.push('\n');
                }
            });
        }
        Server { child, stdin, lines, next_id: 0, stderr, timeout: TIMEOUT }
    }

    /// The most to wait for the answer to one request.
    pub fn with_timeout(mut self, timeout: Duration) -> Server {
        self.timeout = timeout;
        self
    }

    pub fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        writeln!(self.stdin, "{message}").and_then(|()| self.stdin.flush()).map_err(|e| format!("the server's stdin is closed: {e}"))
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        self.send(&json!({"jsonrpc": "2.0", "method": method}))
    }

    /// One request, and its result.
    fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value, Failure> {
        self.next_id += 1;
        let id = self.next_id;
        let mut message = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(params) = params {
            message["params"] = params;
        }
        self.send(&message).map_err(Failure::Transport)?;
        loop {
            let line = match self.lines.recv_timeout(self.timeout) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => return Err(Failure::Transport(format!("{method} timed out after {:?}", self.timeout))),
                Err(RecvTimeoutError::Disconnected) => return Err(Failure::Transport(format!("the server closed its output during {method}"))),
            };
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                return Err(Failure::Transport(format!("the server wrote a line that is not JSON: {line}")));
            };
            // A notification or a request from the server is not the answer
            if reply.get("id") != Some(&json!(id)) || reply.get("method").is_some() {
                continue;
            }
            if let Some(error) = reply.get("error") {
                let code = error.get("code").and_then(Value::as_i64).unwrap_or_default();
                let message = error.get("message").and_then(Value::as_str).unwrap_or_default();
                // The MCP SDK's client puts the code in front of the message
                return Err(Failure::Rpc(RpcError { code, message: format!("MCP error {code}: {message}"), data: error.get("data").cloned() }));
            }
            return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    pub fn initialize(&mut self) -> Result<(), String> {
        let params = json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "logseq-parity-test", "version": "1.0.0"}});
        match self.request("initialize", Some(params)) {
            Ok(_) => self.notify("notifications/initialized"),
            Err(Failure::Rpc(e)) => Err(e.message),
            Err(Failure::Transport(e)) => Err(e),
        }
    }

    /// `tools/list`, in the recorded projection: each tool's name, title, annotations, description and input schema.
    pub fn tool_list(&mut self) -> Result<Vec<Value>, String> {
        let result = self.request("tools/list", None).map_err(|f| match f {
            Failure::Rpc(e) => e.message,
            Failure::Transport(e) => e,
        })?;
        let tools = result.get("tools").and_then(Value::as_array).ok_or("tools/list has no tools")?;
        Ok(tools
            .iter()
            .map(|tool| {
                let mut projected = Map::new();
                projected.insert("name".to_owned(), tool["name"].clone());
                if let Some(title) = tool.get("annotations").and_then(|a| a.get("title")) {
                    projected.insert("title".to_owned(), title.clone());
                }
                for key in ["annotations", "description", "inputSchema"] {
                    if let Some(value) = tool.get(key) {
                        projected.insert(key.to_owned(), value.clone());
                    }
                }
                Value::Object(projected)
            })
            .collect())
    }

    /// One case's request. A JSON-RPC error is a result of the case for a prompt or a resource, as a tool's
    /// `isError` is; for a tool call or a listing it is a failure.
    pub fn run_case(&mut self, case: &Case) -> Result<Value, CaseError> {
        let (method, params, errors_are_results) = match &case.request {
            Request::ListResourceTemplates => ("resources/templates/list", None, false),
            Request::ListResources => ("resources/list", None, false),
            Request::ListPrompts => ("prompts/list", None, false),
            Request::GetPrompt { name, arguments } => {
                let mut params = json!({"name": name});
                if let Some(arguments) = arguments {
                    params["arguments"] = arguments.clone();
                }
                ("prompts/get", Some(params), true)
            }
            Request::ReadResource(uri) => ("resources/read", Some(json!({"uri": uri})), true),
            Request::Tool => ("tools/call", Some(json!({"name": case.tool, "arguments": case.arguments})), false),
        };
        match self.request(method, params) {
            Ok(result) => Ok(result),
            Err(Failure::Rpc(e)) if errors_are_results => {
                let mut error = json!({"code": e.code, "message": e.message});
                if let Some(data) = e.data {
                    error["data"] = data;
                }
                Ok(json!({"error": error}))
            }
            Err(Failure::Rpc(e)) => Err(CaseError { message: e.message, server_gone: false }),
            Err(Failure::Transport(e)) => Err(CaseError { message: e, server_gone: true }),
        }
    }
}

/// Why a case got no result.
#[derive(Debug)]
pub struct CaseError {
    pub message: String,
    /// The server stopped answering (a timeout, a closed pipe): the cases after it can't run either, so the run ends
    pub server_gone: bool,
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// What a run needs.
pub struct Run<'a> {
    /// The cases to run, perturbed or not; each carries its golden result
    pub cases: &'a [Case],
    /// The cases as committed, when `cases` are a perturbed copy: the closest names are judged against their
    /// candidates, not the perturbed ones
    pub unperturbed: &'a [Case],
    /// The recorded `tools/list` the server's is compared with
    pub expected_tool_list: &'a [Value],
    pub now_ms: i64,
    /// The most to wait, per case, for the LogSeq calls a tool made at once to reach the stub after its result came back
    pub settle_ms: u64,
    /// Collect what the server answers instead of comparing it with the golden results and the recorded tool
    /// list (the recorder, `record.rs`). The calls are still compared, so a recording is never made from a case
    /// whose LogSeq traffic is wrong.
    pub record: bool,
}

pub struct Report {
    /// Every difference, each beginning `[tool: case name]` when it belongs to a case
    pub failures: Vec<String>,
    /// The server's stderr, to explain a failure (everything the stub serves is synthetic)
    pub stderr: String,
    /// What the server answered for each case that got an answer, by case name
    pub results: HashMap<String, Value>,
    /// How many LogSeq calls the server made for each case that got an answer, by case name (the recorder lowers a
    /// case's ceiling to it)
    pub call_counts: HashMap<String, usize>,
    /// The server's `tools/list` in the recorded projection
    pub tool_list: Vec<Value>,
}

/// A fresh empty folder for the run, under the target directory cargo gives integration tests.
pub fn scratch_dir(label: &str) -> PathBuf {
    // The clock alone isn't unique: tests of one process run in threads, and a coarse clock gives two the same reading
    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("{label}-{}-{nanos:x}-{n}", std::process::id()));
    fs::create_dir_all(dir.join("home")).expect("create the scratch folder");
    dir
}

/// Run every case against one server process and report what differs from the golden results, the recorded
/// calls and the recorded tool list.
pub fn run_parity(run: &Run) -> Report {
    run_parity_with(run, &|config_path, home, now_ms| Server::start(config_path, home, now_ms))
}

/// [`run_parity`] with a server of the caller's making: it is given the config file the stub is written into,
/// the empty home and the clock.
pub fn run_parity_with(run: &Run, launch: &dyn Fn(&Path, &Path, i64) -> Server) -> Report {
    let mut failures = Vec::new();
    let mut results = HashMap::new();
    let mut call_counts = HashMap::new();
    let mut tool_list = Vec::new();
    let mut names = HashSet::new();
    for case in run.cases {
        assert!(names.insert(case.name.as_str()), "duplicate parity case name {:?}", case.name);
    }
    let judged: HashMap<&str, &Case> = run.unperturbed.iter().map(|c| (c.name.as_str(), c)).collect();

    let stub = Stub::start();
    let dir = scratch_dir("parity");
    let config_path = dir.join("config.json");
    fs::write(&config_path, json!({"apiUrl": stub.api_url, "authToken": stub.auth_token}).to_string()).unwrap();
    let mut server = launch(&config_path, &dir.join("home"), run.now_ms);
    stub.load([]);

    'run: {
        if let Err(error) = server.initialize() {
            failures.push(format!("harness: {error}"));
            break 'run;
        }
        match server.tool_list() {
            Ok(tools) => {
                if !run.record {
                    failures.extend(compare_tool_lists(run.expected_tool_list, &tools).into_iter().map(|f| format!("tools/list differs in meaning, {f}")));
                }
                tool_list = tools;
            }
            Err(error) => {
                failures.push(format!("harness: {error}"));
                break 'run;
            }
        }
        failures.extend(stub.failures().into_iter().map(|f| format!("startup: stub: {f}")));
        if !stub.calls().is_empty() {
            failures.push(format!("startup and tools/list made {} LogSeq call(s); expected none", stub.calls().len()));
        }

        for case in run.cases {
            stub.load(case.canned());
            let prefix = format!("[{}: {}]", case.tool, case.name);
            let result = match server.run_case(case) {
                Ok(result) => result,
                Err(error) => {
                    // The calls of this case aren't compared, so wait only for requests already in flight
                    stub.settle(0, run.settle_ms);
                    failures.push(format!("{prefix} the call failed: {}", error.message));
                    // A server that died or hung would otherwise cost every remaining case the wait, a mutant that does
                    // that included
                    if error.server_gone {
                        failures.push("harness: the server stopped answering, so the cases after this one were not run".to_owned());
                        break 'run;
                    }
                    continue;
                }
            };
            // A tool that fails on the first of several concurrent answers returns before the rest arrive (#340)
            stub.settle(case.call_count(), run.settle_ms);
            failures.extend(stub.failures().into_iter().map(|f| format!("{prefix} stub: {f}")));
            let made = stub.calls();
            failures.extend(compare_calls(&case.steps, case.ceiling, &made).into_iter().map(|f| format!("{prefix} LogSeq calls, {f}")));
            call_counts.insert(case.name.clone(), made.len());
            if !run.record {
                let candidates = candidates_of(judged.get(case.name.as_str()).copied().unwrap_or(case));
                failures.extend(compare_results(&case.expected, &result, &candidates).into_iter().map(|f| format!("{prefix} result {f}")));
            }
            results.insert(case.name.clone(), result);
        }
        // The reference is held to rules 3 to 6 when it is recorded, and the recorded set has to exercise them (ADR-0032).
        // A recording checks the results it is about to write, which `record.rs` does once the run is over.
        if !run.record {
            failures.extend(check_reference_lists(run.unperturbed));
            failures.extend(missing_required_cases(run.unperturbed));
        }
    }
    let stderr = server.stderr();
    drop(server);
    drop(stub);
    let _ = fs::remove_dir_all(&dir);
    Report { failures, stderr, results, call_counts, tool_list }
}
