/**
 * The defaults and maximums the tools state in their descriptions and `ResultMeta` warnings (ADR-0011, BR-0006).
 * The suites assert the server against these numbers, so a change to a cap fails a test and is a decision
 * (BR-0004). Each is the value the tool's description states and the Rust constant in `rust/src/tools/` holds.
 */

export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_SEARCH_LIMIT = 500;

export const DEFAULT_MAX_SEARCH_RESULTS = 20;
export const MAX_SEARCH_RESULTS = 100;

export const DEFAULT_LIST_PAGES_LIMIT = 200;
export const MAX_LIST_PAGES_LIMIT = 1000;

export const DEFAULT_MAX_ENTRIES = 100;
export const MAX_ENTRIES = 500;

export const DEFAULT_DATE_RANGE_MAX_BLOCKS = 200;
export const MAX_DATE_RANGE_BLOCKS = 1000;

export const DEFAULT_MAX_PAGES = 20;
export const MAX_PAGES = 100;
export const DEFAULT_MAX_BLOCKS_PER_PAGE = 10;
export const MAX_BLOCKS_PER_PAGE = 50;

export const DEFAULT_PROPERTY_LIMIT = 100;
export const MAX_PROPERTY_LIMIT = 500;

export const DEFAULT_RELATIONSHIP_LIMIT = 50;
export const MAX_RELATIONSHIP_LIMIT = 500;

export const DEFAULT_MAX_NODES = 50;
export const DEFAULT_MAX_FANOUT = 15;
export const MAX_NODES_LIMIT = 500;
export const MAX_FANOUT_LIMIT = 100;

export const DEFAULT_MAX_BLOCKS = 50;
export const DEFAULT_MAX_RELATED_PAGES = 10;
export const DEFAULT_MAX_REFERENCES = 20;

/** The pages LogSeq makes itself, which `query_by_date_range` leaves out of `topConcepts` (lowercase `:block/name`). */
export const BUILT_IN_CONCEPTS: ReadonlySet<string> = new Set([
  'todo',
  'doing',
  'done',
  'now',
  'later',
  'waiting',
  'canceled',
  'cancelled',
  'in-progress',
  'card',
]);
