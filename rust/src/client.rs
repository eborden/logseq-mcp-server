//! HTTP client for LogSeq's API (the Rust side of `src/client.ts` and the connection errors in
//! `src/errors.ts`). Every call is one `POST {apiUrl}/api` with a bearer token and its own timeout.

use std::fmt;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::config::Config;
use crate::edn::DatalogInput;

/// The per-call timeout when the config sets no `timeoutMs`, as in `src/client.ts`.
pub const DEFAULT_TIMEOUT_MS: f64 = 30000.0;

/// A LogSeq call failed. The first three are failures of the connection itself
/// ([`LogseqError::is_infrastructure`]) and must never be turned into "no data" (BR-0003).
/// No message includes the token (ADR-0003). The messages match `src/errors.ts` word for word,
/// except `NotRunning`'s `detail`, which is the HTTP library's own wording.
#[derive(Debug)]
pub enum LogseqError {
    /// Nothing answered at the API URL: LogSeq is closed or its API server is off.
    NotRunning { api_url: String, detail: String },
    /// LogSeq didn't answer within the timeout.
    Timeout { api_url: String, timeout_ms: f64 },
    /// LogSeq rejected the token (HTTP 401).
    Auth { api_url: String },
    /// Any other non-2xx status.
    Http { status: u16, status_text: String },
    /// LogSeq answered 200 with `{"error": ...}`, e.g. `MethodNotExist` for an unknown method.
    Api { message: String },
    /// The body was not JSON. Its text is not shown: it can hold graph data.
    InvalidBody { method: String },
    /// `timeoutMs` is too large to be a timeout. TypeScript fails each call too, with Node's
    /// own `RangeError` wording; this message is ours.
    TimeoutTooLarge { timeout_ms: f64 },
}

impl LogseqError {
    /// True for failures of the connection to LogSeq (not running, timeout, rejected token).
    pub fn is_infrastructure(&self) -> bool {
        matches!(self, LogseqError::NotRunning { .. } | LogseqError::Timeout { .. } | LogseqError::Auth { .. })
    }
}

impl fmt::Display for LogseqError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LogseqError::NotRunning { api_url, detail } => write!(
                f,
                "Cannot connect to LogSeq at {api_url}\n\nError: {detail}\n\n\
                 Steps to fix:\n\
                 1. Start LogSeq desktop application\n\
                 2. Enable HTTP API server: Settings → Advanced → Enable HTTP API server\n\
                 3. Verify API URL in ~/.logseq-mcp/config.json matches LogSeq's HTTP server port"
            ),
            LogseqError::Timeout { api_url, timeout_ms } => write!(
                f,
                "LogSeq at {api_url} did not respond within {timeout_ms}ms\n\n\
                 Steps to fix:\n\
                 1. Check that LogSeq is not busy (indexing, a stuck window or a very large graph)\n\
                 2. Retry the request\n\
                 3. To allow slower calls, raise \"timeoutMs\" in ~/.logseq-mcp/config.json (default 30000, per API call)"
            ),
            LogseqError::Auth { api_url } => write!(
                f,
                "LogSeq at {api_url} rejected the auth token (HTTP 401)\n\n\
                 Steps to fix:\n\
                 1. The token is invalid or has been changed. Regenerate it in LogSeq's API settings\n\
                 2. Update \"authToken\" in ~/.logseq-mcp/config.json\n\
                 3. See tests/integration/setup.md for details"
            ),
            LogseqError::Http { status, status_text } => write!(f, "HTTP {status}: {status_text}"),
            LogseqError::Api { message } => write!(f, "LogSeq API error: {message}"),
            LogseqError::InvalidBody { method } => {
                write!(f, "LogSeq answered {method} with a body that is not JSON")
            }
            LogseqError::TimeoutTooLarge { timeout_ms } => write!(
                f,
                "\"timeoutMs\" in ~/.logseq-mcp/config.json is too large to be a timeout ({timeout_ms}); use a smaller value (default 30000, per API call)"
            ),
        }
    }
}

impl std::error::Error for LogseqError {}

#[derive(Serialize)]
struct ApiRequest<'a> {
    method: &'a str,
    args: &'a [Value],
}

pub struct LogseqClient {
    http: reqwest::Client,
    api_url: String,
    auth_token: String,
    timeout_ms: f64,
    /// `None` when `timeout_ms` is too large for a `Duration` (it is positive and finite, so
    /// that is the only way it fails). Each call then fails with [`LogseqError::TimeoutTooLarge`]
    /// rather than panicking, as TypeScript's `AbortSignal.timeout` throws on every call.
    timeout: Option<Duration>,
}

impl LogseqClient {
    pub fn new(config: &Config) -> Self {
        let timeout_ms = config.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        LogseqClient {
            // No proxy, whatever HTTP_PROXY or ALL_PROXY say: a proxy would see the token and
            // every query and answer (ADR-0003, BR-0001). Node's fetch ignores them too.
            http: reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("a client with no TLS and no proxy always builds"),
            api_url: config.api_url.clone(),
            auth_token: config.auth_token.clone(),
            timeout_ms,
            timeout: Duration::try_from_secs_f64(timeout_ms / 1000.0).ok(),
        }
    }

