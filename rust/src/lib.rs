//! Spike: the LogSeq MCP server in Rust, beside the TypeScript one (ADR-0025, #122).
//!
//! Stdout is the MCP stdio channel. Nothing in this crate prints to it; logs go to stderr
//! (ADR-0004), and `tests/no_stdout.rs` fails on a `print!`/`println!` or a direct stdout write.

pub mod client;
pub mod config;
pub mod edn;
pub mod env;
pub mod errors;
pub mod fuzzy;
pub mod js;
pub mod meta;
pub mod outline;
pub mod params;
pub mod queries;
pub mod resolve;
pub mod server;
pub mod tips;
pub mod wire;
