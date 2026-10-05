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
  // The page-name lookup is a Datalog query too; answer it and keep it out of the ref counts
  const inner = graph.executeDatalogQuery.getMockImplementation()!;
  graph.executeDatalogQuery.mockImplementation(async (query: string, ...inputs: unknown[]) =>
    query.includes(':in $ ?n') ? [[{ id: 1, name: 'alpha', 'original-name': 'Alpha' }, 'name']] : inner(query, ...inputs)
  );
  const refCalls = () => graph.executeDatalogQuery.mock.calls.filter(c => !String(c[0]).includes(':in $ ?n'));
  return { ...graph, refCalls };
}

describe('getPage resolve_refs', () => {
  it('off: same calls and same output as before, no Datalog', async () => {
    const { client, refCalls } = setup();
    const result = await getPage(client, 'Alpha', true);
    expect(client.callAPI).toHaveBeenCalledTimes(2);
    expect(refCalls()).toHaveLength(0);
    expect(result).toEqual({ ...page, children: tree() });
    expect(JSON.stringify(result)).not.toMatch(/resolved|warnings|hasMore/);
  });

  it('explicit false is the same as off', async () => {
    const { client, refCalls } = setup();
    const result = await getPage(client, 'Alpha', true, { resolveRefs: false });
    expect(refCalls()).toHaveLength(0);
    expect(result).toEqual({ ...page, children: tree() });
  });

  it('on: annotates child blocks, keeps content, adds meta, and costs at most depth + 1 extra calls', async () => {
    const { client, refCalls } = setup();
    const result = await getPage(client, 'Alpha', true, { resolveRefs: true });

    expect(client.callAPI).toHaveBeenCalledTimes(2); // unchanged
    expect(refCalls().length).toBeLessThanOrEqual(2 + 1);
    expect(refCalls()).toHaveLength(1);

    const first = result.children![0] as any;
    expect(first.content).toBe(`see ((${REF}))`);
    expect(first.resolvedContent).toBe('see quoted words');
    expect(first.resolvedRefs).toEqual([{ uuid: REF, content: 'quoted words', page: 'Beta', status: 'ok' }]);
    expect((result.children![1] as any).resolvedContent).toBeUndefined();
    expect(result.hasMore).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('on without include_children: nothing to resolve, no extra calls', async () => {
    const { client, refCalls } = setup();
    const result = await getPage(client, 'Alpha', false, { resolveRefs: true });
    expect(client.callAPI).toHaveBeenCalledTimes(1);
    expect(refCalls()).toHaveLength(0);
    expect(result.children).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('on with no refs in the page: no Datalog call', async () => {
    const { client, refCalls } = setup();
    (client.callAPI as any).mockImplementation(async (method: string) =>
      method === 'logseq.Editor.getPage' ? { ...page } : [{ id: 1, uuid: uuidN(1), content: 'x', children: [] }]
    );
    await getPage(client, 'Alpha', true, { resolveRefs: true });
    expect(refCalls()).toHaveLength(0);
  });
});
