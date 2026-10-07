import type { EditorPage, EntityRef, GraphInfo as WireGraphInfo, WireBlock } from './response-schemas.js';

// What LogSeq sends is described once, by the zod schemas in src/response-schemas.ts (#202). The
// entities below take their fields from them and add the ones a tool derives: `children`, `level`
// and the camelCase fields of a camelized pull. A page of either spelling is `PageLike`.
export type { PageLike, PulledPage } from './response-schemas.js';

// Entity reference: a bare `{ id }`
export type IEntityID = EntityRef;

/**
 * Block entity structure: the fields LogSeq spells the same in both dialects (checked by
 * `blockSchema`), plus the ones a tool adds or a camelized pull carries. `page`, `parent` and
 * `left` are optional because not every query pulls them (the outline's doesn't pull `page`).
 * `page` is a bare `{ id }` from the Editor API, or the page itself when a pull or a tool nested it;
 * read it with `blockPageId` or `pageDisplayName` from `src/utils/entity-fields.ts`.
 */
export interface BlockEntity extends WireBlock {
  level?: number;
  children?: BlockEntity[];
  /**
   * Set when a cap left out some of this block's children: `max_blocks` on `query_by_date_range`,
   * `limit` on `search_by_relationship` with `connected-within`
   */
  childrenTruncated?: boolean;
  /** Property keys in file order. Editor API blocks carry it, and so do pulls camelized by `camelizeBlock` */
  propertiesOrder?: string[];
  unordered?: boolean;
  meta?: {
    startPos?: number;
    endPos?: number;
    properties?: unknown;
    timestamps?: unknown;
  };
  // Additional properties from search/query results
  pathRefs?: IEntityID[]; // Path of entity references from root to this block
  format?: 'markdown' | 'org';
  'journal?'?: boolean; // Whether this is a journal block
  journalDay?: number; // Journal date in YYYYMMDD format
  scheduled?: number; // Scheduled date in YYYYMMDD format
  deadline?: number; // Deadline date in YYYYMMDD format
  // Added only when a tool is called with resolve_refs (#18); `content` is never changed
  resolvedContent?: string;
  resolvedRefs?: ResolvedRef[];
}

/**
 * Page entity structure, as the Editor API sends it (camelCase). A Datalog pull has
 * its own spelling, `PulledPage`; `PageLike` is either.
 */
export interface PageEntity extends EditorPage {
  children?: (PageEntity | BlockEntity)[];
}

// LogSeq API request/response types
export interface LogseqAPIRequest {
  method: string;
  args?: unknown[];
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
export type GraphInfo = WireGraphInfo;

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
 * Leaves out empty fields (#42). `pageName` is also omitted on children and
 * where the surrounding entry names the page.
 */
export interface SlimBlock {
  uuid: string;
  content: string;
  pageName?: string;
  properties?: Record<string, unknown>;
  marker?: string;
  tags?: string[];
  pageRefs?: string[];
  /** Present only with resolve_refs, on blocks that hold a `((uuid))` ref or `{{embed}}` */
  resolvedContent?: string;
  resolvedRefs?: ResolvedRef[];
  /** Present (true) only when a cap (`max_blocks`) left out some of this block's children, so it isn't read as a leaf */
  childrenTruncated?: boolean;
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
  properties?: Record<string, unknown>;
  isJournal?: boolean;
  journalDate?: number;
}

// Resolved block refs and embeds (#18)

/**
 * - `ok`: found; its text is in `resolvedContent`
 * - `missing`: no such block or page (deleted?); the reference is left as written
 * - `depth_limit`: not followed, because it sits deeper than the depth limit
 * - `cycle`: not followed, because it is already being expanded on this path
 * - `unavailable`: not looked up, because LogSeq answered its lookup with `null` (#260, #272, BR-0011);
 *   left as written, never `missing`. The `refs_unavailable` warning counts these.
 */
export type RefStatus = 'ok' | 'missing' | 'depth_limit' | 'cycle' | 'unavailable';

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
