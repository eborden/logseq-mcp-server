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

/** The page named by most blocks, first seen wins a tie. */
function mostCommonPage(blocks: unknown[]): string | undefined {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const name = pageNameOf(block);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Tips for one finished tool call. `args` are the arguments after alias
 * resolution; `result` is the tool's return value. Returns [] when there is
 * nothing useful to add.
 */
export function buildTips(tool: string, args: Record<string, unknown> | undefined, result: unknown): string[] {
  const tips: string[] = [];
  const a = args ?? {};

  switch (tool) {
    case 'logseq_search_blocks': {
      if (!Array.isArray(result)) break;
      if (result.length === 0) {
        const word = nonEmptyString(a.query)?.trim().split(/\s+/)[0];
        tips.push(
          'No match. Search is literal (no synonyms): try a shorter or different word' +
            (word ? `, or ${suggestCall('logseq_list_pages', { name_contains: word })}.` : '.')
        );
        break;
      }
      const page = mostCommonPage(result);
      tips.push(
        page
          ? `To read the page most results are on: ${suggestCall('logseq_build_context', { topic_name: page })}.`
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

    case 'logseq_get_backlinks': {
      const page = nonEmptyString(a.page_name);
      if (!page || !Array.isArray(result) || result.length === 0) break;
      tips.push(`For the page's own content and related pages: ${suggestCall('logseq_build_context', { topic_name: page })}.`);
      break;
    }

    case 'logseq_query_by_property': {
      if (!Array.isArray(result) || result.length === 0) break;
      const page = mostCommonPage(result);
      if (page) tips.push(`To read the page most matches are on: ${suggestCall('logseq_build_context', { topic_name: page })}.`);
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
