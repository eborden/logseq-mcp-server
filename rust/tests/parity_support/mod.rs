//! The parity test's parts (#371): the cases, the stub LogSeq, the server process, and the comparator.
//! `rust/tests/parity.rs` runs them, and `parity_self_check.rs` runs them against perturbed answers.

#![allow(dead_code)] // each test file uses some of these

pub mod cases;
pub mod compare;
pub mod server;
pub mod stub;
pub mod suggestion_rules;
