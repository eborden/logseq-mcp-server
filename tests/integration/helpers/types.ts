/**
 * The shapes the integration suites read out of tool results and LogSeq answers. They are deliberately loose:
 * a suite asserts exact values on the fixture graph, so the type only has to let it reach a field. The server
 * (rust/) is where the real shapes live.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/** What a tool says about a `((uuid))` ref or an embed it resolved (`resolve_refs`, BR-0007). */
export interface ResolvedRef {
  uuid?: string;
  /** Set for embeds; absent for a plain `((uuid))` ref */
  embed?: 'block' | 'page';
  content: string | null;
  page: string | null;
  status: 'ok' | 'missing' | 'depth_limit' | 'cycle' | 'unavailable';
}

/** A page, as the Editor API or a tool sends it. */
export interface PageEntity {
  id: number;
  uuid?: string;
  name: string;
  originalName?: string;
  properties?: Record<string, Json>;
  journalDay?: number;
  children?: Array<PageEntity | BlockEntity>;
  [key: string]: Json;
}

/** A block, as the Editor API or a tool sends it. */
export interface BlockEntity {
  id: number;
  uuid: string;
  content?: string;
  marker?: string;
  properties?: Record<string, Json>;
  propertiesOrder?: string[];
  parent?: { id: number };
  left?: { id: number };
  page?: { id: number; [key: string]: Json };
  refs?: Array<{ id: number; [key: string]: Json }>;
  children?: BlockEntity[];
  resolvedContent?: string;
  resolvedRefs?: ResolvedRef[];
  [key: string]: Json;
}

export interface TopConcept {
  name: string;
  count: number;
  days: number;
}

export type DateRangeResult = Json;
export type ConceptNetworkResult = Json;

export interface ListPagesResult {
  pages: Array<{ name: string; aliases?: string[] }>;
  total: number;
  hasMore?: boolean;
  warnings?: Array<{ code: string; message: string; howToFetchAll?: string; [key: string]: Json }>;
}
