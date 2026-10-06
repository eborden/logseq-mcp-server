import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { DatalogQueryBuilder } from '../../src/datalog/queries.js';
import { getCurrentContext } from '../../src/tools/get-current-context.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Read-only: calls getCurrentPage / getCurrentBlock / getSelectedBlocks and never
 * changes LogSeq or its UI state. What is open is up to whoever is at the keyboard
 * (a fresh fixture instance opens today's journal with the cursor in its one block,
 * but a LogSeq that someone is using can show anything), so these tests check the
 * shape, and that every page the result names exists in the fixture graph.
 */
describe('getCurrentContext - Integration', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  async function pageExists(name: string): Promise<boolean> {
    const { query, inputs } = DatalogQueryBuilder.getPage(name);
    return ((await client.executeDatalogQuery<unknown[]>(query, ...inputs)) ?? []).length === 1;
  }

  it('succeeds and returns a well-formed result for whatever is open', async () => {
    const result = await getCurrentContext(client);

    expect(result).toHaveProperty('page');
    if (result.page === null) {
      // Nothing open is a normal result with an explanation, not an error
      expect(typeof result.message).toBe('string');
      expect(result.message!.length).toBeGreaterThan(0);
    } else {
      expect(typeof result.page.name).toBe('string');
      expect(result.page.originalName.toLowerCase()).toBe(result.page.name);
      expect(await pageExists(result.page.name), 'the open page is a page of the graph').toBe(true);
      expect(result.message).toBeUndefined();
    }

    if (result.focusedBlock) {
      expect(typeof result.focusedBlock.uuid).toBe('string');
      expect(typeof result.focusedBlock.content).toBe('string');
      expect(await pageExists(result.focusedBlock.pageName), 'the focused block is on a page of the graph').toBe(true);
    }

    if (result.selectedBlocks) {
      expect(result.selectedBlocks.length).toBeGreaterThan(0);
      for (const block of result.selectedBlocks) {
        expect(typeof block.uuid).toBe('string');
        expect(await pageExists(block.pageName)).toBe(true);
      }
    }
  });

  it('makes at most 4 API calls', async () => {
    const methods: string[] = [];
    const original = client.callAPI.bind(client);
    const counting = Object.create(client) as LogseqClient;
    counting.callAPI = (async (method: string, args: any[] = []) => {
      methods.push(method);
      return original(method, args);
    }) as typeof client.callAPI;

    await getCurrentContext(counting);

    expect(methods.length).toBeLessThanOrEqual(4);
    expect(methods).not.toContain('logseq.Editor.getAllPages');
  });
});
