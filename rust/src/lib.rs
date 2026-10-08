//! Spike: the LogSeq MCP server in Rust, beside the TypeScript one (ADR-0025, #122).
//!
//! Stdout is the MCP stdio channel. Nothing in this crate prints to it; logs go to stderr
//! (ADR-0004), and `tests/no_stdout.rs` fails on a `print!`/`println!` or a direct stdout write.

pub mod config;
