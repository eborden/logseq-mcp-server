#!/usr/bin/env bash
# Prepares a Claude cloud agent's fresh container to build and test this repo. Idempotent: safe to re-run.
# It installs what CI's `tooling` and `cargo` jobs need (the pinned Rust toolchain, the crate's dependencies, the
# Node dev dependencies) and nothing else. The cloud has no LogSeq desktop app, so the integration tests, the probe
# and the measure scripts can't run there (CLAUDE.md, "Cloud agents").
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# rust-toolchain.toml pins the compiler. rustup installs the pinned channel on first use, so force it here, once,
# instead of in the middle of the agent's first `cargo` call.
if ! command -v rustup >/dev/null 2>&1; then
  echo "cloud-setup: rustup is missing; install it from https://rustup.rs and re-run" >&2
  exit 1
fi
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install
rustc --version >&2

# Fetch the crate's dependencies from the lockfile so later builds don't stall on the network. --locked fails if
# Cargo.lock is out of date rather than rewriting it.
cargo fetch --locked

# The dev tooling: guard tests, type-check, scripts. `npm ci` installs from the lockfile and deletes node_modules
# first, so skip it when the install already matches.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund
fi

echo "cloud-setup: ready" >&2
