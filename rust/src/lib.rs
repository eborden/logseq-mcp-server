//! Spike: the LogSeq MCP server in Rust, beside the TypeScript one (ADR-0025, #122).
//!
//! Stdout is the MCP stdio channel. Nothing in this crate prints to it; logs go to stderr
//! (ADR-0004), and `tests/no_stdout.rs` fails on a `print!`/`println!` or a direct stdout write.
//!
//! Layout: each tool and the code only it uses are in `tools/<tool>/`. What more than one tool
//! uses is here at the top level: the client, config and environment, the typed query values
//! (`edn`), the LogSeq reader (`wire`), the page resolver (`resolve`, BR-0010) with its own
//! queries and wire types, `fuzzy` (the resolver's suggestions), the errors, `ResultMeta`
//! (`meta`), tips, the JavaScript rules the output depends on (`js`) and the tool helpers (`tool`).

pub mod args;
pub mod block_tree;
pub mod client;
pub mod config;
pub mod edn;
pub mod entity;
pub mod env;
pub mod errors;
pub mod escape;
pub mod fuzzy;
pub mod js;
pub mod meta;
pub mod params;
pub mod resolve;
pub mod server;
pub mod slim;
pub mod tips;
pub mod tool;
pub mod tools;
pub mod truncation;
pub mod wire;
