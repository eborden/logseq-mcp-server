import { BlockEntity, PageEntity, SlimBlock, SlimPage } from '../types.js';

/**
 * Whether tools with a `slim_results` parameter slim their output when the
 * caller doesn't say (#42). `slim_results: false` is the opt-out.
 *
 * The default lives at the MCP boundary: the argument schemas in
 * `src/tool-args.ts` default `slim_results` to this value (#60), and the
 * handlers pass the parsed boolean to the tool function. The tool functions
 * (`searchBlocks`, `queryByProperty`, `queryJournals`) still default their
 * `slimResults` parameter to `false`, so a direct call gets full output. A
 * new slim-capable tool must use the shared `slim_results` schema, or it
 * silently returns full output. `src/index.slim-default.test.ts` pins this.
 */
export const DEFAULT_SLIM_RESULTS = true;

/**
 * Extract [[PageName]] references from block content
 * @param content - Block content text
 * @returns Array of page names (without brackets)
 */
export function extractPageRefs(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
  return Array.from(matches, m => m[1]);
}

/**
 * Extract #tags from block content
 * @param content - Block content text
 * @returns Array of tag names (without # prefix)
 */
export function extractTags(content: string): string[] {
  const matches = content.matchAll(/#([^\s#]+)/g);
  return Array.from(matches, m => m[1]);
}

/**
 * Build a map of page ID to page name for efficient lookups
 * @param pages - Array of PageEntity objects
 * @returns Map of page ID to page name
 */
export function buildPageNameMap(pages: PageEntity[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const page of pages) {
    // Use originalName to preserve casing
    const name = page.originalName || page['original-name'] || page.name;
    map.set(page.id, name);
  }
  return map;
}

/**
 * Get page name from a block's page reference
 * @param block - BlockEntity with page reference
 * @param pageMap - Map of page ID to page name
 * @returns Page name or empty string if not found
 */
export function getPageNameFromBlock(
  block: BlockEntity,
  pageMap: Map<number, string>
): string {
  if (!block.page) {
    return '';
  }

  const pageRef = block.page as any;
  const pageId = pageRef.id || pageRef['db/id'];

  if (!pageId) {
    return '';
  }

  return pageMap.get(pageId) || '';
}

/**
 * A value that says nothing: null, undefined, an empty or blank string, an empty
 * array or an empty plain object. `false` and `0` say something, so they are not empty.
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/**
 * The properties of a block or page without the empty ones, or undefined when
 * none are left (#42). `status:: false` and `count:: 0` stay.
 */
export function nonEmptyProperties(properties: Record<string, any> | undefined | null): Record<string, any> | undefined {
  if (!properties) return undefined;
  const kept = Object.fromEntries(Object.entries(properties).filter(([, value]) => !isEmptyValue(value)));
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * Transform BlockEntity to SlimBlock (recursively handles children)
 *
 * Empty fields are left out (#42): `pageName` when it is blank, `properties` when
 * none have a value. `uuid` and `content` always stay, even for an empty block.
 * Children never carry `pageName`: they sit on their parent's page, which the
 * parent names.
 *
 * @param block - Full BlockEntity
 * @param pageName - Page name for denormalization. Pass '' to leave it out,
 *   e.g. where the surrounding entry already names the page
 * @returns SlimBlock with essential data only
 */
export function toSlimBlock(block: BlockEntity, pageName: string): SlimBlock {
  const slim: SlimBlock = {
    uuid: block.uuid,
    content: block.content
  };

  if (!isEmptyValue(pageName)) {
    slim.pageName = pageName;
  }

  const properties = nonEmptyProperties(block.properties);
  if (properties) {
    slim.properties = properties;
  }

  // Only include marker if present
  if (block.marker) {
    slim.marker = block.marker;
  }

  // Extract and include tags if present
  const tags = extractTags(block.content);
  if (tags.length > 0) {
    slim.tags = tags;
  }

  // Extract and include page refs if present
  const pageRefs = extractPageRefs(block.content);
  if (pageRefs.length > 0) {
    slim.pageRefs = pageRefs;
  }

  // Resolved refs (resolve_refs) ride along on slim blocks too, only when present
  if (block.resolvedContent !== undefined) {
    slim.resolvedContent = block.resolvedContent;
  }
  if (block.resolvedRefs && block.resolvedRefs.length > 0) {
    slim.resolvedRefs = block.resolvedRefs;
  }

  // Recursively transform children
  if (block.children && block.children.length > 0) {
    slim.children = block.children.map(child => toSlimBlock(child, ''));
  }

  return slim;
}

/**
 * Transform PageEntity to SlimPage
 * @param page - Full PageEntity
 * @returns SlimPage with essential data only
 */
export function toSlimPage(page: PageEntity): SlimPage {
  const slim: SlimPage = {
    name: page.name,
    originalName: page.originalName || page['original-name'] || page.name
  };

  // Only include properties that have a value
  const properties = nonEmptyProperties(page.properties);
  if (properties) {
    slim.properties = properties;
  }

  // Only include journal metadata if it's a journal page
  const isJournal = page['journal?'] || page.journal;
  if (isJournal) {
    slim.isJournal = true;
    if (page.journalDay) {
      slim.journalDate = page.journalDay;
    }
  }

  return slim;
}
