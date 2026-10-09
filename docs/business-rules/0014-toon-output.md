# TOON output is opt-in and matches JSON

## Statement

`format: "toon"` is an opt-in result format. It carries the same data as the JSON result, in the same key order. The default stays JSON, and errors are always JSON.

## Rationale

TOON writes a list's keys once instead of on every row, so flat lists cost the model fewer tokens. Opt-in leaves the default untouched (BR-0004, ADR-0009). Proposed in #468.

## Mechanical enforcement

test: `rust/src/toon.rs` (a fixed value encodes to a pinned TOON text, so key order, `null`, empty arrays and crate upgrades are checked)

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-09 | Introduced. | #468, #472 |
| 2026-10-09 | Enforcement: a unit test pins a fixed value's TOON output (additive; the `none-yet` line it replaces is the one for #469). | #474 |
