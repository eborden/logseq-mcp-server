# Keep the server read-only

## Context

The server connects an LLM to a personal knowledge graph through LogSeq's HTTP API, which can also write: it exposes `logseq.Editor.*` methods that insert, update and remove blocks. A write-capable tool means a model can lose or corrupt notes by mistake, and the graph here is a single person's data.

Under the MCP spec, a tool with no annotations defaults to possibly destructive and open-world, so clients cannot auto-approve calls even when every tool only reads (issue #9). That was the actual state until PR #28: the server was read-only in behaviour but looked destructive to clients.

The alternative was to add write tools, perhaps behind a flag. The server's value is in reading and navigating the graph, and writing adds risk without being needed for that. Where the user explicitly asks for a summary or links to be recorded, the `logseq-skills` skill does it through the host's own tools, not through this server.

## Decision

We keep the server read-only. No tool writes to the graph. Every tool declares `readOnlyHint: true`, `destructiveHint: false` and `openWorldHint: false`, plus a title. A tool is also declared `idempotentHint: true` unless it reads live editor state: `logseq_get_current_context` is read-only but `idempotentHint: false`. The hints live in one shared constant and each tool adds only its title.

Prompts and resources are read-only too. A prompt that produces a summary says to show it in chat, and to write a page only if asked and file access exists.

Adding a tool that writes to the graph is a contract change and needs the maintainer's explicit sign-off, with a new ADR that supersedes this one.

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
