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
 */
export interface SlimBlock {
  uuid: string;
  content: string;
  pageName: string;
  properties?: Record<string, any>;
  marker?: string;
  tags?: string[];
  pageRefs?: string[];
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
}
