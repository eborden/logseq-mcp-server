import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * Guardrails on the `tools/list` payload (#39, part of #13).
 *
 * Every session pays for this payload in context, so growth should be a deliberate
 * choice. Three checks:
 *   1. a size budget on the whole serialized tool list,
 *   2. a per-tool description length cap,
 *   3. a snapshot, so description and schema changes show up in review.
 */

/**
 * Budget for `JSON.stringify(tools)`, in characters.
 *
 * Measured when this test was added: 16,014 characters (about 4,000 tokens at
 * chars / 4) across 13 tools. The budget is that plus roughly 15% headroom.
 * Adding logseq_get_current_context (#15) brought it to 16,660 characters across 14 tools,
 * still inside the budget, so the budget was not raised.
 *
 * To raise it deliberately: change this constant in the PR that grows the tool list,
 * and say in the PR description why the extra tokens are worth paying for every session.
 */
const TOOL_LIST_BUDGET_CHARS = 18_500;

/** Rough token estimate. English text and JSON average about 4 characters per token. */
const CHARS_PER_TOKEN = 4;
const approxTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

/** Maximum length of a tool's `description` text (the input schema is not counted). */
const DESCRIPTION_CAP = 400;

/**
 * Tools whose descriptions were already over the cap when the cap was added.
 * Each value is that tool's length at the time, and it is a ceiling, not a target:
 * these descriptions may shrink but must not grow. They were not rewritten in the
 * PR that added the cap.
 *
 * When you trim one of these below DESCRIPTION_CAP, delete its entry (a test below
 * fails on stale entries). New tools get no allowance, so they must fit in the cap.
 */
const DESCRIPTION_ALLOWANCES: Record<string, number> = {
  logseq_get_page: 547,
  logseq_get_backlinks: 619,
  logseq_get_block: 431,
  logseq_search_blocks: 589,
  logseq_query_by_property: 856,
  logseq_get_concept_network: 952,
  logseq_search_by_relationship: 654,
  logseq_build_context: 638,
  logseq_get_context_for_query: 600,
  logseq_query_by_date_range: 560,
  logseq_get_concept_evolution: 636,
  logseq_list_pages: 624,
};

describe('tools/list guardrails', () => {
  let tools: Tool[];

  beforeAll(async () => {
    const server = createServer(new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    try {
      tools = (await mcpClient.listTools()).tools;
    } finally {
      await mcpClient.close();
    }
  });

  it('stays within the token budget', () => {
    const size = JSON.stringify(tools).length;
    expect(
      size,
      `The tools/list payload is ${size} characters (about ${approxTokens(size)} tokens), over the budget of ` +
        `${TOOL_LIST_BUDGET_CHARS} characters (about ${approxTokens(TOOL_LIST_BUDGET_CHARS)} tokens). ` +
        'Every session pays for this, so first try trimming descriptions or parameter docs. ' +
        'If the growth is worth it, raise TOOL_LIST_BUDGET_CHARS in src/tool-list.test.ts ' +
        'and justify the increase in the PR description.'
    ).toBeLessThanOrEqual(TOOL_LIST_BUDGET_CHARS);
  });

  describe('description length', () => {
    it('keeps every description within its cap', () => {
      for (const tool of tools) {
        const length = (tool.description ?? '').length;
        const cap = DESCRIPTION_ALLOWANCES[tool.name] ?? DESCRIPTION_CAP;
        expect(
          length,
          `${tool.name} has a ${length}-character description, over its cap of ${cap}. ` +
            `New descriptions should fit in ${DESCRIPTION_CAP} characters. Move detail into parameter ` +
            'descriptions or tool output. Tools listed in DESCRIPTION_ALLOWANCES may shrink but not grow.'
        ).toBeLessThanOrEqual(cap);
      }
    });

    it('has no stale allowances', () => {
      const lengths = new Map(tools.map(t => [t.name, (t.description ?? '').length]));
      for (const name of Object.keys(DESCRIPTION_ALLOWANCES)) {
        const length = lengths.get(name);
        expect(length, `DESCRIPTION_ALLOWANCES lists ${name}, which is not a registered tool. Remove the entry.`)
          .toBeDefined();
        expect(
          length!,
          `${name} is now ${length} characters, within the ${DESCRIPTION_CAP} cap. Remove its entry from DESCRIPTION_ALLOWANCES.`
        ).toBeGreaterThan(DESCRIPTION_CAP);
      }
    });
  });

  it('matches the tool list snapshot', () => {
    // Sorted so that registration order doesn't churn the snapshot.
    // Run `npx vitest run src/tool-list.test.ts -u` to accept an intended change.
    const snapshot = [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, annotations, description, inputSchema }) => ({
        name,
        title: annotations?.title,
        annotations,
        description,
        inputSchema,
      }));
    expect(snapshot).toMatchSnapshot();
  });
});
