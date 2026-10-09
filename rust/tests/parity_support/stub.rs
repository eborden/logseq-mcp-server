//! A stand-in for LogSeq's HTTP API (#124): it replays canned answers keyed by the whole call (method, query text
//! without layout, and inputs), records every call it gets, and fails loud on any call it has no answer for.
//! It listens on 127.0.0.1 with a port the OS picks, never LogSeq's 12315, and checks a token made fresh for
//! each run, so a server pointed at it can't reach a real graph by mistake (BR-0001).

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::cases::Canned;

/// LogSeq's own port. The stub refuses to run on it (BR-0001).
pub const LOGSEQ_PORT: u16 = 12315;

pub const DATASCRIPT_QUERY: &str = "logseq.DB.datascriptQuery";

/// One call as the server sent it: the method and its args, as LogSeq's `/api` takes them.
#[derive(Debug, Clone)]
pub struct Call {
    pub method: String,
    pub args: Vec<Value>,
}

/// Collapse whitespace runs to one space. A query's indentation is how the source happens to lay it out,
/// not part of what LogSeq is asked, so it is not part of the contract.
pub fn normalize_query(query: &str) -> String {
    query.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A value as minified JSON, to compare what the server sent with what a case lists.
fn stringify(value: &Value) -> String {
    value.to_string()
}

/// A call as a failure message names it: the method, plus the query text for a Datalog query or the args for any
/// other method. The inputs of a query are not in it; `canonical` has them.
pub fn call_key(method: &str, args: &[Value]) -> String {
    match args.first() {
        Some(Value::String(query)) if method == DATASCRIPT_QUERY => format!("{method} {}", normalize_query(query)),
        _ => format!("{method} {}", stringify(&Value::Array(args.to_vec()))),
    }
}

/// A call in comparable form: the query text with its whitespace collapsed, the inputs as sent.
pub fn canonical(method: &str, args: &[Value]) -> String {
    let args = match args.first() {
        Some(Value::String(query)) if method == DATASCRIPT_QUERY => {
            let mut all = vec![Value::String(normalize_query(query))];
            all.extend_from_slice(&args[1..]);
            all
        }
        _ => args.to_vec(),
    };
    stringify(&Value::Array(vec![Value::String(method.to_owned()), Value::Array(args)]))
}

#[derive(Default)]
struct State {
    /// Answers left for each call, by its `canonical` form (method, query text without layout, inputs), used up in
    /// the order they were listed, so one call asked twice gets its two answers in the recorded order (ADR-0034
    /// Decision 5). A call whose canonical form is not here, or is used up, has no answer and is a failure
    pending: HashMap<String, VecDeque<Value>>,
    log: Vec<Call>,
    failures: Vec<String>,
    /// Requests received and not yet answered
    in_flight: usize,
    last_start: Option<Instant>,
}

pub struct Stub {
    pub api_url: String,
    pub auth_token: String,
    state: Arc<Mutex<State>>,
    stopping: Arc<AtomicBool>,
    address: SocketAddr,
}

impl Stub {
    /// Start a stub on a random local port.
    pub fn start() -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the stub");
        let address = listener.local_addr().unwrap();
        assert_ne!(address.port(), LOGSEQ_PORT, "the parity stub got LogSeq's own port; refusing to run there");
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let auth_token = format!("parity-{:x}-{nanos:x}", std::process::id());
        let state = Arc::new(Mutex::new(State::default()));
        let stopping = Arc::new(AtomicBool::new(false));
        {
            let (state, stopping, token) = (Arc::clone(&state), Arc::clone(&stopping), auth_token.clone());
            thread::spawn(move || {
                for stream in listener.incoming() {
                    if stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    let Ok(stream) = stream else { continue };
                    {
                        let mut state = state.lock().unwrap();
                        state.in_flight += 1;
                        state.last_start = Some(Instant::now());
                    }
                    let (state, token) = (Arc::clone(&state), token.clone());
                    thread::spawn(move || {
                        serve(stream, &state, &token);
                        state.lock().unwrap().in_flight -= 1;
                    });
                }
            });
        }
        Stub { api_url: format!("http://{address}"), auth_token, state, stopping, address }
    }

    /// Replace the canned answers and clear the call log and failures.
    pub fn load<'a>(&self, calls: impl IntoIterator<Item = &'a Canned>) {
        let mut state = self.state.lock().unwrap();
        state.pending.clear();
        for call in calls {
            state.pending.entry(canonical(&call.method, &call.args)).or_default().push_back(call.response.clone());
        }
        state.log.clear();
        state.failures.clear();
    }

    /// Every call since the last `load`, in the order the requests arrived.
    pub fn calls(&self) -> Vec<Call> {
        self.state.lock().unwrap().log.clone()
    }

    /// Calls the stub could not answer, wrong tokens and malformed requests since the last `load`.
    pub fn failures(&self) -> Vec<String> {
        self.state.lock().unwrap().failures.clone()
    }

    /// Wait for the calls a tool sent at the same moment as the one whose answer it acted on (#340). A tool
    /// that makes calls at once and fails on the first answer returns before the others reach the stub;
    /// reading the log then misses them, and they land in the next case's log. It returns when no request is
    /// being read or answered and either at least `expected` calls have arrived since the last `load`, or no
    /// request has started for 200 ms (a server that makes fewer calls than the case lists is a failure the
    /// comparison reports, so this is the cost of a miss). `max_ms` is a backstop for a server that keeps
    /// calling; 0 doesn't wait at all. Never fails.
    pub fn settle(&self, expected: usize, max_ms: u64) {
        const QUIET: Duration = Duration::from_millis(200);
        let began = Instant::now();
        loop {
            let now = Instant::now();
            {
                let state = self.state.lock().unwrap();
                let quiet = now.duration_since(state.last_start.map_or(began, |s| s.max(began))) >= QUIET;
                if (state.in_flight == 0 && (state.log.len() >= expected || quiet)) || now.duration_since(began).as_millis() as u64 >= max_ms {
                    return;
                }
            }
            thread::sleep(Duration::from_millis(2));
        }
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        // Wake the accept loop so its thread ends
        let _ = TcpStream::connect(self.address);
    }
}

