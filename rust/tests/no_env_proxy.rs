//! The client never goes through a proxy named in the environment: a proxy would see the bearer
//! token and every query and answer (ADR-0003, BR-0001). Its own test binary, because it sets
//! process-wide environment variables.

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::Config;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tokio::test]
async fn proxy_environment_variables_are_ignored() {
    // A proxy on a closed port: a call routed through it would fail to connect.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    // SAFETY: this binary has one test, so no other thread reads the environment meanwhile.
    unsafe {
        for key in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
            std::env::set_var(key, &proxy);
        }
        std::env::remove_var("NO_PROXY");
        std::env::remove_var("no_proxy");
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 8192];
        let n = socket.read(&mut buf).await.unwrap();
        let body = r#"{"ok":true}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or_default().to_owned()
    });

    let client = LogseqClient::new(&Config { api_url, auth_token: "t".into(), timeout_ms: Some(5000.0), tips: None });
    let data = client.call_api("logseq.App.getCurrentGraph", &[]).await.unwrap();
    assert_eq!(data, serde_json::json!({"ok": true}));
    // A direct request names the path; a proxied one would name the absolute URL.
    assert_eq!(server.await.unwrap(), "POST /api HTTP/1.1");
}
