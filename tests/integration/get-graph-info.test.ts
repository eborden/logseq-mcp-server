import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { getGraphInfo } from '../../src/tools/get-graph-info.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * get_graph_info against the fixture graph. LogSeq names a graph after its folder, so the fixture
 * is `graph`, opened from the instance's copy or some checkout's tests/fixtures/graph. Which is not asserted:
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
    // The instance opens its copy, .logseq-instance/graph (#151); your own LogSeq opens tests/fixtures/graph
    expect(
      result.path.endsWith('/.logseq-instance/graph') || result.path.endsWith('/tests/fixtures/graph'),
      'the path is the instance\'s copy or a tests/fixtures/graph folder'
    ).toBe(true);
    expect(result.url === `logseq_local_${result.path}`, 'the url is the local url of that path').toBe(true);
  });

  it('should return consistent results on multiple calls', async () => {
    const result1 = await getGraphInfo(client);
    const result2 = await getGraphInfo(client);

    expect(result1).toEqual(result2);
  });
});
