# TOON output is opt-in and matches JSON

## Statement

`format: "toon"` is an opt-in result format. It carries the same data as the JSON result, in the same key order. The default stays JSON, and errors are always JSON.

## Rationale

TOON writes a list's keys once instead of on every row, so flat lists cost the model fewer tokens. Opt-in leaves the default untouched (BR-0004, ADR-0009). Proposed in #468.

## Mechanical enforcement

none-yet: #469 (adds a test that pins a fixed value's TOON output, so key order and crate upgrades are checked)

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-09 | Introduced. | #468 |
