// The shape the tools/list snapshot is taken in (ADR-0016). src/tool-list.test.ts writes the
// snapshot with it and the parity harness (#124) compares other servers with it, so the two can't
// drift apart.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** Sorted by name, so that registration order doesn't churn the snapshot. */
export function toolListForSnapshot(tools: readonly Tool[]) {
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, annotations, description, inputSchema }) => ({
      name,
      title: annotations?.title,
      annotations,
      description,
      inputSchema
    }));
}
