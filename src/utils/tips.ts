/**
 * Next-step tips (#44).
 *
 * After a result the model usually needs one more call (search, then read the
 * page that matched). A tip names that call with ready-to-use arguments. Tips:
 * - are built here from the arguments and the result, never by the tools, so the
 *   primary result keeps its shape;
 * - travel in `meta.tips` (see `metaContent`), in the trailing meta block;
 * - are on by default and can be turned off (see `resolveTipsEnabled` in config.ts);
 * - appear only when there is a concrete next step: nothing for an empty
 *   result (apart from a search miss), nothing for a call that is already the step;
 * - carry at most {@link MAX_TIPS} entries, each one line.
 *
 * Suggested arguments go through `JSON.stringify`, so a name containing quotes,
 * backslashes or newlines stays a valid call.
 */

import type { ResultMeta } from '../types.js';

export const MAX_TIPS = 2;

/** A suggested call: the tool name followed by its arguments as JSON. */
export function suggestCall(tool: string, args: Record<string, unknown>): string {
  return `${tool} ${JSON.stringify(args)}`;
}

const asObject = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, any>) : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * Page name of a block or page-like entity, in the shapes the tools return:
 * slim blocks (`pageName`), search context (`context.page`), property results
 * (`page.originalName`), and plain pages. Undefined when only a bare `{id}` is known.
 */
export function pageNameOf(entity: unknown): string | undefined {
  const e = asObject(entity);
  if (!e) return undefined;
  const page = asObject(e.page);
  const contextPage = asObject(asObject(e.context)?.page);
  return (
    nonEmptyString(e.pageName) ??
    nonEmptyString(contextPage?.originalName) ??
    nonEmptyString(contextPage?.['original-name']) ??
    nonEmptyString(contextPage?.name) ??
    nonEmptyString(page?.originalName) ??
    nonEmptyString(page?.['original-name']) ??
    nonEmptyString(page?.name)
  );
}

/** The most frequent value; the first one seen wins a tie. */
function mostCommon(values: Iterable<string>): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Whether the page behind a block is a journal date page: true or false when the
 * block carries a page entity with a name (search `context.page`, property results),
 * undefined when only a name (slim block) or a bare id is known.
 */
function journalStatus(block: unknown): boolean | undefined {
  const b = asObject(block);
  const page = [asObject(asObject(b?.context)?.page), asObject(b?.page)].find(
    p => p && pageNameOf({ page: p }) !== undefined
  );
  if (!page) return undefined;
  return (
    page.isJournal === true ||
    page.journalDate != null ||
    page['journal?'] === true ||
    page.journal === true ||
    page.journalDay != null ||
    page['journal-day'] != null
  );
}

/** Topic names a block mentions: its #tags and [[page refs]] (slim blocks), and `context.tags`. */
function topicsOf(block: unknown): string[] {
  const b = asObject(block);
  const lists = [b?.tags, b?.pageRefs, asObject(b?.context)?.tags];
  return lists.flatMap(list => (Array.isArray(list) ? list.filter((t): t is string => nonEmptyString(t) !== undefined) : []));
}

/**
 * The topic worth a `build_context` call for a set of hit blocks. Most hits sit on
 * journal date pages, which make the least informative next step, so in order:
 * 1. the page most hits are on, among pages known not to be journals;
 * 2. the #tag or [[ref]] most hits mention (slim hits carry no journal flag);
 * 3. the most common page whose kind is unknown (its journal flag isn't in the hit);
 * 4. a journal page, only when nothing else is available.
 */
function suggestTopic(blocks: unknown[]): { name: string; kind: 'page' | 'topic' } | undefined {
  const named = blocks.flatMap(block => {
    const name = pageNameOf(block);
    return name ? [{ name, journal: journalStatus(block) }] : [];
  });

  const nonJournal = mostCommon(named.filter(n => n.journal === false).map(n => n.name));
  if (nonJournal) return { name: nonJournal, kind: 'page' };

  const topic = mostCommon(blocks.flatMap(topicsOf));
  if (topic) return { name: topic, kind: 'topic' };

  const unknown = mostCommon(named.filter(n => n.journal === undefined).map(n => n.name));
  if (unknown) return { name: unknown, kind: 'page' };

  const journal = mostCommon(named.map(n => n.name));
  return journal ? { name: journal, kind: 'page' } : undefined;
}

