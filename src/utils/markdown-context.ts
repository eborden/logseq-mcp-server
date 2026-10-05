import type { TopicQueryContext } from '../tools/get-context-for-query.js';
import type { TopicContext } from '../tools/build-context.js';
import { buildBlockTrees } from './block-tree.js';
import {
  isObj,
  Obj,
  pageLink,
  pageTitle,
  renderOutline,
  renderProperties,
  resolvedFromLine,
} from './markdown.js';

/**
 * Markdown for the context tools (#43), built on the shared pieces in
 * `markdown.ts`: `build_context`, `get_context_for_query` and
 * `get_concept_network`. Same conventions: `[[Page]]` links, `- ` bullets,
 * `((uuid))` refs untouched. Warnings, `hasMore` and tips are not rendered here;
 * the handler adds them with `withFooter`.
 */

export interface ContextRenderOptions {
  /** Block snippets and uuids instead of bodies */
  compact?: boolean;
  /** Heading level of the title (default 1); sections go one level below it */
  headingLevel?: number;
}

const heading = (level: number, text: string) => `${'#'.repeat(Math.min(level, 6))} ${text}`;

/** `shown`, or `shown of total` when the tool cut the list and knows the real count. */
const count = (shown: number, total?: number) =>
  total !== undefined && total > shown ? `${shown} of ${total}` : String(shown);

/**
 * The topic's blocks as a tree. `directBlocks` are flat Datalog pulls, in query
 * order; the `:block/parent` and `:block/left` links give back the page's order and
 * nesting. A block whose parent was cut by `max_blocks` is shown as a top-level one,
 * and a pull with neither link is too, so nothing is dropped.
 */
function blockTree(blocks: Obj[], pageId: number): Obj[] {
  const withPage = blocks.map(b => (b.page || b.parent ? b : { ...b, page: { id: pageId } }));
  const trees = buildBlockTrees(withPage as any[], [pageId]);
  return [...trees.values()].flat();
}

/** Reference blocks grouped by the page they sit on, in first-seen order. */
function groupBySource(references: Obj[]): Array<{ page: Obj; blocks: Obj[] }> {
  const groups = new Map<string, { page: Obj; blocks: Obj[] }>();
  for (const ref of references) {
    const page = isObj(ref.sourcePage) ? ref.sourcePage : {};
    const key = String(page.id ?? page['db/id'] ?? pageTitle(page));
    const group = groups.get(key) ?? { page, blocks: [] };
    group.blocks.push(ref.block);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * A topic's context: title, page properties, its blocks, related pages, and the
 * blocks that reference it grouped by source page.
 */
export function renderTopicContext(
  context: TopicQueryContext & { totals?: TopicContext['totals'] },
  options: ContextRenderOptions = {}
): string {
  const { compact = false, headingLevel = 1 } = options;
  const main: Obj = isObj(context.mainPage) ? context.mainPage : {};
  const lines: string[] = [heading(headingLevel, pageTitle(main, context.topic)), ''];

  const note = resolvedFromLine(context.resolvedFrom);
  if (note) lines.push(note, '');
  if (context.temporalContext?.isJournal && context.temporalContext.date !== undefined) {
    lines.push(`Journal: ${context.temporalContext.date}`, '');
  }
  const props = renderProperties(main.properties);
  if (props.length > 0) lines.push(...props, '');

  const section = headingLevel + 1;

  // Blocks
  const blocks = context.directBlocks as Obj[];
  if (blocks.length === 0) {
    lines.push('(this page has no blocks)', '');
  } else {
    const pageId = main.id ?? main['db/id'] ?? 0;
    // Properties are rendered above, so the block that holds them is not repeated
    const outline = renderOutline(blockTree(blocks, pageId), { compact, skipPreBlocks: props.length > 0 });
    lines.push(heading(section, `Blocks (${count(blocks.length, context.totals?.blocks)})`), '', ...outline.lines, '');
  }

  // Related pages
  if (context.relatedPages.length > 0) {
    const links = context.relatedPages.map(r => {
      const link = pageLink(r.page);
      return r.relationshipType === 'inbound' ? link : `${link} (${r.relationshipType})`;
    });
    lines.push(
      heading(section, `Related pages (${count(links.length, context.totals?.relatedPages)})`),
      '',
      links.join(', '),
      ''
    );
  }

  // References, grouped by source page
  if (context.references.length > 0) {
    lines.push(heading(section, `References (${count(context.references.length, context.totals?.references)})`), '');
    for (const group of groupBySource(context.references as Obj[])) {
      lines.push(heading(section + 1, pageLink(group.page)), '');
      // One bullet per referencing block; its own children are not part of the reference
      const outline = renderOutline(
        group.blocks.map(block => ({ ...block, children: [] })),
        { compact }
      );
      lines.push(...outline.lines, '');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
