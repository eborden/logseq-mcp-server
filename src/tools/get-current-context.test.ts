import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCurrentContext, NO_PAGE_OPEN_MESSAGE } from './get-current-context.js';
import { LogseqClient } from '../client.js';
import { LogSeqNotRunningError, LogSeqTimeoutError } from '../errors.js';

const PAGE = {
  id: 10,
  uuid: 'page-uuid-1',
  name: 'my page',
  originalName: 'My Page',
  'journal?': false
};

function block(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    uuid: 'block-uuid-1',
    content: 'Talking to [[Alice]] about #atlas',
    page: { id: 10 },
    parent: { id: 10 },
    left: { id: 10 },
    ...overrides
  };
}

describe('getCurrentContext', () => {
  let callAPI: ReturnType<typeof vi.fn>;
  let executeDatalogQuery: ReturnType<typeof vi.fn>;
  let client: LogseqClient;

  /** Route the three Editor calls to canned responses. */
  function mockEditor(responses: { page?: unknown; block?: unknown; selected?: unknown }) {
    callAPI.mockImplementation(async (method: string) => {
      switch (method) {
        case 'logseq.Editor.getCurrentPage':
          return responses.page ?? null;
        case 'logseq.Editor.getCurrentBlock':
          return responses.block ?? null;
        case 'logseq.Editor.getSelectedBlocks':
          return responses.selected ?? null;
        default:
          throw new Error(`Unexpected method ${method}`);
      }
    });
  }

  beforeEach(() => {
    callAPI = vi.fn();
    executeDatalogQuery = vi.fn().mockResolvedValue([]);
    client = { callAPI, executeDatalogQuery } as any;
  });

  it('returns the page and the focused block, using the open page for the block page name', async () => {
    mockEditor({ page: PAGE, block: block() });

    const result = await getCurrentContext(client);

    expect(result.page).toEqual({ name: 'my page', originalName: 'My Page' });
    expect(result.message).toBeUndefined();
    expect(result.focusedBlock).toEqual({
      uuid: 'block-uuid-1',
      content: 'Talking to [[Alice]] about #atlas',
      pageName: 'My Page',
      tags: ['atlas'],
      pageRefs: ['Alice']
    });
    expect(result.selectedBlocks).toBeUndefined();
    // Block is on the open page, so no Datalog resolution is needed
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });

  it('returns only the page when no block is focused or selected', async () => {
    mockEditor({ page: PAGE });

    const result = await getCurrentContext(client);

    expect(result).toEqual({ page: { name: 'my page', originalName: 'My Page' } });
    expect(result).not.toHaveProperty('focusedBlock');
    expect(result).not.toHaveProperty('selectedBlocks');
  });

  it('includes journal metadata for a journal page', async () => {
    mockEditor({ page: { ...PAGE, name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', 'journal?': true, journalDay: 20250101 } });

    const result = await getCurrentContext(client);

    expect(result.page).toMatchObject({ isJournal: true, journalDate: 20250101 });
  });

  it('returns a "no page open" result, not an error, when nothing is open', async () => {
    mockEditor({});

    const result = await getCurrentContext(client);

    expect(result).toEqual({ page: null, message: NO_PAGE_OPEN_MESSAGE });
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });

  it('treats an empty selection like no selection', async () => {
    mockEditor({ page: PAGE, selected: [] });

    const result = await getCurrentContext(client);

    expect(result).not.toHaveProperty('selectedBlocks');
  });

  it('resolves a bare {id} block page with one Datalog pull by :db/id', async () => {
    mockEditor({ block: block({ page: { id: 77 } }) });
    executeDatalogQuery.mockResolvedValue([
      [{ 'db/id': 77, name: 'project atlas', 'original-name': 'Project Atlas' }]
    ]);

    const result = await getCurrentContext(client);

    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    const [query] = executeDatalogQuery.mock.calls[0];
    expect(query).toContain('[(ground [77]) [?p ...]]');
    expect(result.focusedBlock?.pageName).toBe('Project Atlas');
    // With no open page, the block's page stands in for it
    expect(result.page).toEqual({ name: 'project atlas', originalName: 'Project Atlas' });
    expect(result.message).toBeUndefined();
  });

  it('resolves all distinct unknown pages in a single Datalog call', async () => {
    mockEditor({
      page: PAGE,
      block: block({ page: { id: 10 } }),
      selected: [
        block({ uuid: 's1', page: { id: 20 } }),
        block({ uuid: 's2', page: { id: 20 } }),
        block({ uuid: 's3', page: { id: 30 } })
      ]
    });
    executeDatalogQuery.mockResolvedValue([
      [{ 'db/id': 20, name: 'bob notes', 'original-name': 'Bob Notes' }],
      [{ 'db/id': 30, name: 'inbox', 'original-name': 'Inbox' }]
    ]);

    const result = await getCurrentContext(client);

    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    expect(executeDatalogQuery.mock.calls[0][0]).toContain('[(ground [20 30]) [?p ...]]');
    expect(result.selectedBlocks?.map(b => b.pageName)).toEqual(['Bob Notes', 'Bob Notes', 'Inbox']);
    expect(result.focusedBlock?.pageName).toBe('My Page');
  });

  it('drops unfetched ["uuid", "id"] child tuples that the Editor API returns without includeChildren', async () => {
    mockEditor({
      page: PAGE,
      block: block({ children: [['uuid', 'child-uuid-1'], ['uuid', 'child-uuid-2']] })
    });

    const result = await getCurrentContext(client);

    expect(result.focusedBlock).toBeDefined();
    expect(result.focusedBlock).not.toHaveProperty('children');
  });

  it('keeps children that are real block entities', async () => {
    mockEditor({
      page: PAGE,
      block: block({ children: [block({ uuid: 'child-1', content: 'child content' })] })
    });

    const result = await getCurrentContext(client);

    expect(result.focusedBlock?.children).toHaveLength(1);
    expect(result.focusedBlock?.children![0]).toMatchObject({ uuid: 'child-1', pageName: 'My Page' });
  });

  it('returns selected blocks', async () => {
    mockEditor({
      page: PAGE,
      selected: [block({ uuid: 's1', content: 'first' }), block({ uuid: 's2', content: 'TODO second', marker: 'TODO' })]
    });

    const result = await getCurrentContext(client);

    expect(result.selectedBlocks).toHaveLength(2);
    expect(result.selectedBlocks![0]).toMatchObject({ uuid: 's1', content: 'first', pageName: 'My Page' });
    expect(result.selectedBlocks![1]).toMatchObject({ uuid: 's2', marker: 'TODO' });
  });

  it('treats a block returned by getCurrentPage (zoomed in) as the focused block', async () => {
    mockEditor({ page: block({ page: { id: 77 } }) });
    executeDatalogQuery.mockResolvedValue([
      [{ 'db/id': 77, name: 'project atlas', 'original-name': 'Project Atlas' }]
    ]);

    const result = await getCurrentContext(client);

    expect(result.page?.originalName).toBe('Project Atlas');
    expect(result.focusedBlock?.uuid).toBe('block-uuid-1');
  });

  it('leaves the page name out when the Datalog pull finds nothing', async () => {
    mockEditor({ block: block({ page: { id: 77 } }) });
    executeDatalogQuery.mockResolvedValue(null);

    const result = await getCurrentContext(client);

    expect(result.focusedBlock).not.toHaveProperty('pageName');
    expect(result.page).toBeNull();
  });

  it('makes exactly 3 Editor calls and no Datalog call when blocks are on the open page', async () => {
    mockEditor({ page: PAGE, block: block(), selected: [block({ uuid: 's1' })] });

    await getCurrentContext(client);

    expect(callAPI.mock.calls.map(c => c[0]).sort()).toEqual([
      'logseq.Editor.getCurrentBlock',
      'logseq.Editor.getCurrentPage',
      'logseq.Editor.getSelectedBlocks'
    ]);
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });

  it('makes at most 4 calls in total, even with several unresolved pages', async () => {
    mockEditor({
      block: block({ page: { id: 1 } }),
      selected: [block({ uuid: 's1', page: { id: 2 } }), block({ uuid: 's2', page: { id: 3 } })]
    });

    await getCurrentContext(client);

    // 3 Editor calls (callAPI mock) + 1 Datalog call (executeDatalogQuery mock)
    expect(callAPI).toHaveBeenCalledTimes(3);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
  });

  it('never calls getAllPages or the nonexistent getEditingBlockSelection', async () => {
    mockEditor({ page: PAGE, block: block() });

    await getCurrentContext(client);

    const methods = callAPI.mock.calls.map(c => c[0]);
    expect(methods).not.toContain('logseq.Editor.getAllPages');
    expect(methods).not.toContain('logseq.Editor.getEditingBlockSelection');
  });

  it('propagates a LogSeqNotRunningError', async () => {
    callAPI.mockRejectedValue(new LogSeqNotRunningError('http://localhost:12315'));

    await expect(getCurrentContext(client)).rejects.toBeInstanceOf(LogSeqNotRunningError);
  });

  it('propagates a LogSeqTimeoutError from the page-resolution query', async () => {
    mockEditor({ block: block({ page: { id: 77 } }) });
    executeDatalogQuery.mockRejectedValue(new LogSeqTimeoutError('http://localhost:12315', 30000));

    await expect(getCurrentContext(client)).rejects.toBeInstanceOf(LogSeqTimeoutError);
  });
});
