import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  approxTokens,
  DESCRIPTION_ALLOWANCES,
  DESCRIPTION_CAP,
  TOOL_LIST_BUDGET_CHARS,
} from '../guards/tool-list-limits.js';
import { startLiveServer, type LiveServer } from './live-server.js';

/**
 * ADR-0016's size budget and description cap, over the Rust server's own `tools/list`: the payload every session
 * loads. `tests/guards/tool-list.test.ts` holds the recorded list (`tests/data/parity/tool-list.json`) to the
 * same limits, but the server spells its schemas its own way (`format: "uint32"` on every count and so on, which the
 * parity step's by-meaning comparison drops on purpose), so the recorded list is smaller than the payload a client
 * gets. It was 18,763 characters when the live one was 19,383.
 */
describe('the live tools/list (ADR-0016)', () => {
  let live: LiveServer;
  let tools: Tool[];

  beforeAll(async () => {
    live = await startLiveServer();
    tools = (await live.client.listTools()).tools;
  }, 30000);

  afterAll(async () => {
    await live?.close();
  });

  it('lists 10 tools', () => {
    expect(tools).toHaveLength(10);
  });

  it('stays within the token budget, measured on what the server sends', () => {
    const size = JSON.stringify(tools).length;
    expect(
      size,
      `The server's tools/list payload is ${size} characters (about ${approxTokens(size)} tokens), over the budget of ` +
        `${TOOL_LIST_BUDGET_CHARS} characters (about ${approxTokens(TOOL_LIST_BUDGET_CHARS)} tokens). ` +
        'Every session pays for this, so first try trimming descriptions or parameter docs. If the growth is worth it, ' +
        'raise TOOL_LIST_BUDGET_CHARS in tests/guards/tool-list-limits.ts and justify the increase in the PR description.'
    ).toBeLessThanOrEqual(TOOL_LIST_BUDGET_CHARS);
  });

  it('writes no `type` array: an optional parameter is `anyOf` one type and null (MCP Inspector, Gemini)', () => {
    const arrays: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) node.forEach((item, i) => visit(item, `${path}[${i}]`));
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === 'type' && Array.isArray(value)) arrays.push(path);
          visit(value, `${path}.${key}`);
        }
      }
    };
    for (const tool of tools) visit(tool.inputSchema, tool.name);
    expect(arrays).toEqual([]);
  });

  it("keeps every description within its cap and says what each tool can't find", () => {
    for (const tool of tools) {
      const length = (tool.description ?? '').length;
      const cap = DESCRIPTION_ALLOWANCES[tool.name] ?? DESCRIPTION_CAP;
      expect(length, `${tool.name} has a ${length}-character description, over its cap of ${cap}`).toBeLessThanOrEqual(cap);
      expect(tool.description, `${tool.name} needs a "Can't find" line (ADR-0015)`).toMatch(/Can't find/);
    }
  });
});
