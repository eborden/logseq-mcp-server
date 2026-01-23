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
