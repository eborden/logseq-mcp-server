//! The plan and the ratchet for `cargo-mutants` runs on the server crate (ADR-0033, #364).
//!
//! Nothing here runs a mutant. The workflows (`.github/workflows/rust-mutation.yml` and `rust-mutation-full.yml`) run the tool
//! and call this package's binary before and after: `plan` decides what a pull request's run measures, `full-plan` what a slice
//! of a full run does, and `report` reads what the tool wrote. The logic is in the library and each rule is a unit test.
//!
//! This package is not part of the server's dependency tree and the server's jobs don't build it. It lives under `rust/` but
//! outside `rust/src`, so the one `rust/**` path filter of the PR workflow covers the code that gates.

pub mod baseline;
pub mod diff;
pub mod exit;
pub mod gather;
pub mod limits;
pub mod listing;
pub mod outcomes;
pub mod plan;
pub mod regions;
pub mod report;
pub mod run;
pub mod score;
pub mod slices;
