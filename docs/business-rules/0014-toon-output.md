# TOON output carries the same data and never changes a default unannounced

## Statement

A tool may offer `format: "toon"` (Token-Oriented Object Notation) as a result format. A TOON result must carry exactly the data the JSON result carries: the same keys, values and key order (BR-0013), including `warnings`, `hasMore` and `meta`. It must never drop, round or reword anything. An error result stays JSON in every format.

A tool offers `toon` only where it is measured smaller than the JSON result in tokens. A tool's default format stays JSON until an explicit maintainer decision changes it for that tool, recorded as a Changelog row on this rule. Such a change moves every consumer that parses the old default (skills, integration helpers) in the same change, and carries a migration note (BR-0004).

## Rationale

JSON repeats every key on every row of a long uniform list, and the model reads and pays for each repeat. TOON writes the keys once, then one row per item, which is fewer tokens for flat lists. It gains little on nested block trees, so it is offered per tool and not everywhere. A format that silently changed data, or a default that silently changed shape, would break clients and skills that cannot see the server (BR-0004, ADR-0009). Proposed in #468. How the encoder is built is left to the implementing PR (#469).

## Mechanical enforcement

none-yet: #469 (adds a test that a TOON result equals the JSON result in data and key order, and that an omitted `format` returns the unchanged JSON)

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-09 | Introduced. | #468, #470 |
