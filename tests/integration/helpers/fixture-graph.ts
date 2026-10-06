import { LogseqClient } from '../../../src/client.js';
import { DatalogQueryBuilder } from '../../../src/datalog/queries.js';

/**
 * Guard for the fixture graph in tests/fixtures/graph (#87).
 *
 * The integration tests are moving to exact assertions against that graph (#86, #90). An exact
 * assertion run against any other graph fails confusingly, or passes by accident, so a test suite
 * calls `requireFixtureGraph` in `beforeAll` and stops with a pointer to setup.md instead.
 *
 * It identifies the fixture by a sentinel page and its `fixture-version` property, not by the graph
 * name: LogSeq names a graph after its folder, and "graph" is not unique.
 */

/** Name of the sentinel page, tests/fixtures/graph/pages/logseq-mcp-fixture-sentinel.md. */
export const FIXTURE_SENTINEL_PAGE = 'logseq-mcp-fixture-sentinel';

/** The `fixture-version` the tests expect. Bump it with the property on the sentinel page. */
export const FIXTURE_VERSION = 1;

const SETUP_POINTER =
  'Open tests/fixtures/graph as its own graph in LogSeq and make it the current graph. ' +
  'See "Fixture graph" in tests/integration/setup.md.';

/** Thrown when the LogSeq API is not serving the fixture graph, or an outdated copy of it. */
export class FixtureGraphError extends Error {
  constructor(message: string) {
    super(`${message} ${SETUP_POINTER}`);
    this.name = 'FixtureGraphError';
  }
}

/**
 * `fixture-version` from a pulled page's properties. Datalog pulls key properties as stored
 * (`fixture-version`) and the Editor API camelCases them (`fixtureVersion`); LogSeq may parse
 * the value as a number or keep it as text. Returns undefined when it is missing or not an integer.
 */
function readFixtureVersion(properties: unknown): number | undefined {
  if (!properties || typeof properties !== 'object') return undefined;
  const props = properties as Record<string, unknown>;
  const raw = props['fixture-version'] ?? props['fixtureVersion'];
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

/**
 * Confirm the LogSeq API is serving the fixture graph at the expected version.
 *
 * API calls: 1 Datalog query. Connection, auth and timeout errors propagate unchanged.
 *
 * @returns the fixture version found on the sentinel page
 * @throws FixtureGraphError if the sentinel page is missing, has no `fixture-version`,
 *   or has a different version than `FIXTURE_VERSION`
 */
export async function requireFixtureGraph(client: LogseqClient): Promise<number> {
  const { query, inputs } = DatalogQueryBuilder.getPage(FIXTURE_SENTINEL_PAGE);
  const rows = await client.executeDatalogQuery<unknown[][] | null>(query, ...inputs);
  const page = rows?.[0]?.[0] as { properties?: unknown } | undefined;

  if (!page) {
    throw new FixtureGraphError(
      `The LogSeq API is not serving the fixture graph: it has no page "${FIXTURE_SENTINEL_PAGE}".`,
    );
  }

  const version = readFixtureVersion(page.properties);
  if (version === undefined) {
    throw new FixtureGraphError(
      `The page "${FIXTURE_SENTINEL_PAGE}" has no integer fixture-version property, ` +
        'so this is not the fixture graph, or LogSeq has not finished indexing it (re-index the graph).',
    );
  }

  if (version !== FIXTURE_VERSION) {
    throw new FixtureGraphError(
      `The open fixture graph is version ${version}, but the tests expect version ${FIXTURE_VERSION}. ` +
        'The graph LogSeq has open is probably another checkout of the repo; open this checkout\'s copy.',
    );
  }

  return version;
}
