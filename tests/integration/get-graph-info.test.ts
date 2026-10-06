import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { getGraphInfo } from '../../src/tools/get-graph-info.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * get_graph_info against the fixture graph. LogSeq names a graph after its folder, so the fixture
 * is `graph`, opened from some checkout's tests/fixtures/graph. Which checkout is not asserted:
 * the path includes the user's home directory, and nothing here prints it.
 */
describe('getGraphInfo - Integration', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  it('names the fixture graph and its folder', async () => {
    const result = await getGraphInfo(client);

    expect(result.name).toBe('graph');
    expect(result.path.startsWith('/'), 'the path is absolute').toBe(true);
    expect(result.path.endsWith('/tests/fixtures/graph'), 'the path is a tests/fixtures/graph folder').toBe(true);
    expect(result.url === `logseq_local_${result.path}`, 'the url is the local url of that path').toBe(true);
  });

  it('should return consistent results on multiple calls', async () => {
    const result1 = await getGraphInfo(client);
    const result2 = await getGraphInfo(client);

    expect(result1).toEqual(result2);
  });
});
