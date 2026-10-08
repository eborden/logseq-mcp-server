use std::process::ExitCode;

use logseq_mcp_server::client::LogseqClient;
use logseq_mcp_server::config::load_config;
use logseq_mcp_server::env::Env;
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
    // ~/.logseq-mcp/config.json, or the file LOGSEQ_MCP_CONFIG names; LOGSEQ_MCP_TIPS checked too
    let env = Env::from_process()?;
    let config = load_config(env.config_path.as_path())?;
    // LOGSEQ_MCP_TIPS wins over the config file's `tips`; a bad value was rejected above
    let tips_enabled = env.tips.tips_enabled(config.tips);

    let server = LogseqServer::new(LogseqClient::new(&config), tips_enabled).with_clock(env.clock);
    let running = server.serve(rmcp::transport::stdio()).await?;
    eprintln!("LogSeq MCP server running on stdio");
    running.waiting().await?;
    Ok(())
}
