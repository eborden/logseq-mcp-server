//! A mock LogSeq for the tests that count a tool's calls: a local port that answers each request
//! with the next canned body and records the requests. Every page and block a test sends it is made
//! up (BR-0001); it never listens on LogSeq's own port.

#![allow(dead_code)] // each test file uses some of these

use std::sync::{Arc, Mutex};

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct MockLogseq {
    pub api_url: String,
    pub seen: Arc<Mutex<Vec<Value>>>,
}

/// A LogSeq that answers request n with `answers[n]`. A request past the last answer finds no one
/// listening for it, which the client reports as LogSeq not running.
pub async fn mock_logseq(answers: Vec<Value>) -> MockLogseq {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);
    tokio::spawn(async move {
        for answer in answers {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let body = loop {
                let mut chunk = [0u8; 8192];
                let n = socket.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length: ").map(str::to_owned))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if body.len() >= length {
                        break body.to_owned();
                    }
                }
            };
            recorded.lock().unwrap().push(serde_json::from_str(&body).unwrap());
            let reply = answer.to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    MockLogseq { api_url, seen }
}

pub fn client(logseq: &MockLogseq) -> LogseqClient {
    LogseqClient::new(&Config { api_url: logseq.api_url.clone(), auth_token: "t".into(), timeout_ms: Some(5000.0), tips: None })
}

/// The method of each request so far, in order.
pub fn methods(logseq: &MockLogseq) -> Vec<String> {
    logseq.seen.lock().unwrap().iter().map(|call| call["method"].as_str().unwrap().to_owned()).collect()
}

/// The `args` of request `n`.
pub fn args_of(logseq: &MockLogseq, n: usize) -> Vec<Value> {
    logseq.seen.lock().unwrap()[n]["args"].as_array().unwrap().clone()
}

/// A block uuid made from a number.
pub fn uuid(n: i64) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

/// A block as the Editor API sends it: no `children` unless the test adds them.
pub fn editor_block(id: i64, content: &str) -> Value {
    json!({"id": id, "uuid": uuid(id), "content": content, "page": {"id": 100}})
}
