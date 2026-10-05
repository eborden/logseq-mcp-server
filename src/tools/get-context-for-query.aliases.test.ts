import { describe, it, expect, vi } from 'vitest';
import { getContextForQuery } from './get-context-for-query.js';
import { LogseqClient } from '../client.js';

// Synthetic graph from the issue: "Jordan" declares `alias:: Jordan Rivera`.
const jordan = { id: 1, name: 'jordan', 'original-name': 'Jordan', file: { id: 900 }, alias: [{ id: 2 }] };
const member = (id: number, name: string, originalName: string) => ({ id, name, 'original-name': originalName });

describe('get_context_for_query across an alias group (#69)', () => {
  it('reports the names covered for a topic that has aliases, and only for that topic', async () => {
    const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
      if (query.includes(':in $ ?n')) {
        return inputs[0] === 'jordan'
          ? [[jordan, 'name']]
          : [[{ id: 9, name: 'alice', 'original-name': 'Alice', file: { id: 901 } }, 'name']];
      }
      if (query.includes('?start')) return [[1, member(1, 'jordan', 'Jordan')], [1, member(2, 'jordan rivera', 'Jordan Rivera')]];
      return [];
    });
    const client = { config: {}, executeDatalogQuery, callAPI: vi.fn().mockResolvedValue([]) } as unknown as LogseqClient;

    const result = await getContextForQuery(client, 'What did [[Jordan]] and [[Alice]] ship?');

    const [jordanContext, aliceContext] = result.contexts;
    expect(jordanContext.resolvedAliases).toEqual(['Jordan', 'Jordan Rivera']);
    expect(aliceContext).not.toHaveProperty('resolvedAliases');
    // Jordan: resolver, alias set, blocks, linked references (4).
    // Alice: resolver, blocks (2), plus one Editor call for her linked references.
    expect(executeDatalogQuery).toHaveBeenCalledTimes(4 + 2);
  });
});
