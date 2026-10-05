import type { ConceptNetworkResult } from '../tools/get-concept-network.js';
import type { QueryContext, TopicQueryContext } from '../tools/get-context-for-query.js';
import type { TopicContext } from '../tools/build-context.js';
import { buildBlockTrees } from './block-tree.js';
import {
  isObj,
  Obj,
  pageLink,
  pageTitle,
  renderOutline,
  propertyLines,
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
  const blocks = context.directBlocks as Obj[];
  const pageId = main.id ?? main['db/id'] ?? 0;
  const tree = blocks.length > 0 ? blockTree(blocks, pageId) : [];
  // The pre-block's own text when it was fetched, so keys and values are shown as stored
  const props = propertyLines(main.properties, tree);
  if (props.lines.length > 0) lines.push(...props.lines, '');

  const section = headingLevel + 1;

  // Blocks
  if (blocks.length === 0) {
    lines.push('(this page has no blocks)', '');
  } else {
    // Properties are rendered above, so the block that holds them is not repeated
    const outline = renderOutline(tree, { compact, skipPreBlocks: props.fromPreBlock });
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

/**
 * Context for a natural-language query: the topics found, each topic's context one
 * heading level down, and the keyword search results when the query named no topic.
 */
export function renderQueryContext(context: QueryContext, options: Pick<ContextRenderOptions, 'compact'> = {}): string {
  const { compact = false } = options;
  const lines: string[] = [`# Context for: ${context.query}`, ''];
  if (context.extractedTopics.length > 0) {
    lines.push(`Topics: ${context.extractedTopics.map(t => `[[${t}]]`).join(', ')}`, '');
  }

  const parts = [lines.join('\n').trimEnd()];
  for (const topic of context.contexts) {
    parts.push(renderTopicContext(topic, { compact, headingLevel: 2 }).trimEnd());
  }

  if (context.searchResults !== undefined) {
    const results = context.searchResults as Obj[];
    const outline = renderOutline(
      results.map(block => ({ ...block, children: [] })),
      { compact }
    );
    parts.push(
      [heading(2, `Search results (${results.length})`), '', ...(outline.lines.length > 0 ? outline.lines : ['(no matches)'])].join('\n')
    );
  } else if (context.contexts.length === 0) {
    parts.push('(no results)');
  }

  return `${parts.join('\n\n')}\n`;
}

/**
 * A concept network: the pages grouped by distance from the root, then one line
 * per linked pair. `A -> B` means blocks on A reference B, `A <- B` that blocks on
 * B reference A, and `A <-> B (out/in)` both; the number is the reference count.
 * `A` is always the page closer to the root.
 */
export function renderNetwork(network: ConceptNetworkResult): string {
  const root = network.nodes.find(n => n.depth === 0);
  const lines: string[] = [`# Concept network: [[${root?.name ?? network.concept}]]`, ''];
  const note = resolvedFromLine(network.resolvedFrom);
  if (note) lines.push(note, '');

  const byDepth = new Map<number, string[]>();
  for (const node of network.nodes) {
    if (node.depth === 0) continue;
    byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), `[[${node.name}]]`]);
  }
  if (byDepth.size === 0) lines.push('(no linked pages)', '');
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const names = byDepth.get(depth)!;
    lines.push(`## Depth ${depth} (${names.length})`, '', names.join(', '), '');
  }

  const nameOf = new Map(network.nodes.map(n => [n.id, n.name]));
  const links = network.edges.flatMap(edge => {
    const from = nameOf.get(edge.from);
    const to = nameOf.get(edge.to);
    if (from === undefined || to === undefined) return [];
    const link =
      edge.outbound > 0 && edge.inbound > 0
        ? `<-> [[${to}]] (${edge.outbound}/${edge.inbound})`
        : edge.outbound > 0
          ? `-> [[${to}]] (${edge.outbound})`
          : `<- [[${to}]] (${edge.inbound})`;
    return [`- [[${from}]] ${link}`];
  });
  if (links.length > 0) lines.push(`## Links (${links.length})`, '', ...links, '');

  return `${lines.join('\n').trimEnd()}\n`;
}