    /// Call a LogSeq API method, e.g. `logseq.Editor.getBlock`. The response is returned as
    /// LogSeq sent it (it isn't wrapped); checking its shape is the caller's job.
    pub async fn call_api(&self, method: &str, args: &[Value]) -> Result<Value, LogseqError> {
        let timeout = self.timeout.ok_or(LogseqError::TimeoutTooLarge { timeout_ms: self.timeout_ms })?;
        // A fresh timeout per call: it bounds each request, not a whole tool run.
        let response = self
            .http
            .post(format!("{}/api", self.api_url))
            .bearer_auth(&self.auth_token)
            .json(&ApiRequest { method, args })
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| self.transport_error(error))?;

        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(LogseqError::Auth { api_url: self.api_url.clone() });
        }
        if !status.is_success() {
            return Err(LogseqError::Http {
                status: status.as_u16(),
                status_text: status.canonical_reason().unwrap_or("").to_owned(),
            });
        }

        let body = response.bytes().await.map_err(|error| self.transport_error(error))?;
        let data: Value =
            serde_json::from_slice(&body).map_err(|_| LogseqError::InvalidBody { method: method.to_owned() })?;

        // LogSeq reports a failed call (an unknown method, a bad query) as HTTP 200 with an
        // `error` key, so the body is always checked.
        if let Value::Object(map) = &data {
            if let Some(error) = map.get("error") {
                return Err(LogseqError::Api { message: js_string(error) });
            }
        }
        Ok(data)
    }

    /// Run a Datalog query via `logseq.DB.datascriptQuery`, with each input after the query
    /// string sent as EDN (ADR-0013; see [`DatalogInput`]).
    pub async fn execute_datalog_query(&self, query: &str, inputs: &[DatalogInput]) -> Result<Value, LogseqError> {
        let mut args = Vec::with_capacity(inputs.len() + 1);
        args.push(Value::from(query));
        args.extend(inputs.iter().map(|input| Value::from(input.to_edn())));
        self.call_api("logseq.DB.datascriptQuery", &args).await
    }

    fn transport_error(&self, error: reqwest::Error) -> LogseqError {
        if error.is_timeout() {
            LogseqError::Timeout { api_url: self.api_url.clone(), timeout_ms: self.timeout_ms }
        } else {
            // A refused or failed connection, or a body cut off mid-read. TypeScript maps the
            // same failures (fetch failed, ECONNREFUSED) to LogSeqNotRunningError.
            LogseqError::NotRunning { api_url: self.api_url.clone(), detail: error.to_string() }
        }
    }
}

