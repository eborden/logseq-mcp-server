use std::path::PathBuf;
use std::process::ExitCode;

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::{CONFIG_PATH_ENV, load_config, resolve_config_path};
use logseq_mcp_server::server::LogseqServer;
use rmcp::ServiceExt;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // Display, not Debug: the messages are written to be read and never hold the token.
            eprintln!("Failed to start server: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    // ~/.logseq-mcp/config.json, or the file LOGSEQ_MCP_CONFIG names
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let config_path = resolve_config_path(std::env::var(CONFIG_PATH_ENV).ok().as_deref(), &home)?;
    let config = load_config(&config_path)?;

    let server = LogseqServer::new(LogseqClient::new(&config));
    let running = server.serve(rmcp::transport::stdio()).await?;
    eprintln!("LogSeq MCP server running on stdio");
    running.waiting().await?;
    Ok(())
}
