import { describe, it, expect } from 'vitest';
import { getBlock } from './get-block.js';
import { fakeRefGraph, uuidN } from '../../tests/helpers/ref-graph.js';

const ROOT = uuidN(1);
const REF = uuidN(7);
const embedded = uuidN(8);
const block = () => ({
  id: 11,
  uuid: ROOT,
  content: `quote ((${REF})) and {{embed ((${embedded}))}}`,
  page: { id: 1 },
  parent: { id: 1 },
  left: { id: 1 },
  children: [{ id: 12, uuid: uuidN(2), content: `child ((${REF}))`, children: [] }]
});

function setup() {
  const graph = fakeRefGraph({
    pages: ['Beta'],
    blocks: [
      { uuid: REF, content: 'quoted words', page: 'Beta' },
      { uuid: embedded, content: 'embedded root', page: 'Beta' },
      { uuid: uuidN(9), content: 'embedded child', page: 'Beta', parent: embedded }
    ]
  });
  (graph.client.callAPI as any).mockImplementation(async () => block());
  return graph;
}

describe('getBlock resolve_refs', () => {
  it('off: same call and same output as before, no Datalog', async () => {
    const { client, executeDatalogQuery } = setup();
    const result = await getBlock(client, ROOT, true);
    expect(client.callAPI).toHaveBeenCalledTimes(1);
    expect(client.callAPI).toHaveBeenCalledWith('logseq.Editor.getBlock', [ROOT, { includeChildren: true }]);
    expect(executeDatalogQuery).not.toHaveBeenCalled();
    expect(result).toEqual(block());
    expect(JSON.stringify(result)).not.toMatch(/resolved|warnings|hasMore/);
  });

  it('on: resolves refs and embeds in the block and its children with a single batched query', async () => {
    const { client, executeDatalogQuery } = setup();
    const result = await getBlock(client, ROOT, true, { resolveRefs: true });

    expect(client.callAPI).toHaveBeenCalledTimes(1);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1); // <= depth + 1, here exactly one level
    expect(result.content).toBe(block().content);
    expect(result.resolvedContent).toBe('quote quoted words and embedded root\n  - embedded child');
    expect(result.resolvedRefs!.map(r => [r.uuid, r.embed ?? null, r.status])).toEqual([
      [REF, null, 'ok'],
      [embedded, 'block', 'ok']
    ]);
    expect((result.children![0] as any).resolvedContent).toBe('child quoted words');
    expect(result.warnings).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('on, without children: resolves the block itself', async () => {
    const { client } = setup();
    (client.callAPI as any).mockImplementation(async () => ({ ...block(), children: undefined }));
    const result = await getBlock(client, ROOT, false, { resolveRefs: true });
    expect(result.resolvedContent).toContain('quoted words');
    expect(result.children).toBeUndefined();
  });

  it('on: a deleted target is left in place and marked missing', async () => {
    const { client } = setup();
    (client.callAPI as any).mockImplementation(async () => ({
      ...block(),
      content: `gone ((${uuidN(99)}))`,
      children: []
    }));
    const result = await getBlock(client, ROOT, false, { resolveRefs: true });
    expect(result.resolvedContent).toBe(`gone ((${uuidN(99)}))`);
    expect(result.resolvedRefs![0].status).toBe('missing');
  });
});
