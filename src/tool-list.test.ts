import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';
import { toolListForSnapshot } from '../scripts/parity/tool-list-projection.js';

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
 * Adding the resolve_refs parameter to four tools (#18) added 568 characters (about 140 tokens),
 * bringing it to 17,651, also inside the budget.
 * Rewriting every description to fit the cap and add a "Can't find" line (#44) brought it down to about 13,900,
 * and the budget was set to 17,000 (about 23% headroom over ~13,900). The headroom is deliberate: #43 is expected
 * to add `format` and `compact` to five tools (about 200-250 characters of schema each, so 1,000-1,250) and a
 * `logseq_get_page_outline` tool (roughly 800 for description, schema and annotations). That fits in 17,000
 * without trimming useful "Can't find" lines or raising the constant again.
 * Saying that page-name parameters take aliases and ISO dates (#41) added 161 characters (about 40 tokens),
 * bringing it to about 14,030. The longest description is 391 characters, inside the cap.
 * Making slim_results default to true and shortening its description on three tools (#42) removed 39 characters,
 * bringing it to about 13,990.
 * Adding `format` to five tools, `compact` to two, and logseq_get_page_outline (#43) took it from about 14,040 to
 * 15,650 across 15 tools: 5 x 99 for `format`, 2 x 118 for `compact`, 741 for the new tool and 41 for pointing
 * logseq_get_page at it, all inside the budget, so the budget was not raised (about 1,350 characters of headroom remain).
 * The longest description is 394 characters.
 * Saying in the `format` text that Markdown has block uuids only on search hits and with `compact` (#80) added
 * 5 x 53 characters, bringing it to about 15,915 (about 1,085 characters of headroom remain).
 * Adding logseq_check_links (#146) added 698 characters (256 of description, two capped string parameters),
 * bringing it to about 16,820 across 16 tools, inside the budget, so the budget was not raised (about 180
 * characters of headroom remain; the next tool will need trimming or a deliberate raise).
 * `limit` and `offset` on logseq_list_pages (#61) then added 164 characters net (the new parameters, less a
 * trimmed description), bringing it to 16,984 across 16 tools (16 characters of headroom remain), so the budget
 * was not raised. The list_pages text was trimmed to fit after rebasing onto logseq_check_links (#146).
 * `max_entries` on logseq_get_concept_evolution (#61) added 150 characters (the parameter and a clause in the
 * "Can't find" line), bringing it to 17,134, so the budget was raised once to 19,700 (17,134 plus ~15%): the
 * remaining #61 rows add parameters to query_by_date_range, get_backlinks (two), query_by_property and
 * search_by_relationship, about 600 characters in all, which leaves about 1,960 characters of headroom after them.
 * `limit` on logseq_query_by_property (#61) added about 160 characters net (the parameter and a clause in two
 * description lines, less a trimmed "Matching" line), bringing it to 17,754 across 16 tools; the budget was not raised.
 * `limit` on logseq_search_by_relationship (#61), the last row, added 201 characters (the parameter and a clause in two
 * description lines), bringing it to 17,955 across 16 tools; the budget was not raised (1,745 characters of headroom).
 * Saying in `limit`'s parameter text that connected-within counts top-level blocks (review of #182) added 86 more, bringing it to
 * 18,041 across 16 tools; the budget was not raised (1,659 characters of headroom).
 *
 * To raise it deliberately: change this constant in the PR that grows the tool list,
 * and say in the PR description why the extra tokens are worth paying for every session.
 */
const TOOL_LIST_BUDGET_CHARS = 19_700;

/** Rough token estimate. English text and JSON average about 4 characters per token. */
const CHARS_PER_TOKEN = 4;
const approxTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

/** Maximum length of a tool's `description` text (the input schema is not counted). */
const DESCRIPTION_CAP = 400;

/**
 * Tools whose descriptions are allowed to exceed the cap. Empty since #44 trimmed
 * every description to fit. Each value would be that tool's length when listed, as a
 * ceiling, not a target: it may shrink but must not grow. When you trim a listed tool
 * below DESCRIPTION_CAP, delete its entry (a test below fails on stale entries).
 * New tools get no allowance, so they must fit in the cap.
 */
const DESCRIPTION_ALLOWANCES: Record<string, number> = {};

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

  it("says what each tool can't find (#44)", () => {
    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a "Can't find" line`).toMatch(/Can't find/);
    }
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
    // The parity harness (#124) compares other servers in the same shape.
    expect(toolListForSnapshot(tools)).toMatchSnapshot();
  });
});
