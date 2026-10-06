import { describe, it, expect, beforeAll } from 'vitest';
import { access } from 'fs/promises';
import { loadConfig, resolveConfigPath } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { DatalogQueryBuilder } from '../../src/datalog/queries.js';
import { discoverPages, DiscoveredPage } from './helpers/discovery.js';

/**
 * Integration tests for :in inputs (issue #6)
 *
 * Verifies end to end that builders' :in queries run against a real LogSeq,
 * that casing does not matter, and that names containing characters that
 * used to break embedded queries are handled as plain data.
 *
 * Requires LogSeq running with the HTTP API enabled and at least one page.
 * See tests/integration/setup.md. Read-only: nothing is written to the graph.
 */

describe('Datalog :in inputs Integration Tests', () => {
  let client: LogseqClient;
  let page: DiscoveredPage;

  beforeAll(async () => {
    const configPath = resolveConfigPath();

    try {
      await access(configPath);
    } catch {
      throw new Error(
        'Config file not found at ~/.logseq-mcp/config.json. ' +
        'Integration tests require LogSeq configuration. ' +
        'See tests/integration/setup.md for setup instructions.'
      );
    }

    client = new LogseqClient(await loadConfig(configPath));

    try {
      await client.callAPI('logseq.App.getCurrentGraph');
    } catch (error) {
      throw new Error(
        `Cannot connect to LogSeq HTTP API: ${error instanceof Error ? error.message : 'Unknown error'}\n` +
        'Ensure LogSeq is running with HTTP server enabled. ' +
        'See tests/integration/setup.md'
      );
    }

    const pages = await discoverPages(client, 1);
    expect(pages.length).toBeGreaterThan(0,
      'No pages found in LogSeq graph. Create at least one page. ' +
      'See tests/integration/setup.md'
    );
    page = pages[0];
  });

  async function run({ query, inputs }: { query: string; inputs: unknown[] }) {
    return client.executeDatalogQuery<any[]>(query, ...inputs);
  }

  it('getPage finds a discovered page through the :in path', async () => {
    const rows = await run(DatalogQueryBuilder.getPage(page.name));

    expect(rows).toHaveLength(1);
    expect(rows[0][0].id ?? rows[0][0]['db/id']).toBe(page.id);
  });

  it('getPage is case-insensitive', async () => {
    const lower = await run(DatalogQueryBuilder.getPage(page.name.toLowerCase()));
    const upper = await run(DatalogQueryBuilder.getPage(page.name.toUpperCase()));

    expect(lower).toHaveLength(1);
    expect(upper).toHaveLength(1);
  });

  it('conceptNetwork depth 0 finds the discovered page', async () => {
    const rows = await run(DatalogQueryBuilder.conceptNetwork(page.name, 0));

    expect(rows).toHaveLength(1);
  });

  it('conceptNetwork depth 1 runs without error', async () => {
    const rows = await run(DatalogQueryBuilder.conceptNetwork(page.name, 1));

    expect(Array.isArray(rows)).toBe(true);
  });

  it('getPageBlocks and getBlocksReferencingPage run without error', async () => {
    const blocks = await run(DatalogQueryBuilder.getPageBlocks(page.name));
    const refs = await run(DatalogQueryBuilder.getBlocksReferencingPage(page.name));

    expect(Array.isArray(blocks)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
  });

  // These names used to produce "Unexpected EOF reading string" or a
  // malformed query. As :in inputs they are just strings that match no page.
  it.each([
    ['a double quote', 'foo "bar'],
    ['a backslash', 'a\\b'],
    ['a newline', 'line1\nline2'],
    ['query-closing characters', 'x"]] [?p :block/name']
  ])('treats a name containing %s as data and finds no page', async (_label, name) => {
    expect(await run(DatalogQueryBuilder.getPage(name))).toHaveLength(0);
    expect(await run(DatalogQueryBuilder.getPageBlocks(name))).toHaveLength(0);
    expect(await run(DatalogQueryBuilder.conceptNetwork(name, 0))).toHaveLength(0);
    expect(await run(DatalogQueryBuilder.conceptNetwork(name, 1))).toHaveLength(0);
    expect(await run(DatalogQueryBuilder.getBlocksReferencingPage(name))).toHaveLength(0);
  });

  it('groundIds batches integer ids in a real query', async () => {
    // Bind ?p straight to the entity id, then require it to be a page
    const query = `[:find (pull ?p [:db/id]) :where ${DatalogQueryBuilder.groundIds([page.id], '?p')} [?p :block/name]]`;
    const rows = await client.executeDatalogQuery<any[]>(query);

    expect(rows).toHaveLength(1);
  });
});
