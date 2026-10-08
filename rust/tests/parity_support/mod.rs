//! The parity test's parts (#371, #379): the cases, the stub LogSeq, the server process, the comparator and the
//! recorder. `rust/tests/parity.rs` runs them, `parity_self_check.rs` runs them against perturbed answers,
//! `parity_comparator.rs` and `parity_harness.rs` hold the parts to their own rules, and `parity_record.rs`
//! records the golden results.

#![allow(dead_code)] // each test file uses some of these

pub mod cases;
pub mod compare;
pub mod record;
pub mod server;
pub mod stub;
pub mod suggestion_rules;
