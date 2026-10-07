import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_PROPERTY_LIMIT,
  MAX_PROPERTY_LIMIT,
  queryByProperty,
  queryByPropertyWithMeta
} from './query-by-property.js';
import { LogseqClient } from '../client.js';

/**
 * The cap on logseq_query_by_property (#61): `limit`, default 100, at most 500. The results
 * are a bare array, so the cut is reported in `meta` (the handler sends it as a second block).
 * All data is made up.
 */

/** A pulled block, as datascriptQuery returns it. Ids ascend with `i`, all on one page unless given. */
const pulled = (i: number, pageId = 10) => ({
  id: i,
  uuid: `uuid-${i}`,
  content: `Block ${i}`,
  format: 'markdown',
  page: { id: pageId, name: `page ${pageId}`, 'original-name': `Page ${pageId}` },
  properties: { status: 'active' }
});

/** `n` matching blocks, ids 1..n, returned in reverse so the tool's own order shows */
function clientWith(n: number | null) {
  const executeDatalogQuery = vi.fn(async () =>
    n === null ? null : Array.from({ length: n }, (_, i) => [pulled(n - i)])
  );
  const callAPI = vi.fn();
  return { client: { executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
}

const ids = (results: unknown) => (results as Array<{ id: number }>).map(block => block.id);

describe('queryByPropertyWithMeta caps', () => {
  it('uses a default of 100 and a maximum of 500', () => {
    expect(DEFAULT_PROPERTY_LIMIT).toBe(100);
    expect(MAX_PROPERTY_LIMIT).toBe(500);
  });

  describe('below the cap', () => {
    it('returns every block with no meta', async () => {
      const { client } = clientWith(99);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active');

      expect(results).toHaveLength(99);
      expect(meta).toBeNull();
    });

    it('returns an explicit limit above the match count whole, with no meta', async () => {
      const { client } = clientWith(7);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active', false, 300);

      expect(results).toHaveLength(7);
      expect(meta).toBeNull();
    });

    it('returns full blocks, with ids and a page, when slimResults is left out', async () => {
      const { client } = clientWith(2);

      const { results } = await queryByPropertyWithMeta(client, 'status', 'active');

      expect(results).toEqual([
        expect.objectContaining({ id: 1, page: { id: 10, name: 'page 10', originalName: 'Page 10' } }),
        expect.objectContaining({ id: 2, page: { id: 10, name: 'page 10', originalName: 'Page 10' } })
      ]);
    });

    it('returns the same array as before the cap existed', async () => {
      const { client } = clientWith(30);

      expect(await queryByProperty(client, 'status', 'active', true)).toEqual(
        (await queryByPropertyWithMeta(client, 'status', 'active', true)).results
      );
    });
  });

  describe('at the cap', () => {
    it('returns exactly 100 blocks with no meta at the default', async () => {
      const { client } = clientWith(100);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active');

      expect(results).toHaveLength(100);
      expect(meta).toBeNull();
    });

    it('returns exactly 500 blocks with no meta at the maximum', async () => {
      const { client } = clientWith(500);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active', true, 500);

      expect(results).toHaveLength(500);
      expect(meta).toBeNull();
    });
  });

  describe('above the cap', () => {
    it('scales the large-result threshold for unslimmed results (#196)', async () => {
      const note = "A result this large may be saved to a file by the host instead of shown; the server can't tell.";
      const atLimit = async (matches: number, slim: boolean) =>
        (await queryByPropertyWithMeta(clientWith(matches).client, 'status', 'active', slim)).meta!.warnings[0].howToFetchAll;

      // Slim blocks: the note starts past 200 matches. Unslimmed ones are about 1.6 times larger: past 125
      expect(await atLimit(200, true)).toBe('Set limit to 200 (or higher) to get all 200.');
      expect(await atLimit(201, true)).toBe(`Set limit to 201 (or higher) to get all 201. ${note}`);
      expect(await atLimit(125, false)).toBe('Set limit to 125 (or higher) to get all 125.');
      expect(await atLimit(126, false)).toBe(`Set limit to 126 (or higher) to get all 126. ${note}`);
    });

    it('cuts to 100 by default and says how to get all of them', async () => {
      const { client } = clientWith(130);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active', true);

      expect(results).toHaveLength(100);
      expect(meta).toEqual({
        hasMore: true,
        totals: { matches: 130 },
        warnings: [
          {
            code: 'results_truncated',
            message: 'Showing 100 of 130 matching blocks (the first ones listed, not ranked).',
            howToFetchAll: 'Set limit to 130 (or higher) to get all 130.'
          }
        ]
      });
    });

    it('cuts to the limit asked for', async () => {
      const { client } = clientWith(12);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active', false, 5);

      expect(results).toHaveLength(5);
      expect(meta?.warnings[0].howToFetchAll).toBe('Set limit to 12 (or higher) to get all 12.');
      expect(meta?.totals).toEqual({ matches: 12 });
    });

    it('keeps the first blocks in page-id then block-id order, whatever order the query returns', async () => {
      const rows = [[pulled(9, 30)], [pulled(2, 20)], [pulled(8, 20)], [pulled(5, 10)], [pulled(1, 30)]];
      const client = { executeDatalogQuery: vi.fn(async () => rows) } as unknown as LogseqClient;

      const { results } = await queryByPropertyWithMeta(client, 'status', 'active', false, 3);

      expect(ids(results)).toEqual([5, 2, 8]);
    });

    it('cuts slim results the same way', async () => {
      const { client } = clientWith(150);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active', true);

      expect(results).toHaveLength(100);
      expect((results as Array<{ pageName: string }>)[0].pageName).toBe('Page 10');
      expect(meta?.totals).toEqual({ matches: 150 });
    });

    it('offers the maximum, and no value above it, when the matches pass 500', async () => {
      const { client } = clientWith(700);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active', true, 200);

      expect(results).toHaveLength(200);
      expect(meta?.hasMore).toBe(true);
      expect(meta?.warnings[0].howToFetchAll).toBe(
        'Set limit to 500 (the maximum) to get 500 of 700. A result this large may be saved to a file by the host instead of shown; the server can\'t tell. No other parameter narrows this query.'
      );
      expect(meta?.warnings[0].howToFetchAll).not.toContain('to 700');
    });
  });

  describe('at the maximum', () => {
    it('says the maximum was reached, with no howToFetchAll and hasMore false', async () => {
      const { client } = clientWith(600);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active', true, 500);

      expect(results).toHaveLength(500);
      expect(meta).toEqual({
        hasMore: false,
        totals: { matches: 600 },
        warnings: [
          {
            code: 'results_truncated',
            message:
              'Showing 500 of 600 matching blocks (the first ones listed, not ranked): limit is capped at its maximum of 500, so the rest can\'t be fetched in one call. No other parameter narrows this query.'
          }
        ]
      });
      expect(meta?.warnings[0]).not.toHaveProperty('howToFetchAll');
    });

    it('clamps a limit above 500 and says what was asked for', async () => {
      const { client } = clientWith(501);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active', true, 5000);

      expect(results).toHaveLength(500);
      expect(meta?.hasMore).toBe(false);
      expect(meta?.warnings[0].message).toContain('capped at its maximum of 500 (5000 was asked for)');
      expect(meta?.warnings[0]).not.toHaveProperty('howToFetchAll');
    });

    it('returns 500 blocks and no meta when exactly 500 match and a larger limit is asked for', async () => {
      const { client } = clientWith(500);

      const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active', true, 5000);

      expect(results).toHaveLength(500);
      expect(meta).toBeNull();
    });
  });

  describe('odd limits', () => {
    it('returns no blocks for a limit of 0 or below, and says so', async () => {
      const { client } = clientWith(3);

      for (const limit of [0, -4]) {
        const { results, meta } = await queryByPropertyWithMeta(client, 'status', 'active', true, limit);
        expect(results).toEqual([]);
        expect(meta?.warnings[0].message).toContain('Showing 0 of 3 matching blocks');
        expect(meta?.warnings[0].howToFetchAll).toBe('Set limit to 3 (or higher) to get all 3.');
      }
    });

    it('floors a fractional limit', async () => {
      const { client } = clientWith(10);

      const { results } = await queryByPropertyWithMeta(client, 'status', 'active', false, 2.9);

      expect(results).toHaveLength(2);
    });
  });

  describe('cost and null', () => {
    it('makes the one Datalog query and no other call, cut or not', async () => {
      for (const n of [3, 250]) {
        const { client, executeDatalogQuery, callAPI } = clientWith(n);

        await queryByPropertyWithMeta(client, 'status', 'active', true);

        expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
        expect(callAPI).not.toHaveBeenCalled();
      }
    });

    it('keeps a null answer null, with no meta (BR-0011)', async () => {
      const { client } = clientWith(null);

      expect(await queryByPropertyWithMeta(client, 'status', 'active')).toEqual({ results: null, meta: null });
      expect(await queryByProperty(client, 'status', 'active')).toBeNull();
    });

    it('returns an empty array and no meta when nothing matches', async () => {
      const { client } = clientWith(0);

      expect(await queryByPropertyWithMeta(client, 'status', 'active')).toEqual({ results: [], meta: null });
    });
  });
});
