# Keep the server read-only

## Context

The server connects an LLM to a personal knowledge graph through LogSeq's HTTP API, which can also write: it exposes `logseq.Editor.*` methods that insert, update and remove blocks. The server has never called one. It has been read-only since the first commit (48284ae, 2025-11-20), so there is no dated moment when the choice was made, and no early source records why.

The recorded rationale came later, in the foundations doc (PR #38). Section 4.5: "MCP clients retry, and LLMs call the same tool twice. A read-only tool makes that harmless." It adds that a tool that writes would need "idempotent design, explicit confirmation semantics and its own review", and hard rule 4 makes adding one a contract change that needs the maintainer's sign-off.

Inferred, not recorded: a write-capable tool also means a model can lose or corrupt notes by mistake, in a graph that is one person's data, and the server's value is in reading and navigating the graph.

Under the MCP spec, a tool with no annotations defaults to possibly destructive and open-world, so clients cannot auto-approve calls even when every tool only reads (issue #9). That was the state until PR #28 (2026-10-05): the server was read-only in behaviour but looked destructive to clients. The Status date is when PR #28 declared the property in annotations, not when it was chosen.

## Decision

We keep the server read-only. No tool writes to the graph, and every tool declares it through MCP annotations (PR #28). Prompts and resources are read-only too.

The invariants that keep this true (which hints each tool declares, the one non-idempotent tool, and the sign-off needed for a tool that writes) live in the business rule [BR-0002 (tools-read-only)](../business-rules/0002-tools-read-only.md) (PR #84) and in foundations hard rule 4. Reversing this decision needs a new ADR that supersedes this one.

## Consequences

- Clients can auto-approve every tool, and there is no way for the server to damage the graph.
- Users who want the model to record something must use another path, such as host file tools, and the skills depend on that.
- Keeping the annotations accurate is ongoing work: a new tool has to pick correct hints, and a stateful read such as the live editor selection is not idempotent.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/index.test.ts` (every tool is readOnlyHint: true with a title, and carries the other hints, with the non-idempotent exception pinned)
- test: `src/resources.test.ts` (reading a resource never calls a write method on LogSeq)
- test: `src/prompts.test.ts`
