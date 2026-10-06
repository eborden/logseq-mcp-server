import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_MAX_FANOUT, DEFAULT_MAX_NODES } from './tools/get-concept-network.js';
import { DEFAULT_MAX_BLOCKS, DEFAULT_MAX_REFERENCES, DEFAULT_MAX_RELATED_PAGES } from './tools/build-context.js';
import { HUB_PAGE, JOURNAL_FILE, buildHubFixture, hubFixtureCounts } from '../scripts/fixture-hub/hub-graph.js';

// The hub fixture (#89): the committed files match their generator, the counts documented in
// tests/fixtures/graph/README.md hold when the files are read back as a link graph, and the hub is
// big enough to pass every default cap.

const graphDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests/fixtures/graph');

/** page name -> the names it links, one entry per block holding a link, read back from the committed files. */
function readLinks(dir: 'pages' | 'journals'): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const file of readdirSync(join(graphDir, dir)).filter(f => f.endsWith('.md'))) {
    const links: string[] = [];
    for (const line of readFileSync(join(graphDir, dir, file), 'utf8').split('\n')) {
      const names = [...line.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
      if (names.length > 0) links.push(...names);
    }
    result.set(basename(file, '.md'), links);
  }
  return result;
}

describe('hub fixture files', () => {
  it('match what scripts/generate-hub-fixture.ts writes', () => {
    for (const [path, content] of buildHubFixture()) {
      expect(existsSync(join(graphDir, path)), `${path} is missing; run npx tsx scripts/generate-hub-fixture.ts`).toBe(true);
      expect(readFileSync(join(graphDir, path), 'utf8'), path).toBe(content);
    }
  });

  it('have no stray hub or neighbour pages the generator does not write', () => {
    const owned = new Set(buildHubFixture().keys());
    const strays = readdirSync(join(graphDir, 'pages'))
      .filter(name => name === `${HUB_PAGE}.md` || name.startsWith('neighbour-'))
      .filter(name => !owned.has(`pages/${name}`));
    expect(strays).toEqual([]);
  });

  it('keep the journal dated 2025 or earlier, so .gitignore does not hide it', () => {
    expect(JOURNAL_FILE).toMatch(/^journals\/(19|20[01]\d|202[0-5])_\d{2}_\d{2}\.md$/);
  });
});

describe('hub fixture counts', () => {
  const counts = hubFixtureCounts();
  const pages = readLinks('pages');
  const journal = readLinks('journals').get(basename(JOURNAL_FILE, '.md'));
  const hubLinks = pages.get(HUB_PAGE) ?? [];

  it('give the hub the documented outbound neighbours', () => {
    expect(new Set(hubLinks).size).toBe(counts.hubOutbound);
    expect(hubLinks.length).toBe(counts.hubOutbound); // one link per block, no repeats
    expect(readFileSync(join(graphDir, 'pages', `${HUB_PAGE}.md`), 'utf8').split('\n').filter(l => l.startsWith('- ')).length).toBe(
      counts.hubBlocks
    );
  });

  it('give the hub the documented inbound neighbours and blocks', () => {
    const inbound = [...pages].filter(([name, links]) => name !== HUB_PAGE && links.includes(HUB_PAGE));
    expect(inbound.length).toBe(counts.hubInboundPages);
    const inboundBlocks = inbound.reduce((sum, [, links]) => sum + links.filter(l => l === HUB_PAGE).length, 0);
    expect(inboundBlocks + (journal ?? []).filter(l => l === HUB_PAGE).length).toBe(counts.hubInboundBlocks);
  });

  it('have the documented total of distinct non-journal neighbours', () => {
    const inbound = [...pages].filter(([name, links]) => name !== HUB_PAGE && links.includes(HUB_PAGE)).map(([name]) => name);
    expect(new Set([...hubLinks, ...inbound]).size).toBe(counts.neighbours);
    expect(counts.neighbours).toBe(120);
  });

  it('link the second ring and the journal topics from nothing but the neighbours and the journal', () => {
    const fringe = new Set<string>();
    for (const [name, links] of pages) {
      for (const link of links.filter(l => l.startsWith('fringe-'))) {
        expect(name, `${name} links ${link}`).toMatch(/^neighbour-(out|both)-/);
        fringe.add(link);
      }
    }
    expect(fringe.size).toBe(counts.fringe);
    const topics = new Set((journal ?? []).filter(l => l.startsWith('journal-topic-')));
    expect(topics.size).toBe(counts.journalTopics);
    for (const [name, links] of pages) {
      expect(links.some(l => l.startsWith('journal-topic-')), name).toBe(false);
    }
  });

  it('exceed every default cap', () => {
    expect(counts.neighbours).toBeGreaterThan(DEFAULT_MAX_NODES);
    expect(counts.hubOutbound).toBeGreaterThan(DEFAULT_MAX_FANOUT);
    expect(counts.hubBlocks).toBeGreaterThan(DEFAULT_MAX_BLOCKS);
    expect(counts.hubInboundBlocks).toBeGreaterThan(DEFAULT_MAX_REFERENCES);
    expect(counts.hubInboundPages + 1).toBeGreaterThan(DEFAULT_MAX_RELATED_PAGES);
    // Depth 2 can fill the node budget: the 15 pages kept at depth 1 reach at least 34 fresh pages
    expect(counts.fringe).toBeGreaterThanOrEqual(DEFAULT_MAX_NODES - 1 - DEFAULT_MAX_FANOUT);
  });
});