/// The request's head (lowercased header lines) and body, read to its Content-Length.
fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<(String, String)>, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut request_line = lines.next()?.split(' ');
    let (method, path) = (request_line.next()?.to_owned(), request_line.next()?.to_owned());
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned())))
        .collect();
    let length = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse::<usize>().ok()).unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some((method, path, headers, body))
}

fn send(stream: &mut TcpStream, status: &str, body: &Value) {
    let text = body.to_string();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn serve(mut stream: TcpStream, state: &Mutex<State>, token: &str) {
    let fail = |message: String| state.lock().unwrap().failures.push(message);
    let Some((method, path, headers, body)) = read_request(&mut stream) else {
        fail("a request that could not be read".to_owned());
        return;
    };
    if method != "POST" || path != "/api" {
        fail(format!("unexpected request {method} {path}"));
        return send(&mut stream, "404 Not Found", &serde_json::json!({"error": "parity stub: only POST /api exists"}));
    }
    let authorized = headers.iter().any(|(k, v)| k == "authorization" && *v == format!("Bearer {token}"));
    if !authorized {
        fail("request with a wrong or missing auth token".to_owned());
        return send(&mut stream, "401 Unauthorized", &serde_json::json!({"error": "parity stub: bad token"}));
    }
    let parsed: Result<(String, Vec<Value>), String> = serde_json::from_slice::<Value>(&body).map_err(|e| e.to_string()).and_then(|value| {
        let method = value.get("method").and_then(Value::as_str).ok_or("no method or args")?.to_owned();
        let args = value.get("args").and_then(Value::as_array).ok_or("no method or args")?.clone();
        Ok((method, args))
    });
    let (call_method, args) = match parsed {
        Ok(call) => call,
        Err(error) => {
            fail(format!("malformed request body ({error})"));
            return send(&mut stream, "400 Bad Request", &serde_json::json!({"error": "parity stub: malformed body"}));
        }
    };
    let key = call_key(&call_method, &args);
    let wanted = canonical(&call_method, &args);
    let answer = {
        let mut state = state.lock().unwrap();
        state.log.push(Call { method: call_method, args: args.clone() });
        // Only a call that a recorded call answers is answered: its method, query text (layout aside) and every input
        // equal, and the next answer listed for it. A call with a changed input, or one more than were recorded, has
        // none and fails the case, whatever the server does with the error (ADR-0034 Decision 5)
        let answer = state.pending.get_mut(&wanted).and_then(VecDeque::pop_front);
        if answer.is_none() {
            let inputs = stringify(&Value::Array(args.iter().skip(1).cloned().collect()));
            state.failures.push(format!("no canned response for {key} (inputs {inputs})"));
        }
        answer
    };
    match answer {
        Some(answer) => send(&mut stream, "200 OK", &answer),
        // LogSeq answers an unknown method with HTTP 200 and an error body; the stub does the same
        None => send(&mut stream, "200 OK", &serde_json::json!({"error": "parity stub: no canned response for this call"})),
    }
}
