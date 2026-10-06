# Explore a Rust implementation alongside TypeScript, and re-scope the process docs per toolchain

## Context

The maintainer wants a self-contained binary with a lower startup time and memory footprint than the Node server, and a stricter type system. Node single-executable builds are fragile, and the footprint of a Node process is the part that stays. Bun and Deno `compile` also produce a single binary. We did not trial them (inferred, not recorded: they keep a JavaScript runtime, so the footprint argument holds for them too). Request latency is not a driver: a tool call makes a handful of LogSeq API calls (1 to 5 in the measured table) and almost all the time is LogSeq running the query (see "Current Implementation Status" in `CLAUDE.md`).

Go and Rust were both considered. Go's small language and fast compiler suit agents. Rust's type system can make more illegal states unrepresentable, which suits the parse-at-the-boundary principle (ADR-0019 (parse-input-at-boundary)). The maintainer ranks correctness above compile speed and expects to review little of the code the agents write. That makes the safety net the tests, not a human reading the diff, and favours Rust.

A rewrite would also strand the process docs. Several ADRs, `docs/architecture-foundations.md` and `CLAUDE.md` name TypeScript mechanisms (zod, vitest, `tsc`, npm). Accepted ADRs are immutable, and a Rust implementation doesn't reverse them, so superseding them one by one would be the wrong tool. Most of their decisions are about the tool contract, LogSeq's behaviour and how we work, and hold for any implementation. Only some are about TypeScript.

Tracked in #122.

## Decision

1. **We explore a Rust implementation beside the TypeScript one.** Both live in this repo and the TypeScript server stays the shipped one. A spike (#123 to #126) ports one representative tool, `logseq_get_page_outline` (it needs the shared page resolver, a bound Datalog query, a capped result and sibling ordering, in 2 API calls), measures startup and footprint, and evaluates the official Rust MCP SDK. A go/no-go decision (#127) follows. A "no-go" marks this ADR `deprecated`. A "go" leaves it accepted and opens the port.
2. **The TypeScript tool contract is the specification.** Until TypeScript is retired, the Rust server must emit the same `tools/list` (the ADR-0016 snapshot) and identical results for the same stubbed LogSeq responses. "Identical" means: the result text is equal byte for byte, as serialized by the TypeScript server (minified JSON per ADR-0009 (minified-json-output), so key order, number formatting and escaping all count; Markdown output likewise). The same LogSeq calls are made with the same inputs: calls the TypeScript code makes one after another are compared in order, and calls it makes concurrently are compared as a set. A differential harness over synthetic fixtures checks this (#124). Contract changes stay additive ([BR-0004 (additive-tool-contracts)](../business-rules/0004-additive-tool-contracts.md)) and apply to both.
3. **Process docs are re-scoped per toolchain, not superseded.**
   - An ADR whose Decision describes the contract, LogSeq's behaviour or how we work binds every implementation. Reading it for Rust means reading its intent, with the mechanism that names TypeScript read as "the TypeScript mechanism".
   - An ADR whose Decision is itself about the TypeScript toolchain (for example the Node floor and the npm publish path) applies to the TypeScript implementation only. The Rust equivalent, if there is one, gets its own ADR. This is a scope reading, not a supersession: those ADRs say nothing about Rust, so a second implementation reverses nothing in them. #128 adds a `reviewer:` line to each such ADR's Mechanical enforcement section stating its scope, so a reader of ADR-0022 alone can find out.
   - Each accepted ADR keeps its text. Rust's way of meeting it is recorded by adding a `<tier>: <reference>` line to its Mechanical enforcement section, which the ADR README already allows to be updated in place.
   - `docs/architecture-foundations.md`, `CLAUDE.md` and the business rules are editable. Foundations is split into toolchain-neutral principles and a section per toolchain. Business rules are edited in place with Changelog rows, as their README says.
   - This ADR sets the approach. The classification of each ADR and the doc rewrite happen in #128, after a "go". Nothing is reclassified before then. **Interim rule for the spike:** the Rust code follows every ADR by its intent, except ADR-0017, ADR-0022 and the `node dist/index.js` launch in ADR-0018, which are TypeScript-only.
4. **Retiring the TypeScript implementation is a separate decision** and gets its own ADR, if and when the Rust server reaches parity and ships.

## Consequences

- Two implementations to keep in step while both exist: every contract change lands twice, and the differential harness has to stay green. The spike limits the window in which that costs anything.
- The parity harness doubles as a regression suite for the contract, since it pins behaviour that is today pinned only by TypeScript unit tests.
- We accept that "read the intent" leaves some judgment to the reader until #128 classifies each ADR. The weaker alternative, rewriting accepted ADRs in place, would break the immutability that lets them serve as history.
- A spike that ends in "no-go" still leaves the harness and a record of why.
- Each Rust enforcement line added in #128 is an edit to an accepted ADR and needs the maintainer's approval, so #128 is a long approval queue. A `test:` line can only land once the Rust file it names exists.
- ADR-0018 launches the server with `node dist/index.js`, and a Rust CI or release workflow could trip the checks in `src/adr-workflow-guards.test.ts`. The spike keeps its workflow separate and checks this early (#123).
- Publishing a binary is a new release path. [ADR-0017 (manual-npm-publish)](0017-manual-npm-publish.md) applies to npm only, and a binary release needs its own ADR, written when it is real, with the same "never publish from a session" stance.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- none-yet: #124 (adds the differential harness that holds the Rust server to the TypeScript contract; covers Decision 2)
- reviewer: a PR that adds Rust code checks it against every ADR by intent and against Decision 3's interim rule (Decision 3 has no mechanical guard; #128 adds the per-ADR scope lines)
