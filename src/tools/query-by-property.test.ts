import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryByProperty } from './query-by-property.js';
import { LogseqClient } from '../client.js';
import { InvalidParameterError } from '../errors.js';

/** A block as `datascriptQuery` returns it: kebab-case keys, page inlined. */
function pulledBlock(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    uuid: 'block-uuid-1',
    content: 'Block with property',
    format: 'markdown',
    page: { id: 10, name: 'project atlas', 'original-name': 'Project Atlas' },
    parent: { id: 10 },
    left: { id: 10 },
    properties: { status: 'active' },
    'properties-order': ['status'],
    'path-refs': [{ id: 10 }],
    ...overrides
  };
}

describe('queryByProperty', () => {
  let mockClient: LogseqClient;
  let executeDatalogQuery: ReturnType<typeof vi.fn>;
  let callAPI: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeDatalogQuery = vi.fn();
    callAPI = vi.fn();
    mockClient = { executeDatalogQuery, callAPI } as any;
  });

  describe('query', () => {
    it('runs one Datalog query with the key and value as inputs, and never crawls', async () => {
      executeDatalogQuery.mockResolvedValueOnce([]);

      await queryByProperty(mockClient, 'status', 'active');

      expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
      const [query, ...inputs] = executeDatalogQuery.mock.calls[0];
      expect(query).toContain(':in $ ?key ?value');
      expect(inputs).toEqual(['status', 'active']);
      expect(callAPI).not.toHaveBeenCalled();
    });

    it('makes at most 2 API calls, however many blocks match', async () => {
      executeDatalogQuery.mockResolvedValueOnce(
        Array.from({ length: 200 }, (_, i) => [pulledBlock({ id: i + 1, uuid: `uuid-${i}` })])
      );

      await queryByProperty(mockClient, 'status', 'active', true);

      expect(executeDatalogQuery.mock.calls.length + callAPI.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('accepts the camelCase spelling the Editor API uses and queries the stored key', async () => {
      executeDatalogQuery.mockResolvedValueOnce([]);

      await queryByProperty(mockClient, 'createdBy', 'Alice');

      expect(executeDatalogQuery.mock.calls[0].slice(1)).toEqual(['created-by', 'Alice']);
    });

    it('passes a multi-value element as the value (sets match on any element)', async () => {
      executeDatalogQuery.mockResolvedValueOnce([]);

      await queryByProperty(mockClient, 'type', 'project atlas');

      expect(executeDatalogQuery.mock.calls[0][0]).toContain('[(contains? ?v ?value)]');
      expect(executeDatalogQuery.mock.calls[0].slice(1)).toEqual(['type', 'project atlas']);
    });

    it('rejects an invalid property name without calling the API', async () => {
      await expect(queryByProperty(mockClient, 'bad name', 'x')).rejects.toThrow(InvalidParameterError);
      await expect(queryByProperty(mockClient, 'a"]', 'x')).rejects.toThrow(InvalidParameterError);

      expect(executeDatalogQuery).not.toHaveBeenCalled();
      expect(callAPI).not.toHaveBeenCalled();
    });
  });

  describe('results', () => {
    it('returns the matching block', async () => {
      executeDatalogQuery.mockResolvedValueOnce([[pulledBlock()]]);

      const result: any = await queryByProperty(mockClient, 'status', 'active');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 1,
        uuid: 'block-uuid-1',
        content: 'Block with property',
        properties: { status: 'active' }
      });
    });

    it('returns an empty array when nothing matches', async () => {
      executeDatalogQuery.mockResolvedValueOnce([]);

      expect(await queryByProperty(mockClient, 'status', 'nonexistent')).toEqual([]);
    });

    it('returns null when the API returns null', async () => {
      executeDatalogQuery.mockResolvedValueOnce(null);

      expect(await queryByProperty(mockClient, 'status', 'active')).toBeNull();
    });

    it('propagates errors from the API client', async () => {
      executeDatalogQuery.mockRejectedValueOnce(new Error('Failed to connect to LogSeq API'));

      await expect(queryByProperty(mockClient, 'status', 'active')).rejects.toThrow(
        'Failed to connect to LogSeq API'
      );
    });

    it('uses camelCase keys like the Editor API, including inside properties', async () => {
      executeDatalogQuery.mockResolvedValueOnce([
        [
          pulledBlock({
            properties: { status: 'active', 'created-by': 'Alice' },
            'properties-order': ['status', 'created-by'],
            'pre-block?': true
          })
        ]
      ]);

      const [block]: any = await queryByProperty(mockClient, 'status', 'active');

      expect(block.properties).toEqual({ status: 'active', createdBy: 'Alice' });
      expect(block.propertiesOrder).toEqual(['status', 'createdBy']);
      expect(block.pathRefs).toEqual([{ id: 10 }]);
      expect(block['preBlock?']).toBe(true);
      expect(block).not.toHaveProperty('path-refs');
      expect(block).not.toHaveProperty('properties-order');
    });

    it('includes the page id, name and originalName', async () => {
      executeDatalogQuery.mockResolvedValueOnce([[pulledBlock()]]);

      const [block]: any = await queryByProperty(mockClient, 'status', 'active');

      expect(block.page).toEqual({ id: 10, name: 'project atlas', originalName: 'Project Atlas' });
    });

    it('returns flat blocks: no children and no level', async () => {
      executeDatalogQuery.mockResolvedValueOnce([[pulledBlock()]]);

      const [block]: any = await queryByProperty(mockClient, 'status', 'active');

      expect(block).not.toHaveProperty('children');
      expect(block).not.toHaveProperty('level');
    });

    it('keeps number and boolean property values as they are', async () => {
      executeDatalogQuery.mockResolvedValueOnce([
        [pulledBlock({ properties: { count: 42, completed: true } })]
      ]);

      const [block]: any = await queryByProperty(mockClient, 'count', '42');

      expect(block.properties).toEqual({ count: 42, completed: true });
    });

    it('keeps a multi-value property as the array LogSeq returns', async () => {
      executeDatalogQuery.mockResolvedValueOnce([
        [pulledBlock({ properties: { type: ['project atlas', 'project borealis'] } })]
      ]);

      const [block]: any = await queryByProperty(mockClient, 'type', 'project atlas');

      expect(block.properties.type).toEqual(['project atlas', 'project borealis']);
    });

    it('orders blocks by page id, then block id', async () => {
      executeDatalogQuery.mockResolvedValueOnce([
        [pulledBlock({ id: 5, uuid: 'e', page: { id: 20 } })],
        [pulledBlock({ id: 9, uuid: 'b', page: { id: 10 } })],
        [pulledBlock({ id: 2, uuid: 'c', page: { id: 20 } })],
        [pulledBlock({ id: 3, uuid: 'a', page: { id: 10 } })]
      ]);

      const result: any = await queryByProperty(mockClient, 'status', 'active');

      expect(result.map((b: any) => b.uuid)).toEqual(['a', 'b', 'c', 'e']);
    });
  });

  describe('rows LogSeq may send oddly', () => {
    it('skips a row whose pulled block is null and keeps the others', async () => {
      executeDatalogQuery.mockResolvedValueOnce([
        [null],
        [pulledBlock({ id: 4, uuid: 'd' })],
        [null],
        [pulledBlock({ id: 3, uuid: 'c' })]
      ]);

      const result: any = await queryByProperty(mockClient, 'status', 'active');

      expect(result.map((b: any) => b.uuid)).toEqual(['c', 'd']);
    });

    it('returns an empty array, not null, when every row is null', async () => {
      executeDatalogQuery.mockResolvedValueOnce([[null], [null]]);

      expect(await queryByProperty(mockClient, 'status', 'active')).toEqual([]);
    });

    it('leaves a block with no page without a page key', async () => {
      const { page: _page, ...noPage } = pulledBlock({ id: 8, uuid: 'x' });
      executeDatalogQuery.mockResolvedValueOnce([[noPage]]);

      const [block]: any = await queryByProperty(mockClient, 'status', 'active');

      expect(block.uuid).toBe('x');
      expect(block).not.toHaveProperty('page');
    });

    it('omits pageName from a slim block with no page', async () => {
      const { page: _page, ...noPage } = pulledBlock({ id: 8, uuid: 'x' });
      executeDatalogQuery.mockResolvedValueOnce([[noPage]]);

      const [block]: any = await queryByProperty(mockClient, 'status', 'active', true);

      expect(block.uuid).toBe('x');
      expect(block).not.toHaveProperty('pageName');
    });

    it('sorts blocks with no page before every page, by block id', async () => {
      const noPage = (id: number) => {
        const { page: _page, ...rest } = pulledBlock({ id, uuid: `n${id}` });
        return [rest];
      };
      executeDatalogQuery.mockResolvedValueOnce([
        [pulledBlock({ id: 7, uuid: 'p7', page: { id: 10 } })],
        noPage(9),
        [pulledBlock({ id: 3, uuid: 'p3', page: { id: 10 } })],
        noPage(4),
        [pulledBlock({ id: 6, uuid: 'p6', page: { id: 5 } })],
        noPage(2)
      ]);

      const result: any = await queryByProperty(mockClient, 'status', 'active');

      expect(result.map((b: any) => b.uuid)).toEqual(['n2', 'n4', 'n9', 'p6', 'p3', 'p7']);
    });
  });

  describe('slim results mode', () => {
    it('returns slim blocks with the original page name', async () => {
      executeDatalogQuery.mockResolvedValueOnce([
        [
          pulledBlock({
            content: 'Block with #tag and [[Link]]',
            properties: { status: 'active', priority: 'high' }
          })
        ]
      ]);

      const result: any = await queryByProperty(mockClient, 'status', 'active', true);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        uuid: 'block-uuid-1',
        content: 'Block with #tag and [[Link]]',
        pageName: 'Project Atlas',
        properties: { status: 'active', priority: 'high' },
        tags: ['tag'],
        pageRefs: ['Link']
      });
    });

    it('drops ids and page, and omits empty fields', async () => {
      executeDatalogQuery.mockResolvedValueOnce([[pulledBlock()]]);

      const [block]: any = await queryByProperty(mockClient, 'status', 'active', true);

      expect(block).not.toHaveProperty('id');
      expect(block).not.toHaveProperty('page');
      expect(block).not.toHaveProperty('marker');
      expect(block).not.toHaveProperty('tags');
      expect(block).not.toHaveProperty('pageRefs');
      expect(block).not.toHaveProperty('children');
    });

    it('camelizes property keys in slim results too', async () => {
      executeDatalogQuery.mockResolvedValueOnce([
        [pulledBlock({ properties: { 'created-by': 'Alice' } })]
      ]);

      const [block]: any = await queryByProperty(mockClient, 'createdBy', 'Alice', true);

      expect(block.properties).toEqual({ createdBy: 'Alice' });
    });

    it('falls back to the lowercase name when original-name is missing', async () => {
      executeDatalogQuery.mockResolvedValueOnce([
        [pulledBlock({ page: { id: 10, name: 'project atlas' } })]
      ]);

      const [block]: any = await queryByProperty(mockClient, 'status', 'active', true);

      expect(block.pageName).toBe('project atlas');
    });

    it('returns full results when slimResults=false (default)', async () => {
      executeDatalogQuery.mockResolvedValueOnce([[pulledBlock()]]);

      const [block]: any = await queryByProperty(mockClient, 'status', 'active', false);

      expect(block).toHaveProperty('id', 1);
      expect(block).toHaveProperty('page');
    });
  });
});
