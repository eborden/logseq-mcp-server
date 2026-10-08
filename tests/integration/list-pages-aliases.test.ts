import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { listPages } from './helpers/tools.js';
import { MAX_LIST_PAGES_LIMIT } from './helpers/caps.js';
import type { ListPagesResult, PageEntity } from './helpers/types.js';
import { connectFixture, recordCalls } from './helpers/fixture-client.js';

/**
 * Aliases nested in logseq_list_pages (#171), against the fixture graph.
 *
 * Read-only. The fixture has two alias groups (tests/fixtures/README.md, "Page resolution and
 * aliases"): `project atlas` declares `alias:: atlas`, which no other page declares, and
 * `project borealis` and `project cascade` both declare `alias:: roadmap`, so `roadmap` is an
 * ambiguous alias that resolves to neither. `alice` and `bob` are pages with a file and no alias.
 * LogSeq makes a stub page, with no file, for each alias name.
 */

describe('logseq_list_pages nests aliases (#171), against the fixture graph', () => {
  let client: LogseqClient;
  let calls: string[];
  let all: ListPagesResult;
  let nonJournalPages: number;

  const names = (result: ListPagesResult) => result.pages.map(page => page.name);
  const entry = (result: ListPagesResult, name: string) => result.pages.find(page => page.name === name);

  beforeAll(async () => {
    ({ client } = await connectFixture());
    // Counted before the call recorder is installed, so it is not part of the call counts below
    const everyPage = (await client.callAPI<PageEntity[] | null>('logseq.Editor.getAllPages')) ?? [];
    nonJournalPages = everyPage.filter(page => !(page.journal || page['journal?'])).length;
    ({ calls } = recordCalls(client));
    all = await listPages(client, { limit: MAX_LIST_PAGES_LIMIT });
  });

  it('nests the alias under the page that declares it, and lists it nowhere else', () => {
    expect(entry(all, 'project atlas')?.aliases).toEqual(['atlas']);
    expect(names(all)).not.toContain('atlas');
  });

  it('lists an alias that two pages declare under both, and not on its own', () => {
    expect(entry(all, 'project borealis')?.aliases).toEqual(['roadmap']);
    expect(entry(all, 'project cascade')?.aliases).toEqual(['roadmap']);
    expect(names(all)).not.toContain('roadmap');
  });

  it('leaves the aliases key off pages that have none', () => {
    for (const name of ['alice', 'bob']) {
      const page = all.pages.find(candidate => candidate.name.toLowerCase() === name);
      expect(page, `a page named ${name}`).toBeDefined();
      expect(page).not.toHaveProperty('aliases');
    }
    expect(all.pages.filter(page => page.aliases).map(page => page.name)).toEqual([
      'project atlas',
      'project borealis',
      'project cascade',
    ]);
  });

  it('counts canonical pages: every non-journal page except the two alias stubs', () => {
    expect(nonJournalPages, 'the unfiltered list fits under the maximum').toBeLessThanOrEqual(MAX_LIST_PAGES_LIMIT);
    expect(all.total).toBe(nonJournalPages - 2);
    expect(all.pages).toHaveLength(all.total);
    expect(all.hasMore).toBeUndefined();
  });

  it('sorts by page name, with no duplicate pages', () => {
    const listed = names(all);
    expect(new Set(listed).size).toBe(listed.length);
    const sorted = [...listed].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    expect(listed.map(name => name.toLowerCase())).toEqual(sorted.map(name => name.toLowerCase()));
  });

  it('name_contains on an alias returns the page that declares it, with its alias list', async () => {
    const result = await listPages(client, { nameContains: 'ATLAS' });

    expect(entry(result, 'project atlas')).toEqual({ name: 'project atlas', aliases: ['atlas'] });
    expect(result.pages.every(page => page.name.toLowerCase().includes('atlas') || page.aliases?.includes('atlas'))).toBe(true);
    expect(result.total).toBe(result.pages.length);
  });

  it('name_contains on an ambiguous alias returns both pages that declare it', async () => {
    const result = await listPages(client, { nameContains: 'roadmap' });

    expect(result).toEqual({
      pages: [
        { name: 'project borealis', aliases: ['roadmap'] },
        { name: 'project cascade', aliases: ['roadmap'] },
      ],
      total: 2,
    });
  });

  it('limit takes pages, not aliases, and offset continues at the next page', async () => {
    const start = names(all).indexOf('project atlas');
    const window = await listPages(client, { limit: 1, offset: start });

    expect(window.pages).toEqual([{ name: 'project atlas', aliases: ['atlas'] }]);
    expect(window.total).toBe(all.total);
    expect(window.hasMore).toBe(true);
    expect(window.warnings?.map(warning => warning.code)).toEqual(['pages_truncated']);
    expect((await listPages(client, { limit: 1, offset: start + 1 })).pages[0]).toEqual(all.pages[start + 1]);
  });

  it('makes one API call, with or without a filter', async () => {
    calls.length = 0;
    await listPages(client, { limit: MAX_LIST_PAGES_LIMIT });
    expect(calls).toEqual(['logseq.Editor.getAllPages']);

    calls.length = 0;
    await listPages(client, { nameContains: 'roadmap' });
    expect(calls).toEqual(['logseq.Editor.getAllPages']);
  });
});