/// What a JavaScript template literal makes of the `error` value, as in `${responseData.error}`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edn::{JournalDay, PageName};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const TOKEN: &str = "test-token-123";

    /// One request as the mock server saw it.
    struct Seen {
        head: String,
        body: Value,
    }

    /// Serves one canned response on a free local port and returns what it received.
    /// `None` accepts the connection and never answers, for the timeout test.
    async fn serve_once(response: Option<String>) -> (String, tokio::task::JoinHandle<Seen>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let (head, body) = loop {
                let mut chunk = [0u8; 4096];
                let n = socket.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length: ").map(str::to_owned))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if body.len() >= length {
                        break (head.to_owned(), body.to_owned());
                    }
                }
            };
            match response {
                Some(response) => socket.write_all(response.as_bytes()).await.unwrap(),
                None => tokio::time::sleep(Duration::from_secs(5)).await,
            }
            Seen { head, body: serde_json::from_str(&body).unwrap() }
        });
        (url, handle)
    }

    fn client(api_url: &str, timeout_ms: Option<f64>) -> LogseqClient {
        LogseqClient::new(&Config { api_url: api_url.into(), auth_token: TOKEN.into(), timeout_ms, tips: None })
    }

    fn ok(body: &str) -> Option<String> {
        Some(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ))
    }

    fn status(line: &str) -> Option<String> {
        Some(format!("HTTP/1.1 {line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"))
    }

    #[tokio::test]
    async fn posts_method_and_args_with_the_bearer_token() {
        let (url, server) = serve_once(ok(r#"{"name":"x"}"#)).await;
        let data = client(&url, None).call_api("logseq.App.getCurrentGraph", &[]).await.unwrap();
        assert_eq!(data, serde_json::json!({"name": "x"}));
        let seen = server.await.unwrap();
        assert!(seen.head.starts_with("POST /api HTTP/1.1"), "{}", seen.head);
        let head = seen.head.to_ascii_lowercase();
        assert!(head.contains(&format!("authorization: bearer {}", TOKEN.to_ascii_lowercase())));
        assert!(head.contains("content-type: application/json"));
        assert_eq!(seen.body, serde_json::json!({"method": "logseq.App.getCurrentGraph", "args": []}));
    }

    #[tokio::test]
    async fn sends_datalog_inputs_as_edn_after_the_query() {
        let (url, server) = serve_once(ok("[[1]]")).await;
        let inputs = [
            DatalogInput::PageName(PageName::new("My \"Page\"")),
            DatalogInput::JournalDay(JournalDay::parse(20250101_u32).unwrap()),
        ];
        let rows = client(&url, None).execute_datalog_query("[:find ?p :in $ ?n ?d]", &inputs).await.unwrap();
        assert_eq!(rows, serde_json::json!([[1]]));
        assert_eq!(
            server.await.unwrap().body,
            serde_json::json!({
                "method": "logseq.DB.datascriptQuery",
                "args": ["[:find ?p :in $ ?n ?d]", "\"my \\\"page\\\"\"", "20250101"]
            })
        );
    }

    #[tokio::test]
    async fn an_error_key_in_a_200_body_is_an_api_error() {
        let (url, _server) = serve_once(ok(r#"{"error":"MethodNotExist: logseq.Editor.nope"}"#)).await;
        let error = client(&url, None).call_api("logseq.Editor.nope", &[]).await.unwrap_err();
        assert!(matches!(error, LogseqError::Api { .. }));
        assert!(!error.is_infrastructure());
        assert_eq!(error.to_string(), "LogSeq API error: MethodNotExist: logseq.Editor.nope");
    }

    #[tokio::test]
    async fn a_401_is_an_auth_error_that_never_shows_the_token() {
        let (url, _server) = serve_once(status("401 Unauthorized")).await;
        let error = client(&url, None).call_api("logseq.App.getCurrentGraph", &[]).await.unwrap_err();
        assert!(matches!(error, LogseqError::Auth { .. }));
        assert!(error.is_infrastructure());
        let message = error.to_string();
        assert!(message.starts_with(&format!("LogSeq at {url} rejected the auth token (HTTP 401)")), "{message}");
        assert!(!message.contains(TOKEN));
    }

    #[tokio::test]
    async fn another_status_is_an_http_error() {
        let (url, _server) =
            serve_once(status("500 Internal Server Error")).await;
        let error = client(&url, None).call_api("logseq.App.getCurrentGraph", &[]).await.unwrap_err();
        assert!(!error.is_infrastructure());
        assert_eq!(error.to_string(), "HTTP 500: Internal Server Error");
    }

    #[tokio::test]
    async fn a_body_that_is_not_json_is_reported_without_its_text() {
        let (url, _server) = serve_once(ok("<html>alice</html>")).await;
        let error = client(&url, None).call_api("logseq.App.getCurrentGraph", &[]).await.unwrap_err();
        assert_eq!(error.to_string(), "LogSeq answered logseq.App.getCurrentGraph with a body that is not JSON");
    }

    #[tokio::test]
    async fn a_hung_call_times_out() {
        let (url, _server) = serve_once(None).await;
        let error = client(&url, Some(100.0)).call_api("logseq.App.getCurrentGraph", &[]).await.unwrap_err();
        assert!(matches!(error, LogseqError::Timeout { .. }), "{error:?}");
        assert!(error.is_infrastructure());
        assert!(error.to_string().starts_with(&format!("LogSeq at {url} did not respond within 100ms")));
    }

    #[tokio::test]
    async fn a_timeout_too_large_for_a_duration_fails_the_call_without_panicking() {
        // parse_config accepts any positive finite timeoutMs; 1e300 ms overflows a Duration.
        let error = client("http://127.0.0.1:1", Some(1e300)).call_api("logseq.App.getCurrentGraph", &[]).await.unwrap_err();
        assert!(matches!(error, LogseqError::TimeoutTooLarge { .. }), "{error:?}");
        assert!(!error.is_infrastructure());
        assert!(error.to_string().starts_with("\"timeoutMs\" in ~/.logseq-mcp/config.json is too large"));
    }

    #[tokio::test]
    async fn a_refused_connection_is_not_running() {
        // Bind to get a free port, then close it so nothing listens there.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let error = client(&url, None).call_api("logseq.App.getCurrentGraph", &[]).await.unwrap_err();
        assert!(matches!(error, LogseqError::NotRunning { .. }), "{error:?}");
        assert!(error.is_infrastructure());
        assert!(error.to_string().starts_with(&format!("Cannot connect to LogSeq at {url}")));
    }

    #[test]
    fn the_api_error_value_is_shown_as_javascript_would() {
        assert_eq!(js_string(&serde_json::json!("x")), "x");
        assert_eq!(js_string(&serde_json::json!(null)), "null");
        assert_eq!(js_string(&serde_json::json!(false)), "false");
        assert_eq!(js_string(&serde_json::json!(3)), "3");
        assert_eq!(js_string(&serde_json::json!(["a", null, 1])), "a,,1");
        assert_eq!(js_string(&serde_json::json!({"k": "v"})), "[object Object]");
    }
}