/**
 * Tips for one finished tool call. `args` are the tool's parsed arguments (after
 * alias resolution and `parseArgs`, so defaults are filled in and nulls dropped);
 * `result` is the tool's return value; `meta` is the ResultMeta the tool
 * reported, if any (a search uses it to tell a real miss from `limit: 0`). Returns [] when there is
 * nothing useful to add.
 */
export function buildTips(
  tool: string,
  args: Record<string, unknown> | undefined,
  result: unknown,
  meta?: Pick<ResultMeta, 'totals'> | null
): string[] {
  const tips: string[] = [];
  const a = args ?? {};

  switch (tool) {
    case 'logseq_search_blocks': {
      if (!Array.isArray(result)) break;
      if (result.length === 0) {
        // An empty array is a miss only if nothing matched: `limit: 0` also returns [] (totals.matches > 0)
        const matches = meta?.totals?.matches;
        if (typeof matches === 'number' && matches > 0) break;
        const word = nonEmptyString(a.query)?.trim().split(/\s+/)[0];
        tips.push(
          'No match. Search is literal (no synonyms): try a shorter or different word' +
            (word ? `, or ${suggestCall('logseq_list_pages', { name_contains: word })}.` : '.')
        );
        break;
      }
      const pick = suggestTopic(result);
      tips.push(
        pick
          ? `To read the ${pick.kind === 'topic' ? 'topic most results mention' : 'page most results are on'}: ${suggestCall('logseq_build_context', { topic_name: pick.name })}.`
          : 'Results carry page ids only. Repeat with slim_results: true to get page names, then logseq_build_context on one.'
      );
      break;
    }

    case 'logseq_get_page': {
      const page = nonEmptyString(asObject(result)?.originalName) ?? nonEmptyString(a.page_name);
      if (!page) break;
      if (a.include_children !== true) {
        tips.push(`For its blocks: ${suggestCall('logseq_get_page', { page_name: page, include_children: true })}.`);
      }
      tips.push(`For what links here: ${suggestCall('logseq_get_backlinks', { page_name: page })}.`);
      break;
    }

    case 'logseq_get_page_outline': {
      const blocks: unknown[] = Array.isArray(asObject(result)?.blocks) ? asObject(result)!.blocks : [];
      // A block with children is the more useful read; otherwise the first block
      const pick = asObject(blocks.find(b => (asObject(b)?.childCount ?? 0) > 0) ?? blocks[0]);
      const uuid = nonEmptyString(pick?.uuid);
      if (uuid) tips.push(`To read a block and its children: ${suggestCall('logseq_get_block', { block_uuid: uuid, include_children: true })}.`);
      break;
    }

    case 'logseq_get_backlinks': {
      const page = nonEmptyString(a.page_name);
      if (!page || !Array.isArray(result) || result.length === 0) break;
      tips.push(`For the page's own content and related pages: ${suggestCall('logseq_build_context', { topic_name: page })}.`);
      break;
    }

    case 'logseq_query_by_property': {
      if (!Array.isArray(result) || result.length === 0) break;
      const pick = suggestTopic(result);
      if (pick) {
        tips.push(
          `To read the ${pick.kind === 'topic' ? 'topic most matches mention' : 'page most matches are on'}: ${suggestCall('logseq_build_context', { topic_name: pick.name })}.`
        );
      }
      break;
    }

    case 'logseq_query_by_date_range': {
      const top = asObject(asObject(asObject(result)?.summary)?.topConcepts?.[0]);
      const name = nonEmptyString(top?.name);
      if (name) tips.push(`To follow the top concept: ${suggestCall('logseq_build_context', { topic_name: name })}.`);
      break;
    }

    case 'logseq_list_pages': {
      const first = asObject(result)?.pages?.[0];
      if (nonEmptyString(a.name_contains) && nonEmptyString(first)) {
        tips.push(`To open the first match: ${suggestCall('logseq_get_page', { page_name: first, include_children: true })}.`);
      }
      break;
    }
  }

  return tips.slice(0, MAX_TIPS);
}
