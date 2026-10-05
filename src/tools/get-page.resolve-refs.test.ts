import { describe, it, expect } from 'vitest';
import { getPage } from './get-page.js';
import { fakeRefGraph, uuidN } from '../../tests/helpers/ref-graph.js';

const REF = uuidN(7);
const page = { id: 1, uuid: uuidN(100), name: 'alpha', originalName: 'Alpha' };
const tree = () => [
  { id: 11, uuid: uuidN(1), content: `see ((${REF}))`, children: [{ id: 12, uuid: uuidN(2), content: 'plain', children: [] }] },
  { id: 13, uuid: uuidN(3), content: 'nothing here', children: [] }
];

function setup() {
  const graph = fakeRefGraph({
    pages: ['Alpha', 'Beta'],
    blocks: [{ uuid: REF, content: 'quoted words', page: 'Beta' }]
  });
  (graph.client.callAPI as any).mockImplementation(async (method: string) =>
    method === 'logseq.Editor.getPage' ? { ...page } : tree()
  );
  return graph;
}

describe('getPage resolve_refs', () => {
  it('off: same calls and same output as before, no Datalog', async () => {
    const { client, executeDatalogQuery } = setup();
    const result = await getPage(client, 'Alpha', true);
    expect(client.callAPI).toHaveBeenCalledTimes(2);
    expect(executeDatalogQuery).not.toHaveBeenCalled();
    expect(result).toEqual({ ...page, children: tree() });
    expect(JSON.stringify(result)).not.toMatch(/resolved|warnings|hasMore/);
  });

  it('explicit false is the same as off', async () => {
    const { client, executeDatalogQuery } = setup();
    const result = await getPage(client, 'Alpha', true, { resolveRefs: false });
    expect(executeDatalogQuery).not.toHaveBeenCalled();
    expect(result).toEqual({ ...page, children: tree() });
  });

  it('on: annotates child blocks, keeps content, adds meta, and costs at most depth + 1 extra calls', async () => {
    const { client, executeDatalogQuery } = setup();
    const result = await getPage(client, 'Alpha', true, { resolveRefs: true });

    expect(client.callAPI).toHaveBeenCalledTimes(2); // unchanged
    expect(executeDatalogQuery.mock.calls.length).toBeLessThanOrEqual(2 + 1);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);

    const first = result.children![0] as any;
    expect(first.content).toBe(`see ((${REF}))`);
    expect(first.resolvedContent).toBe('see quoted words');
    expect(first.resolvedRefs).toEqual([{ uuid: REF, content: 'quoted words', page: 'Beta', status: 'ok' }]);
    expect((result.children![1] as any).resolvedContent).toBeUndefined();
    expect(result.hasMore).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('on without include_children: nothing to resolve, no extra calls', async () => {
    const { client, executeDatalogQuery } = setup();
    const result = await getPage(client, 'Alpha', false, { resolveRefs: true });
    expect(client.callAPI).toHaveBeenCalledTimes(1);
    expect(executeDatalogQuery).not.toHaveBeenCalled();
    expect(result.children).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('on with no refs in the page: no Datalog call', async () => {
    const { client, executeDatalogQuery } = setup();
    (client.callAPI as any).mockImplementation(async (method: string) =>
      method === 'logseq.Editor.getPage' ? { ...page } : [{ id: 1, uuid: uuidN(1), content: 'x', children: [] }]
    );
    await getPage(client, 'Alpha', true, { resolveRefs: true });
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });
});
