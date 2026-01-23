import { BlockEntity, PageEntity, SlimBlock, SlimPage } from '../types.js';

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
 * Transform BlockEntity to SlimBlock (recursively handles children)
 * @param block - Full BlockEntity
 * @param pageName - Page name for denormalization
 * @returns SlimBlock with essential data only
 */
export function toSlimBlock(block: BlockEntity, pageName: string): SlimBlock {
  const slim: SlimBlock = {
    uuid: block.uuid,
    content: block.content,
    pageName
  };

  // Only include non-empty properties
  if (block.properties && Object.keys(block.properties).length > 0) {
    slim.properties = block.properties;
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

  // Recursively transform children
  if (block.children && block.children.length > 0) {
    slim.children = block.children.map(child => toSlimBlock(child, pageName));
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

  // Only include non-empty properties
  if (page.properties && Object.keys(page.properties).length > 0) {
    slim.properties = page.properties;
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
