// Entity reference (can be numeric ID or full entity)
export interface IEntityID {
  id: number;
}

// Block entity structure
export interface BlockEntity {
  id: number;
  uuid: string;
  content: string;
  format?: 'markdown' | 'org';
  page: IEntityID;
  parent: IEntityID;
  left: IEntityID;
  level?: number;
  children?: BlockEntity[];
  properties?: Record<string, any>;
  unordered?: boolean;
  meta?: {
    startPos?: number;
    endPos?: number;
    properties?: any;
    timestamps?: any;
  };
  // Additional properties from search/query results
  pathRefs?: IEntityID[]; // Path of entity references from root to this block
  refs?: IEntityID[]; // Page references in block content (e.g., [[PageName]])
  marker?: string; // TODO/DONE/etc status
  'journal?'?: boolean; // Whether this is a journal block
  journalDay?: number; // Journal date in YYYYMMDD format
  scheduled?: number; // Scheduled date in YYYYMMDD format
  deadline?: number; // Deadline date in YYYYMMDD format
  // Added only when a tool is called with resolve_refs (#18); `content` is never changed
  resolvedContent?: string;
  resolvedRefs?: ResolvedRef[];
}

// Page entity structure
export interface PageEntity {
  id: number;
  'db/id'?: number; // Datalog queries return db/id instead of id
  uuid: string;
  name: string;
  originalName: string;
  'original-name'?: string; // Datalog queries use kebab-case
  properties?: Record<string, any>;
  journal?: boolean;
  'journal?'?: boolean; // Logseq uses this property name
  journalDay?: number;
  namespace?: IEntityID;
  /** Set when the page is backed by a file; absent on stub pages that only exist as link targets */
  file?: IEntityID;
  children?: (PageEntity | BlockEntity)[];
  updatedAt?: number;
}

// LogSeq API request/response types
export interface LogseqAPIRequest {
  method: string;
  args?: any[];
}

export interface LogseqAPIResponse<T = any> {
  data?: T;
  error?: {
    message: string;
    code?: string;
  };
}

// Configuration
export interface LogseqMCPConfig {
  apiUrl: string;
  authToken: string;
  /** Per-request timeout in milliseconds. Defaults to 30000 when omitted. */
  timeoutMs?: number;
  /** Next-step tips in results (#44). On unless set to `false`. `LOGSEQ_MCP_TIPS` (`on`/`off` and variants) overrides this; other values are an error. */
  tips?: boolean;
}

// Graph info structure
export interface GraphInfo {
  url: string;
  name: string;
  path: string;
}

// Pagination metadata for paginated results
export interface PaginationMetadata {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// Generic paginated result wrapper
export interface PaginatedResult<T> {
  results: T[];
  pagination: PaginationMetadata;
}

// Slim types for reduced token usage

/**
 * SlimBlock - Essential block data only (60-70% token reduction)
 * Removes: id, page object, parent, left, level, pathRefs, refs objects, meta, format
 * Keeps: uuid, content, properties, marker, children (recursively slimmed)
 * Adds: pageName (denormalized), tags/pageRefs (extracted strings)
 * Leaves out empty fields (#42), such as a blank `pageName`.
 */
export interface SlimBlock {
  uuid: string;
  content: string;
  pageName?: string;
  properties?: Record<string, any>;
  marker?: string;
  tags?: string[];
  pageRefs?: string[];
  /** Present only with resolve_refs, on blocks that hold a `((uuid))` ref or `{{embed}}` */
  resolvedContent?: string;
  resolvedRefs?: ResolvedRef[];
  children?: SlimBlock[];
}

/**
 * SlimPage - Essential page data only (50-60% token reduction)
 * Removes: id, uuid, timestamps, namespace
 * Keeps: name, originalName, properties, journal metadata
 */
export interface SlimPage {
  name: string;
  originalName: string;
  properties?: Record<string, any>;
  isJournal?: boolean;
  journalDate?: number;
}

// Resolved block refs and embeds (#18)

/**
 * - `ok`: found; its text is in `resolvedContent`
 * - `missing`: no such block or page (deleted?); the reference is left as written
 * - `depth_limit`: not followed, because it sits deeper than the depth limit
 * - `cycle`: not followed, because it is already being expanded on this path
 */
export type RefStatus = 'ok' | 'missing' | 'depth_limit' | 'cycle';

/**
 * One `((uuid))` ref, `{{embed ((uuid))}}` or `{{embed [[page]]}}` found in a block.
 * `uuid` is the address to pass to logseq_get_block; page embeds have none.
 */
export interface ResolvedRef {
  uuid?: string;
  /** Set for embeds; absent for a plain `((uuid))` ref */
  embed?: 'block' | 'page';
  /** Text of the target, with its own refs resolved inline; null unless `ok` */
  content: string | null;
  /** Page the target block is on (the page itself for a page embed); null if unknown */
  page: string | null;
  status: RefStatus;
}

// Capped or partial results (#40)

/**
 * A non-fatal note about a result that is capped or partial. Connection,
 * timeout, auth and unexpected errors are never warnings: they propagate.
 */
export interface ResultWarning {
  /** Stable machine-readable code, e.g. `results_truncated` */
  code: string;
  message: string;
  /** How to get the rest: the tool parameter to raise and a suggested value */
  howToFetchAll?: string;
}

/**
 * Shared convention for any tool that caps its output.
 *
 * - `hasMore` is true only when results were cut off AND a warning says how
 *   to continue (`howToFetchAll`). Under the cap it is false.
 * - `warnings` is always present; empty when nothing was cut.
 * - `totals` holds real counts, only where the tool already had them (no
 *   extra API call just to count).
 *
 * Tools that return an object add these fields to it. Tools that return a bare
 * array keep the array as the first content block and send `{ "meta": ... }` as
 * a second one, so the array shape is unchanged.
 */
export interface ResultMeta {
  hasMore: boolean;
  warnings: ResultWarning[];
  totals?: Record<string, number>;
  /**
   * Suggested next calls (#44), e.g. `logseq_get_backlinks {"page_name":"Alice"}`.
   * Added by the server handler after the tool returns, only when tips are on,
   * and never by the tools themselves. Advice, not data.
   */
  tips?: string[];
}

/**
 * Meta fields a tool adds to its result object when `resolve_refs` is on: the
 * same `hasMore` / `warnings` as {@link ResultMeta}, without `totals`. Absent
 * when `resolve_refs` is off, so default output is unchanged.
 */
export type ResolveRefsMeta = Partial<Pick<ResultMeta, 'hasMore' | 'warnings'>>;

// Page resolution (#41)

/** How a page name was matched to a page. `name` is the exact, case-insensitive match. */
export type PageMatchReason = 'name' | 'alias' | 'journal-date' | 'namespace-leaf';

/**
 * Says that a tool used another page than the one named: how the name matched
 * (`alias`, `journal-date`, `namespace-leaf`) and the page it resolved to.
 * Absent for exact matches.
 */
export interface PageResolvedFrom {
  /** The name the caller passed */
  name: string;
  matchedBy: PageMatchReason;
  /** Original-case name of the page that was used */
  resolvedTo: string;
}

/** One page a name could refer to, when it is ambiguous. */
export interface PageCandidate {
  /** Lowercased `:block/name`, safe to pass back to any page-taking tool */
  name: string;
  originalName: string;
  matchedBy: PageMatchReason;
  /** Why this page matched, in words */
  reason: string;
}
